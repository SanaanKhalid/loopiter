/**
 * Pre-registered comparison for the public benchmarks.
 * The constants match benchmarks/analysis-plan.md. The report generator
 * applies `headlineVerdict` and does not choose a rule from the results.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSeedNetworkFailure } from "../kb-qa/live.js";
import { mulberry32 } from "../kb-qa/stats.js";
import { perItemReason } from "./item-failures.js";
import type { QuestionResult } from "./loop.js";
import { repoRoot } from "./paths.js";

export const ANALYSIS_PLAN_PATH = "benchmarks/analysis-plan.md";
/** Two-sided alpha. The paired interval uses confidence 1 - alpha. */
export const ANALYSIS_ALPHA = 0.05;
export const ANALYSIS_CONFIDENCE = 1 - ANALYSIS_ALPHA;
/**
 * A result is safe, never regresses when the paired CI lower bound is at
 * least this far below zero (the bound is compared with -margin).
 */
export const NON_INFERIORITY_MARGIN = 0.01;
export const PAIRED_BOOTSTRAP_SAMPLES = 2_000;
export const PAIRED_BOOTSTRAP_SEED = 17;
export const MCNEMAR_METHOD = "exact-binomial" as const;
/** Unpaired question ids at or below this count are reported. More than this throws. */
export const UNPAIRED_QUESTION_LIMIT = 5;
export const PROMPT_SENSITIVITY_DEFINITION =
  "The prompt-sensitivity score is the range, maximum minus minimum, of pooled held-out primary accuracy across the frozen baseline, the strong prompt, the one-shot rewrite, and the served controller prompt. Each seed and item counts once. A provider failure counts as incorrect. The per-seed spread is the largest within-seed range of those arms and is not the score.";

export type HeadlineVerdict = "improvement" | "no_difference" | "regression" | "safe_never_regresses";
export type FailureKind = "network" | "timeout" | "http5xx" | "refusal" | "parse";
export type ArmName = "baseline" | "strong-prompt" | "one-shot" | "controller";

export interface ArmFailureCounts {
  network: number;
  timeout: number;
  http5xx: number;
  refusal: number;
  parse: number;
}

export type ArmFailureReport = Record<ArmName, ArmFailureCounts>;

export interface PairedBootstrapInterval {
  mean: number;
  lower: number;
  upper: number;
  confidence: number;
  samples: number;
  seed: number;
  method: "paired-bootstrap-percentile";
  unit: "question";
}

export interface McNemarResult {
  /** Treatment correct and reference incorrect. */
  treatmentOnly: number;
  /** Reference correct and treatment incorrect. */
  referenceOnly: number;
  concordant: number;
  discordant: number;
  /** Raw exact binomial p-value. The primary verdict uses this. */
  pValue: number;
  /** Holm-adjusted p-value for a secondary comparison. Null on the primary. */
  adjustedPValue: number | null;
  adjustment: "none" | "holm";
  alpha: number;
  method: typeof MCNEMAR_METHOD;
}

export interface ArmComparison {
  name: string;
  treatment: string;
  reference: string;
  primary: boolean;
  /** Questions in the comparison. This is n. */
  questions: number;
  unpairedReference: number;
  unpairedTreatment: number;
  unpairedReferenceIds: string[];
  unpairedTreatmentIds: string[];
  mean: number;
  pairedBootstrap: PairedBootstrapInterval | null;
  mcnemar: McNemarResult | null;
  alpha: number;
  nonInferiorityMargin: number;
  verdict: HeadlineVerdict;
  statement: string;
}

export interface PromptSensitivityArm {
  name: string;
  successes: number;
  trials: number;
  accuracy: number;
}

export interface PromptSensitivity {
  score: number;
  perSeedSpread: number;
  definition: string;
  arms: PromptSensitivityArm[];
}

export interface SeedQuestions {
  seed: number;
  baseline: readonly QuestionResult[];
  strongPrompt: readonly QuestionResult[];
  oneShot: readonly QuestionResult[];
  controllerServed: readonly QuestionResult[];
  controllerUngated: readonly QuestionResult[] | null;
}

const COMPARISONS = [
  {
    name: "controller-served-vs-baseline",
    treatment: "controllerServed",
    reference: "baseline",
    primary: true,
  },
  {
    name: "strong-prompt-vs-baseline",
    treatment: "strongPrompt",
    reference: "baseline",
    primary: false,
  },
  {
    name: "one-shot-vs-baseline",
    treatment: "oneShot",
    reference: "baseline",
    primary: false,
  },
  {
    name: "controller-served-vs-strong-prompt",
    treatment: "controllerServed",
    reference: "strongPrompt",
    primary: false,
  },
] as const;

