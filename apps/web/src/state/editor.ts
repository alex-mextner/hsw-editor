import { createValueStore } from '#state-backend';
import type { ViewMode } from '@/scene/CameraRig.tsx';

export type ToolMode = 'select' | 'measure' | 'calibrate';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Pose of an item while it is being dragged/ghosted, before any op is sent. */
export interface PreviewPose {
  readonly x: number;
  readonly y: number;
  readonly rotZ: number;
}

/** Transient interaction state of the 3D editor: nothing here is persisted or sent to the server. */
export interface EditorState {
  readonly tool: ToolMode;
  readonly view: ViewMode;
  readonly selection: readonly string[];
  /** Lattice snapping; the Alt key inverts it for the duration of a drag. */
  readonly snap: boolean;
  readonly fitToken: number;
  readonly measure: { readonly a: Vec2 | null; readonly b: Vec2 | null };
  readonly overlay: { readonly photoId: string | null; readonly opacity: number };
  /** A pointer is down on an item (before or during a drag): the camera must not orbit. */
  readonly holding: boolean;
  /** Live poses of items being dragged, keyed by item id. */
  readonly dragging: ReadonlyMap<string, PreviewPose>;
  /** Whether the drag currently lands somewhere valid (colours the preview). */
  readonly dragValid: boolean;
  /** Bank element hovering over the viewport during drag-and-drop from the palette. */
  readonly ghost: {
    readonly bankId: string;
    readonly x: number;
    readonly y: number;
    readonly valid: boolean;
  } | null;
  /** Item whose params/variant are being edited by a widget (highlight in the scene). */
  readonly widgetItemId: string | null;
  /** Wall point (mm) picked with "add element here": the next element added from the bank goes there. */
  readonly placeAt: Vec2 | null;
}

const INITIAL: EditorState = {
  tool: 'select',
  view: 'perspective',
  selection: [],
  snap: true,
  fitToken: 0,
  measure: { a: null, b: null },
  overlay: { photoId: null, opacity: 0.5 },
  holding: false,
  dragging: new Map(),
  dragValid: true,
  ghost: null,
  widgetItemId: null,
  placeAt: null,
};

export const editorStore = createValueStore<EditorState>(INITIAL);

export function patchEditor(patch: Partial<EditorState>): void {
  editorStore.set({ ...editorStore.get(), ...patch });
}

export function setSelection(ids: readonly string[]): void {
  const current = editorStore.get().selection;
  if (ids.length === current.length && ids.every((id, i) => id === current[i])) return;
  patchEditor({ selection: ids });
}

/** Click semantics: plain click replaces, Ctrl/Shift click toggles membership. */
export function selectItem(id: string, additive: boolean): void {
  const current = editorStore.get().selection;
  if (!additive) {
    setSelection(current.length === 1 && current[0] === id ? current : [id]);
    return;
  }
  setSelection(current.includes(id) ? current.filter((other) => other !== id) : [...current, id]);
}

export function setTool(tool: ToolMode): void {
  patchEditor({ tool, measure: { a: null, b: null } });
}

export function fitView(): void {
  patchEditor({ fitToken: editorStore.get().fitToken + 1 });
}
