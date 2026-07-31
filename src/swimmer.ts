import * as THREE from 'three'
import { createHandPair } from './hand'
import type { PlayerFrame } from './player'

/**
 * First-person swimmer: arms, torso and kicking legs parented to the camera.
 * Hands live in `hand.ts` — they're always on screen, so they get the PBR pass.
 * Poses are keyframed per stroke style and blended as quaternions so the
 * front-crawl windmill can wrap past ±π without popping.
 */

const TAU = Math.PI * 2

const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))

/** [phase, shoulderSwing, shoulderSpread, elbowBend, wristRoll] */
type Key = [number, number, number, number, number]

/**
 * Front crawl. `swing` decreases by a full turn across the cycle: forward →
 * down → back → over the top → forward. The last key equals the first minus
 * 2π so the windmill is seamless.
 */
const CRAWL: Key[] = [
  [0.0, 1.45, 0.3, 0.35, 0.1],
  [0.15, 0.75, 0.34, 0.95, 0.18],
  [0.32, -0.05, 0.3, 1.15, 0.05],
  [0.5, -1.15, 0.26, 0.75, -0.1],
  [0.62, -1.85, 0.62, 1.35, -0.3],
  [0.8, -2.9, 0.8, 1.15, -0.2],
  [0.92, -4.1, 0.5, 0.6, 0.0],
  [1.0, -4.83, 0.3, 0.35, 0.1],
]

/** Breaststroke — both arms together, used when submerged. */
const BREAST: Key[] = [
  [0.0, 1.6, 0.16, 0.12, 0.0],
  [0.22, 1.42, 0.72, 0.45, 0.25],
  [0.42, 0.95, 0.96, 1.05, 0.45],
  [0.58, 0.5, 0.45, 1.75, 0.15],
  [0.74, 0.95, 0.2, 1.95, -0.1],
  [1.0, 1.6, 0.16, 0.12, 0.0],
]

/**
 * Treading water — hands scull in and out in front of the chest. Kept high and
 * fairly narrow so they stay inside frame even on a portrait phone, where the
 * horizontal field of view is tight.
 */
const SCULL: Key[] = [
  [0.0, 1.58, 0.05, 0.28, 0.34],
  [0.32, 1.48, 0.2, 0.48, -0.14],
  [0.66, 1.64, 0.08, 0.24, 0.38],
  [1.0, 1.58, 0.05, 0.28, 0.34],
]

type Pose = { swing: number; spread: number; elbow: number; wrist: number }

function samplePose(keys: Key[], phase: number, out: Pose) {
  const t = phase - Math.floor(phase)
  let i = 0
  while (i < keys.length - 2 && keys[i + 1][0] <= t) i++
  const a = keys[i]
  const b = keys[i + 1]
  let f = (t - a[0]) / Math.max(1e-4, b[0] - a[0])
  f = f * f * (3 - 2 * f)
  out.swing = a[1] + (b[1] - a[1]) * f
  out.spread = a[2] + (b[2] - a[2]) * f
  out.elbow = a[3] + (b[3] - a[3]) * f
  out.wrist = a[4] + (b[4] - a[4]) * f
  return out
}

/**
 * A limb segment hanging along -Y from its joint, plus a group at its far end.
 * `openEnd` skips the distal capsule cap so an anatomical hand can own the wrist.
 */
function limb(length: number, radius: number, material: THREE.Material, openEnd = false) {
  const root = new THREE.Group()
  if (openEnd) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius * 0.92, length * 0.92, 20),
      material,
    )
    mesh.position.y = -length * 0.46
    root.add(mesh)
  } else {
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(radius, Math.max(0.02, length - radius * 2), 6, 20),
      material,
    )
    mesh.position.y = -length / 2
    root.add(mesh)
  }
  const end = new THREE.Group()
  end.position.y = -length
  root.add(end)
  return { root, end }
}

type Arm = {
  shoulder: THREE.Group
  elbow: THREE.Group
  wrist: THREE.Group
  sign: number
  offset: number
}

