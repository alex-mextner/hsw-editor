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
  if (compact === 'PROJECT-ORIGINAL') return { ...base, spdx: 'MIT', redistributable: true };
  if (/STANDARD-DIGITAL-FILE/.test(compact)) {
    return { ...base, spdx: 'LicenseRef-Standard-Digital-File', redistributable: false };
  }
  // Any restriction wording wins over a "BY"/"Attribution" prefix: the product is public and MIT.
  const noDerivatives = /NO-?DERIV|(?:^|-)ND(?:-|$)/.test(compact);
  const shareAlike = /SHARE-?ALIKE|(?:^|-)SA(?:-|$)/.test(compact);
  const nonCommercial = /NON-?COMMERCIAL|(?:^|-)NC(?:-|$)/.test(compact);
  if (noDerivatives) return { ...base, spdx: 'LicenseRef-Unknown', redistributable: false };
  if (nonCommercial && shareAlike)
    return { ...base, spdx: 'CC-BY-NC-SA-4.0', redistributable: false };
  if (nonCommercial) return { ...base, spdx: 'CC-BY-NC-4.0', redistributable: false };
  if (shareAlike) return { ...base, spdx: 'LicenseRef-Unknown', redistributable: false };
  if (/^(?:CC-)?BY(?:-4\.0)?$/.test(compact) || /^CC-ATTRIBUTION(?:-4\.0)?$/.test(compact)) {
    return { ...base, spdx: 'CC-BY-4.0', redistributable: true };
  }
  return { ...base, spdx: 'LicenseRef-Unknown', redistributable: false };
}
