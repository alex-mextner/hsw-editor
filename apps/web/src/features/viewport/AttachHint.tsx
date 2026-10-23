import { useEffect } from 'react';
import { bankStore } from '@/bank/client.ts';
import { useI18n } from '@/i18n/index.ts';
import { editorStore } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';
import { reasonText, toolClassName as classNameIn } from '@/wall/attachReasons.ts';

/**
 * Tooltip next to the pointer while a tool is dragged: why the mount under it refuses the tool (every reason,
 * in the current language) or which mount the tool will hang on. The pointer shows the no-drop cursor on a refusal.
 */
export function AttachHint() {
  const { t, locale } = useI18n();
  const attach = useStore(editorStore).attach;
  const bank = useStore(bankStore);
  const wall = useStore(sessionStore)?.wall;
  const refused = attach?.refusal != null;

  useEffect(() => {
    if (!refused) return undefined;
    const previous = document.body.style.cursor;
    document.body.style.cursor = 'not-allowed';
    return () => {
      document.body.style.cursor = previous;
    };
  }, [refused]);

  if (!attach || bank.status !== 'ready' || !wall) return null;
  const toolClassName = (id: string): string => classNameIn(bank, locale, id);
  const holderName = (holderId: string): string => {
    const item = wall.items.find((candidate) => candidate.id === holderId);
    const element = item?.bankId === undefined ? undefined : bank.byId.get(item.bankId);
    return element?.name[locale] ?? item?.label ?? holderId;
  };
  // Open towards the side with room, so the tooltip never runs off a narrow screen.
  const { innerWidth, innerHeight } = window;
  const style = {
    ...(attach.cursor.x > innerWidth / 2
      ? { right: innerWidth - attach.cursor.x + 16 }
      : { left: attach.cursor.x + 16 }),
    ...(attach.cursor.y > innerHeight / 2
      ? { bottom: innerHeight - attach.cursor.y + 16 }
      : { top: attach.cursor.y + 16 }),
  };

  if (attach.refusal) {
    return (
      <output
        data-testid="attach-refusal"
        style={style}
        className="pointer-events-none fixed z-50 max-w-72 rounded-md border border-destructive/60 bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
      >
        <p className="font-medium text-destructive">
          {t('attach.hint.refused', {
            tool: toolClassName(attach.refusal.toolClass),
            holder: holderName(attach.refusal.holderId),
          })}
        </p>
        <ul className="mt-1 list-disc pl-4">
          {attach.refusal.reasons.map((reason, index) => (
            <li key={`${reason.code}:${index}`}>{reasonText(t, reason, toolClassName)}</li>
          ))}
        </ul>
      </output>
    );
  }
  if (attach.target) {
    return (
      <output
        data-testid="attach-target"
        style={style}
        className="pointer-events-none fixed z-50 rounded-md border border-primary/50 bg-popover px-2.5 py-1 text-xs text-popover-foreground shadow-md"
      >
        {t('attach.hint.hang', { holder: holderName(attach.target.holderId) })}
      </output>
    );
  }
  return null;
}
