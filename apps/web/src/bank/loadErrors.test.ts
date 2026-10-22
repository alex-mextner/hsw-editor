import { describe, expect, test } from 'bun:test';
import {
  backoffDelayMs,
  classifyLoadError,
  errorMessage,
  isRetryable,
  MAX_AUTO_ATTEMPTS,
} from './loadErrors.ts';

const MISSING_URL = '/bank/assets/glb/a47bacef44e3f4f4.glb';
/** The exact message of the incident: R3F wrapping three's FileLoader error. */
const INCIDENT_MESSAGE = `Could not load ${MISSING_URL}: fetch for "${MISSING_URL}" responded with 404: Not Found`;

describe('classifyLoadError', () => {
  test('the incident message is an asset-missing 404 for the GLB url', () => {
    expect(classifyLoadError(new Error(INCIDENT_MESSAGE))).toEqual({
      kind: 'asset-missing',
      url: MISSING_URL,
      status: 404,
    });
  });

  test('a bare FileLoader message without the R3F wrapper is recognised too', () => {
    const message = `fetch for "https://example.test/a.glb" responded with 404: Not Found`;
    expect(classifyLoadError(new Error(message))).toEqual({
      kind: 'asset-missing',
      url: 'https://example.test/a.glb',
      status: 404,
    });
  });

  test('other 4xx statuses mean the asset is not available to us', () => {
    expect(
      classifyLoadError(new Error(`fetch for "/x.glb" responded with 403: Forbidden`)).kind,
    ).toBe('asset-missing');
    expect(classifyLoadError(new Error(`fetch for "/x.glb" responded with 410: Gone`)).kind).toBe(
      'asset-missing',
    );
  });

  test('5xx and throttling are transient network trouble, keeping the status', () => {
    expect(
      classifyLoadError(new Error(`fetch for "/x.glb" responded with 503: Service Unavailable`)),
    ).toEqual({ kind: 'network', url: '/x.glb', status: 503 });
    expect(
      classifyLoadError(new Error(`fetch for "/x.glb" responded with 429: Too Many`)).kind,
    ).toBe('network');
  });

  test('a dropped connection is a network error and keeps the url from the R3F wrapper', () => {
    expect(classifyLoadError(new TypeError('Failed to fetch'))).toEqual({ kind: 'network' });
    expect(classifyLoadError(new Error(`Could not load ${MISSING_URL}: Load failed`))).toEqual({
      kind: 'network',
      url: MISSING_URL,
    });
    expect(
      classifyLoadError(new Error('NetworkError when attempting to fetch resource.')).kind,
    ).toBe('network');
  });

  test('a corrupt file is a decode error', () => {
    expect(
      classifyLoadError(
        new Error(`Could not load ${MISSING_URL}: THREE.GLTFLoader: Unsupported asset.`),
      ),
    ).toEqual({ kind: 'decode', url: MISSING_URL });
    expect(
      classifyLoadError(new SyntaxError('Unexpected token < in JSON at position 0')).kind,
    ).toBe('decode');
  });

  test('anything else is unknown, with the url when the loader named it', () => {
    expect(classifyLoadError(new Error('boom'))).toEqual({ kind: 'unknown' });
    expect(classifyLoadError(new Error(`Could not load /p.jpg: undefined`))).toEqual({
      kind: 'unknown',
      url: '/p.jpg',
    });
  });

  test('non-Error throwables are classified from their message', () => {
    expect(classifyLoadError(INCIDENT_MESSAGE).status).toBe(404);
    expect(classifyLoadError({ message: INCIDENT_MESSAGE }).kind).toBe('asset-missing');
    expect(classifyLoadError(undefined)).toEqual({ kind: 'unknown' });
    expect(errorMessage(42)).toBe('42');
  });

  test('which kinds are worth retrying', () => {
    expect(isRetryable('asset-missing')).toBe(true);
    expect(isRetryable('network')).toBe(true);
    expect(isRetryable('decode')).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  const noJitter = () => 0;

  test('doubles from 1s and caps at 30s', () => {
    const delays = Array.from({ length: MAX_AUTO_ATTEMPTS }, (_, attempt) =>
      backoffDelayMs(attempt, noJitter),
    );
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });

  test('jitter stretches the delay by at most 20 %', () => {
    expect(backoffDelayMs(0, () => 0.5)).toBe(1100);
    expect(backoffDelayMs(3, () => 0.999999)).toBe(9600);
    expect(backoffDelayMs(5, () => 0.999999)).toBe(36000);
  });

  test('after six automatic attempts only a manual retry is left', () => {
    expect(backoffDelayMs(MAX_AUTO_ATTEMPTS, noJitter)).toBeNull();
    expect(backoffDelayMs(99, noJitter)).toBeNull();
  });

  test('rejects nonsense attempts instead of scheduling them', () => {
    expect(backoffDelayMs(-1, noJitter)).toBeNull();
    expect(backoffDelayMs(1.5, noJitter)).toBeNull();
    expect(backoffDelayMs(Number.NaN, noJitter)).toBeNull();
  });

  test('default jitter stays inside the documented band', () => {
    for (let i = 0; i < 50; i++) {
      const delay = backoffDelayMs(1);
      expect(delay).not.toBeNull();
      expect(delay ?? 0).toBeGreaterThanOrEqual(2000);
      expect(delay ?? 0).toBeLessThanOrEqual(2400);
    }
  });
});
