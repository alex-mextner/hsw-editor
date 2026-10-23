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

/**
 * The tools of the demo wall and of the proof wall: generated tools of a dozen classes on holders of the committed seed bank,
 * laid out in rows like the reference photo (tape, scissors and measuring tools on the top, pliers, the drill and the hammer in the
 * middle, screwdrivers, wrenches and the spray can at the bottom). Ids exist in the seed bank (`packages/bank/seed`); where a
 * generator's default does not fit the holder, the class parameter the holder asks about is set (`params`), as a user would
 * with the dimension widget. The racks are laid out as the physics says they work (the wall is the proof of "Seat tools"): the side-cutters
 * (handles 82 mm apart at rest) do not fit a 52 mm deep rack beside two other pliers, so they have a rack of their own; the screwdrivers on the
 * 36 mm rail are slim (22 mm handles) so the gap to the neighbour leaves room for fingers.
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
    tools: [{ classId: 'pliers-combination' }, { classId: 'pliers-long-nose' }],
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
      { classId: 'wrench-open-end' },
      { classId: 'wrench-ring' },
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
    bankId: 'refit-screwdriver-rail-3',
    cell: { col: 8, row: 2 },
    tools: [
      { classId: 'screwdriver', params: { handleDiameter: 22 } },
      { classId: 'screwdriver', params: { handleDiameter: 22 } },
      { classId: 'screwdriver', params: { handleDiameter: 22 } },
    ],
  },
  {
    id: 'sc-spray',
    bankId: 'spray-can-holder-candiameter50',
    cell: { col: 26, row: 2 },
    tools: [{ classId: 'spray-can', params: { diameter: 50 } }],
  },
];
