import * as THREE from 'three';
import { CFG } from '../config';
import { clamp, damp } from '../utils/math';
import { rand, type Rng } from '../utils/noise';
import type { ColliderStore } from '../world/colliders';
import type { Apple } from './apple';

/**
 * A forest gnome (Wichtel) that walks back and forth across the track. When
 * the apple touches it, it grabs the apple and runs off with it at half the
 * player's walking speed until the player kicks it over.
 */
export interface Gnome {
  group: THREE.Group;
  /** Pivot at the feet; tips over when the gnome is kicked. */
  body: THREE.Group;
  arms: THREE.Group[];
  boots: THREE.Mesh[];
  stars: THREE.Group;
  /** Centre and direction (unit, across the track) of the patrol. */
  homeX: number;
  homeZ: number;
  axisX: number;
  axisZ: number;
  span: number;
  /** Position along the patrol, -span..span. */
  t: number;
  dir: 1 | -1;
  state: 'walk' | 'carry' | 'down';
  /** Seconds since the gnome was kicked over. */
  fall: number;
  phase: number;
  /** Set when its chunk is unloaded. */
  removed: boolean;
}

/** The model is built about 1 m tall and scaled up a little. */
const GNOME_SCALE = 1.2;
export const GNOME_RADIUS = 0.27;
const PATROL_SPEED = 0.9;
/** A gnome carrying the apple runs at half the player's walking speed. */
export const GNOME_RUN_SPEED = CFG.player.walkSpeed / 2;
/** The apple is grabbed when it comes this close (horizontally) to the gnome. */
const GRAB_DIST = 0.42;
const FALL_TIME = 0.35;
const FALL_ANGLE = -Math.PI / 2 + 0.12;
/** Where the apple sits in the gnome's hands (local to its group). */
const HAND = new THREE.Vector3(0, 0.36, 0.25);

const HAT_COLORS = [0xb8322c, 0x8e8c86, 0x7b5a3f, 0xa83a30, 0x5f6f4a];
const COAT_COLORS = [0x6f6a62, 0x7d6650, 0x5b6370, 0x82705a];

/** Builds the low-poly gnome models; geometries and materials are shared. */
export class GnomeFactory {
  private readonly coatGeo = new THREE.CylinderGeometry(0.11, 0.18, 0.36, 7);
  private readonly beardGeo = new THREE.ConeGeometry(0.13, 0.27, 7).rotateX(Math.PI);
  private readonly hatGeo = new THREE.ConeGeometry(0.145, 0.52, 7);
  private readonly ballGeo = new THREE.IcosahedronGeometry(1, 1);
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly starGeo: THREE.BufferGeometry;
  private readonly skin = new THREE.MeshLambertMaterial({ color: 0xe9b99b, flatShading: true });
  private readonly nose = new THREE.MeshLambertMaterial({ color: 0xd98577, flatShading: true });
  private readonly beard = new THREE.MeshLambertMaterial({ color: 0xf1ede4, flatShading: true });
  private readonly boot = new THREE.MeshLambertMaterial({ color: 0x3b2c22, flatShading: true });
  private readonly starMat = new THREE.MeshBasicMaterial({ color: 0xffd84a });
  private readonly hats = HAT_COLORS.map((c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
  private readonly coats = COAT_COLORS.map((c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true }));

  constructor() {
    const shape = new THREE.Shape();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 + Math.PI / 2;
      const r = k % 2 === 0 ? 0.075 : 0.032;
      if (k === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    shape.closePath();
    this.starGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.018, bevelEnabled: false }).translate(0, 0, -0.009);
  }

