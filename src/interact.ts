import * as THREE from 'three'

/**
 * Things you can act on. Nothing here glows or pins itself to the HUD — an
 * interactable only announces itself once you're already close enough to touch
 * it, which keeps finding things a matter of looking rather than following.
 */

export type Interactable = {
  /** World position. Owners move this in place as their object drifts. */
  position: THREE.Vector3
  /** Shown as "F · Take plank". */
  verb: string
  label: string
  radius: number
  available: () => boolean
  use: () => void
  /**
   * Higher wins when two things are similarly close. Used so expanding a
   * deck (Lay Platform into the empty cell you're facing) isn't stolen by
   * Raise Wall on the edge you're looking past.
   */
  priority?: number
}

export type InteractableSpec = Omit<Interactable, 'radius' | 'available'> & {
  radius?: number
  available?: () => boolean
  priority?: number
}

const REACH = 2.9

export function createInteractions() {
  const items = new Set<Interactable>()
  const toItem = new THREE.Vector3()
  const forward = new THREE.Vector3()

  return {
    add(spec: InteractableSpec): Interactable {
      const item: Interactable = { radius: REACH, available: () => true, ...spec }
      items.add(item)
      return item
    },

    remove(item: Interactable) {
      items.delete(item)
    },

    /** Nearest thing in reach, biased toward whatever you're facing. */
    find(camera: THREE.Camera): Interactable | null {
      camera.getWorldDirection(forward)
      let best: Interactable | null = null
      let bestScore = Infinity

      for (const item of items) {
        if (!item.available()) continue
        toItem.copy(item.position).sub(camera.position)
        const distance = toItem.length()
        if (distance > item.radius) continue

        const facing = distance > 1e-3 ? toItem.divideScalar(distance).dot(forward) : 1
        if (facing < -0.4) continue

        const score = distance - facing * 1.2 - (item.priority ?? 0)
        if (score < bestScore) {
          bestScore = score
          best = item
        }
      }

      return best
    },

    /** Dev: every live candidate and its score, for tuning prompt contention. */
    candidates(camera: THREE.Camera) {
      camera.getWorldDirection(forward)
      const out: { verb: string; label: string; distance: number; facing: number; score: number }[] = []
      for (const item of items) {
        let why = ''
        if (!item.available()) why = 'unavailable'
        toItem.copy(item.position).sub(camera.position)
        const distance = toItem.length()
        if (!why && distance > item.radius) why = 'far'
        const facing = distance > 1e-3 ? toItem.divideScalar(distance).dot(forward) : 1
        if (!why && facing < -0.4) why = 'behind'
        out.push({
          verb: item.verb,
          label: item.label,
          distance: +distance.toFixed(2),
          facing: +facing.toFixed(2),
          score: +(distance - facing * 1.2 - (item.priority ?? 0)).toFixed(2),
          why,
        } as never)
      }
      return out
    },
  }
}

export type Interactions = ReturnType<typeof createInteractions>
