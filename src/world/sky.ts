import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, rand } from '../utils/noise';

const VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform vec3 topColor;
uniform vec3 horizonColor;
uniform vec3 groundColor;
uniform vec3 stormColor;
uniform vec3 sunDir;
uniform float stormAmount;
uniform float flash;
varying vec3 vWorldPos;

void main() {
  vec3 dir = normalize(vWorldPos - cameraPosition);
  float h = dir.y;
  vec3 sky = mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), 0.5));
  vec3 col = h < 0.0 ? mix(horizonColor, groundColor, clamp(-h * 5.0, 0.0, 1.0)) : sky;

  // Wispy cirrus streaks like on a clear October morning.
  float streak = sin(dir.x * 14.0 + dir.z * 6.0 + dir.y * 3.0) * sin(dir.z * 19.0 - dir.x * 4.0 + dir.y * 31.0);
  float cirrus = smoothstep(0.45, 0.95, streak) * smoothstep(0.03, 0.3, h) * (1.0 - smoothstep(0.55, 0.9, h));
  col = mix(col, vec3(0.93, 0.95, 0.98), cirrus * 0.45 * (1.0 - stormAmount));

  // Sun disc and glow.
  float sd = max(dot(dir, sunDir), 0.0);
  col += vec3(1.0, 0.93, 0.78) * (pow(sd, 400.0) * 1.4 + pow(sd, 10.0) * 0.16);

  // The storm darkens the sky behind the player (towards +Z) and slowly overhead.
  float facing = dot(normalize(vec3(dir.x, 0.0, dir.z) + vec3(0.0, 0.0, 0.0001)), vec3(0.0, 0.0, 1.0));
  float s = smoothstep(-0.4, 0.8, facing) * stormAmount;
  s = max(s, stormAmount * 0.45 * smoothstep(0.25, 0.9, h));
  s = max(s, stormAmount * stormAmount * 0.6);
  col = mix(col, stormColor * (1.0 - 0.35 * clamp(h, 0.0, 1.0)), clamp(s, 0.0, 1.0));
  col += vec3(0.9, 0.9, 1.0) * flash * 0.7;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Sky dome with procedural gradient plus a few low-poly cumulus clouds. */
export class Sky {
  readonly mesh: THREE.Mesh;
  readonly clouds = new THREE.Group();
  readonly uniforms: {
    topColor: { value: THREE.Color };
    horizonColor: { value: THREE.Color };
    groundColor: { value: THREE.Color };
    stormColor: { value: THREE.Color };
    sunDir: { value: THREE.Vector3 };
    stormAmount: { value: number };
    flash: { value: number };
  };
  private readonly cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  private readonly cloudGeos: THREE.BufferGeometry[] = [];
  private readonly drift: number[] = [];
  private time = 0;

  constructor(
    private readonly scene: THREE.Scene,
    sunDir: THREE.Vector3,
  ) {
    this.uniforms = {
      topColor: { value: new THREE.Color(0x4f8fd6) },
      horizonColor: { value: new THREE.Color(0xd3e4f3) },
      groundColor: { value: new THREE.Color(0x6f8f4a) },
      stormColor: { value: new THREE.Color(0x3b4048) },
      sunDir: { value: sunDir.clone().normalize() },
      stormAmount: { value: 0 },
      flash: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 16), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    scene.add(this.mesh);

    // Clouds.
    const rng = mulberry32(1234);
    for (let i = 0; i < 9; i++) {
      const parts: THREE.BufferGeometry[] = [];
      const blobs = 4 + Math.floor(rng() * 4);
      const width = rand(rng, 18, 40);
      for (let k = 0; k < blobs; k++) {
        const r = rand(rng, 6, 12);
        const g = new THREE.IcosahedronGeometry(r, 1);
        g.scale(rand(rng, 1.1, 1.8), rand(rng, 0.45, 0.7), rand(rng, 0.9, 1.3));
        g.translate(rand(rng, -width / 2, width / 2), rand(rng, -2, 3), rand(rng, -6, 6));
        parts.push(g);
      }
      const geo = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      this.cloudGeos.push(geo);
      const mesh = new THREE.Mesh(geo, this.cloudMat);
      const angle = rand(rng, 0, Math.PI * 2);
      const dist = rand(rng, 120, 320);
      mesh.position.set(Math.cos(angle) * dist, rand(rng, 55, 95), Math.sin(angle) * dist);
      mesh.rotation.y = rng() * 6.28;
      this.clouds.add(mesh);
      this.drift.push(rand(rng, 0.4, 1.2));
    }
    scene.add(this.clouds);
  }

  update(dt: number, camPos: THREE.Vector3, stormAmount: number, flash: number): void {
    this.time += dt;
    this.mesh.position.copy(camPos);
    // Clouds follow the camera with a little parallax and drift with the wind.
    this.clouds.position.set(camPos.x * 0.85, 0, camPos.z * 0.85);
    this.clouds.children.forEach((c, i) => {
      c.position.x += this.drift[i] * dt;
      if (c.position.x > 360) c.position.x -= 720;
    });
    this.uniforms.stormAmount.value = stormAmount;
    this.uniforms.flash.value = flash;
    // Clouds turn grey when the storm is near.
    this.cloudMat.color.setRGB(1 - stormAmount * 0.55, 1 - stormAmount * 0.55, 1 - stormAmount * 0.5);
  }

  dispose(): void {
    this.scene.remove(this.mesh, this.clouds);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    for (const g of this.cloudGeos) g.dispose();
    this.cloudMat.dispose();
  }
}
