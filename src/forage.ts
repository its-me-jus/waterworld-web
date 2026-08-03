import * as THREE from 'three'
import type { Hud } from './hud'
import type { Interactions } from './interact'
import type { PlayerFrame } from './player'
import { eat, type Vitals } from './survival'

/**
 * Forage — catching food across the map.
 *
 *  - Provision crate (once): Pry open by the wreck for hardtack.
 *  - Hand grab / spear: hang still underwater near the schools.
 *  - Fishing rod (crafted): cast from shore or the surface into nearby schools.
 *  - Cast net (crafted): scoop the wash while wading the shallows.
 *  - Shore crabs: Grab on wet sand.
 *
 * Cooking / smoking live in improvise; this module holds the counts, the
 * crafted gear flags, and applies the bite.
 */

export type ForageDeps = {
  interactions: Interactions
  /** Bobbing world position of the crate, or null once it's been stripped. */
  provisionSpot: () => THREE.Vector3 | null
  takeProvision: () => boolean
  fish: {
    nearest: (point: THREE.Vector3, maxDist: number) => { index: number; dist: number } | null
    fling: (index: number, far: boolean) => void
    positionAt: (index: number, out: THREE.Vector3) => THREE.Vector3
  }
  /** Island shore crabs — optional so wreck-only tests still construct. */
  crabs?: {
    nearest: (point: THREE.Vector3, maxDist: number) => { index: number; dist: number } | null
    positionAt: (index: number, out: THREE.Vector3) => THREE.Vector3
    take: (index: number) => boolean
  }
  /** The mate's spear swaps bare hands for reach and near-certain odds. */
  hasSpear?: () => boolean
}

const GRAB_RANGE = 2.2
const CRATE_RANGE = 2.9
const CRAB_RANGE = 2.8
/** A spear's honest reach — longer than an arm, surer than fingers. */
const SPEAR_RANGE = 3.4
/** Shore / surface cast into the school. */
const ROD_RANGE = 14
/** Wading scoop in the wash. */
const NET_RANGE = 5.2

