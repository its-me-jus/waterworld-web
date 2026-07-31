import type { PlayerFrame, SwimLimits } from './player'

/**
 * Vitals — breath, energy, hunger. The whole survival model of Phase A.
 *
 * Design locks (decided with the player):
 *  - Grounded castaway tone: numbers stay hidden; the body is the readout.
 *    Breath is a closing vignette and a heartbeat. Hunger is a knot and a
 *    whisper. Fatigue is slower arms.
 *  - Permadeath: when a cause runs out, the run ends. No respawn, no undo.
 *  - Infinite thrive: nothing here ever "wins". Food just buys more ocean.
 *
 * Rates are tuned for readable stakes on a first pass:
 *  - breath ~46 s easy dive, ~24 s working hard, ~3 s to gulp it back
 *  - energy ~62 s of hard crawl, refills while you lie on the swell
 *  - hunger ~12 min full to empty; eating is the only way back
 */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))

export type DeathCause = 'drowned' | 'starved'

export type VitalsHooks = {
  /** Quiet one-liners ("Your stomach knots."). */
  whisper: (text: string) => void
  /** Breath shortage 0..1 every frame — heartbeat + murk pulse live off this. */
  onBreath?: (shortage: number, submerged: boolean) => void
  /** Hunger shortage 0..1 — the growl scheduler. */
  onHunger?: (shortage: number) => void
}

export function createVitals(app: HTMLElement, hooks: VitalsHooks) {
  // You swam away from a sinking ship — not starving yet, but not fed either
  let breath = 1
  let energy = 1
  let hunger = 0.8

  let starveClock = 0
  let dead: DeathCause | null = null

  // Whisper latches — each line fires once per decline, re-arms on recovery
  let saidKnot = false
  let saidGnaw = false
  let saidLead = false
  let saidEmpty = false

  // —— diegetic veils ————————————————————————————————————————
  const breathVeil = document.createElement('div')
  breathVeil.id = 'breath-veil'
  app.appendChild(breathVeil)

  const wearyVeil = document.createElement('div')
  wearyVeil.id = 'weary-veil'
  app.appendChild(wearyVeil)

  let veilBreath = 0
  let veilWeary = 0

  const limits: SwimLimits = { speedScale: 1, climbScale: 1, cadenceScale: 1, wobble: 0 }

  /** Food is the only way back. Amounts are fractions of a full belly. */
  function feed(amount: number) {
    hunger = clamp(hunger + amount, 0, 1)
    starveClock = 0
    if (hunger > 0.55) {
      saidKnot = false
      saidGnaw = false
      saidEmpty = false
    }
  }

  function update(dt: number, view: PlayerFrame): SwimLimits {
    if (dead) return limits

    const submerged = view.underwater && view.submersion > 0.55

    // —— breath ————————————————————————————————————————————
    if (submerged) {
      breath -= (dt / 46) * (1 + view.effort * 0.9)
      if (breath <= 0) {
        breath = 0
        dead = 'drowned'
      }
    } else {
      // Gasping it back is fast, but spent lungs fill slower
      breath = Math.min(1, breath + (dt / 2.8) * (0.45 + 0.55 * energy))
    }

    // —— hunger ————————————————————————————————————————————
    hunger = Math.max(0, hunger - dt / 720)
    if (hunger < 0.55 && !saidKnot) {
      saidKnot = true
      hooks.whisper('Your stomach knots.')
    }
    if (hunger < 0.25 && !saidGnaw) {
      saidGnaw = true
      hooks.whisper('Hunger gnaws at you.')
    }

    // —— energy ————————————————————————————————————————————
    // Hunger sets the ceiling: a starving body can't hold strength
    const cap = hunger < 0.3 ? 0.35 + 0.65 * (hunger / 0.3) : 1
    if (hunger <= 0) {
      energy -= dt / 70
    } else {
      energy -= dt * view.effort * 0.016
      if (view.effort < 0.3) {
        // Lying on the swell is how you rest; drifting underwater, half that
        energy += dt * (submerged ? 0.008 : 0.022) * (1 - view.effort)
      }
    }
    if (energy > cap) energy = Math.max(cap, energy - dt * 0.05)
    energy = clamp(energy, 0, 1)
    if (energy < 0.22 && !saidLead) {
      saidLead = true
      hooks.whisper('Your arms are turning to lead.')
    } else if (energy > 0.5) {
      saidLead = false
    }

    // —— starvation collapse ————————————————————————————————
    if (hunger <= 0 && energy <= 0) {
      if (!saidEmpty) {
        saidEmpty = true
        hooks.whisper('You have nothing left.')
      }
      starveClock += dt
      if (starveClock > 25) dead = 'starved'
    } else {
      starveClock = 0
    }

    // —— what the body has left for the swim model ————————————
    limits.speedScale = 0.55 + 0.45 * energy
    limits.climbScale = 0.45 + 0.55 * energy
    limits.cadenceScale = 0.68 + 0.32 * energy
    const breathShortage = breath < 0.35 ? (0.35 - breath) / 0.35 : 0
    const spentShake = energy < 0.18 ? ((0.18 - energy) / 0.18) * 0.5 : 0
    limits.wobble = clamp(breathShortage + spentShake, 0, 1)

    // —— veils: the body as readout —————————————————————————
    veilBreath = damp(veilBreath, breathShortage, 5, dt)
    breathVeil.style.opacity = veilBreath.toFixed(3)
    breathVeil.classList.toggle('critical', submerged && breath < 0.18)
    if (!submerged && breath >= 0.99) breathVeil.style.opacity = '0'

    const weary = Math.max(hunger < 0.3 ? (0.3 - hunger) / 0.3 : 0, 1 - energy) * 0.55
    veilWeary = damp(veilWeary, weary, 2.5, dt)
    wearyVeil.style.opacity = veilWeary.toFixed(3)

    hooks.onBreath?.(breathShortage, submerged)
    hooks.onHunger?.(1 - hunger)

    return limits
  }

  /** Tuning hooks for the ?breath / ?hunger URL params. */
  function debugSet(patch: { breath?: number; hunger?: number }) {
    if (patch.breath !== undefined) breath = clamp(patch.breath, 0, 1)
    if (patch.hunger !== undefined) hunger = clamp(patch.hunger, 0, 1)
  }

  return {
    update,
    feed,
    debugSet,
    get dead() {
      return dead
    },
    get breath() {
      return breath
    },
    get energy() {
      return energy
    },
    get hunger() {
      return hunger
    },
  }
}

export type Vitals = ReturnType<typeof createVitals>
