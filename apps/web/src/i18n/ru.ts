import { assetsRu } from './catalog/assets.ts';
import { bankRu } from './catalog/bank.ts';
import { compareRu } from './catalog/compare.ts';
import { ompRu } from './catalog/omp.ts';
import { invalidZonesRu } from './catalog/invalidZones.ts';
import { shellRu } from './catalog/shell.ts';
import { viewportRu } from './catalog/viewport.ts';
import { widgetsRu } from './catalog/widgets.ts';
import type { Catalogue } from './keys.ts';

export const ru: Catalogue = {
  ...shellRu,
  ...ompRu,
  ...viewportRu,
  ...bankRu,
  ...widgetsRu,
  ...compareRu,
  ...assetsRu,
  ...invalidZonesRu,
};
