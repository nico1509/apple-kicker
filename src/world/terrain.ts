import * as THREE from 'three';
import { CFG } from '../config';
import { clamp, lerp, smoothstep } from '../utils/math';
import { fbm1, fbm2, hash3, mulberry32, noise1, subSeed, valueNoise2 } from '../utils/noise';
import { LANDSCAPE_LENGTH, landscapeOfIndex, landscapeWeight, type Landscape } from './landscape';

/**
 * Coordinate conventions
 * ----------------------
 * Y is up. The path runs towards negative Z. "Progress" p = -z is the distance
 * travelled along the path. The lateral offset d = x - pathCenterX(p) is
 * positive on the right-hand side when facing down the path.
 */

/** Biomes of the autumn forest landscape and of the Greek late-summer landscape. */
export type BiomeType =
  | 'forest' | 'meadow' | 'field' | 'vineyard' | 'hedge'
  | 'phrygana' | 'olive' | 'stubble' | 'farmstead'
  | 'dunes' | 'oasis' | 'ruins' | 'blackdesert';
export type Side = -1 | 1;

export interface BiomeMix {
  a: BiomeType;
  b: BiomeType;
  t: number; // 0 → a, 1 → b
}

interface Hill {
  start: number;
  length: number;
  height: number;
  kind: 'bump' | 'up' | 'down';
}

const BIOME_SEGMENT = 100;
const HILL_SEGMENT = 50;
/** Extra cross slope (m per m) that a biome adds beside the lane. */
const SLOPE_BIAS: Record<BiomeType, number> = {
  vineyard: 0.17, hedge: 0.08, field: -0.02, forest: 0.05, meadow: 0,
  phrygana: 0.14, olive: 0.09, stubble: -0.02, farmstead: 0.02,
  dunes: 0.04, oasis: -0.03, ruins: 0.03, blackdesert: 0.02,
};
/** Rolling resistance (m/s²) of the ground beside the lane. */
const ROLL_RES: Record<BiomeType, number> = {
  field: 3.6, forest: 1.9, hedge: 2.2, vineyard: 2.0, meadow: 1.9,
  phrygana: 2.4, olive: 2.0, stubble: 2.8, farmstead: 1.9,
  dunes: 3.4, oasis: 2.2, ruins: 2.4, blackdesert: 2.6,
};
const BIOME_WEIGHTS: Record<Landscape, Array<[BiomeType, number]>> = {
  forest: [
    ['forest', 0.3],
    ['meadow', 0.24],
    ['hedge', 0.2],
    ['field', 0.14],
    ['vineyard', 0.12],
  ],
  greece: [
    ['phrygana', 0.34],
    ['olive', 0.3],
    ['stubble', 0.2],
    ['farmstead', 0.16],
  ],
  desert: [
    ['dunes', 0.36],
    ['blackdesert', 0.22],
    ['ruins', 0.22],
    ['oasis', 0.2],
  ],
};

/**
 * A rocky gorge across the track in the Greek landscape, spanned by a steel
 * bridge. The track runs straight and level over the bridge.
 */
export interface Gorge {
  /** Progress of the gorge's centre line; it crosses the track at right angles. */
  p: number;
  /** Path centre x on the bridge. */
  x: number;
  /** Height of the track and of the bridge deck. */
  h: number;
}

export const GORGE = {
  /** Half width (m along the track) of the gorge at the top. */
  half: 16.5,
  depth: 18,
  /** Beyond this lateral distance from the track the gorge has closed. */
  reach: 36,
  /** Half width of the bridge deck: beyond it the apple falls into the gorge. */
  deckHalf: 1.5,
  /** Half length of the bridge deck (it rests on the ground at both ends). */
  deckHalfLen: 17.9,
  /** Distance of the invisible walls along the rims from the gorge centre line. */
  rim: 17.7,
  /** The deck lies this much above the track so the planks never cut into the ground. */
  lift: 0.06,
} as const;
/** Over this distance from a gorge the track eases into a straight, level line. */
const GORGE_FLAT = 42;
/** Search ranges (m into a Greek section) for the first and the second gorge. */
const GORGE_SLOTS: ReadonlyArray<[number, number]> = [[170, 440], [560, 830]];

export class Terrain {
  readonly seed: number;
  private readonly phase: number[];
  private readonly hillCache = new Map<number, Hill[]>();
  private readonly stepOffsetCache = new Map<number, number>();
  private readonly biomeCache = new Map<number, BiomeType>();
  private readonly mixScratch: BiomeMix = { a: 'meadow', b: 'meadow', t: 1 };
  private readonly gorgeCache = new Map<number, Gorge[]>();

  constructor(seed: number) {
    this.seed = seed >>> 0;
    const rng = mulberry32(subSeed(this.seed, 1));
    this.phase = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
  }

  // ---------------------------------------------------------------------------
  // Path centre line

  pathCenterX(p: number): number {
    const x = this.rawCenterX(p);
    const g = this.gorgeNear(p, GORGE_FLAT);
    if (!g) return x;
    return lerp(x, g.x, 1 - smoothstep(GORGE.deckHalfLen + 1, GORGE_FLAT, Math.abs(p - g.p)));
  }

