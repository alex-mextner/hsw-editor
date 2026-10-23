import { createValueStore } from '#state-backend';

export type NoticeKind = 'info' | 'error';

export interface Toast {
  readonly id: number;
  readonly kind: NoticeKind;
  readonly text: string;
}

export const toastStore = createValueStore<readonly Toast[]>([]);

let nextId = 1;
const LIFETIME_MS = 4500;

/** Shows a short toast. Callers pass already translated text. */
export function notify(kind: NoticeKind, text: string): void {
  const toast: Toast = { id: nextId++, kind, text };
  toastStore.set([...toastStore.get(), toast].slice(-4));
  setTimeout(() => dismiss(toast.id), LIFETIME_MS);
}

export function dismiss(id: number): void {
  toastStore.set(toastStore.get().filter((toast) => toast.id !== id));
}
