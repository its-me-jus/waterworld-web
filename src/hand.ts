import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * First-person hands. Fully procedural and self-authored — no third-party assets,
 * so the whole thing is ours to license. They're on screen nearly all the time,
 * so they carry generated PBR skin maps and a wet film that builds as you dive.
 */

const TAU = Math.PI * 2
const X_AXIS = new THREE.Vector3(1, 0, 0)
const Y_AXIS = new THREE.Vector3(0, 1, 0)
const Z_AXIS = new THREE.Vector3(0, 0, 1)

// —— generated skin maps ————————————————————————————————————

function hash2(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

function noise2(x: number, y: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy)
  const b = hash2(ix + 1, iy)
  const c = hash2(ix, iy + 1)
  const d = hash2(ix + 1, iy + 1)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

function fbm(x: number, y: number, octaves = 4) {
  let v = 0
  let a = 0.5
  let f = 1
  for (let i = 0; i < octaves; i++) {
    v += a * noise2(x * f, y * f)
    f *= 2.03
    a *= 0.5
  }
  return v
}

type SkinMaps = {
  albedo: THREE.CanvasTexture
  normal: THREE.CanvasTexture
  roughness: THREE.CanvasTexture
}

/**
 * Bake pores, blood flush and crease detail once at boot. Vertical UV runs from
 * the back of the hand (dry, freckled) toward the palm (pinker, softer).
 */
function createSkinMaps(size = 512): SkinMaps {
  const make = () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    return canvas
  }
  const albedoCanvas = make()
  const normalCanvas = make()
  const roughCanvas = make()

  const aCtx = albedoCanvas.getContext('2d')!
  const nCtx = normalCanvas.getContext('2d')!
  const rCtx = roughCanvas.getContext('2d')!
  const aImg = aCtx.createImageData(size, size)
  const nImg = nCtx.createImageData(size, size)
  const rImg = rCtx.createImageData(size, size)
  const height = new Float32Array(size * size)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const i = (y * size + x) * 4

      const flush = fbm(u * 3.4 + 2.1, v * 3.4 - 1.4, 4)
      const cool = fbm(u * 6.3 - 4, v * 5.9 + 2, 3)
      const freckle = Math.pow(Math.max(0, fbm(u * 42, v * 42, 2) - 0.66) * 2.6, 1.7)
      const pore = fbm(u * 120, v * 120, 2)
      const palm = THREE.MathUtils.smoothstep(v, 0.45, 0.9)

      const r = 176 + flush * 30 - freckle * 40 + palm * 12 - cool * 10
      const g = 122 + flush * 16 - freckle * 30 + palm * 6 - cool * 6
      const b = 96 + flush * 10 - freckle * 22 + palm * 16 + cool * 12

      aImg.data[i] = THREE.MathUtils.clamp(r, 0, 255)
      aImg.data[i + 1] = THREE.MathUtils.clamp(g, 0, 255)
      aImg.data[i + 2] = THREE.MathUtils.clamp(b, 0, 255)
      aImg.data[i + 3] = 255

      // Fine skin grain plus a few soft flexion creases toward the palm
      const crease = Math.pow(Math.abs(Math.sin(v * 15 + fbm(u * 3, v * 3, 2) * 2.4)), 22) * 0.5 * palm
      height[y * size + x] = pore * 0.05 + crease * 0.1 + fbm(u * 18, v * 18, 3) * 0.025

      const rough = 0.5 + (1 - palm) * 0.12 - flush * 0.05 + pore * 0.07 + crease * 0.08
      const rv = THREE.MathUtils.clamp(rough * 255, 0, 255)
      rImg.data[i] = rv
      rImg.data[i + 1] = rv
      rImg.data[i + 2] = rv
      rImg.data[i + 3] = 255
    }
  }

  const strength = 5.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const xm = height[y * size + ((x - 1 + size) % size)]
      const xp = height[y * size + ((x + 1) % size)]
      const ym = height[((y - 1 + size) % size) * size + x]
      const yp = height[((y + 1) % size) * size + x]
      let nx = (xm - xp) * strength
      let ny = (ym - yp) * strength
      const len = Math.hypot(nx, ny, 1) || 1
      nx /= len
      ny /= len
      nImg.data[i] = (nx * 0.5 + 0.5) * 255
      nImg.data[i + 1] = (ny * 0.5 + 0.5) * 255
      nImg.data[i + 2] = (1 / len) * 0.5 * 255 + 127
      nImg.data[i + 3] = 255
    }
  }

  aCtx.putImageData(aImg, 0, 0)
  nCtx.putImageData(nImg, 0, 0)
  rCtx.putImageData(rImg, 0, 0)

  const wrap = (canvas: HTMLCanvasElement, srgb: boolean) => {
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.anisotropy = 8
    tex.needsUpdate = true
    return tex
  }

  return {
    albedo: wrap(albedoCanvas, true),
    normal: wrap(normalCanvas, false),
    roughness: wrap(roughCanvas, false),
  }
}

