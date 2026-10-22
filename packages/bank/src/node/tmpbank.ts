/** Test-only: builds small but fully valid bank trees (real GLBs whose bounds match the index). */
import { Document, NodeIO } from '@gltf-transform/core';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BANK_CATEGORIES } from '../categories.ts';
import type { BankElement } from '../schema.ts';
import { makeElement, type ElementSpec } from '../testing.ts';
import { TOOL_CLASSES } from '../toolClasses.ts';
import type { PublishResult } from './generations.ts';
import { BANK_GRID, bankPaths, type BankPaths } from './paths.ts';
import { composeIndex } from './compose.ts';
import { adoptBank, writeIndexFiles } from './publish.ts';
import { sha256Hex } from './hash.ts';

/** A box GLB spanning exactly `min`..`max` (mm), unquantised, so bounds checks are exact. */
async function boxGlb(
  min: [number, number, number],
  max: [number, number, number],
): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const corners: number[] = [];
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push(x, y, z);
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array(corners))
    .setBuffer(buffer);
  const indices = doc
    .createAccessor()
    .setType('SCALAR')
    .setArray(
      new Uint16Array([
        0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1,
        5, 7, 1, 7, 3,
      ]),
    )
    .setBuffer(buffer);
  const primitive = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices);
  const mesh = doc.createMesh().addPrimitive(primitive);
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

export interface FixtureElement {
  id: string;
  element: BankElement;
  /** Asset paths this element references (glb, thumbnail). */
  glb: string;
  thumbnail: string;
}

/** Writes a valid flat bank (index, search index, glb/, thumb/) with `ids` as elements into `root`. */
export async function writeFixtureBank(
  root: string,
  ids: readonly string[],
  options: {
    unavailable?: { id: string; reason: string }[];
    /** Overrides for the fixture element with this id (names, tags, tool classes...). */
    specs?: Record<string, Partial<ElementSpec>>;
    /** Ids whose GLB is 5 mm wider than the index's bboxMm says (bounds drift). */
    drift?: string[];
  } = {},
): Promise<FixtureElement[]> {
  await mkdir(join(root, 'glb'), { recursive: true });
  await mkdir(join(root, 'thumb'), { recursive: true });
  const built: FixtureElement[] = [];
  for (const [i, id] of ids.entries()) {
    const dims: [number, number, number] = [40 + i, 30 + i, 20 + i];
    const base = makeElement({
      id,
      ru: `Элемент ${id}`,
      en: `Element ${id}`,
      category: 'holders/screwdrivers',
      dims,
      ...options.specs?.[id],
    });
    const glbBytes = await boxGlb(
      [base.bboxMm.min.x, base.bboxMm.min.y, base.bboxMm.min.z],
      [
        base.bboxMm.max.x + (options.drift?.includes(id) ? 5 : 0),
        base.bboxMm.max.y,
        base.bboxMm.max.z,
      ],
    );
    const thumbBytes = new TextEncoder().encode(`thumb:${id}`);
    const glbHash = sha256Hex(glbBytes);
    const thumbHash = sha256Hex(thumbBytes);
    const glb = `glb/${glbHash.slice(0, 16)}.glb`;
    const thumbnail = `thumb/${thumbHash.slice(0, 16)}.webp`;
    await Bun.write(join(root, glb), glbBytes);
    await Bun.write(join(root, thumbnail), thumbBytes);
    const element: BankElement = {
      ...base,
      assets: {
        lod0: { path: glb, bytes: glbBytes.length, sha256: glbHash },
        lod1: { path: glb, bytes: glbBytes.length, sha256: glbHash },
        thumbnail: { path: thumbnail, bytes: thumbBytes.length, sha256: thumbHash },
        triangles: { lod0: 12, lod1: 12 },
      },
    };
    built.push({ id, element, glb, thumbnail });
  }
  const index = composeIndex({
    grid: BANK_GRID,
    categories: [...BANK_CATEGORIES],
    toolClasses: [...TOOL_CLASSES],
    elements: built.map((b) => b.element),
    unavailable: (options.unavailable ?? []).map((u) => ({
      id: u.id,
      name: { ru: u.id, en: u.id },
      reason: u.reason,
    })),
  });
  await writeIndexFiles(root, index);
  return built;
}

export interface Scratch {
  work: string;
  paths: BankPaths;
  /** Builds a flat fixture bank with `ids` and publishes it as a new generation (`label` names the source dir). */
  publishFixture(
    ids: string[],
    label: number,
  ): Promise<{
    source: string;
    built: FixtureElement[];
    publish: PublishResult;
  }>;
}

/** A private bank dir + seed dir under the OS temp dir; the caller removes `work` afterwards. */
export async function createScratch(): Promise<Scratch> {
  const work = await mkdtemp(join(tmpdir(), 'bank-scratch-'));
  const paths: BankPaths = {
    ...bankPaths({ HSW_BANK_DIR: join(work, 'bank'), HSW_EDITOR_CACHE_DIR: join(work, 'cache') }),
    seedDir: join(work, 'seed'),
  };
  await mkdir(paths.bankDir, { recursive: true });
  return {
    work,
    paths,
    async publishFixture(ids, label) {
      const source = join(work, `src-${label}`);
      const built = await writeFixtureBank(source, ids);
      const { publish } = await adoptBank(paths, source, { keep: 3 });
      return { source, built, publish };
    },
  };
}
