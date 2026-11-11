import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Hud } from './hud'
import { sampleOcean } from './waves'

/**
 * Pelagic & barrier-reef megafauna — the showpiece encounters across the crossing,
 * the deep drop-off, and the turquoise lagoon around the stranded coaster:
 *
 *  - A 13.5 m humpback whale and her calf cruising the deep blue channel,
 *    escorted by striped pilot fish, rising periodically to send a tall sunlit
 *    mist spout into the trade wind before lifting her flukes to sound.
 *  - A diamond squadron ("fever") of spotted eagle rays gliding over the white
 *    lagoon sand between the landing cove and the reef wreck.
 *  - Peaceful blacktip reef sharks patrolling the reef wreck and the Wanderer's
 *    coral drop-off with true lateral S-wave swimming.
 *  - Tight bursts of silver-blue flying fish erupting from wave crests, skimming
 *    live Gerstner swells, tail-tapping a crest mid-glide, and slicing back in.
 */

const TAU = Math.PI * 2
const UP = new THREE.Vector3(0, 1, 0)

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
const angleDelta = (a: number, b: number) => ((b - a + Math.PI * 3) % TAU) - Math.PI

function paint(
  geo: THREE.BufferGeometry,
  pick: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => THREE.Color,
) {
  const pos = geo.attributes.position
  const nor = geo.attributes.normal
  const out = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const c = pick(pos.getX(i), pos.getY(i), pos.getZ(i), nor.getX(i), nor.getY(i), nor.getZ(i))
    out[i * 3] = c.r
    out[i * 3 + 1] = c.g
    out[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3))
}

function stripToBasicAttrs(geo: THREE.BufferGeometry) {
  if (!geo.attributes.normal) geo.computeVertexNormals()
  const g = geo.index ? geo.toNonIndexed() : geo.clone()
  for (const key of Object.keys(g.attributes)) {
    if (key !== 'position' && key !== 'normal') g.deleteAttribute(key)
  }
  return g
}

function sampleStation(stations: [number, number, number, number][], u: number) {
  if (u <= stations[0][0]) return stations[0]
  const last = stations[stations.length - 1]
  if (u >= last[0]) return last
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i]
    const b = stations[i + 1]
    if (u <= b[0]) {
      const t = (u - a[0]) / Math.max(1e-6, b[0] - a[0])
      const s = 0.5 - 0.5 * Math.cos(t * Math.PI)
      return [
        u,
        a[1] + (b[1] - a[1]) * s,
        a[2] + (b[2] - a[2]) * s,
        a[3] + (b[3] - a[3]) * s,
      ] as [number, number, number, number]
    }
  }
  return last
}

// —— 1. Humpback whale & calf ———————————————————————————————————————

const WHALE_LENGTH = 13.5

function buildHumpbackBody() {
  const L = WHALE_LENGTH
  // Stations: [u (0 snout -> 1 fluke base), topY, botY, halfW]
  // Broad U-shaped baleen rostrum widening rapidly right behind the snout tip
  const stations: [number, number, number, number][] = [
    [0.0, -0.04, -0.04, 0.0],
    [0.014, 0.12, -0.18, 0.54],
    [0.05, 0.24, -0.42, 0.88],
    [0.12, 0.44, -0.78, 1.08],
    [0.22, 0.78, -1.12, 1.2],
    [0.32, 0.98, -1.24, 1.26],
    [0.44, 0.96, -1.08, 1.14],
    [0.56, 0.86, -0.86, 0.94],
    [0.65, 0.84, -0.66, 0.72], // stepped dorsal hump
    [0.72, 0.62, -0.52, 0.52],
    [0.82, 0.44, -0.38, 0.3],
    [0.92, 0.3, -0.26, 0.16],
    [1.0, 0.14, -0.14, 0.11],
  ]

  const rings = 60
  const radial = 22
  const positions: number[] = []
  const indices: number[] = []

  for (let i = 0; i < rings; i++) {
    const tRing = i / (rings - 1)
    const u = Math.pow(tRing, 1.2)
    const x = L * (0.5 - u)
    const [, ty, by, rawW] = sampleStation(stations, u)
    const hw = i === 0 ? 0 : Math.max(0.02, rawW)
    const midY = (ty + by) * 0.5
    const halfH = i === 0 ? 0 : Math.max(0.02, (ty - by) * 0.5)

    // Rostrum tubercles on the upper snout
    const snoutBand = smooth(0.02, 0.05, u) * (1 - smooth(0.15, 0.2, u))
    // Ventral throat pleats under the jaw and chest
    const pleatBand = smooth(0.05, 0.1, u) * (1 - smooth(0.36, 0.46, u))

    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * TAU
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      // Flatten the upper rostrum into a broad baleen jaw
      const jawFlat = u < 0.22 && ca > 0 ? 1 - (1 - u / 0.22) * 0.32 * ca : 1
      let y = midY + ca * halfH * jawFlat
      let z = sa * hw

      if (ca < -0.15 && pleatBand > 0) {
        const groove = Math.cos(sa * 26) * 0.032 * pleatBand * smooth(-0.15, -0.6, ca)
        y += groove
        z *= 1 + groove * 0.35
      }
      if (ca > 0.55 && snoutBand > 0) {
        const knob = Math.max(0, Math.sin(u * 130) * Math.cos(sa * 9)) * 0.045 * snoutBand
        y += knob
      }
      positions.push(x, y, z)
    }
  }

  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j
      const b = i * radial + ((j + 1) % radial)
      const c = (i + 1) * radial + j
      const d = (i + 1) * radial + ((j + 1) % radial)
      indices.push(a, c, b, b, c, d)
    }
  }

  const body = new THREE.BufferGeometry()
  body.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  body.setIndex(indices)
  body.computeVertexNormals()

  // Characteristic low, stubby hooked dorsal fin sitting atop the u=0.66 hump
  const dorsalShape = new THREE.Shape()
  dorsalShape.moveTo(0.45, 0)
  dorsalShape.quadraticCurveTo(0.1, 0.26, -0.24, 0.42)
  dorsalShape.quadraticCurveTo(-0.46, 0.44, -0.58, 0.28)
  dorsalShape.quadraticCurveTo(-0.42, 0.14, -0.62, 0)
  dorsalShape.closePath()
  const dorsal = new THREE.ExtrudeGeometry(dorsalShape, { depth: 0.11, bevelEnabled: false, curveSegments: 7 })
  dorsal.translate(L * (0.5 - 0.66), 0.72, -0.055)

  // Broad butterfly flukes (~3.9 m span) with central notch and scalloped trailing edge
  const flukeShape = new THREE.Shape()
  const halfSpan = 1.96
  flukeShape.moveTo(0.38, 0.0)
  flukeShape.bezierCurveTo(0.32, 0.52, -0.08, 1.32, -0.52, halfSpan)
  flukeShape.quadraticCurveTo(-0.74, halfSpan * 0.98, -0.82, halfSpan * 0.84)
  // Scalloped trailing margin back to the central fluke notch
  flukeShape.quadraticCurveTo(-0.66, 1.24, -0.74, 0.88)
  flukeShape.quadraticCurveTo(-0.6, 0.52, -0.68, 0.22)
  flukeShape.lineTo(-0.46, 0.0)
  flukeShape.lineTo(-0.68, -0.22)
  flukeShape.quadraticCurveTo(-0.6, -0.52, -0.74, -0.88)
  flukeShape.quadraticCurveTo(-0.66, -1.24, -0.82, -halfSpan * 0.84)
  flukeShape.quadraticCurveTo(-0.74, -halfSpan * 0.98, -0.52, -halfSpan)
  flukeShape.bezierCurveTo(-0.08, -1.32, 0.32, -0.52, 0.38, 0.0)

  const flukes = new THREE.ExtrudeGeometry(flukeShape, { depth: 0.09, bevelEnabled: false, curveSegments: 10 })
  flukes.translate(0, 0, -0.045)
  flukes.rotateX(Math.PI / 2)
  flukes.translate(-L * 0.5 + 0.25, 0.02, 0)

  // Preserve smooth per-vertex normals from indexed `body` (do not overwrite with flat normals)
  const merged = mergeGeometries([body, dorsal, flukes].map(stripToBasicAttrs), false) as THREE.BufferGeometry

  const slate = new THREE.Color('#1d2b38')
  const indigo = new THREE.Color('#2a3d4e')
  const belly = new THREE.Color('#dde7ec')
  const grooveDark = new THREE.Color('#4a5d6c')
  const barnacle = new THREE.Color('#c7c2b4')
  const tmp = new THREE.Color()

  paint(merged, (x, y, z, _nx, ny) => {
    const u = clamp(0.5 - x / L, 0, 1.1)
    const isFluke = x < -L * 0.5 + 0.55 && Math.abs(z) > 0.24
    if (isFluke) {
      // Classic humpback white ventral fluke patches, dark slate above
      if (ny < -0.08) {
        const edgeDark = smooth(1.55, 1.95, Math.abs(z)) * 0.55
        return tmp.copy(belly).lerp(slate, edgeDark)
      }
      return tmp.copy(slate).lerp(belly, smooth(1.4, 1.9, Math.abs(z)) * 0.18)
    }

    const mottling = Math.sin(x * 3.7 + z * 5.3) * Math.cos(x * 7.1 - y * 6.2)
    // Countershading: smooth dark slate back & flanks, bright white throat pleats & belly underneath
    const ventral =
      smooth(-0.08, -0.52, ny) * smooth(-0.14, -0.48, y) * (1 - smooth(0.72, 0.92, u) * 0.55)
    tmp.copy(slate).lerp(indigo, smooth(0.8, 0.0, ny) * 0.35)
    tmp.lerp(belly, ventral * (0.86 + mottling * 0.14))

    // Throat pleat shadow lines
    if (u > 0.04 && u < 0.44 && ny < -0.2 && y < -0.15) {
      const pleatLine = Math.pow(Math.max(0, Math.sin(z * 22)), 4)
      tmp.lerp(grooveDark, pleatLine * 0.42)
    }
    // Chin & rostrum barnacle cluster
    if (u < 0.08 && y < 0.06) {
      const b = smooth(0.45, 0.88, Math.sin(x * 19 + z * 23) * 0.5 + 0.5)
      tmp.lerp(barnacle, b * 0.38)
    }
    return tmp
  })

  return merged
}

