import * as THREE from 'three'
import type { Hud } from './hud'
import type { Interactions } from './interact'
import type { PlayerFrame } from './player'
import { buildNet, buildRod, setRodLine } from './fishinggear'
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
  camera: THREE.PerspectiveCamera
  scene: THREE.Scene
  sfx?: (kind: string, intensity?: number) => void
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
const SPLASH_BEAT = 0.45
const CATCH_BEAT = 0.72
const ACTION_DURATION = 1
const UP = new THREE.Vector3(0, 1, 0)

type FishingTool = 'rod' | 'net'
type FishingAction = {
  tool: FishingTool
  age: number
  fishIndex: number
  success: boolean
  bonus: number
  target: THREE.Vector3
}

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
  let equipped: FishingTool | null = null
  let action: FishingAction | null = null
  let rodCool = 0
  let netCool = 0

  // Camera-carried fishing gear, posed in the same viewmodel space as the
  // mate's spear. Only the equipped tool appears when it has a target.
  const rod = buildRod()
  const net = buildNet()
  rod.scale.setScalar(0.82)
  net.scale.setScalar(0.76)
  rod.visible = false
  net.visible = false
  deps.camera.add(rod)
  deps.camera.add(net)

  const rodBasePos = new THREE.Vector3(0.42, -0.42, -0.82)
  const netBasePos = new THREE.Vector3(0.03, -0.43, -0.72)
  const rodBaseQuat = new THREE.Quaternion().setFromUnitVectors(
    UP,
    new THREE.Vector3(-0.18, 0.82, -0.55).normalize(),
  )
  const netBaseQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.28, 0, -0.08))
  const swayQuat = new THREE.Quaternion()
  const actionQuat = new THREE.Quaternion()
  const swayAxis = new THREE.Vector3(0, 0, 1)
  const castAxis = new THREE.Vector3(1, 0, 0)
  const lineTarget = new THREE.Vector3()
  const lineTip = new THREE.Vector3(0, 1.32, 0)
  const netOpen = net.getObjectByName('open') as THREE.Mesh | undefined

  // One world-space ripple is reused for every cast instead of allocating
  // effects in the interaction callback.
  const splashMaterial = new THREE.MeshBasicMaterial({
    color: 0xd7f4f2,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  })
  const splash = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.025, 5, 24), splashMaterial)
  splash.rotation.x = Math.PI / 2
  splash.visible = false
  splash.renderOrder = 4
  deps.scene.add(splash)
  let splashAge = Number.POSITIVE_INFINITY

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
    available: () =>
      rodCurrent >= 0 &&
      vitals.alive &&
      hasRod &&
      rodCool <= 0 &&
      !action &&
      equipped === 'rod',
    use: () => {
      const index = rodCurrent
      if (index < 0) return
      rodCool = 7.5
      action = {
        tool: 'rod',
        age: 0,
        fishIndex: index,
        success: Math.random() < 0.62,
        bonus: 0,
        target: deps.fish.positionAt(index, new THREE.Vector3()).clone(),
      }
      current = -1
      spearCurrent = -1
      rodCurrent = -1
      netCurrent = -1
    },
  })

  // Cast net — scoop the wash while wading; sometimes two fish at once
  deps.interactions.add({
    position: netFishPos,
    verb: 'Scoop',
    label: 'Net',
    radius: NET_RANGE,
    available: () =>
      netCurrent >= 0 &&
      vitals.alive &&
      hasNet &&
      netCool <= 0 &&
      !action &&
      equipped === 'net',
    use: () => {
      const index = netCurrent
      if (index < 0) return
      netCool = 5.5
      const success = Math.random() < 0.58
      action = {
        tool: 'net',
        age: 0,
        fishIndex: index,
        success,
        bonus: success && Math.random() < 0.28 ? 1 : 0,
        target: deps.fish.positionAt(index, new THREE.Vector3()).clone(),
      }
      current = -1
      spearCurrent = -1
      rodCurrent = -1
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

    if (splash.visible) {
      splashAge += dt
      const life = Math.min(1, splashAge / 0.55)
      splash.scale.setScalar(0.55 + life * 2.2)
      splashMaterial.opacity = (1 - life) * 0.68
      if (life >= 1) splash.visible = false
    }

    if (action) {
      const active = action
      const previousAge = active.age
      active.age += Math.max(0, dt)

      if (previousAge < SPLASH_BEAT && active.age >= SPLASH_BEAT) {
        splash.position.copy(active.target)
        splash.position.y += 0.025
        splash.scale.setScalar(0.55)
        splashMaterial.opacity = 0.68
        splashAge = 0
        splash.visible = true
        deps.sfx?.('splash', 0.45)
      }

      if (previousAge < CATCH_BEAT && active.age >= CATCH_BEAT) {
        deps.fish.fling(active.fishIndex, active.success)
        if (active.tool === 'rod') {
          if (active.success) {
            rawFish += 1
            hud.whisper(
              rawFish > 1
                ? 'Another on the line. The rod earns its keep.'
                : 'A tug, then weight. Fish on the line.',
            )
          } else {
            hud.whisper('A nibble, then nothing. The line comes back empty.')
          }
        } else if (active.success) {
          rawFish += 1 + active.bonus
          hud.whisper(
            active.bonus
              ? 'Two in the mesh. The wash was thick with them.'
              : 'One in the net. Silver and thrashing.',
          )
        } else {
          hud.whisper('The mesh comes up empty. They saw the shadow.')
        }
      }

      if (active.age >= ACTION_DURATION) {
        action = null
        setRodLine(rod, null)
        if (netOpen) netOpen.visible = false
      }
    }

    const spot = deps.provisionSpot()
    if (spot) cratePos.copy(spot)

    current = -1
    if (!action && view.underwater && view.effort < 0.3 && vitals.alive) {
      const hit = deps.fish.nearest(camera.position, GRAB_RANGE)
      if (hit) {
        current = hit.index
        deps.fish.positionAt(hit.index, fishPos)
      }
    }

    // The spear forgives a little more motion — reach buys you that
    spearCurrent = -1
    if (
      !action &&
      view.underwater &&
      view.effort < 0.55 &&
      vitals.alive &&
      (deps.hasSpear?.() ?? false)
    ) {
      const hit = deps.fish.nearest(camera.position, SPEAR_RANGE)
      if (hit) {
        spearCurrent = hit.index
        deps.fish.positionAt(hit.index, spearFishPos)
      }
    }

    // Rod: from shore (walking) or near the surface — not deep diving
    rodCurrent = -1
    if (!action && hasRod && vitals.alive && rodCool <= 0) {
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
    if (!action && hasNet && vitals.alive && netCool <= 0) {
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

    // Both tools carry a small stroke sway. Their action poses are applied on
    // top, keeping the idle placement stable while casting and hauling.
    const sway = Math.sin(view.stroke * Math.PI * 2) * 0.026
    swayQuat.setFromAxisAngle(swayAxis, sway)
    rod.position.copy(rodBasePos)
    rod.quaternion.copy(rodBaseQuat).multiply(swayQuat)
    net.position.copy(netBasePos)
    net.quaternion.copy(netBaseQuat).multiply(swayQuat)

    if (action?.tool === 'rod') {
      const age = action.age
      const draw = Math.min(1, age / 0.2)
      const snap = THREE.MathUtils.smoothstep(age, 0.2, 0.55)
      const settle = THREE.MathUtils.smoothstep(age, CATCH_BEAT, ACTION_DURATION)
      const castBend = THREE.MathUtils.lerp(-0.45 * draw, 0.52, snap) * (1 - settle)
      actionQuat.setFromAxisAngle(castAxis, castBend)
      rod.quaternion.multiply(actionQuat)
      rod.position.z += draw * 0.12 - snap * 0.28 + settle * 0.16
      rod.position.y += Math.sin(Math.min(1, age / 0.55) * Math.PI) * 0.08

      const extend = THREE.MathUtils.smoothstep(age, 0.2, SPLASH_BEAT)
      const retract = 1 - THREE.MathUtils.smoothstep(age, CATCH_BEAT, ACTION_DURATION)
      const reach = extend * retract
      if (reach > 0.01) {
        rod.updateWorldMatrix(true, false)
        lineTarget.copy(action.target)
        rod.worldToLocal(lineTarget)
        lineTarget.lerpVectors(lineTip, lineTarget, reach)
        setRodLine(rod, lineTarget)
      } else {
        setRodLine(rod, null)
      }
    } else {
      setRodLine(rod, null)
    }

    if (action?.tool === 'net') {
      const age = action.age
      const lift = THREE.MathUtils.smoothstep(age, 0, 0.18)
      const thrown = THREE.MathUtils.smoothstep(age, 0.18, 0.5)
      const pulled = THREE.MathUtils.smoothstep(age, 0.6, ACTION_DURATION)
      net.position.y += lift * 0.22 - pulled * 0.18
      net.position.z -= thrown * 0.65 - pulled * 0.58
      actionQuat.setFromAxisAngle(castAxis, -0.8 * thrown + 0.65 * pulled)
      net.quaternion.multiply(actionQuat)
      if (netOpen) {
        netOpen.visible = age >= 0.2 && age < ACTION_DURATION
        const openScale =
          0.15 +
          THREE.MathUtils.smoothstep(age, 0.2, SPLASH_BEAT) * 1.2 -
          THREE.MathUtils.smoothstep(age, CATCH_BEAT, ACTION_DURATION) * 1.05
        netOpen.scale.setScalar(openScale)
      }
    } else if (netOpen) {
      netOpen.visible = false
      netOpen.scale.setScalar(0.15)
    }

    rod.visible = equipped === 'rod' && (rodCurrent >= 0 || action?.tool === 'rod')
    net.visible = equipped === 'net' && (netCurrent >= 0 || action?.tool === 'net')
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

  /** Pull smoked fish out of the arms for crate Stow. */
  function takeSmoked(n: number) {
    const take = Math.min(smokedFish, Math.max(0, Math.floor(n)))
    smokedFish -= take
    return take
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
    equipped = null
    action = null
    rodCool = 0
    netCool = 0
    rod.visible = false
    net.visible = false
    setRodLine(rod, null)
    if (netOpen) netOpen.visible = false
    splash.visible = false
    splashAge = Number.POSITIVE_INFINITY
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
    equip('rod')
    return true
  }

  function fashionNet() {
    if (hasNet) return false
    hasNet = true
    equip('net')
    return true
  }

  function equip(tool: FishingTool | null) {
    equipped =
      tool === 'rod' && hasRod ? 'rod' : tool === 'net' && hasNet ? 'net' : null
    rod.visible = equipped === 'rod'
    net.visible = equipped === 'net'
  }

  function setGear(ownsRod: boolean, ownsNet: boolean, fishingTool?: FishingTool | null) {
    hasRod = !!ownsRod
    hasNet = !!ownsNet
    action = null
    setRodLine(rod, null)
    if (netOpen) netOpen.visible = false
    let preferred: FishingTool | null = hasRod ? 'rod' : hasNet ? 'net' : null
    if (fishingTool === null) preferred = null
    else if (fishingTool === 'rod' && hasRod) preferred = 'rod'
    else if (fishingTool === 'net' && hasNet) preferred = 'net'
    equip(preferred)
  }

  return {
    update,
    reset,
    grant,
    setFish,
    setGear,
    equip,
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
    get equipped() {
      return equipped
    },
    eatRaw,
    cook,
    takeRawForSmoke,
    addSmoked,
    takeSmoked,
    eatSmoked,
  }
}

export type Forage = ReturnType<typeof createForage>
