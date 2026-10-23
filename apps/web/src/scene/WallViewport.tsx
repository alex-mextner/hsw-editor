import { useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Stats } from '@react-three/drei';
import type { Wall } from '@hsw-editor/core';
import { ViewportContextMenu } from '@/features/viewport/ViewportContextMenu.tsx';
import { bankStore } from '@/bank/client.ts';
import { variantVersion } from '@/bank/models.ts';
import { toolAssetsStore } from '@/toolmodels/assets.ts';
import { toolModelVersion } from '@/toolmodels/regen.ts';
import { itemNamer } from '@/features/invalid-zones/itemNames.ts';
import { useI18n } from '@/i18n/index.ts';
import { editorStore, setSelection } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { themeStore } from '@/state/theme.ts';
import { layoutProblems, occupiedCells } from '@/wall/footprint.ts';
import { sessionStore } from '@/wall/session.ts';
import { BoardMesh } from './BoardMesh.tsx';
import { OmpViewportInstaller } from '@/features/omp/OmpViewportInstaller.tsx';
import { BridgeInstaller } from './BridgeInstaller.tsx';
import { CameraRig } from './CameraRig.tsx';
import { dragOverViewport, dropOnViewport, leaveViewport } from './bankDrop.ts';
import { beginItemDrag } from './dragController.ts';
import { FpsProbe } from './FpsProbe.tsx';
import { GhostItem } from './GhostItem.tsx';
import { ItemsLayer } from './ItemsLayer.tsx';
import { AttachHint } from '@/features/viewport/AttachHint.tsx';
import { photoStore } from '@/state/photo.ts';
import { MountHighlights } from './MountHighlights.tsx';
import { dragOverTool, dropTool, leaveToolViewport } from './toolDrop.ts';
import { measureClick, MeasureOverlay } from './MeasureTool.tsx';
import { scenePalette } from './palette.ts';
import { PlacementMarker } from './PlacementMarker.tsx';
import { PhotoExportInstaller } from './PhotoExportInstaller.tsx';
import { PhotoBoard } from './PhotoBoard.tsx';
import { PhotoCameraRig } from './PhotoCameraRig.tsx';
import { wallExtent } from './wallExtent.ts';
import { PhotoFrame } from './PhotoStage.tsx';
import { photoViewState } from './photoView.ts';
import { SelectionFrames } from './SelectionFrames.tsx';
import { boardSizeMm } from '@hsw-editor/core';
import { DimensionLayer } from '@/widgets/DimensionLayer.tsx';
import { InvalidZones } from './invalid-zones/InvalidZones.tsx';
import { PhysicsZones } from './physics/PhysicsZones.tsx';
import { itemSolid } from './invalid-zones/itemSolid.ts';
import { describeReason, regionReasons } from './invalid-zones/reasons.ts';
import { invalidZonesEnabledStore, invalidZonesResultStore } from './invalid-zones/store.ts';
import { useInvalidZones } from './invalid-zones/useInvalidZones.ts';
import { engineScene } from './invalid-zones/wallAdapter.ts';
import { usePhysicsLive } from '@/physics/live.ts';

const GEOMETRY_WARNINGS = new Set(['cell_collision', 'out_of_board', 'cell_out_of_board']);

