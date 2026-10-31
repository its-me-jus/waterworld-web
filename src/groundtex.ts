import * as THREE from 'three'
import { rng, toTexture } from './leaftex'

/**
 * The ground's close-up detail, painted once at load into one tiling texture.
 *
 * The terrain shader carries the island down to about a metre with noise, and
 * below that it was smooth: sand like icing, a forest floor like felt, rock
 * like putty. What the eye reads as "real" at walking distance is all smaller
 * than that — grains, a scatter of dead leaves, the pits and cracks in stone.
 * One RGBA texture holds four data channels for it, sampled in world space
 * (no uv needed on the terrain or the stones):
 *
 *   r  sand: grain, with dark mineral and pale shell specks
 *   g  leaf litter: the value of each fallen leaf, 0 where there is soil
 *   b  rock: grain, pits and hairline cracks
 *   a  leaf litter: a per-leaf 0–1 the shader turns into a hue
 *
 * One tile is DETAIL_TILE metres across. Everything wraps.
 */

export const DETAIL_SIZE = 512
/** Metres of ground one repeat of the texture covers. */
export const DETAIL_TILE = 1.6

/** Value noise on a wrapped lattice of `cells` per side, so it tiles. */
function lattice(r: () => number, cells: number) {
  const g = new Float32Array(cells * cells)
  for (let i = 0; i < g.length; i++) g[i] = r()
  return (u: number, v: number) => {
    const x = u * cells
    const y = v * cells
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const at = (i: number, j: number) => g[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)]
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx
    return a + (b - a) * sy
  }
}

/** Sand: per-pixel grain softened by one wrapped blur, plus specks. */
function paintSand(out: Float32Array) {
  const S = DETAIL_SIZE
  const r = rng(301)
  const raw = new Float32Array(S * S)
  for (let i = 0; i < raw.length; i++) raw[i] = r()
  const drift = lattice(r, 8)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let sum = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) sum += raw[((y + dy + S) % S) * S + ((x + dx + S) % S)]
      }
      const grain = sum / 9
      out[y * S + x] = 0.5 + (grain - 0.5) * 1.6 + (raw[y * S + x] - 0.5) * 0.25 + (drift(x / S, y / S) - 0.5) * 0.2
    }
  }
  // Specks two or three pixels across: dark grains of basalt, pale shell
  for (let k = 0; k < 2600; k++) {
    const cx = Math.floor(r() * S)
    const cy = Math.floor(r() * S)
    const v = r() < 0.65 ? 0.08 + r() * 0.15 : 0.92 + r() * 0.08
    const rad = r() < 0.7 ? 1 : 2
    for (let dy = -rad; dy < rad; dy++) {
      for (let dx = -rad; dx < rad; dx++) out[((cy + dy + S) % S) * S + ((cx + dx + S) % S)] = v
    }
  }
}

/** Rock: three octaves of grain, pitting, and a few hairline cracks. */
function paintRock(out: Float32Array) {
  const S = DETAIL_SIZE
  const r = rng(517)
  const o1 = lattice(r, 6)
  const o2 = lattice(r, 18)
  const o3 = lattice(r, 64)
  const o4 = lattice(r, 160)
  const crackA = lattice(r, 5)
  const crackB = lattice(r, 9)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S
      const v = y / S
      let t = 0.5 + (o1(u, v) - 0.5) * 0.35 + (o2(u, v) - 0.5) * 0.45 + (o3(u, v) - 0.5) * 0.35 + (o4(u, v) - 0.5) * 0.3
      // A crack is the narrow band where a noise crosses its middle
      const c1 = 1 - Math.min(Math.abs(crackA(u, v) - 0.5) * 70, 1)
      const c2 = 1 - Math.min(Math.abs(crackB(u, v) - 0.5) * 90, 1)
      t -= Math.max(c1, c2 * 0.7) * 0.4
      out[y * S + x] = t
    }
  }
  // Vesicles: basalt is full of small gas pits
  for (let k = 0; k < 900; k++) {
    const cx = Math.floor(r() * S)
    const cy = Math.floor(r() * S)
    const rad = 1 + r() * 2.5
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const d = Math.hypot(dx, dy)
        if (d > rad) continue
        const i = ((cy + dy + S) % S) * S + ((cx + dx + S) % S)
        out[i] = Math.min(out[i], 0.12 + (d / rad) * 0.3)
      }
    }
  }
}

