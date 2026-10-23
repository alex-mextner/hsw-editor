import { useCallback, useState } from 'react';
import type { Draft, DraftObjectPatch } from '@hsw-editor/tools/contract';
import {
  groupDraftObjects,
  mergeDraftObjects,
  patchDraftObject,
  splitDraftObject,
} from '../api.ts';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DraftEdits {
  readonly busy: boolean;
  readonly error: string | null;
  readonly patch: (key: string, patch: DraftObjectPatch) => Promise<void>;
  readonly merge: (keys: readonly string[]) => Promise<void>;
  readonly group: (keys: readonly string[]) => Promise<void>;
  readonly split: (key: string, parts: number) => Promise<void>;
  /** Accepts every listed object, one request after the other (each answer is the draft the next builds on). */
  readonly acceptAll: (keys: readonly string[]) => Promise<void>;
}

/**
 * The review actions on a draft. Every one asks the server (which refits the object) and hands the answer back
 * through `onDraft`; only one runs at a time, so the buttons stay disabled while the fit is computed.
 */
export function useDraftEdits(draft: Draft, onDraft: (draft: Draft) => void): DraftEdits {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (action: () => Promise<Draft>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        onDraft(await action());
      } catch (failure) {
        setError(messageOf(failure));
      } finally {
        setBusy(false);
      }
    },
    [onDraft],
  );
  return {
    busy,
    error,
    patch: (key, patch) => run(() => patchDraftObject(draft.id, key, patch)),
    merge: (keys) => run(() => mergeDraftObjects(draft.id, keys)),
    group: (keys) => run(() => groupDraftObjects(draft.id, keys)),
    split: (key, parts) => run(() => splitDraftObject(draft.id, key, parts)),
    acceptAll: (keys) =>
      run(async () => {
        let latest = draft;
        for (const key of keys) latest = await patchDraftObject(draft.id, key, { status: 'accepted' });
        return latest;
      }),
  };
}
