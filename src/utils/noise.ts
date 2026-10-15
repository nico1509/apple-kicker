/**
 * Deterministic pseudo-random helpers. Everything in the world is derived from
 * a single integer seed so that a chunk can be regenerated identically at any time.
 */

/** Small fast PRNG (mulberry32). Returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

/** Uniform float in [lo, hi). */
export const rand = (rng: Rng, lo: number, hi: number): number => lo + (hi - lo) * rng();
/** Integer in [lo, hi]. */
export const randInt = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
/** Pick from a list. */
export const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];

/** Hash three integers to a float in [0, 1). */
export function hash3(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Combine a seed with a couple of integers into a new seed for a sub-generator. */
export function subSeed(seed: number, a: number, b = 0): number {
  return Math.floor(hash3(a, b, seed) * 4294967295) >>> 0;
}

const quintic = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** 2D value noise in [-1, 1]. */
export function valueNoise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = quintic(fx);
  const uy = quintic(fy);
  const a = hash3(ix, iy, seed);
  const b = hash3(ix + 1, iy, seed);
  const c = hash3(ix, iy + 1, seed);
  const d = hash3(ix + 1, iy + 1, seed);
  const top = a + (b - a) * ux;
  const bottom = c + (d - c) * ux;
  return (top + (bottom - top) * uy) * 2 - 1;
}

/** 1D value noise in [-1, 1]. */
export function noise1(x: number, seed: number): number {
  return valueNoise2(x, 0.37, seed);
}

/** Fractal Brownian motion, roughly in [-1, 1]. */
export function fbm2(x: number, y: number, seed: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  // Rotate a little each octave to hide the grid of value noise.
  let px = x;
  let py = y;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(px * freq, py * freq, seed + i * 101);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
    const nx = px * 0.8 - py * 0.6 + 13.7;
    const ny = px * 0.6 + py * 0.8 + 7.1;
    px = nx;
    py = ny;
  }
  return sum / norm;
}

export function fbm1(x: number, seed: number, octaves = 3): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise1(x * freq + i * 37.3, seed + i * 131);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
