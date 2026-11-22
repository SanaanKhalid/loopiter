/** Shared CLI: --estimate, --smoke, --live, --fixtures, --minimum-improvement. */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  LIVE_ENV,
  LiveGateError,
  paceOverrides,
  redactSecrets,
} from "../kb-qa/live.js";
import { MAX_SPLIT_ROWS, PRODUCT_MINIMUM_IMPROVEMENT } from "./constants.js";
import { decisionsBeside } from "./decisions.js";
import { renderTaskEstimate } from "./estimate.js";
import { renderMarkdown, runOfflineBenchmark } from "./harness.js";
import { renderItemFailureSummary } from "./item-failures.js";
import { liveOptionsFromEnv, runLiveTask } from "./live.js";
import { applyRowCounts, type SplitSizes } from "./splits.js";
import type { BenchmarkTask, PublicExample } from "./task.js";

export interface RowCountOverrides {
  validationRows?: number;
  auditRows?: number;
}

/** `--validation-rows` and `--audit-rows` when present. Absent flags are not filled in. */
export function rowCountOverrides(argv: readonly string[] = process.argv): RowCountOverrides {
  const overrides: RowCountOverrides = {};
  if (argv.includes("--validation-rows"))
    overrides.validationRows = splitRowCount("--validation-rows", 1, argv);
  if (argv.includes("--audit-rows")) overrides.auditRows = splitRowCount("--audit-rows", 2, argv);
  return overrides;
}

/**
 * Full-plan selection for `--estimate`. Undefined when the caller did not
 * change seeds or row counts, so the default plan stays the five full seeds.
 */
export function estimateSelection(
  argv: readonly string[],
  full: SplitSizes,
): { seeds?: readonly number[]; sizes?: SplitSizes } | undefined {
  const overrides = rowCountOverrides(argv);
  const customSeeds = argv.includes("--seeds") || argv.includes("--seed-start");
  const customSizes =
    overrides.validationRows !== undefined || overrides.auditRows !== undefined;
  if (!customSeeds && !customSizes) return undefined;
  const seeds = customSeeds
    ? seedList(integerOption("--seeds", 5, argv), integerOption("--seed-start", 1, argv))
    : undefined;
  return {
    ...(seeds === undefined ? {} : { seeds }),
    ...(customSizes ? { sizes: applyRowCounts(full, overrides) } : {}),
  };
}