/**
 * Leaf litter, drawn twice with identical shapes: once in grey by each leaf's
 * value, once in grey by its hue key. Every leaf is drawn at its eight wrapped
 * neighbours too, so the tile has no seam.
 */
function paintLitter(valueOut: Uint8ClampedArray, hueOut: Uint8ClampedArray) {
  const S = DETAIL_SIZE
  const make = () => {
    const c = document.createElement('canvas')
    c.width = c.height = S
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('2D canvas unavailable')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, S, S)
    return ctx
  }
  const val = make()
  const hue = make()
  const r = rng(733)
  // Bunched, not even: litter gathers in drifts with bare soil between
  const drift = lattice(r, 4)
  type Leaf = { x: number; y: number; a: number; len: number; wid: number; v: number; h: number; curl: number; twig: boolean }
  const leaves: Leaf[] = []
  for (let k = 0; k < 1400 && leaves.length < 620; k++) {
    const x = r() * S
    const y = r() * S
    if (r() > drift(x / S, y / S) * 1.5) continue
    const twig = r() < 0.06
    const len = twig ? S * (0.08 + r() * 0.1) : S * (0.035 + r() * 0.045)
    leaves.push({
      x,
      y,
      a: r() * Math.PI * 2,
      len,
      wid: twig ? 2 : len * (0.38 + r() * 0.2),
      // Older leaves, lower in the drift, are darker
      v: 0.3 + (leaves.length / 620) * 0.45 + r() * 0.25,
      h: r(),
      curl: (r() - 0.5) * 0.5,
      twig,
    })
  }
  for (const leaf of leaves) {
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        const px = leaf.x + ox
        const py = leaf.y + oy
        if (px < -leaf.len || px > S + leaf.len || py < -leaf.len || py > S + leaf.len) continue
        for (const [ctx, g] of [
          [val, leaf.v],
          [hue, leaf.twig ? 0.02 : 0.08 + leaf.h * 0.92],
        ] as const) {
          const grey = Math.round(Math.min(Math.max(g, 0.01), 1) * 255)
          ctx.save()
          ctx.translate(px, py)
          ctx.rotate(leaf.a)
          if (leaf.twig) {
            ctx.strokeStyle = `rgb(${grey},${grey},${grey})`
            ctx.lineWidth = leaf.wid
            ctx.beginPath()
            ctx.moveTo(-leaf.len / 2, 0)
            ctx.quadraticCurveTo(0, leaf.len * leaf.curl * 0.3, leaf.len / 2, 0)
            ctx.stroke()
          } else {
            const L = leaf.len
            const W = leaf.wid
            const c = leaf.curl * W
            ctx.fillStyle = `rgb(${grey},${grey},${grey})`
            ctx.beginPath()
            ctx.moveTo(-L / 2, 0)
            ctx.bezierCurveTo(-L * 0.2, -W * 0.8 + c, L * 0.25, -W * 0.6 + c, L / 2, c)
            ctx.bezierCurveTo(L * 0.25, W * 0.6 + c, -L * 0.2, W * 0.8 + c, -L / 2, 0)
            ctx.fill()
          }
          ctx.restore()
        }
      }
    }
  }
  valueOut.set(val.getImageData(0, 0, S, S).data)
  hueOut.set(hue.getImageData(0, 0, S, S).data)
}

let cache: THREE.DataTexture | null = null

export function groundDetail() {
  if (cache) return cache
  const S = DETAIL_SIZE
  const sand = new Float32Array(S * S)
  const rock = new Float32Array(S * S)
  const litterV = new Uint8ClampedArray(S * S * 4)
  const litterH = new Uint8ClampedArray(S * S * 4)
  paintSand(sand)
  paintRock(rock)
  paintLitter(litterV, litterH)
  const data = new Uint8ClampedArray(S * S * 4)
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = sand[i] * 255
    data[i * 4 + 1] = litterV[i * 4]
    data[i * 4 + 2] = rock[i] * 255
    data[i * 4 + 3] = litterH[i * 4]
  }
  cache = toTexture(data, S, S, true, false)
  return cache
}
