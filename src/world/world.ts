import * as THREE from 'three';
import { CFG } from '../config';
import { ColliderStore } from './colliders';
import { Decor } from './decor';
import { Obstacles } from './obstacles';
import { Terrain } from './terrain';

interface Chunk {
  ground: THREE.Mesh;
  far: THREE.Mesh;
  decor: THREE.Group;
  obstacles: THREE.Group;
}

/**
 * The world owns the terrain functions, the chunk life-cycle and the collider store.
 */
export class World {
  readonly terrain: Terrain;
  readonly colliders = new ColliderStore();
  readonly decor: Decor;
  readonly obstacles: Obstacles;
  readonly group = new THREE.Group();
  private readonly chunks = new Map<number, Chunk>();
  private readonly groundMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private readonly farMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  /** Highest chunk index ever generated (for stats). */
  generated = 0;

  constructor(readonly seed: number) {
    this.terrain = new Terrain(seed);
    this.decor = new Decor(this.terrain, this.colliders);
    this.obstacles = new Obstacles(this.terrain, this.colliders);
    this.group.name = 'world';
  }

  private buildChunk(i: number): void {
    if (this.chunks.has(i) || i < 0) return;
    const ground = new THREE.Mesh(this.terrain.buildChunkGeometry(i), this.groundMat);
    ground.receiveShadow = true;
    ground.castShadow = false;
    ground.name = `ground-${i}`;
    const far = new THREE.Mesh(this.terrain.buildFarGeometry(i), this.farMat);
    far.receiveShadow = false;
    far.name = `far-${i}`;
    const decor = this.decor.buildChunk(i);
    const obstacles = this.obstacles.buildChunk(i);
    this.group.add(ground, far, decor, obstacles);
    this.chunks.set(i, { ground, far, decor, obstacles });
    this.generated = Math.max(this.generated, i);
  }

  private removeChunk(i: number): void {
    const c = this.chunks.get(i);
    if (!c) return;
    this.group.remove(c.ground, c.far, c.decor, c.obstacles);
    c.ground.geometry.dispose();
    c.far.geometry.dispose();
    Decor.disposeGroup(c.decor);
    Obstacles.disposeGroup(c.obstacles);
    this.colliders.removeChunk(i);
    this.chunks.delete(i);
  }

  /** Build every chunk around z synchronously (used at game start). */
  prewarm(z: number): void {
    const i = Math.floor(-z / CFG.chunk.length);
    for (let k = Math.max(0, i - CFG.chunk.behind); k <= i + CFG.chunk.ahead; k++) this.buildChunk(k);
  }

  /** Keep the chunk window around z up to date. Builds at most one chunk per call. */
  update(z: number): void {
    const i = Math.floor(-z / CFG.chunk.length);
    const lo = Math.max(0, i - CFG.chunk.behind);
    const hi = i + CFG.chunk.ahead;
    for (const k of [...this.chunks.keys()]) {
      if (k < lo - 1 || k > hi + 1) this.removeChunk(k);
    }
    for (let k = lo; k <= hi; k++) {
      if (!this.chunks.has(k)) {
        this.buildChunk(k);
        break;
      }
    }
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
    for (const k of [...this.chunks.keys()]) this.removeChunk(k);
    this.decor.dispose();
    this.obstacles.dispose();
    this.groundMat.dispose();
    this.farMat.dispose();
    this.colliders.clear();
  }
}
