/**
 * Rebuild a stored custom tool after a user patch. Edits that only touch parameters, colours or names rebuild
 * from `tool.json` directly; class or real-dimension edits (and generic lofts, which have no generator parameters)
 * re-run the fit on the stored profile. A refit starts from the stored values, so an edit never throws away an
 * earlier one (typed thickness, colours, parameters).
 */
import { generate, hasToolClass } from '../registry.ts';
import type { ToolModel } from '../model.ts';
import { recolorModel } from './colors.ts';
import { type FittedObject, dimensionsOf, fitObject, observeModel } from './create.ts';
import { ToolInputError } from './errors.ts';
import { scaleMeshZ } from './transform.ts';
import type { CustomTool, CustomToolPatch } from './schema.ts';

type ToolDoc = Omit<CustomTool, 'model'>;

export interface Rebuilt {
  /** Updated tool document without `model` (the caller writes the files and fills it in). */
  tool: ToolDoc;
  model: ToolModel;
  modelLod1: ToolModel;
}

function withoutModel(tool: CustomTool): ToolDoc {
  const { model: _model, ...rest } = tool;
  return rest;
}

function buildClassModel(tool: ToolDoc, lod: 0 | 1): ToolModel {
  if (tool.classId === null) throw new ToolInputError('a generic tool has no class parameters');
  let model = generate(tool.classId, tool.params, lod);
  if (tool.fit.zScale !== 1) model = scaleMeshZ(model, tool.fit.zScale);
  return Object.keys(tool.partColors).length > 0 ? recolorModel(model, tool.partColors) : model;
}

/** Parameters, colours and names only: no fit; the stored dimensions follow the rebuilt model. */
function rebuildDirect(tool: ToolDoc): Rebuilt {
  const model = buildClassModel(tool, 0);
  return {
    tool: {
      ...tool,
      dimensionsMm: {
        ...dimensionsOf(model),
        source: tool.dimensionsMm.source,
      },
    },
    model,
    modelLod1: buildClassModel(tool, 1),
  };
}

function refit(tool: ToolDoc, patch: CustomToolPatch): Rebuilt {
  if (!tool.profile) throw new ToolInputError('this tool has no stored profile to refit');
  const typed = tool.dimensionsMm.source === 'user' || tool.classId === null;
  // a refit keeps a thickness the user shaped (a squashed class model, an existing loft) unless the patch replaces it;
  // a loft's guessed thickness is not carried into a class, which has a real one of its own
  const staysGeneric = (patch.classId === undefined ? tool.classId : patch.classId) === null;
  const keepThickness = tool.classId === null ? staysGeneric : tool.fit.zScale !== 1;
  const wanted = { ...tool.userDimensionsMm, ...patch.dimensionsMm };
  const dims = {
    ...(typed ? { length: tool.dimensionsMm.length } : {}),
    ...(keepThickness ? { thickness: tool.dimensionsMm.thickness } : {}),
    ...wanted,
  };
  const fitted: FittedObject = fitObject(
    {
      profile: tool.profile,
      colors: tool.colors,
      candidates: tool.classCandidates,
      dimensionsMm: dims,
      dimensionSource: patch.dimensionsMm ? 'user' : tool.dimensionsMm.source,
      ...(tool.profileKind ? { profileKind: tool.profileKind } : {}),
    },
    {
      classId: patch.classId === undefined ? tool.classId : patch.classId,
      fixed: patch.params ?? {},
      start: tool.params,
      partColors: { ...tool.partColors, ...patch.partColors },
    },
  );
  return {
    tool: {
      ...tool,
      classId: fitted.classId,
      params: fitted.params,
      profile: fitted.profile,
      fit: fitted.fit,
      partColors: fitted.partColors,
      dimensionsMm: fitted.dimensionsMm,
      ...(Object.keys(wanted).length > 0 ? { userDimensionsMm: wanted } : {}),
    },
    model: fitted.model,
    modelLod1: fitted.modelLod1,
  };
}

export function applyPatch(tool: CustomTool, patch: CustomToolPatch): Rebuilt {
  if (patch.classId && !hasToolClass(patch.classId)) {
    throw new ToolInputError(`unknown tool class: ${patch.classId}`);
  }
  const named: ToolDoc = {
    ...withoutModel(tool),
    name: { ...tool.name, ...patch.name },
    updatedAt: new Date().toISOString(),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
  };
  const classChanges = patch.classId !== undefined && patch.classId !== tool.classId;
  // generic lofts have no generator parameters: every edit goes through the (deterministic) fit
  if (patch.dimensionsMm !== undefined || classChanges || tool.classId === null) {
    return refit(named, patch);
  }
  const rebuilt = rebuildDirect({
    ...named,
    params: { ...tool.params, ...patch.params },
    partColors: { ...tool.partColors, ...patch.partColors },
  });
  if (!tool.profile || patch.params === undefined || Object.keys(patch.params).length === 0) {
    return rebuilt;
  }
  // the edited parameters are the shape the user wants: later refits start from it, not from the photo, and
  // dimensions typed before the edit described the old shape
  const { userDimensionsMm: _typedBefore, ...shaped } = rebuilt.tool;
  return {
    ...rebuilt,
    tool: {
      ...shaped,
      profile: observeModel(rebuilt.model),
      fit: { ...shaped.fit, view: 'front', flipped: false },
    },
  };
}
