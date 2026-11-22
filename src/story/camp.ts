import * as THREE from 'three'
import { DETAIL_LAYER } from '../quality'
import { skyFill } from '../skyfill'
import type { TribePlaces } from '../tribe/places'
import type { IslandLike, TribeWeather } from '../tribe/types'
import { createCampFlames } from './camp-fire'
import { NET, TAPA, THATCH, WEAVE, band, campAtlas } from './camp-tex'
import {
  Batch,
  TAU,
  UP,
  emissiveByAlbedo,
  hash,
  hex,
  lump,
  paintFaces,
  paintVerts,
  place,
  pole,
  smooth,
  stripBasic,
  type Painter,
} from './prop-geo'

/**
 * The islanders' camp: the home of three people who have lived here a long
 * time, built round the fire pit by the rain pool.
 *
 * The clearing is a hillside, so everything is laid out in the hill's own
 * frame (up the slope, and along it) and sat on the real ground:
 *
 *  - two open-sided thatched houses, each on a dry-stone platform that makes a
 *    level floor of the slope: the sleeping house along the hill from the
 *    fire, and a smaller cook house stepped up behind it;
 *  - the hearth itself: a stone ring, a star of logs, coals, a pot on three
 *    stones, fish on sticks, and seats round it where the islanders sit;
 *  - what a household leaves about: a fish-drying rack, an earth oven, a
 *    woodpile, baskets, gourds and cups, sleeping mats and bark cloth, a net
 *    hung to dry, a shell midden, and the outrigger hauled up above the tide;
 *  - the ground worn dark and bare between them.
 *
 * Trees are different on the two budgets, and a trunk through a roof is the
 * one thing a camp cannot have, so each site is searched for at load: the
 * nearest clear ground to where it is wanted, off the lane the islanders
 * leave by, never nearer the fire than they need to walk round it.
 *
 * It adds no light. The one PointLight is made in cash-bag.ts, handed in here
 * to be flickered, and never added, removed or hidden.
 */

export type CampOptions = {
  scene: THREE.Scene
  /** The props' root: the camp's own groups hang from it. */
  parent: THREE.Group
  /** At places.campFire. Holds the light, so it is never hidden. */
  fireGroup: THREE.Group
  fireLight: THREE.PointLight
  island: IslandLike
  /**
   * The island's terrain mesh, if it has one to give. heightAt is a smooth
   * surface through the mesh's corners; the mesh itself is flat triangles
   * between them, and on this hillside the two part by a hand's breadth or
   * more, which is enough to bury a path or float a mat.
   */
  terrain?: THREE.Mesh
  places: TribePlaces
  lowPower: boolean
}

/** Where something stands, for checking the islanders' routes against. */
export type CampSite = { id: string; label: string; x: number; y: number; z: number; radius: number }

export interface Camp {
  sites: CampSite[]
  /** Triangles by mesh. */
  triangles: Record<string, number>
  /** Triangles by what they are (two houses' platforms, their frames, the canoe...). */
  parts: Record<string, number>
  /** How placing went: how many tree and rock cells were found, and anything that had to go where it was wanted regardless. */
  notes: string[]
  /** Draw calls the camp adds over the bare fire pit it replaced (which was three). */
  draws: number
  update(dt: number, t: number, weather: TribeWeather, eye?: THREE.Vector3): void
}

/** The fire's light at full night, in candela (the cave's pool light is 39). */
const FIRE_CANDELA = 56
/** Beyond this the hearth does no work. */
const FIRE_FAR = 250
/** Roofs, platforms and the canoe are drawn out to here; the small things to NEAR. */
const FAR_SHOW = 340
const NEAR_SHOW = 95
/** Nothing solid nearer the fire than this, but the ring and the seats: the islanders walk round it. */
const FIRE_CLEAR = 4.6
/** Half the open lane from the fire past the pool and on toward the cove. */
const LANE_HALF = 2.3

const POST = hex('#8b6b48')
const POST_DARK = hex('#6c5237')
const POLE = hex('#a78a5f')
const POLE_DARK = hex('#836a49')
const POLE_PALE = hex('#bfa783')
const CUT = hex('#c9ab7b')
const CORD = hex('#b8a26e')
const STONE = hex('#8a8273')
const STONE_DARK = hex('#6f685c')
const STONE_TOP = hex('#a39b88')
const STONE_PALE = hex('#b3ab98')
const LICHEN = hex('#9aa07e')
const PEBBLE = hex('#b5ae9b')
const PEBBLE_DARK = hex('#9a9484')
const CORE = hex('#3f3a34')
const SOOT = hex('#1f1c19')
const ASH = hex('#77726b')
const ASH_WHITE = hex('#b3aea5')
const BARK = hex('#6f583f')
const BARK_DARK = hex('#55432f')
const CHAR = hex('#1c1714')
const CLAY = hex('#8a5a3c')
const HULL = hex('#7a5234')
const HULL_WORN = hex('#9c7e5c')
const HULL_MID = hex('#8a6444')
const HULL_RAIL = hex('#8f4a28')
const HULL_IN = hex('#a8875f')
const FISH_SKIN = hex('#7f8890')
const FISH_FLESH = hex('#c9b796')
const FISH_DRY = hex('#a88d62')
const GOURD = hex('#b98f4c')
const GOURD_DARK = hex('#8b6532')
const HUSK = hex('#7b6142')
const NUT_GREEN = hex('#76903f')
const BREADFRUIT = hex('#8ea04c')
const BANANA = hex('#8aa33c')
const SHELL = hex('#ebe5d6')
const SHELL_GREY = hex('#c4bdae')
const SHELL_PINK = hex('#e3c4b2')
const WOOD_BOWL = hex('#8a6238')
const EMBER_HOT = hex('#ff7a22')
const EMBER_WHITE = hex('#ffc46a')
const EMBER_DULL = hex('#5a1c0c')
const EMBER_CRUST = hex('#140c08')
const STONE_WARM = hex('#94826a')
const EARTH = hex('#9c8f76')
const WHITE = hex('#ffffff')

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

