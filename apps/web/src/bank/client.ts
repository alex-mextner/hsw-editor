import { createValueStore } from '#state-backend';
import type { BankElement, BankIndex, VariantResponse } from '@hsw-editor/bank';

/** Route table of the bank API (see docs/api.md); the only place that knows the URLs. */
export const bankRoutes = {
  index: '/api/bank/index',
  asset: (path: string): string => `/bank/assets/${path}`,
  variant: (id: string): string => `/api/bank/elements/${encodeURIComponent(id)}/variant`,
} as const;

export type BankState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly index: BankIndex;
      readonly byId: ReadonlyMap<string, BankElement>;
    };

export const bankStore = createValueStore<BankState>({ status: 'loading' });

let inflight: Promise<void> | null = null;

/** Loads the bank index once; the service worker serves it offline after the first visit. */
export function loadBank(): Promise<void> {
  inflight ??= (async () => {
    try {
      const response = await fetch(bankRoutes.index);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const index = (await response.json()) as BankIndex;
      bankStore.set({
        status: 'ready',
        index,
        byId: new Map(index.elements.map((element) => [element.id, element])),
      });
    } catch (error) {
      inflight = null;
      bankStore.set({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return inflight;
}

export async function requestVariant(
  elementId: string,
  params: Readonly<Record<string, number>>,
  signal?: AbortSignal,
): Promise<VariantResponse> {
  const response = await fetch(bankRoutes.variant(elementId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as VariantResponse;
}
