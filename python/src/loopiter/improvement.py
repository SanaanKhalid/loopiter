"""Application-scheduled, opt-in autonomous improvement. No background worker.

Callbacks are cooperative, not sandboxed. External serving adapters must atomically
fence expected versions and inspect ambiguous operations; database leases do not do that.
"""

import asyncio
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
from datetime import timedelta
from types import MappingProxyType
from typing import Any
from uuid import uuid4

from . import _validation as v
from .client import FeedbackLoop, _callback
from .improvement_evidence import (
    compare,
    passes_gates,
    prepare_dataset,
    validate_change,
    validate_policy,
)

TERMINAL = {"completed", "no_improvement", "failed", "rolled_back"}
STATES = (
    "waiting_for_evidence proposing evaluating selected deploying observing completed "
    "no_improvement paused failed reconciliation_required rolling_back rolled_back"
).split()


def _plus(time, ms):
    return (v.timestamp(time) + timedelta(milliseconds=ms)).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class CallbackContext:
    operation_id: str
    cancellation: asyncio.Event
    meter: Callable
    configuration: Any = None


@dataclass(frozen=True)
class ImprovementWorkflow:
    id: str
    version: str
    optimizer_version: str
    evaluator_version: str
    policy: dict
    dataset: Callable
    artifact: Callable
    propose: Callable
    evaluate: Callable
    deployment: Any
    observe: Callable
    rollout: Any = None


