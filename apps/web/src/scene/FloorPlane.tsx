import { useMemo, useRef } from 'react';
import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { BufferGeometry, Float32BufferAttribute, type MeshBasicMaterial } from 'three';
import { FLOOR_Y_MM, floorExtentMm, type Board } from '@hsw-editor/core';
import { fallingStore } from './fallAnimation.ts';
import { editorStore } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { useI18n } from '@/i18n/index.ts';
import type { ScenePalette } from './palette.ts';
import { mm } from './units.ts';

/** Distance (mm) between the grid lines of the floor. */
const GRID_MM = 50;
/** The most grid lines along one side of the floor. */
const MAX_LINES = 200;
/** Width (mm) of the lit edge strips. */
const EDGE_MM = 8;

/** Lines every `GRID_MM` over the floor rectangle (x from `x0` to `x1`, z from 0 to `depth`), in the plane y = 0. */
function gridGeometry(x0: number, x1: number, depth: number): BufferGeometry {
  const points: number[] = [];
  // A huge board would make millions of lines: the pitch grows so that no side has more than MAX_LINES.
  const step = Math.max(GRID_MM, (x1 - x0) / MAX_LINES, depth / MAX_LINES);
  const first = Math.ceil(x0 / step) * step;
  for (let x = first; x <= x1; x += step) points.push(mm(x), 0, 0, mm(x), 0, mm(depth));
  for (let z = 0; z <= depth; z += step) points.push(mm(x0), 0, mm(z), mm(x1), 0, mm(z));
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
  return geometry;
}

interface FloorPlaneProps {
  readonly board: Board;
  readonly palette: ScenePalette;
  /** A tool rests on the floor: it stays drawn, quietly, so fallen tools do not hang in the void. */
  readonly occupied: boolean;
}

/**
 * The floor under the wall: where a tool let go with nothing holding it falls and stays. It is drawn while a tool is dragged
 * or falling, lit and pulsing, so it is clear where the tool will end up; while a tool lies on it it stays as a quiet plane.
 * It never takes a pointer: tools on it are picked up like any other.
 */
export function FloorPlane({ board, palette, occupied }: FloorPlaneProps) {
  const { t } = useI18n();
  const dragging = useStore(editorStore).attach !== null;
  const falling = useStore(fallingStore).size > 0;
  const lit = dragging || falling;
  const { x0, x1, depth } = floorExtentMm(board);
  const visible = lit || occupied;
  const grid = useMemo(
    () => (visible ? gridGeometry(x0, x1, depth) : null),
    [visible, x0, x1, depth],
  );
  const fill = useRef<MeshBasicMaterial>(null);
  useFrame(({ clock, invalidate }) => {
    if (!lit) return;
    if (fill.current) fill.current.opacity = 0.3 + 0.1 * Math.sin(clock.elapsedTime * 5);
    invalidate();
  });
  if (grid === null) return null;
  const color = lit ? palette.floorLit : palette.floor;
  const width = x1 - x0;
  return (
    <group name="floor" position={[0, mm(FLOOR_Y_MM), 0]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[mm((x0 + x1) / 2), 0, mm(depth / 2)]}
        raycast={() => undefined}
        renderOrder={1}
      >
        <planeGeometry args={[mm(width), mm(depth)]} />
        <meshBasicMaterial
          ref={fill}
          color={color}
          transparent
          opacity={lit ? 0.3 : 0.16}
          depthWrite={false}
        />
      </mesh>
      <lineSegments geometry={grid} raycast={() => undefined} renderOrder={2}>
        <lineBasicMaterial
          color={color}
          transparent
          opacity={lit ? 0.7 : 0.35}
          depthWrite={false}
        />
      </lineSegments>
      {[0, depth - EDGE_MM].map((z) => (
        <mesh
          key={z}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[mm((x0 + x1) / 2), 0.0005, mm(z + EDGE_MM / 2)]}
          raycast={() => undefined}
          renderOrder={2}
        >
          <planeGeometry args={[mm(width), mm(EDGE_MM)]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={lit ? 0.95 : 0.5}
            depthWrite={false}
          />
        </mesh>
      ))}
      {lit ? (
        <Html position={[mm((x0 + x1) / 2), 0.02, mm(depth * 0.55)]} center zIndexRange={[5, 0]}>
          <span
            data-testid="floor-label"
            className="pointer-events-none select-none whitespace-nowrap rounded bg-popover/90 px-2 py-0.5 text-xs font-medium text-popover-foreground shadow"
            style={{ borderLeft: `3px solid ${color}` }}
          >
            {t('floor.label')}
          </span>
        </Html>
      ) : null}
    </group>
  );
}
