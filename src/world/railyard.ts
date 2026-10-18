import * as THREE from 'three';
import { mulberry32, rand, subSeed, type Rng } from '../utils/noise';
import { SURFACES, type Collider, type ColliderStore } from './colliders';
import { LANDSCAPE_LENGTH } from './landscape';
import { SUBWAY, subwayCut, subwayStart, subwayWallHalf, type Train } from './subway';
import { Terrain } from './terrain';

/** Lavender and white metro cars, coloured freight wagons, blue ramps: the look of the arcade game. */
const METRO_BODY = [0xe6e0f0, 0xd8d4e8, 0xf0ece6, 0xc9cde6].map((h) => new THREE.Color(h));
const METRO_STRIPE = [0x5b3f9e, 0x2f5fb8, 0x7a3a8e, 0x3c4a9a].map((h) => new THREE.Color(h));
const FREIGHT = [0x3f5fc0, 0x3d8a4a, 0xb8442e, 0x6a4aa8].map((h) => new THREE.Color(h));
const HOUSE = [0x8a6ab8, 0x5f9a7a, 0x6a7ec8, 0xd88a4a, 0x9a5a8a, 0x7aa0b8].map((h) => new THREE.Color(h));
const C = {
  sleeper: new THREE.Color(0x5a4450),
  rail: new THREE.Color(0xc4bccc),
  railFoot: new THREE.Color(0x6a5a62),
  wall: new THREE.Color(0x8f86a6),
  wallTop: new THREE.Color(0xb4aac8),
  wallDark: new THREE.Color(0x6f6688),
  gantry: new THREE.Color(0x4a3a7a),
  wire: new THREE.Color(0x2c2438),
  under: new THREE.Color(0x3a3440),
  wheel: new THREE.Color(0x262228),
  glass: new THREE.Color(0x3a5fa8),
  glassDark: new THREE.Color(0x24345e),
  light: new THREE.Color(0xfff2b0),
  leaves: new THREE.Color(0xe0682a),
  leavesDark: new THREE.Color(0xc04a22),
  ramp: new THREE.Color(0x5a6ad0),
  rampDark: new THREE.Color(0x40489a),
  rampStripe: new THREE.Color(0xf0c838),
  roof: new THREE.Color(0x6a4a5a),
  door: new THREE.Color(0x5a3a2a),
  window: new THREE.Color(0xf4e6b0),
  trunk: new THREE.Color(0x5a3e2c),
  canopy: [0xe0702a, 0xd25424, 0xf09a30, 0xc8402a].map((h) => new THREE.Color(h)),
  graffiti: [0xe04a8a, 0x40c0e0, 0xf0c030, 0x60d060, 0xf07030].map((h) => new THREE.Color(h)),
};

