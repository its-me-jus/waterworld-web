import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Hud } from './hud'
import { sampleOcean } from './waves'

/**
 * Island sky, freshwater pool, and nocturnal life:
 *
 *  - White-tailed tropicbirds (Phaethon lepturus) banking along the cove cliffs
 *    and palm crowns with long streaming tail ribbons.
 *  - Metallic emerald and sapphire dragonflies hovering, darting, and dipping
 *    concentric ripples onto the inland basalt rain pools.
 *  - Canopy fireflies waking under the palms and around the pools at dusk.
 *  - Noctiluca sea-sparkle: bioluminescent plankton stirred by your swimming
 *    strokes, wading steps, and surfacing sea life after dark.
 */

const TAU = Math.PI * 2

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
const angleDelta = (a: number, b: number) => ((b - a + Math.PI * 3) % TAU) - Math.PI

function stripBasic(geo: THREE.BufferGeometry) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone()
  if (!g.attributes.normal) g.computeVertexNormals()
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal') g.deleteAttribute(k)
  }
  return g
}

function paint(
  geo: THREE.BufferGeometry,
  pick: (x: number, y: number, z: number, ny: number) => THREE.Color,
) {
  const pos = geo.attributes.position
  const nor = geo.attributes.normal
  const out = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const c = pick(pos.getX(i), pos.getY(i), pos.getZ(i), nor.getY(i))
    out[i * 3] = c.r
    out[i * 3 + 1] = c.g
    out[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3))
}

// —— 1. White-tailed tropicbird (Phaethon lepturus) ——————————————————

function buildTropicbird(mat: THREE.Material) {
  const root = new THREE.Group()

  // Sleek spindle body (+X forward)
  const torso = stripBasic(new THREE.SphereGeometry(1, 10, 7))
  torso.scale(0.24, 0.068, 0.065)
  const head = stripBasic(new THREE.SphereGeometry(0.056, 8, 6))
  head.scale(1.25, 0.95, 0.9)
  head.translate(0.24, 0.022, 0)
  const bill = stripBasic(new THREE.ConeGeometry(0.02, 0.11, 5))
  bill.rotateZ(-Math.PI / 2)
  bill.translate(0.33, 0.016, 0)
  const fanTail = stripBasic(new THREE.ConeGeometry(0.055, 0.16, 4))
  fanTail.scale(1, 1, 0.25)
  fanTail.rotateZ(Math.PI / 2)
  fanTail.translate(-0.24, 0.005, 0)

  const bodyGeo = mergeGeometries([torso, head, bill, fanTail], false) as THREE.BufferGeometry
  bodyGeo.computeVertexNormals()

  const white = new THREE.Color('#f4f6f7')
  const shadowWhite = new THREE.Color('#cfd8de')
  const coralBill = new THREE.Color('#e27329')
  const blackMark = new THREE.Color('#1a2026')
  const tmp = new THREE.Color()

  paint(bodyGeo, (x, y, z, ny) => {
    if (x > 0.285) return tmp.copy(coralBill)
    // Crisp dark eye-mask crescent
    if (x > 0.22 && x < 0.27 && y > 0.015 && Math.abs(z) > 0.035) return tmp.copy(blackMark)
    return tmp.copy(white).lerp(shadowWhite, smooth(0.1, -0.5, ny) * 0.45)
  })
  root.add(new THREE.Mesh(bodyGeo, mat))

  // Swept tern-like wings with black outer primary slashes and dorsal bar
  const makeWing = (side: number) => {
    const pivot = new THREE.Group()
    pivot.position.set(0.04, 0.025, side * 0.045)
    const s = new THREE.Shape()
    s.moveTo(0.08, 0)
    // Forward wrist crook -> long pointed primary tip
    s.quadraticCurveTo(0.11, side * 0.22, -0.06, side * 0.54)
    s.quadraticCurveTo(-0.12, side * 0.52, -0.14, side * 0.36)
    s.quadraticCurveTo(-0.11, side * 0.18, -0.09, 0)
    s.closePath()
    const g = stripBasic(new THREE.ExtrudeGeometry(s, { depth: 0.01, bevelEnabled: false, curveSegments: 5 }))
    g.translate(0, 0, -0.005)
    g.rotateX(-Math.PI / 2)
    g.computeVertexNormals()
    paint(g, (x, _y, z, ny) => {
      const span = Math.abs(z) / 0.54
      // Signature black wingtips & diagonal black upper-wing bar
      if (span > 0.74 && x > -0.1) return tmp.copy(blackMark)
      const diagBar = ny > 0 && Math.abs(x - (-0.01 - span * 0.06)) < 0.024 && span > 0.22 && span < 0.68
      if (diagBar) return tmp.copy(blackMark)
      return tmp.copy(white).lerp(shadowWhite, smooth(0.2, -0.4, ny) * 0.35)
    })
    pivot.add(new THREE.Mesh(g, mat))
    root.add(pivot)
    return pivot
  }

  const wingL = makeWing(1)
  const wingR = makeWing(-1)

  // Two long streaming white tail ribbons (~0.95 m) trailing from -0.28 to -1.23
  const segs = 10
  const streamLen = 0.95
  const ribbonParts: THREE.BufferGeometry[] = []
  for (const side of [-1, 1]) {
    const p = new THREE.PlaneGeometry(streamLen, 0.022, segs, 1)
    // Taper to a fine point aft (-X)
    const pos = p.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const u = clamp(0.5 - pos.getX(i) / streamLen, 0, 1)
      pos.setY(i, pos.getY(i) * (1 - u * 0.72))
    }
    p.rotateX(Math.PI * 0.32 * side)
    p.translate(-0.28 - streamLen * 0.5, 0.004, side * 0.016)
    ribbonParts.push(stripBasic(p))
  }
  const streamGeo = mergeGeometries(ribbonParts, false) as THREE.BufferGeometry
  streamGeo.computeVertexNormals()
  paint(streamGeo, () => white)
  const streamRest = Float32Array.from(streamGeo.attributes.position.array as Float32Array)
  const streamers = new THREE.Mesh(streamGeo, mat)
  streamers.frustumCulled = false
  streamers.userData.noCast = true
  root.add(streamers)

  return { root, wingL, wingR, streamers, streamRest, streamLen }
}

