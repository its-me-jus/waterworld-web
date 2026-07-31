/**
 * The day and the weather — one clock that every other system reads.
 *
 * A full day is ~8 real minutes so night arrives within a run. Storms roll
 * through every few minutes: swell climbs, the sky closes, the wash gets
 * louder, and swimming costs more. Nothing here draws — it only names the
 * numbers the ocean, sky, audio and vitals already know how to feel.
 */

export type Climate = {
  /** 0..1 through the day, midnight at 0 / 1. */
  dayPhase: number
  /** Sun elevation in degrees — negative once it's under the horizon. */
  sunElevation: number
  sunAzimuth: number
  /** 0 clear night … 1 noon. */
  daylight: number
  /** 0 clear … 1 full squall. */
  storm: number
  /** How hard the water is to swim through — 1 in a calm, higher in a storm. */
  swimCost: number
  /** Extra warmth drain multiplier (night + being wet in a storm). */
  cold: number
  /** 0..1 how hard the jellies should glow. */
  biolum: number
}

/** Real seconds for one full day cycle. */
export const DAY_LENGTH = 480
/** First squall arrives after this many seconds of calm. */
const STORM_FIRST = 95
/** Quiet stretch between the end of one squall and the start of the next. */
const STORM_GAP = 155
/** How long a squall spends at full force, not counting the ramps. */
const STORM_HOLD = 48
const STORM_RAMP = 22

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (a: number, b: number, t: number) => {
  const x = clamp01((t - a) / Math.max(1e-6, b - a))
  return x * x * (3 - 2 * x)
}

/**
 * Sun height across a day. Peaks near noon, dips well below the horizon at
 * night so Sky.js actually goes dark instead of hanging a dim sun in the mist.
 */
function sunElevation(phase: number) {
  // phase 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk
  const hour = phase * 24
  if (hour < 5) return -18
  if (hour < 7) return -18 + 28 * smooth(5, 7, hour)
  if (hour < 12) return 10 + 52 * smooth(7, 12, hour)
  if (hour < 17) return 62 - 52 * smooth(12, 17, hour)
  if (hour < 19.5) return 10 - 28 * smooth(17, 19.5, hour)
  return -18
}

/** A raised-cosine pulse: 0 → 1 → 0 over ramp/hold/ramp. */
function stormEnvelope(age: number) {
  if (age < 0) return 0
  if (age < STORM_RAMP) return smooth(0, STORM_RAMP, age)
  if (age < STORM_RAMP + STORM_HOLD) return 1
  if (age < STORM_RAMP * 2 + STORM_HOLD) {
    return 1 - smooth(STORM_RAMP + STORM_HOLD, STORM_RAMP * 2 + STORM_HOLD, age)
  }
  return 0
}

export function createClimate(opts?: { hour?: number; storm?: number }) {
  // Start mid-morning so the first swim has light, then the day turns
  let elapsed = ((opts?.hour ?? 9.5) / 24) * DAY_LENGTH
  const forcedStorm = opts?.storm
  let stormAge = -STORM_FIRST
  let nextGap = STORM_GAP

  const state: Climate = {
    dayPhase: 0,
    sunElevation: 30,
    sunAzimuth: 155,
    daylight: 1,
    storm: 0,
    swimCost: 1,
    cold: 1,
    biolum: 0,
  }

  function update(dt: number) {
    elapsed += dt
    const phase = (elapsed / DAY_LENGTH) % 1
    state.dayPhase = phase

    const elev = sunElevation(phase)
    state.sunElevation = elev
    // Sun tracks west across the day
    state.sunAzimuth = 95 + phase * 170

    // Soft daylight curve — stays lit through golden hour, drops hard after
    const day = clamp01((elev + 6) / 48)
    state.daylight = day * day * (3 - 2 * day)

    if (forcedStorm !== undefined) {
      state.storm = clamp01(forcedStorm)
    } else {
      stormAge += dt
      const pulse = stormEnvelope(stormAge)
      if (stormAge > STORM_RAMP * 2 + STORM_HOLD + nextGap) {
        stormAge = 0
        // Slight jitter so storms don't land on a metronome
        nextGap = STORM_GAP + (Math.random() - 0.5) * 50
      }
      // Night storms hit a touch harder — less sun to burn them off
      state.storm = pulse * (0.85 + (1 - state.daylight) * 0.25)
    }

    state.swimCost = 1 + state.storm * 0.85
    // Night cold is the big one; a storm on top of wet is the killer
    state.cold = 1 + (1 - state.daylight) * 1.6 + state.storm * 0.55
    // Jellies only bother glowing once the day has gone
    state.biolum = clamp01((1 - state.daylight) * 1.35 - 0.15)

    return state
  }

  return { state, update }
}

export type ClimateClock = ReturnType<typeof createClimate>
