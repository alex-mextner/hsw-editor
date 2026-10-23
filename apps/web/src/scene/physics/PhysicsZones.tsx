/**
 * `<PhysicsZones/>` scene component: tools that hang badly (a problem of severity `error`) are drawn over their own
 * model with amber "/" stripes, in two passes (surface + faint see-through) like the red invalid zones but in the
 * opposite direction and with a wider period, so the two can never be confused. Tools with only warnings (swings,
 * awkward removal) get a thin amber outline. Hovering a marked tool (or its row in the report list) shows the reasons.
 * Reads everything it needs from the stores; it does not take part in picking items.
 */
import { useEffect, useMemo, useState } from 'react';
import { Html, useGLTF } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  Matrix4,
  MeshBasicMaterial,
  type BufferGeometry,
  type Material,
  type Mesh,
  type Object3D,
  type Vector3,
} from 'three';
import type { BankElement } from '@hsw-editor/bank';
import { bankStore } from '@/bank/client.ts';
import { variantVersion } from '@/bank/models.ts';
import { describeProblem } from '@/features/physics/describeProblem.ts';
import { reportRows, type ReportRow } from '@/features/physics/reportRows.ts';
import { itemNamer } from '@/features/invalid-zones/itemNames.ts';
import { useI18n } from '@/i18n/index.ts';
import { physicsEnabledStore } from '@/physics/live.ts';
import { physicsStore, reportOf } from '@/physics/store.ts';
import { editorStore } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { themeStore } from '@/state/theme.ts';
import { sessionStore } from '@/wall/session.ts';
import { createStripeMaterial, setStripeDpr } from '../invalid-zones/stripeMaterial.ts';
import { ModelBoundary } from '../ModelBoundary.tsx';
import { MM } from '../units.ts';
import { physicsHoverStore } from './hover.ts';
import { withStripeColour } from './stripeColour.ts';
import { physicsZoneGeometry, type ZoneGeometry } from './zoneGeometry.ts';

const DEG = Math.PI / 180;
/** Above the red invalid zones (40..42), which mark geometry and so win the eye when both apply. */
const RENDER_ORDER = 44;
const AMBER = '#f5a524';
const AMBER_HOT = '#fff0c2';
/** Edge angle (degrees) above which a crease is outlined; keeps curved tool bodies from turning into a mesh of lines. */
const EDGE_THRESHOLD = 30;

interface Part {
  readonly geometry: BufferGeometry;
  /** Placement of the mesh in the tool's frame, mm. */
  readonly local: Matrix4;
}

function collectParts(root: Object3D): Part[] {
  root.updateMatrixWorld(true);
  const parts: Part[] = [];
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh) {
      parts.push({ geometry: withStripeColour(mesh.geometry), local: mesh.matrixWorld.clone() });
    }
  });
  return parts;
}

interface Marked {
  readonly row: ReportRow;
  readonly geometry: ZoneGeometry;
  readonly lines: readonly string[];
  readonly pose: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly rotX: number;
    readonly rotY: number;
    readonly rotZ: number;
  };
}

interface HoverState {
  readonly toolId: string;
  readonly point: Vector3;
}

interface Materials {
  readonly surface: ReturnType<typeof createStripeMaterial>;
  readonly hidden: ReturnType<typeof createStripeMaterial>;
  readonly outline: LineBasicMaterial;
  readonly outlineHot: LineBasicMaterial;
  readonly hit: Material;
}

export function PhysicsZones() {
  const { t, locale } = useI18n();
  const invalidate = useThree((state) => state.invalidate);
  const dpr = useThree((state) => state.viewport.dpr);
  const enabled = useStore(physicsEnabledStore);
  const view = useStore(physicsStore);
  const session = useStore(sessionStore);
  const bankState = useStore(bankStore);
  const editor = useStore(editorStore);
  const listHover = useStore(physicsHoverStore);
  const theme = useStore(themeStore);
  // A regenerated model changes the mesh a mark follows.
  useStore(variantVersion);
  const [hover, setHover] = useState<HoverState | null>(null);

  const materials = useMemo<Materials>(
    () => ({
      surface: createStripeMaterial({ theme, xray: false, variant: 'physics' }),
      hidden: createStripeMaterial({ theme, xray: true, variant: 'physics' }),
      outline: new LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.95 }),
      outlineHot: new LineBasicMaterial({ color: AMBER_HOT }),
      // Invisible but pickable: a warning-only tool has no stripes, yet hovering it must still explain itself.
      hit: new MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        colorWrite: false,
        depthWrite: false,
      }),
    }),
    [theme],
  );
  useEffect(() => {
    setStripeDpr(materials.surface, dpr);
    setStripeDpr(materials.hidden, dpr);
    invalidate();
  }, [dpr, materials, invalidate]);
  useEffect(
    () => () => {
      materials.surface.dispose();
      materials.hidden.dispose();
      materials.outline.dispose();
      materials.outlineHot.dispose();
      materials.hit.dispose();
    },
    [materials],
  );

  const wall = session?.wall ?? null;
  const report = reportOf(view);
  const marked = useMemo<Marked[]>(() => {
    if (!enabled || !wall || report === null) return [];
    const bank: ReadonlyMap<string, BankElement> =
      bankState.status === 'ready' ? bankState.byId : new Map();
    const nameOf = itemNamer(wall, bank, locale);
    const out: Marked[] = [];
    for (const row of reportRows(report)) {
      const item = wall.items.find((candidate) => candidate.id === row.physics.toolId);
      // A tool being dragged has no verdict until the next check: its marks would lie.
      if (!item || editor.dragging.has(item.id)) continue;
      const geometry = physicsZoneGeometry(item, wall, bank);
      if (!geometry) continue;
      out.push({
        row,
        geometry,
        lines: row.physics.problems.map((problem) => describeProblem(problem, t, nameOf)),
        pose: item.pose,
      });
    }
    return out;
  }, [enabled, wall, report, bankState, locale, t, editor.dragging]);

  useEffect(() => {
    invalidate();
  }, [marked, listHover, hover, invalidate]);

  if (marked.length === 0) return null;
  const hovered = hover?.toolId ?? listHover;
  const hoveredMark = hover
    ? marked.find((mark) => mark.row.physics.toolId === hover.toolId)
    : undefined;

  return (
    <group name="physics-zones">
      {marked.map((mark) => (
        <ToolMarks
          key={mark.row.physics.toolId}
          mark={mark}
          materials={materials}
          hot={hovered === mark.row.physics.toolId}
          onHover={(point) => setHover(point ? { toolId: mark.row.physics.toolId, point } : null)}
        />
      ))}
      {hover && hoveredMark ? (
        <Html position={hover.point} style={{ pointerEvents: 'none' }} zIndexRange={[30, 0]}>
          <div
            role="tooltip"
            className="w-max max-w-64 -translate-y-full rounded-md border border-amber-500/60 bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          >
            {hoveredMark.lines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        </Html>
      ) : null}
    </group>
  );
}

