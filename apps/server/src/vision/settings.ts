/**
 * The vision-related user settings the daemon needs outside the web client: today only the segmentation quality
 * (`vision.segmentQuality`, declared in `apps/web/src/commands/appSettings.ts`). They live in the `settings` namespace of
 * `<home>/settings.json` as `{ "<setting id>": value }` overrides; an absent key means the default (the sidecar's `fast`).
 * The file is read at request time (it is small and written atomically), so a change applies to the next request.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSettingsDocument, SettingsContractError } from '@hsw-editor/user-settings';
import { SETTINGS_FILE } from '../settings.ts';
import { SegmentQualitySchema, type SegmentQuality } from './types.ts';

/** The namespace of the web client's settings store (`apps/web/src/commands/settingsSync.ts`). */
const SETTINGS_NAMESPACE = 'settings';

export const SEGMENT_QUALITY_SETTING = 'vision.segmentQuality';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The user's choice, or `undefined` when none is stored, the file is absent/corrupt or the value is not a known quality. */
export async function readSegmentQuality(home: string): Promise<SegmentQuality | undefined> {
  let text: string;
  try {
    text = await readFile(join(home, SETTINGS_FILE), 'utf8');
  } catch {
    // absent or unreadable: a preference lookup never fails a segmentation, the sidecar default applies
    return undefined;
  }
  try {
    const overrides = parseSettingsDocument(JSON.parse(text)).data[SETTINGS_NAMESPACE];
    if (!isPlainObject(overrides)) return undefined;
    const parsed = SegmentQualitySchema.safeParse(overrides[SEGMENT_QUALITY_SETTING]);
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    // a corrupt document is moved aside by the SettingsStore on its next load; the sidecar default applies meanwhile
    if (error instanceof SyntaxError || error instanceof SettingsContractError) return undefined;
    throw error;
  }
}
