import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { DETAIL_LAYER } from '../quality'
import { skyFill } from '../skyfill'
import type { NpcId, NpcPose } from './types'

/**
 * The three islanders as bodies: Kael, Tala and Oru.
 *
 * Each one is a hierarchy of pivot groups (hips, spine, chest, neck, head;
 * shoulder, elbow and wrist for each arm; hip, knee and ankle for each leg)
 * carrying one merged, vertex-coloured, low-poly mesh per segment. All three
 * share one lit material, plus one brass material for what Tala scavenged
 * from the coaster. Colour is painted per face rather than per vertex, so a
 * pandanus weave, a band of ochre or the edge of a hairline stays crisp on a
 * few hundred triangles instead of smearing into a gradient.
 *
 * Conventions:
 *  - The root's origin is at the feet. The figure faces local -Z, so
 *    `root.rotation.y = yaw` uses the player's convention: forward is
 *    (-sin yaw, -cos yaw). The figure's right hand is on local +X.
 *  - The body is modelled once for a 1.75 m person and scaled to each
 *    islander's height by a single uniform scale on the `body` group, so all
 *    the joint maths below is in those reference metres.
 *  - The root must sit in an untransformed parent (the tribe's group), since
 *    `lookAt` reads the target relative to the root's own position and yaw.
 *
 * Poses are joint-angle targets blended with `damp` every frame, never
 * snapped. Legs are solved by two-bone IK against foot targets, which is what
 * lets one solver do standing, a walking stride matched to ground speed, a
 * crouch and a cross-legged sit. The spear and the staff are aimed: the hand
 * holding one is turned each frame so the shaft points where the pose says,
 * and Kael's other hand is solved onto the shaft when a pose needs two hands.
 *
 * Triangle budgets (computed by `countTriangles` on the built rig, full
 * detail, with the low-power build in brackets), against a hard limit of
 * 3,000 each: Kael 2,540 (2,368), Tala 2,628 (2,456), Oru 2,634 (2,434).
 * Draw calls (one per mesh): Kael 17, Tala 19 (two of them brass), Oru 17.
 */

const TAU = Math.PI * 2
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))
const mix = (a: number, b: number, k: number) => a + (b - a) * k
const hash = (a: number, b: number, c: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453
  return s - Math.floor(s)
}

// —— geometry helpers ————————————————————————————————————————————

type Ends = 'open' | 'cap' | 'pole'
/** Colour for one face of a tube: `row` is the band between two rings (-1 and `rows` are the end caps). */
type FacePaint = (row: number, col: number, out: THREE.Color) => void
/** Colour for one face of a primitive, from the face's centre. */
type PointPaint = (x: number, y: number, z: number, out: THREE.Color) => void

const _gv = new THREE.Vector3()
const _gc = new THREE.Color()

/**
 * A closed or open tube from rings of points: the one shape every body part,
 * wrap and shaft is made of. Normals are smoothed on the shared vertices first,
 * then the mesh is split per face so each face can carry its own colour.
 * Winding is checked against the shape's centre and flipped if it came out
 * inside-out, so callers need not care which way their rings run.
 */
function tube(
  rows: number,
  sides: number,
  at: (ring: number, angle: number, out: THREE.Vector3) => void,
  start: Ends,
  end: Ends,
  paint: FacePaint,
): THREE.BufferGeometry {
  const pos: number[] = []
  const idx: number[] = []
  const faces: number[] = []
  const ringStart: number[] = []
  const isPole = (r: number) => (r === 0 && start === 'pole') || (r === rows && end === 'pole')
  for (let r = 0; r <= rows; r++) {
    ringStart.push(pos.length / 3)
    if (isPole(r)) {
      at(r, 0, _gv)
      pos.push(_gv.x, _gv.y, _gv.z)
      continue
    }
    for (let c = 0; c < sides; c++) {
      at(r, (c / sides) * TAU, _gv)
      pos.push(_gv.x, _gv.y, _gv.z)
    }
  }
  const ring = (r: number, c: number) => (isPole(r) ? ringStart[r] : ringStart[r] + (c % sides))
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < sides; c++) {
      const a = ring(r, c)
      const b = ring(r, c + 1)
      const cc = ring(r + 1, c)
      const d = ring(r + 1, c + 1)
      if (a !== b) {
        idx.push(a, cc, b)
        faces.push(r, c)
      }
      if (cc !== d) {
        idx.push(b, cc, d)
        faces.push(r, c)
      }
    }
  }
  const capAt = (r: number, row: number, flip: boolean) => {
    let cx = 0
    let cy = 0
    let cz = 0
    for (let c = 0; c < sides; c++) {
      const k = (ringStart[r] + c) * 3
      cx += pos[k]
      cy += pos[k + 1]
      cz += pos[k + 2]
    }
    const m = pos.length / 3
    pos.push(cx / sides, cy / sides, cz / sides)
    for (let c = 0; c < sides; c++) {
      if (flip) idx.push(m, ring(r, c + 1), ring(r, c))
      else idx.push(m, ring(r, c), ring(r, c + 1))
      faces.push(row, c)
    }
  }
  if (start === 'cap') capAt(0, -1, false)
  if (end === 'cap') capAt(rows, rows, true)

  // Outward winding: summed over faces, the normal should point away from the centre
  let mx = 0
  let my = 0
  let mz = 0
  const n = pos.length / 3
  for (let i = 0; i < n; i++) {
    mx += pos[i * 3]
    my += pos[i * 3 + 1]
    mz += pos[i * 3 + 2]
  }
  mx /= n
  my /= n
  mz /= n
  let out = 0
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3
    const b = idx[i + 1] * 3
    const c = idx[i + 2] * 3
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2]
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2]
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    const fx = (pos[a] + pos[b] + pos[c]) / 3 - mx
    const fy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3 - my
    const fz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3 - mz
    out += nx * fx + ny * fy + nz * fz
  }
  if (out < 0) {
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1]
      idx[i + 1] = idx[i + 2]
      idx[i + 2] = t
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  const flat = g.toNonIndexed()
  g.dispose()
  const tris = flat.attributes.position.count / 3
  const col = new Float32Array(tris * 9)
  for (let t = 0; t < tris; t++) {
    paint(faces[t * 2], faces[t * 2 + 1], _gc)
    for (let k = 0; k < 3; k++) {
      col[t * 9 + k * 3] = _gc.r
      col[t * 9 + k * 3 + 1] = _gc.g
      col[t * 9 + k * 3 + 2] = _gc.b
    }
  }
  flat.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return flat
}

/** [y, half width, half depth in front (-z), half depth behind, z centre, x centre] */
type Sec = readonly number[]

/** A tube through elliptical rings: the usual way a limb or a torso is described. */
function loft(secs: readonly Sec[], sides: number, start: Ends, end: Ends, paint: FacePaint) {
  return tube(
    secs.length - 1,
    sides,
    (r, a, out) => {
      const s = secs[r]
      const sn = Math.sin(a)
      out.set((s[5] ?? 0) + Math.cos(a) * s[1], s[0], (s[4] ?? 0) + sn * (sn < 0 ? s[2] : s[3]))
    },
    start,
    end,
    paint,
  )
}

/** A three.js primitive, stripped to position and normal and painted per face. */
function prim(geo: THREE.BufferGeometry, paint: PointPaint) {
  const g = geo.index ? geo.toNonIndexed() : geo
  if (g !== geo) geo.dispose()
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal') g.deleteAttribute(k)
  }
  if (!g.attributes.normal) g.computeVertexNormals()
  paintFaces(g, paint)
  return g
}

function paintFaces(g: THREE.BufferGeometry, paint: PointPaint) {
  const p = g.attributes.position
  const tris = p.count / 3
  const col = new Float32Array(p.count * 3)
  for (let t = 0; t < tris; t++) {
    const a = t * 3
    paint(
      (p.getX(a) + p.getX(a + 1) + p.getX(a + 2)) / 3,
      (p.getY(a) + p.getY(a + 1) + p.getY(a + 2)) / 3,
      (p.getZ(a) + p.getZ(a + 1) + p.getZ(a + 2)) / 3,
      _gc,
    )
    for (let k = 0; k < 3; k++) {
      col[(a + k) * 3] = _gc.r
      col[(a + k) * 3 + 1] = _gc.g
      col[(a + k) * 3 + 2] = _gc.b
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
}

/** Loose triangles turned to face away from an interior point, flat shaded: a nose, a carved notch. */
function facets(points: readonly number[][], tris: readonly number[][], inside: readonly number[], paint: PointPaint) {
  const pos: number[] = []
  for (const [a, b, c] of tris) {
    const A = points[a], B = points[b], C = points[c]
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]
    const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]]
    const nx = e1[1] * e2[2] - e1[2] * e2[1]
    const ny = e1[2] * e2[0] - e1[0] * e2[2]
    const nz = e1[0] * e2[1] - e1[1] * e2[0]
    const fx = (A[0] + B[0] + C[0]) / 3 - inside[0]
    const fy = (A[1] + B[1] + C[1]) / 3 - inside[1]
    const fz = (A[2] + B[2] + C[2]) / 3 - inside[2]
    const order = nx * fx + ny * fy + nz * fz >= 0 ? [A, B, C] : [A, C, B]
    for (const v of order) pos.push(v[0], v[1], v[2])
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  paintFaces(g, paint)
  return g
}

function merge(parts: THREE.BufferGeometry[]) {
  const g = mergeGeometries(parts, false) as THREE.BufferGeometry
  for (const p of parts) p.dispose()
  g.computeBoundingSphere()
  return g
}

/** Sums index count / 3 (or position count / 3) over every mesh in a subtree. */
export function countTriangles(obj: THREE.Object3D): number {
  let n = 0
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const g = mesh.geometry
    n += g.index ? g.index.count / 3 : g.attributes.position.count / 3
  })
  return Math.round(n)
}

function countMeshes(obj: THREE.Object3D): number {
  let n = 0
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n++
  })
  return n
}

// —— materials —————————————————————————————————————————————————

let bodyMaterial: THREE.MeshStandardMaterial | null = null
let brassMaterial: THREE.MeshStandardMaterial | null = null

