import * as THREE from 'three';
import { lerp, smoothstep } from '../utils/math';
import { mulberry32, rand, subSeed, type Rng } from '../utils/noise';
import { ColliderStore, SURFACES } from './colliders';
import { LANDSCAPE_LENGTH, landscapeAt } from './landscape';
import { Terrain } from './terrain';

export type ObstacleKind =
  | 'root' | 'branch' | 'log' | 'stone' | 'puddle'
  // Greece
  | 'wall' | 'rock' | 'scree' | 'sand';

const WALL_COLORS = [0xbdb4a2, 0xa99f8c, 0xcfc6b2, 0x9a907e, 0xb5a088].map((h) => new THREE.Color(h));

/**
 * Obstacles lie across the track and get denser and bigger with distance.
 * Each obstacle is both a mesh and one or more colliders.
 */
export class Obstacles {
  private readonly rootMat = new THREE.MeshLambertMaterial({ color: 0x5b4232, flatShading: true });
  private readonly branchMat = new THREE.MeshLambertMaterial({ color: 0x6f5238, flatShading: true });
  private readonly logMat = new THREE.MeshLambertMaterial({ color: 0x7a5a3e, flatShading: true });
  private readonly logEndMat = new THREE.MeshLambertMaterial({ color: 0xc9a977, flatShading: true });
  private readonly stoneMat = new THREE.MeshLambertMaterial({ color: 0x8c8c84, flatShading: true });
  // No metalness: without an environment map a metallic surface renders black.
  private readonly puddleMat = new THREE.MeshStandardMaterial({
    color: 0x7c93a6,
    roughness: 0.35,
    metalness: 0,
    transparent: true,
    opacity: 0.85,
  });
  // Greece: pale limestone, drystone walls and dusty sand.
  private readonly limeMat = new THREE.MeshLambertMaterial({ color: 0xcdc7b6, flatShading: true });
  private readonly wallMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  private readonly sandMat = new THREE.MeshLambertMaterial({ color: 0xdcc898 });
  private readonly wallStoneGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly stoneGeo = new THREE.IcosahedronGeometry(1, 0);
  private readonly stubGeo = new THREE.CylinderGeometry(0.5, 1, 1, 5).translate(0, 0.5, 0);

  constructor(
    private readonly terrain: Terrain,
    private readonly colliders: ColliderStore,
  ) {}

  dispose(): void {
    for (const m of [this.rootMat, this.branchMat, this.logMat, this.logEndMat, this.stoneMat, this.puddleMat, this.limeMat, this.wallMat, this.sandMat]) m.dispose();
    this.stoneGeo.dispose();
    this.wallStoneGeo.dispose();
    this.stubGeo.dispose();
  }

  /** Obstacles per metre of track. */
  static density(p: number): number {
    if (p < 40) return 0;
    return lerp(1 / 26, 1 / 8.5, smoothstep(40, 900, p));
  }

  private pickKind(p: number, rng: Rng): ObstacleKind {
    const weights: Array<[ObstacleKind, number]> = landscapeAt(p) === 'greece' ? [
      ['scree', 1.0],
      ['wall', 1.1],
      ['rock', 0.6],
      ['branch', 0.35],
      ['sand', 0.5],
    ] : [
      ['root', 1.0],
      ['branch', 0.7],
      ['stone', p > 80 ? 0.55 : 0],
      ['log', 1.3 * smoothstep(120, 420, p)],
      ['puddle', p > 150 ? 0.6 : 0],
    ];
    let total = 0;
    for (const [, w] of weights) total += w;
    let r = rng() * total;
    for (const [k, w] of weights) {
      if (r < w) return k;
      r -= w;
    }
    return 'root';
  }

