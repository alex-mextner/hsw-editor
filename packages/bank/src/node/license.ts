import type { License } from '../schema.ts';

export interface ObservedLicense {
  /** Licence wording as found at the source. */
  observed: string;
  attribution: string;
  url?: string;
}

/**
 * Maps observed wording onto the licence ids of the schema. Redistribution policy (Decision 3 of the
 * design spec): only permissive terms may be committed to the public MIT repo — CC-BY and the
 * project's own work. NC / SA / platform-specific / unknown licences are built locally at setup only.
 */
export function normalizeLicense({ observed, attribution, url }: ObservedLicense): License {
  const text = observed.trim();
  const compact = text.toUpperCase().replace(/[\s_]+/g, '-');
  const base = { observed: text || 'not recorded', attribution, ...(url ? { url } : {}) };
  if (/^PROJECT-ORIGINAL$/.test(compact)) return { ...base, spdx: 'MIT', redistributable: true };
  if (/BY-NC-SA|BY-SA-NC/.test(compact))
    return { ...base, spdx: 'CC-BY-NC-SA-4.0', redistributable: false };
  if (/BY-NC/.test(compact)) return { ...base, spdx: 'CC-BY-NC-4.0', redistributable: false };
  if (/^(?:CC-)?(?:BY|BY-4\.0|ATTRIBUTION)$/.test(compact) || /^CC-ATTRIBUTION/.test(compact)) {
    return { ...base, spdx: 'CC-BY-4.0', redistributable: true };
  }
  if (/STANDARD-DIGITAL-FILE/.test(compact)) {
    return { ...base, spdx: 'LicenseRef-Standard-Digital-File', redistributable: false };
  }
  return { ...base, spdx: 'LicenseRef-Unknown', redistributable: false };
}
