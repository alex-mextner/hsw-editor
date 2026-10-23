import { Eye, EyeOff, ImagePlus, Layers, RulerIcon } from 'lucide-react';
import { IconButton } from '@/components/IconButton.tsx';
import { Slider } from '@/components/ui/slider.tsx';
import { useShortcutLabel } from '@/commands/app.ts';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';
import { togglePhotoMode } from './photoActions.ts';
import { choosePhotoFile } from './photoImport.ts';
import { photoStore, setOverlayOpacity, startCalibration } from '@/state/photo.ts';

/** Photo controls of the viewport toolbar: photo mode on/off, import, calibrate and the overlay opacity. */
export function PhotoToolbar() {
  const { t } = useI18n();
  const overlayKey = useShortcutLabel('view.overlay');
  const photo = useStore(photoStore);
  const wall = useStore(sessionStore)?.wall;
  const active = photo.photoId !== null;

  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border bg-panel/95 p-0.5 pr-2 shadow-sm backdrop-blur">
      <IconButton
        label={active ? t('overlay.hide') : t('overlay.show')}
        shortcut={overlayKey}
        pressed={active}
        disabled={!wall}
        onClick={togglePhotoMode}
      >
        {active ? <Eye /> : <EyeOff />}
      </IconButton>
      <IconButton label={t('photo.import')} disabled={!wall} onClick={choosePhotoFile}>
        <ImagePlus />
      </IconButton>
      {active && photo.photoId !== null ? (
        <>
          <IconButton
            label={t('calibration.open')}
            pressed={photo.calibrating}
            onClick={() => startCalibration(photo.photoId ?? '')}
          >
            <RulerIcon />
          </IconButton>
          <Layers className="size-3.5 text-muted-foreground" aria-hidden />
          <Slider
            className="w-24"
            min={0}
            max={1}
            step={0.05}
            value={[photo.overlayOpacity]}
            aria-label={t('overlay.opacity')}
            onValueChange={(value) => {
              const next = Array.isArray(value) ? value[0] : value;
              if (typeof next === 'number') setOverlayOpacity(next);
            }}
          />
          <span className="w-8 text-right font-mono text-[10px] text-muted-foreground">
            {Math.round(photo.overlayOpacity * 100)}%
          </span>
        </>
      ) : null}
    </div>
  );
}
