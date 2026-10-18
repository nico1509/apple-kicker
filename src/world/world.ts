import * as THREE from 'three';
import { CFG } from '../config';
import { Bottles } from './bottles';
import { Cabin } from './cabin';
import { ColliderStore } from './colliders';
import { Decor } from './decor';
import { Obstacles } from './obstacles';
import { Railyard } from './railyard';
import { Terrain } from './terrain';

interface Chunk {
  ground: THREE.Mesh;
  far: THREE.Mesh;
  decor: THREE.Group;
  obstacles: THREE.Group;
  bottles: THREE.Group;
  cabin: THREE.Group | null;
  railyard: THREE.Group | null;
}

/** Time budget per frame for incremental chunk generation. */
const BUILD_BUDGET_MS = 4;

/**
 * The world owns the terrain functions, the chunk life-cycle and the collider store.
 * Chunks are generated incrementally (a few milliseconds per frame) so that
 * walking never stutters; the start area is generated synchronously.
 */
export class World {
  readonly terrain: Terrain;
  readonly colliders = new ColliderStore();
  readonly decor: Decor;
  readonly obstacles: Obstacles;
  readonly bottles: Bottles;
  /** The cabin at the end of the story mode (builds nothing in the endless mode). */
  readonly cabin: Cabin;
  /** Tracks, trains and walls of the subway. */
  readonly railyard: Railyard;
  readonly group = new THREE.Group();
  private readonly chunks = new Map<number, Chunk>();
  private readonly groundMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private readonly farMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private pending: { i: number; gen: Generator<void, void> } | null = null;
  /** Highest chunk index ever generated (for stats). */
  generated = 0;

  constructor(readonly seed: number) {
    this.terrain = new Terrain(seed);
    this.decor = new Decor(this.terrain, this.colliders);
    this.obstacles = new Obstacles(this.terrain, this.colliders);
    this.cabin = new Cabin(this.terrain, this.colliders);
    this.railyard = new Railyard(this.terrain, this.colliders);
    this.bottles = new Bottles(this.terrain, this.colliders);
    this.group.name = 'world';
  }

  private static lowestChunk(): number {
    return -CFG.chunk.behind;
  }

  /** Generator that builds chunk i in several steps (ground rows, far strips, decor, obstacles). */
  private *buildChunkGen(i: number): Generator<void, void> {
    if (this.chunks.has(i) || i < World.lowestChunk()) return;
    const groundGeo = yield* this.terrain.buildChunkGeometryGen(i);
    const ground = new THREE.Mesh(groundGeo, this.groundMat);
    ground.receiveShadow = true;
    ground.castShadow = false;
    ground.name = `ground-${i}`;
    yield;
    const far = new THREE.Mesh(this.terrain.buildFarGeometry(i), this.farMat);
    far.receiveShadow = false;
    far.name = `far-${i}`;
    yield;
    const decor = this.decor.buildChunk(i);
    yield;
    const obstacles = this.obstacles.buildChunk(i);
    const railyard = yield* this.railyard.buildChunkGen(i);
    const cabin = this.cabin.buildChunk(i);
    // After the obstacles so the bottles can keep clear of them.
    const bottles = this.bottles.buildChunk(i);
    this.group.add(ground, far, decor, obstacles, bottles);
    if (cabin) this.group.add(cabin);
    if (railyard) this.group.add(railyard);
    this.chunks.set(i, { ground, far, decor, obstacles, bottles, cabin, railyard });
    this.generated = Math.max(this.generated, i);
  }

  private buildChunkNow(i: number): void {
    const gen = this.buildChunkGen(i);
    while (!gen.next().done) {
      /* run to completion */
    }
  }

