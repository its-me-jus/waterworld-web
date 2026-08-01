import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { buildSpear } from './spear'
import { fbm, sampleOcean } from './waves'

/**
 * The Wanderer — a schooner broken across a reef pinnacle, with her raked mast
 * and a shred of sail still above the swell. She's the one fixed thing in an
 * endless ocean, so she doubles as the landmark: you spot the mast from a
 * hundred metres out, reach the trail of flotsam, then dive the hull.
 *
 * Everything is modelled in local coordinates with y = 0 at mean sea level and
 * the whole group parked at a world position. Shapes are deterministic (the
 * noise comes from the shared wave fbm), so the wreck is identical every load.
 */

const UP = new THREE.Vector3(0, 1, 0)

// —— materials ————————————————————————————————————————————————

function materials() {
  return {
    // Waterlogged oak. Read light in air, because the murk takes most of it back
    plank: new THREE.MeshStandardMaterial({
      color: 0x846a49,
      roughness: 0.94,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }),
    timber: new THREE.MeshStandardMaterial({ color: 0x5e4c34, roughness: 0.96 }),
    spar: new THREE.MeshStandardMaterial({ color: 0x94795a, roughness: 0.88 }),
    // Double-sided so swimming into the reef reads as "inside a rock" rather
    // than a hole in the world
    rock: new THREE.MeshStandardMaterial({
      color: 0x5c6b60,
      roughness: 0.97,
      side: THREE.DoubleSide,
    }),
    sand: new THREE.MeshStandardMaterial({ color: 0xa89e86, roughness: 1 }),
    // The spire stands in the sun and the salt, so it reads paler than the
    // drowned reef below it. The emissive lift stands in for skylight, which
    // standard shading has none of out here — without it the seaward faces
    // crush to a silhouette from whichever side you swim in on.
    // The air hemisphere out here is lit by a near-black sea, so anything not
    // facing the sun crushes to a silhouette. Standing on the spire you are
    // *always* looking at one shaded face or another, so it carries a cool
    // skylight term of its own — the blue a real rock takes in open shade.
    perchRock: new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      emissive: 0x44525c,
      emissiveIntensity: 0.9,
    }),
    iron: new THREE.MeshStandardMaterial({
      color: 0x5a5048,
      roughness: 0.65,
      metalness: 0.55,
      // Bare metal goes black with no env light down deep; a whisper of
      // emissive reads as sheen in the murk
      emissive: 0x171a1d,
      emissiveIntensity: 0.55,
    }),
    rope: new THREE.MeshStandardMaterial({ color: 0x8d7c5c, roughness: 1 }),
    // Thin canvas glows when the sun is behind it. Standard shading has no
    // transmission, so without an emissive lift the backlit side of the sail
    // renders as a black cutout.
    cloth: new THREE.MeshStandardMaterial({
      color: 0xb5a88e,
      roughness: 0.92,
      side: THREE.DoubleSide,
      emissive: 0x4c545b,
      emissiveIntensity: 0.55,
    }),
    weed: new THREE.MeshStandardMaterial({
      color: 0x51713f,
      roughness: 0.9,
      side: THREE.DoubleSide,
    }),
    fan: new THREE.MeshStandardMaterial({
      color: 0x93526f,
      roughness: 0.85,
      side: THREE.DoubleSide,
    }),
    // Barnacle clusters — pale cones that make the sunken wood read as
    // colonised, not freshly varnished
    barnacle: new THREE.MeshStandardMaterial({
      color: 0xc7bfae,
      roughness: 0.98,
      metalness: 0.0,
    }),
    // Salvage: a sheath of sailors' leather and a little brass that survives it
    leather: new THREE.MeshStandardMaterial({ color: 0x4a3325, roughness: 0.9 }),
    brass: new THREE.MeshStandardMaterial({
      color: 0x8f7a3c,
      roughness: 0.45,
      metalness: 0.7,
      // The glint you spot from two metres out — how you find the knife at all
      emissive: 0x2e2410,
      emissiveIntensity: 0.6,
    }),
  }
}

// —— reef ————————————————————————————————————————————————————

/**
 * Lumpy rock from a subdivided icosahedron. Displacement is a function of
 * position only, so duplicated vertices move together and the shell stays
 * watertight. Left non-indexed and faceted, which suits rock.
 *
 * Most of the amplitude is in the high-frequency term on purpose: the collider
 * approximates each lump as a plain ellipsoid, so the bulk shape has to stay
 * close to one or you get stopped by rock that isn't there.
 */
function rockLump(radius: number, detail: number, seed: number) {
  const geo = new THREE.IcosahedronGeometry(radius, detail)
  const pos = geo.attributes.position
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    // Sampled on the unit sphere so a boulder gets the same relative roughness as
    // the mound. Frequencies stay near the mesh resolution — any higher and the
    // displacement aliases into per-vertex noise instead of reading as rock.
    const ux = v.x / radius
    const uy = v.y / radius
    const uz = v.z / radius
    const coarse = fbm(ux * 1.9 + seed, uz * 1.9 - seed)
    const mid = fbm(uy * 4.2 + seed * 3, ux * 4.0)
    const fine = fbm(ux * 5.2 + seed * 7, uz * 5.2)
    v.multiplyScalar(0.9 + coarse * 0.16 + mid * 0.12 + fine * 0.14)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  geo.computeVertexNormals()
  return geo
}

type LumpSpec = {
  radius: number
  seed: number
  at: [number, number, number]
  scale: [number, number, number]
}

/**
 * A compact seamount, deliberately pushed to -x/-z. You approach the wreck from
 * +x/+z, so that quadrant stays open water — swimming in shouldn't mean swimming
 * into a wall. Crest sits near -9, flanks run down to the sand at -25.
 */
const REEF: LumpSpec[] = [
  { radius: 10, seed: 1.3, at: [-9, -18, -8], scale: [1.0, 0.72, 0.93] },
  { radius: 6, seed: 4.7, at: [-17, -20, -2], scale: [1.1, 0.6, 1.1] },
  { radius: 5, seed: 8.1, at: [-3, -19.5, 1], scale: [1.3, 0.5, 0.9] },
  { radius: 3, seed: 2.2, at: [-14, -12, -13], scale: [0.75, 2.2, 0.8] },
  { radius: 2.6, seed: 6.4, at: [-4, -14.5, -15], scale: [0.8, 2.0, 0.85] },
  { radius: 3.5, seed: 9.9, at: [2, -22, -12], scale: [1.0, 0.8, 1.0] },
]

function buildReef(low: boolean) {
  const matrix = new THREE.Matrix4()
  const parts = REEF.map((spec) => {
    const geo = rockLump(spec.radius, low ? 2 : 3, spec.seed)
    matrix.makeScale(...spec.scale)
    matrix.setPosition(...spec.at)
    return geo.applyMatrix4(matrix)
  })
  return mergeGeometries(parts, false) as THREE.BufferGeometry
}

const SAND_Y = -25

/**
 * The one piece of the reef that beat the water to the surface: a basalt spire
 * off the wreck's port shoulder with a tilted shelf on top, a metre and a half
 * clear of mean sea level. It is the only place in a thousand square kilometres
 * you can be out of the ocean without crossing it.
 *
 * The shelf is deliberately small and low. You can sit out a bad hour on it and
 * get some heat back, but a big sea washes clean over the top, so it is shelter
 * the way a rock in a river is shelter — conditional, and it knows it.
 */
