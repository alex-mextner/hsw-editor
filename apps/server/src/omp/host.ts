/**
 * Owns every omp session of the daemon: lookup by wall id, the global child cap, version probing,
 * and shutdown (graceful on request, best-effort kill from the process `exit` hook).
 *
 * Attaches are serialized: creating a session, evicting another one to make room and registering the new
 * one is a single critical section, so two pages opening the same wall (or different walls near the cap)
 * can neither create duplicate sessions nor exceed `maxChildren`.
 */
import { ID_PATTERN } from '@hsw-editor/core';
import type { OmpSessionStatus } from '@hsw-editor/omp-protocol';
import type { OmpConfig } from './config.ts';
import { childEnv } from './config.ts';
import { OmpSession, type OmpClientPort, type SessionTimings } from './session.ts';
import type { ToolFactory } from './tool-types.ts';

/** Wall ids become directory names; `ID_PATTERN` forbids `.`/`..` (first character is alphanumeric). */
export function isValidWallId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export class OmpCapacityError extends Error {}

export interface OmpHostOptions {
  readonly config: OmpConfig;
  readonly createTools: ToolFactory;
  readonly timings?: SessionTimings;
  readonly log?: (message: string) => void;
}

export class OmpHost {
  readonly config: OmpConfig;
  readonly #options: OmpHostOptions;
  readonly #sessions = new Map<string, OmpSession>();
  /** Stopped sessions whose child is still exiting: they keep counting against the cap. */
  readonly #closing = new Set<OmpSession>();
  #attachQueue: Promise<unknown> = Promise.resolve();
  #version: Promise<string | undefined> | null = null;
  #exitHook: (() => void) | null = null;

  #shutDown = false;

  constructor(options: OmpHostOptions) {
    this.#options = options;
    this.config = options.config;
  }

  /** `omp --version` once; undefined when omp cannot be run (the session then fails with a clear error). */
  ompVersion(): Promise<string | undefined> {
    this.#version ??= this.#probeVersion();
    return this.#version;
  }

  async #probeVersion(): Promise<string | undefined> {
    const [bin, ...prefix] = this.config.command;
    if (bin === undefined) return undefined;
    try {
      const proc = Bun.spawn([bin, ...prefix, '--version'], {
        env: childEnv(this.config),
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      const text = await new Response(proc.stdout).text();
      clearTimeout(timer);
      const match = /(\d+\.\d+\.\d+)/.exec(text);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  session(wallId: string): OmpSession | undefined {
    return this.#sessions.get(wallId);
  }

  statuses(): OmpSessionStatus[] {
    return [...this.#sessions.values()].map((session) => session.status());
  }

  /** Attach a page to the wall's session, creating it (and starting its child) on demand. */
  attach(wallId: string, port: OmpClientPort): Promise<OmpSession> {
    if (!isValidWallId(wallId)) return Promise.reject(new Error('invalid wall id'));
    return this.#serialized(() => this.#attachNow(wallId, port));
  }

  /** Restart a session; one without a child needs a free slot first. */
  restart(session: OmpSession): Promise<void> {
    return this.#serialized(async () => {
      this.#assertRunning();
      if (this.#sessions.get(session.wallId) !== session) return;
      if (!session.occupiesSlot) {
        await this.#ensureCapacity();
        this.#assertRunning();
      }
      // Not awaited: closing the old child takes up to a second and must not hold the queue; the session
      // counts as occupying a slot from the synchronous start of `restart`.
      void session.restart();
    });
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#attachQueue.then(operation);
    this.#attachQueue = run.catch(() => undefined);
    return run;
  }

  #assertRunning(): void {
    if (this.#shutDown) throw new Error('the editor is shutting down');
  }

  async #attachNow(wallId: string, port: OmpClientPort): Promise<OmpSession> {
    this.#assertRunning();
    let session = this.#sessions.get(wallId);
    if (session === undefined) {
      await this.#ensureCapacity();
      this.#assertRunning();
      session = this.#createSession(wallId);
    } else if (!session.occupiesSlot && session.phase !== 'failed') {
      await this.#ensureCapacity();
      this.#assertRunning();
    }
    session.attach(port);
    return session;
  }

  #createSession(wallId: string): OmpSession {
    const session = new OmpSession({
      wallId,
      config: this.config,
      createTools: this.#options.createTools,
      ompVersion: () => this.ompVersion(),
      onDispose: (disposed, closed) => {
        if (this.#sessions.get(disposed.wallId) === disposed)
          this.#sessions.delete(disposed.wallId);
        this.#closing.add(disposed);
        const done = (): void => void this.#closing.delete(disposed);
        closed.then(done, done);
      },
      ...(this.#options.timings ? { timings: this.#options.timings } : {}),
      ...(this.#options.log ? { log: this.#options.log } : {}),
    });
    this.#sessions.set(wallId, session);
    return session;
  }

  /** Stop the least recently useful child that nobody is watching, or refuse. */
  async #ensureCapacity(): Promise<void> {
    const live = [...this.#sessions.values()].filter((session) => session.occupiesSlot);
    if (live.length + this.#closing.size < this.config.maxChildren) return;
    if (live.length < this.config.maxChildren) {
      await Promise.allSettled([...this.#closing].map((session) => session.closed));
      return;
    }
    const evictable = live.find((session) => session.clientCount === 0 && !session.busy);
    if (evictable === undefined) {
      throw new OmpCapacityError(
        `at most ${this.config.maxChildren} omp sessions can run at once; close another wall's agent first`,
      );
    }
    await evictable.stop('evicted');
  }

  /** Graceful: close every child's stdin and wait for exit. */
  async shutdown(): Promise<void> {
    this.#shutDown = true;
    await Promise.all(
      [...this.#sessions.values(), ...this.#closing].map((session) => session.stop('shutdown')),
    );
    this.removeExitHook();
  }

  /** Last-resort: children must not outlive the daemon, whatever path ends the process. */
  installExitHook(): void {
    if (this.#exitHook !== null) return;
    this.#exitHook = () => {
      for (const session of [...this.#sessions.values(), ...this.#closing]) session.killNow();
    };
    process.on('exit', this.#exitHook);
  }

  removeExitHook(): void {
    if (this.#exitHook !== null) process.off('exit', this.#exitHook);
    this.#exitHook = null;
  }
}
