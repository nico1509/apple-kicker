import * as THREE from 'three';
import { clamp, damp } from '../utils/math';
import { rand, type Rng } from '../utils/noise';

/** A camel lying on the track. Its neck turns towards the player and it spits. */
export interface Camel {
  group: THREE.Group;
  /** Pivot at the base of the neck (turns towards the player). */
  neck: THREE.Group;
  /** Marks the mouth, where the spit starts. */
  mouth: THREE.Object3D;
  /** Seconds until the next spit while the player is in range (0: spit as soon as the player steps in). */
  timer: number;
}

/** Seconds between two spits of the same camel. */
export const SPIT_INTERVAL = 1;
/** Metres the player is pushed along the flight direction of a spit that hits. */
export const SPIT_PUSH = 5;
/** Within this distance (metres) the camel watches and spits at the player; beyond it the camel does nothing. */
export const SPIT_RANGE = 10;
const SPIT_GRAVITY = 9.81;
/** Neck can turn this far to either side (radians). */
const NECK_LIMIT = 1.7;

/** Builds the low-poly camel model; geometries and materials are shared by all camels. */
export class CamelFactory {
  private readonly blob = new THREE.IcosahedronGeometry(1, 1);
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly neckGeo = new THREE.CylinderGeometry(0.11, 0.16, 1, 6).translate(0, 0.5, 0);
  private readonly fur = new THREE.MeshLambertMaterial({ color: 0xd4aa6c, flatShading: true });
  private readonly furDark = new THREE.MeshLambertMaterial({ color: 0xa77d48, flatShading: true });
  private readonly blanket = new THREE.MeshLambertMaterial({ color: 0xa8262a, flatShading: true });
  private readonly trim = new THREE.MeshLambertMaterial({ color: 0xe0b040, flatShading: true });
  private readonly eye = new THREE.MeshLambertMaterial({ color: 0x1e1a16 });

  private part(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.rotation.x = rx;
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  /** A camel lying down at (x, y, z), facing local +Z rotated by yaw. */
  build(x: number, y: number, z: number, yaw: number, rng: Rng): Camel {
    const group = new THREE.Group();
    group.name = 'camel';
    group.position.set(x, y, z);
    group.rotation.y = yaw;
    // Body, hump and the colourful saddle blanket.
    this.part(group, this.blob, this.fur, 0, 0.42, 0, 0.5, 0.42, 0.95);
    this.part(group, this.blob, this.fur, 0, 0.82, -0.08, 0.36, 0.32, 0.45);
    this.part(group, this.box, this.blanket, 0, 0.66, -0.05, 1.04, 0.36, 0.72);
    this.part(group, this.box, this.trim, 0, 0.47, -0.05, 1.06, 0.06, 0.74);
    // Folded legs and the tail.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) this.part(group, this.box, this.furDark, sx * 0.38, 0.08, sz * 0.5, 0.16, 0.14, 0.45);
    }
    this.part(group, this.box, this.furDark, 0, 0.35, -0.98, 0.06, 0.4, 0.06, 0.4);
    // Neck and head.
    const neck = new THREE.Group();
    neck.position.set(0, 0.48, 0.8);
    neck.rotation.y = rand(rng, -0.5, 0.5);
    group.add(neck);
    // The neck reaches forward, then the head sits up a little.
    this.part(neck, this.neckGeo, this.fur, 0, 0, 0, 1, 0.85, 1, 0.95);
    const head = new THREE.Group();
    head.position.set(0, 0.5, 0.68);
    neck.add(head);
    this.part(head, this.blob, this.fur, 0, 0, 0.08, 0.15, 0.15, 0.24);
    this.part(head, this.blob, this.furDark, 0, -0.04, 0.3, 0.1, 0.1, 0.13);
    for (const sx of [-1, 1]) {
      this.part(head, this.blob, this.eye, sx * 0.12, 0.05, 0.12, 0.03, 0.03, 0.03);
      this.part(head, this.box, this.furDark, sx * 0.09, 0.16, -0.05, 0.04, 0.09, 0.04);
    }
    const mouth = new THREE.Object3D();
    mouth.position.set(0, -0.06, 0.42);
    head.add(mouth);
    return { group, neck, mouth, timer: 0 };
  }

