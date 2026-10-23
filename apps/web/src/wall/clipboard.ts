import { createValueStore } from '#state-backend';
import type { WallItem } from '@hsw-editor/core';

/** Items put there by Copy; Paste places copies of them. In memory only, per tab. */
export const clipboardStore = createValueStore<readonly WallItem[]>([]);
