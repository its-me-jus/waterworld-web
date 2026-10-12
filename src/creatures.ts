import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { sampleOcean } from './waves'

/**
 * Larger sea life — the things you stop swimming to watch.
 *
 *  - A dolphin pod that comes through every minute or two, porpoising across
 *    the swell in long arcs, and leaves.
 *  - Sea turtles that drift around the wreck reef and the island shelf.
 *  - Manta rays gliding in the blue off the wreck.
 *
 * None of it reacts to you or asks anything of you. They are modelled as plain
 * stylised forms (like the rest of the world) and animated by bending the mesh
 * along its length, which is all it takes to read as a swimming animal.
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
/** Shortest signed angle from a to b. */
const angleDelta = (a: number, b: number) => ((b - a + Math.PI * 3) % TAU) - Math.PI

/** Vertex colours are read in working (linear) space, so go through Color. */
function paint(geo: THREE.BufferGeometry, pick: (x: number, y: number, z: number, ny: number) => THREE.Color) {
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

// —— dolphin ———————————————————————————————————————————————————

const DOLPHIN_LENGTH = 2.5

function buildDolphin() {
  // Radius along the body, nose to tail
  const profile = new THREE.SplineCurve(
    [
      [0.0, 0.0],
      [0.025, 0.032],
      [0.09, 0.052],
      [0.16, 0.115],
      [0.25, 0.195],
      [0.38, 0.255],
      [0.52, 0.24],
      [0.68, 0.172],
      [0.82, 0.098],
      [0.93, 0.055],
      [1.0, 0.04],
    ].map(([u, r]) => new THREE.Vector2(u, r)),
  ).getPoints(44)
  const rings = profile.length
  const radial = 14
  const L = DOLPHIN_LENGTH

  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i < rings; i++) {
    const { x: u, y: r } = profile[i]
    const x = L * (0.5 - u)
    // The belly hangs a touch lower than the back rises
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * TAU
      positions.push(x, Math.cos(a) * r * (Math.cos(a) > 0 ? 1.0 : 0.9) - r * 0.04, Math.sin(a) * r * 0.92)
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

  const extrude = (shape: THREE.Shape, depth: number) => {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 6 })
    g.translate(0, 0, -depth / 2)
    return g
  }

  // Dorsal fin: a swept-back crescent
  const dorsalShape = new THREE.Shape()
  dorsalShape.moveTo(0.12, 0)
  dorsalShape.quadraticCurveTo(-0.02, 0.2, -0.3, 0.34)
  dorsalShape.quadraticCurveTo(-0.22, 0.14, -0.38, 0)
  dorsalShape.lineTo(0.12, 0)
  const dorsal = extrude(dorsalShape, 0.025)
  dorsal.translate(L * (0.5 - 0.46), 0.2, 0)

  // Pectorals: swept paddles, one each side
  const finShape = new THREE.Shape()
  finShape.moveTo(0.05, 0)
  finShape.quadraticCurveTo(-0.08, -0.12, -0.3, -0.3)
  finShape.quadraticCurveTo(-0.16, -0.08, -0.14, 0)
  finShape.lineTo(0.05, 0)
  const finA = extrude(finShape, 0.02)
  finA.rotateX(-0.9)
  finA.translate(L * (0.5 - 0.3), -0.1, 0.17)
  const finB = extrude(finShape, 0.02)
  finB.rotateX(0.9)
  finB.translate(L * (0.5 - 0.3), -0.1, -0.17)

  // Flukes: two broad lobes with a notch between them
  const flukeShape = new THREE.Shape()
  const lobe: [number, number][] = [
    [0.06, 0.03],
    [-0.05, 0.14],
    [-0.2, 0.36],
    [-0.3, 0.42],
    [-0.21, 0.28],
    [-0.13, 0.1],
    [-0.11, 0.0],
  ]
  flukeShape.moveTo(lobe[0][0], lobe[0][1])
  for (const [x, y] of lobe.slice(1)) flukeShape.lineTo(x, y)
  for (const [x, y] of [...lobe].reverse().slice(1)) flukeShape.lineTo(x, -y)
  const flukes = extrude(flukeShape, 0.022)
  flukes.rotateX(Math.PI / 2)
  flukes.translate(-L * 0.5 + 0.02, -0.01, 0)

  const parts = [body, dorsal, finA, finB, flukes].map((g) => (g.index ? g.toNonIndexed() : g))
  for (const g of parts) {
    if (!g.attributes.normal) g.computeVertexNormals()
    g.deleteAttribute('uv')
  }
  const merged = mergeGeometries(parts, false) as THREE.BufferGeometry
  merged.computeVertexNormals()

  const back = new THREE.Color('#566f82')
  const cape = new THREE.Color('#7f98a8')
  const belly = new THREE.Color('#dde5e8')
  const fin = new THREE.Color('#465d6e')
  const tmp = new THREE.Color()
  paint(merged, (x, y, z, ny) => {
    // Fins and flukes sit outside the body envelope — colour them darker
    const outside = Math.abs(z) > 0.2 || y > 0.28 || x < -L * 0.5 + 0.06
    if (outside) return tmp.copy(fin)
    const t = smooth(-0.35, 0.3, ny)
    tmp.copy(belly).lerp(cape, smooth(-0.35, 0.05, ny)).lerp(back, smooth(0.1, 0.6, ny) * t)
    return tmp
  })
  return merged
}

