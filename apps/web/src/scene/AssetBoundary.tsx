import {
  Component,
  Suspense,
  useEffect,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { errorEntry, logClientError } from '@/api/clientErrors.ts';
import {
  assetHealthStore,
  forgetFailure,
  getFailure,
  markRecovered,
  markReloading,
  recordFailure,
  type AssetState,
} from '@/bank/assetHealth.ts';
import {
  cancelAutoRetry,
  goneReasonFor,
  hasPendingAutoRetry,
  hasPendingRetry,
  prepareRetry,
  registerRetryHandler,
  requestRetry,
  scheduleAutoRetry,
  type RecoveryDeps,
} from '@/bank/assetRecovery.ts';
import { failureReason } from '@/bank/failureView.ts';
import { classifyLoadError } from '@/bank/loadErrors.ts';
import { useI18n } from '@/i18n/index.ts';

/** What a placeholder needs to explain a failed asset; reflects the live asset-health record. */
export interface FailureView {
  readonly url: string;
  readonly bankId?: string;
  readonly name: string;
  readonly state: AssetState;
  /** Already translated: "file not found (404)", "removed from the bank", ... */
  readonly reason: string;
  /** The element is gone for good (removed / unavailable): retrying cannot help. */
  readonly gone: boolean;
  readonly attempts: number;
}

export interface AssetBoundaryProps {
  /** URL of the asset the children load; it is the key of the failure record and of its retry loop. */
  readonly url: string;
  /** Bank element the asset belongs to (enables re-resolving it against a fresh index on retry). */
  readonly bankId?: string;
  /** Already translated element / asset name for the toast and the placeholder. */
  readonly name: string;
  /** Drops the loader's cached (failed) result so the next render fetches again. */
  readonly clearCache: (url: string) => void;
  /** Drawn instead of the children while the asset is failing. */
  readonly placeholder: (view: FailureView) => ReactNode;
  /** Shown while the children suspend (loading). */
  readonly fallback?: ReactNode;
  /** Revalidates whatever index lists this asset before a retry (assets that are not bank elements: tool models). */
  readonly revalidate?: () => Promise<void>;
  /** Register the failure but raise no toast (hover previews, background work). */
  readonly quiet?: boolean;
  /** Test seam: how a retry revalidates the bank index. */
  readonly recovery?: RecoveryDeps;
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly error: Error | null;
  /** Bumped on every reset so the children remount and fetch again. */
  readonly generation: number;
}

/** Reports "everything under me finished loading" by mounting: Suspense only commits then. */
function LoadedProbe({ url }: { readonly url: string }) {
  useEffect(() => {
    markRecovered(url);
    cancelAutoRetry(url);
  }, [url]);
  return null;
}

function Placeholder({
  url,
  bankId,
  name,
  render,
}: {
  readonly url: string;
  readonly bankId: string | undefined;
  readonly name: string;
  readonly render: AssetBoundaryProps['placeholder'];
}) {
  const { t } = useI18n();
  // Only this URL's record: a failure elsewhere must not re-render every placeholder on the wall.
  const failure = useSyncExternalStore(assetHealthStore.subscribe, () => getFailure(url));
  const view: FailureView = {
    url,
    ...(bankId === undefined ? {} : { bankId }),
    name,
    state: failure?.state ?? 'failed',
    reason: failure ? failureReason(failure, t) : failureReason({ kind: 'unknown' }, t),
    gone: failure?.gone !== undefined,
    attempts: failure?.attempts ?? 1,
  };
  return render(view);
}

/**
 * Error boundary + Suspense for anything that loads a file: a failed load becomes a placeholder
 * instead of an unmounted page. It registers the failure (one record, one toast per URL), retries
 * with backoff and on demand, and tells the asset-health store when the asset finally loads.
 * It owns no three.js code, so it is testable in a plain DOM; the scene wraps it with its loader cache.
 */
export class AssetBoundary extends Component<AssetBoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, generation: 0 };

  private mounted = false;
  private unregister: (() => void) | null = null;

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidMount(): void {
    this.mounted = true;
    this.unregister = registerRetryHandler(this.props.url, this.retryNow);
  }

  override componentDidUpdate(previous: AssetBoundaryProps): void {
    if (previous.url === this.props.url) return;
    this.unregister?.();
    this.unregister = registerRetryHandler(this.props.url, this.retryNow);
    // The URL changed (the refreshed index points the element at another file, or the LOD switched).
    // Only a boundary that is showing the old URL's failure owns it: drop that record and load the new URL.
    if (!this.state.error) return;
    cancelAutoRetry(previous.url);
    forgetFailure(previous.url);
    this.reset();
  }

  override componentWillUnmount(): void {
    this.mounted = false;
    this.unregister?.();
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const { url, bankId, name, quiet } = this.props;
    const classified = classifyLoadError(error);
    // Judged against the index this tab holds right now: an element it no longer lists is not worth retrying.
    const gone = bankId === undefined ? null : goneReasonFor(bankId);
    const { record, isNew, advanced } = recordFailure({
      url,
      ...(bankId === undefined ? {} : { bankId }),
      elementName: name,
      ...(classified.status === undefined ? {} : { status: classified.status }),
      kind: classified.kind,
      message: error.message,
      ...(quiet === undefined ? {} : { quiet }),
      ...(gone === null ? {} : { gone }),
    });
    if (isNew) {
      const isLoadFailure = classified.url !== undefined || classified.status !== undefined;
      logClientError(
        errorEntry(isLoadFailure ? 'asset-load' : 'render', error, {
          url,
          ...(bankId === undefined ? {} : { bankId }),
          ...(classified.status === undefined ? {} : { status: classified.status }),
          detail: { loadErrorKind: classified.kind, component: firstFrame(info.componentStack) },
        }),
      );
    }
    // One timer per URL, however many boundaries show it. A duplicate failure re-arms the timer when
    // the record is waiting for its retry but no timer is pending (all boundaries unmounted and came back).
    if (advanced || (record.state === 'retrying' && record.nextRetryAt !== null)) {
      if (record.nextRetryAt === null) cancelAutoRetry(url);
      else if (advanced || !hasPendingAutoRetry(url)) {
        scheduleAutoRetry(url, record.nextRetryAt - Date.now());
      }
    } else if (
      record.state === 'retrying' &&
      record.nextRetryAt === null &&
      !hasPendingRetry(url)
    ) {
      // A retry was begun but its boundaries went away before the reload: start it again.
      requestRetry(url);
    }
  }

  private readonly retryNow = (): void => {
    if (this.state.error) void this.retry();
  };

  private async retry(): Promise<void> {
    const startedWith = this.props.url;
    const outcome = await prepareRetry(
      {
        url: startedWith,
        ...(this.props.bankId === undefined ? {} : { bankId: this.props.bankId }),
        ...(this.props.revalidate === undefined ? {} : { revalidate: this.props.revalidate }),
      },
      this.props.recovery,
    );
    if (outcome.kind === 'gone' || !this.mounted) return;
    this.props.clearCache(startedWith);
    // The refreshed index may have moved the element to another file while we waited.
    if (this.props.url !== startedWith) this.props.clearCache(this.props.url);
    // From here a failure is a real new attempt; before it, a stale cached rejection was not.
    markReloading(startedWith);
    this.reset();
  }

  private reset(): void {
    this.setState((state) => ({ error: null, generation: state.generation + 1 }));
  }

  override render(): ReactNode {
    const { url, bankId, name, placeholder, fallback } = this.props;
    if (this.state.error) {
      return <Placeholder url={url} bankId={bankId} name={name} render={placeholder} />;
    }
    return (
      <Suspense key={this.state.generation} fallback={fallback ?? null}>
        {this.props.children}
        <LoadedProbe url={url} />
      </Suspense>
    );
  }
}

function firstFrame(componentStack: string | null | undefined): string {
  return (componentStack ?? '').trim().split('\n')[0]?.trim() ?? '';
}
