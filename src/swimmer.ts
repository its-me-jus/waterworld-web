import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { PlayerFrame } from './player'
import { createArticulatedLimb, createTorso } from './anatomy'

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
  [0.10, 1.38, 0.16, 0.21, 0.16, 0.08, 0.06],
  [0.22, 0.85, 0.28, 0.31, 0.77, -0.24, 0.12],
  [0.34, -0.04, 0.32, 0.22, 1.13, -0.43, 0.08],
  [0.48, -1.05, 0.3, -0.05, 0.85, -0.25, 0.0],
  [0.6, -1.75, 0.5, -0.3, 1.5, 0.45, 0.2],
  [0.75, -2.79, 0.77, -0.40, 1.68, 0.59, 0.22],
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
  [0.71, 1.60, 0.11, -0.04, 0.11, 0.03, 0.0],
  [0.86, 1.64, 0.10, 0.0, 0.08, 0.05, 0.0],
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

// Swing starts with the heel lifting behind the hip. The knee then leads
// the foot forward, opens for contact, and softens as weight comes onto it.
const STRIDE: LegKey[] = [
  [0, -0.46, 0.35, 0.02], [0.14, 0.04, 1.12, 0.04],
  [0.33, 0.64, 0.83, 0.03], [0.50, 0.54, 0.11, 0.015],
  [0.61, 0.37, 0.32, 0.01], [0.82, -0.10, 0.15, 0.01],
  [1, -0.46, 0.35, 0.02],
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
  return out
}

/** A shallow cupped palm and relaxed finger arc, driven through each pull.
 * Applies to the owned mesh and fallback, preserving their original topology. */
function addHandCup(geometry: THREE.BufferGeometry) {
  const cupped = geometry.clone()
  const positions = cupped.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i)
    const finger = Math.max(0, -y - 0.085)
    const angle = Math.min(0.72, finger * 8)
    positions.setXYZ(i, x * (1 - Math.min(0.05, finger * 0.5)),
      y + finger * (1 - Math.cos(angle)), z + finger * Math.sin(angle) * 0.6)
  }
  cupped.computeVertexNormals()
  // UV islands duplicate palm vertices. Average their deformed normals so the
  // glove does not acquire hard polygon edges when the hand cups.
  const normals = cupped.getAttribute('normal') as THREE.BufferAttribute
  const smooth = new Map<string, THREE.Vector3>()
  const key = (i: number) => `${Math.round(positions.getX(i) * 1e5)},${Math.round(positions.getY(i) * 1e5)},${Math.round(positions.getZ(i) * 1e5)}`
  for (let i = 0; i < positions.count; i++) {
    const hash = key(i)
    const sum = smooth.get(hash) ?? new THREE.Vector3()
    sum.x += normals.getX(i); sum.y += normals.getY(i); sum.z += normals.getZ(i)
    smooth.set(hash, sum)
  }
  for (const sum of smooth.values()) sum.normalize()
  for (let i = 0; i < positions.count; i++) {
    const sum = smooth.get(key(i))!
    normals.setXYZ(i, sum.x, sum.y, sum.z)
  }
  geometry.morphAttributes.position = [positions.clone()]
  geometry.morphAttributes.normal = [cupped.getAttribute('normal').clone()]
  cupped.dispose()
  return geometry
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
      if (!found.getAttribute("normal")) found.computeVertexNormals()
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

type Arm = {
  clavicle: THREE.Group
  shoulder: THREE.Object3D
  elbow: THREE.Object3D
  wrist: THREE.Object3D
  sign: number
  offset: number
  hand: THREE.Mesh
}

type Leg = { hip: THREE.Object3D; knee: THREE.Object3D; ankle: THREE.Object3D; sign: number }

