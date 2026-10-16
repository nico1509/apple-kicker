import * as THREE from 'three';
import { CFG } from '../config';
import { smoothstep } from '../utils/math';
import { fbm2, hash3, mulberry32, rand, subSeed, type Rng } from '../utils/noise';
import { ColliderStore, SURFACES } from './colliders';
import { landscapeAt, landscapeWeight } from './landscape';
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
  // Greece in late summer.
  olive: [C(0x93a378), C(0xa0ae84), C(0x86976c), C(0xaab48c)],
  cypress: [C(0x2c4a2a), C(0x33522e), C(0x284326)],
  shrub: [C(0x5f6b38), C(0x6f7a3e), C(0x7f7c3a), C(0x67733c), C(0x8a7a3e), C(0x96603a)],
  oleander: [C(0x4f7a36), C(0x5a8540)],
  blossom: [C(0xe0609a), C(0xec7fb0), C(0xd24c86)],
  dryTuft: [C(0xd2bd76), C(0xc4ad62), C(0xb39c58), C(0x9aa050)],
  pebble: [C(0xd8d2c2), C(0xc2bcab), C(0xe2dccb)],
  farGreece: [C(0x56663a), C(0x4a5a33), C(0x6a7442), C(0x7e7a44)],
  palm: [C(0x5f8a34), C(0x6f9a3c), C(0x4f7a2c), C(0x7a9a40)],
  desertShrub: [C(0x8a8a4a), C(0x9a8e52), C(0x7a7a40), C(0xa49060)],
};
const ROCK_COLORS = [C(0xc9c3b3), C(0xb4ae9f), C(0xd8d2c2), C(0xa8a293)];
const OLIVE_TRUNK_COLORS = [C(0x8a7f6c), C(0x978b76), C(0x7b715f)];
const WALL_STONE_COLORS = [C(0xbdb4a2), C(0xa99f8c), C(0xcfc6b2), C(0x9a907e), C(0xb5a088)];
const WHITEWASH = C(0xf1ede3);
const ROOF_TILES = [C(0xc4623a), C(0xb8582f), C(0xcf7244)];
const WOOD_DARK = C(0x5d4a38);
const HAY = [C(0xd9bf6c), C(0xcdb05c), C(0xe0c87a)];
const SAIL_CLOTH = C(0xf4f1e8);
const SAIL_SPOKE = C(0x8a7f70);
const PALM_TRUNK_COLORS = [C(0x8a6a44), C(0x7a5c3a), C(0x96764c)];
const PALM_DRY = [C(0xa88a4a), C(0x96783e)];
const DATES = [C(0xc8742a), C(0xb05a22)];
const MUD_BRICK = [C(0xc9a46c), C(0xd4b07a), C(0xbf9860)];
const SANDSTONE = [C(0xd8b47a), C(0xcda66a), C(0xe0c08a)];
const BASALT = [C(0x3e332c), C(0x4a3d34), C(0x352b25)];
const PYRAMID = [C(0xd8b072), C(0xcfa566)];
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
  private readonly roofGeo: THREE.BufferGeometry;
  private readonly pyramidGeo: THREE.BufferGeometry;

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
    // Gable roof: a triangular prism 1 wide (x), 1 high and 1 long (z), resting on y = 0.
    const roof = new THREE.Shape();
    roof.moveTo(-0.5, 0);
    roof.lineTo(0.5, 0);
    roof.lineTo(0, 1);
    roof.lineTo(-0.5, 0);
    this.roofGeo = new THREE.ExtrudeGeometry(roof, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
    // Square pyramid, edges aligned with the axes, base on y = 0.
    this.pyramidGeo = new THREE.ConeGeometry(Math.SQRT2 / 2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0);
  }

  dispose(): void {
    for (const g of [
      this.trunkGeo, this.canopyGeo, this.coneGeo, this.bushGeo,
      this.boxGeo, this.leafGeo, this.tuftGeo, this.farConeGeo, this.farBlobGeo, this.roofGeo, this.pyramidGeo,
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

  /** Biomes that get a wooden fence along the track. */
  private static fenced(b: BiomeType): boolean {
    return b === 'meadow' || b === 'farmstead';
  }

  /**
   * A fence along the meadow edge: posts on a global 2.4 m grid (so fences of
   * neighbouring chunks line up), only where the biome is meadow (or a Greek farmstead).
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
    if (i - 1 >= -CFG.chunk.behind && this.fenceOn(i - 1, side) && Decor.fenced(this.terrain.biomeAt(first - step, side))) {
      const pp = first - step;
      prevX = this.terrain.pathCenterX(pp) + d;
      prevZ = -pp;
      prevY = this.terrain.groundHeight(prevX, prevZ);
    }
    for (let p = first; p < p1 - 1e-6; p += step) {
      if (!Decor.fenced(this.terrain.biomeAt(p, side))) {
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
    // Leaves on the track (pale pebbles in Greece).
    for (let k = 0; k < 110; k++) {
      const p = rand(rng, p0, p1);
      const d = rand(rng, -2.3, 2.3);
      const x = this.terrain.pathCenterX(p) + d;
      const z = -p;
      const y = this.terrain.groundHeight(x, z) + 0.012;
      const s = rand(rng, 0.05, 0.1);
      if (rng() < landscapeWeight(p, 'desert')) continue;
      const greek = rng() < landscapeWeight(p, 'greece');
      if (greek) this.place(b.leaf, x, y, z, s * 0.6, 1, s * 0.5, rng() * 6.28, this.pickColor(CANOPY_COLORS.pebble, rng, 0.08));
      else this.place(b.leaf, x, y, z, s, 1, s * rand(rng, 0.6, 1), rng() * 6.28, this.pickColor(CANOPY_COLORS.leaf, rng, 0.1));
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
      else if (biome === 'forest' || biome === 'stubble') d = rand(rng, 1.3, 2.6);
      else if (biome === 'olive') d = rand(rng, 1.3, 3.0);
      else d = rand(rng, 1.3, 30);
      if ((biome === 'dunes' && rng() < 0.75) || (biome === 'blackdesert' && rng() < 0.85)) continue;
      const dry = biome === 'phrygana' || biome === 'olive' || biome === 'stubble' || biome === 'farmstead'
        || biome === 'dunes' || biome === 'blackdesert' || biome === 'ruins';
      const x = this.terrain.pathCenterX(p) + side * d;
      const z = -p;
      const y = this.terrain.groundHeight(x, z) - 0.02;
      const s = rand(rng, 0.05, 0.1);
      const h = rand(rng, 0.14, 0.3);
      this.place(b.tuft, x, y, z, s, h, s, rng() * 6.28, this.pickColor(dry ? CANOPY_COLORS.dryTuft : CANOPY_COLORS.tuft, rng, 0.12), rand(rng, -0.25, 0.25), rand(rng, -0.25, 0.25));
    }
  }

  private addFarForest(b: Batches, i: number, rng: Rng): void {
    const { zNear, zFar } = Terrain.chunkRange(i);
    for (const side of [-1, 1] as Side[]) {
      // Windmills on the Greek slopes.
      const pm = -(zNear + zFar) / 2;
      if (landscapeAt(pm) === 'greece' && rng() < 0.14) {
        this.addWindmills(b, side * rand(rng, 58, 120), rand(rng, zFar + 8, zNear), side, rng);
      }
      // Pyramids on the desert horizon.
      if (landscapeAt(pm) === 'desert' && rng() < 0.09) {
        this.addPyramids(b, side * rand(rng, 150, 230), rand(rng, zFar, zNear), side, rng);
      }
      for (let k = 0; k < 230; k++) {
        const ax = rand(rng, CFG.chunk.halfWidth + 3, CFG.chunk.farExtent - 10);
        const x = side * ax;
        const z = rand(rng, zFar, zNear);
        if (rng() < landscapeWeight(-z, 'greece')) {
          // Sparse scrub and cypresses below bare mountains.
          if (rng() < 0.45 || rng() < smoothstep(90, 200, ax)) continue;
          const y = this.terrain.groundHeight(x, z) - 0.3;
          if (rng() < 0.25) {
            const h = rand(rng, 6, 10);
            this.place(b.farCone, x, y, z, h * 0.12, h, h * 0.12, rng() * 6.28, this.pickColor(CANOPY_COLORS.cypress, rng, 0.1));
          } else {
            const s = rand(rng, 1.8, 3.6);
            this.place(ax < 100 ? b.farBlob : b.farBlobLod, x, y + s * 0.3, z, s, s * 0.6, s, rng() * 6.28, this.pickColor(CANOPY_COLORS.farGreece, rng, 0.12));
          }
          continue;
        }
        if (rng() < landscapeWeight(-z, 'desert')) {
          // A few dark rocks on the distant dunes.
          if (rng() < 0.85) continue;
          const y = this.terrain.groundHeight(x, z) - 0.3;
          const s = rand(rng, 1.5, 4);
          this.place(ax < 100 ? b.farBlob : b.farBlobLod, x, y, z, s, s * 0.5, s, rng() * 6.28, this.pickColor(BASALT, rng, 0.1));
          continue;
        }
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
  // Greece

  /** Pushes a position sideways so that an object of radius r stays off the lane. Returns the new x. */
  private clearOfLane(x: number, z: number, r: number): number {
    const cx = this.terrain.pathCenterX(-z);
    const d = x - cx;
    const minD = CFG.path.halfWidth + 0.2 + r;
    return Math.abs(d) < minD ? cx + (d < 0 ? -1 : 1) * minD : x;
  }

  /** A gnarled olive tree: a short leaning trunk under a wide, silvery canopy. */
  private addOliveTree(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const y = this.terrain.groundHeight(x, z) - 0.1;
    const h = rand(rng, 1.2, 1.9);
    const tr = rand(rng, 0.16, 0.28);
    const lean = rand(rng, -0.22, 0.22);
    this.place(b.trunk, x, y, z, tr, h + 0.5, tr, rng() * 6.28, this.pickColor(OLIVE_TRUNK_COLORS, rng), lean, rand(rng, -0.22, 0.22));
    // Several small, loose tufts rather than one dense ball.
    const lobes = 4 + Math.floor(rng() * 3);
    const spread = rand(rng, 1.1, 1.7);
    for (let k = 0; k < lobes; k++) {
      const a = (k / lobes) * Math.PI * 2 + rng();
      const o = k === 0 ? 0 : spread * rand(rng, 0.6, 1.0);
      const s = rand(rng, 0.6, 1.0) * (k === 0 ? 1.15 : 1);
      this.place(b.canopy, x + Math.cos(a) * o, y + h + 0.5 + rand(rng, -0.2, 0.35), z + Math.sin(a) * o, s, s * rand(rng, 0.5, 0.7), s, rng() * 6.28, this.pickColor(CANOPY_COLORS.olive, rng, 0.06));
    }
    this.colliders.add(chunk, { kind: 'cylinder', x, z, r: tr + 0.08, yTop: y + h, surface: SURFACES.trunk, blocksPlayer: true });
  }

  /** A slim, dark Mediterranean cypress. */
  private addCypress(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const y = this.terrain.groundHeight(x, z) - 0.1;
    const h = rand(rng, 5, 9);
    const r = h * rand(rng, 0.09, 0.12);
    this.place(b.trunk, x, y, z, 0.15, 1.0, 0.15, 0, this.pickColor(TRUNK_COLORS, rng));
    this.place(b.canopy, x, y + 0.4 + h * 0.5, z, r, h * 0.5, r, rng() * 6.28, this.pickColor(CANOPY_COLORS.cypress, rng));
    this.colliders.add(chunk, { kind: 'cylinder', x, z, r: 0.3, yTop: y + h, surface: SURFACES.bush, blocksPlayer: true });
  }

  /** Oleander: a green bush covered in pink blossoms. */
  private addOleander(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const scale = rand(rng, 0.9, 1.3);
    const bx = this.addBush(b, chunk, x, z, rng, scale, CANOPY_COLORS.oleander);
    const y = this.terrain.groundHeight(bx, z);
    const n = 7 + Math.floor(rng() * 6);
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2;
      const up = rand(rng, 0.2, 1);
      const rr = scale * 0.95 * Math.sqrt(1 - up * up * 0.6);
      const s = rand(rng, 0.13, 0.22);
      this.place(b.bush, bx + Math.cos(a) * rr, y + scale * (0.4 + up * 0.75), z + Math.sin(a) * rr, s, s, s, rng() * 6.28, this.pickColor(CANOPY_COLORS.blossom, rng, 0.08));
    }
  }

  /** A pale limestone boulder (with a smaller one or two beside it). */
  private addRock(b: Batches, chunk: number, x: number, z: number, rng: Rng, scale = 1, colors = ROCK_COLORS): void {
    const r = rand(rng, 0.3, 0.85) * scale;
    x = this.clearOfLane(x, z, r * 1.3);
    const y = this.terrain.groundHeight(x, z) + r * 0.2;
    this.place(b.rock, x, y, z, r * rand(rng, 1.0, 1.4), r * rand(rng, 0.6, 0.9), r * rand(rng, 1.0, 1.3), rng() * 6.28, this.pickColor(colors, rng, 0.05), rand(rng, -0.3, 0.3), rand(rng, -0.3, 0.3));
    this.colliders.add(chunk, { kind: 'sphere', x, y, z, r: r * 0.95, surface: SURFACES.stone, blocksPlayer: r > 0.35 });
    const extra = Math.floor(rng() * 3);
    for (let k = 0; k < extra; k++) {
      const a = rng() * Math.PI * 2;
      const rs = r * rand(rng, 0.3, 0.55);
      const sx = this.clearOfLane(x + Math.cos(a) * r * 1.3, z, rs);
      const sz = z + Math.sin(a) * r * 1.3;
      const sy = this.terrain.groundHeight(sx, sz) + rs * 0.2;
      this.place(b.rock, sx, sy, sz, rs * 1.2, rs * 0.8, rs, rng() * 6.28, this.pickColor(colors, rng, 0.05));
      this.colliders.add(chunk, { kind: 'sphere', x: sx, y: sy, z: sz, r: rs * 0.95, surface: SURFACES.stone, blocksPlayer: false });
    }
  }

  /** Whether the drystone wall along the track runs at progress p on this side. */
  private wallAt(p: number, side: Side): boolean {
    const b = this.terrain.biomeAt(p, side);
    if (b !== 'olive' && b !== 'stubble') return false;
    if (hash3(Math.floor(p / 100), side, this.terrain.seed + 83) > 0.7) return false;
    // A gap every now and then.
    return hash3(Math.floor(p / 4), side, this.terrain.seed + 89) > 0.12;
  }

  /**
   * A knee-high drystone wall along the track. Segments sit on a global 1.2 m
   * grid so that walls of neighbouring chunks line up. Like the fence rails the
   * wall bounces the apple, but the player can climb over it.
   */
  private addDryWall(b: Batches, chunk: number, i: number, side: Side): void {
    const { p0, p1 } = Terrain.chunkRange(i);
    const step = 1.2;
    const dWall = side * 3.0;
    const first = Math.ceil(p0 / step) * step;
    for (let p = first; p < p1 - 1e-6; p += step) {
      if (!this.wallAt(p, side)) continue;
      const rng = mulberry32(subSeed(this.terrain.seed, 1300 + Math.round(p / step), side + 2));
      const yaw = this.terrain.pathHeading(p);
      const courses = 3;
      for (let c = 0; c < courses; c++) {
        for (let k = 0; k < 2; k++) {
          const pp = p + (k + 0.5 - (c % 2) * 0.25) * (step / 2);
          const x = this.terrain.pathCenterX(pp) + dWall + rand(rng, -0.04, 0.04);
          const z = -pp;
          const y = this.terrain.groundHeight(x, z) - 0.06 + c * 0.24;
          const w = (0.62 - c * 0.07) * rand(rng, 0.9, 1.05);
          this.place(b.box, x, y, z, w, rand(rng, 0.22, 0.3), (step / 2) * rand(rng, 0.85, 1.05), yaw + rand(rng, -0.12, 0.12), this.pickColor(WALL_STONE_COLORS, rng, 0.06), rand(rng, -0.06, 0.06), rand(rng, -0.08, 0.08));
        }
      }
      if (this.wallAt(p + step, side)) {
        const ax = this.terrain.pathCenterX(p) + dWall;
        const bx = this.terrain.pathCenterX(p + step) + dWall;
        const ay = this.terrain.groundHeight(ax, -p) + 0.4;
        const by = this.terrain.groundHeight(bx, -(p + step)) + 0.4;
        this.colliders.add(chunk, { kind: 'capsule', ax, ay, az: -p, bx, by, bz: -(p + step), r: 0.32, surface: SURFACES.stone, blocksPlayer: false });
      }
    }
  }

  /** Olive trees on a loose grid (global, so groves continue across chunks). */
  private addOliveGrove(b: Batches, chunk: number, i: number, side: Side): void {
    const { p0, p1 } = Terrain.chunkRange(i);
    const spacing = 6.5;
    const first = Math.ceil(p0 / spacing) * spacing;
    for (let p = first; p < p1 - 1e-6; p += spacing) {
      if (this.terrain.biomeAt(p, side) !== 'olive') continue;
      const cx = this.terrain.pathCenterX(p);
      for (let d = 6; d < CFG.chunk.halfWidth + 12; d += spacing) {
        const rng = mulberry32(subSeed(this.terrain.seed, 1700 + Math.round(p / spacing), Math.round(d) * side));
        if (rng() < 0.1) continue;
        const x = cx + side * (d + rand(rng, -0.8, 0.8));
        const z = -p + rand(rng, -0.8, 0.8);
        if (Math.abs(x) > CFG.chunk.halfWidth - 1.5) continue;
        this.addOliveTree(b, chunk, x, z, rng);
      }
    }
  }

  /** A whitewashed farmhouse with a terracotta (or flat) roof, set back from the track. */
  private addHouse(b: Batches, chunk: number, x: number, z: number, side: Side, rng: Rng): void {
    const yaw = this.terrain.pathHeading(-z) + rand(rng, -0.15, 0.15);
    const len = rand(rng, 5.5, 8); // along the track (local z)
    const dep = rand(rng, 4, 5.2); // across (local x)
    const h = rand(rng, 2.6, 3.1);
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const world = (ox: number, oz: number): [number, number] => [x + ox * c + oz * sn, z - ox * sn + oz * c];
    let lo = Infinity;
    let hi = -Infinity;
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const [wx, wz] = world((ox * dep) / 2, (oz * len) / 2);
      const gh = this.terrain.groundHeight(wx, wz);
      lo = Math.min(lo, gh);
      hi = Math.max(hi, gh);
    }
    const y0 = lo - 0.2;
    const wallH = h + (hi - lo) + 0.2;
    this.place(b.box, x, y0, z, dep, wallH, len, yaw, WHITEWASH);
    if (rng() < 0.65) {
      this.place(b.roof, x, y0 + wallH, z, dep + 0.5, rand(rng, 1.0, 1.4), len + 0.5, yaw, this.pickColor(ROOF_TILES, rng, 0.05));
    } else {
      this.place(b.box, x, y0 + wallH, z, dep + 0.15, 0.22, len + 0.15, yaw, WHITEWASH);
    }
    // Door and small windows on the side facing the track.
    const face = -side * (dep / 2 + 0.01);
    const yDoor = hi - 0.05;
    const [dx, dz] = world(face, rand(rng, -len * 0.25, len * 0.25));
    this.place(b.box, dx, yDoor, dz, 0.06, 1.95, 0.95, yaw, WOOD_DARK);
    for (const t of [-0.38, 0.38]) {
      const [wx, wz] = world(face, t * len);
      this.place(b.box, wx, yDoor + 1.1, wz, 0.06, 0.62, 0.5, yaw, WOOD_DARK);
    }
    // Colliders: a row of cylinders along the house.
    const n = Math.ceil(len / dep) + 1;
    for (let k = 0; k < n; k++) {
      const [cx, cz] = world(0, -len / 2 + dep / 2 + ((len - dep) * k) / Math.max(1, n - 1));
      this.colliders.add(chunk, { kind: 'cylinder', x: cx, z: cz, r: dep / 2, yTop: y0 + wallH, surface: SURFACES.stone, blocksPlayer: true });
    }
  }

  /** Small square straw bales left on the stubble. */
  private addHayBales(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const n = 1 + Math.floor(rng() * 3);
    const yaw = rng() * 6.28;
    for (let k = 0; k < n; k++) {
      const bx = x + Math.cos(yaw) * k * 0.55;
      const bz = z - Math.sin(yaw) * k * 0.55;
      const y = this.terrain.groundHeight(bx, bz) - 0.03;
      this.place(b.box, bx, y, bz, 0.5, 0.42, 1.0, yaw + rand(rng, -0.1, 0.1), this.pickColor(HAY, rng, 0.05));
      this.colliders.add(chunk, { kind: 'cylinder', x: bx, z: bz, r: 0.45, yTop: y + 0.42, surface: SURFACES.bush, blocksPlayer: true });
    }
  }

  /** A row of Lasithi-style windmills on the distant slopes: white towers with cloth sails. */
  private addWindmills(b: Batches, x: number, z: number, side: Side, rng: Rng): void {
    const count = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < count; k++) {
      const mx = x + rand(rng, -2, 2);
      const mz = z - k * rand(rng, 9, 12);
      const y = this.terrain.groundHeight(mx, mz) - 0.4;
      const towerH = rand(rng, 5, 6.5);
      const R = rand(rng, 1.4, 1.7);
      this.place(b.trunk, mx, y, mz, R, towerH, R, rng() * 6.28, WHITEWASH);
      this.place(b.cone, mx, y + towerH, mz, R * 0.78, R * 0.7, R * 0.78, 0, this.pickColor(ROCK_COLORS, rng, 0.03));
      // The sails face the track.
      const hubX = mx - side * (R * 0.8 + 0.35);
      const hubY = y + towerH - 0.1;
      const L = rand(rng, 3.4, 4.2);
      const turn = rng() * Math.PI;
      for (let s = 0; s < 8; s++) {
        const th = turn + (s * Math.PI) / 4;
        const dy = Math.cos(th);
        const dz = Math.sin(th);
        // The box geometry starts at its local origin, so the spoke grows outwards from the hub.
        this.place(b.box, hubX, hubY, mz, 0.08, L, 0.08, 0, SAIL_SPOKE, th);
        // Triangular-looking cloth: a thin panel beside the outer part of the spoke.
        const off = L * 0.36;
        const w = L * 0.13; // half the cloth width, along (0, -dz, dy)
        this.place(b.box, hubX - side * 0.05, hubY + dy * off - dz * w, mz + dz * off + dy * w, 0.03, L * 0.62, L * 0.26, 0, SAIL_CLOTH, th);
      }
    }
  }


  // ---------------------------------------------------------------------------
  // The Egyptian desert

  /** A date palm: a slightly bent, ringed trunk under a crown of drooping fronds. */
  private addPalm(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const y0 = this.terrain.groundHeight(x, z) - 0.1;
    const h = rand(rng, 5, 8.5);
    const segs = 5;
    const leanA = rng() * Math.PI * 2;
    const lean = rand(rng, 0.04, 0.16);
    let px = x;
    let py = y0;
    let pz = z;
    for (let k = 0; k < segs; k++) {
      const t = lean * (0.5 + k / segs);
      const tx = Math.cos(leanA) * t;
      const tz = Math.sin(leanA) * t;
      const sh = h / segs + 0.12;
      const r = 0.22 - k * 0.015;
      this.place(b.trunk, px, py, pz, r, sh, r, 0, this.pickColor(PALM_TRUNK_COLORS, rng, 0.05), tx, tz);
      // The next ring starts where this one ends (local up after the tilt, see place()).
      const len = sh - 0.12;
      px += -Math.sin(tz) * len;
      py += Math.cos(tz) * Math.cos(tx) * len;
      pz += Math.cos(tz) * Math.sin(tx) * len;
    }
    // Crown.
    const fronds = 10 + Math.floor(rng() * 4);
    for (let k = 0; k < fronds; k++) {
      const yaw = (k / fronds) * Math.PI * 2 + rand(rng, -0.2, 0.2);
      const outer = k % 2 === 0;
      const tilt = outer ? rand(rng, 1.75, 2.1) : rand(rng, 1.0, 1.4);
      const len = rand(rng, 2.0, 2.8) * (outer ? 1 : 0.8);
      const dry = outer && rng() < 0.15;
      this.place(b.box, px, py, pz, 0.5, len, 0.05, yaw, this.pickColor(dry ? PALM_DRY : CANOPY_COLORS.palm, rng, 0.08), tilt);
    }
    // Dates.
    for (let k = 0; k < 3; k++) {
      const a = rng() * Math.PI * 2;
      this.place(b.bush, px + Math.cos(a) * 0.3, py - 0.35, pz + Math.sin(a) * 0.3, 0.16, 0.24, 0.16, 0, this.pickColor(DATES, rng, 0.05));
    }
    this.colliders.add(chunk, { kind: 'cylinder', x, z, r: 0.3, yTop: y0 + h, surface: SURFACES.trunk, blocksPlayer: true });
  }

  /** Crumbling mud-brick walls of an old settlement, with a broken top edge. */
  private addRuin(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const yaw = this.terrain.pathHeading(-z) + (rng() < 0.5 ? 0 : Math.PI / 2) + rand(rng, -0.1, 0.1);
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const len = rand(rng, 5, 10);
    const pieces = Math.round(len / 1.2);
    const thick = 0.6;
    const baseH = rand(rng, 1.6, 3.0);
    for (let k = 0; k < pieces; k++) {
      if (rng() < 0.15) continue; // a gap, like a doorway or a collapsed bit
      const t = -len / 2 + (k + 0.5) * (len / pieces);
      const wx = x + t * sn;
      const wz = z + t * c;
      const y = this.terrain.groundHeight(wx, wz) - 0.2;
      const hh = baseH * rand(rng, 0.45, 1.0);
      this.place(b.box, wx, y, wz, thick, hh + 0.2, len / pieces + 0.02, yaw, this.pickColor(MUD_BRICK, rng, 0.04));
      this.colliders.add(chunk, { kind: 'cylinder', x: wx, z: wz, r: 0.6, yTop: y + hh, surface: SURFACES.stone, blocksPlayer: true });
    }
    // A return wall at one end.
    if (rng() < 0.6) {
      const end = (rng() < 0.5 ? -1 : 1) * len / 2;
      const ex = x + end * sn;
      const ez = z + end * c;
      const rl = rand(rng, 2, 4);
      const mx = ex + (rl / 2) * c;
      const mz = ez - (rl / 2) * sn;
      const y = this.terrain.groundHeight(mx, mz) - 0.2;
      const hh = baseH * rand(rng, 0.5, 0.9);
      this.place(b.box, mx, y, mz, rl, hh + 0.2, thick, yaw, this.pickColor(MUD_BRICK, rng, 0.04));
      this.colliders.add(chunk, { kind: 'cylinder', x: mx, z: mz, r: rl / 2, yTop: y + hh, surface: SURFACES.stone, blocksPlayer: true });
    }
  }

  /** A sandstone column, often broken off, sometimes with its capital. */
  private addColumn(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const y = this.terrain.groundHeight(x, z) - 0.15;
    const r = rand(rng, 0.35, 0.5);
    const intact = rng() < 0.35;
    const h = intact ? rand(rng, 4, 5.5) : rand(rng, 0.8, 3.2);
    this.place(b.trunk, x, y, z, r, h, r, rng() * 6.28, this.pickColor(SANDSTONE, rng, 0.04));
    if (intact) this.place(b.box, x, y + h - 0.05, z, r * 2.6, 0.4, r * 2.6, rng() * 6.28, this.pickColor(SANDSTONE, rng, 0.04));
    this.colliders.add(chunk, { kind: 'cylinder', x, z, r: r + 0.05, yTop: y + h, surface: SURFACES.stone, blocksPlayer: true });
  }

  /** A fallen sandstone block, half sunk into the sand. */
  private addBlock(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const s = rand(rng, 0.5, 1.1);
    x = this.clearOfLane(x, z, s * 0.8);
    const y = this.terrain.groundHeight(x, z) - s * 0.25;
    this.place(b.box, x, y, z, s * rand(rng, 1, 1.6), s * rand(rng, 0.6, 0.9), s, rng() * 6.28, this.pickColor(SANDSTONE, rng, 0.05), rand(rng, -0.15, 0.15), rand(rng, -0.15, 0.15));
    this.colliders.add(chunk, { kind: 'cylinder', x, z, r: s * 0.6, yTop: y + s * 0.8, surface: SURFACES.stone, blocksPlayer: s > 0.6 });
  }

  /** A dark, cone-shaped hill of the black desert. */
  private addBasaltCone(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const r = rand(rng, 2, 4.5);
    const h = r * rand(rng, 0.6, 0.9);
    const y = this.terrain.groundHeight(x, z) - 0.4;
    this.place(b.cone, x, y, z, r, h, r, rng() * 6.28, this.pickColor(BASALT, rng, 0.06));
    this.colliders.add(chunk, { kind: 'cylinder', x, z, r: r * 0.7, yTop: y + h * 0.6, surface: SURFACES.stone, blocksPlayer: true });
  }

  /** A group of pyramids on the horizon. */
  private addPyramids(b: Batches, x: number, z: number, side: Side, rng: Rng): void {
    const count = 1 + Math.floor(rng() * 3);
    let px = x;
    let pz = z;
    for (let k = 0; k < count; k++) {
      const base = rand(rng, 22, 42) * (k === 0 ? 1 : 0.75);
      const y = this.terrain.groundHeight(px, pz) - 3;
      this.place(b.pyramid, px, y, pz, base, base * 1.25, base, 0, this.pickColor(PYRAMID, rng, 0.03));
      px += side * rand(rng, 10, 40);
      pz -= base * rand(rng, 1.4, 2.0);
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
      rock: new Batch(this.farBlobGeo, this.flatMat, true, true),
      roof: new Batch(this.roofGeo, this.flatMat, true, false),
      pyramid: new Batch(this.pyramidGeo, this.flatMat, false, false),
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
      let groveDone = false;
      if (this.fenceOn(i, side)) this.addFence(b, i, i, side);
      if (landscapeAt(p0) === 'greece' || landscapeAt(p1) === 'greece') this.addDryWall(b, i, i, side);
      // One farmhouse per farmstead segment, in the chunk that holds its spot.
      const seg = Math.floor(p0 / 100);
      for (let k = seg; k <= seg + 1; k++) {
        const hp = k * 100 + 30 + hash3(k, side, this.terrain.seed + 91) * 40;
        if (hp < p0 || hp >= p1 || this.terrain.biomeAt(hp, side) !== 'farmstead') continue;
        const hrng = mulberry32(subSeed(this.terrain.seed, 1900 + k, side + 2));
        const hd = rand(hrng, 11, 17);
        const hx = this.terrain.pathCenterX(hp) + side * hd;
        if (Math.abs(hx) > CFG.chunk.halfWidth - 6) continue;
        this.addHouse(b, i, hx, -hp, side, hrng);
        placed.push([hx, -hp, 5]);
        // Oleanders and a cypress by the house.
        for (let o = 0; o < 3; o++) {
          const ox = hx - side * rand(hrng, 3.5, 5);
          const oz = -hp + rand(hrng, -5, 5);
          this.addOleander(b, i, ox, oz, hrng);
          placed.push([ox, oz, 1.2]);
        }
        const cz = -hp + (hrng() < 0.5 ? -1 : 1) * rand(hrng, 5, 7);
        this.addCypress(b, i, hx + side * rand(hrng, -1, 2), cz, hrng);
        placed.push([hx, cz, 1]);
      }

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
          case 'phrygana': {
            // Low scrub, limestone and the odd tree on a dry hillside.
            const r = rng();
            if (r < 0.2 && !tooClose(x, z, 1.0)) {
              const bx = this.addBush(b, i, x, z, rng, rand(rng, 0.3, 0.62), CANOPY_COLORS.shrub);
              placed.push([bx, z, 0.6]);
            } else if (r < 0.25 && d > 2.4 && !tooClose(x, z, 1.4)) {
              this.addRock(b, i, x, z, rng, d < 5 ? 0.7 : 1.2);
              placed.push([x, z, 1]);
            } else if (r < 0.262 && d > 5 && !tooClose(x, z, 4)) {
              if (rng() < 0.5) this.addCypress(b, i, x, z, rng);
              else this.addOliveTree(b, i, x, z, rng);
              placed.push([x, z, 2]);
            }
            break;
          }
          case 'olive': {
            if (!groveDone) {
              groveDone = true;
              this.addOliveGrove(b, i, i, side);
            }
            if (d > 3.8 && d < 5.5 && rng() < 0.05 && !tooClose(x, z, 1.5)) {
              const bx = this.addBush(b, i, x, z, rng, rand(rng, 0.4, 0.7), CANOPY_COLORS.shrub);
              placed.push([bx, z, 0.6]);
            }
            break;
          }
          case 'stubble': {
            if (d > 34 && rng() < 0.2 && !tooClose(x, z, 3)) {
              if (rng() < 0.5) this.addCypress(b, i, x, z, rng);
              else this.addOliveTree(b, i, x, z, rng);
              placed.push([x, z, 1.5]);
            } else if (d > 6 && d < 30 && rng() < 0.012 && !tooClose(x, z, 3)) {
              this.addHayBales(b, i, x, z, rng);
              placed.push([x, z, 1.5]);
            }
            break;
          }
          case 'dunes': {
            // Mostly bare sand: the odd dry shrub or a lone palm.
            const r = rng();
            if (r < 0.04 && !tooClose(x, z, 1.2)) {
              const bx = this.addBush(b, i, x, z, rng, rand(rng, 0.25, 0.45), CANOPY_COLORS.desertShrub);
              placed.push([bx, z, 0.5]);
            } else if (r < 0.043 && d > 8 && !tooClose(x, z, 4)) {
              this.addPalm(b, i, x, z, rng);
              placed.push([x, z, 2]);
            }
            break;
          }
          case 'blackdesert': {
            const r = rng();
            if (r < 0.01 && d > 16 && !tooClose(x, z, 6)) {
              this.addBasaltCone(b, i, x, z, rng);
              placed.push([x, z, 7]);
            } else if (r < 0.05 && d > 2.4 && !tooClose(x, z, 1)) {
              this.addRock(b, i, x, z, rng, 0.6, BASALT);
              placed.push([x, z, 0.6]);
            }
            break;
          }
          case 'ruins': {
            const r = rng();
            if (r < 0.006 && d > 9 && Math.abs(x) < CFG.chunk.halfWidth - 7 && !tooClose(x, z, 7)) {
              this.addRuin(b, i, x, z, rng);
              placed.push([x, z, 6]);
            } else if (r < 0.016 && d > 4 && !tooClose(x, z, 2)) {
              this.addColumn(b, i, x, z, rng);
              placed.push([x, z, 1]);
            } else if (r < 0.04 && d > 2.6 && !tooClose(x, z, 1.5)) {
              this.addBlock(b, i, x, z, rng);
              placed.push([x, z, 1]);
            }
            break;
          }
          case 'oasis': {
            const r = rng();
            if (r < 0.07 && d > 3.5 && d < 30 && !tooClose(x, z, 2.5)) {
              this.addPalm(b, i, x, z, rng);
              placed.push([x, z, 1.5]);
            } else if (r < 0.12 && d > 2.4 && !tooClose(x, z, 1.2)) {
              const bx = this.addBush(b, i, x, z, rng, rand(rng, 0.4, 0.8), CANOPY_COLORS.oleander);
              placed.push([bx, z, 0.6]);
            }
            break;
          }
          case 'farmstead': {
            if (d > 5 && rng() < 0.02 && !tooClose(x, z, 4)) {
              if (rng() < 0.6) this.addFruitTree(b, i, x, z, rng);
              else this.addOliveTree(b, i, x, z, rng);
              placed.push([x, z, 2]);
            } else if (d > 2.4 && rng() < 0.03 && !tooClose(x, z, 1.5)) {
              const bx = this.addBush(b, i, x, z, rng, rand(rng, 0.4, 0.7), CANOPY_COLORS.shrub);
              placed.push([bx, z, 0.6]);
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
  rock: Batch;
  roof: Batch;
  pyramid: Batch;
}