/**
 * One material for skin, cloth, hair, wood and shell on all three islanders
 * (the colour is in the vertices), and one for the brass. Brass in shade
 * carries a little of the sky's light of its own, the way the wreck's iron
 * does, and like every such stand-in it follows the daylight through skyFill.
 */
function materials() {
  if (!bodyMaterial) {
    bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0 })
  }
  if (!brassMaterial) {
    brassMaterial = skyFill(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        color: 0xffffff,
        roughness: 0.42,
        metalness: 0.72,
        emissive: 0x1a130a,
        emissiveIntensity: 0.55,
      }),
    )
  }
  return { body: bodyMaterial, brass: brassMaterial }
}

// —— the reference body (1.75 m) ————————————————————————————————————

const REF_HEIGHT = 1.75
const STAND_HIPS = 0.945
const SIT_HIPS = 0.13
const HIP_X = 0.09
const HIP_Y = -0.026
const THIGH = 0.42
const SHIN = 0.42
const ANKLE = 0.079
const UPPER_ARM = 0.3
const FOREARM = 0.26
const SPINE_Y = 0.105
const CHEST_Y = 0.175
const NECK_Y = 0.245
const HEAD_Y = 0.085
const SHOULDER_X = 0.185
const SHOULDER_Y = 0.205
/** Where a closed fist holds a shaft, in the wrist's frame. The shaft runs along local z. */
const GRIP_Y = -0.058

const HEAD: readonly Sec[] = [
  [-0.05, 0, 0, 0, -0.058],
  [-0.04, 0.035, 0.03, 0.03, -0.056],
  [-0.02, 0.052, 0.045, 0.05, -0.042],
  [0.0, 0.062, 0.062, 0.065, -0.03],
  [0.02, 0.068, 0.075, 0.075, -0.022],
  [0.045, 0.072, 0.085, 0.085, -0.015],
  [0.065, 0.075, 0.09, 0.09, -0.012],
  [0.085, 0.077, 0.093, 0.094, -0.01],
  [0.105, 0.078, 0.1, 0.096, -0.01],
  [0.125, 0.079, 0.093, 0.098, -0.006],
  [0.15, 0.076, 0.085, 0.094, -0.003],
  [0.175, 0.064, 0.068, 0.082, 0.0],
  [0.195, 0.04, 0.042, 0.052, 0.003],
  [0.205, 0, 0, 0, 0.004],
]

/** Band of paint around a segment: [y from, y to, colour, front only]. */
type Band = readonly [number, number, THREE.Color, boolean]

type Style = {
  skin: THREE.Color
  palm: THREE.Color
  lip: THREE.Color
  hair: THREE.Color
  brow: THREE.Color
  /** Hairline height at the front, the sides and the back of the head. */
  hairline: readonly [number, number, number]
  /** How far the hair stands off the scalp at a height on the head. */
  hairThick: (y: number) => number
  beard: boolean
  girth: number
  shoulders: number
  hipsW: number
  /** Extra front depth over the chest. */
  bust: number
  upperArmBands: readonly Band[]
  forearmBands: readonly Band[]
  chestBands: readonly Band[]
  seed: number
}

const col = (hex: string) => new THREE.Color(hex)

function jitter(out: THREE.Color, base: THREE.Color, amount: number, a: number, b: number, seed: number) {
  return out.copy(base).multiplyScalar(1 + (hash(a, b, seed) - 0.5) * amount)
}

/** Skin, with any painted bands crossing this ring band. */
function skinPaint(
  secs: readonly Sec[],
  sides: number,
  st: Style,
  bands: readonly Band[],
  palmSide: number,
  palmFrom = Infinity,
): FacePaint {
  return (row, c, out) => {
    const r0 = clamp(row, 0, secs.length - 2)
    const y = (secs[r0][0] + secs[r0 + 1][0]) / 2
    const a = ((c + 0.5) / sides) * TAU
    for (const [y0, y1, colour, front] of bands) {
      if (y > y0 && y < y1 && (!front || Math.sin(a) < -0.35)) {
        jitter(out, colour, 0.1, row, c, st.seed + 7)
        return
      }
    }
    // The palm side of a hand is paler than the back
    if (palmSide !== 0 && y < palmFrom && Math.cos(a) * palmSide > 0.35) {
      jitter(out, st.palm, 0.05, row, c, st.seed)
      return
    }
    jitter(out, st.skin, 0.05, row, c, st.seed)
  }
}

type Segments = {
  hips: THREE.BufferGeometry[]
  spine: THREE.BufferGeometry[]
  chest: THREE.BufferGeometry[]
  neck: THREE.BufferGeometry[]
  head: THREE.BufferGeometry[]
  upperArm: [THREE.BufferGeometry[], THREE.BufferGeometry[]]
  forearm: [THREE.BufferGeometry[], THREE.BufferGeometry[]]
  hand: [THREE.BufferGeometry[], THREE.BufferGeometry[]]
  thigh: [THREE.BufferGeometry[], THREE.BufferGeometry[]]
  shin: [THREE.BufferGeometry[], THREE.BufferGeometry[]]
  foot: [THREE.BufferGeometry[], THREE.BufferGeometry[]]
  /** Brass parts, by the pivot they ride on. */
  brassHead: THREE.BufferGeometry[]
  brassChest: THREE.BufferGeometry[]
}

/** Index 0 is the right side (+x), 1 the left. */
const SIDES = [1, -1] as const

function scaleGirth(g: THREE.BufferGeometry, girth: number) {
  g.scale(girth, 1, girth)
  return g
}

