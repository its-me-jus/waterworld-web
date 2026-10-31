import * as THREE from 'three'

/**
 * Leaves and bark, painted once at load.
 *
 * Every crown on the island was a few smooth lumps, and however well they are
 * lit a smooth lump reads as clay: no gaps, no ragged edge, the same soft
 * outline against the sky from a metre or a kilometre. What a real crown has
 * is thousands of leaves in sprays, with sky showing between them at the rim.
 * So each crown keeps its lumps as a dark inner volume and gets a shell of
 * leaf cards over it — quads carrying a spray of leaves cut out by alpha —
 * the way every game tree since the nineties has done it.
 *
 * Nothing is loaded from disk: the sprays and the bark are drawn into a canvas
 * here, then copied out so the colour can be bled into the transparent pixels
 * (a canvas stores those as black, and mipmapping would pull a dark fringe
 * round every leaf at range).
 */

const ATLAS = 1024
/** Sprays per side of the atlas — four variants, each a 512 cell. */
const CELLS = 2

/** Deterministic 0–1, so the island paints the same leaves every load. */
function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Fill every transparent pixel with the colour of the nearest opaque one, a
 * few passes out. Alpha stays as drawn; only the hidden colour changes.
 */
function bleed(data: Uint8ClampedArray, size: number, passes: number) {
  const known = new Uint8Array(size * size)
  for (let i = 0; i < size * size; i++) known[i] = data[i * 4 + 3] > 8 ? 1 : 0
  let sumR = 0
  let sumG = 0
  let sumB = 0
  let n = 0
  for (let i = 0; i < size * size; i++) {
    if (!known[i]) continue
    sumR += data[i * 4]
    sumG += data[i * 4 + 1]
    sumB += data[i * 4 + 2]
    n++
  }
  for (let pass = 0; pass < passes; pass++) {
    const next = known.slice()
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x
        if (known[i]) continue
        let r = 0
        let g = 0
        let b = 0
        let c = 0
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
          const j = ny * size + nx
          if (!known[j]) continue
          r += data[j * 4]
          g += data[j * 4 + 1]
          b += data[j * 4 + 2]
          c++
        }
        if (c === 0) continue
        data[i * 4] = r / c
        data[i * 4 + 1] = g / c
        data[i * 4 + 2] = b / c
        next[i] = 1
      }
    }
    known.set(next)
  }
  // Whatever the passes didn't reach takes the average leaf
  for (let i = 0; i < size * size; i++) {
    if (known[i]) continue
    data[i * 4] = sumR / Math.max(n, 1)
    data[i * 4 + 1] = sumG / Math.max(n, 1)
    data[i * 4 + 2] = sumB / Math.max(n, 1)
  }
}

function toTexture(data: Uint8ClampedArray, w: number, h: number, repeat: boolean) {
  const tex = new THREE.DataTexture(new Uint8Array(data.buffer.slice(0)), w, h, THREE.RGBAFormat)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.needsUpdate = true
  return tex
}

/**
 * One spray: a twig rising from the bottom centre of the cell, leaves
 * alternating up it and fanning out, the youngest small at the tip. Colours
 * sit near neutral — the material colour and each plant's baked tint do the
 * greening, the texture only carries leaf-to-leaf value and the midribs.
 */
