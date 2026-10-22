import { useGLTF, useTexture } from '@react-three/drei';
import { AssetBoundary, type AssetBoundaryProps } from './AssetBoundary.tsx';

/** Forgets the (failed) cached load of `url` in whichever drei loader cache holds it. */
export function clearLoadedAsset(url: string): void {
  useGLTF.clear(url);
  useTexture.clear(url);
}

/**
 * The boundary every model/texture load in the scene goes through: Suspense for loading, a
 * placeholder for failure, retry against the drei loader caches. See `AssetBoundary`.
 */
export function ModelBoundary(props: Omit<AssetBoundaryProps, 'clearCache'>) {
  return <AssetBoundary clearCache={clearLoadedAsset} {...props} />;
}
