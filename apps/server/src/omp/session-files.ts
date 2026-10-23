/**
 * Lists the omp sessions stored for one wall (`<dataDir>/omp/<wallId>/*.jsonl`). Only that directory is
 * ever read, so the panel never sees the user's other projects' sessions.
 */
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isJsonObject, type JsonValue, type OmpSessionFile } from '@hsw-editor/omp-protocol';

const HEAD_BYTES = 64 * 1024;
const PREVIEW_CHARS = 120;

function readHead(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function parseLine(line: string): JsonValue | null {
  try {
    return JSON.parse(line) as JsonValue;
  } catch {
    return null;
  }
}

function userText(content: JsonValue | undefined): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (isJsonObject(block) && block['type'] === 'text' && typeof block['text'] === 'string')
      return block['text'];
  }
  return null;
}

/** Newest first. Unreadable or non-session files are skipped. */
export function listSessionFiles(sessionDir: string): OmpSessionFile[] {
  if (!existsSync(sessionDir)) return [];
  const files: OmpSessionFile[] = [];
  for (const name of readdirSync(sessionDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(sessionDir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      let id: string | null = null;
      let createdAt: string | null = null;
      let title: string | null = null;
      let preview: string | null = null;
      for (const line of readHead(path).split('\n')) {
        const entry = parseLine(line);
        if (!isJsonObject(entry)) continue;
        if (
          entry['type'] === 'title' &&
          typeof entry['title'] === 'string' &&
          entry['title'].length > 0
        ) {
          title = entry['title'];
        } else if (entry['type'] === 'session' && typeof entry['id'] === 'string') {
          id = entry['id'];
          createdAt = typeof entry['timestamp'] === 'string' ? entry['timestamp'] : null;
          if (typeof entry['title'] === 'string' && entry['title'].length > 0)
            title ??= entry['title'];
        } else if (entry['type'] === 'message' && preview === null) {
          const message = entry['message'];
          if (isJsonObject(message) && message['role'] === 'user') {
            const text = userText(message['content']);
            if (text) preview = text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
          }
        }
      }
      if (id === null) continue;
      files.push({
        path,
        id,
        title,
        preview,
        createdAt,
        updatedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
      });
    } catch {
      // A file being rotated or half-written is not worth failing the listing for.
    }
  }
  return files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
