/** A small wall with fake bank elements and a fake tool library for the physics tests. */
import type { BankElement } from '@hsw-editor/bank';
import {
  createEmptyWall,
  DEFAULT_BOARD,
  type Op,
  type Pose,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { DISTURBANCES, type HangReport, type RankedSeat } from '@hsw-editor/physics';
import type { HolderSpec, ToolInterface } from '@hsw-editor/compat';
import { bankElement } from '@/test/fixtures.ts';
import { toolInterfaceOf } from '@/wall/toolInterface.ts';
import type { AssetContext, ToolLibrary } from './assets.ts';
import type { PhysicsRanker } from './client.ts';
import type { RankRequest } from './protocol.ts';
import type { PostStepDeps } from './seat.ts';

export const RACK: BankElement = bankElement('rack', {
  category: 'holders/screwdrivers',
  fitsTool: [{ toolClass: 'screwdriver', capacity: 4 }],
  bboxMm: { min: { x: -60, y: -20, z: 0 }, max: { x: 60, y: 20, z: 30 } },
});

export const HOOK: BankElement = bankElement('hook', {
  category: 'hooks/hooks',
  fitsTool: [{ toolClass: 'screwdriver', capacity: 1 }],
  bboxMm: { min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 40 } },
});

/** A holder spec whose bank entry states what a slot carries (the bank schema does not publish it yet). */
export const HOOK_CAPPED: HolderSpec = {
  id: 'hook-capped',
  category: 'hooks/hooks',
  fitsTool: [{ toolClass: 'screwdriver', capacity: 1, maxLoadG: 300 }],
  bboxMm: HOOK.bboxMm,
};

export const LIBRARY: ToolLibrary = {
  classes: [
    {
      id: 'screwdriver',
      bankClass: 'screwdriver',
      schema: {
        shaftDiameter: {
          kind: 'num',
          min: 2,
          max: 10,
          def: 5,
          step: 0.1,
          unit: 'mm',
          label: { en: 'Shaft', ru: 'Стержень' },
          dimension: true,
        },
        length: {
          kind: 'num',
          min: 50,
          max: 400,
          def: 200,
          step: 1,
          unit: 'mm',
          label: { en: 'Length', ru: 'Длина' },
          dimension: true,
        },
        grip: { kind: 'color', def: '#ff0000', label: { en: 'Grip', ru: 'Рукоять' } },
      },
    },
    {
      id: 'screwdriver-precision',
      bankClass: 'screwdriver',
      schema: {},
    },
  ],
  tools: [{ id: 'mine', updatedAt: '2026-10-01T00:00:00Z' }],
};

export const POSE: Pose = { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 };

export function holderItem(id: string, bankId: string, pose: Partial<Pose> = {}): WallItem {
  return {
    id,
    kind: 'holder',
    bankId,
    pose: { ...POSE, ...pose },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

export function toolItem(
  id: string,
  options: {
    readonly by?: string;
    readonly parentId?: string;
    readonly slot?: number;
    readonly params?: Readonly<Record<string, number>>;
    readonly pose?: Partial<Pose>;
    readonly toolClass?: string;
  } = {},
): { item: WallItem; model: Wall['models'][number] } {
  const model: Wall['models'][number] = {
    id: `m-${id}`,
    label: id,
    status: 'chosen',
    source: { type: 'library', by: options.by ?? 'preset' },
    dimensionsMm: { x: 28, y: 210, z: 28 },
    toolClass: options.toolClass ?? 'screwdriver',
  };
  const item: WallItem = {
    id,
    kind: 'tool',
    modelRefId: model.id,
    toolClass: options.toolClass ?? 'screwdriver',
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
    ...(options.slot === undefined ? {} : { slot: options.slot }),
    pose: { ...POSE, z: 40, ...options.pose },
    params: { ...options.params },
    source: { type: 'manual' },
    locked: false,
  };
  return { item, model };
}

export function wallOf(
  holders: readonly WallItem[],
  tools: readonly { item: WallItem; model: Wall['models'][number] }[],
): Wall {
  const empty = createEmptyWall('w', 'W', { ...DEFAULT_BOARD, cols: 30, rows: 30 });
  return {
    ...empty,
    items: [...holders, ...tools.map((t) => t.item)],
    models: tools.map((t) => t.model),
  };
}

export function contextOf(
  wall: Wall,
  options: { readonly library?: ToolLibrary; readonly elements?: readonly BankElement[] } = {},
): AssetContext {
  const elements = options.elements ?? [RACK, HOOK];
  return {
    bank: new Map(elements.map((e) => [e.id, e])),
    library: options.library ?? LIBRARY,
    baseUrl: 'http://wall.test/app/',
    toolInterface: (item): ToolInterface | undefined => toolInterfaceOf(item, wall),
  };
}

// ---- fake physics answers ----------------------------------------------------------------------

const MARGINS = Object.fromEntries(
  Object.keys(DISTURBANCES).map((name) => [name, 1]),
) as HangReport['marginsG'];

export function fakeSeat(
  holderId: string,
  pose: Pose,
  options: { readonly score?: number; readonly combined?: number } = {},
): RankedSeat {
  const score = options.score ?? 0.9;
  const report: HangReport = {
    score,
    status: score >= 0.7 ? 'stable' : score >= 0.4 ? 'marginal' : 'unstable',
    reasons: [],
    marginsG: MARGINS,
    massG: 100,
    contactCount: 2,
    penetrationMm: 0,
    swingDeg: null,
    rest: null,
  };
  return {
    holderId,
    seat: {
      placement: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], position: [pose.x, pose.y, pose.z] },
      pose,
      report,
      candidates: 1,
    },
    removal: null,
    rating: score,
    combined: options.combined ?? score,
  };
}

/** Post-step dependencies over a mutable wall; `submitted` records every undo step the code submits. */
export interface FakeEditor {
  wall: Wall | null;
  enabled: boolean;
  readonly requests: RankRequest[];
  readonly submitted: { readonly ops: readonly Op[]; readonly label: string }[];
  readonly deps: PostStepDeps;
}

export function fakeEditor(
  wall: Wall,
  answer: (request: RankRequest) => readonly RankedSeat[],
  options: { readonly elements?: readonly BankElement[]; readonly submitOk?: boolean } = {},
): FakeEditor {
  const editor: FakeEditor = {
    wall,
    enabled: true,
    requests: [],
    submitted: [],
    deps: {
      wall: () => editor.wall,
      context: (current) =>
        contextOf(current, options.elements === undefined ? {} : { elements: options.elements }),
      ranker: (): PhysicsRanker => ({
        rank: async (request: RankRequest) => {
          editor.requests.push(request);
          return answer(request);
        },
      }),
      submit: (ops, label) => {
        editor.submitted.push({ ops, label });
        return options.submitOk ?? true;
      },
      enabled: () => editor.enabled,
    },
  };
  return editor;
}
