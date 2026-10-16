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
    };

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
