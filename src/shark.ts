import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { sampleOcean } from './waves'

/**
 * The shark — a rare presence you can actually see.
 *
 * A pass has two acts, so the ocean can warn you without words:
 *
 *  1. Surface cruise — only the dorsal cuts the swell, a dark triangle
 *     sliding past at ~22 m. You spot the fin from the surface.
 *  2. Below — it sinks and takes one slow circle under you, close enough
 *     that diving puts the whole body in the murk where you can read it.
 *
 * Armed (Phase B spear): the underwater circle tightens, and about two
 * passes in three it commits to a run. Jab turns it; a connected bite
 * wounds. Unarmed, it never touches you — foreshadowing only.
 */

const TAU = Math.PI * 2

type SharkParts = {
  root: THREE.Group
  tail: THREE.Group
  /** How far the dorsal tip sits above the body's centre — used to park the fin. */
  dorsalTip: number
}

function buildShark(): SharkParts {
  // Two tones: dark dorsal against the sky, paler belly in the murk
  const top = new THREE.MeshStandardMaterial({
    color: 0x2a3338,
    roughness: 0.82,
    emissive: 0x0a1014,
    emissiveIntensity: 0.35,
  })
  const belly = new THREE.MeshStandardMaterial({
    color: 0x9aa4a8,
    roughness: 0.88,
    emissive: 0x243038,
    emissiveIntensity: 0.45,
  })

  const root = new THREE.Group()

  // Body ~5 m nose to peduncle. Forward is +z.
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), top)
  body.scale.set(0.55, 0.62, 2.4)
  root.add(body)

  // Pale underside — the flash you catch looking down from the surface
  const under = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55), belly)
  under.scale.set(0.52, 0.58, 2.35)
  under.position.y = -0.06
  root.add(under)

  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.44, 1.1, 10), top)
  snout.rotation.x = Math.PI / 2
  snout.position.set(0, -0.02, 2.55)
  root.add(snout)

  // The classic silhouette — tall, thin, slightly raked. Tip sits ~1.55 m
  // above the body centre when the body is upright.
  const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.48, 1.35, 6), top)
  dorsal.scale.set(0.14, 1, 0.85)
  dorsal.position.set(0, 0.95, 0.25)
  dorsal.rotation.x = -0.22
  root.add(dorsal)
  const dorsalTip = 0.95 + 1.35 * 0.5 // ≈ 1.62

  // Pectorals
  const finGeo = new THREE.ConeGeometry(0.36, 1.6, 5)
  finGeo.scale(0.14, 1, 0.55)
  finGeo.translate(0, -0.8, 0)
  const pecL = new THREE.Mesh(finGeo, top)
  pecL.position.set(-0.55, -0.3, 0.95)
  pecL.rotation.z = 1.05
  pecL.rotation.y = 0.35
  root.add(pecL)
  const pecR = new THREE.Mesh(finGeo, top)
  pecR.position.set(0.55, -0.3, 0.95)
  pecR.rotation.z = -1.05
  pecR.rotation.y = -0.35
  root.add(pecR)

  const tail = new THREE.Group()
  tail.position.set(0, 0, -2.25)
  root.add(tail)

  const peduncle = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.3, 1.15, 8), top)
  peduncle.rotation.x = Math.PI / 2
  peduncle.position.z = -0.5
  tail.add(peduncle)

  const flukeGeo = mergeGeometries(
    [
      new THREE.ConeGeometry(0.36, 1.45, 5).translate(0, 0.68, 0),
      new THREE.ConeGeometry(0.28, 0.9, 5).rotateZ(Math.PI).translate(0, -0.4, 0),
    ],
    false,
  ) as THREE.BufferGeometry
  flukeGeo.scale(0.14, 1, 0.7)
  const fluke = new THREE.Mesh(flukeGeo, top)
  fluke.position.z = -1.1
  tail.add(fluke)

  root.visible = false
  return { root, tail, dorsalTip }
}

export type SharkOptions = {
  resolve?: (p: { x: number; y: number; z: number }) => void
  whisper?: (text: string) => void
  /** Debug/tuning: seconds until the first pass (?shark=8). */
  summonIn?: number
  /** Debug/tuning: every armed pass commits to a run (?commit=1). */
  alwaysCommit?: boolean
  onCommit?: () => void
  onBite?: () => void
}

