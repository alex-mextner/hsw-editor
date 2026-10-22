import type { Mounting, ParamDef, Provenance, SourceRef } from '@hsw-editor/bank';
import type { MessageKey } from '@/i18n/index.ts';
import type { OriginFilter, SizeBucket } from './filters.ts';

/** Message keys of the filter options, shared by the filter panel and its active-filter chips. */
export const SIZE_LABELS: Readonly<Record<SizeBucket, MessageKey>> = {
  s1: 'bank.sizeOption.s1',
  s2: 'bank.sizeOption.s2',
  s3to4: 'bank.sizeOption.s3to4',
  s5plus: 'bank.sizeOption.s5plus',
};

export const ORIGIN_LABELS: Readonly<Record<OriginFilter, MessageKey>> = {
  all: 'bank.originOption.all',
  generated: 'bank.originOption.generated',
  sources: 'bank.originOption.sources',
};

/** Message keys for the enum-valued fields shown in the detail view. */
export const MOUNTING_LABELS: Readonly<Record<Mounting['kind'], MessageKey>> = {
  'hex-plug': 'bank.mounting.hex-plug',
  'm3-screw': 'bank.mounting.m3-screw',
  clip: 'bank.mounting.clip',
  none: 'bank.mounting.none',
};

export const UNIT_LABELS: Readonly<Record<ParamDef['unit'], MessageKey>> = {
  mm: 'bank.unit.mm',
  count: 'bank.unit.count',
  deg: 'bank.unit.deg',
};

export const PROVENANCE_LABELS: Readonly<Record<Provenance['origin'], MessageKey>> = {
  'source-file': 'bank.provenance.source-file',
  'project-original': 'bank.provenance.project-original',
  generated: 'bank.provenance.generated',
};

export const SITE_LABELS: Readonly<Record<SourceRef['site'], MessageKey>> = {
  printables: 'bank.site.printables',
  makerworld: 'bank.site.makerworld',
  thingiverse: 'bank.site.thingiverse',
  'hsw-project': 'bank.site.hsw-project',
  unknown: 'bank.site.unknown',
};
