import { Fragment, useState, type ComponentProps } from 'react';
import { Check } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu.tsx';
import { useI18n } from '@/i18n/index.ts';
import { editorStore } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { clipboardStore } from '@/wall/clipboard.ts';
import { sessionStore } from '@/wall/session.ts';
import { openMenuTarget, runMenuAction } from './contextMenuActions.ts';
import { buildMenu, type MenuTarget } from './contextMenuModel.ts';

/**
 * Wraps the viewport: right click (or long press on touch) opens the item or board menu at the
 * pointer. The canvas stays a single element, so what is under the pointer is decided by the scene
 * (`openMenuTarget`) at the moment the menu opens.
 */
export function ViewportContextMenu({
  children,
  ...triggerProps
}: ComponentProps<typeof ContextMenuTrigger>) {
  const [target, setTarget] = useState<MenuTarget>({ kind: 'board', point: null });
  return (
    <ContextMenu
      onOpenChange={(open, details) => {
        if (open) setTarget(openMenuTarget(details.event));
      }}
    >
      <ContextMenuTrigger {...triggerProps}>{children}</ContextMenuTrigger>
      <ViewportMenuContent target={target} />
    </ContextMenu>
  );
}

function ViewportMenuContent({ target }: { readonly target: MenuTarget }) {
  const { t } = useI18n();
  const editor = useStore(editorStore);
  const wall = useStore(sessionStore)?.wall;
  const clipboard = useStore(clipboardStore);
  const selected = wall?.items.filter((item) => editor.selection.includes(item.id)) ?? [];
  const groups = buildMenu({
    target,
    selected,
    clipboardCount: clipboard.length,
    view: editor.view,
  });
  return (
    <ContextMenuContent aria-label={t('context.menu')}>
      {groups.map((group, index) => (
        <Fragment key={group[0]?.action ?? index}>
          {index > 0 ? <ContextMenuSeparator /> : null}
          {group.map((entry) => (
            <ContextMenuItem
              key={entry.action}
              disabled={entry.disabled}
              variant={entry.destructive ? 'destructive' : 'default'}
              onClick={() => runMenuAction(entry.action, target)}
            >
              {t(entry.label)}
              {entry.checked ? <Check className="ml-auto" aria-hidden /> : null}
              {entry.shortcut ? <ContextMenuShortcut>{entry.shortcut}</ContextMenuShortcut> : null}
            </ContextMenuItem>
          ))}
        </Fragment>
      ))}
    </ContextMenuContent>
  );
}
