import * as THREE from 'three';
import { CFG } from '../config';
import { clamp, damp } from '../utils/math';
import { mulberry32, rand, type Rng } from '../utils/noise';
import type { ColliderStore } from '../world/colliders';
import type { Apple } from './apple';

/**
 * A zombie of the small town. It shambles about on the road; when the player
 * comes within 20 m it follows them, and once it stands very close it draws
 * back its arms and hits. A hit takes all of the player's stamina. The player
 * can kick it over like a gnome.
 */
export interface Zombie {
  /** Unique number (for tests). */
  id: number;
  group: THREE.Group;
  /** Pivot at the feet; tips over when the zombie is kicked. */
  body: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  arms: THREE.Group[];
  legs: THREE.Group[];
  stars: THREE.Group;
  /** Where it wanders about (on the road). */
  homeX: number;
  homeZ: number;
  targetX: number;
  targetZ: number;
  /** Seconds it stands still before it picks the next spot to wander to. */
  pause: number;
  state: 'wander' | 'chase' | 'windup' | 'down';
  /** Seconds into the wind-up, or since it was kicked over. */
  timer: number;
  /** Seconds until it may hit again. */
  cooldown: number;
  /** Seconds left of the follow-through after a blow (arms swing down). */
  swing: number;
  phase: number;
  /** Seconds it has hardly got anywhere (blocked by a car or a barrier). */
  stuck: number;
  /** Seconds left of walking round an obstacle, and to which side (+1 left, -1 right). */
  detour: number;
  detourSide: 1 | -1;
  rng: Rng;
  /** Set when its chunk is unloaded. */
  removed: boolean;
}

export const ZOMBIE_RADIUS = 0.3;
/** It follows a player who comes this close. */
export const ZOMBIE_CHASE_RANGE = 20;
/** Its blow reaches as far as the player's kick. */
export const ZOMBIE_HIT_RANGE = CFG.kick.reach + ZOMBIE_RADIUS;
/** It only starts to draw back when the player stands a little closer than that. */
const WINDUP_START = ZOMBIE_HIT_RANGE - 0.35;
/** Seconds from drawing back to the blow: time for the player to step away or kick. */
export const ZOMBIE_WINDUP = 0.75;
/** A zombie hits at most once in this many seconds. */
export const ZOMBIE_COOLDOWN = 3;
const WANDER_SPEED = 0.55;
/** Slower than the player walks, so they can always get away. */
export const ZOMBIE_CHASE_SPEED = 1.7;
/** While wandering it keeps within this distance of the road's centre line. */
const WANDER_HALF_WIDTH = 2.1;
const FALL_TIME = 0.45;
const FALL_ANGLE = -Math.PI / 2 + 0.1;
/** Arm angles (about the shoulder): reaching forward, drawn back over the head, struck down. */
const ARMS_REACH = -1.35;
const ARMS_RAISED = -2.9;
const ARMS_STRUCK = -0.55;

const SKIN_COLORS = [0xa9ad94, 0x9fa38b, 0xb4ab96, 0x9a9c86];
const HAIR_COLORS = [0x2e241c, 0x9c4a22, 0x5a4a3a, 0x77736c];
const SHIRT_COLORS = [0x7a2c26, 0x4f8a90, 0x8a5a3a, 0x5b5f45, 0x6a3e52];
const TROUSER_COLORS = [0x5c564c, 0x4a5464, 0x6d6a4e, 0x3f3b37];

/** Builds the low-poly zombie models; geometries and materials are shared. */
export class ZombieFactory {
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly starGeo: THREE.BufferGeometry;
  private readonly lambert = new Map<number, THREE.MeshLambertMaterial>();
  private readonly starMat = new THREE.MeshBasicMaterial({ color: 0xffd84a });
  private readonly eyeMat = new THREE.MeshBasicMaterial({ color: 0xd8d0a0 });
  private built = 0;

