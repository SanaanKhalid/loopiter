/**
 * Node side of the official IFBench verifier bridge.
 * One Python process stays up so importing the pinned package happens once.
 * Each request carries an id. A timeout kills that process so a late line
 * cannot be paired with the next request.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import { repoRoot } from "../public/paths.js";
import type { InstructionMark, RowScore } from "../public/task.js";
import { IFBENCH_VERIFIER_SHA } from "./pins.js";

export interface VerifierItem {
  prompt: string;
  response: string;
  instructionIdList: string[];
  kwargs: Record<string, unknown>[];
}

interface BridgeRow {
  strictPrompt: boolean;
  loosePrompt: boolean;
  instructions: InstructionMark[];
}

interface Waiter {
  id: string;
  proc: ChildProcessWithoutNullStreams;
  resolve: (value: BridgeRow[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

let child: ChildProcessWithoutNullStreams | null = null;
let reader: Interface | null = null;
let epoch = 0;
let nextId = 0;
let waiters: Waiter[] = [];
let queue: Promise<unknown> = Promise.resolve();
let stderr = "";
let chunkSize = 25;
let timeoutMs = 60_000;
let commandOverride: string[] | null = null;

export function configureVerifier(options: {
  chunkSize?: number;
  timeoutMs?: number;
  command?: string[] | null;
}): void {
  if (options.chunkSize !== undefined) chunkSize = options.chunkSize;
  if (options.timeoutMs !== undefined) timeoutMs = options.timeoutMs;
  if (options.command !== undefined) commandOverride = options.command;
  discardChild();
}

export async function resetVerifier(): Promise<void> {
  chunkSize = 25;
  timeoutMs = 60_000;
  commandOverride = null;
  await closeVerifier();
}

export async function scoreWithVerifiers(items: readonly VerifierItem[]): Promise<RowScore[]> {
  if (items.length === 0) return [];
  const scores: RowScore[] = [];
  const size = Math.max(1, chunkSize);
  for (let offset = 0; offset < items.length; offset += size) {
    const chunk = items.slice(offset, offset + size);
    const rows = await enqueue(() => roundTrip(chunk));
    scores.push(...rows.map(toScore));
  }
  return scores;
}

export async function closeVerifier(): Promise<void> {
  const current = child;
  discardChild();
  if (!current) return;
  current.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (current.exitCode !== null) {
      resolve();
      return;
    }
    current.once("close", () => resolve());
  });
}

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function roundTrip(items: readonly VerifierItem[]): Promise<BridgeRow[]> {
  const proc = ensureChild();
  const id = String(++nextId);
  const mine = epoch;
  const result = new Promise<BridgeRow[]>((resolve, reject) => {
    const waiter: Waiter = {
      id,
      proc,
      resolve,
      reject,
      timer: setTimeout(() => {
        failClosed(
          proc,
          mine,
          new Error(`IFBench verifier bridge timed out after ${timeoutMs} ms.`),
        );
      }, timeoutMs),
      settled: false,
    };
    const finish = (ok: boolean, value: BridgeRow[] | Error) => {
      if (waiter.settled) return;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      waiters = waiters.filter((item) => item !== waiter);
      if (ok) resolve(value as BridgeRow[]);
      else reject(value as Error);
    };
    waiter.resolve = (value) => finish(true, value);
    waiter.reject = (error) => finish(false, error);
    waiters.push(waiter);
  });
  result.catch(() => undefined);
  await writeLine(
    proc,
    `${JSON.stringify({
      id,
      items: items.map((item) => ({
        prompt: item.prompt,
        response: item.response,
        instruction_id_list: item.instructionIdList,
        kwargs: item.kwargs,
      })),
    })}\n`,
  );
  return result;
}

function ensureChild(): ChildProcessWithoutNullStreams {
  if (child && child.exitCode === null && !child.killed && reader) return child;
  const python = commandOverride?.[0] ?? process.env.LOOPITER_BENCH_PYTHON ?? "python3";
  const args = commandOverride
    ? commandOverride.slice(1)
    : [join(repoRoot(import.meta.url), "benchmarks", "ifbench", "bridge.py")];
  stderr = "";
  const proc = spawn(python, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  const mine = ++epoch;
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  reader = createInterface({ input: proc.stdout });
  reader.on("line", (text) => {
    if (mine !== epoch) return;
    let message: { id?: unknown; rows?: unknown };
    try {
      message = JSON.parse(text) as { id?: unknown; rows?: unknown };
    } catch {
      failClosed(proc, mine, new Error("Verifier JSON failed."));
      return;
    }
    const waiter = waiters.find((item) => item.proc === proc && item.id === message.id);
    if (!waiter || !Array.isArray(message.rows)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(message.rows as BridgeRow[]);
  });
  proc.once("exit", (code) => {
    if (child === proc) {
      child = null;
      reader = null;
    }
    const message = `IFBench verifier bridge exited ${code ?? "null"}. ${stderr.slice(-500)}. Install the pinned package (ifbench@${IFBENCH_VERIFIER_SHA}).`;
    for (const waiter of waiters.filter((item) => item.proc === proc)) waiter.reject(new Error(message));
  });
  child = proc;
  return proc;
}

function failClosed(
  proc: ChildProcessWithoutNullStreams,
  mine: number,
  error: Error,
): void {
  if (mine !== epoch) return;
  epoch += 1;
  const pending = waiters.filter((waiter) => waiter.proc === proc);
  waiters = waiters.filter((waiter) => waiter.proc !== proc);
  for (const waiter of pending) waiter.reject(error);
  if (child === proc) {
    reader?.removeAllListeners();
    reader?.close();
    reader = null;
    child = null;
  }
  if (proc.exitCode === null && !proc.killed) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
}

function discardChild(): void {
  const proc = child;
  epoch += 1;
  reader?.removeAllListeners();
  reader?.close();
  reader = null;
  child = null;
  for (const waiter of waiters.splice(0)) waiter.reject(new Error("Verifier bridge reset."));
  if (proc && proc.exitCode === null && !proc.killed) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function writeLine(proc: ChildProcessWithoutNullStreams, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    proc.stdin.once("error", onError);
    const ok = proc.stdin.write(line, () => {
      proc.stdin.off("error", onError);
    });
    if (ok) {
      resolve();
      return;
    }
    proc.stdin.once("drain", () => {
      proc.stdin.off("error", onError);
      resolve();
    });
  });
}

function toScore(row: BridgeRow): RowScore {
  const strictPasses = row.instructions.filter((mark) => mark.strict).length;
  const loosePasses = row.instructions.filter((mark) => mark.loose).length;
  return {
    primary: row.strictPrompt ? 1 : 0,
    loose: row.loosePrompt ? 1 : 0,
    f1: null,
    instructionStrictPasses: strictPasses,
    instructionStrictTotal: row.instructions.length,
    instructionLoosePasses: loosePasses,
    instructionLooseTotal: row.instructions.length,
    instructions: row.instructions,
  };
}
