import * as THREE from 'three';
import { CFG } from '../config';
import { mulberry32, rand, subSeed, type Rng } from '../utils/noise';
import { ColliderStore, SURFACES, type Surface } from './colliders';
import { Batch } from './decor';
import { HUT, Terrain, type Hut } from './terrain';

const C = (hex: number): THREE.Color => new THREE.Color(hex);
/** Weathered, grey-brown logs and planks. */
const LOGS = [C(0x8a7966), C(0x968470), C(0x7d6e5d), C(0xa08d77)];
const LOG_END = [C(0xb39a78), C(0xc0a682), C(0xa88f6e)];
const PLANKS = [C(0x6e5e4c), C(0x625343), C(0x7a6854), C(0x685846)];
const FLOOR = [C(0x7a6248), C(0x6e573f), C(0x85694c)];
const FRAME = C(0x3e342b);
const STONE = [C(0x6f6a64), C(0x5f5a55), C(0x7c766e)];
const STRAW = [C(0xc9a85a), C(0xb8954a), C(0xd4b468)];
const LINEN = C(0xeee8dc);
const BLANKET = C(0x8a3a2e);
const IRON = C(0x2a2826);
/** Warm light behind the windows, in the stove and in the lantern. */
const GLOW = C(0xffb050);
const GLOW_BRIGHT = C(0xffd890);

/** Walls reach this high for the physics so nothing gets over the cabin. */
const TOP = 80;
/** The invisible wall beside the cabin runs this far out to both sides. */
const BARRIER = 1000;
/** Radius and spacing of the wall logs. */
const LOG_R = 0.17;
const LOG_STEP = 0.32;
/** Overhang of the roof over the porch, and how deep the porch is. */
const EAVE_FRONT = 1.0;
const PORCH = 1.4;

/**
 * The log cabin at the end of the story mode, after the reference picture:
 * stacked logs with round ends at the corners, a plank roof with a stone
 * chimney, a porch, and the door standing open with warm light inside. It
 * blocks the path: an invisible wall to both sides keeps the player (and the
 * apple) from walking past it.
 */
export class Cabin {
  private readonly mat = new THREE.MeshLambertMaterial({ flatShading: true });
  private readonly glowMat = new THREE.MeshBasicMaterial();
  private readonly spillMat: THREE.MeshBasicMaterial;
  private readonly spillTex: THREE.CanvasTexture;
  private readonly boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly logGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
  private readonly blobGeo = new THREE.IcosahedronGeometry(1, 1);
  private readonly gableGeo: THREE.BufferGeometry;
  private readonly spillGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly col = new THREE.Color();

