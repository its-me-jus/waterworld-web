import * as THREE from 'three'
import { buildIslander, type IslanderMotion, type IslanderRig } from './npc-mesh'
import { getTribePlaces, type TribePlaces } from './places'
import type {
  HeldItem,
  IslandLike,
  NpcAction,
  NpcId,
  NpcInfo,
  NpcPerceptionSnapshot,
  NpcPose,
  PlayerGesture,
  TidalCavesLike,
  TribePlayerState,
  TribeWeather,
} from './types'

/**
 * The living tribe: Kael, Tala and Oru walking their day on the real island,
 * noticing the player with their own eyes and ears, and the surface the brain
 * (src/ai) uses to make them act.
 *
 * Each islander has a schedule (where they are by day, by night and in a
 * squall), a local behaviour that needs no brain (Kael's standoff, Tala's
 * wary curiosity, Oru watching from the fire), and an override slot the brain
 * fills with `applyAiDecision`. The override holds about twelve seconds and
 * then the local behaviour takes over again.
 *
 * Walking is grounded on `heightAt`: a coarse walkability grid is laid over
 * the island once, A* runs on it when an islander needs to go somewhere new
 * (a few milliseconds, a few times a minute), and a probing steer follows
 * the route frame to frame, looking a couple of metres ahead and turning off
 * anything too steep or too wet. People stay upright on a slope; only the
 * feet follow it.
 *
 * The rules that keep the encounter fair live here and nowhere else, so the
 * brain cannot get round them: Kael never chases without a standing warning,
 * never in the first 45 seconds after the player first comes ashore, never
 * into water deeper than about 0.6 m, and gives up after 20 seconds.
 */

const TAU = Math.PI * 2
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))
const angleDelta = (a: number, b: number) => ((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

// —— tuning ————————————————————————————————————————————————————

/** Ground speeds, m/s. The charge beats the player's 2.35 walk: the sea, not running, is the way out. */
const WALK = 1.3
const PATROL = 1.1
const STALK = 1.0
const CHARGE = 3.4
const ELDER = 0.65
const LEAD = 1.15
const SWIM = 0.85
/** Steepest ground anyone walks up or down, rise over run. */
const MAX_RISE = 0.9
/** Islanders further than this from the camera are hidden and simulated coarsely. */
const SHOW_DIST = 155
const HIDE_DIST = 165
const VISION_HALF = THREE.MathUtils.degToRad(55)
const VISION_DAY = 38
const VISION_NIGHT = 14
/** Seconds after the player first stands on land before a chase is possible at all. */
const LAND_GRACE = 45
/** A warning has to have stood this long before ignoring it can start a chase. */
const WARN_HOLD = 3.5
const CHASE_LIMIT = 20
const DEEP_WATER = 0.6
const CAPTURE_DIST = 1.3
const AI_HOLD = 12
const WHISPER_GAP = 6
/** Fixed sample lists, kept out of the frame so the loops allocate nothing. */
const PROBE_OFFSETS = [0, 0.52, 1.05, 1.57]
const STEP_SAMPLES = [0.5, 1]
const SIGHT_SAMPLES = [0.2, 0.4, 0.6, 0.8]

// —— the walkability grid ——————————————————————————————————————

type NavClass = 'dry' | 'wade'

type Nav = {
  cell: number
  nx: number
  nz: number
  x0: number
  z0: number
  h: Float32Array
  steep: Float32Array
  /**
   * The tidal caves' rock where it stands above the terrain and is level
   * enough to stand on; -Infinity elsewhere. The rock is sculpted at a finer
   * scale than this grid, so a rough patch is left to block routes (through
   * `h`) but never offered as footing.
   */
  rock: Float32Array
  /** The rock's top wherever it stands above the terrain, level or not. */
  rockRaw: Float32Array
  hasRock: boolean
  /** Rough rock standing near or above the water: nobody walks or swims into it. */
  solid(k: number, tide: number): boolean
  reach: Uint8Array
  cellAt(x: number, z: number): number
  /** A* from one point to another. Writes x,z pairs into `out`; returns the number of points (0 on failure). */
  path(sx: number, sz: number, gx: number, gz: number, cls: NavClass, minGround: number, tide: number, out: Float32Array): number
  nearest(x: number, z: number, cls: NavClass, minGround: number, tide: number, maxR: number): number
  passable(i: number, cls: NavClass, minGround: number, tide: number): boolean
  /** Every cell reachable from a point for this kind of walker (1) or not (0). */
  flood(x: number, z: number, cls: NavClass, minGround: number, tide: number): Uint8Array
}

function createNav(
  ground: (x: number, z: number) => number,
  rockAt: (x: number, z: number) => number,
  bounds: { x0: number; z0: number; x1: number; z1: number },
  cell: number,
): Nav {
  const nx = Math.ceil((bounds.x1 - bounds.x0) / cell) + 1
  const nz = Math.ceil((bounds.z1 - bounds.z0) / cell) + 1
  const N = nx * nz
  const h = new Float32Array(N)
  const rock = new Float32Array(N).fill(-Infinity)
  let hasRock = false
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = bounds.x0 + i * cell
      const z = bounds.z0 + j * cell
      const k = j * nx + i
      h[k] = ground(x, z)
      const r = rockAt(x, z)
      if (r > h[k] + 0.05) {
        rock[k] = r
        h[k] = r
        hasRock = true
      }
    }
  }
  // Steepness from the neighbours: the terrain itself is bilinear on a
  // coarser grid than this, so differences here see every real slope
  const steep = new Float32Array(N)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      const hx0 = h[j * nx + Math.max(0, i - 1)]
      const hx1 = h[j * nx + Math.min(nx - 1, i + 1)]
      const hz0 = h[Math.max(0, j - 1) * nx + i]
      const hz1 = h[Math.min(nz - 1, j + 1) * nx + i]
      steep[k] = Math.max(Math.abs(hx1 - h[k]), Math.abs(h[k] - hx0), Math.abs(hz1 - h[k]), Math.abs(h[k] - hz0)) / cell
    }
  }
  const rockRaw = Float32Array.from(rock)
  hasRock = false
  for (let k = 0; k < N; k++) {
    if (rock[k] > -Infinity && steep[k] > MAX_RISE) rock[k] = -Infinity
    if (rock[k] > -Infinity) hasRock = true
  }

  const cellAt = (x: number, z: number) => {
    const i = Math.round((x - bounds.x0) / cell)
    const j = Math.round((z - bounds.z0) / cell)
    if (i < 0 || j < 0 || i >= nx || j >= nz) return -1
    return j * nx + i
  }
  const water = (k: number, tide: number) => h[k] < tide + 0.1
  const solid = (k: number, tide: number) => rockRaw[k] > tide - 0.5 && rock[k] === -Infinity
  const passable = (k: number, cls: NavClass, minGround: number, tide: number) => {
    if (solid(k, tide)) return false
    if (cls === 'wade') return water(k, tide) || steep[k] <= MAX_RISE + 0.05
    return h[k] >= minGround && steep[k] <= MAX_RISE
  }
  const edgeOk = (a: number, b: number, len: number, cls: NavClass, tide: number) => {
    if (cls === 'wade' && water(a, tide) && water(b, tide)) return true
    return Math.abs(h[b] - h[a]) / len <= MAX_RISE
  }

  // A* scratch, reused for every search; a generation stamp stands in for clearing it
  const g = new Float32Array(N)
  const from = new Int32Array(N)
  const seen = new Uint32Array(N)
  const done = new Uint32Array(N)
  const HEAP = N * 4
  const heap = new Int32Array(HEAP)
  const heapF = new Float32Array(HEAP)
  let heapN = 0
  let gen = 0
  const push = (k: number, f: number) => {
    if (heapN >= HEAP) return
    let i = heapN++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heapF[p] <= f) break
      heap[i] = heap[p]
      heapF[i] = heapF[p]
      i = p
    }
    heap[i] = k
    heapF[i] = f
  }
  const pop = () => {
    const top = heap[0]
    const lastK = heap[--heapN]
    const lastF = heapF[heapN]
    let i = 0
    for (;;) {
      let c = i * 2 + 1
      if (c >= heapN) break
      if (c + 1 < heapN && heapF[c + 1] < heapF[c]) c++
      if (heapF[c] >= lastF) break
      heap[i] = heap[c]
      heapF[i] = heapF[c]
      i = c
    }
    heap[i] = lastK
    heapF[i] = lastF
    return top
  }
  const DI = [1, -1, 0, 0, 1, 1, -1, -1]
  const DJ = [0, 0, 1, -1, 1, -1, 1, -1]

  const nearest = (x: number, z: number, cls: NavClass, minGround: number, tide: number, maxR: number) => {
    const c = cellAt(x, z)
    if (c >= 0 && passable(c, cls, minGround, tide)) return c
    const ci = Math.round((x - bounds.x0) / cell)
    const cj = Math.round((z - bounds.z0) / cell)
    const R = Math.ceil(maxR / cell)
    let best = -1
    let bestD = Infinity
    for (let r = 1; r <= R && best < 0; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
          const i = ci + di
          const j = cj + dj
          if (i < 0 || j < 0 || i >= nx || j >= nz) continue
          const k = j * nx + i
          if (!passable(k, cls, minGround, tide)) continue
          const d = di * di + dj * dj
          if (d < bestD) {
            bestD = d
            best = k
          }
        }
      }
    }
    return best
  }

  const lineClear = (ax: number, az: number, bx: number, bz: number, cls: NavClass, minGround: number, tide: number) => {
    const len = Math.hypot(bx - ax, bz - az)
    const steps = Math.max(1, Math.ceil(len / (cell * 0.5)))
    let prev = cellAt(ax, az)
    if (prev < 0) return false
    for (let s = 1; s <= steps; s++) {
      const k = cellAt(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps)
      if (k < 0 || !passable(k, cls, minGround, tide)) return false
      if (k !== prev && !edgeOk(prev, k, Math.max(cell * 0.5, len / steps), cls, tide)) return false
      prev = k
    }
    return true
  }

  const path = (sx: number, sz: number, gx: number, gz: number, cls: NavClass, minGround: number, tide: number, out: Float32Array) => {
    const s = nearest(sx, sz, cls, minGround, tide, 24)
    const t = nearest(gx, gz, cls, minGround, tide, 30)
    if (s < 0 || t < 0) return 0
    gen++
    heapN = 0
    g[s] = 0
    seen[s] = gen
    from[s] = -1
    const tx = t % nx
    const tz = (t / nx) | 0
    const heur = (k: number) => {
      const dx = Math.abs((k % nx) - tx)
      const dz = Math.abs(((k / nx) | 0) - tz)
      return (Math.max(dx, dz) + 0.414 * Math.min(dx, dz)) * cell
    }
    push(s, heur(s))
    let expanded = 0
    while (heapN > 0) {
      const cur = pop()
      if (done[cur] === gen) continue
      done[cur] = gen
      if (cur === t) break
      if (++expanded > 45000) return 0
      const ci = cur % nx
      const cj = (cur / nx) | 0
      for (let d = 0; d < 8; d++) {
        const i = ci + DI[d]
        const j = cj + DJ[d]
        if (i < 0 || j < 0 || i >= nx || j >= nz) continue
        const k = j * nx + i
        if (done[k] === gen || !passable(k, cls, minGround, tide)) continue
        const diag = d >= 4
        // No cutting a corner past ground that cannot be walked
        if (diag && (!passable(cj * nx + i, cls, minGround, tide) || !passable(j * nx + ci, cls, minGround, tide))) continue
        const len = diag ? cell * 1.4142 : cell
        if (!edgeOk(cur, k, len, cls, tide)) continue
        const rise = Math.abs(h[k] - h[cur]) / len
        let cost = len * (1 + 1.2 * rise)
        if (cls === 'wade' && water(k, tide)) cost += len * (tide - h[k] > 1.0 ? 0.9 : 0.3)
        if (cls === 'dry' && h[k] < minGround + 0.5) cost += len * 0.25
        const ng = g[cur] + cost
        if (seen[k] !== gen || ng < g[k]) {
          seen[k] = gen
          g[k] = ng
          from[k] = cur
          push(k, ng + heur(k))
        }
      }
    }
    if (done[t] !== gen) return 0
    // Walk back from the goal, then write it out start-first
    let count = 0
    for (let c = t; c !== -1; c = from[c]) count++
    const cap = out.length >> 1
    const keep = Math.min(count, cap)
    let w = keep - 1
    let skip = count - keep
    for (let c = t; c !== -1 && w >= 0; c = from[c]) {
      if (skip > 0) {
        skip--
        continue
      }
      out[w * 2] = bounds.x0 + (c % nx) * cell
      out[w * 2 + 1] = bounds.z0 + ((c / nx) | 0) * cell
      w--
    }
    // The real goal replaces the last cell centre when it is in that cell's reach
    if (Math.hypot(gx - out[(keep - 1) * 2], gz - out[(keep - 1) * 2 + 1]) < cell * 1.5) {
      out[(keep - 1) * 2] = gx
      out[(keep - 1) * 2 + 1] = gz
    }
    // String-pull: skip ahead to the furthest point still in a clear straight line
    let n = 1
    let i = 0
    while (i < keep - 1) {
      let j = Math.min(keep - 1, i + 24)
      while (j > i + 1 && !lineClear(out[i * 2], out[i * 2 + 1], out[j * 2], out[j * 2 + 1], cls, minGround, tide)) j--
      out[n * 2] = out[j * 2]
      out[n * 2 + 1] = out[j * 2 + 1]
      n++
      i = j
    }
    return n
  }

  const flood = (x: number, z: number, cls: NavClass, minGround: number, tide: number) => {
    const mark = new Uint8Array(N)
    const start = nearest(x, z, cls, minGround, tide, 30)
    if (start < 0) return mark
    const queue = new Int32Array(N)
    let qh = 0
    let qt = 0
    queue[qt++] = start
    mark[start] = 1
    while (qh < qt) {
      const cur = queue[qh++]
      const ci = cur % nx
      const cj = (cur / nx) | 0
      for (let d = 0; d < 4; d++) {
        const i = ci + DI[d]
        const j = cj + DJ[d]
        if (i < 0 || j < 0 || i >= nx || j >= nz) continue
        const k = j * nx + i
        if (mark[k] || !passable(k, cls, minGround, tide) || !edgeOk(cur, k, cell, cls, tide)) continue
        mark[k] = 1
        queue[qt++] = k
      }
    }
    return mark
  }

  const nav: Nav = {
    cell,
    nx,
    nz,
    x0: bounds.x0,
    z0: bounds.z0,
    h,
    steep,
    rock,
    rockRaw,
    hasRock,
    solid,
    reach: new Uint8Array(N),
    cellAt,
    path,
    nearest,
    passable,
    flood,
  }
  return nav
}

