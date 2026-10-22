import { Canvas } from '@react-three/fiber';
import { View } from '@react-three/drei';

/**
 * The one WebGL canvas behind every compare tile. It covers the compare container, lets pointer
 * events through to the DOM and draws each `View` into its tile's rectangle.
 */
export function CompareCanvas({ eventSource }: { readonly eventSource: HTMLElement }) {
  return (
    <Canvas
      className="pointer-events-none absolute! inset-0"
      eventSource={eventSource}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
    >
      <View.Port />
    </Canvas>
  );
}