// —— manta ray ——————————————————————————————————————————————————

function buildManta() {
  const span = 1.9
  const nU = 22
  const nV = 9
  const sheet = (sign: number) => {
    const pos: number[] = []
    const idx: number[] = []
    for (let i = 0; i <= nU; i++) {
      const u = (i / nU) * 2 - 1
      const au = Math.abs(u)
      // Leading edge sweeps back toward the wingtip; trailing edge stays near the body
      const lead = 0.62 * (1 - Math.pow(au, 1.5)) - 0.1 * au
      const trail = -0.42 * (1 - Math.pow(au, 0.9)) - 0.06 * au
      for (let j = 0; j <= nV; j++) {
        const v = j / nV
        const x = THREE.MathUtils.lerp(trail, lead, v)
        const thick = 0.17 * Math.pow(1 - au, 1.35) * Math.pow(Math.sin(Math.PI * (0.12 + v * 0.8)), 0.7)
        pos.push(x, sign * thick, u * span)
      }
    }
    for (let i = 0; i < nU; i++) {
      for (let j = 0; j < nV; j++) {
        const a = i * (nV + 1) + j
        const b = a + 1
        const c = a + (nV + 1)
        const d = c + 1
        if (sign > 0) idx.push(a, b, c, b, d, c)
        else idx.push(a, c, b, b, c, d)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(idx)
    return g.toNonIndexed()
  }
  const top = sheet(1)
  const bottom = sheet(-1)

  // Tail: a thin whip trailing behind
  const tail = new THREE.ConeGeometry(0.035, 1.6, 5, 1)
  tail.rotateZ(Math.PI / 2) // tip toward -x
  tail.translate(-0.42 - 0.8, 0, 0)
  const tailGeo = tail.toNonIndexed()

  const parts = [top, bottom, tailGeo]
  for (const g of parts) {
    g.deleteAttribute('uv')
    g.computeVertexNormals()
  }
  const merged = mergeGeometries(parts, false) as THREE.BufferGeometry
  merged.computeVertexNormals()

  const dark = new THREE.Color('#273746')
  const light = new THREE.Color('#e4eaee')
  const patch = new THREE.Color('#aab8c2')
  const tmp = new THREE.Color()
  paint(merged, (x, _y, z, ny) => {
    if (ny < -0.1) return tmp.copy(light).lerp(patch, smooth(1.0, 1.9, Math.abs(z)) * 0.5)
    return tmp.copy(dark).lerp(patch, smooth(0.2, 0.55, -x) * 0.18)
  })
  return merged
}

// —— sea turtle ——————————————————————————————————————————————————

type Turtle = {
  group: THREE.Group
  frontL: THREE.Group
  frontR: THREE.Group
  rearL: THREE.Group
  rearR: THREE.Group
  head: THREE.Mesh
  home: THREE.Vector2
  radius: number
  heading: number
  turn: number
  depth: number
  phase: number
  x: number
  z: number
  y: number
  pitch: number
}

function buildTurtle(): Omit<Turtle, 'home' | 'radius' | 'heading' | 'turn' | 'depth' | 'phase' | 'x' | 'z' | 'y' | 'pitch'> {
  const group = new THREE.Group()
  const shellMat = new THREE.MeshStandardMaterial({ color: '#6f6a3c', roughness: 0.6, flatShading: true })
  const skinMat = new THREE.MeshStandardMaterial({ color: '#7e8a58', roughness: 0.7 })
  const bellyMat = new THREE.MeshStandardMaterial({ color: '#d9ca94', roughness: 0.8 })

  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 9), shellMat)
  shell.scale.set(1.0, 0.36, 0.82)
  shell.position.y = 0.04
  group.add(shell)
  // Ridged scutes along the carapace
  for (let i = 0; i < 3; i++) {
    const ridge = new THREE.Mesh(new THREE.SphereGeometry(0.17, 7, 5), shellMat)
    ridge.scale.set(1.1, 0.5, 0.9)
    ridge.position.set(0.27 - i * 0.27, 0.2, 0)
    group.add(ridge)
  }
  const plastron = new THREE.Mesh(new THREE.SphereGeometry(0.46, 12, 6, 0, TAU, Math.PI / 2, Math.PI / 2), bellyMat)
  plastron.scale.set(1.0, 0.3, 0.78)
  plastron.position.y = 0.02
  group.add(plastron)

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 9, 7), skinMat)
  head.scale.set(1.3, 0.9, 0.95)
  head.position.set(0.58, 0.04, 0)
  group.add(head)
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.22, 7), skinMat)
  neck.rotation.z = Math.PI / 2
  neck.position.set(0.47, 0.04, 0)
  group.add(neck)

  const flipper = (len: number, wid: number, x: number, z: number, side: number, yaw: number) => {
    const pivot = new THREE.Group()
    pivot.position.set(x, 0.0, z * side)
    const blade = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 5), skinMat)
    // Sphere scaled into a paddle, hinged at its root
    const half = len * 0.5
    blade.scale.set(wid, 0.045, half)
    blade.position.z = half * side * 0.9
    pivot.add(blade)
    pivot.rotation.y = yaw * side
    group.add(pivot)
    return pivot
  }
  const frontL = flipper(0.42, 0.13, 0.28, 0.36, 1, -0.45)
  const frontR = flipper(0.42, 0.13, 0.28, 0.36, -1, -0.45)
  const rearL = flipper(0.2, 0.09, -0.4, 0.22, 1, 0.5)
  const rearR = flipper(0.2, 0.09, -0.4, 0.22, -1, 0.5)

  return { group, frontL, frontR, rearL, rearR, head }
}

