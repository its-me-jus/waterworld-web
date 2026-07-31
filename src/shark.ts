import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * The shark — a rare event that becomes a question.
 *
 * Design lock: predators exist in this ocean, but combat only arrives once
 * the player can answer it (the mate's spear, Phase B). With permadeath, an
 * unanswerable killer would be cheap.
 *
 * Unarmed, nothing changes from Phase A: every few minutes a big shape
 * slides out of the murk, takes one slow circle through your water — never
 * closer than ~17 m, always below you — and is gone again. Foreshadowing.
 *
 * Armed, it treats you as competition: the circle tightens to ~11 m, and
 * about two passes in three it commits — a fast run straight at you. A spear
 * jab inside ~4 m turns it (each answer teaches it to stay away longer);
 * let the run connect and it takes a piece of you. One wound clots. Two
 * don't.
 */

const TAU = Math.PI * 2

type SharkParts = {
  root: THREE.Group
  tail: THREE.Group
}

function buildShark(): SharkParts {
  const mat = new THREE.MeshStandardMaterial({ color: 0x3d4b53, roughness: 0.78 })
  const root = new THREE.Group()

  // Body: a stretched sphere, ~4.5 m nose to peduncle. Forward is +z (same
  // convention as the fish, so lookAt(pos + heading) aims it correctly).
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), mat)
  body.scale.set(0.52, 0.58, 2.25)
  root.add(body)

  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.0, 10), mat)
  snout.rotation.x = Math.PI / 2
  snout.position.set(0, -0.04, 2.4)
  root.add(snout)

  // Dorsal — the silhouette everyone knows
  const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.05, 6), mat)
  dorsal.scale.set(0.16, 1, 0.9)
  dorsal.position.set(0, 0.72, 0.35)
  dorsal.rotation.x = -0.28
  root.add(dorsal)

  // Pectorals, swept low and wide
  const finGeo = new THREE.ConeGeometry(0.34, 1.5, 5)
  finGeo.scale(0.14, 1, 0.55)
  finGeo.translate(0, -0.75, 0)
  const pecL = new THREE.Mesh(finGeo, mat)
  pecL.position.set(-0.5, -0.28, 0.9)
  pecL.rotation.z = 1.05
  pecL.rotation.y = 0.35
  root.add(pecL)
  const pecR = new THREE.Mesh(finGeo, mat)
  pecR.position.set(0.5, -0.28, 0.9)
  pecR.rotation.z = -1.05
  pecR.rotation.y = -0.35
  root.add(pecR)

  // Tail on its own pivot so the whole rear half can sweep
  const tail = new THREE.Group()
  tail.position.set(0, 0, -2.1)
  root.add(tail)

  const peduncle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, 1.1, 8), mat)
  peduncle.rotation.x = Math.PI / 2
  peduncle.position.z = -0.5
  tail.add(peduncle)

  const flukeGeo = mergeGeometries(
    [
      new THREE.ConeGeometry(0.34, 1.35, 5).translate(0, 0.62, 0),
      new THREE.ConeGeometry(0.26, 0.85, 5).rotateZ(Math.PI).translate(0, -0.38, 0),
    ],
    false,
  ) as THREE.BufferGeometry
  flukeGeo.scale(0.14, 1, 0.7)
  const fluke = new THREE.Mesh(flukeGeo, mat)
  fluke.position.z = -1.05
  tail.add(fluke)

  root.visible = false
  return { root, tail }
}

export type SharkOptions = {
  /** Optional collider (the wreck's) so a pass never ghosts through the reef. */
  resolve?: (p: { x: number; y: number; z: number }) => void
  whisper?: (text: string) => void
  /** Debug/tuning: seconds until the first pass (?shark=8). */
  summonIn?: number
  /** Debug/tuning: every armed pass commits to a run (?commit=1). */
  alwaysCommit?: boolean
  /** It has decided: a fast run straight at the swimmer. Telegraph line. */
  onCommit?: () => void
  /** The run connected — nobody answered. Vitals decides what it costs. */
  onBite?: () => void
}

type Mode = 'approach' | 'circle' | 'commit' | 'retreat' | 'flee'