export type SkinMaterials = {
  /** Shared by hands, arms, torso and legs so the tone always matches. */
  skin: THREE.MeshPhysicalMaterial
  nail: THREE.MeshPhysicalMaterial
  setWetness: (wet: number) => void
}

export function createSkinMaterials(): SkinMaterials {
  const maps = createSkinMaps(512)

  const skin = new THREE.MeshPhysicalMaterial({
    map: maps.albedo,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(1.1, 1.1),
    roughnessMap: maps.roughness,
    roughness: 0.58,
    metalness: 0,
    sheen: 0.6,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color(0xd08a68),
    clearcoat: 0.1,
    clearcoatRoughness: 0.55,
    envMapIntensity: 0.6,
  })

  // Cheap subsurface: never let flesh fall to black, and warm the half-tones
  skin.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;',
      /* glsl */ `
      vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
      vec3 sss = totalDiffuse * vec3(1.15, 0.8, 0.68) + vec3(0.035, 0.012, 0.009);
      totalDiffuse = mix(totalDiffuse, max(totalDiffuse, sss), 0.55);
      `,
    )
  }

  const nail = new THREE.MeshPhysicalMaterial({
    color: 0xdcae9e,
    roughness: 0.2,
    metalness: 0.04,
    clearcoat: 0.9,
    clearcoatRoughness: 0.12,
    sheen: 0.3,
    sheenColor: new THREE.Color(0xffd4c8),
  })

  function setWetness(wet: number) {
    const w = THREE.MathUtils.clamp(wet, 0, 1)
    skin.clearcoat = 0.1 + w * 0.55
    skin.clearcoatRoughness = 0.55 - w * 0.35
    skin.roughness = 0.58 - w * 0.2
    skin.envMapIntensity = 0.6 + w * 0.3
    skin.normalScale.setScalar(1.1 - w * 0.25)
    nail.clearcoat = 0.9 + w * 0.1
    nail.roughness = Math.max(0.06, 0.2 - w * 0.1)
  }

  return { skin, nail, setWetness }
}

export type DiveKitMaterials = SkinMaterials & {
  /** Neoprene for arms / torso / legs — slightly lighter than the glove. */
  suit: THREE.MeshPhysicalMaterial
  suitPanel: THREE.MeshPhysicalMaterial
  accent: THREE.MeshStandardMaterial
  hardware: THREE.MeshStandardMaterial
}

/**
 * Full dive kit: padded black gloves + neoprene suit. Same hand mesh, no bare
 * skin — the nail plates are painted glove-rubber so they disappear into the
 * finger tips. Wetness still drives clearcoat for the "just surfaced" sheen.
 */
