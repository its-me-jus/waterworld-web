import * as THREE from 'three'
import { WAVES, WAVE_COUNT } from './waves'

const noiseGLSL = /* glsl */ `
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
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p, int octaves) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    v += a * noise(p);
    p = p * 2.03 + vec2(17.1, 9.3);
    a *= 0.5;
  }
  return v;
}
`

const vertexShader = /* glsl */ `
uniform float uTime;
uniform vec4 uWaves[${WAVE_COUNT}];
uniform vec2 uWaveExtra[${WAVE_COUNT}];

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vCrest;

${noiseGLSL}

vec3 gerstner(vec2 p, vec4 wave, vec2 extra, inout vec3 tangent, inout vec3 binormal) {
  float steepness = wave.z;
  float wavelength = wave.w;
  float k = 6.28318530718 / wavelength;
  float c = sqrt(9.8 / k) * extra.y;
  vec2 d = normalize(wave.xy);
  float f = k * (dot(d, p) - c * uTime) + extra.x;
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
  // Waves live in world space so the mesh can follow the camera seamlessly
  vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;

  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
  vec3 disp = vec3(0.0);

  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    disp += gerstner(world.xz, uWaves[i], uWaveExtra[i], tangent, binormal);
  }

  float chop =
    (fbm(world.xz * 0.08 + vec2(uTime * 0.07, -uTime * 0.05), 4) - 0.5) * 0.55 +
    (fbm(world.xz * 0.22 + vec2(-uTime * 0.11, uTime * 0.03), 3) - 0.5) * 0.22;
  disp.y += chop;

  world += disp;

  vCrest = smoothstep(0.4, 1.35, disp.y);
  vWorldPos = world;
  vNormal = normalize(cross(binormal, tangent));

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`

