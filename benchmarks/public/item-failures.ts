/**
 * Per-item prediction failures for the public benchmarks.
 * A content filter, a clearly per-item 400, or an incomplete response scores 0
 * for that row. Auth, quota, and systemic 400s still stop the run.
 */
import {
  IncompleteOutputError,
  ProviderRequestError,
  type SafeProviderDetail,
} from "../../examples/prompt-improvement/provider.js";
import type { PredictCall } from "./task.js";

/** Stop when failed predictions in one arm and split exceed this share of that split. */
export const ITEM_FAILURE_FRACTION = 0.2;
/** Stop after this many failed predictions in a row, even when each split stays under the fraction. */
export const ITEM_FAILURE_CONSECUTIVE = 5;

const PER_ITEM_CODES = new Set([
  "content_filter",
  "responsibleaipolicyviolation",
  "context_length_exceeded",
  "string_above_max_length",
  "invalid_prompt",
]);

export interface ItemFailure {
  rowId: string;
  arm: PredictCall["arm"];
  split: PredictCall["split"];
  reason: string;
  categories: string[];
}

export interface ItemFailureCount {
  arm: PredictCall["arm"];
  split: PredictCall["split"];
  count: number;
}

export class ItemFailureStop extends Error {
  readonly reason: "item_failure_fraction" | "item_failure_consecutive";
  constructor(reason: ItemFailureStop["reason"], message: string) {
    super(message);
    this.name = "ItemFailureStop";
    this.reason = reason;
  }
}

/** Reason code for a per-item provider failure, or null when the error must stop the run. */
export function perItemReason(error: unknown): string | null {
  if (error instanceof IncompleteOutputError) {
    const reason = error.detail.incompleteReason;
    if (reason === "refusal" || reason === "empty_output") return reason;
    return reason ? `incomplete:${reason}` : "incomplete";
  }
  if (!(error instanceof ProviderRequestError) || error.status !== 400) return null;
  return perItemCode(error.detail);
}

export function failureCategories(error: unknown): string[] {
  if (!(error instanceof ProviderRequestError)) return [];
  return error.detail.categories.map((item) =>
    item.severity ? `${item.category}:${item.severity}` : item.category,
  );
}

export class ItemFailureTracker {
  readonly failures: ItemFailure[] = [];
  private consecutive = 0;
  private readonly counts = new Map<string, number>();
  private halt: ItemFailureStop | null = null;

  noteSuccess(): void {
    if (this.halt) return;
    this.consecutive = 0;
  }

  noteFailure(call: PredictCall, rowId: string, reason: string, categories: string[]): void {
    if (this.halt) return;
    this.failures.push({
      rowId,
      arm: call.arm,
      split: call.split,
      reason,
      categories,
    });
    this.consecutive += 1;
    const key = `${call.arm}\0${call.split}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (this.consecutive >= ITEM_FAILURE_CONSECUTIVE) {
      this.halt = new ItemFailureStop(
        "item_failure_consecutive",
        `Stopping after ${this.consecutive} failed predictions in a row. Last was ${call.arm} ${call.split} row ${rowId} (${reason}).`,
      );
      return;
    }
    if (call.planned > 0 && count / call.planned > ITEM_FAILURE_FRACTION) {
      this.halt = new ItemFailureStop(
        "item_failure_fraction",
        `Stopping: ${count} of ${call.planned} ${call.arm} ${call.split} predictions failed, above ${Math.round(ITEM_FAILURE_FRACTION * 100)}% of that split.`,
      );
    }
  }

  stop(): ItemFailureStop | null {
    return this.halt;
  }

  countsBySplit(): ItemFailureCount[] {
    const grouped = new Map<string, ItemFailureCount>();
    for (const failure of this.failures) {
      const key = `${failure.arm}\0${failure.split}`;
      const existing = grouped.get(key);
      if (existing) existing.count += 1;
      else grouped.set(key, { arm: failure.arm, split: failure.split, count: 1 });
    }
    return [...grouped.values()];
  }
}

export function renderItemFailureSummary(failures: readonly ItemFailure[]): string {
  if (failures.length === 0) return "";
  const groups = new Map<string, number>();
  for (const failure of failures) {
    const key = `${failure.arm} ${failure.split} ${failure.reason}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const lines = [`Item failures: ${failures.length}`];
  for (const [key, count] of groups) lines.push(`${key}: ${count}`);
  return lines.join("\n");
}

function perItemCode(detail: SafeProviderDetail): string | null {
  const code = detail.code?.toLowerCase() ?? "";
  const inner = detail.innerCode?.toLowerCase() ?? "";
  if (detail.code && PER_ITEM_CODES.has(code)) return detail.code;
  if (detail.innerCode && PER_ITEM_CODES.has(inner)) return detail.innerCode;
  if (detail.categories.length > 0) return "content_filter";
  return null;
}