export async function cliMain<T extends PublicExample>(task: BenchmarkTask<T>): Promise<void> {
  let overrides: RowCountOverrides;
  try {
    overrides = rowCountOverrides(process.argv);
  } catch (error) {
    console.error(errorText(error));
    process.exit(2);
  }
  if (process.argv.includes("--estimate")) {
    try {
      process.stdout.write(
        renderTaskEstimate(task, process.env, estimateSelection(process.argv, task.fullSizes)),
      );
    } catch (error) {
      console.error(redactSecrets(errorText(error), secretValues()));
      process.exit(2);
    }
    return;
  }
  const liveRequested =
    process.argv.includes("--live") || process.env.LOOPITER_BENCHMARK_LIVE === "1";
  if (liveRequested) {
    if (!process.argv.includes("--live") || process.env[LIVE_ENV.allow] !== "1") {
      console.error(
        `Live runs require --live and ${LIVE_ENV.allow}=1. No provider call was made.`,
      );
      process.exit(2);
    }
    if (process.argv.includes("--fixtures")) {
      console.error("Live mode reads the fetched cache. Refusing to send fixtures.");
      process.exit(2);
    }
    await runLiveCli(task, overrides);
    return;
  }
  if (process.argv.includes("--smoke") || process.argv.includes("--stop-at-warn")) {
    console.error(
      "--smoke and --stop-at-warn are live options. Pass --live and LOOPITER_BENCH_ALLOW_LIVE=1, or use --estimate.",
    );
    process.exit(2);
  }
  const minimumImprovement = readMinimumImprovement();
  const minimumEffect = readMinimumEffect();
  const seeds = seedList(integerOption("--seeds", 5), integerOption("--seed-start", 1));
  const source = process.argv.includes("--fixtures") ? "fixtures" : "cache";
  const customSizes =
    overrides.validationRows !== undefined || overrides.auditRows !== undefined;
  const baseSizes = source === "fixtures" ? task.fixtureSizes : task.fullSizes;
  try {
    const out = process.argv.includes("--out") ? option("--out") : "";
    const report = await runOfflineBenchmark(task, {
      seeds,
      minimumImprovement,
      ...(minimumEffect === undefined ? {} : { minimumEffect }),
      source,
      ...(customSizes ? { sizes: applyRowCounts(baseSizes, overrides) } : {}),
      ...(out ? { decisionLogPath: decisionsBeside(out) } : {}),
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const markdown = renderMarkdown(report);
    if (out) {
      await writeFile(out, json);
      const markdownPath = out.endsWith(".json") ? out.replace(/\.json$/, ".md") : `${out}.md`;
      await writeFile(markdownPath, markdown);
      console.log(`${report.passed ? "PASS" : "FAIL"} ${out}`);
    } else {
      process.stdout.write(json);
      process.stdout.write("---\n");
      process.stdout.write(markdown);
    }
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(redactSecrets(errorText(error), secretValues()));
    process.exitCode = 1;
  }
}

async function runLiveCli<T extends PublicExample>(
  task: BenchmarkTask<T>,
  overrides: RowCountOverrides,
): Promise<void> {
  const smoke = process.argv.includes("--smoke");
  const seeds = seedList(
    integerOption("--seeds", smoke ? 1 : 5),
    integerOption("--seed-start", 1),
  );
  const rowLimit = process.argv.includes("--rows")
    ? integerOption("--rows", 1)
    : smoke
      ? task.smokeRows
      : undefined;
  const ledgerPath = process.argv.includes("--ledger")
    ? option("--ledger")
    : `${task.liveDir}/ledger.json`;
  const out = process.argv.includes("--out") ? option("--out") : `${task.liveDir}/report.json`;
  let secret = "";
  try {
    if (rowLimit !== undefined && (rowLimit < 1 || rowLimit > 10_000))
      throw new LiveGateError("--rows must be from 1 to 10000.");
    const live = liveOptionsFromEnv(task, process.env, {
      seeds,
      ...(rowLimit === undefined ? {} : { rowLimit }),
      smoke,
      stopAtWarn: process.argv.includes("--stop-at-warn"),
      ledgerPath,
      minimumImprovement: readMinimumImprovement(),
      ...(readMinimumEffect() === undefined ? {} : { minimumEffect: readMinimumEffect() }),
      sizes: applyRowCounts(task.fullSizes, overrides),
      ...paceOverrides(process.argv),
    });
    secret = live.apiKey;
    const loaded = await task.loadCache();
    const report = await runLiveTask(
      task,
      { ...live, reportPath: out, decisionLogPath: decisionsBeside(out), handleSignals: true },
      loaded,
    );
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (secret && json.includes(secret))
      throw new LiveGateError("Refusing to write a report that contains a credential.");
    await boundedWrite(out, json);
    console.log(`${report.passed ? "PASS" : "FAIL"} ${out}`);
    const failureSummary = renderItemFailureSummary(report.itemFailures);
    if (failureSummary) console.error(failureSummary);
    if (report.stopped) console.error(report.stopped.message);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    if (error instanceof LiveGateError && !secret) {
      console.error(error.message);
      process.exit(2);
    }
    console.error(redactSecrets(errorText(error), secret ? [secret] : secretValues()));
    process.exit(error instanceof LiveGateError ? 2 : 1);
  }
}

async function boundedWrite(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.report.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
}

function readMinimumEffect(): number | undefined {
  if (!process.argv.includes("--minimum-effect")) return undefined;
  const value = Number(option("--minimum-effect"));
  if (!Number.isFinite(value)) throw new Error("--minimum-effect must be a finite number.");
  return value;
}

function readMinimumImprovement(): number {
  if (!process.argv.includes("--minimum-improvement")) return PRODUCT_MINIMUM_IMPROVEMENT;
  const value = Number(option("--minimum-improvement"));
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("--minimum-improvement must be a number from 0 to 1.");
  return value;
}

function seedList(count: number, start: number): number[] {
  if (count < 1 || count > 100) throw new Error("--seeds must be from 1 to 100.");
  return Array.from({ length: count }, (_, index) => start + index);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Benchmark failed.";
}

function secretValues(): string[] {
  const key = process.env[LIVE_ENV.apiKey];
  return key && key.length >= 4 ? [key] : [];
}

function option(name: string, argv: readonly string[] = process.argv): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing value for ${name}.`);
  return value;
}

function integerOption(name: string, fallback: number, argv: readonly string[] = process.argv): number {
  if (!argv.includes(name)) return fallback;
  const raw = option(name, argv);
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be an integer.`);
  return Number(raw);
}

function splitRowCount(name: string, minimum: number, argv: readonly string[]): number {
  const raw = option(name, argv);
  if (!/^-?\d+$/.test(raw))
    throw new Error(`${name} must be an integer from ${minimum} to ${MAX_SPLIT_ROWS}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_SPLIT_ROWS)
    throw new Error(`${name} must be an integer from ${minimum} to ${MAX_SPLIT_ROWS}.`);
  return value;
}
