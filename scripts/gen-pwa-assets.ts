/**
 * Renders the PWA raster assets from `apps/web/public/icon.svg` into `apps/web/public/icons/`:
 * install icons (192/512, maskable 512), the iOS home-screen icon and the iOS startup (splash) images.
 * The PNGs are committed; run `bun run pwa:assets` after changing the logo. CI never runs this.
 *
 * The logo is two shapes in a 64x64 box (a dark rounded square and an amber hexagon). Install icons that must
 * not be masked (`any`) keep the rounded square; the maskable and iOS icons are full-bleed (the OS applies its
 * own mask) with the hexagon inside the central safe zone.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(import.meta.dir, '..');
const out = resolve(root, 'apps/web/public/icons');
mkdirSync(out, { recursive: true });

const BACKGROUND = '#0a0a0a';
const HEXAGON =
  '<path d="M32 10l19 11v22L32 54 13 43V21z" fill="none" stroke="#f59e0b" stroke-width="4"/>';

function render(svg: string, width: number): Uint8Array {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
}

function save(name: string, svg: string, width: number): void {
  writeFileSync(resolve(out, name), render(svg, width));
  console.info(`wrote icons/${name}`);
}

/** The logo as is: rounded square with transparent corners. */
const anySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="${BACKGROUND}"/>${HEXAGON}</svg>`;

/** Full-bleed background, hexagon scaled into the central 80% (maskable safe zone). */
function fullBleed(scale: number): string {
  const offset = (64 - 64 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${BACKGROUND}"/><g transform="translate(${offset} ${offset}) scale(${scale})">${HEXAGON}</g></svg>`;
}

save('icon-192.png', anySvg, 192);
save('icon-512.png', anySvg, 512);
save('icon-maskable-512.png', fullBleed(0.8), 512);
// iOS draws its own rounded corners and rejects transparency (it paints it black).
save('apple-touch-icon-180.png', fullBleed(0.9), 180);

/** iPhone portrait startup images: CSS size, pixel ratio (the `media` query in index.html uses the same table). */
export const IPHONE_SPLASH = [
  { w: 440, h: 956, r: 3 },
  { w: 402, h: 874, r: 3 },
  { w: 430, h: 932, r: 3 },
  { w: 393, h: 852, r: 3 },
  { w: 428, h: 926, r: 3 },
  { w: 390, h: 844, r: 3 },
  { w: 375, h: 812, r: 3 },
  { w: 414, h: 896, r: 3 },
  { w: 414, h: 896, r: 2 },
  { w: 414, h: 736, r: 3 },
  { w: 375, h: 667, r: 2 },
] as const;

for (const { w, h, r } of IPHONE_SPLASH) {
  const width = w * r;
  const height = h * r;
  const logo = Math.round(Math.min(width, height) * 0.28);
  const x = Math.round((width - logo) / 2);
  const y = Math.round((height - logo) / 2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${BACKGROUND}"/><svg x="${x}" y="${y}" width="${logo}" height="${logo}" viewBox="0 0 64 64">${HEXAGON}</svg></svg>`;
  save(`splash-${width}x${height}.png`, svg, width);
}
