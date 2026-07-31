import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { PlayerFrame } from './player'

/**
 * First-person swimmer in a full dive kit: neoprene wetsuit, dive gloves, and
 * high-vis accents. Hands prefer the owned Blender GLB in public/hands/;
 * procedural capsules are the fallback.
 *
 * Poses are keyframed per stroke style across six channels (shoulder swing /
 * spread / twist, elbow, wrist pitch / roll) and blended as quaternions so the
 * front-crawl windmill can wrap past ±π without popping. Four sets share the
 * rig: crawl at the surface, breaststroke submerged, a rest hang that keeps
 * the arms off-screen whenever you're not actually moving, and a walk cycle
 * for the island that counter-phases the arms against the legs. The body is a
 * named joint hierarchy (clavicle → shoulder → elbow → wrist; hip → knee)
 * hanging under the camera in a neutral standing pose — swimming leans it
 * prone from the collar, walking stands it back up.
 */

const HAND_GLB = '/hands/right.glb'

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
 * At rest — idle floating, straight dives, straight ascents — the arms hang
 * by the sides and stay out of the frame. The shoulders sit behind the
 * camera plane, so a nearly straight hang keeps the hands off-screen while
 * looking ahead; look straight down and you'll catch them drifting beside
 * the body, which is exactly when seeing them reads naturally. A slow sway
 * keeps the pose alive instead of mannequin-still.
 */
const REST: Key[] = [
  [0.0, 0.12, 0.07, 0.04, 0.1, 0.12, 0.0],
  [0.5, 0.07, 0.1, -0.02, 0.16, 0.05, 0.0],
  [1.0, 0.12, 0.07, 0.04, 0.1, 0.12, 0.0],
]

/**
 * Walk — arms hang mostly straight and swing counter to the same-side leg
 * (the rig feeds each arm the phase offset its maker gave it). The swing is
 * deliberately small: first-person arms at full marching swing read as
 * windshield wipers, not walking.
 */