export function createShark(scene: THREE.Scene, opts: SharkOptions = {}) {
  const { root, tail } = buildShark()
  scene.add(root)

  let cooldown = opts.summonIn ?? 190 + Math.random() * 160
  let active = false
  let armed = false
  let strikes = 0

  let elapsed = 0
  let theta = 0
  let radius = 75
  let mode: Mode = 'approach'
  let saidHello = false
  let committed = false
  let runT = 0
  let runMinDist = Infinity
  let proximity = 0
  let distance = Infinity
  let tailBeat = 3.4

  const centre = new THREE.Vector3()
  const pos = new THREE.Vector3()
  const heading = new THREE.Vector3()
  const desired = new THREE.Vector3()
  const fleeDir = new THREE.Vector3()
  const pushable = { x: 0, y: 0, z: 0 }

  const APPROACH = 28
  const CIRCLE = 40
  const DURATION = 72

  function begin(camera: THREE.PerspectiveCamera) {
    active = true
    elapsed = 0
    saidHello = false
    committed = false
    theta = Math.random() * TAU
    radius = 75
    mode = 'approach'
    centre.copy(camera.position)
    root.visible = true
  }

  function endEncounter(calm: number) {
    active = false
    root.visible = false
    proximity = 0
    distance = Infinity
    const base = armed ? 230 + Math.random() * 170 : 280 + Math.random() * 340
    cooldown = base * calm
  }

  function startCommit() {
    mode = 'commit'
    runT = 0
    runMinDist = Infinity
    opts.onCommit?.()
  }

  function breakAway(struck: boolean) {
    mode = 'flee'
    runT = 0
    // Away from the swimmer and down — struck ones go harder and erratic
    fleeDir.subVectors(pos, centre)
    fleeDir.y = 0
    if (fleeDir.lengthSq() < 1e-6) fleeDir.set(1, 0, 0)
    fleeDir.normalize()
    if (struck) {
      fleeDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 1.2)
    }
  }

  /** A spear jab landing: the answer Phase B gives the question. */
  function strike() {
    if (!active || mode === 'flee') return false
    strikes++
    breakAway(true)
    return true
  }

  /** Phase B: the player can answer now, so the question gets sharper. */
  function arm() {
    armed = true
  }

  function update(dt: number, time: number, camera: THREE.PerspectiveCamera, hasDived: boolean) {
    if (!active) {
      proximity = 0
      distance = Infinity
      // Never in the first hundred seconds, and never before the player's
      // first dive — the deep earns its reputation after you've seen it.
      // A debug summon skips both courtesies.
      if (hasDived && (time > 100 || opts.summonIn !== undefined)) {
        cooldown -= dt
        if (cooldown <= 0) begin(camera)
      }
      return
    }

    elapsed += dt
    const circleR = armed ? 11.5 : 17

    if (mode === 'approach') {
      const f = Math.min(1, elapsed / APPROACH)
      radius = 75 + (circleR - 75) * (f * f * (3 - 2 * f))
      if (elapsed >= APPROACH) mode = 'circle'
    } else if (mode === 'circle') {
      radius = circleR
      // Armed and halfway round: it weighs you up, and usually commits
      if (armed && !committed && elapsed > APPROACH + (CIRCLE - APPROACH) * 0.55) {
        committed = true
        if (opts.alwaysCommit || Math.random() < 0.65) startCommit()
      }
      if (elapsed >= CIRCLE) mode = 'retreat'
    }

    if (mode === 'commit') {
      runT += dt
      // A fast, slightly stiff pursuit curve — you have maybe two seconds
      desired.subVectors(camera.position, pos).normalize()
      heading.lerp(desired, Math.min(1, dt * 2.4)).normalize()
      pos.addScaledVector(heading, 8.4 * dt)

      distance = camera.position.distanceTo(pos)
      runMinDist = Math.min(runMinDist, distance)

      if (distance < 1.9) {
        opts.onBite?.()
        breakAway(false)
      } else if ((runT > 3 && distance > runMinDist + 1.5) || runT > 9) {
        // Missed — either you slipped it or it thought better of the angle
        breakAway(false)
      }
    } else if (mode === 'flee') {
      runT += dt
      const speed = strikes > 0 && runT < 2 ? 12 : 9
      pos.addScaledVector(fleeDir, speed * dt)
      pos.y = Math.max(pos.y - dt * (2.2 + strikes), -16)
      heading.copy(fleeDir)
      if (runT > 5.5) {
        // Every answered pass teaches it to leave your water alone longer
        endEncounter(Math.pow(1.7, strikes) * 0.8)
        return
      }
    } else {
      // Circle & retreat ride the ring, as they always have
      if (mode === 'retreat') {
        radius = circleR + ((elapsed - CIRCLE) / (DURATION - CIRCLE)) * 100
        if (elapsed > DURATION) {
          endEncounter(1)
          return
        }
      }

      // Keep the ring loosely centred on the swimmer during the approach, so
      // the pass lands close even if they're making way
      const trail = elapsed < CIRCLE ? 0.05 : 0.01
      centre.x += (camera.position.x - centre.x) * Math.min(1, dt * trail)
      centre.z += (camera.position.z - centre.z) * Math.min(1, dt * trail)

      theta += (3.6 / Math.max(radius, 8)) * dt
      pos.set(
        centre.x + Math.cos(theta) * radius,
        Math.min(-4.5, -9.5 + Math.sin(elapsed * 0.35) * 2.2),
        centre.z + Math.sin(theta) * radius,
      )
      // Tangent of the circle in the direction theta advances
      heading.set(-Math.sin(theta), 0, Math.cos(theta))
      distance = camera.position.distanceTo(pos)
    }

    // Stay out of the reef if the pass happens over the wreck
    if (opts.resolve) {
      pushable.x = pos.x
      pushable.y = pos.y
      pushable.z = pos.z
      opts.resolve(pushable)
      pos.set(pushable.x, pushable.y, pushable.z)
    }

    root.position.copy(pos)
    root.lookAt(pos.x + heading.x, pos.y + heading.y, pos.z + heading.z)

    const tailTarget = mode === 'flee' ? 11 : mode === 'commit' ? 7.5 : 3.4
    tailBeat += (tailTarget - tailBeat) * Math.min(1, dt * 3)
    tail.rotation.y = Math.sin(time * tailBeat) * (mode === 'flee' ? 0.55 : 0.4)
    root.rotation.z = Math.sin(time * 0.9) * 0.06

    proximity = Math.max(0, 1 - distance / 55)
    if (!saidHello && distance < 32) {
      saidHello = true
      opts.whisper?.('Something large passes below.')
    }
  }

  return {
    update,
    strike,
    arm,
    /** 0 far/absent → 1 right under you. Feeds the low audio pulse. */
    get proximity() {
      return proximity
    },
    get active() {
      return active
    },
    get armed() {
      return armed
    },
    get mode() {
      return mode
    },
    /** Metres from the swimmer's eye — jab range checks and tuning hooks. */
    get distance() {
      return distance
    },
    /** Live world position (internal vector, valid until next update). */
    get position() {
      return pos
    },
  }
}

export type Shark = ReturnType<typeof createShark>