const SENSITIVITY_ARMS = [
  ["baseline", "baseline"],
  ["strong-prompt", "strongPrompt"],
  ["one-shot", "oneShot"],
  ["controller-served", "controllerServed"],
] as const;

type QuestionKey = (typeof SENSITIVITY_ARMS)[number][1];

export function emptyArmFailures(): ArmFailureReport {
  return {
    baseline: emptyCounts(),
    "strong-prompt": emptyCounts(),
    "one-shot": emptyCounts(),
    controller: emptyCounts(),
  };
}

export function addArmFailure(report: ArmFailureReport, arm: ArmName, kind: FailureKind): void {
  report[arm][kind] += 1;
}

const REFUSAL_REASONS = new Set([
  "refusal",
  "content_filter",
  "cyber_policy",
  "responsibleaipolicyviolation",
]);
const PARSE_REASONS = new Set(["empty_output", "invalid_output"]);

/** Map a stored reason or message onto the five reported failure buckets. */
export function failureKindForReason(reason: string): FailureKind | null {
  const key = reason.toLowerCase();
  if (key.includes("timed out") || key.includes("timeout")) return "timeout";
  if (/http 50[0234]/.test(key)) return "http5xx";
  if (key.includes("refusal") || REFUSAL_REASONS.has(key)) return "refusal";
  if (PARSE_REASONS.has(key) || key.includes("parse")) return "parse";
  if (
    key === "network" ||
    key.includes("econnreset") ||
    key.includes("econnrefused") ||
    key.includes("eai_again") ||
    key.includes("und_err_socket") ||
    key.includes("socket")
  )
    return "network";
  return null;
}

export function failureKindForError(error: unknown): FailureKind | null {
  const listed = perItemReason(error);
  if (listed) {
    const kind = failureKindForReason(listed);
    if (kind) return kind;
  }
  const message = error instanceof Error ? error.message : "";
  const fromMessage = message ? failureKindForReason(message) : null;
  if (fromMessage) return fromMessage;
  if (isSeedNetworkFailure(error)) return "network";
  return null;
}

/**
 * Two-sided exact McNemar test. Discordant counts are a Binomial(n, 0.5)
 * draw. The p-value sums every outcome whose probability is at most the
 * observed one's. This is the exact binomial test, not the continuity-corrected
 * chi-square.
 */
export function exactMcNemar(
  treatmentOnly: number,
  referenceOnly: number,
): { discordant: number; pValue: number } {
  if (!Number.isInteger(treatmentOnly) || treatmentOnly < 0)
    throw new Error("McNemar treatment-only count must be a non-negative integer.");
  if (!Number.isInteger(referenceOnly) || referenceOnly < 0)
    throw new Error("McNemar reference-only count must be a non-negative integer.");
  const discordant = treatmentOnly + referenceOnly;
  if (discordant === 0) return { discordant: 0, pValue: 1 };
  const observed = Math.min(treatmentOnly, referenceOnly);
  return { discordant, pValue: exactBinomialTwoSided(observed, discordant) };
}

export function pairedBootstrapInterval(
  differences: readonly number[],
  options?: { samples?: number; seed?: number; confidence?: number },
): PairedBootstrapInterval {
  if (differences.length === 0) throw new Error("Paired bootstrap needs at least one question.");
  for (const value of differences)
    if (!Number.isFinite(value)) throw new Error("Paired differences must be finite.");
  const samples = options?.samples ?? PAIRED_BOOTSTRAP_SAMPLES;
  const seed = options?.seed ?? PAIRED_BOOTSTRAP_SEED;
  const confidence = options?.confidence ?? ANALYSIS_CONFIDENCE;
  if (!Number.isInteger(samples) || samples < 100)
    throw new Error("Bootstrap sample count must be an integer of at least 100.");
  if (!Number.isInteger(seed)) throw new Error("Bootstrap seed must be an integer.");
  if (!(confidence > 0 && confidence < 1)) throw new Error("Confidence must be between 0 and 1.");
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < differences.length; index += 1)
      sum += differences[Math.floor(rng() * differences.length)]!;
    means.push(sum / differences.length);
  }
  means.sort((left, right) => left - right);
  const tail = (1 - confidence) / 2;
  return {
    mean,
    lower: percentile(means, tail),
    upper: percentile(means, 1 - tail),
    confidence,
    samples,
    seed,
    method: "paired-bootstrap-percentile",
    unit: "question",
  };
}

