/**
 * Opt-in Azure path. Live calls require --live and LOOPITER_BENCH_ALLOW_LIVE=1.
 * The spend ledger, pacer, retries, stall watchdog, and redaction are the kb-qa session.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { failureDetailText, LoopiterError, type CallbackContext } from "../../src/index.js";
import { ProviderRequestError } from "../../examples/prompt-improvement/provider.js";
import {
  LIVE_ENV,
  LiveGateError,
  LiveLedger,
  LiveSession,
  RateLimitStop,
  ExhaustedProviderError,
  NetworkOutageStop,
  isSeedNetworkFailure,
  retryableServerStatus,
  assertLiveSpendGuards,
  createExitGuard,
  createInterruptHandler,
  createStallWatchdog,
  forceExit,
  paceSettingsFromEnv,
  readLivePrices,
  redactSecrets,
  redactionSecrets,
  stallTimeoutFromEnv,
  startProgressTicker,
  writeInterruptedReport,
  type LivePrices,
  type RequestLimits,
} from "../kb-qa/live.js";
import { formatUsd, usdToMicro } from "../kb-qa/money.js";
import { requestBody } from "./bodies.js";
import { LIVE_INPUT_BYTES } from "./constants.js";
import { UnsupportedInstructionError } from "../ifbench/score.js";
import {
  addArmFailure,
  analysisPlanSha256,
  analyzeSeeds,
  emptyArmFailures,
  failureKindForError,
  failureKindForReason,
  ANALYSIS_PLAN_PATH,
  type ArmComparison,
  type ArmFailureReport,
  type ArmName,
  type PromptSensitivity,
} from "./analysis.js";
import { viewOf, type ScoreView } from "./harness.js";
import {
  ItemFailureStop,
  ItemFailureTracker,
  failureCategories,
  perItemReason,
  type ItemFailure,
  type ItemFailureCount,
} from "./item-failures.js";
import { PREDICT_NAME, PROPOSE_INSTRUCTIONS, PROPOSE_NAME } from "./instructions.js";
import { deploymentOf, resolveLimits } from "./limits.js";
import { emptySeedLog, promptHash, writeDecisionLog, type SeedDecisionLog } from "./decisions.js";
import { runController, runOneShot, scoreHeldOut, type RateDraft } from "./loop.js";
import {
  assertPoolCoversSeeds,
  buildSeededSplit,
  limitSplit,
  scoredSizes,
  splitSizes,
  type SplitSizes,
} from "./splits.js";
import { guardEvalSuite, suiteFromTask } from "./eval-lock.js";
import type { BenchmarkTask, ModelRunner, PredictCall, PublicExample } from "./task.js";

const directMeter = async <T>(
  _maximum: number,
  call: () => Promise<{ value: T; tokens: number | null }>,
): Promise<T> => (await call()).value;

export interface PublicLiveOptions {
  seeds: number[];
  rowLimit?: number;
  smoke: boolean;
  deployment: string;
  apiVersion: string;
  endpoint: string;
  apiKey: string;
  prices: LivePrices;
  totalCapUsd: number;
  warnUsd: number;
  invocationCapUsd: number;
  stopAtWarn: boolean;
  ledgerPath: string;
  limits: RequestLimits;
  minimumImprovement: number;
  minimumEffect?: number;
  /** Full-run split sizes. Omitted sizes use the task's full split. */
  sizes?: SplitSizes;
  decisionLogPath?: string;
  maxTokensPerMinute: number;
  /** 0 disables request pacing. Omitted stays off. */
  maxRequestsPerMinute?: number;
  /** Consecutive network-budget exhaustions before the run stops. Omitted uses the session default. */
  maxConsecutiveNetworkFailures?: number;
  /** Sends per transient network, timeout, or listed server error. Omitted uses the default. */
  networkAttempts?: number;
  maxRetryWaitMs: number;
  max429Retries: number;
  requestTimeoutMs: number;
  maxTotalWaitMs: number;
  stallTimeoutMs: number;
  fetch?: typeof fetch;
  reportPath?: string;
  handleSignals?: boolean;
  /** When set, verify this eval lock before any model call. */
  evalLockPath?: string;
}

