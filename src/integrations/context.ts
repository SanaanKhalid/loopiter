// Adapted from Supermemory's packages/tools/src/shared/memory-context.ts.
// Copyright (c) 2025 Supermemory Inc. MIT; see THIRD_PARTY_NOTICES.md.
const start = '<loopiter context="released-guidance" readonly>';
const end = "</loopiter>";
const block =
  /(?:\r?\n)?<loopiter context="released-guidance" readonly>[\s\S]*?<\/loopiter>/g;
const delimiter = /<\s*\/?\s*loopiter\b[^>]*>/gi;

/** Removes SDK-owned guidance; this is formatting, not a prompt-injection boundary. */
export function stripGuidance(content: string): string {
  return content.replace(block, "");
}

/** Replaces old guidance while preserving caller-authored instructions and whitespace. */
export function replaceGuidance(content: string, guidance: string): string {
  const preserved = stripGuidance(content);
  const normalized = guidance.trim();
  if (!normalized) return preserved;
  const escaped = normalized.replace(delimiter, (tag) =>
    tag.replace("<", "&lt;").replace(">", "&gt;"),
  );
  const wrapped = `${start}\n${escaped}\n${end}`;
  return preserved ? `${preserved}\n${wrapped}` : wrapped;
}

/** Injects once across instruction messages without changing the caller's objects. */
export function guidanceMessages<T extends { role: string; content: unknown }>(
  messages: readonly T[],
  guidance: string,
): T[] {
  let injected = false;
  const result = messages.map((message) => {
    if (message.role !== "system" && message.role !== "developer")
      return message;
    if (typeof message.content !== "string")
      throw new TypeError(
        "Guidance injection requires text instruction messages.",
      );
    const content = injected
      ? stripGuidance(message.content)
      : replaceGuidance(message.content, guidance);
    injected = true;
    return { ...message, content };
  });
  if (!injected && guidance.trim())
    result.unshift({
      role: "system",
      content: replaceGuidance("", guidance),
    } as T);
  return result;
}
