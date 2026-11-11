#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FeedbackLoop } from "./feedback-loop.js";
import { JsonFileStore } from "./stores/json-file.js";
import { importLegacyV1 } from "./migration.js";
import { readAll } from "./analyzer.js";
import { collections } from "./stores/in-memory.js";
import {
  initializeSelfHosted,
  inspectSelfHostedSetup,
  readAgentGuide,
  readReference,
  autonomousActivationCurrent,
  autonomousActivationPrompt,
  moduleActivationNamespace,
  parseStepTimeout,
  readWorkerSettings,
  referenceFiles,
  runSelfHostedWorker,
  verifySelfHostedInstallation,
} from "./onboarding.js";
import type { ImprovementMode } from "./improvement-contracts.js";
const [command, ...args] = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && (!args[index + 1] || args[index + 1]!.startsWith("--")))
    throw Error(`--${name} requires a value.`);
  return index < 0 ? undefined : args[index + 1];
}
function validateOptions(values: string[], switches: string[] = []) {
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;
    if (seen.has(option)) throw Error(`Duplicate option: ${option}`);
    seen.add(option);
    if (switches.includes(option)) continue;
    if (!values.includes(option)) throw Error(`Unknown option: ${option}`);
    if (!args[index + 1] || args[index + 1]!.startsWith("--"))
      throw Error(`${option} requires a value.`);
    index++;
  }
}
async function main() {
  if (!command || command === "--help" || args.includes("--help")) {
    console.log(
      "Loopiter alpha — self-hosted SDK tools\n guide — print the installed agent setup guide\n init --directory ./loopiter — create a self-hosted setup (never overwrites)\n doctor --directory ./loopiter — check configuration without calling models\n verify — run isolated offline controller/rollback checks\n reference [--name workflows|registry|registrySql|providers|classification|classificationReadme]\n starter demo [--reject|--interrupt] — packaged classification example\n worker --module ./loopiter/application.mjs --enable [--mode observe|recommend|experiment|autonomous] [--step-timeout-ms 120000] [--once] [--interval-ms 30000] [--confirm-activation|--yes]\n Fresh init writes schemaVersion 2 (autonomous-default): mode autonomous and selfImproving true. Omitting --mode uses plan.mode; --mode overrides it. The worker refuses to start without --enable. The first non-interactive autonomous run for a namespace and plan passes --confirm-activation or --yes. Later runs reuse the stored confirmation until mode, namespace, audit sizing, policy, plan budget, or the application workflow budget changes. The stamp is a consent record, not a signed or machine-bound check. --enable authorizes improvement work and provider spending inside the existing policy gates; it does not bypass audit, budgets, or rollback.\n analyze --file STATE --namespace NAME --dimensions metadata.task\n candidates|events --file STATE --namespace NAME\n export --file STATE --namespace NAME (writes JSON to stdout)\n import-v1 --input OLD --file NEW --namespace NAME",
    );
    return;
  }
  const selfHostedOptions: Record<string, string[]> = {
    guide: [],
    init: ["--directory"],
    doctor: ["--directory"],
    verify: [],
    reference: ["--name"],
    worker: ["--module", "--mode", "--interval-ms", "--step-timeout-ms"],
  };
  if (Object.hasOwn(selfHostedOptions, command))
    validateOptions(
      selfHostedOptions[command]!,
      command === "worker"
        ? ["--enable", "--once", "--yes", "--confirm-activation"]
        : [],
    );
  if (command === "guide") {
    console.log(await readAgentGuide());
    return;
  }
  if (command === "init") {
    console.log(
      JSON.stringify(
        await initializeSelfHosted(flag("directory") ?? "loopiter"),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "doctor") {
    const report = await inspectSelfHostedSetup(
      flag("directory") ?? "loopiter",
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.configured) process.exitCode = 1;
    return;
  }
  if (command === "verify") {
    console.log(JSON.stringify(await verifySelfHostedInstallation(), null, 2));
    return;
  }
  if (command === "reference") {
    console.log(
      flag("name")
        ? await readReference(flag("name")!)
        : Object.keys(referenceFiles).join("\n"),
    );
    return;
  }
  if (command === "starter") {
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../examples/prompt-improvement/cli.js", import.meta.url),
        ),
        ...args,
      ],
      { stdio: "inherit", env: process.env },
    );
    await new Promise<void>((yes, no) => {
      child.on("error", no);
      child.on("exit", (code) => {
        process.exitCode = code ?? 1;
        yes();
      });
    });
    return;
  }
  if (command === "worker") {
    const module = flag("module");
    if (!module)
      throw Error("--module must name a local application integration module.");
    const modeFlag = flag("mode");
    const timeoutFlag = flag("step-timeout-ms");
    const settings = readWorkerSettings(module, {
      ...(modeFlag
        ? { mode: modeFlag as ImprovementMode, modeSource: "flag" as const }
        : {}),
      ...(timeoutFlag
        ? {
            stepTimeoutMs: parseStepTimeout(timeoutFlag),
            stepTimeoutSource: "flag" as const,
          }
        : {}),
    });
    let granted =
      args.includes("--yes") || args.includes("--confirm-activation");
    const alreadyConfirmed =
      settings.mode === "autonomous" &&
      autonomousActivationCurrent(module, settings.mode);
    const ask = async () => {
      const prompts = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = await prompts.question(
          autonomousActivationPrompt(moduleActivationNamespace(module)),
        );
        if (answer.trim() !== "activate")
          throw Error("Autonomous activation was not confirmed.");
      } finally {
        prompts.close();
      }
    };
    if (args.includes("--enable") && settings.mode === "autonomous" && !alreadyConfirmed) {
      if (!granted) {
        if (!process.stdin.isTTY)
          throw Error(
            "Autonomous activation needs a one-time confirmation for this namespace and plan. Pass --confirm-activation or --yes when stdin is not a terminal.",
          );
        await ask();
        granted = true;
      }
    }
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runSelfHostedWorker({
        module,
        mode: settings.mode,
        modeSource: settings.modeSource,
        stepTimeoutMs: settings.stepTimeoutMs,
        stepTimeoutSource: settings.stepTimeoutSource,
        selfImproving: args.includes("--enable"),
        once: args.includes("--once"),
        intervalMs: Number(flag("interval-ms") ?? 30000),
        recordActivation:
          args.includes("--enable") &&
          settings.mode === "autonomous" &&
          (granted || !alreadyConfirmed),
        confirmBudget: async () => {
          if (granted) return true;
          if (!process.stdin.isTTY) return false;
          await ask();
          granted = true;
          return true;
        },
        signal: shutdown.signal,
        onTick: (result) => console.log(JSON.stringify(result)),
      });
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    return;
  }
  const file = flag("file"),
    namespace = flag("namespace");
  if (!file || !namespace)
    throw new Error("--file and --namespace are required.");
  if (
    command === "import-v1" &&
    (!flag("input") || resolve(flag("input")!) === resolve(file))
  )
    throw new Error(
      "Use distinct --input and --file paths; original files are preserved.",
    );
  const loop = new FeedbackLoop({ store: new JsonFileStore(file), namespace });
  try {
    let result: unknown;
    if (command === "analyze")
      result = await loop.analyze({
        dimensions: (flag("dimensions") ?? "metadata.task").split(","),
      });
    else if (command === "candidates" || command === "events")
      result = await loop.list(command, { limit: 100 });
    else if (command === "import-v1")
      result = await importLegacyV1(
        loop,
        JSON.parse(await readFile(flag("input")!, "utf8")),
      );
    else if (command === "export")
      result = await loop.store.transaction(namespace, async (tx) =>
        Object.fromEntries(
          await Promise.all(
            collections.map(async (kind) => [
              kind,
              await readAll(tx, namespace, kind, 100000),
            ]),
          ),
        ),
      );
    else throw new Error(`Unknown command: ${command}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await loop.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