/** Holm adjusted p-values, in the input order. The family is the array length. */
export function holmAdjusted(pValues: readonly number[]): number[] {
  const family = pValues.length;
  const adjusted = new Array<number>(family).fill(1);
  const order = pValues
    .map((pValue, index) => ({ pValue, index }))
    .sort((left, right) => left.pValue - right.pValue || left.index - right.index);
  let running = 0;
  for (let rank = 0; rank < order.length; rank += 1) {
    const item = order[rank]!;
    if (!(item.pValue >= 0 && item.pValue <= 1))
      throw new Error("Holm p-values must be between 0 and 1.");
    running = Math.max(running, Math.min(1, (family - rank) * item.pValue));
    adjusted[item.index] = running;
  }
  return adjusted;
}

export function analysisPlanSha256(): string {
  const bytes = readFileSync(join(repoRoot(import.meta.url), ANALYSIS_PLAN_PATH));
  return createHash("sha256").update(bytes).digest("hex");
}

export function headlineVerdict(input: {
  lower: number;
  upper: number;
  mean: number;
  pValue: number;
  alpha?: number;
  margin?: number;
  /** Secondary comparisons pass the Holm-adjusted p-value and set this. */
  holm?: boolean;
}): { verdict: HeadlineVerdict; statement: string } {
  const alpha = input.alpha ?? ANALYSIS_ALPHA;
  const margin = input.margin ?? NON_INFERIORITY_MARGIN;
  if (!(alpha > 0 && alpha < 1)) throw new Error("Alpha must be between 0 and 1.");
  if (!(margin >= 0)) throw new Error("Non-inferiority margin must be non-negative.");
  const pName = input.holm ? "Holm-adjusted exact McNemar p-value" : "exact McNemar p-value";
  if (input.lower > 0 && input.pValue < alpha && input.mean > 0)
    return {
      verdict: "improvement",
      statement: `Improvement: the paired bootstrap CI lower bound is above 0 and the ${pName} is below alpha.`,
    };
  if (input.upper < 0 && input.pValue < alpha && input.mean < 0)
    return {
      verdict: "regression",
      statement: `Regression: the paired bootstrap CI upper bound is below 0 and the ${pName} is below alpha.`,
    };
  if (input.lower >= -margin)
    return {
      verdict: "safe_never_regresses",
      statement: `Safe, never regresses: the paired bootstrap CI lower bound is ${fixed(input.lower)}, at or above the non-inferiority margin of ${fixed(-margin)}.`,
    };
  return {
    verdict: "no_difference",
    statement:
      "No difference: the comparison is not an improvement or a regression, and the CI lower bound is below the non-inferiority margin.",
  };
}

export interface CollapsedQuestion {
  id: string;
  referenceMean: number;
  treatmentMean: number;
  /** 1 when correct on strictly more than half of the collapsed seeds. A tie is 0. */
  referenceMajority: 0 | 1;
  treatmentMajority: 0 | 1;
  seeds: number;
}

export interface CollapsedComparison {
  questions: CollapsedQuestion[];
  unpairedReferenceIds: string[];
  unpairedTreatmentIds: string[];
}

/**
 * One row per question. A question is included only when the completed seeds
 * that have it have it on both arms. Majority is strict: more than half the
 * seeds, so 1 of 2 is incorrect and 2 of 3 is correct.
 */
export function collapseQuestions(
  seeds: readonly {
    seed: number;
    reference: readonly QuestionResult[];
    treatment: readonly QuestionResult[];
  }[],
): CollapsedComparison {
  const referenceSeeds = new Map<string, Map<number, boolean>>();
  const treatmentSeeds = new Map<string, Map<number, boolean>>();
  for (const seed of seeds) {
    addArm(referenceSeeds, seed.seed, seed.reference);
    addArm(treatmentSeeds, seed.seed, seed.treatment);
  }
  const ids = [...new Set([...referenceSeeds.keys(), ...treatmentSeeds.keys()])].sort(compareId);
  const unpairedReferenceIds: string[] = [];
  const unpairedTreatmentIds: string[] = [];
  const questions: CollapsedQuestion[] = [];
  for (const id of ids) {
    const reference = referenceSeeds.get(id) ?? new Map<number, boolean>();
    const treatment = treatmentSeeds.get(id) ?? new Map<number, boolean>();
    const seedIds = [...new Set([...reference.keys(), ...treatment.keys()])].sort((left, right) => left - right);
    const paired = seedIds.filter((seedId) => reference.has(seedId) && treatment.has(seedId));
    const referenceOnly = seedIds.some((seedId) => reference.has(seedId) && !treatment.has(seedId));
    const treatmentOnly = seedIds.some((seedId) => treatment.has(seedId) && !reference.has(seedId));
    if (referenceOnly) unpairedReferenceIds.push(id);
    if (treatmentOnly) unpairedTreatmentIds.push(id);
    if (referenceOnly || treatmentOnly || paired.length === 0) continue;
    const referenceCorrect = paired.filter((seedId) => reference.get(seedId)).length;
    const treatmentCorrect = paired.filter((seedId) => treatment.get(seedId)).length;
    questions.push({
      id,
      referenceMean: referenceCorrect / paired.length,
      treatmentMean: treatmentCorrect / paired.length,
      referenceMajority: majority(referenceCorrect, paired.length),
      treatmentMajority: majority(treatmentCorrect, paired.length),
      seeds: paired.length,
    });
  }
  const unpaired = unpairedReferenceIds.length + unpairedTreatmentIds.length;
  if (unpaired > UNPAIRED_QUESTION_LIMIT)
    throw new Error(
      `Unpaired questions ${unpaired} exceed ${UNPAIRED_QUESTION_LIMIT}: reference ${unpairedReferenceIds.join(", ")}; treatment ${unpairedTreatmentIds.join(", ")}.`,
    );
  return { questions, unpairedReferenceIds, unpairedTreatmentIds };
}

