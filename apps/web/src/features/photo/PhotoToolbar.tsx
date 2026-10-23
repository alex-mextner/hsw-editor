import {
  Columns2,
  Download,
  ScanSearch,
  Eye,
  EyeOff,
  ImageOff,
  ImagePlus,
  ImageIcon,
  Layers,
  Move,
  RotateCw,
  Ruler,
} from 'lucide-react';
import { IconButton } from '@/components/IconButton.tsx';
import { Slider } from '@/components/ui/slider.tsx';
import { useShortcutLabel } from '@/commands/app.ts';
import { useI18n } from '@/i18n/index.ts';
import {
  photoStore,
  setOverlayOpacity,
  startCalibration,
  toggleAlign,
  togglePhotoHidden,
  toggleSplit,
} from '@/state/photo.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';
import { exportPhotoPng, findPhotoTools, togglePhotoMode } from './photoActions.ts';
import { findToolsStore } from './findTools.ts';
import { choosePhotoFile } from './photoImport.ts';

/** Photo controls of the viewport toolbar: photo mode on/off, import, calibrate, how the photo shows, board drag. */
export function PhotoToolbar() {
  const { t } = useI18n();
  const overlayKey = useShortcutLabel('view.overlay');
  const photo = useStore(photoStore);
  const wall = useStore(sessionStore)?.wall;
  const photoId = photo.photoId;
  const tools = useStore(findToolsStore);

  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border bg-panel/95 p-0.5 pr-2 shadow-sm backdrop-blur">
      <IconButton
        label={photoId !== null ? t('overlay.hide') : t('overlay.show')}
        shortcut={overlayKey}
        pressed={photoId !== null}
        disabled={!wall}
        onClick={togglePhotoMode}
      >
        {photoId !== null ? <Eye /> : <EyeOff />}
      </IconButton>
      <IconButton label={t('photo.import')} disabled={!wall} onClick={choosePhotoFile}>
        <ImagePlus />
      </IconButton>
      {photoId !== null ? (
        <>
          <IconButton
            label={t('calibration.open')}
            pressed={photo.calibrating}
            onClick={() => startCalibration(photoId)}
          >
            <Ruler />
          </IconButton>
          <div className="mx-0.5 h-5 w-px bg-border" />
          <IconButton
            label={photo.photoHidden ? t('photo.showPhoto') : t('photo.hidePhoto')}
            pressed={photo.photoHidden}
            onClick={togglePhotoHidden}
          >
            {photo.photoHidden ? <ImageOff /> : <ImageIcon />}
          </IconButton>
          <IconButton label={t('photo.split')} pressed={photo.split !== null} onClick={toggleSplit}>
            <Columns2 />
          </IconButton>
          <IconButton
            label={t('photo.moveBoard')}
            pressed={photo.align === 'move'}
            onClick={() => toggleAlign('move')}
          >
            <Move />
          </IconButton>
          <IconButton
            label={t('photo.rollBoard')}
            pressed={photo.align === 'roll'}
            onClick={() => toggleAlign('roll')}
          >
            <RotateCw />
          </IconButton>
          <IconButton
            label={
              tools.phase === 'unavailable'
                ? t('photo.findTools.unavailable')
                : t('photo.findTools')
            }
            disabled={
              tools.phase === 'running' || tools.phase === 'unavailable' || photo.calibrating
            }
            onClick={() => void findPhotoTools()}
          >
            <ScanSearch />
          </IconButton>
          <IconButton
            label={t('photo.export')}
            disabled={photo.calibrating}
            onClick={() => void exportPhotoPng()}
          >
            <Download />
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
