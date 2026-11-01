import type { GridCell } from '@hsw-editor/core';

/** A holder of the bank on a lattice cell, and the tools (generator class ids) that hang in it, left to right. */
export interface ShowcaseHolder {
  readonly id: string;
  readonly bankId: string;
  readonly cell: GridCell;
  readonly rotZ?: number;
  readonly tools: readonly ShowcaseTool[];
}

export interface ShowcaseTool {
  /** Generator class id (`screwdriver`, `pliers-combination`, ...). */
  readonly classId: string;
  /** Class parameters set to what the holder takes (`shaftDiameter`, `beamWidth`): the model is rebuilt with them. */
  readonly params?: Readonly<Record<string, number>>;
}

/** Screwdrivers the 5 mm holes of the rail take: a 4 mm shaft and tip (the rail's bank entry takes shafts of 2..4.6 mm) and a slim 11 mm handle, so the 26 mm pitch leaves room for fingers beside each. */
export const DRIVER_FOR_5MM_HOLES = { shaftDiameter: 4, tipSize: 4, handleDiameter: 11 } as const;

/**
 * The tools of the demo wall and of the proof wall: generated tools of a dozen classes on holders of the committed seed bank,
 * laid out in rows like the reference photo (tape, scissors and measuring tools on the top, pliers, the drill and the hammer in the
 * middle, screwdrivers, wrenches and the spray can at the bottom). Ids exist in the seed bank (`packages/bank/seed`); where a
 * generator's default does not fit the holder, the class parameter the holder asks about is set (`params`), as a user would
 * with the dimension widget. The racks are laid out as the physics says they work (the wall is the proof of "Seat tools"): the side-cutters
 * (handles 82 mm apart at rest) do not fit a 52 mm deep rack beside two other pliers, so they have a rack of their own; the screwdrivers sit in the
 * 5 mm holes of a 3-slot screwdriver rail with 4 mm shafts and slim 11 mm handles (`DRIVER_FOR_5MM_HOLES`), so the gap to the
 * neighbour leaves room for fingers; the long-nose pliers are 170 mm so they stay inside the 66 mm rack.
 */
export const SHOWCASE_LAYOUT: readonly ShowcaseHolder[] = [
  {
    id: 'sc-tape',
    bankId: 'refit-tape-large',
    cell: { col: 3, row: 22 },
    tools: [{ classId: 'tape-roll' }],
  },
  {
    id: 'sc-measure',
    bankId: 'refit-tape-measure-cradle',
    cell: { col: 12, row: 25 },
    tools: [{ classId: 'tape-measure' }],
  },
  {
    id: 'sc-caliper',
    bankId: 'caliper-cradle-slots1-beamwidth16',
    cell: { col: 22, row: 19 },
    tools: [{ classId: 'caliper', params: { beamWidth: 15.5 } }],
  },
  {
    id: 'sc-hammer',
    bankId: 'hammer-fork-handlewidth30',
    cell: { col: 31, row: 12 },
    tools: [{ classId: 'hammer' }],
  },
  {
    id: 'sc-scissors',
    bankId: 'scissors-slot-slots2-bladethickness12',
    cell: { col: 38, row: 22 },
    tools: [{ classId: 'scissors' }, { classId: 'utility-knife' }],
  },
  {
    id: 'sc-pliers',
    bankId: 'pliers-rack-slots3-jawthickness18',
    cell: { col: 9, row: 12 },
    tools: [
      { classId: 'pliers-combination' },
      { classId: 'pliers-long-nose', params: { length: 170 } },
    ],
  },
  {
    id: 'sc-cutters',
    bankId: 'pliers-rack-slots3-jawthickness18',
    cell: { col: 16, row: 2 },
    tools: [{ classId: 'side-cutters' }],
  },
  {
    id: 'sc-wrench',
    bankId: 'wrench-rack-slots4-maxwrenchwidth30',
    cell: { col: 41, row: 2 },
    tools: [
      { classId: 'wrench-combination' },
      { classId: 'wrench-ring' },
      { classId: 'wrench-open-end' },
    ],
  },
  {
    id: 'sc-drill',
    bankId: 'drill-cradle-bodywidth45',
    cell: { col: 16, row: 12 },
    tools: [{ classId: 'cordless-drill' }],
  },
  {
    id: 'sc-drivers',
    bankId: 'screwdriver-rail-slots3-holediameter5',
    cell: { col: 8, row: 2 },
    tools: [
      { classId: 'screwdriver', params: DRIVER_FOR_5MM_HOLES },
      { classId: 'screwdriver', params: DRIVER_FOR_5MM_HOLES },
      { classId: 'screwdriver', params: DRIVER_FOR_5MM_HOLES },
    ],
  },
  {
    id: 'sc-spray',
    bankId: 'spray-can-holder-candiameter50',
    cell: { col: 26, row: 2 },
    tools: [{ classId: 'spray-can', params: { diameter: 50 } }],
  },
];
