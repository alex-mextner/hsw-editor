/** Server-sent events plumbing shared by the wall and job streams. */
const encoder = new TextEncoder();

export interface SseSink {
  send(event: string, data: unknown, id?: string | number): void;
  close(): void;
}

export interface SseOptions {
  /** Called once the stream is open; returns a cleanup that runs when the client goes away. */
  start(sink: SseSink): Promise<() => void> | (() => void);
  heartbeat?: { everyMs: number; event: string; data: () => unknown };
}

export function sseResponse(request: Request, options: SseOptions): Response {
  let cleanup: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const finish = (): void => {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearInterval(timer);
        cleanup?.();
        try {
          controller.close();
        } catch {
          // already closed by the runtime
        }
      };
      const sink: SseSink = {
        send(event, data, id) {
          if (closed) return;
          const head = id === undefined ? '' : `id: ${id}\n`;
          const body = JSON.stringify(data)
            .split('\n')
            .map((line) => `data: ${line}`)
            .join('\n');
          try {
            controller.enqueue(encoder.encode(`${head}event: ${event}\n${body}\n\n`));
          } catch {
            finish();
          }
        },
        close: finish,
      };
      controller.enqueue(encoder.encode('retry: 2000\n\n'));
      request.signal.addEventListener('abort', finish, { once: true });
      cleanup = await options.start(sink);
      if (closed) cleanup();
      const beat = options.heartbeat;
      if (beat !== undefined && !closed) {
        timer = setInterval(() => sink.send(beat.event, beat.data()), beat.everyMs);
      }
    },
    cancel() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}
