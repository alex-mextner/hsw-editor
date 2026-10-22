import { createPersistedStore } from './persisted.ts';

export type Theme = 'dark' | 'light';

export const themeStore = createPersistedStore<Theme>(
  'hsw-editor.theme',
  'dark',
  (raw) => (raw === 'dark' || raw === 'light' ? raw : null),
  (value) => value,
);

function apply(theme: Theme): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

apply(themeStore.get());
themeStore.subscribe(() => apply(themeStore.get()));

export function toggleTheme(): void {
  themeStore.set(themeStore.get() === 'dark' ? 'light' : 'dark');
}
