import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversion, ConvertSettings } from '@hsw-editor/bank';
import { previewUpload } from '@/bank/userClient.ts';
import { userErrorMessage, type UserErrorMessage } from './userErrors.ts';

/** Wait after the last settings change before running the mesh tool (it takes 1-5 s). */
export const PREVIEW_DEBOUNCE_MS = 400;

export interface ConversionPreview {
  /** The last successful conversion; kept while a newer one is being computed or failed. */
  readonly conversion: Conversion | null;
  readonly busy: boolean;
  readonly error: UserErrorMessage | null;
  readonly retry: () => void;
}

/** Outcome of the request made for `requestKey`; anything else means a request is still pending. */
interface Settled {
  readonly requestKey: string;
  readonly error: UserErrorMessage | null;
}

/**
 * Converts the upload with the chosen settings whenever they change. Latest wins: a change aborts the request in
 * flight, and only the last settings are ever applied. Paused (no requests) while `paused`, e.g. offline.
 * `busy` is derived (the settled request is not the current one), so no state is set synchronously in the effect.
 */
export function useConversionPreview(
  uploadId: string | null,
  settings: ConvertSettings,
  paused: boolean,
): ConversionPreview {
  const [conversion, setConversion] = useState<Conversion | null>(null);
  const [settled, setSettled] = useState<Settled | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(settings);
  const hasResult = useRef(false);
  useEffect(() => {
    latest.current = settings;
  });

  const key = JSON.stringify(settings);
  const requestKey = `${uploadId ?? ''}|${attempt}|${key}`;
  useEffect(() => {
    if (uploadId === null || paused) return;
    const controller = new AbortController();
    // The first conversion of an upload starts at once; later ones wait for the user to stop fiddling.
    const timer = setTimeout(
      () => {
        previewUpload(uploadId, latest.current, controller.signal)
          .then((next) => {
            if (controller.signal.aborted) return;
            hasResult.current = true;
            setConversion(next);
            setSettled({ requestKey, error: null });
          })
          .catch((failure: unknown) => {
            if (controller.signal.aborted) return;
            setSettled({ requestKey, error: userErrorMessage(failure) });
          });
      },
      hasResult.current ? PREVIEW_DEBOUNCE_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [uploadId, requestKey, paused]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const busy = uploadId !== null && !paused && settled?.requestKey !== requestKey;
  return {
    conversion,
    busy,
    // An error belongs to the request that failed; a newer request clears it by being pending.
    error: settled !== null && settled.requestKey === requestKey ? settled.error : null,
    retry,
  };
}
