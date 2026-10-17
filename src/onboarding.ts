/** Node-only self-hosted onboarding. No platform account or external service is used. */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { FeedbackLoop } from "./feedback-loop.js";
import { ImprovementController } from "./improvement-controller.js";
import type {
  ImprovementMode,
  ImprovementWorkflow,
  TickResult,
} from "./improvement-contracts.js";
import { runDemo } from "../examples/autonomous/demo.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";
export const referenceFiles: Record<string, string> = {
  workflows: "examples/autonomous/workflows.ts",
  registry: "examples/autonomous/postgres-registry.ts",
  registrySql: "examples/autonomous/registry.sql",
  providers: "examples/autonomous/providers.ts",
  classification: "examples/prompt-improvement/workflow.ts",
  classificationReadme: "examples/prompt-improvement/README.md",
};

export function readAgentGuide(): Promise<string> {
  return readFile(resolve(packageRoot, "AGENT_GUIDE.md"), "utf8");
}
export async function readReference(name: string): Promise<string> {
  if (!Object.hasOwn(referenceFiles, name))
    throw Error(
      "Unknown reference. Use: " + Object.keys(referenceFiles).join(", "),
    );
  return readFile(resolve(packageRoot, referenceFiles[name]!), "utf8");
}

export async function initializeSelfHosted(directory: string) {
  const destination = resolve(directory);
  const guide = await readAgentGuide();
  await mkdir(dirname(destination), { recursive: true });
  // Existing directories (including symlinks) are deliberately never merged or replaced.
  await mkdir(destination, { mode: 0o700 });
  const plan = {
    schemaVersion: 1,
    language: "node",
    mode: "recommend",
    selfImproving: false,
    namespace: "",
    applicationModule: "./application.mjs",
    storage: "unconfigured",
    requiredEnvironment: [],
    reviewed: {
      target: false,
      feedback: false,
      evaluation: false,
      budgets: false,
      deployment: false,
    },
  };
  const files: Record<string, string> = {
    "AGENT_GUIDE.md": guide,
    ".gitignore": ".state/\n.env\n.env.*\n!.env.example\n*.log\n",
    "integration-plan.json": JSON.stringify(plan, null, 2) + "\n",
    "verify.mjs":
      'import { verifySelfHostedInstallation } from "loopiter/onboarding";\nconsole.log(JSON.stringify(await verifySelfHostedInstallation(), null, 2));\n',
    "README.md": `# Self-hosted Loopiter setup\n\nGive your coding agent this instruction:\n\n> Read AGENT_GUIDE.md in this directory. Inspect my application, propose the integration and feedback placement, and complete the self-hosted SDK setup. Use my infrastructure and model credentials. Verify the integration and explain how to run, pause and roll it back.\n\nRun from the application root:\n\n- npx --no-install loopiter verify — isolated offline controller checks; no credentials or charges.\n- npx --no-install loopiter doctor --directory ${shellQuote(directory)} — configuration checks, never model calls.\n- npx --no-install loopiter reference — installed reference names; no repository clone needed.\n\nYour agent creates application.mjs here, exporting async createIntegration({ signal }) returning { loop, workflows, close }. This is the application-specific connection to your real serving code, datasets, evaluator and durable artifact registry. The plan starts incomplete on purpose; initialization does not claim your application is connected.\n\nAfter reviewing the plan and verifying the real integration:\n\n    npx --no-install loopiter worker --module ${shellQuote(directory + "/application.mjs")} --enable --mode recommend --once\n\nOne tick advances one durable phase. Omit --once to run a foreground worker; deploy that command with your own process manager. Automatic releases require the explicit --mode autonomous choice and all SDK policy/evidence gates. A worker does not remain running after its process exits.\n\nYou pay your selected model/judge, database, retrieval, hosting and logging providers directly. No Loopiter platform login, project key or cloud subscription is needed. See AGENT_GUIDE.md for Python, feedback verification, Jev selection, production storage and recovery.\n`,
  };
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(resolve(destination, name), contents, {
      flag: "wx",
      mode: 0o600,
    });
  }
  return {
    directory: destination,
    files: Object.keys(files),
    mode: "recommend",
    connected: false,
    prompt: `Read ${resolve(destination, "AGENT_GUIDE.md")} and complete the self-hosted SDK integration in this project.`,
  };
}