export function createDiveKitMaterials(): DiveKitMaterials {
  const glove = new THREE.MeshPhysicalMaterial({
    color: 0x1b222b,
    roughness: 0.52,
    metalness: 0.06,
    clearcoat: 0.35,
    clearcoatRoughness: 0.4,
    envMapIntensity: 0.55,
  })
  // Same rubber as the glove so nail plates don't flash pink through the mitt
  const nail = new THREE.MeshPhysicalMaterial({
    color: 0x1b222b,
    roughness: 0.5,
    metalness: 0.06,
    clearcoat: 0.4,
    clearcoatRoughness: 0.35,
  })
  const suit = new THREE.MeshPhysicalMaterial({
    color: 0x27384a,
    roughness: 0.58,
    metalness: 0.04,
    clearcoat: 0.35,
    clearcoatRoughness: 0.45,
    envMapIntensity: 0.5,
  })
  const suitPanel = new THREE.MeshPhysicalMaterial({
    color: 0x33495e,
    roughness: 0.55,
    metalness: 0.05,
    clearcoat: 0.3,
    clearcoatRoughness: 0.48,
  })
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

  function setWetness(wet: number) {
    const w = THREE.MathUtils.clamp(wet, 0, 1)
    glove.clearcoat = 0.35 + w * 0.4
    glove.clearcoatRoughness = 0.4 - w * 0.2
    glove.roughness = 0.52 - w * 0.15
    glove.envMapIntensity = 0.55 + w * 0.35
    nail.clearcoat = glove.clearcoat
    nail.clearcoatRoughness = glove.clearcoatRoughness
    suit.clearcoat = 0.35 + w * 0.35
    suit.clearcoatRoughness = 0.45 - w * 0.18
    suit.roughness = 0.58 - w * 0.12
    suitPanel.clearcoat = suit.clearcoat
    suitPanel.clearcoatRoughness = suit.clearcoatRoughness
  }

  return {
    skin: glove,
    nail,
    suit,
    suitPanel,
    accent,
    hardware,
    setWetness,
  }
}

// —— geometry ———————————————————————————————————————————————

type HandParts = { body: THREE.BufferGeometry; nails: THREE.BufferGeometry }

/**
 * Index → pinky. `fan` splays the finger at the knuckle, `converge` leans the tip
 * back toward the middle finger — without it, fingers read as a splayed cartoon
 * glove instead of a relaxed hand.
 */
const FINGERS = [
  { x: -0.028, fan: -0.05, converge: 0.02, length: 0.088, r0: 0.0116, r1: 0.0085, curl: 0.16 },
  { x: -0.0094, fan: -0.012, converge: 0.004, length: 0.096, r0: 0.0122, r1: 0.0089, curl: 0.13 },
  { x: 0.0094, fan: 0.03, converge: -0.01, length: 0.091, r0: 0.0114, r1: 0.0083, curl: 0.16 },
  { x: 0.0268, fan: 0.075, converge: -0.026, length: 0.072, r0: 0.0098, r1: 0.0071, curl: 0.22 },
]

/**
 * Loft a tapered, slightly flattened tube along a curve — continuous skin with
 * no capsule seams, capped at both ends so you never see inside a finger.
 */
