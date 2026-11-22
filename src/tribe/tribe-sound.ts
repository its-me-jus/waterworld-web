/**
 * The islanders and their camp, heard: the camp fire, Kael, Tala and Oru's
 * feet, and a few quiet wordless sounds when they notice you.
 *
 * Everything is synthesised here, once, a bank at a time over the first
 * frames after sound unlocks (so a phone never stalls on the first touch),
 * and then only played back: looping buffers for the fire's steady layers,
 * one-shot buffers for crackle snaps, footfalls and voices. Nothing
 * continuous makes a node per frame; one-shots are capped (ONE_SHOT_CAP).
 *
 * It rides the game's one AudioContext and its ambient bus
 * (`oceanAudio.getWorldOutput()`), so the dive's ear muffle, the chamber's
 * duck and the hidden-tab pause apply to it as they do to the sea. Under the
 * surface its own bus also goes dark and quiet by the rule the sea's layers
 * use (underW from submersion).
 *
 * Positioned with one equal-power PannerNode for the fire and one per
 * islander; the AudioListener follows the camera.
 *
 * The synthesis functions are plain loops over Float32Arrays and the engine
 * takes any BaseAudioContext, so the dev audition (tribe-sound-dev.ts) runs
 * exactly this code in an OfflineAudioContext.
 */

import type * as THREE from 'three'
import type { NpcId } from './types'
import type { TribeCue } from './tribe-sim'
import type { IslanderRig } from './npc-mesh'
import type { CampFireState } from '../story/camp'
import { VOICE_FILES } from './voice-files'

// —— small maths ————————————————————————————————————————————————

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const clamp01 = (v: number) => clamp(v, 0, 1)
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

export type Rng = () => number
export function makeRng(seed: number): Rng {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const white = (r: Rng) => r() * 2 - 1
const onePole = (fc: number, rate: number) => 1 - Math.exp((-2 * Math.PI * fc) / rate)

// —— filters, in place. `circular` runs the array twice first so a loop's end flows into its start ——

function lp(x: Float32Array, fc: number, rate: number, circular = false) {
  const a = onePole(fc, rate)
  let y = 0
  if (circular) for (let i = 0; i < x.length; i++) y += a * (x[i] - y)
  for (let i = 0; i < x.length; i++) {
    y += a * (x[i] - y)
    x[i] = y
  }
}

function hp(x: Float32Array, fc: number, rate: number, circular = false) {
  const a = onePole(fc, rate)
  let low = 0
  if (circular) for (let i = 0; i < x.length; i++) low += a * (x[i] - low)
  for (let i = 0; i < x.length; i++) {
    low += a * (x[i] - low)
    x[i] -= low
  }
}

/** Two-pole resonator, peak gain 1 at `f`. */
function res(x: Float32Array, f: number, bw: number, rate: number, circular = false) {
  const r = Math.exp((-Math.PI * bw) / rate)
  const th = (2 * Math.PI * Math.min(f, rate * 0.45)) / rate
  const a1 = 2 * r * Math.cos(th)
  const a2 = r * r
  const g = Math.hypot(1 - a1 * Math.cos(th) + a2 * Math.cos(2 * th), a1 * Math.sin(th) - a2 * Math.sin(2 * th))
  let y1 = 0
  let y2 = 0
  if (circular) {
    for (let i = 0; i < x.length; i++) {
      const y = g * x[i] + a1 * y1 - a2 * y2
      y2 = y1
      y1 = y
    }
  }
  for (let i = 0; i < x.length; i++) {
    const y = g * x[i] + a1 * y1 - a2 * y2
    y2 = y1
    y1 = y
    x[i] = y
  }
}

function rmsOf(x: Float32Array) {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, x.length))
}
function peakOf(x: Float32Array) {
  let m = 0
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]))
  return m
}
function scale(x: Float32Array, k: number) {
  for (let i = 0; i < x.length; i++) x[i] *= k
  return x
}
const peakTo = (x: Float32Array, p: number) => scale(x, p / (peakOf(x) || 1))
/** RMS to `r`, but never a peak over `cap`. */
const rmsTo = (x: Float32Array, r: number, cap = 0.97) => {
  const k = Math.min(r / (rmsOf(x) || 1), cap / (peakOf(x) || 1))
  return scale(x, k)
}
/** Same energy (sum of squares per second) for every take, so short and long ones weigh alike; peak capped. */
const energyTo = (x: Float32Array, e: number, rate: number, cap = 0.97) => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  const k = Math.min(Math.sqrt(e / (s / rate || 1e-9)), cap / (peakOf(x) || 1))
  return scale(x, k)
}

/** Band-limited unit-RMS noise. */
function band(n: number, r: Rng, rate: number, lo: number, hi: number) {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = white(r)
  if (hi < rate * 0.45) {
    lp(x, hi, rate)
    lp(x, hi, rate)
  }
  if (lo > 0) hp(x, lo, rate)
  return scale(x, 1 / (rmsOf(x) || 1))
}

/** A smooth random wander around 0 with unit spread; circular so it loops. */
function wander(n: number, hz: number, rate: number, r: Rng, circular = true) {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = white(r)
  lp(x, hz, rate, circular)
  lp(x, hz, rate, circular)
  return scale(x, 1 / (rmsOf(x) || 1))
}

/** Add a short noise burst (0.1 ms rise, exponential fall) at sample `at`; wraps round a loop when `wrap`. */
function addBurst(out: Float32Array, at: number, tau: number, amp: number, rate: number, r: Rng, wrap: boolean) {
  const n = out.length
  const len = Math.ceil(tau * 7 * rate)
  const rise = Math.max(1, 0.0001 * rate)
  const k1 = 1 / (tau * rate)
  for (let k = 0; k < len; k++) {
    let i = at + k
    if (i >= n) {
      if (!wrap) break
      i %= n
    }
    out[i] += white(r) * amp * Math.min(1, k / rise) * Math.exp(-k * k1)
  }
}

/** Add `s` into `out` at `at` times `amp`, wrapping round a loop when `wrap`. */
function addInto(out: Float32Array, s: Float32Array, at: number, amp: number, wrap: boolean) {
  const n = out.length
  for (let k = 0; k < s.length; k++) {
    let i = at + k
    if (i >= n) {
      if (!wrap) break
      i %= n
    }
    out[i] += s[k] * amp
  }
}

/** A burst rung through a resonance: a knock, a woody crack, a drip. */
function ring(rate: number, r: Rng, f: number, bw: number, tau: number, len: number) {
  const s = new Float32Array(Math.ceil(len * rate))
  addBurst(s, 0, tau, 1, rate, r, false)
  res(s, f, bw, rate)
  return s
}

/** Shaped band noise added into `out`: attack and exponential fall, optional granular grit. */
function layer(
  out: Float32Array,
  rate: number,
  r: Rng,
  o: { at: number; lo: number; hi: number; attack: number; tau: number; amp: number; grain?: number },
) {
  const start = Math.floor(o.at * rate)
  const len = Math.min(out.length - start, Math.ceil((o.tau * 7 + o.attack) * rate))
  if (len <= 0) return
  const s = band(len, r, rate, o.lo, o.hi)
  const g = o.grain ? wander(len, o.grain, rate, r, false) : null
  const a = Math.max(1, o.attack * rate)
  const k1 = 1 / (o.tau * rate)
  for (let k = 0; k < len; k++) {
    let e = (1 - Math.exp(-k / a * 3)) * Math.exp(-Math.max(0, k - a) * k1)
    if (g) {
      const q = Math.max(0, 0.35 + 0.65 * g[k])
      e *= q * q
    }
    out[start + k] += s[k] * e * o.amp
  }
}

/** A run of tiny crackles (leaf litter, a fire's crackle) between `from` and `to` seconds. */
function crackles(out: Float32Array, rate: number, r: Rng, from: number, to: number, perSecond: number, amp: number, wrap = false) {
  let t = from
  while (true) {
    t += -Math.log(1 - r() * 0.999) / perSecond
    if (t >= to) break
    const u = (t - from) / (to - from)
    const fade = Math.sin(Math.PI * Math.min(1, u * 1.15))
    addBurst(out, Math.floor(t * rate), 0.00022 + 0.0009 * r(), amp * fade * (0.08 + 0.92 * r() ** 3), rate, r, wrap)
  }
}

