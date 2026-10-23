/**
 * PNG export of the photo composite: the wall photo with the HSW overlay (board, items, zone stripes) drawn over it
 * at the overlay opacity, and a banner like the reference picture. The overlay comes from the live 3D canvas, so
 * the PNG is exactly what the viewport shows.
 */
import type { ImageSize } from '@hsw-editor/overlay';

/** Draws the current 3D frame onto a fresh canvas (null when no photo view is mounted). */
export type OverlayRenderer = () => HTMLCanvasElement | null;

let renderer: OverlayRenderer | null = null;

export function setOverlayRenderer(next: OverlayRenderer | null): void {
  renderer = next;
}

export function renderOverlay(): HTMLCanvasElement | null {
  return renderer?.() ?? null;
}

/** Longest side of the exported PNG, px: phone photos are bigger than anyone needs to share. */
export const MAX_EXPORT_SIDE = 2048;

/** Export size: the photo's size, scaled down to `MAX_EXPORT_SIDE`. */
export function exportSize(image: ImageSize): ImageSize {
  const scale = Math.min(1, MAX_EXPORT_SIDE / Math.max(image.width, image.height));
  return { width: Math.round(image.width * scale), height: Math.round(image.height * scale) };
}

/** `Kitchen wall` + `overlay.png` -> `kitchen-wall-overlay.png`: safe on every file system. */
export function exportFileName(wallName: string): string {
  const slug = wallName
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug === '' ? 'wall' : slug}-overlay.png`;
}

export interface BannerText {
  readonly title: string;
  readonly subtitle: string;
}

/** Banner geometry in export pixels, proportional to the image so it reads the same on any size. */
export function bannerBox(size: ImageSize): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly titlePx: number;
  readonly subtitlePx: number;
} {
  const unit = size.width / 40;
  return {
    x: unit / 2,
    y: unit / 2,
    width: size.width - unit,
    height: unit * 2.6,
    titlePx: unit * 0.8,
    subtitlePx: unit * 0.55,
  };
}

export function composeExport(
  photo: CanvasImageSource | null,
  overlay: CanvasImageSource,
  size: ImageSize,
  overlayOpacity: number,
  banner: BannerText,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, size.width, size.height);
  if (photo) ctx.drawImage(photo, 0, 0, size.width, size.height);
  ctx.globalAlpha = overlayOpacity;
  ctx.drawImage(overlay, 0, 0, size.width, size.height);
  ctx.globalAlpha = 1;
  const box = bannerBox(size);
  ctx.fillStyle = 'rgba(14, 22, 36, 0.92)';
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  ctx.font = `600 ${box.titlePx}px system-ui, sans-serif`;
  ctx.fillText(
    banner.title,
    box.x + box.titlePx * 0.8,
    box.y + box.titlePx * 0.5,
    box.width - box.titlePx * 1.6,
  );
  ctx.fillStyle = '#c9d1dc';
  ctx.font = `${box.subtitlePx}px system-ui, sans-serif`;
  ctx.fillText(
    banner.subtitle,
    box.x + box.titlePx * 0.8,
    box.y + box.titlePx * 1.9,
    box.width - box.titlePx * 1.6,
  );
  return canvas;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const { promise, resolve, reject } = Promise.withResolvers<HTMLImageElement>();
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('the photo could not be loaded'));
  image.src = url;
  return promise;
}

/** The composite as a PNG blob. */
export async function exportComposite(options: {
  readonly photoUrl: string;
  readonly image: ImageSize;
  readonly overlayOpacity: number;
  readonly photoHidden: boolean;
  readonly banner: BannerText;
}): Promise<Blob> {
  const overlay = renderOverlay();
  if (!overlay) throw new Error('the photo view is not shown');
  const photo = options.photoHidden ? null : await loadImage(options.photoUrl);
  const canvas = composeExport(
    photo,
    overlay,
    exportSize(options.image),
    options.overlayOpacity,
    options.banner,
  );
  const { promise, resolve } = Promise.withResolvers<Blob | null>();
  canvas.toBlob(resolve, 'image/png');
  const blob = await promise;
  if (!blob) throw new Error('the PNG could not be encoded');
  return blob;
}
