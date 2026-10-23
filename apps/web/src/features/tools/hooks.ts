import { useEffect, useState } from 'react';
import { fetchClassHolding, fetchToolHolding, type HoldingResponse, type ParamValues } from './api.ts';

/** `value` after it stopped changing for `ms` (values are compared by identity, so memoise objects). */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly value: T };

/** Holding interface of a class with the given parameter values; `values` must keep its identity until it changes. */
export function useClassHolding(classId: string, values: ParamValues): Loadable<HoldingResponse> {
  const [answer, setAnswer] = useState<{
    readonly values: ParamValues;
    readonly result: Loadable<HoldingResponse>;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchClassHolding(classId, values, controller.signal).then(
      (value) => setAnswer({ values, result: { status: 'ready', value } }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setAnswer({ values, result: { status: 'error', message } });
      },
    );
    return () => controller.abort();
  }, [classId, values]);
  // An answer for other values is not an answer: it would describe the model before the last change.
  return answer !== null && answer.values === values ? answer.result : { status: 'loading' };
}

/** Holding interface of a user tool; `version` (its `updatedAt`) refetches after an edit. */
export function useToolHolding(toolId: string, version: string): Loadable<HoldingResponse> {
  const [state, setState] = useState<Loadable<HoldingResponse>>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    fetchToolHolding(toolId, controller.signal).then(
      (value) => setState({ status: 'ready', value }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
  }, [toolId, version]);
  return state;
}