export async function inspectSelfHostedSetup(
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const root = resolve(directory);
  const plan = JSON.parse(
    await readFile(resolve(root, "integration-plan.json"), "utf8"),
  ) as Record<string, unknown>;
  if (plan.schemaVersion !== 1 || plan.language !== "node")
    throw Error(
      "Expected a Node self-hosted integration plan, schemaVersion 1.",
    );
  const missing: string[] = [];
  if (typeof plan.namespace !== "string" || !plan.namespace.trim())
    missing.push("Choose an application-owned namespace.");
  if (!["postgres", "custom-durable"].includes(String(plan.storage)))
    missing.push(
      "Configure durable storage; memory and JSON files are development-only.",
    );
  const reviewed = plan.reviewed as Record<string, unknown> | undefined;
  for (const name of [
    "target",
    "feedback",
    "evaluation",
    "budgets",
    "deployment",
  ]) {
    if (reviewed?.[name] !== true) missing.push(`Review ${name}.`);
  }
  if (
    !["observe", "recommend", "experiment", "autonomous"].includes(
      String(plan.mode),
    ) ||
    typeof plan.selfImproving !== "boolean"
  )
    throw Error("Invalid mode or selfImproving in integration plan.");
  if (
    typeof plan.applicationModule !== "string" ||
    !plan.applicationModule.trim()
  )
    throw Error("Choose a local applicationModule.");
  try {
    if (!(await stat(resolve(root, plan.applicationModule))).isFile())
      missing.push("Implement the application integration module.");
  } catch {
    missing.push("Implement the application integration module.");
  }
  if (
    !Array.isArray(plan.requiredEnvironment) ||
    plan.requiredEnvironment.some(
      (name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name),
    )
  )
    throw Error(
      "requiredEnvironment must contain environment-variable names, never values.",
    );
  for (const name of plan.requiredEnvironment as string[])
    if (!environment[name])
      missing.push(
        `Set ${name} through your secret manager or process environment.`,
      );
  return {
    configured: missing.length === 0,
    liveVerified: false,
    mode: plan.mode,
    selfImproving: plan.selfImproving,
    missing,
    note: "Configuration checks only. This does not import application code, contact providers, verify model quality or activate releases.",
  };
}

export async function verifySelfHostedInstallation() {
  const expected = {
    accepted: "completed",
    rejected: "no_improvement",
    insufficient: "waiting_for_evidence",
    interrupted: "completed",
    regression: "rolled_back",
  } as const;
  const checks = [];
  for (const [path, state] of Object.entries(expected)) {
    const report = await runDemo("prompt", path as keyof typeof expected);
    if (report.result?.state !== state)
      throw Error(`Offline ${path} check failed: ${report.result?.state}`);
    if (path === "regression" && report.activeVersion !== report.baseline)
      throw Error("Offline rollback did not restore the original artifact.");
    checks.push({ path, state, passed: true });
  }
  return {
    evidence:
      "SIMULATED: isolated in-memory fixtures, not live model or application verification",
    providerCalls: 0,
    checks,
  };
}

export interface SelfHostedIntegration {
  loop: FeedbackLoop;
  workflows: ImprovementWorkflow[];
  close?: () => Promise<void>;
}
export interface SelfHostedWorkerOptions {
  module: string;
  mode?: ImprovementMode;
  selfImproving?: boolean;
  once?: boolean;
  intervalMs?: number;
  signal?: AbortSignal;
  onTick?: (result: TickResult) => void;
}
export async function runSelfHostedWorker(options: SelfHostedWorkerOptions) {
  if (options.selfImproving !== true)
    throw Error(
      "Worker is disabled. Review the setup and pass --enable to permit improvement work and provider spending.",
    );
  const mode = options.mode ?? "recommend",
    interval = options.intervalMs ?? 30000;
  if (!["observe", "recommend", "experiment", "autonomous"].includes(mode))
    throw Error("Invalid improvement mode.");
  if (!Number.isSafeInteger(interval) || interval < 1000)
    throw Error("intervalMs must be an integer of at least 1000.");
  options.signal?.throwIfAborted();
  const loaded = (await import(
    pathToFileURL(resolve(options.module)).href
  )) as {
    createIntegration?: (context: {
      signal?: AbortSignal;
    }) => Promise<SelfHostedIntegration>;
  };
  if (typeof loaded.createIntegration !== "function")
    throw Error(
      "The local module must export async createIntegration({ signal }).",
    );
  const integration = await loaded.createIntegration(
    options.signal ? { signal: options.signal } : {},
  );
  try {
    if (
      !(integration?.loop instanceof FeedbackLoop) ||
      !Array.isArray(integration.workflows)
    )
      throw Error(
        "createIntegration must return { loop: FeedbackLoop, workflows, close? }.",
      );
    const controller = new ImprovementController(integration.loop, {
      workflows: integration.workflows,
      mode,
      selfImproving: true,
    });
    const results: TickResult[] = [];
    do {
      for (const workflow of integration.workflows) {
        if (options.signal?.aborted) break;
        const result = await controller.tick(workflow.id, options.signal);
        if (options.once) results.push(result);
        options.onTick?.(result);
      }
      if (options.once || options.signal?.aborted) break;
      try {
        await delay(
          interval,
          undefined,
          options.signal ? { signal: options.signal } : {},
        );
      } catch (error) {
        if (!options.signal?.aborted) throw error;
      }
    } while (!options.signal?.aborted);
    return results;
  } finally {
    if (integration?.close) await integration.close();
    else await integration?.loop?.close();
  }
}
