"""Executable adapter conformance checks. Use only an explicitly disposable namespace."""

import asyncio
from copy import deepcopy
from uuid import uuid4

from . import FeedbackLoop, LoopiterError
from .store import FeedbackStore


async def run_store_conformance(store: FeedbackStore, *, namespace: str | None = None) -> None:
    """Asserts transaction, revision, idempotency, isolation and pagination guarantees.

    Creates/deletes its own unique namespaces. Supplying a namespace is an explicit
    request to clear that namespace; never pass a production namespace.
    Does not close the developer-owned store/pool. Raises AssertionError on failure.
    """
    namespace = namespace or f"loopiter-conformance/{uuid4()}"
    other = namespace + "/isolated"
    loop = FeedbackLoop(store=store, namespace=namespace)
    isolated = FeedbackLoop(store=store, namespace=other)
    try:
        first = await loop.record_execution(id="a", kind="prediction")
        assert await loop.record_execution(id="a", kind="prediction") == first
        assert await isolated.get_execution("a") is None
        await isolated.record_execution(id="a", kind="tool")
        try:
            await loop.record_execution(id="a", kind="tool")
        except LoopiterError as e:
            assert e.code == "conflict"
        else:
            raise AssertionError("Conflicting insert overwrote an existing record")
        results = await asyncio.gather(
            *(
                loop.complete_execution("a", expected_revision=1, output={"attempt": i})
                for i in range(2)
            ),
            return_exceptions=True,
        )
        assert sum(isinstance(r, dict) for r in results) == 1
        assert sum(isinstance(r, LoopiterError) and r.code == "conflict" for r in results) == 1
        current = await loop.get_execution("a")
        async with store.transaction(namespace) as tx:
            leaked = tx
            record = deepcopy(current)
            record.update(id="b", revision=1)
            await tx.insert("executions", record)
        try:
            await leaked.get("executions", "a")
        except LoopiterError as e:
            assert e.code == "transaction_closed"
        else:
            raise AssertionError("Completed transaction remained usable")
        try:
            async with store.transaction(namespace) as tx:
                record = deepcopy(first)
                record["id"] = "rolled-back"
                await tx.insert("executions", record)
                raise RuntimeError("injected rollback")
        except RuntimeError:
            pass
        assert await loop.get_execution("rolled-back") is None
        async with store.transaction(namespace) as tx:
            returned = await tx.get("executions", "a")
            returned["kind"] = "custom"
        assert (await loop.get_execution("a"))["kind"] == "prediction"
        page = await loop.list("executions", limit=1)
        assert [r["id"] for r in page["items"]] == ["a"]
        assert [
            r["id"] for r in (await loop.list("executions", cursor=page["next_cursor"]))["items"]
        ] == ["b"]
        signal = await loop.record_signal(
            id="signal", execution_id="a", kind="rating", name="correct", value=True, source="test"
        )
        try:
            async with store.transaction(namespace) as tx:
                signal["revision"] += 1
                await tx.replace("signals", signal, 1)
        except LoopiterError as e:
            assert e.code == "immutable_record"
        else:
            raise AssertionError("Signal was mutable")
        try:
            async with store.transaction(other) as tx:
                await tx.insert("executions", first)
        except LoopiterError as e:
            assert e.code == "namespace_mismatch"
        else:
            raise AssertionError("Cross-namespace write accepted")
        await loop.delete_namespace(confirmation=namespace)
        assert await loop.get_execution("a") is None
        assert (await isolated.get_execution("a"))["kind"] == "tool"
    finally:
        await store.delete_namespace(namespace)
        await store.delete_namespace(other)
