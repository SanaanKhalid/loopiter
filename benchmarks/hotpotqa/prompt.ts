import { PROMPT_CAP } from "../public/constants.js";
import { HOTPOT_PARAGRAPHS } from "./pins.js";

export const HOTPOT_PROMPT_VERSION = "hotpotqa-system-v1";
export const HOTPOT_STRONG_PROMPT_VERSION = "hotpotqa-strong-v1";

export const HOTPOT_SYSTEM_PROMPT = [
  "Answer the question using only the supplied paragraphs.",
  `There are ${HOTPOT_PARAGRAPHS} paragraphs. They are frozen context and do not change when this prompt changes.`,
  "Reply with the short answer only.",
  "Do not add a citation or an explanation.",
  `The editable prompt stays within ${PROMPT_CAP} characters.`,
].join("\n");

/** Hand-written multi-hop prompt. It is not a model rewrite of the frozen baseline. */
export const HOTPOT_STRONG_PROMPT = [
  "Answer multi-hop questions from the supplied paragraphs only. Those paragraphs are frozen: do not add, drop, or reorder them, and do not use outside knowledge.",
  "A question often joins two facts. Find the bridge entity in one paragraph, then read the paragraph that states the attribute of that entity. Ignore a distractor paragraph that shares a name but not the relation.",
  "Reply with the short answer only.",
  "Use the form the question asks for: a name, a place, a date, or a number, not a sentence.",
  "For a yes/no question, reply yes or no.",
  "If the paragraphs do not contain the answer, reply noanswer.",
  "Do not cite a title, do not explain the hops, and do not add punctuation around the answer.",
  `The editable prompt stays within ${PROMPT_CAP} characters.`,
].join("\n");
