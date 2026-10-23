import type { Vec2 } from '@/state/editor.ts';
import { MM } from './units.ts';

/** Ring on the wall where "add element here" will put the next element from the bank. */
export function PlacementMarker({
  point,
  color,
}: {
  readonly point: Vec2 | null;
  readonly color: string;
}) {
  if (!point) return null;
  return (
    <mesh position={[point.x * MM, point.y * MM, 0.004]} raycast={() => undefined} renderOrder={6}>
      <ringGeometry args={[0.012, 0.017, 32]} />
      <meshBasicMaterial color={color} transparent opacity={0.9} depthWrite={false} />
    </mesh>
  );
}
