/** Transport port of the settings client plus the HTTP implementation for the daemon's `/api/settings`. */
import { z } from 'zod';
import {
  parseSettingsDocument,
  type SettingsDocument,
  type SettingsPutBody,
  SettingsContractError,
} from './contract.ts';

export type PutResult =
  | { kind: 'ok'; document: SettingsDocument }
  /** `baseRev` was stale: `document` is the server's current state. */
  | { kind: 'conflict'; document: SettingsDocument };

/** The server answered and will never accept this body (400/413): retrying is pointless. */
export class SettingsRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SettingsRejectedError';
  }
}

/**
 * `get`/`put` may reject for any reason that means "try later" (offline, 5xx, timeout): the client keeps its pending
 * edits. Throw `SettingsRejectedError` for permanent refusals.
 */
export interface SettingsTransport {
  get(): Promise<SettingsDocument>;
  put(body: SettingsPutBody): Promise<PutResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpTransportOptions {
  /** Prefix of the API, `''` (same origin) by default. */
  baseUrl?: string;
  fetch?: FetchLike;
}

const ErrorEnvelopeSchema = z.looseObject({
  error: z.looseObject({ code: z.string().optional(), message: z.string().optional() }).optional(),
  settings: z.unknown().optional(),
});
type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

async function readEnvelope(response: Response): Promise<ErrorEnvelope> {
  try {
    const parsed = ErrorEnvelopeSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function createHttpTransport(options: HttpTransportOptions = {}): SettingsTransport {
  const baseUrl = options.baseUrl ?? '';
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const url = `${baseUrl}/api/settings`;

  async function parse(raw: unknown): Promise<SettingsDocument> {
    try {
      return parseSettingsDocument(raw);
    } catch (error) {
      if (error instanceof SettingsContractError)
        throw new Error(`unusable settings document: ${error.message}`);
      throw error;
    }
  }

  return {
    async get() {
      const response = await doFetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`GET /api/settings -> ${response.status}`);
      return parse(await response.json());
    },
    async put(body) {
      const response = await doFetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.ok) return { kind: 'ok', document: await parse(await response.json()) };
      const envelope = await readEnvelope(response);
      if (
        response.status === 409 &&
        envelope.error?.code === 'rev_conflict' &&
        envelope.settings !== undefined
      ) {
        return { kind: 'conflict', document: await parse(envelope.settings) };
      }
      if (response.status === 400 || response.status === 413) {
        throw new SettingsRejectedError(
          response.status,
          envelope.error?.code ?? 'rejected',
          envelope.error?.message ?? `PUT /api/settings -> ${response.status}`,
        );
      }
      throw new Error(`PUT /api/settings -> ${response.status}`);
    },
  };
}