function taperedTube(
  curve: THREE.Curve<THREE.Vector3>,
  r0: number,
  r1: number,
  segs: number,
  radial: number,
  flat: number,
  uvOffset: number,
) {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const offset = new THREE.Vector3()
  const pos = new THREE.Vector3()
  const frames = curve.computeFrenetFrames(segs, false)
  const stride = radial + 1

  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    curve.getPointAt(t, pos)
    const frameN = frames.normals[i]
    const frameB = frames.binormals[i]
    const r = r0 + (r1 - r0) * t
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU
      offset
        .copy(frameN)
        .multiplyScalar(Math.cos(a) * r)
        .addScaledVector(frameB, Math.sin(a) * r * flat)
      positions.push(pos.x + offset.x, pos.y + offset.y, pos.z + offset.z)
      offset.normalize()
      normals.push(offset.x, offset.y, offset.z)
      uvs.push(uvOffset + t * 0.3, j / radial)
    }
  }

  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * stride + j
      const b = a + 1
      const c = (i + 1) * stride + j
      const d = c + 1
      indices.push(a, b, c, b, d, c)
    }
  }

  const cap = (ring: number, outward: THREE.Vector3, flip: boolean) => {
    curve.getPointAt(ring === 0 ? 0 : 1, pos)
    const centre = positions.length / 3
    positions.push(pos.x, pos.y, pos.z)
    normals.push(outward.x, outward.y, outward.z)
    uvs.push(uvOffset + (ring === 0 ? 0 : 0.3), 0.5)
    for (let j = 0; j < radial; j++) {
      const a = ring * stride + j
      const b = a + 1
      if (flip) indices.push(centre, b, a)
      else indices.push(centre, a, b)
    }
  }
  cap(0, frames.tangents[0].clone().negate(), true)
  cap(segs, frames.tangents[segs].clone(), false)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(indices)
  return geo
}

/**
 * Planar unwrap in hand space — X across the palm, Y along the fingers. The
 * scale is deliberately high: a hand is ~10 cm, so low numbers sample a single
 * flat corner of the skin map and the detail never shows.
 */
function projectUVs(geo: THREE.BufferGeometry, scale = 13) {
  const pos = geo.getAttribute('position')
  const uvs = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    uvs[i * 2] = pos.getX(i) * scale + 0.5
    uvs[i * 2 + 1] = -pos.getY(i) * scale * 0.8
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
}

/**
 * Right hand: wrist at the origin, fingers down -Y, palm facing +Z, thumb toward
 * -X the way a swimmer's thumbs face each other. Held in a light cup.
 */