const PERCH = {
  // Set well off the wreck's port bow. The spire has to be far enough out that
  // its drowned flanks never reach across the sand the stern and the chest are
  // lying on — a rock that quietly floors you ten metres above the seabed makes
  // the deep finds unreachable, and nothing about that failure looks like a bug.
  x: -30,
  z: -4,
  /**
   * Shelf height above mean sea level. The swell stacks to roughly five metres
   * in an ordinary sea, so anything lower isn't land — it's a rock you get
   * washed off. At this height a gale still reaches you, and that's the point.
   */
  top: 6.5,
  /** Flat standing area. */
  flat: 3.2,
  /** Height where the rock meets the water and you're swimming again. */
  shoulderY: -2.5,
  /** Shortest run from the shelf to the sea — the cliff faces. */
  cliffRun: 4,
  /** Extra run on the ramp side, where legs can actually make the climb. */
  rampRun: 16,
  /**
   * Which way the climbable ramp faces, in local radians — out to sea, away
   * from the wreck. Everything facing the Wanderer is cliff, so hauling out
   * means swimming round to the far side and finding the one shoulder that
   * lets you up.
   */
  rampDir: 3.0,
  /** How far the flank keeps falling past the waterline, into the sand. */
  flankRun: 6,
}

/**
 * How far this bearing gets before the rock reaches the sea. The spire is a
 * cliff nearly all the way round — one shoulder shelves out into a long ramp,
 * and finding it is the whole of the climb. Real rock is not a staircase.
 *
 * The wobble keeps the waterline from being a drawn-compass circle with one
 * neat wedge cut out of it, which is exactly what it looks like without.
 */
function perchReach(lx: number, lz: number) {
  const angle = Math.atan2(lz - PERCH.z, lx - PERCH.x)
  const lobe = Math.max(0, Math.cos(angle - PERCH.rampDir)) ** 1.5
  const wobble = 0.9 + fbm(Math.cos(angle) * 2.3 + 11.4, Math.sin(angle) * 2.3 - 5.2) * 0.24
  return (PERCH.flat + PERCH.cliffRun + lobe * PERCH.rampRun) * wobble
}

/** Spire height in wreck-local coords, without the outer cutoff. */
function perchSurface(lx: number, lz: number) {
  const d = Math.hypot(lx - PERCH.x, lz - PERCH.z)
  const waterline = perchReach(lx, lz)
  // A straight grade rather than a smoothstep: an eased curve is half again as
  // steep through its middle, which is exactly where it would stop being
  // climbable and quietly strand anyone who tried
  const ramp = THREE.MathUtils.clamp((d - PERCH.flat) / (waterline - PERCH.flat), 0, 1)
  const flank = THREE.MathUtils.smoothstep(d, waterline, waterline + PERCH.flankRun)
  // The shelf tilts seaward, so it reads as broken rock rather than a table
  const tilt = (lx - PERCH.x) * 0.03 + (lz - PERCH.z) * 0.022
  // Relief in two bands. The long one gives the rock its swells and hollows
  // without ever building a gradient legs can't take; the short one is the
  // broken surface you actually see underfoot. Both stay well inside the
  // walk controller's slope limit, and the flanks get the violent stuff.
  const swellRelief = (fbm(lx * 0.085 + 3.4, lz * 0.085 - 9.1) - 0.5) * 2.2
  const grain = (fbm(lx * 0.62 + 5.1, lz * 0.62 - 2.7) - 0.5) * 0.34
  const broken = (fbm(lx * 0.3 - 7.7, lz * 0.3 + 4.4) - 0.5) * flank * 4.6
  return (
    PERCH.top +
    tilt -
    ramp * (PERCH.top - PERCH.shoulderY) -
    flank * 24 +
    swellRelief +
    grain +
    broken
  )
}

/** Walkable ground on the spire, or deep negative once you're off it. */
function perchGround(lx: number, lz: number) {
  const d = Math.hypot(lx - PERCH.x, lz - PERCH.z)
  // Cut off per bearing, not on one big circle — otherwise the flank's tail
  // spreads across the sand and buries the stern's chest
  if (d > perchReach(lx, lz) + PERCH.flankRun) return -1000
  return perchSurface(lx, lz)
}

/**
 * The spire mesh, sampled from the same function the feet stand on. A ring
 * rather than a square patch, so the flanks run all the way down instead of
 * ending in a shelf hanging in open water, and the tail is clamped below the
 * seabed where the sand plateau hides it.
 */
function buildPerch(low: boolean) {
  const span = PERCH.flat + PERCH.cliffRun + PERCH.rampRun + PERCH.flankRun
  const geo = new THREE.RingGeometry(0.04, span, low ? 40 : 72, low ? 12 : 22)
  geo.rotateX(-Math.PI / 2)
  geo.translate(PERCH.x, 0, PERCH.z)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, Math.max(-27, perchSurface(pos.getX(i), pos.getZ(i))))
  }
  geo.computeVertexNormals()

  // Painted per vertex, because a single flat colour turns the whole spire
  // into a paper cutout against the water: sun-bleached basalt up top, a wet
  // band of weed where the swell keeps washing it, dark rock below.
  const normal = geo.attributes.normal
  const bleached = new THREE.Color('#9d9583')
  const basalt = new THREE.Color('#5d564b')
  const drowned = new THREE.Color('#414a41')
  const weed = new THREE.Color('#54663f')
  const shade = new THREE.Color()
  const colors = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const mottle = fbm(x * 0.18 + 1.7, z * 0.18 - 4.3)

    shade.copy(drowned).lerp(basalt, THREE.MathUtils.smoothstep(y, -9, -1))
    shade.lerp(bleached, THREE.MathUtils.smoothstep(y, 1.2, 5.5))
    // Splash zone: the metre either side of mean sea level never dries
    const wet = 1 - Math.min(1, Math.abs(y + 0.2) / 2.4)
    shade.lerp(weed, wet * (0.35 + mottle * 0.5))
    // Steep faces shed weed and salt alike — bare stone on the cliffs
    shade.lerp(basalt, 1 - THREE.MathUtils.smoothstep(normal.getY(i), 0.3, 0.72))
    shade.multiplyScalar(0.86 + mottle * 0.28)

    colors[i * 3] = shade.r
    colors[i * 3 + 1] = shade.g
    colors[i * 3 + 2] = shade.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geo
}

/** Height of the seabed at a point, shared by the mesh and the collider. */
function sandHeight(x: number, z: number) {
  const dune = (fbm(x * 0.1 + 3, z * 0.1 + 7) - 0.5) * 1.8
  return SAND_Y + dune - THREE.MathUtils.smoothstep(Math.hypot(x, z), 28, 50) * 9
}

/** Sand plateau the reef sits on, dropping away into the murk at its rim. */
function buildSand() {
  const geo = new THREE.RingGeometry(0.4, 50, 56, 8)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, sandHeight(pos.getX(i), pos.getZ(i)) - SAND_Y)
  }
  geo.computeVertexNormals()
  return geo
}

// —— hull ————————————————————————————————————————————————————

/** [u along the keel, half beam, depth below the deck, section fullness]. */
type Station = [number, number, number, number]

const STATIONS: Station[] = [
  [0.0, 1.15, 2.05, 0.95],
  [0.14, 2.18, 2.65, 0.85],
  [0.32, 2.7, 3.0, 0.8],
  [0.52, 2.75, 3.05, 0.78],
  [0.7, 2.45, 3.0, 0.8],
  [0.86, 1.6, 2.65, 0.9],
  [1.0, 0.2, 1.9, 1.15],
]

