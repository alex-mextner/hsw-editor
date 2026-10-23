import { describe, expect, test } from 'bun:test';
import { HEAVY_LOCK_HELD_ENV, withHeavyLock } from './exec.ts';

describe('withHeavyLock', () => {
  test('runs the work directly unless HSW_BANK_LOCK=1', async () => {
    if (process.env.HSW_BANK_LOCK === '1') return;
    expect(await withHeavyLock(async () => 'done')).toBe('done');
  });

  test('does not queue on the lock when a parent already holds it (no self-deadlock)', async () => {
    const script = `import { withHeavyLock } from ${JSON.stringify(import.meta.dir + '/exec.ts')};
      console.log(await withHeavyLock(async () => 'done'));`;
    const proc = Bun.spawn(['bun', '-e', script], {
      env: { ...process.env, HSW_BANK_LOCK: '1', [HEAVY_LOCK_HELD_ENV]: '1' },
      stdout: 'pipe',
    });
    const timeout = setTimeout(() => proc.kill(), 10_000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timeout);
    expect(out.trim()).toBe('done');
  });
});
