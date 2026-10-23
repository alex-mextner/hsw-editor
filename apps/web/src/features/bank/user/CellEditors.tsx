import type { CellOffset } from '@hsw-editor/bank';
import { MOUNTING_KINDS } from '@hsw-editor/bank';
import { Button } from '@/components/ui/button.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { useI18n } from '@/i18n/index.ts';
import { MOUNTING_LABELS } from '../labels.ts';
import { mountingIssue, type MountingKind } from './cellEdit.ts';
import { HexCellGrid } from './HexCellGrid.tsx';
import { footprintDims } from './hexGrid.ts';

interface FootprintEditorProps {
  /** Cells that frame the visible window (footprint plus the detected cells). */
  readonly extent: readonly CellOffset[];
  readonly footprint: readonly CellOffset[];
  /** Footprint was edited by hand, so a new detection no longer replaces it. */
  readonly edited: boolean;
  readonly onPaint: (cell: CellOffset, on: boolean) => void;
  readonly onResetDetected: () => void;
  readonly disabled: boolean;
}

/** Hex-grid picker of the cells under the element; the anchor cell {0,0} (dot) is always part of it. */
export function FootprintEditor({
  extent,
  footprint,
  edited,
  onPaint,
  onResetDetected,
  disabled,
}: FootprintEditorProps) {
  const { t, tn } = useI18n();
  const { cols, rows } = footprintDims(footprint);
  return (
    <div className="flex flex-col gap-1.5" data-testid="add-element-footprint">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t('bank.user.footprint.summary', {
            cols,
            rows,
            cells: tn('bank.cells', footprint.length),
          })}
        </p>
        {edited ? (
          <Button variant="ghost" size="xs" onClick={onResetDetected} disabled={disabled}>
            {t('bank.user.footprint.reset')}
          </Button>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {t('bank.user.footprint.detected')}
          </span>
        )}
      </div>
      <HexCellGrid
        extent={extent}
        footprint={footprint}
        pegs={[]}
        mode="footprint"
        onPaint={onPaint}
        label={t('bank.user.footprint.label')}
        testIdPrefix="hex-cell"
        disabled={disabled}
      />
      <p className="text-[11px] text-muted-foreground">{t('bank.user.footprint.hint')}</p>
    </div>
  );
}

const pressedClass = 'data-pressed:bg-accent data-pressed:text-accent-foreground';

interface MountingEditorProps {
  readonly extent: readonly CellOffset[];
  readonly footprint: readonly CellOffset[];
  readonly kind: MountingKind;
  readonly cells: readonly CellOffset[];
  readonly onKind: (kind: MountingKind) => void;
  readonly onPaint: (cell: CellOffset, on: boolean) => void;
  readonly disabled: boolean;
}

/** Mounting interface: the kind, and on the same grid which footprint cells carry a peg / screw. */
export function MountingEditor({
  extent,
  footprint,
  kind,
  cells,
  onKind,
  onPaint,
  disabled,
}: MountingEditorProps) {
  const { t } = useI18n();
  const issue = mountingIssue(kind, cells);
  return (
    <div className="flex flex-col gap-1.5" data-testid="add-element-mounting">
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={1}
        className="flex-wrap"
        disabled={disabled}
        value={[kind]}
        onValueChange={(value) => {
          const next = MOUNTING_KINDS.find((candidate) => candidate === value[0]);
          if (next !== undefined) onKind(next);
        }}
      >
        {MOUNTING_KINDS.map((candidate) => (
          <ToggleGroupItem
            key={candidate}
            value={candidate}
            className={pressedClass}
            data-testid={`add-element-mounting-${candidate}`}
          >
            {t(MOUNTING_LABELS[candidate])}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {kind === 'none' ? (
        <p className="text-[11px] text-muted-foreground">{t('bank.user.mounting.noneHint')}</p>
      ) : (
        <>
          <HexCellGrid
            extent={extent}
            footprint={footprint}
            pegs={cells}
            mode="pegs"
            onPaint={onPaint}
            label={t('bank.user.mounting.label')}
            testIdPrefix="hex-peg"
            disabled={disabled}
          />
          <p className="text-[11px] text-muted-foreground">{t('bank.user.mounting.hint')}</p>
          {issue === 'no-pegs' ? (
            <p role="alert" className="text-xs text-destructive">
              {t('bank.user.mounting.noPegs')}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
