/**
 * Demo mode (`VITE_HSW_DEMO=1`, the GitHub Pages build at hsw.mextner.com): no daemon exists. The bank is read from files
 * copied next to the app (`scripts` in vite.config.ts), one bundled wall opens read-only, no `/api/walls` call is ever made
 * and edits are refused with a notice. The service worker still precaches the shell and caches the bank, so the demo also
 * works offline after the first visit.
 */
export const DEMO: boolean = import.meta.env['VITE_HSW_DEMO'] === '1';