const WALK: Key[] = [
  [0.0, 0.4, 0.09, 0.03, 0.24, 0.1, 0.02],
  [0.25, 0.08, 0.08, 0.01, 0.34, 0.04, 0.01],
  [0.5, -0.3, 0.09, -0.03, 0.26, 0.1, -0.02],
  [0.75, 0.08, 0.08, 0.01, 0.34, 0.04, 0.01],
  [1.0, 0.4, 0.09, 0.03, 0.24, 0.1, 0.02],
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

// —— hands ————————————————————————————————————————————————

const X_AXIS = new THREE.Vector3(1, 0, 0)
const Z_AXIS = new THREE.Vector3(0, 0, 1)

/** One bone in a finger: [end-to-end length, radius, extra curl at its joint]. */
type Bone = [number, number, number]

/** Index → pinky, laid out across the palm away from the thumb. Dive-glove scale. */
const FINGERS: { x: number; fan: number; bones: Bone[] }[] = [
  { x: -0.03, fan: -0.08, bones: [[0.078, 0.0112, 0.12]] },
  { x: -0.01, fan: -0.02, bones: [[0.086, 0.0116, 0.1]] },
  { x: 0.01, fan: 0.04, bones: [[0.082, 0.011, 0.11]] },
  { x: 0.028, fan: 0.11, bones: [[0.068, 0.0098, 0.14]] },
]

/**
 * Dive-glove silhouette (procedural fallback). Wrist at origin, fingers -Y,
 * palm +Z, thumb -X. One bone per finger so we don't get bead knuckles.
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

  const chain = (base: THREE.Vector3, root: THREE.Quaternion, bones: Bone[], radial: number) => {
    q.copy(root)
    joint.copy(base)
    for (const [length, radius, curl] of bones) {
      q.multiply(step.setFromAxisAngle(X_AXIS, -curl))
      dir.set(0, -1, 0).applyQuaternion(q)
      mid.copy(joint).addScaledVector(dir, length * 0.5)
      place(length, radius, radial, mid, q)
      joint.addScaledVector(dir, length)
    }
  }

  // Thick palm + wrist stump
  const palm = new THREE.CapsuleGeometry(0.034, 0.055, 4, 12)
  palm.scale(1.2, 1, 0.55)
  palm.translate(0, -0.048, 0.002)
  parts.push(palm)
  place(0.04, 0.022, 10, new THREE.Vector3(0, -0.008, 0), q.identity())

  // Thenar
  place(
    0.06,
    0.018,
    8,
    new THREE.Vector3(-0.022, -0.042, 0.008),
    q.setFromAxisAngle(Z_AXIS, -0.4),
    new THREE.Vector3(1, 1, 0.7),
  )

  for (const finger of FINGERS) {
    chain(
      new THREE.Vector3(finger.x, -0.092, 0.004),
      new THREE.Quaternion().setFromAxisAngle(Z_AXIS, finger.fan),
      finger.bones,
      10,
    )
  }

  const thumbRoot = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.8)
    .multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -0.55))
  chain(
    new THREE.Vector3(-0.032, -0.038, 0.01),
    thumbRoot,
    [[0.058, 0.0125, 0.16]],
    10,
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
  if (!index) {
    // GLB meshes are usually indexed; if not, index them before flipping winding.
    const pos = out.getAttribute('position')
    const idx = new Uint32Array(pos.count)
    for (let i = 0; i < pos.count; i++) idx[i] = i
    out.setIndex(new THREE.BufferAttribute(idx, 1))
  }
  const tri = out.getIndex()!.array as Uint16Array | Uint32Array
  for (let i = 0; i < tri.length; i += 3) {
    const first = tri[i]
    tri[i] = tri[i + 2]
    tri[i + 2] = first
  }
  out.getIndex()!.needsUpdate = true
  out.computeVertexNormals()
  return out
}

/** Pull the first mesh geometry out of a loaded GLB scene. */
function firstMeshGeometry(root: THREE.Object3D): THREE.BufferGeometry | null {
  let found: THREE.BufferGeometry | null = null
  root.updateWorldMatrix(true, true)
  root.traverse((obj) => {
    if (found) return
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && mesh.geometry) {
      found = mesh.geometry.clone()
      found.applyMatrix4(mesh.matrixWorld)
      // Wrist at y=0 — remesh / export can leave a stump past the origin
      found.computeBoundingBox()
      const box = found.boundingBox
      if (box) found.translate(0, -box.max.y, 0)
      found.computeVertexNormals()
      found.computeBoundingBox()
    }
  })
  return found
}

function loadBlenderHandGeometry(): Promise<THREE.BufferGeometry | null> {
  return new Promise((resolve) => {
    new GLTFLoader().load(
      HAND_GLB,
      (gltf) => {
        const geo = firstMeshGeometry(gltf.scene)
        if (!geo) {
          console.warn('[swimmer] hand GLB had no mesh; keeping procedural hands')
          resolve(null)
          return
        }
        geo.computeVertexNormals()
        resolve(geo)
      },
      undefined,
      (err) => {
        console.warn('[swimmer] failed to load hand GLB; keeping procedural hands', err)
        resolve(null)
      },
    )
  })
}

/**
 * A limb segment hanging along -Y from its joint, plus a group at its far end.
 * Tapers toward the far end so forearms read as suit sleeves, not pipes.
 */