export interface PublicLiveReport {
  schemaVersion: 1;
  harness: string;
  task: string;
  provider: "azure-openai";
  api: "responses";
  liveCalls: number;
  smoke: boolean;
  seeds: number[];
  rowLimit: number | null;
  splits: SplitSizes;
  minimumImprovement: number;
  promptCapCharacters: number;
  deployment: string;
  strongPromptVersion: string;
  analysisPlan: string;
  analysisPlanSha256: string;
  /** Null when the run failed, no seed completed, or paired analysis threw. */
  headline: ArmComparison | null;
  /**
   * Set when paired analysis throws. Headline, comparisons, and prompt
   * sensitivity stay null. The per-seed items are still on the report.
   */
  analysisError?: string;
  comparisons: ArmComparison[] | null;
  promptSensitivity: PromptSensitivity | null;
  armFailures: ArmFailureReport;
  arms: {
    baseline: { served: ScoreView; ungated: null };
    strongPrompt: { served: ScoreView; ungated: null; gates: "none" };
    oneShot: { served: ScoreView; ungated: ScoreView; gates: "none" };
    controller: { served: ScoreView; ungated: ScoreView | null; gates: "improvement-controller" };
  } | null;
  perSeed: {
    seed: number;
    baseline: RateDraft;
    strongPrompt: RateDraft;
    oneShot: RateDraft;
    controllerServed: RateDraft;
    controllerUngated: RateDraft | null;
    /** Served prompt hash matched the baseline. The paired difference is zero. */
    servedReused: boolean;
    /** Ungated prompt hash matched the baseline. The paired difference is zero. */
    ungatedReused: boolean;
    controllerState: string;
    controllerReason: string;
    controllerDetail: string | null;
    proposeCalls: number;
    proposeRefusals: number;
    status: "complete" | "never_proposed" | "failed";
    failure: { arm: ArmName; code: string; message: string } | null;
  }[];
  proposeRefusals: { calls: number; refused: number };
  seedFailures: {
    seed: number;
    arm: ArmName;
    code: string;
    message: string;
  }[];
  stopped: { reason: string; message: string } | null;
  itemFailures: ItemFailure[];
  itemFailureCounts: ItemFailureCount[];
  spend: {
    totalUsd: string;
    invocationUsd: string;
    calls: number;
    attempts: number;
    rejectedAttempts: number;
  };
  passed: boolean;
}

export function liveOptionsFromEnv<T extends PublicExample>(
  task: BenchmarkTask<T>,
  env: NodeJS.ProcessEnv,
  args: {
    seeds: number[];
    rowLimit?: number;
    smoke: boolean;
    stopAtWarn: boolean;
    ledgerPath: string;
    minimumImprovement: number;
    sizes?: SplitSizes;
    maxTokensPerMinute?: number;
    maxRequestsPerMinute?: number;
    maxConsecutiveNetworkFailures?: number;
    networkAttempts?: number;
  },
): PublicLiveOptions {
  if (env[LIVE_ENV.allow] !== "1")
    throw new LiveGateError(
      `Live runs require --live and ${LIVE_ENV.allow}=1. No provider call was made.`,
    );
  const prices = readLivePrices(env);
  const totalCapUsd = decimal(env, LIVE_ENV.totalCap);
  const warnUsd = decimal(env, LIVE_ENV.warn);
  const invocationCapUsd = decimal(env, LIVE_ENV.invocationCap);
  assertLiveSpendGuards({ prices, totalCapUsd, warnUsd, invocationCapUsd });
  const endpoint = required(env, LIVE_ENV.endpoint);
  const apiKey = required(env, LIVE_ENV.apiKey);
  const { deployment, apiVersion } = deploymentOf(env);
  const pace = paceSettingsFromEnv(env);
  const stallTimeoutMs = stallTimeoutFromEnv(env, pace);
  return {
    seeds: args.seeds,
    ...(args.rowLimit === undefined ? {} : { rowLimit: args.rowLimit }),
    smoke: args.smoke,
    deployment,
    apiVersion,
    endpoint,
    apiKey,
    prices,
    totalCapUsd,
    warnUsd,
    invocationCapUsd,
    stopAtWarn: args.stopAtWarn,
    ledgerPath: args.ledgerPath,
    ...(args.sizes === undefined ? {} : { sizes: args.sizes }),
    limits: resolveLimits(env, task),
    minimumImprovement: args.minimumImprovement,
    maxTokensPerMinute: args.maxTokensPerMinute ?? pace.maxTokensPerMinute,
    maxRequestsPerMinute: args.maxRequestsPerMinute ?? pace.maxRequestsPerMinute,
    maxConsecutiveNetworkFailures:
      args.maxConsecutiveNetworkFailures ?? pace.maxConsecutiveNetworkFailures,
    networkAttempts: args.networkAttempts ?? pace.networkAttempts,
    maxRetryWaitMs: pace.maxRetryWaitMs,
    max429Retries: pace.max429Retries,
    requestTimeoutMs: pace.requestTimeoutMs,
    maxTotalWaitMs: pace.maxTotalWaitMs,
    stallTimeoutMs,
  };
}

