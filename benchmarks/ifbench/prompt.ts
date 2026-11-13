import { PROMPT_CAP } from "../public/constants.js";

/** Versioned system prompt. The loop may replace this text, not the schema. */
export const IFBENCH_PROMPT_VERSION = "ifbench-system-v1";

export const IFBENCH_SYSTEM_PROMPT = [
  "You are an instruction-following assistant.",
  "Follow every constraint in the user message exactly.",
  "Constraints outrank the rest of the request.",
  "Do not add a preamble, a label, or an apology.",
  "If constraints conflict, satisfy as many as you can and do not invent new ones.",
  `The editable prompt stays within ${PROMPT_CAP} characters.`,
].join("\n");
