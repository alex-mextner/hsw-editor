/**
 * Seat proposals for the daemon: where a hung tool rests in the real mesh of its holder, computed with the same
 * `seatTool` search, slot, window and neighbours the editor's worker uses, so a wall built through the API, the CLI or the
 * agent can be seated without a browser. Nothing is written: a caller applies the proposed poses as ordinary ops.
 */
import { slotsOf, wallSlot } from '@hsw-editor/compat';
import type { LeafOp, Pose, Wall, WallItem } from '@hsw-editor/core';
import {
  boundsOverlap,
  type HangReport,
  type HungItem,
  placementOfPose,
  planSeatAll,
  samePose,
  seatSlotInput,
  seatTool,
  SolidBody,
  type ToolBody,
} from '@hsw-editor/physics';
import type { PhysicsAssets, WallSolids } from './assets.ts';

/** Why a hung tool has no seat. */
export type NoSeatReason =
  | 'no_holder'
  | 'holder_missing'
  | 'no_model'
  | 'no_physics'
  | 'holder_refuses'
  | 'no_slot'
  | 'holder_not_upright'
  | 'no_seat';

export const NO_SEAT_TEXT: Record<NoSeatReason, string> = {
  no_holder: 'it hangs on no holder (no parentId)',
  holder_missing: 'its holder is not on the wall or has no model in the bank',
  no_model: 'it has no tool model to seat (a plain box preset)',
  no_physics: 'its model carries no mass',
  no_slot:
    "it hangs without a slot number, so which slot it takes is anybody's guess: attach it to a slot first",
  holder_refuses: 'its holder does not take this tool in that slot (compatibility says no)',
  holder_not_upright:
    'its holder is rotated; seating lowers a tool straight down, so only an upright holder is seated',
  no_seat: 'the tool cannot be lowered into this holder: nothing holds it',
};

export interface Seat {
  readonly toolId: string;
  readonly holderId: string;
  readonly slot: number;
  readonly pose: Pose;
  /** The pose the item has now. */
  readonly from: Pose;
  /** The seated pose differs from the current one. */
  readonly changed: boolean;
  readonly status: HangReport['status'];
  readonly score: number;
}

export type SeatAttempt =
  | { readonly seat: Seat }
  | { readonly seat: null; readonly reason: NoSeatReason };

export interface WallSeatPlan {
  readonly seats: readonly Seat[];
  /** Hung tools with no seat, and why. */
  readonly kept: readonly { readonly toolId: string; readonly reason: NoSeatReason }[];
  readonly unchanged: readonly string[];
  /** Hung without a slot number: left to the user. */
  readonly unslotted: readonly string[];
  /** Rotate and move per tool that ends up somewhere else, the ops of one `seat all` batch. */
  readonly ops: readonly LeafOp[];
}

export interface SeatPlanner {
  /** Where `toolId` rests in its own slot of its holder. */
  seatOne(wall: Wall, toolId: string): Promise<SeatAttempt>;
  /** Every hung tool seated one after the other (the editor's Seat tools pass). */
  seatAll(wall: Wall): Promise<WallSeatPlan>;
}

/** A neighbour is an obstacle for a seat only when its box is within the tool's reach of the holder. */
function reachOf(tool: ToolBody): number {
  const placement = placementOfPose({ x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 });
  const bounds = new SolidBody(tool.id, tool.mesh, placement.rotation, placement.position).bounds();
  return Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
}

