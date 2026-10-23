import { describe, expect, test } from 'bun:test';
import {
  createClientErrorLogger,
  errorEntry,
  THROTTLE_WINDOW_MS,
  type ClientErrorEntry,
} from './clientErrors.ts';

function harness(send?: (entry: ClientErrorEntry) => Promise<unknown>) {
  const sent: ClientErrorEntry[] = [];
  let now = Date.parse('2026-10-22T10:00:00.000Z');
  const logger = createClientErrorLogger({
    send:
      send ??
      ((entry) => {
        sent.push(entry);
        return Promise.resolve(null);
      }),
    now: () => now,
    page: () => 'http://localhost:5173/',
    userAgent: () => 'test-agent',
  });
  return {
    logger,
    sent,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('client error logger', () => {
  test('stamps ts/page/userAgent and passes the contract fields through', () => {
    const { logger, sent } = harness();
    expect(
      logger.log({
        kind: 'asset-load',
        message: 'Could not load /bank/assets/glb/a47bacef44e3f4f4.glb',
        url: '/bank/assets/glb/a47bacef44e3f4f4.glb',
        status: 404,
        bankId: 'caliper-cradle-slots1-beamwidth20',
        detail: { attempts: 2, recovered: false },
      }),
    ).toBe(true);
    expect(sent).toEqual([
      {
        kind: 'asset-load',
        message: 'Could not load /bank/assets/glb/a47bacef44e3f4f4.glb',
        url: '/bank/assets/glb/a47bacef44e3f4f4.glb',
        status: 404,
        bankId: 'caliper-cradle-slots1-beamwidth20',
        detail: { attempts: 2, recovered: false },
        ts: '2026-10-22T10:00:00.000Z',
        page: 'http://localhost:5173/',
        userAgent: 'test-agent',
      },
    ]);
  });

  test('an identical message+url is sent once per 10 s, then again', () => {
    const { logger, sent, advance } = harness();
    const input = { kind: 'render', message: 'boom', url: '/a' } as const;
    expect(logger.log(input)).toBe(true);
    advance(THROTTLE_WINDOW_MS - 1);
    expect(logger.log(input)).toBe(false);
    advance(1);
    expect(logger.log(input)).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test('different message or url is not throttled', () => {
    const { logger, sent } = harness();
    logger.log({ kind: 'render', message: 'boom', url: '/a' });
    logger.log({ kind: 'render', message: 'boom', url: '/b' });
    logger.log({ kind: 'render', message: 'bang', url: '/a' });
    expect(sent).toHaveLength(3);
  });

  test('a failing request is swallowed: no throw, no rejection, no retry loop', async () => {
    let calls = 0;
    const { logger } = harness(() => {
      calls++;
      return Promise.reject(new Error('offline'));
    });
    expect(logger.log({ kind: 'unhandled', message: 'x' })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  test('a synchronous send failure (no fetch) is swallowed too', () => {
    const { logger } = harness(() => {
      throw new TypeError('fetch is not defined');
    });
    expect(() => logger.log({ kind: 'unhandled', message: 'x' })).not.toThrow();
  });

  test('oversized text is clipped so the body stays below the 16 KiB limit', () => {
    const { logger, sent } = harness();
    logger.log({
      kind: 'render',
      message: 'm'.repeat(50_000),
      stack: 's'.repeat(50_000),
      detail: { big: 'd'.repeat(50_000) },
    });
    const body = JSON.stringify(sent[0]);
    expect(body.length).toBeLessThan(12 * 1024);
  });
});

describe('body size guard', () => {
  const bytes = (entry: ClientErrorEntry | undefined) =>
    new TextEncoder().encode(JSON.stringify(entry)).length;

  test('multi-byte text, control characters and long urls still fit under 16 KiB', () => {
    const { logger, sent } = harness();
    logger.log({
      kind: 'render',
      message: '\u6f22'.repeat(1_500),
      stack: '\u0001'.repeat(4_000),
      url: `data:text/javascript,${'x'.repeat(40_000)}`,
      bankId: 'b'.repeat(40_000),
      detail: Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [`k${index}`, '\u6f22'.repeat(1_500)]),
      ),
    });
    expect(bytes(sent[0])).toBeLessThan(16 * 1024);
    expect(sent[0]?.kind).toBe('render');
    expect(sent[0]?.message.length).toBeGreaterThan(0);
  });

  test('an ordinary entry is sent whole, with detail values up to 1500 characters kept', () => {
    const { logger, sent } = harness();
    const stack = 'frame '.repeat(200);
    logger.log({
      kind: 'render',
      message: 'm',
      stack,
      detail: { componentStack: 'c'.repeat(1_500) },
    });
    expect(sent[0]?.stack).toBe(stack);
    expect(sent[0]?.detail?.componentStack).toHaveLength(1_500);
  });
});

describe('last-resort fit', () => {
  test('when even message-only does not fit, the message is cut to 300 characters', () => {
    const { logger, sent } = harness();
    logger.log({
      kind: 'render',
      message: '\u0001'.repeat(1_500),
      url: '\u0001'.repeat(500),
      bankId: '\u0001'.repeat(500),
    });
    // 1500 control characters escape to 6 bytes each: only the last fallback brings it under budget.
    expect(sent[0]?.message.length).toBeLessThanOrEqual(301);
    expect(new TextEncoder().encode(JSON.stringify(sent[0])).length).toBeLessThan(16 * 1024);
  });
});

describe('throttle clock', () => {
  test('a wall clock that jumps backwards does not suppress errors forever', () => {
    const { logger, sent, advance } = harness();
    expect(logger.log({ kind: 'render', message: 'boom' })).toBe(true);
    advance(-60 * 60 * 1000);
    expect(logger.log({ kind: 'render', message: 'boom' })).toBe(true);
    expect(sent).toHaveLength(2);
  });
});

describe('throttle memory', () => {
  test('expired entries are pruned, so the table does not grow without bound', () => {
    const { logger, advance } = harness();
    for (let index = 0; index < 50; index++) logger.log({ kind: 'render', message: `e${index}` });
    expect(logger.remembered()).toBe(50);
    advance(THROTTLE_WINDOW_MS);
    logger.log({ kind: 'render', message: 'fresh' });
    expect(logger.remembered()).toBe(1);
  });

  test('two long messages sharing a 1500-character prefix are throttled as the same error', () => {
    const { logger, sent } = harness();
    const prefix = 'p'.repeat(1_500);
    expect(logger.log({ kind: 'render', message: `${prefix}A` })).toBe(true);
    expect(logger.log({ kind: 'render', message: `${prefix}B` })).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

describe('submit (explicit user reports)', () => {
  test('is not throttled and returns the entry that was sent', async () => {
    const { logger, sent } = harness();
    const first = await logger.submit({ kind: 'user-report', message: 'same', url: '/a' });
    const second = await logger.submit({ kind: 'user-report', message: 'same', url: '/a' });
    expect(first?.ts).toBe('2026-10-22T10:00:00.000Z');
    expect(second).not.toBeNull();
    expect(sent).toHaveLength(2);
  });

  test('reports a failed request as null instead of throwing', async () => {
    const { logger } = harness(() => Promise.reject(new Error('HTTP 500')));
    expect(await logger.submit({ kind: 'user-report', message: 'x' })).toBeNull();
  });
});

describe('errorEntry', () => {
  test('takes message and stack from an Error', () => {
    const error = new Error('render exploded');
    const entry = errorEntry('render', error, { bankId: 'b' });
    expect(entry.message).toBe('render exploded');
    expect(entry.stack).toContain('render exploded');
    expect(entry.bankId).toBe('b');
  });

  test('extracts the message of non-Error throwables instead of [object Object]', () => {
    expect(errorEntry('unhandled', { message: 'Could not load /x.glb: boom' }).message).toBe(
      'Could not load /x.glb: boom',
    );
  });

  test('an Error whose message is not a string cannot make the logger throw', () => {
    const odd = Object.assign(new Error('x'), { message: 42 });
    const { logger } = harness();
    expect(() => logger.log(errorEntry('unhandled', odd))).not.toThrow();
  });

  test('never throws on values without a string form', () => {
    expect(() => errorEntry('unhandled', Object.create(null))).not.toThrow();
    expect(errorEntry('unhandled', Object.create(null)).message).toBe('[object Object]');
  });

  test('stringifies anything else', () => {
    expect(errorEntry('unhandled', 'plain string')).toEqual({
      kind: 'unhandled',
      message: 'plain string',
    });
    expect(errorEntry('unhandled', undefined).message).toBe('undefined');
  });
});
