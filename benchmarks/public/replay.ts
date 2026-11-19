/**
 * Replay an acceptance decision log. No model calls.
 *   node dist/benchmarks/public/replay.js <decisions.json>
 */
import { pathToFileURL } from "node:url";
import { formatReplay, readDecisionLog, replayLogs } from "./decisions.js";

export function replayPath(path: string): { ok: boolean; text: string } {
  const results = replayLogs(readDecisionLog(path));
  return { ok: results.every((row) => row.matched), text: formatReplay(results) };
}

const invoked =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invoked) {
  const path = process.argv[2];
  if (!path || path.startsWith("--")) {
    console.error("Usage: node dist/benchmarks/public/replay.js <decisions.json>");
    process.exit(2);
  }
  try {
    const result = replayPath(path);
    process.stdout.write(result.text);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Replay failed.");
    process.exit(1);
  }
}
