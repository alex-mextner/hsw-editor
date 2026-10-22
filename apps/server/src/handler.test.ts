import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, type HealthPayload } from './handler.ts';

describe('server handler', () => {
  const dist = mkdtempSync(join(tmpdir(), 'hsw-dist-'));
  writeFileSync(join(dist, 'index.html'), '<html>app</html>');
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets/app.js'), 'console.log(1)');
  const handle = createHandler(dist);

  test('GET /api/health', async () => {
    const response = handle(new Request('http://x/api/health'));
    const body = (await response.json()) as HealthPayload;
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  test('unknown routes fall back to the SPA shell', async () => {
    const response = handle(new Request('http://x/walls/1'));
    expect(await response.text()).toBe('<html>app</html>');
  });

  test('path traversal does not escape the dist dir', async () => {
    const response = handle(new Request('http://x/..%2F..%2Fetc%2Fpasswd'));
    expect(await response.text()).toBe('<html>app</html>');
  });

  test('malformed escapes and directories fall back to the SPA shell', async () => {
    for (const path of ['/%', '/%E0%A4', '/assets/']) {
      const response = handle(new Request(`http://x${path}`));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<html>app</html>');
    }
  });

  test('serves existing static assets', async () => {
    const response = handle(new Request('http://x/assets/app.js'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('console.log(1)');
  });
});
