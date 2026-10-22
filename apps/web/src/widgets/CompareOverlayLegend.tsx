import { EyeIcon, EyeOffIcon } from 'lucide-react';
import type { ModelRef } from '@hsw-editor/core';
import { IconButton } from '@/components/IconButton.tsx';
import { Slider } from '@/components/ui/slider.tsx';
import { useT } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';

export interface OverlayStyle {
  readonly visible: boolean;
  readonly opacity: number;
}

export const DEFAULT_OVERLAY_STYLE: OverlayStyle = { visible: true, opacity: 0.55 };

interface CompareOverlayLegendProps {
  readonly candidates: readonly ModelRef[];
  readonly colors: ReadonlyMap<string, string>;
  readonly styles: ReadonlyMap<string, OverlayStyle>;
  readonly onChange: (id: string, style: OverlayStyle) => void;
}

/** Per-candidate colour key with a visibility toggle and an opacity slider for the overlay view. */
export function CompareOverlayLegend({
  candidates,
  colors,
  styles,
  onChange,
}: CompareOverlayLegendProps) {
  const t = useT();
  return (
    <ul className="grid gap-1.5 sm:grid-cols-2">
      {candidates.map((model) => {
        const style = styles.get(model.id) ?? DEFAULT_OVERLAY_STYLE;
        return (
          <li
            key={model.id}
            className={cn(
              'flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1',
              !style.visible && 'opacity-60',
            )}
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: colors.get(model.id) }}
            />
            <span className="min-w-0 flex-1 truncate text-xs" title={model.label}>
              {model.label}
            </span>
            <Slider
              className="w-20 shrink-0"
              min={0.1}
              max={1}
              step={0.05}
              value={[style.opacity]}
              aria-label={t('compare.overlay.opacity', { name: model.label })}
              onValueChange={(value) => {
                const next = typeof value === 'number' ? value : value[0];
                if (next !== undefined) onChange(model.id, { ...style, opacity: next });
              }}
            />
            <IconButton
              label={t(style.visible ? 'compare.overlay.hide' : 'compare.overlay.show', {
                name: model.label,
              })}
              pressed={style.visible}
              size="icon-xs"
              onClick={() => onChange(model.id, { ...style, visible: !style.visible })}
            >
              {style.visible ? <EyeIcon /> : <EyeOffIcon />}
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}
