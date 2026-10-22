import {
  Box,
  Eye,
  EyeOff,
  Layers,
  Magnet,
  Maximize,
  MousePointer2,
  Ruler,
  Scan,
  Square,
} from 'lucide-react';
import { IconButton } from '@/components/IconButton.tsx';
import { Slider } from '@/components/ui/slider.tsx';
import { useI18n } from '@/i18n/index.ts';
import { editorStore, fitView, patchEditor, setTool } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';

/** Floating tool strip over the viewport: select/measure, camera mode, snap, fit and the photo overlay. */
export function ViewportToolbar() {
  const { t } = useI18n();
  const editor = useStore(editorStore);
  const photos = useStore(sessionStore)?.wall?.photos ?? [];
  const overlayOn = editor.overlay.photoId !== null;
  const firstPhoto = photos[0];

  return (
    <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex flex-wrap items-start gap-2">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border bg-panel/95 p-0.5 shadow-sm backdrop-blur">
        <IconButton
          label={t('tool.select')}
          shortcut="V"
          pressed={editor.tool === 'select'}
          onClick={() => setTool('select')}
        >
          <MousePointer2 />
        </IconButton>
        <IconButton
          label={t('tool.measure')}
          shortcut="M"
          pressed={editor.tool === 'measure'}
          onClick={() => setTool(editor.tool === 'measure' ? 'select' : 'measure')}
        >
          <Ruler />
        </IconButton>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <IconButton
          label={editor.view === 'front' ? t('view.perspective') : t('view.front')}
          shortcut="O"
          pressed={editor.view === 'front'}
          onClick={() => patchEditor({ view: editor.view === 'front' ? 'perspective' : 'front' })}
        >
          {editor.view === 'front' ? <Square /> : <Box />}
        </IconButton>
        <IconButton label={t('view.fit')} shortcut="F" onClick={fitView}>
          <Maximize />
        </IconButton>
        <IconButton
          label={t('tool.snap')}
          shortcut="S"
          pressed={editor.snap}
          onClick={() => patchEditor({ snap: !editor.snap })}
        >
          <Magnet />
        </IconButton>
      </div>

      {firstPhoto ? (
        <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border bg-panel/95 p-0.5 pr-2 shadow-sm backdrop-blur">
          <IconButton
            label={overlayOn ? t('overlay.hide') : t('overlay.show')}
            shortcut="P"
            pressed={overlayOn}
            onClick={() =>
              patchEditor({
                overlay: {
                  ...editor.overlay,
                  photoId: overlayOn ? null : (editor.overlay.photoId ?? firstPhoto.id),
                },
              })
            }
          >
            {overlayOn ? <Eye /> : <EyeOff />}
          </IconButton>
          <Layers className="size-3.5 text-muted-foreground" aria-hidden />
          <Slider
            className="w-24"
            min={0}
            max={1}
            step={0.05}
            value={[editor.overlay.opacity]}
            aria-label={t('overlay.opacity')}
            disabled={!overlayOn}
            onValueChange={(value) => {
              const next = Array.isArray(value) ? value[0] : value;
              if (typeof next === 'number')
                patchEditor({ overlay: { ...editor.overlay, opacity: next } });
            }}
          />
          <span className="w-8 text-right font-mono text-[10px] text-muted-foreground">
            {Math.round(editor.overlay.opacity * 100)}%
          </span>
        </div>
      ) : null}
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
