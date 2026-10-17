import * as THREE from 'three';
import { CFG } from '../config';
import { smoothstep } from '../utils/math';
import { fbm2, hash3, mulberry32, rand, subSeed, type Rng } from '../utils/noise';
import { ColliderStore, SURFACES, type Collider } from './colliders';
import { landscapeAt, landscapeWeight } from './landscape';
import { GORGE, ROAD, Terrain, type BiomeType, type Side } from './terrain';

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
  // The town in winter.
  winterBush: [C(0x6e6248), C(0x7a6c4c), C(0x606a44), C(0x6e5a42)],
  winterTuft: [C(0x7d7a4a), C(0x8a7f52), C(0x6e7444), C(0x9a8a5a)],
  wetLeaf: [C(0x5e4630), C(0x6e5236), C(0x4a3a2a), C(0x7a5a34)],
  farTown: [C(0x857868), C(0x7a6e60), C(0x8e8272), C(0x6f6458)],
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
const PENGUIN_BLACK = [C(0x1d2024), C(0x24272c), C(0x2a2c30)];
const PENGUIN_WHITE = C(0xf2f2ee);
const PENGUIN_ORANGE = [C(0xe8642a), C(0xf07a30)];
const DARK_ROCK = [C(0x3a322e), C(0x463c36), C(0x2f2926), C(0x54473e)];
const SNOW_CAP = [C(0xeef3f8), C(0xe2eaf2)];
const ICE = [C(0xe8f1f8), C(0xd2e4f2), C(0xbcd8ee), C(0xf4f8fb)];
// The orange research equipment.
const RESEARCH_ORANGE = [C(0xf07a1e), C(0xe8701a)];
const RESEARCH_TEAL = C(0x1fa7b8);
const RESEARCH_GLASS = C(0x5fd0e6);
const RESEARCH_NAVY = C(0x1f3550);
const RESEARCH_GREY = C(0x8a9096);
const RESEARCH_BLACK = C(0x24262a);
const RESEARCH_WHITE = C(0xf2f2ee);
const SOLAR = C(0x24407a);
const TRUNK_COLORS = [C(0x6b4d33), C(0x7a5a3c), C(0x5a4330)];
// The small town.
const BARK = [C(0x5a5048), C(0x6b6056), C(0x4e463f), C(0x625a50)];
const BIRCH = C(0xd6d2c6);
const BRICK = [C(0x8a4a3a), C(0x7a4234), C(0x95553f), C(0x84503e)];
const BRICK_LIGHT = C(0xb27a62);
const PLASTER = [C(0xb8ae98), C(0xa8a090), C(0xc4b89c), C(0x9aa0a0), C(0xb4a088)];
const PLANKS = [C(0x4e5e44), C(0x6a5038), C(0x5f6466), C(0x4f6474), C(0x7a6a4a), C(0x5a4a3c)];
const METAL_ROOF = [C(0x5a5c60), C(0x7e8184), C(0x8a5a4c), C(0x4f5a52), C(0x6c625a)];
const CONCRETE = [C(0xa8a49a), C(0x9a978e), C(0xb2aea4)];
const WINDOW_FRAME = C(0xdcd8cc);
const GLASS = C(0x2c3338);
const DOOR = [C(0x4a3a2c), C(0x3e4a3e), C(0x5a4636)];
const SHOP_SIGN = [C(0x2a4f9a), C(0x9a2a2a), C(0x2a6a5a)];
const KERB = C(0x9c9a94);
const ROAD_PAINT = C(0xd6d4c8);
const POLE_WOOD = C(0x5e5246);
const WIRE = C(0x2a2a2a);
const GUARDRAIL = C(0xa8adae);
const BIN_COLORS = [C(0x3f6a3a), C(0xc8a83a), C(0x3a5a8a), C(0x7a7c7a)];
const SIGN_RED = C(0xc0261e);
const SIGN_WHITE = C(0xf0f0ea);
const SIGN_BLACK = C(0x1e1e1e);
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
  private readonly discGeo: THREE.BufferGeometry;

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
    // A flat disc facing ±Z (road signs).
    this.discGeo = new THREE.CylinderGeometry(1, 1, 1, 16).rotateX(Math.PI / 2);
  }

  dispose(): void {
    for (const g of [
      this.trunkGeo, this.canopyGeo, this.coneGeo, this.bushGeo,
      this.boxGeo, this.leafGeo, this.tuftGeo, this.farConeGeo, this.farBlobGeo, this.roofGeo, this.pyramidGeo, this.discGeo,
    ]) g.dispose();
    this.flatMat.dispose();
    this.leafMat.dispose();
    this.tuftMat.dispose();
  }

  // ---------------------------------------------------------------------------

  /** True inside the walled-off area around a gorge (plus `margin` metres), where nothing grows. */
  private inGorge(x: number, z: number, margin = 0): boolean {
    const g = this.terrain.gorgeNear(-z, GORGE.rim + margin);
    return g !== null && Math.abs(x - g.x) < GORGE.reach + margin;
  }

  private addCollider(chunk: number, c: Collider): void {
    const x = c.kind === 'capsule' || c.kind === 'wall' ? (c.ax + c.bx) / 2 : c.x;
    const z = c.kind === 'capsule' || c.kind === 'wall' ? (c.az + c.bz) / 2 : c.z;
    if (!this.inGorge(x, z)) this.colliders.add(chunk, c);
  }

  private place(
    batch: Batch,
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
    yaw: number,
    color: THREE.Color,
    tiltX = 0, tiltZ = 0,
  ): void {
    if (this.inGorge(x, z)) return;
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
    this.addCollider(chunk, { kind: 'cylinder', x, z, r: tr + 0.08, yTop: y + h, surface: SURFACES.trunk, blocksPlayer: true });
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
    this.addCollider(chunk, { kind: 'cylinder', x, z, r: tr + 0.08, yTop: y + h, surface: SURFACES.trunk, blocksPlayer: true });
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
    this.addCollider(chunk, { kind: 'cylinder', x, z, r: tr + 0.08, yTop: y + h, surface: SURFACES.trunk, blocksPlayer: true });
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
    this.addCollider(chunk, { kind: 'sphere', x, y: y + maxR * 0.45, z, r: colliderR, surface: SURFACES.bush, blocksPlayer: false });
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
      this.addCollider(chunk, { kind: 'cylinder', x, z, r: 0.1, yTop: y + 1, surface: SURFACES.post, blocksPlayer: true });
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
          this.addCollider(chunk, { kind: 'capsule', ax: prevX, ay: prevY + h, az: prevZ, bx: x, by: y + h, bz: z, r: 0.05, surface: SURFACES.post, blocksPlayer: false });
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
        this.addCollider(chunk, { kind: 'cylinder', x, z, r: 0.08, yTop: y + 1.8, surface: SURFACES.post, blocksPlayer: true });
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
            this.addCollider(chunk, { kind: 'sphere', x: bx, y: by + 0.8, z, r: 0.42, surface: SURFACES.bush, blocksPlayer: false });
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
      if (rng() < landscapeWeight(p, 'desert') + landscapeWeight(p, 'antarctic')) continue;
      // Only a few wet, dark leaves on the asphalt of the town.
      const town = landscapeWeight(p, 'town');
      if (town > 0 && rng() < town) {
        if (rng() < 0.75) continue;
        this.place(b.leaf, x, y, z, s, 1, s * rand(rng, 0.6, 1), rng() * 6.28, this.pickColor(CANOPY_COLORS.wetLeaf, rng, 0.1));
        continue;
      }
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
      // No grass in the snow; a few dry tufts only between the rocks of the rookery.
      if (biome === 'snowfield' || biome === 'shore' || (biome === 'rookery' && rng() < 0.8)) continue;
      const town = biome === 'townhouses' || biome === 'gardens' || biome === 'fallow';
      if (town) {
        // Winter grass beside the road, none on the pavement.
        d = rand(rng, ROAD.half + 0.4, 30);
        if (biome === 'townhouses' && (d < ROAD.half + 2.6 || rng() < 0.5)) continue;
      }
      const dry = biome === 'phrygana' || biome === 'olive' || biome === 'stubble' || biome === 'farmstead'
        || biome === 'dunes' || biome === 'blackdesert' || biome === 'ruins' || biome === 'rookery';
      const x = this.terrain.pathCenterX(p) + side * d;
      const z = -p;
      const y = this.terrain.groundHeight(x, z) - 0.02;
      const s = rand(rng, 0.05, 0.1);
      const h = rand(rng, 0.14, 0.3);
      const palette = town ? CANOPY_COLORS.winterTuft : dry ? CANOPY_COLORS.dryTuft : CANOPY_COLORS.tuft;
      this.place(b.tuft, x, y, z, s, h * (town ? 1.3 : 1), s, rng() * 6.28, this.pickColor(palette, rng, 0.12), rand(rng, -0.25, 0.25), rand(rng, -0.25, 0.25));
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
        if (rng() < landscapeWeight(-z, 'antarctic')) {
          // Ice floes and the odd iceberg drifting on the sea.
          if (rng() < 0.8) continue;
          const y = this.terrain.groundHeight(x, z);
          if (y > this.terrain.seaLevel(-z) + 0.05) continue;
          const berg = rng() < 0.25;
          const s = berg ? rand(rng, 2, 6) : rand(rng, 1.5, 5);
          this.place(ax < 100 ? b.farBlob : b.farBlobLod, x, y - (berg ? s * 0.2 : 0.05), z, s * rand(rng, 0.8, 1.4), berg ? s * rand(rng, 0.6, 1.1) : 0.25, s, rng() * 6.28, this.pickColor(ICE, rng, 0.04));
          continue;
        }
        if (rng() < landscapeWeight(-z, 'town')) {
          // Leafless woods, a few dark firs and the odd house in the fields.
          if (rng() < 0.35) continue;
          const y = this.terrain.groundHeight(x, z) - 0.4;
          const r = rng();
          if (r < 0.05 && ax < 170) {
            const w = rand(rng, 6, 10);
            const h = rand(rng, 4, 7);
            const yaw = rng() * 6.28;
            this.place(b.box, x, y, z, w, h, w * rand(rng, 0.7, 1.2), yaw, this.pickColor(rng() < 0.5 ? PLASTER : PLANKS, rng, 0.08));
            this.place(b.roof, x, y + h, z, w + 0.6, rand(rng, 2, 3), w * 1.3, yaw, this.pickColor(METAL_ROOF, rng, 0.08));
          } else if (r < 0.3) {
            const h = rand(rng, 8, 14);
            this.place(b.farCone, x, y, z, h * 0.26, h, h * 0.26, rng() * 6.28, this.pickColor(CANOPY_COLORS.fir, rng, 0.12));
          } else if (ax > 60) {
            // Bare crowns: a pale, grey-brown haze of branches in the distance.
            const s = rand(rng, 2.5, 4.5) * (1 + smoothstep(150, 300, ax) * 0.5);
            this.place(ax < 100 ? b.farBlob : b.farBlobLod, x, y + s * 1.1, z, s * 0.8, s * 1.1, s * 0.8, rng() * 6.28, this.pickColor(CANOPY_COLORS.farTown, rng, 0.08));
          } else {
            const h = rand(rng, 7, 11);
            this.place(b.trunk, x, y, z, 0.25, h, 0.25, 0, this.pickColor(BARK, rng));
            this.place(b.farCone, x, y + h * 0.35, z, h * 0.18, h * 0.75, h * 0.18, rng() * 6.28, this.pickColor(CANOPY_COLORS.farTown, rng, 0.08));
          }
          continue;
        }
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
    this.addCollider(chunk, { kind: 'cylinder', x, z, r: tr + 0.08, yTop: y + h, surface: SURFACES.trunk, blocksPlayer: true });
  }

  /** A slim, dark Mediterranean cypress. */
  private addCypress(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const y = this.terrain.groundHeight(x, z) - 0.1;
    const h = rand(rng, 5, 9);
    const r = h * rand(rng, 0.09, 0.12);
    this.place(b.trunk, x, y, z, 0.15, 1.0, 0.15, 0, this.pickColor(TRUNK_COLORS, rng));
    this.place(b.canopy, x, y + 0.4 + h * 0.5, z, r, h * 0.5, r, rng() * 6.28, this.pickColor(CANOPY_COLORS.cypress, rng));
    this.addCollider(chunk, { kind: 'cylinder', x, z, r: 0.3, yTop: y + h, surface: SURFACES.bush, blocksPlayer: true });
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
    this.addCollider(chunk, { kind: 'sphere', x, y, z, r: r * 0.95, surface: SURFACES.stone, blocksPlayer: r > 0.35 });
    const extra = Math.floor(rng() * 3);
    for (let k = 0; k < extra; k++) {
      const a = rng() * Math.PI * 2;
      const rs = r * rand(rng, 0.3, 0.55);
      const sx = this.clearOfLane(x + Math.cos(a) * r * 1.3, z, rs);
      const sz = z + Math.sin(a) * r * 1.3;
      const sy = this.terrain.groundHeight(sx, sz) + rs * 0.2;
      this.place(b.rock, sx, sy, sz, rs * 1.2, rs * 0.8, rs, rng() * 6.28, this.pickColor(colors, rng, 0.05));
      this.addCollider(chunk, { kind: 'sphere', x: sx, y: sy, z: sz, r: rs * 0.95, surface: SURFACES.stone, blocksPlayer: false });
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
        this.addCollider(chunk, { kind: 'capsule', ax, ay, az: -p, bx, by, bz: -(p + step), r: 0.32, surface: SURFACES.stone, blocksPlayer: false });
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
        if (Math.abs(x) > CFG.chunk.halfWidth - 1.5 || this.inGorge(x, z, 2.5)) continue;
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
      this.addCollider(chunk, { kind: 'cylinder', x: cx, z: cz, r: dep / 2, yTop: y0 + wallH, surface: SURFACES.stone, blocksPlayer: true });
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
      this.addCollider(chunk, { kind: 'cylinder', x: bx, z: bz, r: 0.45, yTop: y + 0.42, surface: SURFACES.bush, blocksPlayer: true });
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
    this.addCollider(chunk, { kind: 'cylinder', x, z, r: 0.3, yTop: y0 + h, surface: SURFACES.trunk, blocksPlayer: true });
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
      this.addCollider(chunk, { kind: 'cylinder', x: wx, z: wz, r: 0.6, yTop: y + hh, surface: SURFACES.stone, blocksPlayer: true });
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
      this.addCollider(chunk, { kind: 'cylinder', x: mx, z: mz, r: rl / 2, yTop: y + hh, surface: SURFACES.stone, blocksPlayer: true });
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
    this.addCollider(chunk, { kind: 'cylinder', x, z, r: r + 0.05, yTop: y + h, surface: SURFACES.stone, blocksPlayer: true });
  }

  /** A fallen sandstone block, half sunk into the sand. */
  private addBlock(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const s = rand(rng, 0.5, 1.1);
    x = this.clearOfLane(x, z, s * 0.8);
    const y = this.terrain.groundHeight(x, z) - s * 0.25;
    this.place(b.box, x, y, z, s * rand(rng, 1, 1.6), s * rand(rng, 0.6, 0.9), s, rng() * 6.28, this.pickColor(SANDSTONE, rng, 0.05), rand(rng, -0.15, 0.15), rand(rng, -0.15, 0.15));
    this.addCollider(chunk, { kind: 'cylinder', x, z, r: s * 0.6, yTop: y + s * 0.8, surface: SURFACES.stone, blocksPlayer: s > 0.6 });
  }

  /** A dark, cone-shaped hill of the black desert. */
  private addBasaltCone(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const r = rand(rng, 2, 4.5);
    const h = r * rand(rng, 0.6, 0.9);
    const y = this.terrain.groundHeight(x, z) - 0.4;
    this.place(b.cone, x, y, z, r, h, r, rng() * 6.28, this.pickColor(BASALT, rng, 0.06));
    this.addCollider(chunk, { kind: 'cylinder', x, z, r: r * 0.7, yTop: y + h * 0.6, surface: SURFACES.stone, blocksPlayer: true });
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
  // Antarctica

  /**
   * A gentoo penguin, about 0.75 m tall: black back, white belly, orange beak
   * and feet. It faces `yaw`. With a collider when it stands near the track.
   */
  private addPenguin(b: Batches, chunk: number, x: number, z: number, yaw: number, rng: Rng, collider: boolean): void {
    const y = this.terrain.groundHeight(x, z);
    const s = rand(rng, 0.85, 1.1);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const lean = rand(rng, -0.12, 0.08);
    const black = this.pickColor(PENGUIN_BLACK, rng, 0.05).clone();
    const orange = this.pickColor(PENGUIN_ORANGE, rng, 0.04).clone();
    this.place(b.bush, x, y + 0.32 * s, z, 0.19 * s, 0.32 * s, 0.18 * s, yaw, black, lean);
    this.place(b.bush, x + fx * 0.055 * s, y + 0.29 * s, z + fz * 0.055 * s, 0.155 * s, 0.26 * s, 0.14 * s, yaw, PENGUIN_WHITE, lean);
    const hy = y + 0.66 * s;
    const hx = x + fx * 0.02 * s;
    const hz = z + fz * 0.02 * s;
    this.place(b.bush, hx, hy, hz, 0.115 * s, 0.11 * s, 0.12 * s, yaw, black);
    // White patches above the eyes.
    for (const side of [-1, 1]) {
      this.place(b.bush, hx + rx * side * 0.08 * s + fx * 0.04 * s, hy + 0.04 * s, hz + rz * side * 0.08 * s + fz * 0.04 * s, 0.03 * s, 0.022 * s, 0.035 * s, yaw, PENGUIN_WHITE);
    }
    this.place(b.box, hx + fx * 0.11 * s, hy - 0.035 * s, hz + fz * 0.11 * s, 0.035 * s, 0.035 * s, 0.11 * s, yaw, orange, 0.15);
    // Flippers held a little away from the body.
    for (const side of [-1, 1]) {
      this.place(b.box, x + rx * side * 0.18 * s, y + 0.5 * s, z + rz * side * 0.18 * s, 0.025 * s, 0.3 * s, 0.09 * s, yaw, black, Math.PI, -side * rand(rng, 0.2, 0.55));
      this.place(b.box, x + rx * side * 0.06 * s + fx * 0.06 * s, y, z + rz * side * 0.06 * s + fz * 0.06 * s, 0.07 * s, 0.03 * s, 0.11 * s, yaw + side * 0.25, orange);
    }
    if (collider) this.colliders.add(chunk, { kind: 'cylinder', x, z, r: 0.2 * s, yTop: y + 0.7 * s, surface: SURFACES.fur, blocksPlayer: true });
  }

  /** A few penguins standing together, roughly facing the same way. */
  private addPenguinGroup(b: Batches, chunk: number, x: number, z: number, count: number, spread: number, rng: Rng, collider: boolean): void {
    const yaw0 = rng() * Math.PI * 2;
    const cx = this.terrain.pathCenterX(-z);
    for (let k = 0; k < count; k++) {
      const a = rng() * Math.PI * 2;
      const r = spread * Math.sqrt(rng());
      let px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      // Never on the lane.
      const d = px - cx;
      const minD = CFG.path.halfWidth + 0.45;
      if (Math.abs(d) < minD) px = cx + (d < 0 ? -1 : 1) * minD;
      if (this.terrain.groundHeight(px, pz) < this.terrain.seaLevel(-pz) + 0.15) continue;
      this.addPenguin(b, chunk, px, pz, yaw0 + rand(rng, -0.9, 0.9), rng, collider && Math.abs(px - cx) < 7);
    }
  }

  /** A dark rock with a cap of snow. */
  private addSnowyRock(b: Batches, chunk: number, x: number, z: number, rng: Rng, scale = 1): void {
    const r = rand(rng, 0.3, 0.9) * scale;
    x = this.clearOfLane(x, z, r * 1.3);
    const y = this.terrain.groundHeight(x, z) + r * 0.15;
    const sx = r * rand(rng, 1.0, 1.4);
    const sy = r * rand(rng, 0.6, 0.95);
    const sz = r * rand(rng, 1.0, 1.3);
    const yaw = rng() * 6.28;
    this.place(b.rock, x, y, z, sx, sy, sz, yaw, this.pickColor(DARK_ROCK, rng, 0.05), rand(rng, -0.2, 0.2), rand(rng, -0.2, 0.2));
    if (rng() < 0.75) this.place(b.bush, x, y + sy * 0.62, z, sx * 0.75, sy * 0.32, sz * 0.75, yaw, this.pickColor(SNOW_CAP, rng, 0.02));
    this.colliders.add(chunk, { kind: 'sphere', x, y, z, r: r * 0.95, surface: SURFACES.stone, blocksPlayer: r > 0.35 });
  }

  /** A block of ice floating in the water by the shore. */
  private addIceberg(b: Batches, x: number, z: number, rng: Rng): void {
    const sea = this.terrain.seaLevel(-z);
    const s = rand(rng, 0.6, 2.2);
    const flat = rng() < 0.6;
    this.place(b.rock, x, sea - (flat ? 0.04 : s * 0.25), z, s * rand(rng, 1, 1.6), flat ? rand(rng, 0.12, 0.25) : s * rand(rng, 0.6, 1.0), s, rng() * 6.28, this.pickColor(ICE, rng, 0.03));
  }

  /**
   * An orange research lab on stilts, like a container: teal window band,
   * solar panels and an antenna on the roof, a small wind turbine beside it.
   */
  private addResearchLab(b: Batches, chunk: number, x: number, z: number, side: Side, rng: Rng): void {
    const yaw = this.terrain.pathHeading(-z) + rand(rng, -0.25, 0.25);
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    // Local ox across the track, oz along it (see addHouse).
    const world = (ox: number, oz: number): [number, number] => [x + ox * c + oz * sn, z - ox * sn + oz * c];
    const len = 4.4;
    const dep = 2.5;
    let lo = Infinity;
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const [wx, wz] = world((ox * dep) / 2, (oz * len) / 2);
      lo = Math.min(lo, this.terrain.groundHeight(wx, wz));
    }
    const legH = 1.3;
    const orange = this.pickColor(RESEARCH_ORANGE, rng, 0.03).clone();
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const [lx, lz] = world(ox * (dep / 2 - 0.3), oz * (len / 2 - 0.45));
      const gy = this.terrain.groundHeight(lx, lz) - 0.1;
      this.place(b.box, lx, gy, lz, 0.5, 0.12, 0.6, yaw, RESEARCH_BLACK);
      this.place(b.box, lx, gy, lz, 0.2, lo + legH - gy + 0.1, 0.2, yaw, RESEARCH_GREY);
      this.place(b.cone, lx, gy + 0.1, lz, 0.22, 0.45, 0.22, yaw, RESEARCH_BLACK);
    }
    const y0 = lo + legH;
    this.place(b.box, x, y0, z, dep - 0.2, 0.3, len - 0.3, yaw, RESEARCH_NAVY);
    this.place(b.box, x, y0 + 0.3, z, dep, 1.9, len, yaw, orange);
    this.place(b.box, x, y0 + 2.2, z, dep + 0.12, 0.14, len + 0.12, yaw, this.col.copy(orange).multiplyScalar(1.08));
    // White frame and teal window band on the side facing the track, a white door on the end.
    const face = -side * (dep / 2 + 0.01);
    const [fx, fz] = world(face, 0.4);
    this.place(b.box, fx, y0 + 0.75, fz, 0.06, 1.0, 2.2, yaw, RESEARCH_WHITE);
    this.place(b.box, fx - side * 0.02 * c, y0 + 0.88, fz + side * 0.02 * sn, 0.06, 0.72, 1.9, yaw, RESEARCH_GLASS);
    const [sx, sz] = world(face, -1.5);
    this.place(b.box, sx, y0 + 0.5, sz, 0.06, 1.25, 0.65, yaw, RESEARCH_TEAL);
    const [ex, ez] = world(0, len / 2 + 0.01);
    this.place(b.box, ex, y0 + 0.4, ez, 0.9, 1.5, 0.06, yaw, RESEARCH_WHITE);
    // Solar panels and an antenna on the roof.
    for (const t of [-0.6, 0.6]) {
      const [px, pz] = world(side * 0.3, t);
      this.place(b.box, px, y0 + 2.3, pz, 0.08, 0.35, 0.08, yaw, RESEARCH_GREY);
      this.place(b.box, px, y0 + 2.6, pz, 1.0, 0.05, 0.75, yaw, SOLAR, 0, -side * 0.5);
    }
    const [ax, az] = world(side * 0.9, -len / 2 + 0.3);
    this.place(b.box, ax, y0 + 2.3, az, 0.05, 2.4, 0.05, yaw, RESEARCH_BLACK);
    // Wind turbine on a pole beside the lab.
    const [tx, tz] = world(side * (dep / 2 + 1.0), -len / 2 - 0.6);
    const ty = this.terrain.groundHeight(tx, tz) - 0.1;
    const poleH = 5.2;
    this.place(b.box, tx, ty, tz, 0.09, poleH, 0.09, yaw, RESEARCH_GREY);
    this.place(b.box, tx, ty + poleH - 0.1, tz, 0.16, 0.16, 0.4, yaw, RESEARCH_BLACK);
    const turn = rng() * Math.PI;
    for (let k = 0; k < 3; k++) {
      const [hx, hz] = world(0, 0.2);
      this.place(b.box, hx - x + tx, ty + poleH - 0.02, hz - z + tz, 0.12, 1.1, 0.03, yaw, RESEARCH_BLACK, 0, turn + (k * Math.PI * 2) / 3);
    }
    for (const t of [-1.1, 1.1]) {
      const [cx2, cz2] = world(0, t);
      this.colliders.add(chunk, { kind: 'cylinder', x: cx2, z: cz2, r: 1.35, yTop: y0 + 2.3, surface: SURFACES.post, blocksPlayer: true });
    }
    this.colliders.add(chunk, { kind: 'cylinder', x: tx, z: tz, r: 0.12, yTop: ty + poleH, surface: SURFACES.post, blocksPlayer: true });
  }

  /** An orange snowcat: black tracks, a cab with teal glass, a plough in front and a small crane. */
  private addSnowcat(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const yaw = rng() * Math.PI * 2;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const world = (ox: number, oz: number): [number, number] => [x + ox * c + oz * sn, z - ox * sn + oz * c];
    const y = this.terrain.groundHeight(x, z) - 0.08;
    const orange = this.pickColor(RESEARCH_ORANGE, rng, 0.03).clone();
    for (const sd of [-1, 1]) {
      const [tx, tz] = world(sd * 0.85, 0);
      this.place(b.box, tx, y, tz, 0.6, 0.72, 4.0, yaw, RESEARCH_BLACK);
      const [wx, wz] = world(sd * 1.16, 0);
      this.place(b.box, wx, y + 0.18, wz, 0.04, 0.34, 3.4, yaw, RESEARCH_GREY);
    }
    const [bx, bz] = world(0, -0.35);
    this.place(b.box, bx, y + 0.65, bz, 2.0, 0.85, 3.1, yaw, orange);
    this.place(b.box, bx, y + 0.95, bz, 2.03, 0.12, 3.12, yaw, RESEARCH_WHITE);
    // Cab with glass all round.
    const [kx, kz] = world(0, 0.75);
    this.place(b.box, kx, y + 1.5, kz, 1.9, 0.35, 1.4, yaw, orange);
    this.place(b.box, kx, y + 1.85, kz, 1.86, 0.62, 1.36, yaw, RESEARCH_GLASS);
    this.place(b.box, kx, y + 2.47, kz, 1.98, 0.14, 1.48, yaw, orange);
    const [lx, lz] = world(0, 1.3);
    this.place(b.box, lx, y + 2.61, lz, 1.2, 0.12, 0.14, yaw, RESEARCH_WHITE);
    // Plough with a teal edge.
    const [px, pz] = world(0, 2.35);
    this.place(b.box, px, y - 0.02, pz, 2.7, 0.75, 0.14, yaw, RESEARCH_BLACK, -0.25);
    this.place(b.box, px, y + 0.68, pz, 2.72, 0.12, 0.16, yaw, RESEARCH_TEAL, -0.25);
    // Crane arm behind the cab.
    const [cx2, cz2] = world(0.4, -0.9);
    this.place(b.box, cx2, y + 1.05, cz2, 0.16, 1.7, 0.16, yaw, RESEARCH_TEAL, 0.5);
    for (const t of [-1, 1]) {
      const [ox, oz] = world(0, t * 1.0);
      this.colliders.add(chunk, { kind: 'cylinder', x: ox, z: oz, r: 1.25, yTop: y + 2.6, surface: SURFACES.post, blocksPlayer: true });
    }
  }

  /** True when (x, z) is land a little above the Antarctic sea and not too steep. */
  private onLand(x: number, z: number, margin = 0.3): boolean {
    return this.terrain.groundHeight(x, z) > this.terrain.seaLevel(-z) + margin;
  }


  // ---------------------------------------------------------------------------
  // The small town in winter

  /** A leafless tree: trunk and a few long boughs with twigs; now and then a birch. */
  private addBareTree(b: Batches, chunk: number, x: number, z: number, rng: Rng, big = false): void {
    const y = this.terrain.groundHeight(x, z) - 0.15;
    const h = rand(rng, big ? 4.5 : 3, big ? 7 : 5);
    const tr = rand(rng, 0.13, 0.24) * (big ? 1.35 : 1);
    const birch = rng() < 0.2;
    const bark = birch ? this.col.copy(BIRCH).multiplyScalar(rand(rng, 0.92, 1.02)).clone() : this.pickColor(BARK, rng).clone();
    this.place(b.trunk, x, y, z, tr, h + 0.4, tr, rng() * 6.28, bark);
    const boughs = 4 + Math.floor(rng() * 3);
    for (let k = 0; k < boughs; k++) {
      const yaw = (k / boughs) * Math.PI * 2 + rand(rng, -0.4, 0.4);
      const tilt = rand(rng, 0.45, 0.95);
      const by = y + h * rand(rng, 0.45, 0.95);
      const len = h * rand(rng, 0.35, 0.6);
      const r = tr * rand(rng, 0.35, 0.5);
      this.place(b.trunk, x, by, z, r, len, r, yaw, bark, tilt);
      // Its end (local up after the tilt, then the yaw).
      const ex = x + Math.sin(yaw) * Math.sin(tilt) * len;
      const ey = by + Math.cos(tilt) * len;
      const ez = z + Math.cos(yaw) * Math.sin(tilt) * len;
      for (let t = 0; t < 2; t++) {
        this.place(b.trunk, ex, ey - 0.05, ez, r * 0.45, len * rand(rng, 0.35, 0.6), r * 0.45, yaw + rand(rng, -1, 1), bark, rand(rng, 0.3, 1.1));
      }
    }
    this.addCollider(chunk, { kind: 'cylinder', x, z, r: tr + 0.08, yTop: y + h, surface: SURFACES.trunk, blocksPlayer: true });
  }

  /**
   * A pitched roof: two sloping sheets on gable walls in the wall colour.
   * Local x across (width dep), local z along the ridge (length len).
   */
  private addGableRoof(b: Batches, x: number, z: number, yaw: number, dep: number, len: number, yTop: number, rh: number, roof: THREE.Color, wall: THREE.Color): void {
    this.place(b.roof, x, yTop - 0.02, z, dep, rh, len, yaw, wall);
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const over = 0.35;
    const half = dep / 2 + over;
    const theta = Math.atan2(rh, dep / 2);
    const w = half / Math.cos(theta);
    for (const s of [-1, 1]) {
      // Mid-point of the sheet between the eave and the ridge.
      const ox = (s * half) / 2;
      const oy = yTop + rh - (rh / (dep / 2)) * (half / 2);
      this.place(b.box, x + ox * c, oy, z - ox * sn, w + 0.05, 0.08, len + 0.5, yaw, roof, 0, -s * theta);
    }
  }

  /** Ground heights under the corners of a footprint (local ox across, oz along). */
  private footprint(world: (ox: number, oz: number) => [number, number], dep: number, len: number): { lo: number; hi: number } {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const [wx, wz] = world((ox * dep) / 2, (oz * len) / 2);
      const gh = this.terrain.groundHeight(wx, wz);
      lo = Math.min(lo, gh);
      hi = Math.max(hi, gh);
    }
    return { lo, hi };
  }

  /** A window with a pale frame and dark glass on a wall whose face lies at local ox = face. */
  private addWindow(b: Batches, world: (ox: number, oz: number) => [number, number], yaw: number, face: number, oz: number, y: number, w: number, h: number, alongZ = true): void {
    const out = Math.sign(face) || 1;
    const [fx, fz] = alongZ ? world(face + out * 0.02, oz) : world(oz, face + out * 0.02);
    const [gx, gz] = alongZ ? world(face + out * 0.05, oz) : world(oz, face + out * 0.05);
    if (alongZ) {
      this.place(b.box, fx, y - h / 2, fz, 0.06, h, w, yaw, WINDOW_FRAME);
      this.place(b.box, gx, y - h / 2 + 0.09, gz, 0.04, h - 0.18, w - 0.18, yaw, GLASS);
    } else {
      this.place(b.box, fx, y - h / 2, fz, w, h, 0.06, yaw, WINDOW_FRAME);
      this.place(b.box, gx, y - h / 2 + 0.09, gz, w - 0.18, h - 0.18, 0.04, yaw, GLASS);
    }
  }

  /** Colliders for a box-shaped building: a row of cylinders along it. */
  private addBuildingColliders(chunk: number, world: (ox: number, oz: number) => [number, number], dep: number, len: number, yTop: number): void {
    const n = Math.ceil(len / dep) + 1;
    for (let k = 0; k < n; k++) {
      const [cx, cz] = world(0, -len / 2 + dep / 2 + ((len - dep) * k) / Math.max(1, n - 1));
      this.addCollider(chunk, { kind: 'cylinder', x: cx, z: cz, r: dep / 2, yTop, surface: SURFACES.stone, blocksPlayer: true });
    }
  }

  /**
   * A two or three storey town house of brick or plaster right behind the
   * pavement: rows of white windows, a door, sometimes a shop sign, a metal roof.
   */
  private addTownHouse(b: Batches, chunk: number, x: number, z: number, side: Side, len: number, dep: number, rng: Rng): void {
    const yaw = this.terrain.pathHeading(-z) + rand(rng, -0.04, 0.04);
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const world = (ox: number, oz: number): [number, number] => [x + ox * c + oz * sn, z - ox * sn + oz * c];
    const floors = rng() < 0.55 ? 2 : 3;
    const fh = 3.0;
    const { lo, hi } = this.footprint(world, dep, len);
    const y0 = lo - 0.3;
    const top = hi + floors * fh + 0.3;
    const brick = rng() < 0.55;
    const wall = this.pickColor(brick ? BRICK : PLASTER, rng, 0.05).clone();
    this.place(b.box, x, y0, z, dep, top - y0, len, yaw, wall);
    // A darker plinth and a pale cornice under the roof.
    this.place(b.box, x, y0, z, dep + 0.08, hi - y0 + 0.65, len + 0.08, yaw, this.col.copy(wall).multiplyScalar(0.72));
    this.place(b.box, x, top - 0.3, z, dep + 0.3, 0.3, len + 0.3, yaw, brick ? BRICK_LIGHT : this.col.copy(wall).multiplyScalar(1.12));
    this.addGableRoof(b, x, z, yaw, dep + 0.3, len + 0.3, top, rand(rng, 1.8, 2.6), this.pickColor(METAL_ROOF, rng, 0.06).clone(), wall);
    // A chimney.
    const [chx, chz] = world(rand(rng, -dep * 0.2, dep * 0.2), rand(rng, -len * 0.3, len * 0.3));
    this.place(b.box, chx, top, chz, 0.5, 2.4, 0.6, yaw, brick ? wall : this.pickColor(BRICK, rng, 0.05));
    // Windows on the side facing the road, a door among them.
    const face = -side * (dep / 2);
    const n = Math.max(2, Math.floor((len - 1) / 2.4));
    const door = Math.floor(rng() * n);
    for (let f = 0; f < floors; f++) {
      for (let k = 0; k < n; k++) {
        const oz = -len / 2 + (len * (k + 0.5)) / n;
        if (f === 0 && k === door) {
          const [dx, dz] = world(face - side * 0.03, oz);
          this.place(b.box, dx, hi - 0.05, dz, 0.08, 2.2, 1.1, yaw, this.pickColor(DOOR, rng, 0.06));
          continue;
        }
        const wy = hi + f * fh + 1.85;
        this.addWindow(b, world, yaw, face, oz, wy, 1.0, 1.45);
        if (brick) {
          const [lx, lz] = world(face - side * 0.03, oz);
          this.place(b.box, lx, wy + 0.02, lz, 0.08, 0.18, 1.25, yaw, BRICK_LIGHT);
        }
      }
    }
    // Windows on the gable end the player walks towards.
    for (let f = 0; f < floors; f++) {
      for (const t of [-0.25, 0.25]) this.addWindow(b, world, yaw, len / 2, t * dep, hi + f * fh + 1.85, 1.0, 1.45, false);
    }
    // Now and then a shop with a sign over the ground floor.
    if (rng() < 0.3) {
      const [sx, sz] = world(face - side * 0.08, 0);
      this.place(b.box, sx, hi + 2.55, sz, 0.1, 0.55, len * rand(rng, 0.45, 0.7), yaw, this.pickColor(SHOP_SIGN, rng, 0.05));
      const letters = 4 + Math.floor(rng() * 4);
      for (let k = 0; k < letters; k++) {
        const [lx, lz] = world(face - side * 0.14, (k - (letters - 1) / 2) * 0.42);
        this.place(b.box, lx, hi + 2.67, lz, 0.03, 0.3, 0.26, yaw, WINDOW_FRAME);
      }
    }
    this.addBuildingColliders(chunk, world, dep, len, top);
  }

  /**
   * A one-storey wooden village house on a concrete plinth: painted planks,
   * white windows, a metal roof, sometimes a TV aerial.
   */
  private addWoodHouse(b: Batches, chunk: number, x: number, z: number, side: Side, rng: Rng): void {
    const yaw = this.terrain.pathHeading(-z) + rand(rng, -0.12, 0.12);
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const world = (ox: number, oz: number): [number, number] => [x + ox * c + oz * sn, z - ox * sn + oz * c];
    const len = rand(rng, 7, 10);
    const dep = rand(rng, 5, 6.5);
    const { lo, hi } = this.footprint(world, dep, len);
    const y0 = lo - 0.3;
    const plinth = hi + 0.6;
    const top = plinth + rand(rng, 2.5, 2.9);
    const planks = this.pickColor(PLANKS, rng, 0.06).clone();
    this.place(b.box, x, y0, z, dep + 0.1, plinth - y0, len + 0.1, yaw, this.pickColor(CONCRETE, rng, 0.04));
    this.place(b.box, x, plinth, z, dep, top - plinth, len, yaw, planks);
    // Vertical battens on the side facing the road.
    const face = -side * (dep / 2);
    const dark = this.col.copy(planks).multiplyScalar(0.75).clone();
    for (let oz = -len / 2 + 0.4; oz < len / 2; oz += 0.55) {
      const [bx, bz] = world(face - side * 0.015, oz);
      this.place(b.box, bx, plinth, bz, 0.03, top - plinth, 0.06, yaw, dark);
    }
    this.addGableRoof(b, x, z, yaw, dep, len, top, rand(rng, 1.6, 2.2), this.pickColor(METAL_ROOF, rng, 0.06).clone(), planks);
    const n = Math.max(2, Math.floor(len / 2.4));
    for (let k = 0; k < n; k++) this.addWindow(b, world, yaw, face, -len / 2 + (len * (k + 0.5)) / n, plinth + 1.95, 0.85, 1.25);
    this.addWindow(b, world, yaw, len / 2, 0, plinth + 1.9, 0.85, 1.2, false);
    this.addWindow(b, world, yaw, len / 2, 0, top + 1.0, 0.55, 0.6, false);
    // Door with a few concrete steps at the end facing away from the player.
    const [dx, dz] = world(rand(rng, -dep * 0.2, dep * 0.2), -len / 2 - 0.03);
    this.place(b.box, dx, plinth - 0.05, dz, 0.95, 2.05, 0.08, yaw, this.pickColor(DOOR, rng, 0.06));
    if (rng() < 0.5) {
      const [ax, az] = world(rand(rng, -1, 1), rand(rng, -1, 1));
      this.place(b.box, ax, top + 1, az, 0.04, 2.6, 0.04, yaw, WIRE);
      for (let k = 0; k < 3; k++) this.place(b.box, ax, top + 2.6 + k * 0.25, az, 1.2 - k * 0.25, 0.03, 0.03, yaw + 0.6, WIRE);
    }
    this.addBuildingColliders(chunk, world, dep, len, top);
  }

  /** A small wooden shed with a lean-to roof. */
  private addShed(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const yaw = this.terrain.pathHeading(-z) + rand(rng, -0.3, 0.3);
    const w = rand(rng, 2, 3);
    const l = rand(rng, 2.5, 3.5);
    const y = this.terrain.groundHeight(x, z) - 0.2;
    const h = rand(rng, 2, 2.4);
    this.place(b.box, x, y, z, w, h + 0.2, l, yaw, this.pickColor(PLANKS, rng, 0.1));
    this.place(b.box, x, y + h + 0.2, z, w + 0.4, 0.08, l + 0.4, yaw, this.pickColor(METAL_ROOF, rng, 0.08), 0.12);
    this.addCollider(chunk, { kind: 'cylinder', x, z, r: Math.min(w, l) / 2 + 0.2, yTop: y + h, surface: SURFACES.wood, blocksPlayer: true });
  }

  /** A row of concrete garages with metal doors facing the road. */
  private addGarages(b: Batches, chunk: number, x: number, z: number, side: Side, rng: Rng): void {
    const yaw = this.terrain.pathHeading(-z) + rand(rng, -0.08, 0.08);
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const world = (ox: number, oz: number): [number, number] => [x + ox * c + oz * sn, z - ox * sn + oz * c];
    const count = 2 + Math.floor(rng() * 3);
    const gw = 3.2;
    const dep = 6;
    const len = count * gw;
    const { lo, hi } = this.footprint(world, dep, len);
    const top = hi + 2.5;
    this.place(b.box, x, lo - 0.3, z, dep, top - lo + 0.3, len, yaw, this.pickColor(CONCRETE, rng, 0.04));
    this.place(b.box, x, top, z, dep + 0.3, 0.15, len + 0.2, yaw, this.pickColor(METAL_ROOF, rng, 0.05), 0, side * 0.04);
    const face = -side * (dep / 2 + 0.02);
    for (let k = 0; k < count; k++) {
      const [gx, gz] = world(face, -len / 2 + gw * (k + 0.5));
      this.place(b.box, gx, hi - 0.05, gz, 0.06, 2.15, gw - 0.6, yaw, this.pickColor(k % 2 ? DOOR : METAL_ROOF, rng, 0.1));
    }
    this.addBuildingColliders(chunk, world, dep, len, top);
  }

  /** Two to four wheelie containers in a row (green, yellow, blue, grey). */
  private addBins(b: Batches, chunk: number, x: number, z: number, rng: Rng): void {
    const yaw = this.terrain.pathHeading(-z) + rand(rng, -0.15, 0.15);
    const n = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const oz = (k - (n - 1) / 2) * 1.3;
      const bx = x + oz * Math.sin(yaw);
      const bz = z + oz * Math.cos(yaw);
      const y = this.terrain.groundHeight(bx, bz) - 0.05;
      const color = this.pickColor(BIN_COLORS, rng, 0.05).clone();
      this.place(b.box, bx, y, bz, 1.0, 1.15, 1.15, yaw + rand(rng, -0.1, 0.1), color);
      this.place(b.box, bx, y + 1.15, bz, 1.06, 0.08, 1.2, yaw, color.multiplyScalar(0.7), rand(rng, -0.1, 0.05));
      this.addCollider(chunk, { kind: 'cylinder', x: bx, z: bz, r: 0.62, yTop: y + 1.2, surface: SURFACES.metal, blocksPlayer: true });
    }
  }

  /** A round speed-limit sign (20) on a grey post beside the road, facing the player. */
  private addSign(b: Batches, chunk: number, x: number, z: number): void {
    const y = this.terrain.groundHeight(x, z) - 0.1;
    const yaw = this.terrain.pathHeading(-z);
    this.place(b.box, x, y, z, 0.06, 2.3, 0.06, yaw, GUARDRAIL);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    this.place(b.disc, x + fx * 0.05, y + 2.05, z + fz * 0.05, 0.32, 0.32, 0.03, yaw, SIGN_RED);
    this.place(b.disc, x + fx * 0.07, y + 2.05, z + fz * 0.07, 0.25, 0.25, 0.02, yaw, SIGN_WHITE);
    // "20": a 2 of three strokes and a black ring.
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const at = (o: number, f: number): [number, number] => [x + fx * f + rx * o, z + fz * f + rz * o];
    const [ax2, az2] = at(-0.07, 0.085);
    this.place(b.box, ax2, y + 2.1, az2, 0.08, 0.025, 0.01, yaw, SIGN_BLACK);
    this.place(b.box, ax2, y + 1.98, az2, 0.08, 0.025, 0.01, yaw, SIGN_BLACK);
    this.place(b.box, ax2, y + 1.995, az2, 0.02, 0.12, 0.01, yaw, SIGN_BLACK, 0, -0.75);
    const [ox, oz] = at(0.065, 0.08);
    this.place(b.disc, ox, y + 2.05, oz, 0.045, 0.07, 0.01, yaw, SIGN_BLACK);
    const [wx, wz] = at(0.065, 0.088);
    this.place(b.disc, wx, y + 2.05, wz, 0.025, 0.048, 0.01, yaw, SIGN_WHITE);
    this.addCollider(chunk, { kind: 'cylinder', x, z, r: 0.06, yTop: y + 2.3, surface: SURFACES.metal, blocksPlayer: true });
  }

  /** Spot of the utility pole with index k (one every 32 m on the side chosen per landscape section). */
  private poleAt(k: number): { p: number; x: number; z: number; side: Side } | null {
    const p = k * 32 + 4;
    if (landscapeAt(p) !== 'town' || landscapeWeight(p, 'town') < 0.5) return null;
    const side: Side = hash3(Math.floor(p / 1000), 3, this.terrain.seed + 101) < 0.5 ? -1 : 1;
    const x = this.terrain.pathCenterX(p) + side * (ROAD.half + 0.9);
    return { p, x, z: -p, side };
  }

  /** Wooden utility poles with sagging wires and a street lamp on every second one. */
  private addPoles(b: Batches, chunk: number, i: number): void {
    const { p0, p1 } = Terrain.chunkRange(i);
    for (let k = Math.ceil((p0 - 4) / 32); k * 32 + 4 < p1; k++) {
      const pole = this.poleAt(k);
      if (!pole) continue;
      const y = this.terrain.groundHeight(pole.x, pole.z) - 0.2;
      const H = 7.2;
      this.place(b.trunk, pole.x, y, pole.z, 0.13, H, 0.13, 0, POLE_WOOD);
      const yaw = this.terrain.pathHeading(pole.p);
      // Cross arm with insulators.
      this.place(b.box, pole.x, y + H - 0.45, pole.z, 1.3, 0.1, 0.1, yaw, POLE_WOOD);
      if (k % 2 === 0) {
        // A lamp on an arm out over the road.
        const rx = Math.cos(yaw) * -pole.side;
        const rz = -Math.sin(yaw) * -pole.side;
        this.place(b.box, pole.x + rx * 0.7, y + H - 1.3, pole.z + rz * 0.7, 0.06, 0.06, 1.5, yaw + Math.PI / 2, GUARDRAIL, 0.25);
        this.place(b.box, pole.x + rx * 1.4, y + H - 1.25, pole.z + rz * 1.4, 0.25, 0.12, 0.5, yaw + Math.PI / 2, WIRE);
      }
      this.addCollider(chunk, { kind: 'cylinder', x: pole.x, z: pole.z, r: 0.16, yTop: y + H, surface: SURFACES.post, blocksPlayer: true });
      const prev = this.poleAt(k - 1);
      if (!prev) continue;
      const py = this.terrain.groundHeight(prev.x, prev.z) - 0.2;
      for (const off of [-0.55, 0.55]) {
        const rx = Math.cos(yaw) * off;
        const rz = -Math.sin(yaw) * off;
        const ax = prev.x + rx;
        const az = prev.z + rz;
        const ay = py + H - 0.4;
        const bx = pole.x + rx;
        const bz = pole.z + rz;
        const by = y + H - 0.4;
        const len = Math.hypot(bx - ax, bz - az, by - ay);
        const wyaw = Math.atan2(bx - ax, bz - az);
        const tilt = Math.atan2(by - ay, Math.hypot(bx - ax, bz - az));
        // Two straight halves sagging to the middle.
        for (const h of [0.25, 0.75]) {
          const mx = ax + (bx - ax) * h;
          const mz = az + (bz - az) * h;
          const my = ay + (by - ay) * h - 0.35;
          const t = tilt + (h < 0.5 ? -1 : 1) * Math.atan2(0.7, len);
          this.place(b.box, mx, my, mz, 0.025, 0.025, len / 2 + 0.05, wyaw, WIRE, -t, 0);
        }
      }
    }
  }

  /** White dashes along the middle of the road and kerbs along the pavements. */
  private addRoadMarkings(b: Batches, i: number): void {
    const { p0, p1 } = Terrain.chunkRange(i);
    for (let p = Math.ceil(p0 / 6) * 6 + 1.5; p < p1; p += 6) {
      if (landscapeWeight(p, 'town') < 0.6) continue;
      const pa = p - 1.3;
      const pb = p + 1.3;
      const ax = this.terrain.pathCenterX(pa);
      const bx = this.terrain.pathCenterX(pb);
      const ay = this.terrain.groundHeight(ax, -pa);
      const by = this.terrain.groundHeight(bx, -pb);
      const yaw = Math.atan2(bx - ax, -pb + pa);
      const tilt = Math.atan2(by - ay, Math.hypot(bx - ax, pb - pa));
      this.place(b.box, (ax + bx) / 2, (ay + by) / 2 - 0.012, -p, 0.12, 0.02, 2.6, yaw, ROAD_PAINT, -tilt, 0);
    }
    for (const side of [-1, 1] as Side[]) {
      for (let p = Math.ceil(p0 / 2) * 2 + 1; p < p1; p += 2) {
        if (landscapeWeight(p, 'town') < 0.6 || this.terrain.biomeAt(p, side) !== 'townhouses') continue;
        const pa = p - 1;
        const pb = p + 1;
        const d = side * (ROAD.half + 0.07);
        const ax = this.terrain.pathCenterX(pa) + d;
        const bx = this.terrain.pathCenterX(pb) + d;
        const ay = this.terrain.groundHeight(this.terrain.pathCenterX(pa) + side * ROAD.half, -pa);
        const by = this.terrain.groundHeight(this.terrain.pathCenterX(pb) + side * ROAD.half, -pb);
        const yaw = Math.atan2(bx - ax, -pb + pa);
        const tilt = Math.atan2(by - ay, Math.hypot(bx - ax, pb - pa));
        this.place(b.box, (ax + bx) / 2, (ay + by) / 2 - 0.08, -p, 0.16, 0.22, 2.02, yaw, KERB, -tilt, 0);
      }
    }
  }

  /** Whether the guard rail runs along the road at progress p on this side (on the fallow stretches). */
  private railAt(p: number, side: Side): boolean {
    if (this.terrain.biomeAt(p, side) !== 'fallow' || landscapeWeight(p, 'town') < 0.6) return false;
    return hash3(Math.floor(p / 100), side, this.terrain.seed + 103) < 0.6;
  }

  /** A galvanised guard rail on short posts: it bounces the apple, the player climbs over. */
  private addGuardRail(b: Batches, chunk: number, i: number, side: Side): void {
    const { p0, p1 } = Terrain.chunkRange(i);
    const step = 2;
    const d = side * (ROAD.half + 0.6);
    for (let p = Math.ceil(p0 / step) * step; p < p1 - 1e-6; p += step) {
      if (!this.railAt(p, side)) continue;
      const x = this.terrain.pathCenterX(p) + d;
      const z = -p;
      const y = this.terrain.groundHeight(x, z);
      this.place(b.box, x, y - 0.2, z, 0.1, 0.9, 0.1, 0, GUARDRAIL);
      if (!this.railAt(p + step, side)) continue;
      const nx = this.terrain.pathCenterX(p + step) + d;
      const nz = -(p + step);
      const ny = this.terrain.groundHeight(nx, nz);
      const yaw = Math.atan2(nx - x, nz - z);
      const tilt = Math.atan2(ny - y, Math.hypot(nx - x, nz - z));
      const len = Math.hypot(nx - x, nz - z, ny - y);
      this.place(b.box, (x + nx) / 2 - side * 0.06, (y + ny) / 2 + 0.42, (z + nz) / 2, 0.05, 0.3, len + 0.02, yaw, GUARDRAIL, -tilt, 0);
      this.addCollider(chunk, { kind: 'capsule', ax: x, ay: y + 0.57, az: z, bx: nx, by: ny + 0.57, bz: nz, r: 0.15, surface: SURFACES.metal, blocksPlayer: false });
    }
  }

  /**
   * A fence of grey, weathered boards along the gardens. Like the meadow
   * fences it bounces the apple, but the player can climb through.
   */
  private addBoardFence(b: Batches, chunk: number, i: number, side: Side): void {
    const { p0, p1 } = Terrain.chunkRange(i);
    const step = 2.4;
    const d = side * 4.6;
    for (let p = Math.ceil(p0 / step) * step; p < p1 - 1e-6; p += step) {
      if (this.terrain.biomeAt(p, side) !== 'gardens' || landscapeWeight(p, 'town') < 0.6) continue;
      const rng = mulberry32(subSeed(this.terrain.seed, 2300 + Math.round(p / step), side + 2));
      // Gaps for gates and fallen panels.
      if (rng() < 0.15) continue;
      const pa = p;
      const pb = p + step;
      const ax = this.terrain.pathCenterX(pa) + d;
      const bx = this.terrain.pathCenterX(pb) + d;
      const ay = this.terrain.groundHeight(ax, -pa);
      const by = this.terrain.groundHeight(bx, -pb);
      const yaw = Math.atan2(bx - ax, -pb + pa);
      const h = rand(rng, 1.4, 1.7);
      const lean = rand(rng, -0.06, 0.06);
      const color = this.pickColor(PLANKS.slice(2, 3).concat(PLANKS.slice(5)), rng, 0.12).clone().lerp(C(0x7a7670), 0.4);
      this.place(b.box, ax, ay - 0.1, -pa, 0.1, h + 0.15, 0.1, yaw, POLE_WOOD);
      // Boards with narrow gaps.
      const boards = 12;
      for (let k = 0; k < boards; k++) {
        if (rng() < 0.05) continue;
        const t = (k + 0.5) / boards;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        this.place(b.box, x, y - 0.05, -(pa + (pb - pa) * t), 0.025, h * rand(rng, 0.94, 1.03), (step / boards) * 0.82, yaw, color, lean);
      }
      for (const hh of [0.35, 0.95]) {
        this.addCollider(chunk, { kind: 'capsule', ax, ay: ay + hh, az: -pa, bx, by: by + hh, bz: -pb, r: 0.3, surface: SURFACES.wood, blocksPlayer: false });
      }
    }
  }

  /**
   * Slot-placed buildings of the town (on global grids so rows continue across
   * chunks): town houses along the pavement, wooden houses in the gardens,
   * garages on the fallow land.
   */
  private addTownBuildings(b: Batches, chunk: number, i: number, side: Side, placed: Array<[number, number, number]>): void {
    const { p0, p1 } = Terrain.chunkRange(i);
    const seed = this.terrain.seed;
    // Town houses: one slot every 13 m.
    for (let k = Math.floor(p0 / 13) - 1; k * 13 < p1 + 13; k++) {
      const rng = mulberry32(subSeed(seed, 2500 + k, side + 2));
      const len = rand(rng, 8.5, 11.5);
      const hp = k * 13 + 6.5 + rand(rng, -0.8, 0.8);
      if (hp < p0 || hp >= p1 || this.terrain.biomeAt(hp, side) !== 'townhouses' || landscapeWeight(hp, 'town') < 0.6) continue;
      // Neighbouring slots must be town houses too, so the row never runs into another biome's buildings.
      if (this.terrain.biomeAt(hp - len / 2, side) !== 'townhouses' || this.terrain.biomeAt(hp + len / 2, side) !== 'townhouses') continue;
      if (rng() < 0.15) continue;
      const dep = rand(rng, 7, 9);
      const hd = ROAD.half + 2.6 + rand(rng, 0, 0.6) + dep / 2;
      const hx = this.terrain.pathCenterX(hp) + side * hd;
      this.addTownHouse(b, chunk, hx, -hp, side, len, dep, rng);
      placed.push([hx, -hp, Math.max(len, dep) / 2 + 1]);
    }
    // Wooden houses with a shed: one slot every 22 m.
    for (let k = Math.floor(p0 / 22) - 1; k * 22 < p1 + 22; k++) {
      const rng = mulberry32(subSeed(seed, 2700 + k, side + 2));
      const hp = k * 22 + 11 + rand(rng, -3, 3);
      if (hp < p0 || hp >= p1 || this.terrain.biomeAt(hp, side) !== 'gardens' || landscapeWeight(hp, 'town') < 0.6) continue;
      if (rng() < 0.25) continue;
      const hd = rand(rng, 9, 14);
      const hx = this.terrain.pathCenterX(hp) + side * hd;
      if (Math.abs(hx) > CFG.chunk.halfWidth - 6) continue;
      this.addWoodHouse(b, chunk, hx, -hp, side, rng);
      placed.push([hx, -hp, 5.5]);
      if (rng() < 0.6) {
        const sx = hx + side * rand(rng, 5, 7);
        const sz = -hp + rand(rng, -5, 5);
        this.addShed(b, chunk, sx, sz, rng);
        placed.push([sx, sz, 2.2]);
      }
    }
    // Garages: one slot every 40 m.
    for (let k = Math.floor(p0 / 40) - 1; k * 40 < p1 + 40; k++) {
      const rng = mulberry32(subSeed(seed, 2900 + k, side + 2));
      const hp = k * 40 + 20 + rand(rng, -6, 6);
      if (hp < p0 || hp >= p1 || this.terrain.biomeAt(hp, side) !== 'fallow' || landscapeWeight(hp, 'town') < 0.6) continue;
      if (rng() < 0.5) continue;
      const hd = rand(rng, 9, 16);
      const hx = this.terrain.pathCenterX(hp) + side * hd;
      if (Math.abs(hx) > CFG.chunk.halfWidth - 6) continue;
      this.addGarages(b, chunk, hx, -hp, side, rng);
      placed.push([hx, -hp, 7]);
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
      disc: new Batch(this.discGeo, this.flatMat, true, false),
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
      if (landscapeAt(p0) === 'town' || landscapeAt(p1) === 'town') {
        this.addTownBuildings(b, i, i, side, placed);
        this.addGuardRail(b, i, i, side);
        this.addBoardFence(b, i, i, side);
      }
      // Now and then an orange research lab or snowcat in Antarctica.
      const pm = (p0 + p1) / 2;
      if (landscapeAt(pm) === 'antarctic' && hash3(i, side, this.terrain.seed + 97) < 0.17) {
        const rrng = mulberry32(subSeed(this.terrain.seed, 2100 + i, side + 2));
        const rp = rand(rrng, p0 + 6, p1 - 6);
        const rd = rand(rrng, 8, 16);
        const rx = this.terrain.pathCenterX(rp) + side * rd;
        if (this.onLand(rx, -rp, 0.5) && this.onLand(rx + side * 3, -rp, 0.5)) {
          if (rrng() < 0.55) this.addResearchLab(b, i, rx, -rp, side, rrng);
          else this.addSnowcat(b, i, rx, -rp, rrng);
          placed.push([rx, -rp, 4.5]);
        }
      }
      // One farmhouse per farmstead segment, in the chunk that holds its spot.
      const seg = Math.floor(p0 / 100);
      for (let k = seg; k <= seg + 1; k++) {
        const hp = k * 100 + 30 + hash3(k, side, this.terrain.seed + 91) * 40;
        if (hp < p0 || hp >= p1 || this.terrain.biomeAt(hp, side) !== 'farmstead') continue;
        const hrng = mulberry32(subSeed(this.terrain.seed, 1900 + k, side + 2));
        const hd = rand(hrng, 11, 17);
        const hx = this.terrain.pathCenterX(hp) + side * hd;
        if (Math.abs(hx) > CFG.chunk.halfWidth - 6 || this.inGorge(hx, -hp, 9)) continue;
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
        if (this.inGorge(x, z, 2.5)) continue;
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
          case 'snowfield': {
            const r = rng();
            if (r < 0.006 && d > 2.4 && !tooClose(x, z, 2)) {
              this.addPenguinGroup(b, i, x, z, 1 + Math.floor(rng() * 3), 1.2, rng, true);
              placed.push([x, z, 1.5]);
            } else if (r < 0.018 && d > 4 && !tooClose(x, z, 1.5) && this.onLand(x, z)) {
              this.addSnowyRock(b, i, x, z, rng, d < 8 ? 0.6 : 1.2);
              placed.push([x, z, 1]);
            }
            break;
          }
          case 'shore': {
            const r = rng();
            if (!this.onLand(x, z, 0.05)) {
              if (r < 0.03) this.addIceberg(b, x, z, rng);
            } else if (r < 0.01 && d > 2.4 && !tooClose(x, z, 2)) {
              this.addPenguinGroup(b, i, x, z, 2 + Math.floor(rng() * 4), 1.6, rng, true);
              placed.push([x, z, 2]);
            } else if (r < 0.05 && d > 3 && !tooClose(x, z, 1.4)) {
              this.addSnowyRock(b, i, x, z, rng, 0.9);
              placed.push([x, z, 1]);
            }
            break;
          }
          case 'rookery': {
            // A colony of penguins on dark rock.
            const r = rng();
            if (r < 0.012 && d > 4 && !tooClose(x, z, 3) && this.onLand(x, z)) {
              this.addPenguinGroup(b, i, x, z, 8 + Math.floor(rng() * 14), rand(rng, 2.5, 4.5), rng, true);
              placed.push([x, z, 4]);
            } else if (r < 0.02 && d > 2.2 && !tooClose(x, z, 1.5)) {
              this.addPenguinGroup(b, i, x, z, 1 + Math.floor(rng() * 2), 0.8, rng, true);
              placed.push([x, z, 1]);
            } else if (r < 0.06 && d > 3 && !tooClose(x, z, 1.2) && this.onLand(x, z)) {
              this.addSnowyRock(b, i, x, z, rng, 0.8);
              placed.push([x, z, 0.8]);
            }
            break;
          }
          case 'townhouses': {
            // Yards behind the houses: a bare tree, containers, a sign by the road.
            const r = rng();
            if (r < 0.025 && d > 16 && !tooClose(x, z, 3)) {
              this.addBareTree(b, i, x, z, rng, rng() < 0.4);
              placed.push([x, z, 2]);
            } else if (r < 0.028 && d > 4 && d < 5 && !tooClose(x, z, 2)) {
              this.addBins(b, i, x, z, rng);
              placed.push([x, z, 2.5]);
            } else if (r < 0.03 && d > ROAD.half + 0.4 && d < ROAD.half + 0.8 && !tooClose(x, z, 2)) {
              this.addSign(b, i, x, z);
              placed.push([x, z, 0.5]);
            }
            break;
          }
          case 'gardens': {
            // Leafless fruit trees, a dark fir now and then, bare shrubs by the fences.
            const r = rng();
            if (r < 0.05 && d > 6 && !tooClose(x, z, 3)) {
              if (rng() < 0.15) this.addFir(b, i, x, z, rng);
              else this.addBareTree(b, i, x, z, rng, rng() < 0.3);
              placed.push([x, z, 2]);
            } else if (r < 0.07 && d > 5 && d < 7 && !tooClose(x, z, 1.2)) {
              const bx = this.addBush(b, i, x, z, rng, rand(rng, 0.5, 0.9), CANOPY_COLORS.winterBush);
              placed.push([bx, z, 0.8]);
            }
            break;
          }
          case 'fallow': {
            // Rough ground: bare trees and bushes, a few containers by the road.
            const r = rng();
            if (r < 0.04 && d > 5 && !tooClose(x, z, 3)) {
              this.addBareTree(b, i, x, z, rng, rng() < 0.5);
              placed.push([x, z, 2]);
            } else if (r < 0.08 && d > 4 && !tooClose(x, z, 1.2)) {
              const bx = this.addBush(b, i, x, z, rng, rand(rng, 0.5, 1.1), CANOPY_COLORS.winterBush);
              placed.push([bx, z, 0.8]);
            } else if (r < 0.082 && d > 4.5 && d < 7 && !tooClose(x, z, 3)) {
              this.addBins(b, i, x, z, rng);
              placed.push([x, z, 2.5]);
            } else if (r < 0.084 && d > ROAD.half + 0.4 && d < ROAD.half + 0.8 && !tooClose(x, z, 2)) {
              this.addSign(b, i, x, z);
              placed.push([x, z, 0.5]);
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

    if (landscapeAt(p0) === 'town' || landscapeAt(p1) === 'town') {
      this.addPoles(b, i, i);
      this.addRoadMarkings(b, i);
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
  disc: Batch;
}