export function createForage(hud: Hud, vitals: Vitals, deps: ForageDeps) {
  const cratePos = new THREE.Vector3()
  deps.interactions.add({
    position: cratePos,
    verb: 'Pry open',
    label: 'Crate',
    radius: CRATE_RANGE,
    available: () => vitals.alive && deps.provisionSpot() !== null,
    use: () => {
      if (!deps.takeProvision()) return
      eat(vitals, 0.5, 0.15)
      hud.whisper('Hardtack and dried beans. A week’s luck.')
    },
  })

  // Hand-fishing: one prompt that rides the nearest fish, and only while
  // you're hanging still enough not to have spooked the school. The mate's
  // spear retires bare hands — reach and a point beat fingers.
  let current = -1
  let spearCurrent = -1
  let rodCurrent = -1
  let netCurrent = -1
  let rawFish = 0
  let smokedFish = 0
  let hasRod = false
  let hasNet = false
  let rodCool = 0
  let netCool = 0
  const fishPos = new THREE.Vector3()
  const spearFishPos = new THREE.Vector3()
  const rodFishPos = new THREE.Vector3()
  const netFishPos = new THREE.Vector3()

  deps.interactions.add({
    position: fishPos,
    verb: 'Grab',
    label: 'Fish',
    radius: GRAB_RANGE,
    available: () => current >= 0 && vitals.alive && !(deps.hasSpear?.() ?? false),
    use: () => {
      const index = current
      if (index < 0) return
      // Better odds the slower you're moving when you strike — and raw fish
      // is a coin toss even then
      if (Math.random() < 0.55) {
        deps.fish.fling(index, true)
        rawFish += 1
        hud.whisper(rawFish > 1 ? 'Another. Keep it for the fire.' : 'Raw fish. Keep it, or eat it.')
      } else {
        deps.fish.fling(index, false)
        hud.whisper('It slips through your fingers.')
      }
      current = -1
    },
  })

  // Spearfishing — the same schools, answered properly. Reach past arm's
  // length and near-sure odds; the point does what fingers couldn't.
  deps.interactions.add({
    position: spearFishPos,
    verb: 'Spear',
    label: 'Fish',
    radius: SPEAR_RANGE,
    available: () => spearCurrent >= 0 && vitals.alive && (deps.hasSpear?.() ?? false),
    use: () => {
      const index = spearCurrent
      if (index < 0) return
      if (Math.random() < 0.85) {
        deps.fish.fling(index, true)
        rawFish += 1
        hud.whisper(
          rawFish > 1 ? 'Another on the point. The fire will eat well.' : 'On the spear. The old skill holds.',
        )
      } else {
        deps.fish.fling(index, false)
        hud.whisper('A thrust into empty water. It saw the shadow.')
      }
      spearCurrent = -1
    },
  })

  // Fishing rod — cast from shore or the surface into a school you can see
  deps.interactions.add({
    position: rodFishPos,
    verb: 'Cast',
    label: 'Rod',
    radius: ROD_RANGE,
    available: () => rodCurrent >= 0 && vitals.alive && hasRod && rodCool <= 0,
    use: () => {
      const index = rodCurrent
      if (index < 0) return
      rodCool = 7.5
      if (Math.random() < 0.62) {
        deps.fish.fling(index, true)
        rawFish += 1
        hud.whisper(
          rawFish > 1 ? 'Another on the line. The rod earns its keep.' : 'A tug, then weight. Fish on the line.',
        )
      } else {
        deps.fish.fling(index, false)
        hud.whisper('A nibble, then nothing. The line comes back empty.')
      }
      rodCurrent = -1
    },
  })

  // Cast net — scoop the wash while wading; sometimes two fish at once
  deps.interactions.add({
    position: netFishPos,
    verb: 'Scoop',
    label: 'Net',
    radius: NET_RANGE,
    available: () => netCurrent >= 0 && vitals.alive && hasNet && netCool <= 0,
    use: () => {
      const index = netCurrent
      if (index < 0) return
      netCool = 5.5
      if (Math.random() < 0.58) {
        deps.fish.fling(index, true)
        const bonus = Math.random() < 0.28 ? 1 : 0
        rawFish += 1 + bonus
        hud.whisper(
          bonus
            ? 'Two in the mesh. The wash was thick with them.'
            : 'One in the net. Silver and thrashing.',
        )
      } else {
        deps.fish.fling(index, false)
        hud.whisper('The mesh comes up empty. They saw the shadow.')
      }
      netCurrent = -1
    },
  })

  // Shore crabs — ride the nearest live crab while you're ashore
  let crabCurrent = -1
  const crabPos = new THREE.Vector3()
  if (deps.crabs) {
    const crabs = deps.crabs
    deps.interactions.add({
      position: crabPos,
      verb: 'Grab',
      label: 'Crab',
      radius: CRAB_RANGE,
      available: () => crabCurrent >= 0 && vitals.alive,
      use: () => {
        const index = crabCurrent
        if (index < 0) return
        if (!crabs.take(index)) return
        eat(vitals, 0.16, 0.02)
        hud.whisper('A shore crab. Thin eating.')
        crabCurrent = -1
      },
    })
  }

  function update(camera: THREE.PerspectiveCamera, view: PlayerFrame, dt = 0) {
    if (dt > 0) {
      rodCool = Math.max(0, rodCool - dt)
      netCool = Math.max(0, netCool - dt)
    }

    const spot = deps.provisionSpot()
    if (spot) cratePos.copy(spot)

    current = -1
    if (view.underwater && view.effort < 0.3 && vitals.alive) {
      const hit = deps.fish.nearest(camera.position, GRAB_RANGE)
      if (hit) {
        current = hit.index
        deps.fish.positionAt(hit.index, fishPos)
      }
    }

    // The spear forgives a little more motion — reach buys you that
    spearCurrent = -1
    if (view.underwater && view.effort < 0.55 && vitals.alive && (deps.hasSpear?.() ?? false)) {
      const hit = deps.fish.nearest(camera.position, SPEAR_RANGE)
      if (hit) {
        spearCurrent = hit.index
        deps.fish.positionAt(hit.index, spearFishPos)
      }
    }

    // Rod: from shore (walking) or near the surface — not deep diving
    rodCurrent = -1
    if (hasRod && vitals.alive && rodCool <= 0) {
      const nearSurface = view.walking || (!view.underwater && view.depth < 1.2)
      if (nearSurface) {
        const hit = deps.fish.nearest(camera.position, ROD_RANGE)
        if (hit && hit.dist > 2.5) {
          rodCurrent = hit.index
          deps.fish.positionAt(hit.index, rodFishPos)
        }
      }
    }

    // Net: wading the wash — feet on ground, water still around you
    netCurrent = -1
    if (hasNet && vitals.alive && netCool <= 0) {
      const wading =
        view.walking && view.groundY > -0.9 && view.groundY < 1.15 && view.depth > -0.1
      const inWash = !view.walking && !view.underwater && view.depth < 1.4
      if (wading || inWash) {
        const hit = deps.fish.nearest(camera.position, NET_RANGE)
        if (hit) {
          netCurrent = hit.index
          deps.fish.positionAt(hit.index, netFishPos)
        }
      }
    }

    crabCurrent = -1
    if (deps.crabs && !view.underwater && vitals.alive) {
      const hit = deps.crabs.nearest(camera.position, CRAB_RANGE)
      if (hit) {
        crabCurrent = hit.index
        deps.crabs.positionAt(hit.index, crabPos)
      }
    }
  }

  function eatRaw() {
    if (rawFish <= 0) return false
    rawFish -= 1
    eat(vitals, 0.14, 0.02)
    return true
  }

  /** Cook over the fire — a meal now, nothing left to carry. */
  function cook() {
    if (rawFish <= 0) return false
    rawFish -= 1
    eat(vitals, 0.32, 0.06)
    return true
  }

  /** Spend one raw fish to hang over the smoke. Returns false if none left. */
  function takeRawForSmoke() {
    if (rawFish <= 0) return false
    rawFish -= 1
    return true
  }

  function addSmoked(n = 1) {
    smokedFish += Math.max(0, n)
  }

  function eatSmoked() {
    if (smokedFish <= 0) return false
    smokedFish -= 1
    // Almost a cooked meal, and it kept
    eat(vitals, 0.28, 0.04)
    return true
  }

  function reset() {
    rawFish = 0
    smokedFish = 0
    hasRod = false
    hasNet = false
    rodCool = 0
    netCool = 0
  }

  /** Dev / tests — put fish in hand without diving. */
  function grant(n = 1) {
    rawFish += Math.max(0, n)
  }

  function setFish(raw: number, smoked: number) {
    rawFish = Math.max(0, Math.floor(raw))
    smokedFish = Math.max(0, Math.floor(smoked))
  }

  function fashionRod() {
    if (hasRod) return false
    hasRod = true
    return true
  }

  function fashionNet() {
    if (hasNet) return false
    hasNet = true
    return true
  }

  function setGear(rod: boolean, net: boolean) {
    hasRod = !!rod
    hasNet = !!net
  }

  return {
    update,
    reset,
    grant,
    setFish,
    setGear,
    fashionRod,
    fashionNet,
    get rawFish() {
      return rawFish
    },
    get smokedFish() {
      return smokedFish
    },
    get hasRod() {
      return hasRod
    },
    get hasNet() {
      return hasNet
    },
    eatRaw,
    cook,
    takeRawForSmoke,
    addSmoked,
    eatSmoked,
  }
}

export type Forage = ReturnType<typeof createForage>
