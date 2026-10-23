import { createValueStore } from '#state-backend';

export type LeftTab = 'bank' | 'tools';

/** Which tab of the left panel is open; a store so commands can bring the tool library forward. */
export const leftTabStore = createValueStore<LeftTab>('bank');
