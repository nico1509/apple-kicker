import * as THREE from 'three';
import { CFG } from '../config';
import { smoothstep } from '../utils/math';
import { fbm2, hash3, mulberry32, rand, subSeed, type Rng } from '../utils/noise';
import { ColliderStore, SURFACES } from './colliders';
import { Terrain, type BiomeType, type Side } from './terrain';

/** Collects instance transforms and colours, then bakes them into an InstancedMesh. */
class Batch {
  readonly matrices: number[] = [];
  readonly colors: number[] = [];
  count = 0;
  constructor(
    readonly geometry: THREE.BufferGeometry,
    readonly material: THREE.Material,
    readonly castShadow: boolean,
    readonly receiveShadow: boolean,
  ) {}

  add(m: THREE.Matrix4, c: THREE.Color): void {
    for (let i = 0; i < 16; i++) this.matrices.push(m.elements[i]);
    this.colors.push(c.r, c.g, c.b);
    this.count++;
  }

  build(): THREE.InstancedMesh | null {
    if (this.count === 0) return null;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, this.count);
    (mesh.instanceMatrix.array as Float32Array).set(this.matrices);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.colors), 3);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = this.castShadow;
    mesh.receiveShadow = this.receiveShadow;
    mesh.frustumCulled = true;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

const C = (hex: number): THREE.Color => new THREE.Color(hex);

const CANOPY_COLORS = {
  green: [C(0x4f7f2a), C(0x5b8c31), C(0x467526)],
  yellowGreen: [C(0x8aa83a), C(0x9db43f), C(0x7fa035)],
  gold: [C(0xd2a53a), C(0xc99a2e), C(0xdcb44a)],
  orange: [C(0xc8762a), C(0xd4863a), C(0xb8661f)],
  rust: [C(0xa0542a), C(0x92492a)],
  fir: [C(0x2f5a2a), C(0x365f2f), C(0x2a5027)],
  bush: [C(0x3d6b2a), C(0x4a7a30), C(0x5c7f2d), C(0x6e6a2a)],
  vine: [C(0x8fae3c), C(0xa9b53d), C(0xc9b83a), C(0x9fb545)],
  leaf: [C(0xd6872a), C(0xe0a030), C(0xb85a24), C(0x8f5a2c), C(0xd9b13c)],
  tuft: [C(0x7ea63f), C(0x9db54a), C(0xc2b25a), C(0x6c9a37)],
  far: [C(0x35612c), C(0x2f5629), C(0x4a7532), C(0x6f8a2e), C(0x9a7a2e)],
};
const TRUNK_COLORS = [C(0x6b4d33), C(0x7a5a3c), C(0x5a4330)];
const POST_COLOR = C(0x8a7a62);
const RAIL_COLOR = C(0x9c8a6b);

export class Decor {
  private readonly flatMat = new THREE.MeshLambertMaterial({ flatShading: true });
  private readonly leafMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  private readonly tuftMat = new THREE.MeshLambertMaterial({ flatShading: true, side: THREE.DoubleSide });

  private readonly trunkGeo: THREE.BufferGeometry;
  private readonly canopyGeo: THREE.BufferGeometry;
  private readonly coneGeo: THREE.BufferGeometry;
  private readonly bushGeo: THREE.BufferGeometry;
  private readonly boxGeo: THREE.BufferGeometry;
  private readonly leafGeo: THREE.BufferGeometry;
  private readonly tuftGeo: THREE.BufferGeometry;
  private readonly farConeGeo: THREE.BufferGeometry;
  private readonly farBlobGeo: THREE.BufferGeometry;

  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly col = new THREE.Color();
  private readonly euler = new THREE.Euler();