type Mode = 'surface' | 'sink' | 'circle' | 'commit' | 'retreat' | 'flee'

export function createShark(scene: THREE.Scene, opts: SharkOptions = {}) {
  const { root, tail, dorsalTip } = buildShark()
  scene.add(root)

  // First fin can show before you've ever dived — that's the point
  let cooldown = opts.summonIn ?? 70 + Math.random() * 90
  let active = false
  let armed = false
  let strikes = 0

  let elapsed = 0
  let theta = 0
  let radius = 55
  let mode: Mode = 'surface'
  let saidHello = false
  let committed = false
  let runT = 0
  let runMinDist = Infinity
  let proximity = 0
  let distance = Infinity
  let tailBeat = 3.4
  /** Depth of the body centre below the local swell (positive = under). */
  let depthBelow = 0.55

  const centre = new THREE.Vector3()
  const pos = new THREE.Vector3()
  const heading = new THREE.Vector3()
  const desired = new THREE.Vector3()
  const fleeDir = new THREE.Vector3()
  const pushable = { x: 0, y: 0, z: 0 }

  // Surface cruise → sink → one underwater circle → leave
  const SURFACE = 22
  const SINK = 5
  const CIRCLE = 36
  const DURATION = 70

  function begin(camera: THREE.PerspectiveCamera) {
    active = true
    elapsed = 0
    saidHello = false
    committed = false
    theta = Math.random() * TAU
    radius = 36
    mode = 'surface'
    // Body deep enough that only the dorsal tip cuts the swell
    depthBelow = dorsalTip - 0.55
    centre.copy(camera.position)
    root.visible = true
  }

  function endEncounter(calm: number) {
    active = false
    root.visible = false
    proximity = 0
    distance = Infinity
    const base = armed ? 200 + Math.random() * 160 : 240 + Math.random() * 280
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
    fleeDir.subVectors(pos, centre)
    fleeDir.y = 0
    if (fleeDir.lengthSq() < 1e-6) fleeDir.set(1, 0, 0)
    fleeDir.normalize()
    if (struck) {
      fleeDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 1.2)
    }
  }

  function strike() {
    if (!active || mode === 'flee' || mode === 'surface') return false
    strikes++
    breakAway(true)
    return true
  }

  function arm() {
    armed = true
  }

  function update(dt: number, time: number, camera: THREE.PerspectiveCamera, _hasDived: boolean) {
    if (!active) {
      proximity = 0
      distance = Infinity
      // Give the opening a minute of empty ocean, then the fin can appear —
      // no need to have dived first. Debug summon skips the wait.
      if (time > 55 || opts.summonIn !== undefined) {
        cooldown -= dt
        if (cooldown <= 0) begin(camera)
      }
      return
    }

    elapsed += dt
    const circleR = armed ? 9 : 10.5
    const playerDepth = Math.max(0, sampleOcean(camera.position.x, camera.position.z, time).y - camera.position.y)

    // If you dive while the fin is still up, it follows you under early
    if (mode === 'surface' && playerDepth > 1.4 && elapsed > 6) {
      mode = 'sink'
      elapsed = SURFACE // jump the timeline into the sink window
    }

    if (mode === 'surface') {
      const f = Math.min(1, elapsed / SURFACE)
      radius = 36 + (12 - 36) * (f * f * (3 - 2 * f))
      depthBelow = dorsalTip - 0.55 + Math.sin(elapsed * 0.7) * 0.06
      if (elapsed >= SURFACE) mode = 'sink'
    } else if (mode === 'sink') {
      const t = Math.min(1, (elapsed - SURFACE) / SINK)
      const ease = t * t * (3 - 2 * t)
      depthBelow = dorsalTip - 0.55 + (6.5 - (dorsalTip - 0.55)) * ease
      radius = 12 + (circleR - 12) * ease
      if (elapsed >= SURFACE + SINK) mode = 'circle'
    } else if (mode === 'circle') {
      radius = circleR
      // Track a few metres below the swimmer's eye so a deep dive still puts
      // the body in frame — murk eats anything past ~15 m
      if (armed && !committed && elapsed > SURFACE + SINK + CIRCLE * 0.45) {
        committed = true
        if (opts.alwaysCommit || Math.random() < 0.65) startCommit()
      }
      if (elapsed >= SURFACE + SINK + CIRCLE) mode = 'retreat'
    }

    if (mode === 'commit') {
      runT += dt
      desired.subVectors(camera.position, pos).normalize()
      heading.lerp(desired, Math.min(1, dt * 2.4)).normalize()
      pos.addScaledVector(heading, 8.4 * dt)

      distance = camera.position.distanceTo(pos)
      runMinDist = Math.min(runMinDist, distance)

      if (distance < 1.9) {
        opts.onBite?.()
        breakAway(false)
      } else if ((runT > 3 && distance > runMinDist + 1.5) || runT > 9) {
        breakAway(false)
      }
    } else if (mode === 'flee') {
      runT += dt
      const speed = strikes > 0 && runT < 2 ? 12 : 9
      pos.addScaledVector(fleeDir, speed * dt)
      pos.y = Math.max(pos.y - dt * (2.2 + strikes), -16)
      heading.copy(fleeDir)
      if (runT > 5.5) {
        endEncounter(Math.pow(1.7, strikes) * 0.8)
        return
      }
    } else {
      if (mode === 'retreat') {
        radius = circleR + ((elapsed - (SURFACE + SINK + CIRCLE)) / (DURATION - (SURFACE + SINK + CIRCLE))) * 90
        depthBelow = Math.min(14, depthBelow + dt * 1.6)
        if (elapsed > DURATION) {
          endEncounter(1)
          return
        }
      }

      const trail = mode === 'surface' || mode === 'sink' || mode === 'circle' ? 0.06 : 0.015
      centre.x += (camera.position.x - centre.x) * Math.min(1, dt * trail)
      centre.z += (camera.position.z - centre.z) * Math.min(1, dt * trail)

      // Fin cruise is slow and readable; underwater circle keeps the old pace
      const rate = mode === 'surface' ? 2.4 : 3.6
      theta += (rate / Math.max(radius, 8)) * dt
      const sx = centre.x + Math.cos(theta) * radius
      const sz = centre.z + Math.sin(theta) * radius
      const swell = sampleOcean(sx, sz, time).y
      if (mode === 'circle' || mode === 'retreat') {
        // Prefer the swimmer's depth (a little below), but never breach
        const prefer = camera.position.y - 2.4
        const ceiling = swell - 3.6
        const targetY = Math.min(prefer, ceiling)
        pos.y += (targetY - pos.y) * Math.min(1, dt * 2.2)
        pos.x = sx
        pos.z = sz
      } else {
        pos.set(sx, swell - depthBelow, sz)
      }
      heading.set(-Math.sin(theta), 0, Math.cos(theta))
      distance = camera.position.distanceTo(pos)
    }

    if (opts.resolve) {
      pushable.x = pos.x
      pushable.y = pos.y
      pushable.z = pos.z
      opts.resolve(pushable)
      // On the surface cruise, don't let the reef shove the fin underground
      if (mode === 'surface') {
        const swell = sampleOcean(pushable.x, pushable.z, time).y
        pushable.y = Math.min(pushable.y, swell - (dorsalTip - 0.55))
      }
      pos.set(pushable.x, pushable.y, pushable.z)
    }

    root.position.copy(pos)
    root.lookAt(pos.x + heading.x, pos.y + heading.y, pos.z + heading.z)
    // Level the body on the surface pass so the dorsal reads as a clean triangle
    if (mode === 'surface') root.rotation.x = 0

    const tailTarget = mode === 'flee' ? 11 : mode === 'commit' ? 7.5 : mode === 'surface' ? 2.6 : 3.4
    tailBeat += (tailTarget - tailBeat) * Math.min(1, dt * 3)
    tail.rotation.y = Math.sin(time * tailBeat) * (mode === 'flee' ? 0.55 : 0.35)
    if (mode !== 'surface') root.rotation.z = Math.sin(time * 0.9) * 0.06

    proximity = Math.max(0, 1 - distance / 48)
    if (!saidHello && distance < 36) {
      saidHello = true
      opts.whisper?.('Something large passes below.')
    }
  }

  return {
    update,
    strike,
    arm,
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
    get distance() {
      return distance
    },
    get position() {
      return pos
    },
  }
}

export type Shark = ReturnType<typeof createShark>
