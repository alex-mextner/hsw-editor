import { useEffect, useState } from 'react';

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** Natural pixel size of the image at `url`; null while loading and when it cannot be decoded. */
export function useImageSize(url: string | null): ImageSize | null {
  const [loaded, setLoaded] = useState<{ readonly url: string; readonly size: ImageSize } | null>(null);
  useEffect(() => {
    if (url === null) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled) setLoaded({ url, size: { width: image.naturalWidth, height: image.naturalHeight } });
    };
    image.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);
  return loaded !== null && loaded.url === url ? loaded.size : null;
}
