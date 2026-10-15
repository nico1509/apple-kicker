import * as THREE from 'three';
import { CFG } from '../config';
import { clamp, smoothstep } from '../utils/math';
import { mulberry32, rand } from '../utils/noise';

export interface StormEvents {
  onThunder(volume: number): void;
  onFlash(distance: number): void;
}

const RAIN_DROPS = 2400;
const RAIN_BOX = 20;
const RAIN_HEIGHT = 14;

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
  /** 0..1 how dark the sky has become. */
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
  private readonly cloudMatDark = new THREE.MeshLambertMaterial({ color: 0x343a44, flatShading: true });
  private readonly cloudMatMid = new THREE.MeshLambertMaterial({ color: 0x4d5560, flatShading: true });
  private readonly cloudGeo = new THREE.IcosahedronGeometry(1, 1);
  private readonly boltMat = new THREE.MeshBasicMaterial({ color: 0xf6f3ff, fog: false });
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
        mesh.position.set(x, row === 0 ? rand(this.rng, 14, 20) : rand(this.rng, 26, 36), row === 0 ? rand(this.rng, -4, 6) : rand(this.rng, 6, 18));
        mesh.scale.set(sx, sy, sx * 0.8);
        mesh.rotation.y = this.rng() * 6.28;
        this.wall.add(mesh);
      }
    }
    // A low dark band that touches the ground: the rain curtain.
    this.curtain = new THREE.Mesh(
      new THREE.PlaneGeometry(520, 48),
      new THREE.MeshBasicMaterial({ color: 0x4a515b, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
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
    this.speed = CFG.storm.baseSpeed;
    this.intensity = 0;
    this.darkness = 0;
    this.flash = 0;
    this.time = 0;
    this.nextFlash = 8;
    this.pendingThunder.length = 0;
    this.bolt.visible = false;
  }

  distanceTo(playerProgress: number): number {
    return playerProgress - this.progress;
  }

  private spawnDrop(i: number, anywhere: boolean): void {
    const x = rand(this.rng, -RAIN_BOX, RAIN_BOX);
    const z = rand(this.rng, -RAIN_BOX, RAIN_BOX);
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
   */
  update(dt: number, elapsed: number, playerPos: THREE.Vector3, advance: boolean): void {
    this.time += dt;
    const playerProgress = -playerPos.z;
    const dist = this.distanceTo(playerProgress);

    // ----- speed: slowly accelerating, capped, with a rubber band when far behind.
    const S = CFG.storm;
    const cap = S.capBase + S.capGrowth * elapsed;
    let v = Math.min(cap, S.baseSpeed + S.accel * elapsed);
    if (dist > S.rubberBandDistance) v += (dist - S.rubberBandDistance) * S.rubberBandGain;
    this.speed = v;
    if (advance) this.progress += v * dt;

    // ----- intensity & darkness
    this.intensity = clamp(1 - dist / S.rainStart, 0, 1);
    this.darkness = clamp(1 - dist / S.darkStart, 0, 1);

    // ----- wall placement: follows the player's x, sits at the front line.
    const frontZ = -this.progress;
    this.wall.position.set(playerPos.x, playerPos.y - 4, frontZ + 10);
    // Gentle bobbing of the clouds.
    this.wall.children.forEach((c, i) => {
      if (c === this.curtain) return;
      c.position.y += Math.sin(this.time * 0.4 + i) * 0.004;
    });
    (this.curtain.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.35 * this.darkness;

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
        this.triggerFlash(playerPos, frontZ, dist);
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

  private triggerFlash(playerPos: THREE.Vector3, frontZ: number, dist: number): void {
    this.flash = 1;
    const x = playerPos.x + rand(this.rng, -70, 70);
    const z = frontZ + rand(this.rng, 4, 30);
    const top = playerPos.y + rand(this.rng, 26, 34);
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
    this.bolt.geometry = new THREE.TubeGeometry(curve, segs * 2, 0.22, 4, false);
    this.bolt.visible = true;
    this.boltTimer = rand(this.rng, 0.08, 0.16);
    const delay = clamp(dist / 95, 0.25, 3.5);
    const volume = clamp(1 - dist / 260, 0.12, 1);
    this.pendingThunder.push({ at: this.time + delay, volume });
    this.events.onFlash(dist);
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