// —— islander state ————————————————————————————————————————————

type LocalState =
  | 'schedule'
  | 'watch'
  | 'warn'
  | 'step_back'
  | 'stalk'
  | 'charge'
  | 'edge_hold'
  | 'captured'
  | 'curious'
  | 'wary'

type Override = {
  action: NpcAction
  pose: NpcPose | null
  start: number
  until: number
  planned: boolean
  paused: boolean
  /** Where a step back is going, fixed when it was asked for. */
  tx: number
  tz: number
}

type Activity = {
  kind: 'none' | 'camp' | 'patrol' | 'dwell' | 'rocks' | 'comb' | 'shore' | 'seat' | 'pool' | 'back'
  timer: number
  index: number
  /** What the islander does once there. */
  sub: number
}

type Npc = {
  id: NpcId
  rig: IslanderRig
  cls: NavClass
  index: number
  x: number
  y: number
  z: number
  yaw: number
  speed: number
  want: number
  turnRate: number
  // movement
  path: Float32Array
  pathLen: number
  pathIdx: number
  goalX: number
  goalZ: number
  hasGoal: boolean
  goalEdge: boolean
  chaseGround: boolean
  arriveR: number
  arrived: boolean
  blocked: boolean
  steerOff: number
  probeT: number
  stuckT: number
  progressT: number
  lastGoalDist: number
  replans: number
  faceX: number
  faceZ: number
  hasFace: boolean
  // body
  pose: NpcPose
  reach: number
  swim: number
  wade: number
  look: boolean
  visible: boolean
  coarseT: number
  thinkT: number
  // perception
  snap: NpcPerceptionSnapshot
  percT: number
  alert: number
  dist: number
  approach: number
  armed: boolean
  // behaviour
  state: LocalState
  stateAt: number
  ai: Override | null
  act: Activity
  warnStart: number
  lastWarnAt: number
  chaseStart: number
  calmClock: number
  calmUntil: number
  beckonAt: number
  plantT: number
  holdX: number
  holdZ: number
  awayT: number
  said: { seen: boolean; beckon: boolean; back: boolean; warn: boolean }
}

export type TribeSimOptions = {
  island: IslandLike
  reefWreckPos: THREE.Vector3
  tidalCaves: TidalCavesLike
  lowPower: boolean
  onProximityEnter?: (id: NpcId, snapshot: NpcPerceptionSnapshot) => void
  onPlayerCaptured?: (id: NpcId) => void
  onWhisper?: (text: string) => void
}

/** Debug view of one islander, for the console and the brain's HUD. */
export type NpcDebugState = {
  id: NpcId
  position: THREE.Vector3
  yaw: number
  action: NpcAction
  pose: NpcPose
  /** The local behaviour's own state name. */
  state: string
  /** What the schedule has them doing. */
  activity: string
  alert: number
  /** A warning has been given this encounter. */
  warned: boolean
  /** Seconds since the last warning was standing (Infinity if none). */
  warnedAgo: number
  /** Seconds the current warning has stood (0 when not warning). */
  warnSeconds: number
  chasing: boolean
  captured: boolean
  aiAction: NpcAction | null
  aiPose: NpcPose | null
  /** Seconds left on the brain's override (0 when none). */
  aiRemaining: number
  /** Seconds left of the landing grace, during which no chase can start. */
  graceRemaining: number
  visible: boolean
  seen: boolean
  heard: boolean
  distance: number
  /** Where they are walking to, the route's points and progress, and whether the way ahead is blocked. */
  goal: { x: number; z: number } | null
  route: { points: number; next: number; blocked: boolean; replans: number }
}

