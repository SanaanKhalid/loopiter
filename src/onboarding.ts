/** Node-only self-hosted onboarding. No platform account or external service is used. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
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
import { minimumCertifiableAuditUnits } from "./improvement-evidence.js";
import { hash } from "./utils.js";
import { runDemo } from "../examples/autonomous/demo.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const workerModes = ["observe", "recommend", "experiment", "autonomous"] as const;
const MAX_STEP_MS = 3_600_000;
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

function validStepTimeout(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_STEP_MS
  );
}
const DECIMAL_INTEGER = /^[0-9]+$/;

/** Flag and plan timeouts are decimal integers only. `1e5`, `120000.0`, and `0x1e240` are rejected. */
export function parseStepTimeout(raw: string): number {
  if (!DECIMAL_INTEGER.test(raw))
    throw Error("--step-timeout-ms must be a decimal integer.");
  const value = Number(raw);
  if (!validStepTimeout(value))
    throw Error(
      "Step timeout must be an integer number of milliseconds from 1 to 3600000.",
    );
  return value;
}

function assertPlanStepTimeout(text: string, plan: Record<string, unknown>) {
  if (!Object.hasOwn(plan, "stepTimeoutMs")) return;
  const literal = text.match(/"stepTimeoutMs"\s*:\s*([^\s,}\]]+)/)?.[1];
  if (!literal || !DECIMAL_INTEGER.test(literal) || !validStepTimeout(plan.stepTimeoutMs))
    throw Error(
      "stepTimeoutMs must be a decimal integer number of milliseconds from 1 to 3600000.",
    );
}

function loadIntegrationPlan(
  modulePath: string,
): Record<string, unknown> | undefined {
  const path = resolve(dirname(resolve(modulePath)), "integration-plan.json");
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const plan = JSON.parse(text) as unknown;
  if (!plan || typeof plan !== "object" || Array.isArray(plan))
    throw Error("Invalid integration plan.");
  const record = plan as Record<string, unknown>;
  assertPlanStepTimeout(text, record);
  return record;
}

type ActivationStamp = {
  planHash: string;
  confirmedBy: string;
  confirmedAt: string;
};

function activationFile(modulePath: string): string {
  return resolve(dirname(resolve(modulePath)), ".state", "activation.json");
}

export function activationActor(env: NodeJS.ProcessEnv = process.env): string {
  const provided = env.LOOPITER_ACTIVATION_ACTOR?.trim();
  if (provided) return provided;
  try {
    const name = userInfo().username.trim();
    if (name) return name;
  } catch {
    // Some containers have no passwd entry.
  }
  return "unknown";
}

/** Hash of the plan fields that decide autonomous activation. The stamp is not included.
 * This is a consent record, not a signed or machine-bound check. */
export function autonomyPlanHash(plan: Record<string, unknown> | undefined): string {
  const step = plan && Object.hasOwn(plan, "stepTimeoutMs") ? plan.stepTimeoutMs : 120000;
  return hash({
    schemaVersion: plan?.schemaVersion ?? null,
    mode: typeof plan?.mode === "string" ? plan.mode : "recommend",
    selfImproving: plan?.selfImproving === true,
    namespace: typeof plan?.namespace === "string" ? plan.namespace : "",
    stepTimeoutMs: typeof step === "number" ? step : null,
    audit: plan?.audit ?? null,
    policy: plan?.policy ?? null,
    budget: plan?.budget ?? null,
  });
}

function readActivationEntries(modulePath: string): Record<string, ActivationStamp> {
  const path = activationFile(modulePath);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      entries?: Record<string, ActivationStamp>;
    };
    if (!parsed?.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries))
      return {};
    return parsed.entries;
  } catch {
    return {};
  }
}

export function autonomousActivationCurrent(modulePath: string): boolean {
  const plan = loadIntegrationPlan(modulePath);
  if (!plan) return false;
  const namespace = typeof plan.namespace === "string" ? plan.namespace : "";
  const stamp = readActivationEntries(modulePath)[namespace];
  return (
    !!stamp &&
    stamp.planHash === autonomyPlanHash(plan) &&
    typeof stamp.confirmedBy === "string" &&
    stamp.confirmedBy.trim().length > 0 &&
    typeof stamp.confirmedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(stamp.confirmedAt)
  );
}

