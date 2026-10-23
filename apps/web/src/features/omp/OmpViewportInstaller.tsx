import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { PerspectiveCamera, Vector3 } from 'three';
import type { ViewportCapture } from '@hsw-editor/omp-protocol';
import { mm } from '@/scene/units.ts';
import { editorStore, patchEditor, setSelection } from '@/state/editor.ts';
import { sessionStore } from '@/wall/session.ts';
import { registerViewportBridge } from './viewport-bridge.ts';

const CAPTURE_FOV_MARGIN = 0.62;

interface OrbitLike {
  readonly target: Vector3;
  update(): void;
}

function isOrbitLike(controls: unknown): controls is OrbitLike {
  return (
    typeof controls === 'object' &&
    controls !== null &&
    'target' in controls &&
    'update' in controls
  );
}

/** Two animation frames: enough for a demand-driven canvas to render after `invalidate()` / a state change. */
function settle(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/**
 * Exposes selection and screenshots of the live canvas to the omp agent tools (`wall_get`, `wall_select`,
 * `wall_view`). Must be mounted inside the R3F `<Canvas>`.
 */
export function OmpViewportInstaller({
  widthMm,
  heightMm,
}: {
  readonly widthMm: number;
  readonly heightMm: number;
}) {
  const getState = useThree((state) => state.get);

  useEffect(
    () =>
      registerViewportBridge({
        getSelection: () => editorStore.get().selection,
        select(ids) {
          const known = new Set(sessionStore.get()?.wall?.items.map((item) => item.id));
          const next = ids.filter((id) => known.has(id));
          setSelection(next);
          return next;
        },
        async capture({ view, maxSidePx }): Promise<ViewportCapture> {
          const restore: (() => void)[] = [];
          const viewBefore = editorStore.get().view;
          if (view === 'front' && viewBefore !== 'front') {
            patchEditor({ view: 'front' });
            restore.push(() => patchEditor({ view: viewBefore }));
            await settle();
          }
          if (view === 'iso') {
            if (viewBefore !== 'perspective') {
              patchEditor({ view: 'perspective' });
              restore.push(() => patchEditor({ view: viewBefore }));
              await settle();
            }
            const { camera, controls, size } = getState();
            if (camera instanceof PerspectiveCamera && isOrbitLike(controls)) {
              const saved = { position: camera.position.clone(), target: controls.target.clone() };
              const centre = new Vector3(mm(widthMm / 2), mm(heightMm / 2), 0);
              const tan = Math.tan((camera.fov * Math.PI) / 360);
              const aspect = size.width / Math.max(size.height, 1);
              const distance = Math.max(
                (mm(heightMm) * CAPTURE_FOV_MARGIN) / tan,
                (mm(widthMm) * CAPTURE_FOV_MARGIN) / (tan * aspect),
              );
              camera.position.set(
                centre.x + distance * 0.55,
                centre.y + distance * 0.3,
                distance * 0.85,
              );
              controls.target.copy(centre);
              controls.update();
              restore.push(() => {
                camera.position.copy(saved.position);
                controls.target.copy(saved.target);
                controls.update();
              });
            }
          }
          try {
            getState().invalidate();
            await settle();
            const { gl, scene, camera } = getState();
            // Read the drawing buffer in the same task as the render: no preserveDrawingBuffer needed.
            gl.render(scene, camera);
            const source = gl.domElement;
            const scale = Math.min(1, maxSidePx / Math.max(source.width, source.height));
            const width = Math.max(1, Math.round(source.width * scale));
            const height = Math.max(1, Math.round(source.height * scale));
            const output = document.createElement('canvas');
            output.width = width;
            output.height = height;
            const context = output.getContext('2d');
            if (context === null) throw new Error('2D canvas is unavailable');
            context.drawImage(source, 0, 0, width, height);
            const dataUrl = output.toDataURL('image/png');
            return {
              mimeType: 'image/png',
              dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
              width,
              height,
            };
          } finally {
            for (const undo of restore.reverse()) undo();
            getState().invalidate();
          }
        },
      }),
    [getState, widthMm, heightMm],
  );

  return null;
}
