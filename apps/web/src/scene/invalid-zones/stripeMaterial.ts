/**
 * Diagonal-stripe material for marked zones: MeshStandardMaterial (so the colour keeps the form-giving lighting)
 * with a fragment hook that cuts a screen-space, anti-aliased stripe pattern into the colour and alpha.
 *
Two looks share the one shader. `invalid` (default): red over a neutral (white on dark UI, near black on light UI),
 * "\" diagonal, ~6 px period: a geometry overlap or protrusion. `physics`: amber over a dark neutral, the OPPOSITE
 * "/" diagonal and a wider ~9 px period: a tool that hangs badly. Direction, period and the neutral differ so the two
 * can never be mistaken for each other, in colour or in monochrome.
 *
 * Why the pattern is the primary cue: stripes alternate the lit colour with a neutral, so the zone is recognisable by
 * luminance contrast and shape even without colour vision; the hue is the second cue. Screen-space stripes keep a
 * constant period at any zoom, on any instance, so the material works unchanged on instanced meshes and on a photo
 * overlay (no UVs, no object-space dependency).
 *
 * Regions on red-ish material (red screwdriver handles) would lose red stripes: the geometry's `color` attribute
 * (1 = red, 0 = white, see `regionGeometry.ts`) switches those vertices to WHITE stripes over a dark gap.
 */
import {
  Color,
  FrontSide,
  GreaterDepth,
  LessEqualDepth,
  MeshStandardMaterial,
  type WebGLProgramParametersWithUniforms,
} from 'three';

export type StripeTheme = 'dark' | 'light';

/** `invalid`: red "\" stripes of geometry problems; `physics`: amber "/" stripes of hang problems. */
export type StripeVariant = 'invalid' | 'physics';

export interface StripeLook {
  readonly stripe: string;
  readonly gap: string;
  /** +1: lines of constant x + y ("\"); -1: constant x - y ("/"), in window coordinates. */
  readonly direction: 1 | -1;
  /** CSS pixels between two stripe centres, measured perpendicular to the stripes. */
  readonly periodPx: number;
}

const LOOKS: Record<StripeVariant, Record<StripeTheme, StripeLook>> = {
  invalid: {
    dark: { stripe: '#ff3b3b', gap: '#ffffff', direction: 1, periodPx: 6 },
    light: { stripe: '#d00f1a', gap: '#14141a', direction: 1, periodPx: 6 },
  },
  physics: {
    dark: { stripe: '#f5a524', gap: '#1b1b22', direction: -1, periodPx: 9 },
    light: { stripe: '#e08a00', gap: '#14141a', direction: -1, periodPx: 9 },
  },
};

/** Gap colour under white stripes (the legend swatch in `InvalidZonesLegend.tsx` mirrors it). */
const WHITE_STRIPE_GAP = '#14141a';

/** CSS pixels between two stripe centres of the invalid-zone (red) look. */
export const STRIPE_PERIOD_PX = LOOKS.invalid.dark.periodPx;

export interface StripeOptions {
  readonly theme: StripeTheme;
  /** `false`: the surface pass (normal depth test). `true`: the faint see-through pass for hidden parts. */
  readonly xray: boolean;
  /** Defaults to the red invalid-zone look. */
  readonly variant?: StripeVariant;
}

interface StripeUniforms {
  uPeriodPx: { value: number };
  uDirection: { value: number };
  uGapColor: { value: Color };
  uGapColorOnWhite: { value: Color };
  uStripeAlpha: { value: number };
  uGapAlpha: { value: number };
}

export interface StripeMaterial extends MeshStandardMaterial {
  userData: { stripe: StripeUniforms; basePeriodPx: number };
}

/** Fragment hook, exported so tests can assert it targets a chunk three.js still ships. */
export const STRIPE_FRAGMENT = /* glsl */ `
  float stripePhase = (gl_FragCoord.x + uDirection * gl_FragCoord.y) / (uPeriodPx * 1.41421356);
  float stripeTri = abs(fract(stripePhase) - 0.5) * 2.0;
  float stripeAa = max(fwidth(stripeTri) * 0.75, 1e-4);
  float stripeMask = smoothstep(0.5 - stripeAa, 0.5 + stripeAa, stripeTri);
  vec3 stripeGap = mix(uGapColorOnWhite, uGapColor, vColor.r);
  vec3 stripeRgb = mix(mix(outgoingLight, stripeGap, 0.6), outgoingLight, stripeMask);
  float stripeA = mix(uGapAlpha, uStripeAlpha, stripeMask);
  gl_FragColor = vec4(stripeRgb, stripeA);
`;

/** Replaces the diffuse colour of white-striped vertices (vColor.r = 0) before lighting. */
export const STRIPE_DIFFUSE = /* glsl */ `
  diffuseColor.rgb = mix(vec3(1.0), diffuse, vColor.r);
`;

export function createStripeMaterial({
  theme,
  xray,
  variant = 'invalid',
}: StripeOptions): StripeMaterial {
  const look = LOOKS[variant][theme];
  const uniforms: StripeUniforms = {
    uPeriodPx: { value: look.periodPx },
    uDirection: { value: look.direction },
    uGapColor: { value: new Color(look.gap) },
    // White stripes need a dark gap on either theme (the default white gap would swallow them).
    uGapColorOnWhite: { value: new Color(WHITE_STRIPE_GAP) },
    // The see-through pass is fainter so hidden overlaps hint through the model without hiding it.
    uStripeAlpha: { value: xray ? 0.4 : 0.82 },
    uGapAlpha: { value: xray ? 0.1 : 0.22 },
  };
  const material = new MeshStandardMaterial({
    color: look.stripe,
    vertexColors: true,
    roughness: 0.55,
    metalness: 0,
    flatShading: true,
    side: FrontSide,
    transparent: true,
    depthWrite: false,
    depthFunc: xray ? GreaterDepth : LessEqualDepth,
    // Pull the surface pass towards the camera so it wins against the coplanar surface it marks.
    polygonOffset: !xray,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }) as StripeMaterial;
  material.userData = { stripe: uniforms, basePeriodPx: look.periodPx };
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
'uniform float uPeriodPx;\nuniform float uDirection;\nuniform vec3 uGapColor;\nuniform vec3 uGapColorOnWhite;\nuniform float uStripeAlpha;\nuniform float uGapAlpha;\nvoid main() {',
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${STRIPE_DIFFUSE}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${STRIPE_FRAGMENT}`);
  };
  // The look is baked into uniforms only, but the program is shared per pass: one cache key per pass is enough.
  material.customProgramCacheKey = () => `stripes-${variant}-${xray ? 'x' : 's'}`;
  return material;
}

/** Sets the stripe period for the device pixel ratio so it keeps its CSS-pixel size on hi-dpi screens. */
export function setStripeDpr(material: StripeMaterial, dpr: number): void {
  material.userData.stripe.uPeriodPx.value = material.userData.basePeriodPx * dpr;
}
