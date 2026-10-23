import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { CanvasTexture, SRGBColorSpace } from 'three';
import { boardSizeMm, type Board } from '@hsw-editor/core';
import { drawBoardWeb, webCanvasSize } from './boardWeb.ts';
import { mm } from './units.ts';

/** Light plate colour of the web; the HSW panel is white plastic. */
const WEB_COLOR = '#f3f3ef';

/** The board in photo mode: the white honeycomb web over the photo, with the cells open to the wall behind. */
export function PhotoBoard({ board }: { readonly board: Board }) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const size = boardSizeMm(board);
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    const { width, height } = webCanvasSize(board);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) drawBoardWeb(ctx, board, WEB_COLOR);
    const made = new CanvasTexture(canvas);
    made.colorSpace = SRGBColorSpace;
    made.anisotropy = gl.capabilities.getMaxAnisotropy();
    return made;
  }, [board, gl]);
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
