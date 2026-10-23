import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessionFiles } from './session-files.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionWithFirstUserText(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hsw-session-files-'));
  dirs.push(dir);
  const lines = [
    { type: 'session', id: 's1', timestamp: '2026-01-01T00:00:00Z' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } },
  ];
  writeFileSync(join(dir, 's1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return dir;
}

describe('listSessionFiles preview', () => {
  test('uses the first user text as is', () => {
    const [file] = listSessionFiles(sessionWithFirstUserText('hello   wall'));
    expect(file?.preview).toBe('hello wall');
  });

  test('drops the palette-mode instruction block and shows the question', () => {
    const wrapped = [
      '<hsw-palette-mode>',
      'The user asked this from the editor’s command palette, not from the agent panel.',
      '- Rules.',
      '</hsw-palette-mode>',
      'undo the last change',
    ].join('\n');
    const [file] = listSessionFiles(sessionWithFirstUserText(wrapped));
    expect(file?.preview).toBe('undo the last change');
  });
});
