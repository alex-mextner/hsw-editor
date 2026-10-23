/**
 * What a holder mount carries when the bank does not say (`fitsTool.maxLoadG` absent). The numbers are assumptions for
 * the bank's own parts: PETG printed on a 2.2 mm wall and held by two M3 screws in the honeycomb board. A hook or peg is a
 * small lever on those screws, a rack or slot holder spreads the load over its slot walls, a tray, bin or shelf sits on
 * the board over its whole back plate.
 */
import { mountStyleOf } from '@hsw-editor/compat';

const HOOK_LOAD_G = 1500;
const SLOT_LOAD_G = 1000;
const CUP_LOAD_G = 800;
const TRAY_LOAD_G = 3000;

/** Largest tool mass (g) one slot of a holder of `category` is assumed to carry. */
export function defaultLoadCapacityG(category: string): number {
  if (category === 'bins/cups') return CUP_LOAD_G;
  switch (mountStyleOf({ category })) {
    case 'hook':
      return HOOK_LOAD_G;
    case 'top-holes':
      return SLOT_LOAD_G;
    case 'tray':
      return TRAY_LOAD_G;
  }
}
