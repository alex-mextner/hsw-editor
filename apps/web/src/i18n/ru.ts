import { bankRu } from './catalog/bank.ts';
import { compareRu } from './catalog/compare.ts';
import { shellRu } from './catalog/shell.ts';
import { widgetsRu } from './catalog/widgets.ts';
import type { Catalogue } from './keys.ts';

export const ru: Catalogue = {
  ...shellRu,
  ...bankRu,
  ...widgetsRu,
  ...compareRu,
};
