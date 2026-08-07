import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { bakePlant, createFoliage, plantTint, type PlantBake } from './foliage'
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
  /** The terrain shell itself, for anything that needs to treat it specially. */
  terrain: THREE.Mesh
  centre: THREE.Vector3
  /** World ground height. Deep negative once you're off the shelf. */
  heightAt: (x: number, z: number) => number
  /** Keeps the swimmer out of the rock and lets them wade up the beach. */
  resolve: (p: { x: number; y: number; z: number }) => void
  /** How many boulder / stone ellipsoids are live. */
  readonly rockColliders: number
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
    reset: () => void
    snapshot: () => { returnIn: number }[]
    restore: (saved?: { returnIn: number }[]) => void
  }
  update: (camera: THREE.Camera, underwater: boolean, time?: number) => void
  /** Keep aerial perspective matched to the live horizon. */
  setHaze: (color: THREE.Color) => void
  /**
   * Drive the wind and the key light the leaf backlight reads from. Both come
   * from the weather, which the island itself knows nothing about.
   */
  setWeather: (
    time: number,
    wind: number,
    cloudShadow: number,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    tide?: number,
  ) => void
}

/** Which way the trade wind runs across the island. Everything leans this way. */
const WIND_HEADING = 0.62

/**
 * Uniform 0–1 from a pair of numbers, for scattering things across the island.
 *
 * `fbm` is the wrong tool for this and was quietly ruining the planting: it
 * sums four octaves, so its values pile up around the mean, and a jitter of
 * `(scatter(i, k) - 0.5) * 160` that reads as ±80 m actually lands almost
 * everything within ±25 m. Whole bands of the island came out bare while the
 * cove got planted four times over.
 */
function scatter(i: number, salt: number) {
  const v = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return v - Math.floor(v)
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

/**
 * Bearing from island centre toward the wreck (island-local). The crossing
 * runs this lobe — where we cut the abyss so the approach isn't a shallow
 * turquoise bath all the way from spar to beach.
 */
const TO_WRECK = Math.atan2(576, -1018)

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
  // Two more octaves of hummocks higher up. Without them the slopes above the
  // beach are smooth cones, and a smooth cone reads as a painted backdrop from
  // the water and as a golf course once you're standing on it.
  const midBand = THREE.MathUtils.smoothstep(h, 12, 28) * (1 - THREE.MathUtils.smoothstep(h, 78, 120))
  h += (noise2(lx * 0.018 + 9.1, lz * 0.018 - 6.4) - 0.5) * 8.5 * midBand
  h += (noise2(lx * 0.041 - 3.7, lz * 0.041 + 12.8) - 0.5) * 3.4 * midBand
  h -= SEA_CUT
  // The last few metres either side of the waterline flatten into beach and
  // shallows, instead of the cone driving straight into the sea
  h *= 0.22 + 0.78 * THREE.MathUtils.smoothstep(Math.abs(h), 3, 40)
  // Landing cove: pull the spawn-facing shore onto a wadable shelf so landfall
  // is a beach with palms, not a cliff that rejects every plant.
  // (smoothstep needs min < max — an inverted range silently returns 1.)
  const coveDist = Math.hypot(lx - COVE_X, lz - COVE_Z)
  {
    const cove = 1 - THREE.MathUtils.smoothstep(coveDist, 20, 175)
    if (cove > 0) {
      // Keep the shelf low enough that sand still reads as sand underfoot
      const beach = 2.4 + relief(lx, lz) * 1.6
      if (h > beach) h = THREE.MathUtils.lerp(h, beach, cove * 0.88)
      else if (h < 0.4) h = THREE.MathUtils.lerp(h, Math.min(beach * 0.55, 1.6), cove * 0.65)
    }
  }
  const r = Math.hypot(lx, lz)
  const bearing = Math.atan2(lz, lx)
  // How much this sample faces the wreck crossing (1 on the approach, 0 opposite)
  let approach = Math.cos(bearing - TO_WRECK)
  approach = Math.max(0, approach)
  approach *= approach
  // Protect the landing beach — trench starts seaward of the cove disk
  const coveMask = 1 - THREE.MathUtils.smoothstep(coveDist, 155, 225)

  // Reef drop-off wall: past the wadable shelf a steep face drops over a short
  // swim — a wall you can follow. On the wreck approach it plunges harder so
  // the crossing reads as a lip over darkness, not a bathtub slope.
  {
    const face = THREE.MathUtils.smoothstep(r, 242, 285)
    const apron = THREE.MathUtils.smoothstep(r, 285, 350)
    const wallDrop = 8.5 + approach * (1 - coveMask) * 7
    const apronDrop = 4.5 + approach * (1 - coveMask) * 5
    h -= face * wallDrop + apron * apronDrop
    if (face > 0.02) {
      h += (noise2(bearing * 3.2 + 2.1, r * 0.02) - 0.5) * face * 1.8
    }
  }

  // Abyss between wreck and island — past the wall lip the approach falls into
  // real depth (blue → black). Spar-to-shelf water stops reading as a shallows.
  {
    const throat =
      THREE.MathUtils.smoothstep(r, 295, 360) * (1 - THREE.MathUtils.smoothstep(r, 470, 575))
    const trench = throat * approach * (1 - coveMask * 0.92)
    h -= trench * 26
    // Soft scallop along the canyon so the floor isn't a perfect dish
    if (trench > 0.02) {
      h += (noise2(bearing * 2.4 - 1.1, r * 0.015) - 0.5) * trench * 3.2
    }
  }

  // Then fall away into deep water so the patch edge isn't a bathtub rim
  h -= THREE.MathUtils.smoothstep(r, 330, 620) * 30
  return h
}

/**
 * A leaf: a tapered sheet that arcs over and droops as it goes.
 *
 * Everything green on this island used to be a three-sided cone, which from
 * the ground reads as a field of spikes — the silhouette of a blade of grass
 * is a curve, and a cone can't make one. A plane bent along its length costs
 * about the same and is the single biggest difference between scenery and
 * undergrowth.
 *
 * The normals are the other half of it. A flat sheet lit by a directional
 * light goes black the moment it turns edge-on, so a lawn of them flickers
 * between bright and dark as you walk. Leaning every normal toward the sky
 * gives the whole clump one soft shared response instead.
 */
