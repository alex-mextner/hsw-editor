/** The vision jobs read the real bank index (committed seed, temp data home), the one `GET /api/bank/index` serves. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BankIndexSchema } from '@hsw-editor/bank';
import { readBankIndex } from './bank-index.ts';

let root: string;
let savedBankDir: string | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hsw-vision-bank-'));
  // an ambient override would point the bank away from the temp data home
  savedBankDir = process.env['HSW_BANK_DIR'];
  delete process.env['HSW_BANK_DIR'];
});

afterAll(() => {
  if (savedBankDir !== undefined) process.env['HSW_BANK_DIR'] = savedBankDir;
  rmSync(root, { recursive: true, force: true });
});

test('readBankIndex returns the served bank index with its content hash, tool classes and elements', async () => {
  const index = BankIndexSchema.parse(await readBankIndex(join(root, 'home')));
  expect(index.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(index.elements.length).toBeGreaterThan(50);
  expect(index.toolClasses.length).toBeGreaterThan(0);
});