function buildBody(st: Style, low: boolean, fistSide: number): Segments {
  const limb = low ? 7 : 8
  const g = st.girth
  const seg: Segments = {
    hips: [],
    spine: [],
    chest: [],
    neck: [],
    head: [],
    upperArm: [[], []],
    forearm: [[], []],
    hand: [[], []],
    thigh: [[], []],
    shin: [[], []],
    foot: [[], []],
    brassHead: [],
    brassChest: [],
  }

  // Pelvis
  const pelvis: Sec[] = [
    [-0.11, 0, 0, 0, 0.01],
    [-0.095, 0.11, 0.07, 0.085, 0.01],
    [-0.05, 0.16, 0.095, 0.11, 0.01],
    [0.0, 0.17, 0.1, 0.11, 0.005],
    [0.06, 0.155, 0.095, 0.095, 0],
    [0.13, 0.14, 0.088, 0.083, 0],
  ]
  for (const s of pelvis) (s as number[])[1] *= st.hipsW
  seg.hips.push(scaleGirth(loft(pelvis, 10, 'pole', 'cap', skinPaint(pelvis, 10, st, [], 0)), g))

  // Abdomen
  const abdomen: Sec[] = [
    [-0.04, 0.139, 0.088, 0.083, 0],
    [0.06, 0.13, 0.09, 0.08, 0],
    [0.12, 0.136, 0.095, 0.082, 0],
    [0.2, 0.149, 0.098, 0.087, 0],
  ]
  seg.spine.push(scaleGirth(loft(abdomen, 10, 'cap', 'cap', skinPaint(abdomen, 10, st, [], 0)), g))

  // Chest, with ring edges where Kael's chest markings sit so they stay crisp
  const sh = st.shoulders
  const banded = st.chestBands.length > 0
  const chest: Sec[] = [
    [-0.04, 0.146, 0.096, 0.086, 0],
    [0.04, 0.158, 0.105, 0.092, 0],
    [0.1, 0.172 * (0.5 + sh * 0.5), 0.112 + st.bust * 0.6, 0.097, 0],
    ...(banded
      ? [
          [0.118, 0.176 * (0.5 + sh * 0.5), 0.113 + st.bust, 0.098, 0],
          [0.13, 0.178 * (0.5 + sh * 0.5), 0.112 + st.bust, 0.099, 0],
        ]
      : [[0.125, 0.177 * (0.5 + sh * 0.5), 0.113 + st.bust, 0.098, 0]]),
    [0.15, 0.182 * (0.5 + sh * 0.5), 0.108 + st.bust * 0.5, 0.1, 0],
    [0.2, 0.19 * sh, 0.092, 0.092, 0.005],
    [0.235, 0.15 * sh, 0.075, 0.075, 0.008],
    [0.26, 0.075, 0.055, 0.058, 0.01],
    [0.275, 0.06, 0.05, 0.052, 0.01],
  ]
  seg.chest.push(scaleGirth(loft(chest, 12, 'cap', 'cap', skinPaint(chest, 12, st, st.chestBands, 0)), g))

  // Neck
  const neck: Sec[] = [
    [-0.03, 0.058, 0.055, 0.058, 0.005],
    [0.04, 0.054, 0.052, 0.055, 0.008],
    [0.1, 0.052, 0.05, 0.052, 0.012],
  ]
  seg.neck.push(scaleGirth(loft(neck, 8, 'cap', 'cap', skinPaint(neck, 8, st, [], 0)), g))

  // Head, with hair and (for Oru) a beard as shaped masses on the one surface
  seg.head.push(...buildHead(st))

  for (let i = 0; i < 2; i++) {
    const s = SIDES[i]
    // Extra rings only where painted bands need crisp edges
    const upper: Sec[] = st.upperArmBands.length > 0
      ? [
          [-0.31, 0.034, 0.036, 0.036, 0],
          [-0.25, 0.04, 0.043, 0.042, 0],
          [-0.15, 0.047, 0.05, 0.047, -0.004],
          [-0.12, 0.049, 0.051, 0.048, -0.003],
          [-0.105, 0.05, 0.051, 0.049, -0.002],
          [-0.08, 0.052, 0.052, 0.05, 0],
          [-0.06, 0.054, 0.053, 0.051, 0],
          [0.0, 0.058, 0.056, 0.055, 0],
          [0.035, 0.045, 0.045, 0.045, 0],
          [0.06, 0, 0, 0, 0],
        ]
      : [
          [-0.31, 0.034, 0.036, 0.036, 0],
          [-0.25, 0.04, 0.043, 0.042, 0],
          [-0.15, 0.047, 0.05, 0.047, -0.004],
          [-0.06, 0.054, 0.053, 0.051, 0],
          [0.0, 0.058, 0.056, 0.055, 0],
          [0.035, 0.045, 0.045, 0.045, 0],
          [0.06, 0, 0, 0, 0],
        ]
    seg.upperArm[i].push(scaleGirth(loft(upper, limb, 'cap', 'pole', skinPaint(upper, limb, st, st.upperArmBands, 0)), g))

    const fore: Sec[] = st.forearmBands.length > 0
      ? [
          [-0.27, 0.027, 0.022, 0.022, 0],
          [-0.22, 0.03, 0.025, 0.025, 0],
          [-0.205, 0.031, 0.026, 0.026, 0],
          [-0.19, 0.032, 0.027, 0.027, 0],
          [-0.18, 0.033, 0.028, 0.028, 0],
          [-0.12, 0.039, 0.034, 0.034, 0],
          [-0.05, 0.043, 0.04, 0.04, 0],
          [0.025, 0.037, 0.037, 0.04, 0.004],
        ]
      : [
          [-0.27, 0.027, 0.022, 0.022, 0],
          [-0.2, 0.031, 0.026, 0.026, 0],
          [-0.12, 0.039, 0.034, 0.034, 0],
          [-0.05, 0.043, 0.04, 0.04, 0],
          [0.025, 0.037, 0.037, 0.04, 0.004],
        ]
    seg.forearm[i].push(scaleGirth(loft(fore, low ? 6 : 7, 'cap', 'cap', skinPaint(fore, low ? 6 : 7, st, st.forearmBands, 0)), g))

    // Hands: a mitten with a thumb, or a closed fist for the hand that holds
    // the spear or staff. With the arm hanging the palm faces the thigh, so the
    // hand's breadth runs front to back (z) and its thickness across (x).
    const fist = s === fistSide
    const hand: Sec[] = fist
      ? [
          [-0.105, 0.012, 0.02, 0.02, 0],
          [-0.09, 0.025, 0.038, 0.035, 0],
          [-0.05, 0.031, 0.044, 0.04, 0],
          [-0.01, 0.023, 0.034, 0.032, 0],
          [0.02, 0.017, 0.022, 0.024, 0],
        ]
      : [
          [-0.175, 0.008, 0.012, 0.012, 0],
          [-0.15, 0.012, 0.032, 0.03, 0],
          [-0.1, 0.016, 0.042, 0.04, 0],
          [-0.05, 0.02, 0.043, 0.04, 0],
          [0.0, 0.019, 0.03, 0.03, 0],
          [0.02, 0.016, 0.022, 0.024, 0],
        ]
    const handGeo = loft(hand, 6, 'cap', 'cap', skinPaint(hand, 6, st, [], -s, -0.02))
    const thumb: Sec[] = [
      [-0.06, 0, 0, 0, 0],
      [-0.045, 0.011, 0.011, 0.011, 0],
      [0.0, 0.014, 0.013, 0.013, 0],
    ]
    const thumbGeo = loft(thumb, 5, 'pole', 'cap', skinPaint(thumb, 5, st, [], 0))
    if (fist) {
      // Wrapped over the front of the fist
      thumbGeo.rotateX(1.25)
      thumbGeo.translate(-s * 0.012, -0.03, -0.03)
    } else {
      thumbGeo.rotateX(0.45)
      thumbGeo.rotateZ(-s * 0.25)
      thumbGeo.translate(-s * 0.006, -0.03, -0.034)
    }
    seg.hand[i].push(handGeo, thumbGeo)

    const thigh: Sec[] = [
      [-0.44, 0.05, 0.053, 0.05, 0],
      [-0.38, 0.056, 0.058, 0.054, 0],
      [-0.26, 0.067, 0.068, 0.064, 0],
      [-0.13, 0.078, 0.078, 0.074, 0],
      [-0.03, 0.085, 0.084, 0.082, 0.005],
      [0.04, 0.07, 0.06, 0.07, 0.01],
      [0.07, 0, 0, 0, 0.01],
    ]
    seg.thigh[i].push(scaleGirth(loft(thigh, low ? 8 : 9, 'cap', 'pole', skinPaint(thigh, low ? 8 : 9, st, [], 0)), g))

    const shin: Sec[] = [
      [-0.44, 0.027, 0.03, 0.03, 0.005],
      [-0.36, 0.03, 0.033, 0.034, 0.003],
      [-0.24, 0.042, 0.042, 0.052, 0.006],
      [-0.13, 0.048, 0.046, 0.06, 0.008],
      [-0.03, 0.052, 0.054, 0.05, 0],
      [0.04, 0.045, 0.05, 0.045, 0],
    ]
    seg.shin[i].push(scaleGirth(loft(shin, limb, 'cap', 'cap', skinPaint(shin, limb, st, [], 0)), g))

    // Foot: built along y, then laid down so +y runs forward (-z) and the sole is flat
    const foot: Sec[] = [
      [-0.065, 0, 0, 0, 0.035],
      [-0.055, 0.028, 0.03, 0.03, 0.035],
      [-0.02, 0.034, 0.035, 0.055, 0.035],
      [0.04, 0.04, 0.03, 0.04, 0.03],
      [0.11, 0.046, 0.022, 0.025, 0.022],
      [0.16, 0.044, 0.016, 0.016, 0.016],
      [0.185, 0.03, 0.012, 0.01, 0.012],
    ]
    const footGeo = loft(foot, 7, 'pole', 'cap', (row, c, out) => {
      // The sole is paler and rougher
      const a = ((c + 0.5) / 7) * TAU
      if (Math.sin(a) < -0.6) return jitter(out, st.palm, 0.05, row, c, st.seed + 3).multiplyScalar(0.9)
      return jitter(out, st.skin, 0.05, row, c, st.seed + 3)
    })
    footGeo.rotateX(-Math.PI / 2)
    footGeo.scale(g, 1, 1)
    footGeo.translate(0, -ANKLE, 0)
    seg.foot[i].push(footGeo)
  }
  return seg
}

function buildHead(st: Style): THREE.BufferGeometry[] {
  const sides = 14
  const [hf, hs, hb] = st.hairline
  const hairlineAt = (a: number) => {
    const sn = Math.sin(a)
    const cs = Math.cos(a)
    return hs * cs * cs + (sn < 0 ? hf : hb) * sn * sn
  }
  const geo = tube(
    HEAD.length - 1,
    sides,
    (r, a, out) => {
      const s = HEAD[r]
      const sn = Math.sin(a)
      const cs = Math.cos(a)
      let x = cs * s[1]
      let z = (s[4] ?? 0) + sn * (sn < 0 ? s[2] : s[3])
      const y = s[0]
      // Hair stands off the scalp above the hairline
      const above = y - hairlineAt(a)
      const lift = st.hairThick(y) * smooth(-0.006, 0.02, above)
      // A beard thickens the jaw and chin at the front
      const front = Math.max(0, -sn)
      const beard = st.beard ? 0.013 * smooth(0.1, 0.55, front) * (1 - smooth(0.02, 0.048, y)) : 0
      const grow = lift + beard
      if (grow > 0 && s[1] > 0) {
        x += cs * grow
        z += sn * grow
      }
      out.set(x, y - (st.beard && y < -0.03 ? 0.008 * front : 0), z)
    },
    'pole',
    'pole',
    (row, c, out) => {
      const y = (HEAD[row][0] + HEAD[row + 1][0]) / 2
      const a = ((c + 0.5) / sides) * TAU
      const front = -Math.sin(a)
      const across = Math.abs(Math.cos(a))
      if (y > hairlineAt(a)) return jitter(out, st.hair, 0.12, row, c, st.seed + 11)
      // A tuft on the point of the chin only. Painted across the jaw, or up to
      // the cheeks with a moustache, the white hair read as a face mask at
      // this many faces.
      if (st.beard && y < -0.012 && front > 0.72) return jitter(out, st.hair, 0.1, row, c, st.seed + 13)
      // Shade where the eyes sit, a brow above, lips below: no more face than that
      if (y > 0.085 && y < 0.105 && front > 0.55 && across > 0.18 && across < 0.62) {
        return out.copy(st.skin).multiplyScalar(0.6)
      }
      if (y > 0.105 && y < 0.125 && front > 0.5 && across > 0.1 && across < 0.62) {
        return out.copy(st.skin).lerp(st.brow, 0.65)
      }
      if (y > 0.0 && y < 0.02 && front > 0.85) return out.copy(st.lip)
      return jitter(out, st.skin, 0.05, row, c, st.seed + 5)
    },
  )
  const skin: PointPaint = (_x, _y, _z, out) => {
    out.copy(st.skin)
  }
  const nose = facets(
    [
      [0, 0.1, -0.104],
      [0, 0.052, -0.129],
      [-0.017, 0.047, -0.1],
      [0.017, 0.047, -0.1],
      [0, 0.044, -0.107],
    ],
    [
      [0, 1, 2],
      [0, 3, 1],
      [2, 1, 4],
      [1, 3, 4],
    ],
    [0, 0.07, -0.08],
    skin,
  )
  const parts = [geo, nose]
  for (const s of SIDES) {
    const ear = new THREE.SphereGeometry(0.024, 6, 4)
    ear.scale(0.35, 1.25, 0.75)
    ear.translate(s * 0.074, 0.066, 0.008)
    parts.push(prim(ear, (_x, _y, _z, out) => out.copy(st.skin).multiplyScalar(0.92)))
  }
  if (st.girth !== 1) for (const p of parts) p.scale(0.97 + st.girth * 0.03, 1, 0.97 + st.girth * 0.03)
  return parts
}

// —— what each of them carries and wears —————————————————————————————

/** A wrap round the hips: pandanus weave or bark cloth, flared toward the hem so a stride stays inside it. */
function wrap(hem: number, sides: number, paint: FacePaint, hipsW: number) {
  const secs: Sec[] = []
  const top = 0.08
  const n = 5
  for (let i = 0; i <= n; i++) {
    const y = hem + ((top - hem) * i) / n
    const t = (top - y) / (top - hem)
    const w = (0.172 + t * 0.06) * hipsW
    secs.push([y, w, 0.105 + t * 0.055, 0.115 + t * 0.05, 0])
  }
  return loft(secs, sides, 'cap', 'cap', paint)
}

