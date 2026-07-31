import * as THREE from 'three'
import type { Hud } from './hud'
import type { Interactions } from './interact'
import type { PlayerFrame } from './player'
import type { Shark } from './shark'
import { buildSpear } from './spear'
import { bite, type Vitals } from './survival'

/**
 * Wreck loot — the wreck gives up its depth in three stages:
 *
 *  - The knife (~13 m): a galley knife in its sheath, lying by the capstan
 *    on the bow deck. A working dive. It cuts rope; that's all you ask of it.
 *  - The sealed locker (~24 m): the mate's chest, roped shut on the sand by
 *    the torn stern, where the light gives up. The knife parts the lashing;
 *    inside are an oilskin pouch and the mate's spear.
 *  - The memory: opening the pouch gives back one fragment of who you were —
 *    mate on the Wanderer — and the spear makes the shark a question you can
 *    answer. Jab it when a run comes inside ~4 m and it turns; let the run
 *    connect and it takes a piece of you.
 *
 * Everything here is a plain interactable in the shared registry — the jab
 * wins the prompt the same way anything else does: by being closest.
 */

export type LockerState = 'sealed' | 'cut' | 'stripped'

export type WreckLootDeps = {
  interactions: Interactions
  knifeSpot: () => THREE.Vector3 | null
  takeKnife: () => boolean
  lockerSpot: () => THREE.Vector3
  lockerState: () => LockerState
  cutLashing: () => boolean
  stripLocker: () => boolean
  shark: Shark
  /** Contact sound: the spear landing, or the bite you didn't answer. */
  thump: (intensity: number) => void
}

const KNIFE_RANGE = 2.6
const LOCKER_RANGE = 2.9
const JAB_RANGE = 4.2

const UP = new THREE.Vector3(0, 1, 0)

export function createWreckLoot(
  app: HTMLElement,
  camera: THREE.PerspectiveCamera,
  hud: Hud,
  vitals: Vitals,
  deps: WreckLootDeps,
) {
  let hasKnife = false
  let hasSpear = false
  let lunge = 0

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

  // —— interactables —————————————————————————————————————————
  const knifePos = new THREE.Vector3()
  deps.interactions.add({
    position: knifePos,
    verb: 'Work free',
    label: 'Galley knife',
    radius: KNIFE_RANGE,
    available: () => deps.knifeSpot() !== null && vitals.alive,
    use: () => {
      if (!deps.takeKnife()) return
      hasKnife = true
      hud.whisper('A galley knife, still sound in its sheath. Yours now.')
    },
  })

  // The locker is one spot with three states, so it's three items at the same
  // position — exactly one is available at any time
  const lockerPos = new THREE.Vector3()
  const lockerNear = () =>
    vitals.alive &&
    deps.lockerState() !== 'stripped' &&
    camera.position.distanceTo(deps.lockerSpot()) < LOCKER_RANGE

  deps.interactions.add({
    position: lockerPos,
    verb: 'Tug at',
    label: 'the lashing',
    radius: LOCKER_RANGE,
    available: () => lockerNear() && deps.lockerState() === 'sealed' && !hasKnife,
    use: () => hud.whisper('Wet rope, swollen tight. Bare hands won’t part it.'),
  })
  deps.interactions.add({
    position: lockerPos,
    verb: 'Cut',
    label: 'the lashing',
    radius: LOCKER_RANGE,
    available: () => lockerNear() && deps.lockerState() === 'sealed' && hasKnife,
    use: () => {
      if (!deps.cutLashing()) return
      hud.whisper('The rope parts. The lid swings wide on the dark.')
    },
  })
  deps.interactions.add({
    position: lockerPos,
    verb: 'Reach inside',
    label: 'the locker',
    radius: LOCKER_RANGE,
    available: () => lockerNear() && deps.lockerState() === 'cut',
    use: () => {
      if (!deps.stripLocker()) return
      grantSpear()
      remember()
    },
  })

  // The jab: the prompt rides the shark itself, so it only ever appears while
  // a run is genuinely close — the one prompt that keeps you alive
  const jabPos = new THREE.Vector3()
  deps.interactions.add({
    position: jabPos,
    verb: 'Jab',
    label: 'with the spear',
    radius: JAB_RANGE,
    available: () =>
      hasSpear && vitals.alive && deps.shark.active && deps.shark.distance < JAB_RANGE,
    use: () => {
      lunge = 1
      if (deps.shark.strike()) {
        deps.thump(1)
        hud.whisper('Your spear finds it. The water boils — and it is gone.')
      }
    },
  })

  /** Wired to the shark: its run connected. Survival prices the wound. */
  function onBite() {
    bite(vitals, hud.whisper)
    deps.thump(vitals.alive ? 0.85 : 1.2)
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

  function update(dt: number, view: PlayerFrame) {
    // Registry positions that live in world space, refreshed each frame
    const knife = deps.knifeSpot()
    if (knife) knifePos.copy(knife)
    lockerPos.copy(deps.lockerSpot())
    if (deps.shark.active) jabPos.copy(deps.shark.position)

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
  }

  /** A new run: the wreck is restocked elsewhere; the swimmer starts bare. */
  function reset() {
    hasKnife = false
    hasSpear = false
    spear.visible = false
    lunge = 0
  }

  return {
    update,
    onBite,
    grant,
    reset,
    get hasKnife() {
      return hasKnife
    },
    get hasSpear() {
      return hasSpear
    },
  }
}

export type WreckLoot = ReturnType<typeof createWreckLoot>
