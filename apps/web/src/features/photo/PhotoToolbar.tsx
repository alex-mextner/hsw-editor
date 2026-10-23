import {
  Columns2,
  Download,
  Contrast,
  Eraser,
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
import { useI18n, type MessageKey } from '@/i18n/index.ts';
import {
  photoStore,
  type WebContrastMode,
  setOverlayOpacity,
  cycleWebContrast,
  startCalibration,
  toggleAlign,
  toggleShowCleaned,
  togglePhotoHidden,
  toggleSplit,
} from '@/state/photo.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';
import {
  cleanPhotoBackground,
  exportPhotoPng,
  findPhotoTools,
  isGridCalibrated,
  togglePhotoMode,
} from './photoActions.ts';
import { findToolsStore } from './findTools.ts';
import { choosePhotoFile } from './photoImport.ts';
import { cleanStore, type AiState, type CleanState } from './cleanBackground.ts';

const WEB_CONTRAST_LABEL = {
  auto: 'photo.webContrast.auto',
  on: 'photo.webContrast.on',
  off: 'photo.webContrast.off',
} as const satisfies Record<WebContrastMode, MessageKey>;

/** Why the AI clean did not replace the basic one, per outcome of the last run: a few words and the full sentence. */
const AI_NOTE = {
  login_required: ['photo.clean.short.login_required', 'photo.clean.ai.login_required'],
  quota_exhausted: ['photo.clean.short.quota_exhausted', 'photo.clean.ai.quota_exhausted'],
  unavailable: ['photo.clean.short.unavailable', 'photo.clean.ai.unavailable'],
  rejected: ['photo.clean.short.rejected', 'photo.clean.ai.rejected'],
  failed: ['photo.clean.short.failed', 'photo.clean.ai.failed'],
  disabled: ['photo.clean.short.disabled', 'photo.clean.ai.disabled'],
} as const satisfies Partial<Record<AiState, readonly [MessageKey, MessageKey]>>;

/** The quiet note next to the clean button, and the longer sentence behind it (the tooltip). */
function cleanNote(
  state: CleanState,
  variantBackend: string | null,
  t: (key: MessageKey) => string,
): { readonly text: string | null; readonly detail: string | null } {
  if (state.phase === 'running') return { text: t('photo.clean.running'), detail: null };
  if (variantBackend === null) return { text: null, detail: null };
  if (variantBackend !== 'basic') {
    return { text: t('photo.clean.ai'), detail: t('photo.clean.status.ai') };
  }
  const why =
    state.phase === 'done' && state.ai in AI_NOTE
      ? AI_NOTE[state.ai as keyof typeof AI_NOTE]
      : null;
  const basic = t('photo.clean.basic');
  return {
    text: why === null ? basic : `${basic} · ${t(why[0])}`,
    detail:
      why === null
        ? t('photo.clean.status.basic')
        : `${t('photo.clean.status.basic')} ${t(why[1])}`,
  };
}

/** Photo controls of the viewport toolbar: photo mode on/off, import, calibrate, how the photo shows, board drag. */
export function PhotoToolbar() {
  const { t } = useI18n();
  const overlayKey = useShortcutLabel('view.overlay');
  const photo = useStore(photoStore);
  const wall = useStore(sessionStore)?.wall;
  const photoId = photo.photoId;
  const tools = useStore(findToolsStore);
  const clean = useStore(cleanStore);
  const variant = wall?.photos.find((entry) => entry.cleanOf === photoId);
  const note = cleanNote(clean, variant?.backend ?? null, t);
  // A grid-detected calibration sits on the real lattice: turning the board would take it off.
  const onLattice = isGridCalibrated(wall, photoId);

  return (
    <div className="pointer-events-auto flex max-w-[calc(100vw-1rem)] flex-wrap items-center gap-1 rounded-lg border border-border bg-panel/95 p-0.5 pr-2 shadow-sm backdrop-blur">
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
          <IconButton
            label={t(WEB_CONTRAST_LABEL[photo.webContrast])}
            pressed={photo.webContrast === 'on'}
            onClick={cycleWebContrast}
          >
            <Contrast />
          </IconButton>
          <IconButton
            label={
              variant === undefined
                ? t('photo.clean.make')
                : photo.showCleaned
                  ? t('photo.clean.show')
                  : t('photo.clean.hide')
            }
            pressed={variant !== undefined && photo.showCleaned}
            disabled={photo.calibrating || clean.phase === 'running'}
            onClick={variant === undefined ? cleanPhotoBackground : toggleShowCleaned}
          >
            <Eraser />
          </IconButton>
          {note.text === null ? null : (
            <span
              data-slot="clean-note"
              aria-live="polite"
              title={note.detail ?? undefined}
              className="text-[10px] text-muted-foreground"
            >
              {note.text}
            </span>
          )}
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
            disabled={onLattice}
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
