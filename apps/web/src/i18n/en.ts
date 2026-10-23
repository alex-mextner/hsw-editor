import { assetsEn } from './catalog/assets.ts';
import { attachEn } from './catalog/attach.ts';
import { bankEn } from './catalog/bank.ts';
import { commandsEn } from './catalog/commands.ts';
import { compareEn } from './catalog/compare.ts';
import { ompEn } from './catalog/omp.ts';
import { invalidZonesEn } from './catalog/invalidZones.ts';
import { photoEn } from './catalog/photo.ts';
import { shellEn } from './catalog/shell.ts';
import { toolsEn } from './catalog/tools.ts';
import { viewportEn } from './catalog/viewport.ts';
import { widgetsEn } from './catalog/widgets.ts';

/**
 * English catalogue = the set of message keys. Each feature owns one file in `catalog/` exporting
 * `<feature>En` and a matching `<feature>Ru` (typed `FeatureRu`), so features never edit each other's strings.
 */
export const en = {
  ...shellEn,
  ...ompEn,
  ...viewportEn,
  ...attachEn,
  ...bankEn,
  ...widgetsEn,
  ...compareEn,
  ...assetsEn,
  ...invalidZonesEn,
  ...commandsEn,
  ...toolsEn,
  ...photoEn,
} as const;
