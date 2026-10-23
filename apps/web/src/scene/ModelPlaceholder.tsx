import { useEffect, useMemo } from 'react';
import { Html } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { BoxGeometry, EdgesGeometry, type LineSegments } from 'three';
import { TriangleAlert } from 'lucide-react';
import type { Vec3 } from '@hsw-editor/bank';
import { useT } from '@/i18n/index.ts';
import { InstancedBoxes } from './InstancedBoxes.tsx';
import type { Placement } from './InstancedModel.tsx';
import type { ScenePalette } from './palette.ts';
import { MM } from './units.ts';

const DEG = Math.PI / 180;
/** Labelled outlines are DOM overlays; past this many per group only the boxes are drawn. */
const MAX_LABELLED = 24;
const DASH_M = 0.006;
const GAP_M = 0.004;
const BOX_OPACITY = 0.28;

interface ModelPlaceholderProps {
  readonly dimsMm: Vec3;
  readonly centreMm: Vec3;
  readonly placements: readonly Placement[];
  readonly palette: ScenePalette;
  /** Already translated element name. */
  readonly name: string;
  /** Already translated reason ("file not found (404)", "removed from the bank"...). */
  readonly reason: string;
  readonly onItemPointerDown: (id: string, event: ThreeEvent<PointerEvent>) => void;
}

/**
 * Stand-in for items whose 3D model is missing or failed to load: a translucent orange box with a
 * dashed outline and a warning label. The boxes are the pointer targets (same as the loading
 * stand-in), so the item stays selectable, draggable and framed like any other.
 */
export function ModelPlaceholder({
  dimsMm,
  centreMm,
  placements,
  palette,
  name,
  reason,
  onItemPointerDown,
}: ModelPlaceholderProps) {
  const t = useT();
  const hint = t('asset.placeholder.hint', { name, reason });
  const outline = useMemo(
    () => new EdgesGeometry(new BoxGeometry(dimsMm.x * MM, dimsMm.y * MM, dimsMm.z * MM)),
    [dimsMm.x, dimsMm.y, dimsMm.z],
  );
  useEffect(() => () => outline.dispose(), [outline]);
  return (
    <>
      <InstancedBoxes
        dimsMm={dimsMm}
        centreMm={centreMm}
        color={palette.itemMissing}
        opacity={BOX_OPACITY}
        placements={placements}
        onItemPointerDown={onItemPointerDown}
      />
      {placements.slice(0, MAX_LABELLED).map((placement) => (
        <group
          key={placement.id}
          position={[placement.x * MM, placement.y * MM, placement.z * MM]}
          rotation={[placement.rotX * DEG, placement.rotY * DEG, placement.rotZ * DEG]}
        >
          <lineSegments
            geometry={outline}
            position={[centreMm.x * MM, centreMm.y * MM, centreMm.z * MM]}
            raycast={() => undefined}
            ref={(segments: LineSegments | null) => {
              segments?.computeLineDistances();
            }}
          >
            <lineDashedMaterial
              color={palette.itemMissing}
              dashSize={DASH_M}
              gapSize={GAP_M}
              transparent
              opacity={0.95}
            />
          </lineSegments>
          <Html
            position={[
              centreMm.x * MM,
              (centreMm.y + dimsMm.y / 2) * MM,
              (centreMm.z + dimsMm.z / 2) * MM,
            ]}
            center
            zIndexRange={[30, 0]}
            pointerEvents="none"
          >
            <div
              title={hint}
              className="pointer-events-none flex max-w-56 items-center gap-1 whitespace-nowrap rounded bg-orange-500/90 px-1.5 py-0.5 text-[10px] font-medium text-black shadow"
            >
              <TriangleAlert className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{name}</span>
            </div>
          </Html>
        </group>
      ))}
    </>
  );
}