const HULL_LENGTH = 21

function station(u: number) {
  let i = 0
  while (i < STATIONS.length - 2 && STATIONS[i + 1][0] < u) i++
  const a = STATIONS[i]
  const b = STATIONS[i + 1]
  const f = THREE.MathUtils.clamp((u - a[0]) / (b[0] - a[0]), 0, 1)
  const s = f * f * (3 - 2 * f)
  return {
    halfBeam: a[1] + (b[1] - a[1]) * s,
    depth: a[2] + (b[2] - a[2]) * s,
    flare: a[3] + (b[3] - a[3]) * s,
  }
}

/**
 * A point on the hull surface. `u` runs 0 at the transom to 1 at the stem;
 * `v` runs -1 at the port gunwale, through 0 at the keel, to +1 at starboard.
 */
function hullPoint(u: number, v: number, out: THREE.Vector3, swell = 1) {
  const st = station(u)
  const theta = Math.abs(v) * Math.PI * 0.5
  return out.set(
    Math.sign(v) * st.halfBeam * swell * Math.pow(Math.sin(theta), st.flare),
    -st.depth * swell * Math.pow(Math.cos(theta), 1.5),
    (u - 0.5) * HULL_LENGTH,
  )
}

/**
 * Planking, quad by quad, skipping anything `keep` says has been torn away.
 * Pushed slightly proud of the frames so the ribs read as structure underneath
 * and the torn edges have some thickness to them.
 */
function hullSkin(uFrom: number, uTo: number, keep: (u: number, v: number) => boolean, low: boolean) {
  const NU = low ? 26 : 40
  const NV = low ? 16 : 24
  const verts: number[] = []
  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]

  for (let iu = 0; iu < NU; iu++) {
    const u0 = uFrom + ((uTo - uFrom) * iu) / NU
    const u1 = uFrom + ((uTo - uFrom) * (iu + 1)) / NU
    for (let iv = 0; iv < NV; iv++) {
      const v0 = -1 + (2 * iv) / NV
      const v1 = -1 + (2 * (iv + 1)) / NV
      if (!keep((u0 + u1) * 0.5, (v0 + v1) * 0.5)) continue
      hullPoint(u0, v0, corners[0], 1.03)
      hullPoint(u1, v0, corners[1], 1.03)
      hullPoint(u1, v1, corners[2], 1.03)
      hullPoint(u0, v1, corners[3], 1.03)
      for (const i of [0, 1, 2, 0, 2, 3]) {
        verts.push(corners[i].x, corners[i].y, corners[i].z)
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geo.computeVertexNormals()
  return geo
}

/**
 * Deck planking at gunwale level. Without it you see straight down into an open
 * shell and the whole thing reads as a rowing boat rather than a ship; the hole
 * amidships is where the mast tore its way out.
 */
function hullDeck(uFrom: number, uTo: number, low: boolean) {
  const NU = low ? 20 : 32
  const NV = low ? 10 : 14
  const verts: number[] = []
  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]

  const at = (u: number, v: number, out: THREE.Vector3) =>
    out.set(v * station(u).halfBeam * 0.97, -0.05, (u - 0.5) * HULL_LENGTH)

  const keep = (u: number, v: number) => {
    if (u < 0.42) return false
    const hole = ((u - 0.56) * (u - 0.56)) / 0.02 + (v * v) / 0.55
    return hole > 1 + (fbm(u * 12, v * 12) - 0.5) * 0.8
  }

  for (let iu = 0; iu < NU; iu++) {
    const u0 = uFrom + ((uTo - uFrom) * iu) / NU
    const u1 = uFrom + ((uTo - uFrom) * (iu + 1)) / NU
    for (let iv = 0; iv < NV; iv++) {
      const v0 = -1 + (2 * iv) / NV
      const v1 = -1 + (2 * (iv + 1)) / NV
      if (!keep((u0 + u1) * 0.5, (v0 + v1) * 0.5)) continue
      at(u0, v0, corners[0])
      at(u1, v0, corners[1])
      at(u1, v1, corners[2])
      at(u0, v1, corners[3])
      for (const i of [0, 1, 2, 0, 2, 3]) {
        verts.push(corners[i].x, corners[i].y, corners[i].z)
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geo.computeVertexNormals()
  return geo
}

/** Frames, keel, deck beams and gunwale rails — the bones under the planking. */
function hullFrames(uFrom: number, uTo: number, count: number, low: boolean) {
  const parts: THREE.BufferGeometry[] = []
  const tube = (points: THREE.Vector3[], radius: number, radial: number) =>
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), low ? 10 : 18, radius, radial, false)

  for (let i = 0; i <= count; i++) {
    const u = uFrom + ((uTo - uFrom) * i) / count
    const rib: THREE.Vector3[] = []
    for (let j = 0; j <= 14; j++) rib.push(hullPoint(u, -1 + (2 * j) / 14, new THREE.Vector3()))
    parts.push(tube(rib, 0.075, 5))
  }

  const line = (v: number, radius: number) => {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= 12; i++) {
      pts.push(hullPoint(uFrom + ((uTo - uFrom) * i) / 12, v, new THREE.Vector3()))
    }
    return tube(pts, radius, 6)
  }
  parts.push(line(0, 0.16), line(-0.995, 0.085), line(0.995, 0.085))

  // Surviving deck beams, spaced wide enough to swim between
  const matrix = new THREE.Matrix4()
  for (let i = 1; i < 6; i++) {
    const u = uFrom + ((uTo - uFrom) * i) / 6
    const st = station(u)
    const beam = new THREE.BoxGeometry(st.halfBeam * 1.94, 0.13, 0.22)
    matrix.makeTranslation(0, -0.06, (u - 0.5) * HULL_LENGTH)
    parts.push(beam.applyMatrix4(matrix))
  }

  return mergeGeometries(parts, false) as THREE.BufferGeometry
}

/** Bow and midships: still recognisably a ship, stove in where she struck. */
function bowKeep(u: number, v: number) {
  const snapped = 0.3 + (fbm(u * 9 + 3, v * 5) - 0.5) * 0.05
  if (u < snapped) return false
  // Topsides sheared off back toward the break
  const shear = 0.52 + (fbm(v * 7, u * 6 + 11) - 0.5) * 0.16
  if (u < 0.46 && Math.abs(v) > shear) return false
  // The wound that sank her, starboard side amidships
  const hx = (u - 0.56) / 0.11
  const hy = (Math.abs(v) - 0.62) / 0.28
  if (v > 0 && hx * hx + hy * hy < 1 + (fbm(u * 14, v * 14 + 5) - 0.5) * 0.7) return false
  return true
}

/** The stern third, torn off and lying on the sand. */
function sternKeep(u: number, v: number) {
  const snapped = 0.28 - (fbm(u * 8 + 7, v * 6 + 2) - 0.5) * 0.06
  if (u > snapped) return false
  if (u > 0.15 && Math.abs(v) > 0.6 + (fbm(v * 9, u * 7) - 0.5) * 0.22) return false
  return true
}

// —— fittings ————————————————————————————————————————————————

/** Sagging line between two points — rigging, chain, whatever needs slack. */
function slackLine(from: THREE.Vector3, to: THREE.Vector3, sag: number, radius: number) {
  const mid = from.clone().lerp(to, 0.5)
  mid.y -= sag
  const quarter = from.clone().lerp(mid, 0.5)
  quarter.y -= sag * 0.35
  const threeQuarter = mid.clone().lerp(to, 0.5)
  threeQuarter.y -= sag * 0.35
  const curve = new THREE.CatmullRomCurve3([from, quarter, mid, threeQuarter, to])
  return new THREE.TubeGeometry(curve, 20, radius, 5, false)
}

function buildAnchor() {
  const parts: THREE.BufferGeometry[] = []
  const matrix = new THREE.Matrix4()
  const push = (geo: THREE.BufferGeometry, m: THREE.Matrix4) => parts.push(geo.applyMatrix4(m))

  const shank = new THREE.BoxGeometry(0.26, 3.4, 0.26)
  push(shank, matrix.makeTranslation(0, 1.7, 0))

  const ring = new THREE.TorusGeometry(0.4, 0.09, 6, 14)
  push(ring, matrix.makeTranslation(0, 3.6, 0))

  const stock = new THREE.BoxGeometry(2.3, 0.19, 0.19)
  push(stock, matrix.makeTranslation(0, 3.15, 0))

  // Two arms curving up out of the crown, each ending in a flat fluke
  for (const side of [-1, 1]) {
    const arm = new THREE.TorusGeometry(1.05, 0.13, 5, 14, Math.PI * 0.62)
    matrix.makeRotationZ(side > 0 ? -Math.PI * 0.31 : Math.PI - Math.PI * 0.31)
    matrix.setPosition(0, 1.05, 0)
    push(arm, matrix)

    const fluke = new THREE.BoxGeometry(0.66, 0.52, 0.11)
    matrix.makeRotationZ(side * -0.6)
    matrix.setPosition(side * 1.0, 0.42, 0)
    push(fluke, matrix)
  }

  return mergeGeometries(parts, false) as THREE.BufferGeometry
}

// —— growth ————————————————————————————————————————————————

/** A single kelp blade, pre-bent so a clump looks loose before it even moves. */
function blade(height: number, width: number, bend: number, segments: number) {
  const geo = new THREE.PlaneGeometry(width, height, 1, segments)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / height + 0.5
    pos.setX(i, pos.getX(i) * (0.35 + 0.95 * Math.sin(Math.PI * Math.min(1, t * 1.05))))
    pos.setZ(i, Math.sin(t * 3.2) * bend * t)
  }
  geo.translate(0, height / 2, 0)
  geo.computeVertexNormals()
  return geo
}

