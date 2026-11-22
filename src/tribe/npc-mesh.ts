import * as THREE from 'three'
import { DETAIL_LAYER } from '../quality'
import { skyFill } from '../skyfill'
import type { NpcId, NpcPose } from './types'

/**
 * The three islanders as bodies: Kael, Tala and Oru.
 *
 * Each one is a single skinned mesh on a skeleton of 25 bones: hips, spine,
 * chest, neck, head; shoulder, elbow, wrist and the fingers for each arm;
 * hip, knee and ankle for each leg; and six small ones in the face (an eye
 * each, the upper lids, the jaw, a brow each). The surface runs unbroken
 * through the elbows, wrists, knees, ankles, waist and neck, so a bent arm is
 * a bent arm and not two tubes meeting. Shoulders and hips are a rounded cap
 * turning inside the torso, which is how a deltoid reads anyway.
 *
 * Colour is in the vertices. Cloth, cord, hair and the irises also read a
 * small atlas painted once at build time (plaited pandanus, bark cloth with
 * its painted bands, a shell-and-seed mantle, sennit cord), so a wrap is a
 * weave at any distance instead of a few big squares of face colour. Skin and
 * everything else samples the atlas's white row.
 *
 * Shade: the game's light rig gives a shaded surface almost nothing (see
 * skyfill.ts), and the grade lifts what is left toward blue, so brown skin in
 * shade went to ink. The body material carries the sky's share itself, as an
 * emissive scaled by the surface's own colour and by how much of the sky the
 * surface faces, registered with skyFill so it falls away after dark.
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
 * Poses are joint-angle targets chased by springs, so a change of pose eases
 * in, arrives with a little overshoot and settles. Legs are solved by
 * two-bone IK against foot targets: a planted foot travels back at exactly
 * ground speed, rolls from heel to toe, and the hips ride as high as the legs
 * can reach, which is where the walk's rise and fall comes from. The spear
 * and the staff are aimed: the hand holding one is turned each frame so the
 * shaft points where the pose says, and Kael's other hand is solved onto the
 * shaft when a pose needs two hands. Under every pose there is breath, a slow
 * shift of weight from leg to leg, blinking, and eyes that move before the
 * head does.
 *
 * Budgets are measured, not estimated: `rig.triangles` and `rig.drawCalls`.
 */

const TAU = Math.PI * 2
const DEG = Math.PI / 180
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
const bell = (x: number) => Math.exp(-x * x)
/** The smaller of two heights, without the corner a plain min has where they cross. */
const softMin = (a: number, b: number) => Math.min(a, b) - Math.log(1 + Math.exp(-300 * Math.abs(a - b))) / 300

// —— the atlas ———————————————————————————————————————————————————

const ATLAS_W = 512
const ATLAS_H = 1024
const GUTTER = 6
/** Rows of the atlas, top to bottom, with their heights in texels. Each runs the full width and tiles along it. */
const ROW_HEIGHT = {
  white: 20,
  weaveK: 128,
  weaveT: 96,
  tapaT: 48,
  tapaO: 208,
  mantle: 112,
  cord: 20,
  hair: 56,
  curl: 56,
  eye: 64,
  net: 48,
  wood: 32,
  digits: 48,
} as const
type RowName = keyof typeof ROW_HEIGHT
const ROW = (() => {
  const out = {} as Record<RowName, { y: number; h: number }>
  let y = GUTTER / 2
  for (const k of Object.keys(ROW_HEIGHT) as RowName[]) {
    out[k] = { y, h: ROW_HEIGHT[k] }
    y += ROW_HEIGHT[k] + GUTTER
  }
  return out
})()
/** v for a point `t` of the way down a row (0 its top edge, 1 its bottom). */
const tv = (row: RowName, t: number) => (ROW[row].y + 0.5 + clamp(t, 0, 1) * (ROW[row].h - 1)) / ATLAS_H
const U_WHITE = 0.5
const V_WHITE = tv('white', 0.5)
/** Texels across one cell of the eye and digits rows. */
const CELL = 64

type RGB = readonly [number, number, number]
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

/** Value noise that repeats every `period` cells along x, so a row tiles. */
function tileNoise(x: number, y: number, seed: number, period: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const at = (a: number, b: number) => hash(((a % period) + period) % period, b, seed)
  const p = at(ix, iy)
  const q = at(ix + 1, iy)
  const r = at(ix, iy + 1)
  const s = at(ix + 1, iy + 1)
  return p + (q - p) * ux + (r - p) * uy + (p - q - r + s) * ux * uy
}

function paintAtlas(ctx: CanvasRenderingContext2D, ss: number) {
  const W = ATLAS_W
  // Everything is drawn in the atlas's own units; `ss` only says how many texels each one gets
  ctx.setTransform(ss, 0, 0, ss, 0, 0)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, ATLAS_H)

  const band = (row: RowName, y: number, h: number, colour: string) => {
    ctx.fillStyle = colour
    ctx.fillRect(0, ROW[row].y + y, W, h)
  }
  const tri = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, colour: string) => {
    ctx.fillStyle = colour
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.lineTo(x3, y3)
    ctx.closePath()
    ctx.fill()
  }
  const diamond = (cx: number, cy: number, r: number, colour: string) => {
    ctx.fillStyle = colour
    ctx.beginPath()
    ctx.moveTo(cx, cy - r)
    ctx.lineTo(cx + r, cy)
    ctx.lineTo(cx, cy + r)
    ctx.lineTo(cx - r, cy)
    ctx.closePath()
    ctx.fill()
  }
  const clipRow = (row: RowName, draw: () => void) => {
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, ROW[row].y, W, ROW[row].h)
    ctx.clip()
    draw()
    ctx.restore()
  }

  // —— bark cloth, Oru's wrap: a pale beaten ground, printed in bands of soot and red earth ——
  const ground = '#d6bf94'
  const soot = '#3b2518'
  const earth = '#8e4c29'
  {
    const y0 = ROW.tapaO.y
    band('tapaO', 0, ROW.tapaO.h, ground)
    band('tapaO', 0, 9, soot)
    band('tapaO', 13, 3, earth)
    for (let i = 0; i < 32; i++) tri(i * 16, y0 + 21, i * 16 + 16, y0 + 21, i * 16 + 8, y0 + 45, soot)
    band('tapaO', 50, 3, soot)
    band('tapaO', 56, 2, earth)
    for (let i = 0; i < 8; i++) {
      const cx = i * 64 + 32
      const cy = y0 + 96
      ctx.strokeStyle = soot
      ctx.lineWidth = 3
      ctx.strokeRect(i * 64 + 2.5, y0 + 66.5, 59, 59)
      if (i % 2 === 0) {
        // Four leaves meeting at the centre
        tri(cx - 23, cy - 23, cx + 23, cy - 23, cx, cy - 3, soot)
        tri(cx - 23, cy + 23, cx + 23, cy + 23, cx, cy + 3, soot)
        tri(cx - 23, cy - 18, cx - 23, cy + 18, cx - 5, cy, earth)
        tri(cx + 23, cy - 18, cx + 23, cy + 18, cx + 5, cy, earth)
      } else {
        diamond(cx, cy, 25, soot)
        diamond(cx, cy, 16, ground)
        diamond(cx, cy, 8, earth)
      }
    }
    band('tapaO', 132, 3, soot)
    ctx.strokeStyle = earth
    ctx.lineWidth = 5
    ctx.lineJoin = 'miter'
    ctx.beginPath()
    for (let i = 0; i <= 32; i++) {
      const y = y0 + (i % 2 === 0 ? 146 : 164)
      if (i === 0) ctx.moveTo(0, y)
      else ctx.lineTo(i * 16, y)
    }
    ctx.stroke()
    band('tapaO', 172, 3, soot)
    band('tapaO', 180, 24, soot)
    for (let i = 0; i < 32; i++) tri(i * 16 + 2, y0 + 201, i * 16 + 14, y0 + 201, i * 16 + 8, y0 + 185, ground)
    band('tapaO', 204, 4, earth)
  }

  // —— bark cloth, Tala's band: one row of teeth and a dotted line ——
  {
    const y0 = ROW.tapaT.y
    band('tapaT', 0, ROW.tapaT.h, '#dcc8a2')
    band('tapaT', 3, 3, soot)
    for (let i = 0; i < 32; i++) tri(i * 16, y0 + 9, i * 16 + 16, y0 + 9, i * 16 + 8, y0 + 27, soot)
    band('tapaT', 31, 2, earth)
    ctx.fillStyle = earth
    for (let i = 0; i < 32; i++) {
      ctx.beginPath()
      ctx.arc(i * 16 + 8, y0 + 38.5, 2.2, 0, TAU)
      ctx.fill()
    }
    band('tapaT', 44, 4, '#c5ae84')
  }

  // —— Oru's mantle: rows of small shells and red seeds stitched to a net of fibre ——
  clipRow('mantle', () => {
    const y0 = ROW.mantle.y
    const h = ROW.mantle.h
    band('mantle', 0, h, '#86714c')
    ctx.strokeStyle = '#5f4d31'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let k = -20; k < 70; k++) {
      ctx.moveTo(k * 10, y0)
      ctx.lineTo(k * 10 + h, y0 + h)
      ctx.moveTo(k * 10, y0)
      ctx.lineTo(k * 10 - h, y0 + h)
    }
    ctx.stroke()
    // The plaited band it hangs from
    band('mantle', 0, 11, '#a28c5d')
    ctx.strokeStyle = '#6f5b39'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let x = -4; x < W + 8; x += 8) {
      ctx.moveTo(x, y0 + 10)
      ctx.lineTo(x + 6, y0 + 1)
    }
    ctx.stroke()
    const rows = [26, 44, 62, 80, 98]
    rows.forEach((ry, j) => {
      const seedRow = j === 2
      for (let i = -1; i <= 32; i++) {
        const cx = i * 16 + (j % 2 === 0 ? 8 : 0)
        const cy = y0 + ry
        if (seedRow) {
          ctx.fillStyle = '#3e2415'
          ctx.beginPath()
          ctx.arc(cx + 1, cy + 1.5, 5.4, 0, TAU)
          ctx.fill()
          ctx.fillStyle = '#84401f'
          ctx.beginPath()
          ctx.arc(cx, cy, 5.2, 0, TAU)
          ctx.fill()
          ctx.fillStyle = '#b86f4a'
          ctx.beginPath()
          ctx.arc(cx - 1.6, cy - 1.8, 1.6, 0, TAU)
          ctx.fill()
          continue
        }
        const tone = hash(i & 31, j, 3)
        ctx.fillStyle = '#4f4028'
        ctx.beginPath()
        ctx.ellipse(cx + 1.2, cy + 1.8, 6.4, 8.8, 0, 0, TAU)
        ctx.fill()
        ctx.fillStyle = tone < 0.3 ? '#e2d5ba' : tone < 0.8 ? '#efe6d0' : '#dcc3a8'
        ctx.beginPath()
        ctx.ellipse(cx, cy, 6.2, 8.6, 0, 0, TAU)
        ctx.fill()
        ctx.fillStyle = '#c9b996'
        ctx.beginPath()
        ctx.ellipse(cx + 2.2, cy + 2.6, 3.4, 5.2, 0, 0, TAU)
        ctx.fill()
        ctx.strokeStyle = '#7d684a'
        ctx.lineWidth = 1.3
        ctx.beginPath()
        ctx.moveTo(cx, cy - 5)
        ctx.lineTo(cx, cy + 5)
        ctx.stroke()
        ctx.fillStyle = '#fffaf0'
        ctx.beginPath()
        ctx.ellipse(cx - 2.2, cy - 3, 1.5, 2.4, 0, 0, TAU)
        ctx.fill()
      }
    })
    band('mantle', 104, 8, '#5f4d31')
    ctx.strokeStyle = '#ad9765'
    ctx.lineWidth = 1.6
    ctx.beginPath()
    for (let x = 1; x < W; x += 4) {
      ctx.moveTo(x, y0 + 103)
      ctx.lineTo(x + (x % 8 < 4 ? 0.8 : -0.8), y0 + h)
    }
    ctx.stroke()
  })

  // —— the eye: one cell, the rest of the row left the colour of its white ——
  {
    const y0 = ROW.eye.y
    band('eye', 0, ROW.eye.h, '#d9cfc0')
    const cx = CELL / 2
    const cy = y0 + CELL / 2
    const white = ctx.createRadialGradient(cx, cy, 14, cx, cy, 34)
    white.addColorStop(0, '#e9e2d6')
    white.addColorStop(1, '#bca896')
    ctx.fillStyle = white
    ctx.fillRect(0, y0, CELL, CELL)
    const iris = ctx.createRadialGradient(cx, cy, 3.6, cx, cy, 10.4)
    iris.addColorStop(0, '#8a5b30')
    iris.addColorStop(1, '#3f2510')
    ctx.fillStyle = iris
    ctx.beginPath()
    ctx.arc(cx, cy, 10.4, 0, TAU)
    ctx.fill()
    ctx.strokeStyle = 'rgba(160, 112, 64, 0.5)'
    ctx.lineWidth = 0.8
    ctx.beginPath()
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU + 0.2
      ctx.moveTo(cx + Math.cos(a) * 5.1, cy + Math.sin(a) * 5.1)
      ctx.lineTo(cx + Math.cos(a) * 9, cy + Math.sin(a) * 9)
    }
    ctx.stroke()
    ctx.strokeStyle = '#1a0f09'
    ctx.lineWidth = 1.7
    ctx.beginPath()
    ctx.arc(cx, cy, 10.1, 0, TAU)
    ctx.stroke()
    ctx.fillStyle = '#0a0706'
    ctx.beginPath()
    ctx.arc(cx, cy, 4.3, 0, TAU)
    ctx.fill()
    // The light in the eye: without it the gaze is dead
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)'
    ctx.beginPath()
    ctx.ellipse(cx - 3.7, cy - 4.3, 2.4, 2, 0, 0, TAU)
    ctx.fill()
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)'
    ctx.beginPath()
    ctx.arc(cx + 3.4, cy + 4, 1, 0, TAU)
    ctx.fill()
  }

  // —— Tala's net bag: knotted cord over what she has gathered ——
  clipRow('net', () => {
    const y0 = ROW.net.y
    const h = ROW.net.h
    band('net', 0, h, '#30271b')
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = hash(i, 2, 9) < 0.5 ? 'rgba(196, 184, 156, 0.55)' : 'rgba(150, 120, 96, 0.5)'
      ctx.beginPath()
      ctx.ellipse(hash(i, 1, 9) * W, y0 + 8 + hash(i, 3, 9) * (h - 16), 5 + hash(i, 4, 9) * 4, 4, hash(i, 5, 9) * 3, 0, TAU)
      ctx.fill()
    }
    ctx.strokeStyle = '#a9935f'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let k = -8; k < 52; k++) {
      ctx.moveTo(k * 12, y0)
      ctx.lineTo(k * 12 + h, y0 + h)
      ctx.moveTo(k * 12, y0)
      ctx.lineTo(k * 12 - h, y0 + h)
    }
    ctx.stroke()
    ctx.fillStyle = '#c6b17c'
    for (let j = 0; j <= 8; j++) {
      for (let i = 0; i < 86; i++) {
        ctx.beginPath()
        ctx.arc(i * 6, y0 + j * 6, (i + j) % 2 === 0 ? 1.9 : 0, 0, TAU)
        ctx.fill()
      }
    }
  })

  // —— everything painted a texel at a time ——
  // `x` and `y` below are in the atlas's own units whatever the scale it is
  // painted at, so a pattern is the same size on the full and the low-power build
  const PW = W * ss
  const img = ctx.getImageData(0, 0, PW, ATLAS_H * ss)
  const d = img.data
  const out: [number, number, number] = [0, 0, 0]
  /** Paint a row from a function of the position in it. */
  const fill = (row: RowName, at: (x: number, y: number) => void) => {
    const y0 = ROW[row].y * ss
    const h = ROW[row].h * ss
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < PW; px++) {
        at(px / ss, py / ss)
        const i = ((y0 + py) * PW + px) * 4
        d[i] = Math.min(255, out[0])
        d[i + 1] = Math.min(255, out[1])
        d[i + 2] = Math.min(255, out[2])
        d[i + 3] = 255
      }
    }
  }
  const grey = (k: number) => {
    out[0] = out[1] = out[2] = 255 * k
  }
  const tone = (c: RGB, k: number) => {
    out[0] = c[0] * k
    out[1] = c[1] * k
    out[2] = c[2] * k
  }

  /**
   * Plaited pandanus: strips crossing on the diagonal, each cell of the plait
   * showing the strip that lies on top there, darker where it dips under its
   * neighbours. `dyed` bands swap one direction of strip for a dyed one. The
   * cell is cx by cy because a row is stretched on the cloth: the two are
   * chosen so a strip comes out as wide as it is long.
   */
  const weave = (
    row: RowName,
    cx: number,
    cy: number,
    light: RGB,
    dark: RGB,
    dye: RGB,
    dyed: readonly (readonly [number, number])[],
    seed: number,
  ) => {
    const h = ROW[row].h
    const period = Math.round(W / cx)
    const under: RGB = [mix(light[0], dark[0], 0.45), mix(light[1], dark[1], 0.45), mix(light[2], dark[2], 0.45)]
    const frayed: RGB = [mix(light[0], dark[0], 0.3), mix(light[1], dark[1], 0.3), mix(light[2], dark[2], 0.3)]
    fill(row, (x, y) => {
      const t = y / h
      const a = x / cx + y / cy
      const b = x / cx - y / cy + 1024
      const ia = Math.floor(a)
      const ib = Math.floor(b)
      const over = (ia + ib) & 1
      const strip = over ? ib : ia
      const across = over ? b - ib : a - ia
      const along = over ? a - ia : b - ib
      const edge = Math.abs(across * 2 - 1)
      const ends = Math.abs(along * 2 - 1)
      let k = (0.88 + 0.2 * hash(((strip % period) + period) % period, over, seed)) * (1 - 0.26 * edge ** 4 - 0.2 * ends ** 3)
      if (edge > 0.88) k *= 0.62
      let c = over ? under : light
      for (const [from, to] of dyed) if (t > from && t < to && !over) c = dye
      // The turned edge at the waist, and the loose ends at the hem
      if (y < 7) {
        c = dark
        k = 0.72 + 0.12 * Math.sin(x * 0.9)
      } else if (y > h - 11) {
        c = frayed
        k = x % 5 < 3 ? 0.95 + 0.1 * hash(Math.floor(x / 5), 3, seed) : 0.5
      }
      tone(c, k)
    })
  }
  weave('weaveK', 16, 6.4, hex('#c2a56b'), hex('#9b7d49'), hex('#4b2f1d'), [[0.7, 0.84]], 21)
  weave('weaveT', 12.8, 4.4, hex('#dbc591'), hex('#b89d66'), hex('#933f25'), [[0.62, 0.7], [0.78, 0.86]], 31)

  // Bark cloth is beaten, not woven: a soft mottle and the faint lines of the beater
  for (const row of ['tapaO', 'tapaT'] as const) {
    const y0 = ROW[row].y * ss
    const h = ROW[row].h * ss
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < PW; px++) {
        const x = px / ss
        const y = py / ss
        const n = tileNoise(x / 9, y / 9, 51, 57) * 0.6 + tileNoise(x / 2.5, y / 14, 52, 205) * 0.4
        const k = 0.9 + 0.16 * n
        const i = ((y0 + py) * PW + px) * 4
        d[i] = Math.min(255, d[i] * k)
        d[i + 1] = Math.min(255, d[i + 1] * k)
        d[i + 2] = Math.min(255, d[i + 2] * k)
      }
    }
  }

  // Sennit: coconut-fibre cord plaited flat, a herringbone
  {
    const h = ROW.cord.h
    const a = hex('#a48a58')
    const b = hex('#6a5433')
    fill('cord', (x, y) => {
      const v = y / (h - 1)
      const s = x / 8 + Math.abs(v - 0.5) * 1.5
      const ridge = 1 - Math.abs((s - Math.floor(s)) * 2 - 1)
      const m = smooth(0.15, 0.6, ridge)
      const k = (0.78 + 0.3 * ridge) * (1 - 0.45 * Math.abs(v * 2 - 1) ** 3)
      out[0] = mix(b[0], a[0], m) * k
      out[1] = mix(b[1], a[1], m) * k
      out[2] = mix(b[2], a[2], m) * k
    })
  }

  // Hair, as a value the vertex colour is multiplied by: strands for straight hair...
  fill('hair', (x, y) => {
    const sway = Math.sin(y * 0.16 + tileNoise(x / 40, 0, 7, 13) * 5) * 1.6
    const fine = tileNoise((x + sway) / 2.2, y / 30, 5, 233)
    const lock = tileNoise((x + sway) / 9, y / 60, 6, 57)
    let k = 0.5 + 0.34 * fine + 0.22 * lock
    if (hash(Math.floor((x + sway) / 2), 1, 8) > 0.92) k += 0.18
    grey(k)
  })
  // ...and tight curls for Kael's: small round clumps, wider than tall here because the row is stretched up the head
  {
    const cx = 12.8
    const cy = 3.7
    const period = Math.round(W / cx)
    fill('curl', (x, y) => {
      const gx = x / cx
      const gy = y / cy
      const ix = Math.floor(gx)
      const iy = Math.floor(gy)
      let best = 9
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const wrap = (((ix + ox) % period) + period) % period
          const px = ix + ox + 0.2 + 0.6 * hash(wrap, iy + oy, 11)
          const py = iy + oy + 0.2 + 0.6 * hash(wrap, iy + oy, 12)
          best = Math.min(best, Math.hypot(gx - px, gy - py))
        }
      }
      grey(0.4 + 0.6 * (1 - smooth(0.08, 0.72, best)))
    })
  }

  // Wood grain, also a value: long streaks down the shaft
  fill('wood', (x, y) => {
    grey(0.62 + 0.38 * (tileNoise(x / 46, y / 2.4, 14, 11) * 0.65 + tileNoise(x / 13, y / 1.3, 15, 39) * 0.35))
  })

  // Fingers and toes, a value again: the creases between them, across one cell each
  {
    const h = ROW.digits.h
    fill('digits', (x, y) => {
      const v = y / (h - 1)
      const cell = Math.floor(x / CELL)
      const u = (x % CELL) / CELL
      let k = 1
      if (cell === 0) {
        // Four fingers: three creases, and the lines across the knuckles
        for (const at of [0.26, 0.5, 0.74]) k = Math.min(k, 0.6 + 0.4 * smooth(0.008, 0.04, Math.abs(u - at)))
        for (const at of [0.52, 0.76]) k = Math.min(k, 0.86 + 0.14 * smooth(0, 0.03, Math.abs(v - at)))
      } else if (cell === 1) {
        // Five toes, the big one widest
        for (const at of [0.3, 0.5, 0.67, 0.83]) k = Math.min(k, 0.6 + 0.4 * smooth(0.008, 0.045, Math.abs(u - at)))
      }
      // Nothing above the knuckles
      grey(mix(1, k, smooth(0.28, 0.4, v)))
    })
  }

  // Row 0 is what every plain, vertex-coloured surface samples
  fill('white', () => grey(1))

  // Carry each row's edge into the gutter, so a mip level never mixes two rows
  const rows = ATLAS_H * ss
  for (const k of Object.keys(ROW) as RowName[]) {
    const first = ROW[k].y * ss
    const last = (ROW[k].y + ROW[k].h) * ss - 1
    for (let g = 1; g <= (GUTTER / 2) * ss; g++) {
      for (const [from, to] of [[first, first - g], [last, last + g]]) {
        if (to < 0 || to >= rows) continue
        d.copyWithin(to * PW * 4, from * PW * 4, (from + 1) * PW * 4)
      }
    }
  }
  return img
}

