import * as THREE from 'three'

/**
 * The camp fire's flames, sparks and steam: one draw call, every part of it
 * moved in the shader, so a frame costs a handful of uniform writes.
 *
 *  - flames   four upright cards that turn to face the eye, each a different
 *             sheet of the same rising noise, so the fire has a front and a
 *             back and never repeats the same tongue twice
 *  - sparks   specks that leave the coals, wander up on the heat and go out
 *  - steam    pale puffs that only show when rain is falling on hot stone
 *  - glow     the air round the fire lit by it, after dark
 *
 * Nothing here is a light. The one PointLight the camp has lives in
 * cash-bag.ts and is never added, removed or hidden.
 */

const vertex = /* glsl */ `
  attribute vec2 aCorner;
  attribute vec4 aSeed;
  attribute float aKind;
  uniform float uTime;
  uniform float uHeight;
  uniform float uStorm;
  uniform float uSparks;
  uniform vec2 uWind;
  varying vec2 vUv;
  varying vec4 vSeed;
  varying float vKind;
  varying float vLife;

  void main() {
    vUv = aCorner * 0.5 + 0.5;
    vSeed = aSeed;
    vKind = aKind;
    vLife = 0.0;
    vec3 base = (modelMatrix * vec4(position, 1.0)).xyz;
    vec3 toEye = cameraPosition - base;
    vec3 right = normalize(vec3(toEye.z, 0.0, -toEye.x));
    vec3 world = base;

    if (aKind < 0.5) {
      // A flame card: stands on the coals, faces the eye, leans with the wind toward its tip
      float h = aSeed.y * uHeight;
      float w = aSeed.x * (0.8 + 0.2 * uHeight);
      float up = vUv.y;
      world += right * aCorner.x * w * 0.5;
      world.y += up * h;
      world.xz += uWind * up * up * h * (0.1 + uStorm * 0.4);
      // Cards behind the first sit a little back and to the side, so the fire has depth
      world += normalize(vec3(toEye.x, 0.0, toEye.z)) * aSeed.z;
    } else if (aKind < 1.5) {
      // A spark: born in the coals, carried up, wandering, burnt out by the end of its life
      float life = 1.3 + aSeed.x * 2.1;
      float age = fract(uTime / life + aSeed.y);
      vLife = age;
      float rise = age * (1.5 + aSeed.z * 2.6) * (0.55 + 0.45 * uHeight);
      float a = aSeed.w * 6.283;
      float r0 = 0.05 + aSeed.z * 0.2;
      vec3 p = vec3(cos(a) * r0, 0.12 + rise, sin(a) * r0);
      float wob = uTime * (2.0 + aSeed.x * 2.0) + aSeed.w * 40.0;
      p.x += sin(wob + age * 5.0) * 0.16 * age;
      p.z += cos(wob * 0.8 + age * 4.0) * 0.16 * age;
      p.xz += uWind * age * age * (0.5 + uStorm * 2.2);
      world += p;
      // Fewer of them by day and in rain: the ones past the cut are folded away to nothing
      float on = step(aSeed.w, uSparks);
      float size = (0.01 + aSeed.x * 0.012) * (1.0 - age * 0.55) * on;
      vec3 upv = normalize(cross(toEye, right));
      world += (right * aCorner.x + upv * aCorner.y) * size;
    } else if (aKind < 2.5) {
      // Steam: a puff off the hot stones for every few raindrops
      float life = 1.6 + aSeed.x * 1.2;
      float age = fract(uTime / life + aSeed.y);
      vLife = age;
      float a = aSeed.w * 6.283;
      vec3 p = vec3(cos(a) * 0.45, 0.15 + age * (0.9 + aSeed.z * 0.8), sin(a) * 0.45);
      p.xz += uWind * age * (0.4 + uStorm * 1.4);
      world += p;
      float size = (0.16 + age * 0.42) * step(0.02, uStorm);
      vec3 upv = normalize(cross(toEye, right));
      world += (right * aCorner.x + upv * aCorner.y) * size;
    } else {
      // The lit air: one soft disc, facing the eye
      vec3 upv = normalize(cross(toEye, right));
      world.y += 0.55;
      world += (right * aCorner.x + upv * aCorner.y) * aSeed.x;
    }
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }`

