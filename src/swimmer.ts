import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { PlayerFrame } from './player'

/**
 * First-person swimmer: arms, hands, torso and kicking legs built from capsules
 * and parented to the camera. Poses are keyframed per stroke style and blended
 * as quaternions so the front-crawl windmill can wrap past ±π without popping.
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

// —— hands ————————————————————————————————————————————————

const X_AXIS = new THREE.Vector3(1, 0, 0)
const Z_AXIS = new THREE.Vector3(0, 0, 1)

/** One bone in a finger: [end-to-end length, radius, extra curl at its joint]. */
type Bone = [number, number, number]

/** Index → pinky, laid out across the palm away from the thumb. */
const FINGERS: { x: number; fan: number; bones: Bone[] }[] = [
  { x: -0.03, fan: -0.11, bones: [[0.044, 0.0118, 0.2], [0.032, 0.0104, 0.3]] },
  { x: -0.01, fan: -0.03, bones: [[0.048, 0.012, 0.17], [0.035, 0.0106, 0.28]] },
  { x: 0.01, fan: 0.05, bones: [[0.045, 0.0113, 0.19], [0.032, 0.01, 0.32]] },
  { x: 0.029, fan: 0.14, bones: [[0.036, 0.0098, 0.24], [0.026, 0.0088, 0.36]] },
]

/**
 * A hand with actual fingers, merged down to one geometry. Canonical form is the
 * right hand: wrist at the origin, fingers down -Y, palm facing +Z, thumb toward
 * -X so it sits inboard the way a swimmer's thumbs face each other. Held in a
 * slight cup, which is both what a swimmer does and what keeps the silhouette
 * from reading as a mitten when a hand sweeps past the camera.
 */
function handGeometry() {
  const parts: THREE.BufferGeometry[] = []
  const matrix = new THREE.Matrix4()
  const unit = new THREE.Vector3(1, 1, 1)
  const joint = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const mid = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const step = new THREE.Quaternion()

  /** Capsule of exact end-to-end `length`, placed by matrix. */
  const place = (
    length: number,
    radius: number,
    radial: number,
    at: THREE.Vector3,
    rot: THREE.Quaternion,
    scale: THREE.Vector3 = unit,
  ) => {
    const geo = new THREE.CapsuleGeometry(radius, Math.max(0.002, length - radius * 2), 3, radial)
    matrix.compose(at, rot, scale)
    parts.push(geo.applyMatrix4(matrix))
  }

  /** Walk a chain of bones from `base`, each one bending further toward the palm. */
  const chain = (base: THREE.Vector3, root: THREE.Quaternion, bones: Bone[], radial: number) => {
    q.copy(root)
    joint.copy(base)
    for (const [length, radius, curl] of bones) {
      // Fingers close toward +Z, so the curl is a negative turn about X
      q.multiply(step.setFromAxisAngle(X_AXIS, -curl))
      dir.set(0, -1, 0).applyQuaternion(q)
      mid.copy(joint).addScaledVector(dir, length * 0.5)
      place(length, radius, radial, mid, q)
      joint.addScaledVector(dir, length)
    }
  }

  // Palm: flattened front-to-back, knuckles ending around y = -0.1
  const palm = new THREE.CapsuleGeometry(0.03, 0.05, 4, 10)
  palm.scale(1.38, 1, 0.5)
  palm.translate(0, -0.05, 0)
  parts.push(palm)

  // Thenar pad — the fleshy wedge at the base of the thumb
  place(
    0.066,
    0.019,
    8,
    new THREE.Vector3(-0.02, -0.048, 0.005),
    q.setFromAxisAngle(Z_AXIS, -0.4),
    new THREE.Vector3(1, 1, 0.62),
  )

  for (const finger of FINGERS) {
    chain(
      new THREE.Vector3(finger.x, -0.096, 0.001),
      new THREE.Quaternion().setFromAxisAngle(Z_AXIS, finger.fan),
      finger.bones,
      8,
    )
  }

  // Thumb: splayed out to -X, then swung forward so it opposes the fingers
  const thumbRoot = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.75)
    .multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -0.62))
  chain(
    new THREE.Vector3(-0.032, -0.044, 0.008),
    thumbRoot,
    [[0.038, 0.0138, 0.18], [0.031, 0.0116, 0.34]],
    9,
  )

  return mergeGeometries(parts, false) ?? parts[0]
}

/**
 * Mirror across X for the other hand. `scale(-1)` alone leaves every triangle
 * wound backwards, so the index has to be reversed too or the mesh renders
 * inside-out under front-face culling.
 */
function mirrorX(geometry: THREE.BufferGeometry) {
  const out = geometry.clone()
  out.scale(-1, 1, 1)
  const index = out.getIndex()
  if (!index) throw new Error('mirrorX expects indexed geometry')
  const tri = index.array as Uint16Array | Uint32Array
  for (let i = 0; i < tri.length; i += 3) {
    const first = tri[i]
    tri[i] = tri[i + 2]
    tri[i + 2] = first
  }
  index.needsUpdate = true
  return out
}

/**
 * A limb segment hanging along -Y from its joint, plus a group at its far end.
 * Generously segmented: forearms fill a third of the frame during a stroke, and
 * at that size an octagonal cross-section is obvious.
 */
function limb(length: number, radius: number, material: THREE.Material) {
  const root = new THREE.Group()
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, Math.max(0.02, length - radius * 2), 4, 16),
    material,
  )
  mesh.position.y = -length / 2
  root.add(mesh)
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

export function createSwimmer(camera: THREE.Camera) {
  const skin = new THREE.MeshStandardMaterial({
    color: 0xb87f56,
    roughness: 0.58,
    metalness: 0.02,
  })
  const gear = new THREE.MeshStandardMaterial({
    color: 0x5a4433,
    roughness: 0.85,
    metalness: 0.05,
  })

  const rig = new THREE.Group()
  rig.name = 'Swimmer'
  camera.add(rig)

  // Arms live in the rig frame (not the torso) so their poses stay readable in
  // screen space no matter how far the body leans into a prone swim.
  const armRoot = new THREE.Group()
  rig.add(armRoot)

  const rightHand = handGeometry()
  const leftHand = mirrorX(rightHand)

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
    const fore = limb(0.3, 0.038, skin)
    elbow.add(fore.root)

    const bracer = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.041, 0.04, 16), gear)
    bracer.position.y = -0.23
    fore.root.add(bracer)

    const wrist = new THREE.Group()
    fore.end.add(wrist)
    const hand = new THREE.Mesh(sign > 0 ? rightHand : leftHand, skin)
    // Palm faces +Z locally, so a little wrist extension points it back along the
    // pull rather than up at the sky during the catch
    hand.rotation.x = -0.12
    wrist.add(hand)

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

  function update(dt: number, time: number, frame: PlayerFrame, pitch: number, roll: number) {
    // Head can look anywhere; the body only partly follows
    rig.rotation.x = -pitch * 0.72
    rig.rotation.z = -roll * 0.55

    const drive = frame.effort
    const sub = frame.submersion

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
