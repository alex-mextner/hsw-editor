import { useT } from '@/i18n/index.ts';

/**
 * Match quality in [0, 1] as a thin bar. A native `<meter>` carries the semantics (visually hidden,
 * since browsers style it inconsistently); the bar itself is decoration.
 */
export function ScoreBar({ score }: { readonly score: number }) {
  const t = useT();
  const percent = Math.round(score * 100);
  return (
    <>
      <meter className="sr-only" min={0} max={100} value={percent} aria-label={t('compare.score')}>
        {percent}%
      </meter>
      <span
        aria-hidden
        className="block h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <span className="block h-full bg-primary" style={{ width: `${percent}%` }} />
      </span>
    </>
  );
}