export function recordAutonomousActivation(
  modulePath: string,
  actor = activationActor(),
): void {
  const plan = loadIntegrationPlan(modulePath);
  const namespace = typeof plan?.namespace === "string" ? plan.namespace : "";
  const entries = readActivationEntries(modulePath);
  entries[namespace] = {
    planHash: autonomyPlanHash(plan),
    confirmedBy: actor.trim() || "unknown",
    confirmedAt: new Date().toISOString(),
  };
  const path = activationFile(modulePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}
export function readWorkerSettings(
  modulePath: string,
  overrides: {
    mode?: ImprovementMode;
    modeSource?: "flag" | "option" | "plan" | "default";
    stepTimeoutMs?: number;
    stepTimeoutSource?: "flag" | "option" | "plan" | "default";
  } = {},
) {
  const plan = loadIntegrationPlan(modulePath);
  if (
    plan &&
    !workerModes.includes(plan.mode as (typeof workerModes)[number])
  )
    throw Error("Invalid mode in integration plan.");
  const mode = (overrides.mode ??
    (plan?.mode as ImprovementMode | undefined) ??
    "recommend") as ImprovementMode;
  if (!workerModes.includes(mode)) throw Error("Invalid improvement mode.");
  const modeSource = overrides.mode
    ? (overrides.modeSource ?? "option")
    : plan?.mode
      ? "plan"
      : "default";
  if (plan?.stepTimeoutMs !== undefined && !validStepTimeout(plan.stepTimeoutMs))
    throw Error("Invalid stepTimeoutMs in integration plan.");
  const stepTimeoutMs =
    overrides.stepTimeoutMs ??
    (validStepTimeout(plan?.stepTimeoutMs) ? plan.stepTimeoutMs : 120000);
  if (!validStepTimeout(stepTimeoutMs))
    throw Error(
      "Step timeout must be an integer number of milliseconds from 1 to 3600000.",
    );
  const stepTimeoutSource =
    overrides.stepTimeoutMs !== undefined
      ? (overrides.stepTimeoutSource ?? "option")
      : plan?.stepTimeoutMs !== undefined
        ? "plan"
        : "default";
  return {
    mode,
    modeSource,
    stepTimeoutMs,
    stepTimeoutSource,
  } as const;
}
function auditPlanMessages(plan: Record<string, unknown>): {
  error?: string;
  warning?: string;
} {
  const audit = plan.audit;
  if (audit === undefined) {
    if (plan.mode !== "autonomous") return {};
    const needed = minimumCertifiableAuditUnits({
      minimumImprovement: 0.05,
      range: [0, 1],
      alpha: 0.05,
    });
    return {
      error: `Declare audit sizing. With minimum improvement 0.05, range 0 to 1 and alpha 0.05, the paired bound needs at least ${needed} units.`,
    };
  }
  if (!audit || typeof audit !== "object" || Array.isArray(audit))
    throw Error("Invalid audit sizing in integration plan.");
  const row = audit as Record<string, unknown>;
  const method = row.method ?? "paired-hoeffding";
  if (typeof method !== "string" || !method.trim())
    throw Error("Invalid audit method in integration plan.");
  if (
    typeof row.minimumUnits !== "number" ||
    !Number.isSafeInteger(row.minimumUnits) ||
    row.minimumUnits < 1
  )
    throw Error("Invalid audit.minimumUnits in integration plan.");
  if (method !== "paired-hoeffding")
    return {
      warning: "Custom audit method is not sized by the paired Hoeffding check.",
    };
  if (
    typeof row.minimumImprovement !== "number" ||
    !Array.isArray(row.range) ||
    row.range.length !== 2 ||
    typeof row.range[0] !== "number" ||
    typeof row.range[1] !== "number" ||
    typeof row.alpha !== "number"
  )
    throw Error("Invalid audit objective in integration plan.");
  let needed: number;
  try {
    needed = minimumCertifiableAuditUnits({
      minimumImprovement: row.minimumImprovement,
      range: [row.range[0], row.range[1]],
      alpha: row.alpha,
    });
  } catch (error) {
    throw Error(
      error instanceof Error ? error.message : "Invalid audit objective.",
    );
  }
  if (row.minimumUnits >= needed) return {};
  const message = `Audit of ${row.minimumUnits} units cannot certify a gain of ${row.minimumImprovement} at alpha ${row.alpha}. At least ${needed} units are required.`;
  return plan.mode === "autonomous" ? { error: message } : { warning: message };
}
const STATE_IGNORE_LINE = ".state/";

function gitignoreLineCoversState(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return false;
  return (
    trimmed === ".state" ||
    trimmed === ".state/" ||
    trimmed === "/.state" ||
    trimmed === "/.state/" ||
    trimmed === "**/.state" ||
    trimmed === "**/.state/"
  );
}

/** Append `.state/` to an existing setup .gitignore. A second call does not duplicate it. */
export async function ensureStateGitignored(directory: string): Promise<void> {
  const destination = resolve(directory);
  let info;
  try {
    info = await lstat(destination);
  } catch {
    return;
  }
  if (!info.isDirectory()) return;
  const path = resolve(destination, ".gitignore");
  let gitignore;
  try {
    gitignore = await lstat(path);
  } catch {
    return;
  }
  if (!gitignore.isFile()) return;
  const text = await readFile(path, "utf8");
  if (text.split(/\r?\n/).some(gitignoreLineCoversState)) return;
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  await appendFile(path, `${separator}${STATE_IGNORE_LINE}\n`);
}

export async function initializeSelfHosted(directory: string) {
  const destination = resolve(directory);
  const guide = await readAgentGuide();
  await mkdir(dirname(destination), { recursive: true });
  // Existing directories (including symlinks) are deliberately never merged or replaced.
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      await ensureStateGitignored(destination);
    throw error;
  }
  const plan = {
    schemaVersion: 2,
    language: "node",
    preset: "autonomous-default",
    mode: "autonomous",
    selfImproving: true,
    stepTimeoutMs: 120000,
    audit: {
      method: "paired-hoeffding",
      minimumImprovement: 0.05,
      range: [0, 1],
      alpha: 0.05,
      minimumUnits: 50,
    },
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
    "README.md": `# Self-hosted Loopiter setup\n\nGive your coding agent this instruction:\n\n> Read AGENT_GUIDE.md in this directory. Inspect my application, propose the integration and feedback placement, and complete the self-hosted SDK setup. Use my infrastructure and model credentials. Verify the integration and explain how to run, pause and roll it back.\n\nRun from the application root:\n\n- npx --no-install loopiter verify — isolated offline controller checks; no credentials or charges.\n- npx --no-install loopiter doctor --directory ${shellQuote(directory)} — configuration checks, never model calls.\n- npx --no-install loopiter reference — installed reference names; no repository clone needed.\n\nYour agent creates application.mjs here, exporting async createIntegration({ signal }) returning { loop, workflows, close }. This is the application-specific connection to your real serving code, datasets, evaluator and durable artifact registry. The plan starts incomplete on purpose; initialization does not claim your application is connected.\n\nThis plan is schemaVersion 2 with preset autonomous-default: mode autonomous and selfImproving true. Doctor still blocks until the reviewed checklist, namespace, durable storage, application module and required environment names are set. verify does not spend or release.\n\nAfter doctor reports configured and verify passes, autonomous remains the first worker recipe. Before the first run with --enable --mode autonomous, stop and get explicit confirmation from the human. That confirmation is one-time, for initial activation and spend. A completed checklist, doctor report, or plan output alone is not confirmation. After that one confirmation, autonomous runs continue without per-candidate approval.\n\nOn a terminal the worker asks you to type activate. When stdin is not a terminal, the first autonomous run passes --confirm-activation or --yes. The worker stores that confirmation in .state/activation.json for this namespace and plan, with who confirmed it and when. The stamp is a consent record, not a security boundary: it is not signed and it is not bound to a machine. Its hash covers mode, self-improving, namespace, step timeout, audit sizing, and the plan's policy and budget. A later run reuses the stamp. A new namespace or a change to those settings asks again. The flag does not bypass audit, budget, or rollback gates. Init writes .state/ into a new .gitignore and appends that same pattern to an existing .gitignore without duplicating it.\n\n    npx --no-install loopiter worker --module ${shellQuote(directory + "/application.mjs")} --enable --mode autonomous --once\n\n--enable authorizes improvement work and provider spending in this process: proposal, replay and judge calls, and, in autonomous mode, a deployment that has passed validation and audit. It does not bypass validation, audit, minimum improvement, guardrails, trusted sources, budgets, cooldown, the consecutive-failure stop, canary promotion, observation rollback, pause, or lease checks. Autonomous mode fails closed without an audit partition, a budget, or --enable. Omit --enable and the worker refuses to start.\n\n--mode recommend stores proposals and does not apply a candidate. Set plan.mode to recommend, or run:\n\n    npx --no-install loopiter worker --module ${shellQuote(directory + "/application.mjs")} --enable --mode recommend --once\n\nOmitting --mode uses plan.mode. The --mode flag overrides the plan. Set plan.mode to recommend to turn off autonomous. Constructing ImprovementController without a mode stays on recommend with self-improving off. Existing schemaVersion 1 plans are left unchanged.\n\nOne tick advances one durable phase. Omit --once to run a foreground worker; deploy that command with your own process manager. A worker does not remain running after its process exits.\n\nYou pay your selected model/judge, database, retrieval, hosting and logging providers directly. No Loopiter platform login, project key or cloud subscription is needed. See AGENT_GUIDE.md for Python, feedback verification, Jev selection, production storage and recovery.\n`,
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
    schemaVersion: 2,
    preset: "autonomous-default",
    mode: "autonomous",
    selfImproving: true,
    connected: false,
    prompt: `Read ${resolve(destination, "AGENT_GUIDE.md")} and complete the self-hosted SDK integration in this project.`,
  };
}

