/**
 * Node side of the official IFBench verifier bridge.
 * One Python process stays up so importing the pinned package happens once.
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

let child: ChildProcessWithoutNullStreams | null = null;
let reader: Interface | null = null;
let waiters: {
  resolve: (value: BridgeRow[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}[] = [];
let queue: Promise<unknown> = Promise.resolve();
let stderr = "";

export async function scoreWithVerifiers(items: readonly VerifierItem[]): Promise<RowScore[]> {
  if (items.length === 0) return [];
  const rows = await enqueue(() => roundTrip(items));
  return rows.map(toScore);
}

export async function closeVerifier(): Promise<void> {
  const current = child;
  child = null;
  reader?.close();
  reader = null;
  if (!current) return;
  current.stdin.end();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      current.kill();
      resolve();
    }, 1_000);
    current.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
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

function roundTrip(items: readonly VerifierItem[]): Promise<BridgeRow[]> {
  const proc = ensureChild();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((waiter) => waiter.timer !== timer);
      reject(new Error("IFBench verifier bridge timed out."));
    }, 60_000);
    waiters.push({
      resolve,
      reject,
      timer,
    });
    proc.stdin.write(
      `${JSON.stringify(
        items.map((item) => ({
          prompt: item.prompt,
          response: item.response,
          instruction_id_list: item.instructionIdList,
          kwargs: item.kwargs,
        })),
      )}\n`,
    );
  });
}

function ensureChild(): ChildProcessWithoutNullStreams {
  if (child && child.exitCode === null && !child.killed && reader) return child;
  const python = process.env.LOOPITER_BENCH_PYTHON ?? "python3";
  const script = join(repoRoot(import.meta.url), "benchmarks", "ifbench", "bridge.py");
  stderr = "";
  const proc = spawn(python, [script], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  reader = createInterface({ input: proc.stdout });
  reader.on("line", (text) => {
    const waiter = waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    try {
      waiter.resolve(JSON.parse(text) as BridgeRow[]);
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error("Verifier JSON failed."));
    }
  });
  proc.once("exit", (code) => {
    const message = `IFBench verifier bridge exited ${code ?? "null"}. ${stderr.slice(-500)}. Install the pinned package (ifbench@${IFBENCH_VERIFIER_SHA}).`;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    child = null;
    reader = null;
  });
  child = proc;
  return proc;
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
