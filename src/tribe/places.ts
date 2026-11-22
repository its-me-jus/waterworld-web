import * as THREE from 'three'
import type { IslandLike } from './types'

/**
 * Where the islanders live, worked out once from the real island.
 *
 * The props (src/story/cash-bag.ts), the smoke (src/story/heist-intro.ts) and
 * the tribe (src/tribe/tribe-sim.ts) all read these, so the fire Oru sits by,
 * the smoke you see from the parachute and the pit the props build are one
 * place. Nothing here is a hard-coded coordinate: each spot is searched for
 * on the terrain, so a reshaped island moves them with it.
 *
 * With today's island (centre 980, -680) they come out at roughly:
 *   landing   769, -520  dry sand where the skip-the-drop lands you
 *   totem     ~12 m up the beach from the landing, facing the sea
 *   camp      by the south-west rain pool (753, -749), about 215 m down the
 *             coast from the cove: far enough to be earned, close enough to walk
 *   lagoon    the reef crest beside the stranded coaster (680, -544), about a
 *             metre down: knee-deep at low water
 *   caves     the tidal caves' mouth (671, -480), six metres down
 */
export interface TribePlaces {
  /** First dry sand seaward along the cove axis (same rule as main.ts landOnBeach). */
  landing: THREE.Vector3
  /** Unit vector from the island centre out through the cove, in xz. */
  outward: THREE.Vector2
  /** Driftwood warning totem, a little up the beach from the landing. */
  totem: THREE.Vector3
  /** The rain pool the camp is built beside. */
  campPool: THREE.Vector3
  /** The fire pit itself: flat dry ground near the camp pool. */
  campFire: THREE.Vector3
  /** The elder's clearing. Being inside it is trespass for Kael. */
  sacred: { x: number; z: number; radius: number }
  /** Tala's spot on the reef crest by the coaster, about a metre down (y is the ground, not the water). */
  lagoonRocks: THREE.Vector3
  /** Mouth of the tidal caves (sea level; the entrance itself is ~6 m down). */
  cavesMouth: THREE.Vector3
  inSacredZone: (x: number, z: number) => boolean
}

const SACRED_RADIUS = 30

const cache = new WeakMap<IslandLike, TribePlaces>()

export function getTribePlaces(
  island: IslandLike,
  reefWreckPos: { x: number; z: number },
  cavesEntrance: { x: number; z: number },
): TribePlaces {
  const cached = cache.get(island)
  if (cached) return cached

  const H = (x: number, z: number) => island.heightAt(x, z)
  const slope = (x: number, z: number) =>
    Math.hypot(H(x + 1.5, z) - H(x - 1.5, z), H(x, z + 1.5) - H(x, z - 1.5)) / 3

  const cove = island.shore.length > 0 ? island.shore[0] : island.centre
  const outward = new THREE.Vector2(cove.x - island.centre.x, cove.z - island.centre.z).normalize()

  // Landing: the same walk main.ts does when the drop is skipped
  let lx = cove.x
  let lz = cove.z
  for (let d = -30; d < 90; d += 1) {
    lx = cove.x + outward.x * d
    lz = cove.z + outward.y * d
    if (H(lx, lz) < 2.2) break
  }
  const landing = new THREE.Vector3(lx, H(lx, lz), lz)

  // Totem: walk back up the beach until the sand is clear of the tide and not steep
  let tx = lx
  let tz = lz
  for (let d = 6; d < 40; d += 1) {
    const x = lx - outward.x * d
    const z = lz - outward.y * d
    const h = H(x, z)
    if (h > 2.6 && h < 6.5 && slope(x, z) < 0.45) {
      tx = x
      tz = z
      break
    }
  }
  const totem = new THREE.Vector3(tx, H(tx, tz), tz)

  // Camp pool: the farthest rain pool from the cove that is still a walk
  // (under 300 m); failing that, the farthest one; failing that, inland of the cove
  const pools = island.pools
  let campPool: THREE.Vector3
  if (pools.length === 0) {
    const x = cove.x - outward.x * 90
    const z = cove.z - outward.y * 90
    campPool = new THREE.Vector3(x, H(x, z), z)
  } else {
    const dist = (p: THREE.Vector3) => Math.hypot(p.x - cove.x, p.z - cove.z)
    const walkable = pools.filter((p) => dist(p) < 300)
    const from = walkable.length > 0 ? walkable : pools
    campPool = from.reduce((a, b) => (dist(b) > dist(a) ? b : a)).clone()
  }

  // Fire pit: the flattest dry ground 6–20 m from the pool, a little above it
  let best = { x: campPool.x + 8, z: campPool.z, score: Infinity }
  for (let r = 6; r <= 20; r += 1) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 18) {
      const x = campPool.x + Math.cos(a) * r
      const z = campPool.z + Math.sin(a) * r
      const h = H(x, z)
      if (h < campPool.y + 0.25 || h < 1.5) continue
      const score = slope(x, z) + Math.abs(h - campPool.y - 1) * 0.05 + r * 0.004
      if (score < best.score) best = { x, z, score }
    }
  }
  const campFire = new THREE.Vector3(best.x, H(best.x, best.z), best.z)

  // Lagoon rocks: the shallowest ground beside the coaster, nearest first.
  // The barrier reef's crest there sits about a metre down (knee-deep at low
  // water, tide -0.72), with the lagoon three to four metres deep behind it,
  // so this is where a diver works the wreck from her feet.
  let rocks: THREE.Vector3 | null = null
  for (let r = 6; r <= 40 && !rocks; r += 1.5) {
    let bestH = -Infinity
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 24) {
      const x = reefWreckPos.x + Math.cos(a) * r
      const z = reefWreckPos.z + Math.sin(a) * r
      const h = H(x, z)
      if (h > -1.5 && h < 1.1 && h > bestH) {
        bestH = h
        rocks = new THREE.Vector3(x, h, z)
      }
    }
  }
  if (!rocks) {
    // No shelf: the nearest dry sand to the wreck along the landing beach
    rocks = landing.clone()
  }

  const cavesMouth = new THREE.Vector3(cavesEntrance.x, 0, cavesEntrance.z)
  const sacred = { x: campFire.x, z: campFire.z, radius: SACRED_RADIUS }

  const places: TribePlaces = {
    landing,
    outward,
    totem,
    campPool,
    campFire,
    sacred,
    lagoonRocks: rocks,
    cavesMouth,
    inSacredZone: (x, z) => Math.hypot(x - sacred.x, z - sacred.z) < sacred.radius,
  }
  cache.set(island, places)
  return places
}
