import * as THREE from 'three'
import type { Hud } from './hud'
import type { Interactions } from './interact'
import type { PlayerFrame } from './player'
import { eat, type Vitals } from './survival'

/**
 * Forage — food in two registers:
 *
 *  - The provision crate (once per run): lashed shut, still floating by the
 *    wreck. Pry it open for hardtack and dried beans — the tutorial meal that
 *    proves the world can feed you.
 *  - Hand-fishing (forever): hang still underwater and the schools drift back
 *    in. Grab at one and it's a coin toss — raw fish in hand, or empty
 *    fingers. Eat it raw from the pack of what you're holding, or cook it
 *    once you've kindled a fire. Thrash around and you'll never get near them.
 *
 * Both are plain interactables in the shared registry. Cooking lives in
 * improvise — this module only catches and holds. Held fish also shows in the
 * Pack and the HUD stash strip.
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
}

const GRAB_RANGE = 2.2
const CRATE_RANGE = 2.9

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
  // you're hanging still enough not to have spooked the school
  let current = -1
  let rawFish = 0
  const fishPos = new THREE.Vector3()
  deps.interactions.add({
    position: fishPos,
    verb: 'Grab',
    label: 'Fish',
    radius: GRAB_RANGE,
    available: () => current >= 0 && vitals.alive,
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

  function update(camera: THREE.PerspectiveCamera, view: PlayerFrame) {
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
  }

  function eatRaw() {
    if (rawFish <= 0) return false
    rawFish -= 1
    eat(vitals, 0.14, 0.02)
    return true
  }

  function cook() {
    if (rawFish <= 0) return false
    rawFish -= 1
    // Fire buys you a real meal — more food, a little water from the juices
    eat(vitals, 0.32, 0.06)
    return true
  }

  function reset() {
    rawFish = 0
  }

  /** Dev / tests — put fish in hand without diving. */
  function grant(n = 1) {
    rawFish += Math.max(0, n)
  }

  return {
    update,
    reset,
    grant,
    get rawFish() {
      return rawFish
    },
    eatRaw,
    cook,
  }
}
