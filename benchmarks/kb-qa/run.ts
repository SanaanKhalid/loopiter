/** CLI for the offline KB-QA harness. Refuses live-provider flags. */
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { renderMarkdown, runOfflineBenchmark } from "./harness.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();

async function main(): Promise<void> {
  if (
    process.argv.includes("--live") ||
    process.env.LOOPITER_BENCHMARK_LIVE === "1"
  ) {
    console.error(
      "Phase 1 live runs are not part of this harness. It never calls a model provider. A live run needs a separate change, explicit approval, and spend caps.",
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
