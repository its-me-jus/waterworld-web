import * as THREE from 'three'
import { WAVES, WAVE_COUNT } from './waves'

const vertexShader = /* glsl */ `
uniform float uTime;
uniform vec4 uWaves[${WAVE_COUNT}]; // xy dir, z steepness, w wavelength
uniform vec2 uWaveExtra[${WAVE_COUNT}]; // x phase, y speed

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vFresnelHint;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.02 + vec2(17.1, 9.3);
    a *= 0.5;
  }
  return v;
}

vec3 gerstner(vec3 pos, vec4 wave, vec2 extra, inout vec3 tangent, inout vec3 binormal) {
  float steepness = wave.z;
  float wavelength = wave.w;
  float k = 6.28318530718 / wavelength;
  float c = sqrt(9.8 / k) * extra.y;
  vec2 d = normalize(wave.xy);
  float f = k * (dot(d, pos.xz) - c * uTime) + extra.x;
  float a = steepness / k;

  tangent += vec3(
    -d.x * d.x * steepness * sin(f),
    d.x * steepness * cos(f),
    -d.x * d.y * steepness * sin(f)
  );
  binormal += vec3(
    -d.x * d.y * steepness * sin(f),
    d.y * steepness * cos(f),
    -d.y * d.y * steepness * sin(f)
  );

  return vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
}

void main() {
  vec3 pos = position;
  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
  vec3 displacement = vec3(0.0);

  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    displacement += gerstner(pos, uWaves[i], uWaveExtra[i], tangent, binormal);
  }

  float chop =
    (fbm(pos.xz * 0.08 + vec2(uTime * 0.07, -uTime * 0.05)) - 0.5) * 0.55 +
    (fbm(pos.xz * 0.22 + vec2(-uTime * 0.11, uTime * 0.03)) - 0.5) * 0.22;
  displacement.y += chop;

  // Mild horizontal jitter so crests don't stay locked to a grid
  displacement.x += (fbm(pos.xz * 0.15 + 3.1) - 0.5) * 0.35;
  displacement.z += (fbm(pos.xz * 0.15 + 7.7) - 0.5) * 0.35;

  pos += displacement;

  // Perturb normal with chop derivatives (approximate)
  float e = 0.35;
  float hx = (fbm((pos.xz + vec2(e, 0.0)) * 0.08) - fbm((pos.xz - vec2(e, 0.0)) * 0.08));
  float hz = (fbm((pos.xz + vec2(0.0, e)) * 0.08) - fbm((pos.xz - vec2(0.0, e)) * 0.08));
  vec3 normal = normalize(cross(binormal, tangent) + vec3(-hx * 1.4, 0.0, -hz * 1.4));

  float peak = max(displacement.y, 0.0);
  vFoam = smoothstep(0.35, 1.1, peak) * 0.85 + chop * 0.15;
  vFresnelHint = clamp(1.0 - normal.y, 0.0, 1.0);

  vec4 world = modelMatrix * vec4(pos, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const fragmentShader = /* glsl */ `
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uUnderColor;
uniform vec3 uSunDir;
uniform vec3 uCameraPos;
uniform float uUnderwater;
uniform float uTime;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vFresnelHint;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x)
    + (hash(i + vec2(0.0, 1.0)) - hash(i)) * u.y * (1.0 - u.x)
    + (hash(i + vec2(1.0, 1.0)) - hash(i + vec2(1.0, 0.0))) * u.x * u.y;
}

void main() {
  vec3 N = normalize(vNormal);
  // Flip normal when looking from below
  vec3 V = normalize(uCameraPos - vWorldPos);
  if (dot(N, V) < 0.0) N = -N;

  vec3 L = normalize(uSunDir);

  if (uUnderwater > 0.5) {
    // Murky volume look when camera is submerged
    float depthTint = clamp((-uCameraPos.y + 2.0) * 0.08, 0.0, 1.0);
    vec3 base = mix(uUnderColor, uDeepColor * 0.45, depthTint);
    float caustics = noise(vWorldPos.xz * 0.35 + vec2(uTime * 0.2, -uTime * 0.15));
    caustics *= noise(vWorldPos.xz * 0.7 - vec2(uTime * 0.12, uTime * 0.08));
    base += vec3(0.15, 0.35, 0.3) * pow(caustics, 2.0) * 0.35;

    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.0);
    // Surface from below = brighter silvery sky patch
    vec3 aboveGlow = vec3(0.45, 0.75, 0.85);
    vec3 color = mix(base, aboveGlow, fresnel * 0.55);
    float spec = pow(max(dot(reflect(-L, N), V), 0.0), 40.0);
    color += vec3(0.6, 0.85, 0.9) * spec * 0.25;
    gl_FragColor = vec4(color, 0.88);
    return;
  }

  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.8);
  float facing = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 water = mix(uDeepColor, uShallowColor, facing * facing);
  // Subtle SSS-ish green on wave backs
  water = mix(water, vec3(0.12, 0.45, 0.4), (1.0 - facing) * 0.22);

  vec3 skyTint = vec3(0.55, 0.78, 0.95);
  vec3 horizon = vec3(0.95, 0.72, 0.48);
  vec3 reflectCol = mix(skyTint, horizon, pow(1.0 - clamp(V.y, 0.0, 1.0), 2.0));
  vec3 color = mix(water, reflectCol, fresnel * 0.78);

  float diffuse = max(dot(N, L), 0.0) * 0.4 + 0.5;
  color *= diffuse;

  float spec = pow(max(dot(reflect(-L, N), V), 0.0), 110.0);
  float wide = pow(max(dot(reflect(-L, N), V), 0.0), 18.0);
  color += vec3(1.0, 0.97, 0.9) * spec * 1.2;
  color += vec3(0.7, 0.85, 0.95) * wide * 0.12;

  float foam = smoothstep(0.25, 0.85, vFoam) * (0.55 + 0.45 * vFresnelHint);
  color = mix(color, vec3(0.92, 0.96, 0.98), foam * 0.55);

  // Distance haze into open water
  float dist = length(uCameraPos - vWorldPos);
  color = mix(color, uDeepColor * 1.1, smoothstep(80.0, 260.0, dist) * 0.35);

  gl_FragColor = vec4(color, mix(0.88, 0.97, fresnel));
}
`

export function createOcean(size = 520, segments = 256) {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments)
  geometry.rotateX(-Math.PI / 2)

  const uWaves = WAVES.map(
    (w) => new THREE.Vector4(w.direction[0], w.direction[1], w.steepness, w.wavelength),
  )
  const uWaveExtra = WAVES.map((w) => new THREE.Vector2(w.phase, w.speed))

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWaves: { value: uWaves },
      uWaveExtra: { value: uWaveExtra },
      uDeepColor: { value: new THREE.Color('#0a3d4d') },
      uShallowColor: { value: new THREE.Color('#2f9eae') },
      uUnderColor: { value: new THREE.Color('#053842') },
      uSunDir: { value: new THREE.Vector3(0.45, 0.75, 0.3).normalize() },
      uCameraPos: { value: new THREE.Vector3() },
      uUnderwater: { value: 0 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'Ocean'
  mesh.frustumCulled = false
  return { mesh, material }
}
