/**
 * `<InvalidZones/>` scene component: draws the engine's region meshes with the stripe material, in two passes
 * (surface pass with the normal depth test; faint see-through pass for parts hidden behind geometry, which is where an
 * overlap between two solid bodies mostly lives), plus a thin outline. Renders nothing without regions.
 * Meant to sit inside the R3F `<Canvas>` next to the items layer; it has no effect on picking items.
 */
import { useEffect, useMemo, useState } from 'react';
import { Html } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { EdgesGeometry, LineBasicMaterial, type Vector3 } from 'three';
import type { RegionMesh, SolveResult } from './engine.ts';
import { buildRegionBatch, regionsSignature, type RegionBatch } from './regionGeometry.ts';
import { createStripeMaterial, setStripeDpr, type StripeTheme } from './stripeMaterial.ts';

/** Engine millimetres -> scene metres. */
const MM = 0.001;
/** Above the items and the photo overlay plane, which are drawn at the default order. */
const RENDER_ORDER = 40;

interface InvalidZonesProps {
  readonly result: SolveResult | null;
  readonly theme: StripeTheme;
  /** Tooltip lines for a hovered region (the reasons, already translated); empty = no tooltip. */
  readonly describeRegion?: (region: RegionMesh) => readonly string[];
}

export function InvalidZones({ result, theme, describeRegion }: InvalidZonesProps) {
  const invalidate = useThree((state) => state.invalidate);
  const dpr = useThree((state) => state.viewport.dpr);
  const surface = useMemo(() => createStripeMaterial({ theme, xray: false }), [theme]);
  const hidden = useMemo(() => createStripeMaterial({ theme, xray: true }), [theme]);
  const outline = useMemo(
    () =>
      new LineBasicMaterial({
        color: theme === 'dark' ? '#ff6b6b' : '#b00d17',
        transparent: true,
        opacity: 0.9,
      }),
    [theme],
  );
  // The worker answers every update with fresh clones; rebuild GPU geometry only when a region really changed.
  const signature = useMemo(() => (result ? regionsSignature(result.regions) : ''), [result]);
  const [stable, setStable] = useState<{ signature: string; regions: readonly RegionMesh[] }>({
    signature: '',
    regions: [],
  });
  if (stable.signature !== signature) setStable({ signature, regions: result?.regions ?? [] });
  const regions = stable.regions;
  const batch = useMemo(() => buildRegionBatch(regions, MM), [regions]);
  const edges = useMemo(() => (batch ? new EdgesGeometry(batch.geometry, 30) : null), [batch]);
  // A tooltip belongs to the geometry it was raised on: after an update replaces the regions it is not shown.
  const [hoverState, setHover] = useState<{
    batch: RegionBatch;
    lines: readonly string[];
    point: Vector3;
  } | null>(null);
  const hover = hoverState && hoverState.batch === batch ? hoverState : null;

  useEffect(() => {
    invalidate();
  }, [batch, invalidate]);

  useEffect(() => {
    setStripeDpr(surface, dpr);
    setStripeDpr(hidden, dpr);
    invalidate();
  }, [dpr, surface, hidden, invalidate]);

  useEffect(
    () => () => {
      batch?.geometry.dispose();
      edges?.dispose();
    },
    [batch, edges],
  );
  useEffect(
    () => () => {
      surface.dispose();
      hidden.dispose();
      outline.dispose();
    },
    [surface, hidden, outline],
  );

  if (!batch || !edges) return null;

  const onMove = (event: ThreeEvent<PointerEvent>): void => {
    const region = event.faceIndex == null ? undefined : batch.regionOfTriangle(event.faceIndex);
    const lines = region && describeRegion ? describeRegion(region) : [];
    setHover(lines.length > 0 ? { batch, lines, point: event.point } : null);
  };

  return (
    <group name="invalid-zones">
      <mesh
        geometry={batch.geometry}
        material={hidden}
        renderOrder={RENDER_ORDER}
        frustumCulled={false}
        raycast={() => undefined}
      />
      <mesh
        geometry={batch.geometry}
        material={surface}
        renderOrder={RENDER_ORDER + 1}
        frustumCulled={false}
        onPointerMove={onMove}
        onPointerOut={() => setHover(null)}
      />
      <lineSegments
        geometry={edges}
        material={outline}
        renderOrder={RENDER_ORDER + 2}
        frustumCulled={false}
        raycast={() => undefined}
      />
      {hover ? (
        <Html position={hover.point} style={{ pointerEvents: 'none' }} zIndexRange={[30, 0]}>
          <div
            role="tooltip"
            className="w-max max-w-64 -translate-y-full rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          >
            {hover.lines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        </Html>
      ) : null}
    </group>
  );
}
