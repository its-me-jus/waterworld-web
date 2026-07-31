import * as THREE from 'three'
import { createHandPair, createSkinMaterials } from './hand'
import type { PlayerFrame } from './player'

/**
 * First-person swimmer: arms, torso and kicking legs parented to the camera.
 * Hands live in `hand.ts` — they're always on screen, so they get the PBR pass.
 *
 * Poses are keyframed per stroke style across six channels (shoulder swing /
 * spread / twist, elbow, wrist pitch / roll) and blended as quaternions so the
 * front-crawl windmill can wrap past ±π without popping. The body is a named
 * joint hierarchy (clavicle → shoulder → elbow → wrist; hip → knee) hanging
 * under the camera in a neutral standing pose — when the island lands and we
 * switch to walking, the same joints take a walk-cycle pose set and the torso
 * pivot moves to the hips (see `body` below).
 */

const TAU = Math.PI * 2

const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))

/** [phase, shoulderSwing, shoulderSpread, shoulderTwist, elbowBend, wristPitch, wristRoll] */
type Key = [number, number, number, number, number, number, number]

/**
 * Front crawl. `swing` decreases by a full turn across the cycle: forward →
 * down → back → over the top → forward. The last key equals the first minus
 * 2π so the windmill is seamless. Wrist pitch carries the stroke: palm angles
 * back through the catch and pull, then goes slack and dangles through the
 * recovery so the hand stops looking like a paddle bolted to a stick.
 */
const CRAWL: Key[] = [
  [0.0, 1.42, 0.18, 0.15, 0.3, 0.25, 0.05],
  [0.12, 1.05, 0.22, 0.28, 0.55, -0.15, 0.1],
  [0.3, 0.15, 0.28, 0.2, 0.95, -0.5, 0.08],
  [0.48, -1.05, 0.3, -0.05, 0.85, -0.25, 0.0],
  [0.6, -1.75, 0.5, -0.3, 1.5, 0.45, 0.2],
  [0.75, -2.6, 0.62, -0.32, 1.35, 0.55, 0.15],
  [0.88, -3.7, 0.44, 0.0, 0.85, 0.4, 0.05],
  [1.0, -4.86, 0.18, 0.15, 0.3, 0.25, 0.05],
]

/**
 * Breaststroke — both arms together, used when submerged. The whip kick below
 * is keyed to the same stroke phase: legs draw up through the catch and snap
 * together as the hands shoot forward.
 */
const BREAST: Key[] = [
  [0.0, 1.62, 0.12, 0.0, 0.12, 0.05, 0.0],
  [0.2, 1.5, 0.68, 0.4, 0.35, -0.3, 0.32],
  [0.4, 1.08, 0.95, 0.5, 1.05, -0.55, 0.3],
  [0.55, 0.75, 0.5, 0.1, 1.55, -0.3, -0.1],
  [0.7, 1.35, 0.15, -0.1, 0.4, 0.0, 0.0],
  [1.0, 1.62, 0.12, 0.0, 0.12, 0.05, 0.0],
]

/**
 * Treading water — elbows bent, forearms angled inward, hands meeting in
 * front of the chest like a real scull. The sweep rides on shoulder twist
 * (forearms fan out/in across the midline) with the wrist pitching against
 * each direction, palms pressing water the way sculling actually works.
 * Keeping the hands pulled back toward the chest also keeps them inside the
 * frame on a portrait phone, where straight-arm poses crop at the corners.
 */
const SCULL: Key[] = [
  [0.0, 1.18, 0.24, 0.32, 0.95, 0.5, 0.22],
  [0.25, 1.1, 0.12, 0.2, 1.08, 0.05, 0.0],
  [0.5, 1.2, 0.26, 0.32, 0.95, -0.5, -0.22],
  [0.75, 1.1, 0.12, 0.2, 1.08, -0.05, 0.0],
  [1.0, 1.18, 0.24, 0.32, 0.95, 0.5, 0.22],
]

/** [phase, hipFlex, kneeBend, legSpread] for the breaststroke whip kick. */
type LegKey = [number, number, number, number]

