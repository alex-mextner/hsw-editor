import { bankEn } from './catalog/bank.ts';
import { compareEn } from './catalog/compare.ts';
import { shellEn } from './catalog/shell.ts';
import { viewportEn } from './catalog/viewport.ts';
import { widgetsEn } from './catalog/widgets.ts';

/**
 * English catalogue = the set of message keys. Each feature owns one file in `catalog/` exporting
 * `<feature>En` and a matching `<feature>Ru` (typed `FeatureRu`), so features never edit each other's strings.
 */
export const en = {
  ...shellEn,
  ...viewportEn,
  ...bankEn,
  ...widgetsEn,
  ...compareEn,
} as const;
