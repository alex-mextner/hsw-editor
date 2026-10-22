import type { DrawBackendId, DrawMime } from './contract.ts';
import type { DrawView } from './prompts.ts';
import type { QualityReport } from './quality.ts';

/** One generated view, with the evidence needed to trust (or ignore) it later. Always `source: 'generated'`. */
export interface DrawCandidate {
  readonly source: 'generated';
  readonly view: DrawView;
  readonly backend: DrawBackendId;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly mime: DrawMime;
  /** Absolute path of the saved file in the draw work dir. */
  readonly path: string;
  readonly promptTemplateVersion: number;
  readonly prompt: string;
  readonly quality: QualityReport;
  /** quality.ok; rejected candidates are kept for inspection but never attached to a wall. */
  readonly accepted: boolean;
}

export type DrawViewsOutcome =
  | { readonly status: 'done'; readonly candidates: readonly DrawCandidate[] }
  | {
      /** manual backend: waiting for the user to upload an image for `view`. */
      readonly status: 'manual_pending';
      readonly candidates: readonly DrawCandidate[];
      readonly view: DrawView;
      readonly manualJobId: string;
      readonly prompt: string;
      readonly refPaths: readonly string[];
    }
  | {
      readonly status: 'failed';
      readonly candidates: readonly DrawCandidate[];
      readonly view: DrawView;
      readonly code: string;
      readonly message: string;
      readonly retryAfterMs?: number;
    };
