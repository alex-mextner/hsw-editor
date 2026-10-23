import { layoutStore } from '@/state/layout.ts';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeftIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import type { BankElement, BankIndex } from '@hsw-editor/bank';
import { IconButton } from '@/components/IconButton.tsx';
import { isTypingTarget } from '@/commands/registry.ts';
import { Button } from '@/components/ui/button.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';
import { categoryPathNames, formatNumber } from './detailModel.ts';
import {
  Fact,
  Facts,
  FitsSection,
  LicenseSection,
  ParamsSection,
  PrintNotesSection,
  ProvenanceSection,
  Section,
} from './DetailSections.tsx';
import { MOUNTING_LABELS } from './labels.ts';
import { PreviewBoundary } from './PreviewBoundary.tsx';
import { PreviewCanvas } from './PreviewCanvas.tsx';
import {
  claimPreviewSlot,
  detailSlotKey,
  previewSlotStore,
  releasePreviewSlot,
} from './previewSlot.ts';
import { Thumbnail } from './Thumbnail.tsx';

/** Large orbitable preview; the thumbnail underneath is the loading and error state. */
function DetailPreview({ element }: { readonly element: BankElement }) {
  const t = useI18n().t;
  const slot = useStore(previewSlotStore);
  const key = detailSlotKey(element.id);
  const [ready, setReady] = useState(false);
  const markReady = useCallback(() => setReady(true), []);
  useEffect(() => {
    claimPreviewSlot(key);
    return () => releasePreviewSlot(key);
  }, [key]);
  return (
    <div className="relative aspect-4/3 w-full shrink-0 bg-viewport">
      <div className="absolute inset-0 p-4">
        <Thumbnail element={element} className="bg-transparent" />
      </div>
      {slot === key ? (
        <div
          className={cn(
            'absolute inset-0 bg-viewport transition-opacity duration-200',
            ready ? 'opacity-100' : 'opacity-0',
          )}
        >
          <PreviewBoundary fallback={null}>
            <PreviewCanvas element={element} mode="orbit" onLoaded={markReady} />
          </PreviewBoundary>
        </div>
      ) : null}
      <p className="pointer-events-none absolute inset-x-0 bottom-1.5 text-center text-[10px] text-muted-foreground">
        {t('bank.detail.previewHint')}
      </p>
    </div>
  );
}

interface BankDetailProps {
  readonly element: BankElement;
  readonly index: BankIndex;
  readonly onBack: () => void;
  readonly onAdd: (element: BankElement) => void;
  /** Edit / delete are offered for the user's own elements only. */
  readonly onEdit: (element: BankElement) => void;
  readonly onDelete: (element: BankElement) => void;
}

/** Full description of one element, replacing the grid inside the panel. */
export function BankDetail({ element, index, onBack, onAdd, onEdit, onDelete }: BankDetailProps) {
  const { t, tn, locale } = useI18n();
  // Window-level, because the grid card that had focus is gone and focus falls back to <body>.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || isTypingTarget(event.target)) return;
      // An open dialog (compare, calibration) owns Escape.
      if (document.querySelector('[role="dialog"]')) return;
      // A closed (hidden) panel must not swallow Escape from the viewport.
      if (!layoutStore.get().leftOpen) return;
      // Capture phase: going back wins over the global deselect shortcut.
      event.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onBack]);

  const { dimsMm, footprint } = element;
  const description = element.description?.[locale];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <IconButton label={t('bank.detail.back')} shortcut="Esc" onClick={onBack}>
          <ArrowLeftIcon aria-hidden />
        </IconButton>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="truncate text-sm font-semibold">{element.name[locale]}</h2>
            {element.source === 'user' ? (
              <span
                data-testid="bank-detail-mine-badge"
                title={t('bank.mineTitle')}
                className="inline-flex h-4 shrink-0 items-center rounded bg-primary/15 px-1 text-[10px] leading-none text-primary"
              >
                {t('bank.mine')}
              </span>
            ) : null}
          </div>
          {element.variantLabel ? (
            <p className="truncate text-[11px] text-muted-foreground">
              {element.variantLabel[locale]}
            </p>
          ) : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <DetailPreview key={element.id} element={element} />
        <div className="flex flex-col gap-4 p-3">
          {description ? <p className="text-xs leading-5">{description}</p> : null}
          <Section title={t('bank.detail.dims')}>
            <Facts>
              <Fact label={t('bank.detail.category')}>
                {categoryPathNames(index.categories, element.category, locale).join(' › ')}
              </Fact>
              <Fact label={t('bank.detail.dims')}>
                <span className="tabular-nums">
                  {t('bank.detail.dimsValue', {
                    x: formatNumber(dimsMm.x, locale),
                    y: formatNumber(dimsMm.y, locale),
                    z: formatNumber(dimsMm.z, locale),
                  })}
                </span>
              </Fact>
              <Fact label={t('bank.detail.footprint')}>
                {t('bank.detail.footprintValue', {
                  cols: footprint.cols,
                  rows: footprint.rows,
                  cells: tn('bank.cells', footprint.cells.length),
                })}
              </Fact>
              <Fact label={t('bank.detail.mounting')}>
                {t(MOUNTING_LABELS[element.mounting.kind])}
              </Fact>
            </Facts>
          </Section>
          <FitsSection element={element} index={index} />
          <ParamsSection element={element} />
          <LicenseSection element={element} />
          <ProvenanceSection element={element} />
          <PrintNotesSection element={element} />
        </div>
      </div>
      <footer className="flex flex-col gap-2 border-t border-border bg-panel p-2">
        {element.source === 'user' ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              data-testid="bank-detail-edit"
              onClick={() => onEdit(element)}
            >
              <PencilIcon aria-hidden />
              {t('bank.detail.edit')}
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              data-testid="bank-detail-delete"
              onClick={() => onDelete(element)}
            >
              <Trash2Icon aria-hidden />
              {t('bank.detail.delete')}
            </Button>
          </div>
        ) : null}
        <Button className="w-full" onClick={() => onAdd(element)}>
          <PlusIcon aria-hidden />
          {t('bank.detail.add')}
        </Button>
      </footer>
    </div>
  );
}
