/**
 * The tool import's way to the vision sidecar: the daemon's ONE managed client (`../vision/shared.ts`), so the
 * import starts the sidecar on demand like the `vision.*` jobs do (and it is stopped again when idle) instead of
 * insisting that somebody started it by hand.
 */
import {
  VisionRequestError,
  VisionUnavailableError,
  type VisionAvailability,
  type VisionTransport,
} from '@hsw-editor/tools/node';
import { z } from 'zod';
import type { ServiceRequest, VisionClient, VisionStatus } from '../vision/client.ts';
import { VisionError, type StreamEvent } from '../vision/types.ts';

/** Errors that mean "no sidecar can be reached or started" (the wizard shows the install/start steps), not "it said no". */
const UNAVAILABLE_CODES = new Set([
  'vision_not_installed',
  'vision_unreachable',
  'vision_start_failed',
  'vision_start_timeout',
]);

function translate(error: unknown): unknown {
  if (!(error instanceof VisionError)) return error;
  if (UNAVAILABLE_CODES.has(error.code)) {
    return new VisionUnavailableError(error.message, error.fix);
  }
  return new VisionRequestError(
    error.code,
    error.fix === undefined ? error.message : `${error.message} (${error.fix})`,
  );
}

export class ManagedVisionTransport implements VisionTransport {
  constructor(private readonly client: VisionClient) {}

  async status(): Promise<VisionAvailability> {
    let state: VisionStatus;
    try {
      state = await this.client.status();
    } catch (error) {
      // e.g. an unreadable state file: the wizard shows its "not available" state with this message
      return {
        available: false,
        message: `the vision service state cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (state.running)
      return { available: true, ...(state.endpoint ? { url: state.endpoint } : {}) };
    if (state.startable) return { available: true };
    if (state.endpoint) {
      // an external sidecar (HSW_VISION_URL) that does not answer is never started by us
      return {
        available: false,
        url: state.endpoint,
        message: `the vision service at ${state.endpoint} does not answer: restart it (python -m hsw_vision serve), or stop it so hsw-editor can start its own (hsw-editor vision setup installs it)`,
      };
    }
    return {
      available: false,
      message:
        'the vision service is not installed: run `hsw-editor vision setup` (then it starts on demand)',
    };
  }

  async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.client.post(path, asRequest(body), signal);
    } catch (error) {
      throw translate(error);
    }
  }

  async postStream(
    path: string,
    body: unknown,
    onEvent: ((event: StreamEvent) => void) | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.client.postStream(
        path,
        asRequest(body),
        (event) => onEvent?.(event),
        signal,
      );
    } catch (error) {
      throw translate(error);
    }
  }
}

const RequestBody = z.record(z.string(), z.json());

/**
 * The port builds plain JSON objects whose optional fields may be `undefined` (which `JSON.stringify` drops on the
 * wire); the round trip drops them here too, and the parse proves the rest is JSON without a cast.
 */
function asRequest(body: unknown): ServiceRequest {
  return RequestBody.parse(JSON.parse(JSON.stringify(body)));
}
