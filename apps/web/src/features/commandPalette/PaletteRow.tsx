import {
  labelText,
  type PaletteKind,
  type RankedItem,
  type SettingValue,
} from '@hsw-editor/commands';
import {
  BookOpen,
  Box,
  CornerDownRight,
  History,
  LayoutGrid,
  Package,
  Settings2,
  Sparkles,
  Terminal,
  Undo2,
  Wrench,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { Kbd } from '@/components/Kbd.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { HighlightedText } from './HighlightedText.tsx';
import { SettingControl } from './SettingControl.tsx';

const KIND_ICONS: Readonly<Record<PaletteKind, ComponentType<{ className?: string }>>> = {
  recent: History,
  command: Terminal,
  setting: Settings2,
  wall: LayoutGrid,
  item: Box,
  bank: Package,
  tool: Wrench,
  history: Undo2,
  doc: BookOpen,
  goto: CornerDownRight,
  ai: Sparkles,
};

/** `setting:appearance.theme` -> `appearance.theme`. */
export function settingIdOf(itemId: string): string | null {
  return itemId.startsWith('setting:') ? itemId.slice('setting:'.length) : null;
}

interface PaletteRowProps {
  readonly domId: string;
  readonly row: RankedItem;
  readonly active: boolean;
  readonly onHover: () => void;
  readonly onRun: () => void;
  readonly onSetting: (settingId: string, value: SettingValue) => void;
}

export function PaletteRow({ domId, row, active, onHover, onRun, onSetting }: PaletteRowProps) {
  const { locale } = useI18n();
  const { item } = row;
  const Icon = KIND_ICONS[item.kind];
  const title = labelText(item.title, locale);
  const settingId = settingIdOf(item.id);
  return (
    // The row is a pointer target; keyboard users drive it from the search field (aria-activedescendant).
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/prefer-tag-over-role
    <div
      id={domId}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="option"
      aria-selected={active}
      tabIndex={-1}
      className={cn(
        'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm sm:min-h-9',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
      )}
      onMouseMove={onHover}
      onClick={onRun}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          <HighlightedText text={title} positions={row.positions} />
        </span>
        {item.subtitle === undefined ? null : (
          <span className="block truncate text-xs text-muted-foreground">
            {labelText(item.subtitle, locale)}
          </span>
        )}
      </span>
      {item.control !== undefined && settingId !== null ? (
        // Clicks on the control must not run the row.
        <span
          className="shrink-0"
          role="presentation"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <SettingControl
            control={item.control}
            label={title}
            tabbable={active}
            onChange={(value) => onSetting(settingId, value)}
          />
        </span>
      ) : item.keybinding === undefined ? null : (
        <Kbd className="ml-0 shrink-0">{item.keybinding}</Kbd>
      )}
    </div>
  );
}
