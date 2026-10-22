import { resolve } from 'node:path';
import { createHandler } from './handler.ts';

export const DEFAULT_PORT = 8794;
const port = Number(process.env['HSW_EDITOR_PORT'] ?? DEFAULT_PORT);
const host = process.env['HSW_EDITOR_HOST'] ?? '127.0.0.1';
const webDist = process.env['HSW_EDITOR_WEB_DIST'] ?? resolve(import.meta.dir, '../../web/dist');

const server = Bun.serve({ hostname: host, port, fetch: createHandler(webDist) });
console.info(`hsw-editor listening on http://${server.hostname}:${server.port}`);
