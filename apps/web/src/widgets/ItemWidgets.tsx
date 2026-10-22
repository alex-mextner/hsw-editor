import type { WallItem } from '@hsw-editor/core';
import { bankStore } from '@/bank/client.ts';
import { Separator } from '@/components/ui/separator.tsx';
import { useStore } from '@/state/react.ts';
import { DimensionWidget } from './DimensionWidget.tsx';
import { VariantPicker } from './VariantPicker.tsx';

/**
 * Widget sections the inspector shows for one selected item: its dimensions (items with a bank
 * element) and the variant picker (holders, board parts and tools).
 */
export function ItemWidgets({ item }: { readonly item: WallItem }) {
  const bank = useStore(bankStore);
  if (item.kind === 'photo-ref') return null;
  const element =
    bank.status === 'ready' && item.bankId !== undefined ? bank.byId.get(item.bankId) : undefined;

  return (
    <div className="grid gap-3" data-slot="item-widgets">
      {element || item.kind === 'tool' ? (
        <>
          <DimensionWidget item={item} element={element} />
          <Separator />
        </>
      ) : null}
      <VariantPicker item={item} />
    </div>
  );
}
