/** Minimal external-store contract shared by both backends (matches useSyncExternalStore). */
export interface Store<T> {
  readonly getSnapshot: () => T;
  readonly subscribe: (notify: () => void) => () => void;
}

export interface ValueStore<T> extends Store<T> {
  get(): T;
  set(value: T): void;
}
