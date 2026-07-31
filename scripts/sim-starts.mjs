/**
 * Monte Carlo: what can happen from spawn, and can you reach the island?
 *
 * Ports the survival / climate / swim numbers from src/ so we can answer
 * "is the island even reachable?" without firing up WebGL.
 *
 *   node scripts/sim-starts.mjs
 */

// —— world geometry (src/main.ts, src/island.ts) ————————————————
const SPAWN = { x: 0, z: 4 }
const WRECK = { x: -38, z: -104 }
const ISLAND = { x: 980, z: -680 }

// Rough wade line: palms sit at ground 2.4–13 on radii ~150–360; beach
// approach from spawn hits ~ground 0 near radius ~280 from the peak.
const BEACH_RADIUS = 280

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

const DIST_SPAWN_WRECK = dist(SPAWN, WRECK)
const DIST_SPAWN_ISLAND = dist(SPAWN, ISLAND) - BEACH_RADIUS
const DIST_WRECK_ISLAND = dist(WRECK, ISLAND) - BEACH_RADIUS

// —— swim (src/player.ts) ——————————————————————————————————————
const SURFACE_SPEED = 5.2
const SURGE_AVG = 0.95 // stroke pulse average at surface

// —— vitals (src/survival.ts) ——————————————————————————————————
const BREATH_HOLD = 44
const BREATH_REFILL = 7
const STAMINA_BURN = 115
const STAMINA_REFILL = 32
const WARMTH_IN_WATER = 900
const THIRST = 1500
const HUNGER = 2600
const DROWNING = 11
const FREEZING = 100
const DEHYDRATION = 170
const STARVATION = 260
const MENDING = 190

// —— climate (src/climate.ts) ——————————————————————————————————
const DAY_LENGTH = 480
const START_HOUR = 9.5

/** Weather spells — must mirror SPELLS in src/climate.ts. */
const SPELLS = [
  { name: 'glass', storm: [0.0, 0.04], hold: [150, 300], weight: 20 },
  { name: 'fair', storm: [0.02, 0.12], hold: [240, 460], weight: 36 },
  { name: 'breezy', storm: [0.16, 0.32], hold: [140, 280], weight: 22 },
  { name: 'unsettled', storm: [0.38, 0.56], hold: [90, 170], weight: 13 },
  { name: 'squall', storm: [0.7, 0.92], hold: [45, 105], weight: 8 },
  { name: 'gale', storm: [0.94, 1.0], hold: [70, 130], weight: 1 },
]
const FOUL = 0.35
const FRONT = [26, 52]

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (a, b, t) => {
  const x = clamp01((t - a) / Math.max(1e-6, b - a))
  return x * x * (3 - 2 * x)
}

function sunElevation(phase) {
  const hour = phase * 24
  if (hour < 5) return -18
  if (hour < 7) return -18 + 28 * smooth(5, 7, hour)
  if (hour < 12) return 10 + 52 * smooth(7, 12, hour)
  if (hour < 17) return 62 - 52 * smooth(12, 17, hour)
  if (hour < 19.5) return 10 - 28 * smooth(17, 19.5, hour)
  return -18
}

function createClimate(rng) {
  let elapsed = (START_HOUR / 24) * DAY_LENGTH

  const pick = (from) => {
    let total = 0
    for (const s of from) total += s.weight
    let roll = rng() * total
    for (const s of from) {
      roll -= s.weight
      if (roll <= 0) return s
    }
    return from[from.length - 1]
  }
  const range = ([lo, hi]) => lo + rng() * (hi - lo)
  const nextSpell = (previous) => {
    const settled = previous && previous.storm[1] > FOUL
    return pick(settled ? SPELLS.filter((s) => s.storm[1] <= FOUL) : SPELLS)
  }

  let spell = SPELLS[1]
  let target = range(SPELLS[1].storm)
  let from = target
  let holdLeft = range([200, 320])
  let frontLeft = 0
  let frontLength = 1
  let storm = target

  return {
    update(dt) {
      elapsed += dt
      const phase = (elapsed / DAY_LENGTH) % 1
      const elev = sunElevation(phase)
      const day = clamp01((elev + 6) / 48)
      const daylight = day * day * (3 - 2 * day)

      if (frontLeft > 0) {
        frontLeft -= dt
        const f = smooth(0, 1, 1 - Math.max(0, frontLeft) / frontLength)
        storm = from + (target - from) * f
        if (frontLeft <= 0) storm = target
      } else {
        holdLeft -= dt
        const wander = Math.sin(elapsed * 0.021) * 0.5 + Math.sin(elapsed * 0.0073 + 2.1) * 0.5
        const band = (spell.storm[1] - spell.storm[0]) * 0.5
        storm = clamp01(target + wander * band * 0.35)
        if (holdLeft <= 0) {
          spell = nextSpell(spell)
          from = storm
          target = range(spell.storm)
          holdLeft = range(spell.hold)
          frontLength = range(FRONT)
          frontLeft = frontLength
        }
      }

      const live = clamp01(storm * (0.9 + (1 - daylight) * 0.18))
      return {
        daylight,
        storm: live,
        regime: spell.name,
        fair: 1 - clamp01((live - 0.15) / 0.7),
        swimCost: 1 + live * 0.85,
        cold: 1 + (1 - daylight) * 1.6 + live * 0.55,
        hour: phase * 24,
      }
    },
  }
}

