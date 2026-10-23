/**
 * Rebuild a stored custom tool after a user patch. Edits that only touch parameters, colours or names rebuild
 * from `tool.json` directly; class or real-dimension edits (and generic lofts, which have no generator parameters)
 * re-run the fit on the stored profile. A refit starts from the stored values, so an edit never throws away an
 * earlier one (typed thickness, colours, parameters).
 */
import { generate, hasToolClass } from '../registry.ts';
import type { ToolModel } from '../model.ts';
import { colorsFromSegments, recolorModel } from './colors.ts';
import { type FittedObject, contiguousSegments, dimensionsOf, fitObject, observeModel, typicalLengthMm } from './create.ts';
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

/** Sampled colours with the user's choices on top. */
function effectivePartColors(tool: ToolDoc): Record<string, string> {
  return { ...tool.partColors, ...tool.userPartColors };
}

function buildClassModel(tool: ToolDoc, lod: 0 | 1): ToolModel {
  if (tool.classId === null) throw new ToolInputError('a generic tool has no class parameters');
  let model = generate(tool.classId, tool.params, lod);
  if (tool.fit.zScale !== 1) model = scaleMeshZ(model, tool.fit.zScale);
  const colors = effectivePartColors(tool);
  return Object.keys(colors).length > 0 ? recolorModel(model, colors) : model;
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
  // an estimated size follows the class: another class means another typical length
  const targetClass = patch.classId === undefined ? tool.classId : patch.classId;
  const estimatedLength =
    tool.dimensionsMm.source === 'estimated' &&
    wanted.length === undefined &&
    targetClass !== null &&
    targetClass !== tool.classId &&
    hasToolClass(targetClass)
      ? typicalLengthMm(targetClass)
      : undefined;
  // typing a width or a thickness leaves an estimated LENGTH an estimate; typing a length makes the size the user's
  const typesLength =
    patch.dimensionsMm !== undefined &&
    (tool.dimensionsMm.source !== 'estimated' || wanted.length !== undefined);
  if (
    tool.dimensionsMm.source === 'estimated' &&
    targetClass === null &&
    tool.classId !== null &&
    wanted.length === undefined
  ) {
    // a generic shape has no class to take a typical length from: keeping the old class's length would be a made-up size
    throw new ToolInputError('a generic shape needs a real length: type one (dimensionsMm.length)');
  }
  const dims = {
    ...(typed ? { length: tool.dimensionsMm.length } : {}),
    ...(estimatedLength === undefined ? {} : { length: estimatedLength }),
    ...(keepThickness ? { thickness: tool.dimensionsMm.thickness } : {}),
    ...wanted,
  };
  const userColors = { ...tool.userPartColors, ...patch.partColors };
  const fitted: FittedObject = fitObject(
    {
      profile: tool.profile,
      colors: tool.colors,
      candidates: tool.classCandidates,
      dimensionsMm: dims,
      dimensionSource: typesLength ? 'user' : tool.dimensionsMm.source,
      // the length of a refit is the model's own unless the user typed one: it yields to a typed width
      lengthHeld: wanted.length === undefined,
      ...(tool.profileKind ? { profileKind: tool.profileKind } : {}),
    },
    {
      classId: patch.classId === undefined ? tool.classId : patch.classId,
      fixed: patch.params ?? {},
      start: tool.params,
      partColors: userColors,
    },
  );
  return {
    tool: {
      ...tool,
      classId: fitted.classId,
      params: fitted.params,
      profile: fitted.profile,
      fit: fitted.fit,
      // the fit re-sampled the photo colours for the (possibly new) class; the user's choices stay apart
      partColors: fitted.sampledPartColors,
      userPartColors: userColors,
      dimensionsMm: fitted.dimensionsMm,
      ...(Object.keys(wanted).length > 0 ? { userDimensionsMm: wanted } : {}),
    },
    model: fitted.model,
    modelLod1: fitted.modelLod1,
  };
}

/**
 * Only tools saved before `userPartColors` existed (the field is absent; every newer save writes it, even empty) kept
 * the user's colours inside `partColors`, mixed with the sampled ones. Split them: a generic loft has no sampled
 * colours at all; a class tool's sampled colours are recomputed and whatever differs from them is the user's.
 */
function splitLegacyPartColors(tool: CustomTool): CustomTool {
  if (tool.userPartColors !== undefined || Object.keys(tool.partColors).length === 0) return tool;
  if (tool.classId === null) {
    const { partColors, ...rest } = tool;
    return { ...rest, partColors: {}, userPartColors: partColors };
  }
  if (!hasToolClass(tool.classId)) return tool;
  // the result always carries `userPartColors`, so the split runs once: later edits move the inputs it depends on
  const model = generate(tool.classId, tool.params, 0);
  const partNames = new Set(model.parts.map((part) => part.name));
  const sampled = colorsFromSegments(
    model,
    contiguousSegments(tool.colors),
    tool.fit.flipped,
  );
  const user = Object.fromEntries(
    Object.entries(tool.partColors).filter(
      // a key of a part this class does not have is a leftover of an earlier class (old class changes merged them in)
      ([part, hex]) => partNames.has(part) && sampled[part] !== hex,
    ),
  );
  const kept = Object.fromEntries(
    Object.entries(tool.partColors).filter(([part]) => partNames.has(part) && !(part in user)),
  );
  return { ...tool, partColors: kept, userPartColors: user };
}

export function applyPatch(stored: CustomTool, patch: CustomToolPatch): Rebuilt {
  const tool = splitLegacyPartColors(stored);
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
    ...(patch.partColors === undefined
      ? {}
      : { userPartColors: { ...tool.userPartColors, ...patch.partColors } }),
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
