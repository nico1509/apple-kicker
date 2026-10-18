import * as THREE from 'three';
import { CFG } from '../config';
import { mulberry32, rand, subSeed, type Rng } from '../utils/noise';
import { sphereContact, type ColliderStore, type Contact } from './colliders';
import { inSubwayCore, SUBWAY, type SubwaySection } from './subway';
import { Terrain } from './terrain';

interface Bottle {
  key: string;
  pivot: THREE.Group;
  baseY: number;
  phase: number;
}

/** Metres a bottle may be moved along the path to keep clear of an obstacle. */
const NUDGE = 1.5;

/** Height of the bottle model in metres (a bit larger than life so it reads from afar). */
const HEIGHT = 0.5;

/** Profile of the glass bottle (radius, height), bottom to top, for a lathe. */
const PROFILE: Array<[number, number]> = [
  [0, 0], [0.052, 0], [0.058, 0.01], [0.06, 0.03], [0.06, 0.2], [0.058, 0.235],
  [0.045, 0.27], [0.028, 0.305], [0.021, 0.33], [0.02, 0.385], [0.023, 0.39], [0.023, 0.398], [0, 0.398],
];

/**
 * Small bottles of apple spritzer that float along the path, slightly tilted
 * and spinning. Collecting one quenches the thirst. Their spacing comes from
 * the seed, so every run on the same world has them in the same spots, in
 * every landscape.
 */
export class Bottles {
  private readonly glassMat = new THREE.MeshStandardMaterial({
    color: 0xe0a83c,
    emissive: 0x6a3f08,
    emissiveIntensity: 0.35,
    roughness: 0.25,
    metalness: 0,
  });
  private readonly capMat = new THREE.MeshStandardMaterial({ color: 0x2f9a2c, roughness: 0.4, metalness: 0 });
  private readonly labelTex: THREE.CanvasTexture;
  private readonly labelMat: THREE.MeshStandardMaterial;
  private readonly neckMat = new THREE.MeshStandardMaterial({ color: 0x3fae35, roughness: 0.6, metalness: 0 });
  private readonly bodyGeo: THREE.LatheGeometry;
  private readonly labelGeo: THREE.CylinderGeometry;
  private readonly neckGeo: THREE.CylinderGeometry;
  private readonly capGeo: THREE.CylinderGeometry;
  private readonly chunks = new Map<number, Bottle[]>();
  /** Bottles already drunk in this world (they stay gone when a chunk is rebuilt). */
  private readonly taken = new Set<string>();
  /** Progress of every bottle so far (see spot()). */
  private readonly spots: number[] = [];
  private readonly spotRng: Rng;
  /** Rows of bottles of every subway section, by its start. */
  private readonly rows = new Map<number, Array<{ key: string; x: number; p: number }>>();
  private readonly contact: Contact = { nx: 0, ny: 0, nz: 0, depth: 0, surface: { restitution: 0, friction: 0 } };

  constructor(
    private readonly terrain: Terrain,
    private readonly colliders: ColliderStore,
  ) {
    const s = HEIGHT / 0.398;
    this.bodyGeo = new THREE.LatheGeometry(PROFILE.map(([r, y]) => new THREE.Vector2(r * s, y * s)), 14);
    this.labelGeo = new THREE.CylinderGeometry(0.0615 * s, 0.0615 * s, 0.15 * s, 14, 1, true).translate(0, 0.115 * s, 0);
    this.neckGeo = new THREE.CylinderGeometry(0.0215 * s, 0.0235 * s, 0.03 * s, 12, 1, true).translate(0, 0.35 * s, 0);
    this.capGeo = new THREE.CylinderGeometry(0.0245 * s, 0.0245 * s, 0.016 * s, 12).translate(0, 0.395 * s, 0);
    this.spotRng = mulberry32(subSeed(terrain.seed, 1699));
    this.labelTex = Bottles.makeLabelTexture();
    this.labelMat = new THREE.MeshStandardMaterial({
      map: this.labelTex,
      emissive: 0xffffff,
      emissiveMap: this.labelTex,
      emissiveIntensity: 0.3,
      roughness: 0.6,
      metalness: 0,
    });
  }

