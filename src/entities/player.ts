import * as THREE from 'three';
import { CFG, type Foot } from '../config';
import { clamp, damp, DEG, lerp } from '../utils/math';
import { rampTop, sphereContact, type Contact } from '../world/colliders';
import { subwayWallHalf } from '../world/subway';
import { World } from '../world/world';
import { Apple } from './apple';
import { Input, type KickRequest } from './input';
import { Legs } from './legs';

export interface PlayerEvents {
  onKick(power: number, chip: boolean, foot: Foot): void;
  onWhiff(foot: Foot): void;
  onFootstep(sprinting: boolean): void;
  /** Sprinted until the stamina ran empty: the player has to catch their breath. */
  onExhausted(): void;
}

interface KickState {
  foot: Foot;
  t: number;
  power: number;
  chip: boolean;
  /** Absolute world yaw of the shot, frozen at release. */
  aimYaw: number;
  done: boolean;
}

/** Touch stick: turning rate in radians per second at full sideways deflection. */
const TOUCH_TURN_RATE = 2.4;
/** Touch movement stick: deflection below this is ignored. */
const TOUCH_DEAD_ZONE = 0.12;

/** Longest step in metres between two collision checks. */
const MAX_STEP = 0.15;

/** Seconds into the swing at which the foot meets the apple. */
const KICK_CONTACT_TIME = 0.21;

/**
 * First-person player: WASD movement on the height field, mouse look,
 * jointed legs and the kick mechanic.
 */
export class Player {
  readonly rig = new THREE.Group();
  readonly head = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  readonly legs = new Legs();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  pitch = -0.2;
  stamina = 1;
  sprinting = false;
  /** Seconds left in which the player is out of breath and cannot walk. */
  exhausted = 0;
  private kick: KickState | null = null;
  private walkPhase = 0;
  private bob = 0;
  private stepTimer = 0;
  /** Intended walking velocity (before damping / collisions). */
  private intentX = 0;
  private intentZ = 0;
  private readonly fwd = new THREE.Vector3();
  private readonly rgt = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly contact: Contact = { nx: 0, ny: 0, nz: 0, depth: 0, surface: { restitution: 0, friction: 0 } };
  private inBush = 0;
  /** Displacement still to be applied from a shove (e.g. camel spit), in metres. */
  private shoveX = 0;
  /** Seconds left of the energy drink's faster sprint. */
  boosted = 0;
  /** Downward speed while dropping off a train roof. */
  private fallSpeed = 0;
  /**
   * Asked when a swing reaches its contact point. Returning true means the foot
   * hit something else (a gnome) and the apple is not kicked.
   */
  kickOverride: ((foot: Foot) => boolean) | null = null;
  private shoveZ = 0;

  constructor(
    private readonly world: World,
    private readonly input: Input,
    private readonly events: PlayerEvents,
  ) {
    this.camera = new THREE.PerspectiveCamera(74, 1, 0.04, CFG.render.cameraFar);
    this.head.position.set(0, CFG.player.eyeHeight, 0);
    this.head.add(this.camera);
    this.camera.position.set(0, 0, -0.08);
    // The legs sit a little ahead of the eyes; together with the forward lean
    // of the standing pose this keeps thighs and feet visible when looking down.
    this.legs.group.position.set(0, 0, -0.12);
    this.rig.add(this.head, this.legs.group);
    this.rig.name = 'player';
  }

  /**
   * Knocked breathless (a zombie's blow): all stamina is gone and the player has
   * to catch their breath as after sprinting the bar empty.
   */
  loseBreath(): void {
    this.stamina = 0;
    this.sprinting = false;
    this.exhausted = CFG.player.exhaustedSeconds;
  }

  /** A bottle of apple spritzer: the stamina bar is full again and any breathlessness is over. */
  refillStamina(): void {
    this.stamina = 1;
    this.exhausted = 0;
  }

  /** An energy drink: sprinting is faster for `seconds` (another one restarts the time). */
  boost(seconds: number): void {
    this.boosted = seconds;
  }

  /** Push the player by (dx, dz) metres; applied smoothly over a few frames. */
  shove(dx: number, dz: number): void {
    this.shoveX += dx;
    this.shoveZ += dz;
  }

