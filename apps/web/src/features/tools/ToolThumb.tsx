import { useState } from 'react';
import { WrenchIcon } from 'lucide-react';
import { useT } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';

/** Stable hue 0-359 from an id, so the same tool always gets the same fallback colour. */
function hueOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

interface ToolThumbProps {
  readonly id: string;
  readonly url: string;
  readonly className?: string;
}

/**
 * Lazy generated thumbnail with a skeleton while loading. A tool whose image cannot be rendered or fetched
 * shows a tinted wrench instead of a broken image. The name is announced by the surrounding control.
 * Callers key it by entry, so the load state never has to be reset for another tool.
 */
export function ToolThumb({ id, url, className }: ToolThumbProps) {
  const t = useT();
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');
  return (
    <span className={cn('relative block size-full overflow-hidden bg-stone-200', className)}>
      {state === 'loading' ? (
        <span className="absolute inset-0 animate-pulse bg-muted-foreground/10" aria-hidden />
      ) : null}
      {state === 'error' ? (
        <span
          className="absolute inset-0 flex items-center justify-center"
          style={{ color: `hsl(${hueOf(id)} 55% 50%)` }}
          title={t('toolLib.card.thumbFallback')}
          data-testid="tool-thumb-fallback"
        >
          <WrenchIcon className="size-1/3" aria-hidden />
        </span>
      ) : (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setState('loaded')}
          onError={() => setState('error')}
          className={cn(
            'size-full object-contain p-1 transition-opacity duration-150',
            state === 'loaded' ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
    </span>
  );
}