function kelpClump(seed: number, low: boolean) {
  const parts: THREE.BufferGeometry[] = []
  const count = low ? 2 : 4
  for (let i = 0; i < count; i++) {
    const n = fbm(seed * 3.1 + i * 5.3, seed * 1.7 - i * 2.9)
    const geo = blade(1.6 + n * 2.6, 0.3 + n * 0.2, 0.35 + n * 0.4, low ? 4 : 7)
    geo.rotateY(n * 9.1 + i * 1.6)
    geo.rotateX((n - 0.5) * 0.4)
    geo.translate((n - 0.5) * 0.5, 0, (i % 2 ? 0.3 : -0.25) * n)
    parts.push(geo)
  }
  return mergeGeometries(parts, false) as THREE.BufferGeometry
}

function seaFan(size: number) {
  const geo = new THREE.CircleGeometry(size, 12, 0, Math.PI)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    pos.setZ(i, Math.sin(x * 2.4) * 0.1 + Math.sin(y * 3.1) * 0.08)
    pos.setX(i, x * 0.85)
  }
  geo.computeVertexNormals()
  return geo
}

// —— barnacles ————————————————————————————————————————————————

/**
 * Golden-angle shell of a unit sphere. Shared across the whole wreck, then
 * placed piece by piece — thousands of shells all face slightly different ways,
 * which is exactly how a real encrustation reads.
 */
const BARNACLE_POINTS: THREE.Vector3[] = (() => {
  const pts: THREE.Vector3[] = []
  const N = 240
  const ga = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * i + 1) / N
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const a = i * ga
    pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r))
  }
  return pts
})()

type BarnacleSurface = {
  centre: THREE.Vector3
  normal: THREE.Vector3
  radius: number
  scale: [number, number, number]
  count: number
  seed: number
}

/**
 * Clustered little cones over an ellipsoidal patch. Uses InstancedMesh so we
 * never hit mergeGeometries attribute mismatches (which black-screened the app).
 */
function barnacleInstances(spec: BarnacleSurface, material: THREE.Material) {
  const q = new THREE.Quaternion()
  const roll = new THREE.Quaternion()
  const orient = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const v = new THREE.Vector3()
  const at = new THREE.Vector3()
  const scale = new THREE.Vector3()
  const matrices: THREE.Matrix4[] = []

  q.setFromUnitVectors(up, spec.normal)

  for (let i = 0; i < spec.count; i++) {
    const dir = BARNACLE_POINTS[(i * 7 + Math.floor(spec.seed * 13)) % BARNACLE_POINTS.length]
    v.copy(dir).applyQuaternion(q)
    if (v.dot(spec.normal) < 0.12 || v.lengthSq() < 1e-8) continue
    v.normalize()

    const jitter = fbm(i * 0.61 + spec.seed, i * 0.37 - spec.seed)
    const size = (0.045 + jitter * 0.085) * spec.radius
    at.set(
      spec.centre.x + v.x * spec.scale[0],
      spec.centre.y + v.y * spec.scale[1],
      spec.centre.z + v.z * spec.scale[2],
    )
    roll.setFromAxisAngle(up, i * 2.399)
    orient.setFromUnitVectors(up, v).multiply(roll)
    // Bake the cone height into the instance scale (unit cone is height 1)
    scale.set(size * 0.62, size, size * 0.62)
    matrices.push(new THREE.Matrix4().compose(at, orient, scale))
  }

  if (!matrices.length) return null

  // Unit cone with tip at +Y — scaled per-instance to barnacle size
  const geo = new THREE.ConeGeometry(1, 1, 6)
  geo.translate(0, 0.42, 0)
  const mesh = new THREE.InstancedMesh(geo, material, matrices.length)
  for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i])
  mesh.instanceMatrix.needsUpdate = true
  mesh.frustumCulled = true
  return mesh
}

/** Attach barnacle clusters across the wreck. */
function addBarnacles(parent: THREE.Object3D, material: THREE.Material, low: boolean) {
  const clusters: BarnacleSurface[] = [
    // Bow hull, both flanks and along the snapped rail
    { centre: new THREE.Vector3(-2.4, -12.2, 3.2), normal: new THREE.Vector3(-0.8, 0.45, 0.2).normalize(), radius: 1, scale: [1.6, 1.1, 1.4], count: low ? 14 : 30, seed: 1.7 },
    { centre: new THREE.Vector3(0.8, -11.6, 5.6), normal: new THREE.Vector3(0.85, 0.5, -0.1).normalize(), radius: 1, scale: [1.3, 1.0, 1.6], count: low ? 14 : 28, seed: 4.1 },
    { centre: new THREE.Vector3(-0.6, -10.8, 1.8), normal: new THREE.Vector3(0.15, 1, 0.1).normalize(), radius: 1, scale: [1.5, 0.7, 1.8], count: low ? 12 : 24, seed: 8.3 },
    // Mast, from waterline down
    { centre: new THREE.Vector3(3.4, -6.5, 1.2), normal: new THREE.Vector3(0.4, 0.1, 0.9).normalize(), radius: 1, scale: [0.5, 2.2, 0.5], count: low ? 10 : 20, seed: 2.9 },
    // Yard and the capstan crown
    { centre: new THREE.Vector3(4.4, 1.2, -0.2), normal: new THREE.Vector3(0.2, 0.3, 0.93).normalize(), radius: 1, scale: [1.4, 0.4, 0.4], count: low ? 8 : 14, seed: 6.6 },
    { centre: new THREE.Vector3(0, 0.6, 5.4), normal: new THREE.Vector3(0.2, 1, 0.15).normalize(), radius: 1, scale: [0.45, 0.3, 0.45], count: low ? 8 : 14, seed: 9.4 },
    // Anchor and the stern lying on the sand
    { centre: new THREE.Vector3(7, sandHeight(7, -22) + 0.9, -22), normal: new THREE.Vector3(0.3, 0.9, 0.3).normalize(), radius: 1, scale: [1.2, 0.8, 0.7], count: low ? 12 : 22, seed: 3.2 },
    { centre: new THREE.Vector3(4.2, -22.2, -17.6), normal: new THREE.Vector3(0.4, 0.85, -0.3).normalize(), radius: 1, scale: [1.6, 0.9, 1.3], count: low ? 14 : 26, seed: 5.8 },
  ]

  for (const c of clusters) {
    const mesh = barnacleInstances(c, material)
    if (mesh) parent.add(mesh)
  }
}