type Leg = { hip: THREE.Group; knee: THREE.Group }

export async function createSwimmer(camera: THREE.Camera) {
  const hands = await createHandPair()
  const { setWetness } = hands.mats

  // Shared arm/body skin — picks up a warm tone close to the hand texture
  const skin = new THREE.MeshPhysicalMaterial({
    color: 0xc49272,
    roughness: 0.5,
    metalness: 0,
    sheen: 0.7,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0xe09070),
    clearcoat: 0.18,
    clearcoatRoughness: 0.5,
  })

  const gear = new THREE.MeshStandardMaterial({
    color: 0x6b5344,
    roughness: 0.8,
    metalness: 0.04,
  })

  const rig = new THREE.Group()
  rig.name = 'Swimmer'
  camera.add(rig)

  // Arms live in the rig frame (not the torso) so their poses stay readable in
  // screen space no matter how far the body leans into a prone swim.
  const armRoot = new THREE.Group()
  rig.add(armRoot)

  function makeArm(sign: number, offset: number): Arm {
    // Shoulders sit low and behind the eyes, so the upper arm is foreshortened
    // and it's mostly forearm and hand that fill the lower frame.
    const shoulder = new THREE.Group()
    shoulder.position.set(sign * 0.165, -0.3, 0.12)
    armRoot.add(shoulder)

    const upper = limb(0.32, 0.046, skin)
    shoulder.add(upper.root)

    const elbow = new THREE.Group()
    upper.end.add(elbow)
    const fore = limb(0.26, 0.038, skin, true)
    elbow.add(fore.root)

    // Thin cuff sits under the anatomical wrist so the hand stump can bury into it
    const bracer = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.005, 10, 28), gear)
    bracer.rotation.x = Math.PI / 2
    bracer.position.y = -0.18
    fore.root.add(bracer)

    const wrist = new THREE.Group()
    fore.end.add(wrist)
    wrist.add(sign > 0 ? hands.right : hands.left)

    return { shoulder, elbow, wrist, sign, offset }
  }

  const arms = [makeArm(1, 0), makeArm(-1, 0.5)]

  // Torso + legs trail behind the head as the swim goes prone
  const torso = new THREE.Group()
  torso.position.set(0, -0.24, 0.12)
  rig.add(torso)

  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.3, 4, 12), skin)
  chest.position.y = -0.32
  chest.scale.set(1, 1, 0.72)
  torso.add(chest)

  const hips = new THREE.Group()
  hips.position.y = -0.66
  torso.add(hips)

  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.145, 0.1, 12), gear)
  belt.scale.z = 0.75
  belt.position.y = 0.02
  hips.add(belt)

  function makeLeg(sign: number): Leg {
    const hip = new THREE.Group()
    hip.position.set(sign * 0.085, -0.02, 0)
    hips.add(hip)

    const thigh = limb(0.44, 0.073, skin)
    hip.add(thigh.root)

    const knee = new THREE.Group()
    thigh.end.add(knee)
    const shin = limb(0.42, 0.052, skin)
    knee.add(shin.root)

    const foot = new THREE.Mesh(new THREE.CapsuleGeometry(0.038, 0.07, 3, 10), skin)
    foot.scale.set(1.1, 1, 0.6)
    foot.position.set(0, -0.06, -0.04)
    foot.rotation.x = 1.1
    shin.end.add(foot)

    return { hip, knee }
  }

  const legs = [makeLeg(1), makeLeg(-1)]

  // —— animation scratch ————————————————————————————————————
  const poseCrawl: Pose = { swing: 0, spread: 0, elbow: 0, wrist: 0 }
  const poseBreast: Pose = { swing: 0, spread: 0, elbow: 0, wrist: 0 }
  const poseScull: Pose = { swing: 0, spread: 0, elbow: 0, wrist: 0 }
  const euler = new THREE.Euler(0, 0, 0, 'XYZ')
  const qA = new THREE.Quaternion()
  const qB = new THREE.Quaternion()
  const qC = new THREE.Quaternion()
  const qOut = new THREE.Quaternion()

  /** Incremental weighted slerp — order-independent enough for three poses. */
  function blend(wA: number, wB: number, wC: number) {
    qOut.copy(qA)
    let total = wA
    if (wB > 0.0001) {
      total += wB
      qOut.slerp(qB, wB / total)
    }
    if (wC > 0.0001) {
      total += wC
      qOut.slerp(qC, wC / total)
    }
  }

  let prone = 0
  let kick = 0
  let wet = 0

  function update(dt: number, time: number, frame: PlayerFrame, pitch: number, roll: number) {
    // Head can look anywhere; the body only partly follows
    rig.rotation.x = -pitch * 0.72
    rig.rotation.z = -roll * 0.55

    const drive = frame.effort
    const sub = frame.submersion

    // Hands pick up a water film as you dive; it hangs around a beat after surfacing
    wet = damp(wet, Math.max(sub, frame.underwater ? 1 : sub * 0.4), 2.2, dt)
    setWetness(wet)

    prone = damp(prone, frame.moving * (0.92 + 0.3 * sub), 4, dt)
    torso.rotation.x = -prone
    // Only a hint of the prone lean reaches the shoulders, so the hands stay in
    // frame while swimming instead of dropping out of the bottom
    armRoot.rotation.x = -prone * 0.1
    armRoot.position.z = prone * 0.05

    const wCrawl = drive * (1 - sub)
    const wBreast = drive * sub
    const wScull = Math.max(0, 1 - drive)

    const smoothing = 1 - Math.exp(-dt * 14)
    const scullPhase = time * 0.42

    for (const arm of arms) {
      samplePose(CRAWL, frame.stroke + arm.offset, poseCrawl)
      samplePose(BREAST, frame.stroke, poseBreast)
      samplePose(SCULL, scullPhase + arm.offset * 0.5, poseScull)

      euler.set(poseCrawl.swing, 0, arm.sign * poseCrawl.spread)
      qA.setFromEuler(euler)
      euler.set(poseBreast.swing, 0, arm.sign * poseBreast.spread)
      qB.setFromEuler(euler)
      euler.set(poseScull.swing, 0, arm.sign * poseScull.spread)
      qC.setFromEuler(euler)
      blend(wCrawl, wBreast, wScull)
      arm.shoulder.quaternion.slerp(qOut, smoothing)

      euler.set(poseCrawl.elbow, 0, 0)
      qA.setFromEuler(euler)
      euler.set(poseBreast.elbow, 0, 0)
      qB.setFromEuler(euler)
      euler.set(poseScull.elbow, 0, 0)
      qC.setFromEuler(euler)
      blend(wCrawl, wBreast, wScull)
      arm.elbow.quaternion.slerp(qOut, smoothing)

      euler.set(0, 0, arm.sign * poseCrawl.wrist)
      qA.setFromEuler(euler)
      euler.set(0, 0, arm.sign * poseBreast.wrist)
      qB.setFromEuler(euler)
      euler.set(0, 0, arm.sign * poseScull.wrist)
      qC.setFromEuler(euler)
      blend(wCrawl, wBreast, wScull)
      arm.wrist.quaternion.slerp(qOut, smoothing)
    }

    // Flutter kick — faster and wider the harder you swim
    kick = (kick + dt * (1.0 + 2.4 * drive)) % 1
    const amp = 0.14 + 0.36 * frame.moving
    for (let i = 0; i < legs.length; i++) {
      const offset = i * Math.PI
      const leg = legs[i]
      leg.hip.rotation.x = Math.sin(kick * TAU + offset) * amp - 0.04
      leg.knee.rotation.x = -(0.14 + Math.max(0, Math.sin(kick * TAU + offset - 0.9)) * 0.55)
    }
  }

  return { rig, update }
}
