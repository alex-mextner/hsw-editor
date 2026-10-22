import { Html, Line } from '@react-three/drei';
import { Quaternion, Vector3 } from 'three';
import type { BankElement } from '@hsw-editor/bank';
import type { Wall } from '@hsw-editor/core';
import { resolveModel, variantVersion } from '@/bank/models.ts';
import { useT } from '@/i18n/index.ts';
import type { ScenePalette } from '@/scene/palette.ts';
import { MM } from '@/scene/units.ts';
import { editorStore } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { paramsDraftStore } from './draft.ts';
import { formatLength, unitStore } from './units.ts';

const DEG = Math.PI / 180;
/** Distance of a dimension line from the box it measures. */
const OFFSET_MM = 14;
const CONE_RADIUS_MM = 2.2;
const CONE_LENGTH_MM = 7;
const UP = new Vector3(0, 1, 0);

type Point = readonly [number, number, number];

interface ArrowProps {
  readonly from: Point;
  readonly to: Point;
  readonly color: string;
  readonly label: string;
  /** Screen-space nudge (px) so the three labels of a small element do not sit on top of each other. */
  readonly shiftPx: readonly [number, number];
}

const metres = (point: Point): [number, number, number] => [
  point[0] * MM,
  point[1] * MM,
  point[2] * MM,
];

/** Double-headed dimension line with a label at its middle. Heads are dropped on very short lines. */
function Arrow({ from, to, color, label, shiftPx }: ArrowProps) {
  const direction = new Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const showHeads = direction.length() >= CONE_LENGTH_MM * 3;
  direction.normalize();
  // Cone centre sits half a cone length inside the end point so the tip lands on it.
  const headAt = (point: Point, sign: 1 | -1): [number, number, number] =>
    metres([
      point[0] - sign * direction.x * (CONE_LENGTH_MM / 2),
      point[1] - sign * direction.y * (CONE_LENGTH_MM / 2),
      point[2] - sign * direction.z * (CONE_LENGTH_MM / 2),
    ]);
  const heads = showHeads
    ? [
        {
          position: headAt(to, 1),
          quaternion: new Quaternion().setFromUnitVectors(UP, direction),
        },
        {
          position: headAt(from, -1),
          quaternion: new Quaternion().setFromUnitVectors(UP, direction.clone().negate()),
        },
      ]
    : [];
  const middle: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];

  return (
    <group>
      <Line
        points={[metres(from), metres(to)]}
        color={color}
        lineWidth={1.5}
        depthTest={false}
        renderOrder={20}
      />
      {heads.map((head, index) => (
        <mesh
          key={index}
          position={head.position}
          quaternion={head.quaternion}
          renderOrder={21}
          raycast={() => undefined}
        >
          <coneGeometry args={[CONE_RADIUS_MM * MM, CONE_LENGTH_MM * MM, 12]} />
          <meshBasicMaterial color={color} depthTest={false} />
        </mesh>
      ))}
      <Html
        position={metres(middle)}
        center
        zIndexRange={[10, 0]}
        style={{ pointerEvents: 'none' }}
      >
        <div
          className="rounded bg-background/90 px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap shadow"
          style={{ color, transform: `translate(${shiftPx[0]}px, ${shiftPx[1]}px)` }}
        >
          {label}
        </div>
      </Html>
    </group>
  );
}

interface DimensionArrowsProps {
  readonly wall: Wall;
  readonly bank: ReadonlyMap<string, BankElement>;
  readonly palette: ScenePalette;
}

/**
 * Live width / height / depth arrows around the single selected item. The size comes from
 * `resolveModel`, which already prefers the draft variant of an edit in progress, so the arrows
 * follow the preview model and not the committed one.
 */
export function DimensionArrows({ wall, bank, palette }: DimensionArrowsProps) {
  const t = useT();
  const editor = useStore(editorStore);
  const unit = useStore(unitStore);
  // Both stores change what `resolveModel` returns without touching `wall`.
  useStore(variantVersion);
  useStore(paramsDraftStore);

  const [selectedId] = editor.selection;
  const item =
    editor.selection.length === 1
      ? wall.items.find((candidate) => candidate.id === selectedId)
      : undefined;
  if (!item || item.kind === 'photo-ref') return null;
  const source = resolveModel(item, bank);
  if (!source) return null;

  const live = editor.dragging.get(item.id);
  const { dimsMm: dims, centreMm: centre } = source;
  const left = centre.x - dims.x / 2;
  const right = centre.x + dims.x / 2;
  const bottom = centre.y - dims.y / 2;
  const back = centre.z - dims.z / 2;
  const front = centre.z + dims.z / 2;
  const color = palette.dimension;

  return (
    <group
      name="dimension-arrows"
      position={[(live?.x ?? item.pose.x) * MM, (live?.y ?? item.pose.y) * MM, item.pose.z * MM]}
      rotation={[item.pose.rotX * DEG, item.pose.rotY * DEG, (live?.rotZ ?? item.pose.rotZ) * DEG]}
    >
      <Arrow
        from={[left, bottom - OFFSET_MM, front]}
        to={[right, bottom - OFFSET_MM, front]}
        color={color}
        label={t('widgets.arrows.width', { value: formatLength(dims.x, unit) })}
        shiftPx={[0, 14]}
      />
      <Arrow
        from={[left - OFFSET_MM, bottom, front]}
        to={[left - OFFSET_MM, bottom + dims.y, front]}
        color={color}
        label={t('widgets.arrows.height', { value: formatLength(dims.y, unit) })}
        shiftPx={[-30, 0]}
      />
      <Arrow
        from={[right + OFFSET_MM, bottom, back]}
        to={[right + OFFSET_MM, bottom, front]}
        color={color}
        label={t('widgets.arrows.depth', { value: formatLength(dims.z, unit) })}
        shiftPx={[30, -14]}
      />
    </group>
  );
}