  private rawCenterX(p: number): number {
    const s = this.seed;
    const x =
      5.5 * Math.sin(p * 0.019 + this.phase[0]) +
      3.2 * Math.sin(p * 0.043 + this.phase[1]) +
      2.4 * fbm1(p * 0.02 + 50, s + 3, 2) +
      1.2 * Math.sin(p * 0.11 + this.phase[2]);
    // Ease in so that the player spawns on a straight piece of path.
    const ease = smoothstep(0, 30, p);
    return clamp(x * ease, -CFG.path.maxWander, CFG.path.maxWander);
  }

  /** Direction of the path (yaw in radians, 0 = straight towards -Z, positive = curving left). */
  pathHeading(p: number): number {
    const dx = this.pathCenterX(p + 1) - this.pathCenterX(p - 1);
    return Math.atan2(-dx, 2);
  }

  /** Convert a world position into path coordinates. */
  toPath(x: number, z: number): { p: number; d: number } {
    const p = -z;
    return { p, d: x - this.pathCenterX(p) };
  }

  // ---------------------------------------------------------------------------
  // Hills (the "Hügel" obstacles)

  private hillsInSegment(i: number): Hill[] {
    let list = this.hillCache.get(i);
    if (list) return list;
    list = [];
    const p0 = i * HILL_SEGMENT;
    const rng = mulberry32(subSeed(this.seed, 7000 + i));
    const prob = p0 < 110 ? 0 : Math.min(0.7, 0.28 + p0 / 1600);
    if (rng() < prob) {
      const difficulty = Math.min(1.7, 0.7 + p0 / 700);
      const r = rng();
      const kind: Hill['kind'] = r < 0.55 ? 'bump' : r < 0.8 ? 'up' : 'down';
      const height = Math.min(4, (1.0 + rng() * 1.8) * difficulty * (kind === 'bump' ? 1 : 0.7));
      // Keep the slope climbable (and rollable) by tying the length to the height.
      const length = Math.max(14 + rng() * 14, height * (kind === 'bump' ? 7.5 : 4.5));
      list.push({ start: p0 + rng() * 10, length, height, kind });
    }
    this.hillCache.set(i, list);
    return list;
  }

  /** Sum of all completed step hills before segment i. */
  private stepOffsetBefore(i: number): number {
    if (i <= 0) return 0;
    const cached = this.stepOffsetCache.get(i);
    if (cached !== undefined) return cached;
    let off = this.stepOffsetBefore(i - 1);
    for (const h of this.hillsInSegment(i - 1)) {
      if (h.kind === 'up') off += h.height;
      else if (h.kind === 'down') off -= h.height;
    }
    this.stepOffsetCache.set(i, off);
    return off;
  }

  private hillHeight(p: number): number {
    const i = Math.floor(p / HILL_SEGMENT);
    let h = this.stepOffsetBefore(i);
    for (let k = i - 1; k <= i; k++) {
      if (k < 0) continue;
      for (const hill of this.hillsInSegment(k)) {
        const u = (p - hill.start) / hill.length;
        if (hill.kind === 'bump') {
          if (u > 0 && u < 1) h += hill.height * (0.5 - 0.5 * Math.cos(u * Math.PI * 2));
        } else {
          const s = smoothstep(0, 1, u);
          const contribution = hill.kind === 'up' ? hill.height * s : -hill.height * s;
          // Hills of earlier segments that are fully completed are already in the prefix sum.
          if (k === i) h += contribution;
          else if (u < 1) h += contribution - (hill.kind === 'up' ? hill.height : -hill.height);
        }
      }
    }
    return h;
  }

  /** Height of the path centre line. */
  pathHeight(p: number): number {
    const h = this.rawPathHeight(p);
    const g = this.gorgeNear(p, GORGE_FLAT);
    if (!g) return h;
    return lerp(h, g.h, 1 - smoothstep(GORGE.deckHalfLen + 1, GORGE_FLAT, Math.abs(p - g.p)));
  }

  private rawPathHeight(p: number): number {
    const s = this.seed;
    const rolling = 2.1 * fbm1(p * 0.011 + 7, s + 11, 3) + 0.45 * fbm1(p * 0.047 + 3, s + 13, 2);
    return rolling * smoothstep(0, 25, p) + this.hillHeight(p);
  }

  /** Average slope of the path over the next few metres (used for difficulty hints). */
  pathSlope(p: number): number {
    return (this.pathHeight(p + 2) - this.pathHeight(p - 2)) / 4;
  }

  // ---------------------------------------------------------------------------
  // Gorges (Greek landscape only, at most two per landscape section)

  /** The gorges of landscape section k (empty unless it is Greek). */
  gorgesIn(k: number): Gorge[] {
    let list = this.gorgeCache.get(k);
    if (list) return list;
    list = [];
    if (k > 0 && landscapeOfIndex(k) === 'greece') {
      const rng = mulberry32(subSeed(this.seed, 12000 + k));
      GORGE_SLOTS.forEach(([lo, hi], slot) => {
        if (slot > 0 && rng() > 0.6) return;
        // Look for a stretch where the track is fairly level and straight.
        for (let attempt = 0; attempt < 12; attempt++) {
          const c = k * LANDSCAPE_LENGTH + lo + rng() * (hi - lo);
          const h = this.rawPathHeight(c);
          let ok = Math.abs(this.rawCenterX(c + 40) - this.rawCenterX(c - 40)) < 6;
          for (const o of [-40, -24, -12, 12, 24, 40]) if (Math.abs(this.rawPathHeight(c + o) - h) > 2) ok = false;
          if (!ok) continue;
          list!.push({ p: c, x: this.rawCenterX(c), h });
          break;
        }
      });
    }
    this.gorgeCache.set(k, list);
    return list;
  }

