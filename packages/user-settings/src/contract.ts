/**
 * Per-user settings document shared by the server (`GET|PUT /api/settings`) and the web client.
 * `data` is a bag of namespaces (`keymap`, `settings`, `palette`, ...); each namespace is one opaque JSON value
 * owned by its feature. Merging is namespace-granular: a PUT replaces whole namespaces, `null` deletes one.
 * Contract: docs/api.md, "Settings".
 */
import { type ApiErrorBody, formatIssues, type JsonValue } from '@hsw-editor/core';
import { z } from 'zod';

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_NAMESPACE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const SETTINGS_MAX_NAMESPACES = 64;
/** Serialized size cap of the whole document (UTF-8 bytes). */
export const SETTINGS_MAX_BYTES = 256 * 1024;
/** Nesting cap of one namespace value: a scalar is depth 1, every array/object level adds 1. */
export const SETTINGS_MAX_DEPTH = 16;

export type SettingsErrorCode = 'invalid_body' | 'payload_too_large';

/** A document or PUT body that breaks the contract; `code` maps 1:1 to the HTTP error code. */
export class SettingsContractError extends Error {
  constructor(
    readonly code: SettingsErrorCode,
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'SettingsContractError';
  }
}

export function isValidNamespace(name: string): boolean {
  return SETTINGS_NAMESPACE_PATTERN.test(name);
}

/** True for finite-number/string/boolean/null/array/plain-object trees no deeper than `maxDepth`. */
export function isJsonWithinDepth(
  value: unknown,
  maxDepth = SETTINGS_MAX_DEPTH,
): value is JsonValue {
  if (maxDepth < 1) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonWithinDepth(item, maxDepth - 1));
  if (typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((item) => isJsonWithinDepth(item, maxDepth - 1));
}

export const NamespaceSchema = z
  .string()
  .regex(SETTINGS_NAMESPACE_PATTERN, 'invalid namespace name');

/** A namespace value: any JSON except a top-level `null` (on the wire `null` means "delete the namespace"). */
export type SettingsValue = Exclude<JsonValue, null>;

export const SettingsValueSchema = z.custom<SettingsValue>(
  (value) => value !== null && isJsonWithinDepth(value),
  `value must be non-null JSON no deeper than ${SETTINGS_MAX_DEPTH} levels`,
);

const RevSchema = z.number().int().nonnegative();

export const SettingsDocumentSchema = z
  .object({
    schema: z.literal(SETTINGS_SCHEMA_VERSION),
    rev: RevSchema,
    updatedAt: z.iso.datetime(),
    data: z.record(NamespaceSchema, SettingsValueSchema),
  })
  .strict();

export const SettingsPutBodySchema = z
  .object({
    baseRev: RevSchema.optional(),
    data: z.record(NamespaceSchema, SettingsValueSchema.nullable()),
  })
  .strict();

export interface SettingsDocument {
  schema: typeof SETTINGS_SCHEMA_VERSION;
  /** Monotonic: +1 for every accepted PUT that changes the document. */
  rev: number;
  updatedAt: string;
  data: Record<string, SettingsValue>;
}

export interface SettingsPutBody {
  /** When set, the PUT is refused with `409 rev_conflict` unless it equals the server's current `rev`. */
  baseRev?: number;
  /** Namespaces to replace; `null` deletes a namespace. Absent namespaces are untouched. */
  data: Record<string, JsonValue | null>;
}

/** Body of `409 rev_conflict`: the standard error plus the document the client should reconcile with. */
export interface SettingsRevConflictBody extends ApiErrorBody {
  settings: SettingsDocument;
  currentRev: number;
}

/** Payload of the `settings` SSE event on `GET /api/settings/events`. */
export interface SettingsChangedEvent {
  rev: number;
}

/** Structural equality of JSON values (object key order matters, which is fine for values that round-trip JSON). */
export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function assertDocumentLimits(document: SettingsDocument): void {
  const names = Object.keys(document.data).length;
  if (names > SETTINGS_MAX_NAMESPACES) {
    throw new SettingsContractError(
      'invalid_body',
      `at most ${SETTINGS_MAX_NAMESPACES} namespaces are allowed (got ${names})`,
    );
  }
  const bytes = byteLength(JSON.stringify(document));
  if (bytes > SETTINGS_MAX_BYTES) {
    throw new SettingsContractError(
      'payload_too_large',
      `settings document is ${bytes} bytes, the limit is ${SETTINGS_MAX_BYTES}`,
    );
  }
}

export function parseSettingsDocument(raw: unknown): SettingsDocument {
  const parsed = SettingsDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SettingsContractError(
      'invalid_body',
      'invalid settings document',
      formatIssues(parsed.error),
    );
  }
  assertDocumentLimits(parsed.data);
  return parsed.data;
}

export function parseSettingsPutBody(raw: unknown): SettingsPutBody {
  const parsed = SettingsPutBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new SettingsContractError(
      'invalid_body',
      'invalid settings update',
      formatIssues(parsed.error),
    );
  }
  const { baseRev, data } = parsed.data;
  return baseRev === undefined ? { data } : { baseRev, data };
}

/** The document served before the first PUT. `updatedAt` is the epoch so GET is stable. */
export function defaultSettingsDocument(): SettingsDocument {
  return {
    schema: SETTINGS_SCHEMA_VERSION,
    rev: 0,
    updatedAt: new Date(0).toISOString(),
    data: {},
  };
}

/**
 * Pure merge used by the server: replaces/deletes namespaces and bumps `rev`. Does not check `baseRev` (the store
 * does, atomically with the write). A PUT that changes nothing returns `current` untouched (no rev bump).
 */
export function applySettingsPut(
  current: SettingsDocument,
  body: SettingsPutBody,
  now: Date = new Date(),
): SettingsDocument {
  const data: Record<string, SettingsValue> = { ...current.data };
  let changed = false;
  for (const [name, value] of Object.entries(body.data)) {
    if (value === null) {
      if (Object.hasOwn(data, name)) {
        delete data[name];
        changed = true;
      }
    } else if (!jsonEqual(Object.hasOwn(data, name) ? data[name] : undefined, value)) {
      data[name] = value;
      changed = true;
    }
  }
  if (!changed) return current;
  const next: SettingsDocument = {
    schema: SETTINGS_SCHEMA_VERSION,
    rev: current.rev + 1,
    updatedAt: now.toISOString(),
    data,
  };
  assertDocumentLimits(next);
  return next;
}