  get progress(): number {
    return -this.pos.z;
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  right(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  reset(x: number, z: number, yaw: number): void {
    this.pos.set(x, this.world.groundHeight(x, z), z);
    this.vel.set(0, 0, 0);
    this.shoveX = this.shoveZ = 0;
    this.fallSpeed = 0;
    this.boosted = 0;
    this.yaw = yaw;
    this.pitch = -0.25;
    this.stamina = 1;
    this.exhausted = 0;
    this.kick = null;
    this.walkPhase = 0;
    this.bob = 0;
    this.intentX = 0;
    this.intentZ = 0;
    this.applyTransform();
  }

  private applyTransform(): void {
    this.rig.position.copy(this.pos);
    this.rig.rotation.set(0, this.yaw, 0);
    this.head.rotation.set(this.pitch, 0, 0);
  }

  /**
   * Evaluate a drag into kick parameters. The power curve starts at the tap
   * power right at the tap threshold, so longer drags are never weaker.
   */
  static evalDrag(dx: number, dy: number, tap: boolean): { power: number; dirYaw: number } {
    if (tap) return { power: CFG.kick.tapPower, dirYaw: 0 };
    const len = Math.hypot(dx, dy);
    if (len < CFG.kick.tapThresholdPx) return { power: CFG.kick.tapPower, dirYaw: 0 };
    const t = clamp((len - CFG.kick.tapThresholdPx) / (CFG.kick.maxDragPx - CFG.kick.tapThresholdPx), 0, 1);
    const power = CFG.kick.tapPower + (1 - CFG.kick.tapPower) * Math.pow(t, 0.85);
    // Up on screen = straight ahead; right = to the right.
    const dirYaw = clamp(Math.atan2(dx, -dy), -2.6, 2.6);
    return { power, dirYaw };
  }

  update(dt: number, apple: Apple, paused: boolean): void {
    const input = this.input;
    if (!paused) {
      // ----- look
      const look = input.consumeLook();
      // The touch stick turns at a rate; squared for fine aiming near the centre.
      const turn = input.turnStick * Math.abs(input.turnStick);
      this.yaw -= look.dx * CFG.player.lookSensitivity + turn * TOUCH_TURN_RATE * dt;
      this.pitch = clamp(this.pitch - look.dy * CFG.player.lookSensitivity, CFG.player.pitchMin, CFG.player.pitchMax);
    }

    // ----- movement
    const fwd = this.forward(this.fwd);
    const rgt = this.right(this.rgt);
    let mx = 0;
    let mz = 0;
    // Share of the full speed: the touch stick walks slower when pushed only a little.
    let throttle = 1;
    if (!paused && this.exhausted <= 0) {
      if (input.isDown('KeyW') || input.isDown('ArrowUp')) mz += 1;
      if (input.isDown('KeyS') || input.isDown('ArrowDown')) mz -= 1;
      if (input.isDown('KeyD') || input.isDown('ArrowRight')) mx += 1;
      if (input.isDown('KeyA') || input.isDown('ArrowLeft')) mx -= 1;
      const stick = Math.hypot(input.moveStick.x, input.moveStick.y);
      if (mx === 0 && mz === 0 && stick > TOUCH_DEAD_ZONE) {
        mx = input.moveStick.x;
        mz = -input.moveStick.y;
        throttle = clamp((stick - TOUCH_DEAD_ZONE) / (0.85 - TOUCH_DEAD_ZONE), 0.35, 1);
      }
    }
    const moving = mx !== 0 || mz !== 0;
    const wantSprint = !paused && moving && (input.isDown('ShiftLeft') || input.isDown('ShiftRight') || input.sprintStick) && this.stamina > 0;
    this.sprinting = wantSprint;
    let moveX = 0;
    let moveZ = 0;
    if (paused) {
      // Freeze: no sliding, no stamina regeneration while the world stands still.
      this.vel.set(0, 0, 0);
      this.intentX = 0;
      this.intentZ = 0;
    } else {
      this.boosted = Math.max(0, this.boosted - dt);
      if (this.exhausted > 0) {
        // Catching the breath fills the stamina bar completely within that second.
        this.exhausted = Math.max(0, this.exhausted - dt);
        this.stamina = 1 - this.exhausted / CFG.player.exhaustedSeconds;
      } else if (wantSprint) {
        this.stamina = Math.max(0, this.stamina - dt / CFG.player.staminaMax);
        if (this.stamina <= 0) {
          this.exhausted = CFG.player.exhaustedSeconds;
          this.events.onExhausted();
        }
      } else this.stamina = Math.min(1, this.stamina + (dt * CFG.player.staminaRegen) / CFG.player.staminaMax);

      const slope = this.world.terrain.pathSlope(this.progress);
      const slopeFactor = clamp(1 - Math.max(0, slope) * 1.2, 0.55, 1);
      const bushFactor = lerp(1, 0.4, this.inBush);
      const kickFactor = this.kick ? 0.35 : 1;
      const sprintSpeed = CFG.player.sprintSpeed * (this.boosted > 0 ? CFG.energy.sprintFactor : 1);
      const targetSpeed = (wantSprint ? sprintSpeed : CFG.player.walkSpeed * throttle) * slopeFactor * bushFactor * kickFactor;
      const tx = fwd.x * mz + rgt.x * mx;
      const tz = fwd.z * mz + rgt.z * mx;
      const tl = Math.hypot(tx, tz) || 1;
      const targetVx = (tx / tl) * targetSpeed * (moving ? 1 : 0);
      const targetVz = (tz / tl) * targetSpeed * (moving ? 1 : 0);
      this.intentX = targetVx;
      this.intentZ = targetVz;
      const accel = moving ? CFG.player.accel : CFG.player.accel * 1.4;
      this.vel.x = damp(this.vel.x, targetVx, accel / 4, dt);
      this.vel.z = damp(this.vel.z, targetVz, accel / 4, dt);
      moveX = this.vel.x * dt;
      moveZ = this.vel.z * dt;
      if (this.shoveX !== 0 || this.shoveZ !== 0) {
        const f = 1 - Math.exp(-8 * dt);
        moveX += this.shoveX * f;
        moveZ += this.shoveZ * f;
        this.shoveX *= 1 - f;
        this.shoveZ *= 1 - f;
        if (Math.abs(this.shoveX) + Math.abs(this.shoveZ) < 1e-3) this.shoveX = this.shoveZ = 0;
      }
    }

    // Fast (an energy drink) or on a slow frame the step is split up, so that
    // no wall or ramp side is skipped and the climb up a ramp keeps up.
    const n = Math.max(1, Math.ceil(Math.hypot(moveX, moveZ) / MAX_STEP));
    for (let i = 0; i < n; i++) {
      const prevX = this.pos.x;
      this.pos.x += moveX / n;
      this.pos.z += moveZ / n;
      // Never walk backwards past the start line.
      if (this.pos.z > CFG.path.startLineZ) this.pos.z = CFG.path.startLineZ;
      this.collide();
      this.keepInCutting(prevX);
      this.followGround(dt / n);
    }

    // ----- walk cycle, bob, footsteps
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const walkAmount = clamp(speed / CFG.player.walkSpeed, 0, 1.3);
    if (speed > 0.2) {
      const stride = this.sprinting ? 2.1 : 1.55;
      this.walkPhase += (speed / stride) * Math.PI * 2 * dt;
      this.stepTimer += (speed / stride) * dt;
      if (this.stepTimer >= 0.5) {
        this.stepTimer -= 0.5;
        this.events.onFootstep(this.sprinting);
      }
    } else {
      // Settle to a neutral stance.
      this.walkPhase = damp(this.walkPhase, Math.round(this.walkPhase / Math.PI) * Math.PI, 6, dt);
      this.stepTimer = 0;
    }
    this.bob = damp(this.bob, speed > 0.2 ? 1 : 0, 8, dt);
    const bobY = Math.sin(this.walkPhase * 2) * 0.028 * this.bob * walkAmount;
    const bobX = Math.sin(this.walkPhase) * 0.012 * this.bob * walkAmount;
    this.head.position.set(bobX, CFG.player.eyeHeight + bobY, 0);

    // ----- kick handling
    if (!paused) this.processKicks(apple);
    if (this.kick) {
      const k = this.kick;
      // The swing freezes while paused and finishes after resuming.
      if (!paused) k.t += dt;
      const finished = this.legs.setKick(k.foot, k.t, k.power);
      if (!k.done && k.t >= KICK_CONTACT_TIME) {
        k.done = true;
        this.executeKick(k, apple);
      }
      if (finished) this.kick = null;
    } else if (input.drag) {
      const d = Player.evalDrag(input.drag.dx, input.drag.dy, false);
      this.legs.setAim(input.drag.foot, Math.hypot(input.drag.dx, input.drag.dy) < CFG.kick.tapThresholdPx ? 0 : d.power);
    } else {
      this.legs.setWalk(this.walkPhase, walkAmount);
    }
    this.legs.update(dt, this.kick ? 26 : 14);

    // ----- body contact with the apple
    if (!paused) this.dribble(apple, speed);

    this.applyTransform();
  }

  /** Pushes the player out of every obstacle nearby. */
  private collide(): void {
    this.inBush = 0;
    this.world.colliders.forEachNear(this.pos.z, (col) => {
      const pr = CFG.player.radius;
      if (col.kind === 'sphere') {
        if (col.surface.soft) {
          // Bushes slow the player down but can be pushed through.
          const dx = this.pos.x - col.x;
          const dz = this.pos.z - col.z;
          const dd = dx * dx + dz * dz;
          const rr = (col.r + pr * 0.5) ** 2;
          if (dd < rr && Math.abs(this.pos.y + 0.6 - col.y) < col.r + 0.6) this.inBush = 1;
          return;
        }
        if (!col.blocksPlayer) return;
        if (col.y - col.r > this.pos.y + 1.6 || col.y + col.r < this.pos.y + 0.05) return;
        this.pushOutCircle(col.x, col.z, col.r + pr);
      } else if (col.kind === 'cylinder') {
        if (!col.blocksPlayer) return;
        if (col.yTop < this.pos.y + 0.3) return;
        this.pushOutCircle(col.x, col.z, col.r + pr);
      } else if (col.kind === 'capsule') {
        if (!col.blocksPlayer) return;
        const top = Math.max(col.ay, col.by) + col.r;
        const bottom = Math.min(col.ay, col.by) - col.r;
        if (top < this.pos.y + 0.25 || bottom > this.pos.y + 1.7) return;
        // Closest point on the segment in the XZ plane.
        const abx = col.bx - col.ax;
        const abz = col.bz - col.az;
        const len2 = abx * abx + abz * abz;
        let t = len2 > 0 ? ((this.pos.x - col.ax) * abx + (this.pos.z - col.az) * abz) / len2 : 0;
        t = clamp(t, 0, 1);
        this.pushOutCircle(col.ax + abx * t, col.az + abz * t, col.r + pr);
      } else if (col.kind === 'box') {
        if (col.maxY < this.pos.y + 0.25 || col.minY > this.pos.y + 1.7) return;
        this.pushOutBox(col.minX, col.minZ, col.maxX, col.maxZ, pr);
      } else if (col.kind === 'ramp') {
        // The side of a ramp; walking up its slope is terrain following.
        if (rampTop(col, -this.pos.z) < this.pos.y + 0.25) return;
        this.pushOutBox(col.minX, -col.pHigh, col.maxX, -col.pLow, pr);
      } else if (col.kind === 'wall') {
        const abx = col.bx - col.ax;
        const abz = col.bz - col.az;
        const len2 = abx * abx + abz * abz;
        const t = clamp(len2 > 0 ? ((this.pos.x - col.ax) * abx + (this.pos.z - col.az) * abz) / len2 : 0, 0, 1);
        this.pushOutCircle(col.ax + abx * t, col.az + abz * t, pr);
      }
    });
  }

  /**
   * The walls of the subway cutting are thin: a player that was inside them
   * stays inside, even if pushed hard against them.
   */
  private keepInCutting(prevX: number): void {
    const half = subwayWallHalf(-this.pos.z);
    if (half === Infinity || Math.abs(prevX) > half) return;
    const max = half - CFG.player.radius;
    if (Math.abs(this.pos.x) > max) {
      this.pos.x = Math.sign(this.pos.x) * max;
      this.vel.x = 0;
    }
  }

  /** Train roofs and ramps carry the player from above; off the end of a roof they fall. */
  private followGround(dt: number): void {
    const gy = this.world.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.6);
    if (this.pos.y > gy + 0.6 || this.fallSpeed > 0) {
      this.fallSpeed += 9.81 * dt;
      this.pos.y -= this.fallSpeed * dt;
      if (this.pos.y <= gy) {
        this.pos.y = gy;
        this.fallSpeed = 0;
      }
    } else {
      // Smooth over bumps, but up a ramp stay on it (the sides of a ramp only stop a player below its slope).
      this.pos.y = Math.max(damp(this.pos.y, gy, 30, dt), gy - 0.1);
      if (Math.abs(this.pos.y - gy) > 0.6) this.pos.y = gy;
    }
  }

  private pushOutCircle(cx: number, cz: number, minDist: number, positionOnly = false): void {
    const dx = this.pos.x - cx;
    const dz = this.pos.z - cz;
    const d = Math.hypot(dx, dz);
    if (d >= minDist) return;
    if (d < 1e-4) {
      this.pos.x += minDist;
      return;
    }
    const push = (minDist - d) / d;
    this.pos.x += dx * push;
    this.pos.z += dz * push;
    if (positionOnly) return;
    // Remove the velocity component into the obstacle.
    const vn = (this.vel.x * dx + this.vel.z * dz) / d;
    if (vn < 0) {
      this.vel.x -= (dx / d) * vn;
      this.vel.z -= (dz / d) * vn;
    }
  }

  /** Keeps the player's circle out of an axis-aligned rectangle (a cabin wall). */
  private pushOutBox(minX: number, minZ: number, maxX: number, maxZ: number, r: number): void {
    const qx = clamp(this.pos.x, minX, maxX);
    const qz = clamp(this.pos.z, minZ, maxZ);
    if (qx !== this.pos.x || qz !== this.pos.z) {
      this.pushOutCircle(qx, qz, r);
      return;
    }
    // Inside: out through the nearest edge.
    const out = [this.pos.x - minX, maxX - this.pos.x, this.pos.z - minZ, maxZ - this.pos.z];
    const k = out.indexOf(Math.min(...out));
    if (k === 0) this.pos.x = minX - r;
    else if (k === 1) this.pos.x = maxX + r;
    else if (k === 2) this.pos.z = minZ - r;
    else this.pos.z = maxZ + r;
  }

  private processKicks(apple: Apple): void {
    const reqs = this.input.kicks;
    // Freeze the facing of every request on the frame it arrives (undoing the
    // look movement that arrived after the release), even if it has to wait.
    for (const r of reqs) {
      if (r.yaw === undefined) r.yaw = this.yaw + r.lookAfter * CFG.player.lookSensitivity;
    }
    // A request made during the wind-up waits until the foot has made contact;
    // after that a new request interrupts the follow-through.
    if (this.kick && !this.kick.done) return;
    if (reqs.length === 0) return;
    const req: KickRequest = reqs[reqs.length - 1];
    reqs.length = 0;
    // A request queued behind a swing that just launched the apple can only
    // whiff: drop it instead of showing a misleading miss.
    if (this.kick && this.kick.done && apple.sinceKick < 0.35 && !this.appleInReach(apple, req.foot)) return;
    const { power, dirYaw } = Player.evalDrag(req.dx, req.dy, req.tap);
    // dirYaw is measured clockwise (to the right) from the facing direction.
    this.kick = { foot: req.foot, t: 0, power, chip: req.chip, aimYaw: (req.yaw ?? this.yaw) - dirYaw, done: false };
  }

  /** True when the apple is in reach of the given foot. */
  appleInReach(apple: Apple, foot: Foot): boolean {
    if (apple.held) return false;
    const rel = this.tmp.subVectors(apple.pos, this.pos);
    if (Math.abs(rel.y) > 0.95) return false;
    const fwd = this.forward(this.fwd);
    const rgt = this.right(this.rgt);
    const f = rel.x * fwd.x + rel.z * fwd.z;
    const s = rel.x * rgt.x + rel.z * rgt.z;
    const dist = Math.hypot(rel.x, rel.z);
    if (dist > CFG.kick.reach || f < -0.2) return false;
    if (foot === 'left') return s > -1.15 && s < 0.6;
    // The right foot is the only one the player kicks with: it reaches across.
    return s > -1.15 && s < 1.15;
  }

  private executeKick(k: KickState, apple: Apple): void {
    if (this.kickOverride?.(k.foot)) return;
    if (!this.appleInReach(apple, k.foot)) {
      this.events.onWhiff(k.foot);
      return;
    }
    const dirX = -Math.sin(k.aimYaw);
    const dirZ = -Math.cos(k.aimYaw);
    let speed = lerp(CFG.kick.minSpeed, CFG.kick.maxSpeed, k.power);
    let elevation = lerp(CFG.kick.minElevationDeg, CFG.kick.maxElevationDeg, k.power) * DEG;
    if (k.chip) {
      elevation = CFG.kick.chipElevationDeg * DEG;
      speed *= CFG.kick.chipSpeedFactor;
      // The instep scoops the apple up, so a chip from contact clears a log.
      apple.pos.y += 0.25;
    }
    const dir = this.tmp2.set(dirX * Math.cos(elevation), Math.sin(elevation), dirZ * Math.cos(elevation)).normalize();
    const extra = this.tmp.set(this.vel.x * 0.5, 0, this.vel.z * 0.5);
    // Only one foot kicks, so no side spin: it would bend every kick the same way.
    apple.kick(dir, speed, 0, extra);
    this.events.onKick(k.power, k.chip, k.foot);
  }

  /**
   * Body contact with the apple. The apple is a small obstacle for the body:
   * an apple rolling into the shins bounces off, and walking into a resting
   * apple pushes it ahead at a capped speed (well below the storm), with the
   * body following behind it.
   */
  private dribble(apple: Apple, speed: number): void {
    const dx = apple.pos.x - this.pos.x;
    const dz = apple.pos.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    const minD = CFG.player.radius + apple.radius;
    if (d >= minD || apple.pos.y > this.pos.y + 1.0 || apple.held) return;
    // Right after a kick the apple is in flight: hands off.
    if (apple.sinceKick < 0.3 || !apple.onGround) return;
    let nx = d > 1e-4 ? dx / d : -Math.sin(this.yaw);
    let nz = d > 1e-4 ? dz / d : -Math.cos(this.yaw);
    // An apple rolling into the body bounces off the shins; the player is not moved.
    const vrel = apple.vel.x * nx + apple.vel.z * nz;
    if (vrel < -0.05) {
      apple.vel.x -= nx * vrel * 1.3;
      apple.vel.z -= nz * vrel * 1.3;
      apple.pos.x = this.pos.x + nx * (minD + 0.01);
      apple.pos.z = this.pos.z + nz * (minD + 0.01);
      apple.resting = false;
      return;
    }
    // Walking into the apple: steer an off-centre contact towards the walking
    // direction so the apple rolls ahead of the feet instead of squirting sideways.
    const intent = Math.hypot(this.intentX, this.intentZ);
    if (intent > 0.2) {
      const ix = this.intentX / intent;
      const iz = this.intentZ / intent;
      const bx = nx * 0.45 + ix * 0.55;
      const bz = nz * 0.45 + iz * 0.55;
      const bl = Math.hypot(bx, bz) || 1;
      nx = bx / bl;
      nz = bz / bl;
    }
    const along = this.intentX * nx + this.intentZ * nz;
    // The body stays outside the apple (position only).
    this.pushOutCircle(apple.pos.x, apple.pos.z, minD, true);
    if (along > 0.1 || (speed < 0.2 && apple.resting)) {
      const push = Math.min(along * 0.6 + 0.4, 1.8);
      const appleAlong = apple.vel.x * nx + apple.vel.z * nz;
      if (appleAlong < push - 0.05) {
        // Do not nudge the apple into a hard obstacle (log, root, stone, trunk).
        const cx = apple.pos.x + nx * 0.12;
        const cz = apple.pos.z + nz * 0.12;
        let blocked = false;
        this.world.colliders.forEachNear(cz, (col) => {
          if (!blocked && !col.surface.soft && sphereContact(col, cx, apple.pos.y, cz, apple.radius, this.contact)) blocked = true;
        });
        if (!blocked) apple.nudge(nx * push, nz * push);
      }
      // The body follows at the apple's speed: remove only the velocity
      // relative to the apple along the contact normal.
      const appleN = apple.vel.x * nx + apple.vel.z * nz;
      const bodyN = this.vel.x * nx + this.vel.z * nz;
      if (bodyN > appleN) {
        this.vel.x -= nx * (bodyN - appleN);
        this.vel.z -= nz * (bodyN - appleN);
      }
    }
  }

  dispose(): void {
    this.legs.dispose();
  }
}
