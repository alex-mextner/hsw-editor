import { boardSizeMm, createEmptyWall } from '@hsw-editor/core';
import { useStore } from '@/state/react.ts';
import { currentWallId } from '@/state/current-wall.ts';
import { Button } from '@/components/ui/button.tsx';
import { WallCanvas } from '@/scene/WallCanvas.tsx';

const wall = createEmptyWall('draft', 'Draft wall');
const size = boardSizeMm(wall.board);

export function App() {
  const wallId = useStore(currentWallId);
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-sm">
        <strong>HSW Editor</strong>
        <span className="text-neutral-400">wall: {wallId ?? 'none'}</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => currentWallId.set(wall.id)}
        >
          Open draft wall
        </Button>
      </header>
      <main className="min-h-0 flex-1">
        <WallCanvas widthMm={size.width} heightMm={size.height} />
      </main>
    </div>
  );
}
