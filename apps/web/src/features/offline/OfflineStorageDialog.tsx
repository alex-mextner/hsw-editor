import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createValueStore } from '#state-backend';
import { HardDriveDownload } from 'lucide-react';
import { bankStore } from '@/bank/client.ts';
import { refreshToolAssets, toolAssetsStore } from '@/toolmodels/assets.ts';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { useI18n } from '@/i18n/index.ts';
import { pageCacheDeps } from '@/pwa/pageDeps.ts';
import { pwa } from '@/pwa/instance.ts';
import type { AssetCategory } from '@/pwa/cachePolicy.ts';
import {
  bankAssetUrls,
  buildReport,
  clearCategories,
  downloadAssets,
  toolAssetUrls,
  type DownloadProgress,
  type DownloadResult,
  type StorageReport,
} from '@/pwa/storage.ts';
import { useStore } from '@/state/react.ts';

export const offlineStorageDialogStore = createValueStore<boolean>(false);

const MIB = 1024 * 1024;
const formatBytes = (bytes: number | undefined): string =>
  bytes === undefined
    ? '?'
    : bytes >= 1024 * MIB
      ? `${(bytes / (1024 * MIB)).toFixed(1)} GB`
      : `${(bytes / MIB).toFixed(1)} MB`;

const CATEGORY_LABEL = {
  'bank-model': 'offline.cat.models',
  'bank-thumbnail': 'offline.cat.thumbnails',
  'bank-index': 'offline.cat.index',
  'tool-model': 'offline.cat.toolModels',
  'tool-index': 'offline.cat.toolIndex',
  'wall-photo': 'offline.cat.photos',
  'wall-model': 'offline.cat.wallModels',
} as const satisfies Record<AssetCategory, string>;

const storageEnv = {
  estimate: () => navigator.storage.estimate(),
  persisted: () => navigator.storage.persisted(),
};

/**
 * "Offline storage": what this device keeps for offline use and how big it is, "make available offline" for the whole bank or one
 * top-level category (downloaded and pinned so the budgeted LRU never evicts it), clearing, and installing the app.
 */
export function OfflineStorageDialog() {
  const open = useStore(offlineStorageDialogStore);
  const { t, locale } = useI18n();
  const bank = useStore(bankStore);
  const [report, setReport] = useState<StorageReport | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [result, setResult] = useState<DownloadResult | null>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const install = useSyncExternalStore(pwa.install.subscribe, pwa.install.getSnapshot);

  const refresh = useCallback(async () => {
    setReport(await buildReport(await pageCacheDeps(), storageEnv));
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void pageCacheDeps()
      .then((deps) => buildReport(deps, storageEnv))
      .then(
        (next) => {
          if (live) setReport(next);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [open]);

  /** One storage operation at a time; a failure is shown instead of leaving the dialog stuck. */
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setFailure(null);
    try {
      await work();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setProgress(null);
    } finally {
      busy.current = false;
      abort.current = null;
    }
    await refresh().catch(() => undefined);
  };

  /** `what`: bank categories (empty = the whole bank, with the tool models), or only the generated tool models. */
  const download = (
    categories: readonly string[],
    what: 'bank' | 'tools' = 'bank',
  ): Promise<void> =>
    run(async () => {
      if (what === 'bank' && bank.status !== 'ready') return;
      const controller = new AbortController();
      abort.current = controller;
      setResult(null);
      const tools = what === 'tools' || categories.length === 0;
      if (tools) await refreshToolAssets();
      const toolIndex = toolAssetsStore.get();
      const toolUrls =
        tools && toolIndex.status === 'ready'
          ? toolAssetUrls(toolIndex.index, location.origin)
          : [];
      if (what === 'tools' && toolUrls.length === 0) throw new Error(t('offline.toolsUnavailable'));
      const bankUrls =
        what === 'bank' && bank.status === 'ready'
          ? bankAssetUrls(
              bank.index,
              { categories, thumbnails: true, models: true },
              location.origin,
            )
          : [];
      const urls = [...bankUrls, ...toolUrls];
      const outcome = await downloadAssets(await pageCacheDeps(), urls, {
        origin: location.origin,
        pin: true,
        signal: controller.signal,
        onProgress: setProgress,
        env: storageEnv,
      });
      setProgress(null);
      setResult(outcome);
    });

  const clear = (categories: readonly AssetCategory[]): Promise<void> =>
    run(async () => {
      await clearCategories(await pageCacheDeps(), categories);
    });

  const topCategories =
    bank.status === 'ready' ? bank.index.categories.filter((c) => c.parent === undefined) : [];

  return (
    <Dialog open={open} onOpenChange={(next) => offlineStorageDialogStore.set(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDriveDownload className="size-4 text-primary" aria-hidden />
            {t('offline.title')}
          </DialogTitle>
          <DialogDescription>{t('offline.description')}</DialogDescription>
        </DialogHeader>
        {report ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t('offline.usage', {
                used: formatBytes(report.usage),
                quota: formatBytes(report.quota),
              })}
              {' · '}
              {report.persisted ? t('offline.persisted') : t('offline.notPersisted')}
            </p>
            <ul className="grid gap-1 text-sm">
              {(Object.keys(CATEGORY_LABEL) as AssetCategory[]).map((category) => {
                const row = report.categories[category];
                return (
                  <li key={category} className="flex justify-between">
                    <span>{t(CATEGORY_LABEL[category])}</span>
                    <span className="text-muted-foreground">
                      {t('offline.row', {
                        count: row.count,
                        size: formatBytes(row.bytes),
                        pinned: row.pinnedCount,
                      })}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
        <div className="grid gap-2">
          <Button
            disabled={bank.status !== 'ready' || progress !== null}
            onClick={() => void download([])}
          >
            {t('offline.downloadAll')}
          </Button>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={progress !== null}
              onClick={() => void download([], 'tools')}
            >
              {t('offline.downloadTools')}
            </Button>
            {topCategories.map((category) => (
              <Button
                key={category.id}
                size="sm"
                variant="outline"
                disabled={progress !== null}
                onClick={() => void download([category.id])}
              >
                {category.name[locale]}
              </Button>
            ))}
          </div>
          {progress ? (
            <div className="flex items-center justify-between text-sm">
              <span>
                {t('offline.progress', {
                  done: progress.done + progress.failed,
                  total: progress.total,
                })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>
                {t('offline.cancel')}
              </Button>
            </div>
          ) : null}
          {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
          {result ? (
            <p className="text-sm text-muted-foreground">
              {t(`offline.result.${result.outcome}`, { done: result.done, failed: result.failed })}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void clear(['bank-model'])}>
            {t('offline.clearModels')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void clear(['tool-model'])}>
            {t('offline.clearToolModels')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void clear(['bank-thumbnail'])}>
            {t('offline.clearThumbnails')}
          </Button>
          {report && !report.persisted ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigator.storage.persist().then(refresh)}
            >
              {t('offline.persist')}
            </Button>
          ) : null}
        </div>
        {install.canPrompt ? (
          <Button variant="outline" onClick={() => void pwa.install.prompt()}>
            {t('offline.install')}
          </Button>
        ) : install.iosHint ? (
          <p className="text-sm text-muted-foreground">{t('offline.iosHint')}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
