/**
 * Solids and rigid bodies for the daemon's physics: bank element GLBs (holders, board parts) and generated or library
 * tools, decoded once and cached. The decoding is the one the editor does (`@hsw-editor/physics/glb`), so the report
 * the daemon gives is the report the page would compute.
 */
import { join } from 'node:path';
import type { BankElement, VariantResponse } from '@hsw-editor/bank';
import type { Wall, WallItem } from '@hsw-editor/core';
import { readGlbSolid, readToolBody, type GlbSolid } from '@hsw-editor/physics/glb';
import type { ToolBody } from '@hsw-editor/physics';
import { applyPatch, exportGlb, generate, hasToolClass, type ToolModel } from '@hsw-editor/tools';
import { ToolStore } from '@hsw-editor/tools/node';
import type { ManifoldToplevel } from 'manifold-3d';
import { bankContextFor } from '../bank-user.ts';

/** Only the path of a URL is used to reach the in-process bank handler; the origin is never contacted. */
const IN_PROCESS_ORIGIN = 'http://bank.invalid';
/** Decoded solids kept per cache; a wall rarely uses more than a few dozen distinct elements and tools. */
const CACHE_LIMIT = 200;
/** LOD 1 is what the physics needs: the 0.5 mm column grid cannot see LOD 0's knurling and threads. */
const TOOL_LOD = 1;

/** Why a tool item cannot be judged (the `reason` of a `skipped` entry). */
export type SkipReason = 'no_model' | 'no_physics';

class Lru<V> {
  private readonly entries = new Map<string, V>();

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    const oldest = this.entries.keys().next();
    if (this.entries.size > CACHE_LIMIT && !oldest.done) this.entries.delete(oldest.value);
  }
}

let manifold: Promise<ManifoldToplevel> | null = null;

/** The manifold-3d WASM, loaded on first use and shared by every analysis (bun finds the `.wasm` in node_modules). */
export function loadManifold(): Promise<ManifoldToplevel> {
  manifold ??= import('manifold-3d').then(async ({ default: Module }) => {
    const wasm = await Module();
    wasm.setup();
    return wasm;
  });
  manifold.catch(() => {
    manifold = null;
  });
  return manifold;
}

/** A bank element as the physics sees it: the record and its decoded mesh in the element's root frame. */
export interface ElementSolid {
  readonly element: BankElement;
  readonly solid: GlbSolid;
}

