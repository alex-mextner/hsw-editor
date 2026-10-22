import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import '@/test/domGlobals.ts';
import { installFetch, restoreFetch, settleRequests } from '@/test/fetchStub.ts';
import {
  CLIENT_ERRORS_ROUTE,
  installGlobalErrorLogging,
  resetClientErrorThrottle,
} from './clientErrors.ts';

const posted: { kind: string; message: string; url?: string }[] = [];
let stop: () => void = () => undefined;
let failRequests = false;

beforeEach(() => {
  posted.length = 0;
  failRequests = false;
  resetClientErrorThrottle();
  installFetch((url, init) => {
    if (url !== CLIENT_ERRORS_ROUTE) throw new TypeError('unexpected');
    if (failRequests) throw new TypeError('Failed to fetch');
    posted.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  });
  stop = installGlobalErrorLogging();
});
afterEach(() => {
  stop();
  restoreFetch();
});

function rejection(reason: unknown): Event {
  return Object.assign(new Event('unhandledrejection'), { reason });
}

describe('installGlobalErrorLogging', () => {
  test('logs an uncaught error as kind unhandled', async () => {
    const error = new Error('script exploded');
    window.dispatchEvent(Object.assign(new Event('error'), { error, message: 'script exploded' }));
    await settleRequests();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: 'unhandled', message: 'script exploded' });
  });

  test('logs an unhandled rejection, e.g. the R3F loader error of the incident', async () => {
    const message =
      'Could not load /bank/assets/glb/a47bacef44e3f4f4.glb: fetch for "/bank/assets/glb/a47bacef44e3f4f4.glb" responded with 404: Not Found';
    window.dispatchEvent(rejection(new Error(message)));
    await settleRequests();
    expect(posted[0]).toMatchObject({ kind: 'unhandled', message });
  });

  test('the same error twice within 10 s is logged once', async () => {
    window.dispatchEvent(rejection(new Error('again')));
    window.dispatchEvent(rejection(new Error('again')));
    await settleRequests();
    expect(posted).toHaveLength(1);
  });

  test('a failing log request never throws or escalates into another error', async () => {
    failRequests = true;
    expect(() => window.dispatchEvent(rejection(new Error('offline')))).not.toThrow();
    // Let the rejected request surface; it must stay swallowed (no unhandled rejection -> no new log).
    await settleRequests();
    failRequests = false;
    window.dispatchEvent(rejection(new Error('after outage')));
    await settleRequests();
    expect(posted.map((entry) => entry.message)).toEqual(['after outage']);
  });

  test('stopping removes the listeners', async () => {
    stop();
    window.dispatchEvent(rejection(new Error('ignored')));
    await settleRequests();
    expect(posted).toHaveLength(0);
  });

  test('installing twice does not log every error twice, and both callers hold the same teardown', async () => {
    const second = installGlobalErrorLogging();
    expect(second).toBe(stop);
    window.dispatchEvent(rejection(new Error('once only')));
    await settleRequests();
    expect(posted).toHaveLength(1);
    second();
    window.dispatchEvent(rejection(new Error('after stop')));
    await settleRequests();
    expect(posted).toHaveLength(1);
  });

  test('can be installed again after being stopped', async () => {
    stop();
    stop = installGlobalErrorLogging();
    window.dispatchEvent(rejection(new Error('after reinstall')));
    await settleRequests();
    expect(posted.map((entry) => entry.message)).toEqual(['after reinstall']);
  });
});
