import { useState } from 'react';
import type { Wall, WallItem } from '@hsw-editor/core';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { toolAssetsStore } from '@/toolmodels/assets.ts';
import { toolModelVersion } from '@/toolmodels/regen.ts';
import { resolveToolModel } from '@/toolmodels/resolve.ts';
import { toolRoutes } from '@/features/tools/api.ts';
import { libraryStore } from '@/features/tools/store.ts';

/**
 * Thumbnail the daemon renders for the generator behind a model entry id (`class:<id>` / `tool:<id>`). A library tool's is keyed by
 * its version (`updatedAt`), the URL the service worker keeps for offline use; until the library has loaded it is asked for without.
 */
export function toolThumbUrl(
  entryId: string,
  tools: readonly { readonly id: string; readonly updatedAt: string }[],
): string {
  const [kind, ...rest] = entryId.split(':');
  const id = rest.join(':');
  if (kind !== 'tool') return toolRoutes.classThumb(id);
  const version = tools.find((tool) => tool.id === id)?.updatedAt;
  return version === undefined
    ? `/api/tools/${encodeURIComponent(id)}/thumb.webp`
    : toolRoutes.toolThumb(id, version);
}

/**
 * What draws a tool on the wall: its thumbnail, the generator or library tool behind it, the size of the model and, when the
 * generator cannot be exactly the size typed for the tool, that the closest buildable one is shown.
 */
export function ToolModelCard({ item, wall }: { readonly item: WallItem; readonly wall: Wall }) {
  const { t } = useI18n();
  useStore(toolAssetsStore);
  useStore(toolModelVersion);
  const library = useStore(libraryStore);
  const [thumbFailed, setThumbFailed] = useState(false);
  const model = resolveToolModel(item, wall);
  if (!model) return null;
  const { dimsMm } = model;
  return (
    <section className="flex items-center gap-3 rounded-lg border p-2" data-slot="tool-model">
      {thumbFailed ? null : (
        <img
          src={toolThumbUrl(model.entryId, library.status === 'ready' ? library.tools : [])}
          alt=""
          width={56}
          height={56}
          className="size-14 shrink-0 rounded-md bg-muted/40 object-contain"
          onError={() => setThumbFailed(true)}
        />
      )}
      <div className="grid min-w-0 gap-0.5 text-xs">
        <span className="truncate font-medium">
          {t(model.entryId.startsWith('tool:') ? 'toolmodel.library' : 'toolmodel.generated')}
        </span>
        <span className="font-mono text-muted-foreground">
          {Math.round(dimsMm.x)} × {Math.round(dimsMm.y)} × {Math.round(dimsMm.z)} mm
        </span>
        {model.pending ? (
          <span className="text-muted-foreground">{t('toolmodel.rebuilding')}</span>
        ) : model.failed ? (
          <span className="text-orange-500">{t('toolmodel.failed')}</span>
        ) : model.exact ? null : (
          <span className="text-orange-500">{t('toolmodel.closest')}</span>
        )}
      </div>
    </section>
  );
}