  constructor() {
    const shape = new THREE.Shape();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 + Math.PI / 2;
      const r = k % 2 === 0 ? 0.09 : 0.038;
      if (k === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    shape.closePath();
    this.starGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: false }).translate(0, 0, -0.01);
  }

  private mat(color: number): THREE.MeshLambertMaterial {
    let m = this.lambert.get(color);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color, flatShading: true });
      this.lambert.set(color, m);
    }
    return m;
  }

  private part(parent: THREE.Object3D, mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
    const m = new THREE.Mesh(this.box, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  /** A zombie, about 1.75 m tall and facing local +Z, wandering around (x, z). */
  build(x: number, y: number, z: number, rng: Rng): Zombie {
    const pick = (list: number[]): THREE.MeshLambertMaterial => this.mat(list[Math.floor(rng() * list.length)]);
    const skin = pick(SKIN_COLORS);
    const hair = pick(HAIR_COLORS);
    const shirt = pick(SHIRT_COLORS);
    const trousers = pick(TROUSER_COLORS);
    const blood = this.mat(0x6a1512);
    const dark = this.mat(0x2a2522);
    const shoe = this.mat(0x2f2a26);

    const group = new THREE.Group();
    group.name = 'zombie';
    group.position.set(x, y, z);
    group.scale.setScalar(rand(rng, 0.95, 1.05));
    const body = new THREE.Group();
    group.add(body);

    // Legs hang from the hips and swing when it walks.
    const legs = [-1, 1].map((s) => {
      const leg = new THREE.Group();
      leg.position.set(s * 0.1, 0.88, 0);
      body.add(leg);
      this.part(leg, trousers, 0, -0.42, 0, 0.15, 0.84, 0.17);
      this.part(leg, shoe, 0, -0.85, 0.04, 0.14, 0.08, 0.26);
      // Torn trousers: a dark patch on one knee.
      if (rng() < 0.5) this.part(leg, blood, 0, -0.45, 0.088, 0.1, 0.12, 0.01);
      return leg;
    });
    this.part(body, trousers, 0, 0.9, 0, 0.34, 0.14, 0.2);

    // A hunched torso, leaning forward.
    const torso = new THREE.Group();
    torso.position.set(0, 0.92, 0);
    torso.rotation.x = rand(rng, 0.18, 0.32);
    body.add(torso);
    this.part(torso, shirt, 0, 0.3, 0, 0.4, 0.58, 0.23);
    // A hanging shirt tail and an open collar.
    this.part(torso, shirt, 0.04, -0.02, 0.01, 0.36, 0.12, 0.22, 0, 0, rand(rng, -0.12, 0.12));
    this.part(torso, skin, 0, 0.53, 0.112, 0.13, 0.12, 0.01);
    // Blood stains on the shirt.
    const stains = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < stains; k++) {
      const s = rand(rng, 0.05, 0.11);
      this.part(torso, blood, rand(rng, -0.14, 0.14), rand(rng, 0.08, 0.5), 0.117, s, s * rand(rng, 0.6, 1.4), 0.01);
    }

    // The head hangs forward and to one side.
    const head = new THREE.Group();
    head.position.set(0, 0.62, 0.02);
    head.rotation.set(rand(rng, 0.1, 0.3), rand(rng, -0.2, 0.2), rand(rng, -0.3, 0.3));
    torso.add(head);
    this.part(head, skin, 0, 0.06, 0, 0.09, 0.12, 0.09);
    this.part(head, skin, 0, 0.2, 0.01, 0.21, 0.25, 0.23);
    this.part(head, hair, 0, 0.33, -0.01, 0.23, 0.06, 0.25);
    this.part(head, hair, 0, 0.24, -0.11, 0.23, 0.2, 0.04);
    // Long hair hanging down for some.
    if (rng() < 0.3) for (const s of [-1, 1]) this.part(head, hair, s * 0.11, 0.12, -0.03, 0.04, 0.32, 0.2);
    // Sunken eyes with pale pupils, an open, bloody mouth.
    for (const s of [-1, 1]) {
      this.part(head, dark, s * 0.055, 0.23, 0.116, 0.06, 0.04, 0.01);
      this.part(head, this.eyeMat, s * 0.055, 0.23, 0.12, 0.022, 0.022, 0.01);
    }
    this.part(head, blood, 0, 0.13, 0.117, 0.09, 0.05, 0.01);
    this.part(head, dark, 0, 0.135, 0.12, 0.06, 0.025, 0.01);

    // Arms reach forward from the shoulders.
    const arms = [-1, 1].map((s) => {
      const arm = new THREE.Group();
      arm.position.set(s * 0.25, 0.55, 0);
      arm.rotation.set(ARMS_REACH, 0, s * 0.08);
      torso.add(arm);
      this.part(arm, shirt, 0, -0.2, 0, 0.11, 0.42, 0.12);
      this.part(arm, skin, 0, -0.5, 0, 0.085, 0.24, 0.09);
      this.part(arm, skin, 0, -0.66, 0.01, 0.09, 0.1, 0.05);
      if (rng() < 0.5) this.part(arm, blood, 0, -0.55, 0.047, 0.06, 0.08, 0.01);
      return arm;
    });

    const stars = new THREE.Group();
    stars.visible = false;
    group.add(stars);
    const count = rng() < 0.5 ? 2 : 3;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2;
      const star = new THREE.Mesh(this.starGeo, this.starMat);
      star.position.set(Math.cos(a) * 0.24, 0, Math.sin(a) * 0.24);
      star.rotation.y = -a;
      stars.add(star);
    }
    group.rotation.y = rng() * Math.PI * 2;
    const seed = Math.floor(rng() * 0xffffffff);
    return {
      id: this.built++,
      group, body, torso, head, arms, legs, stars,
      homeX: x, homeZ: z, targetX: x, targetZ: z,
      pause: rand(rng, 0, 2),
      state: 'wander',
      timer: 0,
      cooldown: 0,
      swing: 0,
      phase: rng() * 6,
      stuck: 0,
      detour: 0,
      detourSide: 1,
      rng: mulberry32(seed),
      removed: false,
    };
  }

  dispose(): void {
    this.box.dispose();
    this.starGeo.dispose();
    for (const m of this.lambert.values()) m.dispose();
    this.starMat.dispose();
    this.eyeMat.dispose();
  }
}

