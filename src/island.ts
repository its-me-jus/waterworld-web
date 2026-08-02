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
  /**
   * One inland rock stack — someone marked a place. No marker pointing at it;
   * you find it by walking the green band. Null only if the terrain couldn't
   * host one (shouldn't happen on the stock island).
   */
  cairn: THREE.Vector3 | null
  /**
   * Shore crabs that scuttle the wet sand. Grab one when you're close enough —
   * same rule as fish and shellfish, nothing points at them.
   */
  crabs: {
    nearest: (point: THREE.Vector3, maxDist: number) => { index: number; dist: number } | null
    positionAt: (index: number, out: THREE.Vector3) => THREE.Vector3
    /** Hide and eat; the shell comes back later. */
    take: (index: number) => boolean
  }
  update: (camera: THREE.Camera, underwater: boolean, time?: number) => void
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

/**
 * Spawn sits near the world origin; the island centre is ~1.2 km off that
 * heading's right shoulder. The cove is the soft beach you actually swim onto
 * — without it the approach face is a cliff that sheds every palm.
 */
const COVE_X = -205
const COVE_Z = 148

/** Height above mean sea level, in island-local coordinates. */
function ground(lx: number, lz: number) {
  let h =
    cone(lx, lz, 0, 0, 330, PEAK, 1.45) +
    cone(lx, lz, 180, -104, 190, 76, 1.4) +
    cone(lx, lz, -142, 124, 172, 52, 1.4) +
    cone(lx, lz, 64, 208, 124, 26, 1.35) +
    // Broad low shoulder toward the approach, so the cove has something to carve
    cone(lx, lz, COVE_X * 0.85, COVE_Z * 0.85, 175, 22, 1.15)

  h *= 1 + relief(lx, lz) * 1.15
  // Micro-relief: root flares and hummocks under the green band so the ground
  // isn't a smooth plane once the grass and trees are in
  const greenBand = THREE.MathUtils.smoothstep(h, 3, 14) * (1 - THREE.MathUtils.smoothstep(h, 40, 90))
  h += (noise2(lx * 0.09 + 5.5, lz * 0.09 - 3.3) - 0.5) * 1.1 * greenBand
  // A second octave of hummocks higher up — breaks the painted-cone silhouette
  // from the water before you're close enough to see individual trees
  const midBand = THREE.MathUtils.smoothstep(h, 12, 28) * (1 - THREE.MathUtils.smoothstep(h, 70, 110))
  h += (noise2(lx * 0.018 + 9.1, lz * 0.018 - 6.4) - 0.5) * 4.2 * midBand
  h -= SEA_CUT
  // The last few metres either side of the waterline flatten into beach and
  // shallows, instead of the cone driving straight into the sea
  h *= 0.22 + 0.78 * THREE.MathUtils.smoothstep(Math.abs(h), 3, 40)
  // Landing cove: pull the spawn-facing shore onto a wadable shelf so landfall
  // is a beach with palms, not a cliff that rejects every plant.
  // (smoothstep needs min < max — an inverted range silently returns 1.)
  {
    const d = Math.hypot(lx - COVE_X, lz - COVE_Z)
    const cove = 1 - THREE.MathUtils.smoothstep(d, 20, 175)
    if (cove > 0) {
      // Keep the shelf low enough that sand still reads as sand underfoot
      const beach = 2.4 + relief(lx, lz) * 1.6
      if (h > beach) h = THREE.MathUtils.lerp(h, beach, cove * 0.88)
      else if (h < 0.4) h = THREE.MathUtils.lerp(h, Math.min(beach * 0.55, 1.6), cove * 0.65)
    }
  }
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

/**
 * A broadleaf mid-story tree: short trunk, a few lumpy canopy blobs. This is
 * the layer that turns "beach with palms" into "overgrown interior" — it
 * fills the silhouette between the palm crowns and the ground.
 */
function broadleaf(seed: number) {
  const rand = (n: number) => fbm(seed * 8.3 + n * 3.1, seed * 5.7 - n * 2.3)
  const height = 3.8 + rand(1) * 3.2
  const trunk = new THREE.CylinderGeometry(0.16, 0.3, height, 5, 2)
  trunk.translate(0, height / 2, 0)
  trunk.rotateY(rand(2) * Math.PI * 2)
  trunk.rotateZ((rand(3) - 0.5) * 0.22)

  const canopy: THREE.BufferGeometry[] = []
  const blobs = 3 + Math.floor(rand(4) * 2)
  for (let i = 0; i < blobs; i++) {
    const r = 1.5 + rand(i + 5) * 1.7
    const blob = new THREE.IcosahedronGeometry(r, 0)
    const pos = blob.attributes.position
    for (let v = 0; v < pos.count; v++) {
      const s = 0.82 + rand(i * 31 + v) * 0.36
      pos.setXYZ(v, pos.getX(v) * s, pos.getY(v) * s * 0.82, pos.getZ(v) * s)
    }
    blob.computeVertexNormals()
    blob.translate(
      (rand(i + 9) - 0.5) * 3.0,
      height + (rand(i + 11) - 0.5) * 1.6,
      (rand(i + 13) - 0.5) * 3.0,
    )
    canopy.push(blob)
  }

  return { trunk, canopy }
}

/** A hanging vine — a drooping strip of quads down a rock face or trunk. */
function vine(seed: number) {
  const rand = (n: number) => fbm(seed * 6.3 + n * 2.9, seed * 3.7 - n * 1.4)
  const len = 1.6 + rand(1) * 2.8
  const geo = new THREE.PlaneGeometry(0.22 + rand(2) * 0.2, len, 1, 4)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + len / 2) / len // 0 bottom → 1 top
    // Droop outward as it hangs, slight S-curve
    pos.setZ(i, pos.getZ(i) + (1 - t) * (1 - t) * (0.3 + rand(3) * 0.5))
    pos.setX(i, pos.getX(i) + Math.sin(t * 4 + rand(4) * 6) * 0.12)
  }
  geo.translate(0, -len / 2, 0) // hang from the anchor point
  geo.rotateY(rand(5) * Math.PI * 2)
  geo.computeVertexNormals()
  return geo
}

/** A bleached dead trunk — a snag that sells "this island has weather". */
function deadTree(seed: number) {
  const rand = (n: number) => fbm(seed * 7.7 + n * 3.9, seed * 4.1 - n * 2.2)
  const height = 2.6 + rand(1) * 3.4
  const geo = new THREE.CylinderGeometry(0.09, 0.24, height, 5, 3)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + height / 2) / height
    pos.setX(i, pos.getX(i) + t * t * (rand(2) - 0.5) * 2.2)
  }
  geo.translate(0, height / 2, 0)
  geo.rotateY(rand(3) * Math.PI * 2)
  geo.rotateZ((rand(4) - 0.5) * 0.5)
  geo.computeVertexNormals()
  return geo
}

