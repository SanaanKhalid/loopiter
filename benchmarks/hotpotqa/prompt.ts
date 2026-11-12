import { PROMPT_CAP } from "../public/constants.js";
import { HOTPOT_PARAGRAPHS } from "./pins.js";

export const HOTPOT_PROMPT_VERSION = "hotpotqa-system-v1";

export const HOTPOT_SYSTEM_PROMPT = [
  "Answer the question using only the supplied paragraphs.",
  `There are ${HOTPOT_PARAGRAPHS} paragraphs. They are frozen context and do not change when this prompt changes.`,
  "Reply with the short answer only.",
  "Do not add a citation or an explanation.",
  `The editable prompt stays within ${PROMPT_CAP} characters.`,
].join("\n");