/** Iconic 4.1 m scalloped white humpback pectoral wing, hinged at its shoulder root. */
function buildHumpbackPectoral(side: number) {
  const shape = new THREE.Shape()
  // Local shape in XY before orienting out along +Z: +X is leading edge, -X is trailing
  shape.moveTo(0.36, 0)
  // Scalloped bumpy leading edge (tubercles)
  const bumps: [number, number][] = [
    [0.42, 0.65],
    [0.34, 1.25],
    [0.38, 1.85],
    [0.26, 2.48],
    [0.28, 3.08],
    [0.12, 3.68],
    [-0.14, 4.12],
  ]
  let prev: [number, number] = [0.36, 0]
  for (const [bx, by] of bumps) {
    shape.quadraticCurveTo((prev[0] + bx) * 0.5 + 0.07, (prev[1] + by) * 0.5, bx, by)
    prev = [bx, by]
  }
  // Swept trailing edge back to armpit
  shape.quadraticCurveTo(-0.46, 3.4, -0.44, 2.2)
  shape.quadraticCurveTo(-0.48, 1.1, -0.34, 0)
  shape.closePath()

  const geo = stripToBasicAttrs(
    new THREE.ExtrudeGeometry(shape, { depth: 0.11, bevelEnabled: false, curveSegments: 7 }),
  )
  geo.translate(0, 0, -0.055)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const spanU = clamp(pos.getY(i) / 4.15, 0, 1)
    const taper = 1 - spanU * 0.72
    // Note: rotateX(+PI/2) maps -Z -> +Y (upward camber) and +Y -> +Z (outward span)
    pos.setZ(i, pos.getZ(i) * taper - Math.sin(spanU * Math.PI) * 0.14)
  }
  geo.rotateX(Math.PI / 2)
  geo.rotateY(-0.26)

  // Exact mirror reflection across Z=0 for the opposite wing, preserving CCW winding
  if (side < 0) {
    const arr = pos.array as Float32Array
    for (let i = 0; i < pos.count; i++) arr[i * 3 + 2] = -arr[i * 3 + 2]
    for (let t = 0; t < pos.count; t += 3) {
      const i1 = (t + 1) * 3
      const i2 = (t + 2) * 3
      for (let k = 0; k < 3; k++) {
        const swap = arr[i1 + k]
        arr[i1 + k] = arr[i2 + k]
        arr[i2 + k] = swap
      }
    }
  }
  geo.computeVertexNormals()

  const white = new THREE.Color('#e3edf2')
  const slate = new THREE.Color('#253544')
  const tmp = new THREE.Color()
  paint(geo, (x, _y, z, _nx, ny) => {
    const span = Math.abs(z) / 4.15
    // Classic scalloped mostly-white humpback pectoral wings with dark shoulder root
    const topDark = ny > 0.1 ? (1 - smooth(0.16, 0.48, span)) * 0.65 : 0
    const mottle = Math.sin(x * 9 + Math.abs(z) * 5) * 0.08
    return tmp.copy(white).lerp(slate, clamp(topDark + mottle, 0, 0.8))
  })
  return geo
}

// —— Whale blow spout + surface rings ———————————————————————————————

const blowVertex = /* glsl */ `
attribute float aAlpha;
attribute float aSize;
varying float vAlpha;
uniform float uPixelRatio;
void main() {
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // ~world-scaled: aSize is roughly the puff diameter in metres
  gl_PointSize = clamp(aSize * uPixelRatio * (520.0 / max(-mv.z, 1.5)), 1.0, 96.0);
}
`

const blowFragment = /* glsl */ `
varying float vAlpha;
uniform vec3 uMistTint;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;
  float soft = pow(1.0 - r2 * 4.0, 1.8);
  gl_FragColor = vec4(uMistTint, soft * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

function createBlowPlume(scene: THREE.Scene, pixelRatio: number, lowPower: boolean) {
  const MAX = lowPower ? 70 : 130
  const pos = new Float32Array(MAX * 3)
  const vel = new Float32Array(MAX * 3)
  const alpha = new Float32Array(MAX)
  const size = new Float32Array(MAX)
  const age = new Float32Array(MAX).fill(99)
  const maxAge = new Float32Array(MAX).fill(1)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1))
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1))

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: pixelRatio },
      uMistTint: { value: new THREE.Color('#eef6fa') },
    },
    vertexShader: blowVertex,
    fragmentShader: blowFragment,
    transparent: true,
    depthWrite: false,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = 5
  scene.add(points)

  // Surface ripple rings for whale blows, fluke dives, and flying-fish tail taps
  const RING_MAX = 14
  const rings = Array.from({ length: RING_MAX }, () => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.78, 1.0, 28),
      new THREE.MeshBasicMaterial({
        color: '#e8f5fa',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: true,
      }),
    )
    m.rotation.x = -Math.PI / 2
    m.visible = false
    scene.add(m)
    return { mesh: m, age: 99, life: 2.5, baseScale: 1 }
  })
  let cursor = 0
  let ringCursor = 0

  function emitMist(x: number, y: number, z: number, scale = 1, count = 7) {
    for (let k = 0; k < count; k++) {
      const i = cursor
      cursor = (cursor + 1) % MAX
      const a = Math.random() * TAU
      const spread = rand(0.05, 0.36) * scale
      pos[i * 3] = x + Math.cos(a) * spread * 0.16
      pos[i * 3 + 1] = y + rand(0, 0.25)
      pos[i * 3 + 2] = z + Math.sin(a) * spread * 0.16
      // Tall V-shaped columnar humpback blow drifting gently on the trade wind
      vel[i * 3] = Math.cos(a) * spread * 1.15 + 0.38
      vel[i * 3 + 1] = rand(6.8, 11.4) * scale
      vel[i * 3 + 2] = Math.sin(a) * spread * 1.15 + 0.24
      age[i] = 0
      maxAge[i] = rand(2.3, 3.8)
      size[i] = rand(0.55, 1.05) * scale
      alpha[i] = 0.42
    }
  }

  function spawnRing(x: number, y: number, z: number, baseScale: number, life = 2.6) {
    const r = rings[ringCursor]
    ringCursor = (ringCursor + 1) % RING_MAX
    r.age = 0
    r.life = life
    r.baseScale = baseScale
    r.mesh.position.set(x, y + 0.04, z)
    r.mesh.visible = true
  }

  function update(dt: number, t: number, daylight: number, underwater: boolean) {
    points.visible = !underwater
    const brightness = 0.22 + daylight * 0.76
    ;(mat.uniforms.uMistTint.value as THREE.Color).setRGB(
      0.91 * brightness,
      0.96 * brightness,
      1.0 * brightness,
    )

    let activeAny = false
    for (let i = 0; i < MAX; i++) {
      if (age[i] >= maxAge[i]) {
        alpha[i] = 0
        continue
      }
      activeAny = true
      age[i] += dt
      const u = age[i] / maxAge[i]
      // Air drag slows the upward jet into a hanging cloud of fine mist
      const drag = Math.exp(-3.1 * dt)
      vel[i * 3] = vel[i * 3] * drag + 0.42 * dt
      vel[i * 3 + 1] = vel[i * 3 + 1] * Math.exp(-2.4 * dt) + 0.25 * dt
      vel[i * 3 + 2] = vel[i * 3 + 2] * drag + 0.28 * dt
      pos[i * 3] += vel[i * 3] * dt
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt
      size[i] += dt * 0.95
      alpha[i] = smooth(0, 0.08, u) * (1 - smooth(0.32, 1.0, u)) * 0.5
    }
    if (activeAny) {
      geo.attributes.position.needsUpdate = true
      geo.attributes.aAlpha.needsUpdate = true
      geo.attributes.aSize.needsUpdate = true
    }

    for (const r of rings) {
      if (!r.mesh.visible) continue
      r.age += dt
      const u = r.age / r.life
      if (u >= 1) {
        r.mesh.visible = false
        continue
      }
      const sc = r.baseScale * (0.45 + u * 2.8)
      r.mesh.scale.set(sc, sc, sc)
      r.mesh.position.y = sampleOcean(r.mesh.position.x, r.mesh.position.z, t).y + 0.04
      ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - u) * (1 - u) * 0.48
    }
  }

  return { emitMist, spawnRing, update }
}

// —— Escort pilot fish ——————————————————————————————————————————————

function createPilotFish(count: number) {
  const body = stripToBasicAttrs(new THREE.SphereGeometry(1, 10, 7))
  body.scale(0.22, 0.065, 0.045)
  const tail = new THREE.BufferGeometry()
  tail.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [-0.18, 0, 0, -0.32, 0.09, 0, -0.27, 0, 0, -0.18, 0, 0, -0.27, 0, 0, -0.32, -0.09, 0],
      3,
    ),
  )
  tail.computeVertexNormals()
  const geo = mergeGeometries([body, tail], false) as THREE.BufferGeometry

  const silver = new THREE.Color('#b8d2df')
  const band = new THREE.Color('#162638')
  const tmp = new THREE.Color()
  paint(geo, (x, y) => {
    // Classic Naucrates ductor vertical dark cobalt bands
    const stripe = smooth(0.25, 0.75, Math.sin(x * 46) * 0.5 + 0.5)
    return tmp.copy(silver).lerp(band, stripe * 0.82 + smooth(-0.02, 0.05, y) * 0.2)
  })

  const phases = new Float32Array(count)
  for (let i = 0; i < count; i++) phases[i] = Math.random() * TAU
  geo.setAttribute('aPilotPhase', new THREE.InstancedBufferAttribute(phases, 1))

  const clock = { value: 0 }
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.35,
    metalness: 0.2,
    side: THREE.DoubleSide,
  })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPilotTime = clock
    shader.vertexShader =
      'uniform float uPilotTime;\nattribute float aPilotPhase;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        float w = smoothstep(0.02, 0.3, -position.x);
        transformed.z += sin(uPilotTime * 11.0 + aPilotPhase + position.x * 14.0) * 0.045 * w;
        `,
      )
  }
  mat.customProgramCacheKey = () => 'pilot-fish'

  const mesh = new THREE.InstancedMesh(geo, mat, count)
  mesh.frustumCulled = false
  mesh.userData.noCast = true
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

  // Slots tucked under the whale's chin and wide white pectorals
  const slots = Array.from({ length: count }, (_, i) => ({
    fwd: 2.2 - (i % 4) * 1.15 + rand(-0.3, 0.3),
    right: (i % 2 === 0 ? 1 : -1) * (1.2 + Math.floor(i / 2) * 0.55),
    down: -0.95 - (i % 3) * 0.24,
    phase: phases[i],
    scale: 0.85 + (i % 3) * 0.14,
  }))

  return { mesh, clock, slots }
}

