import { searchPalette, type PaletteResults } from '@hsw-editor/commands';
import { useEffect, useState } from 'react';
import { bankStore } from '@/bank/client.ts';
import { aiSession } from '@/commands/aiSession.ts';
import { getBaseContext, keymapStore, settingsStore, usageStore } from '@/commands/app.ts';
import { paletteProviders } from '@/commands/paletteSources.ts';
import { useI18n } from '@/i18n/index.ts';
import { sessionStore, wallListStore } from '@/wall/session.ts';

/** Bumps whenever something a result row shows (a setting value, a wall name, a key) changed. */
function useSourceVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = (): void => setVersion((current) => current + 1);
    const stops = [
      settingsStore.subscribe(bump),
      keymapStore.subscribe(bump),
      bankStore.subscribe(bump),
      wallListStore.subscribe(bump),
      sessionStore.subscribe(bump),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, []);
  return version;
}

/**
 * Runs the palette search for `input` while the palette is mounted (open). The previous results
 * stay on screen until the next ones arrive, so typing does not flash an empty list.
 */
export function usePaletteSearch(input: string): PaletteResults | null {
  const { locale } = useI18n();
  const version = useSourceVersion();
  const [results, setResults] = useState<PaletteResults | null>(null);

  // `version` only re-triggers the search: the sources themselves are read inside it.
  useEffect(() => {
    const controller = new AbortController();
    void version;
    searchPalette({
      input,
      providers: paletteProviders,
      locale,
      context: getBaseContext(),
      usage: usageStore.get(),
      now: Date.now(),
      askAi: (text) => aiSession.ask(text),
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) setResults(next);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [input, locale, version]);

  return results;
}
