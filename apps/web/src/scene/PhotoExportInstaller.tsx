import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { setOverlayRenderer } from '@/features/photo/photoExport.ts';

/** Lets the PNG export read the live 3D frame: renders once and copies it before the browser can clear it. */
export function PhotoExportInstaller() {
  const gl = useThree((state) => state.gl);
  const get = useThree((state) => state.get);
  useEffect(() => {
    setOverlayRenderer(() => {
      const { scene, camera } = get();
      gl.render(scene, camera);
      const copy = document.createElement('canvas');
      copy.width = gl.domElement.width;
      copy.height = gl.domElement.height;
      copy.getContext('2d')?.drawImage(gl.domElement, 0, 0);
      return copy;
    });
    return () => setOverlayRenderer(null);
  }, [gl, get]);
  return null;
}
