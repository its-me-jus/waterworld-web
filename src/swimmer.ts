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
const Y_AXIS = new THREE.Vector3(0, 1, 0)
const Z_AXIS = new THREE.Vector3(0, 0, 1)

/** Finger: root x, fan angle, [total length, base radius, tip radius, cup curl]. */
const FINGERS: { x: number; fan: number; length: number; r0: number; r1: number; curl: number }[] = [
  { x: -0.03, fan: -0.09, length: 0.092, r0: 0.0116, r1: 0.0078, curl: 0.28 },
  { x: -0.01, fan: -0.02, length: 0.1, r0: 0.0122, r1: 0.0082, curl: 0.24 },
  { x: 0.01, fan: 0.045, length: 0.094, r0: 0.0114, r1: 0.0076, curl: 0.28 },
  { x: 0.029, fan: 0.12, length: 0.074, r0: 0.0096, r1: 0.0064, curl: 0.34 },
]

type HandParts = { body: THREE.BufferGeometry; nails: THREE.BufferGeometry }

/**
 * Build a tapered tube along `curve` by lofting ellipses — continuous skin, no
 * capsule seams. Cross-section is flattened (palm-thin) so fingers read as hands.
 */
function taperedTube(
  curve: THREE.Curve<THREE.Vector3>,
  r0: number,
  r1: number,
  segs = 18,
  radial = 12,
  flat = 0.7,
) {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const normal = new THREE.Vector3()
  const binormal = new THREE.Vector3()
  const tangent = new THREE.Vector3()
  const pos = new THREE.Vector3()
  const frameN = new THREE.Vector3()
  const frameB = new THREE.Vector3()

  // Parallel-transport a frame along the curve so the tube doesn't twist oddly
  const frames = curve.computeFrenetFrames(segs, false)

  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    curve.getPointAt(t, pos)
    tangent.copy(frames.tangents[i])
    frameN.copy(frames.normals[i])
    frameB.copy(frames.binormals[i])
    const r = r0 + (r1 - r0) * t
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2
      // Flatten along binormal (roughly palm thickness)
      const cx = Math.cos(a) * r
      const cy = Math.sin(a) * r * flat
      normal.copy(frameN).multiplyScalar(cx).addScaledVector(frameB, cy)
      positions.push(pos.x + normal.x, pos.y + normal.y, pos.z + normal.z)
      binormal.copy(normal).normalize()
      normals.push(binormal.x, binormal.y, binormal.z)
    }
  }

  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j
      const b = i * radial + ((j + 1) % radial)
      const c = (i + 1) * radial + j
      const d = (i + 1) * radial + ((j + 1) % radial)
      // CCW when viewed from outside
      indices.push(a, b, c, b, d, c)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setIndex(indices)
  return geo
}

/**
 * Anatomical right hand: wrist at the origin, fingers down -Y, palm facing +Z,
 * thumb toward -X. Fingers are single tapered tubes (not stacked capsules) so a
 * close pass doesn't read as toy segments. Nails are separate for a gloss pass.
 */