  constructor(
    private readonly terrain: Terrain,
    private readonly colliders: ColliderStore,
  ) {
    const tri = new THREE.Shape();
    tri.moveTo(-0.5, 0);
    tri.lineTo(0.5, 0);
    tri.lineTo(0, 1);
    tri.lineTo(-0.5, 0);
    this.gableGeo = new THREE.ExtrudeGeometry(tri, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
    this.spillTex = Cabin.makeSpillTexture();
    this.spillMat = new THREE.MeshBasicMaterial({
      map: this.spillTex,
      color: 0xffb060,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
  }

  private static makeSpillTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (g) {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }
    return new THREE.CanvasTexture(c);
  }

  /** Index of the chunk that holds the cabin and its colliders. */
  chunkIndex(): number | null {
    const hut = this.terrain.hut();
    return hut ? Math.floor((hut.p + HUT.depth / 2) / CFG.chunk.length) : null;
  }

  /** Centre of the cabin in world coordinates (floor height), or null in the endless mode. */
  centre(out: THREE.Vector3): THREE.Vector3 | null {
    const hut = this.terrain.hut();
    return hut ? out.set(hut.cx, hut.h, -(hut.p + HUT.depth / 2)) : null;
  }

  /** Where the warm light inside hangs (world coordinates). */
  lightPosition(out: THREE.Vector3): THREE.Vector3 | null {
    const hut = this.terrain.hut();
    return hut ? out.set(hut.cx + HUT.doorX + 0.6, hut.h + 1.9, -(hut.p + 1.4)) : null;
  }

  /** True when (x, z) lies inside the cabin, between its walls. */
  inside(x: number, z: number, margin = 0): boolean {
    const hut = this.terrain.hut();
    if (!hut) return false;
    const lx = x - hut.cx;
    const lz = z + hut.p + HUT.depth / 2;
    return Math.abs(lx) < HUT.width / 2 - HUT.log - margin && Math.abs(lz) < HUT.depth / 2 - HUT.log - margin;
  }

  /** True near the cabin and its porch, where nothing else may stand. */
  near(x: number, z: number, margin: number): boolean {
    const hut = this.terrain.hut();
    if (!hut) return false;
    const u = -z - hut.p;
    return u > -PORCH - 2 - margin && u < HUT.depth + 1.5 + margin && Math.abs(x - hut.cx) < HUT.width / 2 + 1.2 + margin;
  }

  /** Builds the cabin if chunk i holds it (and registers its colliders); null otherwise. */
  buildChunk(i: number): THREE.Group | null {
    const hut = this.terrain.hut();
    if (!hut || i !== this.chunkIndex()) return null;
    const rng = mulberry32(subSeed(this.terrain.seed, 4400));
    const b = {
      box: new Batch(this.boxGeo, this.mat, true, true),
      log: new Batch(this.logGeo, this.mat, true, true),
      blob: new Batch(this.blobGeo, this.mat, true, true),
      gable: new Batch(this.gableGeo, this.mat, true, true),
      glow: new Batch(this.boxGeo, this.glowMat, false, false),
    };
    this.build(b, hut, rng);
    this.addColliders(i, hut);
    const group = new THREE.Group();
    group.name = 'cabin';
    for (const batch of Object.values(b)) {
      const mesh = batch.build();
      if (mesh) group.add(mesh);
    }
    // Warm light falling out of the door and the window onto the snow.
    const z0 = -(hut.p + HUT.depth / 2);
    for (const [lx, w, d] of [[HUT.doorX, 3.4, 4.6], [1.6, 2.6, 2.4]]) {
      const spill = new THREE.Mesh(this.spillGeo, this.spillMat);
      const sx = hut.cx + lx;
      const sz = z0 + HUT.depth / 2 + d * 0.45;
      spill.position.set(sx, this.terrain.groundHeight(sx, sz) + 0.03, sz);
      spill.scale.set(w, 1, d);
      spill.renderOrder = 2;
      group.add(spill);
    }
    return group;
  }

  // ---------------------------------------------------------------------------

  /** Places one instance; (lx, ly, lz) are relative to the cabin centre on the floor. */
  private put(batch: Batch, hut: Hut, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, color: THREE.Color, yaw = 0, tiltX = 0, tiltZ = 0): void {
    this.v.set(hut.cx + lx, hut.h + ly, -(hut.p + HUT.depth / 2) + lz);
    this.s.set(sx, sy, sz);
    this.euler.set(tiltX, yaw, tiltZ, 'YXZ');
    this.q.setFromEuler(this.euler);
    this.m.compose(this.v, this.q, this.s);
    batch.add(this.m, color);
  }

  private pick(list: THREE.Color[], rng: Rng, vary = 0.06): THREE.Color {
    return this.col.copy(list[Math.floor(rng() * list.length)]).multiplyScalar(1 + (rng() - 0.5) * 2 * vary);
  }

  /** A log along x from x0 to x1 (centre height y, depth z). */
  private logX(b: Batches, hut: Hut, x0: number, x1: number, y: number, z: number, rng: Rng, r = LOG_R): void {
    if (x1 - x0 < 0.05) return;
    this.put(b.log, hut, (x0 + x1) / 2, y, z, r, x1 - x0, r, this.pick(LOGS, rng), 0, 0, Math.PI / 2);
  }

  /** A log along z from z0 to z1. */
  private logZ(b: Batches, hut: Hut, z0: number, z1: number, y: number, x: number, rng: Rng, r = LOG_R): void {
    if (z1 - z0 < 0.05) return;
    this.put(b.log, hut, x, y, (z0 + z1) / 2, r, z1 - z0, r, this.pick(LOGS, rng), 0, Math.PI / 2);
  }

  /** Light pale disc on a log end (the sawn face), facing ±x or ±z. */
  private logEnd(b: Batches, hut: Hut, x: number, y: number, z: number, alongX: boolean, rng: Rng): void {
    if (alongX) this.put(b.log, hut, x, y, z, LOG_R * 0.92, 0.04, LOG_R * 0.92, this.pick(LOG_END, rng), 0, 0, Math.PI / 2);
    else this.put(b.log, hut, x, y, z, LOG_R * 0.92, 0.04, LOG_R * 0.92, this.pick(LOG_END, rng), 0, Math.PI / 2);
  }

  private build(b: Batches, hut: Hut, rng: Rng): void {
    const W = HUT.width / 2;
    const D = HUT.depth / 2;
    const wallTop = this.wallTop();
    const doorL = HUT.doorX - HUT.doorWidth / 2;
    const doorR = HUT.doorX + HUT.doorWidth / 2;
    const win = { x0: 0.85, x1: 2.35, y0: 0.9, y1: 1.85 };
    const sideWin = { z0: -0.7, z1: 0.7 };
    const over = 0.32; // the logs reach past the corners
    const front = D - LOG_R;
    const back = -D + LOG_R;
    const side = W - LOG_R;

    // ----- log walls: front and back logs and side logs alternate in height
    for (let k = 0; ; k++) {
      const y = LOG_R + k * LOG_STEP;
      if (y > wallTop) break;
      const yS = y + LOG_STEP / 2;
      // Front wall with the open door and a window.
      const inDoor = y < HUT.doorHeight;
      const inWin = y > win.y0 && y < win.y1;
      const x0 = -W - over;
      const x1 = W + over;
      if (inDoor) {
        this.logX(b, hut, x0, doorL, y, front, rng);
        if (inWin) {
          this.logX(b, hut, doorR, win.x0, y, front, rng);
          this.logX(b, hut, win.x1, x1, y, front, rng);
        } else this.logX(b, hut, doorR, x1, y, front, rng);
      } else this.logX(b, hut, x0, x1, y, front, rng);
      this.logX(b, hut, x0, x1, y, back, rng);
      for (const sx of [-W - over, W + over]) {
        this.logEnd(b, hut, sx, y, front, true, rng);
        this.logEnd(b, hut, sx, y, back, true, rng);
      }
      if (yS > wallTop) continue;
      // Side walls; the right one has a window.
      this.logZ(b, hut, -D - over, D + over, yS, -side, rng);
      if (yS > win.y0 && yS < win.y1) {
        this.logZ(b, hut, -D - over, sideWin.z0, yS, side, rng);
        this.logZ(b, hut, sideWin.z1, D + over, yS, side, rng);
      } else this.logZ(b, hut, -D - over, D + over, yS, side, rng);
      for (const sz of [-D - over, D + over]) {
        this.logEnd(b, hut, -side, yS, sz, false, rng);
        this.logEnd(b, hut, side, yS, sz, false, rng);
      }
    }

    // ----- door: frame, lintel and the leaf standing open into the room
    const fz = D - LOG_R;
    for (const fx of [doorL - 0.06, doorR + 0.06]) this.put(b.box, hut, fx, HUT.doorHeight / 2, fz, 0.12, HUT.doorHeight, HUT.log + 0.06, FRAME);
    this.put(b.box, hut, HUT.doorX, HUT.doorHeight + 0.06, fz, HUT.doorWidth + 0.24, 0.12, HUT.log + 0.06, FRAME);
    const leafZ = D - HUT.log - HUT.doorWidth / 2;
    this.put(b.box, hut, doorL + 0.06, HUT.doorHeight / 2, leafZ, 0.07, HUT.doorHeight - 0.05, HUT.doorWidth - 0.05, this.pick(PLANKS, rng));
    for (const t of [0.35, 1.65]) this.put(b.box, hut, doorL + 0.11, t, leafZ, 0.04, 0.12, HUT.doorWidth - 0.15, FRAME);

    // ----- windows: frame, cross and warm light behind
    const wx = (win.x0 + win.x1) / 2;
    const wy = (win.y0 + win.y1) / 2;
    const ww = win.x1 - win.x0;
    const wh = win.y1 - win.y0;
    this.put(b.glow, hut, wx, wy, fz - 0.05, ww, wh, 0.04, GLOW);
    this.put(b.box, hut, wx, wy, fz + 0.04, 0.08, wh, 0.08, FRAME);
    this.put(b.box, hut, wx, wy, fz + 0.04, ww, 0.08, 0.08, FRAME);
    for (const ex of [win.x0, win.x1]) this.put(b.box, hut, ex, wy, fz + 0.04, 0.1, wh + 0.1, 0.12, FRAME);
    for (const ey of [win.y0, win.y1]) this.put(b.box, hut, wx, ey, fz + 0.06, ww + 0.1, 0.1, 0.16, FRAME);
    const sw = sideWin.z1 - sideWin.z0;
    this.put(b.glow, hut, side - 0.05, wy, 0, 0.04, wh, sw, GLOW);
    this.put(b.box, hut, side + 0.04, wy, 0, 0.08, wh, 0.08, FRAME);
    this.put(b.box, hut, side + 0.04, wy, 0, 0.08, 0.08, sw, FRAME);
    for (const ez of [sideWin.z0, sideWin.z1]) this.put(b.box, hut, side + 0.04, wy, ez, 0.12, wh + 0.1, 0.1, FRAME);
    for (const ey of [win.y0, win.y1]) this.put(b.box, hut, side + 0.06, ey, 0, 0.16, 0.1, sw + 0.1, FRAME);

    // ----- gables and the plank roof
    const ridge = HUT.ridge;
    for (const gx of [-side, side]) this.put(b.gable, hut, gx, wallTop - 0.05, 0, HUT.depth, ridge + 0.05, HUT.log, this.pick(PLANKS, rng), Math.PI / 2);
    const slope = Math.atan2(ridge, D);
    const top = wallTop + ridge + 0.1;
    for (const [dir, eave] of [[1, EAVE_FRONT], [-1, 0.55]] as const) {
      const run = D + eave;
      const len = run / Math.cos(slope);
      const cz = dir * run / 2;
      const cy = top - (run / 2) * Math.tan(slope);
      for (let x = -W - 0.5; x < W + 0.5 - 0.01; x += 0.42) {
        this.put(b.box, hut, x + 0.21, cy + rand(rng, -0.015, 0.015), cz, 0.4, 0.08, len, this.pick(PLANKS, rng, 0.1), 0, dir * slope);
      }
      // Fascia board along the eave.
      this.put(b.box, hut, 0, top - run * Math.tan(slope) - 0.08, dir * run, HUT.width + 1.0, 0.18, 0.08, this.pick(PLANKS, rng));
    }
    this.put(b.log, hut, 0, top + 0.04, 0, 0.12, HUT.width + 1.0, 0.12, this.pick(LOGS, rng), 0, 0, Math.PI / 2);
    // Stone chimney on the left.
    const chimTop = top + 0.9;
    const chimBase = wallTop + 0.2;
    for (let y = chimBase; y < chimTop; y += 0.24) {
      this.put(b.box, hut, -W + 1.3 + rand(rng, -0.02, 0.02), y + 0.12, -0.9, 0.72, 0.23, 0.72, this.pick(STONE, rng, 0.08));
    }

    // ----- porch: deck boards in front, posts carrying the eave
    for (let z = D; z < D + PORCH; z += 0.3) {
      this.put(b.box, hut, 0, -0.05, z + 0.14, HUT.width + 0.2, 0.12, 0.27, this.pick(FLOOR, rng, 0.08));
    }
    const eaveY = top - (D + EAVE_FRONT) * Math.tan(slope);
    for (const px of [-W + 0.2, W - 0.2]) {
      this.put(b.log, hut, px, eaveY / 2, D + EAVE_FRONT - 0.15, 0.11, eaveY, 0.11, this.pick(LOGS, rng));
    }
    // The lantern beside the door.
    this.put(b.box, hut, doorR + 0.32, 2.05, D + 0.05, 0.16, 0.22, 0.16, IRON);
    this.put(b.glow, hut, doorR + 0.32, 2.05, D + 0.05, 0.12, 0.16, 0.18, GLOW_BRIGHT);

    // ----- inside: floor, bed, straw, stove and table
    const iw = HUT.width - 2 * HUT.log;
    const id = HUT.depth - 2 * HUT.log;
    for (let z = -id / 2; z < id / 2; z += 0.3) {
      this.put(b.box, hut, 0, -0.04, z + 0.15, iw, 0.1, 0.29, this.pick(FLOOR, rng, 0.08));
    }
    const ix = -W + HUT.log;
    const iz = -D + HUT.log;
    // Bed against the back wall, left of the door's view line.
    this.put(b.box, hut, HUT.doorX - 0.2, 0.22, iz + 1.0, 1.0, 0.44, 1.9, this.pick(PLANKS, rng));
    this.put(b.box, hut, HUT.doorX - 0.2, 0.5, iz + 1.0, 0.92, 0.14, 1.82, LINEN);
    this.put(b.box, hut, HUT.doorX - 0.2, 0.56, iz + 1.3, 0.96, 0.08, 1.2, BLANKET);
    this.put(b.box, hut, HUT.doorX - 0.2, 0.62, iz + 0.25, 0.7, 0.12, 0.3, LINEN);
    // Straw on the floor by the bed.
    for (let k = 0; k < 4; k++) {
      this.put(b.blob, hut, HUT.doorX + rand(rng, -0.6, 0.6), 0.02, iz + rand(rng, 2.2, 2.9), rand(rng, 0.35, 0.55), 0.1, rand(rng, 0.25, 0.4), this.pick(STRAW, rng, 0.1), rng() * 6.28);
    }
    // Iron stove under the chimney, glowing.
    this.put(b.box, hut, ix + 0.45, 0.4, -0.9, 0.7, 0.8, 0.7, IRON);
    this.put(b.glow, hut, ix + 0.81, 0.36, -0.9, 0.03, 0.26, 0.36, GLOW_BRIGHT);
    this.put(b.log, hut, ix + 0.45, (0.8 + wallTop) / 2, -0.9, 0.08, wallTop - 0.8, 0.08, IRON);
    // Table and a candle on the right.
    this.put(b.box, hut, 2.2, 0.74, iz + 1.0, 1.2, 0.06, 0.8, this.pick(PLANKS, rng));
    for (const [tx, tz] of [[1.7, 0.7], [2.7, 0.7], [1.7, 1.3], [2.7, 1.3]]) this.put(b.box, hut, tx, 0.36, iz + tz, 0.07, 0.72, 0.07, FRAME);
    this.put(b.glow, hut, 2.2, 0.84, iz + 1.0, 0.06, 0.14, 0.06, GLOW_BRIGHT);
  }

  /** Height of the top of the log walls. */
  private wallTop(): number {
    const n = Math.floor((HUT.wall - LOG_R) / LOG_STEP);
    return LOG_R + n * LOG_STEP + LOG_R;
  }

  private addColliders(chunk: number, hut: Hut): void {
    const W = HUT.width / 2;
    const D = HUT.depth / 2;
    const t = HUT.log;
    const doorL = HUT.doorX - HUT.doorWidth / 2;
    const doorR = HUT.doorX + HUT.doorWidth / 2;
    const wood = SURFACES.wood;
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, surface: Surface = wood): void => {
      const zc = -(hut.p + D);
      this.colliders.add(chunk, {
        kind: 'box',
        minX: hut.cx + x0, maxX: hut.cx + x1,
        minY: hut.h + y0, maxY: hut.h + y1,
        minZ: zc + z0, maxZ: zc + z1,
        surface,
        blocksPlayer: true,
      });
    };
    box(-W, W, -1, TOP, -D, -D + t);
    box(-W, -W + t, -1, TOP, -D, D);
    box(W - t, W, -1, TOP, -D, D);
    box(-W, doorL, -1, TOP, D - t, D);
    box(doorR, W, -1, TOP, D - t, D);
    box(doorL, doorR, HUT.doorHeight, TOP, D - t, D);
    // Ceiling and roof: nothing gets onto or over the cabin.
    const eaveY = this.wallTop() + HUT.ridge + 0.1 - (D + EAVE_FRONT) * Math.tan(Math.atan2(HUT.ridge, D));
    box(-W - 0.5, W + 0.5, this.wallTop() - 0.05, TOP, -D - 0.55, D);
    box(-W - 0.5, W + 0.5, eaveY, TOP, D, D + EAVE_FRONT);
    // The open door leaf, the bed, the stove and the table.
    box(doorL, doorL + 0.1, 0, HUT.doorHeight, D - t - HUT.doorWidth, D - t);
    box(HUT.doorX - 0.7, HUT.doorX + 0.3, 0, 0.62, -D + t, -D + t + 1.95);
    box(-W + t, -W + t + 0.8, 0, 0.8, -1.25, -0.55, SURFACES.metal);
    box(1.6, 2.8, 0.7, 0.77, -D + t + 0.6, -D + t + 1.4);
    // Porch posts.
    for (const px of [-W + 0.2, W - 0.2]) {
      const zc = -(hut.p + D) + D + EAVE_FRONT - 0.15;
      this.colliders.add(chunk, { kind: 'cylinder', x: hut.cx + px, z: zc, r: 0.13, yTop: hut.h + eaveY, surface: SURFACES.trunk, blocksPlayer: true });
    }
    // The invisible wall along the front: nobody walks (or kicks the apple) past the cabin.
    box(-W - BARRIER, -W + 0.01, -BARRIER, BARRIER, D - 0.4, D);
    box(W - 0.01, W + BARRIER, -BARRIER, BARRIER, D - 0.4, D);
  }

  dispose(): void {
    for (const g of [this.boxGeo, this.logGeo, this.blobGeo, this.gableGeo, this.spillGeo]) g.dispose();
    this.mat.dispose();
    this.glowMat.dispose();
    this.spillMat.dispose();
    this.spillTex.dispose();
  }
}

interface Batches {
  box: Batch;
  log: Batch;
  blob: Batch;
  gable: Batch;
  glow: Batch;
}