function drawSpray(ctx: CanvasRenderingContext2D, ox: number, oy: number, cell: number, seed: number) {
  const r = rng(seed)
  const baseX = ox + cell / 2
  const baseY = oy + cell - 6
  type Leaf = { x: number; y: number; angle: number; len: number; wid: number; tone: number; droop: number }
  const back: Leaf[] = []
  const front: Leaf[] = []
  // Keep every leaf inside its own cell, or a neighbour's tips show on a card
  ctx.save()
  ctx.beginPath()
  ctx.rect(ox + 3, oy + 3, cell - 6, cell - 6)
  ctx.clip()

  // The back of the spray: leaves deeper in, in its own shade. They fill the
  // gaps between twigs, so a card reads as a mass with sky only at its edge
  for (let i = 0; i < 34; i++) {
    const a = r() * Math.PI * 2
    const d = Math.sqrt(r()) * cell * 0.27
    const len = cell * (0.17 + r() * 0.07)
    back.push({
      x: ox + cell * 0.5 + Math.cos(a) * d,
      y: oy + cell * 0.47 + Math.sin(a) * d * 0.95,
      angle: a + (r() - 0.5) * 1.2,
      len,
      wid: len * (0.4 + r() * 0.12),
      tone: 0.34 + r() * 0.2,
      droop: (r() - 0.5) * 0.5,
    })
  }

  // The front: a fan of twigs from the base, leaves paired up each one,
  // the youngest smaller toward the tips
  const twigs = 5 + Math.floor(r() * 3)
  ctx.strokeStyle = 'rgb(96,88,70)'
  ctx.lineWidth = 3
  for (let t = 0; t < twigs; t++) {
    const spreadA = (t / (twigs - 1) - 0.5) * 1.9 + (r() - 0.5) * 0.25
    const twigLen = cell * (0.46 + r() * 0.16) * (1 - Math.abs(spreadA) * 0.15)
    const steps = 6 + Math.floor(r() * 3)
    ctx.beginPath()
    ctx.moveTo(baseX, baseY)
    let x = baseX
    let y = baseY
    let a = -Math.PI / 2 + spreadA * 0.55
    for (let s = 0; s < steps; s++) {
      const seg = twigLen / steps
      a += (r() - 0.5) * 0.16 + spreadA * 0.05
      x += Math.cos(a) * seg
      y += Math.sin(a) * seg
      ctx.lineTo(x, y)
      const along = (s + 1) / steps
      if (along < 0.25) continue
      for (const side of r() < 0.6 ? [1, -1] : [s % 2 === 0 ? 1 : -1]) {
        const len = cell * (0.19 + r() * 0.07) * (1.08 - along * 0.4)
        front.push({
          x,
          y,
          angle: a + side * (0.5 + r() * 0.55),
          len,
          wid: len * (0.4 + r() * 0.12),
          tone: 0.6 + r() * 0.36,
          droop: (r() - 0.25) * 0.55 * side,
        })
      }
    }
    ctx.stroke()
    front.push({ x, y, angle: a, len: cell * 0.14, wid: cell * 0.058, tone: 0.92, droop: 0 })
  }

  for (const leaf of [...back, ...front]) {
    ctx.save()
    ctx.translate(leaf.x, leaf.y)
    ctx.rotate(leaf.angle)
    const L = leaf.len
    const W = leaf.wid
    // Pointed oval, widest a third of the way out, tip bent by droop
    const path = new Path2D()
    path.moveTo(0, 0)
    path.bezierCurveTo(L * 0.22, -W * 0.8, L * 0.72, -W * 0.6 + leaf.droop * W, L, leaf.droop * W)
    path.bezierCurveTo(L * 0.72, W * 0.6 + leaf.droop * W, L * 0.22, W * 0.8, 0, 0)
    // Darker at the stalk, where it sits in the spray's own shade
    const v = leaf.tone
    const grad = ctx.createLinearGradient(0, 0, L, 0)
    grad.addColorStop(0, `rgb(${Math.round(140 * v)},${Math.round(156 * v)},${Math.round(120 * v)})`)
    grad.addColorStop(0.5, `rgb(${Math.round(228 * v)},${Math.round(242 * v)},${Math.round(196 * v)})`)
    grad.addColorStop(1, `rgb(${Math.round(236 * v)},${Math.round(246 * v)},${Math.round(200 * v)})`)
    ctx.fillStyle = grad
    ctx.fill(path)
    // One half of the blade lighter, as if folded on its rib
    ctx.save()
    ctx.clip(path)
    ctx.fillStyle = 'rgba(255,255,235,0.12)'
    ctx.fillRect(0, -W, L, W)
    // and a thin dark rim, so overlapping leaves separate
    ctx.strokeStyle = `rgba(40,50,30,0.35)`
    ctx.lineWidth = 2
    ctx.stroke(path)
    ctx.restore()
    ctx.strokeStyle = `rgba(245,255,215,${0.4 * v})`
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(L * 0.04, 0)
    ctx.quadraticCurveTo(L * 0.5, leaf.droop * W * 0.4, L * 0.95, leaf.droop * W)
    ctx.stroke()
    ctx.restore()
  }
  ctx.restore()
}

let atlasCache: THREE.DataTexture | null = null

/** Four leaf sprays in a 2×2 atlas, alpha-cut. Built once and shared. */
export function leafAtlas() {
  if (atlasCache) return atlasCache
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = ATLAS
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas unavailable')
  const cell = ATLAS / CELLS
  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) drawSpray(ctx, cx * cell, cy * cell, cell, 11 + cx + cy * CELLS)
  }
  const img = ctx.getImageData(0, 0, ATLAS, ATLAS)
  bleed(img.data, ATLAS, 6)
  atlasCache = toTexture(img.data, ATLAS, ATLAS, false)
  return atlasCache
}

let barkCache: THREE.DataTexture | null = null

/**
 * Pale rainforest bark: long vertical fissures between flat plates, lichen
 * blotches, darker toward the ground. Neutral grey — the layer colour browns
 * it. Wraps both ways; trunks scale their own v by height so it doesn't
 * stretch up a tall bole.
 */
