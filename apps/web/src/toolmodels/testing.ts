/** Fixtures for the tool model tests: a real asset index entry built from a real generator, and a synchronous worker stand-in. */
import {
  boundsCentre,
  boundsDims,
  buildWallToolModel,
  exportGlb,
  getToolClass,
  holdingSummary,
  toolAssetId,
  type ToolAssetEntry,
  type ToolAssetIndex,
} from '@hsw-editor/tools';
import { indexState, type ToolAssetsState } from './assets.ts';
import { regenerate } from './regenCore.ts';
import type { FromRegenWorker, ObjectUrls, RegenPort, ToRegenWorker } from './regen.ts';

/** The index entry of the default build of `classId`, as the server's store would write it (paths are placeholders of the right shape). */
export function classEntry(classId: string, bankClass: string): ToolAssetEntry {
  const built = buildWallToolModel(classId, {});
  const file = (suffix: string, size: number, triangles: number) => ({
    path: `glb/${built.hash.slice(0, 15)}${suffix}.glb`,
    size,
    triangles,
  });
  return {
    id: `class:${classId}`,
    kind: 'class',
    classId,
    bankClass,
    values: built.values,
    paramHash: built.hash,
    dimsMm: boundsDims(built.lod0.bounds),
    centreMm: boundsCentre(built.lod0.bounds),
    holding: holdingSummary(built.lod0),
    lod0: file('0', exportGlb(built.lod0).byteLength, built.lod0.triangles),
    lod1: file('1', exportGlb(built.lod1).byteLength, built.lod1.triangles),
  };
}

/** The tool asset index of the classes the showcase wall uses, built from the real generators. */
export function showcaseToolIndex(classIds: readonly string[]): ToolAssetIndex {
  return {
    schemaVersion: 1,
    contentHash: '0123456789abcdef',
    entries: [...new Set(classIds)].map((id) => classEntry(id, getToolClass(id).bankClass)),
    unavailable: [],
  };
}

export function userToolEntry(id: string, from: ToolAssetEntry): ToolAssetEntry {
  return {
    ...from,
    id: toolAssetId(id),
    kind: 'tool',
    values: null,
    lod0: { ...from.lod0, path: 'glb/aaaaaaaaaaaaaaa0.glb' },
    lod1: { ...from.lod1, path: 'glb/aaaaaaaaaaaaaaa1.glb' },
  };
}

export function readyState(entries: readonly ToolAssetEntry[]): ToolAssetsState {
  const index: ToolAssetIndex = {
    schemaVersion: 1,
    contentHash: '0123456789abcdef',
    entries: [...entries],
    unavailable: [],
  };
  return indexState(index);
}

/** A worker that builds on `flush()` (or at once with `autoRun`), so tests choose when an answer arrives. */
export class FakeRegenPort implements RegenPort {
  onmessage: ((event: MessageEvent<FromRegenWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: ToRegenWorker[] = [];
  terminated = false;
  failWith: string | null = null;

  constructor(private readonly autoRun = false) {}

  postMessage(message: ToRegenWorker): void {
    this.posted.push(message);
    if (this.autoRun) this.flush();
  }

  /** Answers the oldest unanswered request. */
  flush(): void {
    const request = this.posted.shift();
    if (!request) return;
    const reply: FromRegenWorker =
      this.failWith === null
        ? { type: 'built', result: regenerate(request) }
        : { type: 'failed', key: request.key, message: this.failWith };
    this.onmessage?.({ data: reply } as MessageEvent<FromRegenWorker>);
  }

  terminate(): void {
    this.terminated = true;
  }
}

export class FakeUrls implements ObjectUrls {
  readonly live = new Set<string>();
  private next = 0;
  create(): string {
    const url = `blob:fake/${this.next++}`;
    this.live.add(url);
    return url;
  }
  revoke(url: string): void {
    this.live.delete(url);
  }
}
