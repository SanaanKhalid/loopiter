import type { FeedbackLoop } from './feedback-loop.js';
import type {
  AiExecution,
  AnalyzeOptions,
  Collection,
  Collections,
  FeedbackSignal,
  Finding,
  JsonObject,
  TimeWindow,
} from './contracts.js';
import { executionKinds, signalKinds } from './contracts.js';
import type { StoreTransaction } from './store.js';
import {
  enumeration,
  fail,
  finite,
  getPath,
  hash,
  integer,
  nonempty,
  stableJson,
  object,
  windowValid,
} from './utils.js';
import { stored } from './validation.js';
export function defaultSignalScore(signal: FeedbackSignal): number | undefined {
  if (typeof signal.value === 'boolean') return Number(signal.value);
  if (typeof signal.value === 'number') return signal.value;
  if (typeof signal.value === 'string') {
    if (['yes', 'good', 'correct', 'positive', 'success'].includes(signal.value.toLowerCase())) return 1;
    if (['no', 'bad', 'incorrect', 'negative', 'failure'].includes(signal.value.toLowerCase())) return 0;
  }
  return undefined;
}
export async function readAll<K extends Collection>(
  tx: StoreTransaction,
  namespace: string,
  kind: K,
  maximum: number,
  window: TimeWindow = {},
): Promise<Collections[K][]> {
  const rows: Collections[K][] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await tx.list(kind, {
      limit: Math.min(1000, maximum + 1 - rows.length),
      window,
      ...(cursor ? { cursor } : {}),
    });
    object(page, 'adapter page');
    if (!Array.isArray(page.items)) fail('integrity_error', 'Adapter page must contain items.');
    if (page.nextCursor !== undefined) nonempty(page.nextCursor, 'nextCursor');
    for (const row of page.items) {
      stored(kind, row, namespace);
      if (seen.has(row.id)) fail('integrity_error', 'Duplicate/pagination cycle from adapter.');
      seen.add(row.id);
      rows.push(row);
    }
    if (rows.length > maximum)
      fail(
        'query_limit',
        `Analysis exceeds ${maximum} ${kind}; narrow the window or explicitly increase maximumRecords.`,
      );
    if (page.nextCursor && (page.nextCursor === cursor || !page.items.length))
      fail('integrity_error', 'Non-progressing adapter cursor.');
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}
type Scored = { signal: FeedbackSignal; score: number };
type Units = Map<string, Map<string, Scored>>;
function summary(units: Units): { mean: number; weight: number; count: number } | undefined {
  let total = 0;
  let weight = 0;
  for (const items of units.values()) {
    let sum = 0;
    let w = 0;
    for (const { score, signal } of items.values()) {
      sum += score * signal.confidence;
      w += signal.confidence;
    }
    // Normalize within each episode: long conversations do not get extra votes.
    const unitWeight = w / items.size;
    total += (sum / w) * unitWeight;
    weight += unitWeight;
  }
  return weight > 0 ? { mean: total / weight, weight, count: units.size } : undefined;
}
function bucket(time: string, size: 'day' | 'week' | 'month'): string {
  if (size === 'day') return time.slice(0, 10);
  if (size === 'month') return time.slice(0, 7);
  const date = new Date(time);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}
