/**
 * Opt-in Azure path. Live calls require --live and LOOPITER_BENCH_ALLOW_LIVE=1.
 * The spend ledger, pacer, retries, stall watchdog, and redaction are the kb-qa session.
 */
import type { CallbackContext } from "../../src/index.js";
import {
  LIVE_ENV,
  LiveGateError,
  LiveLedger,
  LiveSession,
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
import { viewOf, type ScoreView } from "./harness.js";
import { PREDICT_NAME, PROPOSE_INSTRUCTIONS, PROPOSE_NAME } from "./instructions.js";
import { deploymentOf, resolveLimits } from "./limits.js";
import { runController, runOneShot, scoreHeldOut, type RateDraft } from "./loop.js";
import { buildSeededSplit, limitSplit } from "./splits.js";
import type { BenchmarkTask, ModelRunner, PublicExample } from "./task.js";

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
  maxTokensPerMinute: number;
  maxRetryWaitMs: number;
  max429Retries: number;
  requestTimeoutMs: number;
  maxTotalWaitMs: number;
  stallTimeoutMs: number;
  fetch?: typeof fetch;
  reportPath?: string;
  handleSignals?: boolean;
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
  minimumImprovement: number;
  promptCapCharacters: number;
  deployment: string;
  arms: {
    baseline: { served: ScoreView; ungated: null };
    oneShot: { served: ScoreView; ungated: ScoreView; gates: "none" };
    controller: { served: ScoreView; ungated: ScoreView | null; gates: "improvement-controller" };
  } | null;
  perSeed: {
    seed: number;
    baseline: RateDraft;
    oneShot: RateDraft;
    controllerServed: RateDraft;
    controllerUngated: RateDraft | null;
    controllerState: string;
  }[];
  stopped: { reason: string; message: string } | null;
  spend: { totalUsd: string; invocationUsd: string; calls: number; attempts: number };
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
    limits: resolveLimits(env, task),
    minimumImprovement: args.minimumImprovement,
    maxTokensPerMinute: pace.maxTokensPerMinute,
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
  const runner = liveRunner(task, session);
  const perSeed: PublicLiveReport["perSeed"] = [];
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
  let failure: { reason: string; message: string } | null = null;
  try {
    for (const seed of options.seeds) {
      if (ledger.stopReason || session.isStopping()) break;
      const split = limitSplit(
        buildSeededSplit({
          pool: loaded.pool,
          heldOut: loaded.heldOut,
          seed,
          sizes: task.fullSizes,
        }),
        options.rowLimit,
      );
      const baseline = await scoreHeldOut(task, runner, task.baselinePrompt, split.heldOut);
      const oneShot = await runOneShot({ task, split, runner, mode: "improve" });
      const controller = await runController({
        task,
        split,
        runner,
        mode: "improve",
        observation: "honest",
        minimumImprovement: options.minimumImprovement,
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
      perSeed.push({
        seed,
        baseline,
        oneShot: oneShot.heldOut,
        controllerServed: controller.heldOut,
        controllerUngated: controller.ungated,
        controllerState: controller.state,
      });
      if (ledger.stopReason) {
        failure = { reason: ledger.stopReason, message: "Spend cap reached." };
        break;
      }
    }
  } catch (error) {
    failure = {
      reason: "provider_error",
      message: redactSecrets(error instanceof Error ? error.message : "Live run failed.", secrets),
    };
  } finally {
    heartbeat.stop();
    watchdog?.stop();
    if (onInterrupt) {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
    }
  }
  const report = buildReport(task, options, ledger, perSeed, failure);
  if (options.apiKey.length >= 4 && JSON.stringify(report).includes(options.apiKey))
    throw new LiveGateError("Refusing to write a report that contains a credential.");
  return report;
}

function liveRunner<T extends PublicExample>(
  task: BenchmarkTask<T>,
  session: LiveSession,
): ModelRunner<T> {
  return {
    async answer(prompt, row, context) {
      const payload = task.predictPayload(row);
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
      if (typeof text !== "string" || !text.trim())
        throw new LiveGateError("Model output is missing text.");
      return { text, latencyMs: generation.latencyMs };
    },
    async propose(request, context) {
      const payload = task.proposePayload(request.current, request.rows, request.feedback);
      const generation = await session.generate(
        {
          instructions: PROPOSE_INSTRUCTIONS,
          input: payload,
          name: PROPOSE_NAME,
          schema: task.proposeSchema(),
        },
        requestBody({
          model: session.provider.model,
          instructions: PROPOSE_INSTRUCTIONS,
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
      return fragment;
    },
  };
}

function buildReport<T extends PublicExample>(
  task: BenchmarkTask<T>,
  options: PublicLiveOptions,
  ledger: LiveLedger,
  perSeed: PublicLiveReport["perSeed"],
  failure: { reason: string; message: string } | null,
): PublicLiveReport {
  const scored = perSeed.length > 0 && failure === null;
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
    minimumImprovement: options.minimumImprovement,
    promptCapCharacters: task.promptCap,
    deployment: options.deployment,
    arms: scored
      ? {
          baseline: { served: viewOf(perSeed.map((row) => row.baseline), 2000, 17), ungated: null },
          oneShot: {
            served: viewOf(perSeed.map((row) => row.oneShot), 2000, 17),
            ungated: viewOf(perSeed.map((row) => row.oneShot), 2000, 17),
            gates: "none",
          },
          controller: {
            served: viewOf(perSeed.map((row) => row.controllerServed), 2000, 17),
            ungated: perSeed.every((row) => row.controllerUngated)
              ? viewOf(
                  perSeed.map((row) => row.controllerUngated!),
                  2000,
                  17,
                )
              : null,
            gates: "improvement-controller",
          },
        }
      : null,
    perSeed,
    stopped: failure,
    spend: {
      totalUsd: formatUsd(ledger.totalMicroUsd),
      invocationUsd: formatUsd(ledger.invocationMicroUsd),
      calls: ledger.calls,
      attempts: ledger.attempts,
    },
    passed: failure === null && perSeed.length === options.seeds.length,
  };
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
