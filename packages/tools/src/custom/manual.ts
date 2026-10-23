/**
 * A built-in class with chosen parameters saved to the library (no photo involved). It stores the width profile
 * of the model so that later class / real-dimension edits can refit it like a photographed tool.
 */
import { generate, getToolClass } from '../registry.ts';
import type { ToolModel } from '../model.ts';
import { dimensionsOf, observeModel } from './create.ts';
import type { CustomTool } from './schema.ts';

export interface ManualTool {
  tool: Omit<CustomTool, 'model'>;
  model: ToolModel;
  modelLod1: ToolModel;
}

export function createManualTool(input: {
  id: string;
  classId: string;
  params?: Readonly<Record<string, number | string>>;
  name?: { en?: string | undefined; ru?: string | undefined };
  now?: Date;
}): ManualTool {
  const cls = getToolClass(input.classId);
  const model = generate(cls.id, input.params ?? {}, 0);
  const modelLod1 = generate(cls.id, input.params ?? {}, 1);
  const now = (input.now ?? new Date()).toISOString();
  return {
    tool: {
      version: 1,
      id: input.id,
      name: { en: input.name?.en ?? cls.name.en, ru: input.name?.ru ?? cls.name.ru },
      createdAt: now,
      updatedAt: now,
      classId: cls.id,
      classCandidates: [],
      params: model.params,
      profile: observeModel(model),
      colors: [],
      partColors: {},
      dimensionsMm: { ...dimensionsOf(model), source: 'user' },
      fit: { method: 'manual', iou: 1, confidence: 1, view: 'front', flipped: false, zScale: 1 },
      sources: [],
    },
    model,
    modelLod1,
  };
}
