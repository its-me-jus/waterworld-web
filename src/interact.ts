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
}

export type InteractableSpec = Omit<Interactable, 'radius' | 'available'> & {
  radius?: number
  available?: () => boolean
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

        const score = distance - facing * 1.2
        if (score < bestScore) {
          bestScore = score
          best = item
        }
      }

      return best
    },
  }
}

export type Interactions = ReturnType<typeof createInteractions>
