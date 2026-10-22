import type { BankElement } from '@hsw-editor/bank';
import type { Wall } from '@hsw-editor/core';
import type { ScenePalette } from '@/scene/palette.ts';
import { DimensionArrows } from './DimensionArrows.tsx';
import { InlineDimensionWidget } from './InlineDimensionWidget.tsx';

interface DimensionLayerProps {
  readonly wall: Wall;
  readonly bank: ReadonlyMap<string, BankElement>;
  readonly palette: ScenePalette;
}

/** Everything the dimension feature draws inside the R3F canvas: the 3D arrows and the floating editor. */
export function DimensionLayer({ wall, bank, palette }: DimensionLayerProps) {
  return (
    <>
      <DimensionArrows wall={wall} bank={bank} palette={palette} />
      <InlineDimensionWidget wall={wall} bank={bank} />
    </>
  );
}
