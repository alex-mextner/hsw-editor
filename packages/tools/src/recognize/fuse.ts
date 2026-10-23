/**
 * Class suggestion for a cropped object: CLIP text prompts fused with retrieval against prototype images
 * rendered from the tool generators.
 *
 *   text   logit_c = 100 * <e, t_c>, minus the class bias (mean logit of class c over all prototype images),
 *   proto  s_c     = mean of the top-`k` cosine similarities among the prototype images of class c,
 *   fused  p_c     proportional to softmax(text/Tt)^(1-w) * softmax(100 s/Tp)^w * softmax(100 d/Td)^wd
 *
 * `d_c` is the same top-k retrieval with DINOv2 embeddings (image -> image, the strongest single signal on the carpet
 * crops); it only takes part when the index has DINOv2 prototypes and the caller passes the object's DINOv2 embedding.

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
  /** Optional DINOv2 side: P x dinoDim prototype embeddings (same row order as `protos`). */
  dinoDim?: number;
  dinoProtos?: Float32Array;
  /** Class index of every prototype row. */
  protoClass: Int32Array;
}

export interface Suggestion {
  classId: string;
  /** Fused probability. */
  score: number;
  text: number;
  proto: number;
  /** DINOv2 retrieval probability, when it took part. */
  dino?: number;
}

export interface FuseOptions {
  /** Weight of the prototype evidence (0 = text only, 1 = prototypes only). */
  w?: number;
  /** Prototype neighbours averaged per class. */
  k?: number;
  textTemp?: number;
  protoTemp?: number;
  /** Exponent of the DINOv2 retrieval term (0 = off). */
  wd?: number;
  dinoTemp?: number;
}

/** CLIP only: text + CLIP prototypes. */
export const DEFAULT_FUSE: Required<FuseOptions> = {
  w: 0.5,
  k: 3,
  textTemp: 2,
  protoTemp: 4,
  wd: 0,
  dinoTemp: 4,
};
/**
 * With DINOv2 retrieval. Chosen by leave-one-out over a (w, wd, dinoTemp) grid on the 33 labelled carpet crops (docs/tools.md):
 * (0.7, 0.3, 4) won in 31 of 33 folds.
 */
export const DEFAULT_FUSE_DINO: Required<FuseOptions> = { ...DEFAULT_FUSE, w: 0.7, wd: 0.3 };

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
  dinoDim?: number;
  dinoProtos?: Float32Array;
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
  return {
    dim,
    classIds,
    text,
    textBias,
    protos,
    protoClass,
    ...(input.dinoProtos && input.dinoDim
      ? { dinoDim: input.dinoDim, dinoProtos: input.dinoProtos }
      : {}),
  };
}

export function textLogits(index: PrototypeIndex, e: Float32Array): number[] {
  return index.classIds.map(
    (_, c) => 100 * dot(e, 0, index.text, c * index.dim, index.dim) - (index.textBias[c] as number),
  );
}

export function protoScores(
  index: PrototypeIndex,
  e: Float32Array,
  k: number,
  side: 'clip' | 'dino' = 'clip',
): number[] {
  const C = index.classIds.length;
  const sims: number[][] = Array.from({ length: C }, () => []);
  const protos = side === 'dino' ? index.dinoProtos : index.protos;
  const dim = side === 'dino' ? index.dinoDim : index.dim;
  if (!protos || !dim) throw new Error(`the prototype index has no ${side} prototypes`);
  const P = protos.length / dim;
  for (let p = 0; p < P; p++) {
    const c = index.protoClass[p] as number;
    if (c >= 0) sims[c]?.push(dot(e, 0, protos, p * dim, dim));
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
  dinoEmbedding?: Float32Array,
): Suggestion[] {
  const haveDino = dinoEmbedding !== undefined && index.dinoProtos !== undefined;
  // wd = 0 is "DINOv2 off": the CLIP-only defaults then apply (w = 0.5), not the DINOv2 ones
  const useDino = haveDino && (options.wd ?? DEFAULT_FUSE_DINO.wd) > 0;
  const o = { ...(useDino ? DEFAULT_FUSE_DINO : DEFAULT_FUSE), ...options };
  const text = softmax(textLogits(index, embedding).map((v) => v / o.textTemp));
  const proto = softmax(protoScores(index, embedding, o.k).map((v) => (100 * v) / o.protoTemp));
  const dino =
    useDino && o.wd > 0
      ? softmax(protoScores(index, dinoEmbedding, o.k, 'dino').map((v) => (100 * v) / o.dinoTemp))
      : null;
  const logs = text.map(
    (t, i) =>
      (1 - o.w) * Math.log(t + 1e-12) +
      o.w * Math.log((proto[i] as number) + 1e-12) +
      (dino ? o.wd * Math.log((dino[i] as number) + 1e-12) : 0),
  );
  const fused = softmax(logs);
  return index.classIds
    .map((classId, i) => ({
      classId,
      score: fused[i] as number,
      text: text[i] as number,
      proto: proto[i] as number,
      ...(dino ? { dino: dino[i] as number } : {}),
    }))
    .sort((a, b) => b.score - a.score);
}

export function readF32(bytes: ArrayBuffer, dim: number): Float32Array {
  const m = new Float32Array(bytes);
  if (m.length % dim !== 0) throw new Error('embedding file does not match its dimension');
  return m;
}
