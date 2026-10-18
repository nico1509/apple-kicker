import * as THREE from 'three';
import { CFG } from '../config';
import { clamp, smoothstep } from '../utils/math';

/**
 * Landscapes change every LANDSCAPE_LENGTH metres along the path. In the
 * endless mode they loop: after the last one the first one (the autumn forest)
 * comes back. In the story mode every one comes once, then the snowy home
 * stretch with the hut at the end of the path.
 */
export type Landscape = 'forest' | 'greece' | 'desert' | 'antarctic' | 'subway' | 'town' | 'home';

export const LANDSCAPE_LENGTH = 1000;
export const LANDSCAPES: readonly Landscape[] = ['forest', 'greece', 'desert', 'antarctic', 'subway', 'town'];
/** Start of the home stretch in the story mode. */
export const HOME_START = LANDSCAPES.length * LANDSCAPE_LENGTH;
/** Story mode: the path ends this far into the home stretch, at the door of the hut. */
export const HUT_PROGRESS = HOME_START + 60;

let story = false;

/** Choose the mode before a world is built: the story ends at the hut, the endless mode loops. */
export function setStoryMode(on: boolean): void {
  story = on;
}

export function storyMode(): boolean {
  return story;
}

/**
 * Progress the warm-up ramps (obstacle density, hills, forest obstacle kinds)
 * look at. The endless mode skips the warm-up: it starts where the second
 * round of landscapes used to start.
 */
export function rampProgress(p: number): number {
  return story ? p : p + HOME_START;
}

/** Endless mode: 0 at the start, rising to 1 over CFG.endless.rampLength; always 0 in the story. */
export function endlessHardening(p: number): number {
  return story ? 0 : clamp(p / CFG.endless.rampLength, 0, 1);
}
/** Half width (m) of the cross-fade of colours, light and backdrop at a landscape border. */
const BLEND = 40;

