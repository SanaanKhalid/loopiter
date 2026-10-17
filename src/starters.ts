/** Optional application-side references. Importing them starts no work or model calls. */
export {
  promptWorkflow,
  modelRoutingWorkflow,
  decisionRoutingWorkflow,
  classifierSafety,
} from "../examples/autonomous/workflows.js";
export type {
  ArtifactRegistry,
  WorkflowInputs,
} from "../examples/autonomous/workflows.js";
export {
  PostgresArtifactRegistry,
  migrateArtifactRegistry,
} from "../examples/autonomous/postgres-registry.js";
export {
  meteredClassifier,
  OpenAIProvider,
  AzureOpenAIProvider,
} from "../examples/autonomous/providers.js";
export {
  PromptStarter,
  FixtureProvider,
} from "../examples/prompt-improvement/workflow.js";
export {
  PostgresPromptRegistry,
  MemoryPromptRegistry,
} from "../examples/prompt-improvement/registry.js";
export type {
  GenerationProvider,
  GenerateInput,
  Generation,
} from "../examples/prompt-improvement/provider.js";
