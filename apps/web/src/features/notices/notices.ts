import { createValueStore } from '#state-backend';

export type NoticeKind = 'info' | 'error';

/** A button inside a toast; `run` is called on click and the toast stays unless `run` dismisses it. */
export interface ToastAction {
  readonly label: string;
  readonly run: () => void;
}

export interface Toast {
  readonly id: number;
  readonly kind: NoticeKind;
  readonly text: string;
  readonly actions: readonly ToastAction[];
}

export interface NotifyOptions {
  readonly actions?: readonly ToastAction[];
  /** Stays until dismissed (or replaced), instead of vanishing after a few seconds. */
  readonly persistent?: boolean;
}

export const toastStore = createValueStore<readonly Toast[]>([]);

let nextId = 1;
const LIFETIME_MS = 4500;
const MAX_TOASTS = 4;
/** Pending auto-dismiss per toast id, so replacing or closing a toast also cancels its timer. */
const timers = new Map<number, Parameters<typeof clearTimeout>[0]>();

function schedule(id: number, options: NotifyOptions): void {
  if (options.persistent) return;
  timers.set(
    id,
    globalThis.setTimeout(() => dismiss(id), LIFETIME_MS),
  );
}

/** Shows a toast and returns its id. Callers pass already translated text. */
export function notify(kind: NoticeKind, text: string, options: NotifyOptions = {}): number {
  const toast: Toast = { id: nextId++, kind, text, actions: options.actions ?? [] };
  const next = [...toastStore.get(), toast];
  const dropped = next.length > MAX_TOASTS ? next.slice(0, next.length - MAX_TOASTS) : [];
  for (const old of dropped) clearTimer(old.id);
  toastStore.set(next.slice(-MAX_TOASTS));
  schedule(toast.id, options);
  return toast.id;
}

/** Swaps the content of a live toast in place (same slot, new text/actions); false if it is gone. */
export function replaceToast(
  id: number,
  kind: NoticeKind,
  text: string,
  options: NotifyOptions = {},
): boolean {
  if (!toastStore.get().some((toast) => toast.id === id)) return false;
  clearTimer(id);
  toastStore.set(
    toastStore
      .get()
      .map((toast) =>
        toast.id === id ? { id, kind, text, actions: options.actions ?? [] } : toast,
      ),
  );
  schedule(id, options);
  return true;
}

function clearTimer(id: number): void {
  globalThis.clearTimeout(timers.get(id));
  timers.delete(id);
}

export function dismiss(id: number): void {
  clearTimer(id);
  toastStore.set(toastStore.get().filter((toast) => toast.id !== id));
}