export async function analyze(loop: FeedbackLoop, options: AnalyzeOptions): Promise<Finding[]> {
  if (!Array.isArray(options.dimensions) || options.dimensions.length < 1 || options.dimensions.length > 8)
    fail('invalid_input', 'Choose 1–8 dimensions.');
  for (const d of options.dimensions) nonempty(d, 'dimension');
  if (new Set(options.dimensions).size !== options.dimensions.length) fail('invalid_input', 'Duplicate dimensions.');
  for (const kind of options.executionKinds ?? []) enumeration(kind, executionKinds, 'executionKind');
  for (const kind of options.signalKinds ?? []) enumeration(kind, signalKinds, 'signalKind');
  windowValid(options.executionWindow);
  windowValid(options.observationWindow);
  const max = options.maximumRecords ?? 20000;
  integer(max, 'maximumRecords');
  const depth = options.maximumDimensionDepth ?? 2;
  integer(depth, 'maximumDimensionDepth');
  if (depth > 2) fail('query_limit', 'Alpha supports dimension depth 1 or 2.');
  const support = options.minimumSupport ?? 5,
    scoredMinimum = options.minimumScoredCount ?? 2;
  const recurrence = options.minimumRecurrence ?? 1,
    entities = options.minimumDistinctEntities ?? 0,
    effectMinimum = options.minimumEffectSize ?? 0;
  integer(support, 'minimumSupport');
  integer(scoredMinimum, 'minimumScoredCount');
  integer(recurrence, 'minimumRecurrence');
  integer(entities, 'minimumDistinctEntities', 0);
  finite(effectMinimum, 'minimumEffectSize', 0);
  const size = options.timeBucket ?? 'week';
  enumeration(size, ['day', 'week', 'month'], 'timeBucket');
  const { executions, signals } = await loop.store.transaction(loop.namespace, async tx => ({
    executions: await readAll(tx, loop.namespace, 'executions', max, options.executionWindow),
    signals: await readAll(tx, loop.namespace, 'signals', max, options.observationWindow),
  }));
  const selected = executions.filter(e => !options.executionKinds || options.executionKinds.includes(e.kind));
  const byExecution = new Map<string, Scored[]>(),
    byEpisode = new Map<string, Scored[]>();
  for (const signal of signals) {
    if (
      (options.signalNames && !options.signalNames.includes(signal.name)) ||
      (options.signalKinds && !options.signalKinds.includes(signal.kind))
    )
      continue;
    const score = (options.score ?? defaultSignalScore)(signal);
    if (score !== undefined) finite(score, 'score callback result');
    if (score === undefined || signal.confidence <= 0) continue;
    const index = signal.executionId ? byExecution : byEpisode;
    const key = signal.executionId ?? signal.episodeId!;
    const values = index.get(key) ?? [];
    values.push({ signal, score });
    index.set(key, values);
  }
  function unitsFor(rows: AiExecution[]): Units {
    const units: Units = new Map();
    for (const row of rows) {
      const items = [
        ...(byExecution.get(row.id) ?? []),
        ...(options.includeEpisodeSignals !== false && row.episodeId ? (byEpisode.get(row.episodeId) ?? []) : []),
      ];
      if (!items.length) continue;
      const key = row.episodeId ? `episode:${row.episodeId}` : `execution:${row.id}`;
      const values = units.get(key) ?? new Map<string, Scored>();
      for (const item of items) values.set(item.signal.id, item);
      units.set(key, values);
    }
    return units;
  }
  const baselineUnits = unitsFor(selected),
    baseline = summary(baselineUnits);
  if (!baseline) return [];
  const sets = options.dimensions.map(d => [d]);
  if (depth === 2)
    for (let a = 0; a < options.dimensions.length; a++)
      for (let b = a + 1; b < options.dimensions.length; b++)
        sets.push([options.dimensions[a]!, options.dimensions[b]!]);
  const segments = new Map<string, { dimensions: JsonObject; rows: AiExecution[] }>();
  for (const row of selected)
    for (const set of sets) {
      const values = set.map(d => [d, getPath(row, d)] as const);
      if (values.some(([, v]) => v === undefined)) continue;
      const dimensions = Object.fromEntries(values) as JsonObject,
        key = stableJson(dimensions);
      const segment = segments.get(key) ?? { dimensions, rows: [] };
      segment.rows.push(row);
      segments.set(key, segment);
    }
  const findings: Finding[] = [];
  const baselineFingerprint = hash({
    executions: selected.map(r => [r.id, r.revision, r.inputHash]).sort(),
    baseline: [...baselineUnits]
      .map(([key, items]) => [
        key,
        [...items.values()].map(i => [i.signal.id, i.signal.inputHash, i.score, i.signal.confidence]).sort(),
      ])
      .sort(),
  });
  for (const { dimensions, rows } of segments.values()) {
    const units = unitsFor(rows),
      stats = summary(units);
    if (!stats || units.size < support || stats.count < scoredMinimum) continue;
    const effect = stats.mean - baseline.mean;
    if (!Number.isFinite(effect) || Math.abs(effect) < effectMinimum) continue;
    const unique = new Map<string, Scored>();
    const corrections: Record<string, number> = Object.create(null);
    for (const items of units.values()) {
      const perUnit = new Set<string>();
      for (const [key, item] of items) {
        unique.set(key, item);
        if (item.signal.correction !== undefined) perUnit.add(stableJson(item.signal.correction));
      }
      for (const key of perUnit) corrections[key] = (corrections[key] ?? 0) + 1;
    }
    const buckets = new Set([...unique.values()].map(item => bucket(item.signal.observedAt, size)));
    const eligibleRows = rows.filter(r => units.has(r.episodeId ? `episode:${r.episodeId}` : `execution:${r.id}`));
    const distinct = new Set(eligibleRows.flatMap(r => (r.entityId ? [r.entityId] : [])));
    if (buckets.size < recurrence || distinct.size < entities) continue;
    const manifest = {
      version: 1 as const,
      executionIds: eligibleRows.map(r => r.id).sort(),
      signalIds: [...unique.keys()].sort(),
      executionWindow: options.executionWindow ?? {},
      observationWindow: options.observationWindow ?? {},
    };
    // Include baseline evidence, revisions and scored values, not only this segment's IDs.
    const fingerprint = hash({ manifest, baselineFingerprint });
    findings.push({
      id: hash({ namespace: loop.namespace, dimensions }),
      namespace: loop.namespace,
      dimensions,
      support: units.size,
      executionCount: rows.length,
      uniqueSignalCount: unique.size,
      episodeCount: new Set(eligibleRows.flatMap(r => (r.episodeId ? [r.episodeId] : []))).size,
      scoredCount: stats.count,
      effectiveWeight: stats.weight,
      meanScore: stats.mean,
      baselineScore: baseline.mean,
      effectSize: effect,
      recurrence: buckets.size,
      distinctEntities: distinct.size,
      correctionCounts: corrections,
      evidence: { ...manifest, fingerprint },
    });
  }
  return findings.sort((a, b) => a.effectSize - b.effectSize || a.id.localeCompare(b.id));
}