// —— the fire ————————————————————————————————————————————————————

/** The low flutter of the flames themselves. */
export function renderFireRoar(rate: number, r: Rng, seconds: number) {
  const n = Math.round(rate * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = white(r)
  lp(x, 300, rate, true)
  lp(x, 300, rate, true)
  hp(x, 38, rate, true)
  scale(x, 1 / (rmsOf(x) || 1))
  // The flap of the flame tongues, a little higher and quieter
  const flap = new Float32Array(n)
  for (let i = 0; i < n; i++) flap[i] = white(r)
  res(flap, 560, 520, rate, true)
  scale(flap, 0.3 / (rmsOf(flap) || 1))
  const flutter = wander(n, 6.5, rate, r)
  const swell = wander(n, 0.4, rate, r)
  for (let i = 0; i < n; i++) {
    const f = clamp(0.62 + 0.3 * flutter[i], 0.12, 1.3)
    const s = clamp(0.82 + 0.18 * swell[i], 0.45, 1.2)
    x[i] = (x[i] + flap[i] * f) * f * s
  }
  return rmsTo(x, 0.2)
}

/** Gas and sap escaping: a soft high hiss in slow jets. */
export function renderFireHiss(rate: number, r: Rng, seconds: number) {
  const n = Math.round(rate * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = white(r)
  hp(x, 2400, rate, true)
  hp(x, 2400, rate, true)
  lp(x, 7200, rate, true)
  const jets = wander(n, 1.3, rate, r)
  const slow = wander(n, 0.22, rate, r)
  for (let i = 0; i < n; i++) x[i] *= clamp(0.5 + 0.38 * jets[i], 0.05, 1.3) * clamp(0.8 + 0.2 * slow[i], 0.4, 1.2)
  return rmsTo(x, 0.2)
}

/** The fine crackle: many tiny ticks, in clusters that come and go. */
export function renderFireCrackle(rate: number, r: Rng, seconds: number) {
  const n = Math.round(rate * seconds)
  const out = new Float32Array(n)
  const act = wander(n, 0.55, rate, r)
  let t = 0
  while (true) {
    const i = Math.min(n - 1, Math.floor(t * rate))
    const a = clamp01(0.5 + 0.42 * act[i])
    t += -Math.log(1 - r() * 0.999) / (5 + 60 * a * a)
    if (t >= seconds) break
    addBurst(out, Math.floor(t * rate), 0.00025 + 0.0011 * r(), 0.05 + 0.95 * r() ** 4, rate, r, true)
  }
  hp(out, 1100, rate, true)
  lp(out, 9500, rate, true)
  return peakTo(out, 0.95)
}

/** The bigger pops: a resonant crack of wood, sometimes two or three in a run. */
export function renderFirePops(rate: number, r: Rng, seconds: number) {
  const n = Math.round(rate * seconds)
  const out = new Float32Array(n)
  let t = r() * 0.3
  while (true) {
    t += -Math.log(1 - r() * 0.999) / 1.25 + 0.05
    if (t >= seconds) break
    const run = r() < 0.3 ? 2 + Math.floor(r() * 3) : 1
    let tt = t
    for (let k = 0; k < run; k++) {
      const f = 450 + r() * 2150
      // The ring is gone inside 25 ms (bandwidth f/9 at the narrowest), so the scratch need be no longer
      const s = ring(rate, r, f, f / (3 + r() * 6), 0.0004 + 0.0008 * r(), 0.025)
      addBurst(s, 0, 0.00015, 0.6, rate, r, false)
      addInto(out, s, Math.floor(tt * rate), (0.3 + 0.7 * r() ** 2) * (k === 0 ? 1 : 0.7), true)
      tt += 0.015 + r() * 0.06
    }
  }
  hp(out, 250, rate, true)
  return peakTo(out, 0.95)
}

/** Rain on the fire: a damp steam hiss, sizzles where drops hit the coals, the odd sputter. */
export function renderFireSputter(rate: number, r: Rng, seconds: number) {
  const n = Math.round(rate * seconds)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = white(r)
  hp(out, 3000, rate, true)
  lp(out, 8500, rate, true)
  const slow = wander(n, 0.35, rate, r)
  scale(out, 0.1 / (rmsOf(out) || 1))
  for (let i = 0; i < n; i++) out[i] *= clamp(0.65 + 0.3 * slow[i], 0.2, 1.2)
  // Sizzles: a drop hits the coals
  let t = 0
  while (true) {
    t += -Math.log(1 - r() * 0.999) / 2.4
    if (t >= seconds) break
    const len = 0.08 + r() * 0.22
    const s = band(Math.ceil(len * rate), r, rate, 2600, 8000)
    const a = 0.004 * rate
    const k1 = 1 / ((len / 3) * rate)
    for (let k = 0; k < s.length; k++) s[k] *= Math.min(1, k / a) * Math.exp(-k * k1)
    addInto(out, s, Math.floor(t * rate), 0.05 + 0.09 * r(), true)
  }
  // Sputters: wet wood spitting
  t = 0
  while (true) {
    t += -Math.log(1 - r() * 0.999) / 1.1
    if (t >= seconds) break
    const len = 0.03 + r() * 0.07
    const s = band(Math.ceil(len * rate), r, rate, 0, rate * 0.5)
    const fm = 40 + r() * 50
    for (let k = 0; k < s.length; k++) {
      const u = k / s.length
      const gate = Math.sin(2 * Math.PI * fm * (k / rate)) > -0.2 ? 1 : 0.15
      s[k] *= gate * Math.sin(Math.PI * u)
    }
    res(s, 1500 + r() * 1300, 900, rate)
    addInto(out, s, Math.floor(t * rate), 0.08 + 0.1 * r(), true)
  }
  // Damp little pops, low and dull
  t = 0
  while (true) {
    t += -Math.log(1 - r() * 0.999) / 0.7
    if (t >= seconds) break
    const s = new Float32Array(Math.ceil(0.04 * rate))
    addBurst(s, 0, 0.004, 1, rate, r, false)
    lp(s, 700, rate)
    addInto(out, s, Math.floor(t * rate), 0.25 + 0.3 * r(), true)
  }
  hp(out, 60, rate, true)
  return peakTo(out, 0.95)
}

/** A one-shot snap of wood, for the irregular big cracks on top of the loops. */
export function renderFireSnap(rate: number, r: Rng) {
  const out = new Float32Array(Math.ceil(0.32 * rate))
  const cracks = 1 + Math.floor(r() * 3)
  let t = 0.002
  for (let c = 0; c < cracks; c++) {
    const at = Math.floor(t * rate)
    const amp = c === 0 ? 1 : 0.45 + 0.3 * r()
    const f = 800 + r() * 1400
    addInto(out, ring(rate, r, f, 150 + r() * 200, 0.0003 + 0.0005 * r(), 0.06), at, 0.9 * amp, false)
    addBurst(out, at, 0.00012, 0.7 * amp, rate, r, false)
    addInto(out, ring(rate, r, 200 + r() * 120, 80, 0.002, 0.08), at, 0.5 * amp, false)
    t += 0.012 + r() * 0.045
  }
  crackles(out, rate, r, 0.03, 0.26, 25 + r() * 30, 0.3)
  hp(out, 120, rate)
  return peakTo(out, 0.95)
}

// —— footfalls ———————————————————————————————————————————————————

export type Surface = 'sand' | 'wet-sand' | 'earth' | 'leaves' | 'rock' | 'wade'
export const SURFACES: readonly Surface[] = ['sand', 'wet-sand', 'earth', 'leaves', 'rock', 'wade']

/** How loud each surface's takes are made, as energy, relative to sand. */
const SURFACE_ENERGY: Record<Surface, number> = {
  sand: 1,
  'wet-sand': 0.9,
  earth: 0.75,
  leaves: 1.25,
  rock: 0.4,
  wade: 1.5,
}

/** One barefoot footfall: heel, then the ball of the foot, on that ground. */
export function renderStep(rate: number, r: Rng, surface: Surface, variant: number) {
  const len = surface === 'wade' ? 0.6 : surface === 'leaves' ? 0.42 : 0.32
  const out = new Float32Array(Math.ceil(len * rate))
  const ball = 0.065 + r() * 0.045
  const thud = (at: number, hi: number, tau: number, amp: number) =>
    layer(out, rate, r, { at, lo: 40, hi, attack: 0.002, tau, amp })
  const grit = (at: number, lo: number, hi: number, tau: number, amp: number, attack = 0.006) =>
    layer(out, rate, r, { at, lo, hi, attack, tau, amp, grain: 180 + r() * 220 })
  switch (surface) {
    case 'sand':
      // Soft give, then the sand squeezing out from under heel and toes
      thud(0, 420, 0.022, 1)
      grit(0.008 + r() * 0.012, 1400, 5200, 0.045, 0.55)
      thud(ball, 380, 0.016, 0.45)
      grit(ball + 0.006, 1500, 5600, 0.035, 0.38)
      grit(ball + 0.09, 1800, 6000, 0.03, 0.12, 0.01)
      break
    case 'wet-sand': {
      // Compact: a firm thud, a little smack of skin on wet sand, a soft suck as the foot lifts
      thud(0, 300, 0.018, 1)
      addInto(out, ring(rate, r, 1100 + r() * 300, 900, 0.0012, 0.03), 0, 0.5, false)
      thud(ball, 260, 0.014, 0.5)
      addInto(out, ring(rate, r, 1300 + r() * 300, 900, 0.001, 0.03), Math.floor(ball * rate), 0.22, false)
      layer(out, rate, r, { at: ball + 0.07 + r() * 0.04, lo: 80, hi: 900, attack: 0.012, tau: 0.025, amp: 0.2 })
      grit(0.01, 1800, 4500, 0.02, 0.08)
      break
    }
    case 'earth':
      // The camp's packed, worn ground: dull, and short
      thud(0, 360, 0.02, 1)
      thud(ball, 330, 0.015, 0.5)
      grit(0.006, 2000, 5000, 0.03, 0.15)
      grit(ball + 0.004, 2000, 5200, 0.025, 0.1)
      break
    case 'leaves': {
      // Dry litter crunching under the heel and again under the ball; now and then a twig
      thud(0, 380, 0.02, 0.5)
      const s = new Float32Array(out.length)
      crackles(s, rate, r, 0.002, 0.13, 320, 1)
      crackles(s, rate, r, ball - 0.01, ball + 0.15, 230, 0.8)
      hp(s, 1700, rate)
      lp(s, 9000, rate)
      addInto(out, peakTo(s, 1), 0, 0.75, false)
      layer(out, rate, r, { at: 0.004, lo: 2400, hi: 8000, attack: 0.015, tau: 0.08, amp: 0.2 })
      if (variant % 3 === 0 || r() < 0.2) {
        const at = 0.03 + r() * 0.06
        const f = 1500 + r() * 1700
        addInto(out, ring(rate, r, f, 160 + r() * 120, 0.0004, 0.05), Math.floor(at * rate), 0.9, false)
        addBurst(out, Math.floor(at * rate), 0.00015, 0.5, rate, r, false)
        if (r() < 0.5) addInto(out, ring(rate, r, f * 1.3, 220, 0.0003, 0.04), Math.floor((at + 0.008 + r() * 0.012) * rate), 0.45, false)
      }
      break
    }
    case 'rock':
      // Bare skin on basalt: a soft pat, not a click, and a grain or two of sand scraping
      thud(0, 300, 0.012, 0.8)
      addInto(out, ring(rate, r, 850 + r() * 250, 1200, 0.0009, 0.03), 0, 0.6, false)
      thud(ball, 280, 0.01, 0.4)
      addInto(out, ring(rate, r, 950 + r() * 250, 1200, 0.0008, 0.03), Math.floor(ball * rate), 0.3, false)
      grit(0.01, 3000, 7500, 0.025, 0.12)
      break
    case 'wade': {
      // A shin pushing through water: a low plunge, a slosh that swells and falls, spray, a few drips
      layer(out, rate, r, { at: 0.008, lo: 30, hi: 300, attack: 0.008, tau: 0.06, amp: 0.5 })
      const sl = Math.ceil(0.5 * rate)
      const s = band(sl, r, rate, 0, rate * 0.5)
      res(s, 600 + r() * 150, 700, rate)
      lp(s, 1800, rate)
      const bub = wander(sl, 24 + r() * 10, rate, r, false)
      const a = 0.035 * rate
      const k1 = 1 / (0.15 * rate)
      for (let k = 0; k < sl; k++) s[k] *= (1 - Math.exp((-k / a) * 3)) * Math.exp(-Math.max(0, k - a) * k1) * clamp(0.75 + 0.35 * bub[k], 0.2, 1.4)
      addInto(out, scale(s, 1 / (peakOf(s) || 1)), 0, 1, false)
      layer(out, rate, r, { at: 0, lo: 2200, hi: 7000, attack: 0.003, tau: 0.05, amp: 0.3 })
      const drips = 3 + Math.floor(r() * 4)
      for (let k = 0; k < drips; k++) {
        const at = 0.12 + r() * 0.33
        addInto(out, ring(rate, r, 900 + r() * 1700, 220 + r() * 120, 0.0008, 0.03), Math.floor(at * rate), 0.08 + 0.15 * r(), false)
      }
      break
    }
  }
  // Round off the tail so a take never ends on a cliff
  const fade = Math.ceil(0.02 * rate)
  for (let k = 0; k < fade; k++) out[out.length - 1 - k] *= k / fade
  hp(out, 35, rate)
  return energyTo(out, 0.004 * SURFACE_ENERGY[surface], rate)
}

// —— voices: breath, hums, a little laugh, all nonverbal ————————————————

export type VoiceName =
  | 'kael-breath'
  | 'kael-exhale'
  | 'kael-charge'
  | 'kael-snort'
  | 'kael-sigh'
  | 'tala-breath'
  | 'tala-gasp'
  | 'tala-eh'
  | 'tala-call'
  | 'tala-laugh'
  | 'oru-hm'
  | 'oru-chuckle'
  | 'oru-yes'

export const VOICES: Record<NpcId, readonly VoiceName[]> = {
  kael: ['kael-breath', 'kael-exhale', 'kael-charge', 'kael-snort', 'kael-sigh'],
  tala: ['tala-breath', 'tala-gasp', 'tala-eh', 'tala-call', 'tala-laugh'],
  oru: ['oru-hm', 'oru-chuckle', 'oru-yes'],
}

type Formant = readonly [f: number, bw: number, g: number]
/** Closed-mouth hum (a nasal murmur), for an old man and for a girl. */
const NASAL_M: readonly Formant[] = [[260, 70, 1], [620, 240, 0.08], [2100, 220, 0.04], [2750, 280, 0.03]]
const NASAL_F: readonly Formant[] = [[300, 80, 1], [720, 260, 0.07], [2450, 260, 0.05], [3050, 300, 0.035]]
/** Breath out through the nose. */
const NOSE_OUT: readonly Formant[] = [[500, 320, 0.8], [1150, 420, 0.45], [2500, 700, 0.2]]
/** Breath drawn in through an open mouth. */
const MOUTH_IN: readonly Formant[] = [[950, 450, 0.5], [1650, 500, 0.7], [2650, 650, 0.55], [3800, 900, 0.3]]
/** A girl's short 'e'. */
const VOWEL_E_F: readonly Formant[] = [[590, 80, 1], [2050, 120, 0.5], [2900, 180, 0.28], [3950, 260, 0.1]]

/** Rosenberg glottal flow, phase 0..1. */
function glottis(p: number) {
  const tp = 0.42
  const tn = 0.16
  if (p < tp) return 0.5 * (1 - Math.cos((Math.PI * p) / tp))
  if (p < tp + tn) return Math.cos((0.5 * Math.PI * (p - tp)) / tn)
  return 0
}

/** A raised-cosine bump centred on `c` seconds, half-width `w`. */
const bump = (t: number, c: number, w: number) => (Math.abs(t - c) < w ? 0.5 * (1 + Math.cos((Math.PI * (t - c)) / w)) : 0)
/** Rise over `a` seconds, fall over the last `rl` seconds of `dur`. */
const env = (t: number, dur: number, a: number, rl: number) => smooth(0, a, t) * (1 - smooth(dur - rl, dur, t))

/**
 * Source-filter voice: a glottal pulse train (with jitter and shimmer) plus
 * breath noise, through parallel formant resonances. All curves take seconds.
 */
function voice(
  rate: number,
  r: Rng,
  dur: number,
  o: {
    f0: (t: number) => number
    amp: (t: number) => number
    voicing: (t: number) => number
    breath: (t: number) => number
    formants: readonly Formant[]
  },
) {
  const n = Math.ceil(dur * rate)
  const exc = new Float32Array(n)
  let ph = r()
  let gPrev = 0
  let jit = 0
  let shim = 1
  for (let i = 0; i < n; i++) {
    const t = i / rate
    jit = jit * 0.9992 + (r() - 0.5) * 0.0014
    const f = o.f0(t) * (1 + jit)
    ph += f / rate
    if (ph >= 1) {
      ph -= 1
      shim = 1 + (r() - 0.5) * 0.14
    }
    const g = glottis(ph)
    const dg = ((g - gPrev) * rate) / (f * 5)
    gPrev = g
    const v = o.voicing(t)
    const b = o.breath(t)
    // Breath rides the open glottis while voiced, and flows freely when not
    const asp = white(r) * b * (1 - 0.6 * v + 1.2 * v * g)
    exc[i] = (dg * shim * v + asp * 0.6) * o.amp(t)
  }
  const out = new Float32Array(n)
  const tmp = new Float32Array(n)
  for (const [f, bw, g] of o.formants) {
    tmp.set(exc)
    res(tmp, f, bw, rate)
    for (let i = 0; i < n; i++) out[i] += tmp[i] * g
  }
  lp(out, 6500, rate)
  hp(out, 55, rate)
  return out
}

/** Spear butt on the ground, once: a thump, the shaft's ring, the contact. `hard` is rock, else sand or earth. */
export function renderKnock(rate: number, r: Rng, hard: boolean) {
  const out = new Float32Array(Math.ceil(0.24 * rate))
  // The ground taking the blow
  const thump = new Float32Array(Math.ceil(0.2 * rate))
  addBurst(thump, 0, hard ? 0.0015 : 0.003, 1, rate, r, false)
  lp(thump, 500, rate)
  res(thump, 105 + r() * 25, hard ? 45 : 30, rate)
  addInto(out, peakTo(thump, 1), 0, hard ? 0.7 : 1, false)
  // The shaft, ringing (damped more in sand)
  const modes: readonly (readonly [number, number, number])[] = [[430, 28, 0.55], [990, 40, 0.38], [1760, 70, 0.2]]
  for (const [f, bw, g] of modes) {
    addInto(out, peakTo(ring(rate, r, f * (0.96 + r() * 0.08), bw * (hard ? 1 : 2.2), 0.0003, 0.2), 1), 0, g * (hard ? 0.7 : 0.4), false)
  }
  // The contact itself
  const c = new Float32Array(Math.ceil(0.02 * rate))
  addBurst(c, 0, hard ? 0.0005 : 0.0012, 1, rate, r, false)
  hp(c, hard ? 1800 : 900, rate)
  addInto(out, peakTo(c, 1), 0, hard ? 0.55 : 0.25, false)
  if (!hard) layer(out, rate, r, { at: 0.002, lo: 1500, hi: 5000, attack: 0.003, tau: 0.02, amp: 0.15, grain: 300 })
  hp(out, 45, rate)
  return peakTo(out, 0.95)
}

export function renderVoice(rate: number, r: Rng, name: VoiceName): Float32Array {
  let x: Float32Array
  switch (name) {
    case 'oru-hm': {
      // A low "hm" as he looks up: a breath through the nose that becomes a hum, falling
      const d = 0.55
      x = voice(rate, r, d, {
        f0: (t) => 104 - 18 * (t / d),
        amp: (t) => env(t, d, 0.05, 0.22),
        voicing: (t) => smooth(0.05, 0.12, t),
        breath: (t) => 0.9 - 0.75 * smooth(0.05, 0.12, t),
        formants: NASAL_M,
      })
      break
    }
    case 'oru-chuckle': {
      // A soft, amused chuckle through the nose: hm-hm-hm, each smaller, then the breath out
      const d = 0.95
      const c = [0.07, 0.24, 0.41, 0.57]
      const a = [1, 0.82, 0.6, 0.36]
      x = voice(rate, r, d, {
        f0: (t) => 114 - 16 * (t / d),
        amp: (t) => {
          let s = 0
          for (let k = 0; k < 4; k++) s += a[k] * bump(t, c[k], 0.065)
          return s + 0.3 * bump(t, 0.75, 0.15)
        },
        voicing: (t) => (t < 0.63 ? 0.7 : 0.08),
        breath: () => 0.4,
        formants: NASAL_M,
      })
      break
    }
    case 'oru-yes': {
      // "Mm-hm": taking what is offered
      const d = 0.62
      x = voice(rate, r, d, {
        f0: (t) => (t < 0.25 ? 100 + 12 * (t / 0.25) : 118 - 22 * ((t - 0.25) / 0.37)),
        amp: (t) => 0.8 * smooth(0.01, 0.05, t) * (1 - smooth(0.17, 0.23, t)) + smooth(0.27, 0.32, t) * (1 - smooth(0.48, 0.6, t)),
        voicing: () => 1,
        breath: () => 0.15,
        formants: NASAL_M,
      })
      break
    }
    case 'tala-breath': {
      // A quick breath in, mouth a little open
      const d = 0.34
      x = voice(rate, r, d, {
        f0: () => 300,
        amp: (t) => env(t, d, 0.06, 0.12),
        voicing: () => 0,
        breath: () => 1,
        formants: MOUTH_IN,
      })
      break
    }
    case 'tala-gasp': {
      // Sharper: something startled her
      const d = 0.22
      x = voice(rate, r, d, {
        f0: () => 320,
        amp: (t) => env(t, d, 0.012, 0.1),
        voicing: () => 0,
        breath: () => 1,
        formants: [[1100, 500, 0.6], [2000, 600, 0.8], [3000, 800, 0.6], [4200, 1000, 0.3]],
      })
      break
    }
    case 'tala-eh': {
      // A soft questioning "eh?", breathy, rising
      const d = 0.3
      x = voice(rate, r, d, {
        f0: (t) => 218 + 82 * (t / d) ** 1.6,
        amp: (t) => env(t, d, 0.03, 0.08),
        voicing: (t) => smooth(0.015, 0.05, t),
        breath: (t) => 0.75 - 0.4 * smooth(0.015, 0.05, t),
        formants: VOWEL_E_F,
      })
      break
    }
    case 'tala-call': {
      // Toward the old man: a short two-note "mm-mm?", the second rising
      const d = 0.5
      x = voice(rate, r, d, {
        f0: (t) => (t < 0.2 ? 236 : 252 + 46 * ((t - 0.2) / 0.3)),
        amp: (t) => 0.75 * smooth(0.01, 0.04, t) * (1 - smooth(0.13, 0.18, t)) + smooth(0.23, 0.27, t) * (1 - smooth(0.4, 0.49, t)),
        voicing: () => 1,
        breath: () => 0.15,
        formants: NASAL_F,
      })
      break
    }
    case 'tala-laugh': {
      // A soft laugh through the nose, two or three breaths of it
      const d = 0.55
      const c = [0.06, 0.2, 0.33]
      const a = [1, 0.72, 0.42]
      x = voice(rate, r, d, {
        f0: (t) => 256 - 22 * (t / d),
        amp: (t) => a[0] * bump(t, c[0], 0.05) + a[1] * bump(t, c[1], 0.05) + a[2] * bump(t, c[2], 0.05) + 0.25 * bump(t, 0.45, 0.09),
        voicing: () => 0.45,
        breath: () => 0.65,
        formants: NASAL_F,
      })
      break
    }
    case 'kael-breath': {
      // A slow breath out through the nose: he has seen you
      const d = 0.5
      x = voice(rate, r, d, {
        f0: () => 90,
        amp: (t) => smooth(0, 0.05, t) * Math.exp(-Math.max(0, t - 0.05) / 0.14),
        voicing: () => 0,
        breath: () => 1,
        formants: NOSE_OUT,
      })
      break
    }
    case 'kael-exhale': {
      // Squaring up: one sharp breath out through the nose
      const d = 0.32
      x = voice(rate, r, d, {
        f0: () => 90,
        amp: (t) => (1 - Math.exp(-t / 0.006)) * Math.exp(-t / 0.085),
        voicing: () => 0,
        breath: () => 1,
        formants: [[650, 350, 0.8], [1400, 500, 0.55], [2900, 800, 0.3]],
      })
      break
    }
    case 'kael-charge': {
      // Setting off: a harder breath, a little throat in it
      const d = 0.26
      x = voice(rate, r, d, {
        f0: (t) => 98 - 10 * (t / d),
        amp: (t) => (1 - Math.exp(-t / 0.004)) * Math.exp(-t / 0.07),
        voicing: () => 0.1,
        breath: () => 1,
        formants: [[700, 320, 0.8], [1300, 450, 0.5], [2700, 700, 0.3]],
      })
      break
    }
    case 'kael-snort': {
      // Scoffing at wet paper: a short snort, the soft palate fluttering
      const d = 0.32
      x = voice(rate, r, d, {
        f0: () => 90,
        amp: (t) => (t < 0.13 ? smooth(0, 0.01, t) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 32 * t)) : 0.6 * Math.exp(-(t - 0.13) / 0.06)),
        voicing: () => 0,
        breath: () => 1,
        formants: [[550, 300, 0.8], [1200, 450, 0.5], [2600, 700, 0.2]],
      })
      break
    }
    case 'kael-sigh': {
      // Giving ground: a long breath out, not quite a word
      const d = 0.85
      x = voice(rate, r, d, {
        f0: (t) => 88 - 8 * (t / d),
        amp: (t) => env(t, d, 0.15, 0.45),
        voicing: () => 0.1,
        breath: () => 1,
        formants: NOSE_OUT,
      })
      break
    }
  }
  return rmsTo(x, 0.1, 0.95)
}

