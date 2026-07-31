import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'

/**
 * Gorgeous first-person hands — anatomical skinned mesh with dual-scale PBR
 * skin (Emma Lieker, CC BY-NC 4.0). Always on screen, so they get the good stuff:
 * real topology, nails, wet clearcoat driven by how deep you've dived.
 */

export type SkinMaterials = {
  skins: THREE.MeshPhysicalMaterial[]
  nails: THREE.MeshPhysicalMaterial[]
  setWetness: (wet: number) => void
}

type HandPair = {
  right: THREE.Group
  left: THREE.Group
  mats: SkinMaterials
}

/** @deprecated kept for reference — bone curls melt this particular bind. */
void 0

function upgradeSkin(mat: THREE.MeshStandardMaterial) {
  const phys = new THREE.MeshPhysicalMaterial()
  THREE.MeshStandardMaterial.prototype.copy.call(phys, mat)
  // COLOR_0/1 are dual-scale blend weights from Blender — useful, but they also
  // crush albedo under ACES, so keep them gentle via a lighter base color.
  phys.vertexColors = true
  phys.color = new THREE.Color(0xffffff)
  phys.sheen = 0.65
  phys.sheenRoughness = 0.7
  phys.sheenColor = new THREE.Color(0xd08060)
  phys.clearcoat = 0.08
  phys.clearcoatRoughness = 0.55
  phys.roughness = Math.max(0.45, Math.min(0.7, mat.roughness ?? 0.55))
  phys.metalness = 0
  phys.envMapIntensity = 0.55
  phys.side = THREE.FrontSide
  if (phys.map) {
    phys.map.colorSpace = THREE.SRGBColorSpace
    phys.map.anisotropy = 8
  }
  if (phys.normalMap) phys.normalMap.anisotropy = 8
  if (phys.normalScale) phys.normalScale.set(0.85, 0.85)
  phys.needsUpdate = true
  phys.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;',
      /* glsl */ `
      vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
      // Soft subsurface fill so finger creases don't go to black
      vec3 sss = totalDiffuse * vec3(1.15, 0.78, 0.65) + vec3(0.04, 0.012, 0.008);
      totalDiffuse = mix(totalDiffuse, max(totalDiffuse, sss), 0.55);
      `,
    )
  }
  return phys
}

function upgradeNail(mat: THREE.MeshStandardMaterial) {
  const phys = new THREE.MeshPhysicalMaterial()
  THREE.MeshStandardMaterial.prototype.copy.call(phys, mat)
  phys.clearcoat = 1
  phys.clearcoatRoughness = 0.08
  phys.roughness = Math.min(0.22, mat.roughness ?? 0.18)
  phys.metalness = 0.05
  phys.sheen = 0.35
  phys.sheenColor = new THREE.Color(0xffd0c8)
  phys.side = THREE.FrontSide
  phys.needsUpdate = true
  return phys
}

/**
 * Fit the anatomical hand onto our wrist joint: origin at the wrist, fingers
 * along -Y, palm facing roughly +Z.
 */
function mountHand(source: THREE.Object3D, side: 'left' | 'right') {
  const model = cloneSkeleton(source)
  model.updateMatrixWorld(true)

  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const longest = Math.max(size.x, size.y, size.z) || 1
  const scale = 0.2 / longest

  const wrap = new THREE.Group()
  const pivot = new THREE.Group()
  wrap.add(pivot)
  pivot.add(model)
  model.scale.setScalar(scale)

  // Center the scaled mesh, then shift so the proximal stump sits past the origin
  // (into the forearm). Asset +Y = fingertips.
  model.updateMatrixWorld(true)
  const b = new THREE.Box3().setFromObject(model)
  const c = b.getCenter(new THREE.Vector3())
  pivot.worldToLocal(c)
  model.position.sub(c)
  // Proximal end is ~half-height below center in asset space; push that past 0
  // and a bit further so the cut edge hides inside the capsule.
  model.position.y += size.y * scale * 0.42

  // Flip upright asset so fingers hang along -Y. After this, the stump (which
  // we pushed to +Y in pivot space) lands on wrap -Y… wait, rotation flips it.
  // So bury with a wrap-space nudge after rotating.
  pivot.rotation.order = 'YXZ'
  pivot.rotation.x = Math.PI
  pivot.rotation.y = side === 'right' ? 0.35 : -0.35
  pivot.rotation.z = side === 'right' ? -0.2 : 0.2

  // Elbow is wrap +Y (arm hangs along -Y). Nudge the whole pivot that way.
  pivot.position.y += 0.1

  if (side === 'left') {
    wrap.scale.x = -1
    wrap.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if (m) m.side = THREE.DoubleSide
      }
    })
  }

  wrap.rotation.x = -0.12
  return wrap
}

function collectMats(
  root: THREE.Object3D,
  skins: THREE.MeshPhysicalMaterial[],
  nails: THREE.MeshPhysicalMaterial[],
) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const name = `${mesh.name} ${((mesh.material as THREE.Material)?.name ?? '')}`.toLowerCase()
    const src = mesh.material as THREE.MeshStandardMaterial
    if (!src || !src.isMeshStandardMaterial) return
    if (name.includes('nail')) {
      const m = upgradeNail(src)
      mesh.material = m
      nails.push(m)
    } else {
      const m = upgradeSkin(src)
      mesh.material = m
      skins.push(m)
    }
    mesh.frustumCulled = false
  })
}

let cachedGltf: THREE.Group | null = null

async function loadHandSource(): Promise<THREE.Group> {
  if (cachedGltf) return cachedGltf
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync('/hands/hand.glb')
  cachedGltf = gltf.scene
  return cachedGltf
}

export async function createHandPair(): Promise<HandPair> {
  const source = await loadHandSource()
  const skins: THREE.MeshPhysicalMaterial[] = []
  const nails: THREE.MeshPhysicalMaterial[] = []

  const right = mountHand(source, 'right')
  const left = mountHand(source, 'left')
  collectMats(right, skins, nails)
  collectMats(left, skins, nails)

  const baseClearcoat = skins[0]?.clearcoat ?? 0.08
  const baseClearRough = skins[0]?.clearcoatRoughness ?? 0.55
  const baseRough = skins[0]?.roughness ?? 0.55

  function setWetness(wet: number) {
    const w = THREE.MathUtils.clamp(wet, 0, 1)
    for (const s of skins) {
      s.clearcoat = baseClearcoat + w * 0.55
      s.clearcoatRoughness = baseClearRough - w * 0.35
      s.roughness = baseRough - w * 0.2
      s.sheen = 0.65 - w * 0.15
      s.envMapIntensity = 0.55 + w * 0.35
    }
    for (const n of nails) {
      n.clearcoat = 0.85 + w * 0.15
      n.roughness = Math.max(0.05, 0.18 - w * 0.1)
    }
  }

  return { right, left, mats: { skins, nails, setWetness } }
}
