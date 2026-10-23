import type { ReactNode, SyntheticEvent } from 'react';

/** The R3F canvas listens for pointer/wheel/click/contextmenu on its container; none of that may reach it from here. */
function keepInside(event: SyntheticEvent): void {
  event.stopPropagation();
}

interface EventFenceProps {
  readonly children: ReactNode;
  /** Escape pressed inside the fence. */
  readonly onEscape: () => void;
}

/**
 * Presentation wrapper for HTML floating over the canvas: fences the events the canvas (and the editor's
 * shortcuts) react to, so typing or right-clicking in the widget never acts on the wall behind it.
 */
export function EventFence({ children, onEscape }: EventFenceProps) {
  return (
    <div
      role="presentation"
      onPointerDown={keepInside}
      onPointerUp={keepInside}
      onClick={keepInside}
      onDoubleClick={keepInside}
      onContextMenu={keepInside}
      onWheel={keepInside}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onEscape();
        // Delete, arrows and the other editor shortcuts must not act on the wall while typing here.
        keepInside(event);
      }}
    >
      {children}
    </div>
  );
}