function weave(light: THREE.Color, dark: THREE.Color, border: THREE.Color, edgeCol: number, seed: number, rows: number): FacePaint {
  return (row, c, out) => {
    if (row <= 0 || row >= rows - 1) return jitter(out, border, 0.08, row, c, seed)
    if (c === edgeCol) return out.copy(dark).multiplyScalar(0.7)
    const twill = (row + c) % 4 < 2
    return jitter(out, twill ? light : dark, 0.1, row, c, seed)
  }
}

function tapa(base: THREE.Color, ink: THREE.Color, rust: THREE.Color, seed: number, rows: number): FacePaint {
  return (row, c, out) => {
    if (row < 0 || row >= rows) return out.copy(base)
    if (row === 0) return jitter(out, rust, 0.06, row, c, seed)
    // Bark cloth is printed in bands: a row of triangles between plain cloth
    if (row % 2 === 1) return (c + row) % 2 === 0 ? out.copy(ink) : jitter(out, base, 0.06, row, c, seed)
    return jitter(out, base, 0.06, row, c, seed)
  }
}

/** A cord or belt ring at a height on the hips. */
function belt(y: number, sides: number, w: number, d0: number, d1: number, a: THREE.Color, b: THREE.Color, seed: number) {
  const secs: Sec[] = [
    [y - 0.011, w, d0, d1, 0],
    [y, w + 0.006, d0 + 0.006, d1 + 0.006, 0],
    [y + 0.011, w, d0, d1, 0],
  ]
  // Open ends: it lies on the wrap, and only its outside is ever seen
  return loft(secs, sides, 'open', 'open', (row, c, out) => jitter(out, (row + c) % 2 === 0 ? a : b, 0.08, row, c, seed))
}

/**
 * A shaft held in a fist: it runs along the hand's local z, through the grip
 * point, with the head (added by `head`) toward -z. Built along y and turned,
 * since the lofts run up y.
 */
function shaft(
  buttLength: number,
  radius: number,
  sides: number,
  head: (y0: number, out: Sec[]) => void,
  paint: (y: number, row: number, c: number, out: THREE.Color) => void,
) {
  const secs: Sec[] = [
    [-buttLength, radius * 0.8, radius * 0.8, radius * 0.8, 0],
    [-buttLength + 0.015, radius, radius, radius, 0],
    [0, radius * 1.08, radius * 1.08, radius * 1.08, 0],
  ]
  head(0, secs)
  const g = loft(secs, sides, 'cap', 'pole', (row, c, out) => {
    const r0 = clamp(row, 0, secs.length - 2)
    paint((secs[r0][0] + secs[r0 + 1][0]) / 2, row, c, out)
  })
  // +y (toward the tip) onto -z, then down to the grip point
  g.rotateX(-Math.PI / 2)
  g.translate(0, GRIP_Y, 0)
  return g
}

function kaelSpear(scale: number, low: boolean) {
  // 1.9 m in the world; the hand that holds it is scaled with Kael
  const len = 1.9 / scale
  const butt = 1.0 / scale
  const tip = len - butt
  const wood = col('#4b301f')
  const grain = col('#5d3d27')
  const hard = col('#24180f')
  const carve = col('#8b6a45')
  const cord = col('#8d7850')
  const cordDark = col('#5e4e33')
  const g = shaft(
    butt,
    0.0145,
    low ? 5 : 6,
    (_y0, s) => {
      const base = tip - 0.34
      s.push(
        [base - 0.07, 0.0145, 0.0145, 0.0145, 0],
        [base - 0.065, 0.0185, 0.0185, 0.0185, 0],
        [base - 0.01, 0.0185, 0.0185, 0.0185, 0],
        [base - 0.005, 0.0165, 0.0165, 0.0165, 0],
        [base + 0.06, 0.0175, 0.0175, 0.0175, 0],
        [base + 0.09, 0.0145, 0.0145, 0.0145, 0],
        [base + 0.12, 0.0165, 0.0165, 0.0165, 0],
        [base + 0.2, 0.012, 0.012, 0.012, 0],
        [base + 0.29, 0.006, 0.006, 0.006, 0],
        [tip, 0, 0, 0, 0],
      )
    },
    (y, row, c, out) => {
      const base = tip - 0.34
      // Cord binding below the carved point, and the hand's wrap at the grip
      if ((y > base - 0.068 && y < base - 0.008) || (y > -0.07 && y < 0.07 && y < base - 0.2)) {
        out.copy((row + c) % 2 === 0 ? cord : cordDark)
        return
      }
      if (y > base + 0.12) {
        // Fire-hardened point
        out.copy(hard).lerp(carve, smooth(base + 0.28, base + 0.12, y) * 0.35)
        return
      }
      if (y > base) {
        // Carved chevrons on the collar of the point
        out.copy((row + c) % 2 === 0 ? carve : wood)
        return
      }
      jitter(out, row % 2 === 0 ? wood : grain, 0.06, row, c, 41)
    },
  )
  return g
}

function oruStaff(scale: number, low: boolean) {
  // 1.8 m in the world, held about 0.9 m up so its foot finds the ground
  const len = 1.8 / scale
  const butt = 0.9 / scale
  const tip = len - butt
  const wood = col('#6a4a2e')
  const dark = col('#3e2a1a')
  const pale = col('#9a7650')
  const cord = col('#7c6a4a')
  return shaft(
    butt,
    0.016,
    low ? 5 : 6,
    (_y0, s) => {
      const k = tip - 0.2
      s.push(
        [k - 0.06, 0.016, 0.016, 0.016, 0],
        [k - 0.05, 0.019, 0.019, 0.019, 0],
        [k - 0.01, 0.019, 0.019, 0.019, 0],
        [k + 0.02, 0.024, 0.024, 0.024, 0],
        [k + 0.07, 0.033, 0.033, 0.033, 0],
        [k + 0.1, 0.028, 0.028, 0.028, 0],
        [k + 0.14, 0.034, 0.034, 0.034, 0],
        [k + 0.18, 0.022, 0.022, 0.022, 0],
        [tip, 0, 0, 0, 0],
      )
    },
    (y, row, c, out) => {
      const k = tip - 0.2
      if (y > k - 0.05 && y < k - 0.01) {
        out.copy((row + c) % 2 === 0 ? cord : dark)
        return
      }
      if (y > k) {
        // The carved head: incised rings, dark in the cuts and pale on the ridges
        out.copy(row % 2 === 0 ? pale : dark)
        if ((row + c) % 3 === 0) out.lerp(wood, 0.5)
        return
      }
      jitter(out, wood, 0.08, row, c, 77)
    },
  )
}

// —— poses ————————————————————————————————————————————————————————

/**
 * Every pose is one vector of these. "t" is the arm on the tool side (the hand
 * that holds the spear or the staff; the right arm for Tala), "f" the free arm.
 * Angles in radians, distances in reference metres.
 */
const KEYS = [
  'drop', 'hipZ', 'hipX', 'hipRoll', 'spine', 'chest', 'chestYaw', 'neck', 'head', 'tilt',
  'tFlex', 'tAbd', 'tTwist', 'tElbow', 'tWrist', 'tPalm',
  'fFlex', 'fAbd', 'fTwist', 'fElbow', 'fWrist', 'fPalm',
  'tFoot', 'fFoot', 'stance', 'sit',
  'toolX', 'toolY', 'toolZ', 'grip', 'gripAt',
] as const
type Key = (typeof KEYS)[number]
type PoseSpec = Partial<Record<Key, number>>
const K = Object.fromEntries(KEYS.map((k, i) => [k, i])) as Record<Key, number>
const NP = KEYS.length

const BASE: PoseSpec = {
  drop: 0.012, spine: -0.02, chest: 0.03, neck: 0.02, head: -0.05,
  tFlex: 0.06, tAbd: 0.1, tElbow: 0.18, fFlex: 0.06, fAbd: 0.1, fElbow: 0.18,
  tFoot: 0.03, fFoot: -0.03, stance: 0.03,
  toolX: 0.04, toolY: 1, toolZ: -0.1, gripAt: 0.6,
}

/** The tool arm when the pose has nothing better for it: the shaft upright beside the body. */
const HOLD: PoseSpec = { tFlex: 0.12, tAbd: 0.14, tElbow: 0.9, toolX: 0.03, toolY: 1, toolZ: -0.08 }

/** `tool` applies to anyone carrying a spear or staff, `staff` on top of it for Oru, `bare` to Tala. */
type PoseDef = { all: PoseSpec; tool?: PoseSpec; staff?: PoseSpec; bare?: PoseSpec }

