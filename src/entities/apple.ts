import * as THREE from 'three';
import { CFG } from '../config';
import { sphereContact, type Contact, type Surface } from '../world/colliders';
import { World } from '../world/world';

export interface AppleEvents {
  /** Bounce on the ground; strength is the normal impact speed in m/s. */
  onBounce(strength: number): void;
  /** Hit an obstacle; strength is the normal impact speed in m/s. */
  onHit(strength: number): void;
}

const SUBSTEP = 1 / 240;
const MAX_SUBSTEPS = 12;

const DUMMY_SURFACE: Surface = { restitution: 0, friction: 0 };

/**
 * The apple is a sphere rolling on the height field and bouncing off the
 * analytic colliders (trees, roots, logs, stones, bushes).
 */
export class Apple {
  readonly mesh = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly radius = CFG.apple.radius;
  onGround = false;
  resting = false;
  /** Side spin from the kicking foot; positive curves to the right of travel. */
  curl = 0;
  /** Furthest progress along the path ever reached. */
  maxProgress = 0;
  /** Seconds since the last kick. */
  sinceKick = 999;
  /** True while a gnome carries the apple off: it moves the apple, physics pauses. */
  held = false;
  private readonly normal = new THREE.Vector3(0, 1, 0);
  private readonly tmp = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly spinAxis = new THREE.Vector3(1, 0, 0);
  private spinRate = 0;
  private readonly contact: Contact = { nx: 0, ny: 1, nz: 0, depth: 0, surface: DUMMY_SURFACE };
  private accumulator = 0;
  private readonly body: THREE.Mesh;
  private bounceCooldown = 0;
  private hitCooldown = 0;
  /** While positive the apple is hopping over a low obstacle (twig, root). */
  private hopCooldown = 0;

