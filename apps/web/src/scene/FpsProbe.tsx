import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

/**
 * Benchmark probe (`?bench`): the canvas renders continuously and this publishes the frame rate,
 * the slowest frame and draw-call counts on `document.documentElement.dataset` once per second.
 */
export function FpsProbe() {
  const gl = useThree((state) => state.gl);
  const window = useRef({ start: 0, frames: 0, worst: 0, last: 0 });
  useFrame(({ clock }) => {
    const stats = window.current;
    const now = clock.elapsedTime;
    if (stats.last > 0) stats.worst = Math.max(stats.worst, now - stats.last);
    stats.last = now;
    stats.frames += 1;
    if (now - stats.start >= 1) {
      const root = globalThis.document.documentElement.dataset;
      root['fps'] = (stats.frames / (now - stats.start)).toFixed(1);
      root['worstFrameMs'] = (stats.worst * 1000).toFixed(1);
      root['drawCalls'] = String(gl.info.render.calls);
      root['triangles'] = String(gl.info.render.triangles);
      stats.start = now;
      stats.frames = 0;
      stats.worst = 0;
    }
  });
  return null;
}
