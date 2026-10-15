import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { barrelObject, plankObject } from './wreck'
import { fbm, sampleOcean } from './waves'

/**
 * The second wreck: a small steam coaster that ran onto the island's barrier
 * reef in a blow, a stone's throw from the landing cove. Where the Wanderer is
 * a dive, this one is for looking at: she lies on her side on the crest with
 * her bow lifted, the topsides sheared off forward so the ribs show, a funnel
 * still standing aft, a snapped foremast and its rigging trailing into the
 * lagoon, and sand and coral banked up against her bilge.
 *
 * Everything is modelled in ship-local coordinates (+z bow, +y up, origin at
 * mid-length on the deck line), parked in a pivot that carries the yaw, bow-up
 * pitch and list, then settled onto whatever the island's height field says is
 * under her. The shapes are deterministic, so she is the same every load.
 */

const UP = new THREE.Vector3(0, 1, 0)
const smooth = THREE.MathUtils.smoothstep
const clamp = THREE.MathUtils.clamp

// The lagoon is carved in island.ts relative to these. Mirrored rather than
// imported so this file can't disturb that module.
const ISLAND = { x: 980, z: -680 }
const COVE_BEARING = Math.atan2(148, -205)
/** How far round the reef from the landing pass she lies, in radians. */
const SITE_OFFSET = 0.2

export type ReefWreckOptions = {
  /** World ground height — the island's `heightAt`. */
  heightAt: (x: number, z: number) => number
  lowPower?: boolean
}

const rnd = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

// —— geometry plumbing ————————————————————————————————————————————

const KEEP = ['position', 'normal', 'uv', 'color']

/** Non-indexed, with only position / normal / uv (and colour once painted), so parts can merge. */
function plain(geo: THREE.BufferGeometry, m?: THREE.Matrix4) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone()
  if (m) g.applyMatrix4(m)
  for (const name of Object.keys(g.attributes)) if (!KEEP.includes(name)) g.deleteAttribute(name)
  if (!g.attributes.normal) g.computeVertexNormals()
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
  }
  return g
}

/** Per-vertex colour from a function of position and normal. */
function colorize(
  g: THREE.BufferGeometry,
  fn: (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void,
) {
  const pos = g.attributes.position
  const nor = g.attributes.normal
  const col = new Float32Array(pos.count * 3)
  const p = new THREE.Vector3()
  const n = new THREE.Vector3()
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i)
    n.fromBufferAttribute(nor, i)
    fn(p, n, c)
    col[i * 3] = c.r
    col[i * 3 + 1] = c.g
    col[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}

/** Two-tone mottle, so a flat primitive doesn't read as plastic. */
function paint(
  g: THREE.BufferGeometry,
  base: THREE.ColorRepresentation,
  alt: THREE.ColorRepresentation,
  scale = 0.7,
  shade = 0.16,
) {
  const a = new THREE.Color(base)
  const b = new THREE.Color(alt)
  return colorize(g, (p, _n, out) => {
    const n1 = fbm(p.x * scale + p.y * 0.4 + 7.1, p.z * scale - p.y * scale * 0.6)
    const n2 = fbm(p.z * scale * 2.3 + 1.7, p.x * scale * 2.1 - p.y * 1.9)
    out.copy(a).lerp(b, smooth(n1, 0.4, 0.68))
    out.multiplyScalar(1 - shade + shade * 2 * n2)
  })
}

const merge = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts, false) as THREE.BufferGeometry

// —— hull lines ———————————————————————————————————————————————

/** Overall length. +z is the bow. */
const L = 30

/** [u along the keel, half beam, depth below the deck, section fullness]. */
type Station = [number, number, number, number]

const STATIONS: Station[] = [
  [0.0, 1.7, 3.4, 0.95],
  [0.1, 2.9, 4.0, 0.8],
  [0.25, 3.55, 4.4, 0.74],
  [0.5, 3.75, 4.5, 0.72],
  [0.72, 3.4, 4.4, 0.78],
  [0.88, 2.3, 4.0, 0.92],
  [1.0, 0.18, 3.4, 1.2],
]

function station(u: number) {
  let i = 0
  while (i < STATIONS.length - 2 && STATIONS[i + 1][0] < u) i++
  const a = STATIONS[i]
  const b = STATIONS[i + 1]
  const f = clamp((u - a[0]) / (b[0] - a[0]), 0, 1)
  const s = f * f * (3 - 2 * f)
  return {
    halfBeam: a[1] + (b[1] - a[1]) * s,
    depth: a[2] + (b[2] - a[2]) * s,
    flare: a[3] + (b[3] - a[3]) * s,
  }
}

/** Height of the deck edge above the datum: the bow sweeps up, the stern a little. */
const sheer = (u: number) => 1.05 * Math.pow(u, 3.5) + 0.4 * Math.pow(1 - u, 3)
/** Deck height at a distance along the keel. */
const deckAt = (z: number) => sheer(clamp(z / L + 0.5, 0, 1))

/** A point on the hull skin: v runs -1 at one gunwale, 0 at the keel, +1 at the other. */
function hullPoint(u: number, v: number, out: THREE.Vector3, swell = 1) {
  const st = station(u)
  const th = Math.abs(v) * Math.PI * 0.5
  const k = Math.pow(Math.cos(th), 1.5)
  return out.set(
    Math.sign(v) * st.halfBeam * swell * Math.pow(Math.sin(th), st.flare),
    sheer(u) - st.depth * swell * k,
    // The stem rakes: the keel ends well short of the deck at the bow
    (u - 0.5) * L - 2.6 * smooth(u, 0.8, 1) * k,
  )
}

/** Outward surface normal of the hull skin at (u, v), by differences. */
function hullNormal(u: number, v: number, out: THREE.Vector3) {
  const e = 0.01
  const p0 = hullPoint(u, v, new THREE.Vector3())
  const pu = hullPoint(clamp(u + e, 0, 1), v, new THREE.Vector3()).sub(p0)
  const pv = hullPoint(u, clamp(v + e, -1, 1), new THREE.Vector3()).sub(p0)
  out.crossVectors(pu, pv).normalize()
  // Whichever way the cross product went, outward is away from the keel line
  const inside = new THREE.Vector3(0, -station(u).depth * 0.4, p0.z)
  if (out.dot(p0.clone().sub(inside)) < 0) out.negate()
  return out
}

/**
 * A rectangular grid of points shaped by `at`, minus the quads `keep` rejects.
 * Vertices on a torn edge get bent about so the plating reads as peeled rather
 * than cut.
 */
