import * as THREE from 'three';
import type { Foot } from '../config';
import { damp } from '../utils/math';

interface LegPose {
  thigh: number; // rotation about X: positive = forward
  knee: number; // bend amount (>= 0)
  ankle: number;
}

class Leg {
  readonly hip = new THREE.Group();
  readonly knee = new THREE.Group();
  readonly ankle = new THREE.Group();
  readonly pose: LegPose = { thigh: 0, knee: 0, ankle: 0 };
  readonly target: LegPose = { thigh: 0, knee: 0, ankle: 0 };

  constructor(x: number, thighMat: THREE.Material, shinMat: THREE.Material, shoeMat: THREE.Material, soleMat: THREE.Material) {
    const thighLen = 0.46;
    const shinLen = 0.44;
    this.hip.position.set(x, thighLen + shinLen + 0.08, 0);
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.16, thighLen, 0.17), thighMat);
    thigh.position.y = -thighLen / 2;
    thigh.castShadow = true;
    this.hip.add(thigh);
    this.knee.position.y = -thighLen;
    this.hip.add(this.knee);
    const shin = new THREE.Mesh(new THREE.BoxGeometry(0.14, shinLen, 0.15), shinMat);
    shin.position.y = -shinLen / 2;
    shin.castShadow = true;
    this.knee.add(shin);
    this.ankle.position.y = -shinLen;
    this.knee.add(this.ankle);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.1, 0.31), shoeMat);
    shoe.position.set(0, -0.03, -0.06);
    shoe.castShadow = true;
    this.ankle.add(shoe);
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 0.33), soleMat);
    sole.position.set(0, -0.085, -0.06);
    this.ankle.add(sole);
    const toe = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.07, 0.08), shoeMat);
    toe.position.set(0, -0.045, -0.24);
    this.ankle.add(toe);
  }

  update(dt: number, lambda: number): void {
    const p = this.pose;
    const t = this.target;
    p.thigh = damp(p.thigh, t.thigh, lambda, dt);
    p.knee = damp(p.knee, t.knee, lambda, dt);
    p.ankle = damp(p.ankle, t.ankle, lambda, dt);
    this.hip.rotation.x = p.thigh;
    this.knee.rotation.x = -p.knee;
    this.ankle.rotation.x = p.ankle;
  }
}

/**
 * First-person legs: two jointed legs hanging from the hips. Poses are driven
 * by the player (walking, aiming, kicking) and smoothed here.
 */
export class Legs {
  readonly group = new THREE.Group();
  readonly left: Leg;
  readonly right: Leg;
  private readonly mats: THREE.Material[];

  constructor() {
    const thighMat = new THREE.MeshLambertMaterial({ color: 0x3f5a86 });
    const shinMat = new THREE.MeshLambertMaterial({ color: 0x3a5480 });
    const shoeMat = new THREE.MeshLambertMaterial({ color: 0x5a3b26 });
    const soleMat = new THREE.MeshLambertMaterial({ color: 0x2a2520 });
    this.mats = [thighMat, shinMat, shoeMat, soleMat];
    this.left = new Leg(-0.12, thighMat, shinMat, shoeMat, soleMat);
    this.right = new Leg(0.12, thighMat, shinMat, shoeMat, soleMat);
    // A simple pelvis block anchors the two thighs.
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.22), thighMat);
    pelvis.position.set(0, 0.46 + 0.44 + 0.08 + 0.05, 0.01);
    pelvis.castShadow = true;
    this.group.add(this.left.hip, this.right.hip, pelvis);
    this.group.name = 'legs';
  }

  leg(foot: Foot): Leg {
    return foot === 'left' ? this.left : this.right;
  }

  /** Walk-cycle pose. phase advances with distance; amount 0..1 scales the stride. */
  setWalk(phase: number, amount: number): void {
    const a = 0.55 * amount;
    const sl = Math.sin(phase);
    const sr = Math.sin(phase + Math.PI);
    // A forward lean of the thighs keeps the feet visible when looking down.
    const lean = 0.3 * (1 - amount * 0.5);
    this.left.target.thigh = a * sl + lean;
    this.right.target.thigh = a * sr + lean;
    this.left.target.knee = Math.max(0, Math.cos(phase)) * 0.95 * amount + 0.08;
    this.right.target.knee = Math.max(0, Math.cos(phase + Math.PI)) * 0.95 * amount + 0.08;
    // Standing: the soles stay flat on the ground; walking: the feet swing a little.
    const ank = 1.0 - 0.6 * Math.min(1, amount);
    this.left.target.ankle = -(this.left.target.thigh - this.left.target.knee) * ank;
    this.right.target.ankle = -(this.right.target.thigh - this.right.target.knee) * ank;
  }

  /** Aiming pose: the kicking leg is drawn back proportionally to the power. */
  setAim(foot: Foot, power: number): void {
    const l = this.leg(foot);
    l.target.thigh = -0.45 * power - 0.05;
    l.target.knee = 0.75 * power + 0.15;
    l.target.ankle = 0.25 * power;
    const o = this.leg(foot === 'left' ? 'right' : 'left');
    o.target.thigh = -0.05;
    o.target.knee = 0.12;
    o.target.ankle = 0;
  }

  /** Kick pose at time t (seconds since the kick started). Returns true when the kick is finished. */
  setKick(foot: Foot, t: number, power: number): boolean {
    const l = this.leg(foot);
    const back = -0.8 - 0.35 * power;
    const fwd = 1.0 + 0.35 * power;
    let thigh: number;
    let knee: number;
    if (t < 0.13) {
      const u = t / 0.13;
      thigh = back * ease(u);
      knee = 1.35 * ease(u);
    } else if (t < 0.23) {
      const u = (t - 0.13) / 0.1;
      thigh = back + (fwd - back) * easeIn(u);
      knee = 1.35 - 1.2 * easeIn(u);
    } else if (t < 0.55) {
      const u = (t - 0.23) / 0.32;
      thigh = fwd - (fwd - 0.2) * ease(u);
      knee = 0.15 + 0.5 * Math.sin(u * Math.PI);
    } else {
      return true;
    }
    l.target.thigh = thigh;
    l.target.knee = knee;
    l.target.ankle = Math.max(0, thigh) * 0.5;
    const o = this.leg(foot === 'left' ? 'right' : 'left');
    o.target.thigh = -0.15;
    o.target.knee = 0.25;
    o.target.ankle = 0.1;
    return false;
  }

  update(dt: number, lambda = 16): void {
    this.left.update(dt, lambda);
    this.right.update(dt, lambda);
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}

const ease = (u: number): number => u * u * (3 - 2 * u);
const easeIn = (u: number): number => u * u;