function handGeometry(): HandParts {
  const bodyParts: THREE.BufferGeometry[] = []
  const nailParts: THREE.BufferGeometry[] = []
  const matrix = new THREE.Matrix4()
  const q = new THREE.Quaternion()

  const lump = (at: THREE.Vector3, sx: number, sy: number, sz: number, segs = 16) => {
    const geo = new THREE.SphereGeometry(1, segs, segs)
    geo.scale(sx, sy, sz)
    geo.translate(at.x, at.y, at.z)
    projectUVs(geo)
    bodyParts.push(geo)
  }

  const placeCap = (
    length: number,
    radius: number,
    at: THREE.Vector3,
    rot: THREE.Quaternion,
    scale: THREE.Vector3,
    radial = 16,
  ) => {
    const geo = new THREE.CapsuleGeometry(radius, Math.max(0.002, length - radius * 2), 6, radial)
    matrix.compose(at, rot, scale)
    geo.applyMatrix4(matrix)
    projectUVs(geo)
    bodyParts.push(geo)
  }

  const addFinger = (
    knuckle: THREE.Vector3,
    root: THREE.Quaternion,
    length: number,
    r0: number,
    r1: number,
    curl: number,
    converge: number,
    uvOffset: number,
  ) => {
    const at = (fy: number, fz: number, fx: number) =>
      new THREE.Vector3(converge * fx, -length * fy, length * fz * curl)
        .applyQuaternion(root)
        .add(knuckle)
    const p0 = knuckle.clone()
    const p1 = at(0.36, 0.05, 0.3)
    const p2 = at(0.7, 0.16, 0.7)
    const p3 = at(1, 0.26, 1)
    const curve = new THREE.CatmullRomCurve3([p0, p1, p2, p3])
    bodyParts.push(taperedTube(curve, r0, r1, 22, 14, 0.72, uvOffset))
    // Fingertip pad — kept just under the tube radius so it reads as a soft end
    // rather than a bead stuck on the finger
    lump(p3, r1 * 0.94, r1 * 0.98, r1 * 0.82, 12)

    // Nail plate on the back of the last phalanx
    const tangent = curve.getTangentAt(1).normalize()
    const back = new THREE.Vector3(0, 0, -1).applyQuaternion(root).normalize()
    const side = new THREE.Vector3().crossVectors(tangent, back)
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0).applyQuaternion(root)
    side.normalize()
    const dorsal = new THREE.Vector3().crossVectors(side, tangent).normalize()
    const nailQ = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(side, tangent.clone(), dorsal),
    )
    const nailAt = p3
      .clone()
      .addScaledVector(tangent, -length * 0.1)
      .addScaledVector(dorsal, r1 * 0.55)
    const plate = new THREE.SphereGeometry(1, 16, 12)
    plate.scale(r1 * 0.92, length * 0.17, r1 * 0.62)
    matrix.compose(nailAt, nailQ, new THREE.Vector3(1, 1, 1))
    nailParts.push(plate.applyMatrix4(matrix))
  }

  // Wrist flare, blending the forearm into the palm
  placeCap(
    0.028,
    0.019,
    new THREE.Vector3(0, -0.012, 0.002),
    q.identity(),
    new THREE.Vector3(1.15, 1, 0.72),
    18,
  )

  // Palm: a capsule squashed front-to-back. Rounded edges (unlike a hard loft)
  // but thin enough that it stops reading as a mitten.
  const palm = new THREE.CapsuleGeometry(0.032, 0.054, 8, 22)
  palm.scale(1.5, 1, 0.44)
  palm.translate(0, -0.054, 0.004)
  projectUVs(palm)
  bodyParts.push(palm)

  // Thenar wedge at the thumb base, heel pad on the pinky side
  lump(new THREE.Vector3(-0.024, -0.046, 0.008), 0.015, 0.031, 0.012)
  lump(new THREE.Vector3(0.025, -0.052, 0.006), 0.012, 0.026, 0.011)

  FINGERS.forEach((finger, i) => {
    lump(new THREE.Vector3(finger.x, -0.094, 0.0), 0.0102, 0.0086, 0.0092, 12)
    addFinger(
      new THREE.Vector3(finger.x, -0.096, 0.002),
      new THREE.Quaternion().setFromAxisAngle(Z_AXIS, finger.fan),
      finger.length,
      finger.r0,
      finger.r1,
      finger.curl,
      finger.converge,
      0.08 + i * 0.2,
    )
  })

  // Thumb: opposed, set low on the palm and lying along its plane rather than
  // sticking out sideways as a spur
  const thumbKnuckle = new THREE.Vector3(-0.029, -0.042, 0.009)
  const thumbRoot = new THREE.Quaternion()
    .setFromAxisAngle(Y_AXIS, 0.55)
    .multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -0.62))
    .multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, -0.28))
  addFinger(thumbKnuckle, thumbRoot, 0.081, 0.0136, 0.0099, 0.34, 0, 0.86)

  const body = mergeGeometries(bodyParts, false) ?? bodyParts[0]
  const nails = mergeGeometries(nailParts, false) ?? nailParts[0]
  return { body, nails }
}

/**
 * Mirror for the other hand. A -1 scale flips triangle winding *and* inverts the
 * authored normals, so both have to be corrected or the hand renders black.
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

  const normal = out.getAttribute('normal')
  for (let i = 0; i < normal.count; i++) normal.setX(i, -normal.getX(i))
  normal.needsUpdate = true

  const uv = out.getAttribute('uv')
  if (uv) {
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i))
    uv.needsUpdate = true
  }

  return out
}

export function createHandPair(mats: SkinMaterials) {
  const right = handGeometry()
  const left: HandParts = { body: mirrorX(right.body), nails: mirrorX(right.nails) }

  const build = (parts: HandParts) => {
    const group = new THREE.Group()
    group.add(new THREE.Mesh(parts.body, mats.skin))
    group.add(new THREE.Mesh(parts.nails, mats.nail))
    // Palm faces +Z locally; a little extension points it along the pull
    group.rotation.x = -0.1
    return group
  }

  return { right: build(right), left: build(left) }
}
