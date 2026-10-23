import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { describeProblem, type ProblemParam } from './describeProblem.ts';

/** What the holder suggestions know about hanging the selected tool on one candidate (`usePhysicsRatings`). */
export interface HolderPhysicsRating {
  readonly stability: number;
  readonly convenience: number | null;
  readonly status: 'stable' | 'marginal' | 'unstable';
  readonly reasons: readonly {
    readonly code: string;
    readonly params: Readonly<Record<string, ProblemParam>>;
  }[];
}

/** Convenience below this reads as awkward to take off. */
export const AWKWARD_BELOW = 0.5;

const TONE: Readonly<Record<HolderPhysicsRating['status'], string>> = {
  stable: 'bg-ok/15 text-ok',
  marginal: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  unstable: 'bg-destructive/15 text-destructive',
};

/** Chips under a holder suggestion: stable / marginal / unstable, plus "awkward" when it is hard to take off. */
export function PhysicsBadge({ rating }: { readonly rating: HolderPhysicsRating | undefined }) {
  const { t } = useI18n();
  if (rating === undefined) return null;
  const awkward = rating.convenience !== null && rating.convenience < AWKWARD_BELOW;
  const reasons = rating.reasons.map((reason) => describeProblem(reason, t));
  const title = [
    t('physics.badge.titleHang', { status: t(`physics.badge.${rating.status}`) }),
    ...reasons,
  ].join('\n');
  return (
    <span className="flex flex-wrap gap-1" data-testid="physics-badge" title={title}>
      <span
        className={cn('rounded-full px-1.5 py-px text-[10px] font-medium', TONE[rating.status])}
      >
        {t(`physics.badge.${rating.status}`)}
      </span>
      {awkward ? (
        <span
          className="rounded-full bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-400"
          title={t('physics.badge.titleAwkward')}
        >
          {t('physics.badge.awkward')}
        </span>
      ) : null}
    </span>
  );
}
