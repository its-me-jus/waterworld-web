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
  lanternSpot: () => THREE.Vector3 | null
  takeLantern: () => boolean
  suitLeft: () => boolean
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
  let hasLantern = false
  let lunge = 0
  let lanternClock = 0

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

  // —— the diving lantern viewmodel ————————————————————————————————
  // It rides low on the left, opposite the spear. The lamp is sealed ship's
  // gear: brass cage, clouded glass, and no separate fuel economy.
  const lantern = new THREE.Group()
  const lanternBasePos = new THREE.Vector3(-0.33, -0.34, -0.67)
  const lanternBaseRot = new THREE.Euler(0.08, -0.18, -0.12)
  lantern.position.copy(lanternBasePos)
  lantern.rotation.copy(lanternBaseRot)
  lantern.visible = false
  camera.add(lantern)

  const lanternBrass = new THREE.MeshStandardMaterial({
    color: 0x9b7135,
    roughness: 0.42,
    metalness: 0.72,
    emissive: 0x2a1806,
    emissiveIntensity: 0.3,
  })
  const lanternGlass = new THREE.MeshStandardMaterial({
    color: 0xffd9a0,
    roughness: 0.24,
    transparent: true,
    opacity: 0.72,
    emissive: 0xffb850,
    emissiveIntensity: 0.08,
  })
  const glass = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 9), lanternGlass)
  lantern.add(glass)

  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.12, 0.045, 10), lanternBrass)
  cap.position.y = 0.1
  lantern.add(cap)
  const base = cap.clone()
  base.position.y = -0.1
  base.rotation.z = Math.PI
  lantern.add(base)

  const cageBarGeometry = new THREE.CylinderGeometry(0.009, 0.009, 0.2, 6)
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2
    const bar = new THREE.Mesh(cageBarGeometry, lanternBrass)
    bar.position.set(Math.cos(angle) * 0.095, 0, Math.sin(angle) * 0.095)
    lantern.add(bar)
  }
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.012, 6, 14, Math.PI), lanternBrass)
  handle.position.y = 0.125
  handle.rotation.z = Math.PI
  lantern.add(handle)

  const lanternTarget = new THREE.Object3D()
  lanternTarget.position.set(0, -0.08, -8)
  camera.add(lanternTarget)
  const lanternSpotlight = new THREE.SpotLight(0xffd090, 0, 9, 0.42, 0.55, 1.6)
  lanternSpotlight.position.set(0, 0.01, -0.02)
  lanternSpotlight.target = lanternTarget
  lantern.add(lanternSpotlight)
  const lanternFill = new THREE.PointLight(0xffc878, 0, 1.8, 1.5)
  lanternFill.position.set(0, 0, -0.08)
  lantern.add(lanternFill)

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
    available: () => gearNear() && deps.gearState() !== 'shut' && deps.suitLeft(),
    use: () => {
      if (!deps.takeSuit()) return
      wearSuit(vitals, hud.whisper)
      deps.onSuit()
      hud.whisper('Ship’s issue, never worn. The sea will have to work harder.')
    },
  })

  const lanternPos = new THREE.Vector3()
  deps.interactions.add({
    position: lanternPos,
    verb: 'Take',
    label: 'the diving lantern',
    radius: GEAR_RANGE,
    available: () => vitals.alive && deps.lanternSpot() !== null,
    use: () => {
      if (!deps.takeLantern()) return
      hasLantern = true
      lantern.visible = true
      hud.whisper('A diving lantern, sealed and dark. Night will need it.')
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

  /** URL tuning: ?knife=1, ?spear=1, ?suit=1, ?lantern=1. */
  function grant(what: 'knife' | 'spear' | 'suit' | 'lantern') {
    if (what === 'lantern') {
      if (deps.gearState() === 'shut') deps.pryGear()
      deps.takeLantern()
      hasLantern = true
      lantern.visible = true
      return
    }
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

  function update(dt: number, view: PlayerFrame, daylight = 1) {
    // Registry positions that live in world space, refreshed each frame
    const knife = deps.knifeSpot()
    if (knife) knifePos.copy(knife)
    lockerPos.copy(deps.lockerSpot())
    gearPos.copy(deps.gearSpot())
    const tin = deps.tinSpot()
    if (tin) tinPos.copy(tin)
    const log = deps.logSpot()
    if (log) logPos.copy(log)
    const lanternFind = deps.lanternSpot()
    if (lanternFind) lanternPos.copy(lanternFind)
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

    lanternClock += dt
    if (hasLantern) {
      const strokeSway = Math.sin(view.stroke * Math.PI * 2) * 0.018
      lantern.position.copy(lanternBasePos)
      lantern.position.y += Math.sin(lanternClock * 1.5) * 0.008
      lantern.rotation.copy(lanternBaseRot)
      lantern.rotation.z += strokeSway + Math.sin(lanternClock * 1.1) * 0.012

      const darkness = THREE.MathUtils.clamp((0.55 - daylight) / 0.55, 0, 1)
      const on = view.underwater && darkness > 0.05
      lanternSpotlight.intensity = on ? 2.2 * darkness : 0
      lanternFill.intensity = on ? 0.35 * darkness : 0
      lanternGlass.emissiveIntensity = on ? 0.35 + darkness * 1.45 : 0.08
    }
  }

  /** A new run: the wreck is restocked elsewhere; the swimmer starts bare. */
  function reset() {
    hasKnife = false
    hasSpear = false
    hasLantern = false
    spear.visible = false
    lantern.visible = false
    lanternSpotlight.intensity = 0
    lanternFill.intensity = 0
    lanternGlass.emissiveIntensity = 0.08
    lunge = 0
    lanternClock = 0
  }

  function snapshot() {
    return { knife: hasKnife, spear: hasSpear, lantern: hasLantern }
  }

  function restore(saved?: { knife?: boolean; spear?: boolean; lantern?: boolean }) {
    reset()
    if (!saved) return
    if (saved.knife) hasKnife = true
    if (saved.spear) grantSpear()
    if (saved.lantern) {
      hasLantern = true
      lantern.visible = true
    }
  }

  return {
    update,
    onBite,
    grant,
    reset,
    snapshot,
    restore,
    get hasKnife() {
      return hasKnife
    },
    get hasSpear() {
      return hasSpear
    },
    get hasLantern() {
      return hasLantern
    },
  }
}

export type WreckLoot = ReturnType<typeof createWreckLoot>