  buildChunk(i: number): THREE.Group {
    const group = new THREE.Group();
    group.name = `obstacles-${i}`;
    const { p0, p1 } = Terrain.chunkRange(i);
    const rng = mulberry32(subSeed(this.terrain.seed, 800 + i));
    const density = Obstacles.density((p0 + p1) / 2);
    const expected = density * (p1 - p0);
    const n = Math.floor(expected + rng());
    if (n === 0) return group;
    const slot = (p1 - p0) / n;
    for (let k = 0; k < n; k++) {
      const p = p0 + slot * (k + 0.15 + rng() * 0.7);
      // Keep obstacles off very steep bits of track.
      if (Math.abs(this.terrain.pathSlope(p)) > 0.3) continue;
      let kind = this.pickKind(p, rng);
      // A log at the foot of a descent traps the apple (it rolls back into the
      // log and cannot be chipped over from contact): use a root there.
      if (kind === 'log' && this.terrain.pathSlope(p) < -0.08) kind = 'root';
      if (kind === 'wall' && this.terrain.pathSlope(p) < -0.08) kind = 'scree';
      switch (kind) {
        case 'root': this.addRoot(group, i, p, rng); break;
        case 'branch': this.addBranch(group, i, p, rng); break;
        case 'log': this.addLog(group, i, p, rng); break;
        case 'stone': this.addStone(group, i, p, rng); break;
        case 'puddle': this.addPuddle(group, i, p, rng); break;
        case 'wall': this.addWall(group, i, p, rng); break;
        case 'rock': this.addRock(group, i, p, rng); break;
        case 'scree': this.addScree(group, i, p, rng); break;
        case 'sand': this.addPuddle(group, i, p, rng, this.sandMat, 4); break;
      }
    }
    return group;
  }

  // ---------------------------------------------------------------------------

  /** Builds a tube along points that follow the ground, plus capsule colliders. */
  private addTubeAcross(
    group: THREE.Group,
    chunk: number,
    p: number,
    rng: Rng,
    radius: number,
    halfSpan: number,
    sink: number, // fraction of the radius buried in the ground
    material: THREE.Material,
    wobble: number,
  ): THREE.Vector3[] {
    const cx = this.terrain.pathCenterX(p);
    const heading = this.terrain.pathHeading(p);
    // (cos a, -sin a) is the "right" vector for yaw a, i.e. across the lane.
    const angle = heading + rand(rng, -0.5, 0.5);
    const d0 = rand(rng, -0.7, 0.7);
    const dirX = Math.cos(angle);
    const dirZ = -Math.sin(angle);
    const points: THREE.Vector3[] = [];
    const segs = 6;
    for (let s = 0; s <= segs; s++) {
      const t = -halfSpan + (2 * halfSpan * s) / segs;
      const wx = cx + d0 + dirX * t + rand(rng, -wobble, wobble);
      const wz = -p + dirZ * t + rand(rng, -wobble, wobble);
      const taper = 1 - 0.8 * Math.abs(t / halfSpan) ** 2;
      const y = this.terrain.groundHeight(wx, wz) + radius * (1 - sink) * taper - radius * sink * (1 - taper);
      points.push(new THREE.Vector3(wx, y, wz));
    }
    const curve = new THREE.CatmullRomCurve3(points);
    const geo = new THREE.TubeGeometry(curve, segs * 3, radius, 6, false);
    const mesh = new THREE.Mesh(geo, material);
    mesh.userData.ownGeometry = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    for (let s = 0; s < points.length - 1; s++) {
      const a = points[s];
      const b = points[s + 1];
      this.colliders.add(chunk, {
        kind: 'capsule',
        ax: a.x, ay: a.y, az: a.z,
        bx: b.x, by: b.y, bz: b.z,
        r: radius * 0.95,
        surface: SURFACES.wood,
        blocksPlayer: false,
      });
    }
    return points;
  }

