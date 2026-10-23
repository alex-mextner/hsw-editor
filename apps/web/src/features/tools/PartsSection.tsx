import { Section } from '@/features/bank/DetailSections.tsx';
import { useI18n, type MessageKey } from '@/i18n/index.ts';
import type { ModelPart } from './ToolPreview3D.tsx';

const KNOWN_KINDS = ['metal', 'plastic', 'rubber', 'wood', 'paint', 'glass', 'paper', 'fabric'] as const;
/** Grips worth naming; a smooth handle needs no note. */
const GRIPS = ['knurl', 'ribbed', 'soft-grip', 'checkered', 'leather'] as const;

function isKnown<T extends string>(list: readonly T[], value: string): value is T {
  return list.some((entry) => entry === value);
}

interface PartsSectionProps {
  readonly parts: readonly ModelPart[];
  /** Set for the user's tools: the colour of a part can be changed. */
  readonly onColor?: ((part: string, color: string) => void) | undefined;
  readonly disabled?: boolean;
}

/** Materials and colours of the named parts of the model (handle, shaft, tip, ...). */
export function PartsSection({ parts, onColor, disabled = false }: PartsSectionProps) {
  const t = useI18n().t;
  return (
    <Section title={t('toolDetail.parts')}>
      {parts.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('toolDetail.parts.loading')}</p>
      ) : (
        <ul className="m-0 grid list-none gap-1.5 p-0" data-testid="tool-parts">
          {parts.map((part) => {
            const kind = isKnown(KNOWN_KINDS, part.kind)
              ? t(`toolDetail.material.${part.kind}` satisfies MessageKey)
              : part.kind;
            const grip =
              part.grip !== null && isKnown(GRIPS, part.grip)
                ? t(`toolDetail.grip.${part.grip}` satisfies MessageKey)
                : null;
            return (
              <li key={part.name} className="flex items-center gap-2 text-xs">
                {onColor ? (
                  <input
                    type="color"
                    value={part.color}
                    disabled={disabled}
                    aria-label={t('toolDetail.parts.color', { part: part.name })}
                    onChange={(event) => onColor(part.name, event.target.value)}
                    className="h-6 w-8 shrink-0 cursor-pointer rounded border border-input bg-transparent p-0"
                  />
                ) : (
                  <span
                    className="size-5 shrink-0 rounded border border-border"
                    style={{ background: part.color }}
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{part.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {kind}
                  {grip === null ? '' : `, ${grip}`}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{part.color}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