export function promptSensitivity(seeds: readonly SeedQuestions[]): PromptSensitivity {
  const pooled = new Map<string, QuestionResult[]>();
  for (const [name] of SENSITIVITY_ARMS) pooled.set(name, []);
  let perSeedSpread = 0;
  for (const seed of seeds) {
    const rates: number[] = [];
    for (const [name, key] of SENSITIVITY_ARMS) {
      const items = itemsOf(seed, key);
      pooled.get(name)!.push(...items);
      if (items.length > 0) rates.push(rateOf(items));
    }
    if (rates.length >= 2) {
      const spread = Math.max(...rates) - Math.min(...rates);
      if (spread > perSeedSpread) perSeedSpread = spread;
    }
  }
  const arms = SENSITIVITY_ARMS.map(([name]) => {
    const items = pooled.get(name)!;
    const successes = items.filter((item) => item.correct).length;
    return {
      name,
      successes,
      trials: items.length,
      accuracy: items.length === 0 ? 0 : successes / items.length,
    };
  }).filter((arm) => arm.trials > 0);
  const accuracies = arms.map((arm) => arm.accuracy);
  const score = accuracies.length < 2 ? 0 : Math.max(...accuracies) - Math.min(...accuracies);
  return {
    score,
    perSeedSpread,
    definition: PROMPT_SENSITIVITY_DEFINITION,
    arms,
  };
}

export function analyzeSeeds(
  seeds: readonly SeedQuestions[],
  options?: { samples?: number; seed?: number },
): {
  analysisPlan: string;
  analysisPlanSha256: string;
  headline: ArmComparison;
  comparisons: ArmComparison[];
  promptSensitivity: PromptSensitivity;
} {
  const comparisons = COMPARISONS.map((spec) =>
    compareArms(
      spec.name,
      spec.treatment,
      spec.reference,
      spec.primary,
      seeds.map((seed) => ({
        seed: seed.seed,
        reference: itemsOf(seed, spec.reference),
        treatment: itemsOf(seed, spec.treatment),
      })),
      options,
    ),
  );
  const secondary = comparisons.filter((comparison) => !comparison.primary && comparison.mcnemar);
  const adjusted = holmAdjusted(secondary.map((comparison) => comparison.mcnemar!.pValue));
  secondary.forEach((comparison, index) => {
    const mcnemar = comparison.mcnemar!;
    mcnemar.adjustedPValue = adjusted[index]!;
    mcnemar.adjustment = "holm";
    if (!comparison.pairedBootstrap) return;
    const judged = headlineVerdict({
      lower: comparison.pairedBootstrap.lower,
      upper: comparison.pairedBootstrap.upper,
      mean: comparison.pairedBootstrap.mean,
      pValue: mcnemar.adjustedPValue,
      holm: true,
    });
    comparison.verdict = judged.verdict;
    comparison.statement = judged.statement;
  });
  const headline = comparisons.find((comparison) => comparison.primary);
  if (!headline) throw new Error("The analysis plan has no primary comparison.");
  return {
    analysisPlan: ANALYSIS_PLAN_PATH,
    analysisPlanSha256: analysisPlanSha256(),
    headline,
    comparisons,
    promptSensitivity: promptSensitivity(seeds),
  };
}

