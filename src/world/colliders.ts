import * as THREE from 'three';
import { CFG } from '../config';

/** Physical response parameters of a collider. */
export interface Surface {
  restitution: number; // 0..1
  friction: number; // tangential velocity kept = 1 - friction on impact
  soft?: boolean; // hedges: the player may push through slowly
}

export type Collider =
  | { kind: 'cylinder'; x: number; z: number; r: number; yTop: number; surface: Surface; blocksPlayer: boolean }
  | { kind: 'sphere'; x: number; y: number; z: number; r: number; surface: Surface; blocksPlayer: boolean }
  | {
      kind: 'capsule';
      ax: number; ay: number; az: number;
      bx: number; by: number; bz: number;
      r: number;
      surface: Surface;
      blocksPlayer: boolean;
    }
  /** Invisible vertical wall from (ax, az) to (bx, bz): stops only the player, never the apple. */
  | { kind: 'wall'; ax: number; az: number; bx: number; bz: number; surface: Surface; blocksPlayer: true }
  /** Axis-aligned box (the walls of the cabin): stops the apple and the player. */
  | {
      kind: 'box';
      minX: number; minY: number; minZ: number;
      maxX: number; maxY: number; maxZ: number;
      surface: Surface;
      blocksPlayer: true;
    }
  /**
   * The ramp in front of a train: a wedge across x from minX to maxX that rises
   * from y0 at progress pLow to y1 at pHigh. Its slope is ground (see
   * World.groundHeight); as a collider it is only its sides.
   */
  | {
      kind: 'ramp';
      minX: number; maxX: number;
      pLow: number; pHigh: number;
      y0: number; y1: number;
      surface: Surface;
      blocksPlayer: true;
    };

/** Height of the slope of a ramp at progress p. */
export function rampTop(col: Extract<Collider, { kind: 'ramp' }>, p: number): number {
  const t = (p - col.pLow) / (col.pHigh - col.pLow);
  return col.y0 + (col.y1 - col.y0) * (t < 0 ? 0 : t > 1 ? 1 : t);
}

export interface MudZone {
  x: number;
  z: number;
  rx: number;
  rz: number;
  angle: number;
  factor: number; // additional rolling resistance in m/s²
}

export const SURFACES = {
  wood: { restitution: 0.42, friction: 0.25 },
  stone: { restitution: 0.55, friction: 0.2 },
  bush: { restitution: 0.12, friction: 0.75, soft: true },
  trunk: { restitution: 0.4, friction: 0.3 },
  post: { restitution: 0.45, friction: 0.2 },
  fur: { restitution: 0.25, friction: 0.55 },
  metal: { restitution: 0.5, friction: 0.15 },
  snow: { restitution: 0.15, friction: 0.6 },
  ice: { restitution: 0.5, friction: 0.08 },
} as const satisfies Record<string, Surface>;

/** Result of a closest-point query against a collider. */
export interface Contact {
  nx: number;
  ny: number;
  nz: number;
  depth: number; // penetration depth (positive when overlapping)
  surface: Surface;
}

const tmp = new THREE.Vector3();

/**
 * Compute contact between a sphere (cx,cy,cz,radius) and a collider.
 * Returns null when there is no overlap.
 */
export function sphereContact(
  col: Collider,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  out: Contact,
): Contact | null {
  switch (col.kind) {
    case 'wall':
      return null;
    case 'cylinder': {
      if (cy - radius > col.yTop) return null;
      const dx = cx - col.x;
      const dz = cz - col.z;
      const dist = Math.hypot(dx, dz);
      const depth = col.r + radius - dist;
      if (depth <= 0) return null;
      if (dist < 1e-5) {
        out.nx = 1; out.nz = 0;
      } else {
        out.nx = dx / dist; out.nz = dz / dist;
      }
      out.ny = 0;
      out.depth = depth;
      out.surface = col.surface;
      return out;
    }
    case 'sphere': {
      const dx = cx - col.x;
      const dy = cy - col.y;
      const dz = cz - col.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const depth = col.r + radius - dist;
      if (depth <= 0) return null;
      if (dist < 1e-5) {
        out.nx = 0; out.ny = 1; out.nz = 0;
      } else {
        out.nx = dx / dist; out.ny = dy / dist; out.nz = dz / dist;
      }
      out.depth = depth;
      out.surface = col.surface;
      return out;
    }
    case 'ramp': {
      const top = rampTop(col, -cz);
      // On the slope: that is ground, not a collision.
      if (cy - radius > top - 0.03) return null;
      return boxContact(col.minX, col.y0 - 1, -col.pHigh, col.maxX, top, -col.pLow, cx, cy, cz, radius, col.surface, out);
    }
    case 'box':
      return boxContact(col.minX, col.minY, col.minZ, col.maxX, col.maxY, col.maxZ, cx, cy, cz, radius, col.surface, out);
    case 'capsule': {
      const abx = col.bx - col.ax;
      const aby = col.by - col.ay;
      const abz = col.bz - col.az;
      const apx = cx - col.ax;
      const apy = cy - col.ay;
      const apz = cz - col.az;
      const len2 = abx * abx + aby * aby + abz * abz;
      let t = len2 > 0 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      tmp.set(col.ax + abx * t, col.ay + aby * t, col.az + abz * t);
      const dx = cx - tmp.x;
      const dy = cy - tmp.y;
      const dz = cz - tmp.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const depth = col.r + radius - dist;
      if (depth <= 0) return null;
      if (dist < 1e-5) {
        out.nx = 0; out.ny = 1; out.nz = 0;
      } else {
        out.nx = dx / dist; out.ny = dy / dist; out.nz = dz / dist;
      }
      out.depth = depth;
      out.surface = col.surface;
      return out;
    }
  }
}

