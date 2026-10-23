import { afterEach, describe, expect, test } from 'bun:test';
import { HttpVisionPort, VisionRequestError } from './vision-port.ts';

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true);
});

function sidecar(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const REQUEST = {
  imagePath: '/tmp/x.jpg',
  outDir: '/tmp/out',
  calibration: { mmPerPx: 1.2 },
  categoriesPath: '/tmp/classes.json',
  mode: 'multi' as const,
};

describe('HttpVisionPort', () => {
  test('reads progress events and a final result line without a trailing newline', async () => {
    const events: string[] = [];
    const url = sidecar(
      () =>
        new Response(
          `${JSON.stringify({ event: 'stage', name: 'segment' })}\n${JSON.stringify({ event: 'result', result: { status: 'ok', objects: [] } })}`,
        ),
    );
    const result = await new HttpVisionPort(url).photoToObjects({
      ...REQUEST,
      onEvent: (e) => events.push(e.event),
    });
    expect(result.status).toBe('ok');
    expect(events).toEqual(['stage']);
  });

  test('sends the calibration and categories the sidecar expects', async () => {
    let seen: unknown;
    const url = sidecar(async (req) => {
      seen = await req.json();
      return new Response(
        `${JSON.stringify({ event: 'result', result: { status: 'ok', objects: [] } })}\n`,
      );
    });
    await new HttpVisionPort(url).photoToObjects(REQUEST);
    expect(seen).toMatchObject({
      image_path: '/tmp/x.jpg',
      out_dir: '/tmp/out',
      calibrate: { mode: 'manual', mm_per_px: 1.2 },
      categories: '/tmp/classes.json',
    });
  });

  test('turns an error event into a VisionRequestError with the sidecar fix text', async () => {
    const url = sidecar(
      () =>
        new Response(
          `${JSON.stringify({ event: 'error', error: { code: 'models_missing', message: 'no weights', fix: 'fetch-models' } })}\n`,
          { status: 424, headers: { 'content-type': 'application/x-ndjson' } },
        ),
    );
    const failure = await new HttpVisionPort(url).photoToObjects(REQUEST).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(VisionRequestError);
    expect((failure as VisionRequestError).code).toBe('models_missing');
    expect((failure as VisionRequestError).message).toContain('fetch-models');
  });

  test('rejects a malformed edit reply instead of crashing later', async () => {
    const url = sidecar(() => Response.json({ nope: true }));
    const failure = await new HttpVisionPort(url)
      .mergeObjects('/tmp/out', [1, 2])
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(VisionRequestError);
    expect((failure as VisionRequestError).code).toBe('bad_response');
  });
});
