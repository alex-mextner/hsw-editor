/**
 * Structural equality for JSON-like values, independent of object key order. Walls reach the client from two
 * serializers (the daemon's JSON and the reducer's object spreads in the browser) that do not agree on key order, so
 * comparing `JSON.stringify` output would report differences that are not there.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => deepEqual(value, b[index]))
    );
  }
  const left = Object.entries(a);
  const right = new Map(Object.entries(b));
  return (
    left.length === right.size &&
    left.every(([key, value]) => right.has(key) && deepEqual(value, right.get(key)))
  );
}
