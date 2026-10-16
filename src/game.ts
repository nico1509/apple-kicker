import * as THREE from 'three';
import { AudioEngine } from './audio/audio';
import { CFG, type Foot } from './config';
import { Apple } from './entities/apple';
import { Input } from './entities/input';
import { Player, type PlayerEvents } from './entities/player';
import { Hud } from './ui/hud';
import { clamp, lerp, smoothstep } from './utils/math';
import { Storm } from './weather/storm';
import { Sky } from './world/sky';
import { World } from './world/world';

export type GameState = 'menu' | 'playing' | 'paused' | 'over';
export type Quality = 'low' | 'medium' | 'high';

/** Quality from the URL (?quality=low|medium|high), defaulting to high. */
export function detectQuality(): Quality {
  try {
    const q = new URLSearchParams(window.location.search).get('quality');
    if (q === 'low' || q === 'medium' || q === 'high') return q;
  } catch {
    /* ignore */
  }
  return 'high';
}

const BEST_KEY = 'apple-kicker-best';
const HINT_SECONDS = 25;
const SUN_DIR = new THREE.Vector3(0.55, 0.62, -0.5).normalize();
const HORIZON_CLEAR = new THREE.Color(0xd3e4f3);
const HORIZON_STORM = new THREE.Color(0x5f666f);
const TOP_CLEAR = new THREE.Color(0x4f8fd6);
const TOP_STORM = new THREE.Color(0x2e3540);
const HEMI_SKY_CLEAR = new THREE.Color(0xcfe3ff);
const HEMI_SKY_STORM = new THREE.Color(0x6f7782);
const HEMI_GROUND_CLEAR = new THREE.Color(0x6b6a3a);
const HEMI_GROUND_STORM = new THREE.Color(0x3a3d38);