const fragmentShader = /* glsl */ `
uniform samplerCube uEnvMap;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uUnderColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uCameraPos;
uniform vec3 uHorizonColor;
uniform float uUnderwater;
uniform float uTime;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vCrest;

${noiseGLSL}

// Micro-detail normal from noise gradient, faded with distance to kill shimmer
vec3 detailNormal(vec2 p, float fade) {
  float e = 0.32;
  vec2 flow = vec2(uTime * 0.35, uTime * -0.22);
  float h = fbm((p + flow) * 0.62, ${'DETAIL_OCT'});
  float hx = fbm((p + flow + vec2(e, 0.0)) * 0.62, ${'DETAIL_OCT'});
  float hz = fbm((p + flow + vec2(0.0, e)) * 0.62, ${'DETAIL_OCT'});

  vec2 flow2 = vec2(uTime * -0.6, uTime * 0.4);
  float g = fbm((p + flow2) * 2.3, 2);
  float gx = fbm((p + flow2 + vec2(e * 0.45, 0.0)) * 2.3, 2);
  float gz = fbm((p + flow2 + vec2(0.0, e * 0.45)) * 2.3, 2);

  float dx = (hx - h) * 3.4 + (gx - g) * 2.0;
  float dz = (hz - h) * 3.4 + (gz - g) * 2.0;
  return normalize(vec3(-dx * fade, 1.0, -dz * fade));
}

// GGX specular — gives tight sun glitter instead of a plastic blob
float ggx(vec3 N, vec3 V, vec3 L, float rough) {
  vec3 H = normalize(V + L);
  float a = rough * rough;
  float ndh = max(dot(N, H), 0.0);
  float d = ndh * ndh * (a * a - 1.0) + 1.0;
  float D = (a * a) / (3.14159265 * d * d);
  float ndl = max(dot(N, L), 0.0);
  float ndv = max(dot(N, V), 0.0);
  float k = a * 0.5;
  float G = (ndl / (ndl * (1.0 - k) + k)) * (ndv / (ndv * (1.0 - k) + k));
  return D * G;
}

void main() {
  vec3 V = normalize(uCameraPos - vWorldPos);
  float dist = length(uCameraPos - vWorldPos);
  vec3 L = normalize(uSunDir);

  float fade = 1.0 / (1.0 + dist * 0.035);
  vec3 base = normalize(vNormal);
  vec3 detail = detailNormal(vWorldPos.xz, fade);
  vec3 N = normalize(base + vec3(detail.x, 0.0, detail.z) * 0.7);
  N.y = max(N.y, 0.12);
  N = normalize(N);

  if (uUnderwater > 0.5) {
    float depth = clamp((-uCameraPos.y + 2.0) * 0.05, 0.0, 1.0);
    vec3 murk = mix(uUnderColor, uUnderColor * 0.45, depth);

    // Light shafts / caustics rippling on the underside of the surface
    float caus = fbm(vWorldPos.xz * 0.4 + vec2(uTime * 0.25, -uTime * 0.18), 3);
    caus *= fbm(vWorldPos.xz * 0.9 - vec2(uTime * 0.15, uTime * 0.1), 2);
    murk += vec3(0.2, 0.5, 0.46) * pow(caus, 1.6) * 0.8;

    // Looking up through the surface: Snell's window opens toward vertical,
    // everything outside it mirrors the dark water back at you.
    vec3 I = normalize(vWorldPos - uCameraPos);
    vec3 Nd = -N; // surface normal facing the submerged camera
    float upness = clamp(I.y, 0.0, 1.0);

    vec3 refr = refract(I, Nd, 1.33);
    vec3 sky = dot(refr, refr) < 0.0001
      ? uUnderColor * 1.3
      : min(textureCube(uEnvMap, refr).rgb, vec3(1.3));

    float snell = smoothstep(0.24, 0.95, upness);
    vec3 mirror = mix(murk * 1.15, vec3(0.3, 0.55, 0.6), 0.25);
    // Haze the sky patch so the window edge feels like water, not a cutout
    sky = mix(mirror, sky, 0.72);
    vec3 col = mix(mirror, sky, snell);

    col += uSunColor * ggx(Nd, -I, L, 0.45) * 0.25 * snell;
    col = mix(col, murk, smoothstep(8.0, 60.0, dist));

    gl_FragColor = vec4(col, 0.95);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }

  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.015); // never sample below the horizon
  vec3 sky = textureCube(uEnvMap, R).rgb;
  // Physical sky can spike near the sun — keep reflections from blowing out
  sky = min(sky, vec3(1.2));
  // Grazing reflections read darker/greyer on real water, not milky white
  sky = mix(sky * 0.42, sky, smoothstep(0.0, 0.38, R.y));
  sky = mix(sky, uHorizonColor * 0.7, smoothstep(0.28, 0.0, R.y) * 0.45);

  // Schlick fresnel for water (F0 ~ 0.02), capped so near water keeps its colour
  float ndv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.9 * pow(1.0 - ndv, 5.0);
  fres = min(fres, 0.52);

  // Body colour: deeper looking down the wave, brighter on the shoulders
  float facing = clamp(N.y, 0.0, 1.0);
  vec3 body = mix(uDeepColor, uShallowColor, pow(facing, 2.2));

  // Subsurface glow where the sun shines through a wave back
  float sss = pow(max(dot(-L, V) * 0.5 + 0.5, 0.0), 3.0) * (1.0 - facing);
  body += vec3(0.05, 0.3, 0.24) * sss * 0.8;

  vec3 color = mix(body, sky, fres);

  // Troughs sit in their own shadow
  float ao = 0.68 + 0.32 * smoothstep(-2.0, 1.4, vWorldPos.y);
  color *= ao;

  // Sun glitter: sharp near, broader far
  float rough = mix(0.05, 0.2, clamp(dist * 0.006, 0.0, 1.0));
  color += uSunColor * ggx(N, V, L, rough) * 1.6;

  // Whitecaps on crests + a little foam streaking in the chop
  float streak = fbm(vWorldPos.xz * 0.9 + vec2(uTime * 0.25, -uTime * 0.2), 3);
  float foam = clamp(vCrest * smoothstep(0.45, 0.95, streak), 0.0, 1.0);
  foam *= smoothstep(0.35, 0.8, facing);
  color = mix(color, vec3(0.88, 0.94, 0.97), foam * 0.5);

  // Blend to horizon so the mesh edge disappears
  float far = smoothstep(220.0, 430.0, dist);
  color = mix(color, uHorizonColor * 0.85, far * 0.6);

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export type OceanOptions = {
  size?: number
  segments?: number
  /** fewer noise octaves on weak GPUs */
  detailOctaves?: number
}

export function createOcean({ size = 560, segments = 280, detailOctaves = 4 }: OceanOptions = {}) {
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
      uEnvMap: { value: null },
      uDeepColor: { value: new THREE.Color('#031d2b') },
      uShallowColor: { value: new THREE.Color('#12718c') },
      uUnderColor: { value: new THREE.Color('#0c5c6b') },
      uSunColor: { value: new THREE.Color('#fff3d8') },
      uHorizonColor: { value: new THREE.Color('#8fb3c9') },
      uSunDir: { value: new THREE.Vector3(0.45, 0.35, 0.3).normalize() },
      uCameraPos: { value: new THREE.Vector3() },
      uUnderwater: { value: 0 },
    },
    vertexShader,
    fragmentShader: fragmentShader.replaceAll('DETAIL_OCT', String(detailOctaves)),
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'Ocean'
  mesh.frustumCulled = false

  const step = size / segments

  /** Keep the ocean centred on the player without the waves sliding along. */
  function follow(x: number, z: number) {
    mesh.position.x = Math.round(x / step) * step
    mesh.position.z = Math.round(z / step) * step
  }

  return { mesh, material, follow }
}
