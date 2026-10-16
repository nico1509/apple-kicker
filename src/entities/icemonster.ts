import * as THREE from 'three';
import { CFG } from '../config';
import { clamp, damp } from '../utils/math';
import { mulberry32, rand, subSeed, type Rng } from '../utils/noise';
import { SURFACES, type Collider, type ColliderStore } from '../world/colliders';
import { LANDSCAPE_LENGTH, landscapeOfIndex } from '../world/landscape';

/** What the ice monster needs to know about the world (which is rebuilt for every run). */
export interface IceMonsterHost {
  groundHeight(x: number, z: number): number;
  pathCenterX(p: number): number;
  readonly colliders: ColliderStore;
}

/** Player and apple as far as the ice monster cares. */
export interface IceMonsterTarget {
  readonly pos: THREE.Vector3;
  readonly progress: number;
}

export interface IceMonsterEvents {
  /** The monster storms onto the track. */
  onAppear(): void;
  /** An icicle shoots out of the ground. */
  onIcicle(): void;
  /** The monster ran into the player; shove them by (dx, dz) metres. */
  onBump(dx: number, dz: number): void;
  /** The monster ran into the apple; knock it away at (vx, vz) m/s. */
  onKnockApple(vx: number, vz: number): void;
}

type Phase = 'idle' | 'enter' | 'rage' | 'leave';

interface Icicle {
  group: THREE.Group;
  x: number;
  z: number;
  p: number;
  baseY: number;
  height: number;
  age: number;
  chunk: number;
  collider: Collider;
}

/** Appearances per Antarctic landscape (3 or 4). */
const MIN_VISITS = 3;
/** How long the monster rages on the track (seconds). */
export const RAGE_SECONDS = 5.5;
const RUN_SPEED = 9;
const RAGE_SPEED = 6.5;
/** It comes from this far beside the track and runs back there. */
const SIDE_DISTANCE = 30;
/** Seconds between two icicles. */
const ICICLE_INTERVAL = 0.4;
/** Icicles keep at least this far apart, so there is always a way through. */
const ICICLE_SPACING = 1.6;
const ICICLE_GROW = 0.25;
/** Horizontal radius of the monster's body for bumping into player and apple. */
const BODY_RADIUS = 1.0;
const SCALE = 1.15;

/**
 * The Antarctic ice monster: a hulking, faceted ice creature. A few times per
 * Antarctic landscape it charges in from the side, rushes back and forth on
 * the track for a few seconds while icicles shoot out of the ground behind
 * it, then runs off again. The icicles stay as obstacles (with colliders).
 */
