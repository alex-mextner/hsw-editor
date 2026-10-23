import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { boardSizeMm, type Wall } from '@hsw-editor/core';
import { Button } from '@/components/ui/button.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { photoStore } from '@/state/photo.ts';
import { useStore } from '@/state/react.ts';
import { bankStore } from '@/bank/client.ts';
import type { PhotoView } from '@/scene/photoView.ts';
import { acceptAllGhosts, acceptGhost, ghostName } from './ghostActions.ts';
import { layoutLabels } from './ghostLabels.ts';
import {
  discardAllGhosts,
  discardGhost,
  ghostStore,
  splitByBoard,
  type ToolGhost,
} from './visionGhosts.ts';

function topCentre(ghost: ToolGhost): readonly [number, number] {
  let top = Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const [x, y] of ghost.polygonPx) {
    top = Math.min(top, y);
    left = Math.min(left, x);
    right = Math.max(right, x);
  }
  return [(left + right) / 2, top];
}

/** Recognition confidence from which a ghost is drawn green; below it amber. */
const CONFIDENT_AT = 0.6;
const CONFIDENT_COLOUR = '#22c55e';
const UNSURE_COLOUR = '#f59e0b';
/** The bar with the count and Add all / Discard all: room kept free at the top of the stage. */
const BAR_HALF_WIDTH = 190;
const BAR_HEIGHT = 44;
const CHIP_HEIGHT = 26;
const CHIP_GAP = 2;
/** The chip's text: the class and how sure the recogniser is, in whole percent. */
function chipText(name: string, confidence: number): string {
  return `${name} ${Math.round(confidence * 100)}%`;
}

/** Chip width: padding, the two buttons and about 6.5 px per character of "Name 63%". */
function chipWidth(text: string): number {
  return Math.min(190, 62 + text.length * 6.5);
}

/** Size of `element` (a callback-ref target: the overlay mounts only once ghosts exist). */
function useStageSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return undefined;
    const measure = (): void =>
      setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/**
 * The tools the vision service found in the photo, as proposals: the mask outline, the class and how sure the
 * recogniser is. Accepting puts the tool on the wall at the detected spot (hung on a compatible holder when one
 * exists); discarding drops the proposal. Nothing reaches the wall until the user accepts.
 */
export function PhotoGhosts({ wall, view }: { readonly wall: Wall; readonly view: PhotoView }) {
  const { t } = useI18n();
  const state = useStore(ghostStore);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const stage = useStageSize(root);
  const { calibrating } = useStore(photoStore);
  // Subscribe so class names follow the bank once it has loaded.
  useStore(bankStore);
  if (calibrating || state.photoId !== view.photo.id || state.ghosts.length === 0) return null;
  const size = boardSizeMm(wall.board);
  const { onBoard, offBoard } = splitByBoard(
    state.ghosts,
    (px) => view.map.pxToWall([px[0], px[1]]),
    { widthMm: size.width, heightMm: size.height },
  );
  const { width, height } = view.image;
  const stroke = width / 320;
  const labels = new Map(
    layoutLabels(
      onBoard.map((ghost) => {
        const [x, y] = topCentre(ghost);
        return {
          id: ghost.id,
          anchorX: (x / width) * stage.width,
          anchorY: (y / height) * stage.height,
          // 100 % is the widest the percentage gets, so the estimate never comes up short.
          width: chipWidth(chipText(ghostName(ghost), 1)),
        };
      }),
      {
        width: stage.width,
        height: stage.height,
        chipHeight: CHIP_HEIGHT,
        gap: CHIP_GAP,
        // The proposals bar: centred at the top.
        reserved: [
          {
            left: stage.width / 2 - BAR_HALF_WIDTH,
            right: stage.width / 2 + BAR_HALF_WIDTH,
            top: 0,
            bottom: BAR_HEIGHT,
          },
        ],
      },
    ).map((placement) => [placement.id, placement]),
  );
  return (
    <div ref={setRoot} data-photo-ghosts className="pointer-events-none absolute inset-0 z-20">
      <svg
        aria-hidden
        className="absolute inset-0 size-full"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        {onBoard.map((ghost) => {
          const colour = ghost.confidence >= CONFIDENT_AT ? CONFIDENT_COLOUR : UNSURE_COLOUR;
          return (
            <polygon
              key={ghost.id}
              points={ghost.polygonPx.map((p) => p.join(',')).join(' ')}
              fill={colour}
              fillOpacity={0.16}
              stroke={colour}
              strokeWidth={stroke}
              strokeDasharray={ghost.needsConfirmation ? `${stroke * 3} ${stroke * 2}` : undefined}
              strokeLinejoin="round"
            />
          );
        })}
      </svg>
      <div className="pointer-events-auto absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-lg border border-border bg-panel/95 px-2 py-1 text-xs shadow-sm backdrop-blur">
        <span>
          {t('photo.ghost.count', { count: onBoard.length })}
          {offBoard > 0 ? ` · ${t('photo.ghost.offBoard', { count: offBoard })}` : ''}
        </span>
        <Button
          size="xs"
          disabled={onBoard.length === 0}
          onClick={() => acceptAllGhosts(onBoard, view.map)}
        >
          {t('photo.ghost.acceptAll')}
        </Button>
        <Button size="xs" variant="ghost" onClick={discardAllGhosts}>
          {t('photo.ghost.discardAll')}
        </Button>
      </div>
      {onBoard.map((ghost) => {
        const placed = labels.get(ghost.id);
        if (!placed || stage.width === 0) return null;
        const name = ghostName(ghost);
        return (
          <div
            key={ghost.id}
            data-ghost={ghost.id}
            className="pointer-events-auto absolute flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-border bg-panel/95 py-0.5 pr-0.5 pl-1.5 text-[11px] shadow-sm"
            style={{ left: placed.x, top: placed.y, height: CHIP_HEIGHT }}
          >
            <span
              className={cn(
                'max-w-32 truncate font-medium',
                ghost.confidence < CONFIDENT_AT && 'text-warn',
              )}
              title={ghost.measured ? undefined : t('photo.ghost.presetSize')}
            >
              {chipText(name, ghost.confidence)}
            </span>
            <button
              type="button"
              aria-label={t('photo.ghost.accept', { name })}
              title={t('photo.ghost.accept', { name })}
              className="grid size-6 place-items-center rounded hover:bg-muted"
              onClick={() => acceptGhost(ghost, view.map)}
            >
              <Check className="size-3.5 text-ok" />
            </button>
            <button
              type="button"
              aria-label={t('photo.ghost.discard', { name })}
              title={t('photo.ghost.discard', { name })}
              className="grid size-6 place-items-center rounded hover:bg-muted"
              onClick={() => discardGhost(ghost.id)}
            >
              <X className="size-3.5 text-muted-foreground" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