  constructor(
    private readonly world: World,
    private readonly events: AppleEvents,
  ) {
    const r = this.radius;
    const geo = new THREE.SphereGeometry(r, 12, 9);
    geo.scale(1, 0.92, 1);
    // Vertex colours: sunny side yellow-green, the rest red.
    const pos = geo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const red = new THREE.Color(0xc62b24);
    const yellow = new THREE.Color(0xe0b23a);
    const green = new THREE.Color(0x9bb53a);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / r;
      const x = pos.getX(i) / r;
      const t = THREE.MathUtils.clamp((y * 0.6 + x * 0.5 + 0.3), 0, 1);
      c.copy(red).lerp(yellow, t * 0.8);
      if (y > 0.6) c.lerp(green, (y - 0.6) * 0.8);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.body = new THREE.Mesh(geo, mat);
    this.body.castShadow = true;
    this.body.receiveShadow = false;
    this.mesh.add(this.body);
    // Stem and leaf.
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.06, r * 0.09, r * 0.5, 5),
      new THREE.MeshLambertMaterial({ color: 0x5a3b22 }),
    );
    stem.position.y = r * 0.95;
    stem.rotation.z = 0.25;
    this.body.add(stem);
    const leaf = new THREE.Mesh(
      new THREE.CircleGeometry(r * 0.32, 6),
      new THREE.MeshLambertMaterial({ color: 0x6fa23a, side: THREE.DoubleSide }),
    );
    leaf.scale.set(1, 0.5, 1);
    leaf.position.set(r * 0.2, r * 1.05, 0);
    leaf.rotation.set(-1.2, 0.3, 0.4);
    this.body.add(leaf);
    this.mesh.name = 'apple';
  }

  get progress(): number {
    return -this.pos.z;
  }

  get speed(): number {
    return this.vel.length();
  }

  reset(x: number, z: number): void {
    this.pos.set(x, this.world.groundHeight(x, z) + this.radius, z);
    this.vel.set(0, 0, 0);
    this.curl = 0;
    this.held = false;
    this.maxProgress = 0;
    this.resting = true;
    this.onGround = true;
    this.sinceKick = 999;
    this.body.quaternion.identity();
    this.mesh.position.copy(this.pos);
  }

  /** Launch the apple. `dir` is a unit vector including the elevation. */
  kick(dir: THREE.Vector3, speed: number, curl: number, extra: THREE.Vector3): void {
    this.vel.copy(dir).multiplyScalar(speed).add(extra);
    this.pos.y = Math.max(this.pos.y, this.world.groundHeight(this.pos.x, this.pos.z) + this.radius + 0.01);
    this.curl = curl;
    this.resting = false;
    this.onGround = false;
    this.sinceKick = 0;
  }

  /** A gnome lets go of the apple: it drops onto the ground at (x, z). */
  drop(x: number, z: number): void {
    this.held = false;
    this.pos.set(x, this.world.groundHeight(x, z) + this.radius + 0.05, z);
    this.vel.set(0, 0, 0);
    this.curl = 0;
    this.resting = false;
    this.onGround = false;
    this.accumulator = 0;
    this.mesh.position.copy(this.pos);
  }

  /** Gentle push, e.g. from the player walking into the apple. Never slows it down. */
  nudge(vx: number, vz: number): void {
    if (Math.hypot(this.vel.x, this.vel.z) > Math.hypot(vx, vz)) return;
    this.vel.x = vx;
    this.vel.z = vz;
    if (this.vel.y < 0) this.vel.y = 0;
    this.resting = false;
  }

  update(dt: number): void {
    this.sinceKick += dt;
    if (this.held) {
      // Carried: the gnome sets the position; the distance does not count.
      this.accumulator = 0;
      this.mesh.position.copy(this.pos);
      return;
    }
    this.bounceCooldown -= dt;
    this.hitCooldown -= dt;
    this.hopCooldown -= dt;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= SUBSTEP && steps < MAX_SUBSTEPS) {
      // Keep the travel per inner step below ~1.5 cm so that thin colliders
      // (branches) are met with a small, consistent penetration.
      const n = Math.max(1, Math.min(10, Math.ceil((this.vel.length() * SUBSTEP) / 0.015)));
      for (let k = 0; k < n; k++) this.step(SUBSTEP / n);
      this.accumulator -= SUBSTEP;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;
    this.mesh.position.copy(this.pos);
    // Rolling animation.
    if (this.spinRate > 0.01) {
      this.body.rotateOnWorldAxis(this.spinAxis, this.spinRate * dt);
    }
  }

  private step(dt: number): void {
    const g = CFG.apple.gravity;
    const r = this.radius;
    const world = this.world;
    const vel = this.vel;
    const pos = this.pos;

    if (this.resting) {
      // Wake up if the ground vanished underneath (should not happen) or we got pushed.
      const gy = world.groundHeight(pos.x, pos.z);
      if (pos.y - r > gy + 0.02) this.resting = false;
      else return;
    }

    // Gravity, drag, curl.
    vel.y -= g * dt;
    const drag = 1 - CFG.apple.airDrag * dt;
    vel.multiplyScalar(drag);
    if (!this.onGround && Math.abs(this.curl) > 0.001) {
      const hs = Math.hypot(vel.x, vel.z);
      if (hs > 1) {
        vel.x += -vel.z / hs * this.curl * 0.22 * hs * dt;
        vel.z += vel.x / hs * this.curl * 0.22 * hs * dt;
      }
      this.curl *= 1 - 0.35 * dt;
    }
    const sp = vel.length();
    if (sp > CFG.apple.maxSpeed) vel.multiplyScalar(CFG.apple.maxSpeed / sp);

    pos.addScaledVector(vel, dt);

    // Ground contact.
    const gy = world.groundHeight(pos.x, pos.z);
    this.onGround = false;
    if (pos.y - r < gy) {
      const n = world.groundNormal(pos.x, pos.z, this.normal);
      pos.y = gy + r;
      const vn = vel.dot(n);
      if (vn < 0) {
        // Split into normal and tangential parts.
        this.tmp.copy(n).multiplyScalar(vn);
        vel.sub(this.tmp); // tangential
        const impact = -vn;
        if (impact > 0.9) {
          const e = CFG.apple.restitution * (impact > 3 ? 1 : 0.6);
          vel.multiplyScalar(1 - 0.12);
          vel.addScaledVector(n, impact * e);
          // The side spin is spent at the first touch: the roll continues straight.
          this.curl = 0;
          if (impact > 1.6 && this.bounceCooldown <= 0) {
            this.events.onBounce(impact);
            this.bounceCooldown = 0.08;
          }
        }
      }
      this.onGround = true;
      // Rolling resistance.
      const hs = Math.hypot(vel.x, vel.z);
      if (hs > 0) {
        const rr = world.rollingResistance(pos.x, pos.z);
        const dec = rr * dt;
        const f = Math.max(0, hs - dec) / hs;
        vel.x *= f;
        vel.z *= f;
      }
      // Spin for the visuals: axis = n × v.
      const hs2 = Math.hypot(vel.x, vel.z);
      if (hs2 > 0.05) {
        this.axis.crossVectors(n, vel).normalize();
        this.spinAxis.copy(this.axis);
        this.spinRate = hs2 / r;
      } else {
        this.spinRate = 0;
      }
      // Sleep when slow on gentle ground.
      if (vel.lengthSq() < 0.012 && n.y > 0.985) {
        vel.set(0, 0, 0);
        this.resting = true;
        this.spinRate = 0;
      }
    } else {
      this.spinRate *= 1 - 0.4 * dt;
    }

    // Obstacle colliders.
    world.colliders.forEachNear(pos.z, (col) => {
      const c = sphereContact(col, pos.x, pos.y, pos.z, r, this.contact);
      if (!c) return;
      // Low obstacles (twigs, roots: thin capsules) are rolled over, not bounced
      // off, when the apple arrives rolling with some speed.
      if (col.kind === 'capsule' && col.r <= 0.16) {
        if (this.hopCooldown > 0) {
          // Hop in progress: slide over the obstacle without the wall response.
          pos.x += c.nx * c.depth;
          pos.y += c.ny * c.depth;
          pos.z += c.nz * c.depth;
          const vn2 = vel.x * c.nx + vel.y * c.ny + vel.z * c.nz;
          if (vn2 < 0) {
            vel.x -= c.nx * vn2;
            vel.y -= c.ny * vn2;
            vel.z -= c.nz * vn2;
          }
          return;
        }
        const hs = Math.hypot(vel.x, vel.z);
        if (c.ny > 0.15 && hs > 1.5) {
          pos.y += c.depth + 0.01;
          vel.y = Math.max(vel.y, Math.min(2.5, 0.35 * hs));
          vel.x *= 0.85;
          vel.z *= 0.85;
          this.hopCooldown = 0.3;
          this.resting = false;
          if (this.hitCooldown <= 0) {
            this.events.onHit(hs * 0.4);
            this.hitCooldown = 0.1;
          }
          return;
        }
      }
      pos.x += c.nx * c.depth;
      pos.y += c.ny * c.depth;
      pos.z += c.nz * c.depth;
      const vn = vel.x * c.nx + vel.y * c.ny + vel.z * c.nz;
      if (vn < 0) {
        const s = c.surface;
        // Remove the normal component, damp the tangential, add the bounce.
        vel.x -= c.nx * vn;
        vel.y -= c.ny * vn;
        vel.z -= c.nz * vn;
        // Impact friction only: in resting contact vn is just -g*dt and the
        // apple must keep rolling off (otherwise it freezes on bush crowns).
        if (-vn > 0.3) vel.multiplyScalar(1 - s.friction * 0.5);
        const bounce = -vn * s.restitution;
        vel.x += c.nx * bounce;
        vel.y += c.ny * bounce;
        vel.z += c.nz * bounce;
        this.resting = false;
        this.curl *= 0.3;
        if (-vn > 1.2 && this.hitCooldown <= 0) {
          this.events.onHit(-vn);
          this.hitCooldown = 0.1;
        }
      }
    });

    // The start line is a wall for the apple so it can never leave the walkable area.
    const wallZ = CFG.path.startLineZ - 0.6;
    if (pos.z > wallZ) {
      pos.z = wallZ;
      if (vel.z > 0) vel.z *= -0.15;
    }

    if (this.progress > this.maxProgress) this.maxProgress = this.progress;
  }

  dispose(): void {
    this.mesh.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
