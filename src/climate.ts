/**
 * The day and the weather — one clock that every other system reads.
 *
 * A full day is ~8 real minutes so night arrives within a run.
 *
 * Weather is not a metronome. The sea runs in *spells*: long stretches of fair
 * sky, a breezy afternoon, then — less often — something that closes over you.
 * Each spell picks its own strength and length, then rolls into the next over
 * a slow front, so weather arrives instead of switching. Fair weather is the
 * overwhelming majority of any run, which is what makes a gale mean something.
 *
 * Nothing here draws — it only names the numbers the ocean, sky, audio and
 * vitals already know how to feel.
 */

export type Regime = 'glass' | 'fair' | 'breezy' | 'unsettled' | 'squall' | 'gale'

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
  /**
   * 0 dry … 1 heavy precipitation. Derived from storm — audible rain and the
   * catch-pools fill harder once this climbs.
   */
  rain: number
  /**
   * Residual flash after a bolt (decays over ~0.4s). Sky reads this to punch
   * the horizon and key light white for a frame or two.
   */
  lightning: number
  /**
   * One-shot thunder intensity this frame (0 most frames). Audio plays the
   * clap when this is non-zero — delayed from the flash by distance.
   */
  thunder: number
  /** How hard the water is to swim through — 1 in a calm, higher in a storm. */
  swimCost: number
  /** Extra warmth drain multiplier (night + being wet in a storm). */
  cold: number
  /** 0..1 how hard the jellies should glow. */
  biolum: number
  /** What the sky is currently doing, for anything that wants to read ahead. */
  regime: Regime
  /** 1 in settled weather, 0 at the height of a gale — the inverse of trouble. */
  fair: number
}

/** Real seconds for one full day cycle. */
export const DAY_LENGTH = 480

/**
 * The weather table. `weight` is how often a spell is drawn, `hold` how long it
 * sits once it arrives — fair weather is both more likely *and* longer-lived,
 * so calm water dominates a run the way it dominates a real ocean.
 */
type Spell = {
  name: Regime
  /** Storm strength range this spell settles into. */
  storm: [number, number]
  /** Seconds it holds before the next front. */
  hold: [number, number]
  weight: number
}

const SPELLS: Spell[] = [
  { name: 'glass', storm: [0.0, 0.04], hold: [150, 300], weight: 20 },
  { name: 'fair', storm: [0.02, 0.12], hold: [240, 460], weight: 36 },
  { name: 'breezy', storm: [0.16, 0.32], hold: [140, 280], weight: 22 },
  { name: 'unsettled', storm: [0.38, 0.56], hold: [90, 170], weight: 13 },
  { name: 'squall', storm: [0.7, 0.92], hold: [45, 105], weight: 8 },
  { name: 'gale', storm: [0.94, 1.0], hold: [70, 130], weight: 1 },
]

/** Past this a spell counts as weather you'd rather not be swimming in. */
const FOUL = 0.35

/** Seconds a front takes to roll in — weather arrives, it doesn't switch. */
const FRONT = [26, 52] as const

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

export type ClimateOptions = {
  hour?: number
  /** Pin the storm strength (?storm=1) — skips the spell clock entirely. */
  storm?: number
  /** Deterministic weather, for the shot suite and the sim. */
  random?: () => number
}

