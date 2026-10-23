import type { ParamDef } from '@hsw-editor/bank';
import type { Translate } from '@/i18n/index.ts';
import type { Dims3 } from '@/wall/toolPresets.ts';
import { TOOL_PARAM_KEYS } from '@/wall/toolPresets.ts';

const MIN_MM = 1;

function def(key: string, label: string, base: number): ParamDef {
  return {
    key,
    label: { ru: label, en: label },
    unit: 'mm',
    min: MIN_MM,
    // Generous range around the preset so a long saw and a small SD card share one widget.
    max: Math.max(1000, Math.ceil(base * 4)),
    default: base,
    step: 1,
  };
}

/** Param definitions of a tool's box (width, length, thickness) with `base` as the unedited size. */
export function toolParamDefs(base: Dims3, t: Translate): ParamDef[] {
  return [
    def(TOOL_PARAM_KEYS.width, t('tooldims.width'), base.x),
    def(TOOL_PARAM_KEYS.length, t('tooldims.length'), base.y),
    def(TOOL_PARAM_KEYS.thickness, t('tooldims.thickness'), base.z),
  ];
}