const WHIP: LegKey[] = [
  [0.0, 0.04, 0.12, 0.02],
  [0.24, 0.02, 0.3, 0.06],
  [0.42, -0.28, 1.7, 0.32],
  [0.58, -0.15, 1.2, 0.36],
  [0.72, 0.06, 0.15, 0.04],
  [1.0, 0.04, 0.12, 0.02],
]

type Pose = {
  swing: number
  spread: number
  twist: number
  elbow: number
  wristPitch: number
  wristRoll: number
}

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
  out.twist = a[3] + (b[3] - a[3]) * f
  out.elbow = a[4] + (b[4] - a[4]) * f
  out.wristPitch = a[5] + (b[5] - a[5]) * f
  out.wristRoll = a[6] + (b[6] - a[6]) * f
  return out
}

/** Smoothstep-interpolated leg pose. */
function sampleLeg(keys: LegKey[], phase: number, out: { hip: number; knee: number; spread: number }) {
  const t = phase - Math.floor(phase)
  let i = 0
  while (i < keys.length - 2 && keys[i + 1][0] <= t) i++
  const a = keys[i]
  const b = keys[i + 1]
  let f = (t - a[0]) / Math.max(1e-4, b[0] - a[0])
  f = f * f * (3 - 2 * f)
  out.hip = a[1] + (b[1] - a[1]) * f
  out.knee = a[2] + (b[2] - a[2]) * f
  out.spread = a[3] + (b[3] - a[3]) * f
  return out
}

/**
 * A limb segment hanging along -Y from its joint, plus a group at its far end.
 * Tapered so a forearm narrows into the wrist instead of ending in a fat dome.
 */
function limb(length: number, radius: number, material: THREE.Material, taper = 1) {
  const root = new THREE.Group()
  const geo = new THREE.CapsuleGeometry(radius, Math.max(0.02, length - radius * 2), 6, 20)
  if (taper !== 1) {
    // Squeeze the distal half toward the wrist
    const pos = geo.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      const t = THREE.MathUtils.clamp((length / 2 - pos.getY(i)) / length, 0, 1)
      const k = 1 + (taper - 1) * t
      pos.setX(i, pos.getX(i) * k)
      pos.setZ(i, pos.getZ(i) * k)
    }
    pos.needsUpdate = true
    geo.computeVertexNormals()
  }
  const mesh = new THREE.Mesh(geo, material)
  mesh.position.y = -length / 2
  root.add(mesh)
  const end = new THREE.Group()
  end.position.y = -length
  root.add(end)
  return { root, end }
}

type Arm = {
  clavicle: THREE.Group
  shoulder: THREE.Group
  elbow: THREE.Group
  wrist: THREE.Group
  sign: number
  offset: number
}

type Leg = { hip: THREE.Group; knee: THREE.Group; sign: number }