/**
 * A recorded voice file made ready to play like a synthesised one: mono,
 * leading and trailing silence cut, a few ms of fade at each end, and the
 * same RMS as renderVoice gives, so VOICE_TRIM means the same for both.
 */
export function prepareVoiceFile(ctx: BaseAudioContext, raw: AudioBuffer) {
  const n = raw.length
  const mono = new Float32Array(n)
  for (let c = 0; c < raw.numberOfChannels; c++) {
    const d = raw.getChannelData(c)
    for (let i = 0; i < n; i++) mono[i] += d[i] / raw.numberOfChannels
  }
  const gate = peakOf(mono) * 0.03
  let a = 0
  while (a < n - 1 && Math.abs(mono[a]) < gate) a++
  let b = n - 1
  while (b > a && Math.abs(mono[b]) < gate * 0.5) b--
  const rate = raw.sampleRate
  a = Math.max(0, a - Math.floor(0.005 * rate))
  b = Math.min(n - 1, b + Math.floor(0.04 * rate))
  const x = mono.slice(a, b + 1)
  const fin = Math.min(x.length >> 2, Math.floor(0.004 * rate))
  const fout = Math.min(x.length >> 2, Math.floor(0.03 * rate))
  for (let k = 0; k < fin; k++) x[k] *= k / fin
  for (let k = 0; k < fout; k++) x[x.length - 1 - k] *= k / fout
  return toBuffer(ctx, rmsTo(x, 0.1, 0.95), rate)
}

