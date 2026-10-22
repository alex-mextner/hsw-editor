/**
 * `GET /api/vision/status` (never starts the sidecar: running/endpoint/health/model files) and
 * `POST /api/vision/stop` (stops a sidecar this server spawned, freeing its VRAM). Everything else about vision goes
 * through the jobs API (`vision.*`).
 */
import type { ServerModule } from '../modules.ts';
import type { VisionClient } from './client.ts';

export function createVisionModule(client: VisionClient): ServerModule {
  return {
    name: 'vision',
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/api/vision/status' && request.method === 'GET') {
        return Response.json(await client.status());
      }
      if (pathname === '/api/vision/stop' && request.method === 'POST') {
        await client.stop();
        return Response.json({ ok: true });
      }
      return null;
    },
  };
}
