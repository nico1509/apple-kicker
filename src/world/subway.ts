import { CFG } from '../config';
import { lerp, smoothstep } from '../utils/math';
import { mulberry32, rand, subSeed } from '../utils/noise';
import { LANDSCAPE_LENGTH, landscapeOfIndex } from './landscape';

/**
 * The subway: a railway cutting with three tracks between concrete walls,
 * after Subway Surfers. Trains stand on the tracks; the way through leads
 * along a free track or up a ramp onto the roof of a train. There is no
 * jumping, so every stretch of trains leaves at least one of the two open.
 *
 * Lengths in metres; p is the progress along the path. The path runs
 * straight down the middle track at x = 0.
 */
export const SUBWAY = {
  /** x of the three tracks. */
  lanes: [-4, 0, 4] as readonly number[],
  /** Half the distance between the rails. */
  gauge: 0.72,
  /**
   * Half width of the cutting between the walls: the gap beside a train on an
   * outer track is too narrow for the apple, so it can never get stuck there.
   */
  wall: 5.45,
  /** Thickness of the walls. */
  wallThick: 0.6,
  /** The ground beyond the walls lies this much higher than the tracks. */
  cut: 3.5,
  /** Half width of the funnel at the open ends of the walls. */
  flare: 12,
  trainWidth: 2.7,
  /** Height of a train roof above the track (also the top of the ramps). */
  trainHeight: 3.2,
  /** Length of one car, couplings included. */
  carLength: 13.5,
  rampLength: 9,
} as const;

/** Into the section the walls begin here (and end as far before its end). */
const WALL_START = 20;
/** Over this distance the walls close in from the funnel to the cutting. */
const FUNNEL = 40;
/** The first train stands this far into the section, the last one ends this far before its end. */
const TRAINS_FROM = 75;
const TRAINS_TO = 920;

export interface Train {
  lane: number;
  x: number;
  /** Foot of the ramp, or the front of the train without one. */
  p0: number;
  /** Front of the first car. */
  front: number;
  /** Rear end of the last car. */
  p1: number;
  cars: number;
  ramp: boolean;
  kind: 'metro' | 'freight';
  /** Index into the paint colours. */
  paint: number;
}

/** A row of trains side by side; between two blocks every track is free. */
export interface Block {
  p0: number;
  p1: number;
  /** Per track: no train, a train, or a train with a ramp. */
  lanes: Array<'free' | 'train' | 'ramp'>;
}

export interface SubwaySection {
  /** Progress where the section begins. */
  s: number;
  blocks: Block[];
  trains: Train[];
  /** Trains by chunk index of every chunk they reach into. */
  byChunk: Map<number, Train[]>;
}

/** Start of the subway section around p (within its approaches), or null. */
export function subwayStart(p: number): number | null {
  const k = Math.floor(p / LANDSCAPE_LENGTH);
  for (const j of [k, k + 1, k - 1]) {
    if (j <= 0 || landscapeOfIndex(j) !== 'subway') continue;
    const s = j * LANDSCAPE_LENGTH;
    if (p > s - 60 && p < s + LANDSCAPE_LENGTH + 60) return s;
  }
  return null;
}

/** 0..1: how far the track has eased into the straight, level line of the subway. */
export function subwayStraight(p: number): number {
  const s = subwayStart(p);
  if (s === null) return 0;
  return smoothstep(s - 50, s + 15, p) * (1 - smoothstep(s + LANDSCAPE_LENGTH - 15, s + LANDSCAPE_LENGTH + 50, p));
}

/** Half width between the walls at p, or Infinity where there are none. */
export function subwayWallHalf(p: number): number {
  const s = subwayStart(p);
  if (s === null) return Infinity;
  const u = p - s;
  const end = LANDSCAPE_LENGTH - WALL_START;
  if (u < WALL_START || u > end) return Infinity;
  if (u < WALL_START + FUNNEL) return lerp(SUBWAY.flare, SUBWAY.wall, (u - WALL_START) / FUNNEL);
  if (u > end - FUNNEL) return lerp(SUBWAY.flare, SUBWAY.wall, (end - u) / FUNNEL);
  return SUBWAY.wall;
}

