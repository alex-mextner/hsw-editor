/** Test helpers: a config pointing omp at the scripted fake, and a page stand-in that records server messages. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OmpFrame, OmpRpcCommand, OmpServerMessage } from '@hsw-editor/omp-protocol';
import { DEFAULT_ENV_PASSTHROUGH, type OmpConfig } from '../config.ts';
import type { OmpClientPort } from '../session.ts';

export const FAKE_OMP = join(import.meta.dir, 'fake-omp.ts');

export function testConfig(overrides: Partial<OmpConfig> = {}): OmpConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'hsw-omp-test-'));
  return {
    command: [process.execPath, FAKE_OMP],
    approvalMode: 'write',
    extraArgs: [],
    envPassthrough: DEFAULT_ENV_PASSTHROUGH,
    destructiveOps: 'ask',
    destructiveThreshold: 5,
    autoApproveWallTools: true,
    maxChildren: 3,
    idleStopMs: 0,
    dataDir,
    fallbackCwd: join(dataDir, 'omp-workspace'),
    ...overrides,
  };
}

export class TestPage implements OmpClientPort {
  readonly messages: OmpServerMessage[] = [];
  readonly #waiters: (() => void)[] = [];

  constructor(readonly id: string) {}

  send(message: OmpServerMessage): void {
    this.messages.push(message);
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  frames(): OmpFrame[] {
    return this.messages.flatMap((message) => {
      if (message.t !== 'frame') return [];
      // Unmodelled frame types are filtered by the tests that care; tests only look at modelled ones.
      return [message.frame as OmpFrame];
    });
  }

  find<T extends OmpServerMessage['t']>(t: T): Extract<OmpServerMessage, { t: T }> | undefined {
    return this.messages.find(
      (message): message is Extract<OmpServerMessage, { t: T }> => message.t === t,
    );
  }

  /** Resolves when `predicate` holds for the recorded messages (checked after every new message). */
  async until(predicate: (page: TestPage) => boolean, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timed out; messages: ${JSON.stringify(this.messages.map((m) => (m.t === 'frame' ? m.frame.type : m.t)))}`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 100));
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

let commandSeq = 0;
export function rpcCommand<T extends OmpRpcCommand['type']>(
  type: T,
  extra: object = {},
): Extract<OmpRpcCommand, { type: T }> {
  commandSeq += 1;
  // Test helper: callers pass the exact payload fields for `type`.
  return { id: `t${commandSeq}`, type, ...extra } as unknown as Extract<OmpRpcCommand, { type: T }>;
}
