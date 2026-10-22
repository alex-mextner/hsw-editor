import { useMemo } from 'react';
import { Html, Line } from '@react-three/drei';
import { editorStore, patchEditor, type Vec2 } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import type { ThreeEvent } from '@react-three/fiber';
import { MM } from './units.ts';
import type { ScenePalette } from './palette.ts';

/** Two-click ruler on the wall plane; the label shows the distance in mm and its horizontal/vertical parts. */
export function MeasureOverlay({ palette }: { readonly palette: ScenePalette }) {
  const { a, b, tool } = useMeasure();
  const points = useMemo(
    () =>
      a && b ? [[a.x * MM, a.y * MM, 0.004] as const, [b.x * MM, b.y * MM, 0.004] as const] : null,
    [a, b],
  );
  if (tool !== 'measure') return null;
  return (
    <group name="measure">
      {[a, b].map((point, index) =>
        point ? (
          <mesh
            key={index}
            position={[point.x * MM, point.y * MM, 0.004]}
            raycast={() => undefined}
          >
            <sphereGeometry args={[3.5 * MM, 12, 12]} />
            <meshBasicMaterial color={palette.measure} depthTest={false} />
          </mesh>
        ) : null,
      )}
      {points && a && b ? (
        <>
          <Line
            points={points.map((p) => [...p])}
            color={palette.measure}
            lineWidth={2}
            depthTest={false}
          />
          <Html
            position={[((a.x + b.x) / 2) * MM, ((a.y + b.y) / 2) * MM, 0.01]}
            center
            style={{ pointerEvents: 'none' }}
          >
            <div className="rounded bg-background/90 px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-foreground shadow">
              {Math.hypot(b.x - a.x, b.y - a.y).toFixed(1)} mm
              <span className="text-muted-foreground">
                {' '}
                ({Math.abs(b.x - a.x).toFixed(1)} × {Math.abs(b.y - a.y).toFixed(1)})
              </span>
            </div>
          </Html>
        </>
      ) : null}
    </group>
  );
}

function useMeasure() {
  const editor = useStore(editorStore);
  return { a: editor.measure.a, b: editor.measure.b, tool: editor.tool };
}

/** Plane click while the measure tool is active: first click sets A, second sets B, third restarts. */
export function measureClick(event: ThreeEvent<PointerEvent>): void {
  const state = editorStore.get();
  if (state.tool !== 'measure' || event.nativeEvent.button !== 0) return;
  const point: Vec2 = { x: event.point.x / MM, y: event.point.y / MM };
  const { a, b } = state.measure;
  patchEditor({ measure: !a || b ? { a: point, b: null } : { a, b: point } });
}
