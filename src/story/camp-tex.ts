import * as THREE from 'three'
import { rng } from '../leaftex'

/**
 * Everything in the camp that is made of leaf and fibre, painted once at load
 * into one sheet: thatch, plaited pandanus matting, a fishing net and a piece
 * of bark cloth. No image files; one texture, so every roof, mat, basket and
 * net in the camp is one draw call.
 *
 * The sheet is four bands, each tiling left to right:
 *
 *   THATCH  a course of dry leaf as it hangs on a roof: tied and shaded at the
 *           top where the course above covers it, ragged ends cut out by alpha
 *           at the bottom
 *   WEAVE   plaited matting, two strands over and under, a dyed strand every
 *           so often
 *   NET     knotted mesh, cut out by alpha
 *   TAPA    beaten bark cloth with its border of stamped triangles
 *
 * A band is addressed by `band(i)`: the v at its head and at its foot, already
 * pulled in from the neighbours so mipmapping does not bleed one into the next.
 */

export const THATCH = 0
export const WEAVE = 1
export const NET = 2
export const TAPA = 3
const BANDS = 4

/**
 * v at the head and the foot of a band as it was painted (for thatch: the tied
 * head of the course, then its ragged ends), inset from its neighbours.
 */
export function band(i: number): [number, number] {
  const h = 1 / BANDS
  return [i * h + 0.012, (i + 1) * h - 0.012]
}

let cache: THREE.DataTexture | null = null

