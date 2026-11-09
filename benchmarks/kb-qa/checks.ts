/**
 * Pure judgments for the two harness checks. The loop supplies the evidence;
 * these functions only decide pass or fail.
 */

export interface RegressionEvidence {
  tolerance: number;
  harmful: {
    finalState: string;
    finalReason: string;
    sawValidationFailure: boolean;
    baselineRate: number;
    servedRate: number;
    counterfactualRate: number;
    servedVersion: string;
    baselineVersion: string;
  };
  rollback: {
    finalState: string;
    finalReason: string;
    sawGuardrailFailure: boolean;
    baselineRate: number;
    servedRate: number;
    servedVersion: string;
    baselineVersion: string;
  };
}

export interface CheckJudgment {
  passed: boolean;
  failures: string[];
}

export function judgeRegression(evidence: RegressionEvidence): CheckJudgment {
  const failures: string[] = [];
  const harmful = evidence.harmful;
  if (harmful.finalState !== "no_improvement" || !harmful.sawValidationFailure)
    failures.push(
      "Harmful candidate was not rejected by the validation gate.",
    );
  if (harmful.servedVersion !== harmful.baselineVersion)
    failures.push("Harmful candidate changed the served artifact.");
  if (!withinTolerance(harmful.servedRate, harmful.baselineRate, evidence.tolerance))
    failures.push(
      "Served held-out success dropped below the frozen baseline after the harmful candidate.",
    );
  if (!(harmful.counterfactualRate < harmful.baselineRate - evidence.tolerance))
    failures.push(
      "Injected candidate was not actually worse than the baseline on held-out items.",
    );
  const rollback = evidence.rollback;
  if (
    rollback.finalState !== "rolled_back" ||
    rollback.finalReason !== "previous_version_restored" ||
    !rollback.sawGuardrailFailure
  )
    failures.push(
      "Observation failure did not roll the served artifact back.",
    );
  if (rollback.servedVersion !== rollback.baselineVersion)
    failures.push("Rollback did not restore the baseline artifact version.");
  if (!withinTolerance(rollback.servedRate, rollback.baselineRate, evidence.tolerance))
    failures.push(
      "Served held-out success dropped below the frozen baseline after rollback.",
    );
  return { passed: failures.length === 0, failures };
}

export interface BudgetEvidence {
  perRunCapMicroUsd: number;
  totalCapMicroUsd: number;
  totalMicroUsd: number;
  runs: {
    stopReason: string | null;
    finalState: string;
    finalReason: string;
    microUsd: number;
    calls: number;
    refusedCalls: number;
  }[];
}

export function judgeBudget(evidence: BudgetEvidence): CheckJudgment {
  const failures: string[] = [];
  if (evidence.runs.length < 2)
    failures.push("Budget check needs a per-run stop and a later total stop.");
  if (evidence.totalMicroUsd > evidence.totalCapMicroUsd)
    failures.push("Total simulated spend exceeded the total cap.");
  for (const [index, run] of evidence.runs.entries()) {
    if (run.microUsd > evidence.perRunCapMicroUsd)
      failures.push(`Run ${index + 1} exceeded the per-run cap.`);
    if (run.finalState === "completed")
      failures.push(`Run ${index + 1} finished the loop instead of stopping at the cap.`);
    if (run.finalReason !== "spend_cap")
      failures.push(`Run ${index + 1} stopped for ${run.finalReason}, not the spend cap.`);
    if (run.refusedCalls < 1)
      failures.push(`Run ${index + 1} never refused a call.`);
  }
  const reasons = evidence.runs.map((run) => run.stopReason);
  if (!reasons.includes("per_run_cap"))
    failures.push("No run stopped on the per-run cap.");
  if (!reasons.includes("total_cap"))
    failures.push("No run stopped on the total cap.");
  return { passed: failures.length === 0, failures };
}

function withinTolerance(
  served: number,
  baseline: number,
  tolerance: number,
): boolean {
  return served >= baseline - tolerance;
}