  dispose(): void {
    for (const g of [this.blob, this.box, this.neckGeo]) g.dispose();
    for (const m of [this.fur, this.furDark, this.blanket, this.trim, this.eye]) m.dispose();
  }
}

interface Spit {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  age: number;
}

/** What the spit system needs to know about the player. */
export interface SpitTarget {
  readonly pos: THREE.Vector3;
}

/**
 * Turns the camels' heads towards the player, lets them spit every
 * SPIT_INTERVAL seconds and flies the spit. A hit calls onHit with the
 * horizontal flight direction.
 */
export class CamelSpit {
  readonly group = new THREE.Group();
  private readonly spits: Spit[] = [];
  private readonly geo = new THREE.IcosahedronGeometry(0.075, 1);
  private readonly mat = new THREE.MeshLambertMaterial({ color: 0xe6ead2, emissive: 0x30352a, transparent: true, opacity: 0.9 });
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  /** Number of spits fired so far (for tests). */
  fired = 0;

  constructor(
    scene: THREE.Scene,
    private readonly groundHeight: (x: number, z: number) => number,
  ) {
    this.group.name = 'spit';
    scene.add(this.group);
  }

  update(dt: number, camels: Iterable<Camel>, player: SpitTarget, active: boolean, onHit: (dirX: number, dirZ: number) => void): void {
    const p = player.pos;
    for (const camel of camels) {
      const g = camel.group;
      const dx = p.x - g.position.x;
      const dz = p.z - g.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SPIT_RANGE) {
        // Out of range the camel rests; it spits at once when the player comes back.
        camel.timer = 0;
        continue;
      }
      // Look at the player.
      let rel = Math.atan2(dx, dz) - g.rotation.y;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      camel.neck.rotation.y = damp(camel.neck.rotation.y, clamp(rel, -NECK_LIMIT, NECK_LIMIT), 10, dt);
      if (!active || dist < 1.2) continue;
      camel.timer -= dt;
      if (camel.timer <= 0) {
        camel.timer += SPIT_INTERVAL;
        this.fire(camel, p);
      }
    }
    // Fly the spit.
    for (let i = this.spits.length - 1; i >= 0; i--) {
      const s = this.spits[i];
      s.age += dt;
      s.vel.y -= SPIT_GRAVITY * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      const m = s.mesh.position;
      // Hit test against the player's body (a vertical segment).
      const by = clamp(m.y, p.y + 0.3, p.y + 1.75);
      const hit = active && Math.hypot(m.x - p.x, m.y - by, m.z - p.z) < 0.38;
      if (hit) {
        const l = Math.hypot(s.vel.x, s.vel.z) || 1;
        onHit(s.vel.x / l, s.vel.z / l);
      }
      if (hit || s.age > 2.5 || m.y < this.groundHeight(m.x, m.z)) {
        this.group.remove(s.mesh);
        this.spits.splice(i, 1);
      }
    }
  }

  private fire(camel: Camel, p: THREE.Vector3): void {
    camel.group.updateMatrixWorld(true);
    const start = camel.mouth.getWorldPosition(this.tmp);
    const target = this.tmp2.set(p.x, p.y + 1.45, p.z);
    const dist = start.distanceTo(target);
    const t = clamp(dist / 11, 0.25, 1.4);
    const vel = new THREE.Vector3(
      (target.x - start.x) / t,
      (target.y - start.y) / t + 0.5 * SPIT_GRAVITY * t,
      (target.z - start.z) / t,
    );
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.position.copy(start);
    this.group.add(mesh);
    this.spits.push({ mesh, vel, age: 0 });
    this.fired++;
  }

  clear(): void {
    for (const s of this.spits) this.group.remove(s.mesh);
    this.spits.length = 0;
  }

  dispose(): void {
    this.clear();
    this.group.parent?.remove(this.group);
    this.geo.dispose();
    this.mat.dispose();
  }
}