export async function runLiveTask<T extends PublicExample>(
  task: BenchmarkTask<T>,
  options: PublicLiveOptions,
  loaded: { pool: T[]; heldOut: T[] },
): Promise<PublicLiveReport> {
  if (options.evalLockPath)
    guardEvalSuite(suiteFromTask(task, loaded.heldOut), options.evalLockPath);
  const sizes = options.sizes ?? task.fullSizes;
  assertPoolCoversSeeds({
    pool: loaded.pool,
    heldOut: loaded.heldOut,
    seeds: options.seeds,
    sizes,
  });
  const ledger = await LiveLedger.open(
    options.ledgerPath,
    {
      totalMicroUsd: usdToMicro(options.totalCapUsd),
      invocationMicroUsd: usdToMicro(options.invocationCapUsd),
      warnMicroUsd: usdToMicro(options.warnUsd),
    },
    options.prices,
  );
  const session = new LiveSession(ledger, [options.apiKey], options.stopAtWarn, {
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    deployment: options.deployment,
    apiVersion: options.apiVersion,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    maxTokensPerMinute: options.maxTokensPerMinute,
    ...(options.maxRequestsPerMinute === undefined
      ? {}
      : { maxRequestsPerMinute: options.maxRequestsPerMinute }),
    ...(options.maxConsecutiveNetworkFailures === undefined
      ? {}
      : { maxConsecutiveNetworkFailures: options.maxConsecutiveNetworkFailures }),
    ...(options.networkAttempts === undefined ? {} : { networkAttempts: options.networkAttempts }),
    maxRetryWaitMs: options.maxRetryWaitMs,
    max429Retries: options.max429Retries,
    requestTimeoutMs: options.requestTimeoutMs,
    maxTotalWaitMs: options.maxTotalWaitMs,
    now: Date.now,
    sleep: delay,
    random: Math.random,
    maximumInputBytes: LIVE_INPUT_BYTES,
    ...options.limits,
  });
  const secrets = redactionSecrets(options.apiKey, options.endpoint);
  const failures = new ItemFailureTracker();
  const proposeTally = { calls: 0, refused: 0 };
  const armFailures = emptyArmFailures();
  const runner = liveRunner(task, session, failures, proposeTally, armFailures);
  const perSeed: PublicLiveReport["perSeed"] = [];
  const decisionLogs: SeedDecisionLog[] = [];
  const heartbeat = startProgressTicker(120_000, () => session.emitProgress());
  const guard = createExitGuard(forceExit);
  const onInterrupt =
    options.handleSignals && options.reportPath
      ? createInterruptHandler({
          ledger,
          reportPath: options.reportPath,
          secrets,
          guard,
          harness: `loopiter-live-${task.id}`,
        })
      : null;
  const watchdog = options.reportPath
    ? createStallWatchdog({
        intervalMs: Math.max(1, Math.min(30_000, Math.floor(options.stallTimeoutMs / 2))),
        stallMs: options.stallTimeoutMs,
        lastActivity: () => session.activityMs(),
        onStall: () => {
          guard.arm(1, () =>
            writeInterruptedReport({
              ledger,
              reportPath: options.reportPath!,
              secrets,
              harness: `loopiter-live-${task.id}`,
              reason: "stalled",
              message: "No live-run progress. Stopping instead of hanging.",
            }),
          );
        },
      })
    : null;
  if (onInterrupt) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);
  }
  const saveHeldOutQuestions = async (): Promise<void> => {
    if (options.reportPath) await writeHeldOutQuestions(options.reportPath, perSeed);
  };
  let failure: { reason: string; message: string } | null = null;
  try {
    for (const seed of options.seeds) {
      if (ledger.stopReason || session.isStopping()) break;
      const callsAt = proposeTally.calls;
      const refusedAt = proposeTally.refused;
      let phase: ArmName = "baseline";
      let baseline: RateDraft | undefined;
      let strongPrompt: RateDraft | undefined;
      let oneShot: Awaited<ReturnType<typeof runOneShot>> | undefined;
      let controller: Awaited<ReturnType<typeof runController>> | undefined;
      let recorded = false;
      try {
        const split = limitSplit(
          buildSeededSplit({
            pool: loaded.pool,
            heldOut: loaded.heldOut,
            seed,
            sizes,
          }),
          options.rowLimit,
        );
        baseline = await scoreHeldOut(task, runner, task.baselinePrompt, split.heldOut, {
          arm: "baseline",
          split: "held-out",
          planned: split.heldOut.length,
        });
        phase = "strong-prompt";
        strongPrompt = await scoreHeldOut(task, runner, task.strongPrompt, split.heldOut, {
          arm: "strong-prompt",
          split: "held-out",
          planned: split.heldOut.length,
        });
        phase = "one-shot";
        oneShot = await runOneShot({ task, split, runner, mode: "improve" });
        phase = "controller";
        const decisionLog = emptySeedLog(seed, task.baselinePrompt);
        decisionLog.splits = splitSizes(split);
        decisionLogs.push(decisionLog);
        controller = await runController({
          task,
          split,
          runner,
          mode: "improve",
          observation: "honest",
          minimumImprovement: options.minimumImprovement,
          baselineHeldOut: { promptHash: promptHash(task.baselinePrompt), result: baseline },
          ...(oneShot.baselineFeedback ? { baselineFeedback: oneShot.baselineFeedback } : {}),
          ...(options.minimumEffect !== undefined ? { minimumEffect: options.minimumEffect } : {}),
          oneShotFragment: oneShot.fragment,
          decisionLog,
          batchSize: 1,
          observeChunk: 2,
          latencyMs: session.requestTimeoutMs,
          predictMaxOutputTokens: session.limits.predictMaxOutputTokens,
          proposeMaxOutputTokens: session.limits.proposeMaxOutputTokens,
          modelId: options.deployment,
          scenario: "live",
          tickLimit: 10_000,
          timeouts: {
            callbackTimeoutMs: session.callbackTimeoutMs,
            tickTimeoutMs: session.tickTimeoutMs,
          },
        });
        const proposeCalls = proposeTally.calls - callsAt;
        const proposeRefusals = proposeTally.refused - refusedAt;
        const neverProposed = proposeCalls > 0 && proposeRefusals === proposeCalls;
        perSeed.push({
          seed,
          baseline,
          strongPrompt,
          oneShot: oneShot.heldOut,
          controllerServed: controller.heldOut,
          controllerUngated: controller.ungated,
          servedReused: controller.servedReused,
          ungatedReused: controller.ungatedReused,
          controllerState: controller.state,
          controllerReason: neverProposed ? "never_proposed" : controller.reason,
          controllerDetail: controller.detail,
          proposeCalls,
          proposeRefusals,
          status: neverProposed ? "never_proposed" : "complete",
          failure: null,
        });
        recorded = true;
        await saveHeldOutQuestions();
        if (ledger.stopReason) {
          failure = { reason: ledger.stopReason, message: "Spend cap reached." };
          break;
        }
      } catch (error) {
        if (stopsTheRun(error) || recorded) throw error;
        const recordedFailure = seedFailureView(error, secrets);
        const kind = failureKindForError(error);
        if (kind) addArmFailure(armFailures, phase, kind);
        perSeed.push({
          seed,
          baseline: baseline ?? emptyDraft(),
          strongPrompt: strongPrompt ?? emptyDraft(),
          oneShot: oneShot?.heldOut ?? emptyDraft(),
          controllerServed: controller?.heldOut ?? emptyDraft(),
          controllerUngated: controller?.ungated ?? null,
          servedReused: controller?.servedReused ?? false,
          ungatedReused: controller?.ungatedReused ?? false,
          controllerState: "failed",
          controllerReason: recordedFailure.code,
          controllerDetail: recordedFailure.message,
          proposeCalls: proposeTally.calls - callsAt,
          proposeRefusals: proposeTally.refused - refusedAt,
          status: "failed",
          failure: { arm: phase, code: recordedFailure.code, message: recordedFailure.message },
        });
        await saveHeldOutQuestions();
      }
    }
  } catch (error) {
    failure = stoppedView(error, secrets);
  } finally {
    if (options.decisionLogPath && decisionLogs.length)
      writeDecisionLog(options.decisionLogPath, decisionLogs);
    heartbeat.stop();
    watchdog?.stop();
    if (onInterrupt) {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
    }
  }
  const report = buildReport(
    task,
    options,
    ledger,
    perSeed,
    failure,
    failures,
    proposeTally,
    scoredSizes(sizes, options.rowLimit),
    armFailures,
  );
  if (options.apiKey.length >= 4 && JSON.stringify(report).includes(options.apiKey))
    throw new LiveGateError("Refusing to write a report that contains a credential.");
  return report;
}