/** How deep the cutting is at p (0 at the open ends). */
export function subwayCut(p: number): number {
  const s = subwayStart(p);
  if (s === null) return 0;
  const end = s + LANDSCAPE_LENGTH - WALL_START;
  return SUBWAY.cut * smoothstep(s + WALL_START, s + WALL_START + FUNNEL, p) * (1 - smoothstep(end - FUNNEL, end, p));
}

/** Into the section, the regular bottles give way to the rows of the subway between these. */
export const SUBWAY_CORE = { from: WALL_START + FUNNEL / 2, to: LANDSCAPE_LENGTH - WALL_START - FUNNEL / 2 } as const;

/** True where the regular path things (bottles, obstacles) give way to the subway. */
export function inSubwayCore(p: number): boolean {
  const s = subwayStart(p);
  return s !== null && p > s + SUBWAY_CORE.from && p < s + SUBWAY_CORE.to;
}

/** Lays out the trains of the subway section starting at s. */
export function buildSubwaySection(seed: number, s: number): SubwaySection {
  const rng = mulberry32(subSeed(seed, 15000 + Math.round(s / LANDSCAPE_LENGTH)));
  const blocks: Block[] = [];
  const trains: Train[] = [];
  let p = s + TRAINS_FROM;
  for (;;) {
    const u = (p - s) / LANDSCAPE_LENGTH;
    // More trains and longer ones further in.
    const busy = lerp(0.45, 0.8, u);
    const lanes: Block['lanes'] = SUBWAY.lanes.map(() => (rng() < busy ? (rng() < 0.35 ? 'ramp' : 'train') : 'free'));
    // There must be a way through: a free track or a ramp ...
    if (!lanes.some((l) => l !== 'train')) lanes[Math.floor(rng() * 3)] = rng() < 0.5 ? 'free' : 'ramp';
    // ... and something in the way.
    if (!lanes.some((l) => l !== 'free')) lanes[Math.floor(rng() * 3)] = 'train';
    const row: Train[] = [];
    let end = p;
    lanes.forEach((l, lane) => {
      if (l === 'free') return;
      const ramp = l === 'ramp';
      const cars = Math.min(3, 1 + Math.floor(rng() * (1.6 + 2 * u)));
      const p0 = p + rand(rng, 0, 5);
      const front = p0 + (ramp ? SUBWAY.rampLength : 0);
      const p1 = front + cars * SUBWAY.carLength;
      const kind = rng() < 0.55 ? 'metro' : 'freight';
      row.push({ lane, x: SUBWAY.lanes[lane], p0, front, p1, cars, ramp, kind, paint: Math.floor(rng() * 4) });
      end = Math.max(end, p1);
    });
    if (end > s + TRAINS_TO) break;
    blocks.push({ p0: p, p1: end, lanes });
    trains.push(...row);
    p = end + rand(rng, 10, 18);
  }
  const byChunk = new Map<number, Train[]>();
  const L = CFG.chunk.length;
  for (const t of trains) {
    for (let c = Math.floor(t.p0 / L); c <= Math.floor(t.p1 / L); c++) {
      let list = byChunk.get(c);
      if (!list) byChunk.set(c, (list = []));
      list.push(t);
    }
  }
  return { s, blocks, trains, byChunk };
}

/** Height of the roof or ramp of train t above the track at progress p (-1 off it). */
export function trainDeck(t: Train, x: number, p: number): number {
  if (p < t.p0 || p > t.p1 || Math.abs(x - t.x) > SUBWAY.trainWidth / 2) return -1;
  if (p >= t.front) return SUBWAY.trainHeight;
  return SUBWAY.trainHeight * ((p - t.p0) / SUBWAY.rampLength);
}