const POSES: Record<NpcPose, PoseDef> = {
  idle: { all: {}, tool: HOLD },
  patrol: {
    all: { spine: -0.06, chest: 0, head: -0.02 },
    tool: { tFlex: 0.22, tAbd: 0.12, tElbow: 1.0, toolX: 0.05, toolY: 0.82, toolZ: -0.57 },
    // A walking staff stays upright, its top a little behind the hand
    staff: { tFlex: 0.15, tElbow: 1.0, toolX: 0.03, toolY: 1, toolZ: 0.12 },
  },
  watch_suspicious: {
    all: {
      hipX: 0.025, hipRoll: 0.025, spine: 0, chest: 0.02, head: -0.07,
      fFlex: 0.1, fAbd: 0.16, fElbow: 0.35, tFoot: 0.08, fFoot: -0.1, stance: 0.04,
    },
    tool: { ...HOLD, toolZ: -0.26 },
  },
  warn_spear_raise: {
    all: {
      drop: 0.045, hipZ: 0.05, spine: 0.07, chest: -0.02, neck: -0.03, head: 0.02,
      tFoot: 0.17, fFoot: -0.14, stance: 0.07,
    },
    // The spear held crosswise above the head in both hands
    tool: {
      tFlex: -0.15, tAbd: 2.35, tTwist: -1.45, tElbow: 1.35,
      fFlex: -0.15, fAbd: 2.35, fTwist: -1.45, fElbow: 1.35,
      toolX: -1, toolY: 0.06, toolZ: 0.02, grip: 1, gripAt: 0.72,
    },
    // Without a spear it is both palms up and out: stop there
    bare: { tFlex: 1.25, tAbd: 0.35, tElbow: 1.2, tPalm: -1.2, fFlex: 1.25, fAbd: 0.35, fElbow: 1.2, fPalm: -1.2 },
  },
  stalk: {
    all: {
      drop: 0.2, hipZ: 0.02, spine: -0.42, chest: -0.12, neck: 0.24, head: 0.26,
      tFoot: 0.06, fFoot: -0.12, stance: 0.06,
      fFlex: 0.5, fAbd: 0.12, fElbow: 0.6,
    },
    // Angled across the body so the other hand can take it
    tool: { tFlex: 0.3, tAbd: 0.1, tElbow: 0.95, toolX: -0.42, toolY: 0.25, toolZ: -1, grip: 1, gripAt: 0.75 },
    bare: { tFlex: 0.5, tAbd: 0.12, tElbow: 0.6 },
  },
  charge_attack: {
    all: { drop: 0.06, spine: -0.36, chest: -0.1, neck: 0.18, head: 0.24 },
    // Couched under the arm, level and forward; the other arm pumps with the run
    tool: { tFlex: -0.25, tAbd: 0.2, tElbow: 1.35, toolX: -0.05, toolY: 0.03, toolZ: -1 },
  },
  curious_tilt: {
    all: {
      hipX: -0.02, hipRoll: -0.02, spine: -0.1, chest: -0.04, neck: -0.03, head: 0.06, tilt: 0.3,
      fFlex: 0.12, fElbow: 0.45, tFoot: -0.05, fFoot: 0.05,
    },
    tool: HOLD,
  },
  beckon_follow: {
    all: { chestYaw: 0.12, head: 0.03, fFlex: 0.9, fAbd: 0.35, fElbow: 0.9, fPalm: 1.3 },
    tool: HOLD,
  },
  accept_gift: {
    all: {
      drop: 0.025, spine: -0.18, chest: -0.08, neck: -0.1, head: -0.18,
      fFlex: 1.0, fAbd: 0.1, fElbow: 0.5, fPalm: 1.45,
      tFlex: 1.0, tAbd: 0.1, tElbow: 0.5, tPalm: 1.45,
    },
    tool: HOLD,
  },
  laugh_baffled: {
    // Head back, a hand across the belly
    all: { neck: 0.12, head: 0.24, spine: 0.04, chest: 0.06, fFlex: 0, fAbd: 0.05, fTwist: 0.9, fElbow: 1.3 },
    tool: HOLD,
    bare: { tFlex: 0.3, tAbd: 0.3, tElbow: 0.6 },
  },
  sit_fire: {
    all: {
      sit: 1, spine: -0.18, chest: -0.06, neck: 0, head: -0.14,
      // Forearms up, palms to the fire
      fFlex: 0.7, fAbd: 0.15, fElbow: 1.8, fPalm: -1.45,
      tFlex: 0.7, tAbd: 0.15, tElbow: 1.8, tPalm: -1.45,
    },
    // A staff laid across the lap
    tool: { tFlex: 0.45, tAbd: 0.1, tElbow: 0.8, toolX: -1, toolY: 0.1, toolZ: -0.25 },
  },
}

/** How fast each kind of joint target is chased (1/s). Sitting down takes longer than a glance. */
const LAMBDA = new Float32Array(NP).fill(5)
LAMBDA[K.sit] = 2.4
LAMBDA[K.drop] = 4
LAMBDA[K.toolX] = LAMBDA[K.toolY] = LAMBDA[K.toolZ] = 6
LAMBDA[K.grip] = 7

function poseVector(def: PoseDef, tool: 'spear' | 'staff' | null, bias: PoseSpec) {
  const v = new Float32Array(NP)
  const apply = (s: PoseSpec | undefined) => {
    if (!s) return
    for (const k of Object.keys(s) as Key[]) v[K[k]] = s[k] as number
  }
  apply(BASE)
  apply(def.all)
  apply(tool ? def.tool : def.bare)
  if (tool === 'staff') apply(def.staff)
  for (const k of Object.keys(bias) as Key[]) v[K[k]] += bias[k] as number
  return v
}

// —— two-bone IK ———————————————————————————————————————————————————

const _ikD = new THREE.Vector3()
const _ikN = new THREE.Vector3()
const _ikBone = new THREE.Vector3()
const _ikZ = new THREE.Vector3()
const _ikX = new THREE.Vector3()
const _ikY = new THREE.Vector3()
const _ikM = new THREE.Matrix4()

/**
 * Solve a two-bone limb whose bones hang down local -y. `origin`, `target` and
 * `pole` are in the parent's frame; the middle joint is pushed toward `pole`.
 * sigma -1 is a knee (the front of the thigh faces the pole and the shin
 * folds back), +1 an elbow (the elbow points at the pole and the forearm
 * folds forward). Writes the root joint's rotation and returns the middle
 * joint's angle about its local x.
 */
function solveTwoBone(
  origin: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  a: number,
  b: number,
  sigma: number,
  out: THREE.Quaternion,
) {
  _ikD.subVectors(target, origin)
  let d = _ikD.length()
  if (d < 1e-5) _ikD.set(0, -1, 0)
  else _ikD.multiplyScalar(1 / d)
  d = clamp(d, Math.abs(a - b) + 1e-3, a + b - 1e-4)
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1)
  const sinA = Math.sqrt(1 - cosA * cosA)
  _ikN.copy(pole).addScaledVector(_ikD, -pole.dot(_ikD))
  if (_ikN.lengthSq() < 1e-8) _ikN.set(0, 0, -1).addScaledVector(_ikD, _ikD.z)
  _ikN.normalize()
  _ikBone.copy(_ikD).multiplyScalar(cosA).addScaledVector(_ikN, sinA)
  _ikY.copy(_ikBone).negate()
  _ikZ.copy(_ikN).addScaledVector(_ikBone, -_ikN.dot(_ikBone)).normalize().multiplyScalar(sigma)
  _ikX.crossVectors(_ikY, _ikZ)
  _ikM.makeBasis(_ikX, _ikY, _ikZ)
  out.setFromRotationMatrix(_ikM)
  const cosB = clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1)
  return sigma * (Math.PI - Math.acos(cosB))
}

// —— the rig ———————————————————————————————————————————————————————

export type IslanderMotion = {
  /** Ground speed, m/s. Drives the stride and switches to a run above ~2.5. */
  speed: number
  /** Yaw rate, rad/s: turning on the spot shuffles the feet. */
  turnRate?: number
  /** 0..1 how deep in water the islander stands: arms lift, the stride shortens. */
  wading?: number
  /** Rise per metre along the facing direction, so feet land on a slope rather than through it. */
  slope?: number
  /** 0..1 bend down and reach low with both hands (working the reef, picking up shells). */
  reach?: number
  /** 0..1 swimming (Tala crossing the lagoon): the sim holds the root down in the water. */
  swim?: number
}

export type IslanderRig = {
  root: THREE.Group
  id: NpcId
  /** Triangles in the whole islander, accessories included. */
  triangles: number
  /** Meshes in the islander: one draw call each. */
  drawCalls: number
  /** Standing height in metres. */
  height: number
  readonly pose: NpcPose
  setPose(pose: NpcPose): void
  update(dt: number, t: number, motion: IslanderMotion): void
  /** Turn the head and neck (clamped) toward a world point, or let them come back to the front. */
  lookAt(target: THREE.Vector3 | null): void
  /** Jump the blended pose to its target, for a teleport. */
  snapPose(): void
}

type Person = {
  height: number
  style: Style
  tool: 'spear' | 'staff' | null
  /** +1 holds the tool in the right hand, -1 in the left. */
  toolSide: 1 | -1
  bias: PoseSpec
}

function person(id: NpcId): Person {
  const ochre = col('#a9542b')
  const charcoal = col('#2a221d')
  if (id === 'kael') {
    return {
      height: 1.86,
      tool: 'spear',
      toolSide: 1,
      bias: {},
      style: {
        skin: col('#5a3824'),
        palm: col('#9a6a4a'),
        lip: col('#4a2b22'),
        hair: col('#17120e'),
        brow: col('#17120e'),
        hairline: [0.13, 0.1, 0.04],
        hairThick: (y) => 0.01 + 0.012 * smooth(0.1, 0.2, y),
        beard: false,
        girth: 0.98,
        shoulders: 1.08,
        hipsW: 0.97,
        bust: 0,
        // Ochre and charcoal in bands, on the shoulders, the forearms and across the chest
        upperArmBands: [
          [-0.105, -0.06, charcoal, false],
          [-0.15, -0.12, ochre, false],
        ],
        forearmBands: [
          [-0.22, -0.205, charcoal, false],
          [-0.19, -0.18, ochre, false],
        ],
        chestBands: [
          [0.118, 0.13, charcoal, true],
          [0.13, 0.15, ochre, true],
        ],
        seed: 1,
      },
    }
  }
  if (id === 'tala') {
    return {
      height: 1.62,
      tool: null,
      toolSide: 1,
      bias: {},
      style: {
        skin: col('#7d5236'),
        palm: col('#b58763'),
        lip: col('#6a3a2e'),
        hair: col('#1e1510'),
        brow: col('#1e1510'),
        hairline: [0.14, 0.105, 0.03],
        hairThick: () => 0.008,
        beard: false,
        girth: 0.9,
        shoulders: 0.93,
        hipsW: 1.04,
        bust: 0.012,
        upperArmBands: [],
        forearmBands: [],
        chestBands: [],
        seed: 2,
      },
    }
  }
  return {
    height: 1.7,
    tool: 'staff',
    toolSide: -1,
    // An elder's stoop: carried in every pose, on top of it
    bias: { spine: -0.1, chest: -0.12, neck: 0.13, head: 0.07, drop: 0.02 },
    style: {
      skin: col('#5f3d28'),
      palm: col('#a07455'),
      lip: col('#523028'),
      // Grey-white rather than paper-white: under a noon sun and the bloom the
      // whiter hair glowed. The brows stay dark enough to keep the face a face.
      hair: col('#bfb8ac'),
      brow: col('#6f675c'),
      // Barely receding: a higher front line opened a dark cross of scalp
      // between the white sides at this many faces
      hairline: [0.14, 0.1, 0.03],
      hairThick: (y) => 0.015 - 0.009 * smooth(0.15, 0.2, y),
      beard: true,
      girth: 0.92,
      shoulders: 0.97,
      hipsW: 0.98,
      bust: 0,
      upperArmBands: [],
      forearmBands: [],
      chestBands: [],
      seed: 3,
    },
  }
}