export function createClimate(opts?: ClimateOptions) {
  // Start mid-morning so the first swim has light, then the day turns
  let elapsed = ((opts?.hour ?? 9.5) / 24) * DAY_LENGTH
  const forcedStorm = opts?.storm
  const rand = opts?.random ?? Math.random

  const pick = (from: Spell[]) => {
    let total = 0
    for (const s of from) total += s.weight
    let roll = rand() * total
    for (const s of from) {
      roll -= s.weight
      if (roll <= 0) return s
    }
    return from[from.length - 1]
  }

  const range = ([lo, hi]: readonly [number, number]) => lo + rand() * (hi - lo)

  /**
   * Two foul spells back to back reads as the game punishing you rather than
   * the sky doing its own thing, so weather always clears before it turns
   * again. The ocean gets to be cruel, not relentless.
   */
  function nextSpell(previous: Spell | null) {
    const settled = previous && previous.storm[1] > FOUL
    return pick(settled ? SPELLS.filter((s) => s.storm[1] <= FOUL) : SPELLS)
  }

  // Every run opens settled — the wreck deserves to be found in daylight and
  // flat water before the sky is allowed to have an opinion.
  let spell: Spell = SPELLS[1]
  let target = range(SPELLS[1].storm)
  let from = target
  let holdLeft = range([200, 320])
  let frontLeft = 0
  let frontLength = 1

  // Lightning lives on its own clock: storms charge a strike timer, the flash
  // is instant, and thunder follows after a distance delay so close squalls
  // crack sooner than a gale on the horizon.
  let nextStrikeIn = 10 + rand() * 18
  let thunderLeft = -1
  let thunderPower = 0

  const state: Climate = {
    dayPhase: 0,
    sunElevation: 30,
    sunAzimuth: 155,
    daylight: 1,
    storm: target,
    rain: 0,
    lightning: 0,
    thunder: 0,
    swimCost: 1,
    cold: 1,
    biolum: 0,
    regime: spell.name,
    fair: 1,
  }

  function advanceWeather(dt: number) {
    if (frontLeft > 0) {
      frontLeft -= dt
      const f = smooth(0, 1, 1 - Math.max(0, frontLeft) / frontLength)
      state.storm = from + (target - from) * f
      if (frontLeft <= 0) state.storm = target
      return
    }

    holdLeft -= dt
    // A spell breathes a little inside its own band, so even a fair afternoon
    // isn't a flat line
    const wander = Math.sin(elapsed * 0.021) * 0.5 + Math.sin(elapsed * 0.0073 + 2.1) * 0.5
    const band = (spell.storm[1] - spell.storm[0]) * 0.5
    state.storm = clamp01(target + wander * band * 0.35)

    if (holdLeft <= 0) {
      const next = nextSpell(spell)
      spell = next
      state.regime = next.name
      from = state.storm
      target = range(next.storm)
      holdLeft = range(next.hold)
      frontLength = range(FRONT)
      frontLeft = frontLength
    }
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
      state.regime = forcedStorm > 0.9 ? 'gale' : forcedStorm > FOUL ? 'squall' : 'fair'
    } else {
      advanceWeather(dt)
      // Night weather hits a touch harder — less sun to burn it off
      state.storm = clamp01(state.storm * (0.9 + (1 - state.daylight) * 0.18))
    }

    state.fair = 1 - clamp01((state.storm - 0.15) / 0.7)
    state.swimCost = 1 + state.storm * 0.85
    // Night cold is the big one; a storm on top of wet is the killer
    state.cold = 1 + (1 - state.daylight) * 1.6 + state.storm * 0.55
    // Jellies only bother glowing once the day has gone
    state.biolum = clamp01((1 - state.daylight) * 1.35 - 0.15)

    // Rain arrives once the sky has committed — soft drizzle in unsettled,
    // sheets in a squall. Keeps audio and catch-pools on the same curve.
    state.rain = clamp01((state.storm - 0.32) / 0.55)

    // —— lightning / thunder ————————————————————————————————
    state.thunder = 0
    state.lightning = Math.max(0, state.lightning - dt * 2.6)

    if (thunderLeft >= 0) {
      thunderLeft -= dt
      if (thunderLeft <= 0) {
        state.thunder = thunderPower
        thunderLeft = -1
      }
    }

    if (state.storm > 0.55) {
      nextStrikeIn -= dt * (0.55 + state.storm * 0.9)
      if (nextStrikeIn <= 0) {
        const power = 0.4 + state.storm * 0.55 * (0.55 + rand() * 0.45)
        state.lightning = Math.max(state.lightning, power)
        // Farther / lighter storms: longer gap between flash and boom
        thunderLeft = 0.35 + (1 - state.storm) * 2.6 + rand() * 1.4
        thunderPower = power * (0.5 + 0.5 * state.storm)
        nextStrikeIn = (5 + rand() * 16) / Math.max(0.4, state.storm)
      }
    } else {
      nextStrikeIn = Math.max(nextStrikeIn, 8 + rand() * 14)
    }

    return state
  }

  /**
   * Jump the clock — used when you rest under a lean-to. Weather keeps
   * ticking in short steps so a night's sleep can roll a front in, the same
   * as waiting it out awake.
   */
  function skip(seconds: number) {
    const step = 2
    let left = Math.max(0, seconds)
    while (left > 0) {
      const dt = Math.min(step, left)
      update(dt)
      left -= dt
    }
    return state
  }

  /** Real seconds from now until mid-morning (dayPhase ≈ 0.33 ≈ 8:00). */
  function secondsUntilDawn() {
    const phase = (elapsed / DAY_LENGTH) % 1
    const morning = 0.33
    const delta = phase < morning ? morning - phase : 1 - phase + morning
    return delta * DAY_LENGTH
  }

  function setElapsed(seconds: number) {
    elapsed = Math.max(0, seconds)
    update(0)
  }

  function getElapsed() {
    return elapsed
  }

  return { state, update, skip, setElapsed, getElapsed, secondsUntilDawn }
}

export type ClimateClock = ReturnType<typeof createClimate>