function liveRunner<T extends PublicExample>(
  task: BenchmarkTask<T>,
  session: LiveSession,
  failures: ItemFailureTracker,
  proposeTally: { calls: number; refused: number },
  armFailures: ArmFailureReport,
): ModelRunner<T> {
  const callOf = (call: PredictCall | undefined): PredictCall =>
    call ?? { arm: "baseline", split: "held-out", planned: 0 };
  return {
    afterPredict() {
      const stop = failures.stop();
      if (stop) throw stop;
    },
    async answer(prompt, row, context, call) {
      const stop = failures.stop();
      if (stop) throw stop;
      const site = callOf(call);
      const payload = task.predictPayload(row);
      try {
        const generation = await session.generate(
          {
            instructions: prompt,
            input: payload,
            name: PREDICT_NAME,
            schema: task.predictSchema(),
          },
          requestBody({
            model: session.provider.model,
            instructions: prompt,
            payload,
            name: PREDICT_NAME,
            schema: task.predictSchema(),
            maxOutputTokens: session.limits.predictMaxOutputTokens,
            reasoningEffort: session.limits.reasoningEffort,
          }),
          session.limits.predictMaxOutputTokens,
          context ? context.meter.bind(context) : directMeter,
          signalOf(context),
        );
        const text = generation.value.text;
        if (typeof text !== "string" || !text.trim()) {
          failures.noteFailure(site, row.id, "empty_output", []);
          noteArmReason(armFailures, site.arm, "empty_output");
          return { text: "", latencyMs: generation.latencyMs, failed: true };
        }
        failures.noteSuccess();
        return { text, latencyMs: generation.latencyMs };
      } catch (error) {
        const reason = perItemReason(error);
        if (!reason) throw error;
        failures.noteFailure(site, row.id, reason, failureCategories(error));
        noteArmReason(armFailures, site.arm, reason);
        return { text: "", latencyMs: 0, failed: true };
      }
    },
    async propose(request, context) {
      const stop = failures.stop();
      if (stop) throw stop;
      const instructions = task.proposeInstructions ?? PROPOSE_INSTRUCTIONS;
      const payload = task.proposePayload(request.current, request.rows, request.feedback, {
        ...(request.exampleSeed !== undefined ? { seed: request.exampleSeed } : {}),
        ...(request.predictions !== undefined ? { predictions: request.predictions } : {}),
        ...(request.scores !== undefined ? { scores: request.scores } : {}),
      });
      try {
        const generation = await session.generate(
          {
            instructions,
            input: payload,
            name: PROPOSE_NAME,
            schema: task.proposeSchema(),
          },
          requestBody({
            model: session.provider.model,
            instructions,
            payload,
            name: PROPOSE_NAME,
            schema: task.proposeSchema(),
            maxOutputTokens: session.limits.proposeMaxOutputTokens,
            reasoningEffort: session.limits.reasoningEffort,
          }),
          session.limits.proposeMaxOutputTokens,
          context ? context.meter.bind(context) : directMeter,
          signalOf(context),
        );
        const fragment = generation.value.fragment;
        if (typeof fragment !== "string")
          throw new LiveGateError("Model proposal is missing the prompt.");
        proposeTally.calls += 1;
        return fragment;
      } catch (error) {
        const reason = perItemReason(error);
        if (!reason) throw error;
        proposeTally.calls += 1;
        proposeTally.refused += 1;
        const proposeArm: ArmName = context ? "controller" : "one-shot";
        noteArmReason(armFailures, proposeArm, reason);
        failures.noteFailure(
          {
            arm: context ? "controller" : "one-shot",
            split: "propose",
            planned: 0,
          },
          request.rows[0]?.id ?? "propose",
          reason,
          failureCategories(error),
        );
        return request.current;
      }
    },
  };
}

