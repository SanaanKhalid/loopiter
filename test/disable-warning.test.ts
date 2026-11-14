import assert from "node:assert/strict";
import test from "node:test";
import { warnAmbiguousImprovementDisable } from "../src/index.js";

test("ambiguous disable warning is once per process", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };
  try {
    const env = { ...process.env, LOOPITER_DISABLE: "enabled" };
    warnAmbiguousImprovementDisable(env);
    warnAmbiguousImprovementDisable({ ...env, LOOPITER_DISABLE: "enable" });
  } finally {
    console.error = original;
  }
  assert.equal(
    lines.filter((line) => line.includes("disables improvement work")).length,
    1,
  );
});
