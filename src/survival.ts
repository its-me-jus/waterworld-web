/**
 * What the ocean takes from you. There is no objective — the run is however
 * long you keep all of these off the floor. A living camp persists locally
 * across reloads; death starts you over.
 *
 * Everything is a 0..1 tank with a drain measured in seconds-to-empty, so the
 * numbers below read as "how long have I got".
 */

export type Cause = 'drowned' | 'exposure' | 'thirst' | 'hunger' | 'taken'

export type Vitals = {
  breath: number
  stamina: number
  warmth: number
  water: number
  food: number
  /**
   * The tired timer. Wakefulness spends it slowly, hard work spends it fast,
   * and only sleep buys it back — a nap a little, a night under a roof most
   * of it. It never kills you; it just makes everything slower.
   */
  energy: number
  health: number
  alive: boolean
  cause: Cause | null
  /** Seconds survived this run. */
  elapsed: number
  /** The shark's mark: bleeding until it clots. A second bite ends the run. */
  wounded: boolean
  woundClock: number
  /** Wearing the ship's immersion suit — the sea takes heat far slower. */
  suited: boolean
  /** Whisper latches — each line fires once per decline, re-arms on recovery. */
  saidKnot: boolean
  saidGnaw: boolean
  saidSalt: boolean
  saidLead: boolean
  saidCold: boolean
  saidDrowsy: boolean
  saidSpent: boolean
  /** Mid-clot reminder — re-arms when the wound closes. */
  saidBleeding: boolean
}

/** Seconds, from full to empty, under the stated conditions. */
const BREATH_HOLD = 44
const BREATH_REFILL = 7
const STAMINA_BURN = 115
const STAMINA_REFILL = 32
const WARMTH_IN_WATER = 900
const WARMTH_ON_LAND = 3000
const WARMTH_REFILL = 420
const THIRST = 1500
const HUNGER = 2600
/** A full day awake spends the tank; working hard spends it up to twice as fast. */
const ENERGY_WAKE = 430

/** Seconds from full health to dead, per failing vital. */
const DROWNING = 11
const FREEZING = 100
const DEHYDRATION = 170
const STARVATION = 260
const MENDING = 190

/** Seconds for a bite to clot. Until then it taxes strength and appetite. */
export const WOUND_CLOT = 150

/**
 * The immersion suit. Sealed neoprene turns fifteen minutes of survivable
 * water into most of an hour — long enough to work the wreck, or to cross to
 * the island after dark. It does not make you warm, only slow to lose it, and
 * the bulk costs you a little in the water.
 */
const SUIT_WARMTH = 0.32
const SUIT_DRAG = 0.92

export type VitalsContext = {
  submerged: boolean
  depth: number
  effort: number
  /** Out of the water — standing on land or high on the wreck. */
  onLand: boolean
  /**
   * How well the ground you're on gives heat back: 1 is dry sand well up the
   * beach, ~0.5 a wave-washed rock perch you're still being spat at on.
   */
  shelter?: number
  /** Night + storm cold multiplier from the climate clock. */
  cold?: number
  /** Storm swim-cost multiplier — effort burns stamina faster. */
  swimCost?: number
  /**
   * Glass-off dive window — calm water is kinder on the lungs and the stroke.
   * 0 open sea, 1 flat glass.
   */
  diveEase?: number
  /** Quiet one-liners ("Your stomach knots.") — fired once per decline. */
  whisper?: (text: string) => void
}

export function createVitals(): Vitals {
  return {
    breath: 1,
    stamina: 1,
    warmth: 1,
    water: 1,
    food: 1,
    energy: 1,
    health: 1,
    alive: true,
    cause: null,
    elapsed: 0,
    wounded: false,
    woundClock: 0,
    suited: false,
    saidKnot: false,
    saidGnaw: false,
    saidSalt: false,
    saidLead: false,
    saidCold: false,
    saidDrowsy: false,
    saidSpent: false,
    saidBleeding: false,
  }
}

export function resetVitals(v: Vitals) {
  Object.assign(v, createVitals())
}

const drain = (value: number, dt: number, seconds: number) => Math.max(0, value - dt / seconds)
const fill = (value: number, dt: number, seconds: number) => Math.min(1, value + dt / seconds)