// —— 2. Jewel dragonfly —————————————————————————————————————————————

function buildDragonfly(hue: 'emerald' | 'sapphire', bodyMat: THREE.Material, wingMat: THREE.Material) {
  const root = new THREE.Group()

  const thorax = stripBasic(new THREE.SphereGeometry(0.016, 7, 5))
  thorax.scale(1.4, 0.95, 0.9)
  const head = stripBasic(new THREE.SphereGeometry(0.014, 7, 5))
  head.scale(0.9, 0.95, 1.35)
  head.translate(0.028, 0.003, 0)
  const abdomen = stripBasic(new THREE.CylinderGeometry(0.004, 0.007, 0.095, 6))
  abdomen.rotateZ(Math.PI / 2)
  abdomen.translate(-0.062, -0.002, 0)

  const bodyGeo = mergeGeometries([thorax, head, abdomen], false) as THREE.BufferGeometry
  bodyGeo.computeVertexNormals()

  const primary = new THREE.Color(hue === 'emerald' ? '#12c488' : '#1f8cf0')
  const darkRing = new THREE.Color('#101c22')
  const eyeCol = new THREE.Color(hue === 'emerald' ? '#36f5a8' : '#58c4ff')
  const tmp = new THREE.Color()
  paint(bodyGeo, (x) => {
    if (x > 0.02) return tmp.copy(eyeCol)
    if (x < -0.018) {
      const seg = Math.sin(x * 260) * 0.5 + 0.5
      return tmp.copy(primary).lerp(darkRing, smooth(0.45, 0.85, seg) * 0.7)
    }
    return tmp.copy(primary)
  })
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat)
  bodyMesh.userData.noShadow = true
  root.add(bodyMesh)

  // Four slender hyaline wings (fore + hind pair)
  const wingPair = (xOff: number, sweep: number, span: number) => {
    const gL = new THREE.PlaneGeometry(0.016, span)
    gL.rotateX(-Math.PI / 2)
    gL.rotateY(sweep)
    gL.translate(0, 0, span * 0.5)
    const pivotL = new THREE.Group()
    pivotL.position.set(xOff, 0.008, 0.006)
    const mL = new THREE.Mesh(gL, wingMat)
    mL.userData.noShadow = true
    pivotL.add(mL)

    const gR = new THREE.PlaneGeometry(0.016, span)
    gR.rotateX(-Math.PI / 2)
    gR.rotateY(-sweep)
    gR.translate(0, 0, -span * 0.5)
    const pivotR = new THREE.Group()
    pivotR.position.set(xOff, 0.008, -0.006)
    const mR = new THREE.Mesh(gR, wingMat)
    mR.userData.noShadow = true
    pivotR.add(mR)

    root.add(pivotL, pivotR)
    return { pivotL, pivotR }
  }
  const fore = wingPair(0.008, 0.14, 0.068)
  const hind = wingPair(-0.008, -0.12, 0.062)

  root.userData.noShadow = true
  return { root, fore, hind }
}

