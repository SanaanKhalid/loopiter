import type { ControlRecord, JsonObject } from "./contracts.js";
import type { AutonomyPolicy } from "./improvement-contracts.js";
import type { StoreTransaction } from "./store.js";
import { fail, finite, integer, timestamp } from "./utils.js";
import { fields } from "./validation.js";

export interface RunCaps {
  monthlyBudget?: number;
  callCost?: number;
  runsPerDay?: number;
}

export function validateCaps(value: unknown): void {
  fields(value, ["monthlyBudget", "callCost", "runsPerDay"]);
  const caps = value as RunCaps;
  if (caps.monthlyBudget !== undefined) {
    finite(caps.monthlyBudget, "monthlyBudget", 0);
    if (caps.callCost === undefined)
      fail("invalid_input", "monthlyBudget requires callCost.");
  }
  if (caps.callCost !== undefined) finite(caps.callCost, "callCost", 0);
  if (caps.runsPerDay !== undefined) integer(caps.runsPerDay, "runsPerDay", 0);
}

export function isModelOperation(kind: string): boolean {
  return (
    kind.startsWith("propose:") ||
    kind.startsWith("validation:") ||
    kind.startsWith("audit:")
  );
}

export function countsAsRun(kind: string): boolean {
  return kind === "propose:0";
}

function utcParts(now: string): { month: string; day: string } {
  timestamp(now, "clock");
  return { month: now.slice(0, 7), day: now.slice(0, 10) };
}

function amount(data: JsonObject | undefined): number {
  const value = data?.amount;
  return typeof value === "number" ? value : 0;
}

function count(data: JsonObject | undefined): number {
  const value = data?.count;
  return typeof value === "number" ? value : 0;
}

async function readData(
  tx: StoreTransaction,
  id: string,
): Promise<JsonObject | undefined> {
  const row = (await tx.get("coordination", id)) as ControlRecord | undefined;
  return row?.data;
}

/** Read-only. Undefined means the call may proceed. */
export async function capBlock(
  tx: StoreTransaction,
  caps: RunCaps | undefined,
  now: string,
  kind: string,
): Promise<"budget_cap" | "daily_run_cap" | undefined> {
  if (!caps || !isModelOperation(kind)) return undefined;
  const { month, day } = utcParts(now);
  if (caps.runsPerDay !== undefined && countsAsRun(kind)) {
    const runs = count(await readData(tx, `cap-runs:${day}`));
    if (runs >= caps.runsPerDay) return "daily_run_cap";
  }
  const cost = caps.callCost ?? 0;
  if (caps.monthlyBudget !== undefined) {
    const spent = amount(await readData(tx, `cap-spend:${month}`));
    if (spent + cost > caps.monthlyBudget) return "budget_cap";
  }
  return undefined;
}

async function writeData(
  tx: StoreTransaction,
  namespace: string,
  now: string,
  id: string,
  data: JsonObject,
): Promise<void> {
  const old = (await tx.get("coordination", id)) as ControlRecord | undefined;
  const row: ControlRecord = {
    id,
    namespace,
    revision: (old?.revision ?? 0) + 1,
    createdAt: old?.createdAt ?? now,
    updatedAt: old && old.updatedAt > now ? old.updatedAt : now,
    format: 1,
    data,
  };
  if (old) await tx.replace("coordination", row, old.revision);
  else await tx.insert("coordination", row);
}

/** Charge a model call before it runs. Throws budget_cap or daily_run_cap with no write. */
export async function admitModelCall(
  tx: StoreTransaction,
  namespace: string,
  caps: RunCaps | undefined,
  now: string,
  kind: string,
): Promise<void> {
  const block = await capBlock(tx, caps, now, kind);
  if (block === "budget_cap") fail("budget_cap", "Monthly budget reached.");
  if (block === "daily_run_cap") fail("daily_run_cap", "Daily run cap reached.");
  if (!caps || !isModelOperation(kind)) return;
  const { month, day } = utcParts(now);
  if (caps.monthlyBudget !== undefined) {
    const id = `cap-spend:${month}`;
    const spent = amount(await readData(tx, id));
    await writeData(tx, namespace, now, id, { amount: spent + (caps.callCost ?? 0) });
  }
  if (caps.runsPerDay !== undefined && countsAsRun(kind)) {
    const id = `cap-runs:${day}`;
    const runs = count(await readData(tx, id));
    await writeData(tx, namespace, now, id, { count: runs + 1 });
  }
}

export function capsOf(policy: AutonomyPolicy): RunCaps | undefined {
  return policy.caps;
}
