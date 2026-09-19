import test from "node:test";
import assert from "node:assert/strict";
import {
  runDemo,
  type DemoKind,
  type DemoPath,
} from "../examples/autonomous/demo.js";
for (const kind of ["prompt", "models", "decision"] as DemoKind[])
  for (const path of [
    "accepted",
    "rejected",
    "insufficient",
    "interrupted",
    "regression",
  ] as DemoPath[])
    test(`measured offline ${kind}/${path}`, async () => {
      const report = await runDemo(kind, path);
      assert.equal(
        report.result?.state,
        path === "rejected"
          ? "no_improvement"
          : path === "insufficient"
            ? "waiting_for_evidence"
            : path === "regression"
              ? "rolled_back"
              : "completed",
        JSON.stringify(report.result),
      );
      if (path === "regression")
        assert.equal(report.activeVersion, report.baseline);
      if (path === "accepted")
        assert.notEqual(report.activeVersion, report.baseline);
    });