// A single wraparound window. Each cross section shares the same swept brow
// and notch over the nose, so the rubber lip seats against the glass at the temples.
function expeditionMask() {
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x18494d, roughness: 0.13, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06,
  })
  const rim = new THREE.MeshStandardMaterial({ color: 0xe9d8ad, roughness: 0.61 })
  const seal = new THREE.MeshStandardMaterial({ color: 0x223030, roughness: 0.69 })
  const positions = [0, 0.174, -0.132]
  const indices: number[] = []
  const geometry = new THREE.BufferGeometry()
  const sides = 48
  // Radial extent, setback from the lens apex, and material of this band.
  const bands = [[0.42, 0.0005, 0], [0.84, 0.002, 0], [0.88, 0.001, 1],
    [0.98, 0, 1], [1.0, 0.005, 1], [1.02, 0.017, 2], [0.98, 0.038, 2]]
  for (const [row, [radius, setback, material]] of bands.entries()) {
    const start = indices.length
    const base = 1 + row * sides
    for (let i = 0; i < sides; i++) {
      const angle = i * TAU / sides
      const c = Math.cos(angle), s = Math.sin(angle)
      const x = Math.sign(c) * Math.abs(c) ** 0.74 * radius
      const cheek = s < 0 ? 0.013 * Math.exp(-((x / 0.22) ** 2)) : 0
      const y = Math.sign(s) * Math.abs(s) ** 0.66 * radius * 0.046 + cheek * radius
      positions.push(x * 0.108, 0.174 + y + 0.005 * x * x, -0.132 + x * x * 0.073 + setback)
      const a = base + i, b = base + (i + 1) % sides
      if (row === 0) indices.push(0, b, a)
      else indices.push(a - sides, b, a, a - sides, b - sides, b)
    }
    // Combine adjacent bands into a single draw per material.
    const last = geometry.groups[geometry.groups.length - 1]
    if (last?.materialIndex === material) last.count += indices.length - start
    else geometry.addGroup(start, indices.length - start, material)
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const mask = new THREE.Mesh(geometry, [glass, rim, seal])
  mask.name = 'Reef mask'
  return mask
}

