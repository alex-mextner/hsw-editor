/** Helpers every host tool file shares: result shapes, argument errors and JSON Schema generation. */
import type { JsonObject, JsonValue, OmpToolResult } from '@hsw-editor/omp-protocol';
import { z } from 'zod';

export function jsonResult(
  value: JsonValue | object,
  extra: { details?: JsonValue; isError?: boolean } = {},
): OmpToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    ...(extra.details !== undefined ? { details: extra.details } : {}),
    ...(extra.isError ? { isError: true } : {}),
  };
}

export function failure(message: string, details?: JsonValue): OmpToolResult {
  return jsonResult(message, { isError: true, ...(details !== undefined ? { details } : {}) });
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(args)'}: ${issue.message}`)
    .join('; ');
}

export function jsonSchemaOf(schema: z.ZodType): JsonObject {
  // z.toJSONSchema output is plain JSON; the cast only bridges zod's loose return type to JsonObject.
  const generated = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonObject;
  const { $schema: _dropped, ...rest } = generated;
  return rest;
}
