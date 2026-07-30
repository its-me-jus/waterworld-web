import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Everything that makes the water below the surface feel inhabited: shafts of
 * sunlight, suspended particulate, rising bubble plumes, schooling fish and
 * drifting jellyfish. All of it is kept centred on the swimmer by wrapping
 * positions, so the open ocean never runs out.
 */

const TAU = Math.PI * 2

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
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    v += a * noise(p);
    p = p * 2.03 + vec2(19.7, 5.1);
    a *= 0.5;
  }
  return v;
}
`

/** Keep a value within ±range/2 of a centre by teleporting it a whole range. */
function wrapAxis(value: number, centre: number, range: number) {
  const half = range * 0.5
  const d = value - centre
  if (d > half) return value - range
  if (d < -half) return value + range
  return value
}

// —— light shafts ————————————————————————————————————————————

const rayVertex = /* glsl */ `
uniform float uHeight;

varying vec3 vWorld;
/** 0 at the bottom of the curtain, 1 where it meets the surface. */
varying float vRise;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vRise = clamp(position.y / uHeight + 0.5, 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const rayFragment = /* glsl */ `
uniform float uTime;
uniform float uStrength;
uniform float uScale;
uniform vec2 uSunXZ;
uniform vec3 uColor;
uniform vec3 uCentre;

varying vec3 vWorld;
varying float vRise;

${noiseGLSL}

void main() {
  vec2 dir = normalize(vWorld.xz - uCentre.xz + vec2(0.0001));

  // Sampling on the unit circle keeps the shafts seam-free all the way around
  float broad = fbm(dir * uScale + vec2(uTime * 0.02, uTime * -0.015), 4);
  float fine = fbm(dir * uScale * 3.1 + vec2(uTime * 0.05, 3.1), 3);
  float beam = pow(smoothstep(0.34, 0.94, broad), 2.1) * 0.8
             + pow(smoothstep(0.42, 1.0, fine), 3.0) * 0.45;

  // Brightest where they leave the surface, gone by the time they reach the deep
  float fall = pow(vRise, 1.8);

  // Biased toward the sun's side of the sky
  float sunFace = max(dot(dir, normalize(uSunXZ + vec2(0.0001))), 0.0);
  float bias = 0.22 + 0.95 * pow(sunFace, 1.6);

  float alpha = beam * fall * bias * uStrength;
  gl_FragColor = vec4(uColor * (0.65 + beam * 0.7), alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

function createLightShafts(sunDir: THREE.Vector3) {
  const group = new THREE.Group()
  const materials: THREE.ShaderMaterial[] = []

  const build = (radius: number, height: number, scale: number, strength: number) => {
    const geo = new THREE.CylinderGeometry(radius, radius * 1.5, height, 36, 1, true)
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uHeight: { value: height },
        uStrength: { value: strength },
        uScale: { value: scale },
        uSunXZ: { value: new THREE.Vector2(sunDir.x, sunDir.z) },
        uColor: { value: new THREE.Color('#a8e8ea') },
        uCentre: { value: new THREE.Vector3() },
      },
      vertexShader: rayVertex,
      fragmentShader: rayFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      fog: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    // The ocean underside is transparent and doesn't write depth, so the shafts
    // have to be ordered explicitly or they get painted over.
    mesh.renderOrder = 3
    mesh.userData.height = height
    group.add(mesh)
    materials.push(mat)
    return mesh
  }

  // Narrow inner radius so the shafts sweep up across a wide band of the view
  // instead of hugging the horizon
  const inner = build(15, 46, 3.4, 0.5)
  const outer = build(46, 50, 2.2, 0.34)

  function update(time: number, camera: THREE.Camera, surfaceY: number, fade: number) {
    for (const mesh of [inner, outer]) {
      const h = mesh.userData.height as number
      mesh.position.set(camera.position.x, surfaceY - h * 0.5 + 1.5, camera.position.z)
    }
    inner.rotation.y = time * 0.008
    outer.rotation.y = -time * 0.005

    for (let i = 0; i < materials.length; i++) {
      const mat = materials[i]
      mat.uniforms.uTime.value = time
      mat.uniforms.uCentre.value.copy(camera.position)
      mat.uniforms.uStrength.value = (i === 0 ? 0.5 : 0.34) * fade
    }
  }

  return { group, update }
}

// —— suspended particulate & bubbles ————————————————————————

const driftVertex = /* glsl */ `
uniform float uTime;
uniform vec3 uCam;
uniform float uRange;
uniform float uSize;
uniform float uPixelRatio;
uniform float uRise;
uniform float uSway;

attribute float aSeed;

varying float vFade;
varying float vSeed;

void main() {
  vec3 base = position;
  base.y += uTime * uRise;
  base.x += sin(uTime * 0.3 + aSeed * 24.0) * uSway;
  base.z += cos(uTime * 0.26 + aSeed * 17.0) * uSway;

  // Wrap around the swimmer so the field never runs out ("half" is a reserved
  // GLSL keyword, hence the name)
  float halfRange = uRange * 0.5;
  vec3 rel = mod(base - uCam + halfRange, uRange) - halfRange;
  vec3 world = uCam + rel;

  vec4 mv = viewMatrix * vec4(world, 1.0);
  float dist = -mv.z;

  // Fade in past the near plane and out into the murk
  vFade = smoothstep(0.35, 1.4, dist) * (1.0 - smoothstep(uRange * 0.22, uRange * 0.5, dist));
  vSeed = aSeed;

  gl_PointSize = uSize * uPixelRatio * (8.0 / max(dist, 0.35));
  gl_Position = projectionMatrix * mv;
}
`

const driftFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uRing;
uniform float uGlobal;

varying float vFade;
varying float vSeed;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;

  float body = 1.0 - r2 * 4.0;
  float alpha = body * body;
  // Bubbles read as a bright rim with a hollow middle
  alpha = mix(alpha, smoothstep(0.06, 0.22, r2) * (1.0 - smoothstep(0.2, 0.25, r2)) + body * 0.25, uRing);

  gl_FragColor = vec4(uColor * (0.8 + vSeed * 0.4), alpha * vFade * uOpacity * uGlobal);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

type DriftOptions = {
  count: number
  range: number
  size: number
  rise: number
  sway: number
  color: string
  opacity: number
  ring: number
  order: number
  additive?: boolean
}

function createDrift(opts: DriftOptions) {
  const positions = new Float32Array(opts.count * 3)
  const seeds = new Float32Array(opts.count)
  for (let i = 0; i < opts.count; i++) {
    positions[i * 3] = Math.random() * opts.range
    positions[i * 3 + 1] = Math.random() * opts.range
    positions[i * 3 + 2] = Math.random() * opts.range
    seeds[i] = Math.random()
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uRange: { value: opts.range },
      uSize: { value: opts.size },
      uPixelRatio: { value: 1 },
      uRise: { value: opts.rise },
      uSway: { value: opts.sway },
      uColor: { value: new THREE.Color(opts.color) },
      uOpacity: { value: opts.opacity },
      uRing: { value: opts.ring },
      uGlobal: { value: 1 },
    },
    vertexShader: driftVertex,
    fragmentShader: driftFragment,
    transparent: true,
    depthWrite: false,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    fog: false,
  })

  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  points.renderOrder = opts.order

  function update(time: number, camera: THREE.Camera, pixelRatio: number, fade: number) {
    material.uniforms.uTime.value = time
    material.uniforms.uCam.value.copy(camera.position)
    material.uniforms.uPixelRatio.value = pixelRatio
    material.uniforms.uGlobal.value = fade
  }

  return { points, update }
}

// —— fish ————————————————————————————————————————————————

const fishVertex = /* glsl */ `
uniform float uTime;

attribute float aPhase;
attribute float aTint;

varying vec3 vNormalW;
varying float vDist;
varying float vTint;

void main() {
  vec3 p = position;

  // Tail-heavy sinusoid — the body barely moves, the fin sweeps
  float tail = smoothstep(0.3, -0.9, p.z);
  float wig = sin(uTime * (5.0 + aPhase * 3.0) + aPhase * 6.28318 + p.z * 3.0);
  p.x += wig * 0.17 * tail;
  p.y += wig * 0.02 * tail;

  vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vNormalW = normalize(mat3(instanceMatrix) * normal);
  vTint = aTint;

  vec4 mv = viewMatrix * world;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`

const fishFragment = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uWaterColor;
uniform vec3 uBody;
uniform vec3 uBelly;
uniform float uFogDensity;

varying vec3 vNormalW;
varying float vDist;
varying float vTint;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 L = normalize(uSunDir);

  float ndl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);

  // Countershading: dark back, pale belly, silver flanks. Biased so the flanks
  // (where N.y is near zero) land on the darker body tone rather than the belly,
  // otherwise every fish reads as a white flake.
  vec3 col = mix(uBelly, uBody, smoothstep(-0.55, 0.45, clamp(N.y, -1.0, 1.0)));
  col *= 0.55 + 0.8 * ndl;
  col = mix(col, col * vec3(1.2, 1.04, 0.78), vTint);

  // Flank flash as they roll through the light
  float flash = pow(max(dot(N, L), 0.0), 30.0);
  col += vec3(0.92, 0.98, 1.0) * flash * 0.45;

  col = mix(col, uWaterColor, 1.0 - exp(-vDist * uFogDensity));
  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

function fishGeometry() {
  const body = new THREE.SphereGeometry(0.5, 9, 7)
  body.scale(0.34, 0.5, 1.0)
  const tail = new THREE.PlaneGeometry(0.46, 0.42)
  tail.rotateY(Math.PI / 2)
  tail.translate(0, 0, -0.62)
  const dorsal = new THREE.PlaneGeometry(0.34, 0.18)
  dorsal.rotateY(Math.PI / 2)
  dorsal.translate(0, 0.2, 0.03)
  const merged = mergeGeometries([body, tail, dorsal])
  return merged ?? body
}

type Fish = {
  school: number
  ox: number
  oy: number
  oz: number
  wanderAmp: number
  wanderSpeed: number
  wanderPhase: number
  scale: number
  prev: THREE.Vector3
  dir: THREE.Vector3
}

type School = {
  radius: number
  speed: number
  phase: number
  yOffset: number
  centre: THREE.Vector3
}

function createFishSchools(count: number, schoolCount: number, waterColor: THREE.Color) {
  const geometry = fishGeometry()
  const phases = new Float32Array(count)
  const tints = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    phases[i] = Math.random()
    tints[i] = Math.random() < 0.25 ? Math.random() : 0
  }
  geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1))
  geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 1))

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uWaterColor: { value: waterColor.clone() },
      uBody: { value: new THREE.Color('#24485a') },
      uBelly: { value: new THREE.Color('#a6c6d0') },
      uFogDensity: { value: 0.055 },
    },
    vertexShader: fishVertex,
    fragmentShader: fishFragment,
    side: THREE.DoubleSide,
    fog: false,
  })

  const mesh = new THREE.InstancedMesh(geometry, material, count)
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

  const schools: School[] = []
  for (let s = 0; s < schoolCount; s++) {
    schools.push({
      // Kept inside the ~18 m visibility range, otherwise the schools spend most
      // of their orbit lost in the murk and you never meet one
      radius: 7 + Math.random() * 15,
      speed: 0.05 + Math.random() * 0.06,
      phase: Math.random() * TAU,
      yOffset: -3 - Math.random() * 13,
      centre: new THREE.Vector3(),
    })
  }

  const fishes: Fish[] = []
  for (let i = 0; i < count; i++) {
    const school = i % schoolCount
    const spread = 2.5 + Math.random() * 3.5
    fishes.push({
      school,
      ox: (Math.random() - 0.5) * spread * 2,
      oy: (Math.random() - 0.5) * spread,
      oz: (Math.random() - 0.5) * spread * 2.4,
      wanderAmp: 0.35 + Math.random() * 0.9,
      wanderSpeed: 0.7 + Math.random() * 1.1,
      wanderPhase: Math.random() * TAU,
      scale: 0.2 + Math.random() * 0.22,
      prev: new THREE.Vector3(),
      dir: new THREE.Vector3(0, 0, 1),
    })
  }

  const anchor = new THREE.Vector3()
  let seeded = false
  const dummy = new THREE.Object3D()
  const pos = new THREE.Vector3()

  function update(dt: number, time: number, camera: THREE.Camera, surfaceY: number) {
    // Anchor trails the swimmer so schools stay nearby without snapping to them
    if (!seeded) {
      anchor.copy(camera.position)
      seeded = true
    }
    anchor.x += (camera.position.x - anchor.x) * Math.min(1, dt * 0.25)
    anchor.z += (camera.position.z - anchor.z) * Math.min(1, dt * 0.25)

    for (const s of schools) {
      const a = time * s.speed + s.phase
      s.centre.set(
        anchor.x + Math.cos(a) * s.radius,
        surfaceY + s.yOffset + Math.sin(a * 1.7) * 2.5,
        anchor.z + Math.sin(a * 1.15) * s.radius,
      )
    }

    material.uniforms.uTime.value = time

    for (let i = 0; i < fishes.length; i++) {
      const f = fishes[i]
      const c = schools[f.school].centre
      const w = time * f.wanderSpeed + f.wanderPhase

      pos.set(
        c.x + f.ox + Math.sin(w) * f.wanderAmp,
        c.y + f.oy + Math.sin(w * 0.7 + 1.3) * f.wanderAmp * 0.6,
        c.z + f.oz + Math.cos(w * 0.9) * f.wanderAmp,
      )

      // Scatter out of the swimmer's way
      const dx = pos.x - camera.position.x
      const dy = pos.y - camera.position.y
      const dz = pos.z - camera.position.z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 < 20 && d2 > 0.01) {
        const d = Math.sqrt(d2)
        const push = (1 - d / 4.5) * 3.2
        pos.x += (dx / d) * push
        pos.y += (dy / d) * push
        pos.z += (dz / d) * push
      }

      if (f.prev.lengthSq() > 0) {
        f.dir.subVectors(pos, f.prev)
        if (f.dir.lengthSq() > 1e-6) f.dir.normalize()
      }
      f.prev.copy(pos)

      dummy.position.copy(pos)
      dummy.lookAt(pos.x + f.dir.x, pos.y + f.dir.y, pos.z + f.dir.z)
      dummy.scale.setScalar(f.scale)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }

    mesh.instanceMatrix.needsUpdate = true
  }

  return { mesh, material, update }
}

// —— jellyfish ————————————————————————————————————————————

const jellyVertex = /* glsl */ `
uniform float uTime;

attribute float aPhase;

varying float vRim;
varying float vDist;
varying float vDrop;

void main() {
  vec3 p = position;
  float pulse = sin(uTime * 1.15 + aPhase * 6.28318);
  float rim = smoothstep(0.0, 0.48, length(p.xz));

  // Bell contracts outward-in and lifts as it squeezes
  p.xz *= 1.0 + pulse * 0.15 * rim;
  p.y -= pulse * 0.1 * rim;

  // Trailing skirt ripples further down
  float drop = clamp(-p.y, 0.0, 2.0);
  p.x += sin(uTime * 1.6 + aPhase * 5.0 + drop * 2.4) * 0.05 * drop;
  p.z += cos(uTime * 1.4 + aPhase * 4.0 + drop * 2.1) * 0.05 * drop;

  vRim = rim;
  vDrop = drop;

  vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vec4 mv = viewMatrix * world;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`

const jellyFragment = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uWaterColor;
uniform float uFogDensity;
uniform float uOpacity;

varying float vRim;
varying float vDist;
varying float vDrop;

void main() {
  float alpha = (0.32 + vRim * 0.5) * uOpacity;
  alpha *= 1.0 - smoothstep(0.1, 1.6, vDrop) * 0.85;

  vec3 col = uColor * (0.8 + vRim * 0.6);
  float fog = 1.0 - exp(-vDist * uFogDensity);
  col = mix(col, uWaterColor, fog);
  alpha *= 1.0 - fog * 0.85;

  gl_FragColor = vec4(col, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

type Jelly = { x: number; y: number; z: number; rise: number; spin: number; scale: number }

function createJellyfish(count: number, waterColor: THREE.Color) {
  const bell = new THREE.SphereGeometry(0.5, 16, 9, 0, TAU, 0, Math.PI * 0.56)
  const skirt = new THREE.CylinderGeometry(0.44, 0.05, 1.5, 16, 5, true)
  skirt.translate(0, -0.75, 0)
  const geometry = mergeGeometries([bell, skirt]) ?? bell

  const phases = new Float32Array(count)
  for (let i = 0; i < count; i++) phases[i] = Math.random()
  geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1))

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color('#bfe9ff') },
      uWaterColor: { value: waterColor.clone() },
      uFogDensity: { value: 0.045 },
      uOpacity: { value: 1 },
    },
    vertexShader: jellyVertex,
    fragmentShader: jellyFragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  })

  const mesh = new THREE.InstancedMesh(geometry, material, count)
  mesh.frustumCulled = false
  mesh.renderOrder = 2
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

  const RANGE = 52
  const jellies: Jelly[] = []
  for (let i = 0; i < count; i++) {
    jellies.push({
      x: (Math.random() - 0.5) * RANGE,
      y: -3 - Math.random() * 20,
      z: (Math.random() - 0.5) * RANGE,
      rise: 0.12 + Math.random() * 0.22,
      spin: (Math.random() - 0.5) * 0.15,
      scale: 0.6 + Math.random() * 1.5,
    })
  }

  const dummy = new THREE.Object3D()
  let seeded = false

  function update(dt: number, time: number, camera: THREE.Camera, surfaceY: number, fade: number) {
    if (!seeded) {
      for (const j of jellies) {
        j.x += camera.position.x
        j.z += camera.position.z
      }
      seeded = true
    }

    material.uniforms.uTime.value = time
    material.uniforms.uOpacity.value = fade

    for (let i = 0; i < jellies.length; i++) {
      const j = jellies[i]
      j.y += j.rise * dt
      if (j.y > surfaceY - 2.5) j.y = surfaceY - 26
      j.x = wrapAxis(j.x + Math.sin(time * 0.1 + i) * 0.12 * dt, camera.position.x, RANGE)
      j.z = wrapAxis(j.z + Math.cos(time * 0.09 + i) * 0.12 * dt, camera.position.z, RANGE)

      dummy.position.set(j.x, j.y, j.z)
      dummy.rotation.set(Math.sin(time * 0.2 + i) * 0.12, time * j.spin, Math.cos(time * 0.17 + i) * 0.12)
      dummy.scale.setScalar(j.scale)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  return { mesh, update }
}

// —— assembly ————————————————————————————————————————————

export type UnderwaterOptions = {
  waterColor: THREE.Color
  sunDir: THREE.Vector3
  lowPower?: boolean
}

export function createUnderwaterWorld(scene: THREE.Scene, opts: UnderwaterOptions) {
  const low = opts.lowPower ?? false

  const group = new THREE.Group()
  group.name = 'Underwater'
  group.visible = false
  scene.add(group)

  const shafts = createLightShafts(opts.sunDir)
  group.add(shafts.group)

  const snow = createDrift({
    count: low ? 700 : 1600,
    range: 44,
    size: 1.6,
    rise: -0.16,
    sway: 0.7,
    color: '#dff5f7',
    opacity: 0.7,
    ring: 0,
    order: 4,
  })
  group.add(snow.points)

  const plume = createDrift({
    count: low ? 120 : 260,
    range: 34,
    size: 4.5,
    rise: 1.3,
    sway: 0.5,
    color: '#e6fbff',
    opacity: 0.6,
    ring: 1,
    order: 5,
    additive: true,
  })
  group.add(plume.points)

  const fish = createFishSchools(low ? 120 : 280, low ? 4 : 7, opts.waterColor)
  fish.material.uniforms.uSunDir.value.copy(opts.sunDir)
  group.add(fish.mesh)

  const jellies = createJellyfish(low ? 7 : 14, opts.waterColor)
  group.add(jellies.mesh)

  let fade = 0

  function update(ctx: {
    dt: number
    time: number
    camera: THREE.PerspectiveCamera
    surfaceY: number
    submersion: number
    underwater: boolean
    pixelRatio: number
  }) {
    // Ease the whole layer in so surfacing doesn't pop
    const target = ctx.underwater ? 1 : 0
    fade += (target - fade) * Math.min(1, ctx.dt * 6)
    group.visible = fade > 0.01
    if (!group.visible) return

    shafts.update(ctx.time, ctx.camera, ctx.surfaceY, fade)
    snow.update(ctx.time, ctx.camera, ctx.pixelRatio, fade)
    plume.update(ctx.time, ctx.camera, ctx.pixelRatio, fade * 0.85)
    fish.update(ctx.dt, ctx.time, ctx.camera, ctx.surfaceY)
    jellies.update(ctx.dt, ctx.time, ctx.camera, ctx.surfaceY, fade)
  }

  return { group, update }
}