export function barkTexture() {
  if (barkCache) return barkCache
  const W = 256
  const H = 512
  const data = new Uint8ClampedArray(W * H * 4)
  const r = rng(77)
  // Value noise on a wrapped lattice, so the texture tiles
  const lattice = (gw: number, gh: number) => {
    const g = new Float32Array(gw * gh)
    for (let i = 0; i < g.length; i++) g[i] = r()
    return (u: number, v: number) => {
      const x = u * gw
      const y = v * gh
      const x0 = Math.floor(x)
      const y0 = Math.floor(y)
      const fx = x - x0
      const fy = y - y0
      const sx = fx * fx * (3 - 2 * fx)
      const sy = fy * fy * (3 - 2 * fy)
      const at = (i: number, j: number) => g[(((j % gh) + gh) % gh) * gw + (((i % gw) + gw) % gw)]
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx
      return a + (b - a) * sy
    }
  }
  // Fissures: stretched tall, so they run up the trunk
  const fissure = lattice(20, 2)
  const fissureFine = lattice(36, 5)
  const plate = lattice(8, 4)
  const lichen = lattice(12, 18)
  const grain = lattice(96, 14)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W
      const v = y / H
      // Furrows: a dozen vertical grooves per repeat, wandering a little
      // sideways, broken into lengths where the finer noise lifts them out.
      // (Contours of the noise itself drew wood grain, not bark.)
      const wander = fissure(u, v) * 0.9
      const ridge = Math.abs(Math.sin((u * 12 + wander) * Math.PI))
      const groove = 1 - Math.min(ridge / 0.28, 1)
      const crack = groove * groove * Math.min(Math.max((fissureFine(u, v) - 0.3) * 3, 0), 1)
      let tone = 0.62 + plate(u, v) * 0.22 + grain(u, v) * 0.12
      tone *= 1 - crack * 0.6
      // Lichen: pale, slightly green-grey blotches on the plates
      const l = Math.max(0, lichen(u, v) - 0.6) * 2.4 * (1 - crack)
      const i = (y * W + x) * 4
      data[i] = Math.min(255, (tone + l * 0.3) * 238)
      data[i + 1] = Math.min(255, (tone + l * 0.34) * 232)
      data[i + 2] = Math.min(255, (tone + l * 0.24) * 220)
      data[i + 3] = 255
    }
  }
  barkCache = toTexture(data, W, H, true)
  return barkCache
}

/**
 * Give a cylinder's uv metres instead of 0–1, so one repeat of bark covers
 * about the same patch of trunk however tall the tree is. `around` is how
 * many repeats go round the circumference.
 */
export function barkUv(geo: THREE.BufferGeometry, height: number, around = 1) {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!uv) return geo
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * around, uv.getY(i) * height * 0.32)
  return geo
}

/**
 * Pull a crown's lumps in toward `centre` once its sprays have been scattered
 * over the full-size surface: the sprays become the outside of the crown and
 * the lumps the shaded mass inside it, seen only through the gaps.
 */
export function shrinkCore(geo: THREE.BufferGeometry, k: number, centre = new THREE.Vector3()) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      centre.x + (pos.getX(i) - centre.x) * k,
      centre.y + (pos.getY(i) - centre.y) * k,
      centre.z + (pos.getZ(i) - centre.z) * k,
    )
  }
  pos.needsUpdate = true
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

export type LeafCardOptions = {
  /** How many sprays to scatter over the surface. */
  count: number
  /** Spray length, in the units of `core`. */
  length: number
  seed: number
  /** Fold each card along its rib (4 triangles) instead of flat (2). */
  fold?: boolean
  /** How far a spray leans out of the surface, 0 = flat on it, 1 = straight out. */
  lean?: number
  /** Share of the normal to keep from the surface vs a random tilt. */
  normalJitter?: number
  /**
   * Root sprays up to this far under the surface, so they fill the crown in
   * layers rather than all sitting on one skin.
   */
  depth?: number
}

/**
 * Sprays scattered over a crown's surface. Points are picked by area, so big
 * lumps get more; each card is rooted just under the skin and leans outward,
 * so the outer half of every spray stands proud of the lump and the outline
 * goes ragged. Normals are the core's own (already bent toward the crown's
 * centre in leafMass), so the cards light as one soft volume with it.
 */