/** Kael: woven pandanus wrap, cord belt, spear. Tala and Oru get their own below. */
function dressKael(seg: Segments, st: Style, low: boolean, scale: number, toolHand: number) {
  const sides = low ? 14 : 16
  seg.hips.push(
    wrap(-0.28, sides, weave(col('#b59b62'), col('#937949'), col('#5b3a24'), 12, 21, 5), st.hipsW),
    belt(0.068, sides, 0.183 * st.hipsW, 0.112, 0.122, col('#7d6a48'), col('#5c4c32'), 22),
  )
  seg.hand[toolHand].push(kaelSpear(scale, low))
}

/** Tala: bark-cloth top, pandanus wrap, woven belt and net bag, hair tied up, the coaster's brass. */
function dressTala(seg: Segments, st: Style, low: boolean) {
  const sides = low ? 14 : 16
  seg.hips.push(
    wrap(-0.26, sides, weave(col('#c4ab72'), col('#a08850'), col('#7b3b22'), 3, 31, 5), st.hipsW),
    belt(0.07, sides, 0.186 * st.hipsW, 0.114, 0.124, col('#d2bd8a'), col('#6b4a2a'), 32),
  )
  // Net bag on the right hip, hanging from the belt
  const bag: Sec[] = [
    [-0.17, 0, 0, 0, 0],
    [-0.15, 0.032, 0.03, 0.03, 0],
    [-0.1, 0.048, 0.04, 0.04, 0],
    [-0.04, 0.044, 0.036, 0.036, 0],
    [0.0, 0.026, 0.022, 0.022, 0],
  ]
  const cord = col('#9a8458')
  const gap = col('#3d3224')
  const bagGeo = loft(bag, 7, 'pole', 'cap', (row, c, out) => out.copy((row + c) % 2 === 0 ? cord : gap))
  bagGeo.translate(0.2 * st.hipsW, 0.05, -0.02)
  seg.hips.push(bagGeo)

  // Bark-cloth band round the chest
  const top: Sec[] = [
    [0.055, 0.164, 0.11 + st.bust * 0.6, 0.097, 0],
    [0.1, 0.178, 0.12 + st.bust, 0.102, 0],
    [0.135, 0.186, 0.12 + st.bust, 0.104, 0],
    [0.172, 0.188, 0.11, 0.103, 0],
  ]
  const tapaGeo = loft(top, sides - 4, 'cap', 'cap', tapa(col('#d8c39a'), col('#5a3420'), col('#8a4a2a'), 33, 3))
  tapaGeo.scale(st.girth * (0.5 + st.shoulders * 0.5), 1, st.girth)
  seg.chest.push(tapaGeo)

  // A cord round the neck, dipping to the tag on her breastbone
  const loop = new THREE.TorusGeometry(0.072, 0.0035, 3, low ? 10 : 12)
  loop.rotateX(Math.PI / 2)
  {
    const p = loop.attributes.position
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i)
      const front = Math.max(0, -z / 0.072)
      p.setY(i, p.getY(i) - 0.06 * front * front)
      p.setZ(i, z * (1 + 0.45 * front))
    }
    loop.computeVertexNormals()
  }
  loop.translate(0, 0.245, 0.0)
  seg.chest.push(prim(loop, (_x, _y, _z, out) => out.set(0.32, 0.25, 0.16)))

  // The tag, scavenged from the coaster
  const tag = new THREE.BoxGeometry(0.028, 0.036, 0.004)
  tag.rotateX(-0.25)
  tag.translate(0, 0.168, -0.127 - st.bust * 0.4)
  seg.brassChest.push(
    prim(tag, (x, y, _z, out) => {
      out.set(0.66, 0.5, 0.26)
      if (hash(x * 400, y * 400, 5) > 0.6) out.set(0.34, 0.42, 0.33)
    }),
  )

  // Hair tied up in a knot at the back of the crown
  const bun = new THREE.SphereGeometry(0.046, low ? 6 : 7, 5)
  bun.scale(1, 0.85, 0.95)
  bun.translate(0, 0.19, 0.06)
  seg.head.push(prim(bun, (x, y, z, out) => jitter(out, st.hair, 0.15, x * 90, y * 90 + z * 90, 9)))

  // Goggles pushed up on the forehead: a leather strap round the head, two brass rims
  const strap = new THREE.TorusGeometry(0.092, 0.006, 3, low ? 12 : 14)
  strap.scale(0.9, 1.08, 1)
  strap.rotateX(Math.PI / 2 + 0.5)
  strap.translate(0, 0.14, -0.002)
  seg.head.push(prim(strap, (_x, _y, _z, out) => out.set(0.17, 0.11, 0.07)))
  const rust = (x: number, y: number, z: number, out: THREE.Color) => {
    const h = hash(x * 300, y * 300, z * 300)
    if (h < 0.5) out.set(0.6, 0.45, 0.22)
    else if (h < 0.75) out.set(0.36, 0.42, 0.32)
    else out.set(0.42, 0.24, 0.12)
  }
  for (const s of SIDES) {
    const rim = new THREE.CylinderGeometry(0.019, 0.022, 0.016, 8, 1, true)
    const lens = new THREE.CircleGeometry(0.018, 8)
    lens.rotateX(-Math.PI / 2)
    lens.translate(0, 0.006, 0)
    const rimP = prim(rim, rust)
    const lensP = prim(lens, (_x, _y, _z, out) => out.set(0.09, 0.12, 0.12))
    for (const g of [rimP, lensP]) {
      // Axis tipped forward and up: pushed off the eyes onto the brow
      g.rotateX(-0.6)
      g.translate(s * 0.034, 0.158, -0.092)
      seg.brassHead.push(g)
    }
  }
}

/** Oru: a mantle of shells over the shoulders, a bark-cloth wrap to the knee, the staff. */
function dressOru(seg: Segments, st: Style, low: boolean, scale: number, toolHand: number) {
  const sides = low ? 14 : 16
  seg.hips.push(
    // Rust-brown print on tan. Near-black ink on this few faces read as a chessboard.
    wrap(-0.4, sides, tapa(col('#c4a97e'), col('#8a5634'), col('#7f4528'), 51, 5), st.hipsW),
    belt(0.07, sides, 0.183 * st.hipsW, 0.112, 0.122, col('#6f5a3a'), col('#4a3a26'), 52),
  )
  const mSides = low ? 16 : 18
  const mantle: Sec[] = [
    [0.06, 0.205, 0.12, 0.11, 0],
    [0.12, 0.226, 0.126, 0.116, 0],
    [0.185, 0.25, 0.116, 0.11, 0],
    [0.225, 0.2, 0.09, 0.088, 0.004],
    [0.255, 0.1, 0.068, 0.068, 0.008],
    [0.272, 0.074, 0.058, 0.06, 0.01],
  ]
  // Shells a touch warmer than white, and the gaps between them the fibre
  // backing rather than black: with the first, starker pair the mantle read
  // as a white-and-black chessboard, like armour
  const shellA = col('#ddd0b4')
  const shellB = col('#e8dfcb')
  const shellC = col('#c99e86')
  const gap = col('#6e5a3c')
  const fibre = col('#7a6644')
  const m = loft(mantle, mSides, 'cap', 'open', (row, c, out) => {
    if (row === 0) return out.copy(fibre)
    // Rows of small shells, each face a shell, the rows overlapping like scales
    const h = hash(row, c, 61)
    if ((row + c) % 5 === 0) return out.copy(gap)
    out.copy(h < 0.45 ? shellA : h < 0.8 ? shellB : shellC)
    if (row % 2 === 1) out.multiplyScalar(0.88)
  })
  m.scale(st.girth * st.shoulders, 1, st.girth)
  seg.chest.push(m)
  // Cowries hanging along the hem
  const cowries = low ? 5 : 7
  for (let i = 0; i < cowries; i++) {
    const a = Math.PI * 1.05 + (i / (cowries - 1)) * Math.PI * 0.9
    const sh = new THREE.SphereGeometry(0.014, 4, 3)
    sh.scale(0.8, 1.3, 0.6)
    const x = Math.cos(a) * 0.205 * st.girth * st.shoulders
    const z = Math.sin(a) * 0.125 * st.girth
    sh.translate(x, 0.045, z)
    seg.chest.push(prim(sh, (_x, y, _z, out) => out.copy(y < 0.04 ? shellC : shellB)))
  }
  seg.hand[toolHand].push(oruStaff(scale, low))
}

/**
 * Build one islander. The rig is ready to add to a scene: every mesh is on
 * the detail layer (eye cameras draw it, the sky probe does not) and casts
 * and takes shadow through main's usual scan.
 */
