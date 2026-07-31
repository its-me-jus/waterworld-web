import * as THREE from 'three'
import type { Hud } from './hud'
import type { PlayerFrame } from './player'
import type { Shark } from './shark'
import { buildSpear } from './spear'
import type { Vitals } from './vitals'

/**
 * Salvage — Phase B's answer to the wreck, in three depths:
 *
 *  - The knife (~13 m): a galley knife in its sheath, lying by the capstan
 *    on the bow deck. A working dive. It cuts rope; that's all you ask of it.
 *  - The sealed locker (~24 m): the mate's chest, roped shut on the sand by
 *    the torn stern, where the light gives up. The knife parts the lashing;
 *    inside are an oilskin pouch and the mate's spear.
 *  - The memory: opening the pouch gives back one fragment of who you were —
 *    mate on the Wanderer — and the spear makes the shark a question you can
 *    answer. Jab it (F) when a run comes inside ~4 m and it turns; let the
 *    run connect and it takes a piece of you.
 *
 * Priority over foraging: a shark in your face outranks dinner, and the
 * wreck's named things outrank everything. Interact is F on desktop, the
 * palm button on touch.
 */

export type LockerState = 'sealed' | 'cut' | 'stripped'

export type SalvageDeps = {
  knifeSpot: () => THREE.Vector3 | null
  takeKnife: () => boolean
  lockerSpot: () => THREE.Vector3
  lockerState: () => LockerState
  cutLashing: () => boolean
  stripLocker: () => boolean
  shark: Shark
  /** Contact sound: the spear landing, or the bite you didn't answer. */
  thump: (intensity: number) => void
  mobile: boolean
}

const KNIFE_RANGE = 2.3
const LOCKER_RANGE = 2.7
const JAB_RANGE = 4.2

const UP = new THREE.Vector3(0, 1, 0)