export async function inspectSelfHostedSetup(
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const root = resolve(directory);
  const planText = await readFile(resolve(root, "integration-plan.json"), "utf8");
  const plan = JSON.parse(planText) as Record<string, unknown>;
  assertPlanStepTimeout(planText, plan);
  if (
    (plan.schemaVersion !== 1 && plan.schemaVersion !== 2) ||
    plan.language !== "node"
  )
    throw Error(
      "Expected a Node self-hosted integration plan, schemaVersion 1 or 2.",
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
  if (plan.stepTimeoutMs !== undefined && !validStepTimeout(plan.stepTimeoutMs))
    throw Error(
      "stepTimeoutMs must be an integer number of milliseconds from 1 to 3600000.",
    );
  const audit = auditPlanMessages(plan);
  const warnings = audit.warning ? [audit.warning] : [];
  if (audit.error) missing.push(audit.error);
  return {
    configured: missing.length === 0,
    liveVerified: false,
    mode: plan.mode,
    selfImproving: plan.selfImproving,
    missing,
    warnings,
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
  modeSource?: "flag" | "option" | "plan" | "default";
  stepTimeoutMs?: number;
  stepTimeoutSource?: "flag" | "option" | "plan" | "default";
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
  const settings = readWorkerSettings(options.module, {
    ...(options.mode
      ? { mode: options.mode, modeSource: options.modeSource }
      : {}),
    ...(options.stepTimeoutMs !== undefined
      ? {
          stepTimeoutMs: options.stepTimeoutMs,
          stepTimeoutSource: options.stepTimeoutSource,
        }
      : {}),
  });
  const interval = options.intervalMs ?? 30000;
  if (!Number.isSafeInteger(interval) || interval < 1000)
    throw Error("intervalMs must be an integer of at least 1000.");
  console.error(
    `effective mode ${settings.mode} (source: ${settings.modeSource})`,
  );
  console.error(
    `effective step timeout ${settings.stepTimeoutMs}ms (source: ${settings.stepTimeoutSource})`,
  );
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
    for (const workflow of integration.workflows) {
      if (workflow.policy.auditMethod) continue;
      const needed = minimumCertifiableAuditUnits(workflow.policy.objective);
      if (workflow.policy.minimumAuditUnits >= needed) continue;
      const message = `Audit size ${workflow.policy.minimumAuditUnits} cannot certify the configured gain at this confidence. At least ${needed} units are required.`;
      if (settings.mode === "autonomous") throw Error(message);
      console.error(`warning: ${message}`);
    }
    const controller = new ImprovementController(integration.loop, {
      workflows: integration.workflows,
      mode: settings.mode,
      selfImproving: true,
      stepTimeoutMs: settings.stepTimeoutMs,
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