interface ToolMarksProps {
  readonly mark: Marked;
  readonly materials: Materials;
  readonly hot: boolean;
  readonly onHover: (point: Vector3 | null) => void;
}

/** One tool's marks at its pose; the model's parts when it loads, the stand-in box otherwise. */
function ToolMarks({ mark, materials, hot, onHover }: ToolMarksProps) {
  const { pose, geometry } = mark;
  const box = <BoxMarks mark={mark} materials={materials} hot={hot} onHover={onHover} />;
  return (
    <group
      position={[pose.x * MM, pose.y * MM, pose.z * MM]}
      rotation={[pose.rotX * DEG, pose.rotY * DEG, pose.rotZ * DEG]}
      scale={MM}
    >
      {geometry.modelUrl === null ? (
        box
      ) : (
        <ModelBoundary
          url={geometry.modelUrl}
          {...(geometry.bankId === undefined ? {} : { bankId: geometry.bankId })}
          name={mark.row.physics.toolId}
          fallback={box}
          placeholder={() => box}
          quiet
        >
          <ModelMarks
            url={geometry.modelUrl}
            mark={mark}
            materials={materials}
            hot={hot}
            onHover={onHover}
          />
        </ModelBoundary>
      )}
    </group>
  );
}

type PartProps = Pick<ToolMarksProps, 'mark' | 'materials' | 'hot' | 'onHover'>;

function ModelMarks({ url, ...rest }: PartProps & { readonly url: string }) {
  const gltf = useGLTF(url);
  const parts = useMemo(() => collectParts(gltf.scene), [gltf.scene]);
  useEffect(
    () => () => {
      for (const part of parts) part.geometry.dispose();
    },
    [parts],
  );
  return <Marks parts={parts} {...rest} />;
}

function BoxMarks(props: PartProps) {
  const { dimsMm, centreMm } = props.mark.geometry;
  const box = useMemo<{ part: Part; owned: BufferGeometry }>(() => {
    const owned = withStripeColour(new BoxGeometry(dimsMm.x, dimsMm.y, dimsMm.z));
    return {
      owned,
      part: {
        geometry: owned,
        local: new Matrix4().makeTranslation(centreMm.x, centreMm.y, centreMm.z),
      },
    };
  }, [dimsMm, centreMm]);
  useEffect(() => () => box.owned.dispose(), [box]);
  return <Marks parts={[box.part]} {...props} />;
}

function Marks({
  parts,
  mark,
  materials,
  hot,
  onHover,
}: PartProps & { readonly parts: readonly Part[] }) {
  const striped = mark.row.severity === 'error' || hot;
  const edges = useMemo(
    () => parts.map((part) => new EdgesGeometry(part.geometry, EDGE_THRESHOLD)),
    [parts],
  );
  useEffect(
    () => () => {
      for (const geometry of edges) geometry.dispose();
    },
    [edges],
  );
  const handlers = {
    onPointerMove: (event: ThreeEvent<PointerEvent>) => onHover(event.point),
    onPointerOut: () => onHover(null),
  };
  return (
    <>
      {parts.map((part, index) => (
        <group key={index} matrix={part.local} matrixAutoUpdate={false}>
          {striped ? (
            <>
              <mesh
                geometry={part.geometry}
                material={materials.hidden}
                renderOrder={RENDER_ORDER}
                frustumCulled={false}
                raycast={() => undefined}
              />
              <mesh
                geometry={part.geometry}
                material={materials.surface}
                renderOrder={RENDER_ORDER + 1}
                frustumCulled={false}
                {...handlers}
              />
            </>
          ) : (
            <mesh
              geometry={part.geometry}
              material={materials.hit}
              renderOrder={RENDER_ORDER}
              frustumCulled={false}
              {...handlers}
            />
          )}
          {edges[index] ? (
            <lineSegments
              geometry={edges[index]}
              material={hot ? materials.outlineHot : materials.outline}
              renderOrder={RENDER_ORDER + 2}
              frustumCulled={false}
              raycast={() => undefined}
            />
          ) : null}
        </group>
      ))}
    </>
  );
}
