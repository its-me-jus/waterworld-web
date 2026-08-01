import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { fbm, noise2 } from './waves'

/**
 * A volcanic island, far enough out that it's a smudge you either notice or
 * don't — there is no marker pointing at it. Reaching it is a decision the
 * ocean makes expensive.
 *
 * The terrain is one deterministic height function. The mesh is sampled from
 * it and so is collision, so the ground you bump into is the ground you see,
 * and a future walk mode gets its floor for free.
 */

export type IslandOptions = {
  x: number
  z: number
  lowPower?: boolean
  /** Distant land takes the colour of the air between you and it. */
  hazeColor: THREE.Color
}

export type Island = {
  group: THREE.Group
  centre: THREE.Vector3
  /** World ground height. Deep negative once you're off the shelf. */
  heightAt: (x: number, z: number) => number
  /** Keeps the swimmer out of the rock and lets them wade up the beach. */
  resolve: (p: { x: number; y: number; z: number }) => void
  /** Beach-level world positions, for anything that wants to sit on the sand. */
  shore: THREE.Vector3[]
  /**
   * Rain caught in rock hollows above the beach. This is the one thing the
   * island has that the ocean and the wreck cannot give you at all: water that
   * keeps coming back. It's what turns landfall into somewhere you could stay.
   */
  pools: THREE.Vector3[]
  update: (camera: THREE.Camera, underwater: boolean) => void
  /** Keep aerial perspective matched to the live horizon. */
  setHaze: (color: THREE.Color) => void
}

/** Half-width of the terrain patch — well past the shelf, into deep water. */
const SPAN = 640
const PEAK = 190
/** How far the cones are pushed under, which is what carves the coastline. */
const SEA_CUT = 22

function cone(lx: number, lz: number, cx: number, cz: number, radius: number, height: number, sharp: number) {
  const d = Math.hypot(lx - cx, lz - cz) / radius
  if (d >= 1) return 0
  return height * Math.pow(1 - d, sharp)
}

/**
 * Ridges and gullies. Deliberately built from octaves the mesh can resolve —
 * the shared wave `fbm` runs up to eight times its base frequency, which lands
 * under one grid cell here and shows up as faceted banding across the slopes.
 */
function relief(lx: number, lz: number) {
  return (
    (noise2(lx * 0.0042 + 31.7, lz * 0.0042 - 12.3) - 0.5) * 1.0 +
    (noise2(lx * 0.011 - 4.1, lz * 0.011 + 7.9) - 0.5) * 0.46 +
    (noise2(lx * 0.026 + 17.3, lz * 0.026 + 2.4) - 0.5) * 0.2
  )
}

/** Height above mean sea level, in island-local coordinates. */
function ground(lx: number, lz: number) {
  let h =
    cone(lx, lz, 0, 0, 330, PEAK, 1.45) +
    cone(lx, lz, 180, -104, 190, 76, 1.4) +
    cone(lx, lz, -142, 124, 172, 52, 1.4) +
    cone(lx, lz, 64, 208, 124, 26, 1.35)

  h *= 1 + relief(lx, lz) * 1.15
  h -= SEA_CUT
  // The last few metres either side of the waterline flatten into beach and
  // shallows, instead of the cone driving straight into the sea
  h *= 0.22 + 0.78 * THREE.MathUtils.smoothstep(Math.abs(h), 3, 40)
  // Then fall away into deep water so the patch edge isn't a bathtub rim
  h -= THREE.MathUtils.smoothstep(Math.hypot(lx, lz), 330, 620) * 30
  return h
}

/**
 * Standard shading plus two things three's fog can't do here:
 *
 * - Aerial perspective that *saturates* below 1. Scene fog would erase the
 *   island completely at this range; real distance leaves a silhouette.
 * - Dropping the underwater flanks when they're far away. The ocean mesh only
 *   reaches ~350 m, so without this the island's shelf hangs below the horizon
 *   with nothing but sky behind it.
 *
 * `hazeColor` must already be sRGB-encoded: the mix runs after three's
 * colour-space conversion so that full haze lands exactly on the background.
 */