export class IceMonster {
  readonly group = new THREE.Group();
  /** The spikes it leaves behind. */
  readonly icicleGroup = new THREE.Group();
  readonly icicles: Icicle[] = [];
  phase: Phase = 'idle';
  /** Number of times it came onto the track in this world (for tests). */
  appearances = 0;
  private seed = 0;
  private readonly fired = new Set<string>();
  private readonly triggerCache = new Map<number, number[]>();
  private rng: Rng = mulberry32(1);
  /** Centre of the stretch of track it rages on. */
  private centreP = 0;
  private side: 1 | -1 = 1;
  private timer = 0;
  private icicleTimer = 0;
  private retarget = 0;
  private readonly target = new THREE.Vector2();
  private heading = 0;
  private stride = 0;
  private bumpCooldown = 0;
  // Model parts that move.
  private readonly body = new THREE.Group();
  private readonly arms: THREE.Group[] = [];
  private readonly legs: THREE.Group[] = [];
  // Shared geometries and materials.
  private readonly crystalGeo = new THREE.IcosahedronGeometry(1, 0);
  private readonly boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly spikeGeo = new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0);
  private readonly iceMat = new THREE.MeshPhongMaterial({ color: 0x52bdf6, emissive: 0x0e3e6c, specular: 0xe6f6ff, shininess: 90, flatShading: true });
  private readonly iceLightMat = new THREE.MeshPhongMaterial({ color: 0x92dcff, emissive: 0x18527e, specular: 0xffffff, shininess: 110, flatShading: true });
  private readonly eyeMat = new THREE.MeshBasicMaterial({ color: 0xd01a14 });
  private readonly mouthMat = new THREE.MeshBasicMaterial({ color: 0x7a0a0a });
  private readonly icicleMat = new THREE.MeshPhongMaterial({ color: 0xbfe6fb, emissive: 0x1c4466, specular: 0xffffff, shininess: 120, flatShading: true, transparent: true, opacity: 0.9 });

  constructor(
    scene: THREE.Scene,
    private readonly host: IceMonsterHost,
  ) {
    this.group.name = 'ice-monster';
    this.icicleGroup.name = 'icicles';
    this.buildModel();
    this.group.visible = false;
    scene.add(this.group, this.icicleGroup);
  }

  // ---------------------------------------------------------------------------
  // Model

  private part(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  /**
   * A gorilla-like brute of ice crystals, facing local +Z: a massive hunched
   * torso and shoulders, the head sunk low between them with red eyes and a
   * grin, long arms on big fists, short legs.
   */
  private buildModel(): void {
    const g = this.group;
    g.scale.setScalar(SCALE);
    g.add(this.body);
    const b = this.body;
    const ice = this.iceMat;
    const light = this.iceLightMat;
    // Torso, back and the shoulder mass.
    this.part(b, this.crystalGeo, ice, 0, 1.25, -0.15, 0.85, 0.7, 0.7, 0.5, 0.3, 0);
    this.part(b, this.crystalGeo, light, 0, 1.45, -0.35, 0.75, 0.55, 0.6, -0.3, 1.1, 0.2);
    for (const s of [-1, 1]) this.part(b, this.crystalGeo, s < 0 ? light : ice, s * 0.72, 1.5, 0.05, 0.55, 0.5, 0.55, 0.4, s * 0.6, s * 0.3);
    this.part(b, this.crystalGeo, light, 0, 0.95, 0.15, 0.6, 0.45, 0.45, 0.2, 0.8, 0);
    // Head, low and forward, with a heavy brow.
    const head = new THREE.Group();
    head.position.set(0, 1.3, 0.62);
    b.add(head);
    this.part(head, this.crystalGeo, light, 0, 0, 0, 0.42, 0.36, 0.36, 0.3, 0.4, 0);
    this.part(head, this.crystalGeo, ice, 0, 0.17, 0.12, 0.38, 0.13, 0.22, 0, 0.7, 0);
    this.part(head, this.crystalGeo, ice, 0, -0.12, 0.2, 0.3, 0.16, 0.2, 0, 0.3, 0);
    for (const s of [-1, 1]) {
      this.part(head, this.boxGeo, this.eyeMat, s * 0.13, 0.08, 0.33, 0.1, 0.035, 0.04, 0, 0, s * -0.35);
      // The grin: two slanted strokes meeting under the nose.
      this.part(head, this.boxGeo, this.mouthMat, s * 0.1, -0.13, 0.38, 0.2, 0.03, 0.04, 0, 0, s * 0.28);
    }
    // Arms: pivot at the shoulder, the fist reaches down to the ground.
    for (const s of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(s * 0.95, 1.5, 0.1);
      b.add(arm);
      this.part(arm, this.crystalGeo, ice, s * 0.18, -0.35, 0.05, 0.3, 0.48, 0.3, 0.2, 0.5, s * 0.25);
      this.part(arm, this.crystalGeo, light, s * 0.3, -0.85, 0.12, 0.27, 0.42, 0.27, -0.1, 0.9, s * 0.1);
      this.part(arm, this.crystalGeo, ice, s * 0.34, -1.28, 0.2, 0.32, 0.25, 0.34, 0.3, 0.2, 0);
      // Knuckles.
      for (const k of [-1, 0, 1]) this.part(arm, this.crystalGeo, light, s * 0.34 + k * 0.1, -1.4, 0.42, 0.08, 0.08, 0.1, 0.5, 0.5, 0);
      this.arms.push(arm);
    }
    // Short legs under the body.
    for (const s of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(s * 0.42, 0.75, -0.3);
      b.add(leg);
      this.part(leg, this.crystalGeo, light, 0, -0.3, 0, 0.26, 0.38, 0.26, 0.2, 0.4, 0);
      this.part(leg, this.crystalGeo, ice, 0, -0.66, 0.1, 0.24, 0.12, 0.32, 0, 0.6, 0);
      this.legs.push(leg);
    }
  }

  // ---------------------------------------------------------------------------
  // Appearances

  /** Fresh world: no monster on the track, no icicles, all appearances to come. */
  reset(seed: number): void {
    this.seed = seed >>> 0;
    this.fired.clear();
    this.triggerCache.clear();
    this.clearIcicles();
    this.dismiss();
    this.appearances = 0;
  }

  /** Send the monster away at once (e.g. when the run continues elsewhere). The icicles stay. */
  dismiss(): void {
    this.phase = 'idle';
    this.group.visible = false;
  }

  /** True while it is on (or running onto or off) the track. */
  get active(): boolean {
    return this.phase !== 'idle';
  }

  /** Progress of the stretch of track it rages on (meaningful while active). */
  get progress(): number {
    return this.centreP;
  }

  /** Where along the path the monster turns up in landscape section k (empty unless Antarctic). */
  triggersIn(k: number): number[] {
    const cached = this.triggerCache.get(k);
    if (cached) return cached;
    const list: number[] = [];
    if (k >= 0 && landscapeOfIndex(k) === 'antarctic') {
      const rng = mulberry32(subSeed(this.seed, 9500 + k));
      const n = MIN_VISITS + (rng() < 0.5 ? 1 : 0);
      const start = k * LANDSCAPE_LENGTH + 120;
      const span = (LANDSCAPE_LENGTH - 200) / n;
      for (let j = 0; j < n; j++) list.push(start + span * (j + rand(rng, 0.2, 0.8)));
    }
    this.triggerCache.set(k, list);
    return list;
  }

  update(dt: number, player: IceMonsterTarget, apple: IceMonsterTarget, active: boolean, ev: IceMonsterEvents): void {
    this.cleanupIcicles(player.progress);
    this.growIcicles(dt);
    if (!active) return;
    if (this.phase === 'idle') {
      this.checkTriggers(player, apple, ev);
      return;
    }
    this.timer += dt;
    this.bumpCooldown -= dt;
    const g = this.group.position;
    const h = this.host;
    let speed = 0;
    if (this.phase === 'enter') {
      const tx = h.pathCenterX(this.centreP);
      speed = this.moveTowards(tx, -this.centreP, RUN_SPEED, dt);
      if (Math.abs(g.x - tx) < 0.6) {
        this.phase = 'rage';
        this.timer = 0;
        this.icicleTimer = 0.15;
        this.retarget = 0;
      }
    } else if (this.phase === 'rage') {
      // Hectic dashes to random spots on this stretch of track.
      this.retarget -= dt;
      if (this.retarget <= 0 || Math.hypot(this.target.x - g.x, this.target.y - g.z) < 0.4) {
        const p = this.centreP + rand(this.rng, -4.5, 4.5);
        this.target.set(h.pathCenterX(p) + rand(this.rng, -1.5, 1.5), -p);
        this.retarget = rand(this.rng, 0.45, 0.9);
      }
      speed = this.moveTowards(this.target.x, this.target.y, RAGE_SPEED, dt);
      this.icicleTimer -= dt;
      if (this.icicleTimer <= 0) {
        this.icicleTimer += ICICLE_INTERVAL;
        if (this.spawnIcicle(player, apple)) ev.onIcicle();
      }
      if (this.timer >= RAGE_SECONDS) {
        this.phase = 'leave';
        // Off to a random side.
        this.side = this.rng() < 0.5 ? 1 : -1;
      }
    } else {
      const tx = h.pathCenterX(-g.z) + this.side * SIDE_DISTANCE;
      speed = this.moveTowards(tx, g.z, RUN_SPEED, dt);
      if (Math.abs(g.x - tx) < 0.8) this.dismiss();
    }
    this.animate(dt, speed);
    if (this.active) this.bump(player, apple, ev);
  }

  private checkTriggers(player: IceMonsterTarget, apple: IceMonsterTarget, ev: IceMonsterEvents): void {
    const pp = player.progress;
    const k = Math.floor(Math.max(0, pp) / LANDSCAPE_LENGTH);
    const list = this.triggersIn(k);
    for (let j = 0; j < list.length; j++) {
      const key = `${k}:${j}`;
      if (this.fired.has(key)) continue;
      const t = list[j];
      if (pp > t + 40) {
        // Jumped past it (a teleport or a respawn further on): this one is gone.
        this.fired.add(key);
        continue;
      }
      if (pp < t - 20) continue;
      this.fired.add(key);
      this.appear(player, apple, ev, subSeed(this.seed, 9700 + k, j));
      return;
    }
  }

  /** Charge in from the side onto the track just ahead of the player (and the apple, if it is close). */
  private appear(player: IceMonsterTarget, apple: IceMonsterTarget, ev: IceMonsterEvents, seed: number): void {
    this.rng = mulberry32(seed);
    const pp = player.progress;
    this.centreP = clamp(apple.progress, pp, pp + 22) + 7;
    this.side = this.rng() < 0.5 ? 1 : -1;
    const x = this.host.pathCenterX(this.centreP) + this.side * SIDE_DISTANCE;
    const z = -this.centreP;
    this.group.position.set(x, this.host.groundHeight(x, z), z);
    this.heading = Math.atan2(-this.side, 0);
    this.group.rotation.y = this.heading;
    this.group.visible = true;
    this.phase = 'enter';
    this.timer = 0;
    this.appearances++;
    ev.onAppear();
  }

  /** Runs towards (tx, tz), turning to face its way. Returns the speed it ran at. */
  private moveTowards(tx: number, tz: number, speed: number, dt: number): number {
    const g = this.group.position;
    const dx = tx - g.x;
    const dz = tz - g.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-3) return 0;
    const step = Math.min(dist, speed * dt);
    g.x += (dx / dist) * step;
    g.z += (dz / dist) * step;
    g.y = this.host.groundHeight(g.x, g.z);
    let want = Math.atan2(dx, dz);
    let diff = want - this.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    want = this.heading + diff;
    this.heading = damp(this.heading, want, 12, dt);
    this.group.rotation.y = this.heading;
    return step / dt;
  }

  /** Knuckle-walking gallop: arms swing together, legs push off, the body heaves. */
  private animate(dt: number, speed: number): void {
    this.stride += dt * (2.2 + speed * 0.9);
    const a = Math.sin(this.stride);
    const amp = clamp(speed / RUN_SPEED, 0.15, 1);
    for (const [i, arm] of this.arms.entries()) arm.rotation.x = a * 0.75 * amp + (i === 0 ? 0.08 : -0.08) * Math.sin(this.stride * 2);
    for (const leg of this.legs) leg.rotation.x = -a * 0.6 * amp;
    this.body.position.y = Math.abs(Math.cos(this.stride)) * 0.18 * amp;
    this.body.rotation.x = 0.12 + a * 0.08 * amp;
  }

  /** Running into the player shoves them aside; running into the apple knocks it away. */
  private bump(player: IceMonsterTarget, apple: IceMonsterTarget, ev: IceMonsterEvents): void {
    const g = this.group.position;
    const reach = BODY_RADIUS * SCALE;
    const px = player.pos.x - g.x;
    const pz = player.pos.z - g.z;
    const pd = Math.hypot(px, pz);
    if (pd < reach + CFG.player.radius && this.bumpCooldown <= 0) {
      this.bumpCooldown = 0.8;
      const l = pd || 1;
      ev.onBump((px / l) * 2.5, (pz / l) * 2.5);
    }
    const ax = apple.pos.x - g.x;
    const az = apple.pos.z - g.z;
    const ad = Math.hypot(ax, az);
    if (ad < reach && apple.pos.y < g.y + 1.5) {
      const l = ad || 1;
      ev.onKnockApple((ax / l) * 5, (az / l) * 5);
    }
  }

  // ---------------------------------------------------------------------------
  // Icicles

  /**
   * An icicle shoots out of the ground where the monster has just been, on the
   * track. Never right under the player or the apple, and never too close to
   * another icicle, so there is always a way through.
   */
  private spawnIcicle(player: IceMonsterTarget, apple: IceMonsterTarget): boolean {
    const g = this.group.position;
    // Behind the monster, along its way.
    const back = 0.9 * SCALE;
    const x = g.x - Math.sin(this.heading) * back;
    const z = g.z - Math.cos(this.heading) * back;
    const p = -z;
    const d = x - this.host.pathCenterX(p);
    if (Math.abs(d) > CFG.path.halfWidth + 0.6) return false;
    if (Math.hypot(x - player.pos.x, z - player.pos.z) < 1.3) return false;
    if (Math.hypot(x - apple.pos.x, z - apple.pos.z) < 0.8) return false;
    for (const ic of this.icicles) if (Math.hypot(ic.x - x, ic.z - z) < ICICLE_SPACING) return false;
    const rng = this.rng;
    const baseY = this.host.groundHeight(x, z);
    const height = rand(rng, 1.0, 1.55);
    const r = rand(rng, 0.2, 0.27);
    const group = new THREE.Group();
    group.position.set(x, baseY, z);
    const main = new THREE.Mesh(this.spikeGeo, this.icicleMat);
    main.scale.set(r, height, r);
    main.rotation.set(rand(rng, -0.08, 0.08), rng() * 6.28, rand(rng, -0.08, 0.08));
    main.castShadow = true;
    group.add(main);
    // Smaller shards around the base.
    const shards = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < shards; k++) {
      const a = rng() * Math.PI * 2;
      const s = new THREE.Mesh(this.spikeGeo, this.icicleMat);
      const sh = height * rand(rng, 0.25, 0.5);
      s.scale.set(r * 0.5, sh, r * 0.5);
      s.position.set(Math.cos(a) * r * 1.1, -0.03, Math.sin(a) * r * 1.1);
      s.rotation.set(Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45);
      s.castShadow = true;
      group.add(s);
    }
    group.scale.set(1, 0.01, 1);
    this.icicleGroup.add(group);
    const chunk = Math.floor(-z / CFG.chunk.length);
    const collider: Collider = { kind: 'cylinder', x, z, r: r * 1.15, yTop: baseY + height * 0.95, surface: SURFACES.ice, blocksPlayer: true };
    this.host.colliders.add(chunk, collider);
    this.icicles.push({ group, x, z, p, baseY, height, age: 0, chunk, collider });
    return true;
  }

  private growIcicles(dt: number): void {
    for (const ic of this.icicles) {
      if (ic.age >= ICICLE_GROW) continue;
      ic.age = Math.min(ICICLE_GROW, ic.age + dt);
      const t = ic.age / ICICLE_GROW;
      // Shoots up and overshoots a little.
      ic.group.scale.y = Math.max(0.01, 1 + 0.12 * Math.sin(t * Math.PI) - (1 - t) * (1 - t));
    }
  }

  /** Icicles far behind the player go with their chunk. */
  private cleanupIcicles(pp: number): void {
    for (let i = this.icicles.length - 1; i >= 0; i--) {
      const ic = this.icicles[i];
      if (ic.p > pp - 90 && ic.p < pp + 400) continue;
      this.removeIcicle(i);
    }
  }

  private removeIcicle(i: number): void {
    const ic = this.icicles[i];
    this.icicleGroup.remove(ic.group);
    this.host.colliders.remove(ic.chunk, ic.collider);
    this.icicles.splice(i, 1);
  }

  private clearIcicles(): void {
    for (let i = this.icicles.length - 1; i >= 0; i--) this.removeIcicle(i);
  }

  dispose(): void {
    this.clearIcicles();
    this.group.parent?.remove(this.group);
    this.icicleGroup.parent?.remove(this.icicleGroup);
    for (const g of [this.crystalGeo, this.boxGeo, this.spikeGeo]) g.dispose();
    for (const m of [this.iceMat, this.iceLightMat, this.eyeMat, this.mouthMat, this.icicleMat]) m.dispose();
  }
}
