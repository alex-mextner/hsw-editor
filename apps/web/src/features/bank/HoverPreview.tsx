import { useCallback, useState } from 'react';
import type { BankElement } from '@hsw-editor/bank';
import { cn } from '@/lib/cn.ts';
import { PreviewBoundary } from './PreviewBoundary.tsx';
import { PreviewCanvas } from './PreviewCanvas.tsx';

/**
 * Spinning 3D preview laid over a card's thumbnail. It stays transparent until the model has loaded, so
 * the thumbnail underneath doubles as the loading (and error) state. Pointer events pass through to
 * the card, which keeps hover, click and drag working. Purely decorative: the card is already named.
 */
export function HoverPreview({ element }: { readonly element: BankElement }) {
  const [ready, setReady] = useState(false);
  const markReady = useCallback(() => setReady(true), []);
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 block bg-card transition-opacity duration-150',
        ready ? 'opacity-100' : 'opacity-0',
      )}
    >
      <PreviewBoundary fallback={null}>
        <PreviewCanvas element={element} mode="hover" onLoaded={markReady} />
      </PreviewBoundary>
    </span>
  );
}
