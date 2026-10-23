import { lazy, Suspense } from 'react';
import { CloudOff, Hexagon, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { newWallDialogStore } from '@/features/wizard/NewWallDialog.tsx';
import { useI18n } from '@/i18n/index.ts';
import { currentWallId } from '@/state/current-wall.ts';
import { editorStore } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { openWall, sessionStore, wallListStore } from '@/wall/session.ts';
import { WidgetHost } from '@/widgets/WidgetHost.tsx';
import { EmptyWallHints } from './EmptyWallHints.tsx';
import { ViewportHint, ViewportToolbar } from './ViewportToolbar.tsx';

// three.js is a big chunk; the shell (and the offline home screen) must paint without it.
const WallViewport = lazy(() =>
  import('@/scene/WallViewport.tsx').then((module) => ({ default: module.WallViewport })),
);

/** Centre of the editor: the 3D viewport when a wall is open, otherwise an explanatory state. */
export function ViewportArea() {
  const { t } = useI18n();
  const session = useStore(sessionStore);
  const { tool, placeAt } = useStore(editorStore);

  if (!session) return <HomeState />;
  if (session.status === 'error' || session.status === 'deleted') {
    return (
      <StateCard
        icon={<CloudOff className="size-6 text-destructive" aria-hidden />}
        title={session.status === 'deleted' ? t('state.deleted') : t('state.loadFailed')}
        body={session.errorMessage ?? undefined}
      >
        <Button variant="outline" onClick={() => openWall(session.wallId)}>
          {t('action.retry')}
        </Button>
        <Button variant="ghost" onClick={() => currentWallId.set(null)}>
          {t('state.backHome')}
        </Button>
      </StateCard>
    );
  }
  const wall = session.wall;
  if (!wall) {
    return (
      <StateCard
        icon={<Loader2 className="size-6 animate-spin text-primary" aria-hidden />}
        title={t('state.loading')}
      />
    );
  }
  return (
    <>
      <Suspense
        fallback={
          <StateCard
            icon={<Loader2 className="size-6 animate-spin text-primary" aria-hidden />}
            title={t('state.loading3d')}
          />
        }
      >
        <WallViewport wall={wall} />
      </Suspense>
      <ViewportToolbar />
      <ViewportHint
        text={
          tool === 'measure'
            ? t('hint.measure')
            : placeAt === null
              ? t('hint.select')
              : t('hint.placeAt')
        }
      />
      {wall.items.length === 0 ? <EmptyWallHints /> : null}
      <WidgetHost />
    </>
  );
}

function StateCard({
  icon,
  title,
  body,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly body?: string | undefined;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        {icon}
        <h2 className="text-base font-semibold">{title}</h2>
        {body ? <p className="text-sm break-words text-muted-foreground">{body}</p> : null}
        {children ? <div className="flex gap-2">{children}</div> : null}
      </div>
    </div>
  );
}

/** No wall open: offer to create one or reopen an existing wall. */
function HomeState() {
  const { t, tn } = useI18n();
  const list = useStore(wallListStore);
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-lg flex-col items-center gap-5 text-center">
        <div className="grid size-14 place-items-center rounded-2xl border border-primary/40 bg-accent">
          <Hexagon className="size-7 text-primary" aria-hidden />
        </div>
        <div className="grid gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">{t('home.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('home.subtitle')}</p>
        </div>
        <Button size="lg" className="gap-1.5" onClick={() => newWallDialogStore.set(true)}>
          <Plus /> {t('wall.new')}
        </Button>
        {list.walls.length > 0 ? (
          <div className="grid w-full gap-2 text-left">
            <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {t('home.recent')}
            </h2>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {list.walls.slice(0, 6).map((wall) => (
                <li key={wall.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-primary/60 hover:bg-muted"
                    onClick={() => currentWallId.set(wall.id)}
                  >
                    <span className="truncate font-medium">{wall.name}</span>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      {tn('wall.items', wall.items)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