  private removeChunk(i: number): void {
    const c = this.chunks.get(i);
    if (!c) return;
    this.group.remove(c.ground, c.far, c.decor, c.obstacles, c.bottles);
    if (c.cabin) {
      this.group.remove(c.cabin);
      Decor.disposeGroup(c.cabin);
    }
    if (c.railyard) {
      this.group.remove(c.railyard);
      Railyard.disposeGroup(c.railyard);
    }
    c.ground.geometry.dispose();
    c.far.geometry.dispose();
    Decor.disposeGroup(c.decor);
    Obstacles.disposeGroup(c.obstacles);
    this.bottles.removeChunk(i);
    this.colliders.removeChunk(i);
    this.obstacles.removeChunk(i);
    this.chunks.delete(i);
  }

  private window(z: number): { lo: number; hi: number } {
    const i = Math.floor(-z / CFG.chunk.length);
    return { lo: Math.max(World.lowestChunk(), i - CFG.chunk.behind), hi: i + CFG.chunk.ahead };
  }

  /** Build every chunk around z synchronously (used at game start and for teleports). */
  prewarm(z: number): void {
    this.pending = null;
    const { lo, hi } = this.window(z);
    for (let k = lo; k <= hi; k++) this.buildChunkNow(k);
  }

  /** Keep the chunk window around z up to date, spending at most a few ms per call. */
  update(z: number): void {
    const { lo, hi } = this.window(z);
    for (const k of [...this.chunks.keys()]) {
      if (k < lo - 1 || k > hi + 1) this.removeChunk(k);
    }
    if (this.pending && (this.pending.i < lo - 1 || this.pending.i > hi + 1)) this.pending = null;
    const deadline = performance.now() + BUILD_BUDGET_MS;
    while (performance.now() < deadline) {
      if (!this.pending) {
        let next: number | null = null;
        for (let k = lo; k <= hi; k++) {
          if (!this.chunks.has(k)) {
            next = k;
            break;
          }
        }
        if (next === null) return;
        this.pending = { i: next, gen: this.buildChunkGen(next) };
      }
      if (this.pending.gen.next().done) this.pending = null;
    }
  }

  /** True while a chunk is still being generated in the background. */
  get busy(): boolean {
    return this.pending !== null;
  }

  /**
   * Height of what can be stood on at (x, z): the ground, or the roof or ramp
   * of a train in the subway. Roofs and ramps higher than `top` do not count
   * (seen from beside a train they are its side, which the colliders handle).
   */
  groundHeight(x: number, z: number, top = Infinity): number {
    const g = this.terrain.groundHeight(x, z);
    const deck = this.terrain.deckHeight(x, z);
    return deck > g && deck <= top ? deck : g;
  }

  groundNormal(x: number, z: number, out: THREE.Vector3, top = Infinity): THREE.Vector3 {
    if (this.terrain.deckHeight(x, z) === -Infinity) return this.terrain.groundNormal(x, z, out);
    const e = 0.12;
    const t = top + 0.5;
    const hx = this.groundHeight(x + e, z, t) - this.groundHeight(x - e, z, t);
    const hz = this.groundHeight(x, z + e, t) - this.groundHeight(x, z - e, t);
    // A step at the edge of a roof is not a slope.
    if (Math.abs(hx) > 0.2 || Math.abs(hz) > 0.2) return out.set(0, 1, 0);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** Total rolling resistance (ground type + puddles, less on glassy ice) in m/s²; y is the height of the contact. */
  rollingResistance(x: number, z: number, y = -Infinity): number {
    // The smooth roofs and ramps of the trains.
    if (y > this.terrain.groundHeight(x, z) + 0.3) return 0.8;
    return Math.max(0.2, this.terrain.rollingResistance(x, z) + this.colliders.mudAt(x, z));
  }

  dispose(): void {
    this.pending = null;
    for (const k of [...this.chunks.keys()]) this.removeChunk(k);
    this.decor.dispose();
    this.obstacles.dispose();
    this.bottles.dispose();
    this.cabin.dispose();
    this.railyard.dispose();
    this.groundMat.dispose();
    this.farMat.dispose();
    this.colliders.clear();
  }
}
