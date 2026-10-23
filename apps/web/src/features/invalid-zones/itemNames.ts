import type { BankElement } from '@hsw-editor/bank';
import type { Wall } from '@hsw-editor/core';
import type { Locale } from '@/i18n/index.ts';
import { itemTitle } from '@/features/inspector/Inspector.tsx';

/**
 * `id -> "Title #n"`: the title up to its first colon (bank names carry the parameter list after it, too long for a
 * sentence) and the item's position on the wall, so equal holders stay tellable apart.
 */
export function itemNamer(
  wall: Wall,
  bank: ReadonlyMap<string, BankElement>,
  locale: Locale,
): (id: string) => string {
  const names = new Map<string, string>();
  wall.items.forEach((item, index) => {
    const element = item.bankId === undefined ? undefined : bank.get(item.bankId);
    const title = itemTitle(item, element, locale);
    names.set(item.id, `${title.split(':')[0]?.trim() || title} #${index + 1}`);
  });
  return (id) => names.get(id) ?? id;
}
