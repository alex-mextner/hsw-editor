import { useMemo, useState } from 'react';
import { createValueStore } from '#state-backend';
import { Hexagon } from 'lucide-react';
import { DEFAULT_BOARD } from '@hsw-editor/core';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { notify } from '@/features/notices/notices.ts';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';
import { createAndOpenWall, wallListStore } from '@/wall/session.ts';
import { BOARD_PRESETS, boardFromSize, sizeOfBoard } from './boardSize.ts';

export const newWallDialogStore = createValueStore<boolean>(false);

/** New-wall wizard: name, size (the board snaps to whole honeycomb cells) and grid pitch. */
export function NewWallDialog() {
  const open = useStore(newWallDialogStore);
  return (
    <Dialog open={open} onOpenChange={(next) => newWallDialogStore.set(next)}>
      <DialogContent className="sm:max-w-md">{open ? <NewWallForm /> : null}</DialogContent>
    </Dialog>
  );
}

function numberOf(text: string): number {
  return Number(text.replace(',', '.'));
}

function NewWallForm() {
  const { t } = useI18n();
  const walls = useStore(wallListStore).walls;
  const initialSize = sizeOfBoard(DEFAULT_BOARD);
  const [name, setName] = useState(() => t('wizard.defaultName', { n: walls.length + 1 }));
  const [width, setWidth] = useState(String(initialSize.widthMm));
  const [height, setHeight] = useState(String(initialSize.heightMm));
  const [colPitch, setColPitch] = useState(String(DEFAULT_BOARD.colPitchMm));
  const [rowPitch, setRowPitch] = useState(String(DEFAULT_BOARD.rowPitchMm));
  const [busy, setBusy] = useState(false);

  const board = useMemo(
    () =>
      boardFromSize({
        widthMm: numberOf(width),
        heightMm: numberOf(height),
        colPitchMm: numberOf(colPitch),
        rowPitchMm: numberOf(rowPitch),
      }),
    [width, height, colPitch, rowPitch],
  );
  const actual = board ? sizeOfBoard(board) : null;
  const valid = board !== null && name.trim().length > 0;

  const create = async (): Promise<void> => {
    if (!board || busy) return;
    setBusy(true);
    try {
      await createAndOpenWall(name.trim(), board);
      newWallDialogStore.set(false);
    } catch (error) {
      notify(
        'error',
        t('wizard.failed', { reason: error instanceof Error ? error.message : String(error) }),
      );
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Hexagon className="size-4 text-primary" aria-hidden />
          {t('wizard.title')}
        </DialogTitle>
        <DialogDescription>{t('wizard.description')}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor="wall-name">{t('wizard.name')}</Label>
        <Input
          id="wall-name"
          value={name}

          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('wizard.presets')}</span>
        <div className="grid grid-cols-3 gap-2">
          {BOARD_PRESETS.map((preset) => {
            const size = sizeOfBoard(preset.board);
            const selected = board?.cols === preset.board.cols && board.rows === preset.board.rows;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={selected}
                className={cn(
                  'rounded-lg border px-2 py-2 text-left text-xs transition-colors hover:bg-muted',
                  selected ? 'border-primary bg-accent' : 'border-border',
                )}
                onClick={() => {
                  setWidth(String(size.widthMm));
                  setHeight(String(size.heightMm));
                  setColPitch(String(preset.board.colPitchMm));
                  setRowPitch(String(preset.board.rowPitchMm));
                }}
              >
                <div className="font-medium">{t(`wizard.preset.${preset.id}`)}</div>
                <div className="text-muted-foreground">
                  {size.widthMm} × {size.heightMm}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="wall-width">{t('wizard.width')}</Label>
          <Input
            id="wall-width"
            inputMode="decimal"
            value={width}
            onChange={(event) => setWidth(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="wall-height">{t('wizard.height')}</Label>
          <Input
            id="wall-height"
            inputMode="decimal"
            value={height}
            onChange={(event) => setHeight(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="wall-col-pitch">{t('wizard.colPitch')}</Label>
          <Input
            id="wall-col-pitch"
            inputMode="decimal"
            value={colPitch}
            onChange={(event) => setColPitch(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="wall-row-pitch">{t('wizard.rowPitch')}</Label>
          <Input
            id="wall-row-pitch"
            inputMode="decimal"
            value={rowPitch}
            onChange={(event) => setRowPitch(event.target.value)}
          />
        </div>
      </div>

      <p
        className={cn('rounded-md bg-muted px-3 py-2 text-xs', !board && 'text-destructive')}
        aria-live="polite"
      >
        {board && actual
          ? t('wizard.summary', {
              cols: board.cols,
              rows: board.rows,
              width: actual.widthMm,
              height: actual.heightMm,
            })
          : t('wizard.invalid')}
      </p>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => newWallDialogStore.set(false)}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" disabled={!valid || busy}>
          {t('wizard.create')}
        </Button>
      </DialogFooter>
    </form>
  );
}