const fragment = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  uniform float uHeight;
  uniform float uNight;
  uniform float uStorm;
  uniform float uFlicker;
  varying vec2 vUv;
  varying vec4 vSeed;
  varying float vKind;
  varying float vLife;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec2(17.1, 9.2);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    if (vKind < 0.5) {
      // —— a sheet of flame ——
      float seed = vSeed.w * 37.0;
      float y = vUv.y;
      float x = (vUv.x - 0.5) * 2.0;
      float edge = abs(x);
      // The whole sheet sways, more toward the tip
      float sway = (fbm(vec2(y * 1.6 - uTime * 0.9, seed)) - 0.5) * 0.9 * y;
      x += sway;
      // Noise that climbs: slow broad tongues and quick fine ones over them
      float t = uTime * (1.5 + vSeed.w * 0.5);
      float n1 = fbm(vec2(x * 1.7 + seed, y * 2.1 - t));
      float n2 = fbm(vec2(x * 4.2 - seed, y * 4.6 - t * 1.9));
      float n = n1 * 0.68 + n2 * 0.32;
      // A flame is widest just above its bed and comes to ragged points
      float width = mix(0.86, 0.1, pow(y, 0.72));
      float body = 1.0 - abs(x) / width;
      // How much fire is left this high up: the noise eats it away toward the top
      float heat = body * 1.25 + (n - 0.5) * 1.9 * (0.3 + y) - y * 1.3;
      // Nothing may reach the card's own edges, or the fire shows its corners
      heat *= smoothstep(0.0, 0.07, y) * (1.0 - smoothstep(0.8, 0.98, y)) * (1.0 - smoothstep(0.8, 0.98, edge));
      float a = smoothstep(0.02, 0.3, heat);
      if (a < 0.004) discard;
      // White-yellow where it is hottest, through orange, to deep red at the fraying edge
      float core = smoothstep(0.38, 1.0, heat) * (1.0 - smoothstep(0.35, 0.95, y));
      vec3 col = mix(vec3(1.0, 0.2, 0.02), vec3(1.0, 0.5, 0.07), smoothstep(0.05, 0.42, heat));
      col = mix(col, vec3(1.0, 0.86, 0.46), core);
      // Blue at the very base, where it feeds
      col = mix(col, vec3(0.35, 0.45, 1.0), (1.0 - smoothstep(0.0, 0.1, y)) * 0.35 * a);
      float bright = (1.5 + 2.7 * core) * uStrength * uFlicker;
      // By day the flame has to stand against bright sand, so it keeps some body of its own;
      // after dark it is light and nothing else
      float cover = a * mix(0.62, 0.22, uNight) * uStrength;
      gl_FragColor = vec4(col * bright * a, cover);
    } else if (vKind < 1.5) {
      // —— a spark ——
      vec2 p = vUv * 2.0 - 1.0;
      float d = dot(p, p);
      if (d > 1.0) discard;
      float fade = (1.0 - vLife) * (1.0 - vLife) * smoothstep(0.0, 0.06, vLife);
      float twinkle = 0.65 + 0.35 * sin(uTime * (17.0 + vSeed.x * 13.0) + vSeed.w * 80.0);
      vec3 col = mix(vec3(1.0, 0.24, 0.03), vec3(1.0, 0.72, 0.3), fade);
      float k = (1.0 - d) * fade * twinkle * (0.5 + 2.2 * uNight) * uStrength;
      gl_FragColor = vec4(col * k * 2.4, 0.0);
    } else if (vKind < 2.5) {
      // —— steam ——
      vec2 p = vUv * 2.0 - 1.0;
      float d = dot(p, p);
      float puff = (1.0 - smoothstep(0.1, 1.0, d)) * fbm(vUv * 3.0 + vSeed.xy * 9.0 + uTime * 0.2);
      float fade = smoothstep(0.0, 0.15, vLife) * (1.0 - smoothstep(0.45, 1.0, vLife));
      float a = puff * fade * smoothstep(0.15, 0.6, uStorm) * 0.5;
      if (a < 0.004) discard;
      // Lit grey by day, a ghost of the firelight by night
      vec3 col = mix(vec3(0.62, 0.64, 0.68), vec3(0.3, 0.16, 0.08), uNight);
      gl_FragColor = vec4(col * a, a);
    } else {
      // —— the lit air ——
      vec2 p = vUv * 2.0 - 1.0;
      float d = length(p);
      float g = pow(max(0.0, 1.0 - d), 2.6);
      float k = g * uNight * uStrength * uFlicker * 0.16;
      gl_FragColor = vec4(vec3(1.0, 0.42, 0.12) * k, 0.0);
    }
  }`

export interface CampFlames {
  mesh: THREE.Mesh
  /**
   * `strength` 0..1 is how hard the fire is burning (rain damps it), `night`
   * 0..1 how dark it is round it, `flicker` the same pulse the light is given.
   */
  update(t: number, strength: number, night: number, storm: number, flicker: number): void
  triangles: number
}

/** The trade wind's heading, the same number island.ts leans its trees by. */
const WIND_HEADING = 0.62

export function createCampFlames(lowPower: boolean): CampFlames {
  const corners: number[] = []
  const seeds: number[] = []
  const kinds: number[] = []
  const positions: number[] = []
  const index: number[] = []
  let seed = 71
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const card = (kind: number, a: number, b: number, c: number, d: number, x = 0, y = 0, z = 0) => {
    const base = corners.length / 2
    for (const [cx, cy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      corners.push(cx, cy)
      seeds.push(a, b, c, d)
      kinds.push(kind)
      positions.push(x, y, z)
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  // Flame cards: width, height, how far behind the first, and a seed of their own.
  // The back ones are drawn first so the front one lies over them.
  card(0, 0.95, 1.05, -0.16, 0.71, 0.14, 0.06, 0)
  card(0, 0.9, 1.2, -0.08, 0.37, -0.12, 0.05, 0)
  if (!lowPower) card(0, 0.75, 0.8, 0.02, 0.93, 0.2, 0.04, 0)
  card(0, 1.05, 1.5, 0.08, 0.13, 0, 0.04, 0)
  const sparks = lowPower ? 18 : 44
  for (let i = 0; i < sparks; i++) card(1, rand(), rand(), rand(), (i + 0.5) / sparks)
  const steam = lowPower ? 4 : 7
  for (let i = 0; i < steam; i++) card(2, rand(), (i + rand() * 0.6) / steam, rand(), rand())
  card(3, 2.6, 0, 0, 0)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('aCorner', new THREE.Float32BufferAttribute(corners, 2))
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4))
  geo.setAttribute('aKind', new THREE.Float32BufferAttribute(kinds, 1))
  geo.setIndex(index)
  // Everything is placed in the shader: these bounds hold the tallest flame, the sparks' whole flight and the glow
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 5.5)

  const uniforms = {
    uTime: { value: 0 },
    uStrength: { value: 1 },
    uHeight: { value: 1 },
    uNight: { value: 0 },
    uStorm: { value: 0 },
    uFlicker: { value: 1 },
    uSparks: { value: 0.3 },
    uWind: { value: new THREE.Vector2(Math.cos(WIND_HEADING), Math.sin(WIND_HEADING)) },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Light added over what is behind, less whatever body the flame has: one
    // blend for flame (bright, a little solid), sparks (bright, no body) and
    // steam (dull, all body)
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  })
  const mesh = new THREE.Mesh(geo, material)
  mesh.name = 'Flames'
  mesh.userData.noShadow = true
  mesh.renderOrder = 2

  function update(t: number, strength: number, night: number, storm: number, flicker: number) {
    uniforms.uTime.value = t
    uniforms.uStrength.value = strength
    // Low over its embers by day, standing up after dark; rain beats it down
    uniforms.uHeight.value = (0.62 + 0.38 * night) * (1 - 0.45 * storm) * (0.92 + 0.08 * flicker)
    uniforms.uNight.value = night
    uniforms.uStorm.value = storm
    uniforms.uFlicker.value = flicker
    uniforms.uSparks.value = (0.22 + 0.78 * night) * (1 - 0.7 * storm)
  }

  return { mesh, update, triangles: index.length / 3 }
}
