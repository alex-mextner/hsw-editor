import { Eye, EyeOff, Ruler, TriangleAlert } from 'lucide-react';
import { boardSizeMm, type Wall } from '@hsw-editor/core';
import { api } from '@/api/http.ts';
import { IconButton } from '@/components/IconButton.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { setSelection } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';
import { showPhoto } from '@/features/photo/photoActions.ts';
import { leavePhotoMode, photoStore, startCalibration } from '@/state/photo.ts';

/** Inspector content when nothing is selected: wall facts, photos and layout warnings. */
export function WallPanel({ wall }: { readonly wall: Wall }) {
  const { t, tn } = useI18n();
  const size = boardSizeMm(wall.board);
  const warnings = useStore(sessionStore)?.warnings ?? [];
  const photoMode = useStore(photoStore);
  const tools = wall.items.filter((item) => item.kind === 'tool').length;
  const holders = wall.items.filter(
    (item) => item.kind === 'holder' || item.kind === 'board-part',
  ).length;

  return (
    <div className="grid gap-5 p-3">
      <section className="grid gap-1.5">
        <h2 className="text-sm font-semibold">{wall.name}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t('wallpanel.size')}</dt>
          <dd className="font-mono">
            {Math.round(size.width)} × {Math.round(size.height)} mm
          </dd>
          <dt className="text-muted-foreground">{t('wallpanel.grid')}</dt>
          <dd className="font-mono">
            {wall.board.cols} × {wall.board.rows} · {wall.board.colPitchMm} /{' '}
            {wall.board.rowPitchMm} mm
          </dd>
          <dt className="text-muted-foreground">{t('wallpanel.contents')}</dt>
          <dd>
            {tn('wallpanel.holders', holders)}, {tn('wallpanel.tools', tools)}
          </dd>
          <dt className="text-muted-foreground">{t('wallpanel.revision')}</dt>
          <dd className="font-mono">{wall.rev}</dd>
        </dl>
      </section>

      <section className="grid gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t('wallpanel.photos')}
        </h3>
        {wall.photos.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('wallpanel.noPhotos')}</p>
        ) : (
          <ul className="grid gap-2">
            {wall.photos.map((photo) => {
              const shown = photoMode.photoId === photo.id;
              return (
                <li
                  key={photo.id}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border p-1.5',
                    shown ? 'border-primary' : 'border-border',
                  )}
                >
                  <img
                    src={api.photoUrl(wall.id, photo.id)}
                    alt=""
                    loading="lazy"
                    className="size-12 shrink-0 rounded object-cover"
                  />
                  <div className="min-w-0 flex-1 text-xs">
                    <div className="truncate font-medium">{photo.name ?? photo.id}</div>
                    <div className="text-muted-foreground">
                      {photo.calibration
                        ? t('wallpanel.calibrated', {
                            method: t(`calibration.${photo.calibration.method}`),
                          })
                        : t('wallpanel.uncalibrated')}
                    </div>
                  </div>
                  <IconButton
                    label={t('calibration.open')}
                    size="icon-xs"
                    onClick={() => startCalibration(photo.id)}
                  >
                    <Ruler />
                  </IconButton>
                  <IconButton
                    label={shown ? t('overlay.hide') : t('overlay.show')}
                    pressed={shown}
                    onClick={() => (shown ? leavePhotoMode() : showPhoto(photo))}
                  >
                    {shown ? <Eye /> : <EyeOff />}
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {warnings.length > 0 ? (
        <section className="grid gap-1.5">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-warn uppercase">
            <TriangleAlert className="size-3.5" aria-hidden />
            {tn('wallpanel.warnings', warnings.length)}
          </h3>
          <ul className="grid gap-1">
            {warnings.slice(0, 12).map((warning, index) => (
              <li key={`${warning.code}-${index}`}>
                <button
                  type="button"
                  className="w-full rounded-md px-2 py-1 text-left text-xs hover:bg-muted"
                  onClick={() => setSelection(warning.itemIds)}
                >
                  <span className="font-medium">{t(`warning.${warning.code}`)}</span>
                  <span className="block truncate text-muted-foreground">{warning.message}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
