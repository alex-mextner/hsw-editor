/**
 * PBR materials (glTF metallic-roughness). Colours are sRGB hex in the API and linear floats in
 * `baseColor` (what glTF stores). `kind` is semantic (used by the renderer, the photo colour sampler and
 * the UI); `grip` hints the surface texture of a handle even when it is not modelled as geometry.
 */
export type MaterialKind =
  | 'metal'
  | 'plastic'
  | 'rubber'
  | 'wood'
  | 'paint'
  | 'glass'
  | 'paper'
  | 'fabric';
export type GripTexture = 'smooth' | 'knurl' | 'ribbed' | 'soft-grip' | 'checkered' | 'leather';

export interface Material {
  name: string;
  kind: MaterialKind;
  /** sRGB hex of the base colour, `#rrggbb`. */
  color: string;
  metallic: number;
  roughness: number;
  /** 1 = opaque. */
  alpha: number;
  grip?: GripTexture;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`bad colour: ${hex}`);
  const v = Number.parseInt(m[1] as string, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number): string =>
    Math.round(Math.max(0, Math.min(255, x)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

const srgbToLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export function linearColor(hex: string, alpha = 1): [number, number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), alpha];
}

export function shadeColor(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * factor, g * factor, b * factor);
}

const metal = (name: string, color: string, roughness: number, metallic = 1): Material => ({
  name,
  kind: 'metal',
  color,
  metallic,
  roughness,
  alpha: 1,
});

/** Fixed material library (finishes of metal parts). */
export const METALS = {
  steel: metal('steel', '#b9bcc1', 0.34),
  polishedSteel: metal('polished steel', '#d3d6da', 0.16),
  chrome: metal('chrome', '#dfe2e6', 0.07),
  chromeVanadium: metal('chrome vanadium', '#c4c7cc', 0.24),
  blackOxide: metal('black oxide', '#26272a', 0.42, 0.9),
  zinc: metal('zinc plated', '#a8aeb4', 0.4),
  brass: metal('brass', '#c9a24a', 0.3),
  copper: metal('copper', '#c0734a', 0.3),
  aluminium: metal('aluminium', '#c6c9ce', 0.38),
  darkSteel: metal('dark steel', '#5d6066', 0.45),
  castIron: metal('cast iron', '#3b3c3f', 0.7, 0.8),
} as const satisfies Record<string, Material>;

export function plastic(color: string, roughness = 0.42, name = 'plastic'): Material {
  return { name, kind: 'plastic', color, metallic: 0, roughness, alpha: 1 };
}

export function glossyPlastic(color: string, name = 'glossy plastic'): Material {
  return { name, kind: 'plastic', color, metallic: 0, roughness: 0.18, alpha: 1 };
}

export function translucentPlastic(
  color: string,
  alpha = 0.72,
  name = 'translucent plastic',
): Material {
  return { name, kind: 'plastic', color, metallic: 0, roughness: 0.14, alpha };
}

export function rubber(color: string, grip: GripTexture = 'soft-grip', name = 'rubber'): Material {
  return { name, kind: 'rubber', color, metallic: 0, roughness: 0.82, alpha: 1, grip };
}

export function paint(color: string, roughness = 0.38, name = 'paint'): Material {
  return { name, kind: 'paint', color, metallic: 0.05, roughness, alpha: 1 };
}

export const WOODS = {
  beech: '#c89a62',
  oak: '#b08650',
  walnut: '#6b4a32',
  pine: '#d6b072',
  ash: '#d2b98a',
  hickory: '#b9925e',
  varnished: '#a56a38',
} as const;
export type WoodSpecies = keyof typeof WOODS;

export function wood(species: WoodSpecies = 'beech', roughness = 0.6): Material {
  return {
    name: `wood ${species}`,
    kind: 'wood',
    color: WOODS[species],
    metallic: 0,
    roughness,
    alpha: 1,
  };
}

export const GLASS: Material = {
  name: 'glass',
  kind: 'glass',
  color: '#cfe3ea',
  metallic: 0,
  roughness: 0.05,
  alpha: 0.35,
};

/** Dark LCD / display glass. */
export const SCREEN: Material = {
  name: 'screen',
  kind: 'glass',
  color: '#8fa38a',
  metallic: 0,
  roughness: 0.1,
  alpha: 1,
};

export const WHITE_PAPER: Material = {
  name: 'label',
  kind: 'paper',
  color: '#ece8dc',
  metallic: 0,
  roughness: 0.75,
  alpha: 1,
};

/** Named colours of common tool plastics, used as defaults and for the photo colour snapper. */
export const TOOL_COLORS = {
  red: '#c8262b',
  orange: '#e8741e',
  yellow: '#f0c326',
  green: '#2f8f4c',
  blue: '#2455a8',
  black: '#1b1c1e',
  grey: '#6c7077',
  white: '#ece9e2',
  clear: '#d8e4ea',
} as const;
export type ToolColorName = keyof typeof TOOL_COLORS;

/** Nearest named tool colour for a sampled sRGB colour (CIE-ish weighted RGB distance). */
export function nearestToolColor(hex: string): ToolColorName {
  const [r, g, b] = hexToRgb(hex);
  let best: ToolColorName = 'grey';
  let bestD = Infinity;
  for (const [name, h] of Object.entries(TOOL_COLORS) as [ToolColorName, string][]) {
    const [r2, g2, b2] = hexToRgb(h);
    const rm = (r + r2) / 2;
    const d =
      (2 + rm / 256) * (r - r2) ** 2 + 4 * (g - g2) ** 2 + (2 + (255 - rm) / 256) * (b - b2) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}
