import { useState } from 'react';
import type { BankElement } from '@hsw-editor/bank';
import { bankRoutes, bankStore } from '@/bank/client.ts';
import { useT } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';
import { DEFAULT_GRID, glyphModel, type HexGrid } from './glyph.ts';

/** Anything that may or may not carry a thumbnail path (older or partial index entries). */
interface MaybeThumbnail {
  readonly assets?: { readonly thumbnail?: { readonly path?: string } };
}

export function thumbnailPath(element: MaybeThumbnail): string | undefined {
  const path = element.assets?.thumbnail?.path;
  return path === undefined || path === '' ? undefined : path;
}

/** Deterministic picture of an element drawn from its footprint cells; used whenever the real image is missing. */
export function ElementGlyph({
  element,
  grid = DEFAULT_GRID,
  className,
}: {
  readonly element: BankElement;
  readonly grid?: HexGrid;
  readonly className?: string;
}) {
  const glyph = glyphModel(element, grid);
  const stroke = `hsl(${glyph.hue} 55% 45%)`;
  return (
    <svg
      viewBox={`0 0 ${glyph.size} ${glyph.size}`}
      aria-hidden
      focusable="false"
      className={cn('size-full', className)}
    >
      <rect
        x={glyph.bbox.x}
        y={glyph.bbox.y}
        width={glyph.bbox.width}
        height={glyph.bbox.height}
        rx={2}
        fill="none"
        stroke={stroke}
        strokeWidth={1}
        strokeDasharray="3 2"
        opacity={0.7}
      />
      {glyph.hexes.map((points, index) => (
        <polygon
          key={index}
          points={points}
          fill={`hsl(${glyph.hue} 60% 55% / 0.4)`}
          stroke={stroke}
          strokeWidth={0.8}
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

interface ThumbnailProps {
  readonly element: BankElement;
  readonly className?: string;
}

/**
 * Lazy thumbnail with a skeleton while loading. An element without a thumbnail, or one whose image
 * fails to load (the index can outlive its files), shows a generated footprint outline instead of an
 * empty box. Callers key it by element, so the load state never has to be reset for a different
 * element. The name is announced by the surrounding control, hence the empty alt. Built from
 * phrasing elements so it can sit inside a `<button>`.
 */
export function Thumbnail({ element, className }: ThumbnailProps) {
  const t = useT();
  const bank = useStore(bankStore);
  const path = thumbnailPath(element);
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>(
    path === undefined ? 'error' : 'loading',
  );
  const grid = bank.status === 'ready' ? bank.index.grid : DEFAULT_GRID;
  return (
    <span className={cn('relative block size-full overflow-hidden bg-muted/60', className)}>
      {state === 'loading' ? (
        <span className="absolute inset-0 animate-pulse bg-muted-foreground/10" aria-hidden />
      ) : null}
      {state === 'error' || path === undefined ? (
        <span
          className="absolute inset-0 flex items-center justify-center p-1.5"
          title={t('bank.image.generated')}
        >
          <ElementGlyph element={element} grid={grid} />
        </span>
      ) : (
        <img
          src={bankRoutes.asset(path)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setState('loaded')}
          onError={() => setState('error')}
          className={cn(
            'size-full object-contain transition-opacity duration-150',
            state === 'loaded' ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
    </span>
  );
}