export function createSwimmer(camera: THREE.Camera) {
  // One skin material for hands, arms, torso and legs so the tone always matches
  const mats = createSkinMaterials()
  const { skin, setWetness } = mats
  const hands = createHandPair(mats)

  const gear = new THREE.MeshStandardMaterial({
    color: 0x6b5344,
    roughness: 0.8,
    metalness: 0.04,
  })

  const rig = new THREE.Group()
  rig.name = 'Swimmer'
  camera.add(rig)

  // The sun is overhead and we mostly see the underside of our own arms, so
  // without help they render as near-silhouettes. A soft fill that travels
  // with the camera lifts just the viewmodel — distance-capped so the world
  // never notices.
  const fill = new THREE.PointLight(0xfff0e0, 2.4, 2.6, 1.9)
  fill.position.set(0.12, -0.04, -0.26)
  rig.add(fill)

  // Arms hang from clavicles in the rig frame (not the torso) so their poses
  // stay readable in screen space no matter how far the body leans prone.
  const armRoot = new THREE.Group()
  rig.add(armRoot)

  function makeArm(sign: number, offset: number): Arm {
    // Clavicle: anatomical shoulder root. Carries the deltoid and takes a small
    // share of the stroke so the arm reads as grown out of a torso rather than
    // floating beside the camera.
    const clavicle = new THREE.Group()
    clavicle.position.set(sign * 0.19, -0.33, 0.12)
    armRoot.add(clavicle)

    const deltoid = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), skin)
    deltoid.scale.set(1, 0.85, 1.05)
    clavicle.add(deltoid)

    const shoulder = new THREE.Group()
    clavicle.add(shoulder)

    const upper = limb(0.33, 0.05, skin)
    shoulder.add(upper.root)

    const elbow = new THREE.Group()
    upper.end.add(elbow)
    // Soft elbow pad so a fully bent arm doesn't read as a sharp V
    const elbowPad = new THREE.Mesh(new THREE.SphereGeometry(0.044, 12, 8), skin)
    elbowPad.position.set(0, 0.004, 0.014)
    elbowPad.scale.set(0.9, 1, 0.85)
    elbow.add(elbowPad)

    const fore = limb(0.3, 0.044, skin, 0.62)
    elbow.add(fore.root)

    // Braided cord, sitting just above the wrist
    const bracer = new THREE.Mesh(new THREE.TorusGeometry(0.029, 0.0035, 8, 26), gear)
    bracer.rotation.x = Math.PI / 2
    bracer.position.y = -0.245
    fore.root.add(bracer)

    const wrist = new THREE.Group()
    fore.end.add(wrist)
    wrist.add(sign > 0 ? hands.right : hands.left)

    return { clavicle, shoulder, elbow, wrist, sign, offset }
  }

  const arms = [makeArm(1, 0), makeArm(-1, 0.5)]

  // —— body ————————————————————————————————————————————————
  // Neutral standing pose under the camera: neck, chest, abdomen, hips, legs.
  // `body` pivots at the neck for the prone swim lean — fine while swimming,
  // but when the island walk lands this should re-pivot at `hips` and take an
  // upright pose + walk cycle instead.
  const body = new THREE.Group()
  body.name = 'Body'
  body.position.set(0, -0.24, 0.12)
  rig.add(body)

  // Neck stump — the rim you catch at the bottom of the frame when looking down
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.1, 14), skin)
  neck.position.y = -0.06
  body.add(neck)

  // Clavicle bar ties the deltoids to the chest so the shoulders have a home
  const clavBar = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.24, 4, 12), skin)
  clavBar.rotation.z = Math.PI / 2
  clavBar.position.set(0, -0.12, 0.01)
  clavBar.scale.set(1, 1, 0.8)
  body.add(clavBar)

  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.185, 0.28, 4, 14), skin)
  chest.position.y = -0.32
  chest.scale.set(1, 1, 0.74)
  body.add(chest)

  const abdomen = new THREE.Mesh(new THREE.CapsuleGeometry(0.155, 0.14, 4, 12), skin)
  abdomen.position.y = -0.52
  abdomen.scale.set(1, 1, 0.7)
  body.add(abdomen)

  const hips = new THREE.Group()
  hips.name = 'Hips'
  hips.position.y = -0.66
  body.add(hips)

  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.145, 0.1, 12), gear)
  belt.scale.z = 0.78
  belt.position.y = 0.02
  hips.add(belt)
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.045, 0.02), gear)
  buckle.position.set(0, 0.02, 0.12)
  hips.add(buckle)

  function makeLeg(sign: number): Leg {
    const hip = new THREE.Group()
    hip.position.set(sign * 0.088, -0.02, 0)
    hips.add(hip)

    const thigh = limb(0.44, 0.078, skin)
    hip.add(thigh.root)

    const knee = new THREE.Group()
    thigh.end.add(knee)
    const kneePad = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), skin)
    kneePad.position.set(0, 0.0, -0.018)
    kneePad.scale.set(0.95, 1.05, 0.8)
    knee.add(kneePad)

    const shin = limb(0.42, 0.055, skin, 0.78)
    knee.add(shin.root)

    const foot = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.072, 3, 10), skin)
    foot.scale.set(1.12, 1, 0.62)
    foot.position.set(0, -0.06, -0.045)
    foot.rotation.x = 1.1
    shin.end.add(foot)

    return { hip, knee, sign }
  }

  const legs = [makeLeg(1), makeLeg(-1)]

  // —— animation scratch ————————————————————————————————————
  const poseCrawl: Pose = { swing: 0, spread: 0, twist: 0, elbow: 0, wristPitch: 0, wristRoll: 0 }
  const poseBreast: Pose = { swing: 0, spread: 0, twist: 0, elbow: 0, wristPitch: 0, wristRoll: 0 }
  const poseScull: Pose = { swing: 0, spread: 0, twist: 0, elbow: 0, wristPitch: 0, wristRoll: 0 }
  const legWhip = { hip: 0, knee: 0, spread: 0 }
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
    const wCrawl = drive * (1 - sub)
    const wBreast = drive * sub
    const wScull = Math.max(0, 1 - drive)

    // Torso rolls toward the pulling arm; arms inherit most of it. Without
    // this the crawl reads as a windmill bolted to a surfboard.
    const crawlRoll = -Math.sin(frame.stroke * TAU) * 0.14 * wCrawl
    // Breaststroke breathes: chest rises into the insweep, settles on the glide
    const breastPulse = Math.sin(frame.stroke * TAU * 2 + 0.8) * 0.045 * wBreast
    // Idle breathing lift
    const breathe = Math.sin(time * 0.8) * 0.006 * wScull

    body.rotation.x = -prone + breastPulse
    body.rotation.z = crawlRoll
    body.position.y = -0.24 + breathe
    armRoot.rotation.x = -prone * 0.1
    armRoot.rotation.z = crawlRoll * 0.75
    armRoot.position.z = prone * 0.05

    const smoothing = 1 - Math.exp(-dt * 14)
    const scullPhase = time * 0.42

    for (const arm of arms) {
      samplePose(CRAWL, frame.stroke + arm.offset, poseCrawl)
      samplePose(BREAST, frame.stroke, poseBreast)
      samplePose(SCULL, scullPhase + arm.offset * 0.5, poseScull)

      // Clavicle follows the stroke at a fraction — shoulders rise into the
      // reach and dip into the pull instead of staying pinned to the camera
      const clavSwing =
        (poseCrawl.swing - 0.6) * 0.09 * wCrawl +
        (poseBreast.swing - 0.8) * 0.07 * wBreast +
        Math.sin(time * 0.8 + arm.offset * 3) * 0.015 * wScull
      arm.clavicle.rotation.x = damp(arm.clavicle.rotation.x, clavSwing, 10, dt)

      euler.set(poseCrawl.swing, arm.sign * poseCrawl.twist, arm.sign * poseCrawl.spread)
      qA.setFromEuler(euler)
      euler.set(poseBreast.swing, arm.sign * poseBreast.twist, arm.sign * poseBreast.spread)
      qB.setFromEuler(euler)
      euler.set(poseScull.swing, arm.sign * poseScull.twist, arm.sign * poseScull.spread)
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

      euler.set(poseCrawl.wristPitch, 0, arm.sign * poseCrawl.wristRoll)
      qA.setFromEuler(euler)
      euler.set(poseBreast.wristPitch, 0, arm.sign * poseBreast.wristRoll)
      qB.setFromEuler(euler)
      euler.set(poseScull.wristPitch, 0, arm.sign * poseScull.wristRoll)
      qC.setFromEuler(euler)
      blend(wCrawl, wBreast, wScull)
      arm.wrist.quaternion.slerp(qOut, smoothing)
    }

    // —— legs ————————————————————————————————————————————
    // Three styles summed by the same weights as the arms (they add to 1):
    // flutter at the surface, whip kick synced to the breaststroke, slow
    // alternating tread when idle.
    kick = (kick + dt * (1.0 + 2.2 * drive)) % 1
    const flutterAmp = 0.12 + 0.34 * frame.moving
    const tread = time * 1.35

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]
      const offset = i * Math.PI

      const flutterHip = Math.sin(kick * TAU + offset) * flutterAmp - 0.04
      const flutterKnee = 0.14 + Math.max(0, Math.sin(kick * TAU + offset - 0.9)) * 0.5

      sampleLeg(WHIP, frame.stroke, legWhip)

      const treadHip = Math.sin(tread + offset) * 0.16 - 0.06
      const treadKnee = 0.3 + Math.max(0, Math.sin(tread + offset - 0.8)) * 0.25

      leg.hip.rotation.x = flutterHip * wCrawl + legWhip.hip * wBreast + treadHip * wScull
      leg.hip.rotation.z = leg.sign * legWhip.spread * wBreast
      leg.knee.rotation.x = -(flutterKnee * wCrawl + legWhip.knee * wBreast + treadKnee * wScull)
    }
  }

  return { rig, update }
}
