import {
  DEFAULT_API_VERSION,
  DEFAULT_DEPLOYMENT,
  LIVE_ENV,
  LiveGateError,
  readMaxTpm,
  readRequestLimits,
  type RequestLimits,
} from "../kb-qa/live.js";
import { PROPOSE_TOKEN_MAX } from "./constants.js";
import type { BenchmarkTask, PublicExample } from "./task.js";

export function resolveLimits<T extends PublicExample>(
  env: NodeJS.ProcessEnv,
  task: BenchmarkTask<T>,
): RequestLimits {
  const reasoningEnv = { ...env };
  delete reasoningEnv[LIVE_ENV.predictMax];
  delete reasoningEnv[LIVE_ENV.proposeMax];
  const reasoning = readRequestLimits(reasoningEnv).reasoningEffort;
  const predict = bounded(
    env,
    LIVE_ENV.predictMax,
    task.predict,
    `${task.title} predict max_output_tokens`,
  );
  const propose = bounded(
    env,
    LIVE_ENV.proposeMax,
    { ...task.propose, max: Math.min(task.propose.max, PROPOSE_TOKEN_MAX) },
    `${task.title} propose max_output_tokens`,
  );
  return {
    predictMaxOutputTokens: predict,
    proposeMaxOutputTokens: propose,
    reasoningEffort: reasoning,
  };
}

function bounded(
  env: NodeJS.ProcessEnv,
  name: string,
  bounds: { min: number; max: number; defaultValue: number },
  label: string,
): number {
  const raw = env[name];
  const value = raw === undefined ? bounds.defaultValue : positiveInt(raw, name);
  if (value < bounds.min || value > bounds.max)
    throw new LiveGateError(
      `${label} must be from ${bounds.min} to ${bounds.max}. Refusing to start.`,
    );
  return value;
}

function positiveInt(raw: string, name: string): number {
  if (!/^[1-9]\d*$/.test(raw.trim()))
    throw new LiveGateError(
      `${name} must be a finite integer greater than zero. Refusing to start.`,
    );
  return Number(raw.trim());
}

export function deploymentOf(env: NodeJS.ProcessEnv): { deployment: string; apiVersion: string } {
  const deployment = env[LIVE_ENV.deployment]?.trim() || DEFAULT_DEPLOYMENT;
  const apiVersion = env[LIVE_ENV.apiVersion]?.trim() || DEFAULT_API_VERSION;
  if (!deployment.trim()) throw new LiveGateError(`Invalid ${LIVE_ENV.deployment}.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(apiVersion))
    throw new LiveGateError(`Invalid ${LIVE_ENV.apiVersion}.`);
  return { deployment, apiVersion };
}

export { readMaxTpm };