function emptyDraft(): RateDraft {
  return {
    successes: 0,
    trials: 0,
    rate: 0,
    loose: null,
    f1: null,
    instructionStrict: null,
    instructionLoose: null,
    items: [],
  };
}

function noteArmReason(report: ArmFailureReport, arm: ArmName, reason: string): void {
  const kind = failureKindForReason(reason);
  if (kind) addArmFailure(report, arm, kind);
}

function stopsTheRun(error: unknown): boolean {
  return !isSeedScoped(error);
}

/** Policy refusals and a throw from harness or controller logic stay on that seed. */
function isSeedScoped(error: unknown): boolean {
  if (error instanceof NetworkOutageStop) return false;
  if (isSeedNetworkFailure(error)) return true;
  if (error instanceof ProviderRequestError && retryableServerStatus(error.status)) return true;
  if (error instanceof ProviderRequestError) return perItemReason(error) !== null;
  if (!(error instanceof Error)) return false;
  if (error instanceof ExhaustedProviderError) return isSeedNetworkFailure(error);
  if (error instanceof ItemFailureStop) return false;
  if (error instanceof RateLimitStop) return false;
  if (error instanceof UnsupportedInstructionError) return false;
  if (error instanceof LoopiterError) return false;
  return true;
}

function seedFailureView(
  error: unknown,
  secrets: readonly string[],
): { code: string; message: string } {
  const message = failureDetailText(
    redactSecrets(error instanceof Error ? error.message : "Seed failed.", secrets),
  );
  const listed = perItemReason(error);
  if (listed) return { code: listed, message };
  if (error instanceof ProviderRequestError && error.detail.code)
    return { code: error.detail.code, message };
  if (isSeedNetworkFailure(error)) return { code: "network", message };
  return { code: "seed_failed", message };
}

