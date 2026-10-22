import { TriangleAlert } from 'lucide-react';
import type { WallItem } from '@hsw-editor/core';
import { assetHealthStore } from '@/bank/assetHealth.ts';
import { requestRetry } from '@/bank/assetRecovery.ts';
import { reportAsset, reportMissingElement, reportOutcomeText } from '@/bank/assetReport.ts';
import { bankCheckStore, bankStore, refreshBank } from '@/bank/client.ts';
import { failureReason } from '@/bank/failureView.ts';
import { itemModelIssue, type ItemModelIssue } from '@/bank/itemHealth.ts';
import { Button } from '@/components/ui/button.tsx';
import { notify } from '@/features/notices/notices.ts';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';

interface ModelIssueNoticeProps {
  readonly issue: ItemModelIssue;
  readonly checking: boolean;
  readonly onRetry: () => void;
  readonly onReport: () => void;
}

/** Warning block for a wall item whose 3D model is missing from the bank or failed to load. */
export function ModelIssueNotice({ issue, checking, onRetry, onReport }: ModelIssueNoticeProps) {
  const { t } = useI18n();
  const failureText =
    issue.kind === 'failed'
      ? t('asset.failed.body', { reason: failureReason(issue.failure, t) })
      : null;
  return (
    <section
      role="alert"
      className="grid gap-2 rounded-lg border border-orange-500/60 bg-orange-500/10 p-3 text-xs"
    >
      <h3 className="flex items-start gap-1.5 text-sm font-semibold">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-orange-500" aria-hidden />
        <span className="min-w-0 break-words">
          {issue.kind === 'missing'
            ? t('asset.missing.title', { bankId: issue.bankId })
            : t('asset.failed.title')}
        </span>
      </h3>
      <p className="text-muted-foreground">
        {issue.kind === 'missing' ? t('asset.missing.body') : failureText}
      </p>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" disabled={checking} onClick={onRetry}>
          {t('action.retry')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onReport}>
          {t('asset.action.report')}
        </Button>
      </div>
    </section>
  );
}

/** Shows the warning for the selected item when it has a model problem; nothing otherwise. */
export function ItemModelNotice({ item }: { readonly item: WallItem }) {
  const { t } = useI18n();
  const bank = useStore(bankStore);
  const failures = useStore(assetHealthStore);
  const { checking } = useStore(bankCheckStore);
  const issue = itemModelIssue(item, bank, failures);
  if (!issue) return null;
  const retry = (): void => {
    if (issue.kind === 'failed') requestRetry(issue.failure.url);
    else void refreshBank({ force: true });
  };
  const report = (): void => {
    const outcome =
      issue.kind === 'failed' ? reportAsset(issue.failure.url) : reportMissingElement(issue.bankId);
    void outcome.then((result) => {
      if (result !== null) notify('info', reportOutcomeText(result, t));
    });
  };
  return <ModelIssueNotice issue={issue} checking={checking} onRetry={retry} onReport={report} />;
}