export function leafCards(core: THREE.BufferGeometry, opts: LeafCardOptions) {
  const r = rng(opts.seed * 7 + 3)
  const fold = opts.fold ?? true
  const lean = opts.lean ?? 0.55
  const jitter = opts.normalJitter ?? 0.28
  const depth = opts.depth ?? 0
  const geo = core.index ? core.toNonIndexed() : core
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute
  const tris = pos.count / 3
  const cum = new Float32Array(tris)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  let total = 0
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(pos, t * 3)
    b.fromBufferAttribute(pos, t * 3 + 1)
    c.fromBufferAttribute(pos, t * 3 + 2)
    total += b.sub(a).cross(c.sub(a)).length() * 0.5
    cum[t] = total
  }

  const per = fold ? 12 : 6
  const P = new Float32Array(opts.count * per * 3)
  const N = new Float32Array(opts.count * per * 3)
  const U = new Float32Array(opts.count * per * 2)
  const p = new THREE.Vector3()
  const n = new THREE.Vector3()
  const t = new THREE.Vector3()
  const w = new THREE.Vector3()
  const d = new THREE.Vector3()
  const lift = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const tmp = new THREE.Vector3()
  const cell = 1 / CELLS
  let o = 0
  let ou = 0

  for (let k = 0; k < opts.count; k++) {
    // Area-weighted triangle, uniform point in it
    const pick = r() * total
    let lo = 0
    let hi = tris - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid] < pick) lo = mid + 1
      else hi = mid
    }
    let s1 = r()
    let s2 = r()
    if (s1 + s2 > 1) {
      s1 = 1 - s1
      s2 = 1 - s2
    }
    const s0 = 1 - s1 - s2
    p.set(0, 0, 0)
      .addScaledVector(a.fromBufferAttribute(pos, lo * 3), s0)
      .addScaledVector(b.fromBufferAttribute(pos, lo * 3 + 1), s1)
      .addScaledVector(c.fromBufferAttribute(pos, lo * 3 + 2), s2)
    n.set(0, 0, 0)
      .addScaledVector(a.fromBufferAttribute(nrm, lo * 3), s0)
      .addScaledVector(b.fromBufferAttribute(nrm, lo * 3 + 1), s1)
      .addScaledVector(c.fromBufferAttribute(nrm, lo * 3 + 2), s2)
      .normalize()

    // A tangent: mostly "up the crown", turned at random about the normal
    t.copy(up).addScaledVector(n, -up.dot(n))
    if (t.lengthSq() < 1e-4) t.set(1, 0, 0).addScaledVector(n, -n.x)
    t.normalize().applyAxisAngle(n, (r() - 0.5) * Math.PI * 1.6)
    const out = lean * (0.6 + r() * 0.8)
    d.copy(t).multiplyScalar(1 - out).addScaledVector(n, out).normalize()
    w.crossVectors(d, n)
    if (w.lengthSq() < 1e-4) w.crossVectors(d, tmp.set(0.3, 1, 0.2).normalize())
    w.normalize().applyAxisAngle(d, (r() - 0.5) * 0.9)
    lift.crossVectors(w, d).normalize()

    const L = opts.length * (0.75 + r() * 0.5)
    const H = L * 0.5
    // Rooted a little under the skin, so no card hangs off it by its stalk
    const root = tmp.copy(p).addScaledVector(n, -r() * depth).addScaledVector(d, -L * 0.18)
    const bow = H * 0.22

    // Card normal: the surface's, nudged per card so neighbours catch the sun
    // differently — the glint and shade that reads as many leaves
    const cn = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(jitter * 2).add(n).normalize()

    const cx = Math.floor(r() * CELLS) * cell
    const cy = Math.floor(r() * CELLS) * cell
    // Atlas rows run top-down from the canvas: the twig root is at the
    // bottom of a cell on screen, which is the high-v edge here
    const uvAt = (across: number, along: number) => [cx + across * cell, cy + (1 - along) * cell]

    const corner = (across: number, along: number) => {
      const v = new THREE.Vector3()
        .copy(root)
        .addScaledVector(d, along * L)
        .addScaledVector(w, (across - 0.5) * H)
      if (fold && across === 0.5) v.addScaledVector(lift, bow)
      return v
    }
    const quads: [number, number][][] = fold
      ? [
          [[0, 0], [0.5, 0], [0.5, 1], [0, 1]],
          [[0.5, 0], [1, 0], [1, 1], [0.5, 1]],
        ]
      : [[[0, 0], [1, 0], [1, 1], [0, 1]]]
    for (const q of quads) {
      for (const idx of [0, 1, 2, 0, 2, 3]) {
        const [ac, al] = q[idx]
        const v = corner(ac, al)
        P[o] = v.x
        P[o + 1] = v.y
        P[o + 2] = v.z
        N[o] = cn.x
        N[o + 1] = cn.y
        N[o + 2] = cn.z
        o += 3
        const [uu, vv] = uvAt(ac, al)
        U[ou] = uu
        U[ou + 1] = vv
        ou += 2
      }
    }
  }

  const cards = new THREE.BufferGeometry()
  cards.setAttribute('position', new THREE.BufferAttribute(P, 3))
  cards.setAttribute('normal', new THREE.BufferAttribute(N, 3))
  cards.setAttribute('uv', new THREE.BufferAttribute(U, 2))
  return cards
}