export function createCamp(o: CampOptions): Camp {
  const { island, places, lowPower } = o
  const rich = !lowPower
  const fire = places.campFire
  const H = (x: number, z: number) => island.heightAt(x, z)
  // The terrain's own triangles round the camp, so things can sit on the ground that is drawn
  const facets: number[] = []
  if (o.terrain) {
    const pos = o.terrain.geometry.getAttribute('position')
    const index = o.terrain.geometry.index
    o.terrain.updateWorldMatrix(true, false)
    const m = o.terrain.matrixWorld
    const local = new THREE.Vector3(fire.x, fire.y, fire.z).applyMatrix4(new THREE.Matrix4().copy(m).invert())
    const R = 60
    const p = new THREE.Vector3()
    const count = index ? index.count : pos.count
    for (let t = 0; t + 2 < count; t += 3) {
      const a = index ? index.getX(t) : t
      const b = index ? index.getX(t + 1) : t + 1
      const c = index ? index.getX(t + 2) : t + 2
      const ax = pos.getX(a) - local.x
      const az = pos.getZ(a) - local.z
      // Whole stretches of sea and far hillside go by on one corner
      if (ax < -R * 2 || ax > R * 2 || az < -R * 2 || az > R * 2) continue
      const bx = pos.getX(b) - local.x
      const bz = pos.getZ(b) - local.z
      const cx = pos.getX(c) - local.x
      const cz = pos.getZ(c) - local.z
      if (Math.min(ax, bx, cx) > R || Math.max(ax, bx, cx) < -R || Math.min(az, bz, cz) > R || Math.max(az, bz, cz) < -R) continue
      for (const v of [a, b, c]) {
        p.fromBufferAttribute(pos, v).applyMatrix4(m)
        facets.push(p.x, p.y, p.z)
      }
    }
  }
  /** World height of the ground as drawn (the mesh's own facet), or heightAt where the mesh was not to be had. */
  const drawnAt = (x: number, z: number) => {
    let y = -Infinity
    for (let i = 0; i < facets.length; i += 9) {
      const ax = facets[i]
      const az = facets[i + 2]
      const bx = facets[i + 3]
      const bz = facets[i + 5]
      const cx = facets[i + 6]
      const cz = facets[i + 8]
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (Math.abs(d) < 1e-9) continue
      const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
      const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
      const wc = 1 - wa - wb
      if (wa < -1e-4 || wb < -1e-4 || wc < -1e-4) continue
      y = Math.max(y, wa * facets[i + 1] + wb * facets[i + 4] + wc * facets[i + 7])
    }
    return y === -Infinity ? H(x, z) : y
  }
  /** Ground height in the camp's own frame: metres from the fire, relative to the ground under it. */
  const G = (x: number, z: number) => drawnAt(fire.x + x, fire.z + z) - fire.y
  const SIDES = rich ? 6 : 5

  // —— the hill's frame ——
  // u runs up the slope, s along it. Houses are turned so their fronts look down the hill.
  let upX = H(fire.x + 4, fire.z) - H(fire.x - 4, fire.z)
  let upZ = H(fire.x, fire.z + 4) - H(fire.x, fire.z - 4)
  if (Math.hypot(upX, upZ) < 0.25) {
    // Near enough level: inland is up
    upX = island.centre.x - fire.x
    upZ = island.centre.z - fire.z
  }
  {
    const l = Math.hypot(upX, upZ) || 1
    upX /= l
    upZ /= l
  }
  const sX = -upZ
  const sZ = upX
  /** +1 when s runs toward the cove (the way the lane leaves), -1 when it runs away. */
  const toCove = sX * (places.landing.x - fire.x) + sZ * (places.landing.z - fire.z) >= 0 ? 1 : -1
  const yaw = Math.atan2(-upX, -upZ)
  /** Camp-frame offset (metres from the fire) of a point u up the hill and s along it. */
  const fx = (u: number, s: number) => upX * u + sX * s
  const fz = (u: number, s: number) => upZ * u + sZ * s

  // —— what already stands here ——
  // Trunks and boulders, read from the island's own meshes: half-metre cells within reach of the camp
  const REACH = 40
  const CELL = 0.5
  const GN = Math.ceil((REACH * 2) / CELL)
  const taken = new Uint8Array(GN * GN)
  {
    const corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    const p = new THREE.Vector3()
    const local = new THREE.Vector3()
    const inverse = new THREE.Matrix4()
    o.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      const trunk = /trunk/i.test(mesh.name)
      const rock = mesh.name === 'rocks' || mesh.name === 'boulderParts'
      if (!trunk && !rock) return
      const pos = mesh.geometry.getAttribute('position')
      if (!pos) return
      const index = mesh.geometry.index
      mesh.updateWorldMatrix(true, false)
      local.set(fire.x, fire.y, fire.z).applyMatrix4(inverse.copy(mesh.matrixWorld).invert())
      const count = index ? index.count : pos.count
      for (let t = 0; t + 2 < count; t += 3) {
        const ia = index ? index.getX(t) : t
        // Most of the forest is nowhere near: one corner is enough to say so
        if (Math.abs(pos.getX(ia) - local.x) > REACH + 15 || Math.abs(pos.getZ(ia) - local.z) > REACH + 15) continue
        corner[0].fromBufferAttribute(pos, ia).applyMatrix4(mesh.matrixWorld)
        corner[1].fromBufferAttribute(pos, index ? index.getX(t + 1) : t + 1).applyMatrix4(mesh.matrixWorld)
        corner[2].fromBufferAttribute(pos, index ? index.getX(t + 2) : t + 2).applyMatrix4(mesh.matrixWorld)
        // A trunk is a few tall facets, with no corner anywhere near the height
        // of a roof: walk each edge, and mark wherever it passes through that height
        for (let e = 0; e < 3; e++) {
          const from = corner[e]
          const to = corner[(e + 1) % 3]
          const steps = Math.max(1, Math.ceil(from.distanceTo(to) / 0.3))
          for (let k = 0; k <= steps; k++) {
            p.lerpVectors(from, to, k / steps)
            const gx = Math.floor((p.x - fire.x + REACH) / CELL)
            const gz = Math.floor((p.z - fire.z + REACH) / CELL)
            if (gx < 0 || gz < 0 || gx >= GN || gz >= GN) continue
            const above = p.y - H(p.x, p.z)
            // A trunk as high as a roof reaches; a rock only if it stands proud of the ground
            if (trunk ? above > 0.25 && above < 6 : above > 0.5) taken[gz * GN + gx] = 1
          }
        }
      }
    })
  }
  const notes: string[] = []
  {
    let cells = 0
    for (let i = 0; i < taken.length; i++) cells += taken[i]
    notes.push(`${cells} half-metre cells of trunk and rock within ${REACH} m`)
  }
  /** Something stands within `pad` of this camp-frame point. */
  const blocked = (x: number, z: number, pad: number) => {
    const r = Math.ceil(pad / CELL)
    const cx = Math.floor((x + REACH) / CELL)
    const cz = Math.floor((z + REACH) / CELL)
    for (let j = cz - r; j <= cz + r; j++) {
      for (let i = cx - r; i <= cx + r; i++) {
        if (i < 0 || j < 0 || i >= GN || j >= GN) continue
        if (taken[j * GN + i]) return true
      }
    }
    return false
  }

  // —— the lane the islanders leave by ——
  // From the fire to the pool, then on toward the cove, with a second line a
  // little down the hill from the first: the patrol and the walk to the reef
  // both go this way, and neither knows the camp is here.
  const poolX = places.campPool.x - fire.x
  const poolZ = places.campPool.z - fire.z
  const lane: [number, number, number, number][] = []
  let laneX = places.landing.x - places.campPool.x
  let laneZ = places.landing.z - places.campPool.z
  {
    const l = Math.hypot(laneX, laneZ) || 1
    laneX /= l
    laneZ /= l
    const lx = laneX
    const lz = laneZ
    lane.push([0, 0, poolX, poolZ])
    lane.push([poolX, poolZ, poolX + lx * 60, poolZ + lz * 60])
    let dx = lx - upX * 0.16
    let dz = lz - upZ * 0.16
    const dl = Math.hypot(dx, dz) || 1
    dx /= dl
    dz /= dl
    lane.push([poolX, poolZ, poolX + dx * 60, poolZ + dz * 60])
  }
  const laneDistance = (x: number, z: number) => {
    let best = Infinity
    for (const [ax, az, bx, bz] of lane) {
      const ex = bx - ax
      const ez = bz - az
      const t = THREE.MathUtils.clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1), 0, 1)
      best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t))
    }
    return best
  }

  // —— finding room ——
  type Room = { u: number; s: number; hu: number; hs: number }
  const rooms: Room[] = []
  const sites: CampSite[] = []
  type Want = {
    /** Half-size up the hill and along it. */
    hu: number
    hs: number
    /** Extra reach of a roof beyond the footprint, which must clear trunks too. */
    eave?: number
    /** How far it may move to find room. */
    reach?: number
    /** Nearest it may come to the fire. */
    fire?: number
    /** Ground must lie between these heights (world). */
    minY?: number
    maxY?: number
    /** Leave this much round the things already placed. */
    gap?: number
  }
  /** The clear ground nearest (u, s). Falls back to the wanted spot if the hill has no room at all. */
  const findRoom = (u0: number, s0: number, w: Want) => {
    const reach = w.reach ?? 5
    const eave = w.eave ?? 0
    const gap = w.gap ?? 0.5
    const fireClear = w.fire ?? FIRE_CLEAR
    let best = Infinity
    let bu = u0
    let bs = s0
    for (let du = -reach; du <= reach; du += 0.5) {
      for (let ds = -reach; ds <= reach; ds += 0.5) {
        // Sideways along the hill costs less than up or down it
        const cost = Math.hypot(du * 1.35, ds)
        if (cost >= best) continue
        const u = u0 + du
        const s = s0 + ds
        if (Math.hypot(Math.max(Math.abs(u) - w.hu, 0), Math.max(Math.abs(s) - w.hs, 0)) < fireClear) continue
        let ok = true
        for (const r of rooms) {
          if (Math.abs(u - r.u) < w.hu + r.hu + gap && Math.abs(s - r.s) < w.hs + r.hs + gap) ok = false
        }
        if (!ok) continue
        const y = H(fire.x + fx(u, s), fire.z + fz(u, s))
        if ((w.minY !== undefined && y < w.minY) || (w.maxY !== undefined && y > w.maxY)) continue
        const na = Math.max(1, Math.ceil(((w.hu + eave) * 2) / 0.5))
        const nb = Math.max(1, Math.ceil(((w.hs + eave) * 2) / 0.5))
        for (let ia = 0; ia <= na && ok; ia++) {
          for (let ib = 0; ib <= nb && ok; ib++) {
            const a = -w.hu - eave + ((w.hu + eave) * 2 * ia) / na
            const b = -w.hs - eave + ((w.hs + eave) * 2 * ib) / nb
            const x = fx(u + a, s + b)
            const z = fz(u + a, s + b)
            if (blocked(x, z, 0.45)) ok = false
            else if (Math.abs(a) <= w.hu && Math.abs(b) <= w.hs) {
              if (laneDistance(x, z) < LANE_HALF) ok = false
              else if (Math.hypot(x - poolX, z - poolZ) < 3.2) ok = false
            }
          }
        }
        if (!ok) continue
        best = cost
        bu = u
        bs = s
      }
    }
    rooms.push({ u: bu, s: bs, hu: w.hu, hs: w.hs })
    if (best === Infinity) notes.push(`no clear ground within ${reach} m of (${u0.toFixed(1)}, ${s0.toFixed(1)}): placed there regardless`)
    return { u: bu, s: bs, x: fx(bu, bs), z: fz(bu, bs), moved: best === Infinity ? -1 : best }
  }
  const note = (id: string, label: string, x: number, z: number, radius: number) => {
    sites.push({ id, label, x: fire.x + x, y: H(fire.x + x, fire.z + z), z: fire.z + z, radius })
  }

  // —— batches: one per draw call ——
  const farSolid = new Batch()
  const farFibre = new Batch()
  const nearSolid = new Batch()
  const nearFibre = new Batch()
  const hearth = new Batch()
  const coals = new Batch()

  /** Triangles by part, for the budget: each `tally` books what was added since the last one. */
  const parts: Record<string, number> = {}
  let booked = 0
  const tally = (name: string) => {
    const now = farSolid.triangles + farFibre.triangles + nearSolid.triangles + nearFibre.triangles + hearth.triangles + coals.triangles
    parts[name] = (parts[name] ?? 0) + now - booked
    booked = now
  }

  const q = new THREE.Quaternion()
  const qb = new THREE.Quaternion()
  const nrm = new THREE.Vector3()
  const tone = new THREE.Color()
  /** Lying on the ground at a camp-frame point: tilted to the slope, turned to `turn`. */
  const groundQ = (x: number, z: number, turn: number, out: THREE.Quaternion) => {
    const e = 0.35
    nrm.set(G(x - e, z) - G(x + e, z), 2 * e, G(x, z - e) - G(x, z + e)).normalize()
    return out.setFromUnitVectors(UP, nrm).multiply(qb.setFromAxisAngle(UP, turn))
  }
  const grain =
    (base: THREE.Color, dark: THREE.Color, seed: number, cut = CUT): Painter =>
    (p, n, c) => {
      if (Math.abs(n.y) > 0.9) c.copy(cut)
      else c.copy(base).lerp(dark, 0.5 + 0.5 * Math.sin(Math.atan2(p.x, p.z) * 3 + p.y * 2.3 + seed))
    }
  const stick = (
    b: Batch,
    from: THREE.Vector3,
    to: THREE.Vector3,
    r0: number,
    r1: number,
    colour: THREE.Color | Painter,
    sides = SIDES,
    capped = false,
  ) => b.add(pole(from, to, r0, r1, sides, colour, capped))
  /** A flat piece that must face away from (or toward) a point, whatever order its corners came in. */
  const facing = (
    b: Batch,
    a: THREE.Vector3,
    bb: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    from: THREE.Vector3,
    away: boolean,
    colour: THREE.Color,
    colourTop?: THREE.Color,
  ) => {
    nrm.subVectors(bb, a).cross(tone3.subVectors(d, a))
    mid.copy(a).add(bb).add(c).add(d).multiplyScalar(0.25).sub(from)
    if (nrm.dot(mid) > 0 === away) b.quad(a, bb, c, d, colour, undefined, colourTop)
    else b.quad(bb, a, d, c, colour, undefined, colourTop)
  }
  const tone3 = new THREE.Vector3()
  const mid = new THREE.Vector3()

  const [thHead, thFoot] = band(THATCH)
  const [wvHead, wvFoot] = band(WEAVE)
  const [ntHead, ntFoot] = band(NET)
  const [tpHead, tpFoot] = band(TAPA)

  // —— a dry-stone platform (paepae): a level floor on the hillside ——
  /** One wall stone: a block with its corners knocked about, open at the back and underneath. */
  const wallStone = (seed: number, w: number, h: number, d: number, kerb: boolean) => {
    const box = new THREE.BoxGeometry(1, 1, 1).toNonIndexed()
    const pos = box.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      const z = pos.getZ(i)
      const key = x * 3.1 + y * 5.3 + z * 7.7 + seed * 1.37
      // The face is smaller than the body behind it, so every stone is rounded
      // off toward the next and the joints between them fall into shadow
      const face = z > 0 ? (rich ? 0.74 : 0.86) + hash(key + 6.3) * (rich ? 0.16 : 0.1) : 1
      pos.setXYZ(
        i,
        x * w * face * (1 + (hash(key) - 0.5) * 0.3),
        y * h * face * (1 + (hash(key + 2.2) - 0.5) * 0.34),
        z * d + (z > 0 ? (hash(key + 4.1) - 0.5) * 0.12 : 0),
      )
    }
    // Faces come out in the order +x, -x, +y, -y, +z, -z, two triangles each: the
    // bottom and the back are never seen, and on the light budget the ends go too
    // (the wall's dark heart shows through the joints instead)
    const src = pos.array as Float32Array
    const keep = new Float32Array((rich ? 8 : 4) * 9)
    if (rich) {
      keep.set(src.subarray(0, 54), 0)
      keep.set(src.subarray(72, 90), 54)
    } else {
      keep.set(src.subarray(36, 54), 0)
      keep.set(src.subarray(72, 90), 18)
    }
    box.dispose()
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(keep, 3))
    g.computeVertexNormals()
    const base = hash(seed * 3.3)
    const kind = hash(seed * 7.9)
    return paintFaces(g, (p, n, c) => {
      // Mostly grey basalt; one in five a browner stone, one in six weathered pale
      const body = kind < 0.2 ? STONE_WARM : kind > 0.84 ? STONE_PALE : STONE
      if (n.y > 0.5) c.copy(kind > 0.9 ? LICHEN : STONE_TOP).lerp(body, 0.35 + base * 0.3)
      else if (n.z < 0.5) c.copy(body).lerp(STONE_DARK, 0.75)
      else c.copy(body).lerp(STONE_DARK, base * 0.4)
      // Damp and dark toward the foot of the wall, unless it is the kerb in the sun
      if (!kerb) c.multiplyScalar(0.84 + 0.16 * smooth(p.y, -h * 0.5, h * 0.5))
      c.multiplyScalar(0.9 + hash(seed * 1.9 + p.x * 3) * 0.2)
    })
  }
  /** In the frame of its own top (y = 0), with `g` the ground below it. */
  const paepae = (b: Batch, L: number, D: number, g: (x: number, z: number) => number, seed: number) => {
    const hx = L / 2
    const hz = D / 2
    // The floor: water-worn pebbles, each patch its own shade
    const cell = rich ? 0.5 : 0.75
    const nx = Math.max(3, Math.round(L / cell))
    const nz = Math.max(2, Math.round(D / cell))
    const py = (i: number, j: number) => (i === 0 || j === 0 || i === nx || j === nz ? 0 : hash(seed + i * 7.1 + j * 13.3) * 0.035)
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const x0 = -hx + (L * i) / nx
        const x1 = -hx + (L * (i + 1)) / nx
        const z0 = -hz + (D * j) / nz
        const z1 = -hz + (D * (j + 1)) / nz
        tone.copy(PEBBLE).lerp(PEBBLE_DARK, hash(seed + i * 3.7 + j * 9.1))
        b.quad(v3(x0, py(i, j + 1), z1), v3(x1, py(i + 1, j + 1), z1), v3(x1, py(i + 1, j), z0), v3(x0, py(i, j), z0), tone)
      }
    }
    // The walls, laid course on course from the top down to wherever the hill meets them
    const walls: [number, number, number, number, number, number][] = [
      [-hx, hz, hx, hz, 0, 1],
      [hx, hz, hx, -hz, 1, 0],
      [-hx, -hz, -hx, hz, -1, 0],
      [hx, -hz, -hx, -hz, 0, -1],
    ]
    const courseH = rich ? 0.29 : 0.4
    const stoneW = rich ? 0.5 : 0.82
    const depth = 0.34
    let w = 0
    for (const [ax, az, bx, bz, nx2, nz2] of walls) {
      const len = Math.hypot(bx - ax, bz - az)
      const dx = (bx - ax) / len
      const dz = (bz - az) / len
      const turn = Math.atan2(nx2, nz2)
      // The dark of the wall's heart, behind the gaps between its stones
      let low = 0
      for (let t = 0; t <= len; t += 0.5) low = Math.min(low, g(ax + dx * t, az + dz * t))
      if (low < -0.15) {
        const inX = nx2 * 0.12
        const inZ = nz2 * 0.12
        b.quad(
          v3(ax - inX, low - 0.3, az - inZ),
          v3(bx - inX, low - 0.3, bz - inZ),
          v3(bx - inX, -0.02, bz - inZ),
          v3(ax - inX, -0.02, az - inZ),
          CORE,
        )
      }
      for (let c = 0; c * courseH < -low + 0.3 || c === 0; c++) {
        const top = c === 0 ? 0.045 : -(c - 1) * courseH - courseH * 0.72
        const h = c === 0 ? courseH * 0.78 : courseH
        let t = -hash(seed + w * 5.1 + c * 2.7) * stoneW * 0.5
        let k = 0
        while (t < len) {
          const full = stoneW * (0.72 + hash(seed + w * 11.3 + c * 3.9 + k * 1.7) * 0.6)
          // Cut to the wall's own length: a stone may round the corner by a hand, no more
          const from = Math.max(-0.08, t)
          const to = Math.min(len + 0.08, t + full)
          const sw = to - from
          const at = (from + to) / 2
          if (sw < 0.16) {
            t += full
            k++
            continue
          }
          const x = ax + dx * at
          const z = az + dz * at
          const ground = g(x + nx2 * 0.15, z + nz2 * 0.15)
          // Buried stones are left out, and so is one that would only show as a sliver
          if (top > ground + 0.13) {
            const out = (hash(seed + w * 2.3 + c * 8.1 + k * 4.4) - 0.3) * 0.07
            const stone = wallStone(seed + w * 31 + c * 7 + k, sw * 0.98, h * 0.96, depth, c === 0)
            q.setFromAxisAngle(UP, turn + (hash(seed + k * 9.9 + c) - 0.5) * 0.3)
            const settle = c === 0 ? 0 : (hash(seed + k * 6.1 + c * 3.3) - 0.5) * 0.05
            place(stone, x - nx2 * (depth / 2 - 0.05 - out), top - h / 2 + settle, z - nz2 * (depth / 2 - 0.05 - out), q)
            b.add(stone)
          }
          t += full
          k++
        }
      }
      w++
    }
  }

  // —— a thatched roof on a frame of poles ——
  type Roof = { L: number; D: number; plate: number; pitch: number; seed: number }
  const roofOf = (r: Roof) => {
    const zp = r.D / 2 - 0.22
    const tan = Math.tan(r.pitch)
    const over = 0.42
    return { zp, tan, over, ridgeY: r.plate + 0.1 + zp * tan, run: zp + over, x0: -r.L / 2 - 0.38, x1: r.L / 2 + 0.38 }
  }
  /** Posts, plates, ties, ridge and rafters, in the platform's frame. */
  const frame = (b: Batch, r: Roof) => {
    const { zp, tan, ridgeY, run } = roofOf(r)
    const xs = r.L > 3.6 ? [-r.L / 2 + 0.28, 0, r.L / 2 - 0.28] : [-r.L / 2 + 0.28, r.L / 2 - 0.28]
    let n = 0
    for (const x of xs) {
      for (const side of [-1, 1]) {
        const lean = (hash(r.seed + n * 3.1) - 0.5) * 0.05
        stick(b, v3(x, -0.25, side * zp), v3(x + lean, r.plate, side * zp), 0.085, 0.07, grain(POST, POST_DARK, r.seed + n))
        // Sennit at the head of every post, where the plate is lashed on
        if (rich) stick(b, v3(x + lean, r.plate - 0.13, side * zp), v3(x + lean, r.plate + 0.02, side * zp), 0.092, 0.092, CORD, SIDES)
        n++
      }
      // A tie across each pair of posts, and a strut up to the ridge
      stick(b, v3(x, r.plate + 0.13, -zp - 0.22), v3(x, r.plate + 0.13, zp + 0.22), 0.055, 0.05, grain(POLE, POLE_DARK, r.seed + n), SIDES, true)
      stick(b, v3(x, r.plate + 0.16, 0), v3(x, ridgeY - 0.03, 0), 0.05, 0.042, grain(POLE, POLE_DARK, r.seed + n + 5))
    }
    for (const side of [-1, 1]) {
      stick(b, v3(-r.L / 2 - 0.28, r.plate + 0.05, side * zp), v3(r.L / 2 + 0.28, r.plate + 0.05, side * zp), 0.062, 0.055, grain(POLE, POLE_DARK, r.seed + side), SIDES, true)
    }
    stick(b, v3(-r.L / 2 - 0.42, ridgeY, 0), v3(r.L / 2 + 0.42, ridgeY, 0), 0.06, 0.052, grain(POLE, POLE_DARK, r.seed + 9), SIDES, true)
    // Rafters, and the battens the thatch is tied to
    const rafters = Math.max(3, Math.round(r.L / (rich ? 0.75 : 1.1)) + 1)
    for (let i = 0; i < rafters; i++) {
      const x = -r.L / 2 - 0.2 + ((r.L + 0.4) * i) / (rafters - 1)
      for (const side of [-1, 1]) {
        stick(b, v3(x, ridgeY + 0.035, 0), v3(x, ridgeY + 0.035 - (run - 0.06) * tan, side * (run - 0.06)), 0.032, 0.028, POLE_PALE, 4)
      }
    }
    if (rich) {
      for (const side of [-1, 1]) {
        for (const d of [0.36, 0.74]) {
          const z = side * run * d
          const y = ridgeY + 0.075 - run * d * tan
          stick(b, v3(-r.L / 2 - 0.32, y, z), v3(r.L / 2 + 0.32, y, z), 0.02, 0.02, POLE_DARK, 3)
        }
      }
    }
  }
  /** Courses of leaf from the eave to the ridge, each lying over the one below. */
  const thatch = (b: Batch, r: Roof) => {
    const { tan, ridgeY, run, x0, x1 } = roofOf(r)
    const cos = 1 / Math.sqrt(1 + tan * tan)
    const sin = tan * cos
    const slope = run / cos
    const courses = rich ? Math.round(slope / 0.3) : Math.round(slope / 0.42)
    const exposure = slope / courses
    const length = exposure * 1.78
    const TILE = 0.9
    const segs = Math.max(2, Math.round((x1 - x0) / (rich ? 0.7 : 1.1)))
    /** A point on the roof `d` down the slope from the ridge and `lift` off the rafters. */
    const at = (x: number, d: number, lift: number, side: number) =>
      v3(x, ridgeY + 0.06 - d * sin + lift * cos, side * (d * cos + lift * sin))
    for (const side of [-1, 1]) {
      for (let i = 0; i < courses; i++) {
        const low = slope - i * exposure + (i === 0 ? 0.12 : 0.02)
        const high = Math.max(0.04, low - length)
        const head = thFoot - ((thFoot - thHead) * (low - high)) / length
        const shade = 0.82 + hash(r.seed + i * 5.3 + side) * 0.3
        // Old thatch greys; the newest course by the ridge is still straw
        tone.setRGB(shade, shade * (0.97 + hash(r.seed + i * 2.9) * 0.05), shade * (0.9 + hash(r.seed + i * 7.7 + side) * 0.14))
        const off = hash(r.seed + i * 13.1 + side * 3)
        for (let j = 0; j < segs; j++) {
          const ragA = j === 0 ? -hash(r.seed + i * 3.7 + side) * 0.14 : 0
          const ragB = j === segs - 1 ? hash(r.seed + i * 4.3 + side) * 0.14 : 0
          const xa = x0 + ((x1 - x0) * j) / segs + ragA
          const xb = x0 + ((x1 - x0) * (j + 1)) / segs + ragB
          // The eave line wanders: no two leaves were cut the same length
          const da = low + (hash(r.seed + i * 17 + j * 3.1 + side) - 0.5) * 0.07
          const db = low + (hash(r.seed + i * 17 + (j + 1) * 3.1 + side) - 0.5) * 0.07
          const la = 0.062 + hash(r.seed + i + j * 5.7) * 0.03
          const lb = 0.062 + hash(r.seed + i + (j + 1) * 5.7) * 0.03
          const ua = xa / TILE + off
          const ub = xb / TILE + off
          if (side > 0) b.quad(at(xa, da, la, 1), at(xb, db, lb, 1), at(xb, high, 0.012, 1), at(xa, high, 0.012, 1), tone, [ua, thFoot, ub, head])
          else b.quad(at(xb, db, lb, -1), at(xa, da, la, -1), at(xa, high, 0.012, -1), at(xb, high, 0.012, -1), tone, [ub, thFoot, ua, head])
        }
      }
      // The eave is a hand deep: the cut ends of every course hang at it
      {
        const low = slope + 0.12
        const ua = x0 / TILE + 0.61
        const ub = x1 / TILE + 0.61
        const a = at(x0, low, 0.075, side)
        const bb = at(x1, low, 0.075, side)
        tone.setRGB(0.74, 0.72, 0.66)
        b.quad(v3(a.x, a.y - 0.19, a.z - side * 0.05), v3(bb.x, bb.y - 0.19, bb.z - side * 0.05), bb, a, tone, [ua, thFoot, ub, thFoot - (thFoot - thHead) * 0.42])
        // and so is each end of the roof, where the bundles show in section
        for (const x of [x0, x1]) {
          tone.setRGB(0.62, 0.6, 0.54)
          b.quad(at(x, slope + 0.1, -0.05, side), at(x, slope + 0.1, 0.085, side), at(x, 0, 0.12, side), at(x, 0, -0.03, side), tone, [0.2, thHead + (thFoot - thHead) * 0.45, 0.2 + slope / TILE, thHead + (thFoot - thHead) * 0.62])
        }
      }
      // The ridge: a thick saddle of leaf folded over the top
      tone.setRGB(0.96, 0.94, 0.86)
      const ua = x0 / TILE + 0.37
      const ub = x1 / TILE + 0.37
      if (side > 0) b.quad(at(x0 + 0.05, 0.4, 0.13, 1), at(x1 - 0.05, 0.4, 0.13, 1), at(x1 - 0.05, -0.04, 0.1, 1), at(x0 + 0.05, -0.04, 0.1, 1), tone, [ua, thFoot, ub, thHead + (thFoot - thHead) * 0.35])
      else b.quad(at(x1 - 0.05, 0.4, 0.13, -1), at(x0 + 0.05, 0.4, 0.13, -1), at(x0 + 0.05, -0.04, 0.1, -1), at(x1 - 0.05, -0.04, 0.1, -1), tone, [ub, thFoot, ua, thHead + (thFoot - thHead) * 0.35])
    }
    // Gable ends: three short courses hung in the open triangle under the ridge
    for (const end of [-1, 1]) {
      const x = end * (r.L / 2 + 0.3)
      const apex = ridgeY + 0.1
      const foot = r.plate + 0.42
      const rows = 3
      for (let i = 0; i < rows; i++) {
        const yLow = foot + ((apex - foot) * i) / rows - 0.03
        const yHigh = Math.min(apex, yLow + ((apex - foot) / rows) * 1.7)
        const wLow = (apex - yLow) / tan
        const wHigh = (apex - yHigh) / tan
        const out = end * (0.03 + (rows - i) * 0.025)
        const shade = 0.78 + hash(r.seed + i * 3.1 + end) * 0.24
        tone.setRGB(shade, shade * 0.98, shade * 0.92)
        const a = v3(x + out, yLow, -wLow * end)
        const bb = v3(x + out, yLow, wLow * end)
        const c = v3(x + out * 0.4, yHigh, wHigh * end)
        const d = v3(x + out * 0.4, yHigh, -wHigh * end)
        b.quad(a, bb, c, d, tone, [0.1 * i, thFoot, 0.1 * i + (wLow * 2) / TILE, thFoot - (thFoot - thHead) * 0.6])
      }
    }
  }
  /** Crossed sticks pinning the ridge down: the outline every such roof has. */
  const ridgePins = (wood: Batch, r: Roof) => {
    const { tan, ridgeY, x0, x1 } = roofOf(r)
    const cos = 1 / Math.sqrt(1 + tan * tan)
    const sin = tan * cos
    const at = (x: number, d: number, lift: number, side: number) =>
      v3(x, ridgeY + 0.06 - d * sin + lift * cos, side * (d * cos + lift * sin))
    const pins = Math.max(3, Math.round((x1 - x0) / (rich ? 0.72 : 1.2)))
    for (let i = 0; i < pins; i++) {
      const x = x0 + 0.3 + ((x1 - x0 - 0.6) * i) / (pins - 1)
      for (const side of [-1, 1]) stick(wood, at(x, 0.5, 0.16, side), at(x, -0.34, 0.16, side), 0.019, 0.015, POLE_DARK, 3)
    }
  }

  // —— small things ——
  /** A plaited basket: a lathe wrapped in the matting. */
  const basket = (b: Batch, x: number, y: number, z: number, r: number, h: number, seed: number, belly = 1.12) => {
    const profile = [
      [r * 0.72, 0],
      [r * belly, h * 0.35],
      [r * belly * 0.98, h * 0.7],
      [r * 0.9, h],
    ].map(([pr, py]) => new THREE.Vector2(pr, py))
    const g = new THREE.LatheGeometry(profile, rich ? 9 : 6).toNonIndexed()
    const uv = g.attributes.uv
    const around = Math.max(2, Math.round((TAU * r) / 0.4))
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * around, wvHead + (wvFoot - wvHead) * uv.getY(i))
    const shade = 0.72 + hash(seed) * 0.26
    b.add(place(g, x, y, z), tone.setRGB(shade, shade * 0.97, shade * 0.9))
    // The floor of it, so an empty one is not a tube
    const floor = new THREE.CircleGeometry(r * 0.74, rich ? 9 : 6).toNonIndexed()
    floor.rotateX(-Math.PI / 2)
    const fuv = floor.attributes.uv
    for (let i = 0; i < fuv.count; i++) fuv.setXY(i, fuv.getX(i), wvHead + (wvFoot - wvHead) * fuv.getY(i))
    b.add(place(floor, x, y + 0.012, z), tone.setRGB(shade * 0.7, shade * 0.68, shade * 0.62))
  }
  /** A heap of round things: coconuts, breadfruit, oven stones. */
  const heap = (b: Batch, x: number, y: number, z: number, r: number, count: number, size: number, colour: THREE.Color, other: THREE.Color, seed: number) => {
    for (let i = 0; i < count; i++) {
      const a = hash(seed + i * 3.3) * TAU
      const d = Math.sqrt(hash(seed + i * 5.1)) * r
      const g = lump(seed + i)
      const s = size * (0.8 + hash(seed + i * 7.7) * 0.4)
      place(g, x + Math.cos(a) * d, y + s * 0.6 + (1 - d / (r || 1)) * size * 0.5 * (i % 2), z + Math.sin(a) * d, q.setFromAxisAngle(UP, a), s, s * 0.86, s)
      tone.copy(colour).lerp(other, hash(seed + i * 9.9))
      b.add(g, tone)
    }
  }
  /** A water gourd: fat below, a neck, a stopper of leaf. */
  const gourd = (b: Batch, x: number, y: number, z: number, s: number, seed: number) => {
    const g = stripBasic(
      new THREE.LatheGeometry(
        [
          [0.02, 0],
          [0.12, 0.03],
          [0.155, 0.13],
          [0.12, 0.24],
          [0.05, 0.31],
          [0.04, 0.38],
          [0.055, 0.4],
        ].map(([pr, py]) => new THREE.Vector2(pr * s, py * s)),
        rich ? 8 : 5,
      ),
    )
    paintVerts(g, (p, _n, c) => {
      c.copy(GOURD).lerp(GOURD_DARK, 0.25 + 0.5 * hash(seed + Math.round(p.y * 40)) * smooth(p.y, 0, 0.3 * s))
    })
    b.add(place(g, x, y, z, q.setFromAxisAngle(UP, hash(seed) * TAU)))
  }
  /** Half a coconut shell, drunk from. */
  const cup = (b: Batch, x: number, y: number, z: number, seed: number) => {
    const g = stripBasic(new THREE.SphereGeometry(0.055, rich ? 6 : 5, rich ? 3 : 2, 0, TAU, Math.PI / 2, Math.PI / 2))
    b.add(place(g, x, y + 0.055, z), tone.copy(HUSK).multiplyScalar(0.8 + hash(seed) * 0.3))
    const inside = stripBasic(new THREE.CircleGeometry(0.05, 6))
    inside.rotateX(-Math.PI / 2)
    b.add(place(inside, x, y + 0.045, z), SHELL_GREY)
  }
  /** A split fish, hung by the tail to dry, or held over the fire on a stick. */
  const fish = (b: Batch, at: THREE.Vector3, len: number, turn: number, seed: number, down = UP) => {
    const body = stripBasic(new THREE.OctahedronGeometry(1, 0))
    place(body, 0, -len * 0.56, 0, undefined, len * 0.17, len * 0.44, len * 0.045)
    // The fin opens away from the body: the cone stands on its point
    const tail = stripBasic(new THREE.ConeGeometry(len * 0.15, len * 0.17, 3).rotateX(Math.PI))
    place(tail, 0, -len * 0.07, 0, undefined, 1, 1, 0.22)
    for (const part of [body, tail]) {
      paintFaces(part, (p, n, c) => {
        // Flesh side out on one face, skin on the other, both gone leathery
        c.copy(n.z > 0 ? FISH_FLESH : FISH_SKIN).lerp(FISH_DRY, 0.35 + hash(seed + p.y * 9) * 0.3)
      })
      q.setFromUnitVectors(UP, down).multiply(qb.setFromAxisAngle(UP, turn))
      b.add(place(part, at.x, at.y, at.z, q))
    }
  }
  /** A paddle: a shaft and a leaf-shaped blade. `from` is the grip. */
  const paddle = (b: Batch, from: THREE.Vector3, to: THREE.Vector3, seed: number) => {
    const dir = tone3.subVectors(to, from)
    const len = dir.length()
    dir.normalize()
    const neck = from.clone().addScaledVector(dir, len * 0.62)
    stick(b, from, neck, 0.019, 0.017, grain(POLE, POLE_DARK, seed), 5, true)
    const blade = stripBasic(new THREE.SphereGeometry(1, rich ? 6 : 4, rich ? 3 : 2))
    place(blade, 0, 0, 0, undefined, 0.085, len * 0.2, 0.012)
    q.setFromUnitVectors(UP, dir)
    const c = neck.clone().addScaledVector(dir, len * 0.19)
    b.add(place(blade, c.x, c.y, c.z, q), tone.copy(POLE).lerp(POLE_PALE, 0.4))
  }

  // —— the two houses ——
  type House = { x: number; z: number; top: number; L: number; D: number; matrix: THREE.Matrix4; roof: Roof }
  const house = (id: string, label: string, u0: number, s0: number, L: number, D: number, plate: number, seed: number, reach: number): House => {
    const room = findRoom(u0, s0, { hu: D / 2, hs: L / 2, eave: 0.8, reach })
    let top = -Infinity
    for (let a = -L / 2; a <= L / 2 + 0.01; a += 0.25) {
      for (let b = -D / 2; b <= D / 2 + 0.01; b += 0.25) top = Math.max(top, G(room.x + sX * a - upX * b, room.z + sZ * a - upZ * b))
    }
    top += 0.14
    const matrix = new THREE.Matrix4().makeRotationY(yaw).setPosition(room.x, top, room.z)
    const roof: Roof = { L, D, plate, pitch: 0.74, seed }
    const g = (x: number, z: number) => G(room.x + sX * x - upX * z, room.z + sZ * x - upZ * z) - top
    farSolid.within(matrix, () => {
      paepae(farSolid, L, D, g, seed)
      tally('platforms')
      frame(farSolid, roof)
      ridgePins(farSolid, roof)
      tally('frames')
    })
    farFibre.within(matrix, () => thatch(farFibre, roof))
    tally('thatch')
    note(id, label, room.x, room.z, Math.hypot(L / 2, D / 2))
    notes.push(`${id}: moved ${room.moved.toFixed(1)} from where it was wanted, floor ${(top + fire.y).toFixed(2)} m`)
    return { x: room.x, z: room.z, top, L, D, matrix, roof }
  }
  /** A mat on a level floor. */
  const mat = (b: Batch, x: number, z: number, len: number, wid: number, turn: number, seed: number, y = 0.045) => {
    const c = Math.cos(turn)
    const s = Math.sin(turn)
    const at = (a: number, bb: number) => v3(x + c * a + s * bb, y, z - s * a + c * bb)
    const shade = 0.8 + hash(seed) * 0.22
    tone.setRGB(shade, shade * 0.98, shade * 0.92)
    const u = hash(seed * 3.1)
    b.quad(at(-len / 2, wid / 2), at(len / 2, wid / 2), at(len / 2, -wid / 2), at(-len / 2, -wid / 2), tone, [u, wvFoot, u + len / 0.62, wvHead])
  }

  const along = (s: number) => s * toCove
  // The sleeping house: along the hill from the fire, on its own level
  const sleep = house('sleeping_house', 'Sleeping house', 1.6, along(-7.6), 4.4, 2.9, 2.3, 11, 6)
  // The cook house: smaller, stepped up the hill behind it
  const cook = house('cook_house', 'Cook house', sleep.x * upX + sleep.z * upZ + 5.1, sleep.x * sX + sleep.z * sZ + along(-1.4), 3.2, 2.5, 2.25, 47, 6)

  // What is in the sleeping house: three mats, bark cloth, head rests, things kept in the rafters
  nearFibre.within(sleep.matrix, () => {
    const beds: [number, number][] = [
      [-1.15, -0.62],
      [0.95, -0.62],
      [-0.1, 0.62],
    ]
    beds.forEach(([x, z], i) => {
      mat(nearFibre, x, z, 1.9, 0.78, 0, 20 + i)
      // Bark cloth folded at the foot of each
      const fold = new THREE.BoxGeometry(0.46, 0.07, 0.5).toNonIndexed()
      const uv = fold.attributes.uv
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 0.9 + i * 0.3, tpHead + (tpFoot - tpHead) * uv.getY(k))
      nearFibre.add(place(fold, x + 0.62, 0.085, z), WHITE)
    })
    // A blind of matting rolled up under the uphill eave, and one let half down at the far end
    const zp = roofOf(sleep.roof).zp
    const roll = new THREE.CylinderGeometry(0.075, 0.075, 1.7, 7, 1, true).toNonIndexed()
    roll.rotateZ(Math.PI / 2)
    const ruv = roll.attributes.uv
    for (let k = 0; k < ruv.count; k++) ruv.setXY(k, ruv.getY(k) * 2.4, wvHead + (wvFoot - wvHead) * Math.abs(ruv.getX(k) * 2 - 1))
    place(roll, 1.05, sleep.roof.plate - 0.14, -zp - 0.02)
    // and a second with a hand's breadth of it let down, still well above a head
    const roll2 = roll.clone()
    nearFibre.add(roll, tone.setRGB(0.86, 0.84, 0.78))
    nearFibre.add(place(roll2, -2.1, 0, 0), tone.setRGB(0.8, 0.78, 0.72))
    tone.setRGB(0.9, 0.88, 0.82)
    nearFibre.quad(v3(-1.9, sleep.roof.plate - 0.52, -zp - 0.03), v3(-0.2, sleep.roof.plate - 0.52, -zp - 0.03), v3(-0.2, sleep.roof.plate - 0.16, -zp - 0.03), v3(-1.9, sleep.roof.plate - 0.16, -zp - 0.03), tone, [0, wvFoot, 2.6, wvHead])
    // A basket hung from a tie, out of the rats' reach
    basket(nearFibre, 0.55, sleep.roof.plate - 0.62, 0.25, 0.17, 0.26, 31)
  })
  nearSolid.within(sleep.matrix, () => {
    const beds: [number, number][] = [
      [-1.15, -0.62],
      [0.95, -0.62],
      [-0.1, 0.62],
    ]
    for (const [x, z] of beds) {
      // A head rest: a bar on two feet
      stick(nearSolid, v3(x - 0.78, 0.15, z - 0.17), v3(x - 0.78, 0.15, z + 0.17), 0.028, 0.028, WOOD_BOWL, 5, true)
      if (rich) for (const side of [-1, 1]) stick(nearSolid, v3(x - 0.78, 0.03, z + side * 0.13), v3(x - 0.78, 0.15, z + side * 0.13), 0.02, 0.016, WOOD_BOWL, 4)
    }
    stick(nearSolid, v3(0.55, sleep.roof.plate - 0.34, 0.25), v3(0.55, sleep.roof.plate + 0.12, 0.25), 0.006, 0.006, CORD, 3)
    // Spear shafts and a paddle laid up across the ties, where long things live
    const y = sleep.roof.plate + 0.21
    for (let i = 0; i < 3; i++) stick(nearSolid, v3(-2.3, y, -0.5 + i * 0.09), v3(2.25 - i * 0.2, y + 0.01, -0.46 + i * 0.1), 0.017, 0.012, grain(POLE_PALE, POLE, i), 4)
    paddle(nearSolid, v3(-1.9, y + 0.01, 0.55), v3(-0.3, y + 0.01, 0.48), 3)
    // A paddle and two more shafts stood against the seaward corner post
    const zp = roofOf(sleep.roof).zp
    paddle(nearSolid, v3(sleep.L / 2 - 0.42, 1.52, zp - 0.06), v3(sleep.L / 2 - 0.62, 0.05, zp - 0.5), 5)
    stick(nearSolid, v3(sleep.L / 2 - 0.2, 0.02, zp - 0.42), v3(sleep.L / 2 - 0.3, 2.28, zp - 0.05), 0.017, 0.012, grain(POLE_PALE, POLE, 7), 4)
    stick(nearSolid, v3(sleep.L / 2 - 0.34, 0.02, zp - 0.6), v3(sleep.L / 2 - 0.3, 2.2, zp - 0.1), 0.017, 0.012, grain(POLE_PALE, POLE, 8), 4)
  })

  // What is in the cook house: baskets of food, water, a bowl, bananas, the dry wood
  nearFibre.within(cook.matrix, () => {
    basket(nearFibre, -1.05, 0.03, -0.6, 0.26, 0.34, 51)
    basket(nearFibre, -0.5, 0.03, -0.72, 0.2, 0.24, 52)
    if (rich) basket(nearFibre, -1.1, 0.03, 0.05, 0.19, 0.2, 53, 1.3)
    mat(nearFibre, 0.35, 0.45, 1.3, 0.8, 0, 54)
  })
  nearSolid.within(cook.matrix, () => {
    heap(nearSolid, -1.05, 0.3, -0.6, 0.15, rich ? 5 : 2, 0.085, BREADFRUIT, NUT_GREEN, 61)
    heap(nearSolid, -0.5, 0.2, -0.72, 0.1, rich ? 4 : 1, 0.07, HUSK, BARK, 62)
    gourd(nearSolid, 0.25, 0.03, -0.82, 1.15, 63)
    if (rich) gourd(nearSolid, 0.6, 0.03, -0.76, 0.95, 64)
    // A wooden bowl on four feet, and the pounder that goes with it
    const bowl = stripBasic(
      new THREE.LatheGeometry(
        [
          [0.02, 0.07],
          [0.16, 0.08],
          [0.24, 0.15],
          [0.27, 0.2],
          [0.245, 0.2],
          [0.16, 0.12],
          [0.01, 0.1],
        ].map(([pr, py]) => new THREE.Vector2(pr, py)),
        rich ? 10 : 6,
      ),
    )
    nearSolid.add(place(bowl, 0.45, 0.04, 0.4), WOOD_BOWL)
    for (let i = 0; i < (rich ? 4 : 0); i++) {
      const a = (i / 4) * TAU + 0.4
      stick(nearSolid, v3(0.45 + Math.cos(a) * 0.14, 0.04, 0.4 + Math.sin(a) * 0.14), v3(0.45 + Math.cos(a) * 0.12, 0.13, 0.4 + Math.sin(a) * 0.12), 0.022, 0.026, WOOD_BOWL, 4)
    }
    const pounder = stripBasic(
      new THREE.LatheGeometry(
        [
          [0.005, 0],
          [0.07, 0.01],
          [0.06, 0.05],
          [0.028, 0.1],
          [0.026, 0.17],
          [0.04, 0.2],
          [0.005, 0.215],
        ].map(([pr, py]) => new THREE.Vector2(pr, py)),
        6,
      ),
    )
    if (rich) nearSolid.add(place(pounder, 0.86, 0.045, 0.62), STONE_PALE)
    else pounder.dispose()
    cup(nearSolid, 0.05, 0.045, 0.72, 65)
    cup(nearSolid, 0.2, 0.045, 0.84, 66)
    // Green bananas hung from the tie to ripen
    const zp = roofOf(cook.roof).zp
    const hangY = cook.roof.plate + 0.1
    stick(nearSolid, v3(1.2, hangY, 0.2), v3(1.2, hangY - 0.62, 0.2), 0.022, 0.016, NUT_GREEN, 4)
    const hands = rich ? 4 : 2
    for (let h = 0; h < hands; h++) {
      const fingers = rich ? 6 : 3
      for (let f = 0; f < fingers; f++) {
        const a = (f / fingers) * TAU + h * 0.5
        const y = hangY - 0.2 - h * 0.12
        stick(nearSolid, v3(1.2 + Math.cos(a) * 0.03, y, 0.2 + Math.sin(a) * 0.03), v3(1.2 + Math.cos(a) * 0.105, y + 0.12, 0.2 + Math.sin(a) * 0.105), 0.022, 0.014, BANANA, 4)
      }
    }
    // The dry wood, stacked under the eave at the end
    const logs = rich ? 12 : 6
    for (let i = 0; i < logs; i++) {
      const row = Math.floor(i / 4)
      const col = i % 4
      const r = 0.05 + hash(70 + i) * 0.018
      const z = -zp + 0.3 + col * 0.125 + (row % 2) * 0.06
      const y = 0.09 + row * 0.115
      const x = cook.L / 2 - 0.62 + (hash(80 + i) - 0.5) * 0.08
      const g = pole(v3(x - 0.34, y, z), v3(x + 0.34, y, z), r, r * 0.92, 5, grain(BARK, BARK_DARK, i), true)
      nearSolid.add(g)
    }
  })
  // Water gourds slung in a net from the cook house's seaward plate
  nearFibre.within(cook.matrix, () => {
    const zp = roofOf(cook.roof).zp
    tone.setRGB(0.9, 0.88, 0.8)
    for (const x of [-0.2, 0.25]) {
      nearFibre.quad(v3(x - 0.16, cook.roof.plate - 0.62, zp + 0.02), v3(x + 0.16, cook.roof.plate - 0.62, zp + 0.02), v3(x + 0.02, cook.roof.plate - 0.02, zp), v3(x - 0.02, cook.roof.plate - 0.02, zp), tone, [0, ntFoot, 0.5, ntHead])
    }
  })
  nearSolid.within(cook.matrix, () => {
    const zp = roofOf(cook.roof).zp
    gourd(nearSolid, -0.2, cook.roof.plate - 0.66, zp + 0.02, 0.9, 67)
    gourd(nearSolid, 0.25, cook.roof.plate - 0.66, zp + 0.02, 1.0, 68)
  })

  tally('furnishings')

  // —— the hearth ——
  const approach = new THREE.Vector2(places.landing.x - fire.x, places.landing.z - fire.z).normalize()
  /** Oru sits across the fire from the way in, Tala to one side of him (the rule tribe-sim.ts seats them by). */
  const oru = new THREE.Vector2(-approach.x, -approach.y)
  const tala = new THREE.Vector2(approach.y, -approach.x)
  const potAt = new THREE.Vector2(fx(0.6, 0.55 * toCove), fz(0.6, 0.55 * toCove)).normalize()
  {
    // A ring of stones, blackened on the side that faces the fire, with a gap where the pot stands
    const ring = 11
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * TAU + (hash(i * 1.7 + 30) - 0.5) * 0.24
      if (Math.cos(a) * potAt.x + Math.sin(a) * potAt.y > 0.93) continue
      const r = 0.76 + (hash(i * 2.9 + 30) - 0.5) * 0.08
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      const sx = 0.16 + hash(i * 3.3 + 30) * 0.05
      const sy = 0.1 + hash(i * 5.1 + 30) * 0.045
      const sz = 0.13 + hash(i * 7.3 + 30) * 0.04
      const g = lump(100 + i)
      place(g, x, G(x, z) + sy * 0.4, z, groundQ(x, z, -a, q), sx, sy, sz)
      paintFaces(g, (p, n, c) => {
        const len = Math.hypot(p.x, p.z) || 1
        const inward = -(n.x * p.x + n.z * p.z) / len
        c.copy(n.y > 0.6 ? STONE_TOP : STONE)
        if (inward > 0.15) c.lerp(SOOT, 0.85)
      })
      hearth.add(g)
    }
    // The ash bed, lying on the slope as the ground does
    const ash = stripBasic(new THREE.CylinderGeometry(0.6, 0.64, 0.035, rich ? 14 : 10, 1))
    paintFaces(ash, (p, _n, c) => {
      c.copy(ASH).lerp(ASH_WHITE, hash(p.x * 31.7 + p.z * 17.3) * 0.6)
      c.lerp(SOOT, (1 - smooth(Math.hypot(p.x, p.z), 0.1, 0.42)) * 0.7)
    })
    hearth.add(place(ash, 0, G(0, 0) + 0.014, 0, groundQ(0, 0, 0, q)))

    // A star of logs burnt down from the middle and pushed in as they go
    const logs = 5
    for (let i = 0; i < logs; i++) {
      const a = Math.atan2(potAt.y, potAt.x) + 0.63 + i * (TAU / logs) + (hash(i * 6.1 + 50) - 0.5) * 0.3
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      const inner = v3(ca * 0.12, G(0, 0) + 0.15, sa * 0.12)
      const outer = v3(ca * 1.04, G(ca * 1.04, sa * 1.04) + 0.065, sa * 1.04)
      const len = inner.distanceTo(outer)
      // y runs from the outer end (-len/2) to the burning one
      hearth.add(
        pole(outer, inner, 0.07, 0.055, SIDES, (p, n, c) => {
          if (Math.abs(n.y) > 0.9) c.copy(CUT)
          else if (p.y > len * 0.18) c.copy(CHAR)
          else c.copy(BARK).lerp(BARK_DARK, 0.5 + 0.5 * Math.sin(Math.atan2(p.x, p.z) * 4 + p.y * 3 + i))
        }, true, 4),
      )
      const tip = inner.clone().lerp(outer, -0.02)
      coals.add(pole(inner.clone().lerp(outer, 0.1), tip, 0.058, 0.05, SIDES, (p, _n, c) => {
        c.copy(hash(p.x * 51 + p.z * 37 + i) > 0.35 ? EMBER_HOT : EMBER_DULL)
      }, true))
    }
    // Kindling stood in a cone over the coals: what the flames climb
    for (let i = 0; i < (rich ? 6 : 4); i++) {
      const a = (i / (rich ? 6 : 4)) * TAU + 0.3
      const r = 0.27 + hash(i * 4.1) * 0.08
      hearth.add(pole(v3(Math.cos(a) * r, G(0, 0) + 0.05, Math.sin(a) * r), v3(Math.cos(a) * 0.03, G(0, 0) + 0.44 + hash(i) * 0.08, Math.sin(a) * 0.03), 0.02, 0.014, 4, CHAR))
    }
    // The bed of coals: bright in the heart, crusted and dull at the rim
    const bed = stripBasic(new THREE.CylinderGeometry(0.2, 0.36, 0.07, rich ? 10 : 7, 1))
    paintFaces(bed, (p, n, c) => {
      const d = Math.hypot(p.x, p.z)
      if (n.y > 0.5) c.copy(EMBER_WHITE).lerp(EMBER_HOT, smooth(d, 0.03, 0.16))
      else c.copy(hash(p.x * 71 + p.z * 43) > 0.45 ? EMBER_HOT : EMBER_DULL)
    })
    coals.add(place(bed, 0, G(0, 0) + 0.055, 0, groundQ(0, 0, 0, q)))
    const count = rich ? 16 : 10
    for (let i = 0; i < count; i++) {
      const a = hash(i * 3.7 + 60) * TAU
      const r = 0.1 + Math.sqrt(hash(i * 5.9 + 60)) * 0.3
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      const g = lump(120 + i)
      place(g, x, G(x, z) + 0.06 + (1 - r / 0.4) * 0.05, z, q.setFromAxisAngle(UP, a), 0.05 + hash(i * 2.1) * 0.03, 0.035, 0.045 + hash(i * 4.3) * 0.025)
      paintFaces(g, (p, n, c) => {
        const heat = hash(p.x * 91.3 + p.z * 57.1 + i)
        if (n.y < -0.1) c.copy(EMBER_CRUST)
        else c.copy(heat > 0.62 ? EMBER_WHITE : heat > 0.25 ? EMBER_HOT : r > 0.28 ? EMBER_CRUST : EMBER_DULL)
      })
      coals.add(g)
    }

    // A clay pot set on three stones at the edge of the coals
    const px = potAt.x * 0.78
    const pz = potAt.y * 0.78
    const py = G(px, pz)
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.5
      const g = lump(140 + i)
      place(g, px + Math.cos(a) * 0.16, py + 0.06, pz + Math.sin(a) * 0.16, q.setFromAxisAngle(UP, a), 0.085, 0.085, 0.075)
      hearth.add(g, tone.copy(STONE).lerp(SOOT, 0.6))
    }
    const pot = stripBasic(
      new THREE.LatheGeometry(
        [
          [0.01, 0],
          [0.1, 0.02],
          [0.165, 0.1],
          [0.16, 0.19],
          [0.115, 0.255],
          [0.128, 0.285],
          [0.108, 0.285],
          [0.096, 0.25],
          [0.02, 0.24],
        ].map(([pr, pyy]) => new THREE.Vector2(pr, pyy)),
        rich ? 10 : 7,
      ),
    )
    paintVerts(pot, (p, _n, c) => {
      c.copy(CLAY).lerp(SOOT, (1 - smooth(p.y, 0.03, 0.2)) * 0.9)
    })
    hearth.add(place(pot, px, py + 0.12, pz))

    // Two fish on sticks, leant in over the heat from the far side
    for (let i = 0; i < 2; i++) {
      const a = Math.atan2(potAt.y, potAt.x) + Math.PI + (i === 0 ? -0.42 : 0.5)
      const foot = v3(Math.cos(a) * 0.98, G(Math.cos(a) * 0.98, Math.sin(a) * 0.98) - 0.05, Math.sin(a) * 0.98)
      const head = v3(Math.cos(a) * 0.36, G(0, 0) + 0.72, Math.sin(a) * 0.36)
      hearth.add(pole(foot, head, 0.014, 0.01, 4, POLE_DARK))
      const lean = tone3.subVectors(foot, head).normalize().clone()
      fish(hearth, head.clone().addScaledVector(lean, -0.04), 0.3, a, 150 + i, lean.negate())
    }

    // Seats: a log at Oru's back, a flat stone behind Tala, a second log on the side toward the sea
    const seatLog = (dirX: number, dirZ: number, r: number, len: number, seed: number) => {
      const cx = dirX * r
      const cz = dirZ * r
      const tx = -dirZ
      const tz = dirX
      const a = v3(cx - tx * len * 0.5, 0, cz - tz * len * 0.5)
      const b = v3(cx + tx * len * 0.5, 0, cz + tz * len * 0.5)
      a.y = G(a.x, a.z) + 0.15
      b.y = G(b.x, b.z) + 0.15
      hearth.add(pole(a, b, 0.17, 0.155, rich ? 9 : 7, grain(BARK, BARK_DARK, seed), true))
      note('seat_' + seed, 'Seat log', cx, cz, len / 2)
    }
    seatLog(oru.x, oru.y, 2.55, 1.7, 1)
    const side = new THREE.Vector2(oru.x * 0.55 - tala.x * 0.83, oru.y * 0.55 - tala.y * 0.83).normalize()
    if (laneDistance(side.x * 2.75, side.y * 2.75) > LANE_HALF + 0.3) seatLog(side.x, side.y, 2.75, 1.5, 2)
    {
      const x = tala.x * 2.6
      const z = tala.y * 2.6
      const g = lump(160, 1)
      place(g, x, G(x, z) + 0.12, z, groundQ(x, z, 0.4, q), 0.36, 0.19, 0.3)
      paintFaces(g, (_p, n, c) => {
        c.copy(n.y > 0.55 ? STONE_TOP : STONE)
      })
      hearth.add(g)
      note('seat_stone', 'Sitting stone', x, z, 0.45)
    }
    // Cups and a bowl put down at the end of Oru's log
    const cx = oru.x * 2.2 + oru.y * 0.95
    const cz = oru.y * 2.2 - oru.x * 0.95
    cup(hearth, cx, G(cx, cz), cz, 170)
    cup(hearth, cx + 0.16, G(cx + 0.16, cz + 0.1), cz + 0.1, 171)
  }
  // Mats where Oru and Tala sit, lying on the slope
  for (const [seat, seed] of [
    [oru, 180],
    [tala, 181],
  ] as const) {
    const cx = seat.x * 1.72
    const cz = seat.y * 1.72
    const hw = 0.5
    const hd = 0.42
    const at = (a: number, b: number) => {
      const x = cx - seat.y * a + seat.x * b
      const z = cz + seat.x * a + seat.y * b
      return v3(x, G(x, z) + 0.035, z)
    }
    tone.setRGB(0.86, 0.84, 0.78)
    nearFibre.quad(at(-hw, -hd), at(hw, -hd), at(hw, hd), at(-hw, hd), tone, [hash(seed), wvFoot, hash(seed) + 1.5, wvHead])
  }

  tally('hearth')

  // —— between the fire and the houses ——
  // A rack of split fish drying in the sun, on the seaward side
  {
    const room = findRoom(-2.8, along(-5.6), { hu: 0.55, hs: 1.35, reach: 5 })
    const len = 2.5
    const ends = [-len / 2, len / 2].map((a) => {
      const x = room.x + sX * a
      const z = room.z + sZ * a
      return { x, z, y: G(x, z) }
    })
    const topY = Math.max(ends[0].y, ends[1].y) + 1.62
    for (const e of ends) {
      for (const side of [-1, 1]) {
        // Each end is two poles crossed near the top, their feet apart on the slope
        const fx2 = e.x - upX * side * 0.42
        const fz2 = e.z - upZ * side * 0.42
        stick(farSolid, v3(fx2, G(fx2, fz2) - 0.1, fz2), v3(e.x + upX * side * 0.07, topY + 0.16, e.z + upZ * side * 0.07), 0.035, 0.026, grain(POLE, POLE_DARK, side + e.x))
      }
    }
    const a = v3(ends[0].x - sX * 0.2, topY, ends[0].z - sZ * 0.2)
    const b = v3(ends[1].x + sX * 0.2, topY, ends[1].z + sZ * 0.2)
    stick(farSolid, a, b, 0.026, 0.022, POLE_PALE, 5, true)
    const low = 0.52
    stick(farSolid, v3(a.x - upX * 0.14, topY - low, a.z - upZ * 0.14), v3(b.x - upX * 0.14, topY - low, b.z - upZ * 0.14), 0.02, 0.018, POLE_PALE, 4)
    const hung = rich ? 9 : 6
    for (let i = 0; i < hung; i++) {
      const t = (i + 0.5) / hung
      const at = a.clone().lerp(b, 0.08 + t * 0.84)
      at.y -= 0.03
      fish(nearSolid, at, 0.3 + hash(200 + i) * 0.12, yaw + (hash(210 + i) - 0.5) * 0.7, 220 + i)
    }
    note('fish_rack', 'Fish-drying rack', room.x, room.z, 1.4)
    tally('fishRack')
  }
  // An earth oven: a shallow ring of stones heaped with the fire-cracked cobbles it is cooked on
  {
    const room = findRoom(4.4, along(-3.9), { hu: 0.75, hs: 0.75, reach: 4 })
    const ring = rich ? 9 : 5
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * TAU
      const x = room.x + Math.cos(a) * 0.62
      const z = room.z + Math.sin(a) * 0.62
      const g = lump(240 + i)
      place(g, x, G(x, z) + 0.05, z, groundQ(x, z, a, q), 0.17, 0.11, 0.14)
      nearSolid.add(g, tone.copy(STONE).lerp(STONE_DARK, hash(i * 2.3)))
    }
    for (let i = 0; i < (rich ? 9 : 3); i++) {
      const a = hash(250 + i) * TAU
      const d = Math.sqrt(hash(260 + i)) * 0.42
      const x = room.x + Math.cos(a) * d
      const z = room.z + Math.sin(a) * d
      const g = lump(270 + i)
      place(g, x, G(x, z) + 0.06 + (1 - d / 0.42) * 0.1, z, q.setFromAxisAngle(UP, a), 0.11, 0.085, 0.1)
      nearSolid.add(g, tone.copy(SOOT).lerp(STONE, 0.25 + hash(i * 3.1) * 0.4))
    }
    note('earth_oven', 'Earth oven', room.x, room.z, 0.8)
    tally('earthOven')
  }
  // A heap of cut wood against two stakes, within reach of the fire
  {
    const room = findRoom(5.0, along(1.3), { hu: 0.6, hs: 0.85, reach: 4 })
    const len = 1.25
    for (const e of [-1, 1]) {
      const x = room.x + sX * e * (len / 2 - 0.12) - upX * 0.5
      const z = room.z + sZ * e * (len / 2 - 0.12) - upZ * 0.5
      stick(farSolid, v3(x, G(x, z) - 0.15, z), v3(x - upX * 0.05, G(x, z) + 0.75, z - upZ * 0.05), 0.035, 0.028, grain(POLE, POLE_DARK, e))
    }
    const layers = rich ? [5, 4, 3] : [3, 2]
    layers.forEach((n, layer) => {
      for (let i = 0; i < n; i++) {
        const r = (rich ? 0.05 : 0.065) + hash(300 + layer * 9 + i) * 0.035
        // Each log lies along the hill, resting on the slope or on the two beneath it
        const across = -0.4 + (i + layer * 0.5) * 0.135
        const x = room.x + upX * across
        const z = room.z + upZ * across
        const y = G(x, z) + r + layer * 0.105 + Math.max(0, -across * 0.22)
        const skew = (hash(310 + layer * 7 + i) - 0.5) * 0.22
        const l0 = len / 2 - hash(320 + layer * 3 + i) * 0.22
        const l1 = len / 2 - hash(325 + layer * 5 + i) * 0.22
        const a = v3(x - sX * l0 + upX * skew, y, z - sZ * l0 + upZ * skew)
        const b = v3(x + sX * l1 - upX * skew, y + (hash(327 + i) - 0.5) * 0.04, z + sZ * l1 - upZ * skew)
        farSolid.add(pole(a, b, r, r * 0.9, 5, grain(BARK, BARK_DARK, layer * 5 + i), true))
      }
    })
    note('woodpile', 'Woodpile', room.x, room.z, 0.9)
    tally('woodpile')
  }
  // The midden: a low drift of years of shells, down the hill where they are thrown
  {
    const room = findRoom(-6.4, along(-2.4), { hu: 1.0, hs: 1.2, reach: 5 })
    const rings = 3
    const spokes = rich ? 10 : 7
    const rx = 1.05
    const rz = 1.3
    const point = (ring: number, k: number) => {
      const a = (k / spokes) * TAU
      const d = ring / rings
      const wob = 0.85 + hash(330 + k * 3.1) * 0.3
      const x = room.x + (upX * Math.cos(a) * rx + sX * Math.sin(a) * rz) * d * wob
      const z = room.z + (upZ * Math.cos(a) * rx + sZ * Math.sin(a) * rz) * d * wob
      return v3(x, G(x, z) + 0.02 + 0.16 * (1 - d * d) * (ring === rings ? 0 : 1), z)
    }
    for (let ring = 0; ring < rings; ring++) {
      for (let k = 0; k < spokes; k++) {
        // Earth at the rim, shell showing through more toward the top of the heap
        const colour = tone
          .copy(EARTH)
          .lerp(hash(340 + ring * 7 + k) > 0.6 ? SHELL_PINK : SHELL_GREY, hash(350 + ring * 5 + k) > 0.5 + ring * 0.17 ? 0.6 : 0.1)
          .clone()
        const centre = v3(room.x, G(room.x, room.z) - 1, room.z)
        if (ring === 0) nearSolid.tri(point(0, 0), point(1, k + 1), point(1, k), colour)
        else facing(nearSolid, point(ring, k), point(ring, k + 1), point(ring + 1, k + 1), point(ring + 1, k), centre, true, colour)
      }
    }
    for (let i = 0; i < (rich ? 22 : 8); i++) {
      const a = hash(360 + i) * TAU
      const d = 0.15 + hash(370 + i) * 1.25
      const x = room.x + (upX * Math.cos(a) + sX * Math.sin(a)) * d - upX * 0.3
      const z = room.z + (upZ * Math.cos(a) + sZ * Math.sin(a)) * d - upZ * 0.3
      const g = stripBasic(new THREE.OctahedronGeometry(1, 0))
      place(g, x, G(x, z) + 0.025 + 0.15 * Math.max(0, 1 - (d * d) / 1.2), z, groundQ(x, z, a, q), 0.05 + hash(i) * 0.04, 0.025, 0.045)
      nearSolid.add(g, tone.copy(SHELL).lerp(hash(385 + i) > 0.5 ? SHELL_PINK : SHELL_GREY, hash(380 + i) * 0.7))
    }
    note('midden', 'Shell midden', room.x, room.z, 1.3)
    tally('midden')
  }

  // —— down on the beach ——
  // The outrigger, hauled up bow-first above the tide and left lying on the slope
  let canoeAt: { x: number; z: number } | null = null
  {
    // The gentlest dry ground below the camp, a canoe's length clear of rock and tree
    let best = Infinity
    let bu = -15
    let bs = 0
    for (let u = -8; u >= -26; u -= 0.5) {
      for (let s = -16; s <= 16; s += 0.5) {
        const x = fx(u, s)
        const z = fz(u, s)
        const y = H(fire.x + x, fire.z + z)
        if (y < 1.75 || y > 3.6) continue
        const sternY = H(fire.x + fx(u - 2.4, s), fire.z + fz(u - 2.4, s))
        if (sternY < 1.2) continue
        if (laneDistance(x, z) < LANE_HALF + 1.5) continue
        let ok = true
        for (let a = -2.8; a <= 2.8 && ok; a += 0.7) {
          for (let b = -0.6; b <= 2.0 && ok; b += 0.65) if (blocked(fx(u + a, s + b), fz(u + a, s + b), 0.5)) ok = false
        }
        if (!ok) continue
        const slope = Math.abs(H(fire.x + fx(u + 2, s), fire.z + fz(u + 2, s)) - sternY) / 4.4
        const score = slope * 14 + Math.abs(s - along(-3)) * 0.22 + Math.abs(y - 2.5) * 0.8
        if (score < best) {
          best = score
          bu = u
          bs = s
        }
      }
    }
    const cx = fx(bu, bs)
    const cz = fz(bu, bs)
    canoeAt = { x: cx, z: cz }
    rooms.push({ u: bu, s: bs, hu: 2.9, hs: 1.9 })
    // Her own frame: x toward the bow (up the hill), z toward the float, y off the sand
    const bow = v3(cx + upX * 2.1, 0, cz + upZ * 2.1)
    const stern = v3(cx - upX * 2.1, 0, cz - upZ * 2.1)
    bow.y = G(bow.x, bow.z)
    stern.y = G(stern.x, stern.z)
    // The float lies on the side that keeps her frame right-handed with y up
    const float = v3(cx + sX * 1.55, 0, cz + sZ * 1.55)
    float.y = G(float.x, float.z)
    const X = bow.clone().sub(stern).normalize()
    const centre = bow.clone().add(stern).multiplyScalar(0.5)
    const Z = float.clone().sub(centre)
    Z.addScaledVector(X, -Z.dot(X)).normalize()
    const Y = new THREE.Vector3().crossVectors(Z, X)
    const hullM = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(centre.x, centre.y + 0.1, centre.z)
    farSolid.within(hullM, () => {
      const half = 2.75
      const n = rich ? 11 : 8
      const th = 0.03
      type Section = { outer: THREE.Vector3[]; inner: THREE.Vector3[] }
      const sections: Section[] = []
      for (let i = 0; i < n; i++) {
        const t = -1 + (2 * i) / (n - 1)
        const x = t * half
        const at = Math.abs(t)
        const b = 0.25 * Math.pow(Math.max(0, 1 - Math.pow(at, 2.4)), 0.55) + 0.012
        const keel = 0.2 * Math.pow(at, 3)
        const sheer = 0.45 + 0.17 * Math.pow(at, 2.6)
        const bi = Math.max(0.004, b - th)
        const outer = [-1, -0.92, -0.52, 0, 0.52, 0.92, 1].map((k, j) => {
          const y = j === 0 || j === 6 ? sheer : j === 1 || j === 5 ? keel + (sheer - keel) * 0.45 : j === 3 ? keel : keel + 0.055
          return v3(x, y, k * b)
        })
        const inner = [-1, -0.9, -0.48, 0, 0.48, 0.9, 1].map((k, j) => {
          const y = j === 0 || j === 6 ? sheer : j === 1 || j === 5 ? keel + 0.05 + (sheer - keel) * 0.45 : j === 3 ? keel + 0.07 : keel + 0.1
          return v3(x * 0.985, Math.min(sheer, y), k * bi)
        })
        sections.push({ outer, inner })
      }
      for (let i = 0; i + 1 < n; i++) {
        const a = sections[i]
        const b = sections[i + 1]
        const heart = v3((a.outer[3].x + b.outer[3].x) / 2, (a.outer[3].y + a.outer[0].y) / 2 + 0.05, 0)
        for (let k = 0; k < 6; k++) {
          // Dark oiled sides, an ochre strake under the gunwale, worn pale along the keel where she is dragged
          const girth = (j: number) => (j === 0 || j === 6 ? HULL_RAIL : j === 3 ? HULL_WORN : j === 2 || j === 4 ? HULL_MID : HULL)
          facing(farSolid, a.outer[k], b.outer[k], b.outer[k + 1], a.outer[k + 1], heart, true, girth(k), girth(k + 1))
          facing(farSolid, a.inner[k], b.inner[k], b.inner[k + 1], a.inner[k + 1], heart, false, HULL_IN)
        }
        // The gunwales
        const below = v3(heart.x, -1, 0)
        facing(farSolid, a.outer[0], b.outer[0], b.inner[0], a.inner[0], below, true, POST_DARK)
        facing(farSolid, a.outer[6], b.outer[6], b.inner[6], a.inner[6], below, true, POST_DARK)
      }
      // Two booms lashed across her, arching out to the float
      for (const bx of [-0.95, 0.95]) {
        const pts = [v3(bx, 0.49, -0.34), v3(bx, 0.53, 0.5), v3(bx, 0.44, 1.15), v3(bx, 0.3, 1.52)]
        for (let k = 0; k + 1 < pts.length; k++) stick(farSolid, pts[k], pts[k + 1], 0.032, 0.03, grain(POLE, POLE_DARK, bx + k), 5, k === 0)
        // Sennit where each boom crosses a gunwale
        if (rich) for (const z of [-0.26, 0.26]) stick(farSolid, v3(bx - 0.05, 0.5, z), v3(bx + 0.05, 0.5, z), 0.045, 0.045, CORD, 5)
        // and the pegs that carry the float
        for (const side of [-1, 1]) stick(farSolid, v3(bx + side * 0.09, 0.36, 1.48), v3(bx - side * 0.02, 0.02, 1.55), 0.016, 0.014, POLE_DARK, 4)
      }
      const ama: THREE.Vector3[] = []
      for (let i = 0; i <= 4; i++) {
        const t = -1 + i / 2
        ama.push(v3(t * 1.95, -0.015 + 0.14 * Math.pow(Math.abs(t), 2.5), 1.55))
      }
      for (let k = 0; k + 1 < ama.length; k++) {
        const r0 = k === 0 ? 0.03 : 0.085
        const r1 = k === 3 ? 0.03 : 0.085
        stick(farSolid, ama[k], ama[k + 1], r0, r1, grain(POLE_PALE, POLE, k), rich ? 6 : 5, true)
      }
      // Thwarts, and a paddle left in her
      for (const tx of [-0.5, 0.7]) stick(farSolid, v3(tx, 0.37, -0.2), v3(tx, 0.37, 0.2), 0.03, 0.03, POLE, 4, true)
      paddle(farSolid, v3(1.5, 0.52, -0.05), v3(-0.05, 0.3, 0.06), 9)
    })
    // The logs she is rolled up the beach on
    for (const d of [-1.3, 0.9]) {
      const x = cx + upX * d
      const z = cz + upZ * d
      const a = v3(x - sX * 0.55, 0, z - sZ * 0.55)
      const b = v3(x + sX * 0.55, 0, z + sZ * 0.55)
      a.y = G(a.x, a.z) + 0.06
      b.y = G(b.x, b.z) + 0.06
      farSolid.add(pole(a, b, 0.07, 0.065, 5, grain(BARK, BARK_DARK, d), true))
    }
    note('canoe', 'Outrigger canoe', cx, cz, 2.9)
    tally('canoe')
  }
  // A net hung over a pole to dry, at the top of the beach
  {
    const want = canoeAt ? canoeAt.x * upX + canoeAt.z * upZ + 4.4 : -10
    const wantS = canoeAt ? canoeAt.x * sX + canoeAt.z * sZ - 2.6 * toCove : along(-3)
    const room = findRoom(want, wantS, { hu: 0.6, hs: 1.5, reach: 5 })
    const len = 2.6
    const ends = [-len / 2, len / 2].map((a) => {
      const x = room.x + sX * a
      const z = room.z + sZ * a
      return v3(x, G(x, z), z)
    })
    const topY = Math.max(ends[0].y, ends[1].y) + 1.72
    for (const e of ends) stick(farSolid, v3(e.x, e.y - 0.2, e.z), v3(e.x, topY + 0.1, e.z), 0.04, 0.03, grain(POLE, POLE_DARK, e.x))
    const a = v3(ends[0].x - sX * 0.25, topY, ends[0].z - sZ * 0.25)
    const b = v3(ends[1].x + sX * 0.25, topY, ends[1].z + sZ * 0.25)
    stick(farSolid, a, b, 0.024, 0.02, POLE_PALE, 5, true)
    tone.setRGB(0.92, 0.9, 0.82)
    for (const side of [-1, 1]) {
      // It hangs in two falls, one each side of the pole, the uphill one shorter
      const drop = side < 0 ? 1.25 : 0.95
      const out = side * 0.26
      const a0 = v3(a.x + sX * 0.3, topY + 0.02, a.z + sZ * 0.3)
      const b0 = v3(b.x - sX * 0.3, topY + 0.02, b.z - sZ * 0.3)
      const a1 = v3(a0.x - upX * out + sX * 0.1, topY - drop, a0.z - upZ * out + sZ * 0.1)
      const b1 = v3(b0.x - upX * out - sX * 0.14, topY - drop + 0.12, b0.z - upZ * out - sZ * 0.14)
      farFibre.quad(a1, b1, b0, a0, tone, [0, ntFoot, 3.2, ntHead])
      // Floats along the foot of it
      if (side < 0 && rich) {
        for (let i = 0; i < 6; i++) {
          const t = (i + 0.5) / 6
          const p = a1.clone().lerp(b1, t)
          const g = lump(400 + i)
          nearSolid.add(place(g, p.x, p.y, p.z, undefined, 0.045, 0.035, 0.045), POLE_PALE)
        }
      }
    }
    note('net_rack', 'Net drying pole', room.x, room.z, 1.5)
    tally('netPole')
  }

  // —— worn ground ——
  // Years of bare feet: the earth between the fire, the pool, the houses and the beach is darker and bare
  const worn = new Batch()
  /** A colour for every corner of `worn`, in the order they were added: the batch itself only shades by the face. */
  const wornColours: THREE.Color[] = []
  {
    /** What the ground is multiplied by where it is worn this much (0 none .. 1 a path's middle). */
    const shade = (e: number) => new THREE.Color(1 - 0.45 * e, 1 - 0.52 * e, 1 - 0.61 * e)
    const strip = (pts: [number, number][], width: number, strength: number) => {
      // Resampled every two thirds of a metre so it lies on the terrain's own facets
      const line: [number, number][] = []
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i]
        const [bx, bz] = pts[i + 1]
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (rich ? 0.66 : 1.1)))
        for (let k = 0; k < n; k++) line.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n])
      }
      line.push(pts[pts.length - 1])
      const across = [-1, -0.45, 0.45, 1]
      const ring = (i: number) => {
        const [x, z] = line[i]
        const [px, pz] = line[Math.max(0, i - 1)]
        const [nx, nz] = line[Math.min(line.length - 1, i + 1)]
        let tx = nx - px
        let tz = nz - pz
        const l = Math.hypot(tx, tz) || 1
        tx /= l
        tz /= l
        const wander = 1 + (hash(i * 3.7 + width) - 0.5) * 0.3
        return across.map((k) => {
          const qx = x - tz * k * width * 0.5 * wander
          const qz = z + tx * k * width * 0.5 * wander
          return v3(qx, G(qx, qz) + 0.05, qz)
        })
      }
      // Fading in at both ends, so a path starts from nothing; clear along both edges
      const wear = (i: number, k: number) => (k === 0 || k === 3 ? 0 : strength * smooth(Math.min(i, line.length - 1 - i), 0, 3))
      for (let i = 0; i + 1 < line.length; i++) {
        const a = ring(i)
        const b = ring(i + 1)
        for (let k = 0; k < 3; k++) {
          worn.tri(a[k], a[k + 1], b[k + 1], WHITE)
          worn.tri(a[k], b[k + 1], b[k], WHITE)
          wornColours.push(shade(wear(i, k)), shade(wear(i, k + 1)), shade(wear(i + 1, k + 1)), shade(wear(i, k)), shade(wear(i + 1, k + 1)), shade(wear(i + 1, k)))
        }
      }
    }
    // Round the fire: trodden hard, and grey with ash nearest the stones
    const spokes = rich ? 18 : 10
    const radii = [0.7, 1.7, 2.8, 4.1]
    const depth = [1.05, 0.92, 0.6, 0]
    const p = (ring: number, j: number) => {
      const a = (j / spokes) * TAU
      const wob = ring === radii.length - 1 ? 0.85 + hash((j % spokes) * 5.3) * 0.3 : 1
      const x = Math.cos(a) * radii[ring] * wob
      const z = Math.sin(a) * radii[ring] * wob
      return v3(x, G(x, z) + 0.05, z)
    }
    for (let r = 0; r + 1 < radii.length; r++) {
      for (let k = 0; k < spokes; k++) {
        worn.tri(p(r, k), p(r + 1, k), p(r + 1, k + 1), WHITE)
        worn.tri(p(r, k), p(r + 1, k + 1), p(r, k + 1), WHITE)
        wornColours.push(shade(depth[r]), shade(depth[r + 1]), shade(depth[r + 1]), shade(depth[r]), shade(depth[r + 1]), shade(depth[r]))
      }
    }
    const from = (x: number, z: number, r: number): [number, number] => {
      const l = Math.hypot(x, z) || 1
      return [(x / l) * r, (z / l) * r]
    }
    // To the pool, round its uphill side, and on up the lane
    strip(
      [
        from(poolX, poolZ, 2.6),
        [poolX * 0.55, poolZ * 0.55],
        [poolX + upX * 2.7, poolZ + upZ * 2.7],
        [poolX + laneX * 6 + upX * 1.2, poolZ + laneZ * 6 + upZ * 1.2],
        [poolX + laneX * 15, poolZ + laneZ * 15],
      ],
      1.5,
      1,
    )
    // To each house: to the downhill corner nearest the fire, where you step up
    for (const h of [sleep, cook]) {
      const toward = Math.sign(-(h.x * sX + h.z * sZ)) || 1
      const cornerX = h.x + sX * toward * (h.L / 2 + 0.5) - upX * (h.D / 2 - 0.3)
      const cornerZ = h.z + sZ * toward * (h.L / 2 + 0.5) - upZ * (h.D / 2 - 0.3)
      strip([from(cornerX, cornerZ, 2.6), [cornerX * 0.6 + upX * 0.4, cornerZ * 0.6 + upZ * 0.4], [cornerX, cornerZ]], 1.1, 0.85)
    }
    // Down to the canoe
    if (canoeAt) {
      const bx = canoeAt.x + upX * 2.9
      const bz = canoeAt.z + upZ * 2.9
      strip([from(bx, bz, 2.6), [bx * 0.55 + sX * 0.8 * toCove, bz * 0.55 + sZ * 0.8 * toCove], [bx, bz]], 1.2, 0.8)
    }
  }

  // —— the meshes ——
  // Under the trees, and under their own roofs, stone and timber with only the
  // light rig to go on crush to ink and the grade turns that navy. So they
  // carry the fill the island's own boulders and driftwood carry (island.ts,
  // stoneFill): warm, the surface's own colour, and mostly from above. It is
  // sky fill, so it goes down with the sky after dark.
  const shapedFill = (albedo: string, gain: number) => (shader: { fragmentShader: string }) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        vec3 fillN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
        totalEmissiveRadiance *= ${albedo} * ${gain.toFixed(2)} * (0.3 + 0.9 * (fillN.y * 0.5 + 0.5));
      }`,
    )
  }
  const solidMat = skyFill(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, emissive: '#7a7160', emissiveIntensity: 0.55 }),
  )
  // (At 4.4 the platforms stood out pale against the hill at dusk, when the sun has gone and the fill has not.)
  solidMat.onBeforeCompile = shapedFill('vColor.rgb', 3)
  solidMat.customProgramCacheKey = () => 'camp-solid-2'
  const fibreMat = skyFill(
    new THREE.MeshStandardMaterial({
      map: campAtlas(lowPower),
      vertexColors: true,
      alphaTest: 0.36,
      side: THREE.DoubleSide,
      roughness: 0.96,
      emissive: '#7a7160',
      emissiveIntensity: 0.55,
    }),
  )
  fibreMat.onBeforeCompile = shapedFill('diffuseColor.rgb', 2.4)
  fibreMat.customProgramCacheKey = () => 'camp-fibre-3'

  // Real fire, so its glow is not sky fill: it burns as bright at midnight as at noon
  const emberMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: '#40362e',
    roughness: 0.95,
    emissive: '#ffb27a',
    emissiveIntensity: 1.6,
  })
  emberMat.onBeforeCompile = emissiveByAlbedo
  emberMat.customProgramCacheKey = () => 'camp-ember-1'

  const wornMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    // The ground's own colour times this one: darker and browner where feet go, whatever the light
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })

  const triangles: Record<string, number> = {}
  const far = new THREE.Group()
  far.name = 'Camp houses'
  far.position.copy(fire)
  const near = new THREE.Group()
  near.name = 'Camp dressing'
  near.position.copy(fire)
  o.parent.add(far, near)
  const mesh = (name: string, batch: Batch, material: THREE.Material, parent: THREE.Object3D, uv: boolean, cast: boolean) => {
    triangles[name] = batch.triangles
    const m = new THREE.Mesh(batch.build(uv), material)
    m.name = name
    // Nothing here is seen in a reflection; shadows only where the budget allows them
    m.layers.set(DETAIL_LAYER)
    if (!cast) m.userData.noCast = true
    parent.add(m)
    return m
  }
  mesh('campHouses', farSolid, solidMat, far, false, rich)
  mesh('campThatch', farFibre, fibreMat, far, true, rich)
  mesh('campThings', nearSolid, solidMat, near, false, false)
  mesh('campWeave', nearFibre, fibreMat, near, true, false)
  const wornGeo = (() => {
    triangles.campGround = worn.triangles
    const g = worn.build(false)
    const col = g.attributes.color as THREE.BufferAttribute
    for (let i = 0; i < wornColours.length && i < col.count; i++) col.setXYZ(i, wornColours[i].r, wornColours[i].g, wornColours[i].b)
    return g
  })()
  const wornMesh = new THREE.Mesh(wornGeo, wornMat)
  wornMesh.name = 'campGround'
  wornMesh.layers.set(DETAIL_LAYER)
  wornMesh.userData.noShadow = true
  wornMesh.renderOrder = 1
  near.add(wornMesh)

  const hearthMesh = mesh('fire', hearth, solidMat, o.fireGroup, false, true)
  const coalMesh = mesh('embers', coals, emberMat, o.fireGroup, false, false)
  coalMesh.userData.noShadow = true
  const flames = createCampFlames(lowPower)
  flames.mesh.position.y = G(0, 0) + 0.04
  flames.mesh.layers.set(DETAIL_LAYER)
  o.fireGroup.add(flames.mesh)
  triangles.flames = flames.triangles

  // —— per frame ——
  const FIRE_FAR2 = FIRE_FAR * FIRE_FAR
  const FAR2 = FAR_SHOW * FAR_SHOW
  const NEAR2 = NEAR_SHOW * NEAR_SHOW
  const light = o.fireLight

  function update(_dt: number, t: number, weather: TribeWeather, eye?: THREE.Vector3) {
    const d2 = eye ? eye.distanceToSquared(fire) : 0
    // Meshes come and go with distance. The light and the group that holds it never do.
    far.visible = d2 < FAR2
    near.visible = d2 < NEAR2
    const burning = d2 < FIRE_FAR2
    hearthMesh.visible = burning
    coalMesh.visible = burning
    flames.mesh.visible = burning
    if (!burning) {
      if (light.intensity !== 0) light.intensity = 0
      return
    }
    const night = 1 - smooth(weather.daylight, 0.2, 0.65)
    const wet = 1 - 0.5 * weather.storm
    const flicker =
      0.8 +
      0.1 * Math.sin(t * 7.3) +
      0.07 * Math.sin(t * 12.9 + 1.3) +
      0.05 * Math.sin(t * 23.1 + 0.4) +
      (Math.random() - 0.5) * 0.05
    light.intensity = FIRE_CANDELA * night * wet * flicker
    // The light breathes with the flame: a little higher when it leaps
    light.position.y = 0.66 + 0.1 * flicker
    emberMat.emissiveIntensity = (1.1 + 1.5 * night) * wet * (0.75 + 0.25 * flicker)
    flames.update(t, (0.7 + 0.3 * night) * wet, night, weather.storm, flicker)
  }

  // Five meshes beyond the hearth's own three (pit, embers, flames), which were there before
  return { sites, triangles, parts, notes, draws: 5, update }
}