function limb(length: number, radiusNear: number, radiusFar: number, material: THREE.Material) {
  const root = new THREE.Group()
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusNear, radiusFar, length, 16),
    material,
  )
  mesh.position.y = -length / 2
  root.add(mesh)
  // Soft joint caps so sleeve ends don't look sawed off
  const nearCap = new THREE.Mesh(new THREE.SphereGeometry(radiusNear * 0.98, 12, 8), material)
  nearCap.scale.y = 0.55
  root.add(nearCap)
  const farCap = new THREE.Mesh(new THREE.SphereGeometry(radiusFar * 0.98, 12, 8), material)
  farCap.position.y = -length
  farCap.scale.y = 0.55
  root.add(farCap)
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
  // Full dive kit — no bare skin. Neoprene reads as intentional even when the
  // hand mesh is mid-poly / slightly blobbed; gloves are supposed to look padded.
  // Clearcoat gives the wet sheen that sells "just came out of the water".
  const suit = new THREE.MeshPhysicalMaterial({
    color: 0x27384a,
    roughness: 0.58,
    metalness: 0.04,
    clearcoat: 0.5,
    clearcoatRoughness: 0.42,
  })
  const suitPanel = new THREE.MeshPhysicalMaterial({
    color: 0x33495e,
    roughness: 0.55,
    metalness: 0.05,
    clearcoat: 0.45,
    clearcoatRoughness: 0.45,
  })
  const glove = new THREE.MeshPhysicalMaterial({
    color: 0x1b222b,
    roughness: 0.52,
    metalness: 0.06,
    clearcoat: 0.65,
    clearcoatRoughness: 0.3,
  })
  // High-vis cuff + buckle — classic diver cue, also hides the wrist seam
  const accent = new THREE.MeshStandardMaterial({
    color: 0xe0aa1a,
    roughness: 0.42,
    metalness: 0.3,
  })
  const hardware = new THREE.MeshStandardMaterial({
    color: 0x49565f,
    roughness: 0.35,
    metalness: 0.6,
  })

  const rig = new THREE.Group()
  rig.name = 'Swimmer'
  camera.add(rig)

  // The sun is overhead and we mostly see the underside of our own arms, so
  // without help they render as near-silhouettes. A soft fill that travels
  // with the camera lifts just the viewmodel — distance-capped so the world
  // never notices.
  const fill = new THREE.PointLight(0xd6e9f5, 3.5, 2.6, 1.9)
  fill.position.set(0.12, -0.04, -0.26)
  rig.add(fill)

  // Arms hang from clavicles in the rig frame (not the torso) so their poses
  // stay readable in screen space no matter how far the body leans prone.
  const armRoot = new THREE.Group()
  rig.add(armRoot)

  // Start procedural so the first frames aren't empty; swap to Blender GLB when ready.
  let rightHandGeo = handGeometry()
  let leftHandGeo = mirrorX(rightHandGeo)
  const handMeshes: THREE.Mesh[] = []

  function makeArm(sign: number, offset: number): Arm {
    // Clavicle: anatomical shoulder root, level with the collar. Carries the
    // deltoid cap and takes a small share of the stroke so the arm reads as
    // grown out of a torso rather than floating beside the camera.
    const clavicle = new THREE.Group()
    clavicle.position.set(sign * 0.19, -0.33, 0.12)
    armRoot.add(clavicle)

    const deltoid = new THREE.Mesh(new THREE.SphereGeometry(0.062, 14, 10), suit)
    deltoid.scale.set(1, 0.85, 1.05)
    clavicle.add(deltoid)

    const shoulder = new THREE.Group()
    clavicle.add(shoulder)

    const upper = limb(0.33, 0.058, 0.05, suit)
    shoulder.add(upper.root)

    // Bicep panel ring — sells "wetsuit seam" without cards/UI clutter
    const bicepRing = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.006, 8, 16), suitPanel)
    bicepRing.rotation.x = Math.PI / 2
    bicepRing.position.y = -0.05
    upper.root.add(bicepRing)

    const elbow = new THREE.Group()
    upper.end.add(elbow)
    // Elbow pad — softens the sharp V of a fully bent arm
    const elbowPad = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 8), suitPanel)
    elbowPad.position.set(0, 0.004, 0.016)
    elbowPad.scale.set(0.9, 1, 0.85)
    elbow.add(elbowPad)

    const fore = limb(0.31, 0.047, 0.038, suit)
    elbow.add(fore.root)

    // Glove gauntlet — flares over the forearm end so the hand doesn't look bolted on
    const gauntlet = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.044, 0.09, 18), glove)
    gauntlet.position.y = -0.255
    fore.root.add(gauntlet)
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.054, 0.053, 0.014, 18), accent)
    cuff.position.y = -0.215
    fore.root.add(cuff)

    const wrist = new THREE.Group()
    fore.end.add(wrist)
    // Wrist ball welds the hand mesh to the gauntlet through big pitch swings
    const wristBall = new THREE.Mesh(new THREE.SphereGeometry(0.034, 12, 8), glove)
    wristBall.scale.y = 0.8
    wrist.add(wristBall)

    const hand = new THREE.Mesh(sign > 0 ? rightHandGeo : leftHandGeo, glove)
    // Palm faces +Z locally, so a little wrist extension points it back along the
    // pull rather than up at the sky during the catch
    hand.rotation.x = -0.08
    // Seat inside the gauntlet; slight Z thicken for palm pad
    hand.position.y = 0.028
    hand.scale.set(1.06, 1.0, 1.12)
    hand.name = sign > 0 ? 'RightHand' : 'LeftHand'
    wrist.add(hand)
    handMeshes.push(hand)

    return { clavicle, shoulder, elbow, wrist, sign, offset }
  }

  const arms = [makeArm(1, 0), makeArm(-1, 0.5)]

  void loadBlenderHandGeometry().then((geo) => {
    if (!geo) return
    const prevRight = rightHandGeo
    const prevLeft = leftHandGeo
    rightHandGeo = geo
    leftHandGeo = mirrorX(geo)
    for (const hand of handMeshes) {
      hand.geometry = hand.name === 'RightHand' ? rightHandGeo : leftHandGeo
    }
    prevRight.dispose()
    prevLeft.dispose()
  })

  // —— body ————————————————————————————————————————————————
  // Neutral standing pose under the camera: collar at the base of the neck,
  // chest, abdomen, hips, legs. `body` pivots at the collar for the prone
  // swim lean; ashore `prone` damps to zero and the same pivot stands upright.
  const body = new THREE.Group()
  body.name = 'Body'
  body.position.set(0, -0.24, 0.12)
  rig.add(body)

  // Hood collar + neck dam — the rim you catch at the bottom of the frame
  // when you look straight down
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.032, 10, 18), suitPanel)
  collar.rotation.x = Math.PI / 2
  collar.position.y = -0.04
  body.add(collar)
  const neckDam = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.115, 0.1, 14), suit)
  neckDam.position.y = -0.07
  body.add(neckDam)

  // Clavicle bar ties the deltoids to the chest so the shoulders have a home
  const clavBar = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.26, 4, 12), suit)
  clavBar.rotation.z = Math.PI / 2
  clavBar.position.set(0, -0.12, 0.01)
  clavBar.scale.set(1, 1, 0.8)
  body.add(clavBar)

  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.185, 0.28, 4, 14), suit)
  chest.position.y = -0.32
  chest.scale.set(1, 1, 0.74)
  body.add(chest)

  const abdomen = new THREE.Mesh(new THREE.CapsuleGeometry(0.155, 0.14, 4, 12), suit)
  abdomen.position.y = -0.52
  abdomen.scale.set(1, 1, 0.7)
  body.add(abdomen)

  // Center zipper track
  const zipper = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.36, 0.008), hardware)
  zipper.position.set(0, -0.3, 0.138)
  body.add(zipper)
  const zipperPull = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.028, 0.014), accent)
  zipperPull.position.set(0, -0.15, 0.144)
  body.add(zipperPull)

  // BCD shoulder straps + chest strap — reads as dive kit, and gives the eye
  // something to land on between collar and weight belt when looking down
  for (const sx of [-1, 1] as const) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.28, 0.016), suitPanel)
    strap.position.set(sx * 0.105, -0.24, 0.132)
    strap.rotation.set(-0.1, 0, sx * -0.05)
    body.add(strap)
    const keeper = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.02), accent)
    keeper.position.set(sx * 0.105, -0.32, 0.14)
    keeper.rotation.z = sx * -0.05
    body.add(keeper)

    // Side panel stripe (chest)
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.28, 0.008), accent)
    stripe.position.set(sx * 0.13, -0.3, 0.1)
    stripe.rotation.z = sx * 0.08
    body.add(stripe)
  }
  const chestStrap = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.045, 0.014), suitPanel)
  chestStrap.position.set(0, -0.36, 0.138)
  body.add(chestStrap)
  const strapBuckle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), accent)
  strapBuckle.position.set(0, -0.36, 0.148)
  body.add(strapBuckle)

  const hips = new THREE.Group()
  hips.name = 'Hips'
  hips.position.y = -0.66
  body.add(hips)

  // Weight belt
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.15, 0.08, 14), hardware)
  belt.scale.z = 0.78
  belt.position.y = 0.02
  hips.add(belt)
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.025), accent)
  buckle.position.set(0, 0.02, 0.122)
  hips.add(buckle)

  function makeLeg(sign: number): Leg {
    const hip = new THREE.Group()
    hip.position.set(sign * 0.088, -0.02, 0)
    hips.add(hip)

    const thigh = limb(0.44, 0.082, 0.066, suit)
    hip.add(thigh.root)

    // Thigh panel seam — reads as suit construction, not a high-vis rail
    const thighStripe = new THREE.Mesh(new THREE.BoxGeometry(0.011, 0.28, 0.006), suitPanel)
    thighStripe.position.set(sign * 0.055, -0.22, 0.052)
    thigh.root.add(thighStripe)

    const knee = new THREE.Group()
    thigh.end.add(knee)
    const kneePad = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 8), suitPanel)
    kneePad.position.set(0, 0.0, -0.02)
    kneePad.scale.set(0.95, 1.05, 0.8)
    knee.add(kneePad)

    const shin = limb(0.42, 0.06, 0.047, suit)
    knee.add(shin.root)

    // Bootie — same glove rubber as the hands
    const foot = new THREE.Mesh(new THREE.CapsuleGeometry(0.042, 0.075, 3, 10), glove)
    foot.scale.set(1.15, 1, 0.65)
    foot.position.set(0, -0.06, -0.045)
    foot.rotation.x = 1.1
    shin.end.add(foot)
    const ankleCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.048, 0.03, 12), accent)
    ankleCuff.position.y = -0.02
    shin.end.add(ankleCuff)

    return { hip, knee, sign }
  }

  const legs = [makeLeg(1), makeLeg(-1)]

  // —— animation scratch ————————————————————————————————————
  const poseCrawl: Pose = { swing: 0, spread: 0, twist: 0, elbow: 0, wristPitch: 0, wristRoll: 0 }
  const poseBreast: Pose = { swing: 0, spread: 0, twist: 0, elbow: 0, wristPitch: 0, wristRoll: 0 }
  const poseRest: Pose = { swing: 0, spread: 0, twist: 0, elbow: 0, wristPitch: 0, wristRoll: 0 }
  const poseWalk: Pose = { swing: 0, spread: 0, twist: 0, elbow: 0, wristPitch: 0, wristRoll: 0 }
  const legWhip = { hip: 0, knee: 0, spread: 0 }
  const euler = new THREE.Euler(0, 0, 0, 'XYZ')
  const qA = new THREE.Quaternion()
  const qB = new THREE.Quaternion()
  const qC = new THREE.Quaternion()
  const qD = new THREE.Quaternion()
  const qOut = new THREE.Quaternion()

  /** Incremental weighted slerp — order-independent enough for four poses. */
  function blend(wA: number, wB: number, wC: number, wD: number) {
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
    if (wD > 0.0001) {
      total += wD
      qOut.slerp(qD, wD / total)
    }
  }

  let prone = 0
  let kick = 0

  /**
   * The ship's immersion suit, pulled on over the dive kit. Survival orange is
   * the one colour the murk doesn't take, so the change reads instantly at any
   * depth — and it's the only cue the run gives that the cold slowed down.
   */
  function setSurvivalSuit(on: boolean) {
    suit.color.set(on ? 0xd4691f : 0x27384a)
    suitPanel.color.set(on ? 0xb2531a : 0x33495e)
    suit.emissive.set(on ? 0x2a1004 : 0x000000)
    suit.emissiveIntensity = on ? 0.45 : 0
    suitPanel.emissive.set(on ? 0x230d03 : 0x000000)
    suitPanel.emissiveIntensity = on ? 0.4 : 0
    // Sealed cuffs and a heavier glove — the suit swallows the wrist seam
    glove.color.set(on ? 0x16191f : 0x1b222b)
  }

  function update(dt: number, time: number, frame: PlayerFrame, pitch: number, roll: number) {
    // Head can look anywhere; the body only partly follows
    rig.rotation.x = -pitch * 0.72
    rig.rotation.z = -roll * 0.55

    const sub = frame.submersion
    // Arms come out only when you're actually moving: planar input, or the
    // glide while speed bleeds off. Idle and pure vertical dives/ascents tuck
    // them to the sides (REST) so the screen stays clean. `effort` includes
    // vertical thrust, so it can't drive this.
    const walking = frame.walking ? 1 : 0
    const walkAmt = walking * Math.max(frame.moving, Math.min(1, frame.speed / 2.4))
    const swim = (1 - walking) * Math.max(frame.moving, Math.min(1, frame.speed / 3.5))

    // Ashore the torso stands back up — prone is a swim posture
    prone = damp(prone, walking ? 0 : frame.moving * (0.92 + 0.3 * sub), 4, dt)
    const wCrawl = swim * (1 - sub)
    const wBreast = swim * sub
    const wRest = Math.max(0, 1 - swim - walkAmt)

    // Torso rolls toward the pulling arm; arms inherit most of it. Without
    // this the crawl reads as a windmill bolted to a surfboard.
    const crawlRoll = -Math.sin(frame.stroke * TAU) * 0.14 * wCrawl
    // Breaststroke breathes: chest rises into the insweep, settles on the glide
    const breastPulse = Math.sin(frame.stroke * TAU * 2 + 0.8) * 0.045 * wBreast
    // Idle breathing lift
    const breathe = Math.sin(time * 0.8) * 0.006 * wRest
    // Walking: a touch of forward lean, hips swaying with the stride
    const walkLean = walkAmt * 0.05
    const walkSway = Math.sin(frame.stroke * TAU * 2) * 0.02 * walkAmt

    body.rotation.x = -prone + breastPulse - walkLean
    body.rotation.z = crawlRoll + walkSway
    body.position.y = -0.24 + breathe
    armRoot.rotation.x = -prone * 0.1
    armRoot.rotation.z = crawlRoll * 0.75 + walkSway * 0.5
    armRoot.position.z = prone * 0.05

    const smoothing = 1 - Math.exp(-dt * 14)
    const restPhase = time * 0.35

    for (const arm of arms) {
      samplePose(CRAWL, frame.stroke + arm.offset, poseCrawl)
      samplePose(BREAST, frame.stroke, poseBreast)
      samplePose(REST, restPhase + arm.offset * 0.5, poseRest)
      samplePose(WALK, frame.stroke + arm.offset, poseWalk)

      // Clavicle follows the stroke at a fraction — shoulders rise into the
      // reach and dip into the pull instead of staying pinned to the camera
      const clavSwing =
        (poseCrawl.swing - 0.6) * 0.09 * wCrawl +
        (poseBreast.swing - 0.8) * 0.07 * wBreast +
        Math.sin(time * 0.8 + arm.offset * 3) * 0.015 * wRest +
        poseWalk.swing * 0.05 * walkAmt
      arm.clavicle.rotation.x = damp(arm.clavicle.rotation.x, clavSwing, 10, dt)

      euler.set(poseCrawl.swing, arm.sign * poseCrawl.twist, arm.sign * poseCrawl.spread)
      qA.setFromEuler(euler)
      euler.set(poseBreast.swing, arm.sign * poseBreast.twist, arm.sign * poseBreast.spread)
      qB.setFromEuler(euler)
      euler.set(poseRest.swing, arm.sign * poseRest.twist, arm.sign * poseRest.spread)
      qC.setFromEuler(euler)
      euler.set(poseWalk.swing, arm.sign * poseWalk.twist, arm.sign * poseWalk.spread)
      qD.setFromEuler(euler)
      blend(wCrawl, wBreast, wRest, walkAmt)
      arm.shoulder.quaternion.slerp(qOut, smoothing)

      euler.set(poseCrawl.elbow, 0, 0)
      qA.setFromEuler(euler)
      euler.set(poseBreast.elbow, 0, 0)
      qB.setFromEuler(euler)
      euler.set(poseRest.elbow, 0, 0)
      qC.setFromEuler(euler)
      euler.set(poseWalk.elbow, 0, 0)
      qD.setFromEuler(euler)
      blend(wCrawl, wBreast, wRest, walkAmt)
      arm.elbow.quaternion.slerp(qOut, smoothing)

      euler.set(poseCrawl.wristPitch, 0, arm.sign * poseCrawl.wristRoll)
      qA.setFromEuler(euler)
      euler.set(poseBreast.wristPitch, 0, arm.sign * poseBreast.wristRoll)
      qB.setFromEuler(euler)
      euler.set(poseRest.wristPitch, 0, arm.sign * poseRest.wristRoll)
      qC.setFromEuler(euler)
      euler.set(poseWalk.wristPitch, 0, arm.sign * poseWalk.wristRoll)
      qD.setFromEuler(euler)
      blend(wCrawl, wBreast, wRest, walkAmt)
      arm.wrist.quaternion.slerp(qOut, smoothing)
    }

    // —— legs ————————————————————————————————————————————
    // Four styles summed by the same weights as the arms: flutter at the
    // surface, whip kick synced to the breaststroke, slow alternating tread
    // when idle *in water*, and an ashore stride counter-phased to the arms.
    kick = (kick + dt * (0.7 + 2.2 * swim)) % 1
    const flutterAmp = 0.12 + 0.34 * swim
    const tread = time * 1.35
    const treadW = wRest * (1 - walking)

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]
      const offset = i * Math.PI

      const flutterHip = Math.sin(kick * TAU + offset) * flutterAmp - 0.04
      const flutterKnee = 0.14 + Math.max(0, Math.sin(kick * TAU + offset - 0.9)) * 0.5

      sampleLeg(WHIP, frame.stroke, legWhip)

      const treadHip = Math.sin(tread + offset) * 0.16 - 0.06
      const treadKnee = 0.3 + Math.max(0, Math.sin(tread + offset - 0.8)) * 0.25

      // Stride: knee folds through the swing, plants straight for the stance
      const walkHip = Math.sin(frame.stroke * TAU + offset - Math.PI / 2) * 0.5 * walkAmt
      const walkKnee = (0.06 + Math.max(0, Math.sin(frame.stroke * TAU + offset)) * 0.72) * walkAmt

      leg.hip.rotation.x = flutterHip * wCrawl + legWhip.hip * wBreast + treadHip * treadW + walkHip
      leg.hip.rotation.z = leg.sign * (legWhip.spread * wBreast + 0.03 * walkAmt)
      leg.knee.rotation.x = -(flutterKnee * wCrawl + legWhip.knee * wBreast + treadKnee * treadW + walkKnee)
    }
  }

  return { rig, update, setSurvivalSuit }
}
