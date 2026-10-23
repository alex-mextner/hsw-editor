/**
 * The ONE managed vision client of the daemon: the `vision.*` jobs and the tool import (`/api/tools`) talk to the same
 * sidecar, so it is started lazily once, stopped when idle, and its GPU models are shared between them.
 */
import { resolve } from 'node:path';
import { loadConfig } from '../config.ts';
import { HttpVisionClient } from './client.ts';
import { readSegmentQuality } from './settings.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');

/** The user's segmentation quality (`vision.segmentQuality`), read when a request is made. */
export const userSegmentQuality = () => readSegmentQuality(loadConfig().home);

export const visionClient = new HttpVisionClient({
  repoRoot: REPO_ROOT,
  segmentQuality: userSegmentQuality,
});
