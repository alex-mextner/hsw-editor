/**
 * Class vocabulary for recognition: text prompts per tool class, in the `categories` format of the vision
 * sidecar (`[{ id, prompts }]`). Keywords come from the class definitions, so adding a class extends
 * recognition automatically.
 */
import { listToolClasses } from '../registry.ts';

export interface RecognitionCategory {
  id: string;
  /** Full English phrases (CLIP is English only); Russian names stay in the UI. */
  prompts: string[];
}

const TEMPLATES = [
  (k: string) => `a photo of a ${k}.`,
  (k: string) => `a top-down photo of a ${k} lying on a carpet.`,
];

export function recognitionCategories(): RecognitionCategory[] {
  return listToolClasses().map((cls) => {
    const prompts: string[] = [];
    for (const k of cls.keywords.en) for (const t of TEMPLATES) prompts.push(t(k));
    return { id: cls.id, prompts: prompts.slice(0, 12) };
  });
}
