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

/**
 * `pixels` scaled into its place on a canvas of `background` colour, as a PNG. Always three channels: a one-channel
 * raw input does not composite onto an RGB canvas in sharp (it comes out as stripes), so masks are expanded to grey RGB
 * by `greyPixels` first.
 */
export async function canvasPng(
  pixels: Pixels,
  placement: Placement,
  background: { r: number; g: number; b: number } = { r: 128, g: 128, b: 128 },
): Promise<Uint8Array> {
  const resized = await sharp(pixels.data, {
    raw: { width: pixels.width, height: pixels.height, channels: 3 },
  })
    .resize(placement.width, placement.height, { fit: 'fill' })
    .raw()
    .toBuffer();
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
        raw: { width: placement.width, height: placement.height, channels: 3 },
        left: placement.x,
        top: placement.y,
      },
    ])
    .removeAlpha()
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

/** A one-byte-per-pixel mask (0 / non-zero) as grey RGB pixels: white where set, black elsewhere. */
export function maskPixels(mask: Uint8Array, width: number, height: number): Pixels {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const value = mask[i] ? 255 : 0;
    data[i * 3] = value;
    data[i * 3 + 1] = value;
    data[i * 3 + 2] = value;
  }
  return { width, height, data };
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