/**
 * Owns the renderer, the scene and all systems and runs the game loop.
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly input: Input;
  readonly hud: Hud;
  readonly audio = new AudioEngine();
  readonly sky: Sky;
  readonly storm: Storm;
  world: World;
  player!: Player;
  apple!: Apple;
  state: GameState = 'menu';
  elapsed = 0;
  best = 0;
  seed: number;
  private readonly playerEvents: PlayerEvents;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly fog: THREE.Fog;
  private lastTime = 0;
  private running = false;
  /** When true the animation loop only renders; time advances via simulate(). */
  manualStepping = false;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private tipObstacles = false;
  private tipStorm = false;
  private tipWhiff = false;
  private hintFaded = false;
  private indicatorShown = false;
  private pointerLockWanted = false;
  private readonly rafLoop = (now: number): void => this.frame(now);

  constructor(
    readonly canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
    readonly quality: Quality = detectQuality(),
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(quality === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.fog = new THREE.Fog(HORIZON_CLEAR.clone(), CFG.render.fogNear, CFG.render.fogFar);
    this.scene.fog = this.fog;
    this.scene.background = null;

    this.hemi = new THREE.HemisphereLight(HEMI_SKY_CLEAR, HEMI_GROUND_CLEAR, 1.15);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.9);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    const ext = CFG.render.shadowExtent;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
    sc.near = 1; sc.far = 320;
    const shadowSize = quality === 'high' ? CFG.render.shadowMapSize : CFG.render.shadowMapSize / 2;
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.06;
    this.sun.shadow.radius = quality === 'high' ? 3 : 1.5;
    this.scene.add(this.sun, this.sun.target);

    this.sky = new Sky(this.scene, SUN_DIR);
    this.input = new Input(canvas);
    this.hud = new Hud(uiRoot);
    this.storm = new Storm(this.scene, {
      onThunder: (v) => this.audio.thunder(this.state === 'playing' ? v : v * 0.5),
    });

    this.playerEvents = {
      onKick: (power, chip) => {
        this.audio.kick(power);
        if (power > 0.85) this.hud.message(chip ? 'Hoher Lupfer!' : 'Volle Kraft!', 1200, 'good');
      },
      onWhiff: () => {
        this.audio.whiff();
        if (!this.tipWhiff) {
          this.tipWhiff = true;
          this.hud.message('Verfehlt! Der Apfel muss dicht vor dem Fuß liegen.', 2600, 'bad');
        } else {
          this.hud.message('Verfehlt!', 900, 'bad');
        }
      },
      onFootstep: (sprinting) => this.audio.footstep(sprinting),
    };

    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.world = new World(this.seed);
    this.scene.add(this.world.group);
    this.createEntities();

    this.best = this.loadBest();
    this.hud.onStart(() => this.onOverlayClick());
    this.hud.onRestart(() => {
      this.audio.init();
      this.restart();
    });
    this.hud.setDistance(0, this.best);
    this.setupWorld();
    this.hud.showStart(this.best);

    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('keydown', this.onKeyDown);
    this.onResize();
  }

  // ---------------------------------------------------------------------------
  // Setup / state

  private createEntities(): void {
    this.apple = new Apple(this.world, {
      onBounce: (s) => this.audio.bounce(s),
      onHit: (s) => this.audio.hit(s),
    });
    this.scene.add(this.apple.mesh);
    this.player = new Player(this.world, this.input, this.playerEvents);
    this.scene.add(this.player.rig);
  }

  private setupWorld(): void {
    this.world.prewarm(0);
    this.player.reset(this.world.terrain.pathCenterX(0), 0, 0);
    this.apple.reset(this.world.terrain.pathCenterX(1.2), -1.2);
    this.storm.reset();
    this.elapsed = 0;
    this.tipObstacles = false;
    this.tipStorm = false;
    this.tipWhiff = false;
    this.hintFaded = false;
    this.player.update(0, this.apple, true);
    this.updateLighting();
  }

  private rebuildWorld(): void {
    this.scene.remove(this.world.group, this.apple.mesh, this.player.rig);
    this.world.dispose();
    this.apple.dispose();
    this.player.dispose();
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.world = new World(this.seed);
    this.scene.add(this.world.group);
    this.createEntities();
    this.setupWorld();
    this.onResize();
  }

  private loadBest(): number {
    try {
      const v = Number(localStorage.getItem(BEST_KEY) ?? '0');
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  }

  private saveBest(): void {
    try {
      localStorage.setItem(BEST_KEY, String(Math.floor(this.best)));
    } catch {
      /* storage may be unavailable */
    }
  }

  private onOverlayClick(): void {
    this.audio.init();
    if (this.state === 'menu') this.start();
    else if (this.state === 'paused') this.resume();
    else if (this.state === 'over') this.restart();
  }

  /** Begin playing from the menu. Pointer lock is requested but not required. */
  start(): void {
    if (this.state === 'playing') return;
    this.state = 'playing';
    this.hud.hideOverlay();
    this.hud.setHintVisible(true);
    this.audio.chime();
    this.requestPointerLock();
    this.input.cancelDrag();
    this.input.enabled = true;
    this.hud.message('Lauf zum Apfel. Maustaste halten, ziehen, loslassen = Kick!', 3800);
  }

  restart(): void {
    this.input.cancelDrag();
    this.rebuildWorld();
    this.state = 'menu';
    this.start();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.cancelDrag();
    this.input.enabled = false;
    this.hud.clearDrag();
    this.hud.showPaused();
    // Release the pointer so the overlay can be clicked.
    this.pointerLockWanted = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.hud.hideOverlay();
    this.input.enabled = true;
    this.requestPointerLock();
  }

  private gameOver(): void {
    if (this.state !== 'playing') return;
    this.state = 'over';
    this.input.cancelDrag();
    this.input.enabled = false;
    this.hud.clearDrag();
    this.hud.setAppleIndicator(false, 0, 0, 0, 0);
    const score = this.apple.maxProgress;
    const isRecord = score > this.best;
    if (isRecord) {
      this.best = score;
      this.saveBest();
    }
    this.audio.gameOver();
    this.hud.showGameOver(score, this.best, isRecord);
    this.pointerLockWanted = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private requestPointerLock(): void {
    this.pointerLockWanted = true;
    try {
      const p = this.canvas.requestPointerLock() as unknown;
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => undefined);
    } catch {
      /* pointer lock unavailable: the game still works with plain mouse movement */
    }
  }

  private readonly onPointerLockChange = (): void => {
    if (document.pointerLockElement !== this.canvas && this.pointerLockWanted && this.state === 'playing') {
      // The user pressed Escape (or the lock was lost): pause.
      this.pause();
    }
  };

  private readonly onBlur = (): void => {
    this.pause();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (e.code === 'KeyM') {
      this.audio.setMuted(!this.audio.muted);
      this.hud.message(this.audio.muted ? 'Ton aus' : 'Ton an', 900);
      return;
    }
    if (this.state === 'paused') {
      if (e.code === 'KeyP' || e.code === 'Enter' || e.code === 'NumpadEnter') this.onOverlayClick();
      else if (e.code === 'KeyR') {
        this.audio.init();
        this.restart();
      }
      return;
    }
    if (this.state === 'over' || this.state === 'menu') {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') this.onOverlayClick();
      return;
    }
    // playing
    if (e.code === 'KeyP' || e.code === 'Escape') this.pause();
  };

  private readonly onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.player.camera.aspect = w / h;
    this.player.camera.updateProjectionMatrix();
  };

  // ---------------------------------------------------------------------------
  // Loop

  run(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.rafLoop);
  }

  stop(): void {
    this.running = false;
  }

  private frame(now: number): void {
    if (!this.running) return;
    const dt = clamp((now - this.lastTime) / 1000, 0, 0.05);
    this.lastTime = now;
    if (!this.manualStepping) this.update(dt);
    this.render();
    requestAnimationFrame(this.rafLoop);
  }

  update(dt: number): void {
    const playing = this.state === 'playing';
    if (playing) this.elapsed += dt;

    this.player.update(dt, this.apple, !playing);
    if (playing) {
      this.world.update(this.player.pos.z);
      this.apple.update(dt);
    }
    this.storm.update(dt, this.elapsed, this.player.pos, this.apple.progress, playing);
    const globalDark = this.globalDarkness();
    this.sky.update(dt, this.player.camera.getWorldPosition(this.tmp), this.storm.darkness, globalDark, this.storm.flash * (0.4 + 0.6 * globalDark));
    this.updateLighting();
    this.audio.setRain(this.storm.intensity);
    this.audio.setWind(globalDark * 0.8);
    this.audio.update();
    this.updateHud();

    if (playing) {
      // The run is lost when the storm catches the apple, not the player.
      const dist = this.storm.distanceTo(this.apple.progress);
      if (dist <= 0) this.gameOver();
      if (!this.hintFaded && this.elapsed >= HINT_SECONDS) {
        this.hintFaded = true;
        this.hud.setHintVisible(false);
      }
      if (!this.tipObstacles && this.apple.maxProgress > 34) {
        this.tipObstacles = true;
        this.hud.message('Hindernisse voraus! Fester kicken – oder mit Leertaste lupfen.', 3200);
      }
      if (!this.tipStorm && dist < 40) {
        this.tipStorm = true;
        this.hud.message('Das Gewitter holt deinen Apfel ein – kick ihn weiter!', 2500, 'bad');
      }
    }
  }

  /**
   * The storm shows in the sky behind the player early (storm.darkness), but
   * the whole scene only turns grey once the front is within ~65 m.
   */
  private globalDarkness(): number {
    return smoothstep(0.45, 1, this.storm.darkness);
  }

  private updateLighting(): void {
    const dark = this.globalDarkness();
    const flash = this.storm.flash * (0.4 + 0.6 * dark);
    this.sun.intensity = 2.9 * (1 - 0.92 * dark) + flash * 1.2;
    this.sun.shadow.intensity = 1 - 0.85 * dark;
    this.hemi.intensity = 1.15 * (1 - 0.35 * dark) + flash * 2.4;
    this.hemi.color.copy(HEMI_SKY_CLEAR).lerp(HEMI_SKY_STORM, dark);
    this.hemi.groundColor.copy(HEMI_GROUND_CLEAR).lerp(HEMI_GROUND_STORM, dark);
    this.renderer.toneMappingExposure = lerp(1.05, 0.8, dark);
    this.fog.color.copy(HORIZON_CLEAR).lerp(HORIZON_STORM, dark);
    this.fog.near = lerp(CFG.render.fogNear, 30, dark);
    this.fog.far = lerp(CFG.render.fogFar, 150, dark);
    this.sky.uniforms.horizonColor.value.copy(HORIZON_CLEAR).lerp(HORIZON_STORM, dark * 0.8);
    this.sky.uniforms.topColor.value.copy(TOP_CLEAR).lerp(TOP_STORM, dark * 0.9);
    // Shadow-casting light follows the player.
    const p = this.player.pos;
    this.sun.position.set(p.x + SUN_DIR.x * 140, p.y + SUN_DIR.y * 140, p.z + SUN_DIR.z * 140);
    this.sun.target.position.copy(p);
    this.sun.target.updateMatrixWorld();
  }

  private updateHud(): void {
    const hud = this.hud;
    hud.setDistance(this.apple.maxProgress, Math.max(this.best, this.apple.maxProgress));
    const dist = this.storm.distanceTo(this.apple.progress);
    hud.setStorm(dist, clamp(1 - dist / 110, 0, 1));
    hud.setStamina(this.player.stamina);
    hud.setVignette(this.storm.intensity * 0.8);
    const drag = this.input.drag;
    if (drag && this.state === 'playing') {
      const tap = Math.hypot(drag.dx, drag.dy) < CFG.kick.tapThresholdPx;
      const { power } = Player.evalDrag(drag.dx, drag.dy, false);
      hud.setDrag(drag.dx, drag.dy, power, drag.foot, this.input.isDown('Space'), tap);
    } else {
      hud.clearDrag();
    }
    this.updateAppleIndicator();
  }

  private updateAppleIndicator(): void {
    if (this.state !== 'playing') {
      this.indicatorShown = false;
      this.hud.setAppleIndicator(false, 0, 0, 0, 0);
      return;
    }
    const cam = this.player.camera;
    const v = this.tmp.copy(this.apple.pos);
    const dist = v.distanceTo(cam.getWorldPosition(this.tmp2));
    // View space: behind the camera when z > 0.
    const viewZ = this.tmp2.copy(v).applyMatrix4(cam.matrixWorldInverse).z;
    v.project(cam);
    const behind = viewZ > 0;
    const onScreen = !behind && Math.abs(v.x) < 0.92 && Math.abs(v.y) < 0.9;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const far = dist > CFG.apple.markDistance;
    if (onScreen && far) {
      // Far away the apple is only a few pixels: mark it in view too, with the
      // marker sitting above it and pointing down at it.
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      this.indicatorShown = true;
      this.hud.setAppleIndicator(true, x, y - 34, Math.PI / 2, dist, true);
      return;
    }
    if (onScreen || dist < 2.2) {
      this.indicatorShown = false;
      this.hud.setAppleIndicator(false, 0, 0, 0, 0);
      return;
    }
    let sx = v.x;
    let sy = -v.y;
    if (behind) {
      sx = -sx;
      sy = -sy;
      if (Math.abs(sx) < 0.3 && Math.abs(sy) < 0.3) sy = 1;
    }
    const m = Math.max(Math.abs(sx), Math.abs(sy), 1e-4);
    sx /= m;
    sy /= m;
    const margin = 56;
    const x = w / 2 + sx * (w / 2 - margin);
    const y = h / 2 + sy * (h / 2 - margin);
    this.indicatorShown = true;
    this.hud.setAppleIndicator(true, x, y, Math.atan2(sy, sx), dist);
  }

  render(): void {
    this.renderer.render(this.scene, this.player.camera);
  }

  // ---------------------------------------------------------------------------
  // Debug / automation helpers (used by the smoke test)

  debugKick(dx: number, dy: number, foot: Foot, chip = false): void {
    this.input.injectKick({ foot, dx, dy, chip, tap: false, lookAfter: 0 });
  }

  /** Advance the simulation deterministically without waiting for frames. */
  simulate(seconds: number, keys: string[] = [], stepDt = 1 / 60): void {
    this.manualStepping = true;
    for (const k of keys) this.input.keys.add(k);
    const steps = Math.max(1, Math.round(seconds / stepDt));
    for (let i = 0; i < steps; i++) this.update(stepDt);
    for (const k of keys) this.input.keys.delete(k);
    // Finish any chunk generation that was spread over frames.
    for (let i = 0; i < 400 && this.world.busy; i++) this.world.update(this.player.pos.z);
    this.render();
  }

  /** Jump the player, the apple and the storm to a given progress (testing only). */
  debugTeleport(progress: number): void {
    const x = this.world.terrain.pathCenterX(progress);
    this.player.reset(x, -progress, 0);
    this.apple.reset(this.world.terrain.pathCenterX(progress + 1.2), -(progress + 1.2));
    this.apple.maxProgress = progress;
    this.storm.progress = progress - CFG.storm.startBehind;
    this.world.prewarm(-progress);
  }

  debugLook(yaw: number, pitch: number): void {
    this.player.yaw = yaw;
    this.player.pitch = clamp(pitch, CFG.player.pitchMin, CFG.player.pitchMax);
  }

  debugState(): Record<string, number | string | boolean> {
    return {
      state: this.state,
      elapsed: this.elapsed,
      applePx: this.apple.pos.x,
      applePy: this.apple.pos.y,
      applePz: this.apple.pos.z,
      appleProgress: this.apple.progress,
      appleMax: this.apple.maxProgress,
      appleSpeed: this.apple.speed,
      appleResting: this.apple.resting,
      playerX: this.player.pos.x,
      playerY: this.player.pos.y,
      playerZ: this.player.pos.z,
      playerYaw: this.player.yaw,
      playerPitch: this.player.pitch,
      stormProgress: this.storm.progress,
      stormDistance: this.storm.distanceTo(this.apple.progress),
      stormPlayerDistance: this.storm.distanceTo(this.player.progress),
      appleIndicator: this.indicatorShown,
      stormSpeed: this.storm.speed,
      pathAheadX: this.world.terrain.pathCenterX(this.apple.progress + 12),
      chunks: this.world.generated,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      seed: this.seed,
    };
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('keydown', this.onKeyDown);
    this.input.dispose();
    this.world.dispose();
    this.apple.dispose();
    this.player.dispose();
    this.storm.dispose();
    this.sky.dispose();
    this.renderer.dispose();
  }
}
