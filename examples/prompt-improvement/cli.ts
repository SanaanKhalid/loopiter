import { writeFile } from "node:fs/promises";
import { FeedbackLoop, InMemoryStore } from "../../src/index.js";
import { PostgresStore, migratePostgres } from "../../src/postgres.js";
import { datasetHash, evaluatorVersion, FixtureProvider, PromptStarter } from "./workflow.js";
import { AzureOpenAIProvider, OpenAIProvider } from "./provider.js";
import { MemoryPromptRegistry, PostgresPromptRegistry } from "./registry.js";
import type { Label } from "./fixtures.js";
const [command = "help", ...args] = process.argv.slice(2);
function flag(name: string) {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
}
function required(name: string) {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}
async function main() {
  if (command === "help") {
    console.log(
      "Offline: npm run starter -- demo [--reject]\nLive: npm run starter -- init|seed|predict|correct|recommend|evaluate|approve|deploy|rollback|reconcile|inspect --live\nSet DATABASE_URL, LOOPITER_NAMESPACE, OPENAI_MODEL, OPENAI_API_KEY.\nCommands use --candidate ID, --attempt ID, --actor NAME, --text TEXT, --execution ID, --label LABEL as applicable.\n--report PATH saves an exclusive (non-overwriting) JSON report.",
    );
    return;
  }
  if (command !== "demo" && !args.includes("--live"))
    throw new Error("Live commands require explicit --live.");
  const live = command !== "demo";
  const namespace = live ? process.env.LOOPITER_NAMESPACE : "starter/offline";
  if (!namespace) throw new Error("LOOPITER_NAMESPACE is required.");
  if (live && !process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required.");
  const pool = live
    ? new (await import("pg")).Pool({ connectionString: process.env.DATABASE_URL })
    : undefined;
  const store = pool ? new PostgresStore(pool) : new InMemoryStore();
  const loop = new FeedbackLoop({
    store,
    namespace,
    callbackTimeoutMs: 120000,
  });
  const registry = pool
    ? new PostgresPromptRegistry(pool, namespace)
    : new MemoryPromptRegistry();
  const modelCommands = ["seed", "predict", "recommend", "evaluate", "smoke"];
  const providerName = process.env.LOOPITER_PROVIDER ?? "openai";
  if (live && providerName !== "openai" && providerName !== "azure")
    throw new Error("LOOPITER_PROVIDER must be openai or azure.");
  if (live && modelCommands.includes(command))
    console.error(
      `LIVE MODE: request text, corrections or holdout fixtures will be sent to ${providerName === "azure" ? "Azure OpenAI" : "OpenAI"} and may incur charges. store:false is not a zero-retention guarantee.`,
    );
  const provider =
    live && modelCommands.includes(command)
      ? createLiveProvider()
      : new FixtureProvider(args.includes("--reject"));
  function createLiveProvider() {
    const limits = {
      maximumRequests: Number(process.env.LOOPITER_MAX_REQUESTS ?? 80),
      maximumOutputTokens: Number(process.env.LOOPITER_MAX_OUTPUT_TOKENS ?? 2048),
      maximumInputBytes: Number(process.env.LOOPITER_MAX_INPUT_BYTES ?? 16384),
    };
    if (providerName === "azure") {
      const token = process.env.AZURE_OPENAI_AUTH_TOKEN;
      return new AzureOpenAIProvider({
        ...limits,
        endpoint: process.env.AZURE_OPENAI_ENDPOINT ?? "",
        model: process.env.AZURE_OPENAI_DEPLOYMENT ?? "",
        ...(process.env.AZURE_OPENAI_API_KEY ? { apiKey: process.env.AZURE_OPENAI_API_KEY } : {}),
        ...(token ? { tokenProvider: async () => token } : {}),
      });
    }
    return new OpenAIProvider({
      ...limits,
      apiKey: process.env.OPENAI_API_KEY ?? "",
      model: process.env.OPENAI_MODEL ?? "",
    });
  }
  const starter = new PromptStarter(loop, provider, registry);
  const signal = AbortSignal.timeout(600000);
  try {
    let result: unknown;
    if (command === "init") {
      await migratePostgres(pool!);
      await registry.initialize();
      result = { initialized: true, namespace };
    } else if (command === "demo") {
      await registry.initialize();
      await starter.seed(signal);
      const proposed = await starter.recommend(signal);
      if (!proposed.candidate) result = proposed;
      else {
        const evaluated = await starter.evaluate(proposed.candidate.id, signal);
        if (!evaluated.evaluations.at(-1)!.passed)
          result = {
            mode: "simulated",
            result: "candidate rejected by measured fixture evaluation",
            candidate: evaluated,
          };
        else {
          const approved = await starter.approve(
            evaluated.id,
            "explicit-offline-fixture-review",
          );
          let recovery: unknown = null;
          if (args.includes("--interrupt")) {
            // Simulate a process losing the response after the external registry committed.
            try {
              await loop.deployCandidate(approved.id, {
                expectedArtifactVersion: String(approved.metadata.baseVersion),
                adapter: {
                  apply: async (request) => {
                    await registry.apply(request);
                    throw new Error(
                      "Simulated response loss after external commit",
                    );
                  },
                  rollback: (request) => registry.rollback(request),
                  inspect: (request) => registry.inspect(request),
                },
              });
              throw new Error("Fault injection did not interrupt deployment");
            } catch (error) {
              if ((error as { code?: string }).code !== "deployment_pending")
                throw error;
            }
            const pending = (await loop.list("attempts")).items.find(
              (a) => a.status === "pending",
            );
            if (!pending) throw new Error("Missing pending attempt");
            recovery = await loop.reconcileAttempt(
              pending.id,
              registry,
              signal,
            );
          } else await starter.deploy(approved, signal);
          const prediction = await starter.predict(
            "Please explain the subscription price.",
            signal,
          );
          await loop.rollbackCandidate(approved.id, {
            adapter: registry,
            signal,
          });
          result = {
            mode: "simulated",
            diff: proposed.diff,
            evaluation: evaluated.evaluations.at(-1),
            recovery,
            deployedPrediction: prediction.label,
            restored: await registry.current(),
            candidate: await loop.getCandidate(approved.id),
          };
        }
      }
    } else if (command === "smoke") {
      await starter.seed(signal);
      const proposed = await starter.recommend(signal);
      result = {
        ...proposed,
        datasetHash,
        evaluatorVersion,
        baselinePredictions: (await loop.list("executions")).items,
        ...(proposed.candidate ? {
            evaluated: await starter.evaluate(proposed.candidate.id, signal),
            nextAction:
              "Review the actual results; explicit approval and deployment remain separate commands.",
          } : {}),
      };
    } else if (command === "seed") {
      await starter.seed(signal);
      result = { capturedSyntheticCorrections: true, provider: provider.mode };
    } else if (command === "predict")
      result = await starter.predict(required("text"), signal);
    else if (command === "correct")
      result = await starter.correct(
        required("execution"),
        required("label") as Label,
        required("actor"),
      );
    else if (command === "recommend") result = await starter.recommend(signal);
    else if (command === "evaluate")
      result = await starter.evaluate(required("candidate"), signal);
    else if (command === "approve")
      result = await starter.approve(required("candidate"), required("actor"));
    else if (command === "deploy") {
      const c = await loop.getCandidate(required("candidate"));
      if (!c) throw new Error("Candidate not found.");
      result = await starter.deploy(c, signal);
    } else if (command === "rollback")
      result = await loop.rollbackCandidate(required("candidate"), {
        adapter: registry,
        signal,
      });
    else if (command === "reconcile")
      result = await loop.reconcileAttempt(
        required("attempt"),
        registry,
        signal,
      );
    else if (command === "inspect")
      result = {
        active: await registry.current(),
        candidates: await loop.list("candidates"),
        attempts: await loop.list("attempts"),
      };
    else throw new Error(`Unknown command: ${command}`);
    const report = JSON.stringify(
      {
        command,
        mode: live ? "live" : "simulated",
        ...(live && modelCommands.includes(command) ? {
          provider: providerName,
          configuredModel: provider.model,
        } : {}),
        generatedAt: new Date().toISOString(),
        result,
      },
      null,
      2,
    );
    if (flag("report"))
      await writeFile(flag("report")!, `${report}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    console.log(report);
  } finally {
    await loop.close();
    await pool?.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
