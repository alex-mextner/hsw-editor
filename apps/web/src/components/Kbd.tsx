import type { ReactNode } from 'react';
import { cn } from '@/lib/cn.ts';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] leading-none text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
