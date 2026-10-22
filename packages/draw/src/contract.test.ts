import { describe, expect, test } from 'bun:test';
import { DrawError, parseDrawRequest, parseDrawSettings, toFailure } from './contract.ts';
import { PROMPT_TEMPLATE_VERSION, buildViewPrompt, chainRefs, planViews } from './prompts.ts';

const valid = { version: 1, prompt: 'side view', outDir: '/tmp/out' };

function invalid(raw: unknown): string {
  try {
    parseDrawRequest(raw);
  } catch (error) {
    if (error instanceof DrawError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'accepted';
}

describe('parseDrawRequest', () => {
  test('applies defaults', () => {
    expect(parseDrawRequest(valid)).toEqual({
      version: 1,
      prompt: 'side view',
      refs: [],
      n: 1,
      size: '1024x1024',
      outDir: '/tmp/out',
    });
  });

  test.each([
    [{ ...valid, version: 2 }, 'version'],
    [{ ...valid, prompt: '   ' }, 'prompt'],
    [{ ...valid, prompt: 'x'.repeat(8001) }, 'prompt'],
    [{ ...valid, n: 5 }, 'n:'],
    [{ ...valid, n: 1.5 }, 'n:'],
    [{ ...valid, size: '10x10' }, 'size'],
    [{ ...valid, outDir: 'relative' }, 'outDir'],
    [{ ...valid, refs: [{ path: 'rel.png' }] }, 'refs[0].path'],
    [{ ...valid, refs: [{ path: '/a.png', role: 'boss' }] }, 'role'],
    [{ ...valid, refs: Array.from({ length: 6 }, () => ({ path: '/a.png' })) }, 'refs'],
    [{ ...valid, timeoutMs: 10 }, 'timeoutMs'],
    [{ ...valid, timeoutMs: Number.NaN }, 'timeoutMs'],
    [{ ...valid, tag: 'x'.repeat(129) }, 'tag'],
    [null, 'JSON object'],
    [[], 'JSON object'],
  ])('rejects %j', (raw, fragment) => {
    const outcome = invalid(raw);
    expect(outcome).toStartWith('invalid_request');
    expect(outcome).toContain(fragment);
  });

  test('keeps valid refs with roles', () => {
    const req = parseDrawRequest({
      ...valid,
      refs: [{ path: '/a.png', role: 'subject' }, { path: '/b.png' }],
    });
    expect(req.refs).toEqual([{ path: '/a.png', role: 'subject' }, { path: '/b.png' }]);
  });
});

describe('failure mapping', () => {
  test('quota is retryable and carries retryAfterMs; login is not', () => {
    const quota = toFailure(
      'omp',
      't',
      new DrawError('quota_exhausted', 'limit', { retryAfterMs: 5000 }),
    );
    expect(quota.error).toMatchObject({ retryable: true, retryAfterMs: 5000 });
    const login = toFailure('omp', undefined, new DrawError('login_required', 'x'));
    expect(login.error.retryable).toBe(false);
  });
});

describe('settings', () => {
  test('accepts known backends and rejects others', () => {
    expect(parseDrawSettings({ backend: 'auto' })).toEqual({ backend: 'auto' });
    expect(() => parseDrawSettings({ backend: 'dalle' })).toThrow(DrawError);
    expect(() => parseDrawSettings(null)).toThrow(DrawError);
  });
});

describe('prompts', () => {
  test('every view prompt demands white background, no shadow, orthographic, same object', () => {
    const steps = planViews({
      object: { name: 'Fischer plug box' },
      views: ['front', 'side', 'top', 'back'],
    });
    for (const step of steps) {
      expect(step.prompt).toMatch(/pure white/i);
      expect(step.prompt).toMatch(/no cast or contact shadow/i);
      expect(step.prompt).toMatch(/orthographic/i);
      expect(step.prompt).toMatch(/SAME single object/);
    }
    expect(PROMPT_TEMPLATE_VERSION).toBe(1);
  });

  test('plan keeps canonical view order, dedupes, and chains refs after the first', () => {
    const steps = planViews({ object: { name: 'x' }, views: ['top', 'front', 'top'] });
    expect(steps.map((s) => [s.view, s.useGeneratedRefs])).toEqual([
      ['front', false],
      ['top', true],
    ]);
  });

  test('dimensions are stated when known', () => {
    const prompt = buildViewPrompt(
      { name: 'box', dimsMm: { width: 80, height: 40, depth: 30 } },
      'front',
    );
    expect(prompt).toContain('80 mm wide, 40 mm high, 30 mm deep');
  });

  test('chainRefs always keeps the subject and caps at 5 refs', () => {
    const generated = ['/a.png', '/b.png', '/c.png', '/d.png', '/e.png'];
    const refs = chainRefs([{ path: '/subject.png' }], generated);
    expect(refs).toHaveLength(5);
    expect(refs[0]).toEqual({ path: '/subject.png', role: 'subject' });
    expect(refs.at(-1)).toEqual({ path: '/e.png', role: 'view' });
  });
});