// —— banks ——————————————————————————————————————————————————————

export type SoundBanks = {
  roar: AudioBuffer
  hiss: AudioBuffer
  crackle: AudioBuffer
  pops: AudioBuffer
  sputter: AudioBuffer
  snaps: AudioBuffer[]
  steps: Record<Surface, AudioBuffer[]>
  voices: Partial<Record<VoiceName, AudioBuffer>>
  knockSoft: AudioBuffer[]
  knockHard: AudioBuffer[]
}

function toBuffer(ctx: BaseAudioContext, data: Float32Array, rate: number) {
  const b = ctx.createBuffer(1, data.length, rate)
  b.copyToChannel(data as Float32Array<ArrayBuffer>, 0)
  return b
}

/**
 * The banks as a list of small jobs, in the order they are needed: the fire's
 * loops first, then feet, then voices. The live game runs one a frame; an
 * audition runs them all at once.
 */
export function bankJobs(ctx: BaseAudioContext, lowPower: boolean, seed = 7): { banks: SoundBanks; jobs: (() => void)[] } {
  const rate = ctx.sampleRate
  // Loops at half rate on a phone: a quarter of the memory, nothing lost below 11 kHz
  const loopRate = lowPower ? Math.min(rate, 24000) : rate
  const variants = lowPower ? 4 : 6
  const r = makeRng(seed)
  const banks = {
    snaps: [],
    steps: { sand: [], 'wet-sand': [], earth: [], leaves: [], rock: [], wade: [] },
    voices: {},
    knockSoft: [],
    knockHard: [],
  } as unknown as SoundBanks
  const jobs: (() => void)[] = [
    () => (banks.roar = toBuffer(ctx, renderFireRoar(loopRate, r, lowPower ? 5.1 : 6.1), loopRate)),
    () => (banks.crackle = toBuffer(ctx, renderFireCrackle(loopRate, r, lowPower ? 6.3 : 7.7), loopRate)),
    () => (banks.pops = toBuffer(ctx, renderFirePops(loopRate, r, lowPower ? 7.1 : 9.3), loopRate)),
    () => (banks.hiss = toBuffer(ctx, renderFireHiss(loopRate, r, lowPower ? 4.3 : 5.3), loopRate)),
    () => (banks.sputter = toBuffer(ctx, renderFireSputter(loopRate, r, lowPower ? 5.3 : 6.7), loopRate)),
    () => {
      for (let i = 0; i < variants; i++) banks.snaps.push(toBuffer(ctx, renderFireSnap(rate, r), rate))
    },
  ]
  for (const s of SURFACES) {
    jobs.push(() => {
      for (let i = 0; i < variants; i++) banks.steps[s].push(toBuffer(ctx, renderStep(rate, r, s, i), rate))
    })
  }
  jobs.push(() => {
    for (let i = 0; i < 3; i++) {
      banks.knockSoft.push(toBuffer(ctx, renderKnock(rate, r, false), rate))
      banks.knockHard.push(toBuffer(ctx, renderKnock(rate, r, true), rate))
    }
  })
  for (const id of ['kael', 'tala', 'oru'] as const) {
    for (const v of VOICES[id]) jobs.push(() => (banks.voices[v] = toBuffer(ctx, renderVoice(rate, r, v), rate)))
  }
  return { banks, jobs }
}