function stableParamsKey(params: Readonly<Record<string, number>>): string {
  return Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

/** How a tool item is built: a registered class generator (with the item's dimension params) or a library tool. */
type ToolSource =
  | { readonly kind: 'class'; readonly classId: string; readonly params: Record<string, number> }
  | { readonly kind: 'library'; readonly toolId: string };

/**
 * Mirrors how the editor picks the model of a tool item: the model's `by` says `tool:<id>` (the user's library) or
 * `gen:<class>`; otherwise the item's tool class names the generator. Preset boxes of classes without a generator
 * have no geometry to judge.
 */
export function toolSourceOf(item: WallItem, wall: Wall): ToolSource | null {
  const model =
    item.modelRefId === undefined ? undefined : wall.models.find((m) => m.id === item.modelRefId);
  const by = model?.source.type === 'library' ? model.source.by : undefined;
  if (by?.startsWith('tool:') === true)
    return { kind: 'library', toolId: by.slice('tool:'.length) };
  const candidates = [
    by?.startsWith('gen:') === true ? by.slice('gen:'.length) : undefined,
    item.toolClass,
    model?.toolClass,
  ];
  const classId = candidates.find((c): c is string => c !== undefined && hasToolClass(c));
  return classId === undefined ? null : { kind: 'class', classId, params: { ...item.params } };
}

export class PhysicsAssets {
  private readonly solids = new Lru<Promise<GlbSolid>>();
  private readonly bodies = new Lru<Promise<ToolBody | null>>();
  private readonly library: ToolStore;

  constructor(private readonly home: string) {
    this.library = new ToolStore(join(home, 'tools'));
  }

  /** The mesh of a bank element at the item's dimensions, or null when the element is not in the served bank. */
  async elementSolid(
    bankId: string,
    params: Readonly<Record<string, number>>,
  ): Promise<ElementSolid | null> {
    const { handler } = bankContextFor(this.home);
    const reply = await handler(
      new Request(`${IN_PROCESS_ORIGIN}/api/bank/elements/${encodeURIComponent(bankId)}`),
    );
    if (reply === null || reply.status !== 200) return null;
    const element = (await reply.json()) as BankElement;
    let path = `/bank/assets/${element.assets.lod0.path}`;
    if (Object.keys(params).length > 0) {
      // A failed regeneration keeps the base model, as the editor does.
      const variant = await handler(
        new Request(
          `${IN_PROCESS_ORIGIN}/api/bank/elements/${encodeURIComponent(bankId)}/variant`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ params }),
          },
        ),
      );
      if (variant !== null && variant.status === 200) {
        const regenerated = (await variant.json()) as VariantResponse;
        path = new URL(regenerated.glbUrl, IN_PROCESS_ORIGIN).pathname;
      }
    }
    // Asset names are content hashes: the path is a sound cache key.
    let solid = this.solids.get(path);
    if (solid === undefined) {
      solid = this.decode(handler, path);
      this.solids.set(path, solid);
      // A failed decode is retried by the next analysis, not remembered.
      solid.catch(() => this.solids.delete(path));
    }
    return { element, solid: await solid };
  }

  private async decode(
    handler: (request: Request) => Promise<Response | null>,
    path: string,
  ): Promise<GlbSolid> {
    const reply = await handler(new Request(`${IN_PROCESS_ORIGIN}${path}`));
    if (reply === null || reply.status !== 200) throw new Error(`bank asset ${path} is not served`);
    return readGlbSolid(await reply.arrayBuffer());
  }

  /** The tool as a rigid body (mesh, mass, centre of gravity, hang point), or why there is none. */
  async toolBody(item: WallItem, wall: Wall): Promise<{ body: ToolBody } | { skip: SkipReason }> {
    const source = toolSourceOf(item, wall);
    if (source === null) return { skip: 'no_model' };
    const built =
      source.kind === 'class'
        ? await this.cached(`class|${source.classId}|${stableParamsKey(source.params)}`, () =>
            this.fromModel(generate(source.classId, source.params, TOOL_LOD)),
          )
        : await this.libraryBody(source.toolId);
    return built === null ? { skip: 'no_physics' } : { body: { ...built, id: item.id } };
  }

  private cached(key: string, make: () => Promise<ToolBody | null>): Promise<ToolBody | null> {
    let body = this.bodies.get(key);
    if (body === undefined) {
      body = make();
      this.bodies.set(key, body);
      body.catch(() => this.bodies.delete(key));
    }
    return body;
  }

  /** Keyed by `updatedAt`, so an edit in the Tool Library is seen by the next analysis. */
  private async libraryBody(toolId: string): Promise<ToolBody | null> {
    const tool = await this.library.get(toolId).catch(() => null);
    if (tool === null) return null;
    return this.cached(`library|${toolId}|${tool.updatedAt}`, async () => {
      const stored = await this.library.file(toolId, 'glbLod1');
      const glb = await Bun.file(stored.path)
        .arrayBuffer()
        .catch(() => null);
      // Tools stored before the GLB carried its mass are rebuilt from the tool document.
      return (
        (glb === null ? null : await readToolBody(toolId, glb)) ??
        this.fromModel(applyPatch(tool, {}).modelLod1)
      );
    });
  }

  private fromModel(model: ToolModel): Promise<ToolBody | null> {
    return readToolBody(model.classId, toArrayBuffer(exportGlb(model)));
  }
}
