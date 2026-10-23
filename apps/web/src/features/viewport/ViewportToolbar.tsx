import { Box, Magnet, Maximize, MousePointer2, Ruler, Scan, Square } from 'lucide-react';
import { useShortcutLabel } from '@/commands/app.ts';
import { IconButton } from '@/components/IconButton.tsx';
import { useI18n } from '@/i18n/index.ts';
import { editorStore, fitView, patchEditor, setTool } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { PhotoToolbar } from '@/features/photo/PhotoToolbar.tsx';

/** Floating tool strip over the viewport: select/measure, camera mode, snap, fit and the photo controls. */
export function ViewportToolbar() {
  const { t } = useI18n();
  const editor = useStore(editorStore);
  const keys = {
    select: useShortcutLabel('tool.select'),
    measure: useShortcutLabel('tool.measure'),
    view: useShortcutLabel('view.toggle'),
    fit: useShortcutLabel('view.fit'),
    snap: useShortcutLabel('tool.snap'),
  };

  return (
    <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex flex-wrap items-start gap-2">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border bg-panel/95 p-0.5 shadow-sm backdrop-blur">
        <IconButton
          label={t('tool.select')}
          shortcut={keys.select}
          pressed={editor.tool === 'select'}
          onClick={() => setTool('select')}
        >
          <MousePointer2 />
        </IconButton>
        <IconButton
          label={t('tool.measure')}
          shortcut={keys.measure}
          pressed={editor.tool === 'measure'}
          onClick={() => setTool(editor.tool === 'measure' ? 'select' : 'measure')}
        >
          <Ruler />
        </IconButton>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <IconButton
          label={editor.view === 'front' ? t('view.perspective') : t('view.front')}
          shortcut={keys.view}
          pressed={editor.view === 'front'}
          onClick={() => patchEditor({ view: editor.view === 'front' ? 'perspective' : 'front' })}
        >
          {editor.view === 'front' ? <Square /> : <Box />}
        </IconButton>
        <IconButton label={t('view.fit')} shortcut={keys.fit} onClick={fitView}>
          <Maximize />
        </IconButton>
        <IconButton
          label={t('tool.snap')}
          shortcut={keys.snap}
          pressed={editor.snap}
          onClick={() => patchEditor({ snap: !editor.snap })}
        >
          <Magnet />
        </IconButton>
      </div>
      <PhotoToolbar />
    </div>
  );
}

export function ViewportHint({ text }: { readonly text: string }) {
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 z-10 flex items-center gap-1.5 rounded-md bg-panel/90 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">
      <Scan className="size-3" aria-hidden />
      {text}
    </div>
  );
}