function grid(
  nu: number,
  nv: number,
  at: (u: number, v: number, out: THREE.Vector3) => void,
  uvAt: (p: THREE.Vector3, u: number, v: number) => [number, number],
  keep: (u: number, v: number) => boolean,
  bend?: (p: THREE.Vector3, seed: number) => void,
  windingUp = true,
) {
  const stride = nv + 1
  const pos: number[] = []
  const uvs: number[] = []
  const p = new THREE.Vector3()
  const kept = new Uint8Array(nu * nv)
  const touchKept = new Uint8Array((nu + 1) * stride)
  const touchGone = new Uint8Array((nu + 1) * stride)

  for (let iu = 0; iu < nu; iu++) {
    for (let iv = 0; iv < nv; iv++) {
      const ok = keep((iu + 0.5) / nu, -1 + (2 * (iv + 0.5)) / nv)
      kept[iu * nv + iv] = ok ? 1 : 0
      for (const [du, dv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const k = (iu + du) * stride + iv + dv
        if (ok) touchKept[k] = 1
        else touchGone[k] = 1
      }
    }
  }

  for (let iu = 0; iu <= nu; iu++) {
    for (let iv = 0; iv <= nv; iv++) {
      const u = iu / nu
      const v = -1 + (2 * iv) / nv
      at(u, v, p)
      const k = iu * stride + iv
      if (bend && touchKept[k] && touchGone[k]) bend(p, k)
      pos.push(p.x, p.y, p.z)
      const [a, b] = uvAt(p, u, v)
      uvs.push(a, b)
    }
  }

  const idx: number[] = []
  for (let iu = 0; iu < nu; iu++) {
    for (let iv = 0; iv < nv; iv++) {
      if (!kept[iu * nv + iv]) continue
      const A = iu * stride + iv
      const B = (iu + 1) * stride + iv
      const C = (iu + 1) * stride + iv + 1
      const D = iu * stride + iv + 1
      if (windingUp) idx.push(A, B, C, A, C, D)
      else idx.push(A, C, B, A, D, C)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

// —— textures —————————————————————————————————————————————————

function canvasTexture(draw: (g: CanvasRenderingContext2D, s: number) => void, size = 256) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')
  if (g) draw(g, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** One riveted iron plate; tiled over the hull it gives seams, rivet lines and rust streaks. */
function plateTexture() {
  return canvasTexture((g, s) => {
    g.fillStyle = '#d9d9d9'
    g.fillRect(0, 0, s, s)
    // Plate-to-plate tone, so the tiling shows as individual strakes
    for (let i = 0; i < 4; i++) {
      g.fillStyle = `rgba(${i % 2 ? '255,255,255' : '0,0,0'},${0.05 + rnd(i) * 0.07})`
      g.fillRect(0, (s / 4) * i, s, s / 4)
    }
    // Rust streaks run down from the seams
    for (let i = 0; i < 26; i++) {
      const x = rnd(i * 3.1) * s
      const y = rnd(i * 5.7) * s * 0.5
      const grad = g.createLinearGradient(0, y, 0, y + s * (0.25 + rnd(i) * 0.4))
      grad.addColorStop(0, 'rgba(70,40,25,0.34)')
      grad.addColorStop(1, 'rgba(70,40,25,0)')
      g.fillStyle = grad
      g.fillRect(x, y, 2 + rnd(i * 1.7) * 5, s)
    }
    // Seams
    g.fillStyle = 'rgba(40,35,32,0.7)'
    g.fillRect(0, 0, s, 3)
    g.fillRect(0, s / 2 - 1, s, 2)
    g.fillRect(0, 0, 3, s)
    // Rivets
    g.fillStyle = 'rgba(30,26,24,0.55)'
    for (let x = 6; x < s; x += 14) {
      g.beginPath()
      g.arc(x, 8, 1.8, 0, Math.PI * 2)
      g.fill()
      g.beginPath()
      g.arc(x, s / 2 + 5, 1.5, 0, Math.PI * 2)
      g.fill()
    }
  })
}

/** Bleached deck planks with butt joints. */
function deckTexture() {
  return canvasTexture((g, s) => {
    g.fillStyle = '#d6d2c6'
    g.fillRect(0, 0, s, s)
    const planks = 4
    for (let i = 0; i < planks; i++) {
      const x = (s / planks) * i
      g.fillStyle = `rgba(${rnd(i * 2.3) > 0.5 ? '255,255,255' : '40,30,20'},${0.04 + rnd(i) * 0.08})`
      g.fillRect(x, 0, s / planks, s)
      g.fillStyle = 'rgba(30,24,18,0.6)'
      g.fillRect(x, 0, 2, s)
      // Butt joint, staggered
      const jy = rnd(i * 4.4) * s
      g.fillRect(x, jy, s / planks, 2)
      // Grain
      g.fillStyle = 'rgba(60,45,30,0.18)'
      for (let k = 0; k < 7; k++) g.fillRect(x + 4 + rnd(i * 9 + k) * (s / planks - 8), 0, 1, s)
    }
  })
}

// —— small parts ——————————————————————————————————————————————

function slackLine(from: THREE.Vector3, to: THREE.Vector3, sag: number, radius: number, segs = 14) {
  const mid = from.clone().lerp(to, 0.5)
  mid.y -= sag
  const q1 = from.clone().lerp(mid, 0.5)
  q1.y -= sag * 0.35
  const q3 = mid.clone().lerp(to, 0.5)
  q3.y -= sag * 0.35
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3([from, q1, mid, q3, to]), segs, radius, 4, false)
}

/** Cylinder between two points. */
function between(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, radial = 6) {
  const dir = b.clone().sub(a)
  const len = dir.length()
  const geo = new THREE.CylinderGeometry(r1, r0, len, radial, 1)
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize())
  return geo.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)))
}

/** Lumpy rock/coral/sand from an icosahedron; displacement depends on position only. */
function lump(radius: number, detail: number, seed: number, rough = 0.3) {
  const geo = new THREE.IcosahedronGeometry(radius, detail)
  const pos = geo.attributes.position
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const ux = v.x / radius
    const uy = v.y / radius
    const uz = v.z / radius
    const n = fbm(ux * 2 + seed, uz * 2 - seed) * 0.6 + fbm(uy * 4.5 + seed * 3, ux * 4.3) * 0.4
    v.multiplyScalar(0.82 + n * rough)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  geo.computeVertexNormals()
  return geo
}

function weedBlade(height: number, width: number, bend: number, segs: number) {
  const geo = new THREE.PlaneGeometry(width, height, 1, segs)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const t = 1 - (pos.getY(i) / height + 0.5) // 0 at the root, 1 at the tip
    pos.setX(i, pos.getX(i) * (1 - 0.55 * t) * (0.8 + 0.4 * Math.sin(t * 6)))
    pos.setZ(i, Math.sin(t * 3) * bend * t)
  }
  // Root at the origin, hanging down
  geo.translate(0, -height / 2, 0)
  geo.computeVertexNormals()
  return geo
}

/** A perched gull: body, head, beak, tail and folded wings, ~170 triangles. */
function gull(scale: number, headTurn: number) {
  const parts: THREE.BufferGeometry[] = []
  const m = new THREE.Matrix4()
  const add = (geo: THREE.BufferGeometry, mat: THREE.Matrix4, shade: (p: THREE.Vector3) => THREE.Color) => {
    const g = plain(geo, mat)
    colorize(g, (p, _n, out) => out.copy(shade(p)))
    parts.push(g)
  }
  const white = new THREE.Color('#e4e2db')
  const grey = new THREE.Color('#8f979c')
  const dark = new THREE.Color('#3b3a38')
  const yellow = new THREE.Color('#d9a73a')
  const body = new THREE.SphereGeometry(1, 8, 6)
  add(body, m.clone().makeScale(0.13, 0.12, 0.27).setPosition(0, 0, 0), (p) =>
    p.y > 0.03 ? grey : white,
  )
  add(new THREE.SphereGeometry(1, 7, 5), new THREE.Matrix4().makeScale(0.07, 0.07, 0.075).setPosition(0, 0.12, 0.2), () => white)
  add(new THREE.ConeGeometry(0.022, 0.1, 5).rotateX(Math.PI / 2), new THREE.Matrix4().makeTranslation(0, 0.115, 0.3), () => yellow)
  add(new THREE.BoxGeometry(0.1, 0.012, 0.16), new THREE.Matrix4().makeRotationX(-0.12).setPosition(0, 0.0, -0.3), () => white)
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.02, 0.07, 0.32), new THREE.Matrix4().makeRotationZ(s * -0.15).setPosition(s * 0.115, 0.045, -0.06), (p) =>
      p.z < -0.17 ? dark : grey,
    )
  }
  const g = merge(parts)
  g.rotateY(headTurn)
  g.scale(scale, scale, scale)
  return g
}

