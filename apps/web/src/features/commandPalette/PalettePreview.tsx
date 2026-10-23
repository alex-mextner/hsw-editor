import { labelText, type RankedItem } from '@hsw-editor/commands';
import { settingsStore } from '@/commands/app.ts';
import { Kbd } from '@/components/Kbd.tsx';
import { useI18n } from '@/i18n/index.ts';
import { settingIdOf } from './PaletteRow.tsx';

/** Detail of the highlighted row; the surrounding layout hides it below the `sm` breakpoint. */
export function PalettePreview({ row }: { readonly row: RankedItem | undefined }) {
  const { t, locale } = useI18n();
  if (row === undefined) {
    return <p className="p-4 text-xs text-muted-foreground">{t('palette.preview.empty')}</p>;
  }
  const { item } = row;
  const title = labelText(item.title, locale);
  const settingId = settingIdOf(item.id);
  const definition = settingId === null ? undefined : settingsStore.definition(settingId);
  const preview = item.preview;

  return (
    <div className="flex flex-col gap-3 p-4 text-sm">
      {preview?.kind === 'thumbnail' ? (
        // Keyed by source so a new element never shows the previous one's load state.
        <div
          key={preview.src}
          className="aspect-square w-full overflow-hidden rounded-lg border border-border"
        >
          <img
            src={preview.src}
            alt={labelText(preview.alt, locale)}
            loading="lazy"
            className="size-full object-contain"
            onError={(event) => {
              // The index can outlive its files: show the empty frame instead of a broken image icon.
              event.currentTarget.style.visibility = 'hidden';
            }}
          />
        </div>
      ) : null}
      <h3 className="font-semibold break-words">{title}</h3>
      {preview?.kind === 'text' ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {labelText(preview.body, locale)}
        </p>
      ) : null}
      {definition === undefined ? (
        item.subtitle !== undefined && preview?.kind !== 'text' ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {labelText(item.subtitle, locale)}
          </p>
        ) : null
      ) : (
        <dl className="grid gap-1.5 text-xs">
          {definition.description === undefined ? null : (
            <dd className="text-muted-foreground">{labelText(definition.description, locale)}</dd>
          )}
          <dt className="font-medium">{t('palette.preview.current')}</dt>
          <dd className="text-muted-foreground">
            {item.subtitle === undefined ? '' : labelText(item.subtitle, locale)}
          </dd>
        </dl>
      )}
      {item.kind === 'command' || item.kind === 'recent' ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('palette.preview.keybinding')}:</span>
          {item.keybinding === undefined ? (
            <span>{t('palette.preview.noKeybinding')}</span>
          ) : (
            <Kbd className="ml-0">{item.keybinding}</Kbd>
          )}
        </div>
      ) : null}
      {item.group === undefined ? null : (
        <p className="text-[11px] tracking-wide text-muted-foreground uppercase">
          {t('palette.preview.group')}: {labelText(item.group, locale)}
        </p>
      )}
    </div>
  );
}