class ImprovementController:
    def __init__(
        self,
        loop: FeedbackLoop,
        *,
        workflows,
        self_improving=False,
        mode="recommend",
        callback_timeout_ms=120000,
        tick_timeout_ms=600000,
        **obsolete,
    ):
        if obsolete:
            v.fail(
                "migration_required",
                "Unknown/obsolete controller options. Use self_improving and mode.",
            )
        if type(self_improving) is not bool:
            v.fail("invalid_input", "self_improving must be boolean.")
        v.enum(mode, ["observe", "recommend", "experiment", "autonomous"], "mode")
        v.integer(callback_timeout_ms, "callback timeout")
        v.integer(tick_timeout_ms, "tick timeout")
        if callback_timeout_ms > 120000 or tick_timeout_ms > 600000:
            v.fail("invalid_input", "Deadlines may be shortened, not extended beyond 2/10 minutes.")
        self.loop, self.self_improving, self.mode = loop, self_improving, mode
        self.callback_ms, self.tick_ms = callback_timeout_ms, tick_timeout_ms
        self.workflows, self.definitions = {}, {}
        if not workflows:
            v.fail("invalid_input", "Workflows required.")
        for raw in workflows:
            w = ImprovementWorkflow(**{**raw.__dict__, "policy": deepcopy(raw.policy)})
            for name in ("id", "version", "optimizer_version", "evaluator_version"):
                v.nonempty(getattr(w, name), name)
            validate_policy(w.policy)
            for name in ("dataset", "artifact", "propose", "evaluate", "observe"):
                if not callable(getattr(w, name)):
                    v.fail("invalid_adapter", f"Missing {name}.")
            loop._adapter(w.deployment)
            if w.policy["rollout"]["mode"] == "canary" and any(
                not callable(getattr(w.rollout, k, None)) for k in ("promote", "inspect")
            ):
                v.fail("invalid_adapter", "Canary requires durable promotion and inspection.")
            if w.id in self.workflows:
                v.fail("invalid_input", "Duplicate workflow ID.")
            self.workflows[w.id] = w
            self.definitions[w.id] = v.fingerprint(
                {
                    "version": w.version,
                    "optimizer": w.optimizer_version,
                    "evaluator": w.evaluator_version,
                    "policy": w.policy,
                }
            )

    def _workflow(self, key):
        if key not in self.workflows:
            v.fail("not_found", "Workflow not configured.")
        return self.workflows[key]

    def _tx(self):
        return self.loop.store.transaction(self.loop.namespace)

    async def _read(self, tx, kind, key):
        return await self.loop._read(tx, kind, key)

    async def _put(self, tx, kind, key, data):
        v.json_value(data, 16 * 1024 * 1024)
        old = await self._read(tx, kind, key)
        row = (
            self.loop._next(old, data=deepcopy(data))
            if old
            else {**self.loop._base(kind, key), "format": 1, "data": deepcopy(data)}
        )
        if old:
            await tx.replace(kind, row, old["revision"])
        else:
            await tx.insert(kind, row)
        return row

    def _parse(self, run):
        d = run["data"]
        v.enum(d.get("state"), STATES, "stored run state")
        for name in ("workflow_id", "definition_hash", "decision_key"):
            v.nonempty(d.get(name), name)
        v.timestamp(d.get("lease_until"))
        if d.get("lease_owner") is not None:
            v.nonempty(d["lease_owner"], "lease owner")
        v.integer(d.get("proposal_calls"), "proposal calls", 0)
        if type(d.get("candidate_ids")) is not list:
            v.fail("integrity_error", "Invalid candidate references.")
        for cid in d["candidate_ids"]:
            v.nonempty(cid, "candidate ID")
        v.obj(d.get("comparisons"))
        v.baseline(d.get("baseline"))
        return run

    async def get_run(self, key):
        async with self._tx() as tx:
            run = await self._read(tx, "runs", key)
            if not run:
                return None
            run = self._parse(run)
            d = run["data"]
            expected = v.fingerprint(
                {
                    "namespace": self.loop.namespace,
                    "workflow_id": d["workflow_id"],
                    "definition_hash": d["definition_hash"],
                    "baseline": d["baseline"],
                    "dataset": d["dataset"],
                }
            )
            if d["decision_key"] != expected or run["id"] != "run_" + expected:
                v.fail("integrity_error", "Run evidence/baseline identity was altered.")
            accounting = {
                "model_requests": 0,
                "charged_or_reserved_tokens": 0,
                "deployments": 0,
                "outstanding_operations": [],
            }
            for oid in run["data"].get("operation_ids", []):
                op = await self._read(tx, "operations", oid)
                if not op:
                    v.fail("integrity_error", "Run operation missing.")
                data = op["data"]
                accounting["model_requests"] += data.get("requests", 0)
                accounting["charged_or_reserved_tokens"] += data.get(
                    "charged_tokens", data.get("tokens", 0)
                )
                if data.get("status") != "completed":
                    accounting["outstanding_operations"].append(oid)
            if await self._read(tx, "operations", key + ":deployment_budget"):
                accounting["deployments"] = 1
            return {**run, "accounting": accounting}

    async def list_runs(self, **options):
        page = await self.loop.list("runs", **options)
        page["items"] = [self._parse(r) for r in page["items"]]
        return page

    async def pause(self, workflow_id, reason):
        self._workflow(workflow_id)
        v.nonempty(reason, "reason")
        async with self._tx() as tx:
            old = await self._read(tx, "coordination", "workflow:" + workflow_id)
            await self._put(
                tx,
                "coordination",
                "workflow:" + workflow_id,
                {**(old["data"] if old else {}), "paused": True, "reason": reason},
            )
            await self.loop._event(
                tx, "improvement.administrative_pause", workflow_id, reason=reason
            )

    async def resume(self, workflow_id):
        w = self._workflow(workflow_id)
        async with self._tx() as tx:
            old = await self._read(tx, "coordination", "workflow:" + workflow_id)
            await self._put(
                tx,
                "coordination",
                "workflow:" + workflow_id,
                {**(old["data"] if old else {}), "paused": False, "reason": "explicit_resume"},
            )
            target = await self._read(tx, "coordination", self._target(w))
            if target and not target["data"].get("active_run"):
                await self._put(
                    tx,
                    "coordination",
                    self._target(w),
                    {**target["data"], "consecutive_failures": 0},
                )
            await self.loop._event(tx, "improvement.administrative_resume", workflow_id)

    async def _paused(self, tx, w):
        row = await self._read(tx, "coordination", "workflow:" + w.id)
        return bool(row and row["data"].get("paused") is True)

    def _target(self, w):
        return "target:" + v.fingerprint(w.policy["target"])

    def _configuration(self, w):
        return {
            "workflow_id": w.id,
            "workflow_version": w.version,
            "policy_version": w.policy["version"],
            "optimizer_version": w.optimizer_version,
            "evaluator_version": w.evaluator_version,
            "definition_hash": self.definitions[w.id],
        }

    async def _plain(self, w, fn):
        async def invoke(cancel):
            async def no_meter(*_):
                v.fail(
                    "invalid_adapter", "Read-only dataset/artifact callbacks cannot call models."
                )

            return await self.loop._prepare(
                await fn(
                    CallbackContext(
                        "read_" + str(uuid4()),
                        cancel,
                        no_meter,
                        MappingProxyType(self._configuration(w)),
                    )
                )
            )

        return await _callback(invoke, self.callback_ms / 1000)

    def _budget_key(self, w):
        return w.id + ":" + self.loop.now()[:10]

    async def _budget(self, w):
        async with self._tx() as tx:
            row = await self._read(tx, "budgets", self._budget_key(w))
        return {
            k: row["data"][k] if row else 0 for k in ("model_requests", "tokens", "deployments")
        }

    async def _reserve(self, tx, w, requests, tokens, deployments=0):
        key = self._budget_key(w)
        old = await self._read(tx, "budgets", key)
        previous = old["data"] if old else {}
        data = {
            k: previous.get(k, 0) + n
            for k, n in [
                ("model_requests", requests),
                ("tokens", tokens),
                ("deployments", deployments),
            ]
        }
        for k, n in data.items():
            v.integer(n, k, 0)
            if n > w.policy["daily"][k]:
                v.fail("budget_exhausted", "Daily " + k + " exhausted.")
        await self._put(tx, "budgets", key, data)
        return key

    async def _owned(self, tx, rid, owner, recovery=False):
        row = await self._read(tx, "runs", rid)
        if not row:
            v.fail("not_found", "Run missing.")
        run = self._parse(row)
        d, w = run["data"], self._workflow(run["data"]["workflow_id"])
        if d["lease_owner"] != owner or v.timestamp(d["lease_until"]) <= v.timestamp(
            self.loop.now()
        ):
            v.fail("lease_lost", "Late result discarded after lost lease.")
        if not recovery and await self._paused(tx, w):
            v.fail("paused", "Workflow paused.")
        if not recovery and d["definition_hash"] != self.definitions[w.id]:
            v.fail("policy_changed", "Run configuration changed.")
        if not recovery:
            control = await self._read(tx, "coordination", "workflow:" + w.id)
            config = control["data"] if control else {}
            if (
                config.get("definition_hash"),
                config.get("mode"),
                config.get("self_improving"),
            ) != (self.definitions[w.id], self.mode, self.self_improving):
                v.fail("policy_changed", "A later invocation changed controller authorization.")
        return run

    async def _save(self, rid, owner, patch, recovery=False):
        async with self._tx() as tx:
            run = await self._owned(tx, rid, owner, recovery)
            data = {**run["data"], **deepcopy(patch)}
            row = await self._put(tx, "runs", rid, data)
            await self.loop._event(tx, "improvement." + data["state"], rid, reason=data["reason"])
            if data["state"] in TERMINAL:
                w = self._workflow(data["workflow_id"])
                lock = await self._read(tx, "coordination", self._target(w))
                if lock and lock["data"].get("active_run") == rid:
                    await self._put(
                        tx,
                        "coordination",
                        self._target(w),
                        {
                            **lock["data"],
                            "active_run": None,
                            "consecutive_failures": 0
                            if data["state"] == "completed"
                            else lock["data"].get("consecutive_failures", 0) + 1,
                            "previous_outcomes": [
                                *lock["data"].get("previous_outcomes", []),
                                {"state": data["state"], "reason": data["reason"]},
                            ][-10:],
                            "next_eligible_at": _plus(self.loop.now(), w.policy["cooldown_ms"]),
                        },
                    )
            return self._parse(row)

    async def _operation(self, run, owner, kind, fn, recovery=False):
        rid, w = run["id"], self._workflow(run["data"]["workflow_id"])
        opid = rid + ":" + kind
        async with self._tx() as tx:
            current = await self._owned(tx, rid, owner, recovery)
            old = await self._read(tx, "operations", opid)
            if old:
                if old["data"]["status"] == "completed":
                    if "result" not in old["data"]:
                        v.fail("integrity_error", "Completed callback has no durable result.")
                    return deepcopy(old["data"]["result"])
                v.fail("ambiguous_callback", "Callback previously dispatched; not replayed.")
            await self._put(
                tx,
                "operations",
                opid,
                {
                    "run_id": rid,
                    "kind": kind,
                    "status": "pending",
                    "requests": 0,
                    "tokens": 0,
                    "charged_tokens": 0,
                },
            )
            await self._put(
                tx,
                "runs",
                rid,
                {
                    **current["data"],
                    "operation_ids": [*current["data"].get("operation_ids", []), opid],
                },
            )

        async def invoke(cancel):
            async def meter(maximum_tokens, call):
                v.integer(maximum_tokens, "maximum tokens", 0)
                if cancel.is_set():
                    v.fail("cancelled", "Callback cancelled.")
                async with self._tx() as tx:
                    await self._owned(tx, rid, owner, recovery)
                    op = (await self._read(tx, "operations", opid))["data"]
                    requests, tokens = op["requests"] + 1, op["tokens"] + maximum_tokens
                    v.integer(requests, "operation requests")
                    v.integer(tokens, "operation tokens", 0)
                    v.integer(op["charged_tokens"], "charged tokens", 0)
                    limits = w.policy["callback_reservation"]
                    if requests > limits["model_requests"] or tokens > limits["tokens"]:
                        v.fail("budget_exhausted", "Callback budget exhausted.")
                    day = await self._reserve(tx, w, 1, maximum_tokens)
                    await self._put(
                        tx,
                        "operations",
                        opid,
                        {
                            **op,
                            "requests": requests,
                            "tokens": tokens,
                            "charged_tokens": op.get("charged_tokens", 0) + maximum_tokens,
                        },
                    )
                output = await call()
                if cancel.is_set():
                    v.fail("cancelled", "Late usage ignored; reservation retained.")
                v.fields(output, ["value", "tokens"], ("value", "tokens"))
                if output["tokens"] is not None:
                    v.integer(output["tokens"], "actual tokens", 0)
                    async with self._tx() as tx:
                        await self._owned(tx, rid, owner, recovery)
                        b = (await self._read(tx, "budgets", day))["data"]
                        await self._put(
                            tx,
                            "budgets",
                            day,
                            {**b, "tokens": b["tokens"] - maximum_tokens + output["tokens"]},
                        )
                        op = (await self._read(tx, "operations", opid))["data"]
                        await self._put(
                            tx,
                            "operations",
                            opid,
                            {
                                **op,
                                "charged_tokens": op["charged_tokens"]
                                - maximum_tokens
                                + output["tokens"],
                            },
                        )
                    if output["tokens"] > maximum_tokens:
                        v.fail(
                            "budget_contract",
                            "Provider exceeded reserved maximum; actual usage charged and result rejected.",
                        )
                return output["value"]

            return await self.loop._prepare(
                await fn(
                    CallbackContext(opid, cancel, meter, MappingProxyType(self._configuration(w)))
                )
            )

        result = await _callback(invoke, self.callback_ms / 1000)
        async with self._tx() as tx:
            await self._owned(tx, rid, owner, recovery)
            op = (await self._read(tx, "operations", opid))["data"]
            await self._put(tx, "operations", opid, {**op, "status": "completed", "result": result})
        return result

    async def tick(self, workflow_id, cancellation: asyncio.Event | None = None):
        # External event and task cancellation are cooperative; late results are ignored.
        if cancellation and cancellation.is_set():
            return await self._idle(self._workflow(workflow_id), "cancelled")
        task = asyncio.create_task(self._tick(workflow_id))
        waiter = asyncio.create_task(cancellation.wait()) if cancellation else None
        try:
            done, _ = await asyncio.wait(
                {task, *([waiter] if waiter else [])},
                timeout=self.tick_ms / 1000,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if task in done:
                return task.result()
            task.cancel()
            try:
                return await task
            except asyncio.CancelledError:
                pass
            return await self._idle(self._workflow(workflow_id), "cancelled")
        finally:
            if waiter:
                waiter.cancel()
            if not task.done():
                task.cancel()

    async def _idle(self, w, reason, state="waiting_for_evidence", next_time=None):
        return {
            "run_id": None,
            "state": state,
            "reason": reason,
            "candidate_ids": [],
            "budget": await self._budget(w),
            **({"next_eligible_at": next_time} if next_time else {}),
        }

    async def _tick(self, workflow_id):
        w, run, owner = self._workflow(workflow_id), None, str(uuid4())
        p = w.policy
        async with self._tx() as tx:
            control = await self._read(tx, "coordination", "workflow:" + w.id)
            await self._put(
                tx,
                "coordination",
                "workflow:" + w.id,
                {
                    **(control["data"] if control else {}),
                    "definition_hash": self.definitions[w.id],
                    "mode": self.mode,
                    "self_improving": self.self_improving,
                },
            )
            lock = await self._read(tx, "coordination", self._target(w))
            paused = await self._paused(tx, w)
        lock = lock["data"] if lock else {}
        if lock.get("active_run"):
            run = await self.get_run(lock["active_run"])
        try:
            if not run:
                if paused:
                    return await self._idle(w, "workflow_paused", "paused")
                if self.mode == "autonomous" and not self.self_improving:
                    return await self._idle(w, "self_improvement_disabled", "paused")
                if lock.get("consecutive_failures", 0) >= p.get("maximum_consecutive_failures", 3):
                    return await self._idle(w, "repeated_failures_require_review", "paused")
                if lock.get("next_eligible_at") and v.timestamp(
                    lock["next_eligible_at"]
                ) > v.timestamp(self.loop.now()):
                    return await self._idle(w, "cooldown", next_time=lock["next_eligible_at"])
                baseline = await self._plain(w, w.artifact)
                v.baseline(baseline)
                dataset = prepare_dataset(await self._plain(w, w.dataset), p, self.loop.now())
                if self.mode == "observe":
                    return await self._idle(w, "observation_only")
                if any(
                    len(dataset[name]) < minimum
                    for name, minimum in [
                        ("optimization", p["minimum_new_units"]),
                        ("validation", p["minimum_validation_units"]),
                        ("audit", p["minimum_audit_units"]),
                    ]
                ):
                    return await self._idle(w, "insufficient_evidence")
                definition = self.definitions[w.id]
                decision = v.fingerprint(
                    {
                        "workflow_id": w.id,
                        "namespace": self.loop.namespace,
                        "definition_hash": definition,
                        "baseline": baseline,
                        "dataset": dataset,
                    }
                )
                rid = "run_" + decision
                old = await self.get_run(rid)
                if old:
                    return {
                        **await self._idle(w, "unchanged_evidence", old["data"]["state"]),
                        "run_id": rid,
                        "candidate_ids": old["data"]["candidate_ids"],
                    }
                async with self._tx() as tx:
                    lock = await self._read(tx, "coordination", self._target(w))
                    data = lock["data"] if lock else {}
                    if data.get("active_run"):
                        v.fail("target_busy", "Target already has an improvement cycle.")
                    if await self._paused(tx, w):
                        v.fail("paused", "Workflow paused.")
                    used = set(data.get("used_units", []))
                    if (
                        sum(r["entity_id"] not in used for r in dataset["optimization"])
                        < p["minimum_new_units"]
                    ):
                        v.fail("insufficient_new_evidence", "Not enough new entities.")
                    d = {
                        "workflow_id": w.id,
                        "definition_hash": definition,
                        "decision_key": decision,
                        "state": "proposing",
                        "reason": "eligible_evidence",
                        "baseline": baseline,
                        "dataset": dataset,
                        "candidate_ids": [],
                        "comparisons": {},
                        "proposal_calls": 0,
                        "lease_owner": None,
                        "lease_until": self.loop.now(),
                        "previous_outcomes": deepcopy(data.get("previous_outcomes", [])),
                        "configuration": self._configuration(w),
                        "operation_ids": [],
                    }
                    run = await self._put(tx, "runs", rid, d)
                    await self._put(
                        tx,
                        "coordination",
                        self._target(w),
                        {
                            **data,
                            "active_run": rid,
                            "used_units": sorted(
                                used | {r["entity_id"] for r in dataset["optimization"]}
                            ),
                        },
                    )
        except Exception as exc:
            return await self._idle(w, getattr(exc, "code", "callback_failed"))
        rid = run["id"]
        if run["data"]["workflow_id"] != w.id:
            return await self._idle(w, "target_owned_by_other_workflow")
        try:
            async with self._tx() as tx:
                run = self._parse(await self._read(tx, "runs", rid))
                if run["data"]["lease_owner"] and v.timestamp(
                    run["data"]["lease_until"]
                ) > v.timestamp(self.loop.now()):
                    v.fail("run_busy", "Another worker owns this run.")
                run = await self._put(
                    tx,
                    "runs",
                    rid,
                    {
                        **run["data"],
                        "lease_owner": owner,
                        "lease_until": _plus(
                            self.loop.now(), self.tick_ms + self.callback_ms + 60000
                        ),
                    },
                )
            d = run["data"]
            recovering = d["state"] in (
                "deploying",
                "reconciliation_required",
                "rolling_back",
                "observing",
            )
            if recovering and d.get("selected_id"):
                candidate = await self.loop.get_candidate(d["selected_id"])
                receipt = (candidate or {}).get("rollback_receipt")
                if candidate and candidate["status"] == "rolled_back" and receipt:
                    actual = await self._plain(w, w.artifact)
                    v.baseline(actual)
                    expected = d.get(
                        "artifact_version",
                        candidate.get("deployment_receipt", {}).get("artifact_version"),
                    )
                    if (
                        actual["artifact_version"] != receipt["artifact_version"]
                        or receipt["artifact_version"] != d["baseline"]["artifact_version"]
                        or actual["configuration_hash"] != d["baseline"]["configuration_hash"]
                        or receipt["previous_artifact_version"] != expected
                    ):
                        v.fail(
                            "out_of_band_change",
                            "Reviewed rollback does not match actual serving state.",
                        )
                    await self._save(
                        rid,
                        owner,
                        {"state": "rolled_back", "reason": "reviewed_rollback_confirmed"},
                        True,
                    )
                    return {
                        **await self._idle(w, "reviewed_rollback_confirmed", "rolled_back"),
                        "run_id": rid,
                        "candidate_ids": d["candidate_ids"],
                    }
            if d["definition_hash"] != self.definitions[w.id]:
                await self._save(rid, owner, {"reason": "policy_changed_requires_recovery"}, True)
                return {
                    **await self._idle(w, "policy_changed_requires_recovery", "paused"),
                    "run_id": rid,
                    "candidate_ids": d["candidate_ids"],
                }
            if (
                paused or (self.mode == "autonomous" and not self.self_improving)
            ) and not recovering:
                reason = "workflow_paused" if paused else "self_improvement_disabled"
                await self._save(rid, owner, {"reason": reason}, True)
                return {
                    **await self._idle(w, reason, "paused"),
                    "run_id": rid,
                    "candidate_ids": d["candidate_ids"],
                }
            if (
                d["state"] == "observing"
                and d.get("next_eligible_at")
                and v.timestamp(d["next_eligible_at"]) > v.timestamp(self.loop.now())
                and v.timestamp(self.loop.now())
                < v.timestamp(_plus(d["deployed_at"], p["observation"]["timeout_ms"]))
            ):
                return {
                    **await self._idle(w, d["reason"], d["state"], d["next_eligible_at"]),
                    "run_id": rid,
                    "candidate_ids": d["candidate_ids"],
                }
            await self._advance(run, owner, w, paused)
        except (Exception, asyncio.CancelledError) as exc:
            code = (
                "cancelled"
                if isinstance(exc, asyncio.CancelledError)
                else getattr(exc, "code", "callback_failed")
            )
            if code == "run_busy":
                return {
                    **await self._idle(w, code),
                    "run_id": rid,
                    "candidate_ids": run["data"]["candidate_ids"],
                }
            if code != "lease_lost":
                current = await self.get_run(rid)
                if current and current["data"]["lease_owner"] == owner:
                    state = current["data"]["state"]
                    if current["data"].get("pending_promotion") or state in (
                        "deploying",
                        "rolling_back",
                        "reconciliation_required",
                    ):
                        state = "reconciliation_required"
                    elif state != "observing" and code not in ("paused", "policy_changed"):
                        state = "failed"
                    await self._save(rid, owner, {"state": state, "reason": code}, True)
        finally:
            async with self._tx() as tx:
                row = await self._read(tx, "runs", rid)
                if row and row["data"]["lease_owner"] == owner:
                    await self._put(
                        tx,
                        "runs",
                        rid,
                        {**row["data"], "lease_owner": None, "lease_until": self.loop.now()},
                    )
        run = await self.get_run(rid)
        d = run["data"]
        return {
            **await self._idle(w, d["reason"], d["state"], d.get("next_eligible_at")),
            "run_id": rid,
            "candidate_ids": d["candidate_ids"],
        }

    async def _advance(self, run, owner, w, paused):
        rid, d, p = run["id"], run["data"], w.policy
        if d["state"] == "proposing":
            ordinal = d["proposal_calls"]
            proposals = await self._operation(
                run,
                owner,
                f"propose:{ordinal}",
                lambda c: w.propose(
                    {
                        "baseline": deepcopy(d["baseline"]),
                        "examples": deepcopy(d["dataset"]["optimization"]),
                        "ordinal": ordinal,
                        "previous_outcomes": deepcopy(d.get("previous_outcomes", [])),
                    },
                    c,
                ),
            )
            if type(proposals) is not list or len(proposals) > p.get("maximum_candidates", 3):
                v.fail("proposal_limit", "Invalid/oversized proposal batch.")
            ids = list(d["candidate_ids"])
            for proposal in proposals:
                validate_change(proposal, p["change_schema"])
                candidate = await self.loop.create_candidate(
                    id="candidate_" + v.fingerprint({"run_id": rid, "proposal": proposal}),
                    target=p["target"],
                    baseline=d["baseline"],
                    proposed_change=proposal,
                    evidence={
                        "decision_key": d["decision_key"],
                        "dataset_hash": v.fingerprint(d["dataset"]),
                    },
                    risk="low",
                    metadata={"run_id": rid, "policy_version": p["version"]},
                )
                validate_change(candidate["proposed_change"], p["change_schema"])
                if candidate["baseline"] != d["baseline"] or candidate["target"] != p["target"]:
                    v.fail("integrity_error", "Sanitizer changed candidate identity.")
                if candidate["id"] not in ids:
                    ids.append(candidate["id"])
                if len(ids) > p.get("maximum_candidates", 3):
                    v.fail("proposal_limit", "Too many candidates.")
            calls = ordinal + 1
            done = bool(ids) or calls >= p.get("maximum_proposal_calls", 3)
            state = (
                ("completed" if self.mode == "recommend" else "evaluating")
                if ids
                else "no_improvement"
            )
            await self._save(
                rid,
                owner,
                {
                    "proposal_calls": calls,
                    "candidate_ids": ids,
                    "state": state if done else "proposing",
                    "reason": "recommendations_only"
                    if self.mode == "recommend"
                    else "proposals_ready"
                    if ids
                    else "no_proposal",
                },
            )
        elif d["state"] == "evaluating":
            comparisons = deepcopy(d["comparisons"])
            for cid in d["candidate_ids"]:
                if cid in comparisons:
                    continue
                candidate = await self.loop.get_candidate(cid)
                report = await self._operation(
                    run,
                    owner,
                    "validation:" + cid,
                    lambda c, candidate=candidate: w.evaluate(
                        {
                            "baseline": deepcopy(d["baseline"]),
                            "change": candidate["proposed_change"],
                            "examples": deepcopy(d["dataset"]["validation"]),
                            "partition": "validation",
                        },
                        c,
                    ),
                )
                compare(report, d["dataset"]["validation"], p)
                comparisons[cid] = report
                run = await self._save(
                    rid, owner, {"comparisons": comparisons, "reason": "validation_recorded"}
                )
            ranked = sorted(
                [
                    cid
                    for cid in d["candidate_ids"]
                    if compare(comparisons[cid], d["dataset"]["validation"], p)["passed"]
                ],
                key=lambda cid: (
                    -compare(comparisons[cid], d["dataset"]["validation"], p)["improvement"],
                    comparisons[cid]["estimated_serving_cost"],
                    cid,
                ),
            )
            await self._save(
                rid,
                owner,
                {"selected_id": ranked[0], "state": "selected", "reason": "winner_selected"}
                if ranked
                else {"state": "no_improvement", "reason": "validation_failed"},
            )
        elif d["state"] == "selected":
            cid = d["selected_id"]
            candidate = await self.loop.get_candidate(cid)
            async with self._tx() as tx:
                await self._owned(tx, rid, owner)
                for row in d["dataset"]["audit"]:
                    for identity in (
                        "id:" + row["id"],
                        "episode:" + row["episode_id"],
                        "entity:" + row["entity_id"],
                    ):
                        key = "audit:" + v.fingerprint(identity)
                        prior = await self._read(tx, "coordination", key)
                        if prior and prior["data"]["run_id"] != rid:
                            v.fail("audit_consumed", "Fresh audit data required.")
                        if not prior:
                            await self._put(tx, "coordination", key, {"run_id": rid})
            audit = await self._operation(
                run,
                owner,
                "audit:" + cid,
                lambda c: w.evaluate(
                    {
                        "baseline": deepcopy(d["baseline"]),
                        "change": candidate["proposed_change"],
                        "examples": deepcopy(d["dataset"]["audit"]),
                        "partition": "audit",
                    },
                    c,
                ),
            )
            gates = compare(audit, d["dataset"]["audit"], p, True)
            audit_metrics = {
                **audit["metrics"],
                "improvement": gates["improvement"],
                "lower_bound": gates["lower"],
                "sample_count": gates["sample_count"],
            }
            if candidate["status"] == "proposed":

                async def evaluate(*_):
                    return {
                        "passed": gates["passed"],
                        "metrics": audit_metrics,
                        "notes": (
                            "Trusted application audit: "
                            + p["audit_method"]["name"]
                            + "@"
                            + p["audit_method"]["version"]
                        )
                        if p.get("audit_method")
                        else "Fixed-sample paired Hoeffding; independent units required.",
                    }

                await self.loop.evaluate_candidate(
                    cid,
                    evaluate,
                    evaluator_name=w.id,
                    version=w.evaluator_version,
                    dataset_hash=v.fingerprint(d["dataset"]["audit"]),
                )
            audited = await self.loop.get_candidate(cid)
            audit_evaluation = audited["evaluations"][-1] if audited["evaluations"] else None
            if (
                audited["status"] not in ("evaluated", "approved")
                or not audit_evaluation
                or audit_evaluation["evaluator"] != w.id
                or audit_evaluation["version"] != w.evaluator_version
                or audit_evaluation["dataset_hash"] != v.fingerprint(d["dataset"]["audit"])
                or audit_evaluation.get("baseline_hash") != v.fingerprint(d["baseline"])
                or audit_evaluation["passed"] != gates["passed"]
                or audit_evaluation.get("metrics") != audit_metrics
            ):
                v.fail(
                    "audit_evaluation_conflict",
                    "The current evaluation is not this frozen audit. Human changes are not overwritten.",
                )
            await self._save(
                rid, owner, {"audit": audit, "audit_evaluation_id": audit_evaluation["id"]}
            )
            if not gates["passed"]:
                await self._save(
                    rid,
                    owner,
                    {"audit": audit, "state": "no_improvement", "reason": "audit_failed"},
                )
            elif self.mode != "autonomous":
                await self._save(
                    rid, owner, {"audit": audit, "state": "completed", "reason": "experiment_only"}
                )
            else:
                current = await self._plain(w, w.artifact)
                v.baseline(current)
                if current != d["baseline"]:
                    v.fail("stale_baseline", "Serving baseline changed.")
                async with self._tx() as tx:
                    await self._owned(tx, rid, owner)
                    opid = rid + ":deployment_budget"
                    if not await self._read(tx, "operations", opid):
                        await self._reserve(tx, w, 0, 0, 1)
                        await self._put(
                            tx, "operations", opid, {"status": "completed", "result": True}
                        )
                candidate = await self.loop.get_candidate(cid)
                if candidate["status"] == "evaluated":
                    await self.loop.approve_candidate(
                        cid,
                        actor="loopiter/autonomous",
                        authorization={"run_id": rid, "lease_owner": owner},
                        evaluation_id=audit_evaluation["id"],
                    )
                await self._save(
                    rid,
                    owner,
                    {
                        "audit": audit,
                        "state": "deploying",
                        "reason": "audit_passed",
                        "attempt_id": rid + ":apply",
                        "operation": "apply",
                    },
                )
        elif d["state"] in ("deploying", "rolling_back", "reconciliation_required") and not d.get(
            "pending_promotion"
        ):
            async with self._tx() as tx:
                existing = await self._read(tx, "attempts", d["attempt_id"])
            if existing:
                attempt = await self.loop.reconcile_deployment(d["attempt_id"], w.deployment)
            else:
                if d["operation"] == "apply" and (
                    not self.self_improving or self.mode != "autonomous" or paused
                ):
                    await self._save(rid, owner, {"reason": "self_improvement_disabled"}, True)
                    return
                current = await self._plain(w, w.artifact)
                v.baseline(current)
                if d["operation"] == "apply" and current != d["baseline"]:
                    v.fail("stale_baseline", "Target changed before dispatch.")
                if d["operation"] == "rollback" and (
                    current["artifact_version"] != d["artifact_version"]
                    or current["configuration_hash"] != d["observation_configuration_hash"]
                ):
                    v.fail("out_of_band_change", "Will not roll back an unrelated configuration.")
                method = (
                    self.loop.rollback_candidate
                    if d["operation"] == "rollback"
                    else self.loop.deploy_candidate
                )
                controller = self

                class AuthorizedAdapter:
                    async def apply(self, request):
                        async with controller._tx() as tx:
                            await controller._owned(tx, rid, owner)
                        return await w.deployment.apply(request)

                    async def inspect(self, request):
                        return await w.deployment.inspect(request)

                    async def rollback(self, request):
                        return await w.deployment.rollback(request)

                attempt = await method(
                    d["selected_id"],
                    AuthorizedAdapter(),
                    attempt_id=d["attempt_id"],
                    expected_artifact_version=d["artifact_version"]
                    if d["operation"] == "rollback"
                    else d["baseline"]["artifact_version"],
                    **(
                        {"authorization": {"run_id": rid, "lease_owner": owner}}
                        if d["operation"] == "apply"
                        else {}
                    ),
                )
            if attempt["status"] == "pending":
                await self._save(
                    rid,
                    owner,
                    {"state": "reconciliation_required", "reason": "deployment_unknown"},
                    True,
                )
            elif attempt["status"] == "not_applied":
                await self._save(
                    rid,
                    owner,
                    {
                        "state": "reconciliation_required"
                        if d["operation"] == "rollback"
                        else "failed",
                        "reason": "operation_fenced_not_applied",
                    },
                    True,
                )
            elif d["operation"] == "rollback":
                await self._save(
                    rid,
                    owner,
                    {"state": "rolled_back", "reason": "previous_version_restored"},
                    True,
                )
            else:
                actual = await self._plain(w, w.artifact)
                v.baseline(actual)
                if (
                    actual["artifact_version"] != attempt["receipt"]["artifact_version"]
                    or actual["configuration_hash"] != d["baseline"]["configuration_hash"]
                ):
                    v.fail("out_of_band_change", "Applied version is not current.")
                await self._save(
                    rid,
                    owner,
                    {
                        "state": "observing",
                        "reason": "deployment_is_not_improvement",
                        "artifact_version": attempt["receipt"]["artifact_version"],
                        "observation_configuration_hash": actual["configuration_hash"],
                        "deployed_at": attempt["updated_at"],
                    },
                    True,
                )
        elif d["state"] == "observing" or d.get("pending_promotion"):
            await self._observation(run, owner, w, paused)

    async def _observation(self, run, owner, w, paused):
        rid, d, p = run["id"], run["data"], w.policy
        actual = await self._plain(w, w.artifact)
        v.baseline(actual)
        if (
            actual["artifact_version"] != d["artifact_version"]
            or actual["configuration_hash"] != d["observation_configuration_hash"]
        ):
            v.fail("out_of_band_change", "Serving configuration changed during observation.")
        async with self._tx() as tx:
            promotion = await self._read(tx, "operations", rid + ":promote")
        if promotion:
            status = await self._plain(
                w,
                lambda c: w.rollout.inspect(
                    {"operation_id": rid + ":promote", "artifact_version": d["artifact_version"]}, c
                ),
            )
            v.enum(status, ["promoted", "unknown", "not_applied"], "promotion inspection")
            if status == "promoted":
                update = {
                    "state": "completed",
                    "reason": "canary_promoted",
                    "pending_promotion": False,
                }
            elif status == "not_applied":
                update = {
                    "state": "rolling_back",
                    "operation": "rollback",
                    "attempt_id": rid + ":rollback",
                    "reason": "promotion_fenced_withdraw",
                    "pending_promotion": False,
                }
            else:
                update = {
                    "state": "reconciliation_required",
                    "reason": "promotion_requires_reconciliation",
                    "pending_promotion": True,
                }
            await self._save(rid, owner, update, True)
            return
        if d.get("pending_promotion"):
            await self._save(
                rid,
                owner,
                {
                    "state": "observing",
                    "pending_promotion": False,
                    "reason": "promotion_not_dispatched",
                },
                True,
            )
            return
        if v.timestamp(self.loop.now()) >= v.timestamp(
            _plus(d["deployed_at"], p["observation"]["timeout_ms"])
        ):
            await self._save(
                rid,
                owner,
                {
                    "state": "rolling_back",
                    "operation": "rollback",
                    "attempt_id": rid + ":rollback",
                    "reason": "observation_timeout",
                },
                True,
            )
            return
        observed = await self._operation(
            run,
            owner,
            "observe:" + str(run["revision"]),
            lambda c: w.observe(
                {
                    "run_id": rid,
                    "artifact_version": d["artifact_version"],
                    "baseline": deepcopy(d["baseline"]),
                    "deployed_at": d["deployed_at"],
                },
                c,
            ),
            True,
        )
        self._validate_observation(observed, run, w)
        if p["rollout"]["mode"] == "canary":
            run = await self._save(
                rid, owner, {"assignment_hash": observed["assignment_hash"]}, True
            )
        oid = rid + ":observation:" + str(run["revision"])
        async with self._tx() as tx:
            await self._owned(tx, rid, owner, True)
            if not await self._read(tx, "observations", oid):
                await self._put(tx, "observations", oid, observed)
        enough = (
            observed["complete"]
            and len(observed["unit_ids"]) >= p["observation"]["minimum_units"]
            and v.timestamp(observed["ended_at"])
            >= v.timestamp(_plus(d["deployed_at"], p["observation"]["minimum_duration_ms"]))
        )
        passed = passes_gates(observed["metrics"], p["observation"]["guardrails"])
        if (
            not passed
            and observed["complete"]
            and len(observed["unit_ids"]) >= p["observation"]["minimum_units"]
        ):
            await self._save(
                rid,
                owner,
                {
                    "state": "rolling_back",
                    "operation": "rollback",
                    "attempt_id": rid + ":rollback",
                    "reason": "production_guardrail_failed",
                    "last_observation_id": oid,
                },
                True,
            )
        elif enough and passed:
            if p["rollout"]["mode"] == "canary":
                if observed["improvement_lower_bound"] <= p["objective"]["minimum_improvement"]:
                    await self._save(rid, owner, {"reason": "canary_not_superior"}, True)
                    return
                if paused or not self.self_improving or self.mode != "autonomous":
                    await self._save(rid, owner, {"reason": "promotion_paused"}, True)
                    return
                opid = rid + ":promote"
                async with self._tx() as tx:
                    prior = await self._read(tx, "operations", opid)
                if prior:
                    status = await self._plain(
                        w,
                        lambda c: w.rollout.inspect(
                            {"operation_id": opid, "artifact_version": d["artifact_version"]}, c
                        ),
                    )
                    if status != "promoted":
                        await self._save(
                            rid, owner, {"reason": "promotion_requires_reconciliation"}, True
                        )
                        return
                else:
                    run = await self._save(
                        rid,
                        owner,
                        {
                            "pending_promotion": True,
                            "reason": "promotion_dispatch_pending",
                            "last_observation_id": oid,
                        },
                    )

                    async def promote(c):
                        await w.rollout.promote(
                            {
                                "operation_id": c.operation_id,
                                "artifact_version": d["artifact_version"],
                                "baseline": deepcopy(d["baseline"]),
                            },
                            c,
                        )
                        return True

                    await self._operation(run, owner, "promote", promote)
            await self._save(
                rid,
                owner,
                {
                    "state": "completed",
                    "reason": "offline_pass_and_production_limits_met_not_causal_proof"
                    if p["rollout"]["mode"] == "immediate"
                    else "canary_promoted",
                    "last_observation_id": oid,
                },
                True,
            )
        else:
            await self._save(
                rid,
                owner,
                {
                    "reason": "waiting_for_mature_outcomes",
                    "last_observation_id": oid,
                    "next_eligible_at": _plus(
                        self.loop.now(), min(60000, p["observation"]["timeout_ms"])
                    ),
                },
                True,
            )

    def _validate_observation(self, o, run, w):
        v.json_value(o, 16 * 1024 * 1024)
        d = run["data"]
        if (
            o.get("artifact_version") != d["artifact_version"]
            or o.get("configuration_hash") != d["observation_configuration_hash"]
            or v.timestamp(o.get("started_at")) != v.timestamp(d["deployed_at"])
            or not v.timestamp(o["started_at"])
            <= v.timestamp(o.get("ended_at"))
            <= v.timestamp(self.loop.now())
        ):
            v.fail("invalid_observation", "Observation identity/window mismatch.")
        if type(o.get("complete")) is not bool or type(o.get("unit_ids")) is not list:
            v.fail("invalid_observation", "Invalid observation units.")
        for key in o["unit_ids"]:
            v.nonempty(key, "observation unit")
        if len(set(o["unit_ids"])) != len(o["unit_ids"]):
            v.fail("invalid_observation", "Duplicate observation units.")
        passes_gates(o.get("metrics"), w.policy["observation"]["guardrails"])
        if w.policy["rollout"]["mode"] == "canary":
            if o.get("control_version") != d["baseline"]["artifact_version"]:
                v.fail("invalid_observation", "Canary control mismatch.")
            v.nonempty(o.get("assignment_hash"), "assignment hash")
            if d.get("assignment_hash") and d["assignment_hash"] != o["assignment_hash"]:
                v.fail("invalid_observation", "Cohort assignment definition changed.")
            v.finite(o.get("improvement_lower_bound"), "canary uncertainty bound")
            width = w.policy["objective"]["range"][1] - w.policy["objective"]["range"][0]
            if not -width <= o["improvement_lower_bound"] <= width:
                v.fail("invalid_observation", "Canary bound outside objective range.")
            control = o.get("control_unit_ids")
            if type(control) is not list or len(control) < w.policy["observation"]["minimum_units"]:
                v.fail("invalid_observation", "Independent mature control units required.")
            for key in control:
                v.nonempty(key, "control unit")
            if len(set(control)) != len(control) or set(control) & set(o["unit_ids"]):
                v.fail("invalid_observation", "Canary/control units overlap.")