/** How much of a long run is weather you'd actually want to swim in. */
function weatherShare(rng, minutes = 60) {
  const climate = createClimate(rng)
  const dt = 1
  const tally = {}
  let good = 0
  let steps = 0
  for (let t = 0; t < minutes * 60; t += dt) {
    const w = climate.update(dt)
    tally[w.regime] = (tally[w.regime] || 0) + dt
    if (w.storm <= FOUL) good += dt
    steps += dt
  }
  return { goodShare: good / steps, tally, seconds: steps }
}

function createVitals(patch = {}) {
  return {
    breath: patch.breath ?? 1,
    stamina: patch.stamina ?? 1,
    warmth: patch.warmth ?? 1,
    water: patch.water ?? 1,
    food: patch.food ?? 1,
    health: 1,
    alive: true,
    cause: null,
    elapsed: 0,
    wounded: false,
  }
}

function drain(value, dt, seconds) {
  return Math.max(0, value - dt / seconds)
}
function fill(value, dt, seconds) {
  return Math.min(1, value + dt / seconds)
}

function updateVitals(v, dt, ctx) {
  if (!v.alive) return
  v.elapsed += dt

  if (ctx.submerged) {
    const work = 1 + ctx.effort * 1.35 + Math.min(ctx.depth, 30) * 0.022
    v.breath = drain(v.breath, dt * work, BREATH_HOLD)
  } else {
    v.breath = fill(v.breath, dt, BREATH_REFILL)
  }

  const cost = ctx.swimCost ?? 1
  const push = ctx.effort * (ctx.submerged ? 1.15 : 1) * cost
  if (push > 0.2) v.stamina = drain(v.stamina, dt * push, STAMINA_BURN)
  else v.stamina = fill(v.stamina, dt * (v.food > 0.05 ? 1 : 0.4), STAMINA_REFILL)

  const cold = ctx.cold ?? 1
  if (ctx.onLand) {
    // land refill path not used on open-water legs
  } else {
    v.warmth = drain(v.warmth, dt * (ctx.submerged ? 1.35 : 1) * cold, WARMTH_IN_WATER)
  }

  v.water = drain(v.water, dt * (1 + ctx.effort * 0.5), THIRST)
  v.food = drain(v.food, dt * (1 + ctx.effort * 0.35) * (v.wounded ? 1.35 : 1), HUNGER)

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

function swimLimits(v) {
  const cap = Math.min(1, v.wounded ? 0.6 : 1, v.food < 0.3 ? 0.35 + 0.65 * (v.food / 0.3) : 1)
  const strength = Math.min(v.stamina, cap)
  return { speedScale: 0.55 + 0.45 * strength }
}

function eat(v, food, water = 0) {
  v.food = Math.min(1, v.food + food)
  v.water = Math.min(1, v.water + water)
}

/** Mulberry32 — deterministic per-run RNG. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Swim a distance on the surface with a rest policy.
 * restBelow: start floating once stamina drops under this
 * resumeAbove: start stroking again once stamina recovers past this
 */
function swimDistance(v, climate, distance, opts = {}) {
  const restBelow = opts.restBelow ?? 0.28
  const resumeAbove = opts.resumeAbove ?? 0.72
  const dt = opts.dt ?? 0.1
  const maxTime = opts.maxTime ?? 2400
  let remaining = distance
  let swimming = true
  let t0 = v.elapsed

  while (remaining > 0 && v.alive && v.elapsed - t0 < maxTime) {
    const weather = climate.update(dt)
    if (swimming && v.stamina < restBelow) swimming = false
    if (!swimming && v.stamina > resumeAbove) swimming = true

    const effort = swimming ? 1 : 0
    // Input is divided by swimCost in main.ts before movement
    const inputScale = swimming ? 1 / weather.swimCost : 0
    const limits = swimLimits(v)
    const speed = SURFACE_SPEED * SURGE_AVG * limits.speedScale * inputScale

    remaining -= speed * dt
    updateVitals(v, dt, {
      submerged: false,
      depth: 0,
      effort,
      onLand: false,
      cold: weather.cold,
      swimCost: weather.swimCost,
    })
  }

  return {
    ok: remaining <= 0 && v.alive,
    remaining: Math.max(0, remaining),
    seconds: v.elapsed - t0,
  }
}

/** Hang still (or light treading) for N seconds. */
function wait(v, climate, seconds, effort = 0) {
  const dt = 0.1
  let left = seconds
  while (left > 0 && v.alive) {
    const weather = climate.update(dt)
    updateVitals(v, dt, {
      submerged: false,
      depth: 0,
      effort,
      onLand: false,
      cold: weather.cold,
      swimCost: weather.swimCost,
    })
    left -= dt
  }
}

/**
 * A dive: descend, hang at depth, ascend. Breath is the limiter.
 * Returns false if you drown mid-dive.
 */
function dive(v, climate, depth, bottomSeconds) {
  const dt = 0.1
  const VERT = 4.0
  // descend
  let d = 0
  while (d < depth && v.alive) {
    const weather = climate.update(dt)
    d = Math.min(depth, d + VERT * dt)
    updateVitals(v, dt, {
      submerged: true,
      depth: d,
      effort: 0.7,
      onLand: false,
      cold: weather.cold,
      swimCost: weather.swimCost,
    })
  }
  // work on the bottom
  let left = bottomSeconds
  while (left > 0 && v.alive) {
    const weather = climate.update(dt)
    updateVitals(v, dt, {
      submerged: true,
      depth,
      effort: 0.55,
      onLand: false,
      cold: weather.cold,
      swimCost: weather.swimCost,
    })
    left -= dt
  }
  // ascend
  while (d > 0 && v.alive) {
    const weather = climate.update(dt)
    d = Math.max(0, d - VERT * dt)
    updateVitals(v, dt, {
      submerged: d > 0.5,
      depth: d,
      effort: 0.65,
      onLand: false,
      cold: weather.cold,
      swimCost: weather.swimCost,
    })
  }
  // gasp
  wait(v, climate, 4, 0)
  return v.alive
}

// —— start paths ———————————————————————————————————————————————

const PATHS = [
  {
    id: 'straight-island',
    name: 'Swim straight for the island',
    run(rng) {
      const v = createVitals()
      const climate = createClimate(rng)
      const leg = swimDistance(v, climate, DIST_SPAWN_ISLAND)
      return finish(v, leg, { provision: false, knife: false, spear: false, hatch: false })
    },
  },
  {
    id: 'wreck-surface-island',
    name: 'Loot wreck surface (crate + flotsam), then island',
    // Matches: "collected some items from wreck then started swimming"
    run(rng) {
      const v = createVitals()
      const climate = createClimate(rng)
      // Swim to wreck
      let leg = swimDistance(v, climate, DIST_SPAWN_WRECK)
      if (!leg.ok) return finish(v, leg, {})
      // Poke around: planks, barrel, provision crate (~90s of light effort)
      wait(v, climate, 25, 0.35)
      eat(v, 0.5, 0.15) // provision crate
      wait(v, climate, 40, 0.4) // gather a few planks / rope / canvas
      wait(v, climate, 8, 0) // orient toward the haze
      leg = swimDistance(v, climate, DIST_WRECK_ISLAND)
      return finish(v, leg, { provision: true, knife: false, spear: false, hatch: false })
    },
  },
  {
    id: 'wreck-fed-island',
    name: 'Wreck surface + hatch meal, then island',
    run(rng) {
      const v = createVitals()
      const climate = createClimate(rng)
      let leg = swimDistance(v, climate, DIST_SPAWN_WRECK)
      if (!leg.ok) return finish(v, leg, {})
      wait(v, climate, 20, 0.35)
      eat(v, 0.5, 0.15) // provision
      wait(v, climate, 35, 0.5) // climb to hatch / take rope+canvas
      eat(v, 0.45, 0.4) // hatch stash
      wait(v, climate, 10, 0)
      leg = swimDistance(v, climate, DIST_WRECK_ISLAND)
      return finish(v, leg, { provision: true, knife: false, spear: false, hatch: true })
    },
  },
  {
    id: 'knife-then-island',
    name: 'Knife dive (~13 m), then island',
    run(rng) {
      const v = createVitals()
      const climate = createClimate(rng)
      let leg = swimDistance(v, climate, DIST_SPAWN_WRECK)
      if (!leg.ok) return finish(v, leg, {})
      wait(v, climate, 15, 0.3)
      eat(v, 0.5, 0.15)
      if (!dive(v, climate, 13, 8)) return finish(v, { ok: false, remaining: DIST_WRECK_ISLAND, seconds: 0 }, { provision: true, knife: false })
      wait(v, climate, 12, 0)
      leg = swimDistance(v, climate, DIST_WRECK_ISLAND)
      return finish(v, leg, { provision: true, knife: true, spear: false, hatch: false })
    },
  },
  {
    id: 'full-wreck-island',
    name: 'Full wreck (knife + 24 m chest + hatch), then island',
    run(rng) {
      const v = createVitals()
      const climate = createClimate(rng)
      let leg = swimDistance(v, climate, DIST_SPAWN_WRECK)
      if (!leg.ok) return finish(v, leg, {})
      wait(v, climate, 15, 0.3)
      eat(v, 0.5, 0.15)
      eat(v, 0.45, 0.4)
      if (!dive(v, climate, 13, 8)) return finish(v, { ok: false, remaining: DIST_WRECK_ISLAND, seconds: 0 }, { provision: true })
      wait(v, climate, 10, 0)
      // Deep chest dive — tight on breath
      if (!dive(v, climate, 24, 12)) return finish(v, { ok: false, remaining: DIST_WRECK_ISLAND, seconds: 0 }, { provision: true, knife: true, hatch: true })
      wait(v, climate, 20, 0)
      leg = swimDistance(v, climate, DIST_WRECK_ISLAND)
      return finish(v, leg, { provision: true, knife: true, spear: true, hatch: true })
    },
  },
  {
    id: 'wreck-camp',
    name: 'Stay at the wreck (no island) — survive 20 min',
    run(rng) {
      const v = createVitals()
      const climate = createClimate(rng)
      let leg = swimDistance(v, climate, DIST_SPAWN_WRECK)
      if (!leg.ok) return finish(v, leg, {})
      eat(v, 0.5, 0.15)
      eat(v, 0.45, 0.4)
      // Low-effort loitering + occasional fish grab
      const target = 20 * 60
      let fish = 0
      while (v.alive && v.elapsed < target) {
        wait(v, climate, 40 + rng() * 30, 0.15)
        if (!v.alive) break
        // Coin-toss hand fish every couple of minutes
        if (rng() < 0.55) {
          eat(v, 0.14, 0.02)
          fish++
        }
        // Short dive for shellfish sometimes
        if (rng() < 0.25) {
          dive(v, climate, 8, 4)
        }
      }
      return finish(v, { ok: v.alive, remaining: 0, seconds: v.elapsed }, {
        provision: true,
        hatch: true,
        fish,
        camped: true,
      })
    },
  },
  {
    id: 'sprint-no-rest',
    name: 'Island sprint (never rest) — stress test',
    run(rng) {
      const v = createVitals()
      const climate = createClimate(rng)
      const leg = swimDistance(v, climate, DIST_SPAWN_ISLAND, {
        restBelow: -1, // never rest
        resumeAbove: 2,
      })
      return finish(v, leg, { provision: false })
    },
  },
  {
    id: 'late-departure',
    name: 'Loot wreck, linger 8 min, then try island (night risk)',
    run(rng) {
      const v = createVitals()
      const climate = createClimate(rng)
      let leg = swimDistance(v, climate, DIST_SPAWN_WRECK)
      if (!leg.ok) return finish(v, leg, {})
      eat(v, 0.5, 0.15)
      eat(v, 0.45, 0.4)
      wait(v, climate, 8 * 60, 0.2)
      if (!v.alive) return finish(v, { ok: false, remaining: DIST_WRECK_ISLAND, seconds: 0 }, { provision: true, hatch: true })
      leg = swimDistance(v, climate, DIST_WRECK_ISLAND)
      return finish(v, leg, { provision: true, hatch: true, late: true })
    },
  },
]

function finish(v, leg, flags) {
  const freezing = v.alive && v.warmth <= 0
  // Once warmth hits 0 you have FREEZING seconds of health left
  const freezeGrace = freezing ? v.health * FREEZING : null
  return {
    reached: !!leg.ok && v.alive && !flags.camped,
    survived: v.alive,
    cause: v.cause,
    seconds: v.elapsed,
    remainingM: Math.round(leg.remaining ?? 0),
    warmth: +v.warmth.toFixed(3),
    stamina: +v.stamina.toFixed(3),
    water: +v.water.toFixed(3),
    food: +v.food.toFixed(3),
    health: +v.health.toFixed(3),
    freezing,
    freezeGrace,
    ...flags,
  }
}

function fmt(sec) {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function summarize(results) {
  const n = results.length
  const reached = results.filter((r) => r.reached)
  const survived = results.filter((r) => r.survived).length
  const causes = {}
  for (const r of results) {
    if (r.cause) causes[r.cause] = (causes[r.cause] || 0) + 1
  }
  const times = reached.map((r) => r.seconds)
  const avgTime = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null
  const warmLeft = reached.map((r) => r.warmth)
  const avgWarm = warmLeft.length ? warmLeft.reduce((a, b) => a + b, 0) / warmLeft.length : null
  const rem = results.filter((r) => !r.reached).map((r) => r.remainingM)
  const avgRem = rem.length ? rem.reduce((a, b) => a + b, 0) / rem.length : 0
  const freezingArrivals = reached.filter((r) => r.freezing).length
  const grace = reached.filter((r) => r.freezeGrace != null).map((r) => r.freezeGrace)
  const avgGrace = grace.length ? grace.reduce((a, b) => a + b, 0) / grace.length : null
  const healthArr = reached.map((r) => r.health)
  const avgHealth = healthArr.length ? healthArr.reduce((a, b) => a + b, 0) / healthArr.length : null

  return {
    n,
    reachRate: reached.length / n,
    surviveRate: survived / n,
    causes,
    avgReachTime: avgTime,
    avgWarmthOnArrival: avgWarm,
    avgMetresShort: avgRem,
    freezeArrivalRate: reached.length ? freezingArrivals / reached.length : 0,
    avgFreezeGrace: avgGrace,
    avgHealthOnArrival: avgHealth,
  }
}

// —— run ———————————————————————————————————————————————————————

const RUNS = Number(process.env.RUNS || 200)
const seed0 = Number(process.env.SEED || 42)

console.log('WaterWorld — start-path Monte Carlo')
console.log('===================================')
console.log(`Runs per path: ${RUNS}  seed: ${seed0}`)
console.log('')
console.log('Distances (approx to wadeable beach):')
console.log(`  spawn → wreck:   ${DIST_SPAWN_WRECK.toFixed(0)} m`)
console.log(`  spawn → island:  ${DIST_SPAWN_ISLAND.toFixed(0)} m  (~${(DIST_SPAWN_ISLAND / SURFACE_SPEED / 60).toFixed(1)} min ideal sprint)`)
console.log(`  wreck → island:  ${DIST_WRECK_ISLAND.toFixed(0)} m`)
console.log('')
console.log('Hard limits (surface, day, calm):')
console.log(`  warmth empty:    ${(WARMTH_IN_WATER / 60).toFixed(1)} min  (+ ${(FREEZING / 60).toFixed(1)} min to die of exposure)`)
console.log(`  thirst empty:    ${(THIRST / 60).toFixed(1)} min`)
console.log(`  hunger empty:    ${(HUNGER / 60).toFixed(1)} min`)
console.log(`  stamina empty:   ${(STAMINA_BURN / 60).toFixed(1)} min continuous stroke`)
console.log('')

{
  // Weather balance — long spells, more good than bad
  const hours = 12
  const totals = {}
  let good = 0
  let seconds = 0
  for (let i = 0; i < hours; i++) {
    const w = weatherShare(mulberry32(seed0 + i * 7919), 60)
    good += w.goodShare * w.seconds
    seconds += w.seconds
    for (const [k, v] of Object.entries(w.tally)) totals[k] = (totals[k] || 0) + v
  }
  console.log(`Weather balance (${hours} simulated hours):`)
  console.log(`  swimmable (storm ≤ ${FOUL}): ${((good / seconds) * 100).toFixed(0)}% of the time`)
  const parts = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${((v / seconds) * 100).toFixed(0)}%`)
  console.log(`  spells: ${parts.join(' · ')}`)
  console.log('')
}

const table = []

for (const path of PATHS) {
  const results = []
  for (let i = 0; i < RUNS; i++) {
    const rng = mulberry32(seed0 + i * 9973 + path.id.length * 131)
    results.push(path.run(rng))
  }
  const s = summarize(results)
  table.push({ path, s, sample: results[0] })

  const reachPct = (s.reachRate * 100).toFixed(0)
  const livePct = (s.surviveRate * 100).toFixed(0)
  const causeStr = Object.keys(s.causes).length
    ? Object.entries(s.causes)
        .map(([k, v]) => `${k} ${((v / RUNS) * 100).toFixed(0)}%`)
        .join(', ')
    : '—'
  const timeStr = s.avgReachTime != null ? fmt(s.avgReachTime) : '—'
  const warmStr = s.avgWarmthOnArrival != null ? `${(s.avgWarmthOnArrival * 100).toFixed(0)}%` : '—'
  const shortStr = s.reachRate < 1 ? ` short ${s.avgMetresShort.toFixed(0)} m` : ''
  const freezeStr =
    s.reachRate > 0
      ? `  ·  arrive freezing ${(s.freezeArrivalRate * 100).toFixed(0)}%` +
        (s.avgFreezeGrace != null ? ` (≈${s.avgFreezeGrace.toFixed(0)}s grace)` : '')
      : ''

  console.log(`▸ ${path.name}`)
  console.log(
    `    reach island ${reachPct}%  ·  alive ${livePct}%  ·  avg time ${timeStr}  ·  warmth left ${warmStr}${shortStr}${freezeStr}`,
  )
  console.log(`    deaths: ${causeStr}`)
  console.log('')
}

// Quick analytical answer for the player's exact situation
console.log('—— Your run (wreck loot → swim for island) ——————————')
{
  const path = PATHS.find((p) => p.id === 'wreck-surface-island')
  const results = []
  for (let i = 0; i < RUNS; i++) {
    results.push(path.run(mulberry32(seed0 + i * 17)))
  }
  const s = summarize(results)
  console.log(
    `Yes — you can get there. ${(s.reachRate * 100).toFixed(0)}% of sims hit the beach (~${fmt(s.avgReachTime ?? 0)}).`,
  )
  console.log(
    `But the crossing eats a full in-game day (day = ${DAY_LENGTH / 60} real min), so night cold lands mid-swim.`,
  )
  console.log(
    `After wreck-looting first, ${(s.freezeArrivalRate * 100).toFixed(0)}% of arrivals are already on empty warmth` +
      (s.avgFreezeGrace != null
        ? ` — about ${s.avgFreezeGrace.toFixed(0)}s of freeze-grace left to crawl above the wash.`
        : '.'),
  )
  console.log(
    'Coconuts on the sand refill water; dry ground refills warmth. Miss the beach and exposure finishes the run.',
  )
  console.log(
    'Linger at the wreck into the next night before leaving → 0% reach. Leave while the sky is still lit.',
  )
}

console.log('')
console.log('Path ranking by warmth margin on arrival (then freeze grace):')
table
  .filter((t) => t.path.id !== 'wreck-camp')
  .sort((a, b) => {
    const aw = a.s.avgWarmthOnArrival ?? -1
    const bw = b.s.avgWarmthOnArrival ?? -1
    if (bw !== aw) return bw - aw
    const ag = a.s.avgFreezeGrace ?? 999
    const bg = b.s.avgFreezeGrace ?? 999
    if (ag !== bg) return bg - ag
    return b.s.reachRate - a.s.reachRate
  })
  .forEach((t, i) => {
    const warm =
      t.s.avgWarmthOnArrival != null ? `${(t.s.avgWarmthOnArrival * 100).toFixed(0)}% warm` : 'dead'
    const freeze =
      t.s.freezeArrivalRate > 0 ? `, freeze grace ~${(t.s.avgFreezeGrace ?? 0).toFixed(0)}s` : ''
    console.log(
      `  ${i + 1}. ${(t.s.reachRate * 100).toFixed(0).padStart(3)}% reach · ${warm}${freeze}  —  ${t.path.name}`,
    )
  })

console.log('')
console.log('Note: the wreck is not a camp. onLand only fires on the island beach,')
console.log('so lingering in open water always drains warmth — exposure ends long stays.')