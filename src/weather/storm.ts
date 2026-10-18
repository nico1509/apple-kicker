import * as THREE from 'three';
import { CFG } from '../config';
import { clamp, smoothstep } from '../utils/math';
import { mulberry32, rand } from '../utils/noise';
import { LANDSCAPE_LENGTH } from '../world/landscape';

export interface StormEvents {
  onThunder(volume: number): void;
}

const RAIN_DROPS = 2400;
const RAIN_BOX = 20;
const RAIN_HEIGHT = 14;
/** Drops never come closer than this to the eye (they would draw screen-spanning streaks). */
const RAIN_EYE_CLEAR = 0.8;

/**
 * The bad-weather front chasing the player: a wall of dark clouds, a rain
 * curtain, local rain around the player, lightning and thunder.
 */
export class Storm {
  /** Progress coordinate (metres along the path) of the front line. */
  progress = -CFG.storm.startBehind;
  speed: number = CFG.storm.baseSpeed;
  /** 0..1 rain intensity around the player. */
  intensity = 0;
  /** 0..1 how much of the sky behind the player the storm covers. */
  darkness = 0;
  /** 0..1 current lightning flash brightness. */
  flash = 0;
  readonly group = new THREE.Group();
  private readonly wall = new THREE.Group();
  private readonly curtain: THREE.Mesh;
  private readonly rain: THREE.LineSegments;
  private readonly rainPositions: Float32Array;
  private readonly rainMat: THREE.LineBasicMaterial;
  private readonly bolt: THREE.Mesh;
  private boltTimer = 0;
  private nextFlash = 6;
  private readonly pendingThunder: Array<{ at: number; volume: number }> = [];
  private time = 0;
  /** Landscape the chased one is in; entering the next one pulls the front up. */
  private landscape = 0;
  /** Pulling the front up to the standard distance at a landscape start. */
  private catchingUp = false;
  private readonly cloudMatDark = new THREE.MeshLambertMaterial({ color: 0x5a6270, emissive: 0x151820, flatShading: true, fog: false });
  private readonly cloudMatMid = new THREE.MeshLambertMaterial({ color: 0x7c8591, emissive: 0x1c2028, flatShading: true, fog: false });
  private readonly cloudEmissiveDark = new THREE.Color(0x151820);
  private readonly cloudEmissiveMid = new THREE.Color(0x1c2028);
  private readonly curtainColor = new THREE.Color(0x5c6470);
  private readonly cloudGeo = new THREE.IcosahedronGeometry(1, 1);
  private readonly boltMat = new THREE.MeshBasicMaterial({ color: 0xf6f3ff, fog: false, toneMapped: false });
  private readonly rng = mulberry32(99);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly events: StormEvents,
  ) {
    // Cloud wall: two rows of dark ellipsoids spanning the horizon.
    for (let row = 0; row < 2; row++) {
      const n = 26;
      for (let i = 0; i < n; i++) {
        const mesh = new THREE.Mesh(this.cloudGeo, row === 0 ? this.cloudMatDark : this.cloudMatMid);
        const x = -230 + (460 * i) / (n - 1) + rand(this.rng, -8, 8);
        const sx = rand(this.rng, 16, 28);
        const sy = rand(this.rng, 9, 15);
        mesh.position.set(x, row === 0 ? rand(this.rng, 18, 24) : rand(this.rng, 28, 38), row === 0 ? rand(this.rng, -4, 6) : rand(this.rng, 6, 18));
        mesh.userData.baseY = mesh.position.y;
        mesh.scale.set(sx, sy, sx * 0.8);
        mesh.rotation.y = this.rng() * 6.28;
        this.wall.add(mesh);
      }
    }
    // A low grey band that touches the ground: the rain curtain. Its alpha fades
    // out towards the top and the bottom so no hard edge shows.
    const curtainGeo = new THREE.PlaneGeometry(520, 48, 1, 24);
    const cpos = curtainGeo.getAttribute('position');
    const ccol = new Float32Array(cpos.count * 4);
    for (let i = 0; i < cpos.count; i++) {
      const v = cpos.getY(i) / 48 + 0.5; // 0 bottom .. 1 top
      const alpha = smoothstep(0, 0.3, v) * (1 - smoothstep(0.55, 1, v));
      ccol[i * 4] = 1; ccol[i * 4 + 1] = 1; ccol[i * 4 + 2] = 1; ccol[i * 4 + 3] = alpha;
    }
    curtainGeo.setAttribute('color', new THREE.BufferAttribute(ccol, 4));
    this.curtain = new THREE.Mesh(
      curtainGeo,
      new THREE.MeshBasicMaterial({ color: 0x5c6470, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, vertexColors: true, fog: false }),
    );
    this.curtain.position.set(0, 14, -6);
    this.wall.add(this.curtain);
    this.group.add(this.wall);

    // Rain around the player.
    this.rainPositions = new Float32Array(RAIN_DROPS * 2 * 3);
    for (let i = 0; i < RAIN_DROPS; i++) this.spawnDrop(i, true);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.rainPositions, 3));
    this.rainMat = new THREE.LineBasicMaterial({ color: 0xcfd8e6, transparent: true, opacity: 0, depthWrite: false });
    this.rain = new THREE.LineSegments(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.group.add(this.rain);

    // Lightning bolt (rebuilt for every flash).
    this.bolt = new THREE.Mesh(new THREE.BufferGeometry(), this.boltMat);
    this.bolt.visible = false;
    this.bolt.frustumCulled = false;
    this.group.add(this.bolt);

    scene.add(this.group);
  }

  reset(): void {
    this.progress = -CFG.storm.startBehind;
    this.landscape = 0;
    this.catchingUp = false;
    this.speed = CFG.storm.baseSpeed;
    this.intensity = 0;
    this.darkness = 0;
    this.flash = 0;
    this.time = 0;
    this.nextFlash = 8;
    this.pendingThunder.length = 0;
    this.bolt.visible = false;
  }

  /** Put the front the standard distance behind `chasedProgress`, as at the start of a run. */
  placeBehind(chasedProgress: number): void {
    this.progress = chasedProgress - CFG.storm.startBehind;
    this.landscape = Math.floor(Math.max(0, chasedProgress) / LANDSCAPE_LENGTH);
    this.catchingUp = false;
  }

  distanceTo(progress: number): number {
    return progress - this.progress;
  }

  private spawnDrop(i: number, anywhere: boolean): void {
    let x = rand(this.rng, -RAIN_BOX, RAIN_BOX);
    let z = rand(this.rng, -RAIN_BOX, RAIN_BOX);
    const h = Math.hypot(x, z);
    if (h < RAIN_EYE_CLEAR) {
      const s = RAIN_EYE_CLEAR / Math.max(h, 1e-3);
      x *= s;
      z *= s;
    }
    const y = anywhere ? rand(this.rng, 0, RAIN_HEIGHT) : RAIN_HEIGHT + rand(this.rng, 0, 2);
    const len = rand(this.rng, 0.3, 0.55);
    const o = i * 6;
    const p = this.rainPositions;
    p[o] = x; p[o + 1] = y; p[o + 2] = z;
    p[o + 3] = x + 0.04; p[o + 4] = y + len; p[o + 5] = z + 0.14;
  }

  /**
   * Advance the storm. When `advance` is false (menu, pause, game over) the
   * front line stays put but the visuals keep animating.
   *
   * The front chases whichever is further back, the player or the apple
   * (`chasedProgress`): its speed and its rubber band follow that position
   * within the current landscape. Rain, darkness and lightning follow the
   * player, who sees them.
   */
  update(dt: number, playerPos: THREE.Vector3, chasedProgress: number, advance: boolean): void {
    this.time += dt;
    const playerProgress = -playerPos.z;
    const dist = this.distanceTo(playerProgress);
    const chasedDist = this.distanceTo(chasedProgress);

    // ----- speed: slowest at the start of every landscape, fastest at its end,
    // with a rubber band whose free lead shrinks over the landscape.
    const S = CFG.storm;
    const t = (Math.max(0, chasedProgress) % LANDSCAPE_LENGTH) / LANDSCAPE_LENGTH;
    let v = S.baseSpeed + (S.topSpeed - S.baseSpeed) * t;
    const lead = S.rubberBandDistance + (S.rubberBandMin - S.rubberBandDistance) * t;
    if (chasedDist > lead) v += (chasedDist - lead) * S.rubberBandGain;

    // At the start of every landscape a front that has fallen further back
    // than at the start of a run quickly catches up to that distance.
    const k = Math.floor(Math.max(0, chasedProgress) / LANDSCAPE_LENGTH);
    if (k > this.landscape) {
      this.landscape = k;
      this.catchingUp = chasedDist > S.startBehind;
    }
    if (this.catchingUp) {
      if (chasedDist > S.startBehind) v += S.catchUpSpeed + (chasedDist - S.startBehind) * S.catchUpGain;
      else this.catchingUp = false;
    }
    this.speed = v;
    if (advance) {
      this.progress += v * dt;
      // Never overshoot the standard distance while catching up.
      if (this.catchingUp && this.distanceTo(chasedProgress) <= S.startBehind) {
        this.progress = chasedProgress - S.startBehind;
        this.catchingUp = false;
      }
    }

    // ----- intensity & darkness
    this.intensity = clamp(1 - dist / S.rainStart, 0, 1);
    this.darkness = clamp(1 - dist / S.darkStart, 0, 1);

    // ----- wall placement: follows the player's x, sits at the front line.
    const frontZ = -this.progress;
    this.wall.position.set(playerPos.x, playerPos.y - 4, frontZ + 10);
    // Gentle bobbing of the clouds (absolute, so it is frame-rate independent).
    const kids = this.wall.children;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c === this.curtain) continue;
      c.position.y = (c.userData.baseY as number) + 0.5 * Math.sin(this.time * 0.4 + i);
    }
    const curtainMat = this.curtain.material as THREE.MeshBasicMaterial;
    curtainMat.opacity = 0.35 + 0.35 * this.darkness;
    // Up close the sun is gone: the unlit curtain must darken with the scene
    // while the clouds keep a faint self-light so their facets stay readable.
    const dk = this.darkness;
    curtainMat.color.copy(this.curtainColor).multiplyScalar(1 - 0.65 * dk);
    this.cloudMatDark.emissive.copy(this.cloudEmissiveDark).multiplyScalar(1 + 3.5 * dk);
    this.cloudMatMid.emissive.copy(this.cloudEmissiveMid).multiplyScalar(1 + 3.5 * dk);

    // ----- rain
    if (this.intensity > 0.01) {
      this.rain.visible = true;
      this.rain.position.copy(playerPos);
      this.rainMat.opacity = 0.2 + 0.5 * this.intensity;
      const p = this.rainPositions;
      const fall = (9 + 3 * this.intensity) * dt;
      const windZ = -2.2 * dt;
      const windX = 0.6 * dt;
      const active = Math.floor(RAIN_DROPS * (0.25 + 0.75 * this.intensity));
      for (let i = 0; i < RAIN_DROPS; i++) {
        const o = i * 6;
        if (i >= active) {
          // Park unused drops out of sight.
          p[o + 1] = -50;
          p[o + 4] = -50;
          continue;
        }
        if (p[o + 1] <= -45) this.spawnDrop(i, true);
        p[o + 1] -= fall;
        p[o + 4] -= fall;
        p[o + 2] += windZ;
        p[o + 5] += windZ;
        p[o] += windX;
        p[o + 3] += windX;
        // Keep the drops out of the eye's immediate vicinity.
        const h = Math.hypot(p[o], p[o + 2]);
        if (h < RAIN_EYE_CLEAR) {
          const s = RAIN_EYE_CLEAR / Math.max(h, 1e-3);
          p[o] *= s; p[o + 2] *= s;
          p[o + 3] = p[o] + 0.04; p[o + 5] = p[o + 2] + 0.14;
        }
        if (p[o + 1] < -1) this.spawnDrop(i, false);
      }
      (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    } else {
      this.rain.visible = false;
    }

    // ----- lightning
    this.flash *= Math.exp(-11 * dt);
    if (this.boltTimer > 0) {
      this.boltTimer -= dt;
      if (this.boltTimer <= 0) this.bolt.visible = false;
    }
    if (dist < 220) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        const near = 1 - smoothstep(0, 220, dist);
        this.nextFlash = rand(this.rng, 3.5, 11) * (1.6 - near);
        // Menu, pause, game over: fewer and softer flashes.
        if (!advance) this.nextFlash = Math.max(this.nextFlash, 7);
        this.triggerFlash(playerPos, frontZ, dist, advance ? 0.3 + 0.7 * near : 0.35);
      }
    }
    // Thunder arrives after the flash.
    for (let i = this.pendingThunder.length - 1; i >= 0; i--) {
      if (this.time >= this.pendingThunder[i].at) {
        this.events.onThunder(this.pendingThunder[i].volume);
        this.pendingThunder.splice(i, 1);
      }
    }
  }

  private triggerFlash(playerPos: THREE.Vector3, frontZ: number, dist: number, strength: number): void {
    this.flash = strength;
    // In front of the cloud wall (its nearest faces reach ~frontZ-16) but never
    // closer than 20 m to the player.
    const z = Math.max(frontZ - rand(this.rng, 14, 24), playerPos.z + 20);
    const dz = z - playerPos.z;
    // Close bolts stay inside the field of view (spread shrinks with proximity).
    const x = playerPos.x + rand(this.rng, -1, 1) * Math.min(45, dz * 1.1);
    // Top at ~16-22 degrees above the horizon: inside the wall, never above its tops.
    const top = playerPos.y + 1.6 + dz * rand(this.rng, 0.28, 0.4);
    const pts: THREE.Vector3[] = [];
    const segs = 9;
    let cx = x;
    let cz = z;
    for (let i = 0; i <= segs; i++) {
      const y = top - (top - (playerPos.y - 6)) * (i / segs);
      pts.push(new THREE.Vector3(cx, y, cz));
      cx += rand(this.rng, -2.5, 2.5);
      cz += rand(this.rng, -1.5, 1.5);
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0);
    this.bolt.geometry.dispose();
    const radius = 0.08 + 0.004 * dz; // ~0.16 m at 20 m, ~0.25 m at 40 m
    this.bolt.geometry = new THREE.TubeGeometry(curve, segs * 2, radius, 4, false);
    this.bolt.visible = true;
    this.boltTimer = rand(this.rng, 0.12, 0.2);
    const delay = clamp(dist / 95, 0.25, 3.5);
    const volume = clamp(1 - Math.max(dist, 0) / 260, 0.12, 1);
    this.pendingThunder.push({ at: this.time + delay, volume });
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.cloudGeo.dispose();
    this.cloudMatDark.dispose();
    this.cloudMatMid.dispose();
    this.curtain.geometry.dispose();
    (this.curtain.material as THREE.Material).dispose();
    this.rain.geometry.dispose();
    this.rainMat.dispose();
    this.bolt.geometry.dispose();
    this.boltMat.dispose();
  }
}
