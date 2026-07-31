import type * as THREE from 'three'
import type { Hud } from './hud'
import type { PlayerFrame } from './player'
import type { Vitals } from './vitals'

/**
 * Forage — Phase A's answer to hunger, in two registers:
 *
 *  - The provision crate (once per run): lashed shut, still floating by the
 *    wreck. Pry it open for hardtack and dried beans — the tutorial meal that
 *    proves the world can feed you.
 *  - Hand-fishing (forever): hang still underwater and the schools drift back
 *    in. Grab at one and it's a coin toss — raw fish now, or empty fingers.
 *    Thrash around and you'll never get near them.
 *
 * Interact is F on desktop, a contextual palm button on touch.
 */

export type ForageDeps = {
  /** Bobbing world position of the crate, or null once it's been stripped. */
  provisionSpot: () => THREE.Vector3 | null
  takeProvision: () => boolean
  fish: {
    nearest: (point: THREE.Vector3, maxDist: number) => { index: number; dist: number } | null
    fling: (index: number, far: boolean) => void
  }
  mobile: boolean
}

const GRAB_RANGE = 1.9
const CRATE_RANGE = 2.7

export function createForage(app: HTMLElement, hud: Hud, vitals: Vitals, deps: ForageDeps) {
  /** What the current prompt would do if the player confirms. */
  let pending: null | { kind: 'crate' } | { kind: 'fish'; index: number } = null
  let cooldown = 0

  // Touch gets a palm button that appears exactly when a grab is possible
  const grabBtn = document.createElement('button')
  grabBtn.id = 'grab-btn'
  grabBtn.type = 'button'
  grabBtn.setAttribute('aria-label', 'Grab')
  grabBtn.textContent = '✋'
  app.appendChild(grabBtn)

  function interact() {
    if (!pending || cooldown > 0 || vitals.dead) return
    cooldown = 0.7

    if (pending.kind === 'crate') {
      if (!deps.takeProvision()) return
      vitals.feed(0.5)
      hud.whisper('Hardtack and dried beans. A week’s luck.')
      return
    }

    // Hand-fishing: better odds the slower you're moving when you strike
    if (Math.random() < 0.55) {
      deps.fish.fling(pending.index, true)
      vitals.feed(0.14)
      hud.whisper('Raw fish. It stays down.')
    } else {
      deps.fish.fling(pending.index, false)
      hud.whisper('It slips through your fingers.')
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyF') interact()
  })
  grabBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    interact()
  })

  /**
   * `claimed`: another interaction layer (the wreck salvage) has the prompt
   * and the F key this frame — stay out of its way.
   */
  function update(dt: number, camera: THREE.PerspectiveCamera, view: PlayerFrame, claimed = false) {
    cooldown = Math.max(0, cooldown - dt)
    pending = null

    if (!vitals.dead && !claimed) {
      // The crate wins the prompt when both are in reach
      const spot = deps.provisionSpot()
      if (spot && view.submersion < 0.7) {
        const dx = camera.position.x - spot.x
        const dz = camera.position.z - spot.z
        const dy = camera.position.y - spot.y
        if (dx * dx + dz * dz < CRATE_RANGE * CRATE_RANGE && Math.abs(dy) < 2.2) {
          pending = { kind: 'crate' }
        }
      }

      if (!pending && view.underwater && view.effort < 0.3) {
        const hit = deps.fish.nearest(camera.position, GRAB_RANGE)
        if (hit) pending = { kind: 'fish', index: hit.index }
      }
    }

    // Salvage owns the prompt and the palm button this frame — leave the
    // prompt alone, but don't leave our button hanging over theirs
    if (claimed) {
      grabBtn.classList.remove('show')
      return
    }

    const key = deps.mobile ? '✋' : 'F'
    hud.setPrompt(
      pending?.kind === 'crate'
        ? `${key} — pry the crate open`
        : pending?.kind === 'fish'
          ? `${key} — grab the fish`
          : null,
    )
    grabBtn.classList.toggle('show', deps.mobile && pending !== null)
  }

  return { update }
}
