import {
  sendClientError,
  type ClientErrorDetail,
  type ClientErrorEntry,
  type ClientErrorInput,
} from '@/api/clientErrors.ts';
import type { Translate } from '@/i18n/index.ts';
import { getFailure, type AssetFailure } from './assetHealth.ts';
import { bankStore, unavailableElements, type BankState } from './client.ts';

/**
 * The "Report" action: sends a `user-report` entry to the client error log and copies the same
 * diagnostics to the clipboard (so it can be pasted into a chat or ticket even if the daemon is down).
 */

export interface ReportOutcome {
  /** The daemon accepted the entry. */
  readonly sent: boolean;
  /** The diagnostics reached the clipboard. */
  readonly copied: boolean;
}

/** Toast text confirming (or admitting the failure of) a report. */
export function reportOutcomeText(outcome: ReportOutcome, tr: Translate): string {
  if (outcome.sent) return tr(outcome.copied ? 'asset.report.sentCopied' : 'asset.report.sent');
  return tr(outcome.copied ? 'asset.report.copiedOnly' : 'asset.report.failed');
}

export interface ReportDeps {
  readonly send: (input: ClientErrorInput) => Promise<ClientErrorEntry | null>;
  readonly copy: (text: string) => Promise<boolean>;
  /** Index hash the server reports in its asset 404 body, when it can be asked. */
  readonly serverIndexHash: (assetUrl: string) => Promise<string | undefined>;
}

function clientIndexHash(bank: BankState): string | undefined {
  return bank.status === 'ready' ? bank.index.contentHash : undefined;
}

function withDefined(
  entries: Readonly<Record<string, string | number | boolean | undefined>>,
): ClientErrorDetail {
  const detail: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) detail[key] = value;
  return detail;
}

/** Report for a failed asset URL. */
export function assetReportInput(
  failure: AssetFailure,
  bank: BankState,
  serverIndexHash: string | undefined,
): ClientErrorInput {
  return {
    kind: 'user-report',
    message: `Asset failed to load: ${failure.message}`,
    url: failure.url,
    ...(failure.bankId === undefined ? {} : { bankId: failure.bankId }),
    ...(failure.status === undefined ? {} : { status: failure.status }),
    detail: withDefined({
      loadErrorKind: failure.kind,
      attempts: failure.attempts,
      state: failure.state,
      gone: failure.gone?.kind,
      goneDetail: failure.gone?.kind === 'unavailable' ? failure.gone.detail : undefined,
      elementName: failure.elementName,
      clientIndexHash: clientIndexHash(bank),
      serverIndexHash,
    }),
  };
}

/** Report for a wall item whose element is not in the bank index at all. */
export function missingElementReportInput(bankId: string, bank: BankState): ClientErrorInput {
  const listed = bank.status === 'ready' ? unavailableElements(bank.index) : [];
  const unavailable = listed.find((entry) => entry.id === bankId);
  return {
    kind: 'user-report',
    message: `Wall item references an element that is not in the bank: ${bankId}`,
    bankId,
    detail: withDefined({
      loadErrorKind: 'bank-missing',
      unavailableReason: unavailable?.reason,
      clientIndexHash: clientIndexHash(bank),
      bankStatus: bank.status,
    }),
  };
}

async function submitReport(input: ClientErrorInput, deps: ReportDeps): Promise<ReportOutcome> {
  const entry = await deps.send(input);
  // The clipboard copy happens either way: it is the fallback when the daemon cannot take the report.
  const copied = await deps.copy(JSON.stringify(entry ?? input, null, 2));
  return { sent: entry !== null, copied };
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The 404 body of `/bank/assets/*` names the index the server currently serves; any other answer yields nothing. */
async function probeServerIndexHash(assetUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(assetUrl, { cache: 'no-store' });
    if (response.ok) {
      void response.body?.cancel();
      return undefined;
    }
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'indexHash' in body) {
      return typeof body.indexHash === 'string' ? body.indexHash : undefined;
    }
  } catch {
    // Offline or not JSON: the report simply goes without a server hash.
  }
  return undefined;
}

export const liveReportDeps: ReportDeps = {
  send: sendClientError,
  copy: copyToClipboard,
  serverIndexHash: probeServerIndexHash,
};

/** Reports the failure recorded for `url`; `null` when there is no such failure. */
export async function reportAsset(
  url: string,
  deps: ReportDeps = liveReportDeps,
): Promise<ReportOutcome | null> {
  const failure = getFailure(url);
  if (!failure) return null;
  const serverHash = await deps.serverIndexHash(url);
  return submitReport(assetReportInput(failure, bankStore.get(), serverHash), deps);
}

export function reportMissingElement(
  bankId: string,
  deps: ReportDeps = liveReportDeps,
): Promise<ReportOutcome> {
  return submitReport(missingElementReportInput(bankId, bankStore.get()), deps);
}
