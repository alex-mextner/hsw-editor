import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { Kbd } from '@/components/Kbd.tsx';
import { cn } from '@/lib/cn.ts';
import { useFirstUseHint } from './iconHints.ts';

interface IconButtonProps {
  readonly label: string;
  /** A sentence that says more than the label; shown under it in the tooltip and read as the description. */
  readonly description?: string;
  readonly shortcut?: string | undefined;
  /** Identity of the first-use hint when the label carries a name (so each name is not a hint of its own); the label otherwise. */
  readonly hintKey?: string;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly variant?: 'ghost' | 'outline';
  readonly size?: 'icon' | 'icon-sm' | 'icon-xs';
  readonly testId?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * Icon-only button; the label is both the accessible name and the tooltip. The first time a person presses it, the tooltip also stays
 * open for a moment (`iconHints.ts`), which is what explains the icon on a phone, where there is no hover.
 */
export function IconButton({
  label,
  description,
  shortcut,
  hintKey,
  onClick,
  disabled,
  pressed,
  variant = 'ghost',
  size = 'icon-sm',
  testId,
  className,
  children,
}: IconButtonProps) {
  const [hovered, setHovered] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  // Whether the tooltip was open when the press began: a press closes it before the click arrives.
  const openAtPress = useRef(false);
  const hint = useFirstUseHint(hintKey ?? label, anchor);
  return (
    <Tooltip
      open={hovered || hint.showing !== null}
      // The hint is held open under a finger: it must not catch the next tap meant for what is below it.
      disableHoverablePopup={hint.showing !== null}
      onOpenChange={(open, details) => {
        // Escape on a hint the person never hovered is meant for the editor (deselect, cancel a placement), not for this tooltip.
        if (!open && hint.showing !== null && details.reason === 'escape-key') {
          details.cancel();
          details.allowPropagation();
        }
        setHovered(open);
        if (!open) hint.dismiss();
      }}
    >
      <TooltipTrigger
        ref={anchor}
        render={
          <Button
            variant={variant}
            size={size}
            aria-label={label}
            aria-description={description}
            aria-pressed={pressed}
            data-testid={testId}
            disabled={disabled}
            onPointerDown={() => {
              openAtPress.current = hovered;
            }}
            onClick={() => {
              hint.press(label, openAtPress.current || hovered);
              openAtPress.current = false;
              onClick?.();
            }}
            className={cn(pressed && 'bg-accent text-accent-foreground', className)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        <span>{hint.showing ?? label}</span>
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        {description ? <span className="opacity-70">{description}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