// —— levels ——————————————————————————————————————————————————————

/**
 * Layer levels at full night, before distance. Tuned against the sea in the
 * running game (see the report in shots/sound): at 3 m the fire sits under
 * the surf at the waterline, and its peaks stay well clear of the limiter.
 */
export const FIRE_LEVEL = { roar: 0.24, hiss: 0.036, crackle: 0.4, pops: 0.42, sputter: 0.09, snap: 0.4 }
/** Footfalls and voices, before distance and each person's own weight. */
export const STEP_LEVEL = 0.55
export const VOICE_LEVEL = 0.3
/** Most one-shots alive at once, across fire snaps, feet and voices; feet and snaps leave two of them for voices. */
export const ONE_SHOT_CAP = 10
const STEP_CAP = 8

/** Each islander's feet and voice. */
const PEOPLE: Record<NpcId, { step: number; rateLo: number; rateHi: number; voice: number }> = {
  // Heavy, flat-footed, the spear's weight on him
  kael: { step: 0.85, rateLo: 0.86, rateHi: 0.94, voice: 1 },
  // Light on her feet
  tala: { step: 0.6, rateLo: 1.08, rateHi: 1.18, voice: 0.9 },
  // Slow and soft
  oru: { step: 0.5, rateLo: 0.9, rateHi: 0.96, voice: 1 },
}

/** Per-voice trim after the RMS match, so a breath and a hum sit at about the same weight. */
const VOICE_TRIM: Record<VoiceName, number> = {
  'kael-breath': 0.7,
  'kael-exhale': 0.9,
  'kael-charge': 0.9,
  'kael-snort': 0.8,
  'kael-sigh': 0.6,
  'tala-breath': 0.6,
  'tala-gasp': 0.7,
  'tala-eh': 0.6,
  'tala-call': 0.6,
  'tala-laugh': 0.6,
  'oru-hm': 0.75,
  'oru-chuckle': 0.7,
  'oru-yes': 0.7,
}
const KNOCK_LEVEL = 0.32