/** Collects coloured, flat-shaded boxes and wedges into one geometry. */
class Builder {
  /** Colliders of the chunk, added to the store once it is complete. */
  readonly colliders: Collider[] = [];
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  private static readonly unit = (() => {
    const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    return Array.from(g.getAttribute('position').array as Float32Array);
  })();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly t = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  /** A box centred on (x, y, z), turned by yaw about Y and then pitched by `pitch` about X. */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: THREE.Color, yaw = 0, pitch = 0): void {
    this.e.set(pitch, yaw, 0, 'YXZ');
    this.m.compose(this.t.set(x, y, z), this.q.setFromEuler(this.e), this.s.set(sx, sy, sz));
    const u = Builder.unit;
    const m = this.m.elements;
    const { pos, col } = this;
    const { r, g, b } = color;
    for (let k = 0; k < u.length; k += 3) {
      const ux = u[k], uy = u[k + 1], uz = u[k + 2];
      pos.push(m[0] * ux + m[4] * uy + m[8] * uz + m[12], m[1] * ux + m[5] * uy + m[9] * uz + m[13], m[2] * ux + m[6] * uy + m[10] * uz + m[14]);
      col.push(r, g, b);
    }
  }

  /** A triangle (counter-clockwise seen from its front). */
  tri(a: number[], b: number[], c: number[], color: THREE.Color): void {
    this.pos.push(...a, ...b, ...c);
    for (let k = 0; k < 3; k++) this.col.push(color.r, color.g, color.b);
  }

  quad(a: number[], b: number[], c: number[], d: number[], color: THREE.Color): void {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Builds what stands in the subway: tracks, walls, overhead wires, the trains
 * and their ramps, and houses on the rim of the cutting. Each chunk is one
 * merged mesh. The trains and walls also get their colliders here.
 */
export class Railyard {
  private readonly mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private readonly col = new THREE.Color();

  constructor(
    private readonly terrain: Terrain,
    private readonly colliders: ColliderStore,
  ) {}

  dispose(): void {
    this.mat.dispose();
  }

  static disposeGroup(group: THREE.Group): void {
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }

  /** Builds chunk i in a few steps (see World); null outside the subway. */
  *buildChunkGen(i: number): Generator<void, THREE.Group | null> {
    const { p0, p1 } = Terrain.chunkRange(i);
    const s = subwayStart(p0) ?? subwayStart(p1);
    if (s === null) return null;
    const b = new Builder();
    const rng = mulberry32(subSeed(this.terrain.seed, 15500 + i));
    this.addTracks(b, s, p0, p1);
    yield;
    this.addWalls(b, p0, p1, rng);
    this.addGantries(b, s, p0, p1);
    yield;
    const sec = this.terrain.subwayAt((p0 + p1) / 2);
    for (const t of sec?.byChunk.get(i) ?? []) this.addTrain(b, t, p0, p1);
    yield;
    this.addHouses(b, p0, p1, rng);
    for (const c of b.colliders) this.colliders.add(i, c);
    if (b.empty) return null;
    const group = new THREE.Group();
    group.name = `railyard-${i}`;
    const mesh = new THREE.Mesh(b.geometry(), this.mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return group;
  }

  private h(p: number): number {
    return this.terrain.pathHeight(p);
  }

  private addTracks(b: Builder, s: number, p0: number, p1: number): void {
    const a = Math.max(p0, s + 8);
    const e = Math.min(p1, s + LANDSCAPE_LENGTH - 8);
    if (a >= e) return;
    for (const x of SUBWAY.lanes) {
      for (let p = Math.ceil(a / 0.75) * 0.75; p < e; p += 0.75) b.box(x, this.h(p) + 0.05, -p, 2.5, 0.12, 0.26, C.sleeper);
      // Rails in short pieces that follow the gradient.
      for (let p = a; p < e; p += 4) {
        const q = Math.min(e, p + 4);
        const pitch = Math.atan2(this.h(q) - this.h(p), q - p);
        const y = (this.h(p) + this.h(q)) / 2;
        for (const side of [-1, 1]) {
          b.box(x + side * SUBWAY.gauge, y + 0.17, -(p + q) / 2, 0.07, 0.12, q - p, C.rail, 0, pitch);
          b.box(x + side * SUBWAY.gauge, y + 0.11, -(p + q) / 2, 0.16, 0.04, q - p, C.railFoot, 0, pitch);
        }
      }
    }
  }

  /** The concrete walls of the cutting, in pieces of 2 m, with a funnel at each open end. */
  private addWalls(b: Builder, p0: number, p1: number, rng: Rng): void {
    const step = 2;
    for (let p = p0; p < p1 - 1e-6; p += step) {
      const q = p + step;
      const ha = subwayWallHalf(p);
      const hb = subwayWallHalf(q);
      if (ha === Infinity || hb === Infinity) continue;
      const ya = this.h(p);
      const yb = this.h(q);
      const ylo = Math.min(ya, yb) - 0.6;
      const ta = ya + subwayCut(p) + 0.9;
      const tb = yb + subwayCut(q) + 0.9;
      const T = SUBWAY.wallThick;
      for (const side of [-1, 1]) {
        const ia = side * ha;
        const ib = side * hb;
        const oa = side * (ha + T);
        const ob = side * (hb + T);
        const za = -p;
        const zb = -q;
        // Faces wound towards the track (side −1) or mirrored (side +1).
        const quad = (v: number[][], c: THREE.Color): void => (side < 0 ? b.quad(v[0], v[1], v[2], v[3], c) : b.quad(v[0], v[3], v[2], v[1], c));
        quad([[ia, ya - 0.6, za], [ib, yb - 0.6, zb], [ib, tb, zb], [ia, ta, za]], C.wall);
        quad([[oa, ta, za], [ia, ta, za], [ib, tb, zb], [ob, tb, zb]], C.wallTop);
        quad([[oa, ta, za], [ob, tb, zb], [ob, yb - 0.6, zb], [oa, ya - 0.6, za]], C.wallDark);
        // Caps at the open ends.
        if (subwayWallHalf(p - 0.01) === Infinity) quad([[oa, ya - 0.6, za], [ia, ya - 0.6, za], [ia, ta, za], [oa, ta, za]], C.wall);
        if (subwayWallHalf(q + 0.01) === Infinity) quad([[ib, yb - 0.6, zb], [ob, yb - 0.6, zb], [ob, tb, zb], [ib, tb, zb]], C.wall);
        const yaw = Math.atan2(ib - ia, step);
        const cx = (ia + ib) / 2 + side * T / 2;
        const cz = (za + zb) / 2;
        // Now and then some colourful graffiti.
        if (ha === SUBWAY.wall && rng() < 0.18) {
          const g = C.graffiti[Math.floor(rng() * C.graffiti.length)];
          const gh = rand(rng, 0.6, 1.5);
          b.box(cx - side * (T / 2 + 0.01), Math.min(ya, yb) + 0.8 + gh / 2, cz, 0.02, gh, step * rand(rng, 0.5, 1), g, yaw);
        }
        // Colliders: tall boxes so that a chipped apple cannot fly out of the cutting.
        const inner = Math.min(ha, hb);
        const outer = Math.max(ha, hb) + T;
        b.colliders.push({
          kind: 'box',
          minX: side < 0 ? -outer : inner,
          maxX: side < 0 ? -inner : outer,
          minY: ylo,
          maxY: ylo + 60,
          minZ: -q,
          maxZ: -p,
          surface: SURFACES.stone,
          blocksPlayer: true,
        });
      }
    }
  }

  /** Portal frames over the tracks every 40 m, carrying the overhead wires. */
  private addGantries(b: Builder, s: number, p0: number, p1: number): void {
    const H = 7.2;
    for (let n = Math.ceil((p0 - s) / 40); s + n * 40 < p1; n++) {
      const p = s + n * 40;
      if (subwayWallHalf(p) !== SUBWAY.wall) continue;
      const y = this.h(p);
      const X = SUBWAY.wall + SUBWAY.wallThick / 2;
      for (const side of [-1, 1]) b.box(side * X, y + H / 2, -p, 0.3, H, 0.3, C.gantry);
      b.box(0, y + H, -p, 2 * X + 0.3, 0.3, 0.3, C.gantry);
      b.box(0, y + H - 0.5, -p, 2 * X - 0.4, 0.12, 0.12, C.gantry);
      for (const x of SUBWAY.lanes) b.box(x, y + H - 0.85, -p, 0.05, 0.7, 0.05, C.wire);
    }
    // The contact wires run on through the chunk.
    const a = Math.max(p0, s + 60);
    const e = Math.min(p1, s + LANDSCAPE_LENGTH - 60);
    if (a >= e) return;
    const pitch = Math.atan2(this.h(e) - this.h(a), e - a);
    const y = (this.h(a) + this.h(e)) / 2 + H - 1.2;
    for (const x of SUBWAY.lanes) b.box(x, y, -(a + e) / 2, 0.04, 0.04, e - a, C.wire, 0, pitch);
  }

  /** The parts of train t whose cars (or ramp) have their middle in this chunk. */
  private addTrain(b: Builder, t: Train, p0: number, p1: number): void {
    const W = SUBWAY.trainWidth;
    const H = SUBWAY.trainHeight;
    const L = SUBWAY.carLength;
    if (t.ramp) {
      const mid = (t.p0 + t.front) / 2;
      if (mid >= p0 && mid < p1) this.addRamp(b, t);
    }
    for (let k = 0; k < t.cars; k++) {
      const a = t.front + k * L;
      const e = a + L;
      const mid = (a + e) / 2;
      if (mid < p0 || mid >= p1) continue;
      const y = this.h(mid);
      const pitch = Math.atan2(this.h(e) - this.h(a), L);
      const len = L - 0.5;
      const z = -mid;
      // Bogies and wheels.
      b.box(t.x, y + 0.45, z, W - 0.5, 0.4, len - 1, C.under, 0, pitch);
      for (const o of [-len / 2 + 2, len / 2 - 2]) {
        for (const side of [-1, 1]) b.box(t.x + side * 0.72, y + 0.42, z + o, 0.14, 0.62, 1.8, C.wheel, 0, pitch);
      }
      if (t.kind === 'metro') this.addMetroCar(b, t, k, y, z, len, pitch);
      else this.addFreightCar(b, t, y, z, len, pitch);
      b.colliders.push({
        kind: 'box',
        minX: t.x - W / 2,
        maxX: t.x + W / 2,
        minY: Math.min(this.h(a), this.h(e)) - 0.5,
        // Just under the roof, so an apple rolling along the roof never touches it.
        maxY: Math.min(this.h(a), this.h(e)) + H - 0.05,
        minZ: -e,
        maxZ: -a,
        surface: SURFACES.metal,
        blocksPlayer: true,
      });
    }
  }

  private addMetroCar(b: Builder, t: Train, k: number, y: number, z: number, len: number, pitch: number): void {
    const W = SUBWAY.trainWidth;
    const H = SUBWAY.trainHeight;
    const body = METRO_BODY[t.paint];
    const stripe = METRO_STRIPE[t.paint];
    b.box(t.x, y + (0.7 + H - 0.12) / 2, z, W, H - 0.12 - 0.7, len, body, 0, pitch);
    b.box(t.x, y + H - 0.06, z, W - 0.25, 0.12, len - 0.3, body, 0, pitch);
    for (const side of [-1, 1]) {
      const sx = t.x + side * (W / 2 + 0.01);
      b.box(sx, y + 0.95, z, 0.02, 0.35, len, stripe, 0, pitch);
      b.box(sx, y + 2.15, z, 0.02, 0.8, len - 1.2, C.glassDark, 0, pitch);
      // Doors.
      for (const o of [-len / 4, len / 4]) b.box(sx + side * 0.005, y + 1.75, z + o, 0.02, 1.9, 1.3, stripe, 0, pitch);
    }
    if (k > 0) return;
    // The front of the first car faces the player: a big blue windscreen and two lights.
    const fz = z + (SUBWAY.carLength - 0.5) / 2 + 0.01;
    b.box(t.x, y + 2.1, fz, W - 0.5, 1.1, 0.04, C.glass);
    b.box(t.x, y + 1.0, fz, W, 0.45, 0.04, stripe);
    for (const side of [-1, 1]) b.box(t.x + side * (W / 2 - 0.35), y + 1.35, fz + 0.01, 0.35, 0.2, 0.04, C.light);
  }

  private addFreightCar(b: Builder, t: Train, y: number, z: number, len: number, pitch: number): void {
    const W = SUBWAY.trainWidth;
    const H = SUBWAY.trainHeight;
    const paint = FREIGHT[t.paint];
    this.col.copy(paint).multiplyScalar(0.75);
    b.box(t.x, y + (0.75 + H) / 2, z, W, H - 0.75, len, paint, 0, pitch);
    // Ribs on the sides and the ends.
    for (let o = -len / 2 + 0.4; o <= len / 2 - 0.3; o += 1.6) {
      for (const side of [-1, 1]) b.box(t.x + side * (W / 2 + 0.04), y + (0.75 + H) / 2, z + o, 0.08, H - 0.75, 0.16, this.col, 0, pitch);
    }
    b.box(t.x, y + H - 0.05, z, W + 0.1, 0.12, len + 0.05, this.col, 0, pitch);
    // Filled to the brim with autumn leaves (the roof that can be walked on).
    b.box(t.x, y + H + 0.01, z, W - 0.25, 0.04, len - 0.25, C.leaves, 0, pitch);
    for (let o = -len / 2 + 1; o < len / 2 - 0.5; o += 1.7) b.box(t.x + (o % 2) * 0.3, y + H + 0.05, z + o, 1.2, 0.1, 0.8, C.leavesDark, 0.6, pitch);
  }

  /** The ramp in front of a train: a blue wedge with yellow stripes, rising to the roof. */
  private addRamp(b: Builder, t: Train): void {
    const W = SUBWAY.trainWidth;
    const H = SUBWAY.trainHeight;
    const xa = t.x - W / 2;
    const xb = t.x + W / 2;
    const za = -t.p0;
    const zb = -t.front;
    const ya = this.h(t.p0) + 0.02;
    const yg = this.h(t.front);
    const yb = yg + H;
    // Slope, sides and back.
    b.quad([xa, ya, za], [xb, ya, za], [xb, yb, zb], [xa, yb, zb], C.ramp);
    b.tri([xa, ya, za], [xa, yb, zb], [xa, yg, zb], C.rampDark);
    b.tri([xb, ya, za], [xb, yg, zb], [xb, yb, zb], C.rampDark);
    b.quad([xa, yg, zb], [xa, yb, zb], [xb, yb, zb], [xb, yg, zb], C.rampDark);
    // Stripes across the slope.
    const pitch = Math.atan2(yb - ya, SUBWAY.rampLength);
    for (let u = 0.08; u < 0.95; u += 0.12) {
      const zz = za + (zb - za) * u;
      const yy = ya + (yb - ya) * u + 0.012;
      b.box(t.x, yy, zz, W - 0.3, 0.02, 0.22, C.rampStripe, 0, pitch);
    }
    // Edge rails on the slope.
    for (const side of [-1, 1]) {
      b.box(t.x + side * (W / 2 - 0.06), (ya + yb) / 2 + 0.06, (za + zb) / 2, 0.12, 0.12, Math.hypot(SUBWAY.rampLength, H), C.rampDark, 0, pitch);
    }
    b.colliders.push({
      kind: 'ramp',
      minX: xa,
      maxX: xb,
      pLow: t.p0,
      pHigh: t.front,
      y0: this.h(t.p0),
      y1: yb,
      surface: SURFACES.metal,
      blocksPlayer: true,
    });
  }

  /** Colourful houses and autumn trees up on the rim of the cutting. */
  private addHouses(b: Builder, p0: number, p1: number, rng: Rng): void {
    for (const side of [-1, 1]) {
      let p = p0 + rand(rng, 0, 6);
      while (p < p1 - 4) {
        const pm = p + 5;
        if (subwayCut(pm) < SUBWAY.cut * 0.9) {
          p += 10;
          continue;
        }
        if (rng() < 0.65) {
          const w = rand(rng, 6, 9);
          const d = rand(rng, 6, 8);
          const x = side * (SUBWAY.wall + 2.8 + d / 2 + rand(rng, 0, 2));
          const z = -(p + w / 2);
          const y = this.terrain.groundHeight(x, z) - 0.3;
          this.addHouse(b, x, y, z, d, w, side, rng);
          b.colliders.push({ kind: 'box', minX: x - d / 2, maxX: x + d / 2, minY: y, maxY: y + 6, minZ: z - w / 2, maxZ: z + w / 2, surface: SURFACES.wood, blocksPlayer: true });
          p += w + rand(rng, 2, 5);
        } else {
          // An autumn tree.
          const x = side * rand(rng, SUBWAY.wall + 2.5, SUBWAY.wall + 9);
          const z = -(p + 2);
          const y = this.terrain.groundHeight(x, z) - 0.1;
          const th = rand(rng, 2.2, 3.4);
          b.box(x, y + th / 2, z, 0.3, th, 0.3, C.trunk);
          const c = C.canopy[Math.floor(rng() * C.canopy.length)];
          for (let k = 0; k < 3; k++) {
            const r = rand(rng, 1.4, 2.1);
            b.box(x + rand(rng, -0.7, 0.7), y + th + r * 0.5 + k * 0.4, z + rand(rng, -0.7, 0.7), r * 1.6, r * 1.3, r * 1.6, c, rng() * 6);
          }
          p += rand(rng, 4, 7);
        }
      }
    }
  }

  private addHouse(b: Builder, x: number, y: number, z: number, d: number, w: number, side: number, rng: Rng): void {
    const floors = rng() < 0.5 ? 2 : 3;
    const H = floors * 2.6;
    const paint = HOUSE[Math.floor(rng() * HOUSE.length)];
    b.box(x, y + H / 2, z, d, H, w, paint);
    // A gable roof along the track.
    const r = 2.2;
    const xa = x - d / 2 - 0.3;
    const xb = x + d / 2 + 0.3;
    const za = z + w / 2 + 0.3;
    const zb = z - w / 2 - 0.3;
    const yr = y + H;
    b.quad([xa, yr, za], [x, yr + r, za], [x, yr + r, zb], [xa, yr, zb], C.roof);
    b.quad([x, yr + r, za], [xb, yr, za], [xb, yr, zb], [x, yr + r, zb], C.roof);
    b.tri([xa, yr, za], [xb, yr, za], [x, yr + r, za], paint);
    b.tri([xb, yr, zb], [xa, yr, zb], [x, yr + r, zb], paint);
    // Windows facing the track.
    const fx = x - side * (d / 2 + 0.01);
    for (let f = 0; f < floors; f++) {
      for (let o = -w / 2 + 1.2; o < w / 2 - 0.8; o += 1.8) b.box(fx, y + 1.4 + f * 2.6, z + o, 0.04, 1.0, 0.8, C.window);
    }
  }
}

