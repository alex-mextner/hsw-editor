/** Minimal image header sniffing: type and pixel size without decoding. */
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ImageInfo {
  readonly mime: ImageMime;
  readonly ext: 'jpg' | 'png' | 'webp';
  readonly width: number;
  readonly height: number;
}

export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    return positive({
      mime: 'image/png',
      ext: 'png',
      width: view.getUint32(16),
      height: view.getUint32(20),
    });
  }
  if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) return sniffJpeg(bytes, view);
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return sniffWebp(bytes, view);
  }
  return null;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

function positive(info: ImageInfo): ImageInfo | null {
  return info.width > 0 && info.height > 0 ? info : null;
}

function sniffJpeg(bytes: Uint8Array, view: DataView): ImageInfo | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return positive({
        mime: 'image/jpeg',
        ext: 'jpg',
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      });
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

function sniffWebp(bytes: Uint8Array, view: DataView): ImageInfo | null {
  const chunk = ascii(bytes, 12, 16);
  const make = (width: number, height: number): ImageInfo | null =>
    positive({ mime: 'image/webp', ext: 'webp', width, height });
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16);
    const height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16);
    return make(width, height);
  }
  if (chunk === 'VP8 ')
    return make(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true);
    return make((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return null;
}

/** GLB container magic ("glTF"); plain .gltf needs external buffers and is not accepted. */
export function isGlb(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === 'glTF';
}
