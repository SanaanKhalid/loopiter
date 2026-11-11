/** CLI for the KB-QA harness. Live Azure calls are opt-in and fail closed. */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { renderMarkdown, runOfflineBenchmark } from "./harness.js";
import {
  LIVE_ENV,
  LIVE_OUTPUT_DIR,
  SMOKE_ROWS,
  estimateFromEnv,
  liveOptionsFromEnv,
  redactSecrets,
  renderLiveMarkdown,
  runLiveBenchmark,
  LiveExitError,
  LiveGateError,
  forceExit,
} from "./live.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();

async function main(): Promise<void> {
  if (process.argv.includes("--estimate")) {
    try {
      process.stdout.write(estimateFromEnv(process.env));
    } catch (error) {
      console.error(redactSecrets(errorText(error), secretValues()));
      process.exit(2);
    }
    return;
  }
  const liveRequested =
    process.argv.includes("--live") || process.env.LOOPITER_BENCHMARK_LIVE === "1";
  if (liveRequested) {
    if (
      !process.argv.includes("--live") ||
      process.env[LIVE_ENV.allow] !== "1"
    ) {
      console.error(
        `Live runs require --live and ${LIVE_ENV.allow}=1. No provider call was made.`,
      );
      process.exit(2);
    }
    await runLiveCli();
    return;
  }
  if (process.argv.includes("--smoke") || process.argv.includes("--stop-at-warn")) {
    console.error(
      "--smoke and --stop-at-warn are live options. Pass --live and LOOPITER_BENCH_ALLOW_LIVE=1, or use --estimate.",
    );
    process.exit(2);
  }
  const seedCount = integerOption("--seeds", 5);
  const seedStart = integerOption("--seed-start", 1);
  if (seedCount < 1 || seedCount > 100)
    throw new Error("--seeds must be from 1 to 100.");
  const seeds = Array.from({ length: seedCount }, (_, index) => seedStart + index);
  const report = await runOfflineBenchmark({
    seeds,
    perRunUsd: numberOption("--per-run-usd", 1),
    totalUsd: numberOption("--total-usd", 5),
    tolerance: numberOption("--tolerance", 0),
    bootstrapSamples: integerOption("--bootstrap", 2000),
    bootstrapSeed: integerOption("--bootstrap-seed", 17),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderMarkdown(report);
  const out = process.argv.includes("--out") ? option("--out") : "";
  if (out) {
    await writeFile(out, json);
    const markdownPath = out.endsWith(".json")
      ? out.replace(/\.json$/, ".md")
      : `${out}.md`;
    await writeFile(markdownPath, markdown);
    console.log(`${report.passed ? "PASS" : "FAIL"} ${out}`);
  } else {
    process.stdout.write(json);
    process.stdout.write("---\n");
    process.stdout.write(markdown);
  }
  if (!report.passed) process.exitCode = 1;
}

async function runLiveCli(): Promise<void> {
  const smoke = process.argv.includes("--smoke");
  const seeds = process.argv.includes("--seeds")
    ? seedList(integerOption("--seeds", smoke ? 1 : 5), integerOption("--seed-start", 1))
    : seedList(smoke ? 1 : 5, integerOption("--seed-start", 1));
  const rowLimit = process.argv.includes("--rows")
    ? integerOption("--rows", 1)
    : smoke
      ? SMOKE_ROWS
      : undefined;
  const ledgerPath = process.argv.includes("--ledger")
    ? option("--ledger")
    : `${LIVE_OUTPUT_DIR}/ledger.json`;
  const out = process.argv.includes("--out")
    ? option("--out")
    : `${LIVE_OUTPUT_DIR}/report.json`;
  let secret = "";
  try {
    if (rowLimit !== undefined && (rowLimit < 1 || rowLimit > 10_000))
      throw new LiveGateError("--rows must be from 1 to 10000.");
    const live = liveOptionsFromEnv(process.env, {
      seeds,
      ...(rowLimit === undefined ? {} : { rowLimit }),
      smoke,
      stopAtWarn: process.argv.includes("--stop-at-warn"),
      ledgerPath,
    });
    secret = live.apiKey;
    const report = await runLiveBenchmark({
      ...live,
      reportPath: out,
      handleSignals: true,
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (secret && json.includes(secret))
      throw new LiveGateError("Refusing to write a report that contains a credential.");
    await boundedWrite(out, json);
    const markdownPath = out.endsWith(".json") ? out.replace(/\.json$/, ".md") : `${out}.md`;
    await boundedWrite(markdownPath, renderLiveMarkdown(report));
    console.log(`${report.passed ? "PASS" : "FAIL"} ${out}`);
    if (report.stopped) console.error(report.stopped.message);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    if (error instanceof LiveExitError) return;
    if (error instanceof LiveGateError && !secret) {
      console.error(error.message);
      process.exit(2);
    }
    console.error(redactSecrets(errorText(error), secret ? [secret] : secretValues()));
    process.exit(error instanceof LiveGateError ? 2 : 1);
  }
}

async function boundedWrite(path: string, body: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Report write timed out.")), 10_000);
  try {
    await mkdir(dirname(path), { recursive: true });
    controller.signal.throwIfAborted();
    const temporary = `${path}.${process.pid}.report.tmp`;
    await writeFile(temporary, body, { mode: 0o600, signal: controller.signal });
    await rename(temporary, path);
  } finally {
    clearTimeout(timer);
    if (controller.signal.aborted) forceExit(1);
  }
}

function seedList(count: number, start: number): number[] {
  if (count < 1 || count > 100) throw new Error("--seeds must be from 1 to 100.");
  return Array.from({ length: count }, (_, index) => start + index);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Live run failed.";
}

function secretValues(): string[] {
  const key = process.env[LIVE_ENV.apiKey];
  return key && key.length >= 4 ? [key] : [];
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing value for ${name}.`);
  return value;
}

function integerOption(name: string, fallback: number): number {
  if (!process.argv.includes(name)) return fallback;
  const raw = option(name);
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be an integer.`);
  return Number(raw);
}

function numberOption(name: string, fallback: number): number {
  if (!process.argv.includes(name)) return fallback;
  const value = Number(option(name));
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a non-negative number.`);
  return value;
}