/** A grass / fern tuft: a few bent blades as thin cones, merged. */
function grassTuft(seed: number) {
  const rand = (n: number) => fbm(seed * 5.9 + n * 2.7, seed * 3.3 - n * 1.9)
  const blades: THREE.BufferGeometry[] = []
  const count = 5 + Math.floor(rand(1) * 4)
  for (let i = 0; i < count; i++) {
    const h = 0.65 + rand(i + 2) * 1.15
    const blade = new THREE.ConeGeometry(0.07 + rand(i + 4) * 0.07, h, 3)
    blade.translate(0, h / 2, 0)
    blade.rotateZ((rand(i + 6) - 0.5) * 0.9)
    blade.rotateY(rand(i + 8) * Math.PI * 2)
    blade.translate((rand(i + 10) - 0.5) * 0.55, 0, (rand(i + 12) - 0.5) * 0.55)
    blades.push(blade)
  }
  return mergeGeometries(blades, false) as THREE.BufferGeometry
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

/** A fern — wider, drooping fronds that fill the understory between trees. */
function fernClump(seed: number) {
  const rand = (n: number) => fbm(seed * 4.7 + n * 2.1, seed * 6.2 - n * 3.4)
  const fronds: THREE.BufferGeometry[] = []
  const count = 5 + Math.floor(rand(1) * 4)
  for (let i = 0; i < count; i++) {
    const h = 0.7 + rand(i + 2) * 1.1
    const frond = new THREE.ConeGeometry(0.28 + rand(i + 4) * 0.22, h, 3)
    frond.translate(0, h / 2, 0)
    frond.scale(1, 1, 0.22)
    frond.rotateZ(0.55 + rand(i + 6) * 0.7)
    frond.rotateY(rand(i + 8) * Math.PI * 2)
    frond.translate((rand(i + 10) - 0.5) * 0.35, 0, (rand(i + 12) - 0.5) * 0.35)
    fronds.push(frond.toNonIndexed())
  }
  return mergeGeometries(fronds, false) as THREE.BufferGeometry
}

/** A fallen inland log — longer and darker than beach driftwood. */
function fallenLog(seed: number) {
  const rand = (n: number) => fbm(seed * 8.9 + n * 2.6, seed * 3.8 - n * 4.2)
  const len = 3.4 + rand(1) * 4.5
  const geo = new THREE.CylinderGeometry(0.16 + rand(2) * 0.14, 0.2 + rand(3) * 0.16, len, 6, 2)
  geo.rotateZ(Math.PI / 2)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, pos.getY(i) + Math.sin(pos.getX(i) * 1.4) * 0.12)
  }
  geo.computeVertexNormals()
  geo.rotateY(rand(4) * Math.PI * 2)
  geo.rotateX((rand(5) - 0.5) * 0.18)
  return geo
}

/** A larger boulder — breaks the smooth green slopes into something geological. */
function boulder(seed: number) {
  const rand = (n: number) => fbm(seed * 10.2 + n * 4.1, seed * 6.6 - n * 2.5)
  const geo = new THREE.IcosahedronGeometry(1.8 + rand(1) * 2.8, 0)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const s = 0.65 + rand(i + 2) * 0.75
    pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * (0.45 + rand(i + 5) * 0.45), pos.getZ(i) * s)
  }
  geo.computeVertexNormals()
  geo.rotateY(rand(8) * Math.PI * 2)
  geo.rotateX((rand(9) - 0.5) * 0.5)
  return geo
}

/** Tide wrack — a low mat of washed-up weed on the wet sand. */
function tideWrack(seed: number) {
  const rand = (n: number) => fbm(seed * 5.4 + n * 3.3, seed * 7.1 - n * 1.6)
  const parts: THREE.BufferGeometry[] = []
  const clumps = 3 + Math.floor(rand(1) * 4)
  for (let i = 0; i < clumps; i++) {
    const w = 0.5 + rand(i + 2) * 0.9
    const pad = new THREE.SphereGeometry(w * 0.5, 5, 3)
    pad.scale(1, 0.18 + rand(i + 4) * 0.12, 0.7 + rand(i + 5) * 0.4)
    pad.translate((rand(i + 6) - 0.5) * 1.4, 0.04, (rand(i + 7) - 0.5) * 1.4)
    pad.rotateY(rand(i + 8) * Math.PI * 2)
    parts.push(pad.toNonIndexed())
  }
  return mergeGeometries(parts, false) as THREE.BufferGeometry
}

/** Reeds / sea grass in the wet band — thin upright blades. */
function reedClump(seed: number) {
  const rand = (n: number) => fbm(seed * 6.1 + n * 2.4, seed * 4.5 - n * 3.1)
  const blades: THREE.BufferGeometry[] = []
  const count = 6 + Math.floor(rand(1) * 5)
  for (let i = 0; i < count; i++) {
    const h = 0.9 + rand(i + 2) * 1.4
    const blade = new THREE.ConeGeometry(0.035 + rand(i + 4) * 0.03, h, 3)
    blade.translate(0, h / 2, 0)
    blade.rotateZ((rand(i + 6) - 0.5) * 0.35)
    blade.rotateY(rand(i + 8) * Math.PI * 2)
    blade.translate((rand(i + 10) - 0.5) * 0.7, 0, (rand(i + 12) - 0.5) * 0.7)
    blades.push(blade.toNonIndexed())
  }
  return mergeGeometries(blades, false) as THREE.BufferGeometry
}

/** A young sapling — short trunk + canopy blob. Kept as two pieces so the
 *  trunk and leaf materials can stay distinct when merged into batches. */
function sapling(seed: number) {
  const rand = (n: number) => fbm(seed * 7.2 + n * 2.8, seed * 4.9 - n * 1.7)
  const height = 1.6 + rand(1) * 2.2
  const trunk = new THREE.CylinderGeometry(0.05, 0.1, height, 5, 1)
  trunk.translate(0, height / 2, 0)
  trunk.rotateY(rand(2) * Math.PI * 2)

  const canopy: THREE.BufferGeometry[] = []
  const blobs = 1 + Math.floor(rand(3) * 2)
  for (let i = 0; i < blobs; i++) {
    const r = 0.55 + rand(i + 4) * 0.7
    const blob = new THREE.IcosahedronGeometry(r, 0)
    const pos = blob.attributes.position
    for (let v = 0; v < pos.count; v++) {
      const s = 0.85 + rand(i * 17 + v) * 0.3
      pos.setXYZ(v, pos.getX(v) * s, pos.getY(v) * s * 0.9, pos.getZ(v) * s)
    }
    blob.computeVertexNormals()
    blob.translate(
      (rand(i + 5) - 0.5) * 0.5,
      height + (rand(i + 6) - 0.5) * 0.4,
      (rand(i + 7) - 0.5) * 0.5,
    )
    canopy.push(blob)
  }
  return { trunk, canopy }
}

/** A shore crab — flat body, sidling legs, two claws. Small enough to miss. */
function crabMesh(seed: number) {
  const rand = (n: number) => fbm(seed * 9.4 + n * 2.1, seed * 5.8 - n * 3.3)
  const scale = 0.75 + rand(1) * 0.55
  const group = new THREE.Group()
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 6, 4),
    new THREE.MeshStandardMaterial({ color: 0x8a4a32, roughness: 0.85 }),
  )
  shell.scale.set(1.35 * scale, 0.45 * scale, 1.1 * scale)
  shell.position.y = 0.05 * scale
  group.add(shell)

  const legMat = new THREE.MeshStandardMaterial({ color: 0x6e3a28, roughness: 0.9 })
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.01, 0.16 * scale, 3), legMat)
      leg.position.set(side * (0.1 + i * 0.02) * scale, 0.04 * scale, (i - 1) * 0.06 * scale)
      leg.rotation.z = side * (0.85 + i * 0.08)
      leg.rotation.x = (i - 1) * 0.25
      group.add(leg)
    }
    const claw = new THREE.Mesh(new THREE.BoxGeometry(0.05 * scale, 0.03 * scale, 0.07 * scale), legMat)
    claw.position.set(side * 0.14 * scale, 0.05 * scale, 0.1 * scale)
    claw.rotation.y = side * -0.4
    group.add(claw)
  }
  return group
}

