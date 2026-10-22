import { Bot, Terminal, User } from 'lucide-react';
import { useNow } from '@/hooks/useNow.ts';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';

const VISIBLE_MS = 12_000;

/** Shows who edited the wall last when it was not this tab: an agent, the CLI or another human session. */
export function PresenceBadge() {
  const { t } = useI18n();
  const remote = useStore(sessionStore)?.lastRemote ?? null;
  const now = useNow(remote !== null);

  if (!remote || now - remote.at > VISIBLE_MS) return null;
  const Icon = remote.actor.kind === 'agent' ? Bot : remote.actor.kind === 'cli' ? Terminal : User;
  const who = remote.actor.name ?? t(`actor.${remote.actor.kind}`);
  const seconds = Math.max(0, Math.round((now - remote.at) / 1000));
  return (
    <div
      data-slot="presence"
      className="flex items-center gap-1.5 rounded-full border border-primary/40 bg-accent px-2.5 py-1 text-xs text-accent-foreground"
      title={t('presence.edited', { who, seconds })}
    >
      <Icon className="size-3.5 text-primary" aria-hidden />
      <span className="max-w-32 truncate font-medium">{who}</span>
      <span className="text-muted-foreground max-sm:hidden">
        {t('presence.seconds', { seconds })}
      </span>
    </div>
  );
}
