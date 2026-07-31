import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * The shark — a rare event, not an encounter.
 *
 * Design lock: predators exist in this ocean, but combat stays off until the
 * player chooses it (a spear, Phase B). With permadeath, an unanswerable
 * killer would be cheap. So for now the shark is foreshadowing: every few
 * minutes a big shape slides out of the murk, takes one slow circle through
 * your water — never closer than ~17 m, always below you — and is gone again.
 *
 * What it teaches: the deep is not empty, and you are not the top of it.
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
}

export function createShark(scene: THREE.Scene, opts: SharkOptions = {}) {
  const { root, tail } = buildShark()
  scene.add(root)

  let cooldown = opts.summonIn ?? 190 + Math.random() * 160
  let active = false
  let elapsed = 0
  let theta = 0
  let radius = 75
  let saidHello = false
  let proximity = 0

  const centre = new THREE.Vector3()
  const pos = new THREE.Vector3()
  const heading = new THREE.Vector3()
  const pushable = { x: 0, y: 0, z: 0 }

  const APPROACH = 28
  const CIRCLE = 40
  const DURATION = 72

  function begin(camera: THREE.PerspectiveCamera) {
    active = true
    elapsed = 0
    saidHello = false
    theta = Math.random() * TAU
    radius = 75
    centre.copy(camera.position)
    root.visible = true
  }

  function update(dt: number, time: number, camera: THREE.PerspectiveCamera, hasDived: boolean) {
    if (!active) {
      proximity = 0
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
    // Approach → one slow circle → leave, all in the radius
    if (elapsed < APPROACH) {
      const f = elapsed / APPROACH
      radius = 75 + (17 - 75) * (f * f * (3 - 2 * f))
    } else if (elapsed < CIRCLE) {
      radius = 17
    } else {
      radius = 17 + ((elapsed - CIRCLE) / (DURATION - CIRCLE)) * 100
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

    // Stay out of the reef if the pass happens over the wreck
    if (opts.resolve) {
      pushable.x = pos.x
      pushable.y = pos.y
      pushable.z = pos.z
      opts.resolve(pushable)
      pos.set(pushable.x, pushable.y, pushable.z)
    }

    root.position.copy(pos)
    // Tangent of the circle in the direction theta advances
    heading.set(-Math.sin(theta), 0, Math.cos(theta))
    root.lookAt(pos.x + heading.x, pos.y, pos.z + heading.z)

    tail.rotation.y = Math.sin(time * 3.4) * 0.4
    root.rotation.z = Math.sin(time * 0.9) * 0.06

    const dist = camera.position.distanceTo(pos)
    proximity = Math.max(0, 1 - dist / 55)
    if (!saidHello && dist < 32) {
      saidHello = true
      opts.whisper?.('Something large passes below.')
    }

    if (elapsed > DURATION) {
      active = false
      root.visible = false
      proximity = 0
      cooldown = 280 + Math.random() * 340
    }
  }

  return {
    update,
    /** 0 far/absent → 1 right under you. Feeds the low audio pulse. */
    get proximity() {
      return proximity
    },
    get active() {
      return active
    },
  }
}
