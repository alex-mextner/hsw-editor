import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { MaximizeIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import { IconButton } from '@/components/IconButton.tsx';
import { useT } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import {
  fitView,
  imageToScreen,
  panBy,
  pinch,
  scaleLimits,
  screenToImage,
  zoomAt,
  type Point2,
  type Size,
  type ViewTransform,
} from './calibrationView.ts';

export interface Marker {
  readonly point: Point2;
  readonly label: string;
}

interface CalibrationViewerProps {
  readonly src: string;
  /** Pixel size of the photo: marker and overlay coordinates are in these pixels. */
  readonly image: Size;
  readonly markers: readonly Marker[];
  /** Extra points (e.g. the reprojected honeycomb grid), drawn small and not draggable. */
  readonly overlay?: readonly Point2[];
  /** Closed outlines in photo pixels (e.g. the board as the calibration places it), drawn thin over the photo. */
  readonly outlines?: readonly (readonly Point2[])[];
  /** A click that was not a drag; omitted = read-only viewer. */
  readonly onPlace?: (point: Point2) => void;
  readonly onMove?: (index: number, point: Point2) => void;
  readonly className?: string;
}

/** A press that moves less than this is a click, not the start of a pan. */
const CLICK_SLOP_PX = 4;
const WHEEL_SENSITIVITY = 0.0018;
const BUTTON_ZOOM = 1.4;

interface PanState {
  readonly start: Point2;
  readonly view: ViewTransform;
  readonly moved: boolean;
}

interface PinchState {
  readonly start: ViewTransform;
  readonly mid: Point2;
  readonly distance: number;
}

function clampToImage(point: Point2, image: Size): Point2 {
  return [
    Math.min(Math.max(point[0], 0), image.width),
    Math.min(Math.max(point[1], 0), image.height),
  ];
}

function midpoint(a: Point2, b: Point2): Point2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

const ARROW_STEPS: Readonly<Record<string, Point2>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Zoom/pan photo viewer with draggable point markers; wheel zooms at the cursor, two fingers pinch. */
export function CalibrationViewer({
  src,
  image,
  markers,
  overlay,
  outlines,
  onPlace,
  onMove,
  className,
}: CalibrationViewerProps) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  /** The user's own zoom/pan; until there is one, the view follows the fitted photo. */
  const [custom, setCustom] = useState<ViewTransform | null>(null);
  const [failed, setFailed] = useState(false);
  const pointers = useRef(new Map<number, Point2>());
  const pan = useRef<PanState | null>(null);
  const pinching = useRef<PinchState | null>(null);
  const draggingMarker = useRef<number | null>(null);

  const measured = size !== null && size.width > 0 && size.height > 0 ? size : null;
  const view = custom ?? (measured ? fitView(measured, image) : null);
  const limits = measured ? scaleLimits(measured, image) : { min: 0.01, max: 40 };

  // The wheel listener is registered once; it reads the latest view through this ref.
  const latest = useRef({ view, limits });
  useEffect(() => {
    latest.current = { view, limits };
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // React registers wheel listeners as passive, which cannot stop the page from scrolling.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { view: current, limits: bounds } = latest.current;
      if (!current) return;
      const rect = host.getBoundingClientRect();
      const lines = event.deltaMode === 1 ? 16 : 1;
      setCustom(
        zoomAt(
          current,
          [event.clientX - rect.left, event.clientY - rect.top],
          Math.exp(-event.deltaY * lines * WHEEL_SENSITIVITY),
          bounds,
        ),
      );
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, []);

  const zoomFromCentre = (factor: number): void => {
    if (view && measured) {
      setCustom(zoomAt(view, [measured.width / 2, measured.height / 2], factor, limits));
    }
  };

  const local = (event: PointerEvent): Point2 => {
    const rect = hostRef.current?.getBoundingClientRect();
    return [event.clientX - (rect?.left ?? 0), event.clientY - (rect?.top ?? 0)];
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!view || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, local(event));
    const [a, b] = [...pointers.current.values()];
    if (a && b) {
      pan.current = null;
      pinching.current = {
        start: view,
        mid: midpoint(a, b),
        distance: Math.hypot(a[0] - b[0], a[1] - b[1]),
      };
    } else if (a) {
      pan.current = { start: a, view, moved: false };
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, local(event));
    const [a, b] = [...pointers.current.values()];
    const gesture = pinching.current;
    if (gesture && a && b) {
      setCustom(
        pinch(
          gesture.start,
          { mid: gesture.mid, distance: gesture.distance },
          { mid: midpoint(a, b), distance: Math.hypot(a[0] - b[0], a[1] - b[1]) },
          limits,
        ),
      );
      return;
    }
    const drag = pan.current;
    if (!drag || !a) return;
    const dx = a[0] - drag.start[0];
    const dy = a[1] - drag.start[1];
    const moved = drag.moved || Math.hypot(dx, dy) > CLICK_SLOP_PX;
    pan.current = { ...drag, moved };
    if (moved) setCustom(panBy(drag.view, dx, dy));
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    pinching.current = null;
    pan.current = null;
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const position = pointers.current.get(event.pointerId);
    pointers.current.delete(event.pointerId);
    pinching.current = null;
    const drag = pan.current;
    pan.current = null;
    if (!drag || drag.moved || !position || !view || !onPlace) return;
    const point = screenToImage(view, position);
    if (point[0] >= 0 && point[1] >= 0 && point[0] <= image.width && point[1] <= image.height) {
      onPlace(point);
    }
  };

  const moveMarker = (index: number, point: Point2): void =>
    onMove?.(index, clampToImage(point, image));

  const onMarkerKey = (index: number, marker: Marker, event: KeyboardEvent): void => {
    const step = ARROW_STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    const stride = event.shiftKey ? 10 : 1;
    moveMarker(index, [marker.point[0] + step[0] * stride, marker.point[1] + step[1] * stride]);
  };

  const screenMarkers = view ? markers.map((marker) => imageToScreen(view, marker.point)) : [];
  const [first, second] = screenMarkers;

  return (
    <div
      ref={hostRef}
      className={cn(
        'relative touch-none overflow-hidden rounded-md border border-border bg-viewport select-none',
        onPlace ? 'cursor-crosshair' : 'cursor-grab',
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {view ? (
        <img
          src={src}
          alt={t('calibration.photo')}
          draggable={false}
          onError={() => setFailed(true)}
          className="absolute top-0 left-0 max-w-none"
          style={{
            width: image.width,
            height: image.height,
            transformOrigin: '0 0',
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            imageRendering: view.scale > 4 ? 'pixelated' : 'auto',
          }}
        />
      ) : null}
      {failed ? (
        <p
          role="alert"
          className="absolute inset-0 grid place-items-center p-4 text-sm text-destructive"
        >
          {t('calibration.photo.error')}
        </p>
      ) : null}

      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
        {outlines && view
          ? outlines.map((outline, index) => (
              <polygon
                key={index}
                points={outline.map((point) => imageToScreen(view, point).join(',')).join(' ')}
                className="fill-primary/10 stroke-primary"
                strokeWidth={1.5}
              />
            ))
          : null}
        {overlay && view
          ? overlay.map((point, index) => {
              const [x, y] = imageToScreen(view, point);
              return (
                <circle
                  key={index}
                  cx={x}
                  cy={y}
                  r={2.5}
                  className="fill-ok/70 stroke-background"
                  strokeWidth={0.5}
                />
              );
            })
          : null}
        {first && second ? (
          <line
            x1={first[0]}
            y1={first[1]}
            x2={second[0]}
            y2={second[1]}
            className="stroke-primary"
            strokeWidth={1.5}
            strokeDasharray="5 4"
          />
        ) : null}
      </svg>

      {markers.map((marker, index) => {
        const position = screenMarkers[index];
        if (!position) return null;
        return (
          <button
            key={index}
            type="button"
            disabled={!onMove}
            aria-label={t('calibration.handle', { label: marker.label })}
            className="group absolute top-0 left-0 grid size-7 cursor-grab place-items-center rounded-full outline-none disabled:cursor-default"
            style={{ transform: `translate(${position[0] - 14}px, ${position[1] - 14}px)` }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              draggingMarker.current = index;
            }}
            onPointerMove={(event) => {
              if (draggingMarker.current !== index || !view) return;
              moveMarker(index, screenToImage(view, local(event)));
            }}
            onPointerUp={() => {
              draggingMarker.current = null;
            }}
            onKeyDown={(event) => onMarkerKey(index, marker, event)}
          >
            <span className="size-3.5 rounded-full border-2 border-primary bg-primary/25 group-focus-visible:ring-3 group-focus-visible:ring-ring/60" />
            <span className="absolute bottom-full left-1/2 -translate-x-1/2 rounded bg-background/80 px-1 text-[11px] leading-4 font-medium text-foreground">
              {marker.label}
            </span>
          </button>
        );
      })}

      <div
        className="absolute top-2 right-2 flex gap-1 rounded-lg border border-border bg-popover/90 p-0.5 shadow-sm"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <IconButton
          label={t('calibration.zoomIn')}
          size="icon-xs"
          onClick={() => zoomFromCentre(BUTTON_ZOOM)}
        >
          <ZoomInIcon />
        </IconButton>
        <IconButton
          label={t('calibration.zoomOut')}
          size="icon-xs"
          onClick={() => zoomFromCentre(1 / BUTTON_ZOOM)}
        >
          <ZoomOutIcon />
        </IconButton>
        <IconButton label={t('calibration.fit')} size="icon-xs" onClick={() => setCustom(null)}>
          <MaximizeIcon />
        </IconButton>
      </div>
    </div>
  );
}