function compareArms(
  name: string,
  treatment: string,
  reference: string,
  primary: boolean,
  seeds: readonly {
    seed: number;
    reference: readonly QuestionResult[];
    treatment: readonly QuestionResult[];
  }[],
  options: { samples?: number; seed?: number } | undefined,
): ArmComparison {
  const collapsed = collapseQuestions(seeds);
  const base = {
    name,
    treatment,
    reference,
    primary,
    questions: collapsed.questions.length,
    unpairedReference: collapsed.unpairedReferenceIds.length,
    unpairedTreatment: collapsed.unpairedTreatmentIds.length,
    unpairedReferenceIds: collapsed.unpairedReferenceIds,
    unpairedTreatmentIds: collapsed.unpairedTreatmentIds,
    alpha: ANALYSIS_ALPHA,
    nonInferiorityMargin: NON_INFERIORITY_MARGIN,
  };
  if (collapsed.questions.length === 0)
    return {
      ...base,
      mean: 0,
      pairedBootstrap: null,
      mcnemar: null,
      verdict: "no_difference",
      statement: "No difference: there are no questions scored on both arms.",
    };
  const interval = pairedBootstrapInterval(
    collapsed.questions.map((question) => question.treatmentMean - question.referenceMean),
    options,
  );
  let treatmentOnly = 0;
  let referenceOnly = 0;
  let concordant = 0;
  for (const question of collapsed.questions) {
    if (question.treatmentMajority === 1 && question.referenceMajority === 0) treatmentOnly += 1;
    else if (question.treatmentMajority === 0 && question.referenceMajority === 1) referenceOnly += 1;
    else concordant += 1;
  }
  const exact = exactMcNemar(treatmentOnly, referenceOnly);
  const judged = headlineVerdict({
    lower: interval.lower,
    upper: interval.upper,
    mean: interval.mean,
    pValue: exact.pValue,
  });
  return {
    ...base,
    mean: interval.mean,
    pairedBootstrap: interval,
    mcnemar: {
      treatmentOnly,
      referenceOnly,
      concordant,
      discordant: exact.discordant,
      pValue: exact.pValue,
      adjustedPValue: null,
      adjustment: "none",
      alpha: ANALYSIS_ALPHA,
      method: MCNEMAR_METHOD,
    },
    verdict: judged.verdict,
    statement: judged.statement,
  };
}

function addArm(into: Map<string, Map<number, boolean>>, seed: number, items: readonly QuestionResult[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate question id ${item.id}.`);
    seen.add(item.id);
    const scores = into.get(item.id) ?? new Map<number, boolean>();
    scores.set(seed, item.correct);
    into.set(item.id, scores);
  }
}

/** Correct on strictly more than half of the seeds. A tie is incorrect. */
function majority(correct: number, seeds: number): 0 | 1 {
  return correct * 2 > seeds ? 1 : 0;
}

function itemsOf(seed: SeedQuestions, key: QuestionKey): readonly QuestionResult[] {
  if (key === "controllerServed") return seed.controllerServed;
  if (key === "strongPrompt") return seed.strongPrompt;
  if (key === "oneShot") return seed.oneShot;
  return seed.baseline;
}

function rateOf(items: readonly QuestionResult[]): number {
  if (items.length === 0) return 0;
  return items.filter((item) => item.correct).length / items.length;
}

function emptyCounts(): ArmFailureCounts {
  return { network: 0, timeout: 0, http5xx: 0, refusal: 0, parse: 0 };
}

function compareId(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function fixed(value: number): string {
  return value.toFixed(6);
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low]!;
  const weight = index - low;
  return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

/** Exact two-sided binomial tail at p = 0.5. Small n uses integer coefficients. */
function exactBinomialTwoSided(k: number, n: number): number {
  if (n <= 30) {
    const target = binom(n, k);
    const denom = 2 ** n;
    let numer = 0;
    for (let index = 0; index <= n; index += 1) {
      const ways = binom(n, index);
      if (ways <= target) numer += ways;
    }
    return numer / denom;
  }
  const logFact = new Array<number>(n + 1);
  logFact[0] = 0;
  for (let index = 1; index <= n; index += 1) logFact[index] = logFact[index - 1]! + Math.log(index);
  const logPmf = (index: number) => logFact[n]! - logFact[index]! - logFact[n - index]! - n * Math.LN2;
  const target = logPmf(k);
  let p = 0;
  for (let index = 0; index <= n; index += 1) {
    const logP = logPmf(index);
    if (logP <= target + 1e-12) p += Math.exp(logP);
  }
  return Math.min(1, p);
}

function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const take = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= take; index += 1) result = (result * (n - take + index)) / index;
  return result;
}
