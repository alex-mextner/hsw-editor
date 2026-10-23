import { useRef } from 'react';
import {
  Bot,
  Command,
  Download,
  Ellipsis,
  Hexagon,
  ImagePlus,
  Languages,
  Moon,
  PanelLeft,
  PanelRight,
  Redo2,
  Search,
  Sun,
  Undo2,
} from 'lucide-react';
import { api } from '@/api/http.ts';
import { IconButton } from '@/components/IconButton.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Button } from '@/components/ui/button.tsx';
import { openPalette, useShortcutLabel } from '@/commands/app.ts';
import { LOCALES, localeStore, useI18n, type Locale } from '@/i18n/index.ts';
import { layoutStore, togglePanel } from '@/state/layout.ts';
import { patchEditor } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { themeStore, toggleTheme } from '@/state/theme.ts';
import { redoEdit, sessionStore, undoEdit } from '@/wall/session.ts';
import { InvalidZonesToggle } from '@/features/invalid-zones/InvalidZonesToggle.tsx';
import { PresenceBadge } from './PresenceBadge.tsx';
import { SyncStatus } from './SyncStatus.tsx';
import { WallSwitcher } from './WallSwitcher.tsx';
import { notify } from '@/features/notices/notices.ts';

export function TopBar() {
  const { t } = useI18n();
  const layout = useStore(layoutStore);
  const theme = useStore(themeStore);
  const session = useStore(sessionStore);
  const fileInput = useRef<HTMLInputElement>(null);
  const keys = {
    bank: useShortcutLabel('panel.bank'),
    undo: useShortcutLabel('edit.undo'),
    redo: useShortcutLabel('edit.redo'),
    agent: useShortcutLabel('panel.omp'),
    inspector: useShortcutLabel('panel.inspector'),
    palette: useShortcutLabel('app.palette'),
  };
  const wallId = session?.wallId ?? null;
  const ready = session?.status === 'ready' || session?.status === 'offline';

  const importPhoto = async (file: File): Promise<void> => {
    if (!wallId) return;
    try {
      const photoId = await api.uploadPhoto(wallId, file);
      patchEditor({ overlay: { photoId, opacity: 0.5 } });
      notify('info', t('photo.imported', { name: file.name }));
    } catch (error) {
      notify(
        'error',
        t('photo.importFailed', { reason: error instanceof Error ? error.message : String(error) }),
      );
    }
  };

  return (
    <>
      <IconButton
        label={t('panel.bank')}
        shortcut={keys.bank}
        pressed={layout.leftOpen}
        onClick={() => togglePanel('leftOpen')}
      >
        <PanelLeft />
      </IconButton>
      <div className="flex items-center gap-1.5 pr-1 font-semibold tracking-tight max-sm:hidden">
        <Hexagon className="size-4 text-primary" aria-hidden />
        <span>{t('app.name')}</span>
      </div>
      <div className="mx-1 h-5 w-px bg-border" />
      <WallSwitcher />
      <div className="mx-1 h-5 w-px bg-border max-sm:hidden" />
      <IconButton
        label={t('action.undo')}
        shortcut={keys.undo}
        disabled={!session?.canUndo}
        onClick={undoEdit}
      >
        <Undo2 />
      </IconButton>
      <IconButton
        label={t('action.redo')}
        shortcut={keys.redo}
        disabled={!session?.canRedo}
        onClick={redoEdit}
      >
        <Redo2 />
      </IconButton>
      <InvalidZonesToggle />

      <div className="flex-1" />

      <PresenceBadge />
      <SyncStatus />

      <div className="flex items-center gap-0.5 max-md:hidden">
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          aria-label={t('photo.import')}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importPhoto(file);
          }}
        />
        <IconButton
          label={t('photo.import')}
          disabled={!ready}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus />
        </IconButton>
        <IconButton
          label={t('wall.export')}
          disabled={!ready}
          onClick={() => wallId && globalThis.open(api.exportUrl(wallId), '_blank', 'noopener')}
        >
          <Download />
        </IconButton>
        <LanguageMenu />
        <IconButton
          label={theme === 'dark' ? t('theme.light') : t('theme.dark')}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </IconButton>
      </div>

      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 text-muted-foreground max-md:hidden"
        onClick={() => openPalette()}
        aria-label={t('palette.title')}
      >
        <Command />
        <span>{t('palette.open')}</span>
        {keys.palette ? <kbd className="font-mono text-[10px]">{keys.palette}</kbd> : null}
      </Button>

      <div className="md:hidden">
        <IconButton label={t('palette.openButton')} onClick={() => openPalette()}>
          <Search />
        </IconButton>
      </div>
      <IconButton
        label={t('panel.omp')}
        shortcut={keys.agent}
        pressed={layout.ompOpen}
        onClick={() => togglePanel('ompOpen')}
      >
        <Bot />
      </IconButton>
      <OverflowMenu onImport={() => fileInput.current?.click()} wallId={wallId} ready={ready} />
      <IconButton
        label={t('panel.inspector')}
        shortcut={keys.inspector}
        pressed={layout.rightOpen}
        onClick={() => togglePanel('rightOpen')}
      >
        <PanelRight />
      </IconButton>
    </>
  );
}

function LanguageMenu() {
  const { t, locale } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={t('language.label')} />}
      >
        <Languages />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('language.label')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={locale}
            onValueChange={(value) => {
              if (LOCALES.some((candidate) => candidate === value))
                localeStore.set(value as Locale);
            }}
          >
            <DropdownMenuRadioItem value="ru">{t('language.ru')}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="en">{t('language.en')}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Narrow screens: the rarely used actions collapse into one menu. */
function OverflowMenu({
  onImport,
  wallId,
  ready,
}: {
  readonly onImport: () => void;
  readonly wallId: string | null;
  readonly ready: boolean;
}) {
  const { t, locale } = useI18n();
  const theme = useStore(themeStore);
  return (
    <div className="md:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={t('action.more')} />}
        >
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem disabled={!ready} onClick={onImport}>
            <ImagePlus /> {t('photo.import')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!ready}
            onClick={() => wallId && globalThis.open(api.exportUrl(wallId), '_blank', 'noopener')}
          >
            <Download /> {t('wall.export')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => localeStore.set(locale === 'ru' ? 'en' : 'ru')}>
            <Languages /> {locale === 'ru' ? t('language.en') : t('language.ru')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={toggleTheme}>
            {theme === 'dark' ? <Sun /> : <Moon />}
            {theme === 'dark' ? t('theme.light') : t('theme.dark')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openPalette()}>
            <Command /> {t('palette.open')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
