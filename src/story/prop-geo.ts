import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * The small-prop toolkit the story's props and the islanders' camp are built
 * with (the islandlife.ts pattern): parts are plain geometries stripped to
 * position and normal, coloured per vertex or per face, moved into place and
 * merged into a handful of meshes. Everything is deterministic, so the props
 * come out the same every load.
 */

export const TAU = Math.PI * 2
export const UP = new THREE.Vector3(0, 1, 0)
export const smooth = THREE.MathUtils.smoothstep

/** Deterministic 0..1 from a number. */
export const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

export const hex = (h: string) => new THREE.Color(h)

const _m4 = new THREE.Matrix4()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()

/** Non-indexed, with only position and normal, so parts can merge. */
export function stripBasic(geo: THREE.BufferGeometry) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone()
  if (!g.attributes.normal) g.computeVertexNormals()
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal') g.deleteAttribute(k)
  }
  geo.dispose()
  return g
}

export type Painter = (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void

/** A colour per vertex, from where it is: soft gradients (wet bottoms, grain, bleached tops). */
export function paintVerts(geo: THREE.BufferGeometry, pick: Painter) {
  const pos = geo.attributes.position
  const nor = geo.attributes.normal
  const out = new Float32Array(pos.count * 3)
  const p = new THREE.Vector3()
  const n = new THREE.Vector3()
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i)
    n.fromBufferAttribute(nor, i)
    pick(p, n, c)
    c.toArray(out, i * 3)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3))
  return geo
}

/**
 * A colour per triangle, from its middle: crisp bands and patches on a
 * low-poly shape, where per-vertex colour would smear into a gradient.
 * The geometry must be non-indexed.
 */
export function paintFaces(geo: THREE.BufferGeometry, pick: Painter) {
  const pos = geo.attributes.position
  const nor = geo.attributes.normal
  const out = new Float32Array(pos.count * 3)
  const p = new THREE.Vector3()
  const n = new THREE.Vector3()
  const a = new THREE.Vector3()
  const c = new THREE.Color()
  for (let f = 0; f + 2 < pos.count; f += 3) {
    p.set(0, 0, 0)
    n.set(0, 0, 0)
    for (let k = 0; k < 3; k++) {
      p.add(a.fromBufferAttribute(pos, f + k))
      n.add(a.fromBufferAttribute(nor, f + k))
    }
    p.multiplyScalar(1 / 3)
    n.normalize()
    pick(p, n, c)
    for (let k = 0; k < 3; k++) c.toArray(out, (f + k) * 3)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3))
  return geo
}

export function fill(geo: THREE.BufferGeometry, color: THREE.Color) {
  return paintVerts(geo, (_p, _n, c) => {
    c.copy(color)
  })
}

/** A faceted stone (or shell, or coal): an icosahedron with its corners pushed in and out. */
export function lump(seed: number, detail = 0) {
  const g = new THREE.IcosahedronGeometry(1, detail)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    // Keyed on the rounded corner, so every face sharing a corner moves it the
    // same way and the stone stays closed
    const key = Math.round(x * 997) * 0.013 + Math.round(y * 991) * 0.029 + Math.round(z * 983) * 0.041
    const k = 1 + (hash(key + seed * 17.3) - 0.5) * 0.4
    pos.setXYZ(i, x * k, y * k, z * k)
  }
  g.deleteAttribute('uv')
  g.deleteAttribute('normal')
  // Non-indexed, so these come out per face: the facets are the point
  g.computeVertexNormals()
  return g
}

/** Scale, then turn, then move: the same order as an Object3D. */
export function place(
  g: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  q?: THREE.Quaternion,
  sx = 1,
  sy = sx,
  sz = sx,
) {
  _m4.compose(_pos.set(x, y, z), q ?? _quat.identity(), _scale.set(sx, sy, sz))
  return g.applyMatrix4(_m4)
}

export function merge(parts: THREE.BufferGeometry[]) {
  const g = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  if (!g) throw new Error('story props: parts did not merge')
  return g
}

/** Triangles in a geometry, for the budget. */
export function triangles(g: THREE.BufferGeometry) {
  return Math.round((g.index ? g.index.count : g.attributes.position.count) / 3)
}

/**
 * Light the sky would give, carried in the colour of the surface itself. A
 * plain emissive adds the same light to dark basalt and pale driftwood alike,
 * so the stones glowed; scaled by the vertex colour (the albedo) the shade
 * keeps its contrast, as real skylight does.
 */
export function emissiveByAlbedo(shader: { fragmentShader: string }) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <emissivemap_fragment>',
    '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;',
  )
}

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _n = new THREE.Vector3()
const _p = new THREE.Vector3()
const _nm = new THREE.Matrix3()
const _col = new THREE.Color()

/**
 * One draw call's worth of triangles, gathered as plain arrays: position,
 * normal, uv and colour for every corner. Parts are added already coloured
 * (or with one colour for the lot) through the batch's current matrix, so a
 * hut is built in its own frame and dropped onto the hillside in one go.
 */
export class Batch {
  private pos: number[] = []
  private nor: number[] = []
  private uv: number[] = []
  private col: number[] = []
  readonly matrix = new THREE.Matrix4()
  private stack: THREE.Matrix4[] = []

  get triangles() {
    return this.pos.length / 9
  }

