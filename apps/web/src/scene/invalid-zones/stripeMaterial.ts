/**
 * Red diagonal-stripe material for invalid regions: MeshStandardMaterial (so the red keeps the form-giving lighting)
 * with a fragment hook that cuts a 45 degree, screen-space, anti-aliased stripe pattern into the colour and alpha.
 *
 * Why the pattern is the primary cue: stripes alternate the lit red with a neutral (white on dark UI, near black on
 * light UI), so the zone is recognisable by luminance contrast and shape even without colour vision; the red is the
 * second cue. Screen-space stripes keep a constant ~6 px period at any zoom, on any instance, so the material works
 * unchanged on instanced meshes and on a photo overlay (no UVs, no object-space dependency).
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

export interface StripeLook {
  readonly stripe: string;
  readonly gap: string;
}

const LOOKS: Record<StripeTheme, StripeLook> = {
  dark: { stripe: '#ff3b3b', gap: '#ffffff' },
  light: { stripe: '#d00f1a', gap: '#14141a' },
};

/** Gap colour under white stripes (the legend swatch in `InvalidZonesLegend.tsx` mirrors it). */
const WHITE_STRIPE_GAP = '#14141a';

/** CSS pixels between two stripe centres, measured perpendicular to the stripes. */
export const STRIPE_PERIOD_PX = 6;

export interface StripeOptions {
  readonly theme: StripeTheme;
  /** `false`: the surface pass (normal depth test). `true`: the faint see-through pass for hidden parts. */
  readonly xray: boolean;
}

interface StripeUniforms {
  uPeriodPx: { value: number };
  uGapColor: { value: Color };
  uGapColorOnWhite: { value: Color };
  uStripeAlpha: { value: number };
  uGapAlpha: { value: number };
}

export interface StripeMaterial extends MeshStandardMaterial {
  userData: { stripe: StripeUniforms };
}

/** Fragment hook, exported so tests can assert it targets a chunk three.js still ships. */
export const STRIPE_FRAGMENT = /* glsl */ `
  float stripePhase = (gl_FragCoord.x + gl_FragCoord.y) / (uPeriodPx * 1.41421356);
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

export function createStripeMaterial({ theme, xray }: StripeOptions): StripeMaterial {
  const look = LOOKS[theme];
  const uniforms: StripeUniforms = {
    uPeriodPx: { value: STRIPE_PERIOD_PX },
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
  material.userData = { stripe: uniforms };
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        'uniform float uPeriodPx;\nuniform vec3 uGapColor;\nuniform vec3 uGapColorOnWhite;\nuniform float uStripeAlpha;\nuniform float uGapAlpha;\nvoid main() {',
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${STRIPE_DIFFUSE}`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${STRIPE_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => `invalid-stripes-${xray ? 'x' : 's'}`;
  return material;
}

/** Sets the stripe period for the device pixel ratio so it stays ~6 CSS px on hi-dpi screens. */
export function setStripeDpr(material: StripeMaterial, dpr: number): void {
  material.userData.stripe.uPeriodPx.value = STRIPE_PERIOD_PX * dpr;
}
