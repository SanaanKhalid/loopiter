/** Produce reproducible SIMULATED workflow evidence; never calls a provider or publishes. */
import { writeFile } from "node:fs/promises";
import { runDemo } from "../dist/examples/autonomous/demo.js";
function summarize(comparison) {
  if (!comparison) return null;
  const n = comparison.cases.length;
  return {
    sampleCount: n,
    baselineMean: n
      ? comparison.cases.reduce((s, r) => s + r.baseline, 0) / n
      : null,
    candidateMean: n
      ? comparison.cases.reduce((s, r) => s + r.candidate, 0) / n
      : null,
    metrics: comparison.metrics,
    estimatedServingCost: comparison.estimatedServingCost,
  };
}
const workflows = [];
for (const kind of ["prompt", "models", "decision"])
  for (const path of [
    "accepted",
    "rejected",
    "insufficient",
    "interrupted",
    "regression",
  ]) {
    const report = await runDemo(kind, path);
    workflows.push({
      kind,
      path,
      transitions: report.transitions,
      result: report.result,
      baseline: report.baseline,
      activeVersion: report.activeVersion,
      validation: Object.fromEntries(
        Object.entries(report.validation ?? {}).map(([id, comparison]) => [
          id,
          summarize(comparison),
        ]),
      ),
      audit: summarize(report.audit),
      observations: report.observations,
    });
  }
const evidence = {
  generatedAt: new Date().toISOString(),
  release: "0.3.0-alpha.1",
  runtime: process.version,
  evidence:
    "SIMULATED: deterministic predictions, synthetic labeled examples, in-memory serving registry and simulated observation clock",
  injectedFailures: [
    "Lost apply receipt in interrupted path",
    "Wrong subsequent predictions in regression path",
  ],
  liveModelCalls: 0,
  provesCausalProductionImprovement: false,
  workflows,
};
const output = JSON.stringify(evidence, null, 2) + "\n";
if (process.argv[2]) {
  await writeFile(process.argv[2], output, { flag: "wx" });
  console.log(
    `Wrote ${workflows.length} simulated workflow reports to ${process.argv[2]}`,
  );
} else console.log(output);
