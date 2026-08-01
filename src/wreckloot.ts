import * as THREE from 'three'
import type { Hud } from './hud'
import type { Interactions } from './interact'
import type { PlayerFrame } from './player'
import type { Shark } from './shark'
import { buildSpear } from './spear'
import { bite, eat, wearSuit, type Vitals } from './survival'

/**
 * Wreck loot — the wreck gives up its depth in three stages:
 *
 *  - The knife (~13 m): a galley knife in its sheath, lying by the capstan
 *    on the bow deck. A working dive. It cuts rope; that's all you ask of it.
 *  - The gear locker (~17 m): one deck down in the bow hold, a door swollen
 *    shut. The knife forces it. Inside hangs the ship's immersion suit, and
 *    with it on, the cold stops being the thing that ends every run.
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

export type GearState = 'shut' | 'open' | 'stripped'

export type WreckLootDeps = {
  interactions: Interactions
  knifeSpot: () => THREE.Vector3 | null
  takeKnife: () => boolean
  lockerSpot: () => THREE.Vector3
  lockerState: () => LockerState
  cutLashing: () => boolean
  stripLocker: () => boolean
  gearSpot: () => THREE.Vector3
  gearState: () => GearState
  pryGear: () => boolean
  takeSuit: () => boolean
  tinSpot: () => THREE.Vector3 | null
  takeTin: () => boolean
  logSpot: () => THREE.Vector3 | null
  takeLog: () => boolean
  /** Dress the swimmer in survival orange once the suit is on. */
  onSuit: () => void
  shark: Shark
  /** Contact sound: the spear landing, or the bite you didn't answer. */
  thump: (intensity: number) => void
}

const KNIFE_RANGE = 2.6
const LOCKER_RANGE = 2.9
const GEAR_RANGE = 2.4
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

  // The gear locker: same three-state shape as the chest — a door you can't
  // move, a door the knife moves, and what's hanging behind it
  const gearPos = new THREE.Vector3()
  const gearNear = () =>
    vitals.alive &&
    deps.gearState() !== 'stripped' &&
    camera.position.distanceTo(deps.gearSpot()) < GEAR_RANGE

  deps.interactions.add({
    position: gearPos,
    verb: 'Haul at',
    label: 'the hold door',
    radius: GEAR_RANGE,
    available: () => gearNear() && deps.gearState() === 'shut' && !hasKnife,
    use: () => hud.whisper('Swollen shut, and years of it. You need an edge.'),
  })
  deps.interactions.add({
    position: gearPos,
    verb: 'Pry open',
    label: 'the hold door',
    radius: GEAR_RANGE,
    available: () => gearNear() && deps.gearState() === 'shut' && hasKnife,
    use: () => {
      if (!deps.pryGear()) return
      hud.whisper('The door gives, trailing a slow gout of trapped air.')
    },
  })
  deps.interactions.add({
    position: gearPos,
    verb: 'Take',
    label: 'the immersion suit',
    radius: GEAR_RANGE,
    available: () => gearNear() && deps.gearState() === 'open',
    use: () => {
      if (!deps.takeSuit()) return
      wearSuit(vitals, hud.whisper)
      deps.onSuit()
      hud.whisper('Ship’s issue, never worn. The sea will have to work harder.')
    },
  })

  // The galley tin, rolled into the corner of the same hold. Soldered shut,
  // so what's in it is a meal rather than a story about one.
  const tinPos = new THREE.Vector3()
  deps.interactions.add({
    position: tinPos,
    verb: 'Break open',
    label: 'the bread tin',
    radius: GEAR_RANGE,
    available: () => vitals.alive && deps.tinSpot() !== null,
    use: () => {
      if (!deps.takeTin()) return
      eat(vitals, 0.4, 0.05)
      hud.whisper('Ship’s biscuit, dry as the day it was baked. The tin held.')
    },
  })

  // The log under the stern transom. It feeds nothing and arms nothing; it
  // only answers the question the oilskin started.
  const logPos = new THREE.Vector3()
  deps.interactions.add({
    position: logPos,
    verb: 'Read',
    label: 'the ship’s log',
    radius: 3.1,
    available: () => vitals.alive && deps.logSpot() !== null,
    use: () => {
      if (!deps.takeLog()) return
      hud.whisper('The oilskin held. The last page is the master’s hand, not yours.')
      hud.whisper('“Reef uncharted. Mate had the watch and called it. I did not come about.”')
      hud.whisper('You read it twice. It does not change on the second reading.')
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
    available: () => {
      if (!hasSpear || !vitals.alive || !deps.shark.active) return false
      if (deps.shark.distance >= JAB_RANGE) return false
      const m = deps.shark.mode
      // The jab answers a run — telegraph or commit — or a body that got too close
      return m === 'telegraph' || m === 'commit' || (m === 'circle' && deps.shark.distance < 3.2)
    },
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

  /** URL tuning: ?knife=1, ?spear=1 fully armed, ?suit=1 already dressed. */
  function grant(what: 'knife' | 'spear' | 'suit') {
    if (what === 'suit') {
      deps.pryGear()
      deps.takeSuit()
      wearSuit(vitals)
      deps.onSuit()
      return
    }
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
    gearPos.copy(deps.gearSpot())
    const tin = deps.tinSpot()
    if (tin) tinPos.copy(tin)
    const log = deps.logSpot()
    if (log) logPos.copy(log)
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
