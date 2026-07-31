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
 *    in. Grab at one and it's a coin toss — raw fish now, or empty fingers.
 *    Thrash around and you'll never get near them.
 *
 * Both are plain interactables in the shared registry.
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
        eat(vitals, 0.14, 0.02)
        hud.whisper('Raw fish. It stays down.')
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

  return { update }
}
