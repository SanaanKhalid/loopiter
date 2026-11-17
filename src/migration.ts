import type { JsonValue, RecordExecutionInput, RecordSignalInput } from './contracts.js';
import type { FeedbackLoop } from './feedback-loop.js';
import { fail, hash, json, object } from './utils.js';
/** Explicit v1 import. Deployment/candidate history is archived, never activated. */
export async function importLegacyV1(
  loop: FeedbackLoop,
  document: unknown,
): Promise<{ executions: number; signals: number; historical: number }> {
  json(document, 128 * 1024 * 1024);
  object(document, 'legacy document');
  if (
    document.version !== 1 ||
    !Array.isArray(document.executions) ||
    !Array.isArray(document.signals) ||
    !Array.isArray(document.candidates)
  )
    fail('invalid_input', 'Expected complete version 1 JSON export.');
  const result = { executions: 0, signals: 0, historical: 0 };
  // Parent-first ordering is checked before writes; repeated imports use the same IDs.
  const remaining = document.executions.filter(v => {
    object(v, 'execution');
    return v.namespace === loop.namespace;
  }) as Record<string, JsonValue>[];
  const ordered: Record<string, JsonValue>[] = [],
    known = new Set<string>();
  while (remaining.length) {
    const index = remaining.findIndex(v => !v.parentExecutionId || known.has(String(v.parentExecutionId)));
    if (index < 0) fail('invalid_input', 'Legacy parent hierarchy is incomplete or cyclic.');
    const [row] = remaining.splice(index, 1);
    ordered.push(row!);
    known.add(String(row!.id));
  }
  for (const row of ordered) {
    const input = Object.fromEntries(
      [
        'id',
        'kind',
        'episodeId',
        'parentExecutionId',
        'entityId',
        'input',
        'output',
        'artifacts',
        'metadata',
        'startedAt',
        'completedAt',
      ]
        .filter(k => row[k] !== undefined)
        .map(k => [k, row[k]]),
    );
    await loop.recordExecution(input as unknown as RecordExecutionInput);
    result.executions++;
  }
  for (const row of document.signals) {
    object(row, 'signal');
    if (row.namespace !== loop.namespace) continue;
    const input = Object.fromEntries(
      [
        'id',
        'executionId',
        'episodeId',
        'kind',
        'name',
        'value',
        'correction',
        'source',
        'confidence',
        'metadata',
        'observedAt',
      ]
        .filter(k => row[k] !== undefined)
        .map(k => [k, row[k]]),
    );
    await loop.recordSignal(input as unknown as RecordSignalInput);
    result.signals++;
  }
  for (const row of document.candidates) {
    object(row, 'candidate');
    if (row.namespace !== loop.namespace) continue;
    const key = `legacy_${hash(row)}`,
      now = loop.now();
    await loop.store.transaction(loop.namespace, async tx => {
      if (!(await tx.get('historical', key)))
        await tx.insert('historical', {
          id: key,
          namespace: loop.namespace,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          original: row as JsonValue,
        });
    });
    result.historical++;
  }
  return result;
}
