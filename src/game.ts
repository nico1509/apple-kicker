import * as THREE from 'three';
import { AudioEngine } from './audio/audio';
import { CFG, type Foot } from './config';
import { Apple } from './entities/apple';
import { CamelSpit, SPIT_PUSH, type Camel } from './entities/camel';
import { GnomeBand, type Gnome } from './entities/gnome';
import { IceMonster, RAGE_HALF_LENGTH } from './entities/icemonster';
import { Input } from './entities/input';
import { Player, type PlayerEvents } from './entities/player';
import { ZombieHorde, type Zombie } from './entities/zombie';
import { TouchControls } from './ui/touch';
import { EASY_LIVES, Hud, type Cause, type Difficulty, type Mode } from './ui/hud';
import { clamp, lerp, smoothstep } from './utils/math';
import { Storm } from './weather/storm';
import { atmosphereAt, createAtmosphere, LANDSCAPE_LENGTH, landscapeAt, setStoryMode } from './world/landscape';
import { Sky } from './world/sky';
import { sphereContact, type Contact } from './world/colliders';
import { GORGE } from './world/terrain';
import { World } from './world/world';

export type GameState = 'menu' | 'playing' | 'paused' | 'lifelost' | 'over' | 'won';
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

/** The endless mode keeps the original keys so existing records stay. */
const BEST_KEYS: Record<Mode, Record<Difficulty, string>> = {
  endless: { hard: 'apple-kicker-best', easy: 'apple-kicker-best-easy' },
  story: { hard: 'apple-kicker-best-story', easy: 'apple-kicker-best-story-easy' },
};
const DIFFICULTY_KEY = 'apple-kicker-difficulty';
const MODE_KEY = 'apple-kicker-mode';
/** Set once the story mode has been won: the endless mode is unlocked. */
const UNLOCK_KEY = 'apple-kicker-endless-unlocked';
/** Warm light inside the cabin at the end of the story. */
const HOME_LIGHT = 26;
/** The apple lies this far ahead of the player at the start and after a respawn. */
const APPLE_AHEAD = 1.2;
const SUN_DIR = new THREE.Vector3(0.55, 0.62, -0.5).normalize();
const HORIZON_STORM = new THREE.Color(0x5f666f);
const TOP_STORM = new THREE.Color(0x2e3540);
const HEMI_SKY_STORM = new THREE.Color(0x6f7782);
const HEMI_GROUND_STORM = new THREE.Color(0x3a3d38);

