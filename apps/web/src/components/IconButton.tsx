import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { Kbd } from '@/components/Kbd.tsx';
import { cn } from '@/lib/cn.ts';

interface IconButtonProps {
  readonly label: string;
  readonly shortcut?: string | undefined;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly size?: 'icon' | 'icon-sm' | 'icon-xs';
  readonly className?: string;
  readonly children: ReactNode;
}

/** Icon-only button; the label is both the accessible name and the tooltip. */
export function IconButton({
  label,
  shortcut,
  onClick,
  disabled,
  pressed,
  size = 'icon-sm',
  className,
  children,
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={cn(pressed && 'bg-accent text-accent-foreground', className)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        <span>{label}</span>
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}
