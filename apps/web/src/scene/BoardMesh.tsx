import { useLayoutEffect, useMemo, useRef } from 'react';
import {
  Color,
  type InstancedMesh,
  Matrix4,
  Shape,
  ShapeGeometry,
  type BufferGeometry,
} from 'three';
import { boardSizeMm, cellCenter, type Board } from '@hsw-editor/core';
import { mm } from './units.ts';
import type { ScenePalette } from './palette.ts';

/** Flat-top hexagon with circumradius `radius` in the XY plane. */
function hexagonGeometry(radius: number): ShapeGeometry {
  const shape = new Shape();
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 3) * i;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return new ShapeGeometry(shape);
}

interface BoardMeshProps {
  readonly board: Board;
  readonly palette: ScenePalette;
  /** `col,row` keys of cells that hold an item; drawn in the occupied colour. */
  readonly occupied: ReadonlySet<string>;
}

/** The honeycomb panel: a plate with one instanced hexagon per cell at the real pitch. */
export function BoardMesh({ board, palette, occupied }: BoardMeshProps) {
  const cells = useRef<InstancedMesh>(null);
  const count = board.cols * board.rows;
  // Flat-top hexagons tile with colPitch = 1.5 R; the gap makes the grid readable.
  const radius = mm((board.colPitchMm / 1.5) * 0.86);
  const geometry = useMemo<BufferGeometry>(() => hexagonGeometry(radius), [radius]);
  const size = boardSizeMm(board);

  useLayoutEffect(() => {
    const mesh = cells.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    let index = 0;
    for (let col = 0; col < board.cols; col += 1) {
      for (let row = 0; row < board.rows; row += 1) {
        const centre = cellCenter(board, { col, row });
        matrix.makeTranslation(mm(centre.x), mm(centre.y), 0.0004);
        mesh.setMatrixAt(index, matrix);
        index += 1;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [board, count]);

  useLayoutEffect(() => {
    const mesh = cells.current;
    if (!mesh) return;
    const base = new Color(palette.cell);
    const taken = new Color(palette.cellOccupied);
    let index = 0;
    for (let col = 0; col < board.cols; col += 1) {
      for (let row = 0; row < board.rows; row += 1) {
        mesh.setColorAt(index, occupied.has(`${col},${row}`) ? taken : base);
        index += 1;
      }
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [board, count, occupied, palette]);

  return (
    <group name="board">
      <mesh position={[mm(size.width / 2), mm(size.height / 2), -0.003]}>
        <boxGeometry args={[mm(size.width), mm(size.height), 0.006]} />
        <meshStandardMaterial color={palette.plate} roughness={0.9} />
      </mesh>
      <instancedMesh
        ref={cells}
        args={[geometry, undefined, count]}
        frustumCulled={false}
        raycast={() => undefined}
      >
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}
