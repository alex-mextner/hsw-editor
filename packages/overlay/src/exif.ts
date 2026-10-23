/**
 * Just enough EXIF for photo intake: the orientation tag and the 35 mm-equivalent focal length of a JPEG. A phone
 * photo stores its pixels as the sensor read them and says "rotate me" in EXIF; every pixel coordinate in this
 * package is in the ORIENTED image, so intake bakes the rotation in once and re-encodes without the tag.
 */

export interface ExifInfo {
  /** 1..8 as in the EXIF spec; 1 = upright, also the value when the tag is absent or unreadable. */
  orientation: number;
  /** FocalLengthIn35mmFilm in mm, when present. */
  focal35mm?: number;
}

const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_FOCAL_35MM = 0xa405;

/** Reads the EXIF block of a JPEG. Never throws: damaged or absent EXIF yields the defaults. */
export function readJpegExif(bytes: Uint8Array): ExifInfo {
  const fallback: ExifInfo = { orientation: 1 };
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return fallback;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return fallback;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Start of scan / end of image: no EXIF after this point.
    if (marker === 0xda || marker === 0xd9) return fallback;
    const length = view.getUint16(offset + 2);
    if (length < 2) return fallback;
    if (marker === 0xe1 && isExifHeader(bytes, offset + 4)) {
      return parseTiff(view, offset + 10, Math.min(offset + 2 + length, bytes.length)) ?? fallback;
    }
    offset += 2 + length;
  }
  return fallback;
}

function isExifHeader(bytes: Uint8Array, at: number): boolean {
  return (
    bytes[at] === 0x45 &&
    bytes[at + 1] === 0x78 &&
    bytes[at + 2] === 0x69 &&
    bytes[at + 3] === 0x66 &&
    bytes[at + 4] === 0 &&
    bytes[at + 5] === 0
  );
}

function parseTiff(view: DataView, tiff: number, end: number): ExifInfo | null {
  if (tiff + 8 > end) return null;
  const order = view.getUint16(tiff);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return null;
  if (view.getUint16(tiff + 2, little) !== 42) return null;
  const info: ExifInfo = { orientation: 1 };

  const readIfd = (ifd: number, visit: (tag: number, valueAt: number) => void): void => {
    if (ifd < 0 || tiff + ifd + 2 > end) return;
    const count = view.getUint16(tiff + ifd, little);
    for (let i = 0; i < count; i++) {
      const entry = tiff + ifd + 2 + i * 12;
      if (entry + 12 > end) return;
      visit(view.getUint16(entry, little), entry + 8);
    }
  };

  let exifIfd = -1;
  readIfd(view.getUint32(tiff + 4, little), (tag, valueAt) => {
    if (tag === TAG_ORIENTATION) {
      const value = view.getUint16(valueAt, little);
      if (value >= 1 && value <= 8) info.orientation = value;
    } else if (tag === TAG_EXIF_IFD) {
      exifIfd = view.getUint32(valueAt, little);
    }
  });
  readIfd(exifIfd, (tag, valueAt) => {
    if (tag === TAG_FOCAL_35MM) {
      const value = view.getUint16(valueAt, little);
      if (value > 0) info.focal35mm = value;
    }
  });
  return info;
}

/** Pixel size after applying an EXIF orientation: orientations 5..8 swap the axes. */
export function orientedSize(
  width: number,
  height: number,
  orientation: number,
): { width: number; height: number } {
  return orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

/**
 * Canvas 2D transform `[a, b, c, d, e, f]` (as for `ctx.setTransform`) that draws a raw `width` x `height` image
 * upright for an EXIF orientation.
 */
export function orientationTransform(
  orientation: number,
  width: number,
  height: number,
): readonly [number, number, number, number, number, number] {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, width, 0];
    case 3:
      return [-1, 0, 0, -1, width, height];
    case 4:
      return [1, 0, 0, -1, 0, height];
    case 5:
      return [0, 1, 1, 0, 0, 0];
    case 6:
      return [0, 1, -1, 0, height, 0];
    case 7:
      return [0, -1, -1, 0, height, width];
    case 8:
      return [0, -1, 1, 0, 0, width];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/** Size that fits `maxLongSide` while keeping the aspect ratio; never upscales. */
export function fitLongSide(
  width: number,
  height: number,
  maxLongSide: number,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxLongSide) return { width, height };
  const k = maxLongSide / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}