// —— the engine: one graph in any context ————————————————————————————

export type FireInput = Pick<CampFireState, 'night' | 'strength' | 'storm' | 'flicker'>

export type PersonVoice = {
  id: NpcId
  panner: PannerNode
  stepIn: GainNode
  voiceIn: GainNode
  /** Kael's spear knocks: a deliberate signal, so they carry further than a breath. */
  farIn: GainNode
  /** Listener distance last frame, metres. */
  d: number
  heard: boolean
  lastVoice: number
  lastKnock: number
  lastSteps: number
  lastTake: number
}

function makePanner(ctx: BaseAudioContext, ref: number, rolloff: number) {
  const p = ctx.createPanner()
  p.panningModel = 'equalpower'
  p.distanceModel = 'inverse'
  p.refDistance = ref
  p.rolloffFactor = rolloff
  p.maxDistance = 10000
  return p
}

/** Move a panner (or the listener) without a node or an allocation; `jump` sets it at once. */
function placeParam(param: AudioParam, v: number, when: number, jump: boolean) {
  if (jump) {
    param.cancelScheduledValues(when)
    param.setValueAtTime(v, when)
  } else param.setTargetAtTime(v, when, 0.025)
}
export function placePanner(p: PannerNode, x: number, y: number, z: number, when: number, jump = false) {
  if (p.positionX) {
    placeParam(p.positionX, x, when, jump)
    placeParam(p.positionY, y, when, jump)
    placeParam(p.positionZ, z, when, jump)
  } else p.setPosition(x, y, z)
}