  private part(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  /** A gnome patrolling across the track around (x, z); axis is the unit patrol direction. */
  build(x: number, y: number, z: number, axisX: number, axisZ: number, rng: Rng): Gnome {
    const group = new THREE.Group();
    group.name = 'gnome';
    group.position.set(x, y, z);
    group.scale.setScalar(GNOME_SCALE);
    const body = new THREE.Group();
    group.add(body);
    const hat = this.hats[Math.floor(rng() * this.hats.length)];
    const coat = this.coats[Math.floor(rng() * this.coats.length)];
    const boots = [-1, 1].map((s) => this.part(body, this.box, this.boot, s * 0.07, 0.035, 0.02, 0.09, 0.07, 0.15));
    this.part(body, this.coatGeo, coat, 0, 0.25, 0);
    const arms = [-1, 1].map((s) => {
      const arm = new THREE.Group();
      arm.position.set(s * 0.15, 0.38, 0);
      body.add(arm);
      this.part(arm, this.box, coat, 0, -0.1, 0, 0.07, 0.2, 0.07);
      this.part(arm, this.ballGeo, this.skin, 0, -0.21, 0, 0.04, 0.04, 0.04);
      return arm;
    });
    this.part(body, this.ballGeo, this.skin, 0, 0.5, 0.01, 0.1, 0.1, 0.1);
    this.part(body, this.beardGeo, this.beard, 0, 0.36, 0.05, 1, 1, 0.75);
    this.part(body, this.ballGeo, this.nose, 0, 0.48, 0.1, 0.052, 0.048, 0.05);
    const hatMesh = this.part(body, this.hatGeo, hat, 0, 0.78, -0.01);
    // The hat sits low over the eyes and leans back a little.
    hatMesh.rotation.x = -0.12;
    const stars = new THREE.Group();
    stars.visible = false;
    group.add(stars);
    const count = rng() < 0.5 ? 2 : 3;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2;
      const star = new THREE.Mesh(this.starGeo, this.starMat);
      star.position.set(Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2);
      star.rotation.y = -a;
      stars.add(star);
    }
    const span = rand(rng, 1.6, 2.3);
    return {
      group, body, arms, boots, stars,
      homeX: x, homeZ: z, axisX, axisZ, span,
      t: rand(rng, -span, span),
      dir: rng() < 0.5 ? 1 : -1,
      state: 'walk',
      fall: 0,
      phase: rng() * 6,
      removed: false,
    };
  }

  dispose(): void {
    for (const g of [this.coatGeo, this.beardGeo, this.hatGeo, this.ballGeo, this.box, this.starGeo]) g.dispose();
    for (const m of [this.skin, this.nose, this.beard, this.boot, this.starMat, ...this.hats, ...this.coats]) m.dispose();
  }
}

/** What the gnomes need to know about the world. */
export interface GnomeWorld {
  groundHeight(x: number, z: number): number;
  readonly colliders: ColliderStore;
  /** Lateral offset of (x, z) from the path centre. */
  pathOffset(x: number, z: number): number;
}

export interface GnomeEvents {
  onGrab(): void;
}

