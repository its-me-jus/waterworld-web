import { oceanState, WAVES } from './waves'

/**
 * Sea state — the ocean's slow breathing.
 *
 * Three rhythms stacked on top of each other:
 *
 *  - Seasons: a long ~8-minute swell cycle with a faster ~3-minute chop cycle
 *    riding it. Heavy periods close in, hold, and ease off; you learn to read
 *    them because a rising sea makes every mile cost more.
 *  - Glass-offs: short, sudden calm spells (a minute or so) where the swell
 *    lies right down. They are the natural dive windows — the wreck sits still,
 *    visibility holds, and the surface stops shoving you around.
 *  - Current: a slow drift along the dominant swell. Fair water nudges; a
 *    gale shoves. Glass kills it. The sea moves between your inputs.
 *
 * Amplitude (`amp`) is published through `oceanState` so the CPU sampler
 * (player, flotsam, splash) and the GPU vertex shader flatten together —
 * nothing bobs on a ghost sea. Current is read directly from this module.
 */

const TAU = Math.PI * 2

const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))

export type SeaEvents = {
  /** Fired once as a glass-off sets in. */
  onGlassOff?: () => void
  /** Fired once as the swell stands back up after a calm spell. */
  onSwellUp?: () => void
}

/** Dominant swell axis — current rides this, same as the player's orbital drift. */
const SWELL = (() => {
  const [dx, dz] = WAVES[0].direction
  const len = Math.hypot(dx, dz) || 1
  return { x: dx / len, z: dz / len }
})()

export type SeaCurrent = {
  /** Horizontal drift, metres per second. */
  x: number
  z: number
  /** Scalar strength — handy for wash-off and whispers. */
  strength: number
}

export function createSeaState(events: SeaEvents = {}) {
  /** Current amplitude multiplier; ~0.55 glassy, ~1.3 heavy. */
  let amp = 1

  let glassLeft = -1
  let glassLength = 1
  let nextGlassIn = 150 + Math.random() * 180
  /** Set when a glass-off is active, for the fade in/out envelope. */
  let glassy = false
  /** 1 under a settled sky, 0 in a gale — set from the climate clock. */
  let fair = 1
  /** Squall strength from climate — raises the drift under your stroke. */
  let storm = 0

  const drift: SeaCurrent = { x: 0, z: 0, strength: 0 }

  function update(dt: number, t: number) {
    // Glass-offs belong to fair weather. Under a settled sky they come around
    // often and hold; with a front overhead the water never gets the chance.
    nextGlassIn -= dt * (0.35 + fair * 1.3)
    if (glassy) {
      glassLeft -= dt
      // A front rolling in ends the calm early — that's the tell
      if (glassLeft <= 0 || fair < 0.35) {
        glassy = false
        nextGlassIn = 190 + Math.random() * 260
      }
    } else if (nextGlassIn <= 0 && fair > 0.6) {
      glassy = true
      glassLength = 60 + Math.random() * 70
      glassLeft = glassLength
    }

    // Seasons: slow primary + a secondary so it never metronomes
    const slow = Math.sin(t * (TAU / 490) + 1.7) * 0.5 + 0.5
    const mid = Math.sin(t * (TAU / 168) + 0.4) * 0.5 + 0.5
    let target = 0.76 + slow * 0.36 + mid * 0.16

    if (glassy) {
      // Ease into and out of the calm so the ocean doesn't snap flat
      const inF = Math.min(1, (glassLength - glassLeft) / 12)
      const outF = Math.min(1, glassLeft / 14)
      const hold = Math.min(inF, outF)
      target = Math.min(target, target + (0.56 - target) * hold)
    }

    const wasGlass = amp < 0.68
    // Very slow approach — the sea takes its time, that's the point
    amp = damp(amp, target, 0.09, dt)
    oceanState.amp = amp

    if (!wasGlass && amp < 0.68) events.onGlassOff?.()
    if (wasGlass && amp >= 0.68) events.onSwellUp?.()

    // Drift along the swell. Glass almost kills it; a gale doubles the shove.
    // A slow wander keeps the set from reading as a treadmill.
    const glassMul = glassy ? 0.12 + Math.min(1, glassLeft / 20) * 0.08 : 1
    const wander = 0.85 + 0.15 * Math.sin(t * 0.017 + 0.6)
    const strength =
      (0.28 + Math.max(0, amp - 0.55) * 0.95 + storm * 1.55) * glassMul * wander
    drift.x = SWELL.x * strength
    drift.z = SWELL.z * strength
    drift.strength = strength
  }

  function snapshot() {
    return {
      amp,
      glassy,
      glassLeft,
      glassLength,
      nextGlassIn,
    }
  }

  function restore(
    saved:
      | {
          amp: number
          glassy: boolean
          glassLeft: number
          glassLength: number
          nextGlassIn: number
        }
      | undefined,
  ) {
    if (!saved) return
    amp = Math.max(0.4, saved.amp)
    glassy = !!saved.glassy
    glassLeft = saved.glassLeft
    glassLength = Math.max(1e-3, saved.glassLength)
    nextGlassIn = Math.max(0, saved.nextGlassIn)
    oceanState.amp = amp
  }

  return {
    update,
    /** Feed the climate's fair-weather share in; glass-offs follow the sky. */
    setFair(value: number) {
      fair = Math.min(1, Math.max(0, value))
    },
    /** Squall strength — same 0..1 the waves and vitals already read. */
    setStorm(value: number) {
      storm = Math.min(1, Math.max(0, value))
    },
    /** 0 = dead calm, 1 = as heavy as it gets. For audio / sky / UI. */
    get weight() {
      return Math.min(1, Math.max(0, (amp - 0.5) / 0.8))
    },
    get glassy() {
      return glassy
    },
    /** Live set — player and raft read this each frame. */
    get current(): SeaCurrent {
      return drift
    },
    snapshot,
    restore,
    /** Debug/tuning: pin the sea glass-calm (?calm=1). */
    pinCalm() {
      glassy = true
      glassLength = 1e9
      glassLeft = 1e9
      nextGlassIn = 1e9
    },
  }
}
