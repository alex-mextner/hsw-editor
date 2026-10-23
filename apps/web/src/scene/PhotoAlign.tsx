import { useRef, type PointerEvent } from 'react';
import { boardExtent } from '@hsw-editor/overlay';
import type { Wall } from '@hsw-editor/core';
import { useStore } from '@/state/react.ts';
import { patchPhoto, photoStore } from '@/state/photo.ts';
import { submitOps } from '@/wall/session.ts';
import { alignCalibration } from './photoAlign.ts';
import type { PhotoView } from './photoView.ts';

interface Gesture {
  readonly pointerId: number;
  readonly startPx: readonly [number, number];
  readonly base: PhotoView['calibration'];
}

/**
 * Catches the pointer over the photo while "move/turn the board" is on, so the grid can be lined up with the
 * real wall by hand. The calibration changes live as a draft; release commits it as one undoable op.
 */
export function PhotoAlign({ wall, view }: { readonly wall: Wall; readonly view: PhotoView }) {
  const { align } = useStore(photoStore);
  const gesture = useRef<Gesture | null>(null);
  if (align === null) return null;

  const photoPx = (event: PointerEvent<HTMLDivElement>): readonly [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) / rect.width) * view.image.width,
      ((event.clientY - rect.top) / rect.height) * view.image.height,
    ];
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      startPx: photoPx(event),
      base: view.calibration,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const [x, y] = photoPx(event);
    const draft = alignCalibration(active.base, view.image, boardExtent(wall.board), {
      kind: align,
      startPx: active.startPx,
      nowPx: [x, y],
    });
    if (draft) patchPhoto({ draft });
  };

  const finish = (event: PointerEvent<HTMLDivElement>, commit: boolean): void => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null;
    const { draft } = photoStore.get();
    patchPhoto({ draft: null });
    if (commit && draft) {
      submitOps(
        [{ type: 'setCalibration', photoId: view.photo.id, calibration: draft }],
        'align-board',
      );
    }
  };

  return (
    <div
      data-photo-align={align}
      className="absolute inset-0 z-10 cursor-grab touch-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
    />
  );
}