/** Moves the gnomes, lets them steal the apple and knocks them over when kicked. */
export class GnomeBand {
  /** The gnome currently running off with the apple. */
  holder: Gnome | null = null;
  /** Counters for tests. */
  grabs = 0;
  knocked = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly world: GnomeWorld) {}

  update(dt: number, gnomes: Iterable<Gnome>, apple: Apple, player: { pos: THREE.Vector3 }, active: boolean, events: GnomeEvents): void {
    if (this.holder && !apple.held) {
      // The apple was put back on the track (respawn, new run): back to patrolling.
      if (!this.holder.removed) this.settle(this.holder);
      this.holder = null;
    } else if (this.holder && this.holder.removed) {
      // The gnome's chunk was unloaded: it lets go of the apple where it was.
      this.release(this.holder, apple, player.pos);
      this.holder = null;
    }
    const pp = player.pos;
    for (const g of gnomes) {
      const pos = g.group.position;
      if (g.state === 'down') {
        g.fall += dt;
        const k = clamp(g.fall / FALL_TIME, 0, 1);
        g.body.rotation.x = FALL_ANGLE * k * k;
        g.stars.visible = k >= 1;
        g.stars.rotation.y += dt * 3;
        // Above the head, which lies behind the feet now.
        g.stars.position.set(0, 0.3 + 0.03 * Math.sin(g.fall * 5), -0.5);
        continue;
      }
      let speed = 0;
      if (!active) {
        // Frozen while the game is paused or over.
      } else if (g.state === 'walk') {
        g.t += g.dir * PATROL_SPEED * dt;
        if (g.t > g.span) {
          g.t = g.span;
          g.dir = -1;
        } else if (g.t < -g.span) {
          g.t = -g.span;
          g.dir = 1;
        }
        pos.x = g.homeX + g.axisX * g.t;
        pos.z = g.homeZ + g.axisZ * g.t;
        g.group.rotation.y = damp(g.group.rotation.y, Math.atan2(g.axisX * g.dir, g.axisZ * g.dir), 8, dt);
        speed = PATROL_SPEED;
        if (!apple.held && Math.hypot(apple.pos.x - pos.x, apple.pos.z - pos.z) < GRAB_DIST && apple.pos.y < pos.y + 0.8) {
          g.state = 'carry';
          apple.held = true;
          this.holder = g;
          this.grabs++;
          events.onGrab();
        }
      } else {
        // Run away from the player, but stay within reach of the track.
        let dx = pos.x - pp.x;
        let dz = pos.z - pp.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l;
        dz /= l;
        const off = this.world.pathOffset(pos.x, pos.z);
        if (Math.abs(off) > 9) dx -= Math.sign(off) * Math.min(1.5, (Math.abs(off) - 9) / 3);
        const want = Math.atan2(dx, dz);
        let rel = want - g.group.rotation.y;
        rel = Math.atan2(Math.sin(rel), Math.cos(rel));
        g.group.rotation.y += clamp(rel, -6 * dt, 6 * dt);
        const yaw = g.group.rotation.y;
        pos.x += Math.sin(yaw) * GNOME_RUN_SPEED * dt;
        pos.z += Math.cos(yaw) * GNOME_RUN_SPEED * dt;
        if (pos.z > CFG.path.startLineZ - 1) pos.z = CFG.path.startLineZ - 1;
        this.avoidTrees(pos);
        speed = GNOME_RUN_SPEED;
      }
      pos.y = this.world.groundHeight(pos.x, pos.z);
      // Walk cycle: stepping boots, swinging arms (stretched out while carrying).
      g.phase += speed * dt * 9;
      const sw = Math.sin(g.phase) * Math.min(1, speed);
      g.boots[0].position.z = 0.02 + sw * 0.06;
      g.boots[1].position.z = 0.02 - sw * 0.06;
      g.body.position.y = Math.abs(Math.cos(g.phase)) * 0.025 * Math.min(1, speed);
      const carrying = g.state === 'carry';
      g.arms[0].rotation.x = carrying ? -1.25 : sw * 0.5;
      g.arms[1].rotation.x = carrying ? -1.25 : -sw * 0.5;
      // The player cannot walk through a standing gnome.
      const px = pp.x - pos.x;
      const pz = pp.z - pos.z;
      const pd = Math.hypot(px, pz);
      const minD = GNOME_RADIUS + CFG.player.radius;
      if (pd < minD && pd > 1e-4) {
        pp.x = pos.x + (px / pd) * minD;
        pp.z = pos.z + (pz / pd) * minD;
      }
      if (carrying) {
        g.group.updateMatrixWorld(true);
        apple.pos.copy(g.group.localToWorld(this.tmp.copy(HAND)));
        apple.vel.set(0, 0, 0);
      }
    }
  }

  /** Trees and other solid colliders stop a running gnome; it slides around them. */
  private avoidTrees(pos: THREE.Vector3): void {
    this.world.colliders.forEachNear(pos.z, (col) => {
      if (col.kind !== 'cylinder' || !col.blocksPlayer) return;
      const dx = pos.x - col.x;
      const dz = pos.z - col.z;
      const d = Math.hypot(dx, dz);
      const minD = col.r + GNOME_RADIUS;
      if (d < minD && d > 1e-4) {
        pos.x = col.x + (dx / d) * minD;
        pos.z = col.z + (dz / d) * minD;
      }
    });
  }

  /**
   * A kick that reaches a standing gnome knocks it over; a carried apple drops
   * at its feet. Returns the gnome, or null when none was in reach.
   */
  kick(gnomes: Iterable<Gnome>, player: { pos: THREE.Vector3; forward(out: THREE.Vector3): THREE.Vector3 }, apple: Apple): Gnome | null {
    const fwd = player.forward(this.tmp);
    const pp = player.pos;
    let best: Gnome | null = null;
    let bestD = CFG.kick.reach + GNOME_RADIUS;
    for (const g of gnomes) {
      if (g.state === 'down') continue;
      const p = g.group.position;
      const dx = p.x - pp.x;
      const dz = p.z - pp.z;
      const d = Math.hypot(dx, dz);
      if (d >= bestD || dx * fwd.x + dz * fwd.z < -0.2 || Math.abs(p.y - pp.y) > 1) continue;
      best = g;
      bestD = d;
    }
    if (!best) return null;
    const p = best.group.position;
    // Face the kicker, then tip over backwards.
    best.group.rotation.y = Math.atan2(pp.x - p.x, pp.z - p.z);
    if (best === this.holder) {
      this.release(best, apple, pp);
      this.holder = null;
    }
    best.state = 'down';
    best.fall = 0;
    best.arms[0].rotation.x = best.arms[1].rotation.x = -2.6;
    this.knocked++;
    return best;
  }

  /** Drops the apple in front of the gnome (on the side of the player). */
  private release(g: Gnome, apple: Apple, pp: THREE.Vector3): void {
    const p = g.group.position;
    const dx = pp.x - p.x;
    const dz = pp.z - p.z;
    const l = Math.hypot(dx, dz) || 1;
    const x = p.x + (dx / l) * 0.38;
    const z = p.z + (dz / l) * 0.38;
    apple.drop(x, z);
    g.state = 'down';
  }

  /** The apple was taken away elsewhere: the gnome goes back to patrolling where it stands. */
  private settle(g: Gnome): void {
    g.state = 'walk';
    g.homeX = g.group.position.x;
    g.homeZ = g.group.position.z;
    g.t = 0;
  }
}
