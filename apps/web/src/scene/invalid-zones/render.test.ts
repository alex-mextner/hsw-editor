import { describe, expect, test } from 'bun:test';
import { ShaderChunk } from 'three';
import type { RegionMesh } from './engine.ts';
import { describeReason, formatMm, reasonsByItem } from './reasons.ts';
import { buildRegionBatch, regionsSignature } from './regionGeometry.ts';
import { invalidZonesEn, invalidZonesRu } from '@/i18n/catalog/invalidZones.ts';
import { STRIPE_FRAGMENT, createStripeMaterial } from './stripeMaterial.ts';

const region = (key: string, vertices: number, triangles: number): RegionMesh => ({
  key,
  geometryKey: `${key}@0`,
  kind: 'overlap',
  itemIds: ['a', 'b'],
  positions: Float32Array.from({ length: vertices * 3 }, (_, i) => i),
  indices: Uint32Array.from({ length: triangles * 3 }, (_, i) => i % vertices),
  edges: Float32Array.from({ length: 12 }, (_, i) => i),
  stripe: 'red',
});

describe('buildRegionBatch', () => {
  test('returns null without triangles', () => {
    expect(buildRegionBatch([], 0.001)).toBeNull();
  });

  test('merges regions, offsets indices, scales to scene units and maps triangles back', () => {
    const first = region('r1', 4, 2);
    const second = region('r2', 5, 3);
    const batch = buildRegionBatch([first, second], 0.001);
    if (!batch) throw new Error('expected a batch');
    const positions = batch.geometry.getAttribute('position');
    expect(positions.count).toBe(9);
    expect(positions.getX(1)).toBeCloseTo(0.003, 9);
    // both regions' outlines are merged and scaled too
    expect(batch.edges.getAttribute('position').count).toBe(8);
    expect(batch.edges.getAttribute('position').getX(1)).toBeCloseTo(0.003, 9);
    const index = batch.geometry.getIndex();
    expect(index?.count).toBe(15);
    // second region's first index is offset by the first region's 4 vertices
    expect(index?.getX(6)).toBe(4);
    expect(batch.regionOfTriangle(0)?.key).toBe('r1');
    expect(batch.regionOfTriangle(1)?.key).toBe('r1');
    expect(batch.regionOfTriangle(2)?.key).toBe('r2');
    expect(batch.regionOfTriangle(4)?.key).toBe('r2');
  });
});

describe('regionsSignature', () => {
  test('is the region ids plus operand keys: stable for clones, different when an operand moved', () => {
    const a = region('r1', 4, 2);
    expect(regionsSignature([a])).toBe(
      regionsSignature([{ ...a, positions: Float32Array.from(a.positions) }]),
    );
    expect(regionsSignature([{ ...a, geometryKey: 'r1@moved' }])).not.toBe(regionsSignature([a]));
    expect(regionsSignature([])).toBe('');
  });
});

describe('stripe material', () => {
  test('the shader hooks target chunks and anchors that exist in this three.js version', () => {
    expect(ShaderChunk.opaque_fragment).toContain('gl_FragColor');
    expect(ShaderChunk.meshphysical_frag).toContain('#include <opaque_fragment>');
    expect(ShaderChunk.meshphysical_frag).toContain('#include <color_fragment>');
    expect(ShaderChunk.color_fragment).toContain('vColor');
    expect(ShaderChunk.meshphysical_frag).toContain('void main() {');
    expect(STRIPE_FRAGMENT).toContain('gl_FragCoord');
  });

  test('surface and see-through passes differ only in depth handling and strength', () => {
    const surface = createStripeMaterial({ theme: 'dark', xray: false });
    const hidden = createStripeMaterial({ theme: 'dark', xray: true });
    expect(surface.polygonOffset).toBe(true);
    expect(hidden.polygonOffset).toBe(false);
    expect(surface.depthFunc).not.toBe(hidden.depthFunc);
    expect(surface.depthWrite).toBe(false);
    expect(hidden.userData.stripe.uStripeAlpha.value).toBeLessThan(
      surface.userData.stripe.uStripeAlpha.value,
    );
    expect(surface.customProgramCacheKey()).not.toBe(hidden.customProgramCacheKey());
  });
});

describe('reasons', () => {
  test('messages carry the measured numbers, shallow ones with two decimals', () => {
    expect(formatMm(0.123)).toBe('0.12');
    expect(formatMm(4.2)).toBe('4.2');
    const overlap = describeReason(
      { kind: 'overlap', itemId: 'a', otherId: 'h3', depthMm: 4.2, volumeMm3: 10 },
      (id) => `Holder ${id}`,
    );
    expect(overlap).toEqual({
      key: 'invalid.overlap',
      params: { other: 'Holder h3', depth: '4.2' },
    });
    const out = describeReason(
      { kind: 'out-of-board', itemId: 'a', side: 'behind-wall', extentMm: 2, volumeMm3: 1 },
      String,
    );
    expect(out.key).toBe('invalid.out.behindWall');
  });

  test('every message key exists in both locales with the same placeholders', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, en] of Object.entries(invalidZonesEn)) {
      const ru = (invalidZonesRu as Record<string, string>)[key];
      expect(ru).toBeDefined();
      expect(placeholders(ru ?? '')).toEqual(placeholders(en));
    }
  });

  test('groups by item', () => {
    const grouped = reasonsByItem([
      { kind: 'overlap', itemId: 'a', otherId: 'b', depthMm: 1, volumeMm3: 1 },
      { kind: 'overlap', itemId: 'b', otherId: 'a', depthMm: 1, volumeMm3: 1 },
      { kind: 'out-of-board', itemId: 'a', side: 'top', extentMm: 1, volumeMm3: 1 },
    ]);
    expect(grouped.get('a')).toHaveLength(2);
    expect(grouped.get('b')).toHaveLength(1);
  });
});
