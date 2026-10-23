import { PMREMGenerator, type Texture, type WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const environments = new WeakMap<WebGLRenderer, Texture>();

/**
 * Image-based light for tool materials: steel and chrome parts are metallic, and a metal under analytic lights only
 * reads as black. A generated studio-room environment (no file, nothing to download, so it works offline) gives them
 * something to reflect. One per renderer, prefiltered once.
 */
export function toolEnvironment(gl: WebGLRenderer): Texture {
  const known = environments.get(gl);
  if (known) return known;
  const generator = new PMREMGenerator(gl);
  const room = new RoomEnvironment();
  const texture = generator.fromScene(room, 0.04).texture;
  room.dispose();
  generator.dispose();
  environments.set(gl, texture);
  return texture;
}