  /** Work in a frame of its own for the length of `build`. */
  within(local: THREE.Matrix4, build: () => void) {
    this.stack.push(this.matrix.clone())
    this.matrix.multiply(local)
    build()
    this.matrix.copy(this.stack.pop() as THREE.Matrix4)
  }

  /**
   * A finished part. Its own colours are kept if it has them; otherwise it
   * takes `color`. The geometry is disposed.
   */
  add(geo: THREE.BufferGeometry, color?: THREE.Color) {
    const g = geo.index ? geo.toNonIndexed() : geo
    if (!g.attributes.normal) g.computeVertexNormals()
    const p = g.attributes.position
    const n = g.attributes.normal
    const u = g.attributes.uv
    const c = g.attributes.color
    _nm.getNormalMatrix(this.matrix)
    for (let i = 0; i < p.count; i++) {
      _p.fromBufferAttribute(p, i).applyMatrix4(this.matrix)
      this.pos.push(_p.x, _p.y, _p.z)
      _n.fromBufferAttribute(n, i).applyMatrix3(_nm).normalize()
      this.nor.push(_n.x, _n.y, _n.z)
      if (u) this.uv.push(u.getX(i), u.getY(i))
      else this.uv.push(0, 0)
      if (c) this.col.push(c.getX(i), c.getY(i), c.getZ(i))
      else if (color) this.col.push(color.r, color.g, color.b)
      else this.col.push(1, 1, 1)
    }
    if (g !== geo) g.dispose()
    geo.dispose()
  }

  /** One flat triangle, wound a, b, c. */
  tri(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    color: THREE.Color,
    ua = 0,
    va = 0,
    ub = 0,
    vb = 0,
    uc = 0,
    vc = 0,
  ) {
    _a.copy(a).applyMatrix4(this.matrix)
    _b.copy(b).applyMatrix4(this.matrix)
    _c.copy(c).applyMatrix4(this.matrix)
    _n.subVectors(_b, _a).cross(_p.subVectors(_c, _a)).normalize()
    this.pos.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z)
    for (let k = 0; k < 3; k++) {
      this.nor.push(_n.x, _n.y, _n.z)
      this.col.push(color.r, color.g, color.b)
    }
    this.uv.push(ua, va, ub, vb, uc, vc)
  }

  /**
   * A flat four-cornered piece, corners given anticlockwise as seen from the
   * side it faces. `uv` is [u0, v0, u1, v1]: a = (u0, v0), b = (u1, v0),
   * c = (u1, v1), d = (u0, v1). `colorTop` shades the c–d edge differently.
   */
  quad(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    color: THREE.Color,
    uv?: readonly [number, number, number, number],
    colorTop?: THREE.Color,
  ) {
    const [u0, v0, u1, v1] = uv ?? [0, 0, 1, 1]
    const top = colorTop ?? color
    const pts = [a, b, c, a, c, d]
    const uvs = [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]
    const cols = [color, color, top, color, top, top]
    _a.copy(a).applyMatrix4(this.matrix)
    _b.copy(b).applyMatrix4(this.matrix)
    _c.copy(c).applyMatrix4(this.matrix)
    _n.subVectors(_b, _a).cross(_p.subVectors(_c, _a))
    // A quad folded to a triangle at one end still wants a normal
    if (_n.lengthSq() < 1e-10) {
      _b.copy(d).applyMatrix4(this.matrix)
      _n.subVectors(_c, _a).cross(_p.subVectors(_b, _a))
    }
    _n.normalize()
    for (let k = 0; k < 6; k++) {
      _p.copy(pts[k]).applyMatrix4(this.matrix)
      this.pos.push(_p.x, _p.y, _p.z)
      this.nor.push(_n.x, _n.y, _n.z)
      this.col.push(cols[k].r, cols[k].g, cols[k].b)
      this.uv.push(uvs[k * 2], uvs[k * 2 + 1])
    }
  }

  /** Multiply every colour already in the batch from corner `from` on (to tone a finished part). */
  tint(fromTriangle: number, by: THREE.Color) {
    for (let i = fromTriangle * 9; i < this.col.length; i += 3) {
      this.col[i] *= by.r
      this.col[i + 1] *= by.g
      this.col[i + 2] *= by.b
    }
  }

  build(withUv: boolean) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    if (withUv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.computeBoundingSphere()
    g.computeBoundingBox()
    this.pos = []
    this.nor = []
    this.uv = []
    this.col = []
    return g
  }
}

const _dir = new THREE.Vector3()
const _q = new THREE.Quaternion()

/**
 * A pole from `a` to `b`: a tapered cylinder, coloured by `pick` in its own
 * frame (y runs from -len/2 at `a` to +len/2 at `b`). Open-ended unless capped.
 */
export function pole(
  a: THREE.Vector3,
  b: THREE.Vector3,
  ra: number,
  rb: number,
  sides: number,
  pick: Painter | THREE.Color,
  capped = false,
  rows = 1,
) {
  _dir.subVectors(b, a)
  const len = _dir.length()
  _dir.normalize()
  _q.setFromUnitVectors(UP, _dir)
  const g = stripBasic(new THREE.CylinderGeometry(rb, ra, len, sides, rows, !capped))
  if ((pick as THREE.Color).isColor) fill(g, _col.copy(pick as THREE.Color))
  else paintFaces(g, pick as Painter)
  return place(g, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, _q)
}