  constructor(
    private readonly terrain: Terrain,
    private readonly colliders: ColliderStore,
  ) {
    this.trunkGeo = new THREE.CylinderGeometry(0.72, 1, 1, 6).translate(0, 0.5, 0);
    this.canopyGeo = new THREE.IcosahedronGeometry(1, 1);
    this.coneGeo = new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0);
    this.bushGeo = new THREE.IcosahedronGeometry(1, 1);
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.leafGeo = new THREE.CircleGeometry(1, 5).rotateX(-Math.PI / 2);
    this.tuftGeo = new THREE.ConeGeometry(1, 1, 3).translate(0, 0.5, 0);
    this.farConeGeo = new THREE.ConeGeometry(1, 1, 5).translate(0, 0.5, 0);
    this.farBlobGeo = new THREE.IcosahedronGeometry(1, 0); // 20 triangles for the fogged distance
  }

  dispose(): void {
    for (const g of [
      this.trunkGeo, this.canopyGeo, this.coneGeo, this.bushGeo,
      this.boxGeo, this.leafGeo, this.tuftGeo, this.farConeGeo, this.farBlobGeo,
    ]) g.dispose();
    this.flatMat.dispose();
    this.leafMat.dispose();
    this.tuftMat.dispose();
  }

  // ---------------------------------------------------------------------------

  private place(
    batch: Batch,
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
    yaw: number,
    color: THREE.Color,
    tiltX = 0, tiltZ = 0,
  ): void {
    this.pos.set(x, y, z);
    this.scl.set(sx, sy, sz);
    this.euler.set(tiltX, yaw, tiltZ, 'YXZ');
    this.q.setFromEuler(this.euler);
    this.m.compose(this.pos, this.q, this.scl);
    batch.add(this.m, color);
  }

  private pickColor(list: THREE.Color[], rng: Rng, vary = 0.08): THREE.Color {
    const base = list[Math.floor(rng() * list.length)];
    const v = 1 + (rng() - 0.5) * 2 * vary;
    return this.col.copy(base).multiplyScalar(v);
  }

  private canopyPalette(biome: BiomeType, rng: Rng): THREE.Color[] {
    const r = rng();
    switch (biome) {
      case 'forest':
        return r < 0.45 ? CANOPY_COLORS.green : r < 0.75 ? CANOPY_COLORS.yellowGreen : r < 0.9 ? CANOPY_COLORS.gold : CANOPY_COLORS.orange;
      case 'hedge':
        return r < 0.5 ? CANOPY_COLORS.green : r < 0.8 ? CANOPY_COLORS.yellowGreen : CANOPY_COLORS.gold;
      default:
        return r < 0.35 ? CANOPY_COLORS.green : r < 0.65 ? CANOPY_COLORS.yellowGreen : r < 0.85 ? CANOPY_COLORS.gold : r < 0.95 ? CANOPY_COLORS.orange : CANOPY_COLORS.rust;
    }
  }

  private addBroadleaf(b: Batches, chunk: number, x: number, z: number, rng: Rng, biome: BiomeType, big = false): void {
    const y = this.terrain.groundHeight(x, z) - 0.15;
    const h = rand(rng, big ? 3.2 : 2.2, big ? 5.2 : 4.2);
    const tr = rand(rng, 0.14, 0.3) * (big ? 1.3 : 1);
    this.place(b.trunk, x, y, z, tr, h + 0.6, tr, rng() * 6.28, this.pickColor(TRUNK_COLORS, rng));
    const palette = this.canopyPalette(biome, rng);
    const lobes = 1 + Math.floor(rng() * 3);
    const rx = rand(rng, 1.7, 3.2) * (big ? 1.35 : 1);
    for (let i = 0; i < lobes; i++) {
      const s = i === 0 ? rx : rx * rand(rng, 0.55, 0.85);
      const ox = i === 0 ? 0 : rand(rng, -rx * 0.6, rx * 0.6);
      const oz = i === 0 ? 0 : rand(rng, -rx * 0.6, rx * 0.6);
      const oy = i === 0 ? 0 : rand(rng, -rx * 0.3, rx * 0.4);
      const sy = s * rand(rng, 0.75, 1.0);
      this.place(b.canopy, x + ox, y + h + sy * 0.65 + oy, z + oz, s, sy, s * rand(rng, 0.85, 1.1), rng() * 6.28, this.pickColor(palette, rng));
    }
    this.colliders.add(chunk, { kind: 'cylinder', x, z, r: tr + 0.08, yTop: y + h, surface: SURFACES.trunk, blocksPlayer: true });
  }

  private addFruitTree(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const y = this.terrain.groundHeight(x, z) - 0.1;
    const h = rand(rng, 1.5, 2.4);
    const tr = rand(rng, 0.12, 0.2);
    this.place(b.trunk, x, y, z, tr, h + 0.4, tr, rng() * 6.28, this.pickColor(TRUNK_COLORS, rng));
    const palette = rng() < 0.55 ? CANOPY_COLORS.green : rng() < 0.6 ? CANOPY_COLORS.yellowGreen : CANOPY_COLORS.gold;
    const s = rand(rng, 1.5, 2.4);
    this.place(b.canopy, x, y + h + s * 0.7, z, s, s * rand(rng, 0.8, 1.0), s, rng() * 6.28, this.pickColor(palette, rng));
    if (rng() < 0.6) {
      const s2 = s * rand(rng, 0.5, 0.7);
      this.place(b.canopy, x + rand(rng, -s * 0.5, s * 0.5), y + h + s * 0.9, z + rand(rng, -s * 0.5, s * 0.5), s2, s2, s2, rng() * 6.28, this.pickColor(palette, rng));
    }
    this.colliders.add(chunk, { kind: 'cylinder', x, z, r: tr + 0.08, yTop: y + h, surface: SURFACES.trunk, blocksPlayer: true });
  }

  private addFir(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const y = this.terrain.groundHeight(x, z) - 0.15;
    const h = rand(rng, 6, 11);
    const tr = rand(rng, 0.16, 0.28);
    this.place(b.trunk, x, y, z, tr, h * 0.35, tr, rng() * 6.28, this.pickColor(TRUNK_COLORS, rng));
    const tiers = 3;
    const baseR = h * 0.22;
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      const r = baseR * (1 - t * 0.45);
      const th = h * 0.42;
      this.place(b.cone, x, y + h * 0.22 + t * h * 0.55, z, r, th, r, rng() * 6.28, this.pickColor(CANOPY_COLORS.fir, rng));
    }
    this.colliders.add(chunk, { kind: 'cylinder', x, z, r: tr + 0.08, yTop: y + h, surface: SURFACES.trunk, blocksPlayer: true });
  }

  /**
   * A bush made of one or two blobs. The bush is pushed away from the track so
   * that its collider never reaches onto the lane. Returns the final x.
   */
  private addBush(b: Batches, chunk: number, x: number, z: number, rng: Rng, scale = 1, palette = CANOPY_COLORS.bush): number {
    const blobs = 1 + Math.floor(rng() * 2);
    const sizes: Array<[number, number, number, number, number]> = [];
    let maxR = 0;
    for (let i = 0; i < blobs; i++) {
      const sx = rand(rng, 0.7, 1.3) * scale;
      const sy = rand(rng, 0.7, 1.2) * scale;
      const sz = rand(rng, 0.7, 1.3) * scale;
      const ox = i === 0 ? 0 : rand(rng, -0.5, 0.5) * scale;
      const oz = i === 0 ? 0 : rand(rng, -0.5, 0.5) * scale;
      sizes.push([sx, sy, sz, ox, oz]);
      maxR = Math.max(maxR, Math.max(sx, sz) + Math.hypot(ox, oz));
    }
    const colliderR = maxR * 0.85;
    // Keep the collider clear of the lane.
    const cx = this.terrain.pathCenterX(-z);
    const d = x - cx;
    const side = d < 0 ? -1 : 1;
    const minD = CFG.path.halfWidth + 0.2 + colliderR;
    if (Math.abs(d) < minD) x = cx + side * minD;
    const y = this.terrain.groundHeight(x, z);
    for (const [sx, sy, sz, ox, oz] of sizes) {
      this.place(b.bush, x + ox, y + sy * 0.55, z + oz, sx, sy, sz, rng() * 6.28, this.pickColor(palette, rng, 0.12));
    }
    this.colliders.add(chunk, { kind: 'sphere', x, y: y + maxR * 0.45, z, r: colliderR, surface: SURFACES.bush, blocksPlayer: false });
    return x;
  }

  /** Whether chunk i carries a fence on this side (a deterministic 30 % roll). */
  private fenceOn(i: number, side: Side): boolean {
    return hash3(i, side, this.terrain.seed + 77) < 0.3;
  }

  /**
   * A fence along the meadow edge: posts on a global 2.4 m grid (so fences of
   * neighbouring chunks line up), only where the biome is meadow.
   */
  private addFence(b: Batches, chunk: number, i: number, side: Side): void {
    const { p0, p1 } = Terrain.chunkRange(i);
    const d = side * 2.35;
    const step = 2.4;
    let prevX = NaN;
    let prevY = 0;
    let prevZ = 0;
    const first = Math.ceil(p0 / step) * step;
    // Bridge to the last post of a fenced previous chunk.
    if (i - 1 >= -CFG.chunk.behind && this.fenceOn(i - 1, side) && this.terrain.biomeAt(first - step, side) === 'meadow') {
      const pp = first - step;
      prevX = this.terrain.pathCenterX(pp) + d;
      prevZ = -pp;
      prevY = this.terrain.groundHeight(prevX, prevZ);
    }
    for (let p = first; p < p1 - 1e-6; p += step) {
      if (this.terrain.biomeAt(p, side) !== 'meadow') {
        prevX = NaN;
        continue;
      }
      const x = this.terrain.pathCenterX(p) + d;
      const z = -p;
      const y = this.terrain.groundHeight(x, z);
      this.place(b.box, x, y - 0.1, z, 0.1, 1.1, 0.1, 0, POST_COLOR);
      this.colliders.add(chunk, { kind: 'cylinder', x, z, r: 0.1, yTop: y + 1, surface: SURFACES.post, blocksPlayer: true });
      if (!Number.isNaN(prevX)) {
        for (const h of [0.45, 0.85]) {
          const mx = (x + prevX) / 2;
          const mz = (z + prevZ) / 2;
          const my = (y + prevY) / 2 + h;
          const len = Math.hypot(x - prevX, z - prevZ, y - prevY);
          const yaw = Math.atan2(x - prevX, z - prevZ);
          const tilt = Math.atan2(y - prevY, Math.hypot(x - prevX, z - prevZ));
          // Rail: a box along Z, rotated to the segment direction.
          this.place(b.box, mx, my - 0.04, mz, 0.06, 0.08, len, yaw, RAIL_COLOR, -tilt, 0);
          // Rails bounce the apple but the player can climb through them, so the
          // apple can never end up out of reach behind a fence.
          this.colliders.add(chunk, { kind: 'capsule', ax: prevX, ay: prevY + h, az: prevZ, bx: x, by: y + h, bz: z, r: 0.05, surface: SURFACES.post, blocksPlayer: false });
        }
      }
      prevX = x;
      prevY = y;
      prevZ = z;
    }
  }

  private addVineRows(b: Batches, chunk: number, i: number, side: Side, rng: Rng): void {
    const { p0, p1 } = Terrain.chunkRange(i);
    const rowSpacing = 2.4;
    const firstRow = Math.ceil(p0 / rowSpacing) * rowSpacing + 1.2;
    for (let p = firstRow; p < p1; p += rowSpacing) {
      if (this.terrain.biomeAt(p, side) !== 'vineyard') continue;
      const z = -p;
      const cx = this.terrain.pathCenterX(p);
      const dStart = 3.2;
      const dEnd = 26.5;
      const postStep = 1.5;
      let prevX = NaN;
      let prevY = 0;
      for (let d = dStart; d <= dEnd; d += postStep) {
        const x = cx + side * d;
        const y = this.terrain.groundHeight(x, z);
        this.place(b.box, x, y - 0.1, z, 0.08, 1.9, 0.08, 0, POST_COLOR);
        this.colliders.add(chunk, { kind: 'cylinder', x, z, r: 0.08, yTop: y + 1.8, surface: SURFACES.post, blocksPlayer: true });
        if (!Number.isNaN(prevX)) {
          // Wire between the posts, following the slope.
          const mx = (x + prevX) / 2;
          const my = (y + prevY) / 2 + 1.15;
          const len = Math.hypot(x - prevX, y - prevY);
          // A box along local X, tilted about Z to follow the slope.
          const tilt = Math.atan2(y - prevY, x - prevX);
          this.place(b.box, mx, my, z, len, 0.025, 0.025, 0, POST_COLOR, 0, tilt);
        }
        prevX = x;
        prevY = y;
        if (d + postStep <= dEnd) {
          // Two vine blobs between posts.
          for (let k = 0; k < 2; k++) {
            const bx = x + side * postStep * (0.3 + 0.4 * k) + rand(rng, -0.1, 0.1);
            const by = this.terrain.groundHeight(bx, z);
            const sx = rand(rng, 0.45, 0.6);
            const sy = rand(rng, 0.55, 0.75);
            this.place(b.bush, bx, by + 0.55 + sy * 0.5, z + rand(rng, -0.08, 0.08), sx, sy, rand(rng, 0.28, 0.4), rng() * 0.4, this.pickColor(CANOPY_COLORS.vine, rng, 0.12));
            this.colliders.add(chunk, { kind: 'sphere', x: bx, y: by + 0.8, z, r: 0.42, surface: SURFACES.bush, blocksPlayer: false });
          }
        }
      }
    }
  }

  private addLeaves(b: Batches, i: number, rng: Rng): void {
    const { p0, p1 } = Terrain.chunkRange(i);
    // Leaves on the track.
    for (let k = 0; k < 110; k++) {
      const p = rand(rng, p0, p1);
      const d = rand(rng, -2.3, 2.3);
      const x = this.terrain.pathCenterX(p) + d;
      const z = -p;
      const y = this.terrain.groundHeight(x, z) + 0.012;
      const s = rand(rng, 0.05, 0.1);
      this.place(b.leaf, x, y, z, s, 1, s * rand(rng, 0.6, 1), rng() * 6.28, this.pickColor(CANOPY_COLORS.leaf, rng, 0.1));
    }
    // Leaves under trees.
    for (let k = 0; k < 160; k++) {
      const p = rand(rng, p0, p1);
      const side: Side = rng() < 0.5 ? -1 : 1;
      const biome = this.terrain.biomeAt(p, side);
      if (biome !== 'forest' && biome !== 'hedge') continue;
      const d = rand(rng, 1.8, biome === 'hedge' ? 6 : 14);
      const x = this.terrain.pathCenterX(p) + side * d;
      const z = -p;
      const y = this.terrain.groundHeight(x, z) + 0.012;
      const s = rand(rng, 0.06, 0.12);
      this.place(b.leaf, x, y, z, s, 1, s * rand(rng, 0.6, 1), rng() * 6.28, this.pickColor(CANOPY_COLORS.leaf, rng, 0.1));
    }
  }

  private addTufts(b: Batches, i: number, rng: Rng): void {
    const { p0, p1 } = Terrain.chunkRange(i);
    for (let k = 0; k < 200; k++) {
      const p = rand(rng, p0, p1);
      const side: Side = rng() < 0.5 ? -1 : 1;
      const biome = this.terrain.biomeAt(p, side);
      let d: number;
      if (biome === 'field') d = rand(rng, 1.3, 2.6);
      else if (biome === 'vineyard') d = rand(rng, 1.3, 3.0);
      else if (biome === 'hedge') d = rng() < 0.5 ? rand(rng, 1.3, 1.9) : rand(rng, 6, 30);
      else if (biome === 'forest') d = rand(rng, 1.3, 2.6);
      else d = rand(rng, 1.3, 30);
      const x = this.terrain.pathCenterX(p) + side * d;
      const z = -p;
      const y = this.terrain.groundHeight(x, z) - 0.02;
      const s = rand(rng, 0.05, 0.1);
      const h = rand(rng, 0.14, 0.3);
      this.place(b.tuft, x, y, z, s, h, s, rng() * 6.28, this.pickColor(CANOPY_COLORS.tuft, rng, 0.12), rand(rng, -0.25, 0.25), rand(rng, -0.25, 0.25));
    }
  }

  private addFarForest(b: Batches, i: number, rng: Rng): void {
    const { zNear, zFar } = Terrain.chunkRange(i);
    for (const side of [-1, 1] as Side[]) {
      for (let k = 0; k < 230; k++) {
        const ax = rand(rng, CFG.chunk.halfWidth + 3, CFG.chunk.farExtent - 10);
        const x = side * ax;
        const z = rand(rng, zFar, zNear);
        // Leave meadow clearings in the distant hills.
        const n = fbm2(x * 0.01, z * 0.01, this.terrain.seed + 51, 3);
        if (n > 0.2 && ax < 150 && rng() < 0.85) continue;
        const y = this.terrain.groundHeight(x, z) - 0.5;
        const h = rand(rng, 7, 14) * (1 + smoothstep(150, 300, ax) * 0.6);
        if (rng() < 0.6) {
          this.place(b.farCone, x, y, z, h * 0.3, h, h * 0.3, rng() * 6.28, this.pickColor(CANOPY_COLORS.far, rng, 0.15));
        } else {
          const s = h * 0.45;
          // Full detail only in the un-fogged near band; a 20-triangle blob beyond.
          this.place(ax < 100 ? b.farBlob : b.farBlobLod, x, y + s * 0.8, z, s, s * 1.1, s, rng() * 6.28, this.pickColor(CANOPY_COLORS.far, rng, 0.15));
        }
      }
    }
  }

  // ---------------------------------------------------------------------------

  /** Build all decoration for chunk i. Also registers the colliders. */
  buildChunk(i: number): THREE.Group {
    const rng = mulberry32(subSeed(this.terrain.seed, 500 + i));
    const b: Batches = {
      trunk: new Batch(this.trunkGeo, this.flatMat, true, false),
      canopy: new Batch(this.canopyGeo, this.flatMat, true, false),
      cone: new Batch(this.coneGeo, this.flatMat, true, false),
      bush: new Batch(this.bushGeo, this.flatMat, true, true),
      box: new Batch(this.boxGeo, this.flatMat, true, false),
      leaf: new Batch(this.leafGeo, this.leafMat, false, true),
      tuft: new Batch(this.tuftGeo, this.tuftMat, false, true),
      farCone: new Batch(this.farConeGeo, this.flatMat, false, false),
      farBlob: new Batch(this.canopyGeo, this.flatMat, false, false),
      farBlobLod: new Batch(this.farBlobGeo, this.flatMat, false, false),
    };
    const { p0, p1 } = Terrain.chunkRange(i);

    for (const side of [-1, 1] as Side[]) {
      const placed: Array<[number, number, number]> = [];
      const tooClose = (x: number, z: number, minD: number): boolean => {
        for (const [px, pz, pr] of placed) {
          const dd = (px - x) ** 2 + (pz - z) ** 2;
          if (dd < (minD + pr) ** 2) return true;
        }
        return false;
      };
      const singleFieldTree = hash3(i, side, this.terrain.seed + 79) < 0.3;
      let fieldTreePlaced = false;
      let vinesDone = false;
      if (this.fenceOn(i, side)) this.addFence(b, i, i, side);

      for (let k = 0; k < 260; k++) {
        const p = rand(rng, p0, p1);
        const d = rand(rng, 1.8, CFG.chunk.halfWidth - 2);
        const biome = this.terrain.biomeAt(p, side);
        const cx = this.terrain.pathCenterX(p);
        const x = cx + side * d;
        const z = -p;
        if (Math.abs(x) > CFG.chunk.halfWidth - 1.5) continue;
        switch (biome) {
          case 'forest': {
            if (d < 3.2) {
              if (rng() < 0.5 && !tooClose(x, z, 1.2)) {
                const bx = this.addBush(b, i, x, z, rng, rand(rng, 0.7, 1.1));
                placed.push([bx, z, 1]);
              }
            } else if (rng() < 0.6 && !tooClose(x, z, 2.6)) {
              if (rng() < 0.25) this.addFir(b, i, x, z, rng);
              else this.addBroadleaf(b, i, x, z, rng, biome, d > 6 && rng() < 0.3);
              placed.push([x, z, 1.5]);
            }
            break;
          }
          case 'hedge': {
            if (d < 4.8) {
              if (rng() < 0.8 && !tooClose(x, z, 0.8)) {
                const bx = this.addBush(b, i, x, z, rng, rand(rng, 1.0, 1.5));
                placed.push([bx, z, 0.6]);
              }
            } else if (d < 8) {
              if (rng() < 0.22 && !tooClose(x, z, 4)) {
                this.addBroadleaf(b, i, x, z, rng, biome, true);
                placed.push([x, z, 2]);
              }
            } else if (rng() < 0.05 && !tooClose(x, z, 5)) {
              this.addFruitTree(b, i, x, z, rng);
              placed.push([x, z, 2]);
            }
            break;
          }
          case 'meadow': {
            if (d > 3 && rng() < 0.045 && !tooClose(x, z, 5)) {
              if (rng() < 0.8) this.addFruitTree(b, i, x, z, rng);
              else this.addBroadleaf(b, i, x, z, rng, biome);
              placed.push([x, z, 2]);
            } else if (d > 2.2 && d < 4 && rng() < 0.04 && !tooClose(x, z, 2)) {
              this.addBush(b, i, x, z, rng, rand(rng, 0.6, 1));
              placed.push([x, z, 1]);
            }
            break;
          }
          case 'field': {
            if (d > 34 && rng() < 0.3 && !tooClose(x, z, 3)) {
              this.addBroadleaf(b, i, x, z, rng, biome, rng() < 0.4);
              placed.push([x, z, 1.5]);
            } else if (singleFieldTree && !fieldTreePlaced && d > 8 && d < 30) {
              fieldTreePlaced = true;
              this.addBroadleaf(b, i, x, z, rng, biome, true);
              placed.push([x, z, 2]);
            }
            break;
          }
          case 'vineyard': {
            if (!vinesDone) {
              vinesDone = true;
              this.addVineRows(b, i, i, side, rng);
            }
            if (d > 28.5 && rng() < 0.3 && !tooClose(x, z, 3)) {
              this.addBroadleaf(b, i, x, z, rng, biome, rng() < 0.4);
              placed.push([x, z, 1.5]);
            } else if (d > 2.2 && d < 3.0 && rng() < 0.03) {
              this.addBush(b, i, x, z, rng, 0.7);
            }
            break;
          }
        }
      }
    }

    this.addLeaves(b, i, rng);
    this.addTufts(b, i, rng);
    this.addFarForest(b, i, rng);

    const group = new THREE.Group();
    group.name = `decor-${i}`;
    for (const batch of Object.values(b)) {
      const mesh = batch.build();
      if (mesh) group.add(mesh);
    }
    return group;
  }

  static disposeGroup(group: THREE.Group): void {
    group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
    });
  }
}

interface Batches {
  trunk: Batch;
  canopy: Batch;
  cone: Batch;
  bush: Batch;
  box: Batch;
  leaf: Batch;
  tuft: Batch;
  farCone: Batch;
  farBlob: Batch;
  farBlobLod: Batch;
}