/**
 * Owns the renderer, the scene and all systems and runs the game loop.
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly input: Input;
  readonly touch: TouchControls;
  readonly hud: Hud;
  readonly audio = new AudioEngine();
  readonly sky: Sky;
  readonly storm: Storm;
  readonly spit: CamelSpit;
  readonly gnomeBand: GnomeBand;
  readonly iceMonster: IceMonster;
  readonly zombieHorde: ZombieHorde;
  world: World;
  player!: Player;
  apple!: Apple;
  state: GameState = 'menu';
  elapsed = 0;
  best = 0;
  /** Records of every mode and difficulty. */
  records: Record<Mode, Record<Difficulty, number>> = { story: { easy: 0, hard: 0 }, endless: { easy: 0, hard: 0 } };
  difficulty: Difficulty = 'easy';
  mode: Mode = 'story';
  /** The endless mode is unlocked by winning the story mode. */
  endlessUnlocked = false;
  /** Seconds played in this run, over all lives (shown when the story is won). */
  runTime = 0;
  /** Lives left in the easy mode. */
  lives = EASY_LIVES;
  /** Highest landscape section the player has entered in this run; each new one gives back a lost life. */
  landscapeReached = 0;
  /** Thirst bar: 1 = quenched, 0 = parched. */
  thirst = 1;
  /** Bottles drunk in this run. */
  bottles = 0;
  seed: number;
  private readonly playerEvents: PlayerEvents;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly fog: THREE.Fog;
  private readonly homeLight: THREE.PointLight;
  /** Clear-weather light of the landscape the player is in. */
  private readonly atmo = createAtmosphere();
  private lastTime = 0;
  private running = false;
  /** When true the animation loop only renders; time advances via simulate(). */
  manualStepping = false;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly contact: Contact = { nx: 0, ny: 0, nz: 0, depth: 0, surface: { restitution: 0, friction: 0 } };
  private tipObstacles = false;
  private tipStorm = false;
  /** Hints already shown this run; each one appears only once until a restart or kickstart. */
  private readonly shownHints = new Set<string>();
  private lastCause: Cause = 'player';
  /** Clock for the spinning bottles. */
  private animTime = 0;
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

    this.fog = new THREE.Fog(this.atmo.horizon.clone(), this.atmo.fogNear, this.atmo.fogFar);
    this.scene.fog = this.fog;
    this.scene.background = null;

    this.hemi = new THREE.HemisphereLight(this.atmo.hemiSky, this.atmo.hemiGround, 1.15);
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

    this.homeLight = new THREE.PointLight(0xffa24a, 0, 18, 1.4);
    this.scene.add(this.homeLight);

    this.sky = new Sky(this.scene, SUN_DIR);
    this.input = new Input(canvas);
    this.hud = new Hud(uiRoot);
    this.touch = new TouchControls(this.input, this.hud.root, () => this.pause());
    this.hud.setTouch(this.touch.enabled);
    this.touch.onEnable(() => this.hud.setTouch(true));
    this.storm = new Storm(this.scene, {
      onThunder: (v) => this.audio.thunder(this.state === 'playing' ? v : v * 0.5),
    });

    this.spit = new CamelSpit(this.scene, (x, z) => this.world.groundHeight(x, z));
    // The world is rebuilt for every run, so look it up on each call.
    const world = (): World => this.world;
    this.gnomeBand = new GnomeBand({
      groundHeight: (x, z) => this.world.groundHeight(x, z),
      get colliders() {
        return world().colliders;
      },
      pathOffset: (x, z) => x - this.world.terrain.pathCenterX(-z),
    });
    this.zombieHorde = new ZombieHorde({
      groundHeight: (x, z) => this.world.groundHeight(x, z),
      get colliders() {
        return world().colliders;
      },
      pathCenterX: (p) => this.world.terrain.pathCenterX(p),
    });
    this.iceMonster = new IceMonster(this.scene, {
      groundHeight: (x, z) => this.world.groundHeight(x, z),
      pathCenterX: (p) => this.world.terrain.pathCenterX(p),
      get colliders() {
        return world().colliders;
      },
    });

    this.playerEvents = {
      onKick: (power, chip) => {
        this.audio.kick(power);
        if (power > 0.85) this.hint(chip ? 'Hoher Lupfer!' : 'Volle Kraft!', 1200, 'good');
      },
      onWhiff: () => {
        this.audio.whiff();
        this.hint('Verfehlt! Der Apfel muss dicht vor dem Fuß liegen.', 2600, 'bad');
      },
      onFootstep: (sprinting) => this.audio.footstep(sprinting),
      onExhausted: () => this.hint('Aus der Puste! Kurz verschnaufen …', 1300, 'bad'),
    };

    this.endlessUnlocked = this.loadUnlocked();
    this.mode = this.loadMode();
    // The mode decides how the world goes on after the last landscape.
    setStoryMode(this.mode === 'story');
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.world = new World(this.seed);
    this.scene.add(this.world.group);
    this.createEntities();

    for (const m of ['story', 'endless'] as Mode[]) this.records[m] = { easy: this.loadBest(m, 'easy'), hard: this.loadBest(m, 'hard') };
    this.difficulty = this.loadDifficulty();
    this.best = this.bests[this.difficulty];
    this.hud.onStart(() => this.onOverlayClick());
    this.hud.onRestart(() => {
      this.audio.init();
      this.restart();
    });
    this.hud.onContinue(() => {
      this.audio.init();
      this.continueRun();
    });
    this.hud.onMenu(() => this.toMenu());
    this.hud.onKickstart(() => {
      this.audio.init();
      this.kickstart();
    });
    this.hud.onDifficulty((d) => this.setDifficulty(d));
    this.hud.onMode((m) => this.setMode(m));
    this.hud.setDistance(0, this.best);
    this.setupWorld();
    this.showStart();

    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.addEventListener('mousedown', this.onCanvasMouseDown);
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
    this.player.kickOverride = (foot) => this.kickCreature(foot);
    this.scene.add(this.player.rig);
  }

  private setupWorld(): void {
    this.world.prewarm(0);
    this.player.reset(this.world.terrain.pathCenterX(0), 0, 0);
    this.apple.reset(this.world.terrain.pathCenterX(APPLE_AHEAD), -APPLE_AHEAD);
    this.storm.reset();
    this.spit.clear();
    this.iceMonster.reset(this.seed);
    this.elapsed = 0;
    this.runTime = 0;
    this.lives = this.maxLives();
    this.landscapeReached = 0;
    this.quench();
    this.bottles = 0;
    this.tipObstacles = false;
    this.tipStorm = false;
    this.shownHints.clear();
    this.player.update(0, this.apple, true);
    this.updateLighting();
    this.hud.setLives(this.lives, this.maxLives());
  }

  /** A hint in the message line, shown only the first time per run (until a restart or kickstart). */
  private hint(text: string, duration: number, kind: 'info' | 'bad' | 'good' = 'info'): void {
    if (this.shownHints.has(text)) return;
    this.shownHints.add(text);
    this.hud.message(text, duration, kind);
  }

  /** Fill the thirst bar completely (start of a run, after a lost life). */
  private quench(): void {
    this.thirst = 1;
    this.hud.setThirst(this.thirst, CFG.thirst.warnBelow);
  }

  private maxLives(): number {
    return this.difficulty === 'easy' ? EASY_LIVES : 0;
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

  /** Records of the chosen mode. */
  get bests(): Record<Difficulty, number> {
    return this.records[this.mode];
  }

  private showStart(): void {
    this.hud.showStart(this.bests, this.difficulty, this.mode, this.endlessUnlocked);
  }

  private loadBest(m: Mode, d: Difficulty): number {
    try {
      const v = Number(localStorage.getItem(BEST_KEYS[m][d]) ?? '0');
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  }

  private saveBest(): void {
    this.bests[this.difficulty] = this.best;
    try {
      localStorage.setItem(BEST_KEYS[this.mode][this.difficulty], String(Math.floor(this.best)));
    } catch {
      /* storage may be unavailable */
    }
  }

  private loadDifficulty(): Difficulty {
    try {
      return localStorage.getItem(DIFFICULTY_KEY) === 'hard' ? 'hard' : 'easy';
    } catch {
      return 'easy';
    }
  }

  private loadUnlocked(): boolean {
    try {
      return localStorage.getItem(UNLOCK_KEY) === '1';
    } catch {
      return false;
    }
  }

  private loadMode(): Mode {
    try {
      return this.endlessUnlocked && localStorage.getItem(MODE_KEY) === 'endless' ? 'endless' : 'story';
    } catch {
      return 'story';
    }
  }

  /** Choose the mode (only in the menu); the endless mode only once it is unlocked. */
  setMode(m: Mode): void {
    if (this.state !== 'menu' || (m === 'endless' && !this.endlessUnlocked) || m === this.mode) return;
    this.mode = m;
    setStoryMode(m === 'story');
    // The world past the last landscape differs between the modes.
    this.rebuildWorld();
    this.best = this.bests[this.difficulty];
    this.hud.setDistance(0, this.best);
    this.showStart();
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage may be unavailable */
    }
  }

  /** Choose the difficulty (only in the menu, before a run starts). */
  setDifficulty(d: Difficulty): void {
    if (this.state !== 'menu') return;
    this.difficulty = d;
    this.best = this.bests[d];
    this.lives = this.maxLives();
    this.hud.setLives(this.lives, this.maxLives());
    this.hud.setDistance(0, this.best);
    try {
      localStorage.setItem(DIFFICULTY_KEY, d);
    } catch {
      /* storage may be unavailable */
    }
  }

  private onOverlayClick(): void {
    this.audio.init();
    if (this.state === 'menu') this.start();
    else if (this.state === 'paused') this.resume();
    else if (this.state === 'lifelost') this.continueRun();
    else if (this.state === 'over' || this.state === 'won') this.restart();
  }

  /** Begin playing from the menu. Pointer lock is requested but not required. */
  start(): void {
    if (this.state === 'playing') return;
    if (this.state === 'menu') {
      this.lives = this.maxLives();
      this.hud.setLives(this.lives, this.maxLives());
    }
    this.state = 'playing';
    this.hud.hideOverlay();
    this.audio.chime();
    this.requestPointerLock();
    this.input.cancelDrag();
    this.input.enabled = true;
    this.hud.message(this.touch.enabled ? 'Lauf zum Apfel. Wischen = Kick!' : 'Lauf zum Apfel. Maustaste halten, ziehen, loslassen = Kick!', 3800);
  }

  restart(): void {
    this.input.cancelDrag();
    this.rebuildWorld();
    this.state = 'menu';
    this.start();
  }

  /** Back to the start menu with a fresh world, e.g. to change the difficulty. */
  toMenu(): void {
    this.stopPlaying();
    this.rebuildWorld();
    this.state = 'menu';
    this.showStart();
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

  /** The storm caught the player or the apple, or the thirst bar ran empty. In the easy mode this costs a life. */
  private caught(cause: Cause): void {
    if (this.state !== 'playing') return;
    this.lastCause = cause;
    if (this.difficulty === 'easy') {
      this.lives = Math.max(0, this.lives - 1);
      this.hud.setLives(this.lives, this.maxLives());
      if (this.lives > 0) {
        this.state = 'lifelost';
        this.stopPlaying();
        this.audio.gameOver();
        this.hud.showLifeLost(cause, this.lives, this.maxLives(), this.apple.maxProgress);
        return;
      }
    }
    this.gameOver();
  }

  private stopPlaying(): void {
    this.input.cancelDrag();
    this.input.enabled = false;
    this.hud.clearDrag();
    this.hud.setAppleIndicator(false, 0, 0, 0, 0);
    this.pointerLockWanted = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /**
   * Continue after a lost life: player, apple and storm are placed on the path
   * as at the start of a run, but at the distance the apple has reached so far.
   */
  continueRun(): void {
    if (this.state !== 'lifelost') return;
    const reached = this.apple.maxProgress;
    this.placeRunAt(reached);
    this.state = 'playing';
    this.hud.hideOverlay();
    this.audio.chime();
    this.requestPointerLock();
    this.input.cancelDrag();
    this.input.enabled = true;
    this.hud.message(`Weiter geht's bei ${Math.floor(reached)} m!`, 2400, 'good');
  }

  /**
   * Easy mode only: a fresh run with all lives that starts right at the
   * easy record instead of at 0 m.
   */
  kickstart(): void {
    const record = this.bests.easy;
    if (this.difficulty !== 'easy' || record < 1) return;
    if (this.state === 'playing') return;
    this.input.cancelDrag();
    this.rebuildWorld();
    this.state = 'menu';
    this.placeRunAt(record);
    this.start();
    this.hud.message(`Kickstart bei ${Math.floor(record)} m!`, 2400, 'good');
  }

  /**
   * Player, apple and storm as at the start of a run, but `reached` metres down
   * the path; the distance counts from there.
   */
  private placeRunAt(reached: number): void {
    // Never past (or right at) the cabin at the end of the story.
    const hut = this.world.terrain.hut();
    if (hut) reached = Math.min(reached, hut.p - 14);
    const p = this.respawnProgress(reached);
    this.placeOnPath(p);
    this.apple.maxProgress = reached;
    // Respawning into a landscape gives no life; only walking into the next one does.
    this.landscapeReached = Math.max(this.landscapeReached, Math.floor(p / LANDSCAPE_LENGTH));
    this.iceMonster.dismiss();
    this.storm.reset();
    this.storm.progress = p - CFG.storm.startBehind;
    // The storm's speed follows the position within the landscape by itself.
    this.elapsed = 0;
    this.quench();
    this.tipObstacles = true;
    this.player.update(0, this.apple, true);
    this.updateLighting();
  }

  /** Player on the path centre at progress p, the apple just ahead, facing it. */
  private placeOnPath(p: number): void {
    const t = this.world.terrain;
    this.world.prewarm(-p);
    const px = t.pathCenterX(p);
    const ax = t.pathCenterX(p + APPLE_AHEAD);
    this.player.reset(px, -p, Math.atan2(-(ax - px), APPLE_AHEAD));
    this.apple.reset(ax, -(p + APPLE_AHEAD));
  }

  /**
   * A spot near `target` where player and apple stand on a flat bit of the
   * path, clear of obstacles and puddles. Searches backwards first so the run
   * never gains free metres.
   */
  respawnProgress(target: number): number {
    this.world.prewarm(-target);
    const base = Math.max(0, Math.floor(target * 2) / 2);
    for (let i = 0; i <= 80; i++) {
      const p = base - i * 0.5;
      if (p < 0) break;
      if (this.respawnClear(p)) return p;
    }
    for (let i = 1; i <= 40; i++) {
      const p = base + i * 0.5;
      if (this.respawnClear(p)) return p;
    }
    return base;
  }

  /** True when the stretch of path from just behind the player to past the apple is free. */
  respawnClear(p: number): boolean {
    const t = this.world.terrain;
    if (t.gorgeNear(p, GORGE.rim + 5)) return false;
    const hut = t.hut();
    if (hut && p + APPLE_AHEAD + 1.5 > hut.p - 4) return false;
    for (const g of this.gnomes()) {
      if (g.state !== 'down' && Math.abs(-g.group.position.z - (p + APPLE_AHEAD / 2)) < 8) return false;
    }
    for (const zb of this.zombies()) {
      if (zb.state !== 'down' && Math.abs(-zb.group.position.z - (p + APPLE_AHEAD / 2)) < 12) return false;
    }
    if (this.iceMonster.active && Math.abs(this.iceMonster.progress - (p + APPLE_AHEAD / 2)) < RAGE_HALF_LENGTH + 10) return false;
    if (Math.abs(t.pathSlope(p)) > 0.08 || Math.abs(t.pathSlope(p + APPLE_AHEAD)) > 0.08) return false;
    for (let q = p - 1; q <= p + APPLE_AHEAD + 1.5; q += 0.25) {
      const x = t.pathCenterX(q);
      const z = -q;
      if (this.world.rollingResistance(x, z) > t.rollingResistance(x, z)) return false;
      // Not on a train roof or ramp in the subway.
      if (t.deckHeight(x, z) > -Infinity) return false;
      const gy = this.world.groundHeight(x, z);
      let hit = false;
      this.world.colliders.forEachNear(z, (col) => {
        if (hit) return;
        for (const h of [0.15, 0.6, 1.2]) {
          if (sphereContact(col, x, gy + h, z, 0.7, this.contact)) {
            hit = true;
            return;
          }
        }
      });
      if (hit) return false;
    }
    return true;
  }

  private gameOver(): void {
    if (this.state !== 'playing') return;
    this.state = 'over';
    this.stopPlaying();
    const score = this.apple.maxProgress;
    const isRecord = score > this.best;
    if (isRecord) {
      this.best = score;
      this.saveBest();
    }
    this.audio.gameOver();
    this.hud.showGameOver(score, this.best, isRecord, this.lastCause, this.maxLives());
  }

  /** Story mode: the apple and the player are inside the cabin. The run is won and the endless mode unlocked. */
  private win(): void {
    if (this.state !== 'playing') return;
    this.state = 'won';
    this.stopPlaying();
    const score = this.apple.maxProgress;
    const isRecord = score > this.best;
    if (isRecord) {
      this.best = score;
      this.saveBest();
    }
    const unlockedNow = !this.endlessUnlocked;
    this.endlessUnlocked = true;
    try {
      localStorage.setItem(UNLOCK_KEY, '1');
    } catch {
      /* storage may be unavailable */
    }
    this.audio.chime();
    this.hud.showWon(score, this.runTime, this.best, isRecord, unlockedNow);
  }

  /**
   * Enter fullscreen when play starts; only works right after a click or key press, so failures are ignored.
   * Returns a promise that settles once the switch is done, or null if nothing was requested.
   */
  private requestFullscreen(): Promise<void> | null {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    if (document.fullscreenElement || doc.webkitFullscreenElement) return null;
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      if (el.requestFullscreen) return el.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
      el.webkitRequestFullscreen?.();
    } catch {
      /* fullscreen unavailable (e.g. iPhone): the game runs in the normal window */
    }
    return null;
  }

  /**
   * Fullscreen first, then pointer lock: browsers drop a pointer lock requested
   * while the switch to fullscreen is still running, which left a free cursor.
   */
  private requestPointerLock(): void {
    if (this.touch.enabled) {
      // Touch screens have no cursor to catch: fullscreen only.
      void this.requestFullscreen();
      return;
    }
    this.pointerLockWanted = true;
    const fullscreen = this.requestFullscreen();
    if (fullscreen) void fullscreen.then(() => this.lockPointer());
    else this.lockPointer();
  }

  private lockPointer(): void {
    if (!this.pointerLockWanted || this.state !== 'playing' || document.pointerLockElement === this.canvas) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown;
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => undefined);
    } catch {
      /* pointer lock unavailable: the game still works with plain mouse movement */
    }
  }

  /** If the pointer lock was refused anyway, the next click in the game grabs the cursor. */
  private readonly onCanvasMouseDown = (): void => {
    this.lockPointer();
  };

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
    if (this.state === 'lifelost') {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') this.onOverlayClick();
      else if (e.code === 'KeyR') {
        this.audio.init();
        this.restart();
      }
      return;
    }
    if (this.state === 'over' || this.state === 'won' || this.state === 'menu') {
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
    if (playing) {
      this.elapsed += dt;
      this.runTime += dt;
    }
    this.animTime += dt;
    this.world.bottles.animate(this.animTime);

    this.player.update(dt, this.apple, !playing);
    this.spit.update(dt, this.camels(), this.player, playing, (dx, dz) => {
      // A hit pushes the player along the flight direction of the spit.
      this.player.shove(dx * SPIT_PUSH, dz * SPIT_PUSH);
      this.audio.hit(0.5);
      this.hint('Angespuckt!', 1100, 'bad');
    });
    if (playing) {
      this.world.update(this.player.pos.z);
      this.apple.update(dt);
    }
    this.gnomeBand.update(dt, this.gnomes(), this.apple, this.player, playing, {
      onGrab: () => {
        this.audio.hit(0.6);
        this.hint('Ein Wichtel hat deinen Apfel geklaut! Kick ihn um!', 2400, 'bad');
      },
    });
    this.zombieHorde.update(dt, this.zombies(), this.apple, this.player, playing, {
      onChase: () => {
        this.hint('Ein Zombie! Kick ihn um, bevor er zuschlägt!', 2600, 'bad');
      },
      onWindup: () => this.audio.groan(),
      onHit: () => {
        this.player.loseBreath();
        this.audio.hit(1.2);
        this.hint('Ein Zombie hat dich erwischt! Keine Puste mehr …', 1800, 'bad');
      },
    });
    this.iceMonster.update(dt, this.player, this.apple, playing, {
      onAppear: () => {
        this.audio.roar();
        this.hint('Ein Eismonster! Vorsicht vor den Eiszapfen!', 2600, 'bad');
      },
      onIcicle: () => this.audio.iceCrack(),
      onBump: (dx, dz) => {
        this.player.shove(dx, dz);
        this.audio.hit(1);
        this.hint('Umgerannt!', 1000, 'bad');
      },
      onKnockApple: (vx, vz) => this.apple.nudge(vx, vz),
    });
    this.storm.update(dt, this.player.pos, this.chasedProgress(), playing);
    const globalDark = this.globalDarkness();
    this.sky.update(dt, this.player.camera.getWorldPosition(this.tmp), this.storm.darkness, globalDark, this.storm.flash * (0.4 + 0.6 * globalDark));
    this.updateLighting();
    this.audio.setRain(this.storm.intensity);
    this.audio.setWind(globalDark * 0.8);
    this.audio.update();
    this.updateHud();

    if (playing) {
      // The run is lost when the storm catches the player or the apple.
      const dist = this.storm.distanceTo(this.chasedProgress());
      if (dist <= 0) this.caught(this.appleTrails() ? 'apple' : 'player');
      if (this.appleInGorge()) this.caught('gorge');
      if (this.atHome()) this.win();
      this.updateThirst(dt);
      this.updateLandscapeLife();
      if (!this.tipObstacles && this.apple.maxProgress > 34) {
        this.tipObstacles = true;
        this.hud.message(`Hindernisse voraus! Fester kicken – oder mit ${this.touch.enabled ? 'dem roten Knopf' : 'Leertaste'} lupfen.`, 3200);
      }
      if (!this.tipStorm && dist < 40) {
        this.tipStorm = true;
        this.hud.message(this.appleTrails() ? 'Das Gewitter holt deinen Apfel ein – kick ihn weiter!' : 'Das Gewitter holt auf – lauf!', 2500, 'bad');
      }
    }
  }

  /** Easy mode: entering the next landscape gives back one lost life (once per landscape and run). */
  private updateLandscapeLife(): void {
    const k = Math.floor(this.player.progress / LANDSCAPE_LENGTH);
    if (k <= this.landscapeReached) return;
    this.landscapeReached = k;
    if (this.difficulty !== 'easy' || this.lives >= this.maxLives()) return;
    this.lives++;
    this.hud.setLives(this.lives, this.maxLives());
    this.audio.chime();
    this.hud.message('Ein Leben zurück!', 2400, 'good');
  }

  /** The thirst bar drains fast; a bottle on the path fills it (and the stamina) up again. Empty costs a life. */
  private updateThirst(dt: number): void {
    if (this.state !== 'playing') return;
    const got = this.world.bottles.collect(this.player.pos);
    if (got > 0) {
      this.bottles += got;
      this.thirst = Math.min(1, this.thirst + got * CFG.thirst.refill);
      this.player.refillStamina();
      this.audio.drink();
      this.hint('Apfelschorle! Ahh …', 1100, 'good');
    }
    this.thirst = Math.max(0, this.thirst - dt / CFG.thirst.drainSeconds);
    if (this.thirst < CFG.thirst.warnBelow && this.thirst > 0) {
      this.hint('Durst! Schnapp dir eine Apfelschorle auf dem Weg.', 2400, 'bad');
    }
    this.hud.setThirst(this.thirst, CFG.thirst.warnBelow);
    if (this.thirst <= 0) this.caught('thirst');
  }

  /** Story mode: the apple is in the cabin and the player has followed it in. */
  private atHome(): boolean {
    const cabin = this.world.cabin;
    return cabin.inside(this.apple.pos.x, this.apple.pos.z) && cabin.inside(this.player.pos.x, this.player.pos.z, 0.15);
  }

  /** True once the apple has dropped well below the rim of a gorge. */
  private appleInGorge(): boolean {
    const g = this.world.terrain.gorgeNear(this.apple.progress, GORGE.rim);
    return g !== null && Math.abs(this.apple.pos.x - g.x) < GORGE.reach && this.apple.pos.y < g.h - 2.5;
  }

  /**
   * A swing that reaches a gnome or a zombie knocks it over (and frees a
   * stolen apple). A free apple in reach of the foot is kicked as usual.
   */
  private kickCreature(foot: Foot): boolean {
    if (!this.apple.held && this.player.appleInReach(this.apple, foot)) return false;
    const carried = this.apple.held;
    const g = this.gnomeBand.kick(this.gnomes(), this.player, this.apple);
    if (g) {
      this.audio.kick(0.6);
      this.audio.hit(1.4);
      this.hint(carried ? 'Umgekickt! Der Wichtel lässt den Apfel fallen.' : 'Wichtel umgekickt!', 1600, 'good');
      return true;
    }
    if (!this.zombieHorde.kick(this.zombies(), this.player)) return false;
    this.audio.kick(0.7);
    this.audio.hit(1.6);
    this.hint('Zombie umgekickt!', 1400, 'good');
    return true;
  }

  private *gnomes(): Generator<Gnome> {
    for (const list of this.world.obstacles.gnomes.values()) yield* list;
  }

  private *zombies(): Generator<Zombie> {
    for (const list of this.world.obstacles.zombies.values()) yield* list;
  }

  private *camels(): Generator<Camel> {
    for (const list of this.world.obstacles.camels.values()) yield* list;
  }

  /** True when the apple is further back than the player, i.e. the storm reaches it first. */
  private appleTrails(): boolean {
    return this.apple.progress < this.player.progress;
  }

  /** Progress of whichever the storm reaches first: the player or the apple. */
  private chasedProgress(): number {
    return Math.min(this.apple.progress, this.player.progress);
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
    const atmo = atmosphereAt(this.player.progress, this.atmo);
    this.sun.intensity = atmo.sunIntensity * (1 - 0.92 * dark) + flash * 1.2;
    this.sun.color.copy(atmo.sun);
    this.sun.shadow.intensity = 1 - 0.85 * dark;
    this.hemi.intensity = 1.15 * (1 - 0.35 * dark) + flash * 2.4;
    this.hemi.color.copy(atmo.hemiSky).lerp(HEMI_SKY_STORM, dark);
    this.hemi.groundColor.copy(atmo.hemiGround).lerp(HEMI_GROUND_STORM, dark);
    this.renderer.toneMappingExposure = lerp(1.05, 0.8, dark);
    this.fog.color.copy(atmo.horizon).lerp(HORIZON_STORM, dark);
    this.fog.near = lerp(atmo.fogNear, 30, dark);
    this.fog.far = lerp(atmo.fogFar, 150, dark);
    this.sky.uniforms.horizonColor.value.copy(atmo.horizon).lerp(HORIZON_STORM, dark * 0.8);
    this.sky.uniforms.topColor.value.copy(atmo.top).lerp(TOP_STORM, dark * 0.9);
    this.sky.uniforms.cirrusAmount.value = atmo.cirrus;
    this.sky.cloudAmount = atmo.clouds;
    // The warm light in the cabin at the end of the story.
    const home = this.world.cabin.lightPosition(this.tmp2);
    if (home) this.homeLight.position.copy(home);
    this.homeLight.intensity = home ? HOME_LIGHT * (1 + 0.6 * dark) : 0;
    // Shadow-casting light follows the player.
    const p = this.player.pos;
    this.sun.position.set(p.x + SUN_DIR.x * 140, p.y + SUN_DIR.y * 140, p.z + SUN_DIR.z * 140);
    this.sun.target.position.copy(p);
    this.sun.target.updateMatrixWorld();
  }

  private updateHud(): void {
    const hud = this.hud;
    this.touch.setActive(this.state === 'playing');
    hud.setDistance(this.apple.maxProgress, Math.max(this.best, this.apple.maxProgress));
    const dist = this.storm.distanceTo(this.chasedProgress());
    hud.setStorm(dist, clamp(1 - dist / 110, 0, 1), this.appleTrails());
    hud.setStamina(this.player.stamina, this.player.exhausted > 0);
    hud.setVignette(this.storm.intensity * 0.8);
    const drag = this.input.drag;
    if (drag && this.state === 'playing') {
      const tap = Math.hypot(drag.dx, drag.dy) < CFG.kick.tapThresholdPx;
      const { power } = Player.evalDrag(drag.dx, drag.dy, false);
      hud.setDrag(drag.dx, drag.dy, power, this.input.chipHeld(), tap);
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
    const far = dist >= CFG.apple.markDistance;
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
    this.landscapeReached = Math.max(this.landscapeReached, Math.floor(progress / LANDSCAPE_LENGTH));
    this.storm.progress = progress - CFG.storm.startBehind;
    this.world.prewarm(-progress);
    this.iceMonster.dismiss();
    this.quench();
  }

  /** Unlock (or lock again) the endless mode as if the story had been won (testing only). */
  debugUnlock(on = true): void {
    this.endlessUnlocked = on;
    try {
      if (on) localStorage.setItem(UNLOCK_KEY, '1');
      else localStorage.removeItem(UNLOCK_KEY);
    } catch {
      /* storage may be unavailable */
    }
    if (!on && this.mode === 'endless') this.setMode('story');
    if (this.state === 'menu') this.showStart();
  }

  /** Gnomes in the generated chunks (testing only). */
  debugGnomes(): Array<{ id: number; x: number; z: number; state: string; homeX: number; homeZ: number }> {
    return [...this.gnomes()].map((g) => ({ id: g.id, x: g.group.position.x, z: g.group.position.z, state: g.state, homeX: g.homeX, homeZ: g.homeZ }));
  }

  /** Zombies in the generated chunks (testing only). */
  debugZombies(): Array<{ id: number; x: number; z: number; state: string; cooldown: number }> {
    return [...this.zombies()].map((zb) => ({ id: zb.id, x: zb.group.position.x, z: zb.group.position.z, state: zb.state, cooldown: zb.cooldown }));
  }

  /** Gorges of the first landscape sections (testing only). */
  debugGorges(sections = 6): Array<{ p: number; x: number; h: number }> {
    const out: Array<{ p: number; x: number; h: number }> = [];
    for (let k = 0; k < sections; k++) out.push(...this.world.terrain.gorgesIn(k));
    return out;
  }

  /** Blocks of trains of the subway section around progress p (testing only). */
  debugSubway(p: number): { s: number; blocks: Array<{ p0: number; p1: number; lanes: string[] }>; trains: Array<{ x: number; p0: number; front: number; p1: number; ramp: boolean }> } | null {
    const sec = this.world.terrain.subwayAt(p);
    if (!sec) return null;
    return {
      s: sec.s,
      blocks: sec.blocks.map((b) => ({ p0: b.p0, p1: b.p1, lanes: [...b.lanes] })),
      trains: sec.trains.map((t) => ({ x: t.x, p0: t.p0, front: t.front, p1: t.p1, ramp: t.ramp })),
    };
  }

  /** Put the player at (x, z), looking along yaw (testing only). */
  debugPlayer(x: number, z: number, yaw = 0): void {
    this.player.reset(x, z, yaw);
  }

  /** Put the apple at rest at (x, z) (testing only). */
  debugApple(x: number, z: number): void {
    this.apple.reset(x, z);
    this.apple.maxProgress = Math.max(0, -z);
  }

  /** Set the thirst bar (testing only). */
  debugThirst(v: number): void {
    this.thirst = clamp(v, 0, 1);
  }

  /** Bottles still floating in the generated chunks (testing only). */
  debugBottles(): Array<{ x: number; y: number; z: number }> {
    return this.world.bottles.positions();
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
      stormDistance: this.storm.distanceTo(this.chasedProgress()),
      stormAppleDistance: this.storm.distanceTo(this.apple.progress),
      stormPlayerDistance: this.storm.distanceTo(this.player.progress),
      appleIndicator: this.indicatorShown,
      difficulty: this.difficulty,
      mode: this.mode,
      endlessUnlocked: this.endlessUnlocked,
      runTime: this.runTime,
      atHome: this.atHome(),
      lives: this.lives,
      landscapeReached: this.landscapeReached,
      stamina: this.player.stamina,
      exhausted: this.player.exhausted,
      thirst: this.thirst,
      bottles: this.bottles,
      appleHeld: this.apple.held,
      gnomeGrabs: this.gnomeBand.grabs,
      gnomeKnocked: this.gnomeBand.knocked,
      zombieHits: this.zombieHorde.hits,
      zombieSwings: this.zombieHorde.swings,
      zombieKnocked: this.zombieHorde.knocked,
      holderX: this.gnomeBand.holder?.group.position.x ?? 0,
      holderZ: this.gnomeBand.holder?.group.position.z ?? 0,
      groundY: this.world.groundHeight(this.player.pos.x, this.player.pos.z),
      playerGroundGap: this.player.pos.y - this.world.groundHeight(this.player.pos.x, this.player.pos.z),
      appleGroundGap: this.apple.pos.y - this.apple.radius - this.world.groundHeight(this.apple.pos.x, this.apple.pos.z),
      playerPathOffset: this.player.pos.x - this.world.terrain.pathCenterX(this.player.progress),
      best: this.best,
      stormSpeed: this.storm.speed,
      pathAheadX: this.world.terrain.pathCenterX(this.apple.progress + 12),
      chunks: this.world.generated,
      landscape: landscapeAt(this.player.progress),
      monster: this.iceMonster.phase,
      monsterAppearances: this.iceMonster.appearances,
      icicles: this.iceMonster.icicles.length,
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
    this.canvas.removeEventListener('mousedown', this.onCanvasMouseDown);
    window.removeEventListener('keydown', this.onKeyDown);
    this.input.dispose();
    this.world.dispose();
    this.apple.dispose();
    this.player.dispose();
    this.storm.dispose();
    this.spit.dispose();
    this.iceMonster.dispose();
    this.sky.dispose();
    this.renderer.dispose();
  }
}
