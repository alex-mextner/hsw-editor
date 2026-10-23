import { TriangleAlert } from 'lucide-react';
import type { Wall } from '@hsw-editor/core';
import { bankStore } from '@/bank/client.ts';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { describeReason } from '@/scene/invalid-zones/reasons.ts';
import { invalidZonesEnabledStore, invalidZonesResultStore } from '@/scene/invalid-zones/store.ts';
import { itemNamer } from './itemNames.ts';

/** Inspector section: why the selected item has invalid parts ("Overlaps Holder #3 by 4.2 mm"). */
export function InvalidReasons({ wall, itemId }: { readonly wall: Wall; readonly itemId: string }) {
  const { t, locale } = useI18n();
  const enabled = useStore(invalidZonesEnabledStore);
  const result = useStore(invalidZonesResultStore);
  const bank = useStore(bankStore);
  const own = enabled ? (result?.reasons.filter((reason) => reason.itemId === itemId) ?? []) : [];
  if (own.length === 0) return null;
  const nameOf = itemNamer(wall, bank.status === 'ready' ? bank.byId : new Map(), locale);
  return (
    <section className="grid gap-1.5 rounded-lg border border-red-500/50 bg-red-500/10 p-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400">
        <TriangleAlert className="size-3.5" aria-hidden />
        {t('invalid.inspector.title')}
      </h3>
      <ul className="grid gap-1 text-xs" data-testid="invalid-reasons">
        {own.map((reason) => {
          const message = describeReason(reason, nameOf);
          return (
            <li key={`${reason.kind}:${reason.kind === 'overlap' ? reason.otherId : reason.side}`}>
              {t(message.key, message.params)}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