let atlasTexture: THREE.DataTexture | null = null

/** The atlas, painted on first use: at twice its size on the full build, at its own on the low-power one. */
function atlas(low: boolean) {
  if (atlasTexture) return atlasTexture
  const ss = low ? 1 : 2
  let data: Uint8Array
  let w = ATLAS_W * ss
  let h = ATLAS_H * ss
  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas')
  if (canvas) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas?.getContext('2d', { willReadFrequently: true }) ?? null
  if (ctx) {
    data = new Uint8Array(paintAtlas(ctx, ss).data.buffer.slice(0))
  } else {
    // No canvas (a headless check): plain vertex colour
    w = h = 2
    data = new Uint8Array(16).fill(255)
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  atlasTexture = tex
  return tex
}

// —— materials —————————————————————————————————————————————————

let bodyMaterial: THREE.MeshStandardMaterial | null = null
let brassMaterial: THREE.MeshStandardMaterial | null = null

/**
 * One material for skin, cloth, hair, wood and shell on all three islanders,
 * and one for the brass Tala scavenged from the coaster.
 *
 * The body's emissive is the sky's light, not a glow: it is multiplied by the
 * surface's own colour, weighted toward faces that look up at the sky, with a
 * little more along the silhouette where skylight grazes, and it follows the
 * daylight through skyFill like every other stand-in on the island.
 */
function materials(low: boolean) {
  if (!bodyMaterial) {
    const mat = skyFill(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: atlas(low),
        roughness: 0.66,
        metalness: 0,
        emissive: new THREE.Color(0.66, 0.6, 0.55),
        emissiveIntensity: 1,
      }),
    )
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        {
          vec3 skyUp = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));
          float skyFacing = 0.5 + 0.5 * dot(normal, skyUp);
          float skyGraze = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
          totalEmissiveRadiance *= diffuseColor.rgb * (0.45 + 0.75 * skyFacing + 0.6 * skyGraze * skyFacing);
        }`,
      )
    }
    mat.customProgramCacheKey = () => 'islander-skyfill-1'
    bodyMaterial = mat
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

// —— the skeleton ——————————————————————————————————————————————————

/** Bone indices, in the order the skeleton is built. */
const B = {
  hips: 0, spine: 1, chest: 2, neck: 3, head: 4,
  shoulderR: 5, elbowR: 6, wristR: 7,
  shoulderL: 8, elbowL: 9, wristL: 10,
  hipR: 11, kneeR: 12, ankleR: 13,
  hipL: 14, kneeL: 15, ankleL: 16,
  eyeR: 17, eyeL: 18, lids: 19, jaw: 20, browR: 21, browL: 22,
  fingersR: 23, fingersL: 24,
} as const

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
const NECK_Z = 0.005
const HEAD_Y = 0.085
const SHOULDER_X = 0.185
const SHOULDER_Y = 0.205
const SHOULDER_Z = 0.005
/** Where a closed fist holds a shaft, in the wrist's frame. The shaft runs along local z. */
const GRIP_Y = -0.058
/** Along the foot from the ankle: where the ball and the heel meet the ground. */
const BALL = 0.115
const HEEL = 0.05
/** The leg at full stretch, a hair short of locked. */
const REACH = 0.8392

/** Heights of the joints in the bind pose, in the body's frame. */
const Y_SHOULDER = STAND_HIPS + SPINE_Y + CHEST_Y + SHOULDER_Y
const Y_HEAD = STAND_HIPS + SPINE_Y + CHEST_Y + NECK_Y + HEAD_Y
const Y_HIP = STAND_HIPS + HIP_Y
const Y_WRIST = Y_SHOULDER - UPPER_ARM - FOREARM
/** The knuckles, below the wrist: where the fingers hinge. */
const KNUCKLE_Y = -0.105
/** Face landmarks in the head's frame. */
const EYE_X = 0.0325
const EYE_Y = 0.076
const EYE_Z = -0.074
const BROW_Y = 0.0985
const JAW_Y = 0.03
const JAW_Z = -0.012

/** Index 0 is the right side (+x), 1 the left. */
const SIDES = [1, -1] as const

// —— geometry: one builder, every part a grid of vertices ————————————————————

/** One vertex being described by a part. Colour defaults to white on the atlas's white row, weight to the hips. */
class Vert {
  x = 0
  y = 0
  z = 0
  r = 1
  g = 1
  b = 1
  u = U_WHITE
  v = V_WHITE
  b0 = 0
  b1 = 0
  b2 = 0
  w0 = 1
  w1 = 0
  w2 = 0
  reset() {
    this.x = this.y = this.z = 0
    this.r = this.g = this.b = 1
    this.u = U_WHITE
    this.v = V_WHITE
    this.b0 = this.b1 = this.b2 = 0
    this.w0 = 1
    this.w1 = this.w2 = 0
  }
  at(x: number, y: number, z: number) {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
  rgb(c: THREE.Color, k = 1) {
    this.r = c.r * k
    this.g = c.g * k
    this.b = c.b * k
    return this
  }
  grey(k: number) {
    this.r = this.g = this.b = k
    return this
  }
  tex(u: number, v: number) {
    this.u = u
    this.v = v
    return this
  }
  bone(i: number) {
    this.b0 = i
    this.w0 = 1
    this.w1 = this.w2 = 0
    return this
  }
  /** Bone `a`, with `t` of the weight handed to bone `b`. */
  bones(a: number, b: number, t: number) {
    this.b0 = a
    this.b1 = b
    this.w0 = 1 - t
    this.w1 = t
    this.w2 = 0
    return this
  }
  bones3(a: number, wa: number, b: number, wb: number, c: number, wc: number) {
    this.b0 = a
    this.b1 = b
    this.b2 = c
    this.w0 = wa
    this.w1 = wb
    this.w2 = wc
    return this
  }
}

type SurfaceOpts = {
  /** A point the surface faces away from. Default: the middle of its own vertices. */
  inside?: readonly [number, number, number]
  /** Leave a quad out (a face that would only ever be hidden). */
  skip?: (r: number, c: number) => boolean
  /** Added to every position: where the part's own frame sits in the body. */
  ox?: number
  oy?: number
  oz?: number
  /** Applied to every position before that: a part modelled once and made wider or shorter for one islander. */
  sx?: number
  sy?: number
  sz?: number
}

/**
 * Collects every part of one islander into one indexed geometry with
 * position, normal, colour, uv and skin weights.
 *
 * A part is a grid: (rows + 1) x (cols + 1) vertices from a callback. A tube
 * repeats its first column as its last (so uv can wrap), a pole is a ring
 * whose vertices coincide, and a hard edge of colour or of uv is two rings in
 * the same place. Triangles with no area are dropped, normals are averaged
 * over vertices that share a position, and the winding is turned to face away
 * from the part's inside, so callers need not care which way their grid runs.
 */
class Sculpt {
  pos: number[] = []
  nrm: number[] = []
  col: number[] = []
  uv: number[] = []
  skinI: number[] = []
  skinW: number[] = []
  idx: number[] = []
  private vert = new Vert()

  surface(rows: number, cols: number, fn: (r: number, c: number, v: Vert) => void, o: SurfaceOpts = {}) {
    const base = this.pos.length / 3
    const v = this.vert
    const ox = o.ox ?? 0
    const oy = o.oy ?? 0
    const oz = o.oz ?? 0
    const sx = o.sx ?? 1
    const sy = o.sy ?? 1
    const sz = o.sz ?? 1
    const P = this.pos
    let mx = 0
    let my = 0
    let mz = 0
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        v.reset()
        fn(r, c, v)
        P.push(v.x * sx + ox, v.y * sy + oy, v.z * sz + oz)
        mx += v.x * sx + ox
        my += v.y * sy + oy
        mz += v.z * sz + oz
        this.col.push(v.r, v.g, v.b)
        this.uv.push(v.u, v.v)
        const sum = v.w0 + v.w1 + v.w2 || 1
        this.skinI.push(v.b0, v.b1, v.b2, 0)
        this.skinW.push(v.w0 / sum, v.w1 / sum, v.w2 / sum, 0)
        this.nrm.push(0, 0, 0)
      }
    }
    const count = (rows + 1) * (cols + 1)
    const inside = o.inside ?? [mx / count, my / count, mz / count]
    const at = (r: number, c: number) => base + r * (cols + 1) + c
    const same = (i: number, j: number) =>
      Math.abs(P[i * 3] - P[j * 3]) + Math.abs(P[i * 3 + 1] - P[j * 3 + 1]) + Math.abs(P[i * 3 + 2] - P[j * 3 + 2]) < 1e-6
    const tris: number[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (o.skip?.(r, c)) continue
        const a = at(r, c)
        const b = at(r, c + 1)
        const d = at(r + 1, c)
        const e = at(r + 1, c + 1)
        if (!same(a, d) && !same(d, b) && !same(a, b)) tris.push(a, d, b)
        if (!same(b, d) && !same(d, e) && !same(b, e)) tris.push(b, d, e)
      }
    }
    // Which way is out, summed over the part
    const fn3 = [0, 0, 0]
    const faceNormal = (i: number) => {
      const a = tris[i] * 3
      const b = tris[i + 1] * 3
      const c = tris[i + 2] * 3
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2]
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2]
      fn3[0] = e1y * e2z - e1z * e2y
      fn3[1] = e1z * e2x - e1x * e2z
      fn3[2] = e1x * e2y - e1y * e2x
    }
    let out = 0
    for (let i = 0; i < tris.length; i += 3) {
      faceNormal(i)
      const a = tris[i] * 3
      const b = tris[i + 1] * 3
      const c = tris[i + 2] * 3
      out +=
        fn3[0] * ((P[a] + P[b] + P[c]) / 3 - inside[0]) +
        fn3[1] * ((P[a + 1] + P[b + 1] + P[c + 1]) / 3 - inside[1]) +
        fn3[2] * ((P[a + 2] + P[b + 2] + P[c + 2]) / 3 - inside[2])
    }
    if (out < 0) {
      for (let i = 0; i < tris.length; i += 3) {
        const t = tris[i + 1]
        tris[i + 1] = tris[i + 2]
        tris[i + 2] = t
      }
    }
    // Normals, shared by every vertex of this part that sits in the same place
    const slot = new Map<string, number>()
    const acc: number[] = []
    const slotOf: number[] = []
    for (let i = 0; i < count; i++) {
      const k = (base + i) * 3
      const key = `${Math.round(P[k] * 2e4)},${Math.round(P[k + 1] * 2e4)},${Math.round(P[k + 2] * 2e4)}`
      let s = slot.get(key)
      if (s === undefined) {
        s = acc.length / 3
        slot.set(key, s)
        acc.push(0, 0, 0)
      }
      slotOf.push(s)
    }
    for (let i = 0; i < tris.length; i += 3) {
      faceNormal(i)
      for (let k = 0; k < 3; k++) {
        const s = slotOf[tris[i + k] - base] * 3
        acc[s] += fn3[0]
        acc[s + 1] += fn3[1]
        acc[s + 2] += fn3[2]
      }
    }
    for (let i = 0; i < count; i++) {
      const s = slotOf[i] * 3
      const len = Math.hypot(acc[s], acc[s + 1], acc[s + 2]) || 1
      const k = (base + i) * 3
      this.nrm[k] = acc[s] / len
      this.nrm[k + 1] = acc[s + 1] / len
      this.nrm[k + 2] = acc[s + 2] / len
    }
    for (const t of tris) this.idx.push(t)
  }

  get empty() {
    return this.idx.length === 0
  }

  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.skinI, 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.skinW, 4))
    g.setIndex(this.idx)
    return g
  }
}

/** [y, half width, half depth in front (-z), half depth behind, z centre, x centre] */
type Sec = readonly number[]

/**
 * A point on one ring of a loft. Angle 0 is the right side (+x), a quarter
 * turn is the back (+z). `square` above 2 flattens the ring toward a rounded box.
 */
function ringAt(s: Sec, a: number, v: Vert, square = 2) {
  const cs = Math.cos(a)
  const sn = Math.sin(a)
  const p = 2 / square
  const ex = Math.sign(cs) * Math.abs(cs) ** p
  const ez = Math.sign(sn) * Math.abs(sn) ** p
  v.x = (s[5] ?? 0) + ex * s[1]
  v.y = s[0]
  v.z = (s[4] ?? 0) + ez * (sn < 0 ? s[2] : s[3])
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

// —— who they are, as shapes ————————————————————————————————————————

/** Control points [degrees round from the front, value], the same on both sides of the head. */
type Curve = readonly (readonly [number, number])[]

function curveAt(c: Curve, deg: number) {
  const d = Math.abs(deg)
  if (d <= c[0][0]) return c[0][1]
  for (let i = 1; i < c.length; i++) {
    if (d <= c[i][0]) return mix(c[i - 1][1], c[i][1], smooth(c[i - 1][0], c[i][0], d))
  }
  return c[c.length - 1][1]
}

/** What makes one face not another. 1 is the reference head unless noted. */
type Face = {
  /** Width of the jaw. */
  jaw: number
  chin: number
  /** Fullness of the cheekbones. */
  cheek: number
  /** Weight of the brow ridge. */
  ridge: number
  /** 0..1: hollows under the cheekbones, heavier lids. */
  age: number
  /** Size of the eye. */
  eye: number
  /** How far the upper lid stands open, degrees above level. */
  lidOpen: number
  noseW: number
  noseL: number
  lipW: number
  lipFull: number
  /** Corners of the mouth: up (+) or set (-). */
  smile: number
  /** Inner ends of the brows lower (+) or higher (-) than the outer. */
  browTilt: number
  browThick: number
  browArch: number
  ear: number
  /** How far the bridge of the nose stands off the face between the eyes. */
  bridge: number
}

type Style = {
  skin: THREE.Color
  palm: THREE.Color
  lip: THREE.Color
  hair: THREE.Color
  brow: THREE.Color
  /** Height of the hairline on the head, round from the front. */
  hairLine: Curve
  /** How far the hair stands off the scalp: degrees round from the front, and 0 (hairline) to 1 (crown). */
  hairThick: (deg: number, t: number) => number
  hairRow: 'hair' | 'curl'
  hairTiles: number
  beard: boolean
  girth: number
  shoulders: number
  hipsW: number
  waist: number
  /** Extra front depth over the chest, and over the belly. */
  bust: number
  belly: number
  neck: number
  /** 0..1 how much the chest and belly are drawn in shade. */
  muscle: number
  face: Face
  /** The head as a whole: wider, shorter or deeper than the reference one. */
  headScale: readonly [number, number, number]
  /** Where the hem of the wrap hangs, from the hips. What the wrap always covers is not built. */
  wrapHem: number
  seed: number
}

/** How finely each part is cut. The low-power build is the same body on fewer faces. */
type Detail = {
  low: boolean
  arm: number
  leg: number
  torso: number
  cloth: number
  shaft: number
  /** Columns of the head: degrees round from the front, one side. */
  headHalf: readonly number[]
  eye: number
  lid: number
  /** Rows of a hair shell, hairline to crown. */
  hairT: readonly number[]
}

const FULL: Detail = {
  low: false,
  arm: 8,
  leg: 9,
  torso: 12,
  cloth: 16,
  shaft: 6,
  headHalf: [0, 9, 18, 27, 37, 48, 60, 74, 90, 108, 128, 152, 180],
  eye: 8,
  lid: 6,
  hairT: [0, 0.1, 0.3, 0.55, 0.8, 1],
}

const LOW: Detail = {
  low: true,
  arm: 6,
  leg: 7,
  torso: 10,
  cloth: 12,
  shaft: 5,
  headHalf: [0, 10, 20, 31, 44, 60, 80, 104, 136, 180],
  eye: 6,
  lid: 4,
  hairT: [0, 0.12, 0.4, 0.75, 1],
}

/** Skin at this vertex: the base tone, a shade, a little warmth, and a grain so no patch is one flat value. */
function skinAt(v: Vert, st: Style, shade = 1, warm = 0) {
  const n = shade * (1 + (hash(v.x * 91.7 + st.seed, v.y * 73.1, v.z * 57.3) - 0.5) * 0.04)
  v.r = st.skin.r * n * (1 + warm * 0.1)
  v.g = st.skin.g * n * (1 - warm * 0.05)
  v.b = st.skin.b * n * (1 - warm * 0.12)
}

/** A loft's section at any height, by straight interpolation between its rings. */
function secAt(secs: readonly Sec[], y: number, out: number[]) {
  let i = 0
  while (i < secs.length - 2 && secs[i + 1][0] < y) i++
  const a = secs[i]
  const b = secs[i + 1]
  const k = clamp((y - a[0]) / (b[0] - a[0] || 1), 0, 1)
  out[0] = y
  for (let j = 1; j < 6; j++) out[j] = mix(a[j] ?? 0, b[j] ?? 0, k)
  return out
}

/** The trunk from the fork to inside the skull, in the body's frame. */
function torsoSecs(st: Style): Sec[] {
  const sh = st.shoulders
  const hw = st.hipsW
  const half = 0.5 + sh * 0.5
  const n = st.neck
  const raw: number[][] = [
    [0.835, 0, 0, 0, 0.012],
    [0.852, 0.105 * hw, 0.066, 0.08, 0.012],
    [0.895, 0.158 * hw, 0.094, 0.108, 0.01],
    [0.945, 0.172 * hw, 0.1, 0.113, 0.006],
    [1.0, 0.162 * (0.5 + hw * 0.5), 0.097 + st.belly * 0.5, 0.1, 0.002],
    [1.05, 0.146 * st.waist, 0.092 + st.belly, 0.088, 0],
    [1.1, 0.137 * st.waist, 0.09 + st.belly, 0.082, 0],
    [1.16, 0.142 * (0.5 + st.waist * 0.5), 0.094 + st.belly * 0.6, 0.083, 0],
    [1.215, 0.152, 0.098 + st.belly * 0.2, 0.087, 0],
    [1.27, 0.164 * half, 0.106 + st.bust * 0.5, 0.093, 0],
    [1.325, 0.175 * half, 0.112 + st.bust, 0.098, 0],
    [1.375, 0.183 * (0.4 + sh * 0.6), 0.108 + st.bust * 0.6, 0.1, 0],
    // The shoulder line runs out over the top of the arm, so the arm's cap reads as a deltoid and not a ball
    [1.43, 0.2 * sh, 0.094, 0.095, 0.004],
    [1.458, 0.187 * sh, 0.08, 0.084, 0.006],
    [1.476, 0.136 * sh, 0.068, 0.074, 0.008],
  ]
  for (const s of raw) {
    // The shoulders are as wide as the arms are set, whatever the girth of the trunk below them
    if (s[0] < 1.4) s[1] *= st.girth
    s[2] *= st.girth
    s[3] *= st.girth
  }
  raw.push(
    [1.491, 0.086, 0.057, 0.063, 0.009],
    [1.506, 0.06 * n, 0.052 * n, 0.057 * n, 0.011],
    [1.54, 0.054 * n, 0.05 * n, 0.054 * n, 0.013],
    [1.582, 0.052 * n, 0.048 * n, 0.052 * n, 0.016],
    [1.6, 0, 0, 0, 0.016],
  )
  return raw
}

/** Which of the trunk's bones carry the point `v` is at, at this height. */
function torsoWeights(v: Vert, y: number) {
  if (y < 0.99) v.bone(B.hips)
  else if (y < 1.11) v.bones(B.hips, B.spine, smooth(0.99, 1.11, y))
  else if (y < 1.17) v.bone(B.spine)
  else if (y < 1.29) v.bones(B.spine, B.chest, smooth(1.17, 1.29, y))
  else if (y < 1.445) v.bone(B.chest)
  // The neck takes over up its own column only: the shoulders either side stay with the chest
  else if (y < 1.505) v.bones(B.chest, B.neck, smooth(1.445, 1.505, y) * smooth(0.15, 0.07, Math.abs(v.x)))
  else if (y < 1.535) v.bone(B.neck)
  else v.bones(B.neck, B.head, smooth(1.535, 1.585, y))
}

function buildTorso(S: Sculpt, st: Style, q: Detail, secs: readonly Sec[]) {
  const sides = q.torso
  // The wrap is a closed bag from the waist to its hem: nothing inside it is
  // ever seen, so the pelvis is left out, and can never show through the cloth
  const skip = (r: number) => secs[r + 1][0] < 1.005
  S.surface(secs.length - 1, sides, (r, c, v) => {
    const s = secs[r]
    const a = (c / sides) * TAU
    ringAt(s, a, v, s[0] < 1.48 ? 2.35 : 2)
    const y = s[0]
    const front = -Math.sin(a)
    const side = Math.abs(Math.cos(a))
    // A worked chest: the two muscles stand forward of the breastbone between them
    const chest = front > 0 ? st.muscle * bell((y - 1.335) / 0.05) : 0
    v.z -= 0.008 * chest * bell((Math.abs(v.x) - 0.085) / 0.055)
    let shade = 1 - 0.1 * chest * bell(v.x / 0.022)
    // Under the arm, under the chest, down the middle of the belly, under the jaw
    shade *= 1 - 0.1 * smooth(0.75, 1, side) * bell((y - 1.36) / 0.07)
    shade *= 1 - 0.12 * st.muscle * bell((y - 1.275) / 0.022) * smooth(0.2, 0.7, front)
    shade *= 1 - 0.07 * st.muscle * bell((y - 1.15) / 0.09) * bell(Math.cos(a) / 0.3) * (front > 0 ? 1 : 0)
    shade *= 1 - 0.12 * bell((y - 1.525) / 0.03) * smooth(-0.2, 0.8, front)
    shade *= mix(0.88, 1, smooth(0.84, 0.9, y))
    // The hollow of the back
    shade *= 1 - 0.06 * bell((y - 1.2) / 0.12) * bell(Math.cos(a) / 0.3) * (front < 0 ? 1 : 0)
    skinAt(v, st, shade, 0.2 * bell((y - 1.33) / 0.06) * Math.max(0, front))
    torsoWeights(v, y)
  }, { skip })
}

function buildArm(S: Sculpt, st: Style, q: Detail, i: number, fist: boolean) {
  const s = SIDES[i]
  const sides = q.arm
  const g = st.girth
  const ox = s * SHOULDER_X * st.shoulders
  const origin = { ox, oy: Y_SHOULDER, oz: SHOULDER_Z }
  const shoulder = i === 0 ? B.shoulderR : B.shoulderL
  const elbow = shoulder + 1
  const wrist = shoulder + 2
  const fingers = i === 0 ? B.fingersR : B.fingersL
  // A worked arm is thicker in the muscle, not at the wrist
  const thick = g * (1 + 0.1 * st.muscle)

  const arm: number[][] = [
    [0.047, 0, 0, 0, 0],
    [0.031, 0.037, 0.038, 0.038, 0],
    [0.0, 0.057, 0.056, 0.055, 0],
    [-0.055, 0.055, 0.054, 0.052, 0],
    [-0.135, 0.049, 0.053, 0.049, -0.003],
    [-0.225, 0.042, 0.045, 0.043, -0.002],
    [-0.275, 0.038, 0.039, 0.04, 0],
    [-0.3, 0.038, 0.037, 0.041, 0.002],
    [-0.335, 0.043, 0.041, 0.04, 0],
    [-0.4, 0.04, 0.037, 0.036, 0],
    [-0.48, 0.033, 0.029, 0.029, 0],
    [-0.535, 0.028, 0.023, 0.023, 0],
    [-0.565, 0.026, 0.021, 0.021, 0],
  ]
  if (q.low) arm.splice(3, 1)
  for (const a of arm) {
    const k = mix(thick, g, smooth(-0.44, -0.53, a[0]))
    a[1] *= k
    a[2] *= k
    a[3] *= k
  }
  const armRows = arm.length
  // The hand follows on the same surface, so the wrist has no seam. With the
  // arm hanging the palm faces the thigh: breadth runs front to back (z),
  // thickness across (x), and the fingers curl a little toward the palm.
  /** [y, thickness, breadth in front, breadth behind, curl toward the palm, v down the digits cell] */
  const hand: number[][] = fist
    ? [
        [-0.6, 0.02, 0.018, 0.018, 0, 0.04],
        [-0.615, 0, 0, 0, 0, 0.04],
      ]
    : [
        [-0.565, 0.026 * g, 0.021 * g, 0.021 * g, 0, 0.04],
        [-0.585, 0.022, 0.026, 0.024, 0, 0.06],
        [-0.61, 0.0185, 0.036, 0.032, 0, 0.12],
        [-0.64, 0.018, 0.042, 0.038, 0, 0.2],
        [-0.665, 0.0155, 0.044, 0.04, 0.001, 0.3],
        [-0.692, 0.013, 0.0425, 0.039, 0.003, 0.5],
        [-0.714, 0.0115, 0.04, 0.036, 0.007, 0.7],
        [-0.733, 0.0095, 0.035, 0.031, 0.012, 0.88],
        [-0.744, 0.006, 0.026, 0.022, 0.015, 0.98],
        [-0.748, 0, 0, 0, 0.016, 1],
      ]
  const rows = armRows + hand.length - 1
  const sec: number[] = [0, 0, 0, 0, 0, 0]
  S.surface(
    rows,
    sides,
    (r, c, v) => {
      const a = (c / sides) * TAU
      if (r < armRows) {
        const row = arm[r]
        ringAt(row, a, v)
        const y = row[0]
        const back = Math.sin(a)
        // The point of the elbow is darker and drier
        skinAt(v, st, 1 - 0.1 * bell((y + 0.3) / 0.035) * Math.max(0, back))
        if (y > -0.25) v.bone(shoulder)
        else if (y > -0.35) v.bones(shoulder, elbow, smooth(-0.25, -0.35, y))
        else if (y > -0.537) v.bone(elbow)
        else v.bones(elbow, wrist, smooth(-0.537, -0.585, y))
        return
      }
      const h = hand[r - armRows]
      sec[0] = h[0]
      sec[1] = h[1]
      sec[2] = h[2]
      sec[3] = h[3]
      sec[4] = 0
      sec[5] = -s * h[4]
      ringAt(sec, a, v, fist ? 2 : 2.8)
      // The palm is paler than the back of the hand
      const palmSide = smooth(0.15, 0.8, -s * Math.cos(a))
      skinAt(v, st, 1 - 0.06 * bell((h[0] + 0.665) / 0.012) * (1 - palmSide))
      v.r = mix(v.r, st.palm.r, palmSide * 0.8)
      v.g = mix(v.g, st.palm.g, palmSide * 0.8)
      v.b = mix(v.b, st.palm.b, palmSide * 0.8)
      if (!fist) v.tex((clamp((v.z + 0.044) / 0.088, 0.04, 0.96) * CELL) / ATLAS_W, tv('digits', h[5]))
      // Past the knuckles the fingers are their own joint, so the hand can close
      if (h[0] > -0.585) v.bones(elbow, wrist, smooth(-0.537, -0.585, h[0]))
      else if (fist || h[0] > -0.655) v.bone(wrist)
      else v.bones(wrist, fingers, smooth(-0.655, -0.692, h[0]))
    },
    origin,
  )

  /** A short tube through three points, for a thumb. */
  const thumb = (pts: readonly (readonly number[])[], radii: readonly number[]) => {
    S.surface(
      pts.length,
      5,
      (r, c, v) => {
        const k = Math.min(r, pts.length - 1)
        const p = pts[k]
        const n = pts[Math.min(k + 1, pts.length - 1)]
        const m = pts[Math.max(k - 1, 0)]
        const dy = n[1] - m[1]
        const dz = n[2] - m[2]
        const len = Math.hypot(dy, dz) || 1
        const rad = r === pts.length ? 0 : radii[k]
        const a = (c / 5) * TAU
        // The last ring closes the tip, a little beyond the last point
        const tip = r === pts.length ? 0.008 : 0
        v.at(
          p[0] + Math.cos(a) * rad,
          p[1] + (Math.sin(a) * rad * dz) / len + (tip * dy) / len,
          p[2] - (Math.sin(a) * rad * dy) / len + (tip * dz) / len,
        )
        skinAt(v, st, 0.97)
        v.bone(wrist)
      },
      origin,
    )
  }

  if (fist) {
    // A closed hand round the shaft, which runs along z through the grip point:
    // the four fingers lie side by side along it
    const cy = -UPPER_ARM - FOREARM - 0.052
    const stations = [
      [-0.047, 0],
      [-0.043, 0.72],
      [-0.03, 1],
      [0, 1],
      [0.03, 1],
      [0.041, 0.72],
      [0.045, 0],
    ]
    const around = 8
    S.surface(
      stations.length - 1,
      around,
      (r, c, v) => {
        const [z, k] = stations[r]
        const b = (c / around) * TAU
        const cs = Math.cos(b)
        const sn = Math.sin(b)
        v.at(
          -s * 0.003 + Math.sign(cs) * Math.abs(cs) ** 0.7 * 0.027 * k,
          cy + Math.sign(sn) * Math.abs(sn) ** 0.7 * 0.036 * k,
          z,
        )
        const palmSide = smooth(0.2, 0.8, -s * cs)
        skinAt(v, st, 1 - 0.08 * palmSide)
        // Creases between the fingers on the lower half; the back of the hand above stays plain
        v.tex((clamp((z + 0.047) / 0.094, 0.04, 0.96) * CELL) / ATLAS_W, tv('digits', sn > -0.1 ? 0.05 : 0.6))
        v.bone(wrist)
      },
      origin,
    )
    const w = -UPPER_ARM - FOREARM
    thumb(
      [
        [s * 0.014, w - 0.026, -0.024],
        [-s * 0.006, w - 0.04, -0.046],
        [-s * 0.024, w - 0.058, -0.044],
      ],
      [0.0125, 0.012, 0.0095],
    )
  } else {
    const w = -UPPER_ARM - FOREARM
    thumb(
      [
        [-s * 0.004, w - 0.04, -0.028],
        [-s * 0.01, w - 0.078, -0.05],
        [-s * 0.017, w - 0.108, -0.058],
      ],
      [0.013, 0.0115, 0.009],
    )
  }
}

function buildLeg(S: Sculpt, st: Style, q: Detail, i: number) {
  const s = SIDES[i]
  const sides = q.leg
  const g = st.girth
  const ox = s * HIP_X * st.hipsW
  const hip = i === 0 ? B.hipR : B.hipL
  const knee = hip + 1
  const ankle = hip + 2
  const leg: number[][] = [
    [0.07, 0, 0, 0, 0.01],
    [0.045, 0.066, 0.058, 0.068, 0.01],
    [-0.03, 0.087, 0.086, 0.084, 0.005],
    [-0.13, 0.081, 0.082, 0.078, 0],
    [-0.26, 0.069, 0.071, 0.067, 0],
    [-0.36, 0.058, 0.061, 0.056, 0],
    [-0.42, 0.052, 0.057, 0.05, -0.002],
    [-0.47, 0.048, 0.049, 0.053, 0.002],
    [-0.55, 0.049, 0.045, 0.066, 0.009],
    [-0.66, 0.041, 0.04, 0.052, 0.006],
    [-0.76, 0.03, 0.032, 0.034, 0.003],
    [-0.815, 0.027, 0.03, 0.03, 0.004],
    [-0.855, 0.028, 0.032, 0.034, 0.004],
    [-0.875, 0, 0, 0, 0.004],
  ]
  if (q.low) leg.splice(3, 1)
  const thick = g * (1 + 0.06 * st.muscle)
  for (const a of leg) {
    if (a[0] < -0.8) continue
    a[1] *= thick
    a[2] *= thick
    a[3] *= thick
  }
  S.surface(
    leg.length - 1,
    sides,
    (r, c, v) => {
      const row = leg[r]
      const a = (c / sides) * TAU
      ringAt(row, a, v)
      const y = row[0]
      skinAt(v, st, 1 - 0.08 * bell((y + 0.425) / 0.035) * Math.max(0, -Math.sin(a)))
      if (y > -0.35) v.bone(hip)
      else if (y > -0.49) v.bones(hip, knee, smooth(-0.35, -0.49, y))
      else if (y > -0.79) v.bone(knee)
      else v.bones(knee, ankle, smooth(-0.79, -0.85, y))
    },
    // The top of the thigh is inside the wrap: built only from a hand's breadth above the hem down
    { ox, oy: Y_HIP, oz: 0, skip: (r) => Y_HIP + leg[r + 1][0] > STAND_HIPS + st.wrapHem + 0.14 },
  )

  // The foot, in the ankle's frame: rings in the x-y plane from the heel to the
  // toes, flat on the sole, turned out a little the way a standing foot is
  /** [z, half width, top, shift toward the big toe, v down the digits cell] */
  const foot: number[][] = [
    [0.062, 0, -0.045, 0, 0.05],
    [0.05, 0.022, -0.02, 0, 0.05],
    [0.02, 0.03, 0.012, 0, 0.05],
    [-0.02, 0.032, 0.005, 0, 0.05],
    [-0.06, 0.037, -0.022, 0.002, 0.05],
    [-0.105, 0.045, -0.046, 0.004, 0.3],
    [-0.145, 0.046, -0.058, 0.007, 0.62],
    [-0.175, 0.04, -0.064, 0.011, 0.92],
    [-0.19, 0, -0.07, 0.014, 1],
  ]
  if (q.low) foot.splice(3, 1)
  const around = q.low ? 6 : 8
  const turn = s * 0.14
  const ct = Math.cos(turn)
  const sn = Math.sin(turn)
  S.surface(
    foot.length - 1,
    around,
    (r, c, v) => {
      const [z, hw, top, toe, vt] = foot[r]
      const b = (c / around) * TAU
      const cb = Math.cos(b)
      const sb = Math.sin(b)
      const bottom = -ANKLE
      const mid = bottom + 0.42 * (top - bottom)
      const x = -s * toe + hw * cb
      const y = hw === 0 ? top : sb >= 0 ? mid + (top - mid) * sb ** 0.9 : mid + (bottom - mid) * (-sb) ** 0.45
      v.at(x * ct - z * sn, y, x * sn + z * ct)
      const sole = smooth(0.35, 0.8, -sb)
      skinAt(v, st, 1 - 0.1 * sole)
      v.r = mix(v.r, st.palm.r * 0.85, sole)
      v.g = mix(v.g, st.palm.g * 0.85, sole)
      v.b = mix(v.b, st.palm.b * 0.85, sole)
      // Toes: the creases, on top only, the big toe on the inside
      const across = clamp(0.5 + (s * cb) / 2, 0.04, 0.96)
      v.tex((CELL + across * CELL) / ATLAS_W, tv('digits', sb > 0.2 ? vt : 0.05))
      v.bone(ankle)
    },
    { ox, oy: ANKLE, oz: 0 },
  )
}

// —— the head ———————————————————————————————————————————————————————

/**
 * The skull as rings, in the head's own frame (origin where it sits on the
 * neck, face toward -z): [y, half width, depth in front, depth behind, z centre].
 * The face is cut into this by `headPoint`.
 */
const HEAD_PROFILE: readonly Sec[] = [
  [-0.052, 0, 0, 0, -0.062],
  [-0.044, 0.03, 0.026, 0.028, -0.06],
  [-0.032, 0.045, 0.04, 0.045, -0.05],
  [-0.018, 0.056, 0.052, 0.052, -0.04],
  [-0.006, 0.063, 0.061, 0.062, -0.032],
  [0.004, 0.066, 0.067, 0.068, -0.027],
  [0.016, 0.069, 0.073, 0.074, -0.023],
  [0.028, 0.071, 0.079, 0.08, -0.019],
  [0.042, 0.073, 0.084, 0.085, -0.015],
  [0.056, 0.0745, 0.088, 0.089, -0.012],
  [0.068, 0.0755, 0.09, 0.091, -0.01],
  [0.078, 0.0765, 0.091, 0.093, -0.009],
  [0.088, 0.0775, 0.092, 0.094, -0.008],
  [0.098, 0.078, 0.093, 0.096, -0.008],
  [0.11, 0.0785, 0.092, 0.097, -0.007],
  [0.126, 0.078, 0.089, 0.098, -0.005],
  [0.145, 0.075, 0.083, 0.095, -0.002],
  [0.165, 0.068, 0.072, 0.086, 0],
  [0.184, 0.053, 0.055, 0.068, 0.002],
  [0.198, 0.03, 0.031, 0.04, 0.003],
  [0.2055, 0, 0, 0, 0.004],
]
/** Rings the low-power head does without. */
const HEAD_LOW_DROP: readonly number[] = [1, 6, 8, 14, 18]
const HEAD_TOP = 0.2055

const _prof = [0, 0, 0, 0, 0, 0]

/** How deep the eye socket is cut at a point on the front of the head (0..1). */
function socketAt(ax: number, y: number) {
  // Cut further above the eye than below it: the cheek comes up to the lower lid
  const tall = y > EYE_Y ? 0.0135 : 0.0085
  return Math.exp(-(((ax - EYE_X) / 0.023) ** 4 + ((y - EYE_Y) / tall) ** 4))
}

/**
 * A point on the head's surface, `phi` radians round from the front (toward
 * the figure's right) at height y: the skull's ring there, then the face
 * pressed into and raised out of it (sockets, brow ridge, cheekbones, the
 * mouth's swell, the chin, the temples).
 */
function headPoint(fc: Face, phi: number, y: number, out: THREE.Vector3) {
  secAt(HEAD_PROFILE, y, _prof)
  const w = Math.max(1e-4, _prof[1] * mix(1, fc.jaw, smooth(0.045, -0.012, y)))
  const sn = Math.sin(phi)
  const cs = Math.cos(phi)
  const dep = Math.max(1e-4, cs > 0 ? _prof[2] : _prof[3])
  const r = 1 / Math.sqrt((sn * sn) / (w * w) + (cs * cs) / (dep * dep))
  const x0 = r * sn
  const ax = Math.abs(x0)
  const front = Math.max(0, cs)
  let d = -0.014 * socketAt(ax, y) * front
  d += 0.0036 * fc.ridge * bell((y - 0.1) / 0.009) * smooth(0.25, 0.75, front)
  d += 0.0045 * fc.cheek * Math.exp(-(((ax - 0.05) / 0.02) ** 2 + ((y - 0.05) / 0.018) ** 2)) * front
  d -= 0.0045 * fc.age * Math.exp(-(((ax - 0.046) / 0.02) ** 2 + ((y - 0.016) / 0.02) ** 2)) * front
  if (cs > 0) {
    d += 0.005 * Math.exp(-((x0 / 0.03) ** 2 + ((y - 0.006) / 0.022) ** 2))
    d += 0.004 * fc.chin * Math.exp(-((x0 / 0.022) ** 2 + ((y + 0.032) / 0.014) ** 2))
  }
  d -= 0.0025 * Math.exp(-(((ax - 0.066) / 0.012) ** 2 + ((y - 0.105) / 0.02) ** 2))
  out.set((r + d) * sn, y, _prof[4] - (r + d) * cs)
  return out
}

/** The point of the face's surface at a given x and y, for whatever is laid on it. */
function facePoint(fc: Face, x: number, y: number, out: THREE.Vector3) {
  let phi = Math.asin(clamp(x / 0.095, -1, 1))
  for (let k = 0; k < 4; k++) {
    headPoint(fc, phi, y, out)
    phi += (x - out.x) / 0.09
  }
  return headPoint(fc, phi, y, out)
}

/** Where the head's own frame sits in the body, and this islander's proportions for it. */
function headOrigin(st: Style) {
  return { ox: 0, oy: Y_HEAD, oz: NECK_Z, sx: st.headScale[0], sy: st.headScale[1], sz: st.headScale[2] }
}

function headColumns(q: Detail) {
  const phis: number[] = []
  for (let i = q.headHalf.length - 1; i > 0; i--) phis.push(-q.headHalf[i])
  for (const d of q.headHalf) phis.push(d)
  return phis
}

function buildHead(S: Sculpt, st: Style, q: Detail) {
  const fc = st.face
  const p = new THREE.Vector3()
  const O = headOrigin(st)
  const inBody = (x: number, y: number, z: number): [number, number, number] => [x * O.sx, y * O.sy + Y_HEAD, z * O.sz + NECK_Z]
  const skullMid = inBody(0, 0.08, -0.01)
  const phis = headColumns(q)
  const cols = phis.length - 1
  const ys = HEAD_PROFILE.map((s) => s[0]).filter((_, i) => !q.low || !HEAD_LOW_DROP.includes(i))
  const rows = ys.length - 1

  // —— the skull and the face cut into it ——
  S.surface(
    rows,
    cols,
    (r, c, v) => {
      const y = ys[r]
      const deg = phis[c]
      if (r === 0 || r === rows) {
        secAt(HEAD_PROFILE, y, _prof)
        v.at(0, y, _prof[4])
      } else {
        headPoint(fc, deg * DEG, y, p)
        v.at(p.x, p.y, p.z)
      }
      const ax = Math.abs(v.x)
      const front = Math.max(0, Math.cos(deg * DEG))
      // Shade in the sockets and under the brow, under the jaw, in an old man's cheeks
      let shade = 1 - 0.22 * socketAt(ax, y) * front
      shade *= 1 - 0.1 * bell((y - 0.09) / 0.007) * bell((ax - EYE_X) / 0.03) * smooth(0.3, 0.8, front)
      shade *= mix(0.8, 1, smooth(-0.05, -0.022, y))
      shade *= 1 - 0.12 * fc.age * Math.exp(-(((ax - 0.046) / 0.02) ** 2 + ((y - 0.016) / 0.02) ** 2)) * front
      // Blood nearer the surface in the cheeks and round the nose
      const warm =
        0.6 * Math.exp(-(((ax - 0.045) / 0.022) ** 2 + ((y - 0.04) / 0.02) ** 2)) * front +
        0.3 * Math.exp(-((ax / 0.02) ** 2 + ((y - 0.035) / 0.02) ** 2)) * front
      skinAt(v, st, shade, warm)
      const jaw = 0.95 * smooth(0.002, -0.016, y) * smooth(82, 50, Math.abs(deg))
      if (jaw > 0.001) v.bones(B.head, B.jaw, jaw)
      else v.bone(B.head)
    },
    {
      ...O,
      inside: skullMid,
      // Whatever the hair covers is never seen
      skip: (r, c) => ys[r] > curveAt(st.hairLine, phis[c]) + 0.016 && ys[r] > curveAt(st.hairLine, phis[c + 1]) + 0.016,
    },
  )

  // —— eyes: a ball in each socket, and lids that close over it ——
  for (let i = 0; i < 2; i++) {
    const s = SIDES[i]
    const ex = s * EYE_X
    const re = 0.0165 * fc.eye
    // The lids are flat facets on a round ball: they stand far enough off it,
    // and are cut finely enough, that no corner of the ball comes through one
    const rl = re + 0.0017
    const inside = inBody(ex, EYE_Y, EYE_Z)
    const polar = q.low ? [0, 16, 34, 62] : [0, 12, 24, 40, 62]
    /** The ball draws in a little toward its rim, which the lids always cover. */
    const rim = q.low ? [1, 1, 0.985, 0.92] : [1, 1, 1, 0.98, 0.92]
    // The ball's rim must stay inside the eye's cell of the atlas
    const k = 0.53
    S.surface(
      polar.length - 1,
      q.eye,
      (r, c, v) => {
        const pa = polar[r] * DEG
        const qa = (c / q.eye) * TAU
        const dx = Math.sin(pa) * Math.cos(qa)
        const dy = Math.sin(pa) * Math.sin(qa)
        const rad = re * rim[r]
        v.at(ex + rad * dx, EYE_Y + rad * dy, EYE_Z - rad * Math.cos(pa))
        // The lid's own shadow across the top of the eye
        v.grey(0.88 - 0.18 * Math.max(0, dy))
        v.tex((CELL / 2 + dx * k * CELL) / ATLAS_W, (ROW.eye.y + CELL / 2 - dy * k * CELL) / ATLAS_H)
        v.bone(i === 0 ? B.eyeR : B.eyeL)
      },
      { ...O, inside },
    )
    // Lids are slices of a slightly larger ball, hinged on the line through
    // the eye's two corners, so the open eye is an almond and a blink is one turn
    const seg = q.lid
    const corner = 52 * DEG
    const lid = (u: number, th: number, rad: number, v: Vert) => {
      const al = u * corner
      v.at(ex + rad * Math.sin(al), EYE_Y + rad * Math.cos(al) * Math.sin(th), EYE_Z - rad * Math.cos(al) * Math.cos(th))
    }
    S.surface(
      4,
      seg,
      (r, c, v) => {
        const u = (c / seg) * 2 - 1
        const margin = fc.lidOpen * (1 - u * u) ** 0.6
        const th = r === 0 ? margin : r === 1 ? margin + 7 : r === 2 ? margin + 32 : r === 3 ? 82 : 132
        lid(u, th * DEG, rl + (r === 0 ? 0.0008 : 0), v)
        // The lash line, then the lid
        if (r === 0) v.rgb(st.brow, 0.5)
        else skinAt(v, st, r === 1 ? 0.78 : 0.88)
        v.bone(B.lids)
      },
      { ...O, inside },
    )
    S.surface(
      3,
      seg,
      (r, c, v) => {
        const u = (c / seg) * 2 - 1
        const margin = -fc.lidOpen * 1.3 * (1 - u * u) ** 0.6
        lid(u, (r === 0 ? margin : r === 1 ? margin - 26 : r === 2 ? -72 : -128) * DEG, rl, v)
        skinAt(v, st, r === 0 ? 0.8 : 0.97, r === 0 ? 0.5 : 0.1)
        v.bone(B.head)
      },
      { ...O, inside },
    )
  }

  // —— nose ——
  /** [y, half width, how far the ridge stands off the face] */
  const nose = [
    [0.09, 0.0065, 0.0005],
    [0.066, 0.0105 * fc.noseW, 0.0065 * fc.bridge],
    [0.045, 0.014 * fc.noseW, 0.0155 * fc.noseL * (0.7 + 0.3 * fc.bridge)],
    [0.033, 0.0178 * fc.noseW, 0.0205 * fc.noseL],
    [0.025, 0.0195 * fc.noseW, 0.016 * fc.noseL],
    [0.019, 0.011 * fc.noseW, 0.004],
  ]
  const across = [-1, -0.55, 0, 0.55, 1]
  S.surface(
    nose.length - 1,
    across.length - 1,
    (r, c, v) => {
      const [y, hw, off] = nose[r]
      const t = across[c]
      const x = t * hw
      facePoint(fc, x, y, p)
      const edge = Math.abs(t) === 1
      v.at(x, y, p.z - off * (1 - Math.abs(t) ** 1.7) + (edge ? 0.0015 : 0))
      // Nostrils: the underside, either side of the middle
      const nostril = r === 5 && !edge && t !== 0
      skinAt(v, st, nostril ? 0.34 : r === 5 ? 0.78 : 1, r >= 2 && r <= 4 ? 0.45 : 0.15)
      v.bone(B.head)
    },
    { ...O, inside: inBody(0, 0.05, -0.075) },
  )

  // —— mouth: two lips with the dark between them, and teeth for a laugh ——
  const my = 0.004
  const hwm = 0.0245 * fc.lipW
  const us = q.low ? [-1, -0.5, 0, 0.5, 1] : [-1, -0.66, -0.33, 0, 0.33, 0.66, 1]
  const full = fc.lipFull
  for (const upper of [true, false]) {
    S.surface(
      2,
      us.length - 1,
      (r, c, v) => {
        const u = us[c]
        const x = u * hwm
        const e = 1 - u * u
        const cy = my + fc.smile * 0.0035 * u * u
        let y: number
        let out: number
        if (upper) {
          if (r === 0) {
            y = cy + full * 0.0078 * e ** 0.55 - 0.0018 * bell(u / 0.22)
            out = 0.0008
          } else if (r === 1) {
            y = cy + full * 0.0038 * e ** 0.6
            out = 0.0005 + 0.0042 * full * e ** 0.5
          } else {
            y = cy
            out = -0.0015
          }
        } else if (r === 0) {
          y = cy - 0.0004
          out = -0.0015
        } else if (r === 1) {
          y = cy - full * 0.0045 * e ** 0.6
          out = 0.0005 + 0.0052 * full * e ** 0.5
        } else {
          y = cy - full * 0.0105 * e ** 0.6
          out = 0.0008
        }
        if (e === 0) {
          y = cy
          out = 0
        }
        facePoint(fc, x, y, p)
        v.at(x, y, p.z - out)
        // The upper lip faces down and sits darker; the lower catches the light
        v.rgb(st.lip, upper ? (r === 2 ? 0.55 : 0.86) : r === 0 ? 0.55 : r === 1 ? 1.1 : 0.94)
        if (upper) v.bone(B.head)
        else v.bones(B.head, B.jaw, 0.9 * (1 - 0.45 * u * u))
      },
      { ...O, inside: inBody(0, my, -0.06) },
    )
  }
  facePoint(fc, 0, my, p)
  const mz = p.z
  S.surface(
    1,
    1,
    (r, c, v) => {
      v.at((c * 2 - 1) * hwm * 0.82, r === 0 ? my + 0.007 : my - 0.014, mz + 0.0078)
      v.r = 0.07
      v.g = 0.03
      v.b = 0.03
      if (r === 0) v.bone(B.head)
      else v.bones(B.head, B.jaw, 0.9)
    },
    { ...O, inside: inBody(0, my, -0.04) },
  )
  S.surface(
    1,
    2,
    (r, c, v) => {
      v.at((c - 1) * hwm * 0.62, r === 0 ? my + 0.004 : my - 0.0035, mz + 0.0048 + Math.abs(c - 1) * 0.003)
      v.r = 0.72
      v.g = 0.68
      v.b = 0.6
      v.bone(B.head)
    },
    { ...O, inside: inBody(0, my, -0.04) },
  )

  // —— brows, each on its own bone ——
  for (let i = 0; i < 2; i++) {
    const s = SIDES[i]
    const ts = q.low ? [0, 0.35, 0.7, 1] : [0, 0.25, 0.5, 0.75, 1]
    S.surface(
      2,
      ts.length - 1,
      (r, c, v) => {
        const t = ts[c]
        const x = s * mix(0.0105, 0.0545, t)
        const yc = BROW_Y + fc.browArch * 0.0042 * Math.sin(Math.PI * t ** 0.8) - fc.browTilt * 0.0038 * (1 - t) - 0.0032 * t * t
        const h = fc.browThick * mix(0.0064, 0.0024, t ** 1.2) * (t === 0 ? 0.7 : 1)
        const y = yc + (r - 1) * h * 0.5
        facePoint(fc, x, y, p)
        v.at(x, y, p.z - (r === 1 ? 0.0032 : 0.0004))
        v.rgb(st.brow, r === 1 ? 1 : 0.82)
        v.bone(i === 0 ? B.browR : B.browL)
      },
      { ...O, inside: inBody(s * EYE_X, BROW_Y, -0.07) },
    )
  }

  // —— ears: a rim standing off the head, a hollow inside it ——
  for (let i = 0; i < 2; i++) {
    const s = SIDES[i]
    headPoint(fc, s * 97 * DEG, 0.05, p)
    const cx = p.x - s * 0.003
    const cz = p.z + 0.004
    const n = q.low ? 6 : 8
    /** [size, stand-off, shade] from where it joins the head, over the rim, into the hollow */
    const rings = [
      [0.6, 0, 0.95],
      [1, 1, 1],
      [0.55, 0.7, 0.68],
      [0, 0.45, 0.5],
    ]
    S.surface(
      3,
      n,
      (r, c, v) => {
        const [k, outK, shade] = rings[r]
        // Half a step round, so the top of the ear is an edge and not a point
        const qa = ((c + 0.5) / n) * TAU
        const up = Math.sin(qa)
        const back = Math.cos(qa)
        const out = (0.0075 + 0.0055 * back) * outK * fc.ear
        // The lobe is narrower than the top, and the whole ear leans back a little
        const wide = 0.0155 * (1 + 0.18 * up)
        v.at(cx + s * out, 0.052 + 0.029 * fc.ear * up * k, cz + (wide * back * k + 0.005 * outK + 0.004 * up * k) * fc.ear)
        skinAt(v, st, shade, 0.35)
        v.bone(B.head)
      },
      { ...O, inside: inBody(cx + s * 0.004, 0.052, cz + 0.003) },
    )
  }

  // —— hair: a shell over the scalp with its own edge, so the hairline is a line ——
  const T = q.hairT
  S.surface(
    T.length - 1,
    cols,
    (r, c, v) => {
      const t = T[r]
      const deg = phis[c]
      if (r === T.length - 1) {
        secAt(HEAD_PROFILE, HEAD_TOP, _prof)
        v.at(0, HEAD_TOP + st.hairThick(0, 1), _prof[4])
      } else {
        const line = curveAt(st.hairLine, deg)
        headPoint(fc, deg * DEG, mix(line - 0.004, HEAD_TOP, t ** 0.9), p)
        const th = r === 0 ? -0.0015 : st.hairThick(deg, t)
        const nx = p.x
        const ny = p.y - 0.085
        const nz = p.z + 0.005
        const len = Math.hypot(nx, ny, nz) || 1
        v.at(p.x + (nx / len) * th, p.y + (ny / len) * th, p.z + (nz / len) * th)
      }
      v.rgb(st.hair, 0.8 + 0.2 * smooth(0, 0.3, t))
      v.tex((deg / 360 + 0.5) * st.hairTiles, tv(st.hairRow, t))
      v.bone(B.head)
    },
    { ...O, inside: skullMid },
  )

  if (st.beard) {
    // —— a full white beard: along the jaw, over the chin, rounded off a little below it ——
    const sub = phis.filter((d) => Math.abs(d) <= 80)
    const top: Curve = [[0, -0.011], [12, -0.0105], [22, -0.004], [30, 0.006], [45, 0.02], [62, 0.038], [80, 0.056]]
    const down = [0, 0.2, 0.5, 0.8, 1, 1]
    S.surface(
      5,
      sub.length - 1,
      (r, c, v) => {
        const deg = sub[c]
        const a = Math.abs(deg)
        const yTop = curveAt(top, deg)
        // Down to the edge of the jaw all the way back to the ear, and below it at the chin
        const yBot = mix(-0.07, -0.028, smooth(30, 85, a))
        const t = down[r]
        const y = mix(yTop, yBot, t)
        // Below the chin there is no jaw to follow: the beard keeps the jaw's outline and draws in
        headPoint(fc, deg * DEG, Math.max(y, -0.03), p)
        const taper = mix(1, 0.6, smooth(-0.03, -0.07, y))
        const th = r === 0 ? -0.0015 : 0.004 + 0.012 * Math.sin(Math.PI * Math.min(t, 0.9) ** 0.75)
        let x = (p.x + Math.sin(deg * DEG) * th) * taper
        let z = -0.045 + (p.z - Math.cos(deg * DEG) * th + 0.045) * taper
        let yy = y
        if (r === 5) {
          // Turned back under the chin to close it
          x *= 0.5
          z = z * 0.5 - 0.016
          yy = y + 0.012
        }
        v.at(x, yy, z)
        v.rgb(st.hair, 0.74 + 0.26 * smooth(0, 0.35, t))
        v.tex((deg / 360 + 0.5) * 3, tv('hair', 0.15 + 0.8 * t))
        v.bones(B.head, B.jaw, 0.8 * smooth(0.15, 0.7, t) * smooth(80, 40, a))
      },
      { ...O, inside: inBody(0, -0.02, -0.05) },
    )
    // —— and a moustache over the upper lip, its ends running down into the beard ——
    const mus = [-1, -0.62, -0.28, 0, 0.28, 0.62, 1]
    S.surface(
      2,
      mus.length - 1,
      (r, c, v) => {
        const u = mus[c]
        const x = u * 0.034
        const yc = 0.0135 - 0.015 * u * u
        const h = mix(0.0095, 0.006, Math.abs(u))
        const y = yc + (1 - r) * h * 0.5
        facePoint(fc, x, y, p)
        v.at(x, y, p.z - (r === 1 ? 0.0065 : 0.001))
        v.rgb(st.hair, r === 1 ? 0.98 : 0.8)
        v.tex((u * 0.5 + 0.5) * 0.5, tv('hair', 0.3 + r * 0.25))
        v.bone(B.head)
      },
      { ...O, inside: inBody(0, 0.01, -0.06) },
    )
  }
}

// —— what each of them carries and wears —————————————————————————————

const col = (h: string) => new THREE.Color(h)
const _sec = [0, 0, 0, 0, 0, 0]
/** How square the trunk's rings are: cloth that follows it uses the same. */
const TRUNK_SQUARE = 2.35

type Origin = { ox: number; oy: number; oz: number }

/** The front of the trunk at a point: where a pendant or a tag lies. */
function torsoFront(torso: readonly Sec[], x: number, y: number) {
  secAt(torso, y, _sec)
  const k = clamp(Math.abs(x) / Math.max(_sec[1], 1e-4), 0, 1)
  return _sec[4] - _sec[2] * (1 - k ** TRUNK_SQUARE) ** (1 / TRUNK_SQUARE)
}

/**
 * A wrap round the hips, flared toward the hem. It hangs from the hips but
 * its lower part belongs to the thighs, each side to its own leg, so a stride
 * carries the cloth with it instead of walking through it. Closed underneath
 * by a dark inner face.
 */
function buildWrap(
  S: Sculpt,
  st: Style,
  q: Detail,
  torso: readonly Sec[],
  o: { row: RowName; tiles: number; flare: number; fold: number },
) {
  const sides = q.cloth
  const top = STAND_HIPS + 0.085
  const hemY = STAND_HIPS + st.wrapHem
  const n = q.low ? 4 : 6
  S.surface(n + 3, sides, (r, c, v) => {
    const a = (c / sides) * TAU
    const k = Math.min(r, n) / n
    const y = mix(top, hemY, k ** 1.25)
    // The trunk where there is one; below the hips, the hips' own width carried down
    secAt(torso, Math.max(y, 0.955), _sec)
    // ...and never narrower than the thighs it has to hang round
    if (y < 0.97) _sec[1] = Math.max(_sec[1], HIP_X * st.hipsW + 0.092 * st.girth * (1 + 0.06 * st.muscle))
    const hang = smooth(0.955, hemY, y)
    _sec[0] = y
    _sec[1] += 0.008 + o.flare * hang
    _sec[2] += 0.01 + o.flare * 0.9 * hang
    _sec[3] += 0.009 + o.flare * 0.8 * hang
    ringAt(_sec, a, v, 2.2)
    // Where the cloth's free edge laps over itself
    const lap = smooth(o.fold - 0.05, o.fold, a) * (1 - smooth(o.fold, o.fold + 2.4, a))
    v.x *= 1 + 0.045 * lap
    v.z *= 1 + 0.045 * lap
    if (r <= n) {
      const down = (top - y) / (top - hemY)
      v.grey((0.78 + 0.22 * smooth(0, 0.14, down)) * (0.96 + 0.07 * hash(c % sides, r, st.seed + 40)))
      v.tex((c / sides) * o.tiles, tv(o.row, down))
    } else {
      // Underneath: the hem again in shadow, then in and up to close it. It is
      // still cloth: seated, with the knees apart, this is what lies across the lap.
      const inward = r === n + 1 ? 1 : r === n + 2 ? 0.74 : 0
      v.x *= inward
      v.z *= inward
      v.y += r === n + 1 ? 0 : r === n + 2 ? 0.03 : 0.06
      v.grey(r === n + 1 ? 0.5 : 0.3)
      v.tex((c / sides) * o.tiles, tv(o.row, 0.5))
    }
    if (v.y > 0.99) {
      torsoWeights(v, v.y)
    } else {
      // The front goes with the thighs; the back mostly stays with the hips,
      // or sitting down would lift it off the seat
      const kk = 0.92 * smooth(0.955, Math.max(hemY, 0.79), v.y) * mix(1, 0.25, smooth(-0.03, 0.06, v.z))
      const right = clamp(0.5 + v.x / 0.14, 0, 1)
      v.bones3(B.hips, 1 - kk, B.hipR, kk * right, B.hipL, kk * (1 - right))
    }
  })
}

/** A plaited cord round the waist, over the top of the wrap. */
function buildBelt(S: Sculpt, q: Detail, torso: readonly Sec[], y: number, tint: THREE.Color, tiles: number) {
  const sides = q.cloth
  S.surface(2, sides, (r, c, v) => {
    const yy = y + (r - 1) * 0.013
    secAt(torso, yy, _sec)
    const grow = r === 1 ? 0.019 : 0.011
    _sec[1] += grow
    _sec[2] += grow
    _sec[3] += grow
    ringAt(_sec, (c / sides) * TAU, v, 2.2)
    v.rgb(tint)
    v.tex((c / sides) * tiles, tv('cord', r / 2))
    torsoWeights(v, yy)
  })
}

/** A band round a limb: an armlet of sennit, a bracelet of shell or seed. */
function buildBand(
  S: Sculpt,
  sides: number,
  o: Origin,
  y: number,
  half: number,
  rx: number,
  rz: number,
  bone: number,
  paint: (c: number, r: number, v: Vert) => void,
) {
  S.surface(
    2,
    sides,
    (r, c, v) => {
      const a = (c / sides) * TAU
      const grow = r === 1 ? 0.0065 : 0.001
      v.at(Math.cos(a) * (rx + grow), y + (r - 1) * half, Math.sin(a) * (rz + grow))
      paint(c, r, v)
      v.bone(bone)
    },
    o,
  )
}

/** A cord lying on the neck and chest, dipping at the front to whatever hangs from it. */
function buildNeckCord(S: Sculpt, q: Detail, torso: readonly Sec[], yBack: number, yFront: number, tint: THREE.Color) {
  const n = q.low ? 10 : 14
  S.surface(1, n, (r, c, v) => {
    const a = (c / n) * TAU
    const front = (1 - Math.sin(a)) / 2
    const y = mix(yBack, yFront, front ** 1.7) + (r === 0 ? 0.0035 : -0.0035)
    secAt(torso, y, _sec)
    _sec[1] += 0.004
    _sec[2] += 0.004
    _sec[3] += 0.004
    ringAt(_sec, a, v, TRUNK_SQUARE)
    v.rgb(tint)
    v.tex((c / n) * 3, tv('cord', r === 0 ? 0.2 : 0.8))
    torsoWeights(v, y)
  })
}

/**
 * A shaft held in a fist: it runs along the hand's local z through the grip
 * point, the head toward -z. `prof` is [distance from the grip toward the
 * head, radius]; `paint` colours each ring.
 */
function buildShaft(
  S: Sculpt,
  sides: number,
  o: Origin,
  bone: number,
  prof: readonly (readonly [number, number])[],
  row: RowName,
  paint: (along: number, ring: number, v: Vert) => void,
) {
  S.surface(
    prof.length - 1,
    sides,
    (r, c, v) => {
      const [along, rad] = prof[r]
      const a = (c / sides) * TAU
      v.at(Math.cos(a) * rad, GRIP_Y + Math.sin(a) * rad, -along)
      paint(along, r, v)
      v.tex(row === 'wood' ? along * 2.4 : (c / sides) * 2, row === 'wood' ? tv('wood', c / sides) : tv('cord', (along * 9) % 1))
      v.bone(bone)
    },
    o,
  )
}

/** Kael: woven pandanus wrap, sennit belt and armlets, a pearl-shell crescent at the throat, the spear. */
function dressKael(S: Sculpt, st: Style, q: Detail, torso: readonly Sec[], scale: number, toolHand: number) {
  buildWrap(S, st, q, torso, { row: 'weaveK', tiles: 2, flare: 0.055, fold: 3.5 })
  const sennit = col('#b39a68')
  buildBelt(S, q, torso, STAND_HIPS + 0.066, sennit, 2)

  for (let i = 0; i < 2; i++) {
    const s = SIDES[i]
    const o = { ox: s * SHOULDER_X * st.shoulders, oy: Y_SHOULDER, oz: SHOULDER_Z }
    buildBand(S, q.arm, o, -0.118, 0.016, 0.05 * st.girth, 0.05 * st.girth, i === 0 ? B.shoulderR : B.shoulderL, (c, r, v) => {
      v.rgb(sennit, 0.95)
      v.tex((c / q.arm) * 0.5, tv('cord', r / 2))
    })
  }

  // The crescent: pearl shell, horns up, on a cord
  buildNeckCord(S, q, torso, 1.474, 1.392, col('#6d5a3c'))
  const pearl = col('#efe6d0')
  const blush = col('#d9c2b4')
  const steps = q.low ? 5 : 7
  S.surface(
    2,
    steps - 1,
    (r, c, v) => {
      const t = (200 + (c / (steps - 1)) * 140) * DEG
      const rad = r === 0 ? 0.036 : r === 1 ? 0.029 : 0.022
      const cy = r === 2 ? 1.397 : 1.388
      const x = Math.cos(t) * rad
      const y = cy + Math.sin(t) * rad
      v.at(x, y, torsoFront(torso, x, y) - (r === 1 ? 0.008 : 0.0045))
      if (r === 2) v.rgb(blush, 0.9)
      else v.rgb(pearl, r === 0 ? 0.92 : 1)
      v.bone(B.chest)
    },
    { inside: [0, 1.39, 0] },
  )

  // The spear: 1.9 m in the world, so the lengths are divided by his scale
  const butt = 1.0 / scale
  const tip = 0.9 / scale
  const base = tip - 0.34
  const o = { ox: SIDES[toolHand] * SHOULDER_X * st.shoulders, oy: Y_WRIST, oz: SHOULDER_Z }
  const bone = toolHand === 0 ? B.wristR : B.wristL
  const wood = col('#8a5e3c')
  const hard = col('#3a261a')
  const carve = col('#b08e62')
  buildShaft(
    S,
    q.shaft,
    o,
    bone,
    [
      [-butt, 0],
      [-butt + 0.004, 0.011],
      [-butt + 0.02, 0.0145],
      [0, 0.0155],
      [base - 0.07, 0.0145],
      [base - 0.005, 0.0165],
      [base + 0.06, 0.0178],
      [base + 0.09, 0.0145],
      [base + 0.12, 0.0168],
      [base + 0.2, 0.012],
      [base + 0.29, 0.006],
      [tip, 0],
    ],
    'wood',
    (along, ring, v) => {
      // Carved rings on the collar, then the fire-hardened point
      if (along > base + 0.1) v.rgb(hard)
      else if (along > base - 0.01) v.rgb(ring % 2 === 0 ? carve : wood)
      else v.rgb(wood)
    },
  )
  const cord = col('#c0a877')
  for (const [from, to, rad] of [[-0.075, 0.075, 0.0185], [base - 0.068, base - 0.01, 0.0195]]) {
    buildShaft(S, q.shaft, o, bone, [[from, rad - 0.002], [from + 0.006, rad], [to - 0.006, rad], [to, rad - 0.002]], 'cord', (_a, _r, v) => {
      v.rgb(cord)
    })
  }
}

/** Tala: bark-cloth band, fine pandanus wrap, belt and net bag, hair tied up with a flower, the coaster's brass. */
function dressTala(S: Sculpt, brass: Sculpt, st: Style, q: Detail, torso: readonly Sec[]) {
  const fc = st.face
  const p = new THREE.Vector3()
  const HEAD_ORIGIN = headOrigin(st)
  const [hx, hy, hz] = st.headScale
  buildWrap(S, st, q, torso, { row: 'weaveT', tiles: 2, flare: 0.05, fold: 5.6 })
  buildBelt(S, q, torso, STAND_HIPS + 0.068, col('#d9c79a'), 2)

  // Net bag on the right hip, hanging from the belt
  /** [y from the hips, radius across, radius front to back] */
  const bag = [
    [0.06, 0.011, 0.011],
    [0.02, 0.03, 0.026],
    [-0.04, 0.047, 0.04],
    [-0.09, 0.043, 0.036],
    [-0.117, 0.024, 0.02],
    [-0.127, 0, 0],
  ]
  const around = q.low ? 6 : 8
  secAt(torso, STAND_HIPS, _sec)
  const bagX = _sec[1] + 0.036
  S.surface(
    bag.length - 1,
    around,
    (r, c, v) => {
      const [y, rx, rz] = bag[r]
      const a = (c / around) * TAU
      v.at(bagX + Math.cos(a) * rx - 0.02 * smooth(-0.02, 0.06, y), y, -0.025 + Math.sin(a) * rz)
      v.grey(0.95)
      v.tex((c / around) * 0.4, tv('net', r / (bag.length - 1)))
      v.bones(B.hips, B.hipR, 0.4 * smooth(0.02, -0.1, y))
    },
    { ox: 0, oy: STAND_HIPS, oz: 0 },
  )

  // Bark-cloth band round the chest, its edges turned in against the skin
  const ys = [1.27, 1.27, 1.302, 1.336, 1.37, 1.398, 1.398]
  S.surface(ys.length - 1, q.cloth, (r, c, v) => {
    const y = ys[r]
    const edge = r === 0 || r === ys.length - 1
    secAt(torso, y, _sec)
    const grow = edge ? -0.002 : 0.007
    _sec[1] += grow
    _sec[2] += grow
    _sec[3] += grow
    ringAt(_sec, (c / q.cloth) * TAU, v, TRUNK_SQUARE)
    v.grey(edge ? 0.6 : 0.97 + 0.05 * hash(c, r, 33))
    v.tex(c / q.cloth, tv('tapaT', 1 - (y - 1.27) / 0.128))
    torsoWeights(v, y)
  })

  // A cord round the neck, and the tag from the coaster on her breastbone
  buildNeckCord(S, q, torso, 1.474, 1.418, col('#7d6744'))
  brass.surface(
    1,
    1,
    (r, c, v) => {
      const x = (c * 2 - 1) * 0.014
      const y = 1.418 - r * 0.036
      v.at(x, y, torsoFront(torso, x, y) - 0.007)
      v.r = 0.66
      v.g = 0.5
      v.b = 0.26
      if (r === 1 && c === 0) {
        // Verdigris in one corner
        v.r = 0.34
        v.g = 0.42
        v.b = 0.33
      }
      v.bone(B.chest)
    },
    { inside: [0, 1.4, 0] },
  )

  // A bracelet of white shell on the left wrist
  const shell = col('#eee4cf')
  const o = { ox: -SHOULDER_X * st.shoulders, oy: Y_SHOULDER, oz: SHOULDER_Z }
  buildBand(S, q.arm, o, -0.522, 0.009, 0.029 * st.girth, 0.025 * st.girth, B.elbowL, (c, _r, v) => {
    v.rgb(shell, c % 2 === 0 ? 1 : 0.72)
  })

  // Hair tied up in a knot at the back of the crown
  const lat = q.low ? 3 : 4
  const lon = q.low ? 6 : 8
  S.surface(
    lat,
    lon,
    (r, c, v) => {
      const th = (r / lat) * Math.PI
      const ph = (c / lon) * TAU
      v.at(Math.sin(th) * Math.cos(ph) * 0.047, 0.203 + Math.cos(th) * 0.041, 0.052 + Math.sin(th) * Math.sin(ph) * 0.045)
      v.rgb(st.hair, 0.95)
      v.tex((c / lon) * 1.5 + r * 0.12, tv('hair', 0.1 + 0.8 * (r / lat)))
      v.bone(B.head)
    },
    HEAD_ORIGIN,
  )

  // A hibiscus tucked over her ear
  const petal = col('#d8432b')
  const petalTip = col('#f07a45')
  const heart = col('#f2c544')
  headPoint(fc, 78 * DEG, 0.104, p)
  const fx = p.x + 0.012
  const fy = p.y
  const fz = p.z
  // The plane the flower opens in: facing out and a little forward and up
  const n = new THREE.Vector3(1, 0.25, -0.45).normalize()
  const e1 = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize()
  const e2 = new THREE.Vector3().crossVectors(n, e1)
  S.surface(
    2,
    10,
    (r, c, v) => {
      const a = (c / 10) * TAU
      const rad = r === 0 ? 0 : r === 1 ? 0.012 : c % 2 === 0 ? 0.031 : 0.017
      const lift = r === 0 ? 0.007 : r === 1 ? 0.004 : c % 2 === 0 ? -0.003 : 0.002
      v.at(
        fx + (e1.x * Math.cos(a) + e2.x * Math.sin(a)) * rad + n.x * lift,
        fy + (e1.y * Math.cos(a) + e2.y * Math.sin(a)) * rad + n.y * lift,
        fz + (e1.z * Math.cos(a) + e2.z * Math.sin(a)) * rad + n.z * lift,
      )
      if (r === 0) v.rgb(heart)
      else if (r === 1) v.rgb(petal, 0.9)
      else v.rgb(c % 2 === 0 ? petalTip : petal)
      v.bone(B.head)
    },
    { ...HEAD_ORIGIN, inside: [(fx - n.x * 0.03) * hx, (fy - n.y * 0.03) * hy + Y_HEAD, (fz - n.z * 0.03) * hz + NECK_Z] },
  )

  // Goggles pushed up on the forehead: a leather strap round the head, two brass rims
  const phis = headColumns(q)
  const leather = col('#4a3020')
  const rimBrass = col('#a8823c')
  const rimGreen = col('#5c6b52')
  const rimRust = col('#6b3d1f')
  S.surface(
    1,
    phis.length - 1,
    (r, c, v) => {
      const deg = phis[c]
      const y = mix(0.143, 0.105, (1 - Math.cos(deg * DEG)) / 2) + (r === 0 ? 0.0065 : -0.0065)
      headPoint(fc, deg * DEG, y, p)
      const over = y > curveAt(st.hairLine, deg) ? st.hairThick(deg, 0.5) : 0
      const out = 0.004 + over
      v.at(p.x + Math.sin(deg * DEG) * out, y, p.z - Math.cos(deg * DEG) * out)
      v.rgb(leather, r === 0 ? 1 : 0.8)
      v.bone(B.head)
    },
    { ...HEAD_ORIGIN, inside: [0, Y_HEAD + 0.1, NECK_Z] },
  )
  for (const s of SIDES) {
    facePoint(fc, s * 0.031, 0.144, p)
    const cx = p.x
    const cy = p.y
    const cz = p.z - 0.004
    // The rim's axis: forward, tipped up, toed out a little
    const ax = new THREE.Vector3(s * 0.18, 0.5, -1).normalize()
    const u1 = new THREE.Vector3(1, 0, 0).addScaledVector(ax, -ax.x).normalize()
    const u2 = new THREE.Vector3().crossVectors(ax, u1)
    const inside: [number, number, number] = [cx * hx, cy * hy + Y_HEAD, cz * hz + NECK_Z]
    brass.surface(
      3,
      8,
      (r, c, v) => {
        const a = (c / 8) * TAU
        // Out along the rim, over its lip, then in across the glass
        const rad = r === 0 ? 0.021 : r === 1 ? 0.019 : r === 2 ? 0.0155 : 0
        const along = r === 0 ? 0 : r === 1 ? 0.014 : 0.012
        v.at(
          cx + (u1.x * Math.cos(a) + u2.x * Math.sin(a)) * rad + ax.x * along,
          cy + (u1.y * Math.cos(a) + u2.y * Math.sin(a)) * rad + ax.y * along,
          cz + (u1.z * Math.cos(a) + u2.z * Math.sin(a)) * rad + ax.z * along,
        )
        if (r >= 2) {
          v.r = 0.07
          v.g = 0.1
          v.b = 0.1
        } else {
          // Brass gone green and brown in patches
          const h = hash(c, r, s + 3)
          v.rgb(h < 0.55 ? rimBrass : h < 0.8 ? rimGreen : rimRust)
        }
        v.bone(B.head)
      },
      { ...HEAD_ORIGIN, inside },
    )
  }
}

/** Oru: a mantle of shell and seed over the shoulders, a printed bark-cloth wrap to the knee, the staff. */
function dressOru(S: Sculpt, st: Style, q: Detail, torso: readonly Sec[], scale: number, toolHand: number) {
  buildWrap(S, st, q, torso, { row: 'tapaO', tiles: 1, flare: 0.06, fold: 3.5 })
  buildBelt(S, q, torso, STAND_HIPS + 0.068, col('#8a7450'), 2)

  // The mantle lies on the shoulders and hangs clear of the chest; where it
  // covers an arm it belongs partly to that arm, so it lifts when the arm does
  const X = SHOULDER_X * st.shoulders
  const R = 0.058 * st.girth
  const sides = q.low ? 14 : 18
  const secs: Sec[] = [
    [1.502, 0.07, 0.06, 0.066, 0.012],
    [1.49, 0.115, 0.072, 0.078, 0.01],
    [1.476, X + 0.036, 0.088, 0.09, 0.008],
    [1.452, X + R + 0.004, 0.102, 0.1, 0.006],
    [1.418, X + R + 0.012, 0.114, 0.109, 0.005],
    [1.368, X + R + 0.018, 0.122, 0.115, 0.004],
    [1.315, X + R + 0.018, 0.127, 0.119, 0.004],
  ]
  const n = secs.length - 1
  S.surface(n + 2, sides, (r, c, v) => {
    const s = secs[Math.min(r, n)]
    ringAt(s, (c / sides) * TAU, v, 2.6)
    if (r <= n) {
      v.grey(0.94 + 0.08 * hash(c, r, 61))
      v.tex((c / sides) * 2, tv('mantle', r / n))
    } else {
      const inward = r === n + 1 ? 1 : 0.7
      v.x *= inward
      v.z *= inward
      v.y += r === n + 1 ? 0 : 0.02
      v.grey(0.32)
      v.tex((c / sides) * 2, tv('mantle', 0.02))
    }
    const arm = smooth(0.11, 0.2, Math.abs(v.x)) * smooth(1.5, 1.45, v.y)
    v.bones(B.chest, v.x > 0 ? B.shoulderR : B.shoulderL, arm)
  })

  // A bracelet of red seeds on the free wrist
  const seed = col('#84401f')
  const free = 1 - toolHand
  const fo = { ox: SIDES[free] * SHOULDER_X * st.shoulders, oy: Y_SHOULDER, oz: SHOULDER_Z }
  buildBand(S, q.arm, fo, -0.522, 0.009, 0.029 * st.girth, 0.025 * st.girth, free === 0 ? B.elbowR : B.elbowL, (c, _r, v) => {
    v.rgb(seed, c % 2 === 0 ? 1.15 : 0.7)
  })

  // The staff: 1.8 m in the world, held about 0.9 m up so its foot finds the ground
  const butt = 0.9 / scale
  const tip = 0.9 / scale
  const k = tip - 0.2
  const o = { ox: SIDES[toolHand] * SHOULDER_X * st.shoulders, oy: Y_WRIST, oz: SHOULDER_Z }
  const bone = toolHand === 0 ? B.wristR : B.wristL
  const wood = col('#9a7048')
  const dark = col('#553a24')
  const pale = col('#c09a68')
  buildShaft(
    S,
    q.shaft,
    o,
    bone,
    [
      [-butt, 0],
      [-butt + 0.004, 0.012],
      [-butt + 0.02, 0.016],
      [0, 0.017],
      [k - 0.06, 0.016],
      [k - 0.01, 0.019],
      [k + 0.02, 0.024],
      [k + 0.07, 0.034],
      [k + 0.1, 0.027],
      [k + 0.14, 0.035],
      [k + 0.18, 0.022],
      [tip, 0],
    ],
    'wood',
    (along, ring, v) => {
      // The carved head: dark in the cuts, pale on the ridges
      if (along > k) v.rgb(ring % 2 === 0 ? dark : pale)
      else v.rgb(wood)
    },
  )
  buildShaft(S, q.shaft, o, bone, [[k - 0.056, 0.019], [k - 0.05, 0.0215], [k - 0.014, 0.0215], [k - 0.008, 0.019]], 'cord', (_a, _r, v) => {
    v.rgb(col('#b9a070'))
  })
}

// —— poses ————————————————————————————————————————————————————————

/**
 * Every pose is one vector of these. "t" is the arm on the tool side (the hand
 * that holds the spear or the staff; the right arm for Tala), "f" the free arm.
 * Angles in radians, distances in reference metres. `Curl` closes the
 * fingers of an open hand. The last four are the face: brows raised, brows
 * drawn down and together, eyes narrowed, jaw open.
 */
const KEYS = [
  'drop', 'hipZ', 'hipX', 'hipRoll', 'spine', 'chest', 'chestYaw', 'neck', 'head', 'tilt',
  'tFlex', 'tAbd', 'tTwist', 'tElbow', 'tWrist', 'tPalm',
  'fFlex', 'fAbd', 'fTwist', 'fElbow', 'fWrist', 'fPalm',
  'tFoot', 'fFoot', 'stance', 'sit',
  'toolX', 'toolY', 'toolZ', 'grip', 'gripAt',
  'tCurl', 'fCurl',
  'brow', 'frown', 'squint', 'jaw',
] as const
type Key = (typeof KEYS)[number]
type PoseSpec = Partial<Record<Key, number>>
const K = Object.fromEntries(KEYS.map((k, i) => [k, i])) as Record<Key, number>
const NP = KEYS.length

const BASE: PoseSpec = {
  // A standing knee is soft, not locked and not bent: a few millimetres of drop is ten degrees of knee
  drop: 0.003, spine: -0.02, chest: 0.03, neck: 0.02, head: -0.05,
  tFlex: 0.06, tAbd: 0.1, tElbow: 0.18, fFlex: 0.06, fAbd: 0.1, fElbow: 0.18,
  tFoot: 0.03, fFoot: -0.03, stance: 0.03,
  toolX: 0.04, toolY: 1, toolZ: -0.1, gripAt: 0.6,
  // A hanging hand is never flat: the fingers rest half closed
  tCurl: 0.5, fCurl: 0.5,
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
      frown: 0.7, squint: 0.3,
    },
    tool: { ...HOLD, toolZ: -0.26 },
  },
  warn_spear_raise: {
    all: {
      drop: 0.045, hipZ: 0.05, spine: 0.07, chest: -0.02, neck: -0.03, head: 0.02,
      tFoot: 0.17, fFoot: -0.14, stance: 0.07,
      frown: 1, squint: 0.1, jaw: 0.3,
    },
    // The spear held crosswise above the head in both hands
    tool: {
      tFlex: -0.15, tAbd: 2.35, tTwist: -1.45, tElbow: 1.35,
      fFlex: -0.15, fAbd: 2.35, fTwist: -1.45, fElbow: 1.35,
      toolX: -1, toolY: 0.06, toolZ: 0.02, grip: 1, gripAt: 0.72, fCurl: 1.45,
    },
    // Without a spear it is both palms up and out: stop there
    bare: {
      tFlex: 1.25, tAbd: 0.35, tElbow: 1.2, tPalm: -1.2, fFlex: 1.25, fAbd: 0.35, fElbow: 1.2, fPalm: -1.2,
      tCurl: 0.05, fCurl: 0.05,
    },
  },
  stalk: {
    all: {
      drop: 0.2, hipZ: 0.02, spine: -0.42, chest: -0.12, neck: 0.24, head: 0.26,
      tFoot: 0.06, fFoot: -0.12, stance: 0.06,
      fFlex: 0.5, fAbd: 0.12, fElbow: 0.6,
      frown: 0.9, squint: 0.35,
    },
    // Angled across the body so the other hand can take it
    tool: { tFlex: 0.3, tAbd: 0.1, tElbow: 0.95, toolX: -0.42, toolY: 0.25, toolZ: -1, grip: 1, gripAt: 0.75, fCurl: 1.45 },
    bare: { tFlex: 0.5, tAbd: 0.12, tElbow: 0.6 },
  },
  charge_attack: {
    all: { drop: 0.06, spine: -0.36, chest: -0.1, neck: 0.18, head: 0.24, frown: 1, jaw: 0.55 },
    // Couched under the arm, level and forward; the other arm pumps with the run
    tool: { tFlex: -0.25, tAbd: 0.2, tElbow: 1.35, toolX: -0.05, toolY: 0.03, toolZ: -1 },
  },
  curious_tilt: {
    all: {
      hipX: -0.02, hipRoll: -0.02, spine: -0.1, chest: -0.04, neck: -0.03, head: 0.06, tilt: 0.3,
      fFlex: 0.12, fElbow: 0.45, tFoot: -0.05, fFoot: 0.05,
      brow: 0.9, jaw: 0.06,
    },
    tool: HOLD,
  },
  beckon_follow: {
    all: { chestYaw: 0.12, head: 0.03, fFlex: 0.9, fAbd: 0.35, fElbow: 0.9, fPalm: 1.3, fCurl: 0.3, brow: 0.55, jaw: 0.1 },
    tool: HOLD,
  },
  accept_gift: {
    all: {
      drop: 0.025, spine: -0.18, chest: -0.08, neck: -0.1, head: -0.18,
      fFlex: 1.0, fAbd: 0.1, fElbow: 0.5, fPalm: 1.45,
      tFlex: 1.0, tAbd: 0.1, tElbow: 0.5, tPalm: 1.45,
      tCurl: 0.15, fCurl: 0.15,
      brow: 0.4, squint: 0.12,
    },
    tool: HOLD,
  },
  laugh_baffled: {
    // Head back, a hand across the belly
    all: {
      neck: 0.12, head: 0.24, spine: 0.04, chest: 0.06, fFlex: 0, fAbd: 0.05, fTwist: 0.9, fElbow: 1.3,
      brow: 0.7, squint: 0.8, jaw: 0.6,
    },
    tool: HOLD,
    bare: { tFlex: 0.3, tAbd: 0.3, tElbow: 0.6 },
  },
  sit_fire: {
    all: {
      sit: 1, spine: -0.18, chest: -0.06, neck: 0, head: -0.14,
      // Forearms up, palms to the fire
      fFlex: 0.7, fAbd: 0.15, fElbow: 1.8, fPalm: -1.45,
      tFlex: 0.7, tAbd: 0.15, tElbow: 1.8, tPalm: -1.45,
      tCurl: 0.2, fCurl: 0.2,
      squint: 0.15,
    },
    // A staff laid across the lap
    tool: { tFlex: 0.45, tAbd: 0.1, tElbow: 0.8, toolX: -1, toolY: 0.1, toolZ: -0.25 },
  },
}

/**
 * Each joint target is chased by a spring: how quick (1/s) and how damped
 * (1 never passes its target; lower passes it a little and comes back).
 * A change of pose so starts from rest, arrives a touch past and settles,
 * and the wrists and head arrive after the trunk has. Sitting down, the feet
 * and the grip on a shaft do not overshoot: a foot that did would slide.
 */
const OMEGA = new Float32Array(NP).fill(7.5)
const ZETA = new Float32Array(NP).fill(0.62)
function spring(keys: readonly Key[], omega: number, zeta: number) {
  for (const k of keys) {
    OMEGA[K[k]] = omega
    ZETA[K[k]] = zeta
  }
}
spring(['sit'], 4.2, 1)
spring(['drop', 'hipZ', 'hipX', 'hipRoll'], 6.5, 0.8)
spring(['spine', 'chest', 'chestYaw'], 7, 0.66)
spring(['neck', 'head', 'tilt'], 8.5, 0.58)
spring(['tWrist', 'tPalm', 'fWrist', 'fPalm'], 9, 0.55)
spring(['tFoot', 'fFoot', 'stance'], 6, 1)
spring(['toolX', 'toolY', 'toolZ'], 8, 0.85)
spring(['grip', 'gripAt'], 9, 1)
spring(['tCurl', 'fCurl'], 10, 0.7)
spring(['brow', 'frown', 'squint', 'jaw'], 13, 0.7)

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

/**
 * Read-out of the walk for the footstep sound. Written by `update` the frame a
 * foot plants (the instant its stance begins); nothing in the body reads it.
 */
export type IslanderGait = {
  /** Feet planted so far. Compare with the last value you saw. */
  steps: number
  /** Which foot planted last: 1 right, -1 left. */
  side: number
  /** 0..1 how much of a walk the legs were in when it landed. */
  weight: number
  /** 0..1 how much of a run. */
  run: number
  /** 0..1 how deep in water. */
  wade: number
  /** Ground speed at the plant, m/s. */
  speed: number
}

export type IslanderRig = {
  root: THREE.Group
  id: NpcId
  /** Footfalls, for the sound (src/tribe/tribe-sound.ts). */
  readonly gait: IslanderGait
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
  /** Carried in every pose, on top of it: a stoop, a set of the brow. */
  bias: PoseSpec
  /** Seconds between shifts of weight from one leg to the other, and how far the hips go with it. */
  shiftPeriod: number
  shiftAmount: number
  /** Seconds a breath takes. */
  breath: number
  /** How much the eyes and head wander when nothing holds them. */
  glance: number
}

function person(id: NpcId): Person {
  if (id === 'kael') {
    // The guard: tall, broad, still. Heavy brow, eyes a little narrowed, mouth set.
    return {
      height: 1.86,
      tool: 'spear',
      toolSide: 1,
      bias: { frown: 0.32, squint: 0.1 },
      shiftPeriod: 15,
      shiftAmount: 0.7,
      breath: 4.6,
      glance: 0.7,
      style: {
        skin: col('#8f5d3c'),
        palm: col('#c39472'),
        lip: col('#6e3d32'),
        hair: col('#2a211c'),
        brow: col('#17110e'),
        hairLine: [[0, 0.158], [25, 0.16], [45, 0.15], [60, 0.118], [72, 0.088], [84, 0.078], [96, 0.094], [110, 0.06], [135, 0.022], [180, 0.01]],
        // Thick, tight curls standing well off the head
        hairThick: (_deg, t) => 0.02 * smooth(0, 0.3, t) + 0.006 * Math.sin(Math.PI * t),
        hairRow: 'curl',
        hairTiles: 1,
        beard: false,
        girth: 0.98,
        shoulders: 1.08,
        hipsW: 0.97,
        waist: 0.98,
        bust: 0.004,
        belly: 0,
        neck: 1.1,
        muscle: 1,
        face: {
          jaw: 1.07, chin: 1.1, cheek: 1, ridge: 1.35, age: 0, eye: 0.97, lidOpen: 12,
          noseW: 1.08, noseL: 1, lipW: 1.06, lipFull: 1, smile: -0.35,
          browTilt: 0.9, browThick: 1.3, browArch: 0.4, ear: 1, bridge: 1,
        },
        headScale: [1.02, 1, 1],
        wrapHem: -0.285,
        seed: 1,
      },
    }
  }
  if (id === 'tala') {
    // Young, quick, curious: rounder face, wide eyes, arched brows, the start of a smile.
    return {
      height: 1.62,
      tool: null,
      toolSide: 1,
      bias: { brow: 0.25 },
      shiftPeriod: 7.5,
      shiftAmount: 1,
      breath: 3.6,
      glance: 1.3,
      style: {
        skin: col('#a8764d'),
        palm: col('#d3a781'),
        lip: col('#8e4a40'),
        hair: col('#2b1f18'),
        brow: col('#1e1510'),
        hairLine: [[0, 0.154], [25, 0.155], [45, 0.146], [60, 0.12], [72, 0.096], [84, 0.088], [96, 0.094], [110, 0.055], [135, 0.03], [180, 0.022]],
        // Drawn back tight to the knot
        hairThick: (_deg, t) => 0.0015 + 0.005 * smooth(0, 0.3, t),
        hairRow: 'hair',
        hairTiles: 2,
        beard: false,
        girth: 0.9,
        shoulders: 0.93,
        hipsW: 1.04,
        waist: 0.93,
        bust: 0.012,
        belly: 0,
        neck: 0.86,
        muscle: 0.25,
        face: {
          jaw: 0.9, chin: 1, cheek: 1.25, ridge: 0.5, age: 0, eye: 1.12, lidOpen: 17,
          noseW: 0.96, noseL: 0.76, lipW: 0.98, lipFull: 1.15, smile: 0.55,
          browTilt: -0.2, browThick: 0.75, browArch: 1.2, ear: 0.92, bridge: 0.45,
        },
        // A shorter, rounder face than the men's
        headScale: [1.03, 0.94, 1],
        wrapHem: -0.262,
        seed: 2,
      },
    }
  }
  // The elder: stooped a little, white-haired and bearded, the eyes creased as if at a joke.
  return {
    height: 1.7,
    tool: 'staff',
    toolSide: -1,
    bias: { spine: -0.1, chest: -0.12, neck: 0.13, head: 0.07, drop: 0.009, squint: 0.14, brow: 0.12 },
    shiftPeriod: 19,
    shiftAmount: 0.5,
    breath: 5.2,
    glance: 0.9,
    style: {
      skin: col('#8a5b40'),
      palm: col('#bf9070'),
      lip: col('#6b4036'),
      // Grey-white rather than paper-white: under a noon sun and the bloom whiter hair glowed
      hair: col('#d2ccc0'),
      brow: col('#a59e92'),
      // High at the front, where it has gone, and longer over the ears and the nape
      hairLine: [[0, 0.178], [25, 0.182], [45, 0.165], [60, 0.125], [75, 0.09], [95, 0.092], [112, 0.05], [140, 0.012], [180, 0]],
      hairThick: (deg, t) =>
        0.003 + (0.006 + 0.009 * smooth(55, 120, Math.abs(deg))) * smooth(0, 0.2, t) * (1 - 0.5 * smooth(0.55, 1, t)),
      hairRow: 'hair',
      hairTiles: 2,
      beard: true,
      girth: 0.92,
      shoulders: 0.97,
      hipsW: 0.98,
      waist: 1.04,
      bust: 0,
      belly: 0.012,
      neck: 0.95,
      muscle: 0.4,
      face: {
        jaw: 0.98, chin: 0.95, cheek: 1.1, ridge: 1, age: 1, eye: 0.94, lidOpen: 12,
        noseW: 1.1, noseL: 1.08, lipW: 1, lipFull: 0.85, smile: 0.8,
        browTilt: -0.5, browThick: 1.35, browArch: 1.1, ear: 1.15, bridge: 0.9,
      },
      headScale: [1, 1, 1],
      wrapHem: -0.4,
      seed: 3,
    },
  }
}

/** How far forward of the hip a foot lands, as a share of the ground it covers while planted. */
const LANDS_AHEAD = 0.44

/**
 * Build one islander. The rig is ready to add to a scene: every mesh is on
 * the detail layer (eye cameras draw it, the sky probe does not) and casts
 * and takes shadow through main's usual scan.
 */
export function buildIslander(id: NpcId, opts?: { lowPower?: boolean }): IslanderRig {
  const q = opts?.lowPower ? LOW : FULL
  const who = person(id)
  const st = who.style
  const scale = who.height / REF_HEIGHT
  const { body: mat, brass: brassMat } = materials(q.low)
  const toolSide = who.toolSide
  const toolHand = toolSide > 0 ? 0 : 1
  const hasTool = who.tool !== null

  // —— the surface ——
  const S = new Sculpt()
  const brass = new Sculpt()
  const torso = torsoSecs(st)
  buildTorso(S, st, q, torso)
  for (let i = 0; i < 2; i++) {
    buildArm(S, st, q, i, hasTool && i === toolHand)
    buildLeg(S, st, q, i)
  }
  buildHead(S, st, q)
  if (id === 'kael') dressKael(S, st, q, torso, scale, toolHand)
  else if (id === 'tala') dressTala(S, brass, st, q, torso)
  else dressOru(S, st, q, torso, scale, toolHand)

  // —— the skeleton, in the order of `B` ——
  const root = new THREE.Group()
  root.name = `Islander:${id}`
  const body = new THREE.Group()
  body.scale.setScalar(scale)
  root.add(body)
  const bones: THREE.Bone[] = []
  const joint = (name: string, parent: THREE.Object3D, x: number, y: number, z: number) => {
    const b = new THREE.Bone()
    b.name = name
    b.position.set(x, y, z)
    parent.add(b)
    bones.push(b)
    return b
  }
  const hips = joint('hips', body, 0, STAND_HIPS, 0)
  const spine = joint('spine', hips, 0, SPINE_Y, 0)
  const chest = joint('chest', spine, 0, CHEST_Y, 0)
  const neck = joint('neck', chest, 0, NECK_Y, NECK_Z)
  const head = joint('head', neck, 0, HEAD_Y, 0)
  const shoulder: THREE.Bone[] = []
  const elbow: THREE.Bone[] = []
  const wrist: THREE.Bone[] = []
  const hip: THREE.Bone[] = []
  const knee: THREE.Bone[] = []
  const ankle: THREE.Bone[] = []
  for (let i = 0; i < 2; i++) {
    const side = SIDES[i] > 0 ? 'R' : 'L'
    shoulder[i] = joint(`shoulder${side}`, chest, SIDES[i] * SHOULDER_X * st.shoulders, SHOULDER_Y, SHOULDER_Z)
    elbow[i] = joint(`elbow${side}`, shoulder[i], 0, -UPPER_ARM, 0)
    wrist[i] = joint(`wrist${side}`, elbow[i], 0, -FOREARM, 0)
  }
  for (let i = 0; i < 2; i++) {
    const side = SIDES[i] > 0 ? 'R' : 'L'
    hip[i] = joint(`hip${side}`, hips, SIDES[i] * HIP_X * st.hipsW, HIP_Y, 0)
    knee[i] = joint(`knee${side}`, hip[i], 0, -THIGH, 0)
    ankle[i] = joint(`ankle${side}`, knee[i], 0, -SHIN, 0)
  }
  // The face's joints sit where this islander's own head has put them
  const [hx, hy, hz] = st.headScale
  const eye = [joint('eyeR', head, EYE_X * hx, EYE_Y * hy, EYE_Z * hz), joint('eyeL', head, -EYE_X * hx, EYE_Y * hy, EYE_Z * hz)]
  const lids = joint('lids', head, 0, EYE_Y * hy, EYE_Z * hz)
  const jaw = joint('jaw', head, 0, JAW_Y * hy, JAW_Z * hz)
  const browY = BROW_Y * hy
  const brow = [joint('browR', head, EYE_X * hx, browY, -0.098 * hz), joint('browL', head, -EYE_X * hx, browY, -0.098 * hz)]
  const fingers = [joint('fingersR', wrist[0], 0, KNUCKLE_Y, 0), joint('fingersL', wrist[1], 0, KNUCKLE_Y, 0)]

  // One skinned mesh (two for Tala, whose brass is its own material) on that skeleton.
  // The bounds are set by hand to cover any pose with the spear at full reach:
  // a skinned mesh's own are those of the pose it was bound in.
  const meshes: THREE.SkinnedMesh[] = []
  const skin = (sculpt: Sculpt, material: THREE.Material, name: string) => {
    const mesh = new THREE.SkinnedMesh(sculpt.build(), material)
    mesh.name = name
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 2.6)
    mesh.boundingBox = new THREE.Box3(new THREE.Vector3(-2.6, -1.4, -2.6), new THREE.Vector3(2.6, 3.4, 2.6))
    body.add(mesh)
    meshes.push(mesh)
  }
  skin(S, mat, 'bodyMesh')
  if (!brass.empty) skin(brass, brassMat, 'brassMesh')
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones)
  for (const mesh of meshes) mesh.bind(skeleton)

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
  const vel = new Float32Array(NP)
  /** Weights of the procedural layers that belong to one pose each. */
  const w = { warn: 0, laugh: 0, beckon: 0, curious: 0, watch: 0, reach: 0, swim: 0, wade: 0 }
  let phase = hash(st.seed, 1, 2)
  let gaitW = 0
  let runW = 0
  const look = { yaw: 0, pitch: 0, has: false }
  const lookTarget = new THREE.Vector3()
  const seed = st.seed * 1.7
  // The face's own clocks
  let blinkIn = 1 + 3 * hash(st.seed, 3, 1)
  let blinkCount = 0
  let blink = 0
  let glanceIn = 0.5
  let glanceCount = 0
  let gazeX = 0
  let gazeY = 0
  let eyeYaw = 0
  let eyePitch = 0
  const lidClose = (st.face.lidOpen * 2.3 + 2) * DEG
  const footX = [0, 0]
  const footY = [0, 0]
  const footZ = [0, 0]
  const footPitch = [0, 0]
  const gait: IslanderGait = { steps: 0, side: 0, weight: 0, run: 0, wade: 0, speed: 0 }

  const X = new THREE.Vector3(1, 0, 0)
  const Z = new THREE.Vector3(0, 0, 1)
  const e = new THREE.Euler()
  const q1 = new THREE.Quaternion()
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

  /** Orientation of a joint relative to the body group. */
  const chainQuat = (nodes: readonly THREE.Object3D[], out: THREE.Quaternion) => {
    out.identity()
    for (const n of nodes) out.multiply(n.quaternion)
    return out
  }
  /** A point given in the innermost joint's frame, carried out to the body group's frame. */
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
    q1.setFromRotationMatrix(mBasis)
    q2.copy(qChain).invert().multiply(q1)
    if (weight >= 0.999) wristNode.quaternion.copy(q2)
    else wristNode.quaternion.slerp(q2, weight)
  }

  function setArm(
    i: number,
    flex: number,
    abd: number,
    twist: number,
    elb: number,
    wristFlex: number,
    palm: number,
    curl: number,
    breathe: number,
  ) {
    const s = SIDES[i]
    // Fingers close toward the palm, which faces the body
    fingers[i].quaternion.setFromAxisAngle(Z, -s * clamp(curl, -0.1, 1.6))
    shoulder[i].quaternion.setFromEuler(e.set(flex, s * twist, s * abd, 'XZY'))
    // The shoulder itself rises with a breath, and with an arm lifted high
    shoulder[i].position.y = SHOULDER_Y + 0.0035 * breathe + 0.024 * smooth(0.9, 2.2, abd) + 0.01 * smooth(0.9, 1.6, flex)
    elbow[i].quaternion.setFromAxisAngle(X, Math.max(0, elb))
    wrist[i].quaternion.setFromEuler(e.set(wristFlex, -s * palm, 0, 'YXZ'))
  }

  function update(dt: number, t: number, motion: IslanderMotion) {
    // —— the pose, chased by springs ——
    const h = clamp(dt, 0, 0.1)
    const sub = h > 0.036 ? 3 : h > 0.018 ? 2 : 1
    const hs = h / sub
    for (let n = 0; n < sub; n++) {
      for (let i = 0; i < NP; i++) {
        const om = OMEGA[i]
        vel[i] += (om * om * (tgt[i] - cur[i]) - 2 * ZETA[i] * om * vel[i]) * hs
        cur[i] += vel[i] * hs
      }
    }
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
    const sit = clamp(cur[K.sit], 0, 1)
    /** 1 standing on the ground, 0 seated or swimming. */
    const afoot = (1 - sit) * (1 - w.swim)
    // Steps per second rise with speed; a run is a quicker, longer stride
    const cadence = (0.66 + 0.3 * Math.min(v, 2.4)) * (1 - runW) + (1.25 + 0.06 * v) * runW
    const phaseWas = phase
    phase = (phase + cadence * dt * (1 - sit)) % 1
    const duty = 0.62 - 0.26 * runW
    // Feet travel back at exactly ground speed while planted, so they do not skate
    const stride = (v * duty) / cadence
    // The foot rolls: down on the heel with the toes up, off the ball with the heel up
    const roll = clamp(stride / 0.6, 0, 1) * gaitW * afoot * (1 - 0.5 * w.wade)
    const heelStrike = 0.3 * roll
    const toeOff = (0.7 + 0.25 * runW) * roll
    const lift = (0.07 + 0.09 * runW) * gaitW * (1 - 0.6 * w.wade) * (1 - w.swim)
    const slope = clamp(motion.slope ?? 0, -1.2, 1.2) * afoot
    const walk = gaitW * afoot
    // For the sound only: a foot lands as its stance begins, where its phase wraps to 0
    // (the right foot's phase is `phase`, the left's is half a cycle on). Reads, never writes, the gait.
    if (walk > 0.25 && v > 0.08) {
      const right = phase < phaseWas
      const left = phaseWas < 0.5 && phase >= 0.5
      if (right || left) {
        gait.steps += right && left ? 2 : 1
        gait.side = left ? -1 : 1
        gait.weight = walk
        gait.run = runW
        gait.wade = w.wade
        gait.speed = Math.max(0, motion.speed)
      }
    }
    // Standing: every so often the weight goes over to the other leg, and stays a while
    const idle = (1 - gaitW) * afoot * (1 - w.reach)
    const s0 = Math.sin((TAU * t) / who.shiftPeriod + seed * 3.1)
    const shift = (s0 / Math.sqrt(s0 * s0 + 0.05)) * idle * who.shiftAmount

    // —— where each ankle is, in the body's frame ——
    const stand = cur[K.stance] * (1 - 0.45 * gaitW)
    for (let i = 0; i < 2; i++) {
      const s = SIDES[i]
      const lp = (s > 0 ? phase : phase + 0.5) % 1
      let fz: number
      let up = 0
      let pitch: number
      if (lp < duty) {
        const k = lp / duty
        fz = stride * (k - LANDS_AHEAD)
        pitch = heelStrike * (1 - smooth(0, 0.2, k)) - toeOff * smooth(0.55, 1, k)
      } else {
        const k = (lp - duty) / (1 - duty)
        fz = stride * (1 - LANDS_AHEAD - smooth(0, 1, k))
        up = Math.sin(Math.PI * k) * lift
        pitch = heelStrike * smooth(0.55, 1, k) - toeOff * (1 - smooth(0, 0.4, k))
      }
      fz += (s === sT ? cur[K.tFoot] : cur[K.fFoot]) * (1 - gaitW * 0.7) + 0.28 * w.swim
      up += 0.12 * w.swim * (1 + Math.sin(TAU * 0.7 * t + (s > 0 ? 0 : Math.PI)))
      // The leg the weight has left rests: a little forward, the heel just off the ground
      const rest = Math.max(0, -shift * s)
      fz -= 0.04 * rest
      pitch -= 0.16 * rest
      // Toes down turns the foot about its ball, toes up about its heel: either lifts the ankle
      const cp = Math.cos(pitch)
      const sp = Math.sin(pitch)
      footX[i] = s * (HIP_X * st.hipsW + stand)
      footY[i] = (pitch < 0 ? ANKLE * cp - BALL * sp : ANKLE * cp + HEEL * sp) + up - slope * fz
      footZ[i] = pitch < 0 ? fz - BALL + ANKLE * sp + BALL * cp : fz + HEEL + ANKLE * sp - HEEL * cp
      footPitch[i] = pitch
    }

    // —— hips ——
    const breathe = Math.sin((TAU * t) / who.breath + seed)
    const mid = TAU * (phase - duty * 0.5)
    // Over the planted foot, the far hip dropping, the near hip leading the leg that swings
    const swayX =
      0.006 * Math.sin(TAU * (t / 7.3) + seed * 2) * idle + 0.024 * shift + 0.02 * walk * (1 - 0.6 * runW) * Math.cos(mid)
    const rollDyn = 0.04 * walk * (1 - 0.5 * runW) * Math.cos(mid) + 0.035 * shift
    const pelvisRoll = cur[K.hipRoll] + rollDyn
    const pelvisYaw = 0.085 * walk * (1 - 0.4 * runW) * Math.cos(TAU * phase)
    let drop = cur[K.drop] + (0.006 + 0.04 * runW) * gaitW + 0.06 * Math.min(1, Math.abs(slope)) + 0.28 * w.reach
    drop += 0.006 * Math.abs(shift) - 0.025 * runW * gaitW * Math.cos(2 * mid)
    const laughPulse = w.laugh * (0.55 + 0.45 * Math.sin(TAU * 0.45 * t))
    drop += 0.02 * Math.abs(Math.sin(TAU * 3.1 * t)) * laughPulse
    const hipsX = cur[K.hipX] + swayX
    const hipsZ = cur[K.hipZ]
    const free = STAND_HIPS - drop
    // The hips ride as high as both legs can reach and no higher: this is the
    // walk's rise over the planted leg and its dip when both feet are down
    let high = free
    for (let i = 0; i < 2; i++) {
      const s = SIDES[i]
      const dx = footX[i] - (hipsX + s * HIP_X * st.hipsW)
      const dz = footZ[i] - hipsZ
      const room = Math.sqrt(Math.max(REACH * REACH - dx * dx - dz * dz, 0.25))
      high = softMin(high, footY[i] + room - HIP_Y - s * HIP_X * st.hipsW * pelvisRoll)
    }
    high = Math.max(high, free - 0.04 - 0.06 * runW)
    const hipsY = mix(mix(high, free, w.swim), SIT_HIPS, sit)
    hips.position.set(hipsX, hipsY, hipsZ)
    hips.quaternion.setFromEuler(e.set(0, pelvisYaw, pelvisRoll, 'YXZ'))

    // —— trunk: the shoulders turn against the hips, and breathe ——
    const lean = -0.05 * Math.min(v, 2.4) * gaitW - 0.1 * runW * gaitW
    const spineP = cur[K.spine] + lean - 0.8 * w.reach - 0.35 * w.swim
    let chestP = cur[K.chest] + 0.014 * breathe - 0.22 * w.reach
    chestP += 0.045 * Math.sin(TAU * 6.2 * t) * laughPulse
    let chestYaw = cur[K.chestYaw] * sF - pelvisYaw * 1.1
    chestYaw += 0.05 * Math.sin(TAU * 0.8 * t) * w.beckon * sF + 0.02 * Math.sin(TAU * 1.15 * t) * w.warn

    // —— head and eyes: the eyes go first, the neck and head follow ——
    let eyeYawWant: number
    let eyePitchWant: number
    if (look.has) {
      vT.copy(lookTarget).sub(root.position)
      qInv.copy(root.quaternion).invert()
      vT.applyQuaternion(qInv).multiplyScalar(1 / scale)
      vT.y -= hipsY + 0.66
      const yawTo = Math.atan2(-vT.x, -vT.z) - chestYaw
      const pitchTo = Math.atan2(vT.y, Math.hypot(vT.x, vT.z)) - (spineP + chestP) * 0.5
      look.yaw = damp(look.yaw, clamp(yawTo, -1.35, 1.35), 6, dt)
      look.pitch = damp(look.pitch, clamp(pitchTo, -0.6, 0.5), 6, dt)
      eyeYawWant = clamp(yawTo - look.yaw, -0.5, 0.5)
      eyePitchWant = clamp(pitchTo - look.pitch, -0.35, 0.3)
    } else {
      // Nothing to look at: a slow wander of the head, and the eyes jumping ahead of it
      const wander = who.glance * (1 - 0.5 * gaitW)
      const yawIdle =
        0.28 * Math.sin(TAU * 0.07 * t + seed) * w.watch +
        wander * (0.09 * Math.sin((TAU * t) / 9.1 + seed * 5) + 0.05 * Math.sin((TAU * t) / 4.3 + seed))
      look.yaw = damp(look.yaw, yawIdle, 2, dt)
      look.pitch = damp(look.pitch, wander * 0.03 * Math.sin((TAU * t) / 6.7 + seed * 2), 2, dt)
      glanceIn -= dt
      if (glanceIn <= 0) {
        glanceCount++
        glanceIn = 0.6 + 2.6 * hash(glanceCount, seed, 5)
        gazeX = (hash(glanceCount, seed, 6) - 0.5) * 0.5 * who.glance
        gazeY = (hash(glanceCount, seed, 7) - 0.5) * 0.16 * who.glance - 0.03
      }
      eyeYawWant = gazeX
      eyePitchWant = gazeY
    }
    eyeYaw = damp(eyeYaw, eyeYawWant, 26, dt)
    eyePitch = damp(eyePitch, eyePitchWant, 26, dt)
    const ly = look.yaw
    const lp = look.pitch
    // What the shoulders turned against the stride, the neck turns back: the head keeps its line
    const level = pelvisYaw * 0.7
    spine.quaternion.setFromEuler(e.set(spineP, -pelvisYaw * 0.6 + ly * 0.08, -rollDyn * 0.55, 'YXZ'))
    chest.quaternion.setFromEuler(e.set(chestP, chestYaw + ly * 0.12, -cur[K.hipRoll] * 0.5 - rollDyn * 0.35, 'YXZ'))
    chest.scale.set(1 + 0.005 * breathe, 1, 1 + 0.014 * breathe)
    const tilt = cur[K.tilt] + 0.06 * Math.sin(TAU * 0.17 * t + seed) * w.curious
    neck.quaternion.setFromEuler(
      e.set(
        cur[K.neck] + lp * 0.4 + 0.3 * w.reach + 0.03 * Math.sin(TAU * 6.2 * t + 1.3) * laughPulse,
        ly * 0.35 + level * 0.5,
        tilt * 0.35 - rollDyn * 0.05,
        'YXZ',
      ),
    )
    head.quaternion.setFromEuler(
      e.set(cur[K.head] + lp * 0.6 + 0.2 * w.reach + 0.25 * w.swim, ly * 0.45 + level * 0.4, tilt * 0.65 - rollDyn * 0.05, 'YXZ'),
    )

    // —— face ——
    blinkIn -= dt
    if (blinkIn <= 0) {
      blinkCount++
      // Now and then two in a row
      blinkIn = hash(blinkCount, seed, 4) > 0.84 ? 0.32 : 2.4 + 3.6 * hash(blinkCount, seed, 9)
      blink = 1
    }
    if (blink > 0) blink = Math.max(0, blink - dt / 0.17)
    const closing = blink > 0 ? Math.sin(Math.PI * (1 - blink) ** 0.7) : 0
    const squint = clamp(cur[K.squint] + 0.15 * laughPulse, 0, 1)
    // Lids follow the eye up and down, narrow with a squint, and shut to blink
    lids.quaternion.setFromAxisAngle(X, eyePitch * 0.6 - lidClose * Math.max(closing, squint * 0.78))
    e.set(eyePitch, eyeYaw, 0, 'YXZ')
    eye[0].quaternion.setFromEuler(e)
    eye[1].quaternion.setFromEuler(e)
    const browUp = cur[K.brow] + 0.3 * laughPulse
    const frown = cur[K.frown]
    for (let i = 0; i < 2; i++) {
      const s = SIDES[i]
      // Curious: one brow goes higher than the other
      brow[i].position.y = browY + 0.0045 * browUp * (1 + 0.5 * s * w.curious) - 0.0022 * frown
      brow[i].quaternion.setFromAxisAngle(Z, s * (0.28 * frown - 0.08 * browUp))
    }
    const talk = 0.5 * laughPulse * (0.6 + 0.4 * Math.sin(TAU * 6.2 * t))
    jaw.quaternion.setFromAxisAngle(X, -0.4 * clamp(cur[K.jaw] + talk, 0, 1.2))

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
    // A hanging arm is never quite still
    const sway = 0.012 * Math.sin((TAU * t) / 5.3 + seed * 4) * idle
    setArm(
      iT,
      mix(cur[K.tFlex] - swingT * Math.cos(TAU * phT) + 0.2 * w.wade + 0.55 * w.reach + warm + (hasTool ? 0 : sway), swimFlex, w.swim),
      mix(cur[K.tAbd] + 0.045 * Math.sin(TAU * 1.15 * t) * w.warn + 0.3 * w.wade, swimAbd, w.swim),
      cur[K.tTwist] * (1 - w.swim),
      mix(cur[K.tElbow] + (hasTool ? 0 : elbowRun - 0.1 * swingT * Math.cos(TAU * phT)) + 0.4 * w.wade, swimElbow, w.swim),
      cur[K.tWrist],
      cur[K.tPalm] * (1 - w.swim),
      cur[K.tCurl] * (1 - 0.7 * w.swim),
      breathe,
    )
    // A beckon shows even from the water: that arm leaves the stroke to wave
    const swimF = w.swim * (1 - w.beckon)
    setArm(
      iF,
      mix(cur[K.fFlex] - swingF * Math.cos(TAU * phF) + 0.22 * beck * w.beckon + 0.2 * w.wade + 0.55 * w.reach - warm - sway, swimFlex, swimF),
      mix(cur[K.fAbd] + 0.3 * w.wade, swimAbd, swimF),
      cur[K.fTwist] * (1 - swimF),
      mix(cur[K.fElbow] + elbowRun - 0.1 * swingF * Math.cos(TAU * phF) + 0.35 * (beck + 1) * w.beckon + 0.4 * w.wade, swimElbow, swimF),
      cur[K.fWrist],
      cur[K.fPalm] * (1 - swimF),
      // Beckoning is done with the fingers as much as the arm
      cur[K.fCurl] * (1 - 0.7 * swimF) + 0.55 * (beck + 1) * w.beckon,
      breathe,
    )

    // —— legs ——
    qInv.copy(hips.quaternion).invert()
    for (let i = 0; i < 2; i++) {
      const s = SIDES[i]
      vT.set(footX[i], footY[i], footZ[i])
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
      // The sole follows the ground and the roll of the step, or lies on its edge to sit
      e.set((Math.atan(slope) + footPitch[i]) * (1 - sit), s * 0.9 * sit, -s * 1.3 * sit, 'YXZ')
      q1.setFromEuler(e).premultiply(qInv)
      q2.copy(hip[i].quaternion).multiply(knee[i].quaternion).invert()
      ankle[i].quaternion.copy(q2).multiply(q1)
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
        // The wrist sits a hand's width short of the shaft, toward the shoulder,
        // and to the back of the hand's side of it, so the shaft lies in the
        // palm and the fingers close round it
        vB.copy(shoulder[iF].position).sub(vA).normalize()
        vC.copy(toolDir).applyQuaternion(qInv).negate()
        vC.crossVectors(vB, vC).normalize()
        vA.addScaledVector(vB, 0.065).addScaledVector(vC, sF * 0.024)
        vP.set(sF * 0.5, -0.55, 0.7)
        const elbowIk = solveTwoBone(shoulder[iF].position, vA, vP, UPPER_ARM, FOREARM, 1, ikQ)
        shoulder[iF].quaternion.slerp(ikQ, grip)
        q1.setFromAxisAngle(X, elbowIk)
        elbow[iF].quaternion.slerp(q1, grip)
        aimFist(freeChain, wrist[iF], toolDir, grip)
      }
    }
  }

  return {
    root,
    id,
    gait,
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
      vel.fill(0)
      w.warn = pose === 'warn_spear_raise' ? 1 : 0
      w.laugh = pose === 'laugh_baffled' ? 1 : 0
      w.beckon = pose === 'beckon_follow' ? 1 : 0
      w.curious = pose === 'curious_tilt' ? 1 : 0
    },
  }
}