/** Contact between a sphere and an axis-aligned box. */
function boxContact(
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
  cx: number, cy: number, cz: number, radius: number,
  surface: Surface,
  out: Contact,
): Contact | null {
  const qx = Math.min(Math.max(cx, minX), maxX);
  const qy = Math.min(Math.max(cy, minY), maxY);
  const qz = Math.min(Math.max(cz, minZ), maxZ);
  const dx = cx - qx;
  const dy = cy - qy;
  const dz = cz - qz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > 1e-10) {
    if (d2 >= radius * radius) return null;
    const dist = Math.sqrt(d2);
    out.nx = dx / dist; out.ny = dy / dist; out.nz = dz / dist;
    out.depth = radius - dist;
  } else {
    // Centre inside: push out through the nearest face.
    const faces: Array<[number, number, number, number]> = [
      [cx - minX, -1, 0, 0], [maxX - cx, 1, 0, 0],
      [cy - minY, 0, -1, 0], [maxY - cy, 0, 1, 0],
      [cz - minZ, 0, 0, -1], [maxZ - cz, 0, 0, 1],
    ];
    let best = faces[0];
    for (const f of faces) if (f[0] < best[0]) best = f;
    out.nx = best[1]; out.ny = best[2]; out.nz = best[3];
    out.depth = best[0] + radius;
  }
  out.surface = surface;
  return out;
}

/**
 * Colliders are stored per chunk so that queries only touch the few chunks
 * around a position.
 */
export class ColliderStore {
  private readonly chunks = new Map<number, Collider[]>();
  private readonly mud = new Map<number, MudZone[]>();

  add(chunk: number, c: Collider): void {
    let list = this.chunks.get(chunk);
    if (!list) {
      list = [];
      this.chunks.set(chunk, list);
    }
    list.push(c);
  }

  addMud(chunk: number, m: MudZone): void {
    let list = this.mud.get(chunk);
    if (!list) {
      list = [];
      this.mud.set(chunk, list);
    }
    list.push(m);
  }

  /** Remove one collider again (e.g. an icicle that melts away). */
  remove(chunk: number, c: Collider): void {
    const list = this.chunks.get(chunk);
    const k = list ? list.indexOf(c) : -1;
    if (list && k >= 0) list.splice(k, 1);
  }

  removeChunk(chunk: number): void {
    this.chunks.delete(chunk);
    this.mud.delete(chunk);
  }

  clear(): void {
    this.chunks.clear();
    this.mud.clear();
  }

  /** Iterate over the colliders of the chunks around z (±1 chunk). */
  forEachNear(z: number, cb: (c: Collider) => void): void {
    const i = Math.floor(-z / CFG.chunk.length);
    for (let k = i - 1; k <= i + 1; k++) {
      const list = this.chunks.get(k);
      if (!list) continue;
      for (let j = 0; j < list.length; j++) cb(list[j]);
    }
  }

  /** Extra rolling resistance from puddles / mud at a position. */
  mudAt(x: number, z: number): number {
    const i = Math.floor(-z / CFG.chunk.length);
    let total = 0;
    for (let k = i - 1; k <= i + 1; k++) {
      const list = this.mud.get(k);
      if (!list) continue;
      for (const m of list) {
        const dx = x - m.x;
        const dz = z - m.z;
        const c = Math.cos(m.angle);
        const s = Math.sin(m.angle);
        const lx = (dx * c + dz * s) / m.rx;
        const lz = (-dx * s + dz * c) / m.rz;
        if (lx * lx + lz * lz < 1) total += m.factor;
      }
    }
    return total;
  }
}
