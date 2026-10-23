import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoveHorizontalIcon } from 'lucide-react';
import type { Wall } from '@hsw-editor/core';
import { api } from '@/api/http.ts';
import { notify } from '@/features/notices/notices.ts';
import { useT } from '@/i18n/index.ts';
import { setSplit, photoStore } from '@/state/photo.ts';
import { useStore } from '@/state/react.ts';
import { PhotoAlign } from './PhotoAlign.tsx';
import { PhotoGuides } from './PhotoGuides.tsx';
import { fitBox, type Box, type PhotoView } from './photoView.ts';

function useElementSize(
  ref: React.RefObject<HTMLElement | null>,
): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** The before/after line: left of it the bare photo, right of it the photo with the HSW overlay. */
function SplitHandle({ split }: { readonly split: number }) {
  const t = useT();
  return (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
        style={{ left: `${split * 100}%` }}
      >
        <span className="absolute top-1/2 left-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-black/30 bg-white text-black shadow">
          <MoveHorizontalIcon className="size-4" aria-hidden />
        </span>
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.005}
        value={split}
        aria-label={t('photo.split.handle')}
        className="absolute inset-y-0 z-20 h-full w-10 -translate-x-1/2 cursor-ew-resize opacity-0"
        style={{ left: `${split * 100}%` }}
        onChange={(event) => setSplit(Number(event.target.value))}
      />
    </>
  );
}

/**
 * Hosts the 3D canvas. Without a photo view the canvas fills the viewport; with one it sits in a box of the
 * photo's aspect ratio, on top of the photo, so a camera with the photo's field of view lines the two up exactly.
 */
export function PhotoFrame({
  wall,
  view,
  children,
}: {
  readonly wall: Wall;
  readonly view: PhotoView | null;
  readonly children: ReactNode;
}) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const size = useElementSize(host);
  const photo = useStore(photoStore);
  const box: Box | null = view && size ? fitBox(size, view.image) : null;
  const showPhoto = view !== null && !photo.photoHidden;
  const overlayStyle =
    view === null
      ? undefined
      : {
          opacity: photo.overlayOpacity,
          clipPath: photo.split === null ? undefined : `inset(0 0 0 ${photo.split * 100}%)`,
        };

  return (
    <div ref={host} className="absolute inset-0 overflow-hidden">
      <div
        data-photo-stage={view ? view.photo.id : undefined}
        className="absolute"
        style={box ?? { inset: 0 }}
      >
        {showPhoto ? (
          <img
            src={api.photoUrl(wall.id, view.photo.id)}
            alt=""
            draggable={false}
            onError={() => notify('error', t('calibration.photo.error'))}
            className="absolute inset-0 size-full max-w-none select-none"
          />
        ) : null}
        <div className="absolute inset-0" style={overlayStyle}>
          {children}
        </div>
        {view && photo.split !== null ? <SplitHandle split={photo.split} /> : null}
        {view ? <PhotoGuides wall={wall} view={view} /> : null}
        {view ? <PhotoAlign wall={wall} view={view} /> : null}
      </div>
    </div>
  );
}
