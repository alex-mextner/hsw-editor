import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createEmptyWall } from '@hsw-editor/core';
import { api, ApiError, NetworkError } from './http.ts';

interface Answer {
  readonly status: number;
  readonly body: string;
}

/** Just enough of XMLHttpRequest for `uploadPhoto`: it answers the next send with a scripted response. */
class FakeXhr {
  static next: Answer | 'network-error' = { status: 500, body: '' };
  static progress: readonly { loaded: number; total: number }[] = [];
  responseText = '';
  status = 0;
  responseType = '';
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(): void {}
  send(): void {
    queueMicrotask(() => {
      for (const { loaded, total } of FakeXhr.progress) {
        this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
      }
      if (FakeXhr.next === 'network-error') {
        this.onerror?.();
        return;
      }
      this.status = FakeXhr.next.status;
      this.responseText = FakeXhr.next.body;
      this.onload?.();
    });
  }
}

const original = globalThis.XMLHttpRequest;
beforeEach(() => {
  FakeXhr.progress = [];
  Object.assign(globalThis, { XMLHttpRequest: FakeXhr });
});
afterEach(() => {
  Object.assign(globalThis, { XMLHttpRequest: original });
});

const file = new File(['x'], 'wall.jpg', { type: 'image/jpeg' });

describe('uploadPhoto', () => {
  test('reports upload progress and returns the photo id with the wall that contains it', async () => {
    const wall = {
      ...createEmptyWall('w', 'W'),
      rev: 1,
      photos: [
        {
          id: 'p1',
          file: 'photos/p1.jpg',
          mime: 'image/jpeg',
          width: 10,
          height: 20,
          origin: 'upload',
        },
      ],
    };
    FakeXhr.next = { status: 201, body: JSON.stringify({ photo: wall.photos[0], rev: 1, wall }) };
    FakeXhr.progress = [
      { loaded: 10, total: 40 },
      { loaded: 40, total: 40 },
    ];
    const seen: number[] = [];
    const result = await api.uploadPhoto('w', file, ({ loaded, total }) =>
      seen.push(loaded / total),
    );
    expect(result.photoId).toBe('p1');
    expect(result.wall.photos).toHaveLength(1);
    expect(seen).toEqual([0.25, 1]);
  });

  test('a refusal with an error body becomes an ApiError carrying the server code', async () => {
    FakeXhr.next = {
      status: 413,
      body: JSON.stringify({ error: { code: 'payload_too_large', message: 'too big' } }),
    };
    const failure = await api.uploadPhoto('w', file).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 413, code: 'payload_too_large', message: 'too big' });
  });

  test('a body that is not JSON still fails as an ApiError', async () => {
    FakeXhr.next = { status: 415, body: '<html>nope</html>' };
    const failure = await api.uploadPhoto('w', file).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 415, code: 'http_error' });
  });

  test('a dead gateway and a dropped connection are network errors, not refusals', async () => {
    FakeXhr.next = { status: 502, body: '' };
    expect(await api.uploadPhoto('w', file).catch((error: unknown) => error)).toBeInstanceOf(
      NetworkError,
    );
    FakeXhr.next = 'network-error';
    expect(await api.uploadPhoto('w', file).catch((error: unknown) => error)).toBeInstanceOf(
      NetworkError,
    );
  });
});
