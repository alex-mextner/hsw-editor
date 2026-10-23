import { beforeAll, describe, expect, test } from 'bun:test';
import { DEFAULT_BOARD, PoseSchema } from '@hsw-editor/core';
import { InvalidZoneEngine, type EngineItem, type SolidMesh } from './engine.ts';
import { loadManifold, type ManifoldToplevel } from './manifold.ts';
import { buildRegionBatch } from './regionGeometry.ts';
import {
  chooseStripeColour,
  colourAt,
  isRedish,
  type ColourPart,
  type Rgb,
} from './stripeColour.ts';

const hex = (value: string): Rgb => [
  Number.parseInt(value.slice(1, 3), 16) / 255,
  Number.parseInt(value.slice(3, 5), 16) / 255,
  Number.parseInt(value.slice(5, 7), 16) / 255,
];

describe('isRedish', () => {
  test.each(['#d62020', '#ff0000', '#b01818', '#e0403a', '#ff4d00', '#c2185b', '#8b1a1a'])(
    '%s is red-ish',
    (colour) => expect(isRedish(hex(colour))).toBe(true),
  );

  test.each([
    '#ffffff',
    '#808080',
    '#101010',
    '#2f6fdb',
    '#2ca02c',
    '#f2c200',
    '#8a8a86',
    '#c9b8b8',
    '#2a0505',
  ])('%s is not', (colour) => expect(isRedish(hex(colour))).toBe(false));
});

describe('chooseStripeColour', () => {
  const red = hex('#d62020');
  const grey = hex('#808080');

  test('red base gives white stripes', () => {
    expect(chooseStripeColour([red, red, red])).toBe('white');
  });

  test('anything else keeps the default red stripes', () => {
    expect(chooseStripeColour([grey, grey])).toBe('red');
    expect(chooseStripeColour([hex('#2f6fdb')])).toBe('red');
  });

  test('a region mostly on a grey shaft stays red, mostly on a red handle goes white', () => {
    expect(chooseStripeColour([grey, grey, grey, red])).toBe('red');
    expect(chooseStripeColour([grey, red, red, red])).toBe('white');
  });

  test('unknown colours are ignored; with nothing known the default stays', () => {
    expect(chooseStripeColour([null, red, null])).toBe('white');
    expect(chooseStripeColour([null, null])).toBe('red');
    expect(chooseStripeColour([])).toBe('red');
  });
});

describe('colourAt', () => {
  const shaft: ColourPart = { min: [-2, -2, 0], max: [2, 2, 60], rgb: [0.5, 0.5, 0.5] };
  const handle: ColourPart = { min: [-8, -8, 60], max: [8, 8, 120], rgb: [0.8, 0.1, 0.1] };

  test('picks the part containing the point, the nearest part outside, and null without parts', () => {
    expect(colourAt([shaft, handle], 0, 0, 30)).toEqual(shaft.rgb);
    expect(colourAt([shaft, handle], 7, 7, 100)).toEqual(handle.rgb);
    expect(colourAt([shaft, handle], 20, 0, 90)).toEqual(handle.rgb);
    expect(colourAt([], 0, 0, 0)).toBeNull();
  });

  test('where boxes overlap the smaller one wins (a rod running into a handle)', () => {
    const rod: ColourPart = { min: [-1, -1, 50], max: [1, 1, 90], rgb: [0.5, 0.5, 0.5] };
    expect(colourAt([handle, rod], 0, 0, 70)).toEqual(rod.rgb);
    expect(colourAt([handle, rod], 6, 6, 70)).toEqual(handle.rgb);
  });
});

describe('engine regions carry the stripe colour', () => {
  let wasm: ManifoldToplevel;
  beforeAll(async () => {
    wasm = await loadManifold();
  });

  const cube = (colours?: readonly ColourPart[]): SolidMesh => ({
    positions: Float32Array.from([
      -10, -10, 0, 10, -10, 0, 10, 10, 0, -10, 10, 0, -10, -10, 20, 10, -10, 20, 10, 10, 20, -10,
      10, 20,
    ]),
    indices: Uint32Array.from([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3,
      0, 4, 3, 4, 7,
    ]),
    ...(colours ? { colours } : {}),
  });
  const whole = (rgb: Rgb): ColourPart => ({ min: [-10, -10, 0], max: [10, 10, 20], rgb });
  const item = (id: string, solidKey: string, x: number): EngineItem => ({
    id,
    kind: 'holder',
    solidKey,
    pose: PoseSchema.parse({ x, y: 100 }),
  });

  function stripesOf(a: SolidMesh, b: SolidMesh): readonly string[] {
    const engine = new InvalidZoneEngine(wasm);
    engine.defineSolid('a', { kind: 'mesh', mesh: a });
    engine.defineSolid('b', { kind: 'mesh', mesh: b });
    const result = engine.solve(DEFAULT_BOARD, [item('x', 'a', 100), item('y', 'b', 110)]);
    engine.dispose();
    return result.regions.map((region) => region.stripe);
  }

  test('two red-handled tools overlap: white stripes; grey ones, uncoloured ones: red', () => {
    const red = cube([whole(hex('#d62020'))]);
    const grey = cube([whole(hex('#808080'))]);
    expect(stripesOf(red, red)).toEqual(['white']);
    expect(stripesOf(grey, grey)).toEqual(['red']);
    expect(stripesOf(cube(), cube())).toEqual(['red']);
  });

  test('colours are looked up in the item frame, also for a rotated item', () => {
    // Only the thin y 5..10 strip of the tool is red. Turned 90 degrees about z that strip faces -x in the wall, and
    // the other item reaches into exactly it: white. Read without the rotation the overlap would sit on the grey part.
    const grey = hex('#808080');
    const stripRed = cube([
      { min: [-10, -10, 0], max: [10, 5, 20], rgb: grey },
      { min: [-10, 5, 0], max: [10, 10, 20], rgb: hex('#d62020') },
    ]);
    const engine = new InvalidZoneEngine(wasm);
    engine.defineSolid('turned', { kind: 'mesh', mesh: stripRed });
    engine.defineSolid('plain', { kind: 'mesh', mesh: cube() });
    const turned: EngineItem = {
      ...item('t', 'turned', 100),
      pose: PoseSchema.parse({ x: 100, y: 100, rotZ: 90 }),
    };
    const plain: EngineItem = {
      ...item('p', 'plain', 85),
      pose: PoseSchema.parse({ x: 85, y: 100 }),
    };
    const result = engine.solve(DEFAULT_BOARD, [turned, plain]);
    engine.dispose();
    expect(result.regions.map((region) => region.stripe)).toEqual(['white']);
  });

  test('the region geometry carries the choice per vertex for the stripe material', () => {
    const engine = new InvalidZoneEngine(wasm);
    engine.defineSolid('red', { kind: 'mesh', mesh: cube([whole(hex('#d62020'))]) });
    engine.defineSolid('grey', { kind: 'mesh', mesh: cube([whole(hex('#808080'))]) });
    const white = engine.solve(DEFAULT_BOARD, [item('x', 'red', 100), item('y', 'red', 110)]);
    const red = engine.solve(DEFAULT_BOARD, [item('x', 'grey', 100), item('y', 'grey', 110)]);
    engine.dispose();
    const whiteBatch = buildRegionBatch(white.regions, 0.001);
    const redBatch = buildRegionBatch(red.regions, 0.001);
    expect(whiteBatch?.geometry.getAttribute('color').getX(0)).toBe(0);
    expect(redBatch?.geometry.getAttribute('color').getX(0)).toBe(1);
  });
});