// —— 2. Spotted eagle rays (Aetobatus narinari) —————————————————————

function buildEagleRay() {
  const span = 1.72
  const nU = 24
  const nV = 10

  const sheet = (sign: number) => {
    const pos: number[] = []
    const idx: number[] = []
    for (let i = 0; i <= nU; i++) {
      const u = (i / nU) * 2 - 1
      const au = Math.abs(u)
      // Projecting duck-bill snout at u=0, falcate swept wings out to the tips
      const snout = Math.exp(-au * au * 26) * 0.34
      const lead = 0.48 * (1 - Math.pow(au, 1.35)) + snout - 0.12 * au
      const trail = -0.44 * (1 - Math.pow(au, 0.85)) - 0.1 * au
      for (let j = 0; j <= nV; j++) {
        const v = j / nV
        const x = THREE.MathUtils.lerp(trail, lead, v)
        const headDome = sign > 0 ? Math.exp(-au * au * 16) * smooth(0.45, 0.85, v) * 0.09 : 0
        const thick =
          0.13 * Math.pow(1 - au, 1.45) * Math.pow(Math.sin(Math.PI * (0.1 + v * 0.82)), 0.75) +
          headDome
        pos.push(x, sign * thick, u * span)
      }
    }
    for (let i = 0; i < nU; i++) {
      for (let j = 0; j < nV; j++) {
        const a = i * (nV + 1) + j
        const b = a + 1
        const c = a + (nV + 1)
        const d = c + 1
        if (sign > 0) idx.push(a, c, b, b, c, d)
        else idx.push(a, b, c, b, d, c)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(idx)
    g.computeVertexNormals()
    return stripToBasicAttrs(g)
  }

  // Long whip tail characteristic of spotted eagle rays
  const tailGeo = new THREE.ConeGeometry(0.026, 2.05, 6, 1)
  tailGeo.rotateZ(Math.PI / 2)
  tailGeo.translate(-0.44 - 1.0, 0, 0)
  tailGeo.computeVertexNormals()
  const tail = stripToBasicAttrs(tailGeo)

  const merged = mergeGeometries([sheet(1), sheet(-1), tail], false) as THREE.BufferGeometry

  const dorsal = new THREE.Color('#172438')
  const margin = new THREE.Color('#253a54')
  const belly = new THREE.Color('#edf2f5')
  const tmp = new THREE.Color()
  paint(merged, (x, _y, z, _nx, ny) => {
    if (ny < -0.06) return tmp.copy(belly)
    const wing = Math.abs(z) / span
    return tmp.copy(dorsal).lerp(margin, smooth(0.75, 1.0, wing) * 0.45 + smooth(0.45, 0.8, x) * 0.2)
  })
  return merged
}

/** Crisp procedural white ocelli (rings & spots) on the dorsal disc, compatible with caustics.apply. */
function createEagleRayMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.34,
    metalness: 0.02,
    side: THREE.DoubleSide,
  })
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'varying vec3 vRayLocal;\nvarying vec3 vRayNormal;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        vRayLocal = position;
        vRayNormal = normal;
        `,
      )
    shader.fragmentShader =
      'varying vec3 vRayLocal;\nvarying vec3 vRayNormal;\n' +
      shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        if (vRayNormal.y > 0.12 && vRayLocal.x > -0.46 && vRayLocal.x < 0.42) {
          vec2 uv = vec2(vRayLocal.x * 11.5, vRayLocal.z * 10.5);
          vec2 cell = floor(uv);
          vec2 f = fract(uv) - 0.5;
          vec2 h = fract(sin(vec2(
            dot(cell, vec2(17.3, 31.7)),
            dot(cell, vec2(29.1, 13.9))
          )) * 758.5453);
          float keep = step(0.16, fract(h.x + h.y));
          float d = length(f - (h - 0.5) * 0.34);
          // Ring-shaped white ocelli across the dark indigo disc, smaller dots toward wingtips
          float wingSpan = abs(vRayLocal.z) / 1.72;
          float mask = keep * (1.0 - smoothstep(0.78, 0.96, wingSpan)) * (1.0 - smoothstep(0.24, 0.42, vRayLocal.x));
          float ring = smoothstep(0.29, 0.21, d) * (1.0 - smoothstep(0.14, 0.07, d) * 0.72);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.96, 0.99), ring * mask * 0.92);
        }
        `,
      )
  }
  mat.customProgramCacheKey = () => 'eagle-ray-spots'
  return mat
}

// —— 3. Blacktip reef sharks (Carcharhinus melanopterus) ————————————

const SHARK_LENGTH = 1.92