export function campAtlas(lowPower: boolean) {
  if (cache) return cache
  const S = lowPower ? 512 : 1024
  const B = S / BANDS
  const k = S / 512
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = S
  const g = canvas.getContext('2d', { willReadFrequently: true })
  if (!g) throw new Error('2D canvas unavailable')
  const r = rng(4127)

  /** Draw something that crosses the left or right edge three times, so the band tiles. */
  const wrapped = (x: number, w: number, draw: (x: number) => void) => {
    draw(x)
    if (x < w) draw(x + S)
    if (x > S - w) draw(x - S)
  }

  // —— THATCH ——
  {
    const y0 = 0
    g.save()
    g.beginPath()
    g.rect(0, y0, S, B)
    g.clip()
    // The body of the course: solid down to where the ends begin to fray
    g.fillStyle = '#7d6a45'
    g.fillRect(0, y0, S, B * 0.5)
    // Leaf after leaf, long and narrow, each its own dry colour, the later ones lying over the earlier
    const leaves = 310
    for (let i = 0; i < leaves; i++) {
      const x = r() * S
      const w = (3 + r() * 5) * k
      const top = y0 - 4 * k
      // Most reach nearly to the bottom; some are short, some broken off
      const reach = r() < 0.16 ? 0.45 + r() * 0.17 : 0.62 + r() * 0.37
      const bottom = y0 + B * reach
      const lean = (r() - 0.5) * 10 * k
      const tone = r()
      // Straw and tan, a few silvered by weather, a few still olive
      const pick = r()
      let cr: number
      let cg: number
      let cb: number
      if (pick < 0.12) {
        cr = 168 + tone * 30
        cg = 162 + tone * 28
        cb = 140 + tone * 26
      } else if (pick < 0.2) {
        cr = 118 + tone * 30
        cg = 118 + tone * 30
        cb = 62 + tone * 20
      } else {
        cr = 150 + tone * 72
        cg = 122 + tone * 58
        cb = 66 + tone * 40
      }
      const dark = 0.62 + r() * 0.38
      wrapped(x, 40 * k, (px) => {
        const grad = g.createLinearGradient(0, top, 0, bottom)
        grad.addColorStop(0, `rgb(${cr * dark * 0.72},${cg * dark * 0.72},${cb * dark * 0.72})`)
        grad.addColorStop(0.5, `rgb(${cr * dark},${cg * dark},${cb * dark})`)
        grad.addColorStop(1, `rgb(${cr * dark * 1.08},${cg * dark * 1.06},${cb * dark})`)
        g.fillStyle = grad
        g.beginPath()
        g.moveTo(px - w / 2, top)
        g.lineTo(px + w / 2, top)
        g.lineTo(px + lean + w * 0.4, bottom - w)
        // A torn tip
        g.lineTo(px + lean, bottom)
        g.lineTo(px + lean - w * 0.45, bottom - w * 1.4)
        g.closePath()
        g.fill()
        // The shaded edge where it lies under its neighbour
        g.strokeStyle = 'rgba(40,30,16,0.55)'
        g.lineWidth = Math.max(1, k)
        g.beginPath()
        g.moveTo(px + w / 2, top)
        g.lineTo(px + lean + w * 0.4, bottom - w)
        g.stroke()
        // A pale midrib on the wider ones
        if (w > 5.5 * k) {
          g.strokeStyle = 'rgba(244,226,170,0.32)'
          g.beginPath()
          g.moveTo(px, top)
          g.lineTo(px + lean * 0.9, bottom - w * 1.5)
          g.stroke()
        }
      })
    }
    // The course above lies over the top of this one: its shadow, deepest just under its edge
    const shade = g.createLinearGradient(0, y0, 0, y0 + B * 0.5)
    shade.addColorStop(0, 'rgba(22,16,8,0.82)')
    shade.addColorStop(0.45, 'rgba(22,16,8,0.5)')
    shade.addColorStop(1, 'rgba(22,16,8,0)')
    g.globalCompositeOperation = 'source-atop'
    g.fillStyle = shade
    g.fillRect(0, y0, S, B * 0.5)
    // Sun-bleached ends
    const tips = g.createLinearGradient(0, y0 + B * 0.7, 0, y0 + B)
    tips.addColorStop(0, 'rgba(255,238,190,0)')
    tips.addColorStop(1, 'rgba(255,238,190,0.2)')
    g.fillStyle = tips
    g.fillRect(0, y0 + B * 0.7, S, B * 0.3)
    g.globalCompositeOperation = 'source-over'
    g.restore()
  }

  // —— WEAVE ——
  {
    const y0 = B
    g.save()
    g.beginPath()
    g.rect(0, y0, S, B)
    g.clip()
    const cell = 16 * k
    const cols = Math.round(S / cell)
    const rows = Math.ceil(B / cell)
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const over = (i + j) % 2 === 0
        // A dyed weft every sixth strand, and a dyed warp every eighth: a plaid of dark lines
        const dyed = over ? j % 6 === 2 : i % 8 === 3
        const t = r()
        let cr = 196 + t * 30
        let cg = 170 + t * 26
        let cb = 112 + t * 24
        if (dyed) {
          cr = 96 + t * 18
          cg = 60 + t * 12
          cb = 36 + t * 10
        }
        const x = i * cell
        const y = y0 + j * cell
        g.fillStyle = `rgb(${cr},${cg},${cb})`
        g.fillRect(x, y, cell, cell)
        // The strand dips under its neighbours at both ends
        const grad = over ? g.createLinearGradient(x, 0, x + cell, 0) : g.createLinearGradient(0, y, 0, y + cell)
        grad.addColorStop(0, 'rgba(30,20,8,0.5)')
        grad.addColorStop(0.22, 'rgba(30,20,8,0)')
        grad.addColorStop(0.78, 'rgba(30,20,8,0)')
        grad.addColorStop(1, 'rgba(30,20,8,0.5)')
        g.fillStyle = grad
        g.fillRect(x, y, cell, cell)
        // and its fibres run its own way
        g.strokeStyle = 'rgba(255,240,200,0.16)'
        g.lineWidth = Math.max(1, k)
        g.beginPath()
        if (over) {
          g.moveTo(x, y + cell * 0.35)
          g.lineTo(x + cell, y + cell * 0.35)
          g.moveTo(x, y + cell * 0.7)
          g.lineTo(x + cell, y + cell * 0.7)
        } else {
          g.moveTo(x + cell * 0.35, y)
          g.lineTo(x + cell * 0.35, y + cell)
          g.moveTo(x + cell * 0.7, y)
          g.lineTo(x + cell * 0.7, y + cell)
        }
        g.stroke()
      }
    }
    g.restore()
  }

  // —— NET ——
  {
    const y0 = B * 2
    g.save()
    g.beginPath()
    g.rect(0, y0, S, B)
    g.clip()
    const mesh = 32 * k
    g.lineCap = 'round'
    for (const [colour, width] of [
      ['#5a4a30', 7.5 * k],
      ['#b59c68', 4.5 * k],
    ] as const) {
      g.strokeStyle = colour
      g.lineWidth = width
      g.beginPath()
      for (let x = -B; x < S + B; x += mesh) {
        g.moveTo(x, y0 - 2)
        g.lineTo(x + B + 4, y0 + B + 2)
        g.moveTo(x + B + 4, y0 - 2)
        g.lineTo(x, y0 + B + 2)
      }
      g.stroke()
    }
    // Knots where the cords cross
    g.fillStyle = '#c9b27c'
    for (let x = 0; x <= S; x += mesh / 2) {
      for (let y = 0; y <= B; y += mesh / 2) {
        if ((Math.round(x / (mesh / 2)) + Math.round(y / (mesh / 2))) % 2 !== 0) continue
        g.beginPath()
        g.arc(x, y0 + y, 4.2 * k, 0, Math.PI * 2)
        g.fill()
      }
    }
    g.restore()
  }

  // —— TAPA ——
  {
    const y0 = B * 3
    g.save()
    g.beginPath()
    g.rect(0, y0, S, B)
    g.clip()
    g.fillStyle = '#d2bf97'
    g.fillRect(0, y0, S, B)
    // The beaten grain of the bark
    for (let i = 0; i < 260; i++) {
      const x = r() * S
      const y = y0 + r() * B
      g.strokeStyle = r() < 0.5 ? 'rgba(120,96,60,0.16)' : 'rgba(250,240,214,0.2)'
      g.lineWidth = Math.max(1, k)
      g.beginPath()
      g.moveTo(x, y)
      g.lineTo(x + (10 + r() * 30) * k, y + (r() - 0.5) * 3 * k)
      g.stroke()
    }
    const brown = '#5b3620'
    const black = '#2a1c14'
    // Borders: a rule and a row of triangles, top and bottom
    const tri = 16 * k
    for (const [edge, dir] of [
      [y0 + 9 * k, 1],
      [y0 + B - 9 * k, -1],
    ] as const) {
      g.fillStyle = black
      g.fillRect(0, edge - 2 * k, S, 4 * k)
      g.fillStyle = brown
      for (let x = 0; x < S; x += tri) {
        g.beginPath()
        g.moveTo(x, edge + dir * 4 * k)
        g.lineTo(x + tri, edge + dir * 4 * k)
        g.lineTo(x + tri / 2, edge + dir * (4 * k + tri * 0.8))
        g.closePath()
        g.fill()
      }
    }
    // The field: lozenges with a dark heart, a cross between each pair
    const step = S / 8
    const mid = y0 + B / 2
    for (let i = 0; i < 8; i++) {
      const cx = step * (i + 0.5)
      const d = 20 * k
      g.fillStyle = brown
      g.beginPath()
      g.moveTo(cx, mid - d)
      g.lineTo(cx + d * 0.8, mid)
      g.lineTo(cx, mid + d)
      g.lineTo(cx - d * 0.8, mid)
      g.closePath()
      g.fill()
      g.fillStyle = '#d2bf97'
      g.beginPath()
      g.moveTo(cx, mid - d * 0.5)
      g.lineTo(cx + d * 0.4, mid)
      g.lineTo(cx, mid + d * 0.5)
      g.lineTo(cx - d * 0.4, mid)
      g.closePath()
      g.fill()
      g.fillStyle = black
      g.fillRect(cx - 2 * k, mid - 2 * k, 4 * k, 4 * k)
      g.fillRect(i * step - 1.5 * k, mid - 12 * k, 3 * k, 24 * k)
      g.fillRect(i * step - 8 * k, mid - 1.5 * k, 16 * k, 3 * k)
    }
    g.restore()
  }

  // A canvas keeps black under every clear pixel, and mipmapping would pull
  // that into a dark fringe round each leaf tip and cord: give the clear
  // pixels the colour of what they sit beside
  const img = g.getImageData(0, 0, S, S)
  const d = img.data
  const under = [
    [150, 124, 78],
    [196, 170, 112],
    [170, 148, 100],
    [210, 191, 151],
  ]
  for (let y = 0; y < S; y++) {
    const u = under[Math.min(BANDS - 1, Math.floor(y / B))]
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4
      if (d[i + 3] < 250) {
        const a = d[i + 3] / 255
        d[i] = d[i] * a + u[0] * (1 - a)
        d[i + 1] = d[i + 1] * a + u[1] * (1 - a)
        d[i + 2] = d[i + 2] * a + u[2] * (1 - a)
      }
    }
  }
  // Copied out of the canvas rather than uploaded from it: a canvas stores its
  // clear pixels as black whatever is written to them (see leaftex.ts)
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer.slice(0)), S, S, THREE.RGBAFormat)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.needsUpdate = true
  cache = tex
  return tex
}
