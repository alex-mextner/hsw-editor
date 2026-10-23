import { useMemo } from 'react';
import { useTexture } from '@react-three/drei';
import { BufferAttribute, DoubleSide, PlaneGeometry } from 'three';
import type { Photo, Wall } from '@hsw-editor/core';
import { api } from '@/api/http.ts';
import { MM } from './units.ts';

const SEGMENTS = 24;

type Homography = readonly [number, number, number, number, number, number, number, number, number];

/** Pixel -> wall mm. Homography when the calibration has one, else uniform scale, else fit to the board width. */
export function pixelToWall(
  photo: Photo,
  boardWidthMm: number,
): (u: number, v: number) => [number, number] {
  const calibration = photo.calibration;
  const homography: Homography | undefined = calibration?.homography;
  if (homography) {
    const [a, b, c, d, e, f, g, h, i] = homography;
    return (u, v) => {
      const w = g * u + h * v + i;
      return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
    };
  }
  const scale = calibration?.mmPerPx ?? boardWidthMm / photo.width;
  // Image rows grow downwards, the wall's y grows upwards.
  return (u, v) => [u * scale, (photo.height - v) * scale];
}

/** The calibrated photo as a see-through quad lying on the board face (z = 0.3 mm), warped by the homography. */
export function PhotoOverlay({
  wall,
  photoId,
  opacity,
}: {
  readonly wall: Wall;
  readonly photoId: string;
  readonly opacity: number;
}) {
  const photo = wall.photos.find((candidate) => candidate.id === photoId);
  if (!photo) return null;
  return (
    <PhotoQuad
      wallId={wall.id}
      photo={photo}
      boardWidthMm={wall.board.cols * wall.board.colPitchMm}
      opacity={opacity}
    />
  );
}

function PhotoQuad({
  wallId,
  photo,
  boardWidthMm,
  opacity,
}: {
  readonly wallId: string;
  readonly photo: Photo;
  readonly boardWidthMm: number;
  readonly opacity: number;
}) {
  const texture = useTexture(api.photoUrl(wallId, photo.id));
  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(1, 1, SEGMENTS, SEGMENTS);
    const uv = plane.getAttribute('uv');
    const positions = new Float32Array(uv.count * 3);
    const map = pixelToWall(photo, boardWidthMm);
    for (let index = 0; index < uv.count; index += 1) {
      const u = uv.getX(index);
      const v = uv.getY(index); // 0 at the bottom of the image
      const [x, y] = map(u * photo.width, (1 - v) * photo.height);
      positions.set([x * MM, y * MM, 0.0003], index * 3);
    }
    plane.setAttribute('position', new BufferAttribute(positions, 3));
    return plane;
  }, [photo, boardWidthMm]);

  return (
    <mesh geometry={geometry} renderOrder={1} raycast={() => undefined}>
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={opacity}
        depthWrite={false}
        side={DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}