/** The R3F viewport for the open wall. Reads everything from the stores; sends edits through the session. */
export function WallViewport({ wall }: { readonly wall: Wall }) {
  const { t, locale } = useI18n();
  const editor = useStore(editorStore);
  const zonesEnabled = useStore(invalidZonesEnabledStore);
  const variants = useStore(variantVersion);
  const toolVersion = useStore(toolModelVersion);
  const toolAssets = useStore(toolAssetsStore);
  const photoMode = useStore(photoStore);
  const photoState = photoViewState(
    wall,
    photoMode.calibrating ? null : photoMode.photoId,
    photoMode.draft,
  );
  const photoView = photoState.status === 'ready' ? photoState.view : null;
  const theme = useStore(themeStore);
  const bankState = useStore(bankStore);
  const session = useStore(sessionStore);
  const palette = scenePalette(theme);
  const bank = useMemo(
    () => (bankState.status === 'ready' ? bankState.byId : new Map()),
    [bankState],
  );
  const size = boardSizeMm(wall.board);
  const bench = new URLSearchParams(globalThis.location?.search).has('bench');
  const showStats = new URLSearchParams(globalThis.location?.search).has('stats');

  // Exact invalid regions (overlaps, protrusions) of the real meshes, solved in a worker. A regenerated variant
  // arriving (`variants`) changes which solid an item is, so it is part of the scene's identity.
  const scene = useMemo(
    () => ({
      ...engineScene(
        wall.items,
        (item) => itemSolid(item, wall, bank, globalThis.location.href),
        editor.dragging,
      ),
      variants,
      // A tool model arriving (index loaded, size rebuilt) changes which solid a tool item is.
      toolVersion,
      toolAssets,
    }),
    [wall, bank, editor.dragging, variants, toolVersion, toolAssets],
  );
  const zones = useInvalidZones(
    zonesEnabled && bankState.status === 'ready',
    wall.board,
    scene.items,
    scene.sources,
  );
  useEffect(() => {
    invalidZonesResultStore.set(zones);
    return () => invalidZonesResultStore.set(null);
  }, [zones]);
  // Physics of the hung tools (stability, removal), re-checked off-thread when the wall changes.
  usePhysicsLive();
  // Item-level verdicts feed only the selection frame (a selected item's outline turns red): the exact regions, plus
  // the cell-based verdicts and server warnings. Models themselves are never tinted; with the zones off nothing but
  // the frame of a selected item marks them.
  const invalidIds = useMemo(() => {
    const ids = new Set<string>(zones?.reasons.map((reason) => reason.itemId));
    for (const id of layoutProblems(wall.items, wall.board, bank).keys()) ids.add(id);
    for (const warning of session?.warnings ?? []) {
      if (GEOMETRY_WARNINGS.has(warning.code)) for (const id of warning.itemIds) ids.add(id);
    }
    return ids;
  }, [zones, wall.items, wall.board, bank, session?.warnings]);
  const describeRegion = useMemo(() => {
    const nameOf = itemNamer(wall, bank, locale);
    return (region: Parameters<typeof regionReasons>[0]): string[] =>
      regionReasons(region, zones?.reasons ?? []).map((reason) => {
        const message = describeReason(reason, nameOf);
        return `${nameOf(reason.itemId)}: ${t(message.key, message.params)}`;
      });
  }, [wall, bank, locale, t, zones]);

  // Cheap (one pass over the items) and depends on the tool models, which arrive outside React state: not memoised.
  const extent = wallExtent(wall, bank);
  const overhangs =
    extent.x0 < 0 || extent.y0 < 0 || extent.x1 > size.width || extent.y1 > size.height;
  const occupied = useMemo(
    () => occupiedCells(wall.items, wall.board, bank),
    [wall.items, wall.board, bank],
  );
  const ghostElement = editor.ghost ? bank.get(editor.ghost.bankId) : undefined;

  return (
    <ViewportContextMenu
      className="absolute inset-0"
      onDragOver={(event) => {
        dragOverViewport(event.nativeEvent);
        dragOverTool(event.nativeEvent);
      }}
      onDragLeave={() => {
        leaveViewport();
        leaveToolViewport();
      }}
      onDrop={(event) => {
        dropOnViewport(event.nativeEvent);
        dropTool(event.nativeEvent);
      }}
    >
      <AttachHint />
      <PhotoFrame wall={wall} view={photoView}>
        <Canvas
          frameloop={bench ? 'always' : 'demand'}
          dpr={[1, 2]}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          onPointerMissed={(event) => {
            // Only a primary click on the background clears the selection; right-click opens the menu.
            if (event.button === 0 && editorStore.get().tool === 'select') setSelection([]);
          }}
          aria-label="3D"
        >
          <ambientLight intensity={theme === 'dark' ? 0.9 : 1.1} />
          <directionalLight position={[0.8, 1.6, 2.4]} intensity={theme === 'dark' ? 1.6 : 1.3} />
          <directionalLight position={[-1.2, 0.4, 1.2]} intensity={0.5} />
          <BridgeInstaller />
          {photoView ? <PhotoExportInstaller /> : null}
          <OmpViewportInstaller widthMm={size.width} heightMm={size.height} />
          {photoView ? (
            <PhotoCameraRig
              camera={photoView.camera}
              wallToPx={photoView.map.wallToPxMatrix}
              image={photoView.image}
            />
          ) : (
            <CameraRig
              view={editor.view}
              extent={extent}
              overhangs={overhangs}
              widthMm={size.width}
              heightMm={size.height}
              fitToken={editor.fitToken}
            />
          )}
          {photoView ? (
            <PhotoBoard board={wall.board} />
          ) : (
            <BoardMesh board={wall.board} palette={palette} occupied={occupied} />
          )}
          <ItemsLayer
            wall={wall}
            bank={bank}
            bankReady={bankState.status === 'ready'}
            palette={palette}
            onItemPointerDown={beginItemDrag}
          />
          <InvalidZones result={zones} theme={theme} describeRegion={describeRegion} />
          <PhysicsZones />
          <SelectionFrames wall={wall} bank={bank} palette={palette} invalidIds={invalidIds} />
          <MountHighlights wall={wall} bank={bank} palette={palette} />
          <PlacementMarker point={editor.placeAt} color={palette.ghostOk} />
          <DimensionLayer wall={wall} bank={bank} palette={palette} />
          {editor.ghost && ghostElement ? (
            <GhostItem
              element={ghostElement}
              xMm={editor.ghost.x}
              yMm={editor.ghost.y}
              rotZ={0}
              color={editor.ghost.valid ? palette.ghostOk : palette.ghostBad}
            />
          ) : null}
          <MeasureOverlay palette={palette} />
          {editor.tool === 'measure' ? (
            <mesh
              position={[size.width / 2000, size.height / 2000, 0.002]}
              onPointerDown={measureClick}
            >
              <planeGeometry
                args={[
                  (Math.max(size.width, 4000) / 1000) * 4,
                  (Math.max(size.height, 4000) / 1000) * 4,
                ]}
              />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          ) : null}
          {bench ? <FpsProbe /> : null}
          {showStats ? <Stats className="!left-auto !right-2 !top-14" /> : null}
        </Canvas>
      </PhotoFrame>
    </ViewportContextMenu>
  );
}