// —— splashes ————————————————————————————————————————————————————

const dropVertex = /* glsl */ `
attribute float aAlpha;
attribute float aSize;
varying float vAlpha;
uniform float uPixelRatio;
void main() {
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio * (60.0 / max(-mv.z, 1.0));
}
`
const dropFragment = /* glsl */ `
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;
  float a = (1.0 - r2 * 4.0);
  gl_FragColor = vec4(vec3(0.93, 0.97, 1.0), a * a * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const MAX_DROPS = 220
const MAX_RINGS = 8

function createSplashes(scene: THREE.Scene, pixelRatio: number) {
  const pos = new Float32Array(MAX_DROPS * 3)
  const alpha = new Float32Array(MAX_DROPS)
  const size = new Float32Array(MAX_DROPS)
  const vel = new Float32Array(MAX_DROPS * 3)
  const life = new Float32Array(MAX_DROPS)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1))
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: pixelRatio } },
    vertexShader: dropVertex,
    fragmentShader: dropFragment,
    transparent: true,
    depthWrite: false,
    fog: false,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = 4
  scene.add(points)
  let cursor = 0

  // Spreading foam rings on the surface
  const ringMat = () =>
    new THREE.MeshBasicMaterial({
      color: '#eaf6fa',
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    })
  const rings = Array.from({ length: MAX_RINGS }, () => {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 28), ringMat())
    mesh.rotation.x = -Math.PI / 2
    mesh.visible = false
    scene.add(mesh)
    return { mesh, age: 99, max: 1.6, scale: 1 }
  })
  let ringCursor = 0

  function burst(x: number, y: number, z: number, power: number, upward: number) {
    const n = Math.round(10 + power * 12)
    for (let k = 0; k < n; k++) {
      const i = cursor
      cursor = (cursor + 1) % MAX_DROPS
      const a = Math.random() * TAU
      const s = rand(0.4, 1.9) * power
      pos[i * 3] = x + Math.cos(a) * 0.25
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z + Math.sin(a) * 0.25
      vel[i * 3] = Math.cos(a) * s
      vel[i * 3 + 1] = rand(1.8, 4.6) * upward
      vel[i * 3 + 2] = Math.sin(a) * s
      life[i] = 1
      size[i] = rand(0.07, 0.19)
    }
    const r = rings[ringCursor]
    ringCursor = (ringCursor + 1) % MAX_RINGS
    r.age = 0
    r.max = 1.5 + power * 0.8
    r.scale = 0.7 + power * 0.7
    r.mesh.position.set(x, y + 0.03, z)
    r.mesh.visible = true
  }

  function update(dt: number, surface: (x: number, z: number) => number) {
    for (let i = 0; i < MAX_DROPS; i++) {
      if (life[i] <= 0) {
        alpha[i] = 0
        continue
      }
      vel[i * 3 + 1] -= 9.8 * dt
      pos[i * 3] += vel[i * 3] * dt
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt
      life[i] -= dt * 0.55
      alpha[i] = Math.max(0, Math.min(1, life[i] * 1.6)) * 0.85
      if (pos[i * 3 + 1] < surface(pos[i * 3], pos[i * 3 + 2]) - 0.05 && vel[i * 3 + 1] < 0) life[i] = 0
    }
    geo.attributes.position.needsUpdate = true
    geo.attributes.aAlpha.needsUpdate = true
    geo.attributes.aSize.needsUpdate = true

    for (const r of rings) {
      if (!r.mesh.visible) continue
      r.age += dt
      const f = r.age / r.max
      if (f >= 1) {
        r.mesh.visible = false
        continue
      }
      const sc = r.scale * (0.4 + f * 3.2)
      r.mesh.scale.set(sc, sc, sc)
      r.mesh.position.y = surface(r.mesh.position.x, r.mesh.position.z) + 0.04
      ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - f) * (1 - f) * 0.55
    }
  }

  return { burst, update }
}

// —— the whole cast ——————————————————————————————————————————————

export type CreatureDeps = {
  /** World position of the wreck's reef, where turtles and rays hang about. */
  wreckCentre: THREE.Vector3
  wreckResolve: (p: { x: number; y: number; z: number }) => void
  island: {
    centre: THREE.Vector3
    heightAt: (x: number, z: number) => number
    resolve: (p: { x: number; y: number; z: number }) => void
  }
  /** A shore point on the landing cove, to keep a turtle near the beach. */
  cove: { x: number; z: number }
  lowPower: boolean
  pixelRatio: number
}

type Dolphin = {
  mesh: THREE.Mesh
  rest: Float32Array
  /** Offset from the pod leader, in the pod's own frame (forward, right). */
  fwd: number
  right: number
  phase: number
  y: number
  lastS: number
  pitch: number
}

type Pod = {
  x: number
  z: number
  heading: number
  speed: number
  age: number
  life: number
  dolphins: Dolphin[]
}

type Manta = {
  mesh: THREE.Mesh
  rest: Float32Array
  centre: THREE.Vector2
  rx: number
  rz: number
  speed: number
  offset: number
  depth: number
  phase: number
  yaw: number
  roll: number
}

export function createCreatures(scene: THREE.Scene, deps: CreatureDeps) {
  const group = new THREE.Group()
  scene.add(group)
  const splashes = createSplashes(scene, deps.pixelRatio)

  const bodyMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.38,
    metalness: 0.0,
    side: THREE.DoubleSide,
  })

  // —— dolphins ——
  const dolphinGeo = buildDolphin()
  const dolphinRest = Float32Array.from(dolphinGeo.attributes.position.array as Float32Array)
  const podSize = deps.lowPower ? 3 : 4
  let pod: Pod | null = null
  let podTimer = rand(22, 38)
  const spawnPod = (camera: THREE.Camera) => {
    const forward = new THREE.Vector3()
    camera.getWorldDirection(forward)
    forward.y = 0
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1)
    forward.normalize()
    // Somewhere ahead, to either side, so a glance in front of you finds them
    const bearing = (Math.random() < 0.5 ? -1 : 1) * rand(0.25, 0.8)
    const dir = forward.clone().applyAxisAngle(UP, bearing)
    const dist = rand(15, 30)
    const cx = camera.position.x + dir.x * dist
    const cz = camera.position.z + dir.z * dist
    // Cross in front of the swimmer rather than swim at or away from them
    const side = Math.random() < 0.5 ? 1 : -1
    const heading = Math.atan2(-dir.x, -dir.z) + side * (Math.PI / 2 + rand(-0.35, 0.35))
    const speed = rand(5.5, 6.8)
    const life = 28
    const hx = -Math.sin(heading)
    const hz = -Math.cos(heading)
    const dolphins: Dolphin[] = []
    for (let i = 0; i < podSize; i++) {
      const geo = dolphinGeo.clone()
      const mesh = new THREE.Mesh(geo, bodyMat)
      mesh.frustumCulled = false
      mesh.scale.setScalar(rand(1.0, 1.2) * (i === 0 ? 1.1 : 1))
      mesh.visible = false
      group.add(mesh)
      dolphins.push({
        mesh,
        rest: dolphinRest,
        fwd: -i * rand(2.5, 4) + rand(-1, 1),
        right: (i - (podSize - 1) / 2) * rand(4.5, 6.5),
        phase: i * 0.16 + rand(0, 0.08),
        y: -2,
        lastS: 0,
        pitch: 0,
      })
    }
    pod = {
      // Most of the pod's time is spent near you, not out at the horizon
      x: cx - hx * speed * life * 0.38,
      z: cz - hz * speed * life * 0.38,
      heading,
      speed,
      age: 0,
      life,
      dolphins,
    }
  }

  const disposePod = () => {
    if (!pod) return
    for (const d of pod.dolphins) {
      group.remove(d.mesh)
      d.mesh.geometry.dispose()
    }
    pod = null
  }

  const dummy = new THREE.Object3D()
  const surfaceFn = (time: number) => (x: number, z: number) => sampleOcean(x, z, time).y

  function updatePod(dt: number, t: number, cam: THREE.Camera) {
    if (!pod) return
    pod.age += dt
    const hx = -Math.sin(pod.heading)
    const hz = -Math.cos(pod.heading)
    const rx = -hz
    const rz = hx
    pod.x += hx * pod.speed * dt
    pod.z += hz * pod.speed * dt
    const freq = 0.5
    const airborne = 0.42
    // Fade the pod in and out by sinking it rather than popping it
    const edge = smooth(0, 3, pod.age) * smooth(0, 3, pod.life - pod.age)
    for (const d of pod.dolphins) {
      const wx = pod.x + hx * d.fwd + rx * d.right
      const wz = pod.z + hz * d.fwd + rz * d.right
      const s = (((pod.age * freq + d.phase) % 1) + 1) % 1
      let h: number
      if (s < airborne) h = 1.55 * Math.sin((Math.PI * s) / airborne)
      else h = -1.4 * Math.sin((Math.PI * (s - airborne)) / (1 - airborne))
      h = h * edge - (1 - edge) * 2.4
      const surface = sampleOcean(wx, wz, t).y
      const y = surface + h + 0.05
      const vy = (y - d.y) / Math.max(dt, 1e-3)
      d.pitch = damp(d.pitch, Math.atan2(clamp(vy, -9, 9), pod.speed), 10, dt)
      // Breaking the surface throws spray
      if (d.lastS >= airborne && s < d.lastS && s < 0.2 && edge > 0.8) {
        // came up through the surface
        splashes.burst(wx, surface, wz, 0.8, 1)
      }
      if (d.lastS < airborne && s >= airborne && edge > 0.8) {
        splashes.burst(wx - hx * 0.6, surface, wz - hz * 0.6, 1.0, 1)
      }
      d.lastS = s
      d.y = y

      const swim = pod.age * 7 + d.phase * 30
      const pos = d.mesh.geometry.attributes.position as THREE.BufferAttribute
      const arr = pos.array as Float32Array
      const L = DOLPHIN_LENGTH
      for (let i = 0; i < pos.count; i++) {
        const x = d.rest[i * 3]
        const u = clamp(0.5 - x / L, 0, 1.4)
        const w = Math.pow(smooth(0.3, 1.25, u), 1.3)
        arr[i * 3] = x
        arr[i * 3 + 1] = d.rest[i * 3 + 1] + Math.sin(swim - u * 3.4) * 0.2 * w
        arr[i * 3 + 2] = d.rest[i * 3 + 2]
      }
      pos.needsUpdate = true

      d.mesh.position.set(wx, y, wz)
      // Model faces +x; the heading faces (-sin, -cos)
      dummy.rotation.set(0, 0, 0)
      dummy.rotateY(pod.heading + Math.PI / 2)
      dummy.rotateZ(d.pitch)
      d.mesh.quaternion.copy(dummy.quaternion)
      d.mesh.visible = h > -2.2 && cam.position.distanceToSquared(d.mesh.position) < 400 * 400
    }
    if (pod.age >= pod.life) disposePod()
  }

  // —— turtles ——
  const turtles: Turtle[] = []
  const addTurtle = (hx: number, hz: number, radius: number, depth: number) => {
    const parts = buildTurtle()
    const heading = rand(0, TAU)
    const t: Turtle = {
      ...parts,
      home: new THREE.Vector2(hx, hz),
      radius,
      heading,
      turn: 0,
      depth,
      phase: rand(0, TAU),
      x: hx + rand(-6, 6),
      z: hz + rand(-6, 6),
      y: -depth,
      pitch: 0,
    }
    t.group.scale.setScalar(rand(0.95, 1.25))
    group.add(t.group)
    turtles.push(t)
  }
  const w = deps.wreckCentre
  addTurtle(w.x + 8, w.z + 6, 22, 4.5)
  addTurtle(w.x - 10, w.z - 8, 18, 6.5)
  addTurtle(deps.cove.x - 30, deps.cove.z + 26, 26, 3.2)
  if (!deps.lowPower) addTurtle(deps.island.centre.x - 150, deps.island.centre.z + 60, 30, 4)

  const probe = { x: 0, y: 0, z: 0 }
  function updateTurtle(tu: Turtle, dt: number, t: number, cam: THREE.Camera) {
    const dx = tu.x - cam.position.x
    const dz = tu.z - cam.position.z
    const near = dx * dx + dz * dz < 260 * 260
    tu.group.visible = near
    if (!near) return

    // A lazy, wandering heading that drifts back toward home when it strays
    tu.turn = damp(tu.turn, Math.sin(t * 0.13 + tu.phase) * 0.25 + Math.sin(t * 0.31 + tu.phase * 2) * 0.12, 0.8, dt)
    const toHome = Math.atan2(-(tu.home.x - tu.x), -(tu.home.y - tu.z))
    const dist = Math.hypot(tu.home.x - tu.x, tu.home.y - tu.z)
    let steer = tu.turn
    if (dist > tu.radius) steer += clamp(angleDelta(tu.heading, toHome), -1, 1) * 0.9
    // Shallow or rock-bound: turn away from the island shelf
    const ahead = deps.island.heightAt(tu.x - Math.sin(tu.heading) * 5, tu.z - Math.cos(tu.heading) * 5)
    if (ahead > -2.2) steer += 1.4
    tu.heading += steer * dt
    const speed = 0.9 + Math.sin(t * 0.4 + tu.phase) * 0.15
    tu.x -= Math.sin(tu.heading) * speed * dt
    tu.z -= Math.cos(tu.heading) * speed * dt

    const surface = sampleOcean(tu.x, tu.z, t).y
    const floor = deps.island.heightAt(tu.x, tu.z)
    const targetDepth = tu.depth + Math.sin(t * 0.11 + tu.phase * 1.7) * 1.4
    const targetY = Math.max(surface - targetDepth, floor + 1.0)
    const prevY = tu.y
    tu.y = damp(tu.y, targetY, 0.6, dt)
    tu.pitch = damp(tu.pitch, Math.atan2(tu.y - prevY, speed * dt) * 0.5, 3, dt)

    probe.x = tu.x
    probe.y = tu.y
    probe.z = tu.z
    deps.wreckResolve(probe)
    deps.island.resolve(probe)
    tu.x = probe.x
    tu.y = Math.min(probe.y, surface - 0.9)
    tu.z = probe.z

    tu.group.position.set(tu.x, tu.y, tu.z)
    dummy.rotation.set(0, 0, 0)
    dummy.rotateY(tu.heading + Math.PI / 2)
    dummy.rotateZ(tu.pitch)
    dummy.rotateX(Math.sin(t * 0.7 + tu.phase) * 0.06)
    tu.group.quaternion.copy(dummy.quaternion)

    // Slow, heavy rowing strokes — the front pair together, the rear ones lagging
    const stroke = t * 1.15 + tu.phase
    const flap = Math.sin(stroke)
    tu.frontL.rotation.x = flap * 0.55
    tu.frontR.rotation.x = -flap * 0.55
    tu.rearL.rotation.x = Math.sin(stroke - 0.9) * 0.3
    tu.rearR.rotation.x = -Math.sin(stroke - 0.9) * 0.3
    tu.head.position.y = 0.04 + Math.sin(stroke * 0.5) * 0.015
  }

  // —— manta rays ——
  const mantaGeo = buildManta()
  const mantaRest = Float32Array.from(mantaGeo.attributes.position.array as Float32Array)
  const mantas: Manta[] = []
  const mantaCount = deps.lowPower ? 1 : 2
  for (let i = 0; i < mantaCount; i++) {
    const mesh = new THREE.Mesh(mantaGeo.clone(), bodyMat)
    mesh.frustumCulled = false
    mesh.scale.setScalar(rand(1.15, 1.5))
    group.add(mesh)
    mantas.push({
      mesh,
      rest: mantaRest,
      // Out over open sand and blue water, well clear of the reef's rock
      centre: new THREE.Vector2(w.x + (i === 0 ? 70 : -62), w.z + (i === 0 ? 24 : 40)),
      rx: rand(26, 34),
      rz: rand(20, 28),
      speed: rand(0.045, 0.06) * (i === 0 ? 1 : -1),
      offset: rand(0, TAU),
      depth: 6.5 + i * 2.5,
      phase: rand(0, TAU),
      yaw: 0,
      roll: 0,
    })
  }

  function updateManta(m: Manta, dt: number, t: number, cam: THREE.Camera) {
    // An unhurried ellipse around the reef, rising and falling a little
    const a = t * m.speed + m.offset
    const x = m.centre.x + Math.cos(a) * m.rx
    const z = m.centre.y + Math.sin(a) * m.rz
    const dx = -Math.sin(a) * m.rx * m.speed
    const dz = Math.cos(a) * m.rz * m.speed
    const heading = Math.atan2(-dx, -dz)
    const dHead = angleDelta(m.yaw, heading)
    m.yaw += dHead
    m.roll = damp(m.roll, clamp(dHead / Math.max(dt, 1e-3), -1.2, 1.2) * -0.3, 2.5, dt)

    const surface = sampleOcean(x, z, t).y
    const y = surface - (m.depth + Math.sin(t * 0.09 + m.phase) * 1.6)
    const dxc = x - cam.position.x
    const dzc = z - cam.position.z
    const near = dxc * dxc + dzc * dzc < 240 * 240
    m.mesh.visible = near
    if (!near) return

    const pos = m.mesh.geometry.attributes.position as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    const flap = t * 1.5 + m.phase
    for (let i = 0; i < pos.count; i++) {
      const rxv = m.rest[i * 3]
      const rz = m.rest[i * 3 + 2]
      const wing = Math.abs(rz)
      // The wingtips beat in a slow wave travelling out from the body
      arr[i * 3] = rxv
      arr[i * 3 + 1] = m.rest[i * 3 + 1] + Math.sin(flap - wing * 1.4) * 0.22 * Math.pow(wing / 1.9, 1.4) * 1.9
      arr[i * 3 + 2] = rz
    }
    pos.needsUpdate = true

    m.mesh.position.set(x, y, z)
    dummy.rotation.set(0, 0, 0)
    dummy.rotateY(m.yaw + Math.PI / 2)
    dummy.rotateX(m.roll)
    m.mesh.quaternion.copy(dummy.quaternion)
  }

  function update(
    dt: number,
    t: number,
    camera: THREE.Camera,
    state: { swimming: boolean; daylight: number; storm: number },
  ) {
    // Pods only visit when the water is settled and there's light to see them by
    podTimer -= dt
    if (!pod && podTimer <= 0) {
      if (state.swimming && state.daylight > 0.35 && state.storm < 0.45) {
        spawnPod(camera)
        podTimer = rand(70, 140)
      } else {
        podTimer = 8
      }
    }
    updatePod(dt, t, camera)
    for (const tu of turtles) updateTurtle(tu, dt, t, camera)
    for (const m of mantas) updateManta(m, dt, t, camera)
    splashes.update(dt, surfaceFn(t))
  }

  return {
    update,
    /** Dev/tuning: bring a pod through right now. */
    summonPod: (camera: THREE.Camera) => {
      disposePod()
      spawnPod(camera)
    },
    get podActive() {
      return pod !== null
    },
    /** Dev/tuning: the live dolphin meshes. */
    get dolphins() {
      return pod ? pod.dolphins.map((d) => d.mesh) : []
    },
    group,
    turtles,
    mantas,
  }
}

export type Creatures = ReturnType<typeof createCreatures>
