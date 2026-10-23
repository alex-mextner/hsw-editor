/**
 * Class suggestion for a cropped object: CLIP text prompts fused with retrieval against prototype images
 * rendered from the tool generators.
 *
 *   text   logit_c = 100 * <e, t_c>, minus the class bias (mean logit of class c over all prototype images),
 *   proto  s_c     = mean of the top-`k` cosine similarities among the prototype images of class c,
 *   fused  p_c     proportional to softmax(text/Tt)^(1-w) * softmax(100 s/Tp)^w
 *
 * All embeddings are L2-normalised rows of the same CLIP image/text encoder (the sidecar's).
 */
export interface PrototypeIndex {
  dim: number;
  classIds: readonly string[];
  /** C x dim text embeddings (mean of the class prompts, normalised). */
  text: Float32Array;
  /** C biases of the text logits. */
  textBias: Float32Array;
  /** P x dim prototype image embeddings. */
  protos: Float32Array;
  /** Class index of every prototype row. */
  protoClass: Int32Array;
}

export interface Suggestion {
  classId: string;
  /** Fused probability. */
  score: number;
  text: number;
  proto: number;
}

export interface FuseOptions {
  /** Weight of the prototype evidence (0 = text only, 1 = prototypes only). */
  w?: number;
  /** Prototype neighbours averaged per class. */
  k?: number;
  textTemp?: number;
  protoTemp?: number;
}

export const DEFAULT_FUSE: Required<FuseOptions> = { w: 0.5, k: 3, textTemp: 2, protoTemp: 4 };

function dot(a: Float32Array, ao: number, b: Float32Array, bo: number, dim: number): number {
  let s = 0;
  for (let i = 0; i < dim; i++) s += (a[ao + i] as number) * (b[bo + i] as number);
  return s;
}

function softmax(v: readonly number[]): number[] {
  const m = Math.max(...v);
  const e = v.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

export function buildPrototypeIndex(input: {
  dim: number;
  classIds: readonly string[];
  text: Float32Array;
  protos: Float32Array;
  protoClassIds: readonly string[];
}): PrototypeIndex {
  const { dim, classIds, text, protos } = input;
  const C = classIds.length;
  const P = protos.length / dim;
  const protoClass = new Int32Array(P);
  const indexOf = new Map(classIds.map((c, i) => [c, i]));
  input.protoClassIds.forEach((c, i) => {
    protoClass[i] = indexOf.get(c) ?? -1;
  });
  const textBias = new Float32Array(C);
  for (let c = 0; c < C; c++) {
    let s = 0;
    for (let p = 0; p < P; p++) s += 100 * dot(protos, p * dim, text, c * dim, dim);
    textBias[c] = s / Math.max(P, 1);
  }
  return { dim, classIds, text, textBias, protos, protoClass };
}

export function textLogits(index: PrototypeIndex, e: Float32Array): number[] {
  return index.classIds.map(
    (_, c) => 100 * dot(e, 0, index.text, c * index.dim, index.dim) - (index.textBias[c] as number),
  );
}

export function protoScores(index: PrototypeIndex, e: Float32Array, k: number): number[] {
  const C = index.classIds.length;
  const sims: number[][] = Array.from({ length: C }, () => []);
  const P = index.protos.length / index.dim;
  for (let p = 0; p < P; p++) {
    const c = index.protoClass[p] as number;
    if (c >= 0) sims[c]?.push(dot(e, 0, index.protos, p * index.dim, index.dim));
  }
  return sims.map((s) => {
    if (s.length === 0) return -1;
    s.sort((a, b) => b - a);
    const top = s.slice(0, k);
    return top.reduce((a, b) => a + b, 0) / top.length;
  });
}

/** Ranked suggestions for one object embedding. */
export function suggestClasses(
  index: PrototypeIndex,
  embedding: Float32Array,
  options: FuseOptions = {},
): Suggestion[] {
  const o = { ...DEFAULT_FUSE, ...options };
  const text = softmax(textLogits(index, embedding).map((v) => v / o.textTemp));
  const proto = softmax(protoScores(index, embedding, o.k).map((v) => (100 * v) / o.protoTemp));
  const logs = text.map(
    (t, i) => (1 - o.w) * Math.log(t + 1e-12) + o.w * Math.log((proto[i] as number) + 1e-12),
  );
  const fused = softmax(logs);
  return index.classIds
    .map((classId, i) => ({
      classId,
      score: fused[i] as number,
      text: text[i] as number,
      proto: proto[i] as number,
    }))
    .sort((a, b) => b.score - a.score);
}

export function readF32(bytes: ArrayBuffer, dim: number): Float32Array {
  const m = new Float32Array(bytes);
  if (m.length % dim !== 0) throw new Error('embedding file does not match its dimension');
  return m;
}
