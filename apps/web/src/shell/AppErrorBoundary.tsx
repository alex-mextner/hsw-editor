import { Component, Fragment, useState, type ErrorInfo, type ReactNode } from 'react';
import { errorEntry, logClientError } from '@/api/clientErrors.ts';
import { useT } from '@/i18n/index.ts';

interface AppErrorBoundaryProps {
  readonly children: ReactNode;
}

interface AppErrorState {
  readonly error: Error | null;
  readonly componentStack: string;
  /** Bumped by Recover so the whole tree under the boundary remounts from scratch. */
  readonly generation: number;
}

/** Plain-text report of a crash, as shown by "Copy details". */
export function crashDetails(
  error: Error,
  componentStack: string,
  page: string | undefined,
): string {
  return [
    `${error.name}: ${error.message}`,
    page === undefined ? '' : `page: ${page}`,
    error.stack ?? '',
    componentStack === '' ? '' : `component stack:${componentStack}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CrashPanel({
  error,
  componentStack,
  onRecover,
}: {
  readonly error: Error;
  readonly componentStack: string;
  readonly onRecover: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const details = crashDetails(error, componentStack, globalThis.location?.href);
  return (
    <div
      role="alert"
      className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground"
    >
      <div className="flex w-full max-w-xl flex-col gap-3 rounded-xl border border-destructive/50 bg-card p-5 shadow-lg">
        <h1 className="text-base font-semibold">{t('app.error.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('app.error.body')}</p>
        <pre
          aria-label={t('app.error.details')}
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs"
        >
          {`${error.name}: ${error.message}`}
        </pre>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
            onClick={onRecover}
          >
            {t('app.error.recover')}
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium"
            onClick={() => globalThis.location.reload()}
          >
            {t('app.error.reload')}
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium"
            onClick={() => {
              void copyText(details).then(setCopied);
            }}
          >
            {copied ? t('app.error.copied') : t('app.error.copy')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Last line of defence: an error that escapes every other boundary shows this panel instead of a
 * blank page. Recover re-mounts the app in place (stores keep their state, the page is not reloaded).
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorState> {
  override state: AppErrorState = { error: null, componentStack: '', generation: 0 };

  static getDerivedStateFromError(error: unknown): Partial<AppErrorState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? '';
    this.setState({ componentStack });
    logClientError(
      errorEntry('render', error, {
        detail: { componentStack: componentStack.trim().slice(0, 1500) },
      }),
    );
  }

  private readonly recover = (): void => {
    this.setState((state) => ({
      error: null,
      componentStack: '',
      generation: state.generation + 1,
    }));
  };

  override render(): ReactNode {
    const { error, componentStack, generation } = this.state;
    if (error) {
      return <CrashPanel error={error} componentStack={componentStack} onRecover={this.recover} />;
    }
    // The key makes Recover remount the whole app, not just re-render it with the state that broke it.
    return <Fragment key={generation}>{this.props.children}</Fragment>;
  }
}
