import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CellOffset } from '@hsw-editor/bank';
import { cn } from '@/lib/cn.ts';
import {
  cellCentreMm,
  cellKey,
  cellWindow,
  hasCell,
  isAnchor,
  windowCells,
  windowViewBox,
  type CellWindow,
} from './hexGrid.ts';

/** Peg marker diameter, mm (a hex-plug / M3 head is smaller than the cell). */
const PEG_DIAMETER_MM = 9;
const ANCHOR_DOT_DIAMETER_MM = 3.2;
/** Hexagons are drawn a little smaller than the lattice so neighbours do not touch. */
const CELL_DRAW_RADIUS_MM = 12.6;
const CELL_DRAW_WIDTH_MM = 2 * CELL_DRAW_RADIUS_MM;
const CELL_DRAW_HEIGHT_MM = Math.sqrt(3) * CELL_DRAW_RADIUS_MM;
/** Tallest the grid may get, rem. */
const MAX_HEIGHT_REM = 18;
/** Hexagon with a vertex along +x, like the lattice. */
const HEX_CLIP = 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)';

export interface HexCellGridProps {
  /** Cells that must be visible (footprint, detected cells): the window is these plus a margin. */
  readonly extent: readonly CellOffset[];
  /** Cells shown as part of the footprint. */
  readonly footprint: readonly CellOffset[];
  /** Cells carrying a peg / screw (drawn as a dot); empty hides them. */
  readonly pegs: readonly CellOffset[];
  /** `footprint`: every window cell toggles; `pegs`: only footprint cells toggle, the rest are inert. */
  readonly mode: 'footprint' | 'pegs';
  readonly onPaint: (cell: CellOffset, on: boolean) => void;
  readonly label: string;
  /** `data-testid` prefix of the cells (`<prefix>-<dCol>_<dRow2>`). */
  readonly testIdPrefix: string;
  readonly disabled?: boolean;
}

function growWindow(previous: CellWindow, next: CellWindow): CellWindow {
  return {
    minCol: Math.min(previous.minCol, next.minCol),
    maxCol: Math.max(previous.maxCol, next.maxCol),
    minRow2: Math.min(previous.minRow2, next.minRow2),
    maxRow2: Math.max(previous.maxRow2, next.maxRow2),
  };
}

function sameWindow(a: CellWindow, b: CellWindow): boolean {
  return (
    a.minCol === b.minCol &&
    a.maxCol === b.maxCol &&
    a.minRow2 === b.minRow2 &&
    a.maxRow2 === b.maxRow2
  );
}

/**
 * Hex grid of honeycomb cells around the anchor, shared by the footprint and the peg editors. Every cell is a
 * real button (keyboard, screen readers, touch) clipped to a hexagon. The window only grows, so painting at its
 * edge never moves the cells under the pointer. A mouse can drag-paint; a finger or the keyboard toggles one
 * cell per tap (a touch drag must keep scrolling the dialog).
 */
export function HexCellGrid({
  extent,
  footprint,
  pegs,
  mode,
  onPaint,
  label,
  testIdPrefix,
  disabled = false,
}: HexCellGridProps) {
  const [view, setView] = useState(() => cellWindow(extent));
  // Derived state: grow (never shrink) when cells reach beyond the window.
  const wanted = growWindow(view, cellWindow(extent));
  if (!sameWindow(wanted, view)) setView(wanted);
  const cells = windowCells(wanted);
  const box = windowViewBox(wanted);

  const paint = useRef<{ on: boolean } | null>(null);
  const lastPointerType = useRef('mouse');
  useEffect(() => {
    const stop = (): void => {
      paint.current = null;
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  const editable = (cell: CellOffset): boolean =>
    !disabled && (mode === 'footprint' ? !isAnchor(cell) : hasCell(footprint, cell));
  const stateOf = (cell: CellOffset): boolean =>
    mode === 'footprint' ? hasCell(footprint, cell) : hasCell(pegs, cell);

  const placement = (cell: CellOffset): CSSProperties => {
    const { x, y } = cellCentreMm(cell);
    return {
      left: `${((x - CELL_DRAW_RADIUS_MM - box.x) / box.width) * 100}%`,
      top: `${((-y - CELL_DRAW_HEIGHT_MM / 2 - box.y) / box.height) * 100}%`,
      width: `${(CELL_DRAW_WIDTH_MM / box.width) * 100}%`,
      height: `${(CELL_DRAW_HEIGHT_MM / box.height) * 100}%`,
    };
  };

  return (
    <fieldset
      className="m-0 mx-auto min-w-0 border-0 p-0"
      style={{ width: `min(100%, ${MAX_HEIGHT_REM * (box.width / box.height)}rem)` }}
    >
      <legend className="sr-only">{label}</legend>
      <div className="relative w-full" style={{ aspectRatio: `${box.width} / ${box.height}` }}>
        {cells.map((cell) => {
          const inFootprint = hasCell(footprint, cell);
          const on = stateOf(cell);
          const canEdit = editable(cell);
          return (
            <button
              key={cellKey(cell)}
              type="button"
              data-testid={`${testIdPrefix}-${cellKey(cell)}`}
              data-on={on}
              aria-pressed={on}
              aria-label={`${cell.dCol}, ${cell.dRow2}`}
              disabled={!canEdit}
              style={{ ...placement(cell), clipPath: HEX_CLIP }}
              className={cn(
                'group absolute touch-manipulation p-0 outline-none',
                inFootprint ? 'bg-primary' : 'bg-border',
                canEdit ? 'cursor-pointer' : 'cursor-default',
                canEdit && 'focus-visible:bg-ring',
              )}
              onPointerDown={(event) => {
                lastPointerType.current = event.pointerType;
                if (event.pointerType !== 'mouse' || event.button !== 0) return;
                paint.current = { on: !on };
                onPaint(cell, !on);
              }}
              onPointerEnter={(event) => {
                if (paint.current !== null && event.pointerType === 'mouse') {
                  onPaint(cell, paint.current.on);
                }
              }}
              onClick={(event) => {
                // A mouse press already painted on pointerdown; touch / pen / keyboard (detail 0) toggle here.
                if (lastPointerType.current === 'mouse' && event.detail > 0) return;
                onPaint(cell, !on);
              }}
            >
              <span
                aria-hidden
                style={{ clipPath: HEX_CLIP }}
                className={cn(
                  'absolute inset-[2px] flex items-center justify-center',
                  inFootprint
                    ? mode === 'footprint'
                      ? 'bg-primary/45'
                      : 'bg-primary/20'
                    : 'bg-muted',
                  canEdit && 'group-hover:bg-primary/60',
                )}
              >
                {mode === 'pegs' && on ? (
                  <span
                    className="block rounded-full bg-primary"
                    style={{
                      width: `${(PEG_DIAMETER_MM / CELL_DRAW_WIDTH_MM) * 100}%`,
                      aspectRatio: '1',
                    }}
                  />
                ) : null}
                {isAnchor(cell) ? (
                  <span
                    className="absolute block rounded-full bg-foreground/70"
                    style={{
                      width: `${(ANCHOR_DOT_DIAMETER_MM / CELL_DRAW_WIDTH_MM) * 100}%`,
                      aspectRatio: '1',
                    }}
                  />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