export function createSwimmer(camera: THREE.Camera) {
  // Full dive kit — no bare skin. Neoprene reads as intentional even when the
  // hand mesh is mid-poly / slightly blobbed; gloves are supposed to look padded.
  // Clearcoat gives the wet sheen that sells "just came out of the water".
  const suit = new THREE.MeshPhysicalMaterial({
    color: 0xbac8c6,
    vertexColors: true,
    roughness: 0.58,
    metalness: 0.0,
    clearcoat: 0.2,
    clearcoatRoughness: 0.65,
  })
  const suitPanel = new THREE.MeshPhysicalMaterial({
    color: 0x2d3c47,
    roughness: 0.55,
    metalness: 0.0,
    clearcoat: 0.16,
    clearcoatRoughness: 0.65,
  })
  const glove = new THREE.MeshPhysicalMaterial({
    color: 0x1b222b,
    roughness: 0.52,
    metalness: 0.0,
    clearcoat: 0.25,
    clearcoatRoughness: 0.5,
  })
  // High-vis cuff + buckle — classic diver cue, also hides the wrist seam
  const accent = new THREE.MeshStandardMaterial({
    color: 0xbfa56c,
    roughness: 0.42,
    metalness: 0.08,
  })
  const hardware = new THREE.MeshStandardMaterial({
    color: 0x49565f,
    roughness: 0.35,
    metalness: 0.6,
  })

  // Fine knitted neoprene breakup catches grazing light without painted stripes.
  const size = 64
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4
    pixels[i] = 128 + Math.round(Math.sin(x * Math.PI / 2) * 18)
    pixels[i + 1] = 128 + Math.round(Math.sin(y * Math.PI / 2 + x * Math.PI) * 18)
    pixels[i + 2] = 253
    pixels[i + 3] = 255
  }
  const fabric = new THREE.DataTexture(pixels, size, size)
  fabric.wrapS = fabric.wrapT = THREE.RepeatWrapping
  fabric.repeat.set(5, 8)
  fabric.magFilter = THREE.LinearFilter
  fabric.generateMipmaps = true
  fabric.minFilter = THREE.LinearMipmapLinearFilter
  fabric.needsUpdate = true
  for (const material of [suit, suitPanel, glove]) {
    material.normalMap = fabric
    material.normalScale.setScalar(0.07)
  }

  const rig = new THREE.Group()
  rig.name = 'Swimmer'
  rig.userData.handSource = 'procedural'
  camera.add(rig)

  // The sun is overhead and we mostly see the underside of our own arms, so
  // without help they render as near-silhouettes. A soft fill that travels
  // with the camera lifts just the viewmodel.
  //
  // Its reach has to stop short of the ground. Eye height ashore is about
  // 1.5 m, and at the old 2.6 m this pooled on the sand in front of your feet
  // — invisible in daylight, but after dark it was the brightest thing on the
  // island and nothing was casting it.
  const FILL_INTENSITY = 0.65
  const fill = new THREE.PointLight(0xd6e9f5, FILL_INTENSITY, 1.15, 1.9)
  fill.position.set(0.12, -0.04, -0.26)
  rig.add(fill)

  /**
   * Put the body away (the sky probe and film shots must not see it) without
   * hiding the rig itself. three.js compiles every lit shader for the number
   * of lights in view, so a light that drops out with its parent makes the
   * whole scene's shaders rebuild, which is a freeze of several seconds. The
   * light stays where it is and is turned down to nothing instead.
   */
  const putAway = new Set<THREE.Object3D>()
  let hidden = false
  function setHidden(next: boolean) {
    hidden = next
    if (next) {
      // Safe to call every frame: the pose update may have shown a part again
      for (const part of rig.children) {
        if (part === fill || !part.visible) continue
        part.visible = false
        putAway.add(part)
      }
      fill.intensity = 0
    } else {
      for (const part of putAway) part.visible = true
      putAway.clear()
      fill.intensity = FILL_INTENSITY
    }
  }

  // Arms hang from clavicles in the rig frame (not the torso) so their poses
  // stay readable in screen space no matter how far the body leans prone.
  const armRoot = new THREE.Group()
  rig.add(armRoot)

  // Start procedural so the first frames aren't empty; swap to Blender GLB when ready.
  let rightHandGeo = addHandCup(handGeometry())
  let leftHandGeo = addHandCup(mirrorX(rightHandGeo))
  const handMeshes: THREE.Mesh[] = []

  function makeArm(sign: number, offset: number): Arm {
    // Clavicle: anatomical shoulder root, level with the collar. Carries the
    // deltoid cap and takes a small share of the stroke so the arm reads as
    // grown out of a torso rather than floating beside the camera.
    const clavicle = new THREE.Group()
    clavicle.position.set(sign * 0.164, -0.084, -0.004)
    armRoot.add(clavicle)

    const sleeve = createArticulatedLimb(suit)
    clavicle.add(sleeve.root)
    const { shoulder, elbow, wrist } = sleeve
    shoulder.name = sign > 0 ? 'RightShoulder' : 'LeftShoulder'
    elbow.name = sign > 0 ? 'RightElbow' : 'LeftElbow'
    wrist.name = sign > 0 ? 'RightWrist' : 'LeftWrist'

    // Flat neoprene wrist seal; the sleeve itself continues to the hand.
    const seal = new THREE.Mesh(new THREE.CylinderGeometry(0.029, 0.028, 0.035, 32), glove)
    seal.position.y = 0.012
    wrist.add(seal)
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.0298, 0.0298, 0.004, 32), accent)
    cuff.position.y = 0.024
    wrist.add(cuff)

    const hand = new THREE.Mesh(sign > 0 ? rightHandGeo : leftHandGeo, glove)
    // Palm faces +Z locally, so a little wrist extension points it back along the
    // pull rather than up at the sky during the catch
    hand.rotation.x = -0.08
    // Seat inside the gauntlet; slight Z thicken for palm pad
    hand.position.y = 0.019
    hand.scale.set(0.94, 0.88, 0.96)
    hand.name = sign > 0 ? 'RightHand' : 'LeftHand'
    wrist.add(hand)
    handMeshes.push(hand)

    return { clavicle, shoulder, elbow, wrist, sign, offset, hand }
  }

  const arms = [makeArm(1, 0), makeArm(-1, 0.5)]

  void loadBlenderHandGeometry().then((geo) => {
    if (!geo) return
    const prevRight = rightHandGeo
    const prevLeft = leftHandGeo
    rig.userData.handSource = 'blender'
    rightHandGeo = addHandCup(geo)
    leftHandGeo = addHandCup(mirrorX(geo))
    for (const hand of handMeshes) {
      hand.geometry = hand.name === 'RightHand' ? rightHandGeo : leftHandGeo
      hand.updateMorphTargets()
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
  body.position.set(0, -0.23, 0.23)
  rig.add(body)

  body.add(createTorso(suit))
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.073, 0.007, 8, 40), glove)
  collar.rotation.x = Math.PI / 2
  collar.position.set(0, -0.007, 0.018)
  body.add(collar)

  // A short neck under the neoprene hood, with a wraparound mask seal.
  const hood = new THREE.Group()
  body.add(hood)
  hood.visible = false
  hood.position.y = -0.016
  function oval(parent: THREE.Group, material: THREE.Material, x: number, y: number, z: number,
    width: number, height: number, depth: number) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), material)
    mesh.position.set(x, y, z)
    mesh.scale.set(width, height, depth)
    parent.add(mesh)
    return mesh
  }
  oval(hood, suitPanel, 0, 0.036, 0.014, 0.073, 0.091, 0.065)
  // One hood from chin to crown. Narrow the jaw and bring the chin forward
  // under the mask, then round out the back of the skull above the strap.
  const profile = [[0, 0.047], [0.041, 0.052], [0.064, 0.073], [0.081, 0.106],
    [0.091, 0.139], [0.099, 0.178], [0.099, 0.205], [0.091, 0.237],
    [0.070, 0.263], [0.039, 0.278], [0, 0.284]]
  const skull = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 32)
  const vertices = skull.attributes.position
  for (let i = 0; i < vertices.count; i++) {
    const jaw = 1 - THREE.MathUtils.smoothstep(vertices.getY(i), 0.065, 0.16)
    vertices.setZ(i, vertices.getZ(i) * 1.09 - 0.042 * jaw)
  }
  skull.computeVertexNormals()
  hood.add(new THREE.Mesh(skull, suitPanel))
  oval(hood, glove, 0, 0.17, -0.013, 0.098, 0.024, 0.103)
  hood.add(expeditionMask())
  oval(hood, glove, 0, 0.135, -0.102, 0.022, 0.032, 0.025)
  // The snorkel curves around the cheek and clips to the mask strap.
  const airway = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.095, -0.117), new THREE.Vector3(-0.064, 0.067, -0.12),
    new THREE.Vector3(-0.108, 0.11, -0.071), new THREE.Vector3(-0.113, 0.19, -0.002),
    new THREE.Vector3(-0.117, 0.316, 0.047),
  ])
  hood.add(new THREE.Mesh(new THREE.TubeGeometry(airway, 20, 0.012, 10, false), glove))
  const signalOrange = new THREE.MeshStandardMaterial({ color: 0xd66a35, roughness: 0.66 })
  const snorkelTip = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.045, 12, 1, true), signalOrange)
  snorkelTip.position.copy(airway.getPoint(1))
  snorkelTip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), airway.getTangent(1))
  hood.add(snorkelTip)

  // A flush front zip on the fitted chest (forward is -Z).
  const zipCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.06, -0.077), new THREE.Vector3(0, -0.15, -0.106),
    new THREE.Vector3(0, -0.28, -0.097), new THREE.Vector3(0, -0.43, -0.082),
  ])
  const zipper = new THREE.Mesh(new THREE.TubeGeometry(zipCurve, 24, 0.0025, 5, false), glove)
  body.add(zipper)
  const zipperPull = new THREE.Mesh(new THREE.BoxGeometry(0.009, 0.019, 0.004), hardware)
  zipperPull.position.set(0, -0.1, -0.1)
  body.add(zipperPull)

  const hips = new THREE.Group()
  hips.name = 'Hips'
  hips.position.y = -0.57
  body.add(hips)

  // The waist is part of the wetsuit; no rigid belt hiding the hip articulation.
  function makeLeg(sign: number): Leg {
    const leg = createArticulatedLimb(suit, true)
    leg.root.position.set(sign * 0.082, -0.015, 0)
    hips.add(leg.root)
    const hip = leg.shoulder, knee = leg.elbow
    const boot = new THREE.Mesh(new THREE.CapsuleGeometry(0.034, 0.115, 6, 20), glove)
    boot.rotation.x = Math.PI / 2
    boot.scale.set(1, 1, 0.76)
    boot.position.set(0, -0.024, -0.048)
    leg.wrist.add(boot)
    return { hip, knee, ankle: leg.wrist, sign }
  }

  const legs = [makeLeg(1), makeLeg(-1)]

  // —— animation scratch ————————————————————————————————————
  const poseCrawl: Pose = { swing: 0, spread: 0, twist: 0, elbow: 0, wristPitch: 0, wristRoll: 0 }
  const poseBreast: Pose = { swing: 0, spread: 0, twist: 0, elbow: 0, wristPitch: 0, wristRoll: 0 }
  const poseRest: Pose = { swing: 0, spread: 0, twist: 0, elbow: 0, wristPitch: 0, wristRoll: 0 }
  const poseWalk: Pose = { swing: 0, spread: 0, twist: 0, elbow: 0, wristPitch: 0, wristRoll: 0 }
  const legWhip = { hip: 0, knee: 0, spread: 0 }
  const stridePose = { hip: 0, knee: 0, spread: 0 }
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
  let walkBlend = 0
  let strokeBlend = 0
  let wetness = 0
  const drySuit = new THREE.Color(0xbac2aa)
  const wetSuit = new THREE.Color(0x627e78)
  const dryHood = new THREE.Color(0x394e52)
  const wetHood = new THREE.Color(0x162d34)
  const neoprene = [suit, suitPanel]
  let groundSampler: ((x: number, z: number) => number) | null = null
  const footWorld = new THREE.Vector3(), targetLocal = new THREE.Vector3()
  function setGroundSampler(sample: (x: number, z: number) => number) {
    groundSampler = sample
  }

  function update(dt: number, time: number, frame: PlayerFrame, pitch: number, roll: number, tracking = false) {
    // Head can look anywhere; the body only partly follows
    rig.rotation.x = -pitch
    rig.rotation.z = -roll * 0.55
    const lookDown = THREE.MathUtils.smoothstep(-pitch, 0.45, 1.35)
    rig.position.y = -Math.sin(-pitch) * lookDown * 0.12
    rig.position.z = Math.cos(pitch) * lookDown * 0.12
    hood.visible = tracking
    if (tracking) {
      // The first-person eye rides high enough to see over the swell.
      // Place the visible collar on the waterline for the tracking shot.
      const lower = frame.walking ? 0 : Math.max(0, camera.position.y - frame.surfaceY - 0.12)
      rig.position.set(camera.position.x, camera.position.y - lower, camera.position.z)
      camera.worldToLocal(rig.position)
    }

    const sub = frame.submersion
    // Arms come out only when you're actually moving: planar input, or the
    // glide while speed bleeds off. Idle and pure vertical dives/ascents tuck
    // them to the sides (REST) so the screen stays clean. `effort` includes
    // vertical thrust, so it can't drive this.
    walkBlend = damp(walkBlend, frame.walking ? 1 : 0, 7, dt)
    const soaked = !frame.walking || frame.underwater
    wetness = damp(wetness, soaked ? 1 : 0, soaked ? 5 : 0.105, dt)
    suit.color.lerpColors(drySuit, wetSuit, wetness)
    suitPanel.color.lerpColors(dryHood, wetHood, wetness)
    for (const cloth of neoprene) {
      cloth.roughness = 0.91 - 0.44 * wetness
      cloth.clearcoat = 0.025 + 0.48 * wetness
      cloth.clearcoatRoughness = 0.55 - 0.27 * wetness
      cloth.normalScale.setScalar(0.42 - 0.34 * wetness)
    }
    glove.roughness = 0.84 - wetness * 0.32
    glove.clearcoat = 0.08 + wetness * 0.44
    const walking = walkBlend
    const walkAmt = walking * Math.max(frame.moving, Math.min(1, frame.speed / 2.4))
    const swim = (1 - walking) * Math.max(frame.moving, Math.min(1, frame.speed / 3.5))

    // Ashore the torso stands back up — prone is a swim posture
    prone = damp(prone, (1 - walking) * frame.moving * (1.34 + 0.1 * sub), 4, dt)
    strokeBlend = damp(strokeBlend, sub, 5, dt)
    const wCrawl = swim * (1 - strokeBlend)
    const wBreast = swim * strokeBlend
    const wRest = Math.max(0, 1 - swim - walkAmt)

    // Torso rolls toward the pulling arm; arms inherit most of it. Without
    // this the crawl reads as a windmill bolted to a surfboard.
    const cycle = frame.stroke * TAU
    const crawlRoll = -Math.sin(cycle + 0.25) * 0.42 * wCrawl
    // Breaststroke breathes: chest rises into the insweep, settles on the glide
    const breastPulse = -Math.cos(cycle - 0.45) * 0.13 * wBreast
    // Idle breathing lift
    const breathe = Math.sin(time * 0.8) * 0.006 * wRest
    // Walking: a touch of forward lean, hips swaying with the stride
    const walkLean = walkAmt * 0.05
    const walkSway = Math.sin(cycle) * 0.045 * walkAmt

    body.rotation.x = -prone + breastPulse - walkLean
    // In prone posture the collar-to-hip axis is local Y. Roll about
    // that axis so the recovering shoulder actually lifts from the water.
    body.rotation.y = crawlRoll + Math.cos(cycle) * 0.10 * walkAmt
    body.rotation.z = walkSway
    hips.rotation.y = -Math.cos(cycle) * 0.19 * walkAmt - crawlRoll * 0.40
    body.position.y = -0.23 + breathe - 0.032 * walkAmt * (0.5 + 0.5 * Math.cos(cycle * 2))
    hood.rotation.x = prone * 0.62
    hood.rotation.y = -body.rotation.y * 0.55 + Math.pow(Math.max(0, Math.sin(cycle)), 2) * 0.58 * wCrawl
    armRoot.position.copy(body.position)
    armRoot.rotation.copy(body.rotation)

    const smoothing = 1 - Math.exp(-dt * 14)
    const restPhase = time * 0.35

    for (const arm of arms) {
      const phase = (frame.stroke + arm.offset) % 1
      const catchCup = Math.max(0, Math.sin(phase * TAU)) * wCrawl
        + Math.max(0, Math.sin(frame.stroke * TAU)) * wBreast
      if (arm.hand.morphTargetInfluences) {
        arm.hand.morphTargetInfluences[0] = damp(arm.hand.morphTargetInfluences[0],
          0.15 + catchCup * 0.8 + walkAmt * 0.2, 9, dt)
      }
      samplePose(CRAWL, frame.stroke + arm.offset, poseCrawl)
      samplePose(BREAST, frame.stroke, poseBreast)
      samplePose(REST, restPhase + arm.offset * 0.5, poseRest)
      samplePose(WALK, frame.stroke + arm.offset, poseWalk)

      // Clavicle follows the stroke at a fraction — shoulders rise into the
      // reach and dip into the pull instead of staying pinned to the camera
      const clavSwing =
        Math.sin((frame.stroke + arm.offset) * TAU) * 0.065 * wCrawl +
        (poseBreast.swing - 0.8) * 0.07 * wBreast +
        Math.sin(time * 0.8 + arm.offset * 3) * 0.015 * wRest +
        poseWalk.swing * 0.05 * walkAmt
      arm.clavicle.rotation.x = damp(arm.clavicle.rotation.x, clavSwing, 10, dt)

      euler.set(poseCrawl.swing - body.rotation.x, arm.sign * poseCrawl.twist, arm.sign * poseCrawl.spread)
      qA.setFromEuler(euler)
      euler.set(poseBreast.swing - body.rotation.x, arm.sign * poseBreast.twist, arm.sign * poseBreast.spread)
      qB.setFromEuler(euler)
      euler.set(poseRest.swing - body.rotation.x, arm.sign * poseRest.twist, arm.sign * poseRest.spread)
      qC.setFromEuler(euler)
      euler.set(poseWalk.swing - body.rotation.x, arm.sign * poseWalk.twist, arm.sign * poseWalk.spread)
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
    const kick = (frame.stroke * 3) % 1
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
      sampleLeg(STRIDE, frame.stroke + i * 0.5, stridePose)
      const walkHip = stridePose.hip * walkAmt
      const walkKnee = stridePose.knee * walkAmt

      leg.hip.rotation.x = flutterHip * wCrawl + legWhip.hip * wBreast + treadHip * treadW + walkHip
      leg.hip.rotation.z = leg.sign * (legWhip.spread * wBreast + 0.03 * walkAmt)
      leg.knee.rotation.x = -(flutterKnee * wCrawl + legWhip.knee * wBreast + treadKnee * treadW + walkKnee)
      leg.ankle.rotation.x = damp(leg.ankle.rotation.x,
        -(body.rotation.x + leg.hip.rotation.x + leg.knee.rotation.x) * walking
        - 0.67 * swim + Math.sin(kick * TAU + offset - 1.4) * 0.19 * wCrawl, 12, dt)
    }

    // Lift planted feet out of the actual terrain, folding hip and knee rather
    // than translating a detached boot. Swinging feet retain their clearance.
    if (groundSampler && frame.walking && Math.abs(camera.position.y - frame.groundY - 1.62) < 0.18) {
      rig.updateWorldMatrix(true, true)
      for (const leg of legs) {
        leg.ankle.getWorldPosition(footWorld)
        const floor = groundSampler(footWorld.x, footWorld.z)
        const lift = THREE.MathUtils.clamp(floor + 0.05 - footWorld.y, 0, 0.18)
        if (lift <= 0 || !Number.isFinite(floor)) continue
        footWorld.y += lift
        targetLocal.copy(footWorld)
        leg.hip.parent!.worldToLocal(targetLocal)
        targetLocal.sub(leg.hip.position)
        const distance = Math.min(0.784, Math.hypot(targetLocal.y, targetLocal.z))
        const knee = -Math.acos(THREE.MathUtils.clamp((distance * distance - 0.4 ** 2 - 0.385 ** 2) / (2 * 0.4 * 0.385), -1, 1))
        const hip = Math.atan2(-targetLocal.z, -targetLocal.y)
          - Math.atan2(0.385 * Math.sin(knee), 0.4 + 0.385 * Math.cos(knee))
        leg.hip.rotation.x = THREE.MathUtils.lerp(leg.hip.rotation.x, hip, walkBlend)
        leg.knee.rotation.x = THREE.MathUtils.lerp(leg.knee.rotation.x, knee, walkBlend)
        leg.ankle.rotation.x = -(body.rotation.x + leg.hip.rotation.x + leg.knee.rotation.x) * walkBlend
      }
    }
  }

  return {
    rig,
    update,
    setGroundSampler,
    setHidden,
    get hidden() {
      return hidden
    },
  }
}