// —— flotsam ————————————————————————————————————————————————

/** What this piece of wreckage is worth to someone salvaging it. */
export type FlotsamKind = 'plank' | 'barrel' | 'crate'

type Flotsam = {
  object: THREE.Object3D
  kind: FlotsamKind
  x: number
  z: number
  lift: number
  spin: number
  phase: number
  /** How the item lies in the water, before the swell tilts it. */
  rest: THREE.Quaternion
  /** Named items the survival loop can interact with. */
  id?: string
  /** Once pried open, it stops riding the swell. */
  taken?: boolean
}

export function plankObject(length: number, width: number, mat: THREE.Material) {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(length, 0.09, width), mat)
  group.add(body)
  for (const at of [-length * 0.3, length * 0.28]) {
    const batten = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, width * 1.15), mat)
    batten.position.set(at, -0.07, 0)
    group.add(batten)
  }
  return group
}

export function barrelObject(wood: THREE.Material, iron: THREE.Material) {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.31, 0.84, 12), wood)
  group.add(body)
  for (const y of [-0.26, 0.26]) {
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.035, 5, 14), iron)
    hoop.rotation.x = Math.PI / 2
    hoop.position.y = y
    group.add(hoop)
  }
  group.rotation.z = 1.35
  return group
}

export function crateObject(mat: THREE.Material) {
  const group = new THREE.Group()
  group.add(new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.68, 0.72), mat))
  for (const axis of [0, 1]) {
    const batten = new THREE.Mesh(new THREE.BoxGeometry(axis ? 0.76 : 0.1, 0.72, axis ? 0.1 : 0.76), mat)
    group.add(batten)
  }
  group.rotation.set(0.3, 0.6, 0.2)
  return group
}

// —— assembly ————————————————————————————————————————————————

export type WreckOptions = {
  x: number
  z: number
  lowPower?: boolean
}