// —— 3 & 4. Glow shaders (Fireflies & Noctiluca sea-sparkle) —————————

const glowVertex = /* glsl */ `
attribute float aAlpha;
attribute float aSize;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
uniform float uPixelRatio;
uniform float uMaxSize;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // ~world-scaled: aSize is roughly the glow diameter in metres
  gl_PointSize = clamp(aSize * uPixelRatio * (520.0 / max(-mv.z, 0.6)), 1.8, uMaxSize);
}
`

const glowFragment = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  if (vAlpha <= 0.002) discard;
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;
  float core = exp(-r2 * 22.0);
  float halo = pow(1.0 - r2 * 4.0, 2.0) * 0.45;
  gl_FragColor = vec4(vColor * (core + halo), (core + halo) * vAlpha);
}
`

// —— Assembly ———————————————————————————————————————————————————————

export type IslandLifeDeps = {
  hud: Hud
  island: {
    centre: THREE.Vector3
    heightAt: (x: number, z: number) => number
    pools: THREE.Vector3[]
  }
  cove: THREE.Vector3
  lowPower: boolean
  pixelRatio: number
  onSeabirdCry?: (distance: number) => void
}

export function createIslandLife(scene: THREE.Scene, deps: IslandLifeDeps) {
  const group = new THREE.Group()
  group.name = 'IslandLife'
  scene.add(group)

  const dummy = new THREE.Object3D()

  // —— A. White-tailed tropicbirds soaring the cove cliffs & palms ——
  const birdMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.48,
    metalness: 0.0,
    side: THREE.DoubleSide,
  })

  // Cove-to-interior axis so birds wheel naturally across the cove valley, cliffs, and lagoon edge
  const inDir = new THREE.Vector2(
    deps.island.centre.x - deps.cove.x,
    deps.island.centre.z - deps.cove.z,
  ).normalize()
  const sideDir = new THREE.Vector2(-inDir.y, inDir.x)

  const birdCount = deps.lowPower ? 3 : 5
  const tropicbirds = Array.from({ length: birdCount }, (_, i) => {
    const built = buildTropicbird(birdMat)
    built.root.scale.setScalar(1.18 + (i % 3) * 0.1)
    group.add(built.root)
    // First pair wheels out over the open cove bay/lagoon; others soar high above the cliffs & canopy roof
    const overBay = i < 2
    const along = overBay ? -26 + i * 18 : 36 + (i - 2) * 28
    const across = overBay
      ? (i === 0 ? -1 : 1) * 24
      : (i % 2 === 0 ? 1 : -1) * (38 + (i % 3) * 20)
    const altAbove = overBay ? 18 + i * 5 : 30 + (i % 3) * 6
    return {
      ...built,
      cx: deps.cove.x + inDir.x * along + sideDir.x * across,
      cz: deps.cove.z + inDir.y * along + sideDir.y * across,
      rx: overBay ? 32 : 40 + (i % 3) * 14,
      rz: overBay ? 22 : 28 + ((i + 1) % 3) * 12,
      speed: (0.19 + (i % 3) * 0.035) * (i % 2 === 0 ? 1 : -1),
      phase: (i / birdCount) * TAU,
      altAbove,
      yaw: 0,
      roll: 0,
      pitch: 0,
      y: altAbove + 4,
    }
  })

  let cryTimer = rand(14, 28)

  function updateTropicbirds(dt: number, t: number, cam: THREE.Camera, daylight: number, storm: number) {
    const islandDist = Math.hypot(cam.position.x - deps.cove.x, cam.position.z - deps.cove.z)
    const active = islandDist < 620 && daylight > 0.08
    for (const b of tropicbirds) b.root.visible = active
    if (!active) return

    let nearestDist = Infinity
    for (let idx = 0; idx < tropicbirds.length; idx++) {
      const b = tropicbirds[idx]
      const a = t * b.speed + b.phase
      // Sweeping figure-eight / thermal arc
      const x = b.cx + Math.cos(a) * b.rx
      const z = b.cz + Math.sin(a) * b.rz + Math.sin(a * 2) * 8
      const vx = -Math.sin(a) * b.rx * b.speed
      const vz = (Math.cos(a) * b.rz + Math.cos(a * 2) * 16) * b.speed

      const ground = Math.max(0, deps.island.heightAt(x, z))
      const wantY = ground + b.altAbove + Math.sin(a * 2 + b.phase) * 3.8
      const prevY = b.y
      b.y = damp(b.y, wantY, 1.8, dt)

      const heading = Math.atan2(-vx, -vz)
      const dYaw = angleDelta(b.yaw, heading)
      b.yaw += dYaw
      const bankTarget = clamp((-dYaw / Math.max(dt, 1e-3)) * 0.42, -0.78, 0.78)
      b.roll = damp(b.roll, bankTarget, 3.2, dt)
      b.pitch = damp(b.pitch, clamp((b.y - prevY) / Math.max(dt * 8, 1e-3), -0.3, 0.3), 3, dt)

      // Alternate between crisp climbing wingbeats and long motionless banked glides
      const cycle = (t * 0.16 + b.phase) % 1
      const flapping = smooth(0.0, 0.08, cycle) * (1 - smooth(0.32, 0.42, cycle))
      const beat = Math.sin(t * 14.5 + b.phase * 5) * 0.58 * flapping
      const glideDihedral = 0.08 + Math.abs(b.roll) * 0.08
      b.wingL.rotation.x = glideDihedral + beat
      b.wingR.rotation.x = -(glideDihedral + beat)

      // Trailing tail streamers ripple with airspeed and bank
      const dBird = Math.hypot(x - cam.position.x, z - cam.position.z)
      if (dBird < nearestDist) nearestDist = dBird
      if (dBird < 220) {
        const pos = b.streamers.geometry.attributes.position as THREE.BufferAttribute
        const arr = pos.array as Float32Array
        for (let i = 0; i < pos.count; i++) {
          const rx = b.streamRest[i * 3]
          const u = clamp((-0.28 - rx) / b.streamLen, 0, 1)
          const wave = Math.sin(t * 8.5 - u * 5.2 + b.phase) * 0.052 * u * u
          const turnTrail = clamp(dYaw * 18, -0.25, 0.25) * u * u
          arr[i * 3] = rx
          arr[i * 3 + 1] = b.streamRest[i * 3 + 1] + wave
          arr[i * 3 + 2] = b.streamRest[i * 3 + 2] + turnTrail
        }
        pos.needsUpdate = true
      }

      b.root.position.set(x, b.y, z)
      dummy.rotation.set(0, 0, 0)
      dummy.rotateY(b.yaw + Math.PI / 2)
      dummy.rotateZ(b.pitch)
      dummy.rotateX(b.roll)
      b.root.quaternion.copy(dummy.quaternion)
    }

    cryTimer -= dt
    if (cryTimer <= 0) {
      if (nearestDist < 135 && storm < 0.45 && daylight > 0.22) {
        deps.onSeabirdCry?.(nearestDist)
        cryTimer = rand(18, 36)
      } else {
        cryTimer = 8
      }
    }
  }

  // —— B. Jewel dragonflies & water rings over inland rain pools ——
  const dfBodyMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.22,
    metalness: 0.65,
  })
  const dfWingMat = new THREE.MeshBasicMaterial({
    color: '#dff6ff',
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
    depthWrite: false,
  })

  type Dragonfly = {
    poolIdx: number
    built: ReturnType<typeof buildDragonfly>
    x: number
    y: number
    z: number
    tx: number
    ty: number
    tz: number
    yaw: number
    wait: number
    dipNext: boolean
    dipped: boolean
    phase: number
  }

  const dragonflies: Dragonfly[] = []
  const perPool = deps.lowPower ? 3 : 5
  deps.island.pools.forEach((pool, pIdx) => {
    for (let k = 0; k < perPool; k++) {
      const built = buildDragonfly(k % 2 === 0 ? 'emerald' : 'sapphire', dfBodyMat, dfWingMat)
      built.root.scale.setScalar(1.35)
      built.root.visible = false
      group.add(built.root)
      const a = (k / perPool) * TAU
      const r = 0.4 + (k % 3) * 0.35
      const sx = pool.x + Math.cos(a) * r
      const sz = pool.z + Math.sin(a) * r
      const sy = pool.y + 0.18 + (k % 3) * 0.12
      dragonflies.push({
        poolIdx: pIdx,
        built,
        x: sx,
        y: sy,
        z: sz,
        tx: sx,
        ty: sy,
        tz: sz,
        yaw: a,
        wait: rand(0.4, 1.8),
        dipNext: k === 0,
        dipped: false,
        phase: rand(0, TAU),
      })
    }
  })

  const POOL_RINGS = 8
  const poolRings = Array.from({ length: POOL_RINGS }, () => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.06, 0.085, 22),
      new THREE.MeshBasicMaterial({
        color: '#b8f0f5',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    m.rotation.x = -Math.PI / 2
    m.visible = false
    m.userData.noShadow = true
    group.add(m)
    return { mesh: m, age: 99, life: 1.5 }
  })
  let poolRingCursor = 0

  function spawnPoolRipple(x: number, y: number, z: number) {
    const r = poolRings[poolRingCursor]
    poolRingCursor = (poolRingCursor + 1) % POOL_RINGS
    r.age = 0
    r.mesh.position.set(x, y + 0.026, z)
    r.mesh.scale.setScalar(1)
    r.mesh.visible = true
  }

  function updateDragonflies(dt: number, t: number, cam: THREE.Camera, daylight: number, storm: number) {
    const pools = deps.island.pools
    if (pools.length === 0) return
    const activeWeather = daylight > 0.2 && storm < 0.45

    for (const d of dragonflies) {
      const pool = pools[d.poolIdx]
      const distSq = (cam.position.x - pool.x) ** 2 + (cam.position.z - pool.z) ** 2
      const show = activeWeather && distSq < 56 * 56
      d.built.root.visible = show
      if (!show) continue

      d.wait -= dt
      if (d.wait <= 0) {
        const a = Math.random() * TAU
        const rad = rand(0.15, 1.15)
        d.tx = pool.x + Math.cos(a) * rad
        d.tz = pool.z + Math.sin(a) * rad
        if (d.dipNext) {
          d.ty = pool.y + 0.045
          d.dipped = false
          d.dipNext = false
          d.wait = rand(0.45, 0.75)
        } else {
          d.ty = pool.y + rand(0.16, 0.52)
          d.dipNext = Math.random() < 0.3
          d.wait = rand(0.9, 2.2)
        }
        const dx = d.tx - d.x
        const dz = d.tz - d.z
        if (dx * dx + dz * dz > 1e-4) d.yaw = Math.atan2(-dx, -dz)
      }

      // Snap-dart between hover stations
      d.x = damp(d.x, d.tx, 9.5, dt)
      d.y = damp(d.y, d.ty, 9.5, dt)
      d.z = damp(d.z, d.tz, 9.5, dt)

      if (!d.dipped && d.ty < pool.y + 0.06 && Math.abs(d.y - d.ty) < 0.025) {
        d.dipped = true
        spawnPoolRipple(d.x, pool.y, d.z)
        d.ty = pool.y + rand(0.22, 0.45)
      }

      const hoverBob = Math.sin(t * 7.5 + d.phase) * 0.008
      const blur = Math.sin(t * 58 + d.phase) * 0.38
      d.built.fore.pivotL.rotation.x = blur
      d.built.fore.pivotR.rotation.x = -blur
      d.built.hind.pivotL.rotation.x = -blur * 0.9
      d.built.hind.pivotR.rotation.x = blur * 0.9

      d.built.root.position.set(d.x, d.y + hoverBob, d.z)
      d.built.root.rotation.set(0, d.yaw + Math.PI / 2, 0)
    }

    for (const r of poolRings) {
      if (!r.mesh.visible) continue
      r.age += dt
      const u = r.age / r.life
      if (u >= 1) {
        r.mesh.visible = false
        continue
      }
      r.mesh.scale.setScalar(1 + u * 6.5)
      ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - u) * (1 - u) * 0.65
    }
  }

  // —— C. Canopy & rain-pool fireflies (twilight & night) ——
  const ffCount = deps.lowPower ? 70 : 160
  const ffPos = new Float32Array(ffCount * 3)
  const ffAlpha = new Float32Array(ffCount)
  const ffSize = new Float32Array(ffCount)
  const ffCol = new Float32Array(ffCount * 3)

  type FireflySeed = { hx: number; hy: number; hz: number; phase: number; rate: number; wander: number }
  const ffSeeds: FireflySeed[] = []

  for (let i = 0; i < ffCount; i++) {
    let hx: number
    let hz: number
    // Anchor ~30% around the freshwater rain pools, ~70% through the cove palm grove & inland path
    if (deps.island.pools.length > 0 && i % 3 === 0) {
      const p = deps.island.pools[i % deps.island.pools.length]
      const a = (i * 2.399) % TAU
      const r = 1.5 + (i % 7) * 2.2
      hx = p.x + Math.cos(a) * r
      hz = p.z + Math.sin(a) * r
    } else {
      const along = 4 + ((i * 17) % 80)
      const across = (((i * 37) % 100) / 100 - 0.5) * 80
      hx = deps.cove.x + inDir.x * along + sideDir.x * across
      hz = deps.cove.z + inDir.y * along + sideDir.y * across
    }
    const g = Math.max(1.8, deps.island.heightAt(hx, hz))
    // Drift at head height and above, clear of the grass and shrub layer
    const hy = g + 1.4 + ((i * 13) % 10) * 0.26
    ffSeeds.push({
      hx,
      hy,
      hz,
      phase: (i * 1.618) % TAU,
      rate: 0.55 + ((i * 7) % 10) * 0.06,
      wander: 0.75 + (i % 5) * 0.25,
    })
    // Warm HDR amber-chartreuse glow so the post-process bloom gives a soft lantern halo
    const warmMix = (i % 4) * 0.08
    ffCol[i * 3] = 1.55 + warmMix * 0.75
    ffCol[i * 3 + 1] = 2.35 - warmMix * 0.35
    ffCol[i * 3 + 2] = 0.38
    ffSize[i] = 0.2 + (i % 3) * 0.05
  }

  const ffGeo = new THREE.BufferGeometry()
  ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPos, 3))
  ffGeo.setAttribute('aAlpha', new THREE.BufferAttribute(ffAlpha, 1))
  ffGeo.setAttribute('aSize', new THREE.BufferAttribute(ffSize, 1))
  ffGeo.setAttribute('aColor', new THREE.BufferAttribute(ffCol, 3))

  const glowMat = (maxSize: number) =>
    new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: deps.pixelRatio },
        uMaxSize: { value: maxSize },
      },
      vertexShader: glowVertex,
      fragmentShader: glowFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

  const glowGroup = new THREE.Group()
  glowGroup.name = 'IslandGlow'
  scene.add(glowGroup)

  const ffPoints = new THREE.Points(ffGeo, glowMat(42.0))
  ffPoints.frustumCulled = false
  ffPoints.renderOrder = 6
  ffPoints.visible = false
  glowGroup.add(ffPoints)

  let whisperedFireflies = false

  function updateFireflies(
    t: number,
    cam: THREE.Camera,
    daylight: number,
    storm: number,
    underwater: boolean,
    walking: boolean,
  ) {
    const duskGlow = (1 - smooth(0.12, 0.44, daylight)) * (1 - storm * 0.85)
    const nearIsland = Math.hypot(cam.position.x - deps.cove.x, cam.position.z - deps.cove.z) < 260
    ffPoints.visible = !underwater && duskGlow > 0.02 && nearIsland
    if (!ffPoints.visible) return

    let closeLit = 0
    for (let i = 0; i < ffCount; i++) {
      const s = ffSeeds[i]
      const x = s.hx + Math.sin(t * 0.42 + s.phase) * s.wander
      const y = s.hy + Math.sin(t * 0.68 + s.phase * 1.7) * 0.32
      const z = s.hz + Math.cos(t * 0.37 + s.phase * 1.3) * s.wander
      ffPos[i * 3] = x
      ffPos[i * 3 + 1] = y
      ffPos[i * 3 + 2] = z

      // Organic firefly lantern pulse: warm swell with a soft lingering ember glow
      const wave = Math.sin(t * s.rate * 2.2 + s.phase) * 0.5 + 0.5
      const flash = 0.16 + 0.84 * Math.pow(wave, 2.2)
      const dSq = (x - cam.position.x) ** 2 + (z - cam.position.z) ** 2
      const rangeFade = 1 - smooth(85 * 85, 165 * 165, dSq)
      ffAlpha[i] = flash * duskGlow * rangeFade
      if (dSq < 18 * 18 && ffAlpha[i] > 0.35) closeLit++
    }
    ffGeo.attributes.position.needsUpdate = true
    ffGeo.attributes.aAlpha.needsUpdate = true

    if (!whisperedFireflies && walking && duskGlow > 0.6 && closeLit >= 2) {
      whisperedFireflies = true
      deps.hud.whisper('Small lights drift under the trees.')
    }
  }

  // —— D. Noctiluca sea-sparkle (bioluminescent plankton wake at night) ——
  const bioMax = deps.lowPower ? 260 : 560
  const bioPos = new Float32Array(bioMax * 3)
  const bioVel = new Float32Array(bioMax * 3)
  const bioAlpha = new Float32Array(bioMax)
  const bioSize = new Float32Array(bioMax)
  const bioCol = new Float32Array(bioMax * 3)
  const bioAge = new Float32Array(bioMax).fill(99)
  const bioLife = new Float32Array(bioMax).fill(1)

  const bioGeo = new THREE.BufferGeometry()
  bioGeo.setAttribute('position', new THREE.BufferAttribute(bioPos, 3))
  bioGeo.setAttribute('aAlpha', new THREE.BufferAttribute(bioAlpha, 1))
  bioGeo.setAttribute('aSize', new THREE.BufferAttribute(bioSize, 1))
  bioGeo.setAttribute('aColor', new THREE.BufferAttribute(bioCol, 3))

  const bioPoints = new THREE.Points(bioGeo, glowMat(7.5))
  bioPoints.frustumCulled = false
  bioPoints.renderOrder = 6
  bioPoints.visible = false
  glowGroup.add(bioPoints)

  let bioCursor = 0
  let currentBiolum = 0
  let currentTime = 0
  let strokeSpawnAcc = 0
  let whisperedBio = false
  // Sparks ride a film just above the surface when seen from the air (the water
  // surface is opaque to depth), and just beneath it when seen from below
  let bioLift = 0.06

  function disturbWater(x: number, z: number, power = 1) {
    if (currentBiolum < 0.04) return
    const n = Math.min(48, Math.max(4, Math.round(power * (deps.lowPower ? 14 : 26))))
    for (let k = 0; k < n; k++) {
      const i = bioCursor
      bioCursor = (bioCursor + 1) % bioMax
      const a = Math.random() * TAU
      const r = rand(0.06, 1.35 * Math.sqrt(power))
      bioPos[i * 3] = x + Math.cos(a) * r
      bioPos[i * 3 + 2] = z + Math.sin(a) * r
      bioPos[i * 3 + 1] = sampleOcean(bioPos[i * 3], bioPos[i * 3 + 2], currentTime).y + bioLift
      const spd = rand(0.22, 0.95) * Math.sqrt(power)
      bioVel[i * 3] = Math.cos(a) * spd
      bioVel[i * 3 + 1] = 0
      bioVel[i * 3 + 2] = Math.sin(a) * spd
      bioAge[i] = 0
      bioLife[i] = rand(1.2, 2.5)
      bioSize[i] = rand(0.038, 0.088)
      // Saturated electric turquoise-sapphire sparks (low R prevents additive white blowout)
      const cyanShift = Math.random()
      bioCol[i * 3] = 0.02 + cyanShift * 0.06
      bioCol[i * 3 + 1] = 0.58 + cyanShift * 0.36
      bioCol[i * 3 + 2] = 1.22 + cyanShift * 0.28
    }
  }

  function updateBiolum(
    dt: number,
    t: number,
    cam: THREE.Camera,
    biolum: number,
    underwater: boolean,
    playerActivity: { x: number; y: number; z: number; moving: number; inSea: boolean },
  ) {
    currentBiolum = biolum
    currentTime = t
    bioLift = underwater ? -0.08 : 0.06
    if (biolum < 0.03) {
      bioPoints.visible = false
      return
    }

    // Swimmer's own strokes / wading stir glowing plankton trails around them
    if (playerActivity.inSea && playerActivity.moving > 0.12) {
      strokeSpawnAcc += dt * playerActivity.moving * (deps.lowPower ? 16 : 30)
      while (strokeSpawnAcc >= 1) {
        strokeSpawnAcc -= 1
        const a = Math.random() * TAU
        const rad = rand(0.28, 1.35)
        disturbWater(
          playerActivity.x + Math.cos(a) * rad,
          playerActivity.z + Math.sin(a) * rad,
          0.22,
        )
      }
      if (!whisperedBio && biolum > 0.45 && playerActivity.moving > 0.45) {
        whisperedBio = true
        deps.hud.whisper('Every stroke wakes pale fire in the dark water.')
      }
    }

    let anyLive = false
    for (let i = 0; i < bioMax; i++) {
      if (bioAge[i] >= bioLife[i]) {
        bioAlpha[i] = 0
        continue
      }
      anyLive = true
      bioAge[i] += dt
      const u = bioAge[i] / bioLife[i]
      const drag = Math.exp(-1.9 * dt)
      bioVel[i * 3] *= drag
      bioVel[i * 3 + 2] *= drag
      bioPos[i * 3] += bioVel[i * 3] * dt
      bioPos[i * 3 + 2] += bioVel[i * 3 + 2] * dt
      // Ride the live swell surface
      const surf = sampleOcean(bioPos[i * 3], bioPos[i * 3 + 2], t).y
      bioPos[i * 3 + 1] = surf + bioLift
      const dSq = (bioPos[i * 3] - cam.position.x) ** 2 + (bioPos[i * 3 + 2] - cam.position.z) ** 2
      const rangeFade = 1 - smooth(65 * 65, 130 * 130, dSq)
      bioAlpha[i] = smooth(0, 0.1, u) * Math.pow(1 - u, 1.6) * biolum * rangeFade
    }

    bioPoints.visible = anyLive
    if (anyLive) {
      bioGeo.attributes.position.needsUpdate = true
      bioGeo.attributes.aAlpha.needsUpdate = true
      bioGeo.attributes.aSize.needsUpdate = true
      bioGeo.attributes.aColor.needsUpdate = true
    }
  }

  function update(
    dt: number,
    t: number,
    camera: THREE.Camera,
    state: {
      daylight: number
      storm: number
      biolum: number
      underwater: boolean
      walking: boolean
      playerX: number
      playerY: number
      playerZ: number
      moving: number
      inSea: boolean
    },
  ) {
    updateTropicbirds(dt, t, camera, state.daylight, state.storm)
    updateDragonflies(dt, t, camera, state.daylight, state.storm)
    updateFireflies(t, camera, state.daylight, state.storm, state.underwater, state.walking)
    updateBiolum(dt, t, camera, state.biolum, state.underwater, {
      x: state.playerX,
      y: state.playerY,
      z: state.playerZ,
      moving: state.moving,
      inSea: state.inSea,
    })
  }

  function setPixelRatio(pr: number) {
    ;(ffPoints.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = pr
    ;(bioPoints.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = pr
  }

  return {
    group,
    glowGroup,
    update,
    disturbWater,
    setPixelRatio,
    tropicbirds,
    dragonflies,
  }
}

export type IslandLife = ReturnType<typeof createIslandLife>