export interface LandscapeMix {
  a: Landscape;
  b: Landscape;
  t: number; // 0 → a, 1 → b
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

export function landscapeOfIndex(k: number): Landscape {
  if (story && k >= LANDSCAPES.length) return 'home';
  return LANDSCAPES[mod(k, LANDSCAPES.length)];
}

/** Landscape at progress p (hard border, used for everything that is placed discretely). */
export function landscapeAt(p: number): Landscape {
  return landscapeOfIndex(Math.floor(Math.max(0, p) / LANDSCAPE_LENGTH));
}

/** Blend between neighbouring landscapes over ±BLEND metres around every border. */
export function landscapeMix(p: number, out: LandscapeMix = { a: 'forest', b: 'forest', t: 1 }): LandscapeMix {
  const k = Math.floor(Math.max(0, p) / LANDSCAPE_LENGTH);
  const local = Math.max(0, p) - k * LANDSCAPE_LENGTH;
  if (k > 0 && local < BLEND) {
    out.a = landscapeOfIndex(k - 1);
    out.b = landscapeOfIndex(k);
    out.t = smoothstep(-BLEND, BLEND, local);
  } else if (local > LANDSCAPE_LENGTH - BLEND) {
    out.a = landscapeOfIndex(k);
    out.b = landscapeOfIndex(k + 1);
    out.t = smoothstep(-BLEND, BLEND, local - LANDSCAPE_LENGTH);
  } else {
    out.a = out.b = landscapeOfIndex(k);
    out.t = 1;
  }
  return out;
}

/** How much of landscape `which` is present at p (0..1). */
export function landscapeWeight(p: number, which: Landscape): number {
  const m = landscapeMix(p, scratch);
  return (m.a === which ? 1 - m.t : 0) + (m.b === which ? m.t : 0);
}
const scratch: LandscapeMix = { a: 'forest', b: 'forest', t: 1 };

/** Clear-weather light and sky colours of a landscape. */
export interface Atmosphere {
  horizon: THREE.Color;
  top: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  sun: THREE.Color;
  sunIntensity: number;
  fogNear: number;
  fogFar: number;
  cirrus: number; // 0..1 amount of high cirrus streaks in the sky
  clouds: number; // 0..1 share of the cumulus clouds that are shown
}

export const ATMOSPHERES: Record<Landscape, Atmosphere> = {
  // A clear October day.
  forest: {
    horizon: new THREE.Color(0xd3e4f3),
    top: new THREE.Color(0x4f8fd6),
    hemiSky: new THREE.Color(0xcfe3ff),
    hemiGround: new THREE.Color(0x6b6a3a),
    sun: new THREE.Color(0xfff1d6),
    sunIntensity: 2.9,
    fogNear: CFG.render.fogNear,
    fogFar: CFG.render.fogFar,
    cirrus: 1,
    clouds: 1,
  },
  // Late summer in rural Greece: deep blue sky, dry clear air, warm light.
  greece: {
    horizon: new THREE.Color(0xc4dcf2),
    top: new THREE.Color(0x2f78d8),
    hemiSky: new THREE.Color(0xd6e6ff),
    hemiGround: new THREE.Color(0x8a7a4a),
    sun: new THREE.Color(0xfff0d0),
    sunIntensity: 3.2,
    fogNear: 90,
    fogFar: 290,
    cirrus: 0.3,
    clouds: 0.7,
  },
  // The Egyptian desert: hot, dusty air and a pale horizon.
  desert: {
    horizon: new THREE.Color(0xe4dccb),
    top: new THREE.Color(0x4a8bd4),
    hemiSky: new THREE.Color(0xe2e6f0),
    hemiGround: new THREE.Color(0xb08a50),
    sun: new THREE.Color(0xfff0c8),
    sunIntensity: 3.3,
    fogNear: 80,
    fogFar: 310,
    cirrus: 0.15,
    clouds: 0.25,
  },
  // An Antarctic summer day: pale blue sky, crisp air, white light off the snow.
  antarctic: {
    horizon: new THREE.Color(0xcfe0ee),
    top: new THREE.Color(0x4389cc),
    hemiSky: new THREE.Color(0xd2e4f6),
    hemiGround: new THREE.Color(0x8c9fb6),
    sun: new THREE.Color(0xfff8ee),
    sunIntensity: 2.7,
    fogNear: 140,
    fogFar: 420,
    cirrus: 0.35,
    clouds: 0.3,
  },
  // The railway cutting on a bright autumn afternoon, as in the arcade game.
  subway: {
    horizon: new THREE.Color(0xcfe4f4),
    top: new THREE.Color(0x3f8fe0),
    hemiSky: new THREE.Color(0xd8e6ff),
    hemiGround: new THREE.Color(0x8a6a5a),
    sun: new THREE.Color(0xfff0dc),
    sunIntensity: 3.0,
    fogNear: 90,
    fogFar: 300,
    cirrus: 0.4,
    clouds: 0.5,
  },
  // A small town in winter without snow: an overcast grey sky and flat, cold light.
  town: {
    horizon: new THREE.Color(0xc3c8cd),
    top: new THREE.Color(0x8794a3),
    hemiSky: new THREE.Color(0xc9ced5),
    hemiGround: new THREE.Color(0x5f5b4f),
    sun: new THREE.Color(0xe6e8ee),
    sunIntensity: 1.7,
    fogNear: 60,
    fogFar: 250,
    cirrus: 0,
    clouds: 1,
  },
  // Home: a snowy forest on a winter afternoon, the sun already low and warm.
  home: {
    horizon: new THREE.Color(0xdcd2d8),
    top: new THREE.Color(0x5d78a8),
    hemiSky: new THREE.Color(0xc2cde2),
    hemiGround: new THREE.Color(0x7f8ca4),
    sun: new THREE.Color(0xffd6b0),
    sunIntensity: 2.0,
    fogNear: 60,
    fogFar: 240,
    cirrus: 0.25,
    clouds: 0.45,
  },
};

/** Writes the blended atmosphere at progress p into `out`. */
export function atmosphereAt(p: number, out: Atmosphere): Atmosphere {
  const m = landscapeMix(p, scratch);
  const A = ATMOSPHERES[m.a];
  const B = ATMOSPHERES[m.b];
  const t = m.t;
  out.horizon.copy(A.horizon).lerp(B.horizon, t);
  out.top.copy(A.top).lerp(B.top, t);
  out.hemiSky.copy(A.hemiSky).lerp(B.hemiSky, t);
  out.hemiGround.copy(A.hemiGround).lerp(B.hemiGround, t);
  out.sun.copy(A.sun).lerp(B.sun, t);
  out.sunIntensity = A.sunIntensity + (B.sunIntensity - A.sunIntensity) * t;
  out.fogNear = A.fogNear + (B.fogNear - A.fogNear) * t;
  out.fogFar = A.fogFar + (B.fogFar - A.fogFar) * t;
  out.cirrus = A.cirrus + (B.cirrus - A.cirrus) * t;
  out.clouds = A.clouds + (B.clouds - A.clouds) * t;
  return out;
}

export function createAtmosphere(): Atmosphere {
  const f = ATMOSPHERES.forest;
  return {
    horizon: f.horizon.clone(),
    top: f.top.clone(),
    hemiSky: f.hemiSky.clone(),
    hemiGround: f.hemiGround.clone(),
    sun: f.sun.clone(),
    sunIntensity: f.sunIntensity,
    fogNear: f.fogNear,
    fogFar: f.fogFar,
    cirrus: f.cirrus,
    clouds: f.clouds,
  };
}