export function createWreck(scene: THREE.Scene, opts: WreckOptions) {
  const low = opts.lowPower ?? false
  const mat = materials()

  const group = new THREE.Group()
  group.name = 'Wreck'
  group.position.set(opts.x, 0, opts.z)
  scene.add(group)

  // —— reef and seabed ——
  const reef = new THREE.Mesh(buildReef(low), mat.rock)
  group.add(reef)

  const sand = new THREE.Mesh(buildSand(), mat.sand)
  sand.position.y = SAND_Y
  group.add(sand)

  // The spire that breaks the surface — the wreck's only dry ground
  const perch = new THREE.Mesh(buildPerch(low), mat.perchRock)
  group.add(perch)

  // —— bow section, canted on the reef shoulder ——
  const bow = new THREE.Group()
  bow.position.set(-1.2, -13.6, 0.6)
  bow.rotation.set(-0.17, 0.55, 0.44)
  group.add(bow)
  bow.add(new THREE.Mesh(hullSkin(0.3, 1, bowKeep, low), mat.plank))
  bow.add(new THREE.Mesh(hullDeck(0.3, 1, low), mat.spar))
  bow.add(new THREE.Mesh(hullFrames(0.3, 1, low ? 8 : 13, low), mat.timber))

  const capstan = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.75, 10), mat.spar)
  capstan.position.set(0, 0.2, 5.4)
  bow.add(capstan)
  const hatch = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.16, 1.2), mat.plank)
  hatch.position.set(0.1, -0.05, 2.2)
  bow.add(hatch)

  // —— stern section, torn off and lying on the sand ——
  const stern = new THREE.Group()
  stern.position.set(4, -23, -18)
  stern.rotation.set(0.12, 2.2, 1.3)
  group.add(stern)
  stern.add(new THREE.Mesh(hullSkin(0, 0.28, sternKeep, low), mat.plank))
  stern.add(new THREE.Mesh(hullFrames(0, 0.28, low ? 4 : 7, low), mat.timber))

  // —— mast: the beacon ——
  // Placed by explicit base and tip rather than parented to the canted deck, so
  // we know exactly how far out of the water the top stands.
  const mastBase = new THREE.Vector3(0.4, -13.8, 2.4)
  const mastTip = new THREE.Vector3(7.2, 8.4, -1.6)
  const mastDir = mastTip.clone().sub(mastBase)
  const mastLength = mastDir.length()
  mastDir.normalize()

  const mast = new THREE.Group()
  mast.position.copy(mastBase)
  mast.quaternion.setFromUnitVectors(UP, mastDir)
  group.add(mast)

  const mastShaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.46, mastLength, 10),
    mat.spar,
  )
  mastShaft.position.y = mastLength / 2
  mast.add(mastShaft)

  // Splintered break at the head
  for (let i = 0; i < 4; i++) {
    const splinter = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.5 + i * 0.16, 4), mat.spar)
    splinter.position.set(Math.cos(i * 1.7) * 0.12, mastLength + 0.2, Math.sin(i * 1.7) * 0.12)
    splinter.rotation.set(Math.sin(i) * 0.22, 0, Math.cos(i) * 0.22)
    mast.add(splinter)
  }

  // —— yard and sail, hanging where the swell can work at it ——
  const yardAt = mastBase.clone().addScaledVector(mastDir, mastLength * 0.8)
  const yardAxis = new THREE.Vector3().crossVectors(mastDir, UP).normalize()

  const yard = new THREE.Group()
  yard.position.copy(yardAt)
  yard.quaternion.setFromUnitVectors(UP, yardAxis)
  group.add(yard)
  const yardShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 8.4, 8), mat.spar)
  yardShaft.position.y = 1.2
  yard.add(yardShaft)

  const sailWidth = 4.8
  const sailHeight = 5.6
  const sailGeo = new THREE.PlaneGeometry(sailWidth, sailHeight, low ? 5 : 9, low ? 5 : 8)
  {
    // Torn along the foot and one leech, so it reads as a rag rather than canvas
    const pos = sailGeo.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      const t = 0.5 - y / sailHeight
      const rag = (fbm(x * 1.3 + 11, y * 1.1 + 4) - 0.5) * 1.5
      pos.setX(i, x * (1 - t * 0.22) + rag * t * 0.6)
      pos.setY(i, y + rag * t * t * 1.4)
    }
    sailGeo.translate(0, -sailHeight / 2, 0)
    sailGeo.computeVertexNormals()
  }
  const sailRest = Float32Array.from(sailGeo.attributes.position.array)

  const sail = new THREE.Mesh(sailGeo, mat.cloth)
  sail.position.copy(yardAt).addScaledVector(yardAxis, -0.9)
  // Hangs by gravity, so it keeps its own upright frame regardless of the yard
  sail.quaternion.setFromUnitVectors(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(yardAxis.x, 0, yardAxis.z).normalize(),
  )
  group.add(sail)

  // —— rigging, chain and anchor ——
  const lines: THREE.BufferGeometry[] = [
    slackLine(mastBase.clone().addScaledVector(mastDir, mastLength * 0.92), new THREE.Vector3(-4.2, -13.2, 6.4), 1.4, 0.035),
    // Still snagged on the spire that opened her up
    slackLine(mastBase.clone().addScaledVector(mastDir, mastLength * 0.55), new THREE.Vector3(-13.6, -4.6, -12.6), 1.1, 0.03),
    slackLine(yardAt.clone().addScaledVector(yardAxis, 4.1), new THREE.Vector3(2.4, -12.4, -3.6), 2.2, 0.028),
  ]
  const rigging = new THREE.Mesh(mergeGeometries(lines, false) as THREE.BufferGeometry, mat.rope)
  group.add(rigging)

  const anchor = new THREE.Mesh(buildAnchor(), mat.iron)
  anchor.position.set(7, sandHeight(7, -22) + 0.4, -22)
  anchor.rotation.set(Math.PI / 2 - 0.15, 0.7, 0)
  group.add(anchor)

  const chain = new THREE.Mesh(
    slackLine(new THREE.Vector3(6.7, -24.4, -21.7), new THREE.Vector3(4.6, -22.4, -18.6), 0.9, 0.07),
    mat.iron,
  )
  group.add(chain)

  // Barnacle crust over wood, spar and iron — what makes her read as sunken
  // for years rather than parked last week
  addBarnacles(group, mat.barnacle, low)

  // —— Phase B salvage: the knife and the sealed locker ————————————————
  // Two dives, two depths. The knife lies by the capstan on the bow deck —
  // a working dive at ~13 m. The mate's chest went down with the torn stern
  // and sits on the sand at ~24 m, where the light gives up: the wreck's
  // depth is the price of what's inside.

  // A galley knife, still in its sheath, laid flat on the deck planking
  const knife = new THREE.Group()
  {
    const sheath = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.22, 4, 8), mat.leather)
    sheath.scale.set(1, 1, 0.55)
    knife.add(sheath)
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.016, 0.032), mat.brass)
    guard.position.y = 0.135
    knife.add(guard)
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.11, 8), mat.timber)
    grip.position.y = 0.19
    knife.add(grip)
    knife.rotation.set(0.06, 0.9, Math.PI / 2 - 0.1)
    knife.position.set(0.62, 0.05, 4.35)
    bow.add(knife)
  }

  // —— the bow hold: the gear locker ————————————————————————————
  // One deck down, in the dark under the planking, where a ship keeps the
  // things nobody expects to need. The door swelled shut years ago; the knife
  // is what gets it open. Inside hangs the mate's immersion suit — the reason
  // the water stops being a clock.
  const gear = new THREE.Group()
  gear.position.set(1.15, -2.35, 1.4)
  gear.rotation.set(0.06, -0.42, 0.03)
  bow.add(gear)

  const gearCase = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.36, 0.62), mat.plank)
  gear.add(gearCase)
  for (const gy of [-0.52, 0.52]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.1, 0.68), mat.timber)
    rail.position.y = gy
    gear.add(rail)
  }

  // Door hinged on its left stile, so prying it swings the dark open at you
  const gearDoor = new THREE.Group()
  gearDoor.position.set(-0.44, 0, 0.31)
  gear.add(gearDoor)
  const gearPanel = new THREE.Mesh(new THREE.BoxGeometry(0.86, 1.3, 0.07), mat.plank)
  gearPanel.position.x = 0.43
  gearDoor.add(gearPanel)
  const gearLatch = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.06), mat.iron)
  gearLatch.position.set(0.8, 0.02, 0.05)
  gearDoor.add(gearLatch)

  // What hangs inside: bright survival neoprene, the one colour down here that
  // the murk can't fully take
  const suitFabric = new THREE.MeshStandardMaterial({
    color: 0xd4691f,
    roughness: 0.72,
    emissive: 0x2a1004,
    emissiveIntensity: 0.7,
  })
  const suitHanging = new THREE.Group()
  suitHanging.position.set(0.08, -0.05, 0.02)
  gear.add(suitHanging)
  const suitTorso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.5, 4, 10), suitFabric)
  suitTorso.scale.set(1, 1, 0.55)
  suitTorso.position.y = 0.16
  suitHanging.add(suitTorso)
  for (const sx of [-1, 1]) {
    const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.42, 3, 8), suitFabric)
    sleeve.position.set(sx * 0.2, -0.06, 0)
    sleeve.rotation.z = sx * 0.22
    suitHanging.add(sleeve)
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.44, 3, 8), suitFabric)
    leg.position.set(sx * 0.1, -0.52, 0)
    suitHanging.add(leg)
  }
  const suitHood = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), suitFabric)
  suitHood.position.y = 0.5
  suitHood.scale.set(1, 0.85, 0.8)
  suitHanging.add(suitHood)

  // A bread tin from the galley, rolled into the corner of the hold when she
  // went over. Soldered shut, which is the only reason it's still food.
  const tin = new THREE.Group()
  tin.position.set(-0.9, -2.75, 2.6)
  tin.rotation.set(1.3, 0.6, 0.2)
  bow.add(tin)
  const tinBody = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.34, 12), mat.iron)
  tin.add(tinBody)
  for (const ty of [-0.17, 0.17]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.02, 5, 14), mat.brass)
    rim.rotation.x = Math.PI / 2
    rim.position.y = ty
    tin.add(rim)
  }

  // The ship's log, in its oilskin, spilled out of the stern and lying against
  // her broken ribs. Nothing in it keeps you alive — it only tells you whose
  // watch this was. Parked on the sand rather than inside the hull, because a
  // find you can see through a gap but never quite reach is just a taunt.
  const logBook = new THREE.Group()
  logBook.position.set(2.4, sandHeight(2.4, -20.6) + 0.16, -20.6)
  logBook.rotation.set(0.12, 1.1, 0.28)
  group.add(logBook)
  const logWrap = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.26), mat.leather)
  logBook.add(logWrap)
  const logCord = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.014, 5, 14), mat.rope)
  logCord.rotation.y = Math.PI / 2
  logCord.scale.set(1, 0.62, 1)
  logBook.add(logCord)

  // The mate's chest: iron-banded, roped shut, settled into the sand a
  // couple of metres off the stern's torn ribs
  const chest = new THREE.Group()
  chest.position.set(6.8, sandHeight(6.8, -15.5) + 0.2, -15.5)
  chest.rotation.set(0.05, 0.5, 0.07)
  group.add(chest)

  const chestBody = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.42, 0.68), mat.plank)
  chest.add(chestBody)
  for (const bx of [-0.38, 0.38]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.44, 0.7), mat.iron)
    band.position.x = bx
    chest.add(band)
  }

  // Lid pivots at the back edge so the knife's work swings it wide
  const lid = new THREE.Group()
  lid.position.set(0, 0.21, -0.34)
  chest.add(lid)
  const lidSlab = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.09, 0.68), mat.plank)
  lidSlab.position.set(0, 0.045, 0.34)
  lid.add(lidSlab)
  for (const bx of [-0.38, 0.38]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.7), mat.iron)
    band.position.set(bx, 0.045, 0.34)
    lid.add(band)
  }

  // The rope lashing — what stands between bare hands and the mate's things
  const lashing = new THREE.Group()
  for (const lx of [-0.18, 0.18]) {
    const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.028, 6, 18), mat.rope)
    wrap.rotation.y = Math.PI / 2
    wrap.scale.set(1, 0.72, 0.82)
    wrap.position.set(lx, 0, 0)
    lashing.add(wrap)
  }
  chest.add(lashing)

  // What's inside, sitting just proud of the chest's open top: an oilskin
  // pouch over the mate's spear. Hidden by the closed lid until it's cut.
  const contents = new THREE.Group()
  contents.position.y = 0.19
  chest.add(contents)
  const spearProp = buildSpear()
  spearProp.scale.setScalar(0.62)
  spearProp.rotation.set(0.12, 0.3, Math.PI / 2 - 0.06)
  contents.add(spearProp)
  const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.08, 0.17), mat.leather)
  pouch.position.set(0.16, 0.06, -0.16)
  pouch.rotation.y = 0.4
  contents.add(pouch)

  // —— growth and rubble, planted by dropping rays onto the rock ——
  const clumps: { pivot: THREE.Group; phase: number }[] = []
  {
    const ray = new THREE.Raycaster()
    const down = new THREE.Vector3(0, -1, 0)
    const from = new THREE.Vector3()
    const matrix = new THREE.Matrix4()
    const boulders: THREE.BufferGeometry[] = []
    group.updateMatrixWorld(true)

    /** Golden-angle spiral out from the crest, so nothing clusters. */
    const surfaceAt = (i: number, spots: number, spread: number, offset: number) => {
      const a = i * 2.399 + offset
      const r = 3 + (i / spots) * spread
      from.set(opts.x + Math.cos(a) * r, 8, opts.z + Math.sin(a) * r)
      ray.set(from, down)
      return ray.intersectObject(reef, false)[0]
    }

    const growth = low ? 9 : 18
    for (let i = 0; i < growth; i++) {
      const hit = surfaceAt(i, growth, 17, 0)
      if (!hit || hit.point.y < -23 || hit.point.y > -4) continue

      const pivot = new THREE.Group()
      pivot.position.copy(hit.point).sub(group.position)
      pivot.rotation.y = i * 1.31
      group.add(pivot)

      if (i % 5 === 4) {
        const fan = new THREE.Mesh(seaFan(0.9 + (i % 3) * 0.35), mat.fan)
        fan.rotation.x = -0.25
        pivot.add(fan)
      } else {
        pivot.add(new THREE.Mesh(kelpClump(i + 1, low), mat.weed))
      }
      clumps.push({ pivot, phase: i * 0.9 })
    }

    // Loose rock sitting on the reef. Breaking up the silhouette this way keeps
    // the smooth ellipsoids the collider relies on, unlike displacing them more.
    const rubble = low ? 8 : 16
    for (let i = 0; i < rubble; i++) {
      const hit = surfaceAt(i, rubble, 22, 1.1)
      if (!hit || hit.point.y < -25) continue
      const n = fbm(i * 4.1, i * 2.7)
      const size = 0.7 + n * 2.4
      matrix.makeRotationY(i * 0.83)
      matrix.scale(new THREE.Vector3(0.95 + n * 0.5, 0.5 + n * 0.5, 0.9 + n * 0.35))
      matrix.setPosition(
        hit.point.x - group.position.x,
        hit.point.y - size * 0.3,
        hit.point.z - group.position.z,
      )
      boulders.push(rockLump(size, 2, i * 3.3 + 0.5).applyMatrix4(matrix))
    }
    if (boulders.length) {
      group.add(new THREE.Mesh(mergeGeometries(boulders, false) as THREE.BufferGeometry, mat.rock))
    }
  }

  // —— flotsam on the surface, riding the real swell ——
  const flotsam: Flotsam[] = []
  /** World position of the provision crate, refreshed each frame as it bobs. */
  const provision = new THREE.Vector3()
  let provisionItem: Flotsam | null = null
  {
    const add = (
      kind: FlotsamKind,
      object: THREE.Object3D,
      x: number,
      z: number,
      lift: number,
      spin: number,
      phase: number,
      id?: string,
    ) => {
      group.add(object)
      const item: Flotsam = {
        object,
        kind,
        x,
        z,
        lift,
        spin,
        phase,
        rest: object.quaternion.clone(),
        id,
      }
      flotsam.push(item)
      if (id === 'provision') provisionItem = item
    }
    // The plank he first went overboard clinging to
    add('plank', plankObject(2.7, 0.36, mat.plank), 5.5, 6.5, 0.04, 0.05, 0)
    add('plank', plankObject(1.9, 0.28, mat.plank), 11.5, 12.5, 0.03, -0.04, 1.9)
    add('plank', plankObject(1.4, 0.22, mat.plank), -6.5, 14, 0.03, 0.07, 3.4)
    add('barrel', barrelObject(mat.plank, mat.iron), 8.5, -4.5, 0.12, -0.06, 2.6)
    // The ship's provision crate — first food in the run, lashed shut and
    // still floating. Its lid battens are prised off by hand.
    add('crate', crateObject(mat.plank), 16, 3.5, 0.16, 0.05, 4.8, 'provision')
    add('plank', plankObject(2.2, 0.3, mat.plank), 19.5, -9, 0.03, -0.03, 5.6)
  }

  // —— collision ————————————————————————————————————————————
  // The rock is only six lumps, so pushing a point out of the matching ellipsoids
  // is far cheaper and much steadier than raycasting the merged mesh. Radii are
  // taken a hair under the displaced surface, so you can clip a bump rather than
  // hit an invisible wall standing off it.
  const blockers = REEF.map((spec) => ({
    centre: new THREE.Vector3(opts.x + spec.at[0], spec.at[1], opts.z + spec.at[2]),
    axes: new THREE.Vector3(...spec.scale).multiplyScalar(spec.radius * 1.05),
  }))

  function resolve(p: { x: number; y: number; z: number }) {
    for (const b of blockers) {
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

    const lx = p.x - opts.x
    const lz = p.z - opts.z
    if (Math.hypot(lx, lz) < 48) {
      p.y = Math.max(p.y, sandHeight(lx, lz) + 0.55)
    }

    // The spire is a floor rather than a wall: swim at it and the rock lifts
    // you up its flank until you're standing on it, which is how hauling out
    // of a heaving sea actually goes. Only the part of it that stands above
    // the reef gets a say — deeper than that the sand is already the floor,
    // and letting the skirt push as well is how divers get held off the seabed.
    const spire = perchGround(lx, lz)
    if (spire > -14) p.y = Math.max(p.y, spire + 0.55)
  }

  /**
   * Height of standable wreck ground in world coordinates, or deep negative
   * where there is none. Feeds the same walk controller the island uses.
   */
  function standAt(x: number, z: number) {
    return perchGround(x - opts.x, z - opts.z)
  }

  // —— salvage state —————————————————————————————————————————
  let knifeTaken = false
  let locker: 'sealed' | 'cut' | 'stripped' = 'sealed'
  let gearState: 'shut' | 'open' | 'stripped' = 'shut'
  let tinTaken = false
  let logTaken = false
  /** Time the lashing was cut, so the lid can swing open over a beat. */
  let lidFrom = -1
  /** Time the gear door was pried, so it swings rather than snaps. */
  let gearFrom = -1
  const knifeWorld = new THREE.Vector3()
  const lockerWorld = new THREE.Vector3()
  const gearWorld = new THREE.Vector3()
  const tinWorld = new THREE.Vector3()
  const logWorld = new THREE.Vector3()

  // —— per-frame ————————————————————————————————————————————
  const centre = new THREE.Vector3(opts.x, -12, opts.z)
  group.updateMatrixWorld(true)
  /** Where the deck hatch sits in the world — the one way into the hull. */
  const hatchAt = hatch.getWorldPosition(new THREE.Vector3())
  /** Mast head in world space — the landmark you spot from a kilometre out. */
  const beacon = mastTip.clone().add(group.position)

  const waveUp = new THREE.Vector3()
  const tilt = new THREE.Quaternion()
  const yaw = new THREE.Quaternion()
  const sailPos = sailGeo.attributes.position

  function update(time: number, camera: THREE.Camera) {
    // Once the lashing parts, the lid swings wide on its own — no hand model,
    // just the chest giving up its weight to buoyancy and a nudge
    if (locker !== 'sealed') {
      if (lidFrom < 0) lidFrom = time
      const f = Math.min(1, (time - lidFrom) / 1.6)
      lid.rotation.x = -1.78 * (f * f * (3 - 2 * f))
    }

    // The hold door, once the knife has persuaded it
    if (gearState !== 'shut') {
      if (gearFrom < 0) gearFrom = time
      const f = Math.min(1, (time - gearFrom) / 1.9)
      gearDoor.rotation.y = 1.42 * (f * f * (3 - 2 * f))
    }

    for (const item of flotsam) {
      if (item.taken) continue
      const water = sampleOcean(opts.x + item.x, opts.z + item.z, time)
      item.object.position.set(item.x, water.y + item.lift, item.z)
      waveUp.set(water.normal.x, water.normal.y, water.normal.z)
      tilt.setFromUnitVectors(UP, waveUp)
      yaw.setFromAxisAngle(UP, item.phase + time * item.spin)
      item.object.quaternion.copy(tilt).multiply(yaw).multiply(item.rest)
      if (item === provisionItem) {
        provision.set(opts.x + item.x, water.y + item.lift, opts.z + item.z)
      }
    }

    // Per-vertex work only earns its keep once you're close enough to read it
    if (camera.position.distanceToSquared(centre) > 140 * 140) return

    for (const clump of clumps) {
      clump.pivot.rotation.x = Math.sin(time * 0.5 + clump.phase) * 0.16
      clump.pivot.rotation.z = Math.cos(time * 0.42 + clump.phase * 1.3) * 0.13
    }

    for (let i = 0; i < sailPos.count; i++) {
      const bx = sailRest[i * 3]
      const by = sailRest[i * 3 + 1]
      // Pinned along the yard, loose along the free foot
      const slack = THREE.MathUtils.clamp(-by / sailHeight, 0, 1)
      const flap =
        Math.sin(time * 1.9 + bx * 0.85 + by * 0.5) * 0.4 + Math.sin(time * 3.1 + bx * 1.8) * 0.14
      sailPos.setX(i, bx + flap * slack * 0.1)
      sailPos.setZ(i, flap * slack)
    }
    sailPos.needsUpdate = true
    sailGeo.computeVertexNormals()
  }

  /**
   * The provision crate, while it still floats. Null once it's been pried
   * open and stripped — the hulk slips under a swell and is gone.
   */
  function provisionSpot() {
    return provisionItem && !provisionItem.taken ? provision : null
  }

  /** Pry the crate open: take the food, lose the box to the sea. */
  function takeProvision() {
    if (!provisionItem || provisionItem.taken) return false
    provisionItem.taken = true
    provisionItem.object.visible = false
    return true
  }

  /** World position of the knife on the bow deck, or null once it's yours. */
  function knifeSpot() {
    return knifeTaken ? null : knife.getWorldPosition(knifeWorld)
  }

  /** Work the knife free of the deck — one time only. */
  function takeKnife() {
    if (knifeTaken) return false
    knifeTaken = true
    knife.visible = false
    return true
  }

  /** World position of the mate's chest by the stern. */
  function lockerSpot() {
    return chest.getWorldPosition(lockerWorld)
  }

  /** Part the rope lashing: the lid swings wide. Needs the knife, one time. */
  function cutLashing() {
    if (locker !== 'sealed') return false
    locker = 'cut'
    chest.remove(lashing)
    return true
  }

  /** Take the pouch and the spear, leaving the empty chest to the dark. */
  function stripLocker() {
    if (locker !== 'cut') return false
    locker = 'stripped'
    contents.visible = false
    return true
  }

  /** World position of the gear locker in the bow hold. */
  function gearSpot() {
    return gear.getWorldPosition(gearWorld)
  }

  /** Force the swollen door. Needs the knife; one time only. */
  function pryGear() {
    if (gearState !== 'shut') return false
    gearState = 'open'
    return true
  }

  /** Take the immersion suit off its hook — the locker keeps nothing else. */
  function takeSuit() {
    if (gearState !== 'open') return false
    gearState = 'stripped'
    suitHanging.visible = false
    return true
  }

  /** The galley's bread tin in the hold, until it's been opened. */
  function tinSpot() {
    return tinTaken ? null : tin.getWorldPosition(tinWorld)
  }

  function takeTin() {
    if (tinTaken) return false
    tinTaken = true
    tin.visible = false
    return true
  }

  /** The ship's log under the stern transom, until it's been read. */
  function logSpot() {
    return logTaken ? null : logBook.getWorldPosition(logWorld)
  }

  function takeLog() {
    if (logTaken) return false
    logTaken = true
    logBook.visible = false
    return true
  }

  /** A new run: the knife is back on the deck, the locker roped shut, the
   *  provision crate riding the swell again. */
  function reset() {
    knifeTaken = false
    knife.visible = true
    locker = 'sealed'
    lidFrom = -1
    lid.rotation.x = 0
    gearState = 'shut'
    gearFrom = -1
    gearDoor.rotation.y = 0
    suitHanging.visible = true
    tinTaken = false
    tin.visible = true
    logTaken = false
    logBook.visible = true
    if (lashing.parent !== chest) chest.add(lashing)
    contents.visible = true
    if (provisionItem) {
      provisionItem.taken = false
      provisionItem.object.visible = true
    }
  }

  return {
    group,
    centre,
    beacon,
    hatch: hatchAt,
    flotsam,
    resolve,
    standAt,
    /** World position of the spire's shelf — the one place to haul out. */
    perch: new THREE.Vector3(opts.x + PERCH.x, PERCH.top, opts.z + PERCH.z),
    /** Foot of the climbable ramp, for tests and tuning. */
    perchRamp: new THREE.Vector3(
      opts.x + PERCH.x + Math.cos(PERCH.rampDir) * (PERCH.flat + PERCH.cliffRun + PERCH.rampRun),
      0,
      opts.z + PERCH.z + Math.sin(PERCH.rampDir) * (PERCH.flat + PERCH.cliffRun + PERCH.rampRun),
    ),
    update,
    provisionSpot,
    takeProvision,
    knifeSpot,
    takeKnife,
    lockerSpot,
    cutLashing,
    stripLocker,
    gearSpot,
    pryGear,
    takeSuit,
    tinSpot,
    takeTin,
    logSpot,
    takeLog,
    reset,
    get lockerState() {
      return locker
    },
    get gearLockerState() {
      return gearState
    },
  }
}