export function updateVitals(v: Vitals, dt: number, ctx: VitalsContext) {
  if (!v.alive) return
  v.elapsed += dt

  // Breath — working hard underwater burns air, and so does depth.
  // A glass-off is the dive window: lungs last a little longer in still water.
  if (ctx.submerged) {
    const ease = 1 - Math.min(1, Math.max(0, ctx.diveEase ?? 0)) * 0.22
    const work = (1 + ctx.effort * 1.35 + Math.min(ctx.depth, 30) * 0.022) * ease
    v.breath = drain(v.breath, dt * work, BREATH_HOLD)
  } else {
    v.breath = fill(v.breath, dt, BREATH_REFILL)
  }

  // Stamina — swimming spends it, floating buys it back, an empty gut doesn't.
  // Storms make every stroke cost more. Bone-tired arms come back slowly.
  const cost = ctx.swimCost ?? 1
  const push = ctx.effort * (ctx.submerged ? 1.15 : 1) * cost
  const wearyRefill = v.energy < 0.25 ? 0.45 : v.energy < 0.45 ? 0.7 : 1
  if (push > 0.2) v.stamina = drain(v.stamina, dt * push, STAMINA_BURN)
  else v.stamina = fill(v.stamina, dt * (v.food > 0.05 ? 1 : 0.4) * wearyRefill, STAMINA_REFILL)

  // Energy — the tired timer. A day of wakefulness spends it; effort spends
  // it faster. Sleep is the only refill, so this never climbs on its own.
  v.energy = drain(v.energy, dt * (1 + ctx.effort * 0.9), ENERGY_WAKE)

  // Warmth — the sea pulls heat out far faster than the air does.
  // Night and storms raise `cold`; land still refills, just slower after dark.
  // A wave-washed perch gives less back than dry sand does.
  const cold = ctx.cold ?? 1
  const suit = v.suited ? SUIT_WARMTH : 1
  const shelter = ctx.shelter ?? 1
  if (ctx.onLand) {
    v.warmth = fill(v.warmth, (dt * shelter) / Math.max(0.55, 1.35 - cold * 0.2), WARMTH_REFILL)
    v.warmth = drain(v.warmth, dt * cold * suit, WARMTH_ON_LAND)
  } else {
    v.warmth = drain(v.warmth, dt * (ctx.submerged ? 1.35 : 1) * cold * suit, WARMTH_IN_WATER)
  }

  // An open wound feeds the sea a little of you too, and caps how strong
  // you can get until it clots
  v.water = drain(v.water, dt * (1 + ctx.effort * 0.5), THIRST)
  v.food = drain(v.food, dt * (1 + ctx.effort * 0.35) * (v.wounded ? 1.35 : 1), HUNGER)

  // —— the wound ————————————————————————————————————————————
  if (v.wounded) {
    v.woundClock += dt
    if (!v.saidBleeding && v.woundClock > WOUND_CLOT * 0.4) {
      v.saidBleeding = true
      ctx.whisper?.('Still bleeding. The water knows.')
    }
    if (v.woundClock > WOUND_CLOT) {
      v.wounded = false
      v.saidBleeding = false
      ctx.whisper?.('The bleeding slows.')
    }
  }

  // —— whispers: the body names what the tanks won't ————————————
  if (v.food < 0.55 && !v.saidKnot) {
    v.saidKnot = true
    ctx.whisper?.('Your stomach knots.')
  }
  if (v.food < 0.25 && !v.saidGnaw) {
    v.saidGnaw = true
    ctx.whisper?.('Hunger gnaws at you.')
  }
  if (v.water < 0.4 && !v.saidSalt) {
    v.saidSalt = true
    ctx.whisper?.('Your mouth is full of salt.')
  }
  if (v.stamina < 0.22 && !v.saidLead) {
    v.saidLead = true
    ctx.whisper?.('Your arms are turning to lead.')
  } else if (v.stamina > 0.5) {
    v.saidLead = false
  }
  if (v.warmth < 0.3 && !v.saidCold) {
    v.saidCold = true
    ctx.whisper?.('You are cold to the bone.')
  }
  if (v.energy < 0.45 && !v.saidDrowsy) {
    v.saidDrowsy = true
    ctx.whisper?.('Your eyelids hang heavy.')
  }
  if (v.energy < 0.22 && !v.saidSpent) {
    v.saidSpent = true
    ctx.whisper?.('You could sleep where you stand.')
  }
  if (v.food > 0.55) {
    v.saidKnot = false
    v.saidGnaw = false
  }
  if (v.water > 0.5) v.saidSalt = false
  if (v.warmth > 0.45) v.saidCold = false
  if (v.energy > 0.6) {
    v.saidDrowsy = false
    v.saidSpent = false
  }

  let harm = 0
  if (v.breath <= 0) harm += dt / DROWNING
  if (v.warmth <= 0) harm += dt / FREEZING
  if (v.water <= 0) harm += dt / DEHYDRATION
  if (v.food <= 0) harm += dt / STARVATION

  if (harm > 0) {
    v.health = Math.max(0, v.health - harm)
    if (v.health <= 0) {
      v.alive = false
      v.cause =
        v.breath <= 0 ? 'drowned' : v.warmth <= 0 ? 'exposure' : v.water <= 0 ? 'thirst' : 'hunger'
    }
  } else if (v.breath > 0.5 && v.warmth > 0.25 && v.water > 0.2 && v.food > 0.2) {
    v.health = fill(v.health, dt, MENDING)
  }
}