export function createEngine(ctx: BaseAudioContext, dest: AudioNode, banks: SoundBanks, seed = 11) {
  const r = makeRng(seed)
  const stats = { live: 0, maxLive: 0, started: 0, ended: 0, dropped: 0, persistent: 0 }
  const node = <T extends AudioNode>(n: T) => {
    stats.persistent++
    return n
  }

  function shot(buf: AudioBuffer, to: AudioNode, gain: number, rate: number, when: number, limit: number) {
    if (stats.live >= limit) {
      stats.dropped++
      return false
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = ctx.createGain()
    g.gain.value = gain
    src.connect(g).connect(to)
    stats.live++
    stats.started++
    if (stats.live > stats.maxLive) stats.maxLive = stats.live
    src.onended = () => {
      stats.live--
      stats.ended++
      src.disconnect()
      g.disconnect()
    }
    src.start(when)
    return true
  }

  // —— the fire ——
  const firePan = node(makePanner(ctx, 2.5, 1))
  const fireWin = node(ctx.createGain())
  const fireMix = node(ctx.createGain())
  fireMix.connect(fireWin).connect(firePan)
  let fireConnected = false
  const loop = (buf: AudioBuffer) => {
    const src = node(ctx.createBufferSource())
    src.buffer = buf
    src.loop = true
    const g = node(ctx.createGain())
    g.gain.value = 0
    src.connect(g).connect(fireMix)
    src.start(0, r() * buf.duration)
    return g
  }
  const gRoar = loop(banks.roar)
  const gHiss = loop(banks.hiss)
  const gCrackle = loop(banks.crackle)
  const gPops = loop(banks.pops)
  const gSputter = loop(banks.sputter)
  const snapBus = node(ctx.createGain())
  snapBus.connect(fireMix)
  let activity = 1
  let activityWant = 1
  let activityT = 0
  let snapT = 1 + r() * 3
  let lastSnap = -1

  /** The fire for a span of `dt` seconds from `when`: layer levels, and any big snap due in it (when `snaps`). */
  function fire(f: FireInput, wet: number, when: number, dt: number, snaps: boolean, limit = STEP_CAP) {
    const n = clamp01(f.night)
    const w = clamp01(wet)
    // The crackle swells and settles on its own, a few times a minute
    activityT -= dt
    if (activityT <= 0) {
      activityT = 0.3 + r() * 1.1
      activityWant = 0.55 + r() * 0.9
    }
    activity += (activityWant - activity) * (1 - Math.exp(-dt * 2.2))
    const flick = clamp(0.9 + 0.5 * (f.flicker - 0.8), 0.7, 1.15)
    const L = FIRE_LEVEL
    gRoar.gain.setTargetAtTime(L.roar * (0.42 + 0.58 * n) * (1 - 0.35 * w) * flick, when, 0.12)
    gHiss.gain.setTargetAtTime(L.hiss * (0.3 + 0.7 * n) * (1 - 0.5 * w), when, 0.2)
    gCrackle.gain.setTargetAtTime(L.crackle * (0.18 + 0.82 * n) * (1 - 0.8 * w) * activity, when, 0.15)
    gPops.gain.setTargetAtTime(L.pops * (0.32 + 0.68 * n) * (1 - 0.65 * w) * (0.75 + 0.25 * activity), when, 0.2)
    gSputter.gain.setTargetAtTime(L.sputter * w * (0.55 + 0.45 * clamp01(f.strength)), when, 0.4)
    // A big crack now and then: every few seconds at night, rarely by day, seldom in the wet
    snapT -= dt
    if (snapT <= 0) {
      const mean = (9 - 6 * n) * (1 + 2 * w)
      snapT = 0.4 + -Math.log(1 - r() * 0.999) * mean
      if (snaps && banks.snaps.length) {
        let k = Math.floor(r() * banks.snaps.length)
        if (k === lastSnap) k = (k + 1) % banks.snaps.length
        lastSnap = k
        const g = L.snap * (0.45 + 0.55 * r()) * (0.45 + 0.55 * n) * (1 - 0.6 * w)
        shot(banks.snaps[k], snapBus, g, 0.85 + r() * 0.3, when + r() * dt, limit)
      }
    }
  }

  function connectFire(on: boolean) {
    if (on === fireConnected) return
    fireConnected = on
    if (on) firePan.connect(dest)
    else firePan.disconnect()
  }

  // —— the people ——
  const people = (['kael', 'tala', 'oru'] as const).map((id): PersonVoice => {
    // A gentle rolloff: bare feet on sand at 7 m still just carry over a beach's surf
    const panner = node(makePanner(ctx, 1.4, 1))
    const stepIn = node(ctx.createGain())
    const tone = node(ctx.createBiquadFilter())
    if (id === 'kael') {
      tone.type = 'lowshelf'
      tone.frequency.value = 220
      tone.gain.value = 4
    } else if (id === 'tala') {
      tone.type = 'highpass'
      tone.frequency.value = 170
      tone.Q.value = 0.6
    } else {
      tone.type = 'lowpass'
      tone.frequency.value = 2400
      tone.Q.value = 0.5
    }
    const voiceIn = node(ctx.createGain())
    const farIn = node(ctx.createGain())
    stepIn.connect(tone).connect(panner)
    voiceIn.connect(panner)
    farIn.connect(panner)
    panner.connect(dest)
    return { id, panner, stepIn, voiceIn, farIn, d: Infinity, heard: false, lastVoice: -Infinity, lastKnock: -Infinity, lastSteps: -1, lastTake: -1 }
  })

  /** One footfall. `weight` 0..1 is how much of a walk, `run` 0..1 of a run, `speed` m/s. */
  function step(p: PersonVoice, surface: Surface, weight: number, run: number, speed: number, when: number, limit = STEP_CAP) {
    const bank = banks.steps[surface]
    if (!bank.length) return false
    const P = PEOPLE[p.id]
    let k = Math.floor(r() * bank.length)
    if (k === p.lastTake) k = (k + 1) % bank.length
    p.lastTake = k
    // Kael's charge comes down harder; everyone treads harder the faster they go
    const pace = 0.55 + 0.45 * clamp01(speed / 1.3)
    const charge = p.id === 'kael' ? 1 + 0.5 * clamp01(run) : 1
    const g = STEP_LEVEL * P.step * pace * charge * (0.5 + 0.5 * clamp01(weight)) * (0.88 + 0.24 * r())
    const rate = P.rateLo + (P.rateHi - P.rateLo) * r() + (p.id === 'kael' ? 0.06 * clamp01(run) : 0)
    return shot(bank[k], p.stepIn, g, rate, when, limit)
  }

  function say(p: PersonVoice, name: VoiceName, when: number, limit = ONE_SHOT_CAP) {
    const buf = banks.voices[name]
    if (!buf) return false
    p.lastVoice = when
    return shot(buf, p.voiceIn, VOICE_LEVEL * PEOPLE[p.id].voice * VOICE_TRIM[name], 0.97 + 0.06 * r(), when, limit)
  }

  /**
   * "Tuk. Tuk.": the spear butt, twice. He means it to be heard, so from further
   * off it is struck harder (`d`, metres: up to 3x from 6 m out).
   */
  function knock(p: PersonVoice, hard: boolean, when: number, d = 0, limit = ONE_SHOT_CAP) {
    const bank = hard ? banks.knockHard : banks.knockSoft
    if (!bank.length) return
    p.lastKnock = when
    const g = KNOCK_LEVEL * clamp(d / 6, 1, 3)
    const k = Math.floor(r() * bank.length)
    shot(bank[k], p.farIn, g, 0.97 + 0.05 * r(), when, limit)
    shot(bank[(k + 1) % bank.length], p.farIn, g * 0.85, 0.95 + 0.05 * r(), when + 0.4 + 0.06 * r(), limit)
  }

  return {
    ctx,
    stats,
    firePan,
    fireWin,
    fireMix,
    connectFire,
    get fireConnected() {
      return fireConnected
    },
    fire,
    people,
    step,
    say,
    knock,
    rng: r,
  }
}

export type IslandEngine = ReturnType<typeof createEngine>

// —— the live game —————————————————————————————————————————————————

export type IslandSoundOptions = {
  /** The shared context and bus, or null until sound unlocks (oceanAudio.getWorldOutput). */
  output: () => { ctx: AudioContext; bus: AudioNode } | null
  /** The camp fire's flames as drawn (heistProps.fire). */
  fire: Readonly<CampFireState>
  firePos: THREE.Vector3
  npcs: readonly { readonly id: NpcId; readonly rig: IslanderRig }[]
  /** Terrain height (island.heightAt). */
  heightAt: (x: number, z: number) => number
  /** True where an islander would stand on bare rock (the caves' shelves). */
  rockAt?: (x: number, z: number) => boolean
  lowPower: boolean
  /** ?voices=0 turns the voices (and the spear knocks) off. */
  voices?: boolean
  /** ?tribesound=0 turns all of this off. */
  enabled?: boolean
}

/** Footfalls carry about this far, voices this far; the fire is gone past FIRE_GONE. */
const STEP_NEAR = 10
const STEP_FAR = 16
const VOICE_NEAR = 15
const VOICE_FAR = 22
const KNOCK_NEAR = 24
const KNOCK_FAR = 34
const FIRE_NEAR = 42
const FIRE_FAR = 70
const FIRE_GONE = 85
/** The camp's worn ground, round the fire. */
const CAMP_R = 15

export type StepLog = { perf: number; ctxTime: number; id: NpcId; side: number; surface: Surface; played: boolean }
export type CueLog = { perf: number; ctxTime: number; id: NpcId; cue: TribeCue; sound: string }

export function createIslandSound(o: IslandSoundOptions) {
  const enabled = o.enabled !== false
  const family = { fire: true, steps: true, voices: o.voices !== false }
  let ctx: AudioContext | null = null
  let bus: AudioNode | null = null
  let built: ReturnType<typeof bankJobs> | null = null
  let eng: IslandEngine | null = null
  let islandBus: GainNode | null = null
  let muffle: BiquadFilterNode | null = null
  let firstListen = true
  let lastUnder = -1
  /** Delayed voice: Tala's "eh?" a moment after she has seen you, if you are still there. */
  const later = { active: false, at: 0, who: 0, name: 'tala-eh' as VoiceName }
  /** Dev: what played when, for checking against the feet you see land. */
  let stepLog: StepLog[] | null = null
  let cueLog: CueLog[] | null = null
  const fwd = { x: 0, y: 0, z: -1 }
  const up = { x: 0, y: 1, z: 0 }
  /** The rigs in the engine's order: Kael, Tala, Oru. */
  const rigs = (['kael', 'tala', 'oru'] as const).map((id) => o.npcs.find((n) => n.id === id)?.rig ?? null)

  function build() {
    const out = o.output()
    if (!out) return
    if (!built) {
      ctx = out.ctx
      bus = out.bus
      built = bankJobs(ctx, o.lowPower)
    }
    // One bank a frame, so the first touch on a phone never stalls
    const job = built.jobs.shift()
    if (job) {
      job()
      return
    }
    islandBus = ctx!.createGain()
    islandBus.gain.value = 1
    muffle = ctx!.createBiquadFilter()
    muffle.type = 'lowpass'
    muffle.frequency.value = 18000
    muffle.Q.value = 0.5
    islandBus.connect(muffle).connect(bus!)
    eng = createEngine(ctx!, islandBus, built.banks)
    eng.stats.persistent += 2
    placePanner(eng.firePan, o.firePos.x, o.firePos.y + 0.4, o.firePos.z, ctx!.currentTime, true)
    // Recorded voices, where they ship: at once on a desktop; on a phone not until someone is near
    if (!o.lowPower) void loadVoiceFiles()
  }

  let filesAsked = false
  /** Swap in any recorded voices that ship (voice-files.ts). Fail-soft: a file that won't load leaves the synthesised one. */
  async function loadVoiceFiles() {
    if (filesAsked || !ctx || !built) return
    filesAsked = true
    for (const name of VOICE_FILES) {
      try {
        const res = await fetch(`/audio/voices/${name}.mp3`, { signal: AbortSignal.timeout(8000) })
        if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('audio')) continue
        built.banks.voices[name] = prepareVoiceFile(ctx, await ctx.decodeAudioData(await res.arrayBuffer()))
      } catch {
        // Missing or undecodable: the synthesised voice stays
      }
    }
  }

  function surfaceAt(x: number, z: number, wade: number): Surface {
    if (wade > 0.12) return 'wade'
    const h = o.heightAt(x, z)
    if (h < tideNow + 0.55) return 'wet-sand'
    if (o.rockAt?.(x, z)) return 'rock'
    if (Math.hypot(x - o.firePos.x, z - o.firePos.z) < CAMP_R) return 'earth'
    if (h < 2.6) return 'sand'
    // Steep ground on the island is bare basalt; the forest floor is litter
    const gx = o.heightAt(x + 0.8, z) - o.heightAt(x - 0.8, z)
    const gz = o.heightAt(x, z + 0.8) - o.heightAt(x, z - 0.8)
    if (h > 48 || Math.hypot(gx, gz) / 1.6 > 0.75) return 'rock'
    return 'leaves'
  }

  let tideNow = 0

  /**
   * Per frame, after tribe.update. `submersion` is the eye's (0 dry … 1 under),
   * `rain` the climate's 0..1, `tide` the sea level.
   */
  function update(dt: number, camera: THREE.Camera, submersion: number, rain: number, tide: number) {
    if (!enabled) return
    if (!eng) {
      // Nothing to hear until the camp or an islander is in reach: the drop and the open sea never pay for the banks
      const cp = camera.position
      const near =
        Math.hypot(cp.x - o.firePos.x, cp.z - o.firePos.z) < 220 || rigs.some((g) => g !== null && g.root.visible)
      if (built || near) build()
      return
    }
    const c = ctx!
    if (c.state !== 'running') return
    tideNow = tide
    const now = c.currentTime
    // —— the listener is the camera ——
    const L = c.listener
    const cp = camera.position
    // Forward (0,0,-1) and up (0,1,0) turned by the camera's quaternion, without a Vector3:
    // v' = v + w t + q × t, with t = 2 q × v
    const { x: qx, y: qy, z: qz, w: qw } = camera.quaternion
    let tx = -2 * qy
    let ty = 2 * qx
    fwd.x = qw * tx - qz * ty
    fwd.y = qw * ty + qz * tx
    fwd.z = -1 + qx * ty - qy * tx
    tx = -2 * qz
    const tz = 2 * qx
    up.x = qw * tx + qy * tz
    up.y = 1 + qz * tx - qx * tz
    up.z = qw * tz - qy * tx
    const jump = firstListen
    firstListen = false
    if (L.positionX) {
      placeParam(L.positionX, cp.x, now, jump)
      placeParam(L.positionY, cp.y, now, jump)
      placeParam(L.positionZ, cp.z, now, jump)
      placeParam(L.forwardX, fwd.x, now, jump)
      placeParam(L.forwardY, fwd.y, now, jump)
      placeParam(L.forwardZ, fwd.z, now, jump)
      placeParam(L.upX, up.x, now, jump)
      placeParam(L.upY, up.y, now, jump)
      placeParam(L.upZ, up.z, now, jump)
    } else {
      L.setPosition(cp.x, cp.y, cp.z)
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z)
    }

    // —— under the surface: dark and quiet, by the sea layers' own rule ——
    const underW = clamp01((submersion - 0.12) / 0.72)
    if (Math.abs(underW - lastUnder) > 0.002) {
      lastUnder = underW
      islandBus!.gain.setTargetAtTime(1 - 0.85 * underW, now, 0.06)
      muffle!.frequency.setTargetAtTime(480 * Math.pow(37, 1 - underW), now, 0.06)
    }

    // —— the fire ——
    const dFire = Math.hypot(cp.x - o.firePos.x, cp.y - o.firePos.y, cp.z - o.firePos.z)
    if (dFire < FIRE_GONE - 5) eng.connectFire(true)
    else if (dFire > FIRE_GONE) eng.connectFire(false)
    if (dFire < FIRE_GONE) {
      const wet = clamp01(Math.max(rain, (o.fire.storm - 0.3) / 0.6))
      const on = family.fire && o.fire.burning ? 1 : 0
      eng.fireWin.gain.setTargetAtTime(on * (1 - smooth(FIRE_NEAR, FIRE_FAR, dFire)), now, 0.1)
      eng.fire(o.fire, wet, now, Math.min(dt, 0.1), dFire < FIRE_FAR && on === 1)
    }

    // —— the people ——
    for (let i = 0; i < eng.people.length; i++) {
      const p = eng.people[i]
      const rig = rigs[i]
      if (!rig) continue
      const rp = rig.root.position
      const d = Math.hypot(cp.x - rp.x, cp.y - (rp.y + 0.9), cp.z - rp.z)
      p.d = d
      if (!filesAsked && d < 45 && rig.root.visible) void loadVoiceFiles()
      const was = p.heard
      p.heard = rig.root.visible && d < KNOCK_FAR + 4
      if (p.heard) {
        placePanner(p.panner, rp.x, rp.y + 0.9, rp.z, now, !was)
        p.stepIn.gain.setTargetAtTime(family.steps ? 1 - smooth(STEP_NEAR, STEP_FAR, d) : 0, now, 0.1)
        p.voiceIn.gain.setTargetAtTime(family.voices ? 1 - smooth(VOICE_NEAR, VOICE_FAR, d) : 0, now, 0.1)
        p.farIn.gain.setTargetAtTime(family.voices ? 1 - smooth(KNOCK_NEAR, KNOCK_FAR, d) : 0, now, 0.1)
      } else if (was) {
        p.stepIn.gain.setTargetAtTime(0, now, 0.1)
        p.voiceIn.gain.setTargetAtTime(0, now, 0.1)
        p.farIn.gain.setTargetAtTime(0, now, 0.1)
      }
      const g = rig.gait
      if (g.steps !== p.lastSteps) {
        const first = p.lastSteps < 0
        p.lastSteps = g.steps
        if (first || !p.heard || d > STEP_FAR || !family.steps) continue
        const surface = surfaceAt(rp.x, rp.z, g.wade)
        const played = eng.step(p, surface, g.weight, g.run, g.speed, now)
        stepLog?.push({ perf: performance.now(), ctxTime: now, id: p.id, side: g.side, surface, played })
      }
    }

    if (later.active && now >= later.at) {
      later.active = false
      const p = eng.people[later.who]
      if (family.voices && p.heard && p.d < 16) eng.say(p, later.name, now)
    }
  }

  /** From the tribe sim's onCue: a moment in an encounter, voiced sparingly. */
  function cue(id: NpcId, what: TribeCue) {
    if (!eng || !ctx || !family.voices || ctx.state !== 'running') return
    const i = id === 'kael' ? 0 : id === 'tala' ? 1 : 2
    const p = eng.people[i]
    // Breath and hums are close sounds; only the spear's knock carries past VOICE_FAR
    if (!p.heard || p.d > (what === 'warn' ? KNOCK_FAR : VOICE_FAR)) return
    const now = ctx.currentTime
    const r = eng.rng
    const since = now - p.lastVoice
    let sound = ''
    const say = (name: VoiceName, delay: number) => {
      if (eng!.say(p, name, now + delay)) sound = sound ? `${sound}+${name}` : name
    }
    if (id === 'oru') {
      // He looks up slowly: the "hm" comes a beat after the look, and not every time
      if ((what === 'look' && since > 22) || (what === 'notice' && since > 10)) {
        if (what === 'notice' || r() < 0.8) say('oru-hm', 0.35 + r() * 0.5)
      } else if (what === 'laugh') say('oru-chuckle', 0.15)
      else if (what === 'accept') say('oru-yes', 0.3)
    } else if (id === 'tala') {
      if (what === 'notice' && since > 6) {
        say('tala-breath', 0.05 + r() * 0.1)
        const oru = eng.people[2]
        const oruRig = rigs[2]
        const talaRig = rigs[1]
        const apart = oruRig && talaRig ? oruRig.root.position.distanceTo(talaRig.root.position) : Infinity
        if (r() < 0.5) Object.assign(later, { active: true, at: now + 1.3 + r() * 0.9, who: 1, name: 'tala-eh' })
        else if (apart > 6 && apart < 30 && oru.heard) Object.assign(later, { active: true, at: now + 1.6 + r() * 0.8, who: 1, name: 'tala-call' })
      } else if (what === 'wary' && since > 3) say('tala-gasp', 0)
      else if (what === 'laugh') say('tala-laugh', 0.1)
      else if (what === 'accept') say('tala-breath', 0.1)
    } else {
      if (what === 'notice' && since > 12) {
        if (r() < 0.6) say('kael-breath', 0.25 + r() * 0.3)
      } else if (what === 'warn') {
        // The sharp breath as he squares up is the one sound of his that always comes: just after any breath still sounding
        if (p.d < VOICE_FAR) say('kael-exhale', Math.max(0, p.lastVoice + 0.55 - now))
        // The butt of the spear on the ground, twice: on rock it cracks, in sand it thuds
        const kael = rigs[0]
        if (kael && now - p.lastKnock > 10) {
          const rp = kael.root.position
          eng.knock(p, surfaceAt(rp.x, rp.z, 0) === 'rock', now + 0.4, p.d)
          sound += '+knock'
        }
      } else if (what === 'chase') say('kael-charge', 0)
      else if (what === 'calm') say('kael-sigh', 0.2)
      else if (what === 'laugh') say('kael-snort', 0.2)
      else if (what === 'accept') say('kael-breath', 0.2)
    }
    cueLog?.push({ perf: performance.now(), ctxTime: now, id, cue: what, sound })
  }

  return {
    update,
    cue,
    /** Dev: on/off per family, for A/B against the bare mix. */
    setFamily(which: 'fire' | 'steps' | 'voices', on: boolean) {
      family[which] = on
    },
    get family() {
      return { ...family }
    },
    get ready() {
      return eng !== null
    },
    get stats() {
      return eng ? { ...eng.stats, fireConnected: eng.fireConnected } : null
    },
    /** Dev: start keeping step and cue logs (they are off in a normal game). */
    startLogs() {
      stepLog = []
      cueLog = []
    },
    get logs() {
      return { steps: stepLog, cues: cueLog }
    },
    /** Dev: the bus all of this goes into (before the muffle and the ambient bus). */
    get bus() {
      return islandBus
    },
    get engine() {
      return eng
    },
    surfaceAt: (x: number, z: number, wade = 0) => surfaceAt(x, z, wade),
  }
}

export type IslandSound = ReturnType<typeof createIslandSound>