/** A sunning lizard — long body, tiny legs, the rock's little tenant. */
function lizardMesh(seed: number) {
  const rand = (n: number) => fbm(seed * 6.6 + n * 3.4, seed * 4.2 - n * 2.1)
  const group = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: 0x5a6b3c, roughness: 0.88 })
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.14, 3, 5), mat)
  body.rotation.z = Math.PI / 2
  body.position.y = 0.03
  group.add(body)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.028, 5, 4), mat)
  head.position.set(0.1, 0.035, 0)
  group.add(head)
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.12, 4), mat)
  tail.rotation.z = Math.PI / 2
  tail.position.set(-0.12, 0.03, 0)
  group.add(tail)
  for (let i = 0; i < 4; i++) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.005, 0.05, 3), mat)
    leg.position.set((i < 2 ? 0.04 : -0.04), 0.015, (i % 2 === 0 ? 0.04 : -0.04))
    leg.rotation.x = (i % 2 === 0 ? 1 : -1) * 0.9
    group.add(leg)
  }
  group.scale.setScalar(0.85 + rand(1) * 0.4)
  return group
}

/** A butterfly — two wing planes that flap in update. */
function butterflyMesh(seed: number) {
  const rand = (n: number) => fbm(seed * 8.1 + n * 1.9, seed * 3.5 - n * 4.4)
  const group = new THREE.Group()
  const tone = rand(1) > 0.5 ? 0xc4a35a : 0x6a8c4e
  const wingMat = new THREE.MeshBasicMaterial({ color: tone, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
  const left = new THREE.Mesh(new THREE.CircleGeometry(0.09 + rand(2) * 0.05, 5), wingMat)
  const right = left.clone()
  left.position.x = -0.06
  right.position.x = 0.06
  left.rotation.y = 0.35
  right.rotation.y = -0.35
  group.add(left, right)
  group.userData.left = left
  group.userData.right = right
  return group
}

/** A beach gull — body + wings, smaller and lower than the thermal birds. */
function gullMesh(seed: number) {
  const rand = (n: number) => fbm(seed * 5.2 + n * 2.7, seed * 7.9 - n * 1.3)
  const group = new THREE.Group()
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0xd8d2c4 })
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), bodyMat)
  body.scale.set(1, 0.7, 1.6)
  group.add(body)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.07, 5, 4), bodyMat)
  head.position.set(0, 0.04, 0.16)
  group.add(head)
  const wingGeo = new THREE.PlaneGeometry(0.55, 0.16)
  const wingMat = new THREE.MeshBasicMaterial({ color: 0xc9c2b4, side: THREE.DoubleSide })
  const left = new THREE.Mesh(wingGeo, wingMat)
  const right = new THREE.Mesh(wingGeo, wingMat)
  left.position.set(-0.28, 0.02, 0)
  right.position.set(0.28, 0.02, 0)
  left.rotation.z = 0.15
  right.rotation.z = -0.15
  group.add(left, right)
  group.userData.left = left
  group.userData.right = right
  group.scale.setScalar(0.85 + rand(1) * 0.35)
  return group
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
  const seabed = new THREE.Color('#4e5f4a')
  const tide = new THREE.Color('#6e5f44')
  const wetSand = new THREE.Color('#a8946e')
  const drySand = new THREE.Color('#e2d2ac')
  const moss = new THREE.Color('#3f6132')
  const fern = new THREE.Color('#2e4f24')
  const scrub = new THREE.Color('#55793d')
  const bush = new THREE.Color('#2f4f24')
  const litter = new THREE.Color('#5c4a30')
  const rock = new THREE.Color('#6e6656')
  const basalt = new THREE.Color('#453d34')
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
    const gully = fbm(x * 0.006 - 8.2, z * 0.006 + 4.4)

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

    // Green band: moss in the dips, fern under canopy, scrub on the shoulders.
    // Gully noise keeps it patchy so it reads overgrown, not a green wash.
    growth.copy(moss).lerp(fern, THREE.MathUtils.clamp(gully * 1.4 - 0.2, 0, 1))
    growth.lerp(scrub, THREE.MathUtils.smoothstep(y, 18, 42))
    growth.lerp(bush, mottle * 0.6)
    // Leaf litter under the interior — browns where the canopy is thickest
    growth.lerp(litter, THREE.MathUtils.smoothstep(gully, 0.55, 0.8) * 0.45)
    shade.lerp(growth, THREE.MathUtils.smoothstep(y, 4, 15))
    // Steep faces shed soil — bare rock on the cliffs and up around the crater.
    // MathUtils.smoothstep has no inverted range, so the slope ramp is flipped
    // by hand rather than passing min > max (which silently returns 1).
    stone.copy(rock).lerp(basalt, mottle)
    shade.lerp(
      stone,
      Math.max(
        THREE.MathUtils.smoothstep(y, 108, 172),
        1 - THREE.MathUtils.smoothstep(normal.getY(i), 0.36, 0.62),
      ),
    )
    shade.multiplyScalar(0.9 + mottle * 0.2)

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
  const broadTrunks: THREE.BufferGeometry[] = []
  const broadCanopy: THREE.BufferGeometry[] = []
  const grassParts: THREE.BufferGeometry[] = []
  const deadParts: THREE.BufferGeometry[] = []
  const vineParts: THREE.BufferGeometry[] = []
  const pathParts: THREE.BufferGeometry[] = []
  const fernParts: THREE.BufferGeometry[] = []
  const fallenParts: THREE.BufferGeometry[] = []
  const boulderParts: THREE.BufferGeometry[] = []
  const wrackParts: THREE.BufferGeometry[] = []
  const reedParts: THREE.BufferGeometry[] = []
  // Saplings share the broadleaf batches — same bark / canopy materials

  const palmWanted = low ? 32 : 72
  const rockWanted = low ? 90 : 200
  const woodWanted = low ? 28 : 60
  const scrubWanted = low ? 160 : 380
  const broadWanted = low ? 100 : 240
  const grassWanted = low ? 2800 : 7500
  const deadWanted = low ? 18 : 40
  const vineWanted = low ? 120 : 280
  const pathWanted = low ? 32 : 60
  const fernWanted = low ? 140 : 340
  const fallenWanted = low ? 16 : 36
  const boulderWanted = low ? 32 : 70
  const wrackWanted = low ? 45 : 100
  const reedWanted = low ? 60 : 130
  const saplingWanted = low ? 60 : 140
  // broadWanted is the mid-story tree target; saplings add on top of that

  const placeAt = (geo: THREE.BufferGeometry, lx: number, h: number, lz: number, sink = 0.15) => {
    const m = new THREE.Matrix4().setPosition(lx, h - sink, lz)
    return geo.applyMatrix4(m)
  }

  /** Skip a plant if its local merge failed — better a gap than a hard crash. */
  const pushPlant = (list: THREE.BufferGeometry[], geo: THREE.BufferGeometry | null, lx: number, h: number, lz: number, sink = 0.15) => {
    if (!geo) return
    list.push(placeAt(geo, lx, h, lz, sink))
  }

  /** True when a local point sits on the spawn-facing landing cove. */
  const onCove = (lx: number, lz: number) => Math.hypot(lx - COVE_X, lz - COVE_Z) < 150

  /** Approach-facing slopes — the silhouette you swim toward. */
  const onApproach = (lx: number, lz: number) => {
    // West/north-west of centre, including the cove shoulder
    return lx < 80 && lz > -120
  }

  // Approach grove first — the beach you swim onto has to read as landfall,
  // not empty sand with the palms tucked on the far side of the island.
  {
    const groveWanted = low ? 12 : 22
    for (let i = 0; i < 600 && trunks.length < groveWanted; i++) {
      const angle = Math.atan2(COVE_Z, COVE_X) + (fbm(i, 1.7) - 0.5) * 1.4
      const radius = 155 + fbm(i, 2.9) * 95
      const lx = Math.cos(angle) * radius + (fbm(i, 3.1) - 0.5) * 14
      const lz = Math.sin(angle) * radius + (fbm(i, 4.2) - 0.5) * 14
      if (!onCove(lx, lz) && i % 3 !== 0) continue
      const h = surface(lx, lz)
      if (h < 2.0 || h > 14) continue
      const slope = Math.abs(surface(lx + 7, lz) - h) + Math.abs(surface(lx, lz + 7) - h)
      if (slope > 5.5) continue
      if (shore.some((s) => Math.hypot(s.x - opts.x - lx, s.z - opts.z - lz) < 5.5)) continue

      const at = new THREE.Vector3(lx, h - 0.3, lz)
      const tree = palm(i + 2000)
      const place = new THREE.Matrix4().setPosition(at)
      trunks.push(tree.trunk.applyMatrix4(place))
      for (const blade of tree.leaves) leaves.push(blade.applyMatrix4(place))
      for (const nut of tree.nuts) nuts.push(nut.applyMatrix4(place))
      shore.push(new THREE.Vector3(opts.x + lx, h, opts.z + lz))
    }
  }

  // Palms — clustered a bit so the beach has groves, not a picket fence
  for (let i = 0; i < 1400 && trunks.length < palmWanted; i++) {
    const angle = i * 2.399
    const radius = 150 + ((i * 13) % 220)
    // Pull every third candidate toward the previous successful plant for clusters
    const cluster = trunks.length > 0 && i % 3 === 0
    const prev = cluster ? shore[shore.length - 1] : null
    // Bias the spiral toward the cove so landfall isn't the empty face
    const covePull = i % 5 === 0
    const lx = prev
      ? prev.x - opts.x + (fbm(i, 1.1) - 0.5) * 18
      : covePull
        ? COVE_X + (fbm(i, 1.3) - 0.5) * 110
        : Math.cos(angle) * radius
    const lz = prev
      ? prev.z - opts.z + (fbm(i, 2.2) - 0.5) * 18
      : covePull
        ? COVE_Z + (fbm(i, 2.4) - 0.5) * 110
        : Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 2.0 || h > 14) continue
    // Palms want flat ground, not a cliff face — cove gets a little more slack
    const slope = Math.abs(surface(lx + 7, lz) - h) + Math.abs(surface(lx, lz + 7) - h)
    if (slope > (onCove(lx, lz) ? 5.8 : 4.8)) continue
    if (shore.some((s) => Math.hypot(s.x - opts.x - lx, s.z - opts.z - lz) < 5)) continue

    const at = new THREE.Vector3(lx, h - 0.3, lz)
    const tree = palm(i + 1)
    const place = new THREE.Matrix4().setPosition(at)
    trunks.push(tree.trunk.applyMatrix4(place))
    for (const blade of tree.leaves) leaves.push(blade.applyMatrix4(place))
    for (const nut of tree.nuts) nuts.push(nut.applyMatrix4(place))
    shore.push(new THREE.Vector3(opts.x + lx, h, opts.z + lz))
  }

  // Broadleaf mid-story — the overgrown interior. Sits above the beach band,
  // thicker in the gullies where the relief dips — and piled onto the
  // approach face so the swim-in silhouette isn't a bare cone.
  for (let i = 0; i < 3600 && broadTrunks.length < broadWanted; i++) {
    const angle = i * 2.197
    const radius = 45 + ((i * 17) % 290)
    const approachBias = i % 2 === 0
    const lx = approachBias
      ? COVE_X + (fbm(i, 3.3) - 0.5) * 210 + 50
      : Math.cos(angle) * radius
    const lz = approachBias
      ? COVE_Z + (fbm(i, 4.4) - 0.5) * 210 - 30
      : Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 4.5 || h > 85) continue
    const slope = Math.abs(surface(lx + 6, lz) - h) + Math.abs(surface(lx, lz + 6) - h)
    if (slope > 8.5) continue
    // Gullies grow thicker — sample the local dip
    const dip = surface(lx + 14, lz) + surface(lx - 14, lz) + surface(lx, lz + 14) + surface(lx, lz - 14) - h * 4
    if (dip < -2.5 && i % 3 === 0) continue
    const tree = broadleaf(i + 300)
    const place = new THREE.Matrix4().setPosition(lx, h - 0.25, lz)
    broadTrunks.push(tree.trunk.applyMatrix4(place))
    for (const blob of tree.canopy) broadCanopy.push(blob.applyMatrix4(place))
  }

  // Saplings — fill the gaps between palms and broadleaf so the mid-story
  // doesn't read as a few trees on a painted hill
  let saplings = 0
  for (let i = 0; i < 1600 && saplings < saplingWanted; i++) {
    const angle = i * 2.083
    const radius = 70 + ((i * 21) % 250)
    const lx = Math.cos(angle) * radius + (fbm(i, 1.5) - 0.5) * 8
    const lz = Math.sin(angle) * radius + (fbm(i, 2.5) - 0.5) * 8
    const h = surface(lx, lz)
    if (h < 3.5 || h > 45) continue
    const slope = Math.abs(surface(lx + 4, lz) - h) + Math.abs(surface(lx, lz + 4) - h)
    if (slope > 6) continue
    if (shore.some((s) => Math.hypot(s.x - opts.x - lx, s.z - opts.z - lz) < 4)) continue
    const young = sapling(i + 1100)
    const place = new THREE.Matrix4().setPosition(lx, h - 0.08, lz)
    broadTrunks.push(young.trunk.applyMatrix4(place))
    for (const blob of young.canopy) broadCanopy.push(blob.applyMatrix4(place))
    saplings++
  }

  // Beach rocks — frame the waterline and break empty sand
  for (let i = 0; i < 1600 && rocks.length < rockWanted; i++) {
    const angle = i * 2.193
    // Bias every fourth candidate onto the cove beach
    const coveBias = i % 4 === 0
    const radius = coveBias ? 160 + ((i * 11) % 100) : 190 + ((i * 17) % 240)
    const lx = coveBias
      ? COVE_X + Math.cos(angle) * (radius * 0.45)
      : Math.cos(angle) * radius
    const lz = coveBias
      ? COVE_Z + Math.sin(angle) * (radius * 0.45)
      : Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 0.2 || h > 6.5) continue
    const slope = Math.abs(surface(lx + 4, lz) - h) + Math.abs(surface(lx, lz + 4) - h)
    if (slope > 4) continue
    // Skip if buried under a palm trunk
    if (shore.some((s) => Math.hypot(s.x - opts.x - lx, s.z - opts.z - lz) < 3.2)) continue
    rocks.push(placeAt(rockChunk(i + 40), lx, h, lz, 0.2 + (i % 5) * 0.04))
  }

  // Mid-slope boulders — the thing that stops a green cone reading as a cone
  for (let i = 0; i < 900 && boulderParts.length < boulderWanted; i++) {
    const angle = i * 2.467
    const radius = 80 + ((i * 19) % 240)
    const lx = Math.cos(angle) * radius
    const lz = Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 6 || h > 95) continue
    const slope = Math.abs(surface(lx + 5, lz) - h) + Math.abs(surface(lx, lz + 5) - h)
    // Prefer a bit of pitch — boulders collect where the ground tips
    if (slope < 1.2 || slope > 11) continue
    boulderParts.push(placeAt(boulder(i + 1500), lx, h, lz, 0.35 + (i % 4) * 0.08))
  }

  // Driftwood — mid-beach, sparse, sells the wash-up
  for (let i = 0; i < 1100 && wood.length < woodWanted; i++) {
    const angle = i * 2.618
    const coveBias = i % 3 === 0
    const radius = 200 + ((i * 23) % 190)
    const lx = coveBias ? COVE_X + (fbm(i, 3.3) - 0.5) * 100 : Math.cos(angle) * radius
    const lz = coveBias ? COVE_Z + (fbm(i, 4.4) - 0.5) * 100 : Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 0.6 || h > 5) continue
    const slope = Math.abs(surface(lx + 5, lz) - h) + Math.abs(surface(lx, lz + 5) - h)
    if (slope > 3.2) continue
    wood.push(placeAt(driftwood(i + 90), lx, h, lz, 0.08))
  }

  // Tide wrack — wet-sand mats so the waterline isn't a painted edge
  for (let i = 0; i < 1000 && wrackParts.length < wrackWanted; i++) {
    const angle = i * 2.311
    const coveBias = i % 2 === 0
    const radius = 210 + ((i * 29) % 200)
    const lx = coveBias ? COVE_X + (fbm(i, 5.5) - 0.5) * 120 : Math.cos(angle) * radius
    const lz = coveBias ? COVE_Z + (fbm(i, 6.6) - 0.5) * 120 : Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 0.15 || h > 2.4) continue
    pushPlant(wrackParts, tideWrack(i + 1700), lx, h, lz, 0.02)
  }

  // Reeds in the wet band — vertical rhythm along the wash
  for (let i = 0; i < 1100 && reedParts.length < reedWanted; i++) {
    const angle = i * 2.155
    const coveBias = i % 3 !== 2
    const radius = 200 + ((i * 31) % 210)
    const lx = coveBias ? COVE_X + (fbm(i, 7.7) - 0.5) * 115 : Math.cos(angle) * radius
    const lz = coveBias ? COVE_Z + (fbm(i, 8.8) - 0.5) * 115 : Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 0.3 || h > 3.2) continue
    const slope = Math.abs(surface(lx + 3, lz) - h) + Math.abs(surface(lx, lz + 3) - h)
    if (slope > 2.8) continue
    pushPlant(reedParts, reedClump(i + 1800), lx, h, lz, 0.02)
  }

  // Dune scrub — sits where sand turns green, softens the colour cliff
  for (let i = 0; i < 2800 && scrubParts.length < scrubWanted; i++) {
    const angle = i * 2.071
    const radius = 120 + ((i * 19) % 260)
    const coveBias = i % 3 !== 2
    const lx = coveBias ? COVE_X + (fbm(i, 1.9) - 0.5) * 170 : Math.cos(angle) * radius
    const lz = coveBias ? COVE_Z + (fbm(i, 2.8) - 0.5) * 170 : Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 2.8 || h > 28) continue
    const slope = Math.abs(surface(lx + 6, lz) - h) + Math.abs(surface(lx, lz + 6) - h)
    if (slope > 7.5) continue
    pushPlant(scrubParts, scrubBush(i + 120), lx, h, lz, 0.05)
  }

  // Ferns — understory between the trees, denser in the green band
  for (let i = 0; i < 3000 && fernParts.length < fernWanted; i++) {
    const angle = i * 2.279
    const radius = 50 + ((i * 27) % 270)
    const approachBias = onApproach(Math.cos(angle) * radius, Math.sin(angle) * radius) || i % 2 === 0
    const lx = approachBias
      ? COVE_X + (fbm(i, 9.1) - 0.5) * 180
      : Math.cos(angle) * radius + (fbm(i, 9.1) - 0.5) * 10
    const lz = approachBias
      ? COVE_Z + (fbm(i, 10.2) - 0.5) * 180
      : Math.sin(angle) * radius + (fbm(i, 10.2) - 0.5) * 10
    const h = surface(lx, lz)
    if (h < 3.5 || h > 60) continue
    const slope = Math.abs(surface(lx + 3, lz) - h) + Math.abs(surface(lx, lz + 3) - h)
    if (slope > 7.5) continue
    pushPlant(fernParts, fernClump(i + 1900), lx, h, lz, 0.03)
  }

  // Grass — dense ground cover across the green band. Heavy cove bias so
  // looking down on landfall isn't a blank olive plane.
  for (let i = 0; i < 20000 && grassParts.length < grassWanted; i++) {
    const angle = i * 2.39996
    const radius = 30 + ((i * 29) % 290)
    // First ~40% of the budget is a tight carpet on the landing shelf
    const carpet = grassParts.length < grassWanted * 0.4
    const lx = carpet
      ? COVE_X + (fbm(i, 7.7) - 0.5) * 85
      : i % 2 === 0
        ? COVE_X + (fbm(i, 7.7) - 0.5) * 160
        : Math.cos(angle) * radius + (fbm(i, 7.7) - 0.5) * 9
    const lz = carpet
      ? COVE_Z + (fbm(i, 8.8) - 0.5) * 85
      : i % 2 === 0
        ? COVE_Z + (fbm(i, 8.8) - 0.5) * 160
        : Math.sin(angle) * radius + (fbm(i, 8.8) - 0.5) * 9
    const h = surface(lx, lz)
    if (h < 1.6 || h > 70) continue
    const slope = Math.abs(surface(lx + 3, lz) - h) + Math.abs(surface(lx, lz + 3) - h)
    if (slope > 6) continue
    pushPlant(grassParts, grassTuft(i + 500), lx, h, lz, 0.02)
  }

  // Fallen logs — the interior's weather, lying where trees once stood
  for (let i = 0; i < 700 && fallenParts.length < fallenWanted; i++) {
    const angle = i * 2.701
    const radius = 70 + ((i * 37) % 230)
    const lx = Math.cos(angle) * radius
    const lz = Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 5 || h > 50) continue
    const slope = Math.abs(surface(lx + 5, lz) - h) + Math.abs(surface(lx, lz + 5) - h)
    if (slope > 4.5) continue
    fallenParts.push(placeAt(fallenLog(i + 2100), lx, h, lz, 0.12))
  }

  // Dead snags — scattered through the green, the island's weather showing
  for (let i = 0; i < 800 && deadParts.length < deadWanted; i++) {
    const angle = i * 2.513
    const radius = 80 + ((i * 31) % 250)
    const lx = Math.cos(angle) * radius
    const lz = Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 4 || h > 55) continue
    const slope = Math.abs(surface(lx + 5, lz) - h) + Math.abs(surface(lx, lz + 5) - h)
    if (slope > 6) continue
    deadParts.push(placeAt(deadTree(i + 700), lx, h, lz, 0.1))
  }

  // Vines — hang off steeper faces in the green band, and off the broadleaf
  // trunks, so the rock reads draped rather than bare
  for (let i = 0; i < 1400 && vineParts.length < vineWanted; i++) {
    const angle = i * 2.341
    const radius = 60 + ((i * 23) % 260)
    const lx = Math.cos(angle) * radius
    const lz = Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 5 || h > 90) continue
    const slope = Math.abs(surface(lx + 4, lz) - h) + Math.abs(surface(lx, lz + 4) - h)
    // Want a face with some pitch — not flat ground, not a cliff
    if (slope < 1.8 || slope > 10) continue
    const anchor = h + 1.2 + fbm(i, 3.3) * 2.4
    vineParts.push(placeAt(vine(i + 900), lx, anchor, lz, 0))
  }

  // A worn path from the landing beach up toward the interior — flat stones
  // and trampled ground, subtle enough that you find it by walking it.
  // Prefer a cove palm so the path starts where you actually come ashore.
  {
    const from =
      shore.find((s) => onCove(s.x - opts.x, s.z - opts.z)) ??
      (shore.length > 0 ? shore[0] : null)
    if (from) {
      const sx = from.x - opts.x
      const sz = from.z - opts.z
      const heading = Math.atan2(-sx, -sz) // toward island centre
      for (let i = 0; i < pathWanted; i++) {
        const dist = 3 + i * 2.8
        const wobble = (fbm(i * 0.7, 11.1) - 0.5) * 3.2
        const lx = sx + Math.sin(heading) * -dist + Math.cos(heading) * wobble
        const lz = sz + Math.cos(heading) * -dist - Math.sin(heading) * wobble
        const h = surface(lx, lz)
        if (h < 1.2 || h > 35) continue
        const stone = new THREE.CylinderGeometry(0.5 + fbm(i, 5.5) * 0.5, 0.6 + fbm(i, 6.6) * 0.5, 0.16, 6)
        stone.rotateY(fbm(i, 7.7) * Math.PI)
        pathParts.push(placeAt(stone, lx, h, lz, 0.05))
      }
    }
  }

  // Prefer the landing-cove palms first so Pack→Island and the beach teleport
  // put you where the swim actually arrives, not on the far side of the island.
  shore.sort((a, b) => {
    const da = Math.hypot(a.x - opts.x - COVE_X, a.z - opts.z - COVE_Z)
    const db = Math.hypot(b.x - opts.x - COVE_X, b.z - opts.z - COVE_Z)
    return da - db
  })

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

  if (broadTrunks.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(broadTrunks, false) as THREE.BufferGeometry,
        hazeMaterial(haze, { color: 0x54432e, roughness: 0.96, ...skylight }),
      ),
    )
    group.add(
      new THREE.Mesh(
        mergeGeometries(broadCanopy, false) as THREE.BufferGeometry,
        hazeMaterial(haze, {
          color: 0x35662b,
          roughness: 0.9,
          ...skylight,
        }),
      ),
    )
  }

  if (grassParts.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(grassParts, false) as THREE.BufferGeometry,
        hazeMaterial(haze, {
          color: 0x5a8438,
          roughness: 0.95,
          side: THREE.DoubleSide,
          ...skylight,
        }),
      ),
    )
  }

  if (deadParts.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(deadParts, false) as THREE.BufferGeometry,
        hazeMaterial(haze, { color: 0x8d8272, roughness: 1, ...skylight }),
      ),
    )
  }

  if (vineParts.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(vineParts, false) as THREE.BufferGeometry,
        hazeMaterial(haze, {
          color: 0x3a5c28,
          roughness: 0.92,
          side: THREE.DoubleSide,
          ...skylight,
        }),
      ),
    )
  }

  if (pathParts.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(pathParts, false) as THREE.BufferGeometry,
        hazeMaterial(haze, { color: 0x7d7462, roughness: 0.98, ...skylight }),
      ),
    )
  }

  if (fernParts.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(fernParts, false) as THREE.BufferGeometry,
        hazeMaterial(haze, {
          color: 0x3a5e2a,
          roughness: 0.92,
          side: THREE.DoubleSide,
          ...skylight,
        }),
      ),
    )
  }

  if (fallenParts.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(fallenParts, false) as THREE.BufferGeometry,
        hazeMaterial(haze, { color: 0x4a3c2c, roughness: 1, ...skylight }),
      ),
    )
  }

  if (boulderParts.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(boulderParts, false) as THREE.BufferGeometry,
        hazeMaterial(haze, { color: 0x5e574c, roughness: 0.97, ...skylight }),
      ),
    )
  }

  if (wrackParts.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(wrackParts, false) as THREE.BufferGeometry,
        hazeMaterial(haze, { color: 0x3d4a32, roughness: 0.95, ...skylight }),
      ),
    )
  }

  if (reedParts.length) {
    group.add(
      new THREE.Mesh(
        mergeGeometries(reedParts, false) as THREE.BufferGeometry,
        hazeMaterial(haze, {
          color: 0x5a6e3c,
          roughness: 0.9,
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

  // —— inland cairn ————————————————————————————————————————————
  // A small stack on flat green ground. Not a waypoint — just proof someone
  // walked inland and left rope. Salvage hangs a takeable find on the world
  // position; this mesh is the thing you notice first.
  let cairn: THREE.Vector3 | null = null
  {
    const stoneMat = hazeMaterial(haze, { color: 0x6a6358, roughness: 0.97, ...skylight })
    const candidates: { lx: number; lz: number; h: number; slope: number }[] = []
    for (let i = 0; i < 700; i++) {
      const angle = i * 2.618 + 1.1
      const radius = 70 + ((i * 23) % 180)
      const lx = Math.cos(angle) * radius
      const lz = Math.sin(angle) * radius
      const h = surface(lx, lz)
      if (h < 9 || h > 38) continue
      const slope =
        Math.abs(surface(lx + 3, lz) - h) +
        Math.abs(surface(lx - 3, lz) - h) +
        Math.abs(surface(lx, lz + 3) - h) +
        Math.abs(surface(lx, lz - 3) - h)
      if (slope > 2.8) continue
      // Prefer a quiet pocket away from the rain pools
      if (pools.some((p) => Math.hypot(p.x - (opts.x + lx), p.z - (opts.z + lz)) < 28)) continue
      candidates.push({ lx, lz, h, slope })
    }
    candidates.sort((a, b) => a.slope - b.slope || a.h - b.h)
    const spot = candidates[0]
    if (spot) {
      const { lx, lz, h } = spot
      const stack = new THREE.Group()
      stack.position.set(lx, h, lz)
      const sizes = [
        [0.55, 0.28, 0.48],
        [0.42, 0.22, 0.38],
        [0.28, 0.2, 0.26],
        [0.18, 0.16, 0.2],
      ]
      let y = 0
      for (let i = 0; i < sizes.length; i++) {
        const [sx, sy, sz] = sizes[i]
        const rock = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), stoneMat)
        rock.position.set((i % 2) * 0.04 - 0.02, y + sy * 0.5, (i % 3) * 0.03 - 0.03)
        rock.rotation.y = i * 0.55
        rock.rotation.z = (i % 2) * 0.08 - 0.04
        stack.add(rock)
        y += sy * 0.82
      }
      // A short upright stick — reads as a marker, not a build
      const stick = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.03, 0.9, 5),
        hazeMaterial(haze, { color: 0x5a4634, roughness: 1, ...skylight }),
      )
      stick.position.set(0.12, y * 0.35 + 0.45, -0.08)
      stick.rotation.z = 0.12
      stack.add(stick)
      group.add(stack)
      cairn = new THREE.Vector3(opts.x + lx, h, opts.z + lz)
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

  // —— wildlife ————————————————————————————————————————————————
  // The island has to feel occupied, not dressed. Crabs on the wash, lizards
  // on warm rock, butterflies in the green, gulls on the sand, and a few
  // silhouettes on the thermals. Cheap meshes, live in update, nothing marked.

  type Crab = {
    mesh: THREE.Group
    homeX: number
    homeZ: number
    x: number
    z: number
    heading: number
    spook: number
    phase: number
    goneUntil: number
  }
  type Lizard = {
    mesh: THREE.Group
    x: number
    z: number
    heading: number
    phase: number
    alert: number
  }
  type Flutter = {
    mesh: THREE.Group
    x: number
    y: number
    z: number
    phase: number
    speed: number
  }
  type Gull = {
    mesh: THREE.Group
    x: number
    z: number
    y: number
    heading: number
    phase: number
    flying: number
    flyHeight: number
  }

  const crabs: Crab[] = []
  const lizards: Lizard[] = []
  const flutters: Flutter[] = []
  const gulls: Gull[] = []
  const birds: THREE.Mesh[] = []

  // Shore crabs — wet sand, mostly on the landing cove
  {
    const want = low ? 12 : 24
    for (let i = 0; i < 900 && crabs.length < want; i++) {
      const coveBias = i % 4 !== 3
      const angle = i * 2.399
      const radius = 180 + ((i * 17) % 200)
      const lx = coveBias ? COVE_X + (fbm(i, 1.1) - 0.5) * 130 : Math.cos(angle) * radius
      const lz = coveBias ? COVE_Z + (fbm(i, 2.2) - 0.5) * 130 : Math.sin(angle) * radius
      const h = surface(lx, lz)
      if (h < 0.25 || h > 2.8) continue
      const mesh = crabMesh(i + 50)
      mesh.position.set(lx, h + 0.02, lz)
      group.add(mesh)
      crabs.push({
        mesh,
        homeX: lx,
        homeZ: lz,
        x: lx,
        z: lz,
        heading: fbm(i, 3.3) * Math.PI * 2,
        spook: 0,
        phase: fbm(i, 4.4) * Math.PI * 2,
        goneUntil: 0,
      })
    }
  }

  // Lizards — sun on rock and scrub edges
  {
    const want = low ? 8 : 16
    for (let i = 0; i < 700 && lizards.length < want; i++) {
      const angle = i * 2.618
      const radius = 90 + ((i * 23) % 240)
      const approachBias = i % 2 === 0
      const lx = approachBias ? COVE_X + (fbm(i, 5.5) - 0.5) * 160 : Math.cos(angle) * radius
      const lz = approachBias ? COVE_Z + (fbm(i, 6.6) - 0.5) * 160 : Math.sin(angle) * radius
      const h = surface(lx, lz)
      if (h < 2.5 || h > 28) continue
      const slope = Math.abs(surface(lx + 3, lz) - h) + Math.abs(surface(lx, lz + 3) - h)
      if (slope < 0.8) continue
      const mesh = lizardMesh(i + 80)
      mesh.position.set(lx, h + 0.02, lz)
      mesh.rotation.y = fbm(i, 7.7) * Math.PI * 2
      group.add(mesh)
      lizards.push({
        mesh,
        x: lx,
        z: lz,
        heading: mesh.rotation.y,
        phase: fbm(i, 8.8) * Math.PI * 2,
        alert: 0,
      })
    }
  }

  // Butterflies — green band, especially near the cove shoulder
  {
    const want = low ? 10 : 20
    for (let i = 0; i < want; i++) {
      const lx = COVE_X + (fbm(i, 9.1) - 0.5) * 180 + (i % 3) * 20
      const lz = COVE_Z + (fbm(i, 10.2) - 0.5) * 180
      const h = Math.max(surface(lx, lz), 2)
      const mesh = butterflyMesh(i + 120)
      mesh.position.set(lx, h + 1.2 + fbm(i, 1.4) * 1.5, lz)
      group.add(mesh)
      flutters.push({
        mesh,
        x: lx,
        y: mesh.position.y,
        z: lz,
        phase: fbm(i, 2.5) * Math.PI * 2,
        speed: 0.35 + fbm(i, 3.6) * 0.4,
      })
    }
  }

  // Beach gulls — walk the wash, lift off when you get close
  {
    const want = low ? 5 : 9
    for (let i = 0; i < 500 && gulls.length < want; i++) {
      const coveBias = i % 3 !== 2
      const angle = i * 2.713
      const radius = 200 + ((i * 19) % 180)
      const lx = coveBias ? COVE_X + (fbm(i, 4.1) - 0.5) * 140 : Math.cos(angle) * radius
      const lz = coveBias ? COVE_Z + (fbm(i, 5.2) - 0.5) * 140 : Math.sin(angle) * radius
      const h = surface(lx, lz)
      if (h < 0.4 || h > 4.5) continue
      const mesh = gullMesh(i + 140)
      mesh.position.set(lx, h + 0.12, lz)
      group.add(mesh)
      gulls.push({
        mesh,
        x: lx,
        z: lz,
        y: h + 0.12,
        heading: fbm(i, 6.3) * Math.PI * 2,
        phase: fbm(i, 7.4) * Math.PI * 2,
        flying: 0,
        flyHeight: 4 + fbm(i, 8.5) * 5,
      })
    }
  }

  // Thermal birds — silhouettes over the peak, readable from half a kilometre
  {
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x1c2226, side: THREE.DoubleSide })
    const birdCount = low ? 5 : 9
    for (let i = 0; i < birdCount; i++) {
      const wing = new THREE.PlaneGeometry(0.9, 0.28)
      wing.translate(0.45, 0, 0)
      const left = wing.clone()
      const right = wing.clone()
      left.rotateZ(0.35)
      right.rotateY(Math.PI)
      right.rotateZ(0.35)
      const geo = mergeGeometries([left, right], false) as THREE.BufferGeometry
      const bird = new THREE.Mesh(geo, birdMat)
      bird.userData = {
        radius: 55 + i * 18 + fbm(i, 3.3) * 28,
        height: 85 + i * 12 + fbm(i, 4.4) * 28,
        speed: 0.12 + fbm(i, 5.5) * 0.1,
        phase: fbm(i, 6.6) * Math.PI * 2,
      }
      bird.frustumCulled = false
      group.add(bird)
      birds.push(bird)
    }
  }

  const crabsApi = {
    nearest(point: THREE.Vector3, maxDist: number) {
      let best = -1
      let bestD = maxDist
      for (let i = 0; i < crabs.length; i++) {
        const c = crabs[i]
        if (c.goneUntil > 0 || !c.mesh.visible) continue
        const wx = opts.x + c.x
        const wz = opts.z + c.z
        const d = Math.hypot(point.x - wx, point.z - wz)
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      return best < 0 ? null : { index: best, dist: bestD }
    },
    positionAt(index: number, out: THREE.Vector3) {
      const c = crabs[index]
      const h = surface(c.x, c.z)
      return out.set(opts.x + c.x, h + 0.05, opts.z + c.z)
    },
    take(index: number) {
      const c = crabs[index]
      if (!c || c.goneUntil > 0 || !c.mesh.visible) return false
      c.mesh.visible = false
      // Respawn delay set from update's clock on first hidden frame
      c.goneUntil = -1
      return true
    },
  }

  let wildlifeTime = 0

  function update(camera: THREE.Camera, underwater: boolean, time = 0) {
    // Nothing is visible 700 m through water. Close in it's the shelf you dive,
    // so keep it once the island is the thing you're swimming around.
    group.visible = !underwater || camera.position.distanceToSquared(centre) < 420 * 420

    const dt = wildlifeTime > 0 ? Math.min(0.05, Math.max(0, time - wildlifeTime)) : 0.016
    wildlifeTime = time
    const camX = camera.position.x - opts.x
    const camZ = camera.position.z - opts.z

    // —— crabs ——————————————————————————————————————————————
    for (const c of crabs) {
      if (c.goneUntil < 0) {
        c.goneUntil = time + 75 + c.phase * 8
      }
      if (c.goneUntil > 0) {
        if (time < c.goneUntil) {
          c.mesh.visible = false
          continue
        }
        c.goneUntil = 0
        c.x = c.homeX
        c.z = c.homeZ
        c.spook = 0
        c.mesh.visible = true
      }

      const dist = Math.hypot(camX - c.x, camZ - c.z)
      // Freeze a beat when first noticed, then sidestep — gives a grab window
      if (dist < 3.8) c.spook = Math.min(1, c.spook + dt * 1.4)
      else c.spook = Math.max(0, c.spook - dt * 0.35)

      if (c.spook > 0.45) {
        // Sidestep away from the camera — crabs don't run straight
        const away = Math.atan2(c.z - camZ, c.x - camX) + 1.1
        c.heading = away
        const spd = 1.2 + c.spook * 1.8
        c.x += Math.cos(c.heading) * spd * dt
        c.z += Math.sin(c.heading) * spd * dt
      } else if (c.spook > 0.08) {
        // Locked — the tell before they bolt
        c.heading += Math.sin(time * 20 + c.phase) * 0.05
      } else {
        // Idle wander near home
        c.heading += Math.sin(time * 0.7 + c.phase) * 0.4 * dt
        const spd = 0.25 + Math.sin(time * 1.3 + c.phase) * 0.15
        c.x += Math.cos(c.heading) * spd * dt
        c.z += Math.sin(c.heading) * spd * dt
        // Leash
        const hx = c.x - c.homeX
        const hz = c.z - c.homeZ
        if (hx * hx + hz * hz > 36) {
          c.heading = Math.atan2(c.homeZ - c.z, c.homeX - c.x)
        }
      }

      const h = surface(c.x, c.z)
      // Keep them on the wet band — if they climb too high, turn home
      if (h < 0.1 || h > 4.5) {
        c.heading = Math.atan2(c.homeZ - c.z, c.homeX - c.x)
        c.x += Math.cos(c.heading) * 2 * dt
        c.z += Math.sin(c.heading) * 2 * dt
      }
      c.mesh.position.set(c.x, surface(c.x, c.z) + 0.02, c.z)
      c.mesh.rotation.y = c.heading
      // Tiny bob while moving
      c.mesh.position.y += Math.abs(Math.sin(time * 14 + c.phase)) * 0.015 * (0.3 + c.spook)
    }

    // —— lizards ————————————————————————————————————————————
    for (const l of lizards) {
      const dist = Math.hypot(camX - l.x, camZ - l.z)
      if (dist < 4.2) l.alert = Math.min(1, l.alert + dt * 3)
      else l.alert = Math.max(0, l.alert - dt * 0.5)

      if (l.alert > 0.5) {
        l.heading += (Math.atan2(l.z - camZ, l.x - camX) - l.heading) * 0.2
        l.x += Math.cos(l.heading) * 2.8 * dt
        l.z += Math.sin(l.heading) * 2.8 * dt
      } else {
        // Push-ups in the sun
        l.mesh.position.y = surface(l.x, l.z) + 0.02 + Math.sin(time * 3.5 + l.phase) * 0.012
      }
      const h = surface(l.x, l.z)
      if (h < 1.5 || h > 35) {
        l.heading += Math.PI * 0.5
        l.x += Math.cos(l.heading) * dt
        l.z += Math.sin(l.heading) * dt
      }
      l.mesh.position.x = l.x
      l.mesh.position.z = l.z
      if (l.alert > 0.5) l.mesh.position.y = surface(l.x, l.z) + 0.02
      l.mesh.rotation.y = l.heading
    }

    // —— butterflies ——————————————————————————————————————
    for (const f of flutters) {
      f.x += Math.cos(time * f.speed + f.phase) * 0.55 * dt
      f.z += Math.sin(time * f.speed * 0.85 + f.phase * 1.3) * 0.55 * dt
      f.y = Math.max(surface(f.x, f.z) + 0.8, f.y + Math.sin(time * 2.2 + f.phase) * 0.35 * dt)
      // Soft leash near the cove green
      const dx = f.x - COVE_X
      const dz = f.z - COVE_Z
      if (dx * dx + dz * dz > 220 * 220) {
        f.x -= dx * 0.01
        f.z -= dz * 0.01
      }
      f.mesh.position.set(f.x, f.y, f.z)
      f.mesh.rotation.y = time * f.speed + f.phase
      const flap = Math.sin(time * 18 + f.phase) * 0.55
      const left = f.mesh.userData.left as THREE.Mesh
      const right = f.mesh.userData.right as THREE.Mesh
      if (left && right) {
        left.rotation.y = 0.35 + flap
        right.rotation.y = -0.35 - flap
      }
    }

    // —— gulls ——————————————————————————————————————————————
    for (const g of gulls) {
      const dist = Math.hypot(camX - g.x, camZ - g.z)
      if (dist < 7 && g.flying < 0.2) g.flying = 1
      if (g.flying > 0) {
        g.flying = Math.min(1, g.flying + dt * 0.15)
        g.y += (g.flyHeight - (g.y - surface(g.x, g.z))) * 1.5 * dt
        g.heading += 0.55 * dt
        g.x += Math.cos(g.heading) * 3.2 * dt
        g.z += Math.sin(g.heading) * 3.2 * dt
        // Settle again once far enough
        if (dist > 18 && g.flying > 0.8) {
          g.flying = Math.max(0, g.flying - dt * 0.4)
          const ground = surface(g.x, g.z)
          g.y += (ground + 0.12 - g.y) * 2 * dt
          if (Math.abs(g.y - (ground + 0.12)) < 0.15 && dist > 14) g.flying = 0
        }
        const left = g.mesh.userData.left as THREE.Mesh
        const right = g.mesh.userData.right as THREE.Mesh
        const flap = Math.sin(time * 12 + g.phase) * 0.45
        if (left && right) {
          left.rotation.z = 0.15 + flap
          right.rotation.z = -0.15 - flap
        }
      } else {
        // Peck
        g.mesh.rotation.x = Math.sin(time * 2.4 + g.phase) > 0.7 ? 0.35 : 0
        g.heading += Math.sin(time * 0.4 + g.phase) * 0.3 * dt
        g.x += Math.cos(g.heading) * 0.2 * dt
        g.z += Math.sin(g.heading) * 0.2 * dt
        g.y = surface(g.x, g.z) + 0.12
        const left = g.mesh.userData.left as THREE.Mesh
        const right = g.mesh.userData.right as THREE.Mesh
        if (left && right) {
          left.rotation.z = 0.08
          right.rotation.z = -0.08
        }
      }
      g.mesh.position.set(g.x, g.y, g.z)
      g.mesh.rotation.y = g.heading
    }

    for (const bird of birds) {
      const { radius, height, speed, phase } = bird.userData
      const a = time * speed + phase
      bird.position.set(Math.cos(a) * radius, height + Math.sin(time * 0.5 + phase) * 3, Math.sin(a) * radius)
      bird.rotation.y = -a - Math.PI / 2
      // Wing flap — a slow bob on the z-axis reads as a glide-flap mix at range
      bird.rotation.z = Math.sin(time * 6 + phase * 3) * 0.28
    }
  }

  /** Keep aerial perspective matched to the live horizon as day and storms move. */
  function setHaze(color: THREE.Color) {
    haze.copy(color).convertLinearToSRGB()
  }

  return { group, centre, heightAt, resolve, shore, pools, cairn, crabs: crabsApi, update, setHaze }
}
