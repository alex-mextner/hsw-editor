import { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Stats } from '@react-three/drei';
import type { Wall } from '@hsw-editor/core';
import { ViewportContextMenu } from '@/features/viewport/ViewportContextMenu.tsx';
import { api } from '@/api/http.ts';
import { bankStore } from '@/bank/client.ts';
import { useT } from '@/i18n/index.ts';
import { editorStore, setSelection } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { themeStore } from '@/state/theme.ts';
import { layoutProblems, occupiedCells } from '@/wall/footprint.ts';
import { sessionStore } from '@/wall/session.ts';
import { BoardMesh } from './BoardMesh.tsx';
import { BridgeInstaller } from './BridgeInstaller.tsx';
import { CameraRig } from './CameraRig.tsx';
import { dragOverViewport, dropOnViewport, leaveViewport } from './bankDrop.ts';
import { beginItemDrag } from './dragController.ts';
import { FpsProbe } from './FpsProbe.tsx';
import { GhostItem } from './GhostItem.tsx';
import { ItemsLayer } from './ItemsLayer.tsx';
import { measureClick, MeasureOverlay } from './MeasureTool.tsx';
import { ModelBoundary } from './ModelBoundary.tsx';
import { scenePalette } from './palette.ts';
import { PlacementMarker } from './PlacementMarker.tsx';
import { PhotoOverlay } from './PhotoOverlay.tsx';
import { SelectionFrames } from './SelectionFrames.tsx';
import { boardSizeMm } from '@hsw-editor/core';
import { DimensionLayer } from '@/widgets/DimensionLayer.tsx';

const GEOMETRY_WARNINGS = new Set(['cell_collision', 'out_of_board', 'cell_out_of_board']);

/** The R3F viewport for the open wall. Reads everything from the stores; sends edits through the session. */
export function WallViewport({ wall }: { readonly wall: Wall }) {
  const t = useT();
  const editor = useStore(editorStore);
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

  const invalidIds = useMemo(() => {
    const ids = new Set<string>(layoutProblems(wall.items, wall.board, bank).keys());
    for (const warning of session?.warnings ?? []) {
      if (GEOMETRY_WARNINGS.has(warning.code)) for (const id of warning.itemIds) ids.add(id);
    }
    return ids;
  }, [wall.items, wall.board, bank, session?.warnings]);

  const occupied = useMemo(
    () => occupiedCells(wall.items, wall.board, bank),
    [wall.items, wall.board, bank],
  );
  const ghostElement = editor.ghost ? bank.get(editor.ghost.bankId) : undefined;

  return (
    <ViewportContextMenu
      className="absolute inset-0"
      onDragOver={(event) => dragOverViewport(event.nativeEvent)}
      onDragLeave={leaveViewport}
      onDrop={(event) => dropOnViewport(event.nativeEvent)}
    >
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
        <CameraRig
          view={editor.view}
          widthMm={size.width}
          heightMm={size.height}
          fitToken={editor.fitToken}
        />
        <BoardMesh board={wall.board} palette={palette} occupied={occupied} />
        {editor.overlay.photoId ? (
          // A photo that fails to load must not blank the viewport: draw nothing, toast once.
          <ModelBoundary
            url={api.photoUrl(wall.id, editor.overlay.photoId)}
            name={t('asset.photo')}
            placeholder={() => null}
          >
            <PhotoOverlay
              wall={wall}
              photoId={editor.overlay.photoId}
              opacity={editor.overlay.opacity}
            />
          </ModelBoundary>
        ) : null}
        <ItemsLayer
          wall={wall}
          bank={bank}
          bankReady={bankState.status === 'ready'}
          palette={palette}
          invalidIds={invalidIds}
          onItemPointerDown={beginItemDrag}
        />
        <SelectionFrames wall={wall} bank={bank} palette={palette} invalidIds={invalidIds} />
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
    </ViewportContextMenu>
  );
}