  /** The gorge whose centre line is within `margin` metres of progress p, if any. */
  gorgeNear(p: number, margin: number): Gorge | null {
    const k = Math.floor(p / LANDSCAPE_LENGTH);
    if (k <= 0 || landscapeOfIndex(k) !== 'greece') return null;
    for (const g of this.gorgesIn(k)) if (Math.abs(p - g.p) < margin) return g;
    return null;
  }

  /** Depth (m) the gorge cuts into the ground at (x, z); 0 outside every gorge. */
  gorgeCarve(x: number, z: number): number {
    const p = -z;
    const g = this.gorgeNear(p, GORGE.half + 1);
    return g ? this.carveOf(g, p, x - g.x) : 0;
  }

  private carveOf(g: Gorge, p: number, d: number): number {
    const ad = Math.abs(d);
    if (ad >= GORGE.reach) return 0;
    // Ragged rims; the gorge narrows and closes far from the track.
    const edge = (GORGE.half - 0.35 + 0.7 * noise1(d * 0.21 + g.p, this.seed + 71)) * (1 - smoothstep(GORGE.reach - 13, GORGE.reach, ad));
    const u = Math.abs(p - g.p);
    if (u >= edge) return 0;
    // Steep rock walls about 4 m wide, a broad floor in between.
    const t = 1 - smoothstep(edge - 4.5, edge, u);
    return GORGE.depth * t * (0.85 + 0.15 * noise1(d * 0.33, this.seed + 73));
  }

  /** True when (x, z) lies on the bridge deck over a gorge. */
  onBridge(x: number, z: number): boolean {
    const p = -z;
    const g = this.gorgeNear(p, GORGE.deckHalfLen);
    return g !== null && Math.abs(x - g.x) < GORGE.deckHalf;
  }

  // ---------------------------------------------------------------------------
  // Biomes

  biomeAt(p: number, side: Side): BiomeType {
    const k = Math.max(0, Math.floor(p / BIOME_SEGMENT));
    return this.biomeOfSegment(k, side);
  }

  private biomeOfSegment(k: number, side: Side): BiomeType {
    const key = k * 2 + (side > 0 ? 1 : 0);
    const cached = this.biomeCache.get(key);
    if (cached) return cached;
    let biome: BiomeType;
    if (k === 0) biome = side < 0 ? 'meadow' : 'hedge';
    else if (k === 1) biome = side < 0 ? 'forest' : 'meadow';
    else {
      const rng = mulberry32(subSeed(this.seed, 9000 + k, side + 2));
      const weights = BIOME_WEIGHTS[landscapeOfIndex(Math.floor((k * BIOME_SEGMENT) / LANDSCAPE_LENGTH))];
      const prev = this.biomeOfSegment(k - 1, side);
      // The left side is decided first; the right side tries not to copy it.
      const other = side === 1 ? this.biomeOfSegment(k, -1) : null;
      biome = prev;
      for (let attempt = 0; attempt < 4 && (biome === prev || (biome === other && rng() < 0.5)); attempt++) {
        let r = rng();
        biome = weights[weights.length - 1][0];
        for (const [b, w] of weights) {
          if (r < w) {
            biome = b;
            break;
          }
          r -= w;
        }
      }
    }
    this.biomeCache.set(key, biome);
    return biome;
  }