function handGeometry(): HandParts {
  const bodyParts: THREE.BufferGeometry[] = []
  const nailParts: THREE.BufferGeometry[] = []
  const matrix = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const tip = new THREE.Vector3()
  const nailAt = new THREE.Vector3()
  const back = new THREE.Vector3()
  const nailQ = new THREE.Quaternion()

  const lump = (at: THREE.Vector3, sx: number, sy: number, sz: number, segs = 14) => {
    const geo = new THREE.SphereGeometry(1, segs, segs)
    geo.scale(sx, sy, sz)
    geo.translate(at.x, at.y, at.z)
    bodyParts.push(geo)
  }

  const placeCap = (
    length: number,
    radius: number,
    at: THREE.Vector3,
    rot: THREE.Quaternion,
    scale: THREE.Vector3,
    radial = 14,
  ) => {
    const geo = new THREE.CapsuleGeometry(radius, Math.max(0.002, length - radius * 2), 5, radial)
    matrix.compose(at, rot, scale)
    bodyParts.push(geo.applyMatrix4(matrix))
  }

  /** Curved finger from knuckle, with nail on the dorsal tip. */
  const addFinger = (
    knuckle: THREE.Vector3,
    root: THREE.Quaternion,
    length: number,
    r0: number,
    r1: number,
    curl: number,
    withNail: boolean,
  ) => {
    const p0 = knuckle.clone()
    const p1 = new THREE.Vector3(0, -length * 0.38, length * 0.04 * curl).applyQuaternion(root).add(knuckle)
    const p2 = new THREE.Vector3(0, -length * 0.72, length * 0.14 * curl).applyQuaternion(root).add(knuckle)
    const p3 = new THREE.Vector3(0, -length, length * 0.22 * curl).applyQuaternion(root).add(knuckle)
    const curve = new THREE.CatmullRomCurve3([p0, p1, p2, p3])
    bodyParts.push(taperedTube(curve, r0, r1, 20, 14, 0.68))
    // Soft fingertip
    lump(p3, r1 * 1.05, r1 * 1.15, r1 * 0.85, 12)

    if (withNail) {
      tip.copy(p3)
      const tangent = curve.getTangentAt(1).normalize()
      // Dorsal = roughly -Z in hand space, bent with the finger
      back.set(0, 0, -1).applyQuaternion(root).normalize()
      nailAt.copy(tip).addScaledVector(tangent, -r1 * 1.2).addScaledVector(back, -r1 * 0.9)
      const xAxis = new THREE.Vector3().crossVectors(tangent, back).normalize()
      // If tangent ≈ back, fall back to hand-local axes
      if (xAxis.lengthSq() < 1e-6) xAxis.set(1, 0, 0).applyQuaternion(root).normalize()
      const yAxis = tangent.clone()
      const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize()
      nailQ.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis))
      const plate = new THREE.BoxGeometry(r0 * 1.35, length * 0.22, r1 * 0.28)
      matrix.compose(nailAt, nailQ, new THREE.Vector3(1, 1, 1))
      nailParts.push(plate.applyMatrix4(matrix))
      // Rounded free edge
      const edge = new THREE.SphereGeometry(r1 * 0.55, 10, 10)
      edge.scale(1.4, 0.7, 0.45)
      matrix.compose(
        tip.clone().addScaledVector(tangent, -r1 * 0.15).addScaledVector(back, -r1 * 0.75),
        nailQ,
        new THREE.Vector3(1, 1, 1),
      )
      nailParts.push(edge.applyMatrix4(matrix))
    }
  }

  // Wrist flare into the palm
  placeCap(
    0.03,
    0.02,
    new THREE.Vector3(0, -0.012, 0.002),
    q.identity(),
    new THREE.Vector3(1.15, 1, 0.8),
    16,
  )

  // Palm core + pads
  const palm = new THREE.CapsuleGeometry(0.035, 0.05, 7, 18)
  palm.scale(1.5, 1, 0.56)
  palm.translate(0, -0.056, 0.007)
  bodyParts.push(palm)
  lump(new THREE.Vector3(0.02, -0.04, 0.017), 0.021, 0.035, 0.016, 14)
  lump(new THREE.Vector3(-0.021, -0.042, 0.019), 0.025, 0.037, 0.018, 14)
  lump(new THREE.Vector3(0, -0.072, 0.015), 0.032, 0.026, 0.015, 12)
  placeCap(
    0.055,
    0.0165,
    new THREE.Vector3(-0.021, -0.052, 0.011),
    q.setFromAxisAngle(Z_AXIS, -0.4),
    new THREE.Vector3(1.1, 1, 0.7),
    14,
  )

  // Knuckle mounds + fingers
  for (const finger of FINGERS) {
    const knuckle = new THREE.Vector3(finger.x, -0.1, 0.004)
    lump(new THREE.Vector3(finger.x, -0.095, -0.001), 0.0125, 0.011, 0.012, 12)
    addFinger(
      knuckle,
      new THREE.Quaternion().setFromAxisAngle(Z_AXIS, finger.fan),
      finger.length,
      finger.r0,
      finger.r1,
      finger.curl,
      true,
    )
  }

  // Thumb — opposed, slightly shorter tube
  const thumbRoot = new THREE.Quaternion()
    .setFromAxisAngle(Y_AXIS, 0.8)
    .multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -0.56))
    .multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, -0.1))
  const thumbKnuckle = new THREE.Vector3(-0.036, -0.036, 0.015)
  lump(thumbKnuckle.clone().add(new THREE.Vector3(0.004, 0.006, -0.004)), 0.015, 0.014, 0.013, 12)
  addFinger(thumbKnuckle, thumbRoot, 0.078, 0.0134, 0.0092, 0.4, true)

  const body = mergeGeometries(
    bodyParts.map((g) => {
      g.deleteAttribute('uv')
      return g
    }),
    false,
  ) ?? bodyParts[0]
  // Keep authored normals — recomputing across overlapping pads flattens the form
  const nails =
    nailParts.length > 0
      ? (mergeGeometries(
          nailParts.map((g) => {
            g.deleteAttribute('uv')
            return g
          }),
          false,
        ) ?? nailParts[0])
      : new THREE.BufferGeometry()
  if (nailParts.length > 0) nails.computeVertexNormals()

  return { body, nails }
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
  out.computeVertexNormals()
  return out
}

function mirrorHand(hand: HandParts): HandParts {
  return {
    body: mirrorX(hand.body),
    nails: hand.nails.getAttribute('position')
      ? mirrorX(hand.nails)
      : hand.nails.clone(),
  }
}

/**
 * A limb segment hanging along -Y from its joint, plus a group at its far end.
 * High radial count — forearms fill a third of the frame during a stroke.
 */
function limb(length: number, radius: number, material: THREE.Material) {
  const root = new THREE.Group()
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, Math.max(0.02, length - radius * 2), 6, 20),
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
  // Wet skin — warm sheen reads as subsurface; clearcoat as a damp film
  const skin = new THREE.MeshPhysicalMaterial({
    color: 0xcc9470,
    roughness: 0.48,
    metalness: 0,
    clearcoat: 0.32,
    clearcoatRoughness: 0.5,
    sheen: 0.85,
    sheenRoughness: 0.65,
    sheenColor: new THREE.Color(0xe8a888),
  })
  const nail = new THREE.MeshPhysicalMaterial({
    color: 0xe8c4b8,
    roughness: 0.22,
    metalness: 0.06,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
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

  const rightHand = handGeometry()
  const leftHand = mirrorHand(rightHand)

  function makeHand(parts: HandParts) {
    const group = new THREE.Group()
    group.add(new THREE.Mesh(parts.body, skin))
    if (parts.nails.getAttribute('position')) {
      group.add(new THREE.Mesh(parts.nails, nail))
    }
    // Palm faces +Z locally, so a little wrist extension points it back along the
    // pull rather than up at the sky during the catch
    group.rotation.x = -0.12
    return group
  }

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

    const bracer = new THREE.Mesh(new THREE.CylinderGeometry(0.039, 0.037, 0.022, 24), gear)
    bracer.position.y = -0.215
    fore.root.add(bracer)

    const wrist = new THREE.Group()
    fore.end.add(wrist)
    wrist.add(makeHand(sign > 0 ? rightHand : leftHand))

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
