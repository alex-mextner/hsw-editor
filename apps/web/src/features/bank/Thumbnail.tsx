import { useState } from 'react';
import { ImageOffIcon } from 'lucide-react';
import { useT } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';

interface ThumbnailProps {
  readonly src: string;
  readonly className?: string;
}

/**
 * Lazy thumbnail with a skeleton while loading and a placeholder when it fails. Callers key it by
 * element, so the load state never has to be reset for a different `src`. The name is announced by
 * the surrounding control, hence the empty alt. Built from phrasing elements so it can sit inside a
 * `<button>`.
 */
export function Thumbnail({ src, className }: ThumbnailProps) {
  const t = useT();
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');
  return (
    <span className={cn('relative block size-full overflow-hidden bg-muted/60', className)}>
      {state === 'loading' ? (
        <span className="absolute inset-0 animate-pulse bg-muted-foreground/10" aria-hidden />
      ) : null}
      {state === 'error' ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground">
          <ImageOffIcon className="size-5" aria-hidden />
          <span className="text-[10px]">{t('bank.image.broken')}</span>
        </span>
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setState('loaded')}
          onError={() => setState('error')}
          className={cn(
            'size-full object-contain transition-opacity duration-150',
            state === 'loaded' ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
    </span>
  );
}