function leafBlade(width: number, height: number, bend: number, segments = 3, skyward = 0.62) {
  const geo = new THREE.PlaneGeometry(width, height, 1, segments)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + height / 2) / height
    pos.setX(i, pos.getX(i) * (1 - t * 0.88))
    pos.setZ(i, pos.getZ(i) + t * t * bend)
    pos.setY(i, pos.getY(i) - t * t * Math.abs(bend) * 0.3)
  }
  geo.translate(0, height / 2, 0)
  geo.computeVertexNormals()

  const nrm = geo.attributes.normal
  for (let i = 0; i < nrm.count; i++) {
    const x = nrm.getX(i) * (1 - skyward)
    const y = nrm.getY(i) * (1 - skyward) + skyward
    const z = nrm.getZ(i) * (1 - skyward)
    const len = Math.hypot(x, y, z) || 1
    nrm.setXYZ(i, x / len, y / len, z / len)
  }
  return geo
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
  const blades = 11
  for (let i = 0; i < blades; i++) {
    // Fronds arc out and then fall away, so the crown reads as a shuttlecock
    // rather than a starburst. The blade is built lying along +Y and the tilt
    // below swings it out to its bearing.
    const long = 2.9 + rand(i) * 1.3
    const blade = leafBlade(0.68 + rand(i + 3) * 0.22, long, -0.9 - rand(i + 5) * 0.7, 4, 0.45)
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

  return { trunk, leaves, nuts, height: crown.y }
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

  return { trunk, canopy, height }
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

/**
 * A grass tuft: a handful of blades arcing away from a common root.
 *
 * Fewer, wider blades per tuft and more tufts covers far more ground for the
 * same triangle budget, and coverage is what the eye reads — a hillside with
 * gaps between clumps looks mown no matter how good the clumps are.
 */
function grassTuft(seed: number) {
  const rand = (n: number) => fbm(seed * 5.9 + n * 2.7, seed * 3.3 - n * 1.9)
  const blades: THREE.BufferGeometry[] = []
  const count = 4 + Math.floor(rand(1) * 3)
  for (let i = 0; i < count; i++) {
    const h = 0.6 + rand(i + 2) * 1.2
    const blade = leafBlade(0.14 + rand(i + 4) * 0.1, h, 0.26 + rand(i + 5) * 0.5, 2)
    blade.rotateY(rand(i + 8) * Math.PI * 2)
    blade.rotateZ((rand(i + 6) - 0.5) * 0.4)
    blade.translate((rand(i + 10) - 0.5) * 0.5, 0, (rand(i + 12) - 0.5) * 0.5)
    blades.push(blade)
  }
  return mergeGeometries(blades, false) as THREE.BufferGeometry
}

/**
 * A weathered stone. The old version was a gently-wobbled icosahedron and it
 * read as dough: smooth, pale, and perched on the sand. Three things make a
 * rock read as rock — creases (ridged noise, baked dark in the seams), a
 * cleavage plane or two (broken faces where the stone sheared), and a sit
 * that buries the bottom curve instead of showing it.
 *
 * `detail` trades vertices for nearness: beach stones get 2 (you stand over
 * them), hillside boulders stay at 1 since they're read at thirty metres.
 * The baked `aCrease` attribute survives `bakePlant` — shadeStone folds it
 * into the vertex colours after the tint is written.
 */
function stoneGeometry(seed: number, radius: number, detail: number) {
  const rand = (n: number) => fbm(seed * 12.7 + n * 3.9, seed * 6.3 - n * 2.2)
  // Welded before displacement so normals come out smooth — flat facets are
  // what made the old ones read as cut gems rather than weathered stone
  const geo = mergeVertices(new THREE.IcosahedronGeometry(radius, detail))
  const pos = geo.attributes.position
  const v = new THREE.Vector3()
  // Cleavage planes — flat faces where the stone broke. One always, a second
  // on about half of them, each pushed in a little past the surface.
  const planeA = new THREE.Vector3(rand(1) - 0.5, rand(2) - 0.5, rand(3) - 0.5).normalize()
  const planeB = new THREE.Vector3(rand(4) - 0.5, rand(5) - 0.5, rand(6) - 0.5).normalize()
  const cutA = (rand(7) - 0.3) * radius * 0.85
  const cutB = (rand(8) - 0.35) * radius * 0.85
  const hasB = rand(9) > 0.45
  const squash = 0.52 + rand(10) * 0.3
  const crease = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const ux = v.x / radius
    const uy = v.y / radius
    const uz = v.z / radius
    const coarse = fbm(ux * 1.8 + seed, uz * 1.8 - seed)
    const mid = fbm(uy * 3.6 + seed * 3, ux * 3.4)
    // Ridged noise folds back on itself — the creases are the cracks
    const fold = 1 - Math.abs(2 * fbm(ux * 3.1 + seed * 5, uz * 3.1 + uy * 2.6) - 1)
    const fine = fbm(ux * 6.4 + seed * 7, uz * 6.4)
    v.multiplyScalar(0.84 + coarse * 0.22 + mid * 0.12 + fold * 0.17 + fine * 0.08)
    const dA = v.dot(planeA) - cutA
    if (dA > 0) v.addScaledVector(planeA, -dA * 0.9)
    if (hasB) {
      const dB = v.dot(planeB) - cutB
      if (dB > 0) v.addScaledVector(planeB, -dB * 0.85)
    }
    v.y *= squash
    pos.setXYZ(i, v.x, v.y, v.z)
    // Creases and undersides darken, exposed crowns keep the light
    crease[i] = THREE.MathUtils.clamp(
      0.66 + fold * 0.42 + fine * 0.28 - coarse * 0.22 + (uy > 0 ? 0.06 : -0.12),
      0.48,
      1.14,
    )
  }
  geo.setAttribute('aCrease', new THREE.BufferAttribute(crease, 1))
  geo.computeVertexNormals()
  geo.rotateY(rand(11) * Math.PI * 2)
  geo.rotateX((rand(12) - 0.5) * 0.5)
  geo.computeBoundingBox()
  const box = geo.boundingBox as THREE.Box3
  const height = Math.max(box.max.y - box.min.y, 0.1)
  // Bury the bottom curve. A stone that shows its whole underside floats;
  // anywhere from a settled perch to nearly swallowed by the sand is right.
  const sink = box.min.y + height * (0.14 + rand(13) * 0.3)
  return { geo, sink }
}

