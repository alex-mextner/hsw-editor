import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';

interface WallCanvasProps {
  readonly widthMm: number;
  readonly heightMm: number;
}

/** Scene units are metres; the wall plane is vertical (XY in three.js, XZ in the wall schema). */
export function WallCanvas({ widthMm, heightMm }: WallCanvasProps) {
  const width = widthMm / 1000;
  const height = heightMm / 1000;
  return (
    <Canvas frameloop="demand" camera={{ position: [0, height / 2, 2.2], fov: 45 }}>
      <ambientLight intensity={0.8} />
      <directionalLight position={[2, 3, 4]} intensity={1.2} />
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[width, height, 0.02]} />
        <meshStandardMaterial color="#27272a" />
      </mesh>
      <Grid args={[4, 4]} position={[0, 0, 0]} cellColor="#3f3f46" sectionColor="#52525b" />
      <OrbitControls target={[0, height / 2, 0]} makeDefault />
    </Canvas>
  );
}