function buildBlacktipShark() {
  const L = SHARK_LENGTH
  const profile = new THREE.SplineCurve(
    [
      [0.0, 0.0],
      [0.03, 0.048],
      [0.09, 0.095],
      [0.18, 0.142],
      [0.3, 0.178],
      [0.44, 0.175],
      [0.58, 0.142],
      [0.72, 0.098],
      [0.85, 0.058],
      [0.95, 0.036],
      [1.0, 0.028],
    ].map(([u, r]) => new THREE.Vector2(u, r)),
  ).getPoints(38)

  const rings = profile.length
  const radial = 14
  const positions: number[] = []
  const indices: number[] = []

  for (let i = 0; i < rings; i++) {
    const { x: u, y: r } = profile[i]
    const x = L * (0.5 - u)
    // Reef sharks have a broad, slightly dorsoventrally flattened snout and oval trunk
    const flatY = u < 0.22 ? 0.68 + (u / 0.22) * 0.24 : 0.92
    const wideZ = u < 0.22 ? 1.18 - (u / 0.22) * 0.22 : u > 0.78 ? 0.74 : 0.96
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * TAU
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      const bellyFlat = ca < 0 ? 0.82 : 1.0
      positions.push(x, ca * r * flatY * bellyFlat, sa * r * wideZ)
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j
      const b = i * radial + ((j + 1) % radial)
      const c = (i + 1) * radial + j
      const d = (i + 1) * radial + ((j + 1) % radial)
      indices.push(a, c, b, b, c, d)
    }
  }
  const body = new THREE.BufferGeometry()
  body.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  body.setIndex(indices)
  body.computeVertexNormals()

  const extrudeFin = (pts: [number, number][], depth: number) => {
    const s = new THREE.Shape()
    s.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1])
    s.closePath()
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 5 })
    g.translate(0, 0, -depth * 0.5)
    return g
  }

  // Tall sickle first dorsal fin (carries the signature black tip + white band)
  const d1 = new THREE.Shape()
  d1.moveTo(0.15, 0)
  d1.quadraticCurveTo(0.02, 0.2, -0.11, 0.33)
  d1.quadraticCurveTo(-0.15, 0.34, -0.14, 0.26)
  d1.quadraticCurveTo(-0.08, 0.11, -0.19, 0)
  d1.closePath()
  const dorsal1 = new THREE.ExtrudeGeometry(d1, { depth: 0.02, bevelEnabled: false, curveSegments: 6 })
  dorsal1.translate(L * (0.5 - 0.42), 0.14, -0.01)

  // Smaller second dorsal fin aft
  const dorsal2 = extrudeFin(
    [
      [0.06, 0],
      [-0.04, 0.11],
      [-0.09, 0.09],
      [-0.08, 0],
    ],
    0.015,
  )
  dorsal2.translate(L * (0.5 - 0.74), 0.075, 0)

  // Swept pectoral fins angled downward for stable reef cruising
  const pecShape = new THREE.Shape()
  pecShape.moveTo(0.11, 0)
  pecShape.quadraticCurveTo(-0.02, -0.18, -0.19, -0.34)
  pecShape.quadraticCurveTo(-0.24, -0.33, -0.21, -0.24)
  pecShape.quadraticCurveTo(-0.14, -0.08, -0.14, 0)
  pecShape.closePath()
  const pecL = new THREE.ExtrudeGeometry(pecShape, { depth: 0.018, bevelEnabled: false, curveSegments: 6 })
  pecL.rotateX(-1.18)
  pecL.translate(L * (0.5 - 0.3), -0.08, 0.13)
  const pecR = new THREE.ExtrudeGeometry(pecShape, { depth: 0.018, bevelEnabled: false, curveSegments: 6 })
  pecR.rotateX(1.18)
  pecR.translate(L * (0.5 - 0.3), -0.08, -0.13)

  // Asymmetric heterocercal shark tail (long swept upper lobe, crisp lower lobe)
  const tailShape = new THREE.Shape()
  tailShape.moveTo(0.06, 0.02)
  tailShape.quadraticCurveTo(-0.12, 0.22, -0.36, 0.42)
  tailShape.quadraticCurveTo(-0.42, 0.41, -0.38, 0.33)
  tailShape.quadraticCurveTo(-0.24, 0.17, -0.16, 0.03)
  tailShape.lineTo(-0.24, -0.18)
  tailShape.quadraticCurveTo(-0.28, -0.22, -0.21, -0.22)
  tailShape.quadraticCurveTo(-0.08, -0.1, 0.05, -0.02)
  tailShape.closePath()
  const caudal = new THREE.ExtrudeGeometry(tailShape, { depth: 0.02, bevelEnabled: false, curveSegments: 6 })
  caudal.translate(-L * 0.5 + 0.03, 0, -0.01)

  const merged = mergeGeometries(
    [body, dorsal1, dorsal2, pecL, pecR, caudal].map(stripToBasicAttrs),
    false,
  ) as THREE.BufferGeometry

  const bronze = new THREE.Color('#5a6258')
  const flank = new THREE.Color('#8e968e')
  const white = new THREE.Color('#eaefef')
  const blackTip = new THREE.Color('#101417')
  const tmp = new THREE.Color()

  paint(merged, (x, y, z, _nx, ny) => {
    // Classic Carcharhinus melanopterus dorsal & caudal jet-black tips with bright white highlight band
    const onDorsal1 = x > -0.12 && x < 0.32 && y > 0.24
    if (onDorsal1) {
      if (y > 0.38) return tmp.copy(blackTip)
      if (y > 0.31) return tmp.copy(white)
      return tmp.copy(bronze)
    }
    const onTailTip = x < -L * 0.5 + 0.02 && (y > 0.28 || y < -0.14)
    if (onTailTip) return tmp.copy(blackTip)
    const onPecTip = Math.abs(z) > 0.34
    if (onPecTip) return tmp.copy(blackTip)

    // Countershading + pale lateral flank wedge
    if (ny < -0.22 && y < -0.03 && Math.abs(z) < 0.24) return tmp.copy(white)
    const stripe = (1 - Math.abs(y + 0.02) / 0.07) * smooth(-0.3, 0.4, x)
    return tmp
      .copy(bronze)
      .lerp(flank, smooth(0.45, -0.15, ny) * 0.65)
      .lerp(white, clamp(stripe, 0, 1) * 0.38)
  })
  return merged
}

// —— 4. Flying fish (Exocoetidae) ———————————————————————————————————

function buildFlyingFishGeometry() {
  // Torpedo body along +X (nose +0.19, tail -0.19)
  const body = stripToBasicAttrs(new THREE.SphereGeometry(1, 10, 7))
  body.scale(0.19, 0.036, 0.03)

  // Wide swept translucent-blue pectoral wings for gliding above the swell
  const wing = (side: number) => {
    const s = new THREE.Shape()
    s.moveTo(0.07, 0)
    s.quadraticCurveTo(0.04, side * 0.14, -0.05, side * 0.25)
    s.quadraticCurveTo(-0.11, side * 0.24, -0.13, side * 0.12)
    s.lineTo(-0.04, 0)
    s.closePath()
    const g = stripToBasicAttrs(new THREE.ShapeGeometry(s, 5))
    g.rotateX(-Math.PI / 2 + side * 0.16) // slight positive dihedral
    g.translate(0.03, 0.008, side * 0.02)
    return g
  }

  // Smaller pelvic wings aft
  const pelvic = (side: number) => {
    const s = new THREE.Shape()
    s.moveTo(0.03, 0)
    s.lineTo(-0.03, side * 0.09)
    s.lineTo(-0.07, side * 0.06)
    s.lineTo(-0.03, 0)
    s.closePath()
    const g = stripToBasicAttrs(new THREE.ShapeGeometry(s, 3))
    g.rotateX(-Math.PI / 2 + side * 0.1)
    g.translate(-0.08, -0.01, side * 0.015)
    return g
  }

  // Hypocercal forked tail — elongated lower lobe used to scull wave crests
  const tail = new THREE.BufferGeometry()
  tail.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        -0.17, 0, 0, -0.26, 0.065, 0, -0.22, 0.005, 0,
        -0.17, 0, 0, -0.22, -0.005, 0, -0.3, -0.105, 0,
      ],
      3,
    ),
  )
  tail.computeVertexNormals()

  const merged = mergeGeometries([body, wing(1), wing(-1), pelvic(1), pelvic(-1), tail], false) as THREE.BufferGeometry
  merged.computeVertexNormals()

  const cobalt = new THREE.Color('#184a8c')
  const silver = new THREE.Color('#e2eef5')
  const wingBlue = new THREE.Color('#53b4e0')
  const wingRim = new THREE.Color('#d9f3ff')
  const tmp = new THREE.Color()

  paint(merged, (x, y, z, _nx, ny) => {
    const az = Math.abs(z)
    if (az > 0.035) {
      // Spread pectoral/pelvic wings: iridescent azure with bright silver leading rim
      const lead = smooth(0.0, 0.055, x)
      return tmp.copy(wingBlue).lerp(wingRim, lead * 0.65 + smooth(0.19, 0.25, az) * 0.45)
    }
    if (x < -0.17) return tmp.copy(cobalt).lerp(silver, 0.45)
    return tmp.copy(silver).lerp(cobalt, smooth(-0.1, 0.55, ny) * smooth(-0.01, 0.025, y))
  })
  return merged
}

// —— Assembly & runtime —————————————————————————————————————————————

export type PelagicDeps = {
  hud: Hud
  wreckCentre: THREE.Vector3
  wreckResolve: (p: { x: number; y: number; z: number }) => void
  reefWreckPos: THREE.Vector3
  reefWreckResolve: (p: { x: number; y: number; z: number }) => void
  island: {
    centre: THREE.Vector3
    heightAt: (x: number, z: number) => number
    resolve: (p: { x: number; y: number; z: number }) => void
  }
  cove: THREE.Vector3
  lowPower: boolean
  pixelRatio: number
  onWhaleBlow?: (distance: number) => void
  onWhaleSong?: (distance: number) => void
  onSurfaceDisturb?: (x: number, z: number, power: number) => void
}

