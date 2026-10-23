import { useEffect, useMemo, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { CanvasTexture, SRGBColorSpace } from 'three';
import { boardSizeMm, type Board, type Calibration } from '@hsw-editor/core';
import { boardExtent, photoMapFromCalibration, type ImageSize } from '@hsw-editor/overlay';
import { photoStore } from '@/state/photo.ts';
import { useStore } from '@/state/react.ts';
import { measureBackdropLuma } from './backdropLuma.ts';
import { drawBoardWeb, webCanvasSize } from './boardWeb.ts';
import { mm } from './units.ts';
import { webStyle } from './webContrast.ts';

/**
 * Mean luma of the photo under the board, for the photo at `photoUrl`; null until it is read, or while it is hidden.
 * The photo comes from the browser cache (the stage shows the same URL). `calibration` is the stored one, so a board
 * drag does not re-measure on every frame.
 */
function useBackdropLuma(
  photoUrl: string,
  image: ImageSize,
  board: Board,
  calibration: Calibration,
): number | null {
  const hidden = useStore(photoStore).photoHidden;
  // The size, not the `image` object: that is rebuilt on every render of the viewport.
  const { width, height } = image;
  const [measured, setMeasured] = useState<{ url: string; luma: number | null } | null>(null);
  useEffect(() => {
    if (hidden) return undefined;
    let live = true;
    const picture = new Image();
    picture.onload = () => {
      if (!live) return;
      const map = photoMapFromCalibration(calibration, { width, height }, boardExtent(board));
      setMeasured({ url: photoUrl, luma: map ? measureBackdropLuma(picture, board, map) : null });
    };
    picture.src = photoUrl;
    return () => {
      live = false;
      picture.onload = null;
    };
  }, [photoUrl, width, height, board, calibration, hidden]);
  // A number measured on another photo, or on a photo that is hidden now, does not count.
  return hidden || measured?.url !== photoUrl ? null : measured.luma;
}

/**
 * The board in photo mode: the honeycomb web over the photo, with the cells open to the wall behind. On a white
 * wall the plain white web would vanish, so the web gets a hairline outline and a shaded plate (auto or by the
 * user's choice).
 */
export function PhotoBoard({
  board,
  photoUrl,
  image,
  calibration,
}: {
  readonly board: Board;
  readonly photoUrl: string;
  readonly image: ImageSize;
  /** The stored calibration of the photo (not the draft of a board drag in progress). */
  readonly calibration: Calibration;
}) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const size = boardSizeMm(board);
  const mode = useStore(photoStore).webContrast;
  const luma = useBackdropLuma(photoUrl, image, board, calibration);
  const style = webStyle(mode, luma);
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    const { width, height } = webCanvasSize(board);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) drawBoardWeb(ctx, board, style);
    const made = new CanvasTexture(canvas);
    made.colorSpace = SRGBColorSpace;
    made.anisotropy = gl.capabilities.getMaxAnisotropy();
    return made;
    // `webStyle` hands out one of two constants, so `style` changes identity only when the style really changes.
  }, [board, gl, style]);
  useEffect(() => {
    invalidate();
    return () => texture.dispose();
  }, [texture, invalidate]);

  return (
    <mesh
      name="board"
      position={[mm(size.width / 2), mm(size.height / 2), 0.0004]}
      renderOrder={1}
      raycast={() => undefined}
    >
      <planeGeometry args={[mm(size.width), mm(size.height)]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}