  private addRoot(group: THREE.Group, chunk: number, p: number, rng: Rng): void {
    const grow = smoothstep(40, 700, p);
    const radius = rand(rng, 0.07, 0.1) + grow * 0.05;
    const halfSpan = rand(rng, 1.3, 2.4);
    const pts = this.addTubeAcross(group, chunk, p, rng, radius, halfSpan, 0.35, this.rootMat, 0.12);
    // Side roots.
    const branches = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < branches; k++) {
      const base = pts[1 + Math.floor(rng() * (pts.length - 2))];
      const ang = rng() * Math.PI * 2;
      const len = rand(rng, 0.4, 0.9);
      const ex = base.x + Math.cos(ang) * len;
      const ez = base.z + Math.sin(ang) * len;
      const ey = this.terrain.groundHeight(ex, ez) - radius * 0.3;
      const geo = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([base.clone(), new THREE.Vector3((base.x + ex) / 2, (base.y + ey) / 2 + 0.02, (base.z + ez) / 2), new THREE.Vector3(ex, ey, ez)]),
        4, radius * 0.55, 5, false,
      );
      const mesh = new THREE.Mesh(geo, this.rootMat);
      mesh.userData.ownGeometry = true;
      mesh.castShadow = true;
      group.add(mesh);
      this.colliders.add(chunk, {
        kind: 'capsule', ax: base.x, ay: base.y, az: base.z, bx: ex, by: ey, bz: ez,
        r: radius * 0.5, surface: SURFACES.wood, blocksPlayer: false,
      });
    }
  }

  private addBranch(group: THREE.Group, chunk: number, p: number, rng: Rng): void {
    const radius = rand(rng, 0.035, 0.06);
    const halfSpan = rand(rng, 0.9, 1.8);
    const pts = this.addTubeAcross(group, chunk, p, rng, radius, halfSpan, -0.05, this.branchMat, 0.08);
    // A couple of twigs.
    for (let k = 0; k < 3; k++) {
      const base = pts[Math.floor(rng() * pts.length)];
      const ang = rng() * Math.PI * 2;
      const len = rand(rng, 0.25, 0.6);
      const end = new THREE.Vector3(base.x + Math.cos(ang) * len, base.y + rand(rng, 0.05, 0.3), base.z + Math.sin(ang) * len);
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([base.clone(), end]), 2, radius * 0.5, 4, false);
      const mesh = new THREE.Mesh(geo, this.branchMat);
      mesh.userData.ownGeometry = true;
      mesh.castShadow = true;
      group.add(mesh);
    }
  }

  private addLog(group: THREE.Group, chunk: number, p: number, rng: Rng): void {
    const grow = smoothstep(120, 800, p);
    const radius = rand(rng, 0.16, 0.22) + grow * 0.1;
    const length = rand(rng, 3, 4.8);
    const cx = this.terrain.pathCenterX(p);
    const heading = this.terrain.pathHeading(p);
    const angle = heading + rand(rng, -0.35, 0.35); // across the lane
    const d0 = rand(rng, -0.6, 0.6);
    const dirX = Math.cos(angle);
    const dirZ = -Math.sin(angle);
    const ax = cx + d0 - dirX * length / 2;
    const az = -p - dirZ * length / 2;
    const bx = cx + d0 + dirX * length / 2;
    const bz = -p + dirZ * length / 2;
    const ay = this.terrain.groundHeight(ax, az) + radius * 0.8;
    const by = this.terrain.groundHeight(bx, bz) + radius * 0.8;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const mz = (az + bz) / 2;
    const len3 = Math.hypot(bx - ax, by - ay, bz - az);
    const geo = new THREE.CylinderGeometry(radius * 0.9, radius, len3, 8, 1);
    const mesh = new THREE.Mesh(geo, [this.logMat, this.logEndMat, this.logEndMat]);
    mesh.userData.ownGeometry = true;
    mesh.position.set(mx, my, mz);
    const dir = new THREE.Vector3(bx - ax, by - ay, bz - az).normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    this.colliders.add(chunk, {
      kind: 'capsule', ax, ay, az, bx, by, bz, r: radius, surface: SURFACES.wood, blocksPlayer: false,
    });
    // Stub branches.
    const stubs = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < stubs; k++) {
      const t = rand(rng, 0.15, 0.85);
      const sx = ax + (bx - ax) * t;
      const sy = ay + (by - ay) * t;
      const sz = az + (bz - az) * t;
      const stub = new THREE.Mesh(this.stubGeo, this.logMat);
      const sl = rand(rng, 0.3, 0.7);
      stub.scale.set(radius * 0.35, sl, radius * 0.35);
      stub.position.set(sx, sy, sz);
      stub.rotation.set(rand(rng, -1.2, 1.2), rng() * 6.28, rand(rng, -0.6, 0.6));
      stub.castShadow = true;
      group.add(stub);
    }
  }

  private addStone(group: THREE.Group, chunk: number, p: number, rng: Rng): void {
    const grow = smoothstep(80, 700, p);
    const r = rand(rng, 0.14, 0.24) + grow * 0.1;
    const cx = this.terrain.pathCenterX(p);
    const x = cx + rand(rng, -1.25, 1.25);
    const z = -p;
    const y = this.terrain.groundHeight(x, z) + r * 0.45;
    const mesh = new THREE.Mesh(this.stoneGeo, this.stoneMat);
    mesh.position.set(x, y, z);
    mesh.scale.set(r * rand(rng, 0.9, 1.3), r * rand(rng, 0.8, 1.1), r * rand(rng, 0.9, 1.3));
    mesh.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    this.colliders.add(chunk, { kind: 'sphere', x, y, z, r: r * 1.05, surface: SURFACES.stone, blocksPlayer: r > 0.2 });
  }

  /** A flat patch on the track that slows the apple: a puddle, or dusty sand in Greece. */
  private addPuddle(group: THREE.Group, chunk: number, p: number, rng: Rng, material: THREE.Material = this.puddleMat, factor = 6): void {
    const cx = this.terrain.pathCenterX(p);
    const d = rng() < 0.6 ? (rng() < 0.5 ? -0.85 : 0.85) : rand(rng, -0.9, 0.9);
    const x = cx + d;
    const z = -p;
    const rx = rand(rng, 0.7, 1.4);
    const rz = rand(rng, 0.45, 0.8);
    // Long axis along the lane (the ring uses a standard rotation of (lx, lz)).
    const angle = Math.PI / 2 - this.terrain.pathHeading(p) + rand(rng, -0.3, 0.3);
    const segs = 14;
    const positions: number[] = [];
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const centerY = this.terrain.groundHeight(x, z) + 0.02;
    const ring: Array<[number, number, number]> = [];
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const lx = Math.cos(a) * rx * rand(rng, 0.85, 1.1);
      const lz = Math.sin(a) * rz * rand(rng, 0.85, 1.1);
      const wx = x + lx * c - lz * s;
      const wz = z + lx * s + lz * c;
      ring.push([wx, Math.min(centerY + 0.02, this.terrain.groundHeight(wx, wz) + 0.02), wz]);
    }
    for (let k = 0; k < segs; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % segs];
      positions.push(x, centerY, z, b[0], b[1], b[2], a[0], a[1], a[2]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.userData.ownGeometry = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    this.colliders.addMud(chunk, { x, z, rx: rx * 1.05, rz: rz * 1.05, angle, factor });
  }

  // ---------------------------------------------------------------------------
  // Greece

  /** How far into the current landscape p lies (0 at its start). */
  private static local(p: number): number {
    return p - Math.floor(p / LANDSCAPE_LENGTH) * LANDSCAPE_LENGTH;
  }

  /**
   * A low drystone wall across the track. Like a log it bounces the apple
   * (chip it over) while the player can climb across.
   */
  private addWall(group: THREE.Group, chunk: number, p: number, rng: Rng): void {
    const height = rand(rng, 0.28, 0.38) + 0.14 * smoothstep(0, 600, Obstacles.local(p));
    const length = rand(rng, 2.4, 3.6);
    const cx = this.terrain.pathCenterX(p);
    const angle = this.terrain.pathHeading(p) + rand(rng, -0.25, 0.25); // across the lane
    const d0 = rand(rng, -0.5, 0.5);
    const dirX = Math.cos(angle);
    const dirZ = -Math.sin(angle);
    const ax = cx + d0 - (dirX * length) / 2;
    const az = -p - (dirZ * length) / 2;
    const bx = cx + d0 + (dirX * length) / 2;
    const bz = -p + (dirZ * length) / 2;
    // Stones in two or three courses, stacked along the wall line.
    const courses = height > 0.4 ? 3 : 2;
    const courseH = height / courses;
    const perCourse = Math.round(length / 0.42);
    const total = courses * perCourse;
    const mesh = new THREE.InstancedMesh(this.wallStoneGeo, this.wallMat, total);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    let n = 0;
    for (let c = 0; c < courses; c++) {
      for (let k = 0; k < perCourse; k++) {
        const t = (k + 0.5 + (c % 2) * 0.35) / perCourse;
        if (t > 1) continue;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        const y = this.terrain.groundHeight(x, z) + courseH * (c + 0.5) - 0.02;
        pos.set(x + rand(rng, -0.02, 0.02), y, z + rand(rng, -0.02, 0.02));
        scl.set((length / perCourse) * rand(rng, 0.88, 1.02), courseH * rand(rng, 0.9, 1.1), (0.42 - c * 0.04) * rand(rng, 0.9, 1.05));
        e.set(rand(rng, -0.06, 0.06), angle + rand(rng, -0.1, 0.1), rand(rng, -0.06, 0.06), 'YXZ');
        q.setFromEuler(e);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(n, m);
        mesh.setColorAt(n, WALL_COLORS[Math.floor(rng() * WALL_COLORS.length)]);
        n++;
      }
    }
    mesh.count = n;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    const r = height / 2;
    this.colliders.add(chunk, {
      kind: 'capsule',
      ax, ay: this.terrain.groundHeight(ax, az) + r, az,
      bx, by: this.terrain.groundHeight(bx, bz) + r, bz,
      r, surface: SURFACES.stone, blocksPlayer: false,
    });
  }

  /** A limestone boulder on one half of the track; walk round it. */
  private addRock(group: THREE.Group, chunk: number, p: number, rng: Rng): void {
    const r = rand(rng, 0.32, 0.45) + 0.15 * smoothstep(0, 600, Obstacles.local(p));
    const cx = this.terrain.pathCenterX(p);
    const x = cx + (rng() < 0.5 ? -1 : 1) * rand(rng, 0.7, 1.2);
    const z = -p;
    const y = this.terrain.groundHeight(x, z) + r * 0.35;
    const mesh = new THREE.Mesh(this.stoneGeo, this.limeMat);
    mesh.position.set(x, y, z);
    mesh.scale.set(r * rand(rng, 1.0, 1.3), r * rand(rng, 0.75, 0.95), r * rand(rng, 1.0, 1.3));
    mesh.rotation.set(rand(rng, -0.4, 0.4), rng() * 6.28, rand(rng, -0.4, 0.4));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    this.colliders.add(chunk, { kind: 'sphere', x, y, z, r: r * 1.02, surface: SURFACES.stone, blocksPlayer: true });
  }

  /** Loose scree: a scatter of small stones that knock the apple off line. */
  private addScree(group: THREE.Group, chunk: number, p: number, rng: Rng): void {
    const cx = this.terrain.pathCenterX(p);
    const count = 5 + Math.floor(rng() * 5);
    for (let k = 0; k < count; k++) {
      const r = rand(rng, 0.06, 0.13);
      const x = cx + rand(rng, -1.4, 1.4);
      const z = -p + rand(rng, -0.8, 0.8);
      const y = this.terrain.groundHeight(x, z) + r * 0.4;
      const mesh = new THREE.Mesh(this.stoneGeo, rng() < 0.6 ? this.limeMat : this.stoneMat);
      mesh.position.set(x, y, z);
      mesh.scale.set(r * rand(rng, 0.9, 1.4), r * rand(rng, 0.7, 1.0), r * rand(rng, 0.9, 1.4));
      mesh.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      mesh.castShadow = true;
      group.add(mesh);
      this.colliders.add(chunk, { kind: 'sphere', x, y, z, r, surface: SURFACES.stone, blocksPlayer: false });
    }
  }

  static disposeGroup(group: THREE.Group): void {
    group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
      else if (o instanceof THREE.Mesh && o.userData.ownGeometry) o.geometry.dispose();
    });
  }
}
