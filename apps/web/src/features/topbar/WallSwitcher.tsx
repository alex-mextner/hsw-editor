import { useState } from 'react';
import { Check, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Input } from '@/components/ui/input.tsx';
import { notify } from '@/features/notices/notices.ts';
import { newWallDialogStore } from '@/features/wizard/NewWallDialog.tsx';
import { useI18n } from '@/i18n/index.ts';
import { currentWallId } from '@/state/current-wall.ts';
import { useStore } from '@/state/react.ts';
import { DEMO } from '@/demo/mode.ts';
import { DEMO_WALL_ID } from '@/demo/demoApi.ts';
import {
  deleteWall,
  refreshWalls,
  sessionStore,
  submitOps,
  wallListStore,
} from '@/wall/session.ts';

/** Current wall name with a menu to switch, create, rename or delete walls. */
export function WallSwitcher() {
  const { t, tn } = useI18n();
  const session = useStore(sessionStore);
  const list = useStore(wallListStore);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const wall = session?.wall ?? null;
  const label = wall?.name ?? (session ? t('wall.loading') : t('wall.none'));

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void refreshWalls()}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="max-w-48 gap-1 px-2 font-medium sm:max-w-64"
              aria-label={t('wall.switch')}
            />
          }
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('wall.walls')}</DropdownMenuLabel>
            {list.status === 'error' ? (
              <p className="px-2 py-1.5 text-xs text-destructive">{t('wall.listFailed')}</p>
            ) : null}
            {list.walls.length === 0 && list.status === 'ready' ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('wall.empty')}</p>
            ) : null}
            {list.walls.map((entry) => (
              <DropdownMenuItem key={entry.id} onClick={() => currentWallId.set(entry.id)}>
                <span className="flex-1 truncate">{entry.name}</span>
                <span className="text-xs text-muted-foreground">
                  {tn('wall.items', entry.items)}
                </span>
                {entry.id === wall?.id ? <Check className="text-primary" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => newWallDialogStore.set(true)}>
            <Plus /> {t('wall.new')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!wall} onClick={() => setDialog('rename')}>
            <Pencil /> {t('wall.rename')}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={!wall || (DEMO && wall.id === DEMO_WALL_ID)}
            onClick={() => setDialog('delete')}
          >
            <Trash2 /> {t('wall.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          {wall && dialog === 'rename' ? (
            <RenameForm initial={wall.name} onDone={() => setDialog(null)} />
          ) : null}
          {wall && dialog === 'delete' ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('wall.deleteTitle', { name: wall.name })}</DialogTitle>
                <DialogDescription>{t('wall.deleteHint')}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setDialog(null)}>
                  {t('action.cancel')}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setDialog(null);
                    void deleteWall(wall.id)
                      .then(() => refreshWalls())
                      .then(() => {
                        const rest = wallListStore
                          .get()
                          .walls.filter((entry) => entry.id !== wall.id);
                        currentWallId.set(rest[0]?.id ?? null);
                      })
                      .catch((error: unknown) =>
                        notify('error', error instanceof Error ? error.message : String(error)),
                      );
                  }}
                >
                  {t('wall.delete')}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function RenameForm({
  initial,
  onDone,
}: {
  readonly initial: string;
  readonly onDone: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial);
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (trimmed && trimmed !== initial)
          submitOps([{ type: 'rename', name: trimmed }], 'rename-wall');
        onDone();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('wall.rename')}</DialogTitle>
      </DialogHeader>
      <Input
        value={name}

        aria-label={t('wizard.name')}
        onChange={(event) => setName(event.target.value)}
      />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" disabled={name.trim().length === 0}>
          {t('action.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}
