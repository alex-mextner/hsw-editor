/**
 * Browser-safe API contract of the tool library: zod schemas and types only (no generators, no disk, no
 * renderer), so `apps/web` can parse `/api/tools/*` bodies without bundling the tool classes.
 */
export * from './custom/schema.ts';
export * from './custom/draft.ts';
export * from './assetIndex.ts';
export * from './dims.ts';
