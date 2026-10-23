/**
 * Which holder suits a tool best, physically: every candidate holder is tried (the tool is seated in it), and the
 * seats are ordered by how well the tool hangs there and how easily it comes off again.
 */
import { foldFitAndRating, physicsRating } from '@hsw-editor/compat';
import type { ManifoldToplevel } from 'manifold-3d';
import type { SolidBody, ToolBody } from './body.ts';
import type { HangOptions } from './hang.ts';
import { RemovalProbe, type RemovalReport } from './removal.ts';
import { type SeatResult, seatTool } from './seat.ts';

export interface HolderCandidate {
  holderId: string;
  holder: SolidBody;
  /** Other holders and tools around it (obstacles for the seat and the removal). */
  neighbours: readonly SolidBody[];
  /** Where the slot is: x centre of the slot, z centre of the holder (wall frame). */
  anchor: readonly [number, number, number];
  halfWidthMm: number;
  tipDown: boolean;
  /** Fit score from `compatibility()` (0..1); folded into `combined`. */
  compatScore: number;
  maxLoadG?: number | undefined;
}

export interface RankedSeat {
  holderId: string;
  seat: SeatResult;
  removal: RemovalReport | null;
  /** Hang stability and removal convenience folded together (0..1). */
  rating: number;
  /** `rating` and the dimensional fit folded together (0..1): the sort key. */
  combined: number;
}

/** Seats `tool` in every candidate and returns them best first (ties by holder id). Holders the tool cannot be seated in are left out. */
export function rankHolders(
  tool: ToolBody,
  candidates: readonly HolderCandidate[],
  options: { hang?: Partial<HangOptions>; wasm?: ManifoldToplevel } = {},
): RankedSeat[] {
  const probe = options.wasm === undefined ? null : new RemovalProbe(options.wasm);
  const out: RankedSeat[] = [];
  for (const c of candidates) {
    const hangOptions = {
      ...options.hang,
      ...(c.maxLoadG === undefined ? {} : { maxLoadG: c.maxLoadG }),
    };
    const seat = seatTool({
      tool,
      holder: c.holder,
      neighbours: c.neighbours,
      anchor: [c.anchor[0], c.anchor[1], c.anchor[2]],
      halfWidthMm: c.halfWidthMm,
      tipDown: c.tipDown,
      options: hangOptions,
    });
    if (seat === null) continue;
    const removal =
      probe === null
        ? null
        : probe.analyse({
            tool,
            placement: seat.placement,
            holder: c.holder,
            neighbours: c.neighbours,
          });
    const rating = physicsRating({
      stability: seat.report.score,
      convenience: removal?.convenience ?? null,
    });
    out.push({
      holderId: c.holderId,
      seat,
      removal,
      rating,
      combined: foldFitAndRating(c.compatScore, rating),
    });
  }
  probe?.dispose();
  return out.sort((a, b) => b.combined - a.combined || (a.holderId < b.holderId ? -1 : 1));
}