export function createPelagicLife(scene: THREE.Scene, deps: PelagicDeps) {
  const group = new THREE.Group()
  group.name = 'PelagicLife'
  scene.add(group)

  const plume = createBlowPlume(scene, deps.pixelRatio, deps.lowPower)
  const dummy = new THREE.Object3D()

  // —— A. Humpback mother, calf & pilot fish ——
  const whaleMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.44,
    metalness: 0.02,
    side: THREE.DoubleSide,
  })

  const buildWhaleRig = (scale: number) => {
    const rig = new THREE.Group()
    const bodyGeo = buildHumpbackBody()
    const rest = Float32Array.from(bodyGeo.attributes.position.array as Float32Array)
    const bodyMesh = new THREE.Mesh(bodyGeo, whaleMat)
    bodyMesh.frustumCulled = false
    rig.add(bodyMesh)

    const pecL = new THREE.Group()
    pecL.position.set(WHALE_LENGTH * (0.5 - 0.29), -0.56, 0.96)
    pecL.add(new THREE.Mesh(buildHumpbackPectoral(1), whaleMat))
    rig.add(pecL)

    const pecR = new THREE.Group()
    pecR.position.set(WHALE_LENGTH * (0.5 - 0.29), -0.56, -0.96)
    pecR.add(new THREE.Mesh(buildHumpbackPectoral(-1), whaleMat))
    rig.add(pecR)

    rig.scale.setScalar(scale)
    group.add(rig)
    return { rig, bodyMesh, rest, pecL, pecR, scale }
  }

  const mother = buildWhaleRig(1.0)
  const calf = deps.lowPower ? null : buildWhaleRig(0.43)
  const pilots = createPilotFish(deps.lowPower ? 4 : 8)
  scene.add(pilots.mesh)

  // Deep-water pelagic loop linking the Wanderer's deep edge, the crossing, and
  // the outer drop-off seaward of the landing cove & reef wreck.
  const waypoints = [
    new THREE.Vector2(24, -142),
    new THREE.Vector2(210, -268),
    new THREE.Vector2(430, -405),
    new THREE.Vector2(578, -488),
    new THREE.Vector2(535, -315),
    new THREE.Vector2(245, -168),
  ]

  const whale = {
    wp: 0,
    x: waypoints[0].x,
    z: waypoints[0].y,
    y: -8.5,
    heading: Math.atan2(-(waypoints[1].x - waypoints[0].x), -(waypoints[1].y - waypoints[0].y)),
    pitch: 0,
    roll: 0,
    swimPhase: 0,
    // Breathing cycle: > 0 while cruising deep; during [0..-13] runs a surface blow + arch dive
    breatheTimer: 16,
    blowEmitted: false,
    flukeRinged: false,
    songTimer: 22,
    seeded: false,
  }
  const calfState = {
    x: whale.x + 4,
    z: whale.z + 4,
    y: -7.2,
    heading: whale.heading,
    pitch: 0,
    roll: 0,
    mistDone: false,
  }

  let whisperedSpout = false
  let whisperedBlue = false

  function bendWhale(rig: ReturnType<typeof buildWhaleRig>, phase: number, amp: number, archOffset = 0) {
    const pos = rig.bodyMesh.geometry.attributes.position as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    const rest = rig.rest
    const L = WHALE_LENGTH
    for (let i = 0; i < pos.count; i++) {
      const x = rest[i * 3]
      const u = clamp(0.5 - x / L, 0, 1.2)
      const tailWeight = Math.pow(smooth(0.28, 1.08, u), 1.45)
      const arch = Math.sin(u * Math.PI) * archOffset
      arr[i * 3] = x
      arr[i * 3 + 1] = rest[i * 3 + 1] + Math.sin(phase - u * 3.1) * amp * tailWeight + arch
      arr[i * 3 + 2] = rest[i * 3 + 2]
    }
    pos.needsUpdate = true
  }

  function updateWhale(
    dt: number,
    t: number,
    cam: THREE.Camera,
    state: { underwater: boolean; daylight: number; storm: number },
  ) {
    // On first frame, start at the waypoint closest to where the player spawned
    // (open sea vs Begin-on-the-beach) so the world feels inhabited without teleporting later
    if (!whale.seeded) {
      whale.seeded = true
      let bestIdx = 0
      let bestDist = Infinity
      for (let i = 0; i < waypoints.length; i++) {
        const d = Math.hypot(cam.position.x - waypoints[i].x, cam.position.z - waypoints[i].y)
        if (d < bestDist) {
          bestDist = d
          bestIdx = i
        }
      }
      whale.wp = (bestIdx + 1) % waypoints.length
      whale.x = waypoints[bestIdx].x
      whale.z = waypoints[bestIdx].y
      const nxt = waypoints[whale.wp]
      whale.heading = Math.atan2(-(nxt.x - whale.x), -(nxt.y - whale.z))
      calfState.x = whale.x
      calfState.z = whale.z
      calfState.heading = whale.heading
    }

    const distToCam = Math.hypot(whale.x - cam.position.x, whale.z - cam.position.z)
    // Advance slightly brisker when far out of sight so she naturally visits both ends of the map
    const transitBoost = distToCam > 460 ? 2.2 : 1.0
    const speed = 2.45 * transitBoost

    const targetWp = waypoints[whale.wp]
    const dxWp = targetWp.x - whale.x
    const dzWp = targetWp.y - whale.z
    if (dxWp * dxWp + dzWp * dzWp < 42 * 42) {
      whale.wp = (whale.wp + 1) % waypoints.length
    }

    const desiredHeading = Math.atan2(-dxWp, -dzWp)
    let turn = clamp(angleDelta(whale.heading, desiredHeading), -0.5, 0.5) * 0.28

    // Deep-water guardrail: never let her wander onto the island shelf (< 18 m deep)
    const lookX = whale.x - Math.sin(whale.heading) * 32
    const lookZ = whale.z - Math.cos(whale.heading) * 32
    const aheadFloor = deps.island.heightAt(lookX, lookZ)
    if (aheadFloor > -18.5) {
      const awaySeaward = Math.atan2(-(whale.x - deps.island.centre.x), -(whale.z - deps.island.centre.z))
      turn = clamp(angleDelta(whale.heading, awaySeaward), -1, 1) * 0.85
    }

    whale.heading += turn * dt
    whale.roll = damp(whale.roll, -turn * 0.38, 1.8, dt)

    const hx = -Math.sin(whale.heading)
    const hz = -Math.cos(whale.heading)
    const rx = -hz
    const rz = hx

    whale.x += hx * speed * dt
    whale.z += hz * speed * dt

    // Breathing / spout state machine
    whale.breatheTimer -= dt
    const surface = sampleOcean(whale.x, whale.z, t).y
    const floor = deps.island.heightAt(whale.x, whale.z)
    let targetY = surface - (8.2 + Math.sin(t * 0.14) * 1.4)
    let archOffset = 0

    if (whale.breatheTimer <= 0 && state.storm < 0.7) {
      const cycleAge = -whale.breatheTimer // 0..13.5 s surface sequence
      if (cycleAge < 5.2) {
        // Ascending smoothly so her blowhole & arched back break the swell crest
        targetY = surface - 0.34
      } else if (cycleAge < 8.4) {
        // Blowing at the surface with dorsal hump awash
        targetY = surface - 0.3
        if (!whale.blowEmitted && whale.y > surface - 1.2) {
          whale.blowEmitted = true
          calfState.mistDone = false
          const blowX = whale.x + hx * 4.2
          const blowZ = whale.z + hz * 4.2
          const blowY = sampleOcean(blowX, blowZ, t).y + 0.35
          plume.emitMist(blowX, blowY, blowZ, 1.25, deps.lowPower ? 22 : 38)
          plume.spawnRing(blowX, blowY - 0.35, blowZ, 2.6, 3.6)
          deps.onSurfaceDisturb?.(blowX, blowZ, 2.2)
          deps.onWhaleBlow?.(distToCam)
          if (!whisperedSpout && !state.underwater && distToCam < 230 && state.daylight > 0.12) {
            whisperedSpout = true
            deps.hud.whisper('A tall mist hangs over the swell.')
          }
        }
        // Keep feeding fine spray through the 1.2 s exhale
        if (whale.blowEmitted && cycleAge < 6.5) {
          const blowX = whale.x + hx * 4.2
          const blowZ = whale.z + hz * 4.2
          plume.emitMist(blowX, sampleOcean(blowX, blowZ, t).y + 0.35, blowZ, 1.1, deps.lowPower ? 3 : 5)
        }
      } else if (cycleAge < 13.2) {
        // Sounding roll: arch the dorsal hump and lift the broad flukes as she dives
        const uDive = (cycleAge - 8.4) / 4.8
        targetY = surface - (1.2 + uDive * 9.5)
        archOffset = Math.sin(uDive * Math.PI) * 0.55
        if (!whale.flukeRinged && uDive > 0.36) {
          whale.flukeRinged = true
          const tailX = whale.x - hx * 6.2
          const tailZ = whale.z - hz * 6.2
          plume.spawnRing(tailX, sampleOcean(tailX, tailZ, t).y, tailZ, 2.8, 3.6)
          deps.onSurfaceDisturb?.(tailX, tailZ, 2.4)
        }
      } else {
        whale.breatheTimer = rand(38, 56)
        whale.blowEmitted = false
        whale.flukeRinged = false
      }
    } else if (whale.breatheTimer <= 0) {
      whale.breatheTimer = 25
    }

    targetY = Math.max(targetY, floor + 4.2)
    const prevY = whale.y
    whale.y = damp(whale.y, targetY, 0.85, dt)
    const vy = (whale.y - prevY) / Math.max(dt, 1e-3)
    whale.pitch = damp(whale.pitch, clamp(Math.atan2(vy, 2.45), -0.38, 0.34), 2.2, dt)

    // Underwater song every ~30-50 s when near enough to hear
    whale.songTimer -= dt
    if (whale.songTimer <= 0) {
      if (distToCam < 340 && whale.y < surface - 2.2) {
        deps.onWhaleSong?.(distToCam)
      }
      whale.songTimer = rand(28, 48)
    }

    if (!whisperedBlue && state.underwater && distToCam < 48) {
      whisperedBlue = true
      deps.hud.whisper('Something immense moves through the blue.')
    }

    const visible = distToCam < 440
    mother.rig.visible = visible
    pilots.mesh.visible = visible && distToCam < 160
    if (calf) calf.rig.visible = visible

    if (!visible) return

    whale.swimPhase += dt * 2.35
    // Past a couple of hundred metres the bend cannot be seen; the body holds
    // its last pose and the vertex buffer is not rewritten every frame
    const bending = distToCam < 240
    if (bending) bendWhale(mother, whale.swimPhase, 0.72, archOffset)
    const pecFlap = Math.sin(whale.swimPhase * 0.55) * 0.16
    mother.pecL.rotation.set(0.26 + pecFlap, 0, 0)
    mother.pecR.rotation.set(-(0.26 + pecFlap), 0, 0)

    mother.rig.position.set(whale.x, whale.y, whale.z)
    dummy.rotation.set(0, 0, 0)
    dummy.rotateY(whale.heading + Math.PI / 2)
    dummy.rotateZ(whale.pitch)
    dummy.rotateX(whale.roll)
    mother.rig.quaternion.copy(dummy.quaternion)

    // Calf tucked in echelon off the mother's right shoulder
    if (calf) {
      const wantX = whale.x - hx * 1.4 + rx * 4.5
      const wantZ = whale.z - hz * 1.4 + rz * 4.5
      const calfSurf = sampleOcean(wantX, wantZ, t).y
      const wantY = Math.min(calfSurf - 0.55, whale.y + 0.95 + Math.sin(t * 0.55) * 0.25)
      calfState.x = damp(calfState.x, wantX, 2.4, dt)
      calfState.z = damp(calfState.z, wantZ, 2.4, dt)
      const prevCY = calfState.y
      calfState.y = damp(calfState.y, wantY, 2.0, dt)
      calfState.heading = damp(calfState.heading, whale.heading + angleDelta(whale.heading, calfState.heading) * 0, 3, dt)
      calfState.pitch = damp(
        calfState.pitch,
        clamp(Math.atan2((calfState.y - prevCY) / Math.max(dt, 1e-3), 2.45), -0.35, 0.35),
        3,
        dt,
      )
      if (whale.blowEmitted && !calfState.mistDone && calfState.y > calfSurf - 1.1) {
        calfState.mistDone = true
        plume.emitMist(calfState.x + hx * 1.8, calfSurf, calfState.z + hz * 1.8, 0.55, 10)
      }
      if (bending) bendWhale(calf, whale.swimPhase * 1.55 + 1.1, 0.65, archOffset * 0.6)
      const calfFlap = Math.sin(t * 1.8) * 0.2
      calf.pecL.rotation.set(0.24 + calfFlap, 0, 0)
      calf.pecR.rotation.set(-(0.24 + calfFlap), 0, 0)
      calf.rig.position.set(calfState.x, calfState.y, calfState.z)
      dummy.rotation.set(0, 0, 0)
      dummy.rotateY(whale.heading + Math.PI / 2)
      dummy.rotateZ(calfState.pitch)
      dummy.rotateX(whale.roll * 0.8)
      calf.rig.quaternion.copy(dummy.quaternion)
    }

    // Escort pilot fish riding her pressure wave
    if (pilots.mesh.visible) {
      pilots.clock.value = t
      for (let i = 0; i < pilots.slots.length; i++) {
        const s = pilots.slots[i]
        const wob = Math.sin(t * 2.1 + s.phase) * 0.18
        const px = whale.x + hx * s.fwd + rx * (s.right + wob)
        const pz = whale.z + hz * s.fwd + rz * (s.right + wob)
        const py = whale.y + s.down + Math.cos(t * 1.7 + s.phase) * 0.12
        dummy.position.set(px, py, pz)
        dummy.rotation.set(0, 0, 0)
        dummy.rotateY(whale.heading + Math.PI / 2 + wob * 0.12)
        dummy.rotateZ(whale.pitch * 0.7)
        dummy.scale.setScalar(s.scale)
        dummy.updateMatrix()
        pilots.mesh.setMatrixAt(i, dummy.matrix)
      }
      pilots.mesh.instanceMatrix.needsUpdate = true
    }
  }

  // —— B. Fever of spotted eagle rays in the lagoon & pass ——
  const eagleGeo = buildEagleRay()
  const eagleRest = Float32Array.from(eagleGeo.attributes.position.array as Float32Array)
  const eagleMat = createEagleRayMaterial()

  // Anchor the squadron's circuit in the clear lagoon water between the cove beach and the reef wreck,
  // nudged toward the deepest sandy pocket nearby so they always have clean water under their wings.
  const midX = THREE.MathUtils.lerp(deps.cove.x, deps.reefWreckPos.x, 0.56)
  const midZ = THREE.MathUtils.lerp(deps.cove.z, deps.reefWreckPos.z, 0.56)
  let rayHomeX = midX
  let rayHomeZ = midZ
  let bestFloor = 99
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * TAU
    for (const r of [0, 12, 24, 36]) {
      const tx = midX + Math.cos(a) * r
      const tz = midZ + Math.sin(a) * r
      const h = deps.island.heightAt(tx, tz)
      if (h < bestFloor && h > -11) {
        bestFloor = h
        rayHomeX = tx
        rayHomeZ = tz
      }
    }
  }

  // Diamond formation slots: leader, left wing, right wing, trailing
  const formationSlots = [
    { fwd: 0, right: 0, lift: 0, scale: 1.08, phase: 0 },
    { fwd: -2.1, right: 2.1, lift: 0.18, scale: 0.94, phase: 0.8 },
    { fwd: -2.3, right: -2.0, lift: -0.12, scale: 0.96, phase: 1.5 },
    { fwd: -4.4, right: 0.25, lift: 0.28, scale: 0.86, phase: 2.3 },
  ]
  const rayCount = deps.lowPower ? 2 : 4
  const eagleRays = formationSlots.slice(0, rayCount).map((slot) => {
    const mesh = new THREE.Mesh(eagleGeo.clone(), eagleMat)
    mesh.frustumCulled = false
    mesh.scale.setScalar(slot.scale)
    group.add(mesh)
    return { mesh, slot, y: -2.2, pitch: 0 }
  })

  const fever = {
    angle: 0.4,
    yaw: 0,
    roll: 0,
    rx: 24,
    rz: 16,
  }

  function updateEagleRays(dt: number, t: number, cam: THREE.Camera) {
    const distSq = (rayHomeX - cam.position.x) ** 2 + (rayHomeZ - cam.position.z) ** 2
    const near = distSq < 230 * 230
    for (const r of eagleRays) r.mesh.visible = near
    if (!near) return

    fever.angle += dt * 0.068
    const a = fever.angle
    // Figure-eight / gentle kidney loop through the lagoon
    const cx = rayHomeX + Math.cos(a) * fever.rx
    const cz = rayHomeZ + Math.sin(a) * fever.rz + Math.sin(a * 2) * 4.5
    const vx = -Math.sin(a) * fever.rx * 0.068
    const vz = (Math.cos(a) * fever.rz + Math.cos(a * 2) * 9.0) * 0.068
    const heading = Math.atan2(-vx, -vz)
    const dYaw = angleDelta(fever.yaw, heading)
    fever.yaw += dYaw
    fever.roll = damp(fever.roll, clamp(-dYaw / Math.max(dt, 1e-3), -1, 1) * 0.28, 2.5, dt)

    const hx = -Math.sin(fever.yaw)
    const hz = -Math.cos(fever.yaw)
    const rx = -hz
    const rz = hx

    for (const r of eagleRays) {
      const wx = cx + hx * r.slot.fwd + rx * r.slot.right
      const wz = cz + hz * r.slot.fwd + rz * r.slot.right
      const surf = sampleOcean(wx, wz, t).y
      const floor = deps.island.heightAt(wx, wz)
      // Glide cleanly above the coral sand and safely beneath the lagoon surface
      const idealY = surf - (1.85 + Math.sin(t * 0.28 + r.slot.phase) * 0.35) + r.slot.lift
      const safeY = clamp(idealY, floor + 0.62, surf - 0.52)
      const prevY = r.y
      r.y = damp(r.y, safeY, 2.2, dt)
      r.pitch = damp(r.pitch, clamp((r.y - prevY) / Math.max(dt * 1.6, 1e-3), -0.25, 0.25), 3, dt)
      // Hide gracefully if an extreme low tide ever leaves a slot shallower than 0.85 m
      r.mesh.visible = surf - floor > 0.85

      const pos = r.mesh.geometry.attributes.position as THREE.BufferAttribute
      const arr = pos.array as Float32Array
      const flap = t * 1.95 + r.slot.phase
      for (let i = 0; i < pos.count; i++) {
        const lx = eagleRest[i * 3]
        const lz = eagleRest[i * 3 + 2]
        const wing = Math.abs(lz)
        // Wingtips undulate in a graceful travelling wave; whip tail trails behind
        const tailSway = lx < -0.45 ? Math.sin(flap - lx * 1.2) * 0.05 * (-0.45 - lx) : 0
        arr[i * 3] = lx
        arr[i * 3 + 1] =
          eagleRest[i * 3 + 1] +
          Math.sin(flap - wing * 1.55) * 0.24 * Math.pow(wing / 1.72, 1.38) * 1.6 +
          tailSway
        arr[i * 3 + 2] = lz
      }
      pos.needsUpdate = true

      r.mesh.position.set(wx, r.y, wz)
      dummy.rotation.set(0, 0, 0)
      dummy.rotateY(fever.yaw + Math.PI / 2)
      dummy.rotateZ(r.pitch)
      dummy.rotateX(fever.roll)
      r.mesh.quaternion.copy(dummy.quaternion)
    }
  }

  // —— C. Blacktip reef sharks ——
  const sharkGeo = buildBlacktipShark()
  const sharkRest = Float32Array.from(sharkGeo.attributes.position.array as Float32Array)
  const sharkMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.42,
    metalness: 0.04,
    side: THREE.DoubleSide,
  })

  type Shark = {
    mesh: THREE.Mesh
    home: THREE.Vector2
    radius: number
    prefDepth: number
    x: number
    z: number
    y: number
    heading: number
    turn: number
    roll: number
    pitch: number
    phase: number
    useReefWreck: boolean
  }

  const sharks: Shark[] = []
  const spawnShark = (hx: number, hz: number, radius: number, prefDepth: number, useReefWreck: boolean) => {
    const mesh = new THREE.Mesh(sharkGeo.clone(), sharkMat)
    mesh.frustumCulled = false
    mesh.scale.setScalar(rand(0.95, 1.12))
    group.add(mesh)
    sharks.push({
      mesh,
      home: new THREE.Vector2(hx, hz),
      radius,
      prefDepth,
      x: hx + rand(-8, 8),
      z: hz + rand(-8, 8),
      y: -prefDepth,
      heading: rand(0, TAU),
      turn: 0,
      roll: 0,
      pitch: 0,
      phase: rand(0, TAU),
      useReefWreck,
    })
  }

  // Seaward side of the stranded barrier-reef coaster (in deeper reef water off her bow/flank)
  const outDir = new THREE.Vector2(
    deps.reefWreckPos.x - deps.island.centre.x,
    deps.reefWreckPos.z - deps.island.centre.z,
  ).normalize()
  spawnShark(
    deps.reefWreckPos.x + outDir.x * 26,
    deps.reefWreckPos.z + outDir.y * 26,
    24,
    3.4,
    true,
  )
  if (!deps.lowPower) {
    spawnShark(deps.wreckCentre.x - 18, deps.wreckCentre.z + 14, 26, 6.8, false)
  }

  const probe = { x: 0, y: 0, z: 0 }
  function updateShark(sh: Shark, dt: number, t: number, cam: THREE.Camera) {
    const dxc = sh.x - cam.position.x
    const dzc = sh.z - cam.position.z
    const near = dxc * dxc + dzc * dzc < 220 * 220
    sh.mesh.visible = near
    if (!near) return

    sh.turn = damp(sh.turn, Math.sin(t * 0.21 + sh.phase) * 0.32, 1.1, dt)
    let steer = sh.turn

    const distHome = Math.hypot(sh.home.x - sh.x, sh.home.y - sh.z)
    if (distHome > sh.radius) {
      const toHome = Math.atan2(-(sh.home.x - sh.x), -(sh.home.y - sh.z))
      steer += clamp(angleDelta(sh.heading, toHome), -1, 1) * 1.1
    }

    // Keep off shallow coral flats
    const lookFloor = deps.island.heightAt(sh.x - Math.sin(sh.heading) * 7, sh.z - Math.cos(sh.heading) * 7)
    if (lookFloor > -1.8) steer += 1.6

    // Polite reef-shark shyness: smoothly curve aside if a swimmer gets within 4.5 m
    const swimmerDist = Math.hypot(dxc, dzc)
    if (swimmerDist < 4.8) {
      const away = Math.atan2(-dxc, -dzc)
      steer += clamp(angleDelta(sh.heading, away), -1, 1) * 1.5
    }

    sh.heading += steer * dt
    sh.roll = damp(sh.roll, -steer * 0.22, 3, dt)

    const speed = 1.65 + Math.sin(t * 0.5 + sh.phase) * 0.15
    sh.x -= Math.sin(sh.heading) * speed * dt
    sh.z -= Math.cos(sh.heading) * speed * dt

    const surf = sampleOcean(sh.x, sh.z, t).y
    const floor = deps.island.heightAt(sh.x, sh.z)
    const wantY = clamp(
      surf - (sh.prefDepth + Math.sin(t * 0.18 + sh.phase) * 0.85),
      floor + 0.9,
      surf - 0.55,
    )
    const prevY = sh.y
    sh.y = damp(sh.y, wantY, 1.5, dt)
    sh.pitch = damp(sh.pitch, clamp(Math.atan2(sh.y - prevY, speed * dt) * 0.45, -0.25, 0.25), 3, dt)

    probe.x = sh.x
    probe.y = sh.y
    probe.z = sh.z
    if (sh.useReefWreck) deps.reefWreckResolve(probe)
    else deps.wreckResolve(probe)
    deps.island.resolve(probe)
    sh.x = probe.x
    sh.y = Math.min(probe.y, surf - 0.5)
    sh.z = probe.z

    // Lateral carangiform S-wave (horizontal side-to-side tail sweep + subtle head counter-yaw)
    const swim = t * 5.8 + sh.phase
    const pos = sh.mesh.geometry.attributes.position as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    for (let i = 0; i < pos.count; i++) {
      const lx = sharkRest[i * 3]
      const u = clamp(0.5 - lx / SHARK_LENGTH, 0, 1.3)
      const tailW = Math.pow(smooth(0.22, 1.15, u), 1.55)
      const headSway = (1 - smooth(0.0, 0.35, u)) * Math.sin(swim) * 0.018
      arr[i * 3] = lx
      arr[i * 3 + 1] = sharkRest[i * 3 + 1]
      arr[i * 3 + 2] = sharkRest[i * 3 + 2] + Math.sin(swim - u * 4.4) * 0.145 * tailW + headSway
    }
    pos.needsUpdate = true

    sh.mesh.position.set(sh.x, sh.y, sh.z)
    dummy.rotation.set(0, 0, 0)
    dummy.rotateY(sh.heading + Math.PI / 2)
    dummy.rotateZ(sh.pitch)
    dummy.rotateX(sh.roll)
    sh.mesh.quaternion.copy(dummy.quaternion)
  }

  // —— D. Flights of iridescent flying fish ——
  const flyCount = deps.lowPower ? 8 : 14
  const flyGeo = buildFlyingFishGeometry()
  const buzzAttr = new THREE.InstancedBufferAttribute(new Float32Array(flyCount), 1)
  buzzAttr.setUsage(THREE.DynamicDrawUsage)
  flyGeo.setAttribute('aFlyBuzz', buzzAttr)

  const flyClock = { value: 0 }
  const flyMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.25,
    metalness: 0.32,
    side: THREE.DoubleSide,
  })
  flyMat.onBeforeCompile = (shader) => {
    shader.uniforms.uFlyTime = flyClock
    shader.vertexShader =
      'uniform float uFlyTime;\nattribute float aFlyBuzz;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        float wingOut = smoothstep(0.03, 0.24, abs(position.z));
        transformed.y += sin(uFlyTime * 42.0 + position.x * 18.0) * 0.022 * wingOut * aFlyBuzz;
        float tailBack = smoothstep(0.14, 0.30, -position.x);
        transformed.z += sin(uFlyTime * 36.0) * 0.028 * tailBack * aFlyBuzz;
        `,
      )
  }
  flyMat.customProgramCacheKey = () => 'flying-fish'

  const flyMesh = new THREE.InstancedMesh(flyGeo, flyMat, flyCount)
  flyMesh.frustumCulled = false
  flyMesh.userData.noCast = true
  flyMesh.visible = false
  flyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  scene.add(flyMesh)

  type Flyer = {
    x: number
    z: number
    heading: number
    speed: number
    delay: number
    age: number
    flightDur: number
    peakAlt: number
    tapped: boolean
    scale: number
  }
  let flight: Flyer[] | null = null
  let flyTimer = rand(18, 34)

  function spawnFlyingFish(cam: THREE.Camera) {
    const fwd = new THREE.Vector3()
    cam.getWorldDirection(fwd)
    fwd.y = 0
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1)
    fwd.normalize()

    const bearing = (Math.random() < 0.5 ? -1 : 1) * rand(0.08, 0.36)
    const dir = fwd.clone().applyAxisAngle(UP, bearing)
    const dist = rand(12, 22)
    const ox = cam.position.x + dir.x * dist
    const oz = cam.position.z + dir.z * dist
    // Only launch over open water at least 3 m deep
    if (deps.island.heightAt(ox, oz) > -3.0) return false

    const crossSide = Math.random() < 0.5 ? 1 : -1
    const baseHeading = Math.atan2(-dir.x, -dir.z) + crossSide * rand(1.05, 1.48)
    const hx = -Math.sin(baseHeading)
    const hz = -Math.cos(baseHeading)
    const rx = -hz
    const rz = hx

    flight = Array.from({ length: flyCount }, (_, i) => ({
      x: ox - hx * rand(0, 3.2) + rx * ((i - flyCount * 0.5) * 0.6 + rand(-0.35, 0.35)),
      z: oz - hz * rand(0, 3.2) + rz * ((i - flyCount * 0.5) * 0.6 + rand(-0.35, 0.35)),
      heading: baseHeading + rand(-0.07, 0.07),
      speed: rand(8.4, 10.4),
      delay: i * 0.05 + rand(0, 0.07),
      age: 0,
      flightDur: rand(3.2, 4.7),
      peakAlt: rand(0.48, 0.96),
      tapped: false,
      scale: rand(1.18, 1.48),
    }))
    flyMesh.visible = true
    return true
  }

  function updateFlyingFish(dt: number, t: number) {
    if (!flight) return
    flyClock.value = t
    let anyAlive = false
    const buzzArr = buzzAttr.array as Float32Array

    for (let i = 0; i < flight.length; i++) {
      const f = flight[i]
      f.age += dt
      const activeAge = f.age - f.delay
      if (activeAge < 0) {
        anyAlive = true
        dummy.scale.setScalar(0)
        dummy.updateMatrix()
        flyMesh.setMatrixAt(i, dummy.matrix)
        buzzArr[i] = 0
        continue
      }
      if (activeAge > f.flightDur) {
        dummy.scale.setScalar(0)
        dummy.updateMatrix()
        flyMesh.setMatrixAt(i, dummy.matrix)
        buzzArr[i] = 0
        continue
      }
      anyAlive = true

      // Launch ring on initial breakout
      if (activeAge - dt <= 0) {
        const sy = sampleOcean(f.x, f.z, t).y
        if (i % 3 === 0) plume.spawnRing(f.x, sy, f.z, 0.45, 1.3)
        deps.onSurfaceDisturb?.(f.x, f.z, 0.35)
      }

      const hx = -Math.sin(f.heading)
      const hz = -Math.cos(f.heading)
      f.x += hx * f.speed * dt
      f.z += hz * f.speed * dt

      // Abort into the water cleanly if gliding into shallow beach shoals
      if (deps.island.heightAt(f.x, f.z) > -0.8) {
        f.age = f.delay + f.flightDur + 1
        continue
      }

      const u = activeAge / f.flightDur
      // Double-arc glide: climb -> skim -> mid-flight tail-tap at u=0.52 -> second skim -> slice in
      const lobe =
        u < 0.52
          ? Math.sin((u / 0.52) * Math.PI) * (0.88 + 0.12)
          : Math.sin(((u - 0.52) / 0.48) * Math.PI) * 0.78
      const clearance = 0.06 + lobe * f.peakAlt
      const surf = sampleOcean(f.x, f.z, t).y
      const y = surf + clearance

      if (!f.tapped && u >= 0.5) {
        f.tapped = true
        if (i % 2 === 0) plume.spawnRing(f.x, surf, f.z, 0.38, 1.15)
        deps.onSurfaceDisturb?.(f.x, f.z, 0.3)
      }

      // Shiver wings & scull tail during launch and mid-flight wave tap; taut in pure glide
      const nearTap = 1 - clamp(Math.abs(u - 0.52) / 0.1, 0, 1)
      buzzArr[i] = clamp((1 - smooth(0, 0.18, u)) + nearTap, 0.08, 1)

      const pitch = u < 0.14 ? 0.22 : u > 0.88 ? -0.26 : (0.5 - u) * 0.12
      dummy.position.set(f.x, y, f.z)
      dummy.rotation.set(0, 0, 0)
      dummy.rotateY(f.heading + Math.PI / 2)
      dummy.rotateZ(pitch)
      dummy.rotateX(Math.sin(t * 2.4 + i) * 0.12)
      dummy.scale.setScalar(f.scale)
      dummy.updateMatrix()
      flyMesh.setMatrixAt(i, dummy.matrix)
    }

    buzzAttr.needsUpdate = true
    flyMesh.instanceMatrix.needsUpdate = true
    if (!anyAlive) {
      flight = null
      flyMesh.visible = false
    }
  }

  function update(
    dt: number,
    t: number,
    camera: THREE.Camera,
    state: { underwater: boolean; daylight: number; storm: number },
  ) {
    updateWhale(dt, t, camera, state)
    updateEagleRays(dt, t, camera)
    for (const sh of sharks) updateShark(sh, dt, t, camera)

    flyTimer -= dt
    if (!flight && flyTimer <= 0) {
      if (!state.underwater && camera.position.y < 28 && state.daylight > 0.2 && state.storm < 0.55) {
        const ok = spawnFlyingFish(camera)
        flyTimer = ok ? rand(32, 62) : 9
      } else {
        flyTimer = 8
      }
    }
    updateFlyingFish(dt, t)
    plume.update(dt, t, state.daylight, state.underwater)
  }

  /** Dev / showcase helper: place the whale on a scenic pass ahead in deep water and trigger a surface blow. */
  function summonWhale(camera: THREE.Camera, blowSoon = true) {
    const fwd = new THREE.Vector3()
    camera.getWorldDirection(fwd)
    fwd.y = 0
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1)
    fwd.normalize()
    const dist = 38
    let tx = camera.position.x + fwd.x * dist
    let tz = camera.position.z + fwd.z * dist
    // If summoned while standing on the beach, place her just beyond the barrier reef in deep water
    if (deps.island.heightAt(tx, tz) > -18) {
      const seaDir = new THREE.Vector2(
        camera.position.x - deps.island.centre.x,
        camera.position.z - deps.island.centre.z,
      )
      if (seaDir.lengthSq() < 1) seaDir.set(-1, 0)
      seaDir.normalize()
      tx = deps.island.centre.x + seaDir.x * 465
      tz = deps.island.centre.z + seaDir.y * 465
    }
    const crossHeading = Math.atan2(-fwd.x, -fwd.z) + Math.PI * 0.46
    const hx = -Math.sin(crossHeading)
    const hz = -Math.cos(crossHeading)
    const rx = -hz
    const rz = hx
    whale.x = tx
    whale.z = tz
    whale.heading = crossHeading
    whale.y = blowSoon ? -0.35 : -6.2
    whale.pitch = 0
    whale.roll = 0
    whale.breatheTimer = blowSoon ? -5.22 : 24
    whale.blowEmitted = false
    whale.flukeRinged = false
    calfState.x = tx - hx * 1.4 + rx * 4.6
    calfState.z = tz - hz * 1.4 + rz * 4.6
    calfState.y = whale.y - 0.55
    calfState.heading = crossHeading
  }

  return {
    group,
    update,
    summonWhale,
    summonFlyingFish: (camera: THREE.Camera) => spawnFlyingFish(camera),
    whale,
    eagleRays,
    sharks,
    rayHome: { x: rayHomeX, z: rayHomeZ },
  }
}

export type PelagicLife = ReturnType<typeof createPelagicLife>
