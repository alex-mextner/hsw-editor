import { assetsRu } from './catalog/assets.ts';
import { attachRu } from './catalog/attach.ts';
import { bankRu } from './catalog/bank.ts';
import { commandsRu } from './catalog/commands.ts';
import { compareRu } from './catalog/compare.ts';
import { ompRu } from './catalog/omp.ts';
import { invalidZonesRu } from './catalog/invalidZones.ts';
import { photoRu } from './catalog/photo.ts';
import { shellRu } from './catalog/shell.ts';
import { toolsRu } from './catalog/tools.ts';
import { viewportRu } from './catalog/viewport.ts';
import { widgetsRu } from './catalog/widgets.ts';
import type { Catalogue } from './keys.ts';

export const ru: Catalogue = {
  ...shellRu,
  ...ompRu,
  ...viewportRu,
  ...attachRu,
  ...bankRu,
  ...widgetsRu,
  ...compareRu,
  ...assetsRu,
  ...invalidZonesRu,
  ...commandsRu,
  ...toolsRu,
  ...photoRu,
};
