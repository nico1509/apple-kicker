import * as THREE from 'three';
import { CFG } from '../config';
import { Bottles } from './bottles';
import { ColliderStore } from './colliders';
import { Decor } from './decor';
import { Obstacles } from './obstacles';
import { Terrain } from './terrain';

interface Chunk {
  ground: THREE.Mesh;
  far: THREE.Mesh;
  decor: THREE.Group;
  obstacles: THREE.Group;
  bottles: THREE.Group;
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
    // After the obstacles so the bottles can keep clear of them.
    const bottles = this.bottles.buildChunk(i);
    this.group.add(ground, far, decor, obstacles, bottles);
    this.chunks.set(i, { ground, far, decor, obstacles, bottles });
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
    c.ground.geometry.dispose();
    c.far.geometry.dispose();
    Decor.disposeGroup(c.decor);
    Obstacles.disposeGroup(c.obstacles);
    this.bottles.removeChunk(i);
    this.colliders.removeChunk(i);
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

  groundHeight(x: number, z: number): number {
    return this.terrain.groundHeight(x, z);
  }

  groundNormal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return this.terrain.groundNormal(x, z, out);
  }

  /** Total rolling resistance (ground type + puddles) in m/s². */
  rollingResistance(x: number, z: number): number {
    return this.terrain.rollingResistance(x, z) + this.colliders.mudAt(x, z);
  }

  dispose(): void {
    this.pending = null;
    for (const k of [...this.chunks.keys()]) this.removeChunk(k);
    this.decor.dispose();
    this.obstacles.dispose();
    this.bottles.dispose();
    this.groundMat.dispose();
    this.farMat.dispose();
    this.colliders.clear();
  }
}
