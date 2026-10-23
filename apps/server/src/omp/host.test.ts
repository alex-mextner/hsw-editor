import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_TIMINGS } from './session.ts';
import { OmpCapacityError, OmpHost } from './host.ts';
import { testConfig, TestPage } from './testing/harness.ts';

const hosts: OmpHost[] = [];

function makeHost(maxChildren: number): OmpHost {
  const host = new OmpHost({
    config: testConfig({ maxChildren }),
    createTools: () => [],
    timings: { ...DEFAULT_TIMINGS, backoffMs: [30], maxRestarts: 1 },
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
});

describe('OmpHost', () => {
  test('two pages attaching to the same new wall at once share one session', async () => {
    const host = makeHost(3);
    const [first, second] = await Promise.all([
      host.attach('w1', new TestPage('a')),
      host.attach('w1', new TestPage('b')),
    ]);
    expect(first).toBe(second);
    expect(host.statuses()).toHaveLength(1);
    expect(first.clientCount).toBe(2);
  });

  test('the child cap holds when several walls attach at once, and a watched session is not evicted', async () => {
    const host = makeHost(1);
    const results = await Promise.allSettled([
      host.attach('w1', new TestPage('a')),
      host.attach('w2', new TestPage('b')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(OmpCapacityError);
    expect(host.statuses()).toHaveLength(1);
  });

  test('an unwatched idle session is evicted to make room', async () => {
    const host = makeHost(1);
    const first = await host.attach('w1', new TestPage('a'));
    first.detach('a');
    const second = await host.attach('w2', new TestPage('b'));
    expect(second.wallId).toBe('w2');
    expect(host.session('w1')).toBeUndefined();
    expect(first.phase).toBe('stopped');
  });

  test('a stopped session leaves the host at once and the next attach gets a fresh one', async () => {
    const host = makeHost(3);
    const old = await host.attach('w1', new TestPage('a'));
    const stopping = old.stop('user');
    expect(host.session('w1')).toBeUndefined();
    const fresh = await host.attach('w1', new TestPage('b'));
    await stopping;
    expect(fresh).not.toBe(old);
    expect(host.session('w1')).toBe(fresh);
  });

  test('after shutdown nothing can be attached or restarted', async () => {
    const host = makeHost(3);
    const session = await host.attach('w1', new TestPage('a'));
    await host.shutdown();
    await expect(host.attach('w2', new TestPage('b'))).rejects.toThrow(/shutting down/);
    await expect(host.restart(session)).rejects.toThrow(/shutting down/);
  });

  test('restart brings a running session back on a fresh child', async () => {
    const host = makeHost(1);
    const page = new TestPage('a');
    const session = await host.attach('w1', page);
    await page.until((p) => p.find('snapshot') !== undefined);
    const firstPid = session.status().pid;
    await host.restart(session);
    await page.until((p) => p.messages.filter((m) => m.t === 'snapshot').length >= 2);
    expect(session.status().pid).not.toBe(firstPid);
    expect(host.statuses()).toHaveLength(1);
  });
});