export function createSalvage(
  app: HTMLElement,
  camera: THREE.PerspectiveCamera,
  hud: Hud,
  vitals: Vitals,
  deps: SalvageDeps,
) {
  let hasKnife = false
  let hasSpear = false
  let cooldown = 0
  let lunge = 0

  type Pending =
    | { kind: 'knife' }
    | { kind: 'lashing-tug' }
    | { kind: 'lashing-cut' }
    | { kind: 'strip' }
    | { kind: 'jab' }
  let pending: Pending | null = null

  // —— the memory overlay — a warm dim, not a UI panel ————————————————
  const memoryEl = document.createElement('div')
  memoryEl.id = 'memory'
  app.appendChild(memoryEl)

  // —— the spear viewmodel ——————————————————————————————————————————
  // Held across the body, tip up and forward, butt riding past the right
  // shoulder. Parented to the camera like the swimmer rig, with its own
  // small sway so it reads as carried, not bolted to your face.
  const spear = buildSpear()
  spear.scale.setScalar(1.12)
  spear.visible = false
  camera.add(spear)

  const spearBasePos = new THREE.Vector3(0.32, -0.3, -0.85)
  const spearBaseQuat = new THREE.Quaternion().setFromUnitVectors(
    UP,
    new THREE.Vector3(-0.27, 0.73, -0.69).normalize(),
  )
  const swayQuat = new THREE.Quaternion()
  const swayAxis = new THREE.Vector3(0, 0, 1)

  // Touch gets the same contextual palm button foraging uses
  const useBtn = document.createElement('button')
  useBtn.id = 'use-btn'
  useBtn.type = 'button'
  useBtn.setAttribute('aria-label', 'Use')
  useBtn.textContent = '✋'
  app.appendChild(useBtn)

  /** The pouch and the spear — and one piece of who you were. */
  function remember() {
    memoryEl.classList.add('show')
    window.setTimeout(() => memoryEl.classList.remove('show'), 16000)
    hud.whisper('An oilskin pouch. Your fingers remember the knot.')
    hud.whisper('A brass locket. Her face — and the vow you made sailing out.')
    hud.whisper('You were mate on the Wanderer. The reef was your watch to keep.')
    hud.whisper('Wrapped beneath it, a spear. You knew how to keep a shark honest.')
  }

  function grantSpear() {
    hasSpear = true
    spear.visible = true
    deps.shark.arm()
  }

  function interact() {
    if (!pending || cooldown > 0 || vitals.dead) return
    cooldown = 0.7

    switch (pending.kind) {
      case 'knife':
        if (!deps.takeKnife()) return
        hasKnife = true
        hud.whisper('A galley knife, still sound in its sheath. Yours now.')
        return

      case 'lashing-tug':
        hud.whisper('Wet rope, swollen tight. Bare hands won’t part it.')
        return

      case 'lashing-cut':
        if (!deps.cutLashing()) return
        hud.whisper('The rope parts. The lid swings wide on the dark.')
        return

      case 'strip':
        if (!deps.stripLocker()) return
        grantSpear()
        remember()
        return

      case 'jab':
        lunge = 1
        if (deps.shark.strike()) {
          deps.thump(1)
          hud.whisper('Your spear finds it. The water boils — and it is gone.')
        }
        return
    }
  }

  /** Wired to the shark: its run connected. Vitals prices the wound. */
  function onBite() {
    vitals.bite()
    deps.thump(vitals.dead ? 1.2 : 0.85)
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyF') interact()
  })
  useBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    interact()
  })

  const toShark = new THREE.Vector3()
  const camForward = new THREE.Vector3()

  /** Returns true when it has the prompt — forage stays out of the way. */
  function update(dt: number, view: PlayerFrame): boolean {
    cooldown = Math.max(0, cooldown - dt)
    pending = null

    if (!vitals.dead) {
      // The jab outranks everything: it's the only prompt that keeps you alive
      if (hasSpear && deps.shark.active && deps.shark.distance < JAB_RANGE) {
        toShark.subVectors(deps.shark.position, camera.position).normalize()
        camera.getWorldDirection(camForward)
        if (camForward.dot(toShark) > 0.2) pending = { kind: 'jab' }
      }

      if (!pending) {
        const locker = deps.lockerSpot()
        const state = deps.lockerState()
        if (state !== 'stripped' && camera.position.distanceTo(locker) < LOCKER_RANGE) {
          pending =
            state === 'cut' ? { kind: 'strip' } : hasKnife ? { kind: 'lashing-cut' } : { kind: 'lashing-tug' }
        }
      }

      if (!pending) {
        const spot = deps.knifeSpot()
        if (spot && camera.position.distanceTo(spot) < KNIFE_RANGE) pending = { kind: 'knife' }
      }
    }

    const key = deps.mobile ? '✋' : 'F'
    hud.setPrompt(
      pending?.kind === 'jab'
        ? `${key} — jab with the spear`
        : pending?.kind === 'knife'
          ? `${key} — work the knife free`
          : pending?.kind === 'lashing-tug'
            ? `${key} — tug at the lashing`
            : pending?.kind === 'lashing-cut'
              ? `${key} — cut the lashing`
              : pending?.kind === 'strip'
                ? `${key} — reach inside`
                : null,
    )
    useBtn.classList.toggle('show', deps.mobile && pending !== null)

    // Carried spear: stroke sway, plus the thrust when you answer a run
    lunge = Math.max(0, lunge - dt * 3.2)
    if (hasSpear) {
      const sway = Math.sin(view.stroke * Math.PI * 2) * 0.028
      swayQuat.setFromAxisAngle(swayAxis, sway)
      spear.quaternion.copy(spearBaseQuat).multiply(swayQuat)
      const thrust = lunge < 0.55 ? (lunge / 0.55) * 0.5 : (1 - lunge) * 0.9
      spear.position.copy(spearBasePos)
      spear.position.z -= thrust
    }

    return pending !== null
  }

  /** URL tuning: ?knife=1 starts with the knife, ?spear=1 fully armed. */
  function grant(what: 'knife' | 'spear') {
    if (what === 'spear') {
      hasKnife = true
      deps.takeKnife()
      grantSpear()
      return
    }
    hasKnife = true
    deps.takeKnife()
  }

  return {
    update,
    onBite,
    grant,
    get hasKnife() {
      return hasKnife
    },
    get hasSpear() {
      return hasSpear
    },
  }
}

export type Salvage = ReturnType<typeof createSalvage>