  /** Green label with lighter apple halves and the lettering, after the fritz-spritz bottle. */
  private static makeLabelTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const g = c.getContext('2d');
    if (g) {
      g.fillStyle = '#3aa832';
      g.fillRect(0, 0, 256, 128);
      // Apple halves in a lighter green.
      for (const [x, y, r] of [[30, 30, 30], [120, 105, 34], [215, 25, 28], [250, 110, 22], [-5, 110, 24]]) {
        g.fillStyle = '#7ccf4c';
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#a7e070';
        g.beginPath();
        g.arc(x, y, r * 0.55, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = '#ffffff';
      g.font = 'bold 34px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('apfel', 64, 58);
      g.fillText('apfel', 192, 58);
      g.font = 'bold 15px sans-serif';
      g.fillText('SCHORLE', 64, 86);
      g.fillText('SCHORLE', 192, 86);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * Progress of bottle k along the path. The gaps are drawn from the seed so
   * that, after nudging round obstacles, two bottles are always between
   * CFG.thirst.minGap and maxGap apart.
   */
  private spot(k: number): number {
    const { firstBottle, minGap, maxGap } = CFG.thirst;
    while (this.spots.length <= k) {
      const prev = this.spots.length ? this.spots[this.spots.length - 1] : firstBottle - minGap - NUDGE;
      this.spots.push(prev + rand(this.spotRng, minGap + 2 * NUDGE, maxGap - 2 * NUDGE));
    }
    return this.spots[k];
  }

  /** Builds the bottles of chunk i, each nudged a little if an obstacle is in the way. */
  buildChunk(i: number): THREE.Group {
    const group = new THREE.Group();
    group.name = `bottles-${i}`;
    const list: Bottle[] = [];
    this.chunks.set(i, list);
    const { p0, p1 } = Terrain.chunkRange(i);
    const rng = mulberry32(subSeed(this.terrain.seed, 1700 + i));
    for (let k = 0; this.spot(k) < p1; k++) {
      const s = this.spot(k);
      if (s < p0) continue;
      // The path ends at the cabin of the story mode.
      const hut = this.terrain.hut();
      if (hut && s > hut.p - 4) break;
      // In the subway the bottles stand in rows instead.
      if (inSubwayCore(s)) continue;
      const key = `${k}`;
      if (this.taken.has(key)) continue;
      const dx = rand(rng, -0.4, 0.4);
      let x = 0;
      let z = 0;
      let gy = 0;
      for (const off of [0, -0.75, 0.75, -NUDGE, NUDGE]) {
        x = this.terrain.pathCenterX(s + off) + dx;
        z = -(s + off);
        gy = this.terrain.groundHeight(x, z);
        if (this.clear(x, gy, z)) break;
      }
      // If every spot is blocked the bottle still floats there: the gap matters more.
      this.addBottle(group, list, key, x, gy, z, rng);
    }
    const sec = this.terrain.subwayAt(p0) ?? this.terrain.subwayAt(p1);
    if (sec) {
      for (const r of this.subwayRows(sec)) {
        if (r.p < p0 || r.p >= p1 || this.taken.has(r.key)) continue;
        const gy = Math.max(this.terrain.groundHeight(r.x, -r.p), this.terrain.deckHeight(r.x, -r.p));
        this.addBottle(group, list, r.key, r.x, gy, -r.p, rng);
      }
    }
    return group;
  }

  /**
   * In the subway the bottles stand in rows like the coins of the arcade game:
   * along every free track and up every ramp onto the roof, so that they show
   * the way, and a short row in the open between two blocks of trains.
   */
  private subwayRows(sec: SubwaySection): Array<{ key: string; x: number; p: number }> {
    let rows = this.rows.get(sec.s);
    if (rows) return rows;
    rows = [];
    const rng = mulberry32(subSeed(this.terrain.seed, 1750 + sec.s));
    sec.blocks.forEach((b, bi) => {
      b.lanes.forEach((l, lane) => {
        const x = SUBWAY.lanes[lane];
        if (l === 'free') {
          for (let j = 0; j < 6; j++) rows!.push({ key: `w${sec.s}-${bi}-${lane}-${j}`, x, p: b.p0 + 2 + j * 2.5 });
        } else if (l === 'ramp') {
          const t = sec.trains.find((t) => t.lane === lane && t.p0 >= b.p0 && t.p0 < b.p1);
          if (!t) return;
          for (let j = 0; j < 10 && t.p0 + 1.5 + j * 2.5 < t.p1 - 1; j++) rows!.push({ key: `w${sec.s}-${bi}-${lane}-${j}`, x, p: t.p0 + 1.5 + j * 2.5 });
        }
      });
      const x = SUBWAY.lanes[Math.floor(rng() * 3)];
      for (let j = 0; j < 3; j++) rows!.push({ key: `w${sec.s}-${bi}-g-${j}`, x, p: b.p1 + 2.5 + j * 2.5 });
    });
    this.rows.set(sec.s, rows);
    return rows;
  }

  private addBottle(group: THREE.Group, list: Bottle[], key: string, x: number, gy: number, z: number, rng: Rng): void {
    const pivot = new THREE.Group();
    // The bottle is centred on the tilt group, which leans it; the pivot spins it.
    const tilt = new THREE.Group();
    tilt.rotation.z = CFG.thirst.tilt;
    const body = new THREE.Mesh(this.bodyGeo, this.glassMat);
    body.castShadow = true;
    const label = new THREE.Mesh(this.labelGeo, this.labelMat);
    const neck = new THREE.Mesh(this.neckGeo, this.neckMat);
    const cap = new THREE.Mesh(this.capGeo, this.capMat);
    for (const m of [body, label, neck, cap]) m.position.y = -HEIGHT / 2;
    tilt.add(body, label, neck, cap);
    pivot.add(tilt);
    const baseY = gy + CFG.thirst.hoverHeight;
    pivot.position.set(x, baseY, z);
    pivot.name = 'bottle';
    group.add(pivot);
    list.push({ key, pivot, baseY, phase: rng() * Math.PI * 2 });
  }

  private clear(x: number, gy: number, z: number): boolean {
    let hit = false;
    this.colliders.forEachNear(z, (col) => {
      if (hit) return;
      for (const h of [0.15, 0.6, 1.0]) {
        if (sphereContact(col, x, gy + h, z, 0.8, this.contact)) {
          hit = true;
          return;
        }
      }
    });
    return !hit;
  }

  removeChunk(i: number): void {
    this.chunks.delete(i);
  }

  /** Spin and bob every bottle. */
  animate(time: number): void {
    for (const list of this.chunks.values()) {
      for (const b of list) {
        b.pivot.rotation.y = time * 2.2 + b.phase;
        b.pivot.position.y = b.baseY + Math.sin(time * 2 + b.phase) * 0.05;
      }
    }
  }

  /** Collects every bottle within reach of a player standing at `pos` (feet); returns how many. */
  collect(pos: THREE.Vector3): number {
    let n = 0;
    const reach = CFG.thirst.pickupRadius;
    for (const list of this.chunks.values()) {
      for (let k = list.length - 1; k >= 0; k--) {
        const b = list[k];
        const p = b.pivot.position;
        if (Math.hypot(p.x - pos.x, p.z - pos.z) > reach) continue;
        if (p.y < pos.y - 0.5 || p.y > pos.y + 2.2) continue;
        b.pivot.parent?.remove(b.pivot);
        list.splice(k, 1);
        this.taken.add(b.key);
        n++;
      }
    }
    return n;
  }

  /** Positions of the bottles still lying around (testing only). */
  positions(): Array<{ x: number; y: number; z: number }> {
    const out: Array<{ x: number; y: number; z: number }> = [];
    for (const list of this.chunks.values()) for (const b of list) out.push({ x: b.pivot.position.x, y: b.pivot.position.y, z: b.pivot.position.z });
    return out;
  }

  dispose(): void {
    this.chunks.clear();
    for (const m of [this.glassMat, this.capMat, this.labelMat, this.neckMat]) m.dispose();
    this.labelTex.dispose();
    for (const g of [this.bodyGeo, this.labelGeo, this.neckGeo, this.capGeo]) g.dispose();
  }
}
