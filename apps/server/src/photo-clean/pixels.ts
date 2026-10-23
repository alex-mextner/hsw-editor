/** Pixel I/O for the background clean: decode a stored photo, encode the cleaned variant, build the AI canvas. */
import sharp from 'sharp';
import type { DrawSize } from '@hsw-editor/draw';

export interface Pixels {
  readonly width: number;
  readonly height: number;
  /** Interleaved RGB, 3 bytes per pixel. */
  readonly data: Uint8Array;
}

export async function readPixels(source: string | Uint8Array): Promise<Pixels> {
  const { data, info } = await sharp(source)
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export async function encodeJpeg(pixels: Pixels): Promise<Uint8Array> {
  const buffer = await sharp(pixels.data, {
    raw: { width: pixels.width, height: pixels.height, channels: 3 },
  })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return new Uint8Array(buffer);
}

export async function encodePng(
  data: Uint8Array,
  width: number,
  height: number,
  channels: 1 | 3,
): Promise<Uint8Array> {
  const buffer = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
  return new Uint8Array(buffer);
}

/** Where the photo sits on the square-ish canvas an image model works on. */
export interface Placement {
  readonly size: DrawSize;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const CANVASES: readonly { size: DrawSize; width: number; height: number }[] = [
  { size: '1024x1024', width: 1024, height: 1024 },
  { size: '1536x1024', width: 1536, height: 1024 },
  { size: '1024x1536', width: 1024, height: 1536 },
];

/** The allowed canvas whose shape is closest to the photo's, with the photo fitted inside it (contain, centred). */
export function placeOnCanvas(width: number, height: number): Placement {
  const aspect = width / height;
  const canvas = CANVASES.reduce((best, candidate) =>
    Math.abs(Math.log(candidate.width / candidate.height / aspect)) <
    Math.abs(Math.log(best.width / best.height / aspect))
      ? candidate
      : best,
  );
  const scale = Math.min(canvas.width / width, canvas.height / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return {
    size: canvas.size,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    x: Math.floor((canvas.width - w) / 2),
    y: Math.floor((canvas.height - h) / 2),
    width: w,
    height: h,
  };
}

/** `pixels` scaled into its place on a mid-grey canvas, as a PNG. */
export async function canvasPng(
  pixels: Pixels | { width: number; height: number; data: Uint8Array; channels: 1 | 3 },
  placement: Placement,
): Promise<Uint8Array> {
  const channels = 'channels' in pixels ? pixels.channels : 3;
  const resized = await sharp(pixels.data, {
    raw: { width: pixels.width, height: pixels.height, channels },
  })
    .resize(placement.width, placement.height, { fit: 'fill' })
    .toBuffer();
  const background = channels === 1 ? { r: 0, g: 0, b: 0 } : { r: 128, g: 128, b: 128 };
  const buffer = await sharp({
    create: {
      width: placement.canvasWidth,
      height: placement.canvasHeight,
      channels: 3,
      background,
    },
  })
    .composite([
      {
        input: resized,
        raw: { width: placement.width, height: placement.height, channels },
        left: placement.x,
        top: placement.y,
      },
    ])
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

/** The model's answer cropped back to the photo's own frame and size. */
export async function uncanvas(
  imagePath: string,
  placement: Placement,
  width: number,
  height: number,
): Promise<Pixels> {
  // sharp applies one resize per pipeline, so the frame is cut out first and scaled in a second pass.
  const framed = await sharp(imagePath)
    .removeAlpha()
    .resize(placement.canvasWidth, placement.canvasHeight, { fit: 'fill' })
    .png()
    .toBuffer();
  const photo = await sharp(framed)
    .extract({
      left: placement.x,
      top: placement.y,
      width: placement.width,
      height: placement.height,
    })
    .png()
    .toBuffer();
  const scaled = await sharp(photo)
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width, height, data: new Uint8Array(scaled.data) };
}