export function buildIslander(id: NpcId, opts?: { lowPower?: boolean }): IslanderRig {
  const low = opts?.lowPower ?? false
  const who = person(id)
  const st = who.style
  const scale = who.height / REF_HEIGHT
  const { body: mat, brass } = materials()
  const toolSide = who.toolSide
  const toolHand = toolSide > 0 ? 0 : 1
  const hasTool = who.tool !== null

  const seg = buildBody(st, low, hasTool ? toolSide : 0)
  if (id === 'kael') dressKael(seg, st, low, scale, toolHand)
  else if (id === 'tala') dressTala(seg, st, low)
  else dressOru(seg, st, low, scale, toolHand)

  const root = new THREE.Group()
  root.name = `Islander:${id}`
  const body = new THREE.Group()
  body.scale.setScalar(scale)
  root.add(body)

  const pivot = (parent: THREE.Object3D, x: number, y: number, z: number, parts: THREE.BufferGeometry[], name: string) => {
    const g = new THREE.Group()
    g.name = name
    g.position.set(x, y, z)
    parent.add(g)
    if (parts.length > 0) {
      const mesh = new THREE.Mesh(merge(parts), mat)
      mesh.name = `${name}Mesh`
      g.add(mesh)
    }
    return g
  }

  const hips = pivot(body, 0, STAND_HIPS, 0, seg.hips, 'hips')
  const spine = pivot(hips, 0, SPINE_Y, 0, seg.spine, 'spine')
  const chest = pivot(spine, 0, CHEST_Y, 0, seg.chest, 'chest')
  const neck = pivot(chest, 0, NECK_Y, 0.005, seg.neck, 'neck')
  const head = pivot(neck, 0, HEAD_Y, 0, seg.head, 'head')
  if (seg.brassHead.length > 0) head.add(new THREE.Mesh(merge(seg.brassHead), brass))
  if (seg.brassChest.length > 0) chest.add(new THREE.Mesh(merge(seg.brassChest), brass))

  const shoulder: THREE.Group[] = []
  const elbow: THREE.Group[] = []
  const wrist: THREE.Group[] = []
  const hip: THREE.Group[] = []
  const knee: THREE.Group[] = []
  const ankle: THREE.Group[] = []
  for (let i = 0; i < 2; i++) {
    const s = SIDES[i]
    const side = s > 0 ? 'R' : 'L'
    shoulder[i] = pivot(chest, s * SHOULDER_X * st.shoulders, SHOULDER_Y, 0.005, seg.upperArm[i], `shoulder${side}`)
    elbow[i] = pivot(shoulder[i], 0, -UPPER_ARM, 0, seg.forearm[i], `elbow${side}`)
    wrist[i] = pivot(elbow[i], 0, -FOREARM, 0, seg.hand[i], `wrist${side}`)
    hip[i] = pivot(hips, s * HIP_X * st.hipsW, HIP_Y, 0, seg.thigh[i], `hip${side}`)
    knee[i] = pivot(hip[i], 0, -THIGH, 0, seg.shin[i], `knee${side}`)
    ankle[i] = pivot(knee[i], 0, -SHIN, 0, seg.foot[i], `ankle${side}`)
  }

  // Small life on the island sits on the detail layer; layers are not inherited
  root.traverse((o) => o.layers.set(DETAIL_LAYER))

  const triangles = countTriangles(root)
  const drawCalls = countMeshes(root)

  // —— pose state ——
  const table = {} as Record<NpcPose, Float32Array>
  for (const p of Object.keys(POSES) as NpcPose[]) table[p] = poseVector(POSES[p], who.tool, who.bias)
  let pose: NpcPose = 'idle'
  const cur = Float32Array.from(table.idle)
  const tgt = Float32Array.from(table.idle)
  /** Weights of the procedural layers that belong to one pose each. */
  const w = { warn: 0, laugh: 0, beckon: 0, curious: 0, watch: 0, sit: 0, reach: 0, swim: 0, wade: 0 }
  let phase = hash(st.seed, 1, 2)
  let gaitW = 0
  let runW = 0
  const look = { yaw: 0, pitch: 0, w: 0, has: false }
  const lookTarget = new THREE.Vector3()
  const seed = st.seed * 1.7

  const X = new THREE.Vector3(1, 0, 0)
  const e = new THREE.Euler()
  const q = new THREE.Quaternion()
  const q2 = new THREE.Quaternion()
  const qInv = new THREE.Quaternion()
  const qChain = new THREE.Quaternion()
  const vT = new THREE.Vector3()
  const vP = new THREE.Vector3()
  const vA = new THREE.Vector3()
  const vB = new THREE.Vector3()
  const vC = new THREE.Vector3()
  const toolDir = new THREE.Vector3()
  const mBasis = new THREE.Matrix4()
  const ikQ = new THREE.Quaternion()

  /** Orientation of a pivot relative to the body group. */
  const chainQuat = (nodes: readonly THREE.Object3D[], out: THREE.Quaternion) => {
    out.identity()
    for (const n of nodes) out.multiply(n.quaternion)
    return out
  }
  /** A point given in the innermost pivot's frame, carried out to the body group's frame. */
  const chainPoint = (nodes: readonly THREE.Object3D[], local: THREE.Vector3, out: THREE.Vector3) => {
    out.copy(local)
    for (let i = nodes.length - 1; i >= 0; i--) out.applyQuaternion(nodes[i].quaternion).add(nodes[i].position)
    return out
  }

  const iT = toolHand
  const iF = 1 - toolHand
  const sT = SIDES[iT]
  const sF = SIDES[iF]
  const toolChain = [hips, spine, chest, shoulder[iT], elbow[iT]]
  const toolChainW = [hips, spine, chest, shoulder[iT], elbow[iT], wrist[iT]]
  const freeChain = [hips, spine, chest, shoulder[iF], elbow[iF]]
  const chestChain = [hips, spine, chest]

  /**
   * Turn a fist so the shaft through it points along `dir` (body frame),
   * keeping the back of the hand as close to the forearm's line as it allows.
   */
  const aimFist = (chain: readonly THREE.Object3D[], wristNode: THREE.Object3D, dir: THREE.Vector3, weight: number) => {
    chainQuat(chain, qChain)
    vA.set(0, -1, 0).applyQuaternion(qChain) // forearm direction
    vC.copy(dir).negate() // hand z: from the point back toward the butt
    vB.copy(vA).addScaledVector(vC, -vA.dot(vC)).negate() // hand y: back up the forearm
    if (vB.lengthSq() < 0.04) vB.set(0, 0, 1).addScaledVector(vC, -vC.z)
    vB.normalize()
    vA.crossVectors(vB, vC)
    mBasis.makeBasis(vA, vB, vC)
    q.setFromRotationMatrix(mBasis)
    q2.copy(qChain).invert().multiply(q)
    if (weight >= 0.999) wristNode.quaternion.copy(q2)
    else wristNode.quaternion.slerp(q2, weight)
  }

  function setArm(i: number, flex: number, abd: number, twist: number, elb: number, wristFlex: number, palm: number) {
    const s = SIDES[i]
    shoulder[i].quaternion.setFromEuler(e.set(flex, s * twist, s * abd, 'XZY'))
    elbow[i].quaternion.setFromAxisAngle(X, Math.max(0, elb))
    wrist[i].quaternion.setFromEuler(e.set(wristFlex, -s * palm, 0, 'YXZ'))
  }

  function update(dt: number, t: number, motion: IslanderMotion) {
    for (let i = 0; i < NP; i++) cur[i] = damp(cur[i], tgt[i], LAMBDA[i], dt)
    w.warn = damp(w.warn, pose === 'warn_spear_raise' ? 1 : 0, 4, dt)
    w.laugh = damp(w.laugh, pose === 'laugh_baffled' ? 1 : 0, 5, dt)
    w.beckon = damp(w.beckon, pose === 'beckon_follow' ? 1 : 0, 4, dt)
    w.curious = damp(w.curious, pose === 'curious_tilt' ? 1 : 0, 3, dt)
    w.watch = damp(w.watch, pose === 'watch_suspicious' && !look.has ? 1 : 0, 2, dt)
    w.reach = damp(w.reach, clamp(motion.reach ?? 0, 0, 1), 3, dt)
    w.swim = damp(w.swim, clamp(motion.swim ?? 0, 0, 1), 3, dt)
    w.wade = damp(w.wade, clamp(motion.wading ?? 0, 0, 1), 3, dt)

    // —— gait ——
    // Body units are reference metres, so a world speed is divided by the scale
    const v = Math.max(0, motion.speed) / scale
    const turn = Math.abs(motion.turnRate ?? 0)
    gaitW = damp(gaitW, smooth(0.05, 0.35, v + turn * 0.12), 6, dt)
    runW = damp(runW, smooth(2.2, 2.9, v), 4, dt)
    const sit = cur[K.sit]
    // Steps per second rise with speed; a run is a quicker, longer stride
    const cadence = (0.6 + 0.3 * Math.min(v, 2.4)) * (1 - runW) + (1.25 + 0.06 * v) * runW
    phase = (phase + cadence * dt * (1 - sit)) % 1
    const duty = 0.62 - 0.26 * runW
    // Feet travel back at exactly ground speed while planted, so they do not skate
    const stride = (v * duty) / cadence
    const lift = (0.075 + 0.09 * runW) * gaitW * (1 - 0.6 * w.wade) * (1 - w.swim)
    const slope = clamp(motion.slope ?? 0, -1.2, 1.2) * (1 - sit) * (1 - w.swim)

    // —— torso ——
    const breathe = Math.sin(TAU * (t / 4.2) + seed)
    const swayX = 0.008 * Math.sin(TAU * (t / 7.3) + seed * 2) * (1 - gaitW)
    let drop = cur[K.drop] + 0.03 * runW * gaitW + 0.06 * Math.min(1, Math.abs(slope)) + 0.28 * w.reach
    const bob = (0.012 + 0.02 * runW) * gaitW * Math.cos(2 * TAU * (phase - duty / 2))
    drop -= bob
    const laughPulse = w.laugh * (0.55 + 0.45 * Math.sin(TAU * 0.45 * t))
    drop += 0.02 * Math.abs(Math.sin(TAU * 3.1 * t)) * laughPulse
    const pelvisYaw = 0.08 * gaitW * Math.sin(TAU * phase) * (1 - 0.5 * runW)
    const hipsY = (STAND_HIPS - drop) * (1 - sit) + SIT_HIPS * sit
    hips.position.set(cur[K.hipX] + swayX, hipsY, cur[K.hipZ])
    hips.quaternion.setFromEuler(e.set(0, pelvisYaw, cur[K.hipRoll] + 0.012 * Math.sin(TAU * (t / 6.1) + seed) * (1 - gaitW), 'YXZ'))

    const lean = -0.05 * Math.min(v, 2.4) * gaitW - 0.1 * runW * gaitW
    const spineP = cur[K.spine] + lean - 0.8 * w.reach - 0.35 * w.swim
    let chestP = cur[K.chest] + 0.012 * breathe - 0.22 * w.reach
    chestP += 0.045 * Math.sin(TAU * 6.2 * t) * laughPulse
    let chestYaw = cur[K.chestYaw] * sF - pelvisYaw * 0.6
    chestYaw += 0.05 * Math.sin(TAU * 0.8 * t) * w.beckon * sF + 0.02 * Math.sin(TAU * 1.15 * t) * w.warn

    // Head: the look target turns the neck, then the head, then a little of the chest
    if (look.has) {
      vT.copy(lookTarget).sub(root.position)
      qInv.copy(root.quaternion).invert()
      vT.applyQuaternion(qInv).multiplyScalar(1 / scale)
      vT.y -= 1.58 - drop * 0.8
      const yawWant = clamp(Math.atan2(-vT.x, -vT.z) - chestYaw, -1.35, 1.35)
      const pitchWant = clamp(Math.atan2(vT.y, Math.hypot(vT.x, vT.z)) - (spineP + chestP) * 0.5, -0.6, 0.5)
      look.yaw = damp(look.yaw, yawWant, 6, dt)
      look.pitch = damp(look.pitch, pitchWant, 6, dt)
      look.w = damp(look.w, 1, 4, dt)
    } else {
      look.w = damp(look.w, 0, 2.5, dt)
      look.yaw = damp(look.yaw, 0.28 * Math.sin(TAU * 0.07 * t + seed) * w.watch, 2, dt)
      look.pitch = damp(look.pitch, 0, 2, dt)
    }
    const ly = look.yaw
    const lp = look.pitch
    spine.quaternion.setFromEuler(e.set(spineP, -pelvisYaw * 0.4 + ly * 0.08, 0, 'YXZ'))
    chest.quaternion.setFromEuler(e.set(chestP, chestYaw + ly * 0.12, -cur[K.hipRoll] * 0.5, 'YXZ'))
    const tilt = cur[K.tilt] + 0.06 * Math.sin(TAU * 0.17 * t + seed) * w.curious
    neck.quaternion.setFromEuler(
      e.set(cur[K.neck] + lp * 0.4 + 0.3 * w.reach + 0.03 * Math.sin(TAU * 6.2 * t + 1.3) * laughPulse, ly * 0.35, tilt * 0.35, 'YXZ'),
    )
    head.quaternion.setFromEuler(e.set(cur[K.head] + lp * 0.6 + 0.2 * w.reach + 0.25 * w.swim, ly * 0.45, tilt * 0.65, 'YXZ'))

    // —— arms ——
    const swingT = (0.22 + 0.4 * runW) * gaitW * (hasTool ? 0.25 : 1) * (1 - w.swim)
    const swingF = (0.22 + 0.4 * runW) * gaitW * (1 - w.swim)
    const phT = sT > 0 ? phase : phase + 0.5
    const phF = sF > 0 ? phase : phase + 0.5
    const elbowRun = (0.15 + 0.9 * runW) * gaitW
    const beck = Math.sin(TAU * 0.8 * t)
    const stroke = TAU * 0.7 * t
    const swimFlex = 1.3 + 0.35 * Math.sin(stroke)
    const swimAbd = 0.45 + 0.45 * (0.5 + 0.5 * Math.cos(stroke))
    const swimElbow = 0.4 + 0.8 * (0.5 - 0.5 * Math.sin(stroke))
    const warm = 0.04 * Math.sin(TAU * 0.9 * t) * sit
    setArm(
      iT,
      mix(cur[K.tFlex] - swingT * Math.cos(TAU * phT) + 0.2 * w.wade + 0.55 * w.reach + warm, swimFlex, w.swim),
      mix(cur[K.tAbd] + 0.045 * Math.sin(TAU * 1.15 * t) * w.warn + 0.3 * w.wade, swimAbd, w.swim),
      cur[K.tTwist] * (1 - w.swim),
      mix(cur[K.tElbow] + (hasTool ? 0 : elbowRun) + 0.4 * w.wade, swimElbow, w.swim),
      cur[K.tWrist],
      cur[K.tPalm] * (1 - w.swim),
    )
    // A beckon shows even from the water: that arm leaves the stroke to wave
    const swimF = w.swim * (1 - w.beckon)
    setArm(
      iF,
      mix(cur[K.fFlex] - swingF * Math.cos(TAU * phF) + 0.22 * beck * w.beckon + 0.2 * w.wade + 0.55 * w.reach - warm, swimFlex, swimF),
      mix(cur[K.fAbd] + 0.3 * w.wade, swimAbd, swimF),
      cur[K.fTwist] * (1 - swimF),
      mix(cur[K.fElbow] + elbowRun + 0.35 * (beck + 1) * w.beckon + 0.4 * w.wade, swimElbow, swimF),
      cur[K.fWrist],
      cur[K.fPalm] * (1 - swimF),
    )

    // —— legs ——
    qInv.copy(hips.quaternion).invert()
    const stand = cur[K.stance]
    for (let i = 0; i < 2; i++) {
      const s = SIDES[i]
      const legPhase = (s > 0 ? phase : phase + 0.5) % 1
      let fz: number
      let up: number
      let toe = 0
      if (legPhase < duty) {
        fz = -stride / 2 + (stride * legPhase) / duty
        up = 0
      } else {
        const k = (legPhase - duty) / (1 - duty)
        fz = stride / 2 - stride * smooth(0, 1, k)
        up = Math.sin(Math.PI * k) * lift
        toe = -0.3 * Math.sin(TAU * k) * gaitW
      }
      fz += (s === sT ? cur[K.tFoot] : cur[K.fFoot]) * (1 - gaitW * 0.7) + 0.28 * w.swim
      up += 0.12 * w.swim * (1 + Math.sin(TAU * 0.7 * t + (s > 0 ? 0 : Math.PI)))
      const fx = s * (HIP_X * st.hipsW + stand)
      vT.set(fx, ANKLE + up + slope * -fz, fz)
      vP.set(s * 0.12, 0, -1)
      if (sit > 0.001) {
        // Cross-legged: each ankle tucked under the other knee, knees out and up
        vA.set(-s * 0.08, 0.075 + (s > 0 ? 0 : 0.03), -0.3)
        vT.lerp(vA, sit)
        vB.set(s, 0.55, -0.4)
        vP.lerp(vB, sit)
      }
      vP.normalize()
      vT.sub(hips.position).applyQuaternion(qInv)
      vP.applyQuaternion(qInv)
      const kneeAngle = solveTwoBone(hip[i].position, vT, vP, THIGH, SHIN, -1, hip[i].quaternion)
      knee[i].quaternion.setFromAxisAngle(X, kneeAngle)
      // The sole stays level with the body (pitched to the slope), or rolls onto its edge to sit
      e.set(Math.atan(slope) * (1 - sit) + toe, s * 0.9 * sit, -s * 1.3 * sit, 'YXZ')
      q.setFromEuler(e).premultiply(qInv)
      q2.copy(hip[i].quaternion).multiply(knee[i].quaternion).invert()
      ankle[i].quaternion.copy(q2).multiply(q)
    }

    // —— the spear or staff, and Kael's second hand on the spear ——
    if (hasTool) {
      toolDir.set(cur[K.toolX] * sT, cur[K.toolY], cur[K.toolZ])
      // A shaft carried on the walk swings a little with the arm
      toolDir.z -= 0.15 * swingT * Math.cos(TAU * phT)
      if (toolDir.lengthSq() < 1e-4) toolDir.set(0, 1, 0)
      toolDir.normalize()
      aimFist(toolChain, wrist[iT], toolDir, 1)
      const grip = who.tool === 'spear' ? clamp(cur[K.grip], 0, 1) * (1 - w.swim) : 0
      if (grip > 0.01) {
        // The free hand closes on the shaft where it passes nearest its own
        // shoulder (but never on top of the other hand), in the chest's frame
        chainPoint(toolChainW, vT.set(0, GRIP_Y, 0), vA)
        chainPoint(chestChain, shoulder[iF].position, vB)
        const along = clamp(vB.sub(vA).dot(toolDir), 0.22, cur[K.gripAt])
        vA.addScaledVector(toolDir, along)
        chainPoint(chestChain, vB.set(0, 0, 0), vC)
        chainQuat(chestChain, qChain)
        qInv.copy(qChain).invert()
        vA.sub(vC).applyQuaternion(qInv)
        // The wrist sits a hand's width short of the shaft, toward the shoulder
        vB.copy(shoulder[iF].position).sub(vA).normalize()
        vA.addScaledVector(vB, 0.065)
        vP.set(sF * 0.5, -0.55, 0.7)
        const elbowIk = solveTwoBone(shoulder[iF].position, vA, vP, UPPER_ARM, FOREARM, 1, ikQ)
        shoulder[iF].quaternion.slerp(ikQ, grip)
        q.setFromAxisAngle(X, elbowIk)
        elbow[iF].quaternion.slerp(q, grip)
        aimFist(freeChain, wrist[iF], toolDir, grip)
      }
    }
  }

  return {
    root,
    id,
    triangles,
    drawCalls,
    height: who.height,
    get pose() {
      return pose
    },
    setPose(next: NpcPose) {
      if (next === pose) return
      pose = next
      tgt.set(table[next])
    },
    update,
    lookAt(target: THREE.Vector3 | null) {
      if (target) {
        lookTarget.copy(target)
        look.has = true
      } else {
        look.has = false
      }
    },
    snapPose() {
      cur.set(tgt)
      w.warn = pose === 'warn_spear_raise' ? 1 : 0
      w.laugh = pose === 'laugh_baffled' ? 1 : 0
      w.beckon = pose === 'beckon_follow' ? 1 : 0
      w.curious = pose === 'curious_tilt' ? 1 : 0
    },
  }
}