/**
 * Optional load from the stash. Burden slows the stroke; a plank or barrel
 * under the arm buys float (see logistics.ts).
 */
export type SwimLoad = {
  /** Speed multiplier from carried weight (1 = empty arms). */
  burdenScale?: number
  /** 0..1 buoyancy from a carried plank/barrel. */
  swimAid?: number
}

/**
 * What the body has left for the swim model. Starving and bleeding cap how
 * much strength you can hold; low breath and spent muscles shake the stroke.
 * A heavy stash slows you; a swim aid lifts the climb out of a wave.
 */
export function swimLimits(v: Vitals, load: SwimLoad = {}) {
  const cap = Math.min(
    1,
    v.wounded ? 0.6 : 1,
    v.food < 0.3 ? 0.35 + 0.65 * (v.food / 0.3) : 1,
    // Exhaustion caps what the body can give — the floor keeps you swimming
    0.3 + 0.7 * v.energy,
  )
  const strength = Math.min(v.stamina, cap)
  const breathShort = v.breath < 0.35 ? (0.35 - v.breath) / 0.35 : 0
  const spentShake = v.stamina < 0.18 ? ((0.18 - v.stamina) / 0.18) * 0.5 : 0
  const burden = load.burdenScale ?? 1
  const aid = Math.min(1, Math.max(0, load.swimAid ?? 0))
  return {
    speedScale: (0.55 + 0.45 * strength) * (v.suited ? SUIT_DRAG : 1) * burden,
    climbScale: (0.45 + 0.55 * strength) * (1 + aid * 0.4),
    cadenceScale: 0.68 + 0.32 * strength,
    wobble: Math.min(1, breathShort + spentShake),
    /** Folded into the float target so a barrel keeps the head clearer. */
    floatAid: aid,
  }
}

/**
 * The shark's answer when you don't have one. A first bite wounds: bleeding
 * that taxes strength and appetite until it clots. A second bite while the
 * wound is still open ends the run — the ocean keeps you.
 */
export function bite(v: Vitals, whisper?: (text: string) => void) {
  if (!v.alive) return
  if (v.wounded) {
    v.alive = false
    v.cause = 'taken'
    return
  }
  v.wounded = true
  v.woundClock = 0
  v.saidBleeding = false
  v.stamina = Math.min(v.stamina, 0.5)
  v.health = Math.min(v.health, 0.55)
  whisper?.('Its teeth rake your side. The water tastes of iron.')
}

/** Pull the immersion suit on. One way — you don't take it off out here. */
export function wearSuit(v: Vitals, whisper?: (text: string) => void) {
  if (v.suited) return false
  v.suited = true
  whisper?.('The suit seals cold and clammy, then your own heat fills it.')
  return true
}

/** Tuning hooks for the ?breath / ?food / ?wound URL params. */
export function debugSetVitals(
  v: Vitals,
  patch: {
    breath?: number
    food?: number
    water?: number
    warmth?: number
    energy?: number
    wound?: boolean
  },
) {
  if (patch.breath !== undefined) v.breath = Math.min(1, Math.max(0, patch.breath))
  if (patch.food !== undefined) v.food = Math.min(1, Math.max(0, patch.food))
  if (patch.water !== undefined) v.water = Math.min(1, Math.max(0, patch.water))
  if (patch.warmth !== undefined) v.warmth = Math.min(1, Math.max(0, patch.warmth))
  if (patch.energy !== undefined) v.energy = Math.min(1, Math.max(0, patch.energy))
  if (patch.wound) {
    v.wounded = true
    v.woundClock = 0
  }
}

/**
 * Sleep — the tired timer's only refill. Hours are day-cycle hours; a full
 * night (~8 h) brings you back whole, a nap takes the edge off. Shelter
 * quality scales it: a roof you can stand under is worth more than a hull.
 */
export function rest(v: Vitals, hours: number, quality = 1) {
  v.energy = Math.min(1, v.energy + (hours / 8) * quality)
}

export function eat(v: Vitals, food: number, water = 0) {
  v.food = Math.min(1, v.food + food)
  v.water = Math.min(1, v.water + water)
}

export function formatRun(seconds: number) {
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