export function createSeatPlanner(assets: PhysicsAssets): SeatPlanner {
  async function seatIn(
    solids: WallSolids,
    view: Wall,
    item: WallItem,
    wanted: number | undefined,
  ): Promise<SeatAttempt> {
    if (item.parentId === undefined) return { seat: null, reason: 'no_holder' };
    const holder = solids.holders.find((h) => h.item.id === item.parentId);
    if (holder === undefined) return { seat: null, reason: 'holder_missing' };
    const built = await assets.toolBody(item, view);
    if ('skip' in built) return { seat: null, reason: built.skip };
    const iface = await assets.toolInterface(item, view);
    if (iface === undefined) return { seat: null, reason: 'no_model' };
    const target = wallSlot(view, item, holder.item, holder.element, iface, wanted);
    if (target === null) return { seat: null, reason: 'holder_refuses' };
    const input = seatSlotInput(
      holder.item.pose,
      holder.element,
      target.slot,
      slotsOf(holder.element, target.compat).count,
      target.compat,
      iface,
    );
    if (input === null) return { seat: null, reason: 'holder_not_upright' };

    // What the tool could touch: the other holders and shelves near, and the other tools at the poses they have in `view`.
    const reach = reachOf(built.body);
    const near = (body: SolidBody): boolean =>
      boundsOverlap(body.bounds(), holder.body.bounds(), reach);
    const neighbours: SolidBody[] = [
      ...solids.holders.filter((h) => h.item.id !== holder.item.id).map((h) => h.body),
      ...solids.boardParts,
    ].filter(near);
    for (const other of view.items) {
      if (other.kind !== 'tool' || other.id === item.id || other.parentId === undefined) continue;
      const otherBody = await assets.toolBody(other, view);
      if ('skip' in otherBody) continue;
      const placement = placementOfPose(other.pose);
      const solid = new SolidBody(
        other.id,
        otherBody.body.mesh,
        placement.rotation,
        placement.position,
      );
      if (near(solid)) neighbours.push(solid);
    }

    const result = seatTool({
      tool: built.body,
      holder: holder.body,
      neighbours,
      anchor: input.anchor,
      halfWidthMm: input.halfWidthMm,
      tipDown: input.tipDown,
      options: input.maxLoadG === undefined ? {} : { maxLoadG: input.maxLoadG },
    });
    if (result === null) return { seat: null, reason: 'no_seat' };
    return {
      seat: {
        toolId: item.id,
        holderId: holder.item.id,
        slot: target.slot.index,
        pose: result.pose,
        from: item.pose,
        changed: !samePose(result.pose, item.pose),
        status: result.report.status,
        score: result.report.score,
      },
    };
  }

  return {
    async seatOne(wall, toolId) {
      const item = wall.items.find((candidate) => candidate.id === toolId);
      if (item === undefined || item.kind !== 'tool') throw new Error(`no tool ${toolId}`);
      // Which slot a tool without a slot number takes is anybody's guess, and seating only moves it: leave it to the user.
      if (item.parentId !== undefined && item.slot === undefined) {
        return { seat: null, reason: 'no_slot' };
      }
      return seatIn(await assets.wallSolids(wall), wall, item, item.slot);
    },

    async seatAll(wall) {
      const solids = await assets.wallSolids(wall);
      const seats = new Map<string, Seat>();
      const reasons = new Map<string, NoSeatReason>();

      const plan = await planSeatAll(
        wall,
        async (hung: HungItem, view) => {
          const attempt = await seatIn(solids, view, hung, hung.slot);
          if (attempt.seat === null) {
            reasons.set(hung.id, attempt.reason);
            return null;
          }
          reasons.delete(hung.id);
          seats.set(hung.id, attempt.seat);
          return attempt.seat.pose;
        },
        (toolId) => reasons.set(toolId, 'no_seat'),
      );

      return {
        // The seat of a tool that moved is the one its last attempt found, measured from where the wall had it.
        seats: plan.seated.flatMap((id) => {
          const seat = seats.get(id);
          const from = wall.items.find((candidate) => candidate.id === id)?.pose;
          return seat === undefined || from === undefined ? [] : [{ ...seat, from, changed: true }];
        }),
        kept: plan.kept.map((toolId) => ({
          toolId,
          reason: reasons.get(toolId) ?? 'no_seat',
        })),
        unchanged: plan.unchanged,
        unslotted: plan.unslotted,
        ops: plan.ops,
      };
    },
  };
}