export function createTribeSim(scene: THREE.Scene, opts: TribeSimOptions) {
  const { island, tidalCaves } = opts
  const places: TribePlaces = getTribePlaces(island, opts.reefWreckPos, tidalCaves.entrance)
  const group = new THREE.Group()
  group.name = 'Tribe'
  scene.add(group)

  // —— ground ——
  const rockFloor = (x: number, z: number) => {
    // The caves' rock is a sculpted surface; only its top matters to feet
    const r = tidalCaves.floorAt(x, z)
    return Number.isFinite(r) ? r : -Infinity
  }

  // The grid covers the island and its lagoon, and reaches every named place
  const R = 380
  const bx0 = Math.min(island.centre.x - R, places.lagoonRocks.x - 40, places.cavesMouth.x - 40)
  const bx1 = Math.max(island.centre.x + R, places.lagoonRocks.x + 40, places.cavesMouth.x + 40)
  const bz0 = Math.min(island.centre.z - R, places.lagoonRocks.z - 40, places.cavesMouth.z - 40)
  const bz1 = Math.max(island.centre.z + R, places.lagoonRocks.z + 40, places.cavesMouth.z + 40)
  const nav = createNav(island.heightAt, rockFloor, { x0: bx0, z0: bz0, x1: bx1, z1: bz1 }, opts.lowPower ? 4 : 3.5)

  /** Ground under a point: the terrain, or the caves' rock where it stands higher and level. */
  function ground(x: number, z: number) {
    const h = island.heightAt(x, z)
    if (!nav.hasRock) return h
    const k = nav.cellAt(x, z)
    if (k < 0 || nav.rock[k] === -Infinity) return h
    // Blend between level rock cells; at the edge of the footing, the cell itself
    const gx = (x - nav.x0) / nav.cell
    const gz = (z - nav.z0) / nav.cell
    const i = Math.floor(gx)
    const j = Math.floor(gz)
    if (i >= 0 && j >= 0 && i + 1 < nav.nx && j + 1 < nav.nz) {
      const a = nav.rock[j * nav.nx + i]
      const b = nav.rock[j * nav.nx + i + 1]
      const c = nav.rock[(j + 1) * nav.nx + i]
      const d = nav.rock[(j + 1) * nav.nx + i + 1]
      if (a > -Infinity && b > -Infinity && c > -Infinity && d > -Infinity) {
        const fx = gx - i
        const fz = gz - j
        return Math.max(h, (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz)
      }
    }
    return Math.max(h, nav.rock[k])
  }

  // —— places on the ground, worked out once ——
  const DRY_ANY_TIDE = 0.85
  // Dry ground reachable on foot from the cove at any tide
  nav.reach.set(nav.flood(places.landing.x, places.landing.z, 'dry', DRY_ANY_TIDE, 0))
  const fire = places.campFire

  // The way into camp from the cove: Kael keeps watch along it at night
  let approachX = places.landing.x - fire.x
  let approachZ = places.landing.z - fire.z
  let postX = fire.x
  let postZ = fire.z
  const campToCove = new Float32Array(2 * 512)
  let campToCoveLen = nav.path(fire.x, fire.z, places.landing.x, places.landing.z, 'dry', DRY_ANY_TIDE, 0, campToCove)
  if (campToCoveLen < 2) {
    campToCoveLen = nav.path(fire.x, fire.z, places.landing.x, places.landing.z, 'dry', 0.35, 0, campToCove)
  }
  {
    // A point fourteen metres out along the path, and the way it goes on from there
    const along = (want: number, out: { x: number; z: number }) => {
      let acc = 0
      for (let i = 1; i < campToCoveLen; i++) {
        const ax = campToCove[(i - 1) * 2]
        const az = campToCove[(i - 1) * 2 + 1]
        const bx = campToCove[i * 2]
        const bz = campToCove[i * 2 + 1]
        const seg = Math.hypot(bx - ax, bz - az)
        if (acc + seg >= want) {
          const f = (want - acc) / Math.max(seg, 1e-3)
          out.x = ax + (bx - ax) * f
          out.z = az + (bz - az) * f
          return true
        }
        acc += seg
      }
      return false
    }
    const p = { x: 0, z: 0 }
    if (campToCoveLen >= 2 && along(14, p)) {
      postX = p.x
      postZ = p.z
      const q = { x: 0, z: 0 }
      if (along(30, q)) {
        approachX = q.x - p.x
        approachZ = q.z - p.z
      }
    } else {
      const l = Math.hypot(approachX, approachZ) || 1
      postX = fire.x + (approachX / l) * 14
      postZ = fire.z + (approachZ / l) * 14
    }
    const l = Math.hypot(approachX, approachZ) || 1
    approachX /= l
    approachZ /= l
  }
  // Oru sits across the fire from the way in, so he faces anyone coming; Tala to one side
  const oruSeat = { x: fire.x - approachX * 1.7, z: fire.z - approachZ * 1.7 }
  const talaSeat = { x: fire.x + approachZ * 1.7, z: fire.z - approachX * 1.7 }
  const poolSpot = (() => {
    const dx = fire.x - places.campPool.x
    const dz = fire.z - places.campPool.z
    const l = Math.hypot(dx, dz) || 1
    return { x: places.campPool.x + (dx / l) * 3, z: places.campPool.z + (dz / l) * 3 }
  })()
  const seaFace = (x: number, z: number) => {
    const dx = x - island.centre.x
    const dz = z - island.centre.z
    const l = Math.hypot(dx, dz) || 1
    return { x: x + (dx / l) * 30, z: z + (dz / l) * 30 }
  }

  /** Out to sea from the landing: where a guide faces at the end. */
  const landingSea = seaFace(places.landing.x, places.landing.z)

  // The dry ground nearest the caves, and the water's edge in front of it
  const cavesShore = { x: places.landing.x, z: places.landing.z }
  const cavesEdge = { x: places.landing.x, z: places.landing.z }
  {
    let best = Infinity
    for (let k = 0; k < nav.h.length; k++) {
      if (!nav.reach[k] || nav.h[k] < 0.8 || nav.h[k] > 6 || nav.steep[k] > 0.6) continue
      const x = nav.x0 + (k % nav.nx) * nav.cell
      const z = nav.z0 + ((k / nav.nx) | 0) * nav.cell
      const d = Math.hypot(x - places.cavesMouth.x, z - places.cavesMouth.z)
      if (d < best) {
        best = d
        cavesShore.x = x
        cavesShore.z = z
      }
    }
    const dx = places.cavesMouth.x - cavesShore.x
    const dz = places.cavesMouth.z - cavesShore.z
    const l = Math.hypot(dx, dz) || 1
    cavesEdge.x = cavesShore.x
    cavesEdge.z = cavesShore.z
    for (let s = 0.5; s < Math.min(l, 40); s += 0.5) {
      const x = cavesShore.x + (dx / l) * s
      const z = cavesShore.z + (dz / l) * s
      const h = ground(x, z)
      if (h < 0.25) break
      if (Math.abs(h - ground(cavesEdge.x, cavesEdge.z)) / 0.5 > MAX_RISE) break
      cavesEdge.x = x
      cavesEdge.z = z
    }
  }
  // Where Tala waits at the caves: treading water right over the mouth, at the
  // foot of the rock, where she can point straight down at the way in. The
  // rock itself is sculpted finer than the grid can stand anyone on, and the
  // reef crest is seventy metres off, so open water is the honest spot.
  const cavesWade = { x: places.cavesMouth.x, z: places.cavesMouth.z }
  {
    // The mouth sits in a channel narrower than the grid, so: the nearest water
    // to it that a swimmer from the beach can actually get to
    const swimmable = nav.flood(places.landing.x, places.landing.z, 'wade', 0, 0)
    let best = Infinity
    const ci = Math.round((places.cavesMouth.x - nav.x0) / nav.cell)
    const cj = Math.round((places.cavesMouth.z - nav.z0) / nav.cell)
    const R = Math.ceil(40 / nav.cell)
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        const i = ci + di
        const j = cj + dj
        if (i < 0 || j < 0 || i >= nav.nx || j >= nav.nz) continue
        const k = j * nav.nx + i
        // Reachable, clear of rock to well below the surface, deep enough to tread water
        if (!swimmable[k] || nav.rockRaw[k] > -2.5 || nav.h[k] > -1.8) continue
        const x = nav.x0 + i * nav.cell
        const z = nav.z0 + j * nav.cell
        const d = Math.hypot(x - places.cavesMouth.x, z - places.cavesMouth.z)
        if (d < best) {
          best = d
          cavesWade.x = x
          cavesWade.z = z
        }
      }
    }
  }

  // Beachcombing: open sand near the landing, above the wash
  const combPoints: { x: number; z: number }[] = []
  for (let i = 0; i < 400 && combPoints.length < 14; i++) {
    const a = i * 2.399
    const r = 6 + ((i * 7) % 40)
    const x = places.landing.x + Math.cos(a) * r
    const z = places.landing.z + Math.sin(a) * r
    const k = nav.cellAt(x, z)
    if (k < 0 || !nav.reach[k]) continue
    const h = ground(x, z)
    if (h < 0.5 || h > 2.2 || nav.steep[k] > 0.4) continue
    if (combPoints.some((p) => Math.hypot(p.x - x, p.z - z) < 6)) continue
    combPoints.push({ x, z })
  }
  if (combPoints.length === 0) combPoints.push({ x: places.landing.x, z: places.landing.z })

  // Kael's patrol: the shoulder above the cove, then down the coast toward camp and back
  const patrol: { x: number; z: number; fx: number; fz: number }[] = []
  const legs: { pts: Float32Array; n: number }[] = []
  {
    const inX = -places.outward.x
    const inZ = -places.outward.y
    const cands: { x: number; z: number; bearing: number; r: number }[] = []
    for (const r of [45, 60, 75, 90, 105, 118]) {
      for (let a = 0; a < TAU; a += Math.PI / 18) {
        const x = places.totem.x + Math.cos(a) * r
        const z = places.totem.z + Math.sin(a) * r
        const k = nav.cellAt(x, z)
        if (k < 0 || !nav.reach[k]) continue
        const h = nav.h[k]
        if (h < 8 || h > 40 || nav.steep[k] > 0.55) continue
        const dx = x - places.totem.x
        const dz = z - places.totem.z
        const bearing = Math.atan2(dx * inZ - dz * inX, dx * inX + dz * inZ)
        cands.push({ x, z, bearing, r })
      }
    }
    const shoulder: { x: number; z: number }[] = []
    for (const want of [-0.9, 0, 0.9]) {
      let best: (typeof cands)[number] | null = null
      let score = Infinity
      for (const c of cands) {
        const s = Math.abs(c.bearing - want) * 40 + Math.abs(c.r - 80) * 0.3
        if (s < score && !shoulder.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 25)) {
          score = s
          best = c
        }
      }
      if (best && Math.abs(best.bearing - want) < 0.6) shoulder.push({ x: best.x, z: best.z })
    }
    // Two stops on the coast path toward camp
    const coast: { x: number; z: number }[] = []
    if (campToCoveLen >= 2) {
      let total = 0
      for (let i = 1; i < campToCoveLen; i++) {
        total += Math.hypot(campToCove[i * 2] - campToCove[i * 2 - 2], campToCove[i * 2 + 1] - campToCove[i * 2 - 1])
      }
      for (const f of [0.45, 0.75]) {
        let acc = 0
        const want = total * f
        for (let i = 1; i < campToCoveLen; i++) {
          const seg = Math.hypot(campToCove[i * 2] - campToCove[i * 2 - 2], campToCove[i * 2 + 1] - campToCove[i * 2 - 1])
          if (acc + seg >= want) {
            const t = (want - acc) / Math.max(seg, 1e-3)
            coast.push({
              x: campToCove[i * 2 - 2] + (campToCove[i * 2] - campToCove[i * 2 - 2]) * t,
              z: campToCove[i * 2 - 1] + (campToCove[i * 2 + 1] - campToCove[i * 2 - 1]) * t,
            })
            break
          }
          acc += seg
        }
      }
    }
    // Camp side first, then round the shoulder from the end nearest the coast
    const ordered: { x: number; z: number }[] = [...coast]
    const pool = [...shoulder]
    let from = coast.length > 0 ? coast[coast.length - 1] : { x: places.totem.x, z: places.totem.z }
    while (pool.length > 0) {
      let bi = 0
      for (let i = 1; i < pool.length; i++) {
        if (Math.hypot(pool[i].x - from.x, pool[i].z - from.z) < Math.hypot(pool[bi].x - from.x, pool[bi].z - from.z)) bi = i
      }
      from = pool.splice(bi, 1)[0]
      ordered.push(from)
    }
    if (ordered.length === 0) ordered.push({ x: places.totem.x, z: places.totem.z }, { x: places.landing.x, z: places.landing.z })
    // Keep only the stops that join up on foot
    for (const p of ordered) {
      const f = shoulder.includes(p) ? { x: places.totem.x, z: places.totem.z } : seaFace(p.x, p.z)
      patrol.push({ x: p.x, z: p.z, fx: f.x, fz: f.z })
    }
    for (let i = 0; i < patrol.length; i++) {
      const a = patrol[i]
      const b = patrol[(i + 1) % patrol.length]
      const pts = new Float32Array(2 * 512)
      let n = nav.path(a.x, a.z, b.x, b.z, 'dry', DRY_ANY_TIDE, 0, pts)
      if (n < 2) n = nav.path(a.x, a.z, b.x, b.z, 'dry', 0.35, 0, pts)
      legs.push({ pts, n })
    }
  }

  // —— the islanders ——
  const ids: NpcId[] = ['kael', 'tala', 'oru']
  const npcs: Npc[] = ids.map((id, index) => {
    const rig = buildIslander(id, { lowPower: opts.lowPower })
    group.add(rig.root)
    const n: Npc = {
      id,
      rig,
      cls: id === 'tala' ? 'wade' : 'dry',
      index,
      x: fire.x,
      y: fire.y,
      z: fire.z,
      yaw: 0,
      speed: 0,
      want: 0,
      turnRate: 0,
      path: new Float32Array(2 * 512),
      pathLen: 0,
      pathIdx: 0,
      goalX: 0,
      goalZ: 0,
      hasGoal: false,
      goalEdge: false,
      chaseGround: false,
      arriveR: 0.8,
      arrived: true,
      blocked: false,
      steerOff: 0,
      probeT: 0,
      stuckT: 0,
      progressT: 0,
      lastGoalDist: Infinity,
      replans: 0,
      faceX: 0,
      faceZ: 0,
      hasFace: false,
      pose: 'idle',
      reach: 0,
      swim: 0,
      wade: 0,
      look: false,
      visible: true,
      coarseT: 0,
      thinkT: 0,
      snap: {
        npcId: id,
        distance: Infinity,
        angle: Math.PI,
        playerSpeed: 0,
        crouched: false,
        heldItem: 'none',
        inSacredZone: false,
        carryingBag: false,
        timeOfDay: 0,
        tide: 0,
        storm: 0,
        seen: false,
        heard: false,
      },
      percT: index * 0.033,
      alert: 0,
      dist: Infinity,
      approach: 0,
      armed: true,
      state: 'schedule',
      stateAt: 0,
      ai: null,
      act: { kind: 'none', timer: 0, index: 0, sub: 0 },
      warnStart: -Infinity,
      lastWarnAt: -Infinity,
      chaseStart: -Infinity,
      calmClock: 0,
      calmUntil: -Infinity,
      beckonAt: 0,
      plantT: 0,
      holdX: 0,
      holdZ: 0,
      awayT: 0,
      said: { seen: false, beckon: false, back: false, warn: false },
    }
    return n
  })
  const byId = (id: NpcId) => npcs[ids.indexOf(id)]

  // —— shared encounter state ——
  let now = 0
  let firstLandAt = -1
  let captureFired = false
  let escortedUntil = -Infinity
  let campMode = false
  let stormy = false
  let lowTide = false
  let highTide = false
  let needSnap = true
  let lastWhisper = ''
  let lastWhisperAt = -Infinity
  /** One line held back by the gap between whispers, said a moment later if it is still fresh. */
  let pendingWhisper = ''
  let pendingUntil = -Infinity
  let lastGesture: PlayerGesture | null = null
  let lastGestureAt = -Infinity
  // The player, as the islanders read them this frame
  const P = {
    x: 0,
    y: 0,
    z: 0,
    speed: 0,
    crouched: false,
    mode: 'walk' as TribePlayerState['mode'],
    vx: 0,
    vz: 0,
    lastX: Number.NaN,
    lastZ: Number.NaN,
    ground: 0,
    depth: 0,
    deep: false,
    onLand: false,
    sacred: false,
    held: 'none' as HeldItem,
    bag: false,
  }
  const W = { dayPhase: 0.4, daylight: 1, storm: 0, tide: 0, tidePhase: 0 }
  const playerHead = new THREE.Vector3()
  const motion: IslanderMotion = { speed: 0, turnRate: 0, wading: 0, slope: 0, reach: 0, swim: 0 }

  function whisper(text: string) {
    if (!opts.onWhisper || text === lastWhisper) return
    if (now - lastWhisperAt < WHISPER_GAP) {
      pendingWhisper = text
      pendingUntil = now + 5
      return
    }
    lastWhisper = text
    lastWhisperAt = now
    pendingWhisper = ''
    opts.onWhisper(text)
  }

  function flushWhisper() {
    if (!pendingWhisper || now - lastWhisperAt < WHISPER_GAP) return
    const text = pendingWhisper
    pendingWhisper = ''
    if (now < pendingUntil) whisper(text)
  }

  // —— movement ——————————————————————————————————————————————

  function minGroundFor(n: Npc) {
    if (n.cls === 'wade') return -Infinity
    if (n.chaseGround) return W.tide - 0.55
    if (n.goalEdge && Math.hypot(n.goalX - n.x, n.goalZ - n.z) < 8) return W.tide - 0.25
    return Math.max(0.2, W.tide - 0.08)
  }

  /** Can this islander step from here to a point `len` ahead along `yaw`? */
  function stepOk(n: Npc, yaw: number, len: number, hHere: number) {
    const sx = -Math.sin(yaw)
    const sz = -Math.cos(yaw)
    const minG = minGroundFor(n)
    for (const f of STEP_SAMPLES) {
      const x = n.x + sx * len * f
      const z = n.z + sz * len * f
      if (nav.hasRock && solidAt(x, z)) return false
      const h = ground(x, z)
      if (h < minG) return false
      const wet = n.cls === 'wade' && h < W.tide + 0.1 && hHere < W.tide + 0.1
      if (!wet && Math.abs(h - hHere) / (len * f) > MAX_RISE) return false
    }
    return true
  }

  function solidAt(x: number, z: number) {
    const k = nav.cellAt(x, z)
    return k >= 0 && nav.solid(k, W.tide)
  }

  function stop(n: Npc) {
    n.want = 0
    n.hasGoal = false
    n.arrived = true
  }

  /** Walk somewhere, planning a route over the grid when it is not a short straight walk. */
  function goTo(n: Npc, x: number, z: number, speed: number, edge = false, arriveR = 0.8) {
    n.want = speed
    if (n.hasGoal && !n.blocked && Math.hypot(x - n.goalX, z - n.goalZ) < 1.0) return
    n.goalX = x
    n.goalZ = z
    n.hasGoal = true
    n.arrived = false
    n.blocked = false
    n.goalEdge = edge
    n.arriveR = arriveR
    n.replans = 0
    n.stuckT = 0
    n.lastGoalDist = Infinity
    plan(n)
  }

  function plan(n: Npc) {
    n.pathIdx = 0
    const d = Math.hypot(n.goalX - n.x, n.goalZ - n.z)
    if (d < 10) {
      n.pathLen = 0
      return
    }
    const minG = n.cls === 'dry' ? Math.max(0.35, W.tide + 0.15) : 0
    n.pathLen = nav.path(n.x, n.z, n.goalX, n.goalZ, n.cls, minG, W.tide, n.path)
    // A route is followed from its second point; the first is where they already are
    if (n.pathLen >= 2) n.pathIdx = 1
  }

  /** Follow a route worked out in advance (Kael's patrol legs). */
  function follow(n: Npc, pts: Float32Array, count: number, speed: number) {
    if (count < 2) {
      goTo(n, pts[0] ?? n.x, pts[1] ?? n.z, speed)
      return
    }
    n.path.set(pts.subarray(0, count * 2))
    n.pathLen = count
    n.pathIdx = 1
    n.goalX = pts[(count - 1) * 2]
    n.goalZ = pts[(count - 1) * 2 + 1]
    n.hasGoal = true
    n.arrived = false
    n.blocked = false
    n.goalEdge = false
    n.arriveR = 1.0
    n.want = speed
    n.replans = 0
    n.stuckT = 0
    n.lastGoalDist = Infinity
  }

  /** Head straight for a point that moves (the player, a standoff spot): no route. */
  function steerTo(n: Npc, x: number, z: number, speed: number, arriveR = 0.6) {
    n.goalX = x
    n.goalZ = z
    n.pathLen = 0
    n.pathIdx = 0
    n.hasGoal = true
    n.goalEdge = false
    n.arriveR = arriveR
    n.want = speed
    if (Math.hypot(x - n.x, z - n.z) > arriveR) {
      n.arrived = false
      n.blocked = false
    }
  }

  function face(n: Npc, x: number, z: number) {
    n.faceX = x
    n.faceZ = z
    n.hasFace = true
  }

  function waypoint(n: Npc, out: { x: number; z: number }) {
    if (n.pathLen >= 2 && n.pathIdx < n.pathLen) {
      out.x = n.path[n.pathIdx * 2]
      out.z = n.path[n.pathIdx * 2 + 1]
    } else {
      out.x = n.goalX
      out.z = n.goalZ
    }
  }
  const wp = { x: 0, z: 0 }

  function move(n: Npc, dt: number) {
    const hHere = ground(n.x, n.z)
    let wantSpeed = 0
    let wantYaw = n.yaw
    if (n.hasGoal && !n.arrived) {
      waypoint(n, wp)
      let d = Math.hypot(wp.x - n.x, wp.z - n.z)
      while (n.pathLen >= 2 && n.pathIdx < n.pathLen - 1 && d < 1.6) {
        n.pathIdx++
        waypoint(n, wp)
        d = Math.hypot(wp.x - n.x, wp.z - n.z)
      }
      const goalD = Math.hypot(n.goalX - n.x, n.goalZ - n.z)
      if (goalD < n.arriveR) {
        n.arrived = true
      } else {
        const direct = Math.atan2(-(wp.x - n.x), -(wp.z - n.z))
        n.probeT -= dt
        if (n.probeT <= 0) {
          // Look ahead and turn off anything too steep or too wet
          n.probeT = 0.2
          const len = clamp(1.5 + n.speed * 0.5, 1.5, 3)
          // Try straight on, then thirty, sixty and ninety degrees either way,
          // the side that worked last time first
          const first = n.steerOff >= 0 ? 1 : -1
          let found = false
          for (const off of PROBE_OFFSETS) {
            if (stepOk(n, direct + off * first, len, hHere)) {
              n.steerOff = off * first
              found = true
            } else if (off > 0 && stepOk(n, direct - off * first, len, hHere)) {
              n.steerOff = -off * first
              found = true
            }
            if (found) break
          }
          if (!found) n.steerOff = 0
          n.blocked = !found
        }
        wantYaw = direct + n.steerOff
        // Ease into the last metre rather than stopping dead
        wantSpeed = n.want * clamp(goalD / 1.2, 0.35, 1)
        if (n.blocked) wantSpeed = 0
      }
      // Stuck: no progress for two seconds means a new route, and after that a new goal
      n.progressT += dt
      if (n.progressT >= 1) {
        n.progressT = 0
        if (!n.arrived && n.want > 0.2) {
          if (n.lastGoalDist - goalD < 0.25) n.stuckT += 1
          else n.stuckT = 0
          if (n.stuckT >= 2) {
            n.stuckT = 0
            n.replans++
            if (n.replans > 3) {
              n.arrived = true
              n.blocked = true
            } else {
              plan(n)
            }
          }
        }
        n.lastGoalDist = goalD
      }
    }
    if (n.arrived && n.hasFace) wantYaw = Math.atan2(-(n.faceX - n.x), -(n.faceZ - n.z))
    // Slower in water, slower when the turn is sharp
    const turnLeft = Math.abs(angleDelta(n.yaw, wantYaw))
    const waterSlow = n.swim > 0.5 ? SWIM / Math.max(n.want, 0.1) : 1 - 0.45 * n.wade
    wantSpeed *= clamp(1.2 - turnLeft / 1.4, 0.15, 1) * Math.min(1, waterSlow)
    n.speed = damp(n.speed, wantSpeed, wantSpeed > n.speed ? 3 : 5, dt)
    const maxTurn = n.speed > 2.5 ? 5 : 3.2
    const prevYaw = n.yaw
    n.yaw += clamp(angleDelta(n.yaw, wantYaw), -maxTurn * dt, maxTurn * dt)
    n.turnRate = dt > 0 ? angleDelta(prevYaw, n.yaw) / dt : 0
    if (n.speed > 0.01) {
      const nx = n.x - Math.sin(n.yaw) * n.speed * dt
      const nz = n.z - Math.cos(n.yaw) * n.speed * dt
      const h = ground(nx, nz)
      const wet = n.cls === 'wade' && h < W.tide + 0.1
      if (!(nav.hasRock && solidAt(nx, nz)) && h >= minGroundFor(n) && (wet || Math.abs(h - hHere) <= MAX_RISE * Math.max(0.05, n.speed * dt) + 0.02)) {
        n.x = nx
        n.z = nz
      } else {
        n.speed *= 0.5
      }
    }
    settle(n, dt)
  }

  /** Height and wading for where the islander stands now. */
  function settle(n: Npc, dt: number) {
    const h = ground(n.x, n.z)
    const depth = W.tide - h
    const swimDepth = n.rig.height * 0.68
    const swimming = n.cls === 'wade' && depth > swimDepth
    n.swim = damp(n.swim, swimming ? 1 : 0, 3, dt)
    n.wade = clamp(depth / 0.8, 0, 1) * (1 - n.swim)
    const yWant = swimming ? W.tide - n.rig.height * 0.8 : h
    n.y = dt > 0 ? damp(n.y, yWant, swimming ? 4 : 12, dt) : yWant
  }

  /** The cheap version for islanders nobody can see: step along the route twice a second. */
  function coarseMove(n: Npc, dt: number) {
    n.coarseT += dt
    if (n.coarseT < 0.5) return
    const step = n.coarseT
    n.coarseT = 0
    if (!n.hasGoal || n.arrived || n.want <= 0) return
    let budget = Math.min(n.want, WALK) * step
    while (budget > 0) {
      waypoint(n, wp)
      const d = Math.hypot(wp.x - n.x, wp.z - n.z)
      if (d <= budget) {
        n.x = wp.x
        n.z = wp.z
        budget -= d
        if (n.pathLen >= 2 && n.pathIdx < n.pathLen - 1) n.pathIdx++
        else {
          n.arrived = true
          break
        }
      } else {
        n.yaw = Math.atan2(-(wp.x - n.x), -(wp.z - n.z))
        n.x += ((wp.x - n.x) / d) * budget
        n.z += ((wp.z - n.z) / d) * budget
        budget = 0
      }
    }
    // One height a step, so the debug view and the moment they come into sight agree
    settle(n, 0)
  }

  // —— perception ————————————————————————————————————————————

  function perceive(n: Npc, dt: number) {
    const s = n.snap
    const dx = P.x - n.x
    const dz = P.z - n.z
    const d = Math.hypot(dx, dz)
    n.dist = d
    s.distance = d
    s.angle = Math.abs(angleDelta(n.yaw, Math.atan2(-dx, -dz)))
    s.playerSpeed = P.speed
    s.crouched = P.crouched
    s.heldItem = P.held
    s.inSacredZone = P.sacred
    s.carryingBag = P.bag
    s.timeOfDay = W.dayPhase
    s.tide = W.tidePhase
    s.storm = W.storm
    // How fast the player closes on this islander, from the player's own movement
    const adv = d > 0.01 ? -(P.vx * dx + P.vz * dz) / d : 0
    n.approach = damp(n.approach, adv, 5, dt)

    n.percT -= dt
    if (n.percT > 0) return
    n.percT = 0.1
    const submerged = P.y < W.tide - 0.25
    // Under the canopy a figure is half hidden
    const forest = P.mode === 'walk' && P.ground > 6 ? 0.65 : 1
    const range = (VISION_NIGHT + (VISION_DAY - VISION_NIGHT) * W.daylight) * (1 - 0.45 * W.storm) * forest
    let seen = false
    if (!submerged && d < range && (s.angle < VISION_HALF || d < 3.5)) {
      seen = true
      const eyeN = n.y + n.rig.height * 0.93
      const eyeP = P.y
      for (const f of SIGHT_SAMPLES) {
        const h = ground(n.x + dx * f, n.z + dz * f)
        if (h > eyeN + (eyeP - eyeN) * f + 1.5) {
          seen = false
          break
        }
      }
    }
    let hear: number
    if (P.mode === 'swim') hear = P.speed < 0.9 ? 1.2 : 3 + 2 * P.speed
    else hear = (6 + 5 * (P.speed / 2.35)) * (P.crouched ? 0.5 : 1)
    hear *= 1 - 0.4 * W.storm
    s.seen = seen
    s.heard = d < hear
  }

  function updateAlert(n: Npc, dt: number) {
    const s = n.snap
    if (s.seen) n.alert += dt * 1.2 * clamp(1 - s.distance / 40, 0.25, 1)
    else if (s.heard) n.alert += dt * 0.6
    else n.alert -= dt * 0.06
    if (n.state === 'warn' || n.state === 'stalk' || n.state === 'charge' || n.state === 'edge_hold') n.alert = Math.max(n.alert, 0.7)
    n.alert = clamp(n.alert, 0, 1)
    // An encounter ends when the player has been well away for a while
    if (n.dist > 60) n.awayT += dt
    else n.awayT = 0
    if (n.awayT > 20) {
      n.said.seen = false
      n.said.beckon = false
      n.said.back = false
      n.said.warn = false
    }
  }

  function proximity(n: Npc) {
    const s = n.snap
    if (n.armed && (s.distance < 12 || (s.seen && s.distance < 20))) {
      n.armed = false
      opts.onProximityEnter?.(n.id, { ...s })
    } else if (!n.armed && s.distance > 22) {
      n.armed = true
    }
  }

  // —— schedules ——————————————————————————————————————————————

  function setActivity(n: Npc, kind: Activity['kind'], timer = 0, sub = 0) {
    n.act.kind = kind
    n.act.timer = timer
    n.act.sub = sub
  }

  function schedule(n: Npc, dt: number) {
    n.reach = 0
    n.act.timer -= dt
    if (n.id === 'kael') scheduleKael(n)
    else if (n.id === 'tala') scheduleTala(n)
    else scheduleOru(n)
  }

  function scheduleKael(n: Npc) {
    if (campMode) {
      if (n.act.kind !== 'camp') {
        setActivity(n, 'camp')
        goTo(n, postX, postZ, WALK)
      }
      face(n, postX + approachX * 20, postZ + approachZ * 20)
      n.pose = n.arrived ? 'watch_suspicious' : 'patrol'
      return
    }
    if (patrol.length === 0) {
      n.pose = 'idle'
      return
    }
    if (n.act.kind !== 'patrol' && n.act.kind !== 'dwell') {
      // Join the loop at the nearest stop
      let bi = 0
      for (let i = 1; i < patrol.length; i++) {
        if (Math.hypot(patrol[i].x - n.x, patrol[i].z - n.z) < Math.hypot(patrol[bi].x - n.x, patrol[bi].z - n.z)) bi = i
      }
      setActivity(n, 'patrol', 0)
      n.act.index = bi
      goTo(n, patrol[bi].x, patrol[bi].z, PATROL, false, 1.2)
    }
    const here = patrol[n.act.index]
    if (n.act.kind === 'patrol') {
      n.pose = 'patrol'
      if (n.arrived) {
        setActivity(n, 'dwell', rand(5, 10))
        face(n, here.fx, here.fz)
      }
      return
    }
    // Dwelling at a stop: look out over the cove, then walk the next leg
    n.pose = 'watch_suspicious'
    face(n, here.fx, here.fz)
    if (n.act.timer <= 0) {
      const leg = legs[n.act.index]
      n.act.index = (n.act.index + 1) % patrol.length
      setActivity(n, 'patrol', 0)
      if (leg && leg.n >= 2) follow(n, leg.pts, leg.n, PATROL)
      else goTo(n, patrol[n.act.index].x, patrol[n.act.index].z, PATROL, false, 1.2)
    }
  }

  function scheduleTala(n: Npc) {
    if (campMode) {
      if (n.act.kind !== 'camp') {
        setActivity(n, 'camp')
        goTo(n, talaSeat.x, talaSeat.z, WALK, false, 0.5)
      }
      face(n, fire.x, fire.z)
      n.pose = n.arrived ? 'sit_fire' : 'idle'
      return
    }
    if (lowTide) {
      // Low water: out on the reef crest by the coaster, working the wreck from her feet
      if (n.act.kind !== 'rocks') {
        setActivity(n, 'rocks', 0, 0)
        goTo(n, places.lagoonRocks.x, places.lagoonRocks.z, WALK, true, 1.2)
      }
      if (!n.arrived) {
        n.pose = 'idle'
        return
      }
      if (n.act.timer <= 0) {
        n.act.sub = (n.act.sub + 1) % 3
        n.act.timer = n.act.sub === 0 ? rand(3, 5) : rand(3, 6)
      }
      face(n, opts.reefWreckPos.x, opts.reefWreckPos.z)
      if (n.act.sub === 0) {
        n.pose = 'idle'
        n.reach = 1
      } else n.pose = n.act.sub === 1 ? 'idle' : 'curious_tilt'
      return
    }
    if (highTide) {
      // High water: sitting on the shore nearest the caves, watching the water over them
      if (n.act.kind !== 'shore') {
        setActivity(n, 'shore')
        goTo(n, cavesShore.x, cavesShore.z, WALK, false, 0.8)
      }
      face(n, places.cavesMouth.x, places.cavesMouth.z)
      n.pose = n.arrived ? 'sit_fire' : 'idle'
      return
    }
    // Between tides: beachcombing along the cove
    if (n.act.kind !== 'comb') {
      setActivity(n, 'comb', 0, 0)
      n.act.index = Math.floor(Math.random() * combPoints.length)
      const p = combPoints[n.act.index]
      goTo(n, p.x, p.z, WALK * 0.8, false, 0.8)
    }
    n.pose = 'idle'
    if (!n.arrived && !n.blocked) return
    if (n.act.sub === 0) {
      n.act.sub = 1
      n.act.timer = rand(3, 6)
    }
    if (n.act.sub === 1) {
      n.reach = 1
      if (n.act.timer <= 0) {
        n.act.sub = 2
        n.act.timer = rand(2, 4)
      }
    } else if (n.act.timer <= 0) {
      const p = combPoints[(n.act.index = (n.act.index + 1 + Math.floor(Math.random() * 3)) % combPoints.length)]
      n.act.sub = 0
      goTo(n, p.x, p.z, WALK * 0.8, false, 0.8)
    }
  }

  function scheduleOru(n: Npc) {
    if (campMode) {
      if (n.act.kind !== 'camp') {
        setActivity(n, 'camp')
        goTo(n, oruSeat.x, oruSeat.z, ELDER, false, 0.5)
      }
      face(n, fire.x, fire.z)
      n.pose = n.arrived ? 'sit_fire' : 'idle'
      return
    }
    switch (n.act.kind) {
      case 'pool':
        n.pose = 'idle'
        face(n, places.campPool.x, places.campPool.z)
        if (n.arrived) {
          n.reach = n.act.timer > 8 && n.act.timer < 12 ? 0.6 : 0
          if (n.act.timer <= 0) {
            setActivity(n, 'back')
            goTo(n, oruSeat.x, oruSeat.z, ELDER, false, 0.5)
          }
        } else n.act.timer = rand(12, 20)
        return
      case 'back':
        n.pose = 'idle'
        if (n.arrived) setActivity(n, 'seat', rand(60, 120))
        return
      case 'seat':
        face(n, fire.x, fire.z)
        n.pose = n.arrived ? 'sit_fire' : 'idle'
        if (n.act.timer <= 0) {
          setActivity(n, 'pool', 20)
          goTo(n, poolSpot.x, poolSpot.z, ELDER, false, 0.6)
        }
        return
      default:
        setActivity(n, 'seat', rand(40, 100))
        goTo(n, oruSeat.x, oruSeat.z, ELDER, false, 0.5)
    }
  }

  /** Where the schedule has someone right now, for a reset or the first frame. */
  function snapToSchedule(n: Npc) {
    let x = n.x
    let z = n.z
    let fx = fire.x
    let fz = fire.z
    setActivity(n, 'none')
    if (n.id === 'kael') {
      if (campMode) {
        x = postX
        z = postZ
        fx = postX + approachX * 20
        fz = postZ + approachZ * 20
        setActivity(n, 'camp')
      } else if (patrol.length > 0) {
        const i = Math.floor(W.dayPhase * 20) % patrol.length
        x = patrol[i].x
        z = patrol[i].z
        fx = patrol[i].fx
        fz = patrol[i].fz
        setActivity(n, 'dwell', rand(4, 8))
        n.act.index = i
      }
    } else if (n.id === 'tala') {
      if (campMode) {
        x = talaSeat.x
        z = talaSeat.z
        setActivity(n, 'camp')
      } else if (lowTide) {
        x = places.lagoonRocks.x
        z = places.lagoonRocks.z
        fx = opts.reefWreckPos.x
        fz = opts.reefWreckPos.z
        setActivity(n, 'rocks', 0, 0)
      } else if (highTide) {
        x = cavesShore.x
        z = cavesShore.z
        fx = places.cavesMouth.x
        fz = places.cavesMouth.z
        setActivity(n, 'shore')
      } else {
        const i = Math.floor(Math.random() * combPoints.length)
        x = combPoints[i].x
        z = combPoints[i].z
        const f = seaFace(x, z)
        fx = f.x
        fz = f.z
        setActivity(n, 'comb', 0, 2)
        n.act.index = i
      }
    } else {
      x = oruSeat.x
      z = oruSeat.z
      setActivity(n, campMode ? 'camp' : 'seat', rand(30, 90))
    }
    n.x = x
    n.z = z
    n.yaw = Math.atan2(-(fx - x), -(fz - z))
    face(n, fx, fz)
    n.hasGoal = true
    n.goalX = x
    n.goalZ = z
    n.arrived = true
    n.pathLen = 0
    n.speed = 0
    n.want = 0
    settle(n, 0)
    // Land on the right pose without a visible blend
    schedule(n, 0)
    n.rig.setPose(n.pose)
    n.rig.snapPose()
  }

  // —— Kael ——————————————————————————————————————————————————

  function canChase() {
    if (firstLandAt < 0 || now - firstLandAt < LAND_GRACE) return false
    if (P.deep || P.mode !== 'walk') return false
    if (now < escortedUntil && P.held !== 'spear') return false
    return true
  }

  function enterWarn(n: Npc) {
    if (n.state !== 'warn') {
      n.state = 'warn'
      n.stateAt = now
      n.warnStart = now
      n.calmClock = 0
    }
    n.lastWarnAt = now
    if (!n.said.warn) {
      n.said.warn = true
      // A warning is a first sighting too; saying "steps out of the trees" after it reads backwards
      n.said.seen = true
      const nearCamp = Math.hypot(n.x - fire.x, n.z - fire.z) < 120
      if (P.held === 'spear') whisper('He looks at the spear in your hand, then at you, and lifts his own.')
      else if (nearCamp) whisper('He plants the spear butt in the sand between you and the smoke.')
      else whisper('He lifts the spear across his body and holds it there.')
    }
  }

  function startChase(n: Npc) {
    n.state = 'stalk'
    n.stateAt = now
    n.chaseStart = now
    whisper('He comes for you. The water is closer than the trees.')
  }

  function calm(n: Npc) {
    n.state = 'step_back'
    n.stateAt = now
    n.calmUntil = now + 8
    n.chaseGround = false
    const dx = n.x - P.x
    const dz = n.z - P.z
    const l = Math.hypot(dx, dz) || 1
    n.holdX = n.x + (dx / l) * 2.5
    n.holdZ = n.z + (dz / l) * 2.5
    whisper("He lowers the spear a hand's width. Not all the way.")
  }

  function thinkKael(n: Npc, dt: number) {
    const d = n.dist
    const escorted = now < escortedUntil && P.held !== 'spear'
    n.look = n.alert > 0.3 && d < 40
    switch (n.state) {
      case 'captured':
        stop(n)
        face(n, n.holdX, n.holdZ)
        n.pose = 'warn_spear_raise'
        n.look = true
        return
      case 'stalk':
      case 'charge': {
        n.chaseGround = true
        n.lastWarnAt = now
        if (P.deep || P.mode !== 'walk') {
          // The sea is the way out: he stops at the waterline and holds the spear up
          n.state = 'edge_hold'
          n.stateAt = now
          n.chaseGround = false
          whisper('He stops where the sand turns wet and holds the spear high.')
          break
        }
        if (now - n.chaseStart > CHASE_LIMIT) {
          n.state = 'watch'
          n.stateAt = now
          n.calmUntil = now + 10
          n.chaseGround = false
          break
        }
        if (d < CAPTURE_DIST && P.mode === 'walk' && !captureFired) {
          captureFired = true
          n.state = 'captured'
          n.stateAt = now
          n.holdX = P.x
          n.holdZ = P.z
          n.chaseGround = false
          stop(n)
          opts.onPlayerCaptured?.(n.id)
          return
        }
        if (n.state === 'stalk' && now - n.stateAt > 1.6) {
          n.state = 'charge'
          n.stateAt = now
        }
        const charging = n.state === 'charge'
        // Aim a little ahead of a moving player
        const lead = charging ? clamp(d / CHARGE, 0, 0.6) : 0
        steerTo(n, P.x + P.vx * lead, P.z + P.vz * lead, charging ? CHARGE : STALK, 0.3)
        n.pose = charging ? 'charge_attack' : 'stalk'
        n.look = true
        return
      }
      default:
        break
    }
    if (n.state === 'edge_hold') {
      stop(n)
      face(n, P.x, P.z)
      n.pose = 'warn_spear_raise'
      n.look = true
      n.lastWarnAt = now
      // Back out of the water and close again: a fresh warning, its clock started over
      if (now - n.stateAt > 4 && !P.deep && P.mode === 'walk' && d < 14) {
        n.state = 'warn'
        n.stateAt = now
        n.warnStart = now
        n.calmClock = 0
        return
      }
      if (now - n.stateAt > 6 && (P.deep || d > 14)) {
        n.state = 'watch'
        n.stateAt = now
        n.calmUntil = now + 6
      }
      return
    }
    const spearThreat = P.held === 'spear' && d < 25
    const noticed = n.alert >= 0.3
    // Trespass: the fire's clearing, closing in on him, or simply standing in his space.
    // Just after he has calmed, only pressing in again counts.
    const tooClose = d < 5.5
    const pressing = n.approach > 0.25 && d < 12
    const trespass = !escorted && (P.sacred || tooClose || (now > n.calmUntil ? d < 18 && n.approach > 0.15 : pressing))
    if (n.state === 'warn') {
      n.lastWarnAt = now
      n.look = true
      if (escorted && !spearThreat) {
        calm(n)
        return
      }
      // Plant himself between the player and the camp
      n.plantT -= dt
      if (n.plantT <= 0) {
        n.plantT = 0.5
        let cx = fire.x - P.x
        let cz = fire.z - P.z
        const l = Math.hypot(cx, cz) || 1
        cx /= l
        cz /= l
        const px = P.x + cx * 6.5
        const pz = P.z + cz * 6.5
        if (Math.hypot(px - n.x, pz - n.z) < 15 && Math.hypot(px - n.x, pz - n.z) > 1.2 && d > 5) steerTo(n, px, pz, WALK, 0.8)
        else if (n.arrived || d <= 5) n.want = 0
      }
      face(n, P.x, P.z)
      n.pose = 'warn_spear_raise'
      // Escalate only on a warning that has stood, and only by the rules
      const held = now - n.warnStart
      const ignored = held >= WARN_HOLD && d < 9 && n.approach > 0.25
      const runAt = held >= 1 && P.speed > 2.0 && n.approach > 1.5 && d < 14
      const aiWants = n.ai?.action === 'attack_chase' && held >= WARN_HOLD && d < 14
      if ((ignored || runAt || aiWants) && canChase()) {
        startChase(n)
        return
      }
      // Backing off, getting low or showing empty hands calms him. Standing
      // still right in his space does not: that holds the standoff, no worse.
      const backing = n.approach < -0.3
      const gestured = now - lastGestureAt < 3 && (lastGesture === 'empty_hands' || lastGesture === 'crouch' || lastGesture === 'back_away')
      if (backing) n.calmClock += dt
      else if ((P.crouched || gestured) && d > 3) n.calmClock += 1.5 * dt
      else if (P.held === 'none' && n.approach <= 0.1 && !P.sacred && d > 6) n.calmClock += 0.6 * dt
      else n.calmClock = Math.max(0, n.calmClock - 0.5 * dt)
      if (n.calmClock > 1.6 && (!P.sacred || backing) && !spearThreat) {
        calm(n)
        return
      }
      if (d > 28 && !P.sacred) {
        n.state = 'watch'
        n.stateAt = now
      }
      return
    }
    if (n.state === 'step_back') {
      goTo(n, n.holdX, n.holdZ, WALK * 0.7, false, 0.5)
      face(n, P.x, P.z)
      n.pose = 'watch_suspicious'
      n.look = true
      if (now - n.stateAt > 2.5) {
        n.state = 'watch'
        n.stateAt = now
      }
      return
    }
    if (n.state === 'watch') {
      stop(n)
      face(n, P.x, P.z)
      n.pose = 'watch_suspicious'
      n.look = true
      if (noticed && (trespass || spearThreat)) {
        enterWarn(n)
        return
      }
      if (n.alert < 0.12) {
        n.state = 'schedule'
        n.stateAt = now
        setActivity(n, 'none')
      }
      return
    }
    // On his rounds
    if (noticed) {
      n.state = 'watch'
      n.stateAt = now
      if (!n.said.seen) {
        n.said.seen = true
        whisper('A tall man steps out of the trees. He does not lower his spear.')
      }
      return
    }
    n.look = false
    schedule(n, dt)
  }

  // —— Tala ——————————————————————————————————————————————————

  function thinkTala(n: Npc, dt: number) {
    const d = n.dist
    const noticed = n.alert >= 0.3
    const threat = P.held === 'spear' || (P.speed > 2.0 && n.approach > 1.4 && d < 16)
    const inWater = n.swim > 0.5
    n.look = noticed && d < 35
    if (n.state === 'wary') {
      const dx = n.x - P.x
      const dz = n.z - P.z
      const l = Math.hypot(dx, dz) || 1
      if (d < 13.5) steerTo(n, P.x + (dx / l) * 14.5, P.z + (dz / l) * 14.5, WALK * 1.2, 0.8)
      else n.want = 0
      face(n, P.x, P.z)
      n.pose = 'watch_suspicious'
      if (!threat && now - n.stateAt > 4 && d >= 12) {
        n.state = 'curious'
        n.stateAt = now
      }
      return
    }
    if (n.state === 'curious') {
      if (threat) {
        n.state = 'wary'
        n.stateAt = now
        if (!n.said.back) {
          n.said.back = true
          whisper('She backs away, keeping the same distance between you.')
        }
        return
      }
      if (n.alert < 0.12 || d > 26) {
        n.state = 'schedule'
        n.stateAt = now
        setActivity(n, 'none')
        return
      }
      const dx = n.x - P.x
      const dz = n.z - P.z
      const l = Math.hypot(dx, dz) || 1
      // Keep six to eleven metres off
      if (d < 6) steerTo(n, P.x + (dx / l) * 8.5, P.z + (dz / l) * 8.5, WALK, 0.6)
      else if (d > 11 && n.approach > -0.5) steerTo(n, P.x + (dx / l) * 9, P.z + (dz / l) * 9, WALK * 0.8, 0.6)
      else if (n.arrived || (d > 7 && d < 10)) n.want = 0
      face(n, P.x, P.z)
      // Now and then, three seconds of waving you toward the beach, away from Kael's rounds
      if (now > n.beckonAt + 3) n.beckonAt = now + rand(8, 14)
      const beckoning = now > n.beckonAt
      n.pose = beckoning && n.speed < 0.3 ? 'beckon_follow' : 'curious_tilt'
      if (beckoning && !n.said.beckon) {
        n.said.beckon = true
        const onReef = ground(n.x, n.z) < 0
        whisper(
          onReef
            ? 'The girl on the reef tilts her head, then waves you toward the beach.'
            : 'The girl tilts her head, then waves you along the sand, away from the trees.',
        )
      }
      return
    }
    if (noticed && d < 18 && !inWater) {
      n.state = 'curious'
      n.stateAt = now
      n.beckonAt = now + rand(3, 6)
      if (!n.said.seen) {
        n.said.seen = true
        whisper(
          ground(n.x, n.z) < 0.2
            ? 'A girl out on the reef straightens up and watches you.'
            : 'A girl on the beach looks up from the tideline and watches you.',
        )
      }
      return
    }
    schedule(n, dt)
  }

  // —— Oru ———————————————————————————————————————————————————

  function thinkOru(n: Npc, dt: number) {
    const d = n.dist
    const noticed = n.alert >= 0.3
    n.look = noticed && d < 35
    if (n.state === 'watch') {
      if (n.alert < 0.12 || d > 30) {
        n.state = 'schedule'
        n.stateAt = now
        return
      }
      // Seated, he stays seated and watches; standing, he stops and turns
      if (n.pose !== 'sit_fire') {
        stop(n)
        face(n, P.x, P.z)
        n.pose = 'watch_suspicious'
      }
      return
    }
    if (noticed && d < 25) {
      n.state = 'watch'
      n.stateAt = now
      if (!n.said.seen) {
        n.said.seen = true
        const atFire = Math.hypot(n.x - fire.x, n.z - fire.z) < 6
        whisper(atFire ? 'An old man by the fire looks up, and keeps looking.' : 'An old man leaning on a staff stops and watches you.')
      }
      return
    }
    schedule(n, dt)
  }

  // —— the brain's override ——————————————————————————————————

  function lead(n: Npc, ai: Override, gx: number, gz: number, edge: boolean, fx: number, fz: number) {
    if (!ai.planned) {
      ai.planned = true
      goTo(n, gx, gz, LEAD, edge, 1.2)
    }
    n.look = true
    if (n.arrived) {
      n.want = 0
      face(n, fx, fz)
      n.pose = 'beckon_follow'
      return
    }
    // Wait for the player when they fall behind
    if (ai.paused) {
      if (n.dist < 8) ai.paused = false
    } else if (n.dist > 12) ai.paused = true
    if (ai.paused) {
      n.want = 0
      face(n, P.x, P.z)
      n.pose = 'beckon_follow'
    } else {
      n.want = LEAD
      n.hasFace = false
      n.pose = n.id === 'kael' ? 'patrol' : 'idle'
    }
  }

  /** Runs the override if one is active. Returns false to let the local behaviour run. */
  function thinkAi(n: Npc): boolean {
    const ai = n.ai
    if (!ai) return false
    if (now > ai.until) {
      n.ai = null
      // Back to their own judgement, from a watchful start
      if (n.state !== 'captured') {
        n.state = n.alert > 0.3 ? (n.id === 'tala' ? 'curious' : 'watch') : 'schedule'
        n.stateAt = now
        setActivity(n, 'none')
      }
      return false
    }
    if (n.state === 'captured') return false
    const since = now - ai.start
    n.look = true
    switch (ai.action) {
      case 'warn':
      case 'attack_chase':
        // Kael's own standoff runs these, rules and all
        return false
      case 'idle':
        stop(n)
        face(n, P.x, P.z)
        n.pose = 'idle'
        return true
      case 'watch':
        stop(n)
        face(n, P.x, P.z)
        n.pose = 'watch_suspicious'
        return true
      case 'stalk': {
        // Only Kael gets here (the others are turned to watch): a slow advance that stops short
        const dx = n.x - P.x
        const dz = n.z - P.z
        const l = Math.hypot(dx, dz) || 1
        if (n.dist > 7.5) steerTo(n, P.x + (dx / l) * 7, P.z + (dz / l) * 7, STALK, 0.5)
        else n.want = 0
        face(n, P.x, P.z)
        n.pose = 'stalk'
        return true
      }
      case 'step_back':
        goTo(n, ai.tx, ai.tz, WALK * 0.8, false, 0.6)
        face(n, P.x, P.z)
        n.pose = n.arrived ? 'watch_suspicious' : 'idle'
        return true
      case 'accept_offer':
        stop(n)
        face(n, P.x, P.z)
        n.pose = since < 2.5 ? 'accept_gift' : 'idle'
        return true
      case 'scoff_at_cash':
        stop(n)
        face(n, P.x, P.z)
        // The old man laughs until he has to sit down
        n.pose = since < 3 ? 'laugh_baffled' : n.id === 'oru' ? 'sit_fire' : 'idle'
        return true
      case 'beckon_to_caves': {
        const g = n.cls === 'wade' ? cavesWade : cavesEdge
        lead(n, ai, g.x, g.z, true, places.cavesMouth.x, places.cavesMouth.z)
        return true
      }
      case 'beckon_to_elder': {
        escortedUntil = Math.max(escortedUntil, ai.until + 30)
        const dx = n.x - fire.x
        const dz = n.z - fire.z
        const l = Math.hypot(dx, dz) || 1
        // Oru is the elder: he just waits by his own fire
        if (n.id === 'oru' && l < 8) {
          stop(n)
          face(n, P.x, P.z)
          n.pose = 'beckon_follow'
          return true
        }
        lead(n, ai, fire.x + (dx / l) * 4, fire.z + (dz / l) * 4, false, fire.x, fire.z)
        return true
      }
      case 'guide_escape':
        lead(n, ai, places.landing.x, places.landing.z, true, landingSea.x, landingSea.z)
        return true
    }
    return false
  }

  // —— the frame ——————————————————————————————————————————————

  function think(n: Npc, dt: number) {
    if (!thinkAi(n)) {
      if (n.id === 'kael') thinkKael(n, dt)
      else if (n.id === 'tala') thinkTala(n, dt)
      else thinkOru(n, dt)
    }
    // A sitting pose needs the islander stopped; nobody sits on the move
    if (n.pose === 'sit_fire' && (!n.arrived || n.speed > 0.15)) n.pose = 'idle'
    const ai = n.ai
    if (ai?.pose && n.state !== 'captured') {
      const chasing = n.state === 'stalk' || n.state === 'charge'
      if (ai.pose !== 'charge_attack' || chasing) {
        if (!(ai.pose === 'sit_fire' && !n.arrived)) n.pose = ai.pose
      }
    }
  }

  const forward = new THREE.Vector3()

  function update(
    dt: number,
    t: number,
    player: TribePlayerState,
    weather: TribeWeather,
    heldItem: HeldItem,
    carryingBag: boolean,
    camera?: THREE.Camera,
  ) {
    dt = Math.min(dt, 0.1)
    now += dt
    flushWhisper()
    W.dayPhase = weather.dayPhase
    W.daylight = weather.daylight
    W.storm = weather.storm
    W.tide = weather.tide
    W.tidePhase = weather.tidePhase

    // The player
    if (Number.isNaN(P.lastX) || Math.hypot(player.x - P.lastX, player.z - P.lastZ) > 5) {
      P.vx = 0
      P.vz = 0
    } else if (dt > 0) {
      P.vx = damp(P.vx, (player.x - P.lastX) / dt, 8, dt)
      P.vz = damp(P.vz, (player.z - P.lastZ) / dt, 8, dt)
    }
    P.lastX = player.x
    P.lastZ = player.z
    P.x = player.x
    P.y = player.y
    P.z = player.z
    P.speed = player.speed
    P.crouched = player.crouched
    P.mode = player.mode
    P.held = heldItem
    P.bag = carryingBag
    P.ground = ground(player.x, player.z)
    P.depth = W.tide - P.ground
    P.deep = P.depth > DEEP_WATER
    P.onLand = player.mode === 'walk' && P.ground > W.tide + 0.05
    P.sacred = places.inSacredZone(player.x, player.z)
    if (P.onLand && firstLandAt < 0) firstLandAt = now
    playerHead.set(player.x, Math.max(player.y, W.tide + 0.3), player.z)

    // Day, night and weather, with a little hysteresis so nobody dithers at a threshold
    if (W.storm > 0.55) stormy = true
    else if (W.storm < 0.45) stormy = false
    campMode = W.dayPhase < 0.24 || W.dayPhase > 0.82 || stormy
    if (W.tidePhase < -0.25) lowTide = true
    else if (W.tidePhase > -0.12) lowTide = false
    if (W.tidePhase > 0.45) highTide = true
    else if (W.tidePhase < 0.32) highTide = false

    if (needSnap) {
      needSnap = false
      for (const n of npcs) snapToSchedule(n)
    }

    const refX = camera ? camera.position.x : player.x
    const refZ = camera ? camera.position.z : player.z
    for (const n of npcs) {
      const dRef = Math.hypot(n.x - refX, n.z - refZ)
      const wasVisible = n.visible
      if (n.visible && dRef > HIDE_DIST) n.visible = false
      else if (!n.visible && dRef < SHOW_DIST) n.visible = true
      n.rig.root.visible = n.visible

      if (!n.visible) {
        // Out of sight: no eyes, no ears, the schedule twice a second and a coarse step
        n.snap.seen = false
        n.snap.heard = false
        n.dist = Math.hypot(P.x - n.x, P.z - n.z)
        n.snap.distance = n.dist
        n.alert = Math.max(0, n.alert - dt * 0.06)
        n.thinkT -= dt
        if (n.thinkT <= 0) {
          n.thinkT = 0.5
          if (!thinkAi(n) && n.state !== 'captured') schedule(n, 0.5)
        }
        coarseMove(n, dt)
        continue
      }
      if (!wasVisible) {
        // Coming into view: put them on the ground where the coarse step left them
        settle(n, 0)
        n.rig.setPose(n.pose)
        n.rig.snapPose()
      }

      perceive(n, dt)
      updateAlert(n, dt)
      proximity(n)
      think(n, dt)
      move(n, dt)

      const rig = n.rig
      rig.root.position.set(n.x, n.y, n.z)
      rig.root.rotation.set(0, n.yaw, 0)
      rig.setPose(n.pose)
      rig.lookAt(n.look ? playerHead : null)
      forward.set(-Math.sin(n.yaw), 0, -Math.cos(n.yaw))
      const hAhead = ground(n.x + forward.x * 0.6, n.z + forward.z * 0.6)
      motion.speed = n.speed
      motion.turnRate = n.turnRate
      motion.wading = n.wade
      motion.slope = n.swim > 0.5 ? 0 : (hAhead - ground(n.x, n.z)) / 0.6
      motion.reach = n.reach
      motion.swim = n.swim
      rig.update(dt, t, motion)
    }
  }

  // —— the brain's control surface —————————————————————————————

  function applyAiDecision(npcId: NpcId, action: NpcAction, pose?: NpcPose) {
    const n = byId(npcId)
    if (!n || n.state === 'captured') return
    let act = action
    // Only Kael carries a spear; the others' version of a threat is to watch or back off
    if (n.id !== 'kael') {
      if (act === 'attack_chase') act = 'step_back'
      if (act === 'warn' || act === 'stalk') act = 'watch'
    }
    const refresh = n.ai !== null && n.ai.action === act
    if (refresh && n.ai) {
      n.ai.until = now + AI_HOLD
      n.ai.pose = pose ?? n.ai.pose
      return
    }
    const dx = n.x - P.x
    const dz = n.z - P.z
    const l = Math.hypot(dx, dz) || 1
    n.ai = {
      action: act,
      pose: pose ?? null,
      start: now,
      until: now + AI_HOLD,
      planned: false,
      paused: false,
      tx: n.x + (dx / l) * 3.5,
      tz: n.z + (dz / l) * 3.5,
    }
    // Standing down is always allowed: anything short of a threat ends a chase
    // or a standoff, and a warning or a stalk takes a chase back to the standoff
    const chasing = n.state === 'stalk' || n.state === 'charge'
    const hostile = act === 'attack_chase' || act === 'warn' || act === 'stalk'
    if (!hostile && (chasing || n.state === 'warn' || n.state === 'edge_hold')) {
      n.state = 'watch'
      n.stateAt = now
      n.chaseGround = false
      n.calmUntil = now + 8
    } else if (chasing && act !== 'attack_chase') {
      n.chaseGround = false
      enterWarn(n)
    }
    if (n.id === 'kael' && (act === 'warn' || act === 'attack_chase')) {
      const warnedRecently = now - n.lastWarnAt < 20
      if (n.state === 'stalk' || n.state === 'charge' || n.state === 'edge_hold') {
        // Already as far as the rules allow
      } else if (
        act === 'attack_chase' &&
        warnedRecently &&
        n.state === 'warn' &&
        now - n.warnStart >= WARN_HOLD &&
        n.dist < 14 &&
        canChase()
      ) {
        startChase(n)
      } else {
        // No warning standing: he warns first, whatever the brain asked
        enterWarn(n)
      }
    }
    const who = n.id === 'oru' ? 'The old man' : n.id === 'tala' ? 'The girl' : 'He'
    const they = n.id === 'tala' ? 'She' : 'He'
    switch (act) {
      case 'accept_offer':
        whisper(n.id === 'tala' ? 'She takes it carefully and turns it to the light.' : `${who} takes it in both hands and turns it over.`)
        break
      case 'scoff_at_cash':
        whisper(
          n.id === 'oru'
            ? 'The old man laughs until he has to sit down.'
            : n.id === 'tala'
              ? 'The girl peels a wet note loose, looks at it, and laughs at you.'
              : 'He turns the wet bundle over, sniffs it, and snorts.',
        )
        break
      case 'beckon_to_caves':
        whisper(`${they} starts off toward the rocks, looking back to see if you follow.`)
        break
      case 'beckon_to_elder':
        whisper(n.id === 'oru' ? 'The old man waves you in to the fire.' : `${they} turns toward the smoke and waits for you to follow.`)
        break
      case 'guide_escape':
        whisper(`${they} walks you down to the water and points out to sea.`)
        break
      default:
        break
    }
  }

  function getPerceptionSnapshot(
    npcId: NpcId,
    player: TribePlayerState,
    heldItem: HeldItem,
    weather: TribeWeather,
    carryingBag = false,
  ): NpcPerceptionSnapshot {
    const n = byId(npcId)
    const dx = player.x - n.x
    const dz = player.z - n.z
    const d = Math.hypot(dx, dz)
    const angle = Math.abs(angleDelta(n.yaw, Math.atan2(-dx, -dz)))
    const pg = ground(player.x, player.z)
    const submerged = player.y < weather.tide - 0.25
    const forest = player.mode === 'walk' && pg > 6 ? 0.65 : 1
    const range = (VISION_NIGHT + (VISION_DAY - VISION_NIGHT) * weather.daylight) * (1 - 0.45 * weather.storm) * forest
    let seen = !submerged && d < range && (angle < VISION_HALF || d < 3.5)
    if (seen) {
      const eyeN = n.y + n.rig.height * 0.93
      for (const f of SIGHT_SAMPLES) {
        if (ground(n.x + dx * f, n.z + dz * f) > eyeN + (player.y - eyeN) * f + 1.5) {
          seen = false
          break
        }
      }
    }
    let hear: number
    if (player.mode === 'swim') hear = player.speed < 0.9 ? 1.2 : 3 + 2 * player.speed
    else hear = (6 + 5 * (player.speed / 2.35)) * (player.crouched ? 0.5 : 1)
    hear *= 1 - 0.4 * weather.storm
    return {
      npcId,
      distance: d,
      angle,
      playerSpeed: player.speed,
      crouched: player.crouched,
      heldItem,
      inSacredZone: places.inSacredZone(player.x, player.z),
      carryingBag,
      timeOfDay: weather.dayPhase,
      tide: weather.tidePhase,
      storm: weather.storm,
      seen,
      heard: d < hear,
    }
  }

  function effectiveAction(n: Npc): NpcAction {
    if (n.ai && n.state !== 'captured') {
      if (n.ai.action === 'attack_chase') return n.state === 'stalk' || n.state === 'charge' ? 'attack_chase' : 'warn'
      return n.ai.action
    }
    switch (n.state) {
      case 'stalk':
      case 'charge':
        return 'attack_chase'
      case 'warn':
      case 'edge_hold':
      case 'captured':
        return 'warn'
      case 'step_back':
      case 'wary':
        return 'step_back'
      case 'watch':
      case 'curious':
        return 'watch'
      default:
        return 'idle'
    }
  }

  function getNearestNpc(playerPos: THREE.Vector3 | { x: number; y: number; z: number }): NpcInfo | null {
    let best: Npc | null = null
    let bestD = Infinity
    for (const n of npcs) {
      const d = Math.hypot(n.x - playerPos.x, n.z - playerPos.z)
      if (d < bestD) {
        bestD = d
        best = n
      }
    }
    if (!best) return null
    return {
      id: best.id,
      position: new THREE.Vector3(best.x, best.y, best.z),
      distance: Math.hypot(best.x - playerPos.x, best.y - playerPos.y, best.z - playerPos.z),
      pose: best.pose,
      action: effectiveAction(best),
    }
  }

  function getNpcState(id: NpcId): NpcDebugState {
    const n = byId(id)
    return {
      id,
      position: new THREE.Vector3(n.x, n.y, n.z),
      yaw: n.yaw,
      action: effectiveAction(n),
      pose: n.pose,
      state: n.state,
      activity: n.act.kind,
      alert: n.alert,
      warned: n.lastWarnAt > -Infinity,
      warnedAgo: n.lastWarnAt > -Infinity ? now - n.lastWarnAt : Infinity,
      warnSeconds: n.state === 'warn' ? now - n.warnStart : 0,
      chasing: n.state === 'stalk' || n.state === 'charge',
      captured: n.state === 'captured',
      aiAction: n.ai?.action ?? null,
      aiPose: n.ai?.pose ?? null,
      aiRemaining: n.ai ? Math.max(0, n.ai.until - now) : 0,
      graceRemaining: firstLandAt < 0 ? LAND_GRACE : Math.max(0, LAND_GRACE - (now - firstLandAt)),
      visible: n.visible,
      seen: n.snap.seen,
      heard: n.snap.heard,
      distance: n.dist,
      goal: n.hasGoal ? { x: n.goalX, z: n.goalZ } : null,
      route: { points: n.pathLen, next: n.pathIdx, blocked: n.blocked, replans: n.replans },
    }
  }

  function resetEncounters() {
    captureFired = false
    escortedUntil = -Infinity
    // A fresh landing gets a fresh grace: whoever comes ashore after a reset is not caught at once
    firstLandAt = -1
    lastWhisper = ''
    pendingWhisper = ''
    lastGesture = null
    for (const n of npcs) {
      n.alert = 0
      n.state = 'schedule'
      n.stateAt = now
      n.ai = null
      n.warnStart = -Infinity
      n.lastWarnAt = -Infinity
      n.chaseStart = -Infinity
      n.calmClock = 0
      n.calmUntil = -Infinity
      n.chaseGround = false
      n.armed = true
      n.approach = 0
      n.snap.seen = false
      n.snap.heard = false
      n.percT = 0
      n.said.seen = n.said.beckon = n.said.back = n.said.warn = false
      n.look = false
      snapToSchedule(n)
      n.rig.root.position.set(n.x, n.y, n.z)
      n.rig.root.rotation.set(0, n.yaw, 0)
    }
  }

  /**
   * Optional: tell the islanders what the player just did with their body
   * (the HUD's gesture buttons). Showing empty hands, crouching or backing off
   * counts toward calming a standing warning.
   */
  function playerGesture(gesture: PlayerGesture) {
    lastGesture = gesture
    lastGestureAt = now
  }

  // Placed by the fire until the first frame says what time it is
  for (const n of npcs) {
    settle(n, 0)
    n.rig.root.position.set(n.x, n.y, n.z)
  }

  /** Where everything the schedules use ended up on this island, for debugging and the brain's map. */
  const layout = {
    kaelPost: { x: postX, z: postZ },
    oruSeat,
    talaSeat,
    poolSpot,
    cavesShore,
    cavesEdge,
    cavesWade,
    combPoints: combPoints as readonly { x: number; z: number }[],
    patrol: patrol.map((p, i) => ({ x: p.x, z: p.z, legPoints: legs[i]?.n ?? 0 })),
    campToCovePoints: campToCoveLen,
    nav: { cell: nav.cell, nx: nav.nx, nz: nav.nz, hasRock: nav.hasRock },
  }

  /** Debug: plan a route over the grid the way an islander would, without moving anyone. */
  function testRoute(fromX: number, fromZ: number, toX: number, toZ: number, who: NpcId = 'kael') {
    const cls: NavClass = who === 'tala' ? 'wade' : 'dry'
    const minG = cls === 'dry' ? Math.max(0.35, W.tide + 0.15) : 0
    const out = new Float32Array(2 * 512)
    const n = nav.path(fromX, fromZ, toX, toZ, cls, minG, W.tide, out)
    const points: { x: number; z: number }[] = []
    for (let i = 0; i < n; i++) points.push({ x: out[i * 2], z: out[i * 2 + 1] })
    const s = nav.nearest(fromX, fromZ, cls, minG, W.tide, 24)
    const t = nav.nearest(toX, toZ, cls, minG, W.tide, 30)
    return { points, startCell: s, goalCell: t }
  }

  return {
    group,
    places,
    layout,
    testRoute,
    update,
    applyAiDecision,
    getNearestNpc,
    getPerceptionSnapshot,
    resetEncounters,
    getNpcState,
    playerGesture,
    npcs: npcs.map((n) => ({ id: n.id, rig: n.rig })) as readonly { readonly id: NpcId; readonly rig: IslanderRig }[],
  }
}

export type TribeSim = ReturnType<typeof createTribeSim>