/**
 * Fold the baked creases into the plant tint and give each stone its own
 * tone, wet basalt through sun-bleached sandstone, so a beach of them stops
 * reading as one object copied fifty times.
 */
function shadeStone(geo: THREE.BufferGeometry, seed: number) {
  const crease = geo.getAttribute('aCrease') as THREE.BufferAttribute
  const color = geo.getAttribute('color') as THREE.BufferAttribute
  if (!crease || !color) return
  const tone = fbm(seed * 3.3, seed * 8.1)
  const r = THREE.MathUtils.lerp(0.5, 1.14, tone)
  const g = THREE.MathUtils.lerp(0.54, 1.05, tone)
  const b = THREE.MathUtils.lerp(0.62, 0.88, tone)
  for (let i = 0; i < color.count; i++) {
    const c = crease.getX(i)
    color.setXYZ(i, color.getX(i) * c * r, color.getY(i) * c * g, color.getZ(i) * c * b)
  }
  geo.deleteAttribute('aCrease')
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

/**
 * Low dune scrub. A few squashed blobs of mass with leaves fringing out of
 * them — the mass is what reads at fifty metres, the fringe is what stops it
 * looking like a boulder at five.
 */
function scrubBush(seed: number) {
  const rand = (n: number) => fbm(seed * 6.8 + n * 5.1, seed * 3.2 - n * 2.7)
  const parts: THREE.BufferGeometry[] = []
  const clumps = 3 + Math.floor(rand(1) * 3)
  for (let i = 0; i < clumps; i++) {
    const r = 0.26 + rand(i + 2) * 0.34
    const blob = new THREE.IcosahedronGeometry(r, 0)
    const pos = blob.attributes.position
    for (let v = 0; v < pos.count; v++) {
      const s = 0.75 + rand(i * 23 + v) * 0.5
      pos.setXYZ(v, pos.getX(v) * s, pos.getY(v) * s * 0.72, pos.getZ(v) * s)
    }
    blob.computeVertexNormals()
    blob.translate((rand(i + 6) - 0.5) * 1.1, r * 0.7 + rand(i + 3) * 0.35, (rand(i + 7) - 0.5) * 1.1)
    // Polyhedra come out non-indexed, so the blades have to match to merge
    parts.push(blob)
  }
  const fringe = 8 + Math.floor(rand(2) * 5)
  for (let i = 0; i < fringe; i++) {
    const h = 0.85 + rand(i + 11) * 1.0
    const leaf = leafBlade(0.19 + rand(i + 13) * 0.14, h, 0.45 + rand(i + 15) * 0.5)
    leaf.rotateZ(0.25 + rand(i + 17) * 0.6)
    leaf.rotateY(rand(i + 19) * Math.PI * 2)
    leaf.translate((rand(i + 21) - 0.5) * 1.1, 0.1, (rand(i + 23) - 0.5) * 1.1)
    parts.push(leaf.toNonIndexed())
  }
  return mergeGeometries(parts, false) as THREE.BufferGeometry
}

/** A fern — wider, drooping fronds that fill the understory between trees. */
function fernClump(seed: number) {
  const rand = (n: number) => fbm(seed * 4.7 + n * 2.1, seed * 6.2 - n * 3.4)
  const fronds: THREE.BufferGeometry[] = []
  const count = 5 + Math.floor(rand(1) * 4)
  for (let i = 0; i < count; i++) {
    const h = 0.7 + rand(i + 2) * 1.15
    // Wide and heavily arched — a fern's whole read is the droop
    const frond = leafBlade(0.42 + rand(i + 4) * 0.28, h, 0.55 + rand(i + 5) * 0.5, 4)
    frond.rotateZ(0.5 + rand(i + 6) * 0.65)
    frond.rotateY(rand(i + 8) * Math.PI * 2)
    frond.translate((rand(i + 10) - 0.5) * 0.35, 0, (rand(i + 12) - 0.5) * 0.35)
    fronds.push(frond)
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
  return stoneGeometry(seed, 1.8 + fbm(seed * 10.2, seed * 6.6) * 2.8, 1)
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
    const blade = leafBlade(0.07 + rand(i + 4) * 0.05, h, 0.12 + rand(i + 5) * 0.2, 2)
    blade.rotateZ((rand(i + 6) - 0.5) * 0.28)
    blade.rotateY(rand(i + 8) * Math.PI * 2)
    blade.translate((rand(i + 10) - 0.5) * 0.7, 0, (rand(i + 12) - 0.5) * 0.7)
    blades.push(blade)
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
  return { trunk, canopy, height }
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
  // Lit, not unlit: an unlit wing keeps its full daylight colour after dark
  // and turns into a scrap of neon drifting over a black hillside.
  const wingMat = new THREE.MeshLambertMaterial({
    color: tone,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
  })
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
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xd8d2c4 })
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), bodyMat)
  body.scale.set(1, 0.7, 1.6)
  group.add(body)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.07, 5, 4), bodyMat)
  head.position.set(0, 0.04, 0.16)
  group.add(head)
  const wingGeo = new THREE.PlaneGeometry(0.55, 0.16)
  const wingMat = new THREE.MeshLambertMaterial({ color: 0xc9c2b4, side: THREE.DoubleSide })
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
  const haze = opts.hazeColor.clone()
  const foliage = createFoliage(haze, { lowPower: opts.lowPower })
  const group = new THREE.Group()
  group.name = 'Island'
  group.position.set(opts.x, 0, opts.z)
  scene.add(group)

  // —— terrain ————————————————————————————————————————————————
  const segments = low ? 120 : 184
  const step = (SPAN * 2) / segments

  /**
   * The terrain grid, evaluated once.
   *
   * Planting is rejection sampling — tens of thousands of candidates, each
   * asking for a height and two more for the local slope — and `ground` is a
   * dozen noise octaves. Going back to the analytic function every time cost
   * most of a second of load. The grid is thirty-odd thousand floats.
   */
  const gridN = segments + 1
  const heights = new Float32Array(gridN * gridN)
  for (let j = 0; j < gridN; j++) {
    for (let i = 0; i < gridN; i++) {
      heights[j * gridN + i] = ground(-SPAN + i * step, -SPAN + j * step)
    }
  }
  const gridHeight = (i: number, j: number) =>
    i < 0 || j < 0 || i >= gridN || j >= gridN
      ? ground(-SPAN + i * step, -SPAN + j * step)
      : heights[j * gridN + i]

  /**
   * The height the island is actually *drawn* at.
   *
   * The mesh only samples `ground` every few metres, so between grid lines the
   * rendered surface and the analytic function disagree by up to a metre on a
   * steep slope. Anything that trusts the function instead of the mesh — feet,
   * planted props, a pool of rainwater — ends up floating or buried. So the
   * mesh, the collider and the planting all read the same four corners.
   */
  function surface(lx: number, lz: number) {
    const gx = (lx + SPAN) / step
    const gz = (lz + SPAN) / step
    const i = Math.floor(gx)
    const j = Math.floor(gz)
    const fx = gx - i
    const fz = gz - j
    const h00 = gridHeight(i, j)
    const h10 = gridHeight(i + 1, j)
    const h01 = gridHeight(i, j + 1)
    const h11 = gridHeight(i + 1, j + 1)
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz
  }

  const heightAt = (x: number, z: number) => surface(x - opts.x, z - opts.z)

  const geometry = new THREE.PlaneGeometry(SPAN * 2, SPAN * 2, segments, segments)
  geometry.rotateX(-Math.PI / 2)

  const position = geometry.attributes.position
  for (let i = 0; i < position.count; i++) {
    position.setY(i, surface(position.getX(i), position.getZ(i)))
  }
  geometry.computeVertexNormals()

  // Sand, scrub and basalt painted per vertex — one material, one draw call
  const normal = geometry.attributes.normal
  const seabed = new THREE.Color('#4f6458')
  const tide = new THREE.Color('#7a6648')
  const wetSand = new THREE.Color('#b89468')
  const drySand = new THREE.Color('#f2e2b4')
  const moss = new THREE.Color('#5a8a3e')
  const fern = new THREE.Color('#3f6b2b')
  const scrub = new THREE.Color('#77a04c')
  const bush = new THREE.Color('#456b2c')
  const litter = new THREE.Color('#7a6238')
  const rock = new THREE.Color('#8d8471')
  const basalt = new THREE.Color('#5b5145')
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

    // Underwater shelf → wet sand → dry beach. Live tide darkens this further
    // in the ground shader; this bake is the resting palette.
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

  // The air hemisphere's ground colour is near-black, because for the ocean it
  // should be. The sky cube map now does most of the skylight work, so this is
  // only the last bit of lift that keeps an unlit face from crushing to a
  // silhouette — much smaller than it used to be, and warmer, or the whole
  // island reads as a cold day.
  const skylight = { emissive: new THREE.Color('#1b2a2b'), emissiveIntensity: 0.26 }

  const terrain = new THREE.Mesh(
    geometry,
    foliage.material({
      vertexColors: true,
      roughness: 0.98,
      metalness: 0,
      ground: true,
      ...skylight,
    }),
  )
  group.add(terrain)

  // —— shoreline planting ————————————————————————————————————
  // A trunk and the crown it carries have to be quoted the same wind budget,
  // or a gust pulls the crown off the top of the tree.
  const PALM_WIND = 0.3
  const BROAD_WIND = 0.2

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
  /** Hillside boulders + chunky beach stones — ellipsoid push like the wreck reef. */
  const rockBlockers: { centre: THREE.Vector3; axes: THREE.Vector3 }[] = []

  const palmWanted = low ? 32 : 72
  const rockWanted = low ? 90 : 200
  const woodWanted = low ? 28 : 60
  const scrubWanted = low ? 300 : 880
  const broadWanted = low ? 150 : 380
  const grassWanted = low ? 7000 : 24000
  const deadWanted = low ? 18 : 40
  const vineWanted = low ? 120 : 280
  const pathWanted = low ? 32 : 60
  const fernWanted = low ? 240 : 760
  const fallenWanted = low ? 16 : 36
  const boulderWanted = low ? 32 : 70
  const wrackWanted = low ? 45 : 100
  const reedWanted = low ? 60 : 130
  const saplingWanted = low ? 110 : 260
  // broadWanted is the mid-story tree target; saplings add on top of that

  const placeAt = (geo: THREE.BufferGeometry, lx: number, h: number, lz: number, sink = 0.15) => {
    const m = new THREE.Matrix4().setPosition(lx, h - sink, lz)
    return geo.applyMatrix4(m)
  }

  /**
   * How each kind of plant varies and how hard the wind takes it. `sway` is a
   * share of its material's wind budget, so a trunk and the crown it carries
   * have to be quoted against the same budget or the crown floats off the top
   * of the tree on a gust.
   */
  type Species = Omit<PlantBake, 'tint' | 'phase' | 'height'> & {
    /** How far the per-plant colour jitter spreads. */
    spread: number
  }

  const SPECIES: Record<string, Species> = {
    palmTrunk: { spread: 0.42, sway: 1, rootShade: 0.2 },
    palmFrond: { spread: 0.8, sway: 1, flutter: 0.8 },
    nut: { spread: 0.35, sway: 1 },
    broadTrunk: { spread: 0.5, sway: 1, rootShade: 0.28 },
    canopy: { spread: 1, sway: 1, flutter: 0.55, underShade: 0.45 },
    // Tight on value. A tuft is one pixel from out at sea, and a spread wide
    // enough to look varied underfoot puts the brightest of them a long way
    // above the hillside they stand on — which from that distance is not
    // variation, it is a hill with snow on it.
    grass: { spread: 0.78, sway: 1, flutter: 0.4, rootShade: 0.38 },
    fern: { spread: 1, sway: 1, flutter: 0.45, rootShade: 0.34 },
    scrub: { spread: 0.95, sway: 1, flutter: 0.3, rootShade: 0.3, underShade: 0.22 },
    reed: { spread: 0.85, sway: 1, flutter: 0.5, rootShade: 0.28 },
    vine: { spread: 0.75, sway: 0, flutter: 1, hang: true },
    wrack: { spread: 0.7, sway: 0 },
    dead: { spread: 0.55, sway: 1, rootShade: 0.18 },
    rock: { spread: 0.4, sway: 0 },
    wood: { spread: 0.5, sway: 0 },
    path: { spread: 0.3, sway: 0 },
  }

  const tint = new THREE.Color()

  /**
   * Write a plant's variation into its vertices. Everything that ends up in a
   * merged batch goes through here: `mergeGeometries` refuses a batch whose
   * attributes don't line up, and would take the whole island down with it.
   */
  const bakeFor = (
    geo: THREE.BufferGeometry,
    seed: number,
    species: Species,
    height?: number,
  ) => {
    geo.computeBoundingBox()
    const own = geo.boundingBox ? geo.boundingBox.max.y : 1
    return bakePlant(geo, {
      tint: plantTint(seed, species.spread, tint),
      height: height ?? Math.max(own, 0.1),
      sway: species.sway,
      flutter: species.flutter,
      hang: species.hang,
      rootShade: species.rootShade,
      underShade: species.underShade,
      phase: fbm(seed * 1.7, seed * 0.31),
    })
  }

  /** Bake a plant and drop it on the hillside. Null geometry is skipped —
   *  better a gap where a local merge failed than a hard crash. */
  const plant = (
    list: THREE.BufferGeometry[],
    geo: THREE.BufferGeometry | null,
    seed: number,
    species: Species,
    lx: number,
    h: number,
    lz: number,
    sink = 0.15,
  ) => {
    if (!geo) return
    list.push(placeAt(bakeFor(geo, seed, species), lx, h, lz, sink))
  }

  /** A stone sits by its own measure — the sink comes out of the geometry. */
  const plantStone = (
    list: THREE.BufferGeometry[],
    stone: { geo: THREE.BufferGeometry; sink: number },
    seed: number,
    lx: number,
    h: number,
    lz: number,
    /** When set, register an ellipsoid blocker (boulders + big beach stones). */
    collide = false,
  ) => {
    const baked = bakeFor(stone.geo, seed, SPECIES.rock)
    shadeStone(baked, seed)
    list.push(placeAt(baked, lx, h, lz, stone.sink))
    if (!collide) return
    stone.geo.computeBoundingBox()
    const box = stone.geo.boundingBox
    if (!box) return
    const rx = Math.max((box.max.x - box.min.x) * 0.45, 0.45)
    const ry = Math.max((box.max.y - box.min.y) * 0.45, 0.4)
    const rz = Math.max((box.max.z - box.min.z) * 0.45, 0.45)
    // Hair under the visual — same trick as the wreck reef, so you clip a bump
    // rather than bounce off an invisible shell.
    rockBlockers.push({
      centre: new THREE.Vector3(opts.x + lx, h + ry * 0.55, opts.z + lz),
      axes: new THREE.Vector3(rx * 0.92, ry * 0.88, rz * 0.92),
    })
  }

  /** Trunk, crown and nuts share one placement and one whole-plant height, so
   *  the crown rides the trunk's lean instead of drifting off the top of it. */
  const plantPalm = (tree: ReturnType<typeof palm>, seed: number, place: THREE.Matrix4) => {
    trunks.push(bakeFor(tree.trunk, seed, SPECIES.palmTrunk).applyMatrix4(place))
    for (const blade of tree.leaves) {
      leaves.push(bakeFor(blade, seed, SPECIES.palmFrond, tree.height).applyMatrix4(place))
    }
    for (const nut of tree.nuts) {
      nuts.push(bakeFor(nut, seed, SPECIES.nut, tree.height).applyMatrix4(place))
    }
  }

  const plantBroadleaf = (
    tree: { trunk: THREE.BufferGeometry; canopy: THREE.BufferGeometry[]; height: number },
    seed: number,
    place: THREE.Matrix4,
  ) => {
    broadTrunks.push(bakeFor(tree.trunk, seed, SPECIES.broadTrunk).applyMatrix4(place))
    for (const blob of tree.canopy) {
      broadCanopy.push(bakeFor(blob, seed, SPECIES.canopy, tree.height).applyMatrix4(place))
    }
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
      const angle = Math.atan2(COVE_Z, COVE_X) + (scatter(i, 1.7) - 0.5) * 1.4
      const radius = 155 + fbm(i, 2.9) * 95
      const lx = Math.cos(angle) * radius + (scatter(i, 3.1) - 0.5) * 14
      const lz = Math.sin(angle) * radius + (scatter(i, 4.2) - 0.5) * 14
      if (!onCove(lx, lz) && i % 3 !== 0) continue
      const h = surface(lx, lz)
      if (h < 2.0 || h > 14) continue
      const slope = Math.abs(surface(lx + 7, lz) - h) + Math.abs(surface(lx, lz + 7) - h)
      if (slope > 5.5) continue
      if (shore.some((s) => Math.hypot(s.x - opts.x - lx, s.z - opts.z - lz) < 5.5)) continue

      const at = new THREE.Vector3(lx, h - 0.3, lz)
      const tree = palm(i + 2000)
      const place = new THREE.Matrix4().setPosition(at)
      plantPalm(tree, i + 2000, place)
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
      ? prev.x - opts.x + (scatter(i, 1.1) - 0.5) * 18
      : covePull
        ? COVE_X + (scatter(i, 1.3) - 0.5) * 110
        : Math.cos(angle) * radius
    const lz = prev
      ? prev.z - opts.z + (scatter(i, 2.2) - 0.5) * 18
      : covePull
        ? COVE_Z + (scatter(i, 2.4) - 0.5) * 110
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
    plantPalm(tree, i + 1, place)
    shore.push(new THREE.Vector3(opts.x + lx, h, opts.z + lz))
  }

  // Broadleaf mid-story — the overgrown interior. Sits above the beach band,
  // thicker in the gullies where the relief dips — and piled onto the
  // approach face so the swim-in silhouette isn't a bare cone.
  for (let i = 0; i < 6000 && broadTrunks.length < broadWanted; i++) {
    const angle = i * 2.197
    const radius = 45 + ((i * 17) % 300)
    const approachBias = i % 3 === 0
    const lx = approachBias
      ? COVE_X + (scatter(i, 3.3) - 0.5) * 210 + 50
      : Math.cos(angle) * radius
    const lz = approachBias
      ? COVE_Z + (scatter(i, 4.4) - 0.5) * 210 - 30
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
    plantBroadleaf(tree, i + 300, place)
  }

  // Saplings — fill the gaps between palms and broadleaf so the mid-story
  // doesn't read as a few trees on a painted hill
  let saplings = 0
  for (let i = 0; i < 3200 && saplings < saplingWanted; i++) {
    const angle = i * 2.083
    const radius = 60 + ((i * 21) % 270)
    const lx = Math.cos(angle) * radius + (scatter(i, 1.5) - 0.5) * 8
    const lz = Math.sin(angle) * radius + (scatter(i, 2.5) - 0.5) * 8
    const h = surface(lx, lz)
    if (h < 3.5 || h > 72) continue
    const slope = Math.abs(surface(lx + 4, lz) - h) + Math.abs(surface(lx, lz + 4) - h)
    if (slope > 6) continue
    if (shore.some((s) => Math.hypot(s.x - opts.x - lx, s.z - opts.z - lz) < 4)) continue
    const place = new THREE.Matrix4().setPosition(lx, h - 0.08, lz)
    plantBroadleaf(sapling(i + 1100), i + 1100, place)
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
    const stone = stoneGeometry(i + 40, 0.75 + fbm((i + 40) * 9.1, (i + 40) * 5.3) * 1.5, 2)
    // Only the bigger beach stones block — grit underfoot stays walkable
    const span = stone.geo.boundingBox
      ? Math.max(
          stone.geo.boundingBox.max.x - stone.geo.boundingBox.min.x,
          stone.geo.boundingBox.max.z - stone.geo.boundingBox.min.z,
        )
      : 0
    plantStone(rocks, stone, i + 40, lx, h, lz, span > 2.2)
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
    plantStone(boulderParts, boulder(i + 1500), i + 1500, lx, h, lz, true)
  }

  // Driftwood — mid-beach, sparse, sells the wash-up
  for (let i = 0; i < 1100 && wood.length < woodWanted; i++) {
    const angle = i * 2.618
    const coveBias = i % 3 === 0
    const radius = 200 + ((i * 23) % 190)
    const lx = coveBias ? COVE_X + (scatter(i, 3.3) - 0.5) * 100 : Math.cos(angle) * radius
    const lz = coveBias ? COVE_Z + (scatter(i, 4.4) - 0.5) * 100 : Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 0.6 || h > 5) continue
    const slope = Math.abs(surface(lx + 5, lz) - h) + Math.abs(surface(lx, lz + 5) - h)
    if (slope > 3.2) continue
    plant(wood, driftwood(i + 90), i + 90, SPECIES.wood, lx, h, lz, 0.08)
  }

  // Tide wrack — wet-sand mats so the waterline isn't a painted edge
  for (let i = 0; i < 1000 && wrackParts.length < wrackWanted; i++) {
    const angle = i * 2.311
    const coveBias = i % 2 === 0
    const radius = 210 + ((i * 29) % 200)
    const lx = coveBias ? COVE_X + (scatter(i, 5.5) - 0.5) * 120 : Math.cos(angle) * radius
    const lz = coveBias ? COVE_Z + (scatter(i, 6.6) - 0.5) * 120 : Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 0.15 || h > 2.4) continue
    plant(wrackParts, tideWrack(i + 1700), i + 1700, SPECIES.wrack, lx, h, lz, 0.02)
  }

  // Reeds in the wet band — vertical rhythm along the wash
  for (let i = 0; i < 1100 && reedParts.length < reedWanted; i++) {
    const angle = i * 2.155
    const coveBias = i % 3 !== 2
    const radius = 200 + ((i * 31) % 210)
    const lx = coveBias ? COVE_X + (scatter(i, 7.7) - 0.5) * 115 : Math.cos(angle) * radius
    const lz = coveBias ? COVE_Z + (scatter(i, 8.8) - 0.5) * 115 : Math.sin(angle) * radius
    const h = surface(lx, lz)
    if (h < 0.3 || h > 3.2) continue
    const slope = Math.abs(surface(lx + 3, lz) - h) + Math.abs(surface(lx, lz + 3) - h)
    if (slope > 2.8) continue
    plant(reedParts, reedClump(i + 1800), i + 1800, SPECIES.reed, lx, h, lz, 0.02)
  }

  // Dune scrub — sits where sand turns green, softens the colour cliff, and
  // carries on up the shoulders so the slopes above the beach aren't bare
  for (let i = 0; i < 5200 && scrubParts.length < scrubWanted; i++) {
    const angle = i * 2.071
    const radius = 80 + ((i * 19) % 280)
    const coveBias = i % 3 === 0
    const lx = coveBias
      ? COVE_X + (scatter(i, 1.9) - 0.5) * 170
      : Math.cos(angle) * radius + (scatter(i, 1.9) - 0.5) * 12
    const lz = coveBias
      ? COVE_Z + (scatter(i, 2.8) - 0.5) * 170
      : Math.sin(angle) * radius + (scatter(i, 2.8) - 0.5) * 12
    const h = surface(lx, lz)
    if (h < 2.8 || h > 62) continue
    const slope = Math.abs(surface(lx + 6, lz) - h) + Math.abs(surface(lx, lz + 6) - h)
    if (slope > 7.5) continue
    plant(scrubParts, scrubBush(i + 120), i + 120, SPECIES.scrub, lx, h, lz, 0.05)
  }

  // Ferns — understory between the trees, denser in the green band
  for (let i = 0; i < 5000 && fernParts.length < fernWanted; i++) {
    const angle = i * 2.279
    const radius = 50 + ((i * 27) % 285)
    const approachBias = onApproach(Math.cos(angle) * radius, Math.sin(angle) * radius) || i % 3 === 0
    const lx = approachBias
      ? COVE_X + (scatter(i, 9.1) - 0.5) * 180
      : Math.cos(angle) * radius + (scatter(i, 9.1) - 0.5) * 10
    const lz = approachBias
      ? COVE_Z + (scatter(i, 10.2) - 0.5) * 180
      : Math.sin(angle) * radius + (scatter(i, 10.2) - 0.5) * 10
    const h = surface(lx, lz)
    if (h < 3.5 || h > 82) continue
    const slope = Math.abs(surface(lx + 3, lz) - h) + Math.abs(surface(lx, lz + 3) - h)
    if (slope > 7.5) continue
    plant(fernParts, fernClump(i + 1900), i + 1900, SPECIES.fern, lx, h, lz, 0.03)
  }

  // Grass — ground cover across the whole green band.
  //
  // `radius = 30 + (i * 29) % 300` walks a sawtooth, which lays tufts down in
  // concentric rings and leaves the gaps between them bare; and area grows with
  // r, so even a clean uniform angle spends most of the budget crowding the
  // middle. Golden angle on a square-rooted radius is the standard fix: even
  // density per unit of ground, which is the only thing that reads as cover.
  const grassInner = 26
  const grassOuter = 302
  for (let i = 0; i < 90000 && grassParts.length < grassWanted; i++) {
    const angle = i * 2.39996
    const t = (i % 4096) / 4096
    const radius = Math.sqrt(grassInner * grassInner + t * (grassOuter * grassOuter - grassInner * grassInner))
    // Two in five go to the landing shelf. It is a fraction of the island's
    // area and where nearly all the standing around happens, so it carries a
    // much higher density than the ring pass would ever give it.
    const carpet = i % 5 < 2
    const lx = carpet
      ? COVE_X + (scatter(i, 7.7) - 0.5) * 125
      : Math.cos(angle) * radius + (scatter(i, 7.7) - 0.5) * 7
    const lz = carpet
      ? COVE_Z + (scatter(i, 8.8) - 0.5) * 125
      : Math.sin(angle) * radius + (scatter(i, 8.8) - 0.5) * 7
    const h = surface(lx, lz)
    if (h < 1.6 || h > 110) continue
    const slope = Math.abs(surface(lx + 3, lz) - h) + Math.abs(surface(lx, lz + 3) - h)
    if (slope > 9) continue
    plant(grassParts, grassTuft(i + 500), i + 500, SPECIES.grass, lx, h, lz, 0.02)
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
    plant(fallenParts, fallenLog(i + 2100), i + 2100, SPECIES.wood, lx, h, lz, 0.12)
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
    plant(deadParts, deadTree(i + 700), i + 700, SPECIES.dead, lx, h, lz, 0.1)
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
    plant(vineParts, vine(i + 900), i + 900, SPECIES.vine, lx, anchor, lz, 0)
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
        const wobble = (scatter(i * 0.7, 11.1) - 0.5) * 3.2
        const lx = sx + Math.sin(heading) * -dist + Math.cos(heading) * wobble
        const lz = sz + Math.cos(heading) * -dist - Math.sin(heading) * wobble
        const h = surface(lx, lz)
        if (h < 1.2 || h > 35) continue
        const stone = new THREE.CylinderGeometry(0.5 + fbm(i, 5.5) * 0.5, 0.6 + fbm(i, 6.6) * 0.5, 0.16, 6)
        stone.rotateY(fbm(i, 7.7) * Math.PI)
        plant(pathParts, stone, i + 2400, SPECIES.path, lx, h, lz, 0.05)
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

  /**
   * Every plant layer, batched. Each entry is one draw call and one material:
   * `wind` is metres of sway at full vertex weight and has to match between a
   * trunk and the crown it carries, `translucency` is how much sun comes
   * through the leaf, and `throughColor` is what colour it is by the time it
   * gets out — always yellower than the leaf itself.
   */
  const layers: {
    parts: THREE.BufferGeometry[]
    color: number
    roughness: number
    wind?: number
    translucency?: number
    throughColor?: string
    shadowedBleed?: boolean
    doubleSided?: boolean
    /** Metres past which this layer stops being drawn at all. */
    range?: number
  }[] = [
    // Bark is rough but it is not chalk. Left at 0.95 a trunk picks up nothing
    // at all from the sky probe, so backlit it goes to a flat black cutout —
    // exactly the silhouette the environment map was added to prevent. Enough
    // gloss to catch a rim off the sky is all it takes to give it a round side.
    { parts: trunks, color: 0x8a6f4c, roughness: 0.74, wind: PALM_WIND },
    {
      parts: leaves,
      color: 0x74a83f,
      roughness: 0.82,
      wind: PALM_WIND,
      translucency: 0.95,
      throughColor: '#dcec7c',
      shadowedBleed: true,
      doubleSided: true,
    },
    { parts: nuts, color: 0x7c6038, roughness: 1, wind: PALM_WIND },
    { parts: broadTrunks, color: 0x6d573a, roughness: 0.76, wind: BROAD_WIND },
    {
      parts: broadCanopy,
      color: 0x5c9438,
      roughness: 0.88,
      wind: BROAD_WIND,
      translucency: 0.85,
      throughColor: '#bfdd6a',
      shadowedBleed: true,
    },
    {
      parts: grassParts,
      range: 330,
      color: 0x62903a,
      roughness: 0.93,
      wind: 0.15,
      // Grass is the one layer you are always inside. A canopy can afford to
      // glow because you see it from underneath against the sky; a blade lit
      // this hard at arm's length turns the same pale yellow whatever it's
      // doing, and a hillside of them speckles white from out at sea.
      translucency: 0.42,
      throughColor: '#cbdd7a',
      doubleSided: true,
    },
    {
      parts: fernParts,
      range: 380,
      color: 0x4c7a2f,
      roughness: 0.9,
      wind: 0.13,
      translucency: 0.6,
      throughColor: '#cbe374',
      doubleSided: true,
    },
    {
      parts: scrubParts,
      range: 450,
      color: 0x547a38,
      roughness: 0.92,
      wind: 0.11,
      translucency: 0.5,
      throughColor: '#c2d96c',
      doubleSided: true,
    },
    {
      parts: reedParts,
      range: 300,
      color: 0x7a8d4a,
      roughness: 0.9,
      wind: 0.17,
      translucency: 0.55,
      throughColor: '#dbe382',
      doubleSided: true,
    },
    {
      parts: vineParts,
      range: 380,
      color: 0x4d7530,
      roughness: 0.9,
      wind: 0.22,
      translucency: 0.7,
      throughColor: '#c6de70',
      doubleSided: true,
    },
    { parts: wrackParts,
      range: 300, color: 0x4f5c3a, roughness: 0.95 },
    { parts: rocks, color: 0x8b8371, roughness: 0.97 },
    { parts: boulderParts, color: 0x79715f, roughness: 0.97 },
    { parts: wood, color: 0xa08a6a, roughness: 1 },
    { parts: fallenParts, color: 0x63513a, roughness: 1 },
    { parts: deadParts, color: 0xa89b86, roughness: 1, wind: 0.05 },
    { parts: pathParts,
      range: 320, color: 0x8f8674, roughness: 0.98 },
  ]

  /**
   * Undergrowth stops being worth drawing long before it stops being drawn.
   * A grass blade is a couple of pixels at three hundred metres and none at
   * four, but the whole batch still goes through the vertex stage every frame
   * — including from out at the wreck, where the island is a smudge on the
   * horizon and the ground cover is most of its triangle count. Each layer
   * names the range past which it is only costing frames.
   */
  const fadeOut: { mesh: THREE.Mesh; range: number }[] = []

  for (const layer of layers) {
    if (layer.parts.length === 0) continue
    const material = foliage.material({
      color: layer.color,
      roughness: layer.roughness,
      vertexColors: true,
      side: layer.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      wind: layer.wind,
      translucency: layer.translucency,
      throughColor: layer.throughColor,
      shadowedBleed: layer.shadowedBleed,
      ...skylight,
    })
    const mesh = foliage.mesh(
      mergeGeometries(layer.parts, false) as THREE.BufferGeometry,
      material,
    )
    group.add(mesh)
    if (layer.range) fadeOut.push({ mesh, range: layer.range })
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
    const rimMaterial = foliage.material({ color: 0x6e6656, roughness: 0.95, ...skylight })

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
    const stoneMat = foliage.material({ color: 0x6a6358, roughness: 0.97, ...skylight })
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
        foliage.material({ color: 0x5a4634, roughness: 1, ...skylight }),
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

    // Boulders / big stones — same ellipsoid push as the wreck reef. Skip when
    // you're clearly above the crown (ridge walks) or well below (diving past).
    for (const b of rockBlockers) {
      if (p.y > b.centre.y + b.axes.y + 1.1) continue
      if (p.y < b.centre.y - b.axes.y - 1.2) continue
      const dx = (p.x - b.centre.x) / b.axes.x
      const dy = (p.y - b.centre.y) / b.axes.y
      const dz = (p.z - b.centre.z) / b.axes.z
      const d = Math.hypot(dx, dy, dz)
      if (d >= 1 || d < 1e-4) continue
      const push = 1.002 / d
      p.x = b.centre.x + dx * push * b.axes.x
      p.y = b.centre.y + dy * push * b.axes.y
      p.z = b.centre.z + dz * push * b.axes.z
    }
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
      const lx = coveBias ? COVE_X + (scatter(i, 1.1) - 0.5) * 130 : Math.cos(angle) * radius
      const lz = coveBias ? COVE_Z + (scatter(i, 2.2) - 0.5) * 130 : Math.sin(angle) * radius
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
      const lx = approachBias ? COVE_X + (scatter(i, 5.5) - 0.5) * 160 : Math.cos(angle) * radius
      const lz = approachBias ? COVE_Z + (scatter(i, 6.6) - 0.5) * 160 : Math.sin(angle) * radius
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
      const lx = COVE_X + (scatter(i, 9.1) - 0.5) * 180 + (i % 3) * 20
      const lz = COVE_Z + (scatter(i, 10.2) - 0.5) * 180
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
      const lx = coveBias ? COVE_X + (scatter(i, 4.1) - 0.5) * 140 : Math.cos(angle) * radius
      const lz = coveBias ? COVE_Z + (scatter(i, 5.2) - 0.5) * 140 : Math.sin(angle) * radius
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
    reset() {
      for (const c of crabs) {
        c.x = c.homeX
        c.z = c.homeZ
        c.spook = 0
        c.goneUntil = 0
        c.mesh.visible = true
      }
    },
    snapshot() {
      return crabs.map((c) => ({
        returnIn:
          c.goneUntil < 0
            ? 75 + c.phase * 8
            : c.goneUntil > wildlifeTime
              ? c.goneUntil - wildlifeTime
              : 0,
      }))
    },
    restore(saved?: { returnIn: number }[]) {
      crabs.forEach((c, i) => {
        const remaining = Math.max(0, saved?.[i]?.returnIn ?? 0)
        c.x = c.homeX
        c.z = c.homeZ
        c.spook = 0
        c.goneUntil = remaining > 0 ? wildlifeTime + remaining : 0
        c.mesh.visible = remaining <= 0
      })
    },
  }

  let wildlifeTime = 0

  function update(camera: THREE.Camera, underwater: boolean, time = 0) {
    // Nothing is visible 700 m through water. Close in it's the shelf and the
    // abyss wall on the wreck approach — keep the terrain once you're diving it.
    const range = Math.hypot(camera.position.x - centre.x, camera.position.z - centre.z)
    group.visible = !underwater || range < 540

    // Drop the undergrowth once it's too far away to resolve. Measured from
    // the island's centre rather than the nearest ground, so the switch happens
    // out at sea where there's nothing to see it happen to.
    for (const layer of fadeOut) layer.mesh.visible = range < layer.range + 320

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
    haze.copy(color)
  }

  function setWeather(
    time: number,
    wind: number,
    cloudShadow: number,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    tide = 0,
  ) {
    foliage.update(time, wind, WIND_HEADING, cloudShadow, tide)
    foliage.setSun(sunDir, sunColor)
  }

  return {
    group,
    terrain,
    centre,
    heightAt,
    resolve,
    shore,
    pools,
    cairn,
    crabs: crabsApi,
    update,
    setHaze,
    setWeather,
    /** How many boulder / stone ellipsoids are live — tests / tuning. */
    get rockColliders() {
      return rockBlockers.length
    },
  }
}