function hazeMaterial(hazeColor: THREE.Color, params: THREE.MeshStandardMaterialParameters) {
  const material = new THREE.MeshStandardMaterial({ ...params, fog: false })

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHaze = { value: hazeColor }
    shader.uniforms.uHazeDensity = { value: 0.0016 }
    shader.uniforms.uHazeMax = { value: 0.88 }

    shader.vertexShader = `varying vec3 vGroundPos;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
    )

    shader.fragmentShader = `
      uniform vec3 uHaze;
      uniform float uHazeDensity;
      uniform float uHazeMax;
      varying vec3 vGroundPos;
      ${shader.fragmentShader}
    `.replace(
      // Sits after the colour-space conversion, so it mixes toward the horizon
      // in the same encoding the background is drawn in.
      '#include <fog_fragment>',
      `float hazeDist = length(vGroundPos - cameraPosition);
      if (smoothstep(0.0, -6.0, vGroundPos.y) * smoothstep(300.0, 470.0, hazeDist) > 0.45) discard;
      float haze = min(1.0 - exp(-pow(hazeDist * uHazeDensity, 2.0)), uHazeMax);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, haze);`,
    )
  }

  return material
}

/** One palm: a leaning trunk, a crown of drooping blades, a few nuts. */
function palm(seed: number) {
  const rand = (n: number) => fbm(seed * 13.7 + n * 4.3, seed * 7.1 - n * 2.9)
  const height = 6.5 + rand(1) * 5
  const lean = (rand(2) - 0.5) * 3.4
  const facing = rand(3) * Math.PI * 2

  const trunk = new THREE.CylinderGeometry(0.16, 0.34, height, 6, 4)
  const pos = trunk.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + height / 2) / height
    pos.setX(i, pos.getX(i) + t * t * lean)
  }
  trunk.translate(0, height / 2, 0)
  trunk.rotateY(facing)
  trunk.computeVertexNormals()

  const crown = new THREE.Vector3(Math.cos(facing) * lean, height, -Math.sin(facing) * lean)
  const leaves: THREE.BufferGeometry[] = []
  const blades = 8
  for (let i = 0; i < blades; i++) {
    const blade = new THREE.ConeGeometry(0.4, 2.8 + rand(i) * 1.1, 3)
    blade.translate(0, 1.5, 0)
    blade.scale(1, 1, 0.26)
    const tilt = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      0.75 + rand(i + 9) * 0.75,
    )
    const spin = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      facing + (i / blades) * Math.PI * 2,
    )
    blade.applyMatrix4(
      new THREE.Matrix4().compose(crown, spin.multiply(tilt), new THREE.Vector3(1, 1, 1)),
    )
    leaves.push(blade)
  }

  const nuts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 3; i++) {
    const nut = new THREE.IcosahedronGeometry(0.19, 0)
    nut.translate(
      crown.x + Math.cos(i * 2.1 + facing) * 0.28,
      crown.y - 0.35,
      crown.z + Math.sin(i * 2.1 + facing) * 0.28,
    )
    nuts.push(nut)
  }

  return { trunk, leaves, nuts }
}

/** A weathered beach rock — lumpy icosahedron, never quite round. */
function rockChunk(seed: number) {
  const rand = (n: number) => fbm(seed * 9.1 + n * 3.7, seed * 5.3 - n * 1.8)
  const geo = new THREE.IcosahedronGeometry(1.1 + rand(1) * 1.6, 0)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const s = 0.7 + rand(i + 2) * 0.7
    pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * (0.55 + rand(i + 5) * 0.5), pos.getZ(i) * s)
  }
  geo.computeVertexNormals()
  geo.rotateY(rand(8) * Math.PI * 2)
  geo.rotateX((rand(9) - 0.5) * 0.6)
  return geo
}

/** A bleached plank or log washed up on the sand. */
function driftwood(seed: number) {
  const rand = (n: number) => fbm(seed * 11.3 + n * 2.4, seed * 4.7 - n * 6.1)
  const len = 2.2 + rand(1) * 3.4
  const geo = new THREE.CylinderGeometry(0.1 + rand(2) * 0.12, 0.14 + rand(3) * 0.14, len, 5, 1)
  geo.rotateZ(Math.PI / 2)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, pos.getY(i) + Math.sin(pos.getX(i) * 2.2) * 0.08)
  }
  geo.computeVertexNormals()
  geo.rotateY(rand(4) * Math.PI * 2)
  geo.rotateX((rand(5) - 0.5) * 0.25)
  return geo
}

/** Low dune scrub — a clump of bent cones that reads as bush from a few metres. */
function scrubBush(seed: number) {
  const rand = (n: number) => fbm(seed * 6.8 + n * 5.1, seed * 3.2 - n * 2.7)
  const parts: THREE.BufferGeometry[] = []
  const clumps = 4 + Math.floor(rand(1) * 3)
  for (let i = 0; i < clumps; i++) {
    const h = 1.1 + rand(i + 2) * 1.4
    const cone = new THREE.ConeGeometry(0.55 + rand(i + 4) * 0.65, h, 5)
    cone.translate(
      (rand(i + 6) - 0.5) * 1.2,
      h * 0.45,
      (rand(i + 7) - 0.5) * 1.2,
    )
    cone.rotateY(rand(i + 8) * Math.PI * 2)
    cone.rotateZ((rand(i + 9) - 0.5) * 0.35)
    parts.push(cone)
  }
  return mergeGeometries(parts, false) as THREE.BufferGeometry
}

export function createIsland(scene: THREE.Scene, opts: IslandOptions): Island {
  const low = opts.lowPower ?? false
  const haze = opts.hazeColor.clone().convertLinearToSRGB()
  const group = new THREE.Group()
  group.name = 'Island'
  group.position.set(opts.x, 0, opts.z)
  scene.add(group)

  // —— terrain ————————————————————————————————————————————————
  const segments = low ? 120 : 184
  const step = (SPAN * 2) / segments

  /**
   * The height the island is actually *drawn* at.
   *
   * The mesh only samples `ground` every few metres, so between grid lines the
   * rendered surface and the analytic function disagree by up to a metre on a
   * steep slope. Anything that trusts the function instead of the mesh — feet,
   * planted props, a pool of rainwater — ends up floating or buried. So both
   * the collider and the planting interpolate the same corners the mesh used.
   */
  function surface(lx: number, lz: number) {
    const gx = (lx + SPAN) / step
    const gz = (lz + SPAN) / step
    const i = Math.floor(gx)
    const j = Math.floor(gz)
    const fx = gx - i
    const fz = gz - j
    const x0 = -SPAN + i * step
    const z0 = -SPAN + j * step
    const h00 = ground(x0, z0)
    const h10 = ground(x0 + step, z0)
    const h01 = ground(x0, z0 + step)
    const h11 = ground(x0 + step, z0 + step)
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz
  }

  const heightAt = (x: number, z: number) => surface(x - opts.x, z - opts.z)

  const geometry = new THREE.PlaneGeometry(SPAN * 2, SPAN * 2, segments, segments)
  geometry.rotateX(-Math.PI / 2)

  const position = geometry.attributes.position
  for (let i = 0; i < position.count; i++) {
    position.setY(i, ground(position.getX(i), position.getZ(i)))
  }
  geometry.computeVertexNormals()

  // Sand, scrub and basalt painted per vertex — one material, one draw call
  const normal = geometry.attributes.normal
  const seabed = new THREE.Color('#5c6a5b')
  const tide = new THREE.Color('#7a6a4e')
  const wetSand = new THREE.Color('#a8946e')
  const drySand = new THREE.Color('#ddcaa4')
  const scrub = new THREE.Color('#5c7f42')
  const bush = new THREE.Color('#3f6135')
  const rock = new THREE.Color('#79705f')
  const basalt = new THREE.Color('#4e453d')
  const shade = new THREE.Color()
  const growth = new THREE.Color()
  const stone = new THREE.Color()
  const colors = new Float32Array(position.count * 3)

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i)
    const y = position.getY(i)
    const z = position.getZ(i)
    const mottle = fbm(x * 0.02 + 2.3, z * 0.02 - 5.1)
    const grit = fbm(x * 0.09 - 1.4, z * 0.09 + 3.7)

    // Underwater shelf → wet sand → dry beach. The tide band sits right at the
    // waterline so the beach reads as recently washed, not one flat tan.
    shade.copy(seabed).lerp(wetSand, THREE.MathUtils.smoothstep(y, -9, -0.6))
    const wetBand =
      THREE.MathUtils.smoothstep(y, -1.1, 0.2) * (1 - THREE.MathUtils.smoothstep(y, 0.5, 2.6))
    shade.lerp(tide, wetBand * (0.55 + grit * 0.35))
    shade.lerp(drySand, THREE.MathUtils.smoothstep(y, 1.0, 5.2))
    // Fine grit on the sand — breaks the painted-plane look up close
    const onSand = THREE.MathUtils.smoothstep(y, -2, 1) * (1 - THREE.MathUtils.smoothstep(y, 6, 14))
    shade.multiplyScalar(1 + (grit - 0.5) * 0.22 * onSand)

    growth.copy(scrub).lerp(bush, mottle)
    shade.lerp(growth, THREE.MathUtils.smoothstep(y, 4, 15))
    // Steep faces shed soil — bare rock on the cliffs and up around the crater.
    // MathUtils.smoothstep has no inverted range, so the slope ramp is flipped
    // by hand rather than passing min > max (which silently returns 1).
    stone.copy(rock).lerp(basalt, mottle)
    shade.lerp(
      stone,
      Math.max(
        THREE.MathUtils.smoothstep(y, 118, 182),
        1 - THREE.MathUtils.smoothstep(normal.getY(i), 0.36, 0.62),
      ),
    )
    shade.multiplyScalar(0.92 + mottle * 0.16)

    colors[i * 3] = shade.r
    colors[i * 3 + 1] = shade.g
    colors[i * 3 + 2] = shade.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  // Standard shading has no skylight, and the air hemisphere's ground colour is
  // near-black for the water. Without a small lift, whichever face of the
  // island you approach from crushes to a silhouette the moment it's not sunlit.
  const skylight = { emissive: new THREE.Color('#20313a'), emissiveIntensity: 0.5 }

  const terrain = new THREE.Mesh(
    geometry,
    hazeMaterial(haze, { vertexColors: true, roughness: 0.98, metalness: 0, ...skylight }),
  )
  group.add(terrain)

  // —— shoreline planting ————————————————————————————————————
  const shore: THREE.Vector3[] = []
  const trunks: THREE.BufferGeometry[] = []
  const leaves: THREE.BufferGeometry[] = []
  const nuts: THREE.BufferGeometry[] = []
  const rocks: THREE.BufferGeometry[] = []
  const wood: THREE.BufferGeometry[] = []
  const scrubParts: THREE.BufferGeometry[] = []

  const palmWanted = low ? 12 : 24
  const rockWanted = low ? 40 : 80
  const woodWanted = low ? 14 : 28
  const scrubWanted = low ? 45 : 90

  const placeAt = (geo: THREE.BufferGeometry, lx: number, h: number, lz: number, sink = 0.15) => {
    const m = new THREE.Matrix4().setPosition(lx, h - sink, lz)
    return geo.applyMatrix4(m)
  }

  // Palms — clustered a bit so the beach has groves, not a picket fence
  for (let i = 0; i < 800 && trunks.length < palmWanted; i++) {
    const angle = i * 2.399
    const radius = 160 + ((i * 13) % 200)
    // Pull every third candidate toward the previous successful plant for clusters
    const cluster = trunks.length > 0 && i % 3 === 0
    const prev = cluster ? shore[shore.length - 1] : null
    const lx = prev
      ? prev.x - opts.x + (fbm(i, 1.1) - 0.5) * 18
      : Math.cos(angle) * radius
    const lz = prev
      ? prev.z - opts.z + (fbm(i, 2.2) - 0.5) * 18
      : Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 2.4 || h > 13) continue
    // Palms want flat ground, not a cliff face
    const slope = Math.abs(surface(lx + 7, lz) - h) + Math.abs(surface(lx, lz + 7) - h)
    if (slope > 4.5) continue

    const at = new THREE.Vector3(lx, h - 0.3, lz)
    const tree = palm(i + 1)
    const place = new THREE.Matrix4().setPosition(at)
    trunks.push(tree.trunk.applyMatrix4(place))
    for (const blade of tree.leaves) leaves.push(blade.applyMatrix4(place))
    for (const nut of tree.nuts) nuts.push(nut.applyMatrix4(place))
    shore.push(new THREE.Vector3(opts.x + lx, h, opts.z + lz))
  }

  // Beach rocks — frame the waterline and break empty sand
  for (let i = 0; i < 900 && rocks.length < rockWanted; i++) {
    const angle = i * 2.193
    const radius = 200 + ((i * 17) % 220)
    const lx = Math.cos(angle) * radius
    const lz = Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 0.3 || h > 5.5) continue
    const slope = Math.abs(surface(lx + 4, lz) - h) + Math.abs(surface(lx, lz + 4) - h)
    if (slope > 3.5) continue
    // Skip if buried under a palm trunk
    if (shore.some((s) => Math.hypot(s.x - opts.x - lx, s.z - opts.z - lz) < 3.5)) continue
    rocks.push(placeAt(rockChunk(i + 40), lx, h, lz, 0.2 + (i % 5) * 0.04))
  }

  // Driftwood — mid-beach, sparse, sells the wash-up
  for (let i = 0; i < 700 && wood.length < woodWanted; i++) {
    const angle = i * 2.618
    const radius = 210 + ((i * 23) % 180)
    const lx = Math.cos(angle) * radius
    const lz = Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 0.8 || h > 4.5) continue
    const slope = Math.abs(surface(lx + 5, lz) - h) + Math.abs(surface(lx, lz + 5) - h)
    if (slope > 2.8) continue
    wood.push(placeAt(driftwood(i + 90), lx, h, lz, 0.08))
  }

  // Dune scrub — sits where sand turns green, softens the colour cliff
  for (let i = 0; i < 1100 && scrubParts.length < scrubWanted; i++) {
    const angle = i * 2.071
    const radius = 150 + ((i * 19) % 230)
    const lx = Math.cos(angle) * radius
    const lz = Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 3.8 || h > 16) continue
    const slope = Math.abs(surface(lx + 6, lz) - h) + Math.abs(surface(lx, lz + 6) - h)
    if (slope > 5.5) continue
    scrubParts.push(placeAt(scrubBush(i + 120), lx, h, lz, 0.05))
  }

  if (trunks.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(trunks, false) as THREE.BufferGeometry,
        hazeMaterial(haze, { color: 0x6b563c, roughness: 0.95, ...skylight }),
      ),
    )
    group.add(
      new THREE.Mesh(
        mergeGeometries(leaves, false) as THREE.BufferGeometry,
        hazeMaterial(haze, {
          color: 0x5f8a3e,
          roughness: 0.85,
          side: THREE.DoubleSide,
          ...skylight,
        }),
      ),
    )
    group.add(
      new THREE.Mesh(
        mergeGeometries(nuts, false) as THREE.BufferGeometry,
        hazeMaterial(haze, { color: 0x6d5334, roughness: 1 }),
      ),
    )
  }

  if (rocks.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(rocks, false) as THREE.BufferGeometry,
        hazeMaterial(haze, { color: 0x6e6758, roughness: 0.97, ...skylight }),
      ),
    )
  }

  if (wood.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(wood, false) as THREE.BufferGeometry,
        hazeMaterial(haze, { color: 0x8a7355, roughness: 1, ...skylight }),
      ),
    )
  }

  if (scrubParts.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(scrubParts, false) as THREE.BufferGeometry,
        hazeMaterial(haze, {
          color: 0x3d5c2e,
          roughness: 0.92,
          side: THREE.DoubleSide,
          ...skylight,
        }),
      ),
    )
  }

  // —— rain catchment ————————————————————————————————————————
  // Basalt holds water. A few hollows up off the sand stay full between
  // squalls, and finding one is the difference between a night ashore and a
  // week of them. Placed on flattish ground well above the wash, so a storm
  // sea can't salt them.
  const pools: THREE.Vector3[] = []
  {
    // Standing water with nothing to reflect renders as a hole in the ground,
    // so this leans on an emissive sky term rather than a mirror finish.
    const poolWater = new THREE.MeshStandardMaterial({
      color: 0x3f757b,
      roughness: 0.28,
      metalness: 0.05,
      emissive: 0x27505a,
      emissiveIntensity: 0.85,
      transparent: true,
      opacity: 0.92,
    })
    const rimMaterial = hazeMaterial(haze, { color: 0x6e6656, roughness: 0.95, ...skylight })

    // Still water is level water: on any real slope a disc of it saws straight
    // through the hillside. So every candidate is scored for flatness and only
    // the flattest few are used, rather than the first ones that happen to fit.
    const candidates: { lx: number; lz: number; h: number; slope: number }[] = []
    for (let i = 0; i < 900; i++) {
      const angle = i * 2.399 + 0.83
      const radius = 100 + ((i * 19) % 210)
      const lx = Math.cos(angle) * radius
      const lz = Math.sin(angle) * radius
      const h = surface(lx, lz)
      if (h < 7 || h > 26) continue
      const slope =
        Math.abs(surface(lx + 4, lz) - h) +
        Math.abs(surface(lx - 4, lz) - h) +
        Math.abs(surface(lx, lz + 4) - h) +
        Math.abs(surface(lx, lz - 4) - h)
      candidates.push({ lx, lz, h, slope })
    }
    candidates.sort((a, b) => a.slope - b.slope)

    for (const spot of candidates) {
      if (pools.length >= 3) break
      const { lx, lz, h } = spot
      // Keep them apart, so finding one isn't finding all of them
      if (pools.some((p) => Math.hypot(p.x - (opts.x + lx), p.z - (opts.z + lz)) < 90)) continue

      const size = 1.5 + (pools.length % 3) * 0.35
      // The rim is set low enough that the water sits proud of it, or the
      // basin's inner wall hides the pool from anyone standing over it
      const rim = new THREE.Mesh(new THREE.TorusGeometry(size, 0.42, 6, 16), rimMaterial)
      rim.rotation.x = Math.PI / 2
      rim.scale.y = 0.55
      rim.position.set(lx, h - 0.2, lz)
      group.add(rim)

      // Water stops inside the ring, so the stone lip frames it and hides
      // where a flat disc and a not-quite-flat hillside disagree
      const water = new THREE.Mesh(new THREE.CircleGeometry(size - 0.2, 20), poolWater)
      water.rotation.x = -Math.PI / 2
      water.position.set(lx, h + 0.02, lz)
      group.add(water)

      pools.push(new THREE.Vector3(opts.x + lx, h, opts.z + lz))
    }
  }

  // —— collision ————————————————————————————————————————————
  function resolve(p: { x: number; y: number; z: number }) {
    const lx = p.x - opts.x
    const lz = p.z - opts.z
    if (Math.abs(lx) > SPAN || Math.abs(lz) > SPAN) return
    const h = surface(lx, lz)
    if (h < -40) return
    // Eye height above the sand. The swim controller still owns the body here,
    // so wading is approximate until there's a real walk mode to take over.
    if (p.y < h + 1.45) p.y = h + 1.45
  }

  const centre = new THREE.Vector3(opts.x, 0, opts.z)

  function update(camera: THREE.Camera, underwater: boolean) {
    // Nothing is visible 700 m through water. Close in it's the shelf you dive,
    // so keep it once the island is the thing you're swimming around.
    group.visible = !underwater || camera.position.distanceToSquared(centre) < 420 * 420
  }

  /** Keep aerial perspective matched to the live horizon as day and storms move. */
  function setHaze(color: THREE.Color) {
    haze.copy(color).convertLinearToSRGB()
  }

  return { group, centre, heightAt, resolve, shore, pools, update, setHaze }
}
