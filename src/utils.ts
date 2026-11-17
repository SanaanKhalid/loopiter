import { createHash, randomUUID } from 'node:crypto';
import type { JsonValue, TimeWindow } from './contracts.js';
export class LoopiterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LoopiterError';
  }
}
export function fail(code: string, message: string): never {
  throw new LoopiterError(code, message);
}
export function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    fail('invalid_input', `${name} must be a nonempty string without NUL.`);
}
export function enumeration<T extends string>(value: unknown, allowed: readonly T[], name: string): asserts value is T {
  if (!allowed.includes(value as T)) fail('invalid_input', `Invalid ${name}.`);
}
export function finite(value: unknown, name: string, minimum = -Infinity): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum)
    fail('invalid_input', `Invalid ${name}.`);
}
export function integer(value: unknown, name: string, minimum = 1): asserts value is number {
  finite(value, name, minimum);
  if (!Number.isSafeInteger(value)) fail('invalid_input', `Invalid ${name}.`);
}
export function timestamp(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail('invalid_input', `Invalid UTC ${name}.`);
  if (new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19))
    fail('invalid_input', `Invalid calendar date for ${name}.`);
}
export function windowValid(window: TimeWindow = {}): void {
  if (window.from !== undefined) timestamp(window.from, 'window.from');
  if (window.to !== undefined) timestamp(window.to, 'window.to');
  if (window.from && window.to && Date.parse(window.from) >= Date.parse(window.to))
    fail('invalid_input', 'Window must be increasing.');
}
export function inWindow(value: string, window: TimeWindow = {}): boolean {
  const t = Date.parse(value);
  return (!window.from || t >= Date.parse(window.from)) && (!window.to || t < Date.parse(window.to));
}
export function json(value: unknown, maxBytes = 262144): asserts value is JsonValue {
  const seen = new Set<unknown>();
  function visit(v: unknown, depth: number): void {
    if (depth > 32) fail('invalid_input', 'JSON nesting exceeds 32 levels.');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      finite(v, 'JSON number');
      return;
    }
    if (typeof v !== 'object' || seen.has(v)) fail('invalid_input', 'Expected acyclic JSON values.');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
      fail('invalid_input', 'Expected plain JSON object.');
    if (Object.getOwnPropertySymbols(v).length) fail('invalid_input', 'JSON cannot contain symbol keys.');
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.keys(v).some(key => !/^(0|[1-9]\d*)$/.test(key)))
    )
      fail('invalid_input', 'JSON arrays must be dense and contain only indexed values.');
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(v)))
      if (descriptor.get || descriptor.set) fail('invalid_input', 'JSON cannot contain accessors.');
    seen.add(v);
    for (const item of Object.values(v)) visit(item, depth + 1);
    seen.delete(v);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) fail('payload_limit', `Payload exceeds ${maxBytes} bytes.`);
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
export function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
export function clone<T>(value: T): T {
  return structuredClone(value);
}
export function object(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input', `${name} must be an object.`);
}
export function getPath(value: unknown, path: string): unknown {
  let result = value;
  for (const key of path.split('.')) {
    if (!result || typeof result !== 'object' || !Object.hasOwn(result, key)) return undefined;
    result = (result as Record<string, unknown>)[key];
  }
  return result;
}
export async function cancellable<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  parent?: AbortSignal,
  timeoutMs = 120000,
): Promise<T> {
  integer(timeoutMs, 'timeoutMs');
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new Error('Cancelled.'));
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new LoopiterError('timeout', 'Callback deadline exceeded.')),
    timeoutMs,
  );
  let onAbort: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const result = await Promise.race([Promise.resolve().then(() => operation(controller.signal)), interrupted]);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
}
