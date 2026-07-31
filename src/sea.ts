import { oceanState } from './waves'

/**
 * Sea state — the ocean's slow breathing.
 *
 * Two rhythms stacked on top of each other:
 *
 *  - Seasons: a long ~8-minute swell cycle with a faster ~3-minute chop cycle
 *    riding it. Heavy periods close in, hold, and ease off; you learn to read
 *    them because a rising sea makes every mile cost more.
 *  - Glass-offs: short, sudden calm spells (a minute or so) where the swell
 *    lies right down. They are the natural dive windows — the wreck sits still,
 *    visibility holds, and the surface stops shoving you around.
 *
 * The single output is `amp`, a multiplier on every wave's steepness. It is
 * published through `oceanState` so the CPU sampler (player, flotsam, splash)
 * and the GPU vertex shader flatten together — nothing bobs on a ghost sea.
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

export function createSeaState(events: SeaEvents = {}) {
  /** Current amplitude multiplier; ~0.55 glassy, ~1.3 heavy. */
  let amp = 1

  let glassLeft = -1
  let glassLength = 1
  let nextGlassIn = 150 + Math.random() * 180
  /** Set when a glass-off is active, for the fade in/out envelope. */
  let glassy = false

  function update(dt: number, t: number) {
    nextGlassIn -= dt
    if (glassy) {
      glassLeft -= dt
      if (glassLeft <= 0) {
        glassy = false
        nextGlassIn = 240 + Math.random() * 320
      }
    } else if (nextGlassIn <= 0) {
      glassy = true
      glassLength = 50 + Math.random() * 45
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
  }

  return {
    update,
    /** 0 = dead calm, 1 = as heavy as it gets. For audio / sky / UI. */
    get weight() {
      return Math.min(1, Math.max(0, (amp - 0.5) / 0.8))
    },
    get glassy() {
      return glassy
    },
    /** Debug/tuning: pin the sea glass-calm (?calm=1). */
    pinCalm() {
      glassy = true
      glassLength = 1e9
      glassLeft = 1e9
      nextGlassIn = 1e9
    },
  }
}
