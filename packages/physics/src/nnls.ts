/**
 * Non-negative least squares (Lawson-Hanson): min |A x - b| subject to x >= 0. A is small (6 rows: a wrench,
 * a few hundred columns: friction-cone generators of the contacts), so the dense normal-equation solve on the
 * passive set is cheap. Used as a feasibility test: a wrench is balanced by the contacts iff the residual is ~0.
 */

export interface NnlsResult {
  x: Float64Array;
  /** Euclidean norm of A x - b. */
  residual: number;
}

/** `columns[k]` is column k of A (length `rows`). */
export function nnls(
  columns: readonly (readonly number[])[],
  b: readonly number[],
  maxIterations = 200,
): NnlsResult {
  const rows = b.length;
  const n = columns.length;
  const x = new Float64Array(n);
  const passive = new Array<boolean>(n).fill(false);
  const residualVector = (): number[] => {
    const r = b.slice();
    for (let k = 0; k < n; k++) {
      const xk = x[k] ?? 0;
      if (xk === 0) continue;
      const col = columns[k] as readonly number[];
      for (let i = 0; i < rows; i++) r[i] = (r[i] ?? 0) - (col[i] ?? 0) * xk;
    }
    return r;
  };
  const norm = (v: readonly number[]): number => Math.sqrt(v.reduce((s, e) => s + e * e, 0));

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const r = residualVector();
    // Gradient w = A^T r on the active set.
    let best = -1;
    let bestW = 1e-10;
    for (let k = 0; k < n; k++) {
      if (passive[k]) continue;
      const col = columns[k] as readonly number[];
      let w = 0;
      for (let i = 0; i < rows; i++) w += (col[i] ?? 0) * (r[i] ?? 0);
      if (w > bestW) {
        bestW = w;
        best = k;
      }
    }
    if (best < 0) break;
    passive[best] = true;

    // Inner loop: solve on the passive set, back off if a coefficient goes negative.
    for (let inner = 0; inner < maxIterations; inner++) {
      const set: number[] = [];
      for (let k = 0; k < n; k++) if (passive[k]) set.push(k);
      const z = solvePassive(columns, b, set, rows);
      let minZ = Infinity;
      for (let s = 0; s < set.length; s++) minZ = Math.min(minZ, z[s] ?? 0);
      if (minZ > 0) {
        for (const [s, k] of set.entries()) x[k] = z[s] ?? 0;
        break;
      }
      let alpha = Infinity;
      for (const [s, k] of set.entries()) {
        const zs = z[s] ?? 0;
        if (zs <= 0) {
          const xk = x[k] ?? 0;
          alpha = Math.min(alpha, xk / (xk - zs));
        }
      }
      for (const [s, k] of set.entries()) x[k] = (x[k] ?? 0) + alpha * ((z[s] ?? 0) - (x[k] ?? 0));
      for (const k of set) {
        if ((x[k] ?? 0) < 1e-12) {
          x[k] = 0;
          passive[k] = false;
        }
      }
    }
  }
  return { x, residual: norm(residualVector()) };
}

/** Least squares on the chosen columns via ridge-regularised normal equations (Gaussian elimination). */
function solvePassive(
  columns: readonly (readonly number[])[],
  b: readonly number[],
  set: readonly number[],
  rows: number,
): number[] {
  const m = set.length;
  const g: number[][] = Array.from({ length: m }, () => new Array<number>(m + 1).fill(0));
  for (let p = 0; p < m; p++) {
    const cp = columns[set[p] as number] as readonly number[];
    for (let q = p; q < m; q++) {
      const cq = columns[set[q] as number] as readonly number[];
      let s = 0;
      for (let i = 0; i < rows; i++) s += (cp[i] ?? 0) * (cq[i] ?? 0);
      (g[p] as number[])[q] = s;
      (g[q] as number[])[p] = s;
    }
    let s = 0;
    for (let i = 0; i < rows; i++) s += (cp[i] ?? 0) * (b[i] ?? 0);
    (g[p] as number[])[m] = s;
    (g[p] as number[])[p] = ((g[p] as number[])[p] ?? 0) + 1e-9;
  }
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < m; r++) {
      if (Math.abs((g[r] as number[])[col] ?? 0) > Math.abs((g[pivot] as number[])[col] ?? 0))
        pivot = r;
    }
    const tmp = g[col] as number[];
    g[col] = g[pivot] as number[];
    g[pivot] = tmp;
    const d = (g[col] as number[])[col] ?? 0;
    if (Math.abs(d) < 1e-14) continue;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = ((g[r] as number[])[col] ?? 0) / d;
      if (f === 0) continue;
      for (let c = col; c <= m; c++) {
        (g[r] as number[])[c] = ((g[r] as number[])[c] ?? 0) - f * ((g[col] as number[])[c] ?? 0);
      }
    }
  }
  return g.map((row, i) => {
    const d = row[i] ?? 0;
    return Math.abs(d) < 1e-14 ? 0 : (row[m] ?? 0) / d;
  });
}
