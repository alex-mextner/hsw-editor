import { Gauge } from 'lucide-react';
import type { Wall } from '@hsw-editor/core';
import type { HangReport, ToolPhysics } from '@hsw-editor/physics';
import { bankStore } from '@/bank/client.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { itemNamer } from '@/features/invalid-zones/itemNames.ts';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { physicsStore, toolPhysics } from '@/physics/store.ts';
import { useStore } from '@/state/react.ts';
import { describeProblem, describeRemovalPath } from './describeProblem.ts';

const STATUS_TONE: Readonly<Record<HangReport['status'], string>> = {
  stable: 'bg-ok/15 text-ok',
  marginal: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  unstable: 'bg-destructive/15 text-destructive',
};

/** Inspector section of one selected tool: hang verdict, every problem sentence, how it comes off, its mass. */
export function ToolPhysicsSection({
  wall,
  itemId,
}: {
  readonly wall: Wall;
  readonly itemId: string;
}) {
  const { t, locale } = useI18n();
  const view = useStore(physicsStore);
  const bank = useStore(bankStore);
  const physics = toolPhysics(view, itemId);
  // Nothing to say before the first check ran; after it, an unanalysed tool says why.
  if (physics === undefined) {
    return view.status === 'ready' ? (
      <section className="grid gap-1.5" data-testid="tool-physics">
        <SectionTitle />
        <p className="text-xs text-muted-foreground">{t('physics.inspector.none')}</p>
      </section>
    ) : null;
  }
  const nameOf = itemNamer(wall, bank.status === 'ready' ? bank.byId : new Map(), locale);
  return <Body physics={physics} nameOf={nameOf} />;
}

function SectionTitle() {
  const { t } = useI18n();
  return (
    <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      <Gauge className="size-3.5" aria-hidden />
      {t('physics.inspector.title')}
    </h3>
  );
}

function Body({
  physics,
  nameOf,
}: {
  readonly physics: ToolPhysics;
  readonly nameOf: (id: string) => string;
}) {
  const { t } = useI18n();
  const { hang, removal, problems } = physics;
  const path = removal === null ? null : describeRemovalPath(removal, t);
  return (
    <section
      className={cn(
        'grid gap-1.5 rounded-lg border p-2',
        problems.length > 0 ? 'border-amber-500/50 bg-amber-500/10' : 'border-border',
      )}
      data-testid="tool-physics"
    >
      <SectionTitle />
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">{t('physics.inspector.hang')}</span>
        <Badge className={STATUS_TONE[hang.status]} data-testid="hang-chip">
          {t('physics.hang.chip', {
            status: t(`physics.hang.${hang.status}`),
            percent: Math.round(hang.score * 100),
          })}
        </Badge>
        <span className="ml-auto font-mono text-muted-foreground">
          {t('physics.inspector.mass')}{' '}
          {t('physics.inspector.massValue', { massG: Math.round(hang.massG) })}
        </span>
      </div>
      {problems.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('physics.inspector.ok')}</p>
      ) : (
        <ul
          className="grid gap-1 text-xs text-amber-700 dark:text-amber-400"
          data-testid="physics-problems"
        >
          {problems.map((problem, index) => (
            <li key={`${problem.code}:${index}`}>{describeProblem(problem, t, nameOf)}</li>
          ))}
        </ul>
      )}
      {hang.rest ? (
        <p className="text-xs text-muted-foreground">
          {t('physics.inspector.rest', { tiltDeg: Math.round(hang.rest.tiltDeg) })}
        </p>
      ) : null}
      {removal ? (
        <div className="grid gap-0.5 text-xs" data-testid="physics-removal">
          <span className="font-medium">
            {t('physics.inspector.removal')}: {t(`physics.removal.${removal.verdict}`)}
          </span>
          {path ? (
            <span className="text-muted-foreground">{t('physics.inspector.path', { path })}</span>
          ) : null}
          <span className="text-muted-foreground">
            {t('physics.inspector.convenience', { percent: Math.round(removal.convenience * 100) })}
          </span>
        </div>
      ) : null}
    </section>
  );
}