function stoppedView(error: unknown, secrets: readonly string[]): { reason: string; message: string } {
  const message = failureDetailText(
    redactSecrets(error instanceof Error ? error.message : "Live run failed.", secrets),
  );
  if (error instanceof NetworkOutageStop) return { reason: "network_outage", message };
  if (error instanceof ItemFailureStop) return { reason: error.reason, message };
  if (error instanceof RateLimitStop) return { reason: "rate_limit", message };
  if (error instanceof UnsupportedInstructionError)
    return { reason: "unsupported_instruction", message };
  return { reason: "provider_error", message };
}

function buildReport<T extends PublicExample>(
  task: BenchmarkTask<T>,
  options: PublicLiveOptions,
  ledger: LiveLedger,
  perSeed: PublicLiveReport["perSeed"],
  failure: { reason: string; message: string } | null,
  failures: ItemFailureTracker,
  proposeTally: { calls: number; refused: number },
  sizes: SplitSizes,
  armFailures: ArmFailureReport,
): PublicLiveReport {
  const counted = perSeed.filter((row) => row.status !== "failed");
  const scored = counted.length > 0 && failure === null;
  const seedFailures = perSeed.flatMap((row) =>
    row.failure ? [{ seed: row.seed, arm: row.failure.arm, code: row.failure.code, message: row.failure.message }] : [],
  );
  let analysis: ReturnType<typeof analyzeSeeds> | null = null;
  let analysisError: string | undefined;
  if (scored) {
    try {
      analysis = analyzeSeeds(
        counted.map((row) => ({
          seed: row.seed,
          baseline: row.baseline.items,
          strongPrompt: row.strongPrompt.items,
          oneShot: row.oneShot.items,
          controllerServed: row.controllerServed.items,
          controllerUngated: row.controllerUngated?.items ?? null,
          servedReused: row.servedReused,
          ungatedReused: row.ungatedReused,
        })),
      );
    } catch (error) {
      analysisError = error instanceof Error && error.message.trim() ? error.message : "Analysis failed.";
    }
  }
  return {
    schemaVersion: 1,
    harness: `loopiter-live-${task.id}`,
    task: task.id,
    provider: "azure-openai",
    api: "responses",
    liveCalls: ledger.calls,
    smoke: options.smoke,
    seeds: options.seeds,
    rowLimit: options.rowLimit ?? null,
    splits: sizes,
    minimumImprovement: options.minimumImprovement,
    promptCapCharacters: task.promptCap,
    deployment: options.deployment,
    strongPromptVersion: task.strongPromptVersion,
    analysisPlan: ANALYSIS_PLAN_PATH,
    analysisPlanSha256: analysis?.analysisPlanSha256 ?? analysisPlanSha256(),
    headline: analysis?.headline ?? null,
    comparisons: analysis?.comparisons ?? null,
    promptSensitivity: analysis?.promptSensitivity ?? null,
    ...(analysisError === undefined ? {} : { analysisError }),
    armFailures,
    arms: scored
      ? {
          baseline: { served: viewOf(counted.map((row) => row.baseline), 2000, 17), ungated: null },
          strongPrompt: {
            served: viewOf(counted.map((row) => row.strongPrompt), 2000, 17),
            ungated: null,
            gates: "none",
          },
          oneShot: {
            served: viewOf(counted.map((row) => row.oneShot), 2000, 17),
            ungated: viewOf(counted.map((row) => row.oneShot), 2000, 17),
            gates: "none",
          },
          controller: {
            served: viewOf(counted.map((row) => row.controllerServed), 2000, 17),
            ungated: counted.every((row) => row.controllerUngated)
              ? viewOf(
                  counted.map((row) => row.controllerUngated!),
                  2000,
                  17,
                )
              : null,
            gates: "improvement-controller",
          },
        }
      : null,
    perSeed,
    proposeRefusals: { calls: proposeTally.calls, refused: proposeTally.refused },
    seedFailures,
    stopped: failure,
    itemFailures: failures.failures,
    itemFailureCounts: failures.countsBySplit(),
    spend: {
      totalUsd: formatUsd(ledger.totalMicroUsd),
      invocationUsd: formatUsd(ledger.invocationMicroUsd),
      calls: ledger.calls,
      attempts: ledger.attempts,
      rejectedAttempts: ledger.rejectedAttempts,
    },
    passed:
      analysisError === undefined &&
      failure === null &&
      perSeed.length === options.seeds.length &&
      perSeed.every((row) => row.status !== "failed"),
  };
}