/** What the zombies need to know about the world. */
export interface ZombieWorld {
  groundHeight(x: number, z: number): number;
  readonly colliders: ColliderStore;
  pathCenterX(p: number): number;
}

export interface ZombieEvents {
  /** It noticed the player and follows them. */
  onChase(): void;
  /** It draws back to hit. */
  onWindup(): void;
  /** The blow landed. */
  onHit(): void;
}

/** Moves the zombies, lets them hit the player and knocks them over when kicked. */
export class ZombieHorde {
  /** Counters for tests. */
  hits = 0;
  swings = 0;
  knocked = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly world: ZombieWorld) {}

  update(dt: number, zombies: Iterable<Zombie>, apple: Apple, player: { pos: THREE.Vector3 }, active: boolean, events: ZombieEvents): void {
    const pp = player.pos;
    for (const zb of zombies) {
      const pos = zb.group.position;
      if (zb.state === 'down') {
        zb.timer += dt;
        const k = clamp(zb.timer / FALL_TIME, 0, 1);
        zb.body.rotation.x = FALL_ANGLE * k * k;
        zb.stars.visible = k >= 1;
        zb.stars.rotation.y += dt * 3;
        // Above the head, which lies behind the feet now.
        zb.stars.position.set(0, 0.35 + 0.03 * Math.sin(zb.timer * 5), -1.65);
        continue;
      }
      if (!active) continue;
      zb.cooldown = Math.max(0, zb.cooldown - dt);
      zb.swing = Math.max(0, zb.swing - dt);
      const dx = pp.x - pos.x;
      const dz = pp.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const near = dist < ZOMBIE_CHASE_RANGE;
      let speed = 0;
      if (zb.state === 'windup') {
        // Drawn back: it stands and turns to face the player, then strikes.
        zb.timer += dt;
        this.turnTo(zb, dx, dz, 6, dt);
        if (zb.timer >= ZOMBIE_WINDUP) {
          zb.state = near ? 'chase' : 'wander';
          zb.cooldown = ZOMBIE_COOLDOWN;
          zb.swing = 0.35;
          this.swings++;
          if (dist <= ZOMBIE_HIT_RANGE && Math.abs(pp.y - pos.y) < 1.2) {
            this.hits++;
            events.onHit();
          }
          if (zb.state === 'wander') this.settle(zb);
        }
      } else if (near) {
        if (zb.state !== 'chase') {
          zb.state = 'chase';
          events.onChase();
        }
        if (dist <= WINDUP_START && zb.cooldown <= 0) {
          zb.state = 'windup';
          zb.timer = 0;
          events.onWindup();
        } else if (dist > ZOMBIE_RADIUS + CFG.player.radius + 0.25) {
          speed = this.walk(zb, dx, dz, ZOMBIE_CHASE_SPEED, dt, 9);
        } else {
          this.turnTo(zb, dx, dz, 6, dt);
        }
      } else {
        if (zb.state === 'chase') {
          // The player got away: shamble about where it stands.
          zb.state = 'wander';
          this.settle(zb);
        }
        speed = this.wander(zb, dt);
      }
      pos.y = this.world.groundHeight(pos.x, pos.z);
      this.animate(zb, speed, dt);
      // The player cannot walk through a standing zombie.
      const minD = ZOMBIE_RADIUS + CFG.player.radius;
      const pd = Math.hypot(pp.x - pos.x, pp.z - pos.z);
      if (pd < minD && pd > 1e-4) {
        pp.x = pos.x + ((pp.x - pos.x) / pd) * minD;
        pp.z = pos.z + ((pp.z - pos.z) / pd) * minD;
      }
      this.bumpApple(zb, apple, speed);
    }
  }

  /** Wander from spot to spot on the road, with a pause now and then. */
  private wander(zb: Zombie, dt: number): number {
    const pos = zb.group.position;
    const dx = zb.targetX - pos.x;
    const dz = zb.targetZ - pos.z;
    if (Math.hypot(dx, dz) < 0.25) {
      zb.pause -= dt;
      if (zb.pause <= 0) {
        // The next spot: somewhere on the road near home.
        const p = -zb.homeZ + rand(zb.rng, -4, 4);
        zb.targetZ = -p;
        zb.targetX = this.world.pathCenterX(p) + rand(zb.rng, -WANDER_HALF_WIDTH, WANDER_HALF_WIDTH);
        zb.pause = rand(zb.rng, 0.5, 2.5);
      }
      return 0;
    }
    return this.walk(zb, dx, dz, WANDER_SPEED, dt, WANDER_HALF_WIDTH + 0.5);
  }

  /** Walks in direction (dx, dz), turning smoothly and keeping within `maxOff` of the road. */
  private walk(zb: Zombie, dx: number, dz: number, speed: number, dt: number, maxOff: number): number {
    const pos = zb.group.position;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const off = pos.x - this.world.pathCenterX(-pos.z);
    if (Math.abs(off) > maxOff) dx -= Math.sign(off) * Math.min(1.5, (Math.abs(off) - maxOff) / 2);
    if (zb.detour > 0) {
      // Walking round a car or a barrier: turn the way off to one side.
      zb.detour -= dt;
      const a = zb.detourSide * 1.3;
      const rx = dx * Math.cos(a) + dz * Math.sin(a);
      dz = -dx * Math.sin(a) + dz * Math.cos(a);
      dx = rx;
    }
    this.turnTo(zb, dx, dz, 4, dt);
    const yaw = zb.group.rotation.y;
    const x0 = pos.x;
    const z0 = pos.z;
    pos.x += Math.sin(yaw) * speed * dt;
    pos.z += Math.cos(yaw) * speed * dt;
    if (pos.z > CFG.path.startLineZ - 1) pos.z = CFG.path.startLineZ - 1;
    this.avoidObstacles(pos);
    const moved = Math.hypot(pos.x - x0, pos.z - z0);
    zb.stuck = moved < speed * dt * 0.4 ? zb.stuck + dt : Math.max(0, zb.stuck - dt);
    if (zb.stuck > 0.3 && zb.detour <= 0) {
      zb.stuck = 0;
      zb.detour = 1.2;
      // Round the side with more room on the road.
      zb.detourSide = (off > 0) === (Math.cos(yaw) < 0) ? 1 : -1;
      if (zb.rng() < 0.25) zb.detourSide = zb.detourSide === 1 ? -1 : 1;
    }
    return speed;
  }

  private turnTo(zb: Zombie, dx: number, dz: number, rate: number, dt: number): void {
    let rel = Math.atan2(dx, dz) - zb.group.rotation.y;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    zb.group.rotation.y += clamp(rel, -rate * dt, rate * dt);
  }

  /** Trees, cars and other solid colliders stop a zombie; it slides around them. */
  private avoidObstacles(pos: THREE.Vector3): void {
    this.world.colliders.forEachNear(pos.z, (col) => {
      if (!col.blocksPlayer) return;
      let cx: number;
      let cz: number;
      let r: number;
      if (col.kind === 'cylinder') {
        if (col.yTop < pos.y + 0.3) return;
        cx = col.x; cz = col.z; r = col.r;
      } else if (col.kind === 'capsule') {
        if (Math.max(col.ay, col.by) + col.r < pos.y + 0.25) return;
        const abx = col.bx - col.ax;
        const abz = col.bz - col.az;
        const len2 = abx * abx + abz * abz;
        const t = len2 > 0 ? clamp(((pos.x - col.ax) * abx + (pos.z - col.az) * abz) / len2, 0, 1) : 0;
        cx = col.ax + abx * t; cz = col.az + abz * t; r = col.r;
      } else return;
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d = Math.hypot(dx, dz);
      const minD = r + ZOMBIE_RADIUS;
      if (d < minD && d > 1e-4) {
        pos.x = cx + (dx / d) * minD;
        pos.z = cz + (dz / d) * minD;
      }
    });
  }

  /** The apple bounces off a standing zombie (and is pushed along when it walks into it). */
  private bumpApple(zb: Zombie, apple: Apple, speed: number): void {
    if (apple.held) return;
    const pos = zb.group.position;
    const dx = apple.pos.x - pos.x;
    const dz = apple.pos.z - pos.z;
    const d = Math.hypot(dx, dz);
    const minD = ZOMBIE_RADIUS + apple.radius;
    if (d >= minD || d < 1e-4 || apple.pos.y > pos.y + 1.7) return;
    const nx = dx / d;
    const nz = dz / d;
    apple.pos.x = pos.x + nx * minD;
    apple.pos.z = pos.z + nz * minD;
    const vn = apple.vel.x * nx + apple.vel.z * nz;
    if (vn < 0) {
      apple.vel.x -= 1.3 * vn * nx;
      apple.vel.z -= 1.3 * vn * nz;
      apple.resting = false;
    }
    if (speed > 0) apple.nudge(nx * speed * 1.2, nz * speed * 1.2);
  }

  /** Shambling walk, arms reaching out; drawn back over the head in the wind-up, struck down after. */
  private animate(zb: Zombie, speed: number, dt: number): void {
    zb.phase += dt * (1.5 + speed * 3.2);
    const sw = Math.sin(zb.phase) * Math.min(1, speed / 0.8 + 0.15);
    zb.legs[0].rotation.x = sw * 0.45;
    zb.legs[1].rotation.x = -sw * 0.45;
    zb.body.position.y = Math.abs(Math.cos(zb.phase)) * 0.03 * Math.min(1, speed);
    // A lurching sway from side to side.
    zb.body.rotation.z = Math.sin(zb.phase) * 0.06;
    let arms: number;
    if (zb.state === 'windup') arms = ARMS_REACH + (ARMS_RAISED - ARMS_REACH) * clamp(zb.timer / (ZOMBIE_WINDUP * 0.6), 0, 1);
    else if (zb.swing > 0) arms = ARMS_STRUCK;
    else arms = ARMS_REACH + Math.sin(zb.phase * 0.5) * 0.12;
    const lambda = zb.state === 'windup' ? 14 : zb.swing > 0.2 ? 40 : 6;
    zb.arms[0].rotation.x = damp(zb.arms[0].rotation.x, arms + sw * 0.1, lambda, dt);
    zb.arms[1].rotation.x = damp(zb.arms[1].rotation.x, arms - sw * 0.1, lambda, dt);
    // Leaning back while drawing back, forward into the blow.
    const lean = zb.state === 'windup' ? -0.15 : zb.swing > 0 ? 0.55 : 0.25;
    zb.torso.rotation.x = damp(zb.torso.rotation.x, lean, 10, dt);
  }

  /**
   * A kick that reaches a standing zombie knocks it over. Returns the zombie,
   * or null when none was in reach.
   */
  kick(zombies: Iterable<Zombie>, player: { pos: THREE.Vector3; forward(out: THREE.Vector3): THREE.Vector3 }): Zombie | null {
    const fwd = player.forward(this.tmp);
    const pp = player.pos;
    let best: Zombie | null = null;
    let bestD = CFG.kick.reach + ZOMBIE_RADIUS;
    for (const zb of zombies) {
      if (zb.state === 'down') continue;
      const p = zb.group.position;
      const dx = p.x - pp.x;
      const dz = p.z - pp.z;
      const d = Math.hypot(dx, dz);
      if (d >= bestD || dx * fwd.x + dz * fwd.z < -0.2 || Math.abs(p.y - pp.y) > 1) continue;
      best = zb;
      bestD = d;
    }
    if (!best) return null;
    const p = best.group.position;
    // Face the kicker, then topple over backwards.
    best.group.rotation.y = Math.atan2(pp.x - p.x, pp.z - p.z);
    best.state = 'down';
    best.timer = 0;
    best.body.rotation.z = 0;
    best.arms[0].rotation.x = best.arms[1].rotation.x = -2.8;
    this.knocked++;
    return best;
  }

  /** Wander again around the spot where it stands. */
  private settle(zb: Zombie): void {
    const pos = zb.group.position;
    const p = -pos.z;
    const cx = this.world.pathCenterX(p);
    zb.homeX = cx + clamp(pos.x - cx, -WANDER_HALF_WIDTH, WANDER_HALF_WIDTH);
    zb.homeZ = pos.z;
    zb.targetX = zb.homeX;
    zb.targetZ = zb.homeZ;
    zb.pause = rand(zb.rng, 0.5, 1.5);
  }
}
