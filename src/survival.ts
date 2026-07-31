/**
 * What the ocean takes from you. There is no save and no objective — the run
 * is however long you keep all of these off the floor.
 *
 * Everything is a 0..1 tank with a drain measured in seconds-to-empty, so the
 * numbers below read as "how long have I got".
 */

export type Cause = 'drowned' | 'exposure' | 'thirst' | 'hunger'

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

  v.water = drain(v.water, dt * (1 + ctx.effort * 0.5), THIRST)
  v.food = drain(v.food, dt * (1 + ctx.effort * 0.35), HUNGER)

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

/** Exhaustion throttles the stroke rather than stopping it dead. */
export function strokeThrottle(v: Vitals) {
  return 0.45 + 0.55 * Math.min(1, v.stamina / 0.35)
}

export function eat(v: Vitals, food: number, water = 0) {
  v.food = Math.min(1, v.food + food)
  v.water = Math.min(1, v.water + water)
}

export function formatRun(seconds: number) {
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