  /**
   * Biomes blend symmetrically over ±W metres around every segment edge so that
   * heights, colours and rolling resistance are continuous. Returns a scratch
   * object unless `out` is given: do not keep the result across calls.
   */
  biomeMix(p: number, side: Side, out: BiomeMix = this.mixScratch): BiomeMix {
    const W = 9;
    const k = Math.max(0, Math.floor(p / BIOME_SEGMENT));
    const local = p - k * BIOME_SEGMENT;
    if (k > 0 && local < W) {
      out.a = this.biomeOfSegment(k - 1, side);
      out.b = this.biomeOfSegment(k, side);
      out.t = smoothstep(-W, W, local);
    } else if (local > BIOME_SEGMENT - W) {
      out.a = this.biomeOfSegment(k, side);
      out.b = this.biomeOfSegment(k + 1, side);
      out.t = smoothstep(-W, W, local - BIOME_SEGMENT);
    } else {
      out.a = out.b = this.biomeOfSegment(k, side);
      out.t = 1;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Height field

  private sideSlope(p: number, side: Side): number {
    const base = 0.11 * noise1(p * 0.012 + side * 31, this.seed + 17 + side * 3);
    const mix = this.biomeMix(p, side);
    return clamp(base + lerp(SLOPE_BIAS[mix.a], SLOPE_BIAS[mix.b], mix.t), -0.2, 0.22);
  }

  /** Cross-section of the track: two shallow wheel ruts, a crown and raised verges. */
  private crossSection(d: number): number {
    const ad = Math.abs(d);
    const rut = -0.045 * Math.exp(-(((ad - CFG.path.rutCenter) / 0.24) ** 2));
    const crown = ad < CFG.path.halfWidth ? 0.035 * (1 - (ad / CFG.path.halfWidth) ** 2) : 0;
    const verge = 0.1 * smoothstep(CFG.path.halfWidth, 2.8, ad);
    return rut + crown + verge;
  }

  groundHeight(x: number, z: number): number {
    const p = -z;
    const cx = this.pathCenterX(p);
    const d = x - cx;
    const side: Side = d < 0 ? -1 : 1;
    return this.groundHeightRow(x, z, cx, this.pathHeight(p), this.sideSlope(p, side), true);
  }

  /**
   * Height with the row-constant terms (path centre, path height, side slope)
   * supplied by the caller. Chunk building evaluates them once per row.
   * With `deck` the bridge deck over a gorge counts as ground (physics);
   * without it the gorge is carved out underneath (terrain mesh).
   */
  groundHeightRow(x: number, z: number, cx: number, pathH: number, slope: number, deck = false): number {
    const d = x - cx;
    const ad = Math.abs(d);
    const s = this.seed;
    const gorge = this.gorgeNear(-z, GORGE.deckHalfLen + 3);
    // The ruts fade out before the bridge and the track ramps up to the deck,
    // so the deck continues it without a step. The visible ground stays a little
    // below the planks.
    const ruts = gorge ? smoothstep(GORGE.deckHalfLen, GORGE.deckHalfLen + 2.5, Math.abs(-z - gorge.p)) : 1;
    let h = pathH + this.crossSection(d) * ruts + GORGE.lift * (1 - ruts) * (deck ? 1 : 0.5);
    const dd = Math.max(0, ad - CFG.path.halfWidth);
    h += slope * Math.min(dd, 45);
    h += 0.9 * fbm2(x * 0.07, z * 0.07, s + 21, 3) * smoothstep(1.7, 6, ad);
    h += 6 * fbm2(x * 0.012 + 3, z * 0.012, s + 23, 3) * smoothstep(9, 40, ad);
    const w = ad > 4 ? landscapeWeight(-z, 'desert') : 0;
    if (w > 0) {
      // Sand dunes beside the track: sharp crests across the wind.
      const ridge = 1 - Math.abs(fbm2(x * 0.03 + 5, z * 0.012, s + 25, 2));
      h += w * smoothstep(4, 14, ad) * 1.8 * ridge * ridge;
    }
    const ax = Math.abs(x);
    if (ax > CFG.chunk.halfWidth) {
      // Distant wooded hills rising towards the horizon.
      const far = ax - CFG.chunk.halfWidth;
      h += far * 0.11 + 9 * fbm2(x * 0.006, z * 0.006 + 9, s + 29, 3) * smoothstep(0, 60, far);
      // In Greece bare limestone mountains rise behind the hills.
      const g = landscapeWeight(-z, 'greece');
      if (g > 0) {
        const ridge = 1 - Math.abs(fbm2(x * 0.005 + 17, z * 0.004, s + 31, 3));
        h += g * smoothstep(55, 230, far) * (12 + 55 * ridge * ridge + 6 * fbm2(x * 0.03, z * 0.03, s + 33, 2));
      }
      // In the desert the hills give way to a sea of large, flat dunes.
      if (w > 0) {
        const ridge = 1 - Math.abs(fbm2(x * 0.008 + 41, z * 0.005, s + 35, 2));
        h += w * (smoothstep(20, 140, far) * 14 * ridge * ridge - far * 0.07 - 6 * fbm2(x * 0.006, z * 0.006 + 9, s + 29, 3) * smoothstep(0, 60, far));
      }
    }
    if (gorge && !(deck && Math.abs(x - gorge.x) < GORGE.deckHalf && Math.abs(-z - gorge.p) < GORGE.deckHalfLen)) {
      h -= this.carveOf(gorge, -z, x - gorge.x);
    }
    return h;
  }

  groundNormal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 0.12;
    const hx = this.groundHeight(x + e, z) - this.groundHeight(x - e, z);
    const hz = this.groundHeight(x, z + e) - this.groundHeight(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  // ---------------------------------------------------------------------------
  // Surface types (rolling resistance for the apple)

  /** Rolling resistance in m/s² for the ground at this position (ignoring puddles). */
  rollingResistance(x: number, z: number): number {
    const { p, d } = this.toPath(x, z);
    const ad = Math.abs(d);
    // The bridge planks are smooth.
    if (this.onBridge(x, z)) return 0.9;
    if (ad < CFG.path.halfWidth) {
      const rut = Math.exp(-(((ad - CFG.path.rutCenter) / 0.3) ** 2));
      return lerp(1.5, 0.75, rut);
    }
    const mix = this.biomeMix(p, d < 0 ? -1 : 1);
    return lerp(ROLL_RES[mix.a], ROLL_RES[mix.b], mix.t);
  }

  // ---------------------------------------------------------------------------
  // Colours

  private static readonly PAL = {
    dirt: new THREE.Color(0x9a7a52),
    dirtDark: new THREE.Color(0x7a5c3c),
    pathGrass: new THREE.Color(0x8da24a),
    verge: new THREE.Color(0x6f9a3c),
    meadow: new THREE.Color(0x7aa83f),
    meadowDark: new THREE.Color(0x5f8f34),
    straw: new THREE.Color(0xc3b270),
    strawPale: new THREE.Color(0xd6c98e),
    litter: new THREE.Color(0x7a5a3b),
    litterDark: new THREE.Color(0x5e4530),
    forestGrass: new THREE.Color(0x56823a),
    soil: new THREE.Color(0x6b4d35),
    soilLight: new THREE.Color(0x8c6c4c),
    vineGrass: new THREE.Color(0x8aa64a),
    vineSoil: new THREE.Color(0x7e6243),
    farForest: new THREE.Color(0x3f6a33),
    farForestDark: new THREE.Color(0x2f5329),
    farMeadow: new THREE.Color(0x7ba04a),
    // Greece in late summer.
    gDirt: new THREE.Color(0xc9b28a),
    gDirtDark: new THREE.Color(0xae9470),
    gPathGrass: new THREE.Color(0xb7a766),
    gVerge: new THREE.Color(0xa69c58),
    dryGrass: new THREE.Color(0xc8b26c),
    dryGrassPale: new THREE.Color(0xdccb92),
    scrub: new THREE.Color(0x7c8446),
    scrubDark: new THREE.Color(0x5f6b38),
    rock: new THREE.Color(0xbdb7a8),
    redSoil: new THREE.Color(0xa4734a),
    stubble: new THREE.Color(0xdcc47c),
    stubbleDark: new THREE.Color(0xbfa45c),
    farRock: new THREE.Color(0xcdc8ba),
    farRockDark: new THREE.Color(0xaaa597),
    farScrub: new THREE.Color(0x6e7a40),
    farGold: new THREE.Color(0xbba766),
    gorgeRock: new THREE.Color(0x9c9282),
    gorgeDeep: new THREE.Color(0x6e665a),
    // The Egyptian desert.
    sand: new THREE.Color(0xdcb478),
    sandLight: new THREE.Color(0xe8c993),
    sandShade: new THREE.Color(0xc79c5e),
    sandPath: new THREE.Color(0xd2b382),
    sandPathDark: new THREE.Color(0xbfa070),
    sandVerge: new THREE.Color(0xd6b27a),
    basalt: new THREE.Color(0x4a3d34),
    oasisGrass: new THREE.Color(0x8c9a48),
    farSand: new THREE.Color(0xdcb070),
    farSandShade: new THREE.Color(0xc4975a),
  };

  private readonly tmpA = new THREE.Color();
  private readonly tmpB = new THREE.Color();

  private biomeColor(b: BiomeType, p: number, d: number, x: number, z: number, out: THREE.Color): THREE.Color {
    const P = Terrain.PAL;
    const ad = Math.abs(d);
    const s = this.seed;
    const n = fbm2(x * 0.05, z * 0.05, s + 41, 3);
    switch (b) {
      case 'meadow': {
        const patch = smoothstep(-0.15, 0.45, n + 0.25 * Math.sin(p * 0.35 + d * 0.1));
        out.copy(P.meadow).lerp(P.straw, patch * 0.8);
        if (ad > 20) out.lerp(P.strawPale, smoothstep(20, 40, ad) * 0.3);
        return out;
      }
      case 'forest': {
        const litter = smoothstep(1.8, 4.5, ad) * smoothstep(-0.4, 0.3, n + 0.3);
        out.copy(P.forestGrass).lerp(P.litter, litter);
        out.lerp(P.litterDark, smoothstep(0.1, 0.6, valueNoise2(x * 0.2, z * 0.2, s + 43)) * 0.5 * litter);
        return out;
      }
      case 'hedge': {
        if (ad < 5.5) {
          out.copy(P.verge).lerp(P.litterDark, smoothstep(1.9, 3.2, ad) * (1 - smoothstep(4.5, 5.5, ad)));
          return out;
        }
        const patch = smoothstep(-0.2, 0.4, n);
        return out.copy(P.meadow).lerp(P.straw, patch * 0.6);
      }
      case 'field': {
        if (ad < 2.6 || ad > 34) {
          const patch = smoothstep(-0.2, 0.4, n);
          return out.copy(P.meadow).lerp(P.straw, patch * 0.5);
        }
        // Furrows run across the field at a slight angle.
        const furrow = 0.5 + 0.5 * Math.sin((d * 0.9 + p * 0.15) * 3.1);
        out.copy(P.soil).lerp(P.soilLight, furrow * 0.7 + 0.2 * n);
        out.lerp(P.straw, smoothstep(0.3, 0.7, valueNoise2(x * 0.3, z * 0.3, s + 47)) * 0.25);
        return out;
      }
      case 'vineyard': {
        if (ad < 2.8 || ad > 27) {
          return out.copy(P.meadow).lerp(P.straw, smoothstep(-0.2, 0.4, n) * 0.5);
        }
        const rowPhase = ((p % 2.4) + 2.4) % 2.4;
        const underVine = 1 - smoothstep(0.25, 0.55, Math.abs(rowPhase - 1.2));
        return out.copy(P.vineGrass).lerp(P.vineSoil, underVine * 0.5);
      }
      case 'phrygana': {
        // Dry grass with dark scrub patches and bare limestone.
        out.copy(P.dryGrass).lerp(P.scrub, smoothstep(-0.05, 0.45, n) * 0.75);
        out.lerp(P.rock, smoothstep(0.35, 0.7, valueNoise2(x * 0.16, z * 0.16, s + 45)) * 0.8);
        return out;
      }
      case 'olive': {
        if (ad < 2.6) return out.copy(P.dryGrass).lerp(P.dryGrassPale, smoothstep(-0.2, 0.4, n) * 0.5);
        return out.copy(P.redSoil).lerp(P.dryGrass, smoothstep(-0.3, 0.5, n) * 0.6);
      }
      case 'stubble': {
        if (ad < 2.6 || ad > 34) return out.copy(P.dryGrass).lerp(P.scrub, smoothstep(0.1, 0.5, n) * 0.4);
        // Harvest stripes along the path.
        const stripe = 0.5 + 0.5 * Math.sin(d * 1.6 + 0.2 * Math.sin(p * 0.05));
        return out.copy(P.stubble).lerp(P.stubbleDark, stripe * 0.6 + 0.15 * n);
      }
      case 'farmstead': {
        out.copy(P.dryGrass).lerp(P.dryGrassPale, smoothstep(-0.2, 0.4, n) * 0.6);
        return out.lerp(P.scrub, smoothstep(0.3, 0.6, valueNoise2(x * 0.12, z * 0.12, s + 49)) * 0.5);
      }
      case 'dunes': {
        // Wind ripples across the sand.
        const ripple = 0.5 + 0.5 * Math.sin(x * 2.2 + z * 0.9 + 2 * n);
        return out.copy(P.sand).lerp(P.sandLight, smoothstep(-0.2, 0.5, n) * 0.6).lerp(P.sandShade, ripple * 0.25);
      }
      case 'blackdesert': {
        // Orange sand strewn with dark basalt grit.
        out.copy(P.sand).lerp(P.sandShade, smoothstep(-0.3, 0.4, n) * 0.6);
        return out.lerp(P.basalt, smoothstep(0.25, 0.7, valueNoise2(x * 0.2, z * 0.2, s + 55)) * 0.55);
      }
      case 'ruins': {
        return out.copy(P.sandLight).lerp(P.sand, smoothstep(-0.2, 0.4, n) * 0.7);
      }
      case 'oasis': {
        const green = smoothstep(-0.1, 0.4, n) * (1 - smoothstep(14, 30, ad));
        return out.copy(P.sand).lerp(P.oasisGrass, green * 0.85);
      }
    }
  }

  /** Ground colour (linear RGB) at a world position. */
  groundColor(x: number, z: number, out: THREE.Color): THREE.Color {
    const p = -z;
    const cx = this.pathCenterX(p);
    const d = x - cx;
    const mix = this.biomeMix(p, d < 0 ? -1 : 1, this.mixColor);
    return this.groundColorRow(x, z, cx, mix, out);
  }

  private readonly mixColor: BiomeMix = { a: 'meadow', b: 'meadow', t: 1 };

  /** Ground colour with the row-constant path centre and biome mix supplied by the caller. */
  groundColorRow(x: number, z: number, cx: number, mix: BiomeMix, out: THREE.Color): THREE.Color {
    const P = Terrain.PAL;
    const p = -z;
    const d = x - cx;
    const ad = Math.abs(d);
    const ax = Math.abs(x);
    const s = this.seed;
    const g = landscapeWeight(p, 'greece');
    const w = landscapeWeight(p, 'desert');

    if (ax > CFG.chunk.halfWidth - 2) {
      const far = ax - CFG.chunk.halfWidth;
      const n = fbm2(x * 0.01, z * 0.01, s + 51, 3);
      const v = valueNoise2(x * 0.03, z * 0.03, s + 53);
      out.copy(P.farForest).lerp(P.farForestDark, smoothstep(-0.3, 0.4, v));
      out.lerp(P.farMeadow, smoothstep(0.15, 0.45, n) * (1 - smoothstep(60, 140, far)));
      if (g > 0) {
        // Golden foothills with scrub, grey rock higher up.
        this.tmpA.copy(P.farGold).lerp(P.farScrub, smoothstep(-0.2, 0.4, v) * 0.8);
        this.tmpB.copy(P.farRock).lerp(P.farRockDark, smoothstep(-0.2, 0.5, n));
        this.tmpA.lerp(this.tmpB, smoothstep(80, 170, far + 30 * n));
        out.lerp(this.tmpA, g);
      }
      if (w > 0) {
        this.tmpA.copy(P.farSand).lerp(P.farSandShade, smoothstep(-0.2, 0.5, v) * 0.7);
        out.lerp(this.tmpA, w);
      }
      // Blend into the detailed terrain colour.
      if (far < 0) {
        const inner = this.groundColorInner(p, d, x, z, mix, g, w, this.tmpB);
        out.lerp(inner, smoothstep(0, -2, far));
      }
    } else {
      this.groundColorInner(p, d, x, z, mix, g, w, out);
    }

    // Bare rock in the gorge, darker towards the bottom.
    const carve = this.gorgeCarve(x, z);
    if (carve > 0.15) {
      const v = valueNoise2(x * 0.4, z * 0.9 + carve * 0.5, s + 75);
      this.tmpA.copy(P.rock).lerp(P.gorgeRock, smoothstep(-0.3, 0.5, v)).lerp(P.gorgeDeep, smoothstep(6, GORGE.depth, carve) * 0.7);
      out.lerp(this.tmpA, smoothstep(0.15, 1.2, carve));
      return out;
    }

    // Leaf-litter freckles on the track in autumn, pale gravel in Greece, light sand in the desert.
    if (ad < 2.4 && hash3(Math.floor(x * 2), Math.floor(z * 2), s + 61) > 0.9) {
      out.lerp(this.tmpA.setHex(0xb07a3a).lerp(P.dryGrassPale, g).lerp(P.sandLight, w), 0.3);
    }
    return out;
  }

  private readonly vergeTmp = new THREE.Color();

  /** g, w: weights of the Greek and the desert landscape (0..1) for the colours of the track and verge. */
  private groundColorInner(p: number, d: number, x: number, z: number, mix: BiomeMix, g: number, w: number, out: THREE.Color): THREE.Color {
    const P = Terrain.PAL;
    const ad = Math.abs(d);
    const s = this.seed;
    const verge = this.vergeTmp.copy(P.verge).lerp(P.gVerge, g).lerp(P.sandVerge, w);
    if (ad < CFG.path.halfWidth + 0.35) {
      const rut = Math.exp(-(((ad - CFG.path.rutCenter) / 0.3) ** 2));
      const dirtVar = smoothstep(-0.4, 0.5, valueNoise2(x * 0.5, z * 0.5, s + 31));
      this.tmpA.copy(P.dirt).lerp(P.dirtDark, dirtVar * 0.6);
      if (g > 0) this.tmpA.lerp(this.tmpB.copy(P.gDirt).lerp(P.gDirtDark, dirtVar * 0.6), g);
      if (w > 0) this.tmpA.lerp(this.tmpB.copy(P.sandPathDark).lerp(P.sandPath, dirtVar * 0.6), w);
      out.copy(P.pathGrass).lerp(P.gPathGrass, g).lerp(P.sandVerge, w).lerp(this.tmpA, smoothstep(0.25, 0.75, rut));
      // The track fades into the verge.
      out.lerp(verge, smoothstep(CFG.path.halfWidth - 0.3, CFG.path.halfWidth + 0.35, ad));
      return out;
    }
    this.biomeColor(mix.b, p, d, x, z, out);
    if (mix.t < 1) {
      this.biomeColor(mix.a, p, d, x, z, this.tmpA);
      out.lerp(this.tmpA, 1 - mix.t);
    }
    // Verge grass fades into the biome colour.
    out.lerp(verge, 1 - smoothstep(CFG.path.halfWidth + 0.2, 2.6, ad));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Chunk geometry

  /** Z range covered by chunk index i (p from i*L to (i+1)*L). */
  static chunkRange(i: number): { zNear: number; zFar: number; p0: number; p1: number } {
    const L = CFG.chunk.length;
    return { zNear: -i * L, zFar: -(i + 1) * L, p0: i * L, p1: (i + 1) * L };
  }

  private columns(): number[] {
    const cols: number[] = [];
    const { halfWidth, fineHalfWidth, fineStep, coarseStep } = CFG.chunk;
    for (let x = -halfWidth; x < -fineHalfWidth - 1e-6; x += coarseStep) cols.push(x);
    for (let x = -fineHalfWidth; x < fineHalfWidth - 1e-6; x += fineStep) cols.push(x);
    for (let x = fineHalfWidth; x <= halfWidth + 1e-6; x += coarseStep) cols.push(x);
    return cols;
  }

  /** Builds the detailed, flat-shaded ground geometry for a chunk (synchronously). */
  buildChunkGeometry(i: number): THREE.BufferGeometry {
    const gen = this.buildChunkGeometryGen(i);
    for (;;) {
      const r = gen.next();
      if (r.done) return r.value;
    }
  }

  /** Same as buildChunkGeometry but as a generator that yields every few rows. */
  *buildChunkGeometryGen(i: number): Generator<void, THREE.BufferGeometry> {
    const { zNear, zFar } = Terrain.chunkRange(i);
    const cols = this.columns();
    const rows: number[] = [];
    for (let z = zNear; z >= zFar - 1e-6; z -= CFG.chunk.fineStep) rows.push(z);
    return yield* this.buildGridGen(cols, rows, 2000 + i, 0, 6);
  }

  /** Builds the coarse backdrop strips on both sides of a chunk. */
  buildFarGeometry(i: number): THREE.BufferGeometry {
    const { zNear, zFar } = Terrain.chunkRange(i);
    const { halfWidth, farExtent, farStep } = CFG.chunk;
    const rows: number[] = [];
    for (let z = zNear; z >= zFar - 1e-6; z -= farStep) rows.push(z);
    const left: number[] = [];
    const right: number[] = [];
    for (let x = halfWidth - 1.5; x <= farExtent; x += farStep) {
      right.push(x);
      left.unshift(-x);
    }
    const a = this.buildGrid(left, rows, 3000 + i, -0.35);
    const b = this.buildGrid(right, rows, 4000 + i, -0.35);
    return mergeNonIndexed([a, b]);
  }

  private buildGrid(cols: number[], rows: number[], salt: number, yOffset = 0): THREE.BufferGeometry {
    const gen = this.buildGridGen(cols, rows, salt, yOffset, Infinity);
    for (;;) {
      const r = gen.next();
      if (r.done) return r.value;
    }
  }

  /**
   * Grid builder. Heights are sampled per grid vertex; colours are sampled per
   * face at the triangle centroid so that the narrow wheel ruts stay crisp.
   * Row-constant terms (path centre, path height, side slopes, biome mix) are
   * evaluated once per row. Yields after every `rowsPerStep` rows.
   */
  private *buildGridGen(cols: number[], rows: number[], salt: number, yOffset: number, rowsPerStep: number): Generator<void, THREE.BufferGeometry> {
    const nc = cols.length;
    const nr = rows.length;
    const heights = new Float32Array(nc * nr);
    const rowCx = new Float32Array(nr);
    const mixL: BiomeMix[] = [];
    const mixR: BiomeMix[] = [];
    for (let r = 0; r < nr; r++) {
      const z = rows[r];
      const p = -z;
      const cx = this.pathCenterX(p);
      const ph = this.pathHeight(p);
      const slopeL = this.sideSlope(p, -1);
      const slopeR = this.sideSlope(p, 1);
      rowCx[r] = cx;
      mixL.push(this.biomeMix(p, -1, { a: 'meadow', b: 'meadow', t: 1 }));
      mixR.push(this.biomeMix(p, 1, { a: 'meadow', b: 'meadow', t: 1 }));
      for (let c = 0; c < nc; c++) {
        const x = cols[c];
        const side: Side = x < cx ? -1 : 1;
        heights[r * nc + c] = this.groundHeightRow(x, z, cx, ph, side < 0 ? slopeL : slopeR) + yOffset;
      }
      if ((r + 1) % rowsPerStep === 0) yield;
    }
    const quadCount = (nc - 1) * (nr - 1);
    const vertCount = quadCount * 6;
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);
    const color = new THREE.Color();
    const pA = new THREE.Vector3();
    const pB = new THREE.Vector3();
    const pC = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const n = new THREE.Vector3();
    let v = 0;
    let rowIndex = 0;
    const emit = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, facet: number): void => {
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      n.crossVectors(ab, ac).normalize();
      if (n.y < 0) n.negate();
      const cxF = (a.x + b.x + c.x) / 3;
      const czF = (a.z + b.z + c.z) / 3;
      const cx = rowCx[rowIndex];
      this.groundColorRow(cxF, czF, cx, cxF < cx ? mixL[rowIndex] : mixR[rowIndex], color);
      const bright = 0.97 + 0.06 * facet;
      const cr = color.r * bright;
      const cg = color.g * bright;
      const cb = color.b * bright;
      const o = v * 3;
      positions[o] = a.x; positions[o + 1] = a.y; positions[o + 2] = a.z;
      positions[o + 3] = b.x; positions[o + 4] = b.y; positions[o + 5] = b.z;
      positions[o + 6] = c.x; positions[o + 7] = c.y; positions[o + 8] = c.z;
      for (let k = 0; k < 9; k += 3) {
        normals[o + k] = n.x; normals[o + k + 1] = n.y; normals[o + k + 2] = n.z;
        colors[o + k] = cr; colors[o + k + 1] = cg; colors[o + k + 2] = cb;
      }
      v += 3;
    };
    for (let r = 0; r < nr - 1; r++) {
      rowIndex = r;
      for (let c = 0; c < nc - 1; c++) {
        const h00 = heights[r * nc + c];
        const h10 = heights[r * nc + c + 1];
        const h01 = heights[(r + 1) * nc + c];
        const h11 = heights[(r + 1) * nc + c + 1];
        const x0 = cols[c];
        const x1 = cols[c + 1];
        const z0 = rows[r];
        const z1 = rows[r + 1];
        const flip = hash3(c, r, this.seed + salt) > 0.5;
        const f1 = hash3(c * 2, r, this.seed + salt + 7);
        const f2 = hash3(c * 2 + 1, r, this.seed + salt + 7);
        // Triangles are emitted counter-clockwise seen from above (x grows to the
        // right, z shrinks towards the far row).
        if (flip) {
          pA.set(x0, h00, z0); pB.set(x1, h11, z1); pC.set(x0, h01, z1);
          emit(pA, pB, pC, f1);
          pA.set(x0, h00, z0); pB.set(x1, h10, z0); pC.set(x1, h11, z1);
          emit(pA, pB, pC, f2);
        } else {
          pA.set(x0, h00, z0); pB.set(x1, h10, z0); pC.set(x0, h01, z1);
          emit(pA, pB, pC, f1);
          pA.set(x1, h10, z0); pB.set(x1, h11, z1); pC.set(x0, h01, z1);
          emit(pA, pB, pC, f2);
        }
      }
      if ((r + 1) % rowsPerStep === 0) yield;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    fixWinding(geo);
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * Safety net: ensure every triangle is wound counter-clockwise when seen from
 * above (front face up). Colours are per face, so only positions need swapping.
 */
function fixWinding(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  for (let i = 0; i < pos.count; i += 3) {
    const ax = arr[i * 3], az = arr[i * 3 + 2];
    const bx = arr[(i + 1) * 3], bz = arr[(i + 1) * 3 + 2];
    const cx = arr[(i + 2) * 3], cz = arr[(i + 2) * 3 + 2];
    // Y component of (b-a) x (c-a).
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    if (ny < 0) {
      for (let k = 0; k < 3; k++) {
        const t = arr[(i + 1) * 3 + k];
        arr[(i + 1) * 3 + k] = arr[(i + 2) * 3 + k];
        arr[(i + 2) * 3 + k] = t;
      }
    }
  }
}

function mergeNonIndexed(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = ['position', 'normal', 'color'];
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    let total = 0;
    for (const g of list) total += (g.getAttribute(name) as THREE.BufferAttribute).count;
    const arr = new Float32Array(total * 3);
    let off = 0;
    for (const g of list) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      arr.set(a.array as Float32Array, off);
      off += a.array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  for (const g of list) g.dispose();
  out.computeBoundingSphere();
  return out;
}
