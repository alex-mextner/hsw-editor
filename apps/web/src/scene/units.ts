/** Wall documents are in millimetres, the three.js scene in metres (x right, y up, z out of the wall). */
export const MM = 0.001;

export function mm(value: number): number {
  return value * MM;
}