/** `<reportPath>.questions.json`, the raw held-out items saved beside a live report. */
export function heldOutQuestionsPath(reportPath: string): string {
  return `${reportPath}.questions.json`;
}

/** Sibling temp path. The target is replaced only after this file is fully written. */
export function heldOutQuestionsTempPath(reportPath: string): string {
  return `${heldOutQuestionsPath(reportPath)}.${process.pid}.tmp`;
}

/**
 * Write every held-out question recorded so far, per seed and per arm.
 * The body goes to a temp file in the same directory, then replaces the target.
 * A crash during the write leaves the previous target intact.
 */
export async function writeHeldOutQuestions(
  reportPath: string,
  perSeed: PublicLiveReport["perSeed"],
): Promise<void> {
  const target = heldOutQuestionsPath(reportPath);
  const temporary = heldOutQuestionsTempPath(reportPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    temporary,
    `${JSON.stringify(
      {
        perSeed: perSeed.map((row) => ({
          seed: row.seed,
          baseline: row.baseline.items,
          strongPrompt: row.strongPrompt.items,
          oneShot: row.oneShot.items,
          controllerServed: row.controllerServed.items,
          controllerUngated: row.controllerUngated?.items ?? null,
          servedReused: row.servedReused,
          ungatedReused: row.ungatedReused,
        })),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, target);
}

function signalOf(context: CallbackContext | null): AbortSignal {
  return context?.signal ?? new AbortController().signal;
}

function decimal(env: NodeJS.ProcessEnv, name: string): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "")
    throw new LiveGateError(`Missing ${name}. Refusing to start.`);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw.trim()))
    throw new LiveGateError(`${name} must be a finite number greater than zero. Refusing to start.`);
  const value = Number(raw.trim());
  if (!(value > 0))
    throw new LiveGateError(`${name} must be a finite number greater than zero. Refusing to start.`);
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (!value) throw new LiveGateError(`Missing ${name}. Refusing to start.`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