// —— the ship ——————————————————————————————————————————————————

export function createReefWreck(scene: THREE.Scene, opts: ReefWreckOptions) {
  const low = opts.lowPower ?? false
  const { heightAt } = opts

  // —— where she lies ——
  // Find the crest along her bearing rather than trusting a constant, so a
  // retune of the lagoon in island.ts can't leave her floating or buried.
  const bearing = COVE_BEARING + SITE_OFFSET
  const radial = new THREE.Vector3(Math.cos(bearing), 0, Math.sin(bearing)) // out to sea
  const tangent = new THREE.Vector3(-Math.sin(bearing), 0, Math.cos(bearing)) // away from the pass
  let crestR = 330
  {
    let best = -99
    for (let r = 300; r <= 360; r += 1) {
      const h = heightAt(ISLAND.x + radial.x * r, ISLAND.z + radial.z * r)
      if (h > best) {
        best = h
        crestR = r
      }
    }
  }
  const siteR = crestR - 2
  const site = new THREE.Vector3(ISLAND.x + radial.x * siteR, 0, ISLAND.z + radial.z * siteR)

  // Bow swung 25 degrees seaward of the reef line: the stern trails into the
  // lagoon, the bow rides up on the crest
  const heading = tangent.clone().multiplyScalar(Math.cos(0.45)).addScaledVector(radial, Math.sin(0.45))
  const yaw = Math.atan2(heading.x, heading.z)
  // Rotation order Y X Z: list about her own keel, then pitch, then yaw
  const LIST = 0.36
  const PITCH = -0.07
  const SCALE = 1.15
  // Which side faces the lagoon (the one that goes down with the list)
  const inward = radial.clone().negate()
  const sideX = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
  const near = sideX.dot(inward) > 0 ? 1 : -1

  const group = new THREE.Group()
  group.name = 'ReefWreck'
  group.position.set(site.x, 0, site.z)
  scene.add(group)

  const ship = new THREE.Group()
  ship.rotation.order = 'YXZ'
  ship.rotation.set(PITCH, yaw, -near * LIST)
  // A little over life-size for the sailing-coaster class, so she reads from the beach
  ship.scale.setScalar(SCALE)
  group.add(ship)

  // Settle: lower her until the hull's lowest point sits just in the highest
  // ground beneath it
  {
    ship.updateMatrix()
    const q = new THREE.Vector3()
    let lift = -99
    for (let u = 0.1; u <= 0.96; u += 0.06) {
      for (let v = -0.9; v <= 0.9; v += 0.15) {
        hullPoint(u, v, q).applyMatrix4(ship.matrix)
        const g = heightAt(site.x + q.x, site.z + q.z)
        lift = Math.max(lift, g - q.y)
      }
    }
    // Let the keel bury itself a little in the coral
    ship.position.y = lift - 0.25
  }
  ship.updateMatrix()
  ship.updateMatrixWorld(true)
  const toGroup = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(ship.matrix)
  const inv = ship.matrix.clone().invert()
  const toShip = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(inv)
  const worldY = (p: THREE.Vector3) => p.clone().applyMatrix4(ship.matrix).y

  // —— materials ——
  const plate = plateTexture()
  const planks = deckTexture()
  const lit = (extra: THREE.MeshStandardMaterialParameters) =>
    new THREE.MeshStandardMaterial({ vertexColors: true, ...extra })
  const mat = {
    // Skylight stand-in on every lit part: out here the air hemisphere is lit
    // by a near-black sea, so shade would crush to a silhouette
    steel: lit({ map: plate, roughness: 0.84, metalness: 0.2, side: THREE.DoubleSide, emissive: 0x4a423b, emissiveIntensity: 0.8 }),
    deck: lit({ map: planks, roughness: 0.95, side: THREE.DoubleSide, emissive: 0x453f35, emissiveIntensity: 0.7 }),
    fit: lit({ roughness: 0.86, metalness: 0.12, side: THREE.DoubleSide, emissive: 0x403a31, emissiveIntensity: 0.7 }),
    soft: lit({ roughness: 0.92, side: THREE.DoubleSide, emissive: 0x3a4036, emissiveIntensity: 0.5 }),
    reef: lit({ roughness: 1, emissive: 0x3a362c, emissiveIntensity: 0.55 }),
    barnacle: new THREE.MeshStandardMaterial({ color: 0xcfc6b2, roughness: 0.98 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x846a49, roughness: 0.94 }),
    iron: new THREE.MeshStandardMaterial({ color: 0x5a5048, roughness: 0.65, metalness: 0.5, emissive: 0x171a1d, emissiveIntensity: 0.55 }),
  }

  // —— torn plating ——
  // The wound: she struck bows-on and the reef opened the near topsides and
  // sprung the plating forward of the bridge. Aft of that she is whole.
  const BREAK_A = 0.585
  const BREAK_B = 0.8
  const torn = (u: number, v: number) => {
    // Topsides sheared off both sides forward of the hatch
    const shear = 0.74 + (fbm(u * 11 + 3, v * 4) - 0.5) * 0.2
    if (u > BREAK_A && u < BREAK_B && Math.abs(v) > shear) return true
    // The gash in the near side, down toward the waterline
    const nv = v * near
    const hx = (u - 0.69) / 0.075
    const hy = (nv - 0.45) / 0.4
    if (hx * hx + hy * hy < 1 + (fbm(u * 15, v * 14 + 5) - 0.5) * 0.9) return true
    // A smaller breach low on the far side
    const fx = (u - 0.76) / 0.05
    const fy = (nv + 0.68) / 0.22
    return fx * fx + fy * fy < 1 + (fbm(u * 13 + 2, v * 12) - 0.5) * 0.7
  }
  const deckHole = (u: number, v: number) => {
    const jag = (fbm(u * 14 + 2, v * 6) - 0.5) * 0.4
    const hx = (u - 0.69) / 0.115
    const hy = v / 0.85
    return hx * hx + hy * hy < 1 + jag
  }

  const bendEdge = (p: THREE.Vector3, seed: number) => {
    const n = rnd(seed * 1.9)
    p.x *= 0.93 + n * 0.04
    p.y += (rnd(seed * 3.3) - 0.5) * 0.42
    p.z += (rnd(seed * 5.1) - 0.5) * 0.5
  }

  // —— hull skin ——
  const NU = low ? 34 : 52
  const NV = low ? 20 : 30
  const skin = grid(
    NU,
    NV,
    (u, v, out) => hullPoint(u, v, out, 1.0),
    (p, _u, v) => [p.z / 4, v * 5],
    (u, v) => !torn(u, v),
    bendEdge,
    false,
  )
  // Transom: close the stern with a flat plate
  const transom = (() => {
    const rim: THREE.Vector3[] = []
    for (let j = 0; j <= 16; j++) rim.push(hullPoint(0, -1 + (2 * j) / 16, new THREE.Vector3()))
    const verts: number[] = []
    const centre = new THREE.Vector3(0, sheer(0) - 1.5, rim[0].z)
    for (let j = 0; j < 16; j++) {
      for (const q of [centre, rim[j + 1], rim[j]]) verts.push(q.x, q.y, q.z)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((verts.length / 3) * 2), 2))
    g.computeVertexNormals()
    return g
  })()

  // Bulwarks: the plating above the deck edge, cut away at the break
  const bulwarks: THREE.BufferGeometry[] = []
  for (const side of [-1, 1]) {
    const g = grid(
      NU,
      1,
      (u, v, out) => {
        hullPoint(u, side, out)
        if (v > 0) {
          out.y += 0.95 - Math.max(0, (fbm(u * 38 + side, 3) - 0.62) * 2.2)
          out.x *= 0.97
        }
      },
      (p) => [p.z / 4, p.y * 1.4],
      (u) => {
        const wob = (fbm(u * 25 + side * 3, 1) - 0.5) * 0.05
        return u < BREAK_A + wob || u > BREAK_B + wob
      },
      undefined,
      side < 0,
    )
    bulwarks.push(g)
  }

  // —— colouring: rust above the water, weed and crust at it and below ——
  const cPaint = new THREE.Color('#524f49')
  const cPaintAlt = new THREE.Color('#67605a')
  const cTop = new THREE.Color('#8c5233')
  const cTopAlt = new THREE.Color('#b0713f')
  const cBleach = new THREE.Color('#a39682')
  const cLead = new THREE.Color('#8a3d2c')
  const cWeed = new THREE.Color('#6b8a3c')
  const cUnder = new THREE.Color('#7e8a56')
  const cCrust = new THREE.Color('#b0ab92')
  const tmpW = new THREE.Vector3()
  const hullPaint = (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => {
    const wy = tmpW.copy(p).applyMatrix4(ship.matrix).y
    const mott = fbm(p.z * 0.35 + 3, p.x * 0.45 + p.y * 0.55)
    const fine = fbm(p.z * 1.6 + 9, p.y * 1.4 - p.x)
    // Black paint gone to rust in big patches, worst where the spray reaches
    out.copy(cPaint).lerp(cPaintAlt, smooth(mott, 0.35, 0.7))
    const rust = smooth(fbm(p.z * 0.42 + 1.3, p.y * 0.65 + p.x * 0.3 + 4), 0.44, 0.64)
    const lowRust = 1 - smooth(wy, 0.5, 3)
    out.lerp(cTop, clamp(rust * 0.85 + lowRust * 0.35, 0, 1))
    out.lerp(cTopAlt, rust * smooth(fine, 0.5, 0.78) * 0.7)
    out.lerp(cBleach, smooth(fine, 0.66, 0.82) * 0.4 * smooth(wy, 0.5, 2))
    // Underbody and boot-topping: exposed bottom is red lead, then weed
    const bottom = smooth(-n.y, 0.15, 0.6)
    out.lerp(cLead, bottom * smooth(wy, -1.2, 0.2) * 0.85)
    const splash = 1 - clamp(Math.abs(wy + 0.05) / 0.85, 0, 1)
    out.lerp(cWeed, splash * (0.45 + fine * 0.5))
    const wet = 1 - smooth(wy, -0.6, 0.15)
    out.lerp(cUnder, wet * 0.8)
    out.lerp(cCrust, wet * smooth(fbm(p.z * 0.9 + 5, p.y * 0.8 + p.x * 0.6), 0.6, 0.78) * 0.7)
    out.multiplyScalar(0.8 + mott * 0.4)
  }
  colorize(skin, hullPaint)
  colorize(transom, hullPaint)
  for (const g of bulwarks) colorize(g, hullPaint)

  const steelParts = [plain(skin), plain(transom), ...bulwarks.map((g) => plain(g))]
  const steelMesh = new THREE.Mesh(merge(steelParts), mat.steel)
  ship.add(steelMesh)

  // —— deck ——
  const deckGeo = grid(
    low ? 26 : 40,
    low ? 8 : 12,
    (u, v, out) => {
      const st = station(u)
      out.set(v * st.halfBeam * 0.985, sheer(u) - 0.04 + 0.1 * (1 - v * v), (u - 0.5) * L)
    },
    (p) => [p.x * 0.5, p.z * 0.25],
    (u, v) => !deckHole(u, v),
    (p, seed) => {
      p.y -= 0.12 + rnd(seed * 2.7) * 0.35
      p.z += (rnd(seed * 1.3) - 0.5) * 0.3
    },
    true,
  )
  colorize(deckGeo, (p, _n, out) => {
    const m = fbm(p.x * 0.8 + 4, p.z * 0.5)
    out.set('#a39a86').lerp(new THREE.Color('#7f7664'), smooth(m, 0.4, 0.7)).multiplyScalar(0.85 + m * 0.3)
  })
  const deckMesh = new THREE.Mesh(plain(deckGeo), mat.deck)
  ship.add(deckMesh)

  // —— ribs and beams, where the plating is gone ——
  const iron = new THREE.Color('#5d4637')
  const ironAlt = new THREE.Color('#7b5a40')
  const bones: THREE.BufferGeometry[] = []
  const tube = (pts: THREE.Vector3[], r: number, radial = 5) =>
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), low ? 6 : 10, r, radial, false)
  for (let i = 0; i < 9; i++) {
    const u = BREAK_A + 0.01 + (i / 8) * (BREAK_B - BREAK_A - 0.02)
    for (const side of [-1, 1]) {
      // Contiguous run of v on this side where the plating is missing
      let run: THREE.Vector3[] = []
      const flush = () => {
        if (run.length >= 3) {
          // Ribs end ragged: some snapped short, some bent outward
          const cut = rnd(i * 7.3 + side) > 0.55 ? 1 : 0
          const pts = run.slice(0, run.length - cut)
          const last = pts[pts.length - 1]
          pts.push(new THREE.Vector3(last.x + Math.sign(last.x) * 0.22 * rnd(i + side), last.y + 0.18, last.z + 0.1))
          bones.push(tube(pts, 0.065 + rnd(i * 2.2) * 0.02))
        }
        run = []
      }
      for (let j = 0; j <= 40; j++) {
        const v = side * (j / 40)
        if (torn(u, v)) run.push(hullPoint(u, v, new THREE.Vector3()).multiplyScalar(0.99))
        else flush()
      }
      flush()
    }
  }
  // Keel and stringers, showing through the gash
  for (const v of [0, 0.5, -0.5, 0.8, -0.8]) {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= 8; i++) pts.push(hullPoint(0.5 + (0.38 * i) / 8, v, new THREE.Vector3()).multiplyScalar(0.985))
    if (v === 0) bones.push(tube(pts, 0.13, 6))
    else bones.push(tube(pts, 0.05))
  }
  // Deck beams across the hole
  const beamM = new THREE.Matrix4()
  for (let i = 0; i < 7; i++) {
    const u = BREAK_A + 0.01 + (i / 6) * (BREAK_B - BREAK_A - 0.02)
    const st = station(u)
    if (rnd(i * 4.1) < 0.28) continue // some snapped clean away
    const half = st.halfBeam * (0.5 + rnd(i * 6.1) * 0.5)
    beamM.makeTranslation((rnd(i * 2.1) - 0.5) * 0.4, sheer(u) - 0.25 - rnd(i) * 0.3, (u - 0.5) * L)
    bones.push(plain(new THREE.BoxGeometry(half * 1.6, 0.14, 0.2), beamM))
  }
  const boneParts = bones.map((g) => paint(plain(g), iron, ironAlt, 0.9, 0.2))

  // —— fittings: cabin, funnel, mast, winch, hatch, davits ——
  const fit: THREE.BufferGeometry[] = [...boneParts]
  const cream = '#b8ad94'
  const creamAlt = '#8d8470'
  const rustRed = '#7f4733'
  const rustAlt = '#a1613e'
  const darkGlass = '#141b1e'
  const wood = '#7a6648'
  const woodAlt = '#5a4a35'
  const dk = (z: number) => deckAt(z)
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, base: string, alt: string, segs = 2, rot?: [number, number, number]) => {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(rot ?? [0, 0, 0])))
    m.setPosition(x, y, z)
    fit.push(paint(plain(new THREE.BoxGeometry(w, h, d, segs, segs, segs), m), base, alt, 0.9, 0.2))
  }
  const glass = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = plain(new THREE.BoxGeometry(w, h, d), new THREE.Matrix4().makeTranslation(x, y, z))
    colorize(g, (_p, _n, out) => out.set(darkGlass))
    fit.push(g)
  }

  // Accommodation block and wheelhouse
  const bz = -1.7
  const by = dk(bz) + 0.1
  box(5.2, 2.6, 4.2, 0, by + 1.3, bz, cream, creamAlt, 3)
  box(5.5, 0.14, 4.5, 0, by + 2.67, bz, rustRed, rustAlt, 3) // roof
  for (const sx of [-1, 1]) {
    for (const wz of [-2.9, -1.7, -0.5]) glass(0.1, 0.6, 0.72, sx * 2.62, by + 1.6, wz)
  }
  glass(0.1, 1.5, 0.9, 0, by + 0.8, bz - 2.12) // the aft door, stood open on nothing
  box(4.0, 1.9, 2.6, 0, by + 2.74 + 0.95, -1.5, cream, creamAlt, 3) // wheelhouse
  for (const sx of [-1, 1]) for (const wz of [-2.3, -1.1]) glass(0.1, 0.62, 0.78, sx * 2.02, by + 3.9, wz)
  for (const wx of [-1.2, 0, 1.2]) glass(0.8, 0.62, 0.1, wx, by + 3.9, -0.2)
  box(4.2, 0.1, 1.2, 0, by + 4.7, -0.6, rustRed, rustAlt, 2) // roof boards, front half only
  box(0.14, 0.14, 2.6, 1.3, by + 4.66, -2.0, woodAlt, wood, 1) // the rafter the rest hung from
  // Ladder up the front of the block
  for (const lx of [-0.2, 0.2]) fit.push(paint(plain(new THREE.BoxGeometry(0.05, 2.4, 0.05), new THREE.Matrix4().makeTranslation(lx - 1.2, by + 1.2, 0.5)), '#4f4338', '#6a5a46'))
  for (let i = 0; i < 6; i++) fit.push(paint(plain(new THREE.BoxGeometry(0.46, 0.04, 0.04), new THREE.Matrix4().makeTranslation(-1.2, by + 0.35 + i * 0.38, 0.5)), '#4f4338', '#6a5a46'))

  // Engine casing and the funnel
  const cz = -6.1
  box(3.5, 1.3, 3.2, 0, dk(cz) + 0.65, cz, rustRed, rustAlt, 3)
  const funnelGeo = new THREE.CylinderGeometry(0.95, 1.08, 5.4, low ? 12 : 18, 5, true)
  {
    const pos = funnelGeo.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      const a = Math.atan2(pos.getZ(i), pos.getX(i))
      // Elliptical, dented, and the rim torn down on one side
      pos.setX(i, pos.getX(i) * 1.12)
      const dent = (fbm(a * 2 + 5, y * 0.5) - 0.5) * 0.28
      pos.setX(i, pos.getX(i) * (1 + dent * 0.6))
      pos.setZ(i, pos.getZ(i) * (1 + dent))
      if (y > 2.6) pos.setY(i, y - Math.max(0, (Math.cos(a - 2.2) + 0.2)) * 1.5 * (fbm(a * 3, 4) + 0.3))
    }
    funnelGeo.computeVertexNormals()
  }
  {
    const m = new THREE.Matrix4().makeRotationX(-0.11).setPosition(0, dk(cz) + 1.3 + 2.7, cz)
    const g = plain(funnelGeo, m)
    const c1 = new THREE.Color('#a05c3a')
    const c2 = new THREE.Color('#6f3d2b')
    const soot = new THREE.Color('#2f2b28')
    colorize(g, (p, _n, out) => {
      const rel = p.y - (dk(cz) + 1.3)
      const m1 = fbm(p.x * 0.9 + 2, p.y * 0.6)
      out.copy(c1).lerp(c2, smooth(m1, 0.4, 0.7))
      out.lerp(soot, smooth(rel, 4.0, 4.7))
      out.multiplyScalar(0.8 + fbm(p.y * 1.7, p.x * 1.4) * 0.4)
    })
    fit.push(g)
    // Steam pipe and whistle
    fit.push(paint(plain(new THREE.CylinderGeometry(0.07, 0.07, 1.6, 6), new THREE.Matrix4().makeTranslation(0.0, dk(cz) + 1.3 + 3.6, cz - 1.15)), '#6a4f35', '#8a6a40'))
  }
  // Funnel stays — one gone slack
  const funnelTop = new THREE.Vector3(0, dk(cz) + 1.3 + 4.6, cz - 0.4)
  const stayLines: THREE.BufferGeometry[] = []
  const rope = new THREE.Color('#8d7c5c')
  const ropeDark = new THREE.Color('#5d5140')
  const addRope = (g: THREE.BufferGeometry, dark = false) => {
    const p = plain(g)
    colorize(p, (_pp, _n, out) => out.copy(dark ? ropeDark : rope))
    stayLines.push(p)
  }
  for (const sx of [-1, 1]) {
    const hb = station(0.2).halfBeam
    addRope(slackLine(funnelTop, new THREE.Vector3(sx * (hb - 0.3), dk(cz + 2) + 0.2, cz + 2.4), sx === near ? 1.4 : 0.15, 0.025))
    addRope(slackLine(funnelTop, new THREE.Vector3(sx * (hb - 0.4), dk(cz - 2) + 0.2, cz - 2.4), 0.2, 0.025))
  }

  // Hatch coaming — three walls left, the cover boards thrown about
  const hz = 4.2
  box(0.12, 0.62, 3.6, -1.6 * near, dk(hz) + 0.3, hz, woodAlt, wood, 2)
  box(3.2, 0.62, 0.12, 0, dk(hz - 1.8) + 0.3, hz - 1.8, woodAlt, wood, 2)
  for (const [bw, bx, bz2, bry, brz] of [[0.34, 0.4, 3.4, 0.5, 0.4], [0.3, -0.5, 4.8, -0.3, -0.5], [0.34, 1.0, 5.6, 0.1, 0.9]] as number[][]) {
    box(bw, 0.06, 2.3, bx, dk(bz2) - 0.1, bz2, wood, woodAlt, 1, [0.1, bry, brz])
  }
  // Winch
  box(1.3, 0.5, 1.5, 0, dk(7.9) + 0.25, 7.9, '#4b4036', '#6a5545', 2)
  for (const dx of [-0.55, 0.55]) {
    const g = plain(new THREE.CylinderGeometry(0.24, 0.24, 0.55, 8), new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(dx, dk(7.9) + 0.6, 7.9))
    fit.push(paint(g, '#4b4036', '#6a5545'))
  }
  // Ventilator cowl and bollards on the poop
  {
    const vz = -11.3
    const stem = plain(new THREE.CylinderGeometry(0.2, 0.22, 0.9, 8), new THREE.Matrix4().makeTranslation(-1.1, dk(vz) + 0.45, vz))
    fit.push(paint(stem, rustRed, rustAlt))
    const cowl = plain(new THREE.SphereGeometry(0.34, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.62), new THREE.Matrix4().makeRotationX(0.9).setPosition(-1.1, dk(vz) + 1.05, vz))
    fit.push(paint(cowl, rustRed, rustAlt))
    for (const bx of [-1.8, 1.8]) {
      fit.push(paint(plain(new THREE.CylinderGeometry(0.13, 0.17, 0.5, 7), new THREE.Matrix4().makeTranslation(bx, dk(-13.6) + 0.25, -13.6)), '#3f3830', '#5a4d40'))
    }
  }

  // Davits on the high side, the lifeboat long gone
  for (const dz of [-8.6, -11.6]) {
    const side = -near
    const hb = station(dz / L + 0.5).halfBeam
    const base = new THREE.Vector3(side * (hb - 0.25), dk(dz) + 0.5, dz)
    const arc = new THREE.TorusGeometry(1.5, 0.06, 5, 12, Math.PI * 0.55)
    arc.rotateZ(side > 0 ? Math.PI * 0.5 - Math.PI * 0.55 : Math.PI * 0.5)
    arc.translate(base.x - side * 1.5 * 0, base.y + 0.1, base.z)
    fit.push(paint(plain(arc), '#4f4338', '#6a5a46'))
    addRope(slackLine(new THREE.Vector3(base.x + side * 1.45, base.y + 1.45, base.z), new THREE.Vector3(base.x + side * 1.35, base.y - 1.3, base.z), 0.1, 0.02), true)
  }

  // —— foremast: snapped, with its yard down and the rigging tangled ——
  const mastBase = new THREE.Vector3(0.1, dk(10.4) + 0.05, 10.4)
  const mastTop = new THREE.Vector3(-0.35 * near, mastBase.y + 6.3, 10.2)
  fit.push(paint(plain(between(mastBase, mastTop, 0.26, 0.17, 9)), '#8d7655', '#6f5b40', 1.1, 0.2))
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(Math.sin(i * 2.1) * 0.35, 0, Math.cos(i * 1.7) * 0.35))
    m.setPosition(mastTop.x + Math.cos(i * 1.7) * 0.09, mastTop.y + 0.18 + i * 0.03, mastTop.z + Math.sin(i * 1.7) * 0.09)
    fit.push(paint(plain(new THREE.ConeGeometry(0.06, 0.55 + i * 0.15, 4), m), '#a38a64', '#7e6a4c'))
  }
  box(1.5, 0.1, 0.14, mastBase.x, mastBase.y + 4.9, 10.3, '#6a5740', '#8d7655', 1) // crosstrees
  // The yard, snapped off and hanging by its lifts into the lagoon
  const yardA = new THREE.Vector3(mastTop.x, mastTop.y - 0.4, mastTop.z + 0.2)
  const sea = toGroup(near * 5.8, 0, 8.5)
  sea.y = -0.9
  const yardB = toShip(sea.x, sea.y, sea.z)
  fit.push(paint(plain(between(yardA, yardB, 0.12, 0.09, 7)), '#8d7655', '#6f5b40', 1.1, 0.2))
  // Rigging, parted and tangled
  const hbF = station(0.8).halfBeam
  addRope(slackLine(mastTop.clone().setY(mastTop.y - 0.3), new THREE.Vector3(near * (hbF - 0.1), dk(8.4) + 0.4, 8.4), 1.1, 0.03))
  addRope(slackLine(mastTop.clone().setY(mastTop.y - 0.3), new THREE.Vector3(-near * (hbF - 0.1), dk(8.4) + 0.4, 8.4), 0.12, 0.03))
  addRope(slackLine(mastTop.clone().setY(mastTop.y - 0.5), new THREE.Vector3(-near * 1.4, dk(14.2) + 1.1, 14.2), 0.5, 0.025))
  addRope(slackLine(yardB.clone().lerp(yardA, 0.15), yardB.clone().add(new THREE.Vector3(near * 1.2, 0.4, 2.8)), 0.5, 0.03), true)
  addRope(slackLine(yardA.clone().add(new THREE.Vector3(0, 0.5, 0)), yardB.clone().add(new THREE.Vector3(-near * 0.4, 1.4, -1.6)), 1.6, 0.025), true)
  addRope(slackLine(mastTop.clone().setY(mastTop.y - 0.8), yardB.clone().lerp(yardA, 0.45).add(new THREE.Vector3(0, 0, 0.6)), 0.8, 0.025))
  // A coil on the deck
  {
    const coil = new THREE.TorusGeometry(0.35, 0.06, 5, 12)
    coil.rotateX(Math.PI / 2)
    coil.translate(1.4, dk(-5) + 0.06, -9.5)
    addRope(coil)
  }

  // Anchor chain out of the hawsepipe, over the bow
  {
    const stem = hullPoint(0.97, near, new THREE.Vector3())
    const chainEnd = toShip(...(() => {
      const w = toGroup(stem.x, stem.y, stem.z)
      return [w.x + near * 0.5, -1.2, w.z + 0.4] as const
    })())
    const chain = plain(slackLine(stem.clone().add(new THREE.Vector3(0, -0.5, 0.1)), chainEnd, 0.4, 0.06, 10))
    colorize(chain, (_p, _n, out) => out.set('#4c3b2e'))
    fit.push(chain)
  }

  const fitMesh = new THREE.Mesh(merge([...fit, ...stayLines]), mat.fit)
  ship.add(fitMesh)

  // —— sail rag draped over the broken yard ——
  const sailW = 3.0
  const sailH = 3.6
  const sailGeo = new THREE.PlaneGeometry(sailW, sailH, low ? 4 : 7, low ? 5 : 8)
  {
    const pos = sailGeo.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      const t = 0.5 - y / sailH
      const rag = (fbm(x * 1.3 + 11, y * 1.1 + 4) - 0.5) * 1.4
      pos.setX(i, x * (1 - t * 0.2) + rag * t * 0.5)
      pos.setY(i, y + rag * t * t * 1.2)
    }
    sailGeo.translate(0, -sailH / 2, 0)
    sailGeo.computeVertexNormals()
  }
  const sailRest = Float32Array.from(sailGeo.attributes.position.array)
  colorize(sailGeo, (p, _n, out) => {
    out.set('#c2b79e').lerp(new THREE.Color('#8a7f68'), smooth(fbm(p.x * 0.8, p.y * 0.8 + 3), 0.4, 0.7))
  })
  const sailMesh = new THREE.Mesh(sailGeo, mat.soft)
  {
    const hang = yardB.clone().lerp(yardA, 0.55)
    sailMesh.position.copy(hang)
    // Hangs by gravity: its own upright frame, across the ship
    sailMesh.quaternion.copy(new THREE.Quaternion().setFromRotationMatrix(ship.matrix).invert())
    sailMesh.rotateY(yaw + 0.5)
  }
  ship.add(sailMesh)
  const sailPos = sailGeo.attributes.position

  // —— fouling: barnacle crust and hanging weed ——
  const barnacleN = low ? 90 : 260
  {
    const cone = new THREE.ConeGeometry(1, 1, 5)
    cone.translate(0, 0.45, 0)
    const bm = new THREE.InstancedMesh(cone, mat.barnacle, barnacleN)
    const pos = new THREE.Vector3()
    const nor = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const roll = new THREE.Quaternion()
    const scl = new THREE.Vector3()
    const colour = new THREE.Color()
    let n = 0
    for (let tries = 0; tries < barnacleN * 14 && n < barnacleN; tries++) {
      const u = 0.06 + rnd(tries * 1.31) * 0.9
      const v = rnd(tries * 2.17) * 2 - 1
      if (torn(u, v)) continue
      hullPoint(u, v, pos)
      const wy = worldY(pos)
      // Dense through the splash zone and just below; thinner deeper; none high
      const dens = wy > 0.9 ? 0 : wy > 0.15 ? 0.5 : 1
      const cluster = smooth(fbm(u * 22 + 3, v * 7 - 2), 0.46, 0.64)
      if (rnd(tries * 3.7) > dens * cluster) continue
      hullNormal(u, v, nor)
      const s = 0.04 + rnd(tries * 5.3) * 0.075
      q.setFromUnitVectors(UP, nor)
      roll.setFromAxisAngle(UP, tries * 2.399)
      q.multiply(roll)
      scl.set(s * 0.9, s, s * 0.9)
      bm.setMatrixAt(n, new THREE.Matrix4().compose(pos.clone().addScaledVector(nor, 0.01), q, scl))
      colour.set('#d6cdb8').lerp(new THREE.Color('#9d9378'), rnd(tries * 9.1))
      bm.setColorAt(n, colour)
      n++
    }
    bm.count = n
    bm.instanceMatrix.needsUpdate = true
    if (bm.instanceColor) bm.instanceColor.needsUpdate = true
    bm.userData.noCast = true
    ship.add(bm)
  }

  const softParts: THREE.BufferGeometry[] = []
  // Weed streaming off the exposed side where the hull comes out of the water
  {
    const m = new THREE.Matrix4()
    const v3 = new THREE.Vector3()
    const nor = new THREE.Vector3()
    const wc1 = new THREE.Color('#566b34')
    const wc2 = new THREE.Color('#8a7b3c')
    let clump = 0
    for (let ui = 0; ui < (low ? 7 : 12); ui++) {
      const u = 0.1 + (ui / 11) * 0.82
      // Walk down the high side from the gunwale to where it meets the sea
      for (let v = -near * 1.0; Math.abs(v) > 0.02; v += near * 0.02) {
        hullPoint(u, v, v3)
        if (worldY(v3) < 0.1) {
          if (torn(u, v)) break
          hullNormal(u, v, nor)
          for (let b = 0; b < (low ? 2 : 3); b++) {
            const geo = weedBlade(0.9 + rnd(clump * 3 + b) * 1.5, 0.22 + rnd(b + clump) * 0.18, 0.2, 4)
            m.makeRotationY(clump * 1.9 + b * 2.1)
            m.setPosition(v3.x + nor.x * 0.08 + (rnd(b) - 0.5) * 0.3, v3.y + nor.y * 0.08, v3.z + (rnd(b + 4) - 0.5) * 0.5)
            const g = plain(geo, m)
            colorize(g, (p, _n, out) => out.copy(wc1).lerp(wc2, smooth(-p.y + v3.y, 0.3, 1.8)))
            softParts.push(g)
          }
          clump++
          break
        }
      }
    }
    // And a drift of it hung from the fallen yard
    for (let b = 0; b < (low ? 3 : 6); b++) {
      const at = yardB.clone().lerp(yardA, 0.1 + b * 0.09)
      const geo = weedBlade(0.8 + rnd(b * 2.3) * 0.9, 0.25, 0.15, 4)
      const g = plain(geo, new THREE.Matrix4().makeRotationY(b * 1.3).setPosition(at.x, at.y, at.z))
      colorize(g, (_p, _n, out) => out.copy(wc1).lerp(wc2, rnd(b)))
      softParts.push(g)
    }
  }

  // Gulls, if any: they've only just landed, so each looks a different way
  {
    const perches: [THREE.Vector3, number, number][] = [
      [hullPoint(0.985, 0, new THREE.Vector3()).add(new THREE.Vector3(0, 1.0, -0.2)), 1.0, 2.4],
      [new THREE.Vector3(0.3, dk(cz) + 1.3 + 4.62, cz + 0.55), 1.0, -0.8],
      [new THREE.Vector3(mastTop.x + 0.01, mastTop.y + 0.62, mastTop.z), 0.95, 1.1],
      [new THREE.Vector3(-1.4, by + 4.82, -2.9), 1.0, 0.4],
    ]
    for (const [at, s, turn] of low ? perches.slice(0, 2) : perches) {
      softParts.push(plain(gull(s, turn), new THREE.Matrix4().makeTranslation(at.x, at.y, at.z)))
    }
  }
  const softMesh = new THREE.Mesh(merge(softParts), mat.soft)
  softMesh.userData.noCast = true
  ship.add(softMesh)

  // —— sand and coral banked against her, resting on the real ground ——
  const reefParts: THREE.BufferGeometry[] = []
  {
    const sand = [new THREE.Color('#dcd2ae'), new THREE.Color('#c6ba94')]
    const coral = [
      new THREE.Color('#cdb99c'),
      new THREE.Color('#b98c76'),
      new THREE.Color('#8e9a62'),
      new THREE.Color('#d9d3c4'),
    ]
    const q = new THREE.Vector3()
    const placeAt = (gx: number, gz: number, geo: THREE.BufferGeometry, lift: number) => {
      const g = heightAt(site.x + gx, site.z + gz)
      return plain(geo, new THREE.Matrix4().makeTranslation(gx, g + lift, gz))
    }
    // Sand: drifts running along both bilges, deepest on the lagoon side
    let k = 0
    for (const [side, outward, stations] of [
      [near, 0.9, [0.14, 0.32, 0.5, 0.68, 0.86]],
      [-near, 0.8, [0.25, 0.55, 0.85]],
    ] as [number, number, number[]][]) {
      for (const u of stations) {
        hullPoint(u, side * 0.82, q)
        const w = toGroup(q.x, q.y, q.z)
        const lat = new THREE.Vector3(sideX.x * side, 0, sideX.z * side) // outward from the keel line
        const r = 1.1 + rnd(k * 1.7) * 0.9
        const geo = lump(r, low ? 1 : 2, k * 2.9 + 1, 0.5)
        geo.scale(1.3 + rnd(k) * 0.6, 0.17 + rnd(k + 9) * 0.1, 0.85)
        geo.rotateY(k * 1.37)
        const g = placeAt(w.x + lat.x * outward, w.z + lat.z * outward, geo, -0.08)
        colorize(g, (p, _n, out) => {
          out.copy(sand[0]).lerp(sand[1], smooth(fbm(p.x * 0.7 + 2, p.z * 0.7), 0.4, 0.7))
          // Wind ripple lines across the drift
          out.multiplyScalar(0.86 + fbm(p.x * 1.6 + p.z * 3.1, p.z * 1.6 - p.x * 0.5) * 0.28)
        })
        reefParts.push(g)
        k++
      }
    }
    // Coral gathered at the bow and the high side where she took the crest
    const cluster = (gx: number, gz: number, kind: number, seed: number) => {
      const c = coral[Math.floor(rnd(seed) * 4)]
      const c2 = coral[Math.floor(rnd(seed + 7) * 4)]
      let geo: THREE.BufferGeometry
      if (kind === 0) {
        geo = lump(0.5 + rnd(seed * 2) * 0.55, low ? 1 : 2, seed, 0.5) // brain coral
        geo.scale(1, 0.75, 1)
      } else if (kind === 1) {
        // Dead coral rubble: broken heads and a plate or two, piled loose
        const bits: THREE.BufferGeometry[] = []
        for (let b = 0; b < 3; b++) {
          const piece = lump(0.22 + rnd(seed + b) * 0.3, 1, seed + b * 4, 0.55)
          piece.scale(1.2, 0.55, 1)
          piece.translate((rnd(seed * 2 + b) - 0.5) * 1.1, 0.05, (rnd(seed * 3 + b) - 0.5) * 1.1)
          bits.push(plain(piece))
        }
        geo = merge(bits)
      } else {
        // Staghorn: a fan of tapering branches
        const br: THREE.BufferGeometry[] = []
        for (let b = 0; b < (low ? 4 : 7); b++) {
          const a = b * 2.399 + seed
          const lean = 0.35 + rnd(b + seed) * 0.5
          const h = 0.7 + rnd(b * 3 + seed) * 0.8
          const cyl = new THREE.CylinderGeometry(0.035, 0.1, h, 5)
          cyl.translate(0, h / 2, 0)
          cyl.rotateZ(Math.cos(a) * lean)
          cyl.rotateX(Math.sin(a) * lean)
          br.push(plain(cyl))
        }
        geo = merge(br)
      }
      const g = placeAt(gx, gz, geo, -0.05)
      colorize(g, (p, _n, out) => out.copy(c).lerp(c2, smooth(fbm(p.x * 2.2 + seed, p.z * 2.2 + p.y), 0.35, 0.7)))
      reefParts.push(g)
    }
    const bowW = toGroup(0, 0, 14)
    const heap = low ? 7 : 16
    for (let i = 0; i < heap; i++) {
      const a = i * 2.399 + 0.7
      const r = 2.5 + (i / heap) * 9
      const cx = bowW.x + Math.cos(a) * r * 0.9 + radial.x * 2
      const cz2 = bowW.z + Math.sin(a) * r * 0.9 + radial.z * 2
      cluster(cx, cz2, i % 3, i * 5.3 + 2)
    }
    // A few along the sheltered side too, tucked into the sand
    for (let i = 0; i < (low ? 4 : 9); i++) {
      const u = 0.12 + i * 0.1
      hullPoint(u, near * 0.95, q)
      const w = toGroup(q.x, q.y, q.z)
      cluster(w.x + sideX.x * near * (3.4 + rnd(i) * 2), w.z + sideX.z * near * (3.4 + rnd(i) * 2), (i + 1) % 3, i * 3.1 + 40)
    }
  }
  const reefMesh = new THREE.Mesh(merge(reefParts), mat.reef)
  reefMesh.userData.noCast = true
  group.add(reefMesh)

  // —— flotsam in the lagoon, riding the swell ——
  const flotsam: { object: THREE.Object3D; x: number; z: number; spin: number; phase: number; rest: THREE.Quaternion; lift: number }[] = []
  {
    const sternW = toGroup(0, 0, -17)
    const add = (object: THREE.Object3D, dx: number, dz: number, spin: number, phase: number, lift: number) => {
      group.add(object)
      // Parked on the lagoon before the first frame, not inside the hull at the group origin
      object.position.set(sternW.x + dx, lift, sternW.z + dz)
      flotsam.push({ object, x: sternW.x + dx, z: sternW.z + dz, spin, phase, rest: object.quaternion.clone(), lift })
    }
    add(plankObject(2.6, 0.34, mat.wood), -near * sideX.x * 5 + 2, 2, 0.04, 0, 0.04)
    add(plankObject(1.7, 0.26, mat.wood), near * sideX.x * 6 - 3, -4, -0.05, 2.1, 0.03)
    add(barrelObject(mat.wood, mat.iron), near * sideX.x * 8, 5, 0.06, 3.7, 0.12)
  }

  // —— collision ————————————————————————————————————————————
  // The hull below the deck is a rounded-square section along the keel, a hair
  // inside the plating so a corner can be clipped rather than hit a wall that
  // isn't there. Everything above the deck is out of any swimmer's reach.
  const local = new THREE.Vector3()
  const centreWorld = new THREE.Vector3(site.x, 0, site.z)
  function resolve(p: { x: number; y: number; z: number }) {
    const dx0 = p.x - centreWorld.x
    const dz0 = p.z - centreWorld.z
    if (dx0 * dx0 + dz0 * dz0 > 24 * 24) return
    local.set(p.x - site.x, p.y, p.z - site.z).applyMatrix4(inv)
    const u = local.z / L + 0.5
    if (u < 0.02 || u > 0.97) return
    const st = station(u)
    const a = st.halfBeam * 0.97
    const centreY = -st.depth * 0.42
    const top = sheer(u) + 0.05
    const dy = local.y - centreY
    const b = dy < 0 ? st.depth * 0.6 : top - centreY
    const nx = Math.abs(local.x / a)
    const ny = Math.abs(dy / b)
    const k = Math.cbrt(nx * nx * nx + ny * ny * ny)
    if (k >= 1 || k < 1e-4) return
    const f = 1.004 / k
    local.x = (local.x / a) * f * a
    local.y = centreY + (dy / b) * f * b
    local.applyMatrix4(ship.matrix)
    p.x = site.x + local.x
    p.y = local.y
    p.z = site.z + local.z
  }

  /** Not climbable: the deck stands too high out of the water and heels too far. */
  const standAt = (_x: number, _z: number) => -1000

  // —— per-frame ————————————————————————————————————————————
  const centre = new THREE.Vector3(site.x, 1, site.z)
  const waveUp = new THREE.Vector3()
  const tilt = new THREE.Quaternion()
  const spinQ = new THREE.Quaternion()
  function update(time: number, camera: THREE.Camera) {
    // Per-vertex and per-object work only earns its keep once you're close enough to read it
    if (camera.position.distanceToSquared(centre) > 260 * 260) return
    for (const item of flotsam) {
      const water = sampleOcean(item.x + site.x, item.z + site.z, time)
      item.object.position.set(item.x, water.y + item.lift, item.z)
      waveUp.set(water.normal.x, water.normal.y, water.normal.z)
      tilt.setFromUnitVectors(UP, waveUp)
      spinQ.setFromAxisAngle(UP, item.phase + time * item.spin)
      item.object.quaternion.copy(tilt).multiply(spinQ).multiply(item.rest)
    }
    if (camera.position.distanceToSquared(centre) > 120 * 120) return
    for (let i = 0; i < sailPos.count; i++) {
      const bx = sailRest[i * 3]
      const by2 = sailRest[i * 3 + 1]
      const slack = clamp(-by2 / sailH, 0, 1)
      const flap = Math.sin(time * 1.7 + bx * 0.85 + by2 * 0.5) * 0.35 + Math.sin(time * 2.9 + bx * 1.8) * 0.12
      sailPos.setX(i, bx + flap * slack * 0.1)
      sailPos.setZ(i, flap * slack)
    }
    sailPos.needsUpdate = true
    sailGeo.computeVertexNormals()
  }

  group.updateMatrixWorld(true)
  if (import.meta.env.DEV) {
    // Dev only: lets the shot scripts find her without duplicating the placement maths
    ;(window as unknown as Record<string, unknown>).__reefWreck = {
      site: { x: site.x, z: site.z },
      yaw,
      near,
      shipY: ship.position.y,
      resolve,
      tris: () => {
        let n = 0
        group.traverse((o) => {
          const m = o as THREE.Mesh
          if (!m.isMesh) return
          const per = m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count
          n += (per / 3) * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1)
        })
        return Math.round(n)
      },
      toWorld: (x: number, y: number, z: number) => {
        const w = toGroup(x, y, z)
        return { x: site.x + w.x, y: w.y, z: site.z + w.z }
      },
    }
  }
  return {
    group,
    /** Mid-hull in the world, a metre up. */
    position: centre,
    /** Which way she heads, for tuning and for aiming a camera at her. */
    yaw,
    resolve,
    standAt,
    update,
  }
}
