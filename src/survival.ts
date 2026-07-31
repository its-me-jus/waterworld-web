/**
 * What the ocean takes from you. There is no save and no objective — the run
 * is however long you keep all of these off the floor.
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
  health: number
  alive: boolean
  cause: Cause | null
  /** Seconds survived this run. */
  elapsed: number
  /** The shark's mark: bleeding until it clots. A second bite ends the run. */
  wounded: boolean
  woundClock: number
  /** Whisper latches — each line fires once per decline, re-arms on recovery. */
  saidKnot: boolean
  saidGnaw: boolean
  saidSalt: boolean
  saidLead: boolean
  saidCold: boolean
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

/** Seconds from full health to dead, per failing vital. */
const DROWNING = 11
const FREEZING = 100
const DEHYDRATION = 170
const STARVATION = 260
const MENDING = 190

/** Seconds for a bite to clot. Until then it taxes strength and appetite. */
const WOUND_CLOT = 150

export type VitalsContext = {
  submerged: boolean
  depth: number
  effort: number
  /** Out of the water — standing on land or high on the wreck. */
  onLand: boolean
  /** Night + storm cold multiplier from the climate clock. */
  cold?: number
  /** Storm swim-cost multiplier — effort burns stamina faster. */
  swimCost?: number
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
    health: 1,
    alive: true,
    cause: null,
    elapsed: 0,
    wounded: false,
    woundClock: 0,
    saidKnot: false,
    saidGnaw: false,
    saidSalt: false,
    saidLead: false,
    saidCold: false,
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

  // Breath — working hard underwater burns air, and so does depth
  if (ctx.submerged) {
    const work = 1 + ctx.effort * 1.35 + Math.min(ctx.depth, 30) * 0.022
    v.breath = drain(v.breath, dt * work, BREATH_HOLD)
  } else {
    v.breath = fill(v.breath, dt, BREATH_REFILL)
  }

  // Stamina — swimming spends it, floating buys it back, an empty gut doesn't.
  // Storms make every stroke cost more.
  const cost = ctx.swimCost ?? 1
  const push = ctx.effort * (ctx.submerged ? 1.15 : 1) * cost
  if (push > 0.2) v.stamina = drain(v.stamina, dt * push, STAMINA_BURN)
  else v.stamina = fill(v.stamina, dt * (v.food > 0.05 ? 1 : 0.4), STAMINA_REFILL)

  // Warmth — the sea pulls heat out far faster than the air does.
  // Night and storms raise `cold`; land still refills, just slower after dark.
  const cold = ctx.cold ?? 1
  if (ctx.onLand) v.warmth = fill(v.warmth, dt / Math.max(0.55, 1.35 - cold * 0.2), WARMTH_REFILL)
  else v.warmth = drain(v.warmth, dt * (ctx.submerged ? 1.35 : 1) * cold, WARMTH_IN_WATER)
  if (ctx.onLand) v.warmth = drain(v.warmth, dt * cold, WARMTH_ON_LAND)

  // An open wound feeds the sea a little of you too, and caps how strong
  // you can get until it clots
  v.water = drain(v.water, dt * (1 + ctx.effort * 0.5), THIRST)
  v.food = drain(v.food, dt * (1 + ctx.effort * 0.35) * (v.wounded ? 1.35 : 1), HUNGER)

  // —— the wound ————————————————————————————————————————————
  if (v.wounded) {
    v.woundClock += dt
    if (v.woundClock > WOUND_CLOT) {
      v.wounded = false
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
  if (v.food > 0.55) {
    v.saidKnot = false
    v.saidGnaw = false
  }
  if (v.water > 0.5) v.saidSalt = false
  if (v.warmth > 0.45) v.saidCold = false

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
 * What the body has left for the swim model. Starving and bleeding cap how
 * much strength you can hold; low breath and spent muscles shake the stroke.
 */
export function swimLimits(v: Vitals) {
  const cap = Math.min(1, v.wounded ? 0.6 : 1, v.food < 0.3 ? 0.35 + 0.65 * (v.food / 0.3) : 1)
  const strength = Math.min(v.stamina, cap)
  const breathShort = v.breath < 0.35 ? (0.35 - v.breath) / 0.35 : 0
  const spentShake = v.stamina < 0.18 ? ((0.18 - v.stamina) / 0.18) * 0.5 : 0
  return {
    speedScale: 0.55 + 0.45 * strength,
    climbScale: 0.45 + 0.55 * strength,
    cadenceScale: 0.68 + 0.32 * strength,
    wobble: Math.min(1, breathShort + spentShake),
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
  v.stamina = Math.min(v.stamina, 0.5)
  whisper?.('Its teeth rake your side. The water tastes of iron.')
}

/** Tuning hooks for the ?breath / ?food / ?wound URL params. */
export function debugSetVitals(
  v: Vitals,
  patch: { breath?: number; food?: number; water?: number; warmth?: number; wound?: boolean },
) {
  if (patch.breath !== undefined) v.breath = Math.min(1, Math.max(0, patch.breath))
  if (patch.food !== undefined) v.food = Math.min(1, Math.max(0, patch.food))
  if (patch.water !== undefined) v.water = Math.min(1, Math.max(0, patch.water))
  if (patch.warmth !== undefined) v.warmth = Math.min(1, Math.max(0, patch.warmth))
  if (patch.wound) {
    v.wounded = true
    v.woundClock = 0
  }
}

export function eat(v: Vitals, food: number, water = 0) {
  v.food = Math.min(1, v.food + food)
  v.water = Math.min(1, v.water + water)
}

export function formatRun(seconds: number) {
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
