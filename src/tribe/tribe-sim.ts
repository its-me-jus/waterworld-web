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
 * Inside each place on the schedule there is a small life: Tala bends to the
 * reef, straightens, looks out, wades on, sometimes swims; Oru leans in to
 * the fire, reads the sky, gets up to feed it; Kael stops at his lookouts
 * and scans the water and the tree line. Every duration is drawn from that
 * islander's own seeded dice, so nothing loops and no two keep time.
 *
 * Nobody snaps. Speed and heading are both eased (`smoothDamp`), there is a
 * beat before a walk sets off, a standing turn comes before the first step,
 * and the eyes go first: each frame a behaviour says what the islander wants
 * to look at, the gaze travels there at that person's own pace, and the body
 * is only asked to follow after the head has got there.
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
const smooth01 = (v: number) => {
  const k = clamp(v, 0, 1)
  return k * k * (3 - 2 * k)
}

/** The rate left behind by the last smoothDamp call (a second return value without an allocation). */
let sdRate = 0
/**
 * Critically damped approach to a target: the rate of change never jumps,
 * even when the target does. `rate` is the value's current rate of change;
 * the new one is left in `sdRate`. `time` is roughly how long the move takes;
 * `maxRate` caps how fast it may go.
 */
function smoothDamp(cur: number, target: number, rate: number, time: number, maxRate: number, dt: number) {
  if (dt <= 0) {
    sdRate = rate
    return cur
  }
  const omega = 2 / Math.max(time, 1e-3)
  const x = omega * dt
  const k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const maxChange = maxRate * time
  const change = clamp(cur - target, -maxChange, maxChange)
  const goal = cur - change
  const temp = (rate + omega * change) * dt
  sdRate = (rate - omega * temp) * k
  return goal + (change + temp) * k
}
/** The same for a heading, the short way round. */
const smoothDampAngle = (cur: number, target: number, rate: number, time: number, maxRate: number, dt: number) =>
  smoothDamp(cur, cur + angleDelta(cur, target), rate, time, maxRate, dt)

/** A small seeded generator (mulberry32). Each islander draws from their own, so a run repeats and no two keep time. */
function makeRng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// —— tuning ————————————————————————————————————————————————————

/** Ground speeds, m/s. The charge beats the player's 2.35 walk: the sea, not running, is the way out. */
const WALK = 1.3
const PATROL = 1.1
const STALK = 1.0
const CHARGE = 3.4
const ELDER = 0.65
/** The fastest Oru ever walks, for whatever reason: past about a metre a second he strides like the young ones. */
const OLD_PACE = 0.95
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
/** Inside this Kael stops and squares up to a stranger; further off he only stops walking and looks. */
const WATCH_RANGE = 21
/** Nobody's feet come nearer the middle of the fire than this. */
const FIRE_CLEAR = 1.25
/** The walk round the fire: outside the ends of its logs, inside the seats. */
const FIRE_ROUND = 1.7
/** Where someone stands to feed it: far enough back that a bend toward it stops at the ends of the logs. */
const TEND_R = 1.9

/**
 * How each of them moves: the same rules, three different bodies. Kael is
 * deliberate, Tala quick, Oru slow in everything, and his head turns long
 * before the rest of him does.
 */
type Temper = {
  /** Seconds to wind a walk up, and to brake it. */
  startT: number
  stopT: number
  /** Top turning rate on the spot, rad/s, and the seconds a turn takes to wind up. */
  turn: number
  turnT: number
  /** The beat between deciding to go and the first step, seconds (lo, hi). */
  setOffLo: number
  setOffHi: number
  /** How long the head leads before the feet come round (lo, hi). */
  leadLo: number
  leadHi: number
  /** Seconds the eyes take to travel to something new, and the fastest the head will turn for them, rad/s. */
  gazeT: number
  gazeMax: number
}
const TEMPER: Record<NpcId, Temper> = {
  kael: { startT: 0.5, stopT: 0.34, turn: 2.5, turnT: 0.3, setOffLo: 0.25, setOffHi: 0.55, leadLo: 0.3, leadHi: 0.5, gazeT: 0.26, gazeMax: 3.4 },
  tala: { startT: 0.38, stopT: 0.26, turn: 3.1, turnT: 0.24, setOffLo: 0.15, setOffHi: 0.4, leadLo: 0.15, leadHi: 0.35, gazeT: 0.18, gazeMax: 4.4 },
  oru: { startT: 0.9, stopT: 0.55, turn: 1.25, turnT: 0.5, setOffLo: 0.6, setOffHi: 1.3, leadLo: 0.9, leadHi: 1.6, gazeT: 0.7, gazeMax: 1.5 },
}
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
  kind: 'none' | 'camp' | 'patrol' | 'dwell' | 'rocks' | 'comb' | 'shore' | 'seat' | 'pool' | 'tend' | 'weather' | 'back'
  timer: number
  index: number
  /** What the islander does once there. */
  sub: number
}

/** A look at something for a while: a person, the player or a fixed point. */
type Glance = {
  kind: string
  /** -1 the player, -2 the fixed point below, otherwise an islander's index. */
  who: number
  x: number
  y: number
  z: number
  from: number
  until: number
  pri: number
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
  /** Forward ground speed, m/s: what the legs are told. */
  speed: number
  want: number
  turnRate: number
  /** Their own seeded dice. */
  rng: () => number
  // the feel of the movement
  /** Rate of change of speed and of heading, carried so neither ever jumps. */
  accel: number
  yawVel: number
  /** The speed the current walk was asked for; `want` drops to 0 for a pause and comes back to this. */
  cruise: number
  /** How near a route's corner counts as round it. */
  wpR: number
  /** Ground actually covered last frame, m/s. */
  gspeed: number
  slope: number
  stillT: number
  setOffT: number
  going: boolean
  pivot: boolean
  /** A chase: no beat before setting off, no turning on the spot first. */
  urgent: boolean
  faceYaw: number
  faceWait: number
  turning: boolean
  // the eyes
  /** What they want to look at this frame ('' for nothing), where it is, and how much it matters. */
  lk: string
  lkx: number
  lky: number
  lkz: number
  lkPri: number
  gl: Glance
  gazeOn: boolean
  gazeYaw: number
  gazePitch: number
  gazeYV: number
  gazePV: number
  lookPt: THREE.Vector3
  /** When the next look at a far-off stranger may start. */
  glanceAt: number
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
  hasFace: boolean
  // body
  pose: NpcPose
  reach: number
  swim: number
  wade: number
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
  said: { seen: boolean; beckon: boolean; back: boolean; warn: boolean; far: boolean; gave: boolean }
  // the small life inside the schedule
  /** Gone in to the fire for the night or the weather (each has their own hour). */
  camp: boolean
  /** A plain name for what they are doing, for the debug view. */
  doing: string
  step: number
  stepT: number
  /** How long the current step has run. */
  stepAge: number
  spot: number
  reps: number
  plan: number
  seatOff: number
  lastSwim: number
  sweep: number
  /** A bearing the current step looks or faces along. */
  aim: number
  /** The wading value sent to the body: depth, eased off while standing still. */
  wadeFed: number
  /** The weather or the dark has told the old man the fire needs feeding. */
  forceTend: boolean
  // reactions
  /** How long the head leads before the feet come round, this time. */
  lead: number
  /** How long he looks before the spear comes up, this time. */
  readyT: number
  farT: number
  farNext: number
  planting: boolean
  moveHold: number
  side: number
  tiltUntil: number
  peekT: number
  peeking: boolean
  checkAt: number
}

export type TribeSimOptions = {
  island: IslandLike
  reefWreckPos: THREE.Vector3
  tidalCaves: TidalCavesLike
  lowPower: boolean
  onProximityEnter?: (id: NpcId, snapshot: NpcPerceptionSnapshot) => void
  onPlayerCaptured?: (id: NpcId) => void
  onWhisper?: (text: string) => void
  /**
   * Optional, for the islanders' sound: a moment in an encounter, raised the
   * frame it happens (read off the state after each think; nothing here
   * changes what anyone does).
   */
  onCue?: (id: NpcId, cue: TribeCue) => void
}

/**
 * - `look`: a look up at the player from what they are doing, before any encounter
 * - `notice`: turns to watch (Kael, Oru) or to wonder (Tala)
 * - `warn`: Kael's spear comes up (`chase` once he comes for you)
 * - `calm`: Kael gives ground; `wary`: Tala backs off
 * - `laugh`: the laugh / scoff pose begins; `accept`: takes what is offered
 */
export type TribeCue = 'look' | 'notice' | 'warn' | 'chase' | 'calm' | 'wary' | 'laugh' | 'accept'

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
  /** The sim's own clock, seconds. */
  clock: number
  /** Ground speed the body is told about, m/s, and the yaw rate, rad/s. */
  speed: number
  turnRate: number
  /** Ground actually covered last frame, m/s: the same as `speed`, which is what the body plants its feet against. */
  groundSpeed: number
  /** 0..1 bend-and-reach sent to the body. */
  reach: number
  /** Whether the head is being turned toward something. */
  looking: boolean
  /** What they are looking at ('' for nothing) and where the eyes point: yaw off the body's facing, and pitch. */
  look: string
  gazeYaw: number
  gazePitch: number
  /** A plain name for what the schedule or the encounter has them doing right now. */
  doing: string
  /** The wading, slope and swim values sent to the body. */
  wading: number
  slope: number
  swim: number
  /** The last narration line sent (shared by all three), and when on the sim's clock. */
  whisper: string
  whisperAt: number
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

  // —— the small places the day's work uses ——
  /** Ground a person can stand on beside the fire: dry, and not a step up or down from it. */
  const campOk = (x: number, z: number) => Math.abs(ground(x, z) - fire.y) < 1.4
  /** `r` from the fire along a direction turned by `turn`. */
  const fireSide = (dx: number, dz: number, turn: number, r: number) => {
    const l = Math.hypot(dx, dz) || 1
    const c = Math.cos(turn)
    const s = Math.sin(turn)
    return { x: fire.x + ((dx * c - dz * s) / l) * r, z: fire.z + ((dx * s + dz * c) / l) * r }
  }
  /** Of two points, the one further along a direction. */
  const further = (a: { x: number; z: number }, b: { x: number; z: number }, dx: number, dz: number) =>
    (a.x - fire.x) * dx + (a.z - fire.z) * dz >= (b.x - fire.x) * dx + (b.z - fire.z) * dz ? a : b
  // Everything round the fire stays within four metres of it, on the open side toward the pool and the way in
  const toPoolX = places.campPool.x - fire.x
  const toPoolZ = places.campPool.z - fire.z
  // Where each of them bends to the fire: their own side of it, a step round from their seat
  let oruTend = further(
    fireSide(oruSeat.x - fire.x, oruSeat.z - fire.z, 1.15, TEND_R),
    fireSide(oruSeat.x - fire.x, oruSeat.z - fire.z, -1.15, TEND_R),
    toPoolX,
    toPoolZ,
  )
  let talaTend = further(
    fireSide(talaSeat.x - fire.x, talaSeat.z - fire.z, 1.0, TEND_R),
    fireSide(talaSeat.x - fire.x, talaSeat.z - fire.z, -1.0, TEND_R),
    approachX,
    approachZ,
  )
  if (!campOk(oruTend.x, oruTend.z)) oruTend = oruSeat
  if (!campOk(talaTend.x, talaTend.z)) talaTend = talaSeat
  // Where the old man stands to read the sky: a few steps out along the way in
  let skySpot = fireSide(approachX, approachZ, 0, 3.4)
  if (!campOk(skySpot.x, skySpot.z)) skySpot = poolSpot
  // Tala's own place at the pool, so two people never stand on one spot
  let talaPool = poolSpot
  {
    const dx = fire.x - places.campPool.x
    const dz = fire.z - places.campPool.z
    const l = Math.hypot(dx, dz) || 1
    for (const turn of [0.95, -0.95]) {
      const c = Math.cos(turn)
      const s = Math.sin(turn)
      const p = { x: places.campPool.x + ((dx * c - dz * s) / l) * 3, z: places.campPool.z + ((dx * s + dz * c) / l) * 3 }
      const better = talaPool === poolSpot || (p.x - fire.x) * approachX + (p.z - fire.z) * approachZ > (talaPool.x - fire.x) * approachX + (talaPool.z - fire.z) * approachZ
      if (campOk(p.x, p.z) && ground(p.x, p.z) > places.campPool.y + 0.15 && Math.hypot(p.x - fire.x, p.z - fire.z) < 5.5 && better) talaPool = p
    }
  }
  // Kael's night post has a second standing place a few steps further out along the way in
  let postOut = { x: postX + approachX * 3.2, z: postZ + approachZ * 3.2 }
  if (Math.abs(ground(postOut.x, postOut.z) - ground(postX, postZ)) > 1.6 || ground(postOut.x, postOut.z) < 1) postOut = { x: postX, z: postZ }

  // The reef crest by the coaster: where Tala can stand to work at low water, and deeper water beside it for a swim.
  // The hull has no collision here, so every spot, and every walk between two of them, keeps clear of where she
  // lies: along the reef with her bow swung 0.45 rad to seaward (as reefwreck.ts lays her), 34.5 m by 8.6 m.
  const reefSpots: { x: number; z: number }[] = [{ x: places.lagoonRocks.x, z: places.lagoonRocks.z }]
  const reefDeep: { x: number; z: number }[] = []
  let reefGate: { x: number; z: number } | null = null
  let hullAX = 1
  let hullAZ = 0
  let hullKeep = 0
  const hullClear = (x: number, z: number, extra: number) => {
    const dx = x - opts.reefWreckPos.x
    const dz = z - opts.reefWreckPos.z
    return Math.abs(dx * hullAX + dz * hullAZ) > 19.5 || Math.abs(dx * hullAZ - dz * hullAX) > hullKeep + extra
  }
  /** A straight walk or swim between two points that stays clear of the hull. */
  const reefWay = (ax: number, az: number, bx: number, bz: number) => {
    for (let i = 1; i < 4; i++) {
      if (!hullClear(ax + ((bx - ax) * i) / 4, az + ((bz - az) * i) / 4, 0)) return false
    }
    return true
  }
  {
    const r0 = places.lagoonRocks
    let rx = opts.reefWreckPos.x - island.centre.x
    let rz = opts.reefWreckPos.z - island.centre.z
    const rl = Math.hypot(rx, rz) || 1
    rx /= rl
    rz /= rl
    hullAX = -rz * Math.cos(0.45) + rx * Math.sin(0.45)
    hullAZ = rx * Math.cos(0.45) + rz * Math.sin(0.45)
    // Her usual spot is itself right beside the plating; nowhere she goes is any closer than that
    const lat0 = Math.abs((r0.x - opts.reefWreckPos.x) * hullAZ - (r0.z - opts.reefWreckPos.z) * hullAX)
    hullKeep = clamp(lat0 - 0.05, 3.5, 5.2)
    const stand: { x: number; z: number; d: number }[] = []
    const deep: { x: number; z: number; d: number }[] = []
    if (r0.y < 0.2) {
      for (let dz = -15; dz <= 15; dz += 1.5) {
        for (let dx = -15; dx <= 15; dx += 1.5) {
          const x = r0.x + dx
          const z = r0.z + dz
          const d = Math.hypot(dx, dz)
          if (d < 2 || d > 15) continue
          const h = ground(x, z)
          const rough = Math.max(Math.abs(ground(x + 1.5, z) - h), Math.abs(ground(x - 1.5, z) - h), Math.abs(ground(x, z + 1.5) - h), Math.abs(ground(x, z - 1.5) - h)) / 1.5
          if (h > -1.6 && h < -0.3 && rough < 0.85 && hullClear(x, z, 0)) stand.push({ x, z, d })
          else if (h > -3.8 && h < -1.85 && d > 4 && hullClear(x, z, 2.5)) deep.push({ x, z, d })
        }
      }
    }
    stand.sort((a, b) => a.d - b.d)
    for (const p of stand) {
      if (reefSpots.length >= 8) break
      if (reefSpots.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 2.6)) continue
      // Each new spot must be a short clear wade from one she already has
      if (!reefSpots.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 6 && reefWay(q.x, q.z, p.x, p.z))) continue
      reefSpots.push({ x: p.x, z: p.z })
    }
    deep.sort((a, b) => a.d - b.d)
    for (const p of deep) {
      if (reefDeep.length >= 3) break
      if (reefDeep.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 4)) continue
      if (!reefSpots.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 9 && reefWay(q.x, q.z, p.x, p.z))) continue
      reefDeep.push({ x: p.x, z: p.z })
    }
    // The way on and off the reef: the deep spot she can reach from the beach, and her patch from it, without
    // crossing the hull. A walk from the beach straight to her patch would cut through the coaster's stern.
    for (const p of reefDeep) {
      const dx = places.landing.x - p.x
      const dz = places.landing.z - p.z
      const l = Math.hypot(dx, dz) || 1
      let clear = reefWay(p.x, p.z, r0.x, r0.z)
      for (let d = 1.5; d < 45 && clear; d += 1.5) clear = hullClear(p.x + (dx / l) * d, p.z + (dz / l) * d, 1)
      if (clear) {
        reefGate = p
        break
      }
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
      rng: makeRng(0x9e3779b9 ^ ((index + 1) * 0x85ebca6b)),
      accel: 0,
      yawVel: 0,
      cruise: 0,
      wpR: 1.6,
      gspeed: 0,
      slope: 0,
      stillT: 10,
      setOffT: 0,
      going: false,
      pivot: false,
      urgent: false,
      faceYaw: 0,
      faceWait: 0,
      turning: false,
      lk: '',
      lkx: 0,
      lky: 0,
      lkz: 0,
      lkPri: -1,
      gl: { kind: '', who: -2, x: 0, y: 0, z: 0, from: 0, until: -Infinity, pri: 0 },
      gazeOn: false,
      gazeYaw: 0,
      gazePitch: 0,
      gazeYV: 0,
      gazePV: 0,
      lookPt: new THREE.Vector3(),
      glanceAt: 0,
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
      hasFace: false,
      pose: 'idle',
      reach: 0,
      swim: 0,
      wade: 0,
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
      said: { seen: false, beckon: false, back: false, warn: false, far: false, gave: false },
      camp: false,
      doing: '',
      step: 0,
      stepT: 0,
      stepAge: 0,
      spot: 0,
      reps: 0,
      plan: 0,
      seatOff: 0,
      lastSwim: -Infinity,
      sweep: 0,
      aim: 0,
      wadeFed: 0,
      forceTend: false,
      lead: 0.4,
      readyT: 1.4,
      farT: 0,
      farNext: 0,
      planting: false,
      moveHold: 0,
      side: index % 2 === 0 ? 1 : -1,
      tiltUntil: -Infinity,
      peekT: 0,
      peeking: true,
      checkAt: 0,
    }
    return n
  })
  /** A seeded number between two bounds, from that islander's own dice. */
  const rnd = (n: Npc, lo: number, hi: number) => lo + n.rng() * (hi - lo)
  const byId = (id: NpcId) => npcs[ids.indexOf(id)]

  // —— shared encounter state ——
  let now = 0
  let firstLandAt = -1
  let captureFired = false
  let escortedUntil = -Infinity
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
  /** This frame's step, for the helpers that count time without being handed it. */
  let frameDt = 0
  // The weather and the light, as things that happen once and are reacted to
  let stormRising = false
  let wasLight = true
  let saidHome = false
  /** When each pair of islanders may next trade a look (kael-tala, kael-oru, tala-oru), and whether they were near last frame. */
  const pairNext = [0, 0, 0]
  const pairNear = [false, false, false]
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
    const goalD = n.hasGoal ? Math.hypot(n.goalX - n.x, n.goalZ - n.z) : Infinity
    for (const f of STEP_SAMPLES) {
      const x = n.x + sx * len * f
      const z = n.z + sz * len * f
      // The fire is in nobody's way to walk through (a look past where they are going does not count)
      if (len * f < goalD + 0.3 && Math.hypot(x - fire.x, z - fire.z) < FIRE_CLEAR) return false
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
    n.cruise = 0
    n.hasGoal = false
    n.arrived = true
  }

  /** Stand a moment without giving up the walk they are on: the schedule hands the pace back next frame. */
  function pause(n: Npc) {
    n.want = 0
  }

  /** Walk somewhere, planning a route over the grid when it is not a short straight walk. */
  function goTo(n: Npc, x: number, z: number, speed: number, edge = false, arriveR = 0.8) {
    // The old man never strides like the young ones, whoever sets the pace
    if (n.id === 'oru' && speed > OLD_PACE) speed = OLD_PACE
    n.want = speed
    n.cruise = speed
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
    n.wpR = 1.6
    const d = Math.hypot(n.goalX - n.x, n.goalZ - n.z)
    if (d < 10) {
      n.pathLen = 0
      skirtFire(n)
      return
    }
    const minG = n.cls === 'dry' ? Math.max(0.35, W.tide + 0.15) : 0
    n.pathLen = nav.path(n.x, n.z, n.goalX, n.goalZ, n.cls, minG, W.tide, n.path)
    // A route is followed from its second point; the first is where they already are
    if (n.pathLen >= 2) n.pathIdx = 1
    skirtFire(n)
  }

  /** Nobody walks through the fire: a last stretch that would cross it bends round the side it already leans to. */
  function skirtFire(n: Npc) {
    const direct = n.pathLen < 2
    const last = n.pathLen - 1
    const ax = direct ? n.x : n.path[(last - 1) * 2]
    const az = direct ? n.z : n.path[(last - 1) * 2 + 1]
    const bx = direct ? n.goalX : n.path[last * 2]
    const bz = direct ? n.goalZ : n.path[last * 2 + 1]
    const abx = bx - ax
    const abz = bz - az
    const l2 = abx * abx + abz * abz
    if (l2 < 0.01) return
    const t = ((fire.x - ax) * abx + (fire.z - az) * abz) / l2
    if (t <= 0 || t >= 1) return
    let ox = ax + abx * t - fire.x
    let oz = az + abz * t - fire.z
    if (Math.hypot(ox, oz) >= FIRE_CLEAR) return
    if (Math.hypot(ox, oz) < 0.05) {
      // Straight through the middle: round by the left
      ox = -abz
      oz = abx
    }
    const l = Math.hypot(ox, oz) || 1
    const wx = fire.x + (ox / l) * FIRE_ROUND
    const wz = fire.z + (oz / l) * FIRE_ROUND
    if (direct) {
      // A corner this close to the fire is walked, not cut
      n.wpR = 0.7
      n.path[0] = ax
      n.path[1] = az
      n.path[2] = wx
      n.path[3] = wz
      n.path[4] = bx
      n.path[5] = bz
      n.pathLen = 3
      n.pathIdx = 1
    } else if ((n.pathLen + 1) * 2 <= n.path.length) {
      n.path[(last + 1) * 2] = bx
      n.path[(last + 1) * 2 + 1] = bz
      n.path[last * 2] = wx
      n.path[last * 2 + 1] = wz
      n.pathLen++
    }
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
    n.wpR = 1.6
    n.goalX = pts[(count - 1) * 2]
    n.goalZ = pts[(count - 1) * 2 + 1]
    n.hasGoal = true
    n.arrived = false
    n.blocked = false
    n.goalEdge = false
    n.arriveR = 1.0
    n.want = speed
    n.cruise = speed
    n.replans = 0
    n.stuckT = 0
    n.lastGoalDist = Infinity
  }

  /** Head straight for a point that moves (the player, a standoff spot): no route. */
  function steerTo(n: Npc, x: number, z: number, speed: number, arriveR = 0.6) {
    if (n.id === 'oru' && speed > OLD_PACE) speed = OLD_PACE
    n.goalX = x
    n.goalZ = z
    n.pathLen = 0
    n.pathIdx = 0
    n.wpR = 1.6
    n.hasGoal = true
    n.goalEdge = false
    n.arriveR = arriveR
    n.want = speed
    n.cruise = speed
    if (Math.hypot(x - n.x, z - n.z) > arriveR) {
      n.arrived = false
      n.blocked = false
    }
  }

  /** Turn the body to a point (once they are standing). */
  function face(n: Npc, x: number, z: number) {
    if (Math.abs(x - n.x) + Math.abs(z - n.z) > 0.05) n.faceYaw = Math.atan2(-(x - n.x), -(z - n.z))
    n.hasFace = true
  }

  function faceDir(n: Npc, yaw: number) {
    n.faceYaw = yaw
    n.hasFace = true
  }

  /**
   * Turn to face a point the way a person does: not while it has only drifted
   * a little off (the head covers that), and after a beat rather than at once.
   * Once the feet do move they bring the body square.
   */
  function faceLazy(n: Npc, x: number, z: number, dead: number, lag: number) {
    n.hasFace = true
    const want = Math.atan2(-(x - n.x), -(z - n.z))
    const err = Math.abs(angleDelta(n.yaw, want))
    if (n.turning) {
      n.faceYaw = want
      if (err < 0.07) n.turning = false
      return
    }
    n.faceYaw = n.yaw
    if (err > dead) {
      n.faceWait += frameDt
      if (n.faceWait >= lag) {
        n.faceWait = 0
        n.turning = true
        n.faceYaw = want
      }
    } else n.faceWait = Math.max(0, n.faceWait - frameDt)
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
    const T = TEMPER[n.id]
    const hHere = ground(n.x, n.z)
    let wantSpeed = 0
    let wantYaw = n.yaw
    let steering = false
    if (n.hasGoal && !n.arrived) {
      waypoint(n, wp)
      let d = Math.hypot(wp.x - n.x, wp.z - n.z)
      while (n.pathLen >= 2 && n.pathIdx < n.pathLen - 1 && d < n.wpR) {
        n.pathIdx++
        waypoint(n, wp)
        d = Math.hypot(wp.x - n.x, wp.z - n.z)
      }
      const goalD = Math.hypot(n.goalX - n.x, n.goalZ - n.z)
      if (goalD < n.arriveR) {
        n.arrived = true
      } else if (n.want > 0.01) {
        steering = true
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
    // Standing (arrived, or paused on the way): the body comes round to whatever it was asked to face
    if (!steering && n.hasFace) wantYaw = n.faceYaw
    const turnLeft = Math.abs(angleDelta(n.yaw, wantYaw))
    if (n.speed < 0.05) n.stillT += dt
    else n.stillT = 0

    let holdYaw = false
    if (steering && wantSpeed > 0) {
      if (n.urgent) {
        // A chase: no beat, no turning on the spot first
        n.going = true
        n.pivot = false
        n.setOffT = 0
        wantSpeed *= clamp(1.2 - turnLeft / 1.4, 0.15, 1)
      } else {
        if (!n.going) {
          // The beat between deciding to go and going; the eyes get there first
          n.going = true
          n.setOffT = n.stillT > 0.6 ? rnd(n, T.setOffLo, T.setOffHi) : 0
        }
        if (n.setOffT > 0) {
          n.setOffT -= dt
          wantSpeed = 0
          holdYaw = true
        } else {
          // From a standstill they turn most of the way before the first step; on the move they slow into a sharp turn
          if (n.speed < 0.25 && turnLeft > 0.75) n.pivot = true
          else if (turnLeft < 0.3) n.pivot = false
          if (n.pivot) wantSpeed = 0
          else wantSpeed *= clamp(1.25 - turnLeft / 1.3, 0.3, 1)
        }
      }
    } else {
      n.going = false
      n.pivot = false
      n.setOffT = 0
    }
    // The eyes lead a turn: toward where they are about to walk
    if (steering && !n.urgent && (holdYaw || n.pivot) && turnLeft > 0.35) lookDir(n, 'the way ahead', wantYaw, 0, 0)

    // Slower in water, and on steep ground (a chase is not slowed by the slope: how fast he comes is Kael's own rule)
    const waterSlow = n.swim > 0.5 ? SWIM / Math.max(n.want, 0.1) : 1 - 0.45 * n.wade
    wantSpeed *= Math.min(1, waterSlow)
    if (!n.urgent) wantSpeed *= 1 - 0.4 * clamp(Math.abs(n.slope) / 0.7, 0, 1)
    // Speed and heading both ease: neither the pace nor the rate of turn ever jumps
    const quickening = wantSpeed > n.speed
    n.speed = smoothDamp(n.speed, wantSpeed, n.accel, quickening ? (n.urgent ? 0.3 : T.startT) : n.urgent ? 0.22 : T.stopT, 14, dt)
    n.accel = sdRate
    if (n.speed < 0 || (wantSpeed <= 0 && n.speed < 0.02)) {
      n.speed = 0
      n.accel = 0
    }
    const seated = n.pose === 'sit_fire'
    const maxTurn = n.urgent ? (n.speed > 2.5 ? 5 : 3.6) : seated ? 0.7 : n.speed > 0.3 ? T.turn * 0.85 : T.turn
    n.yaw = smoothDampAngle(n.yaw, holdYaw ? n.yaw : wantYaw, n.yawVel, n.urgent ? 0.16 : seated ? 0.7 : T.turnT, maxTurn, dt)
    n.yawVel = sdRate
    n.turnRate = n.yawVel

    let covered = 0
    if (n.speed > 0.01) {
      const nx = n.x - Math.sin(n.yaw) * n.speed * dt
      const nz = n.z - Math.cos(n.yaw) * n.speed * dt
      const h = ground(nx, nz)
      const wet = n.cls === 'wade' && h < W.tide + 0.1
      const fireD = Math.hypot(nx - fire.x, nz - fire.z)
      const intoFire = fireD < FIRE_CLEAR - 0.05 && fireD < Math.hypot(n.x - fire.x, n.z - fire.z)
      if (!intoFire && !(nav.hasRock && solidAt(nx, nz)) && h >= minGroundFor(n) && (wet || Math.abs(h - hHere) <= MAX_RISE * Math.max(0.05, n.speed * dt) + 0.02)) {
        n.x = nx
        n.z = nz
        covered = n.speed
      } else {
        // The legs are never told a pace the ground did not give
        n.speed = 0
        n.accel = 0
      }
    }
    n.gspeed = covered
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

  // —— the eyes ——————————————————————————————————————————————
  //
  // Each frame the behaviour says what an islander wants to look at, if
  // anything; the highest claim wins. The gaze then travels there at that
  // person's own pace and the head follows it, so nobody's head snaps, and
  // the body is only asked to turn after the eyes have got there.

  /** Standing eye height, which is what the body measures a look from. */
  const eyeOf = (n: Npc) => n.y + n.rig.height * 0.92

  function lookTo(n: Npc, kind: string, x: number, y: number, z: number, pri = 0) {
    if (pri < n.lkPri) return
    n.lk = kind
    n.lkx = x
    n.lky = y
    n.lkz = z
    n.lkPri = pri
  }

  function lookPlayer(n: Npc, pri = 2) {
    lookTo(n, 'you', playerHead.x, playerHead.y, playerHead.z, pri)
  }

  /** Look along a bearing, out to the horizon: pitch up for the sky, down for the ground at their feet. */
  function lookDir(n: Npc, kind: string, yaw: number, pitch: number, pri = 0) {
    const c = Math.cos(pitch)
    lookTo(n, kind, n.x - Math.sin(yaw) * c * 30, eyeOf(n) + Math.sin(pitch) * 30, n.z - Math.cos(yaw) * c * 30, pri)
  }

  /** A slow sweep of the eyes across a bearing: `half` either side, one pass in `period` seconds. */
  function sweepLook(n: Npc, kind: string, centre: number, half: number, period: number, pitch = 0) {
    lookDir(n, kind, centre + half * Math.sin((TAU * n.stepAge) / period + n.sweep), pitch)
  }

  /** A look that lasts a while: at the player (who -1), another islander (their index) or a fixed point (-2). */
  function glance(n: Npc, kind: string, who: number, delay: number, hold: number, pri: number, x = 0, y = 0, z = 0) {
    const g = n.gl
    if (now < g.until && g.pri > pri) return
    g.kind = kind
    g.who = who
    g.x = x
    g.y = y
    g.z = z
    g.from = now + delay
    g.until = now + delay + hold
    g.pri = pri
  }

  function glancing(n: Npc) {
    return now >= n.gl.from && now < n.gl.until
  }

  function applyGlance(n: Npc) {
    const g = n.gl
    if (now < g.from || now >= g.until) return
    if (g.who === -1) lookTo(n, g.kind, playerHead.x, playerHead.y, playerHead.z, g.pri)
    else if (g.who >= 0) {
      const o = npcs[g.who]
      lookTo(n, g.kind, o.x, o.y + o.rig.height * (o.pose === 'sit_fire' ? 0.5 : 0.9), o.z, g.pri)
    } else lookTo(n, g.kind, g.x, g.y, g.z, g.pri)
  }

  function updateGaze(n: Npc, dt: number) {
    const T = TEMPER[n.id]
    const has = n.lk !== ''
    if (!n.gazeOn) {
      if (!has) {
        n.rig.lookAt(null)
        return
      }
      n.gazeOn = true
      n.gazeYaw = n.yaw
      n.gazePitch = 0
      n.gazeYV = 0
      n.gazePV = 0
    }
    let wantYaw = n.yaw
    let wantPitch = 0
    if (has) {
      const dx = n.lkx - n.x
      const dz = n.lkz - n.z
      const flat = Math.hypot(dx, dz)
      if (flat > 0.05) {
        // A neck only turns so far: past that, as far round as it goes
        wantYaw = n.yaw + clamp(angleDelta(n.yaw, Math.atan2(-dx, -dz)), -1.45, 1.45)
        // Seated eyes are lower, so the same thing is further up
        const eye = n.y + n.rig.height * (n.pose === 'sit_fire' ? 0.5 : 0.92)
        wantPitch = clamp(Math.atan2(n.lky - eye, flat), -0.7, 0.6)
      }
    }
    n.gazeYaw = smoothDampAngle(n.gazeYaw, wantYaw, n.gazeYV, T.gazeT, T.gazeMax, dt)
    n.gazeYV = sdRate
    n.gazePitch = smoothDamp(n.gazePitch, wantPitch, n.gazePV, T.gazeT, T.gazeMax * 0.7, dt)
    n.gazePV = sdRate
    const off = angleDelta(n.yaw, n.gazeYaw)
    if (!has && Math.abs(off) < 0.012 && Math.abs(n.gazePitch) < 0.012) {
      n.gazeOn = false
      n.rig.lookAt(null)
      return
    }
    // A body that turns faster than the eyes let go carries them with it
    if (Math.abs(off) > 1.5) n.gazeYaw = n.yaw + clamp(off, -1.5, 1.5)
    const c = Math.cos(n.gazePitch)
    n.lookPt.set(n.x - Math.sin(n.gazeYaw) * c * 6, eyeOf(n) + Math.sin(n.gazePitch) * 6, n.z - Math.cos(n.gazeYaw) * c * 6)
    n.rig.lookAt(n.lookPt)
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
      n.said.far = false
      n.said.gave = false
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
  //
  // Where each of them is by day, by night and in a squall is unchanged. What
  // is new is the life inside each place: a handful of small things done one
  // after another, each for a seeded while, so no two minutes look the same
  // and no two people keep time.

  function setStep(n: Npc, step: number, time: number) {
    n.step = step
    n.stepT = time
    n.stepAge = 0
  }

  function setActivity(n: Npc, kind: Activity['kind'], timer = 0, sub = 0) {
    n.act.kind = kind
    n.act.timer = timer
    n.act.sub = sub
    setStep(n, 0, 0)
  }

  /** Each has their own hour for going in to the fire: the girl as the light goes, the guard last. All of them in a squall. */
  function wantsCamp(n: Npc) {
    if (stormy) return true
    const p = W.dayPhase
    if (n.id === 'tala') return p < 0.25 || p > 0.745
    if (n.id === 'kael') return p < 0.235 || p > 0.775
    return p < 0.24 || p > 0.82
  }

  /** The bearing out to sea from a point, and back up into the trees. */
  const seaYaw = (x: number, z: number) => Math.atan2(-(x - island.centre.x), -(z - island.centre.z))
  const yawTo = (n: Npc, x: number, z: number) => Math.atan2(-(x - n.x), -(z - n.z))

  function schedule(n: Npc, dt: number) {
    n.reach = 0
    n.act.timer -= dt
    n.stepT -= dt
    n.stepAge += dt
    // A walk the schedule paused comes back to its own pace, unless this frame pauses it again
    if (n.hasGoal && !n.arrived) n.want = n.cruise
    if (n.id === 'kael') scheduleKael(n)
    else if (n.id === 'tala') scheduleTala(n)
    else campLife(n, oruSeat, oruTend, poolSpot, ELDER, npcs[1])
  }

  // —— Kael's round ——

  function scheduleKael(n: Npc) {
    if (n.camp) {
      kaelPost(n)
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
      setActivity(n, 'patrol', rnd(n, 12, 24))
      n.act.index = bi
      goTo(n, patrol[bi].x, patrol[bi].z, PATROL, false, 1.2)
    }
    const here = patrol[n.act.index]
    if (n.act.kind === 'patrol') {
      n.pose = 'patrol'
      if (n.arrived) {
        // A lookout. What he does at it is drawn fresh each time.
        setActivity(n, 'dwell', 0)
        n.plan = (n.rng() < 0.65 ? 1 : 0) | (n.rng() < 0.5 ? 2 : 0)
        n.sweep = rnd(n, 0, TAU)
        setStep(n, 0, rnd(n, 0.8, 1.6))
        face(n, here.fx, here.fz)
        n.doing = 'come to a lookout'
        return
      }
      if (n.step === 1) {
        // Stopped on the path to look at something, feet where they were
        pause(n)
        n.hasFace = false
        n.pose = 'watch_suspicious'
        n.doing = 'stop on the path and look'
        sweepLook(n, 'far off', n.aim, 0.3, 6)
        if (n.stepT <= 0) {
          setStep(n, 0, 0)
          n.act.timer = rnd(n, 14, 26)
        }
      } else {
        n.doing = 'walk the round'
        if (n.act.timer <= 0 && n.speed > 0.6 && Math.hypot(n.goalX - n.x, n.goalZ - n.z) > 9) {
          setStep(n, 1, rnd(n, 2.5, 5))
          // Out to sea, or back up into the trees
          n.aim = seaYaw(n.x, n.z) + (n.rng() < 0.6 ? 0 : Math.PI) + rnd(n, -0.5, 0.5)
          n.sweep = rnd(n, 0, TAU)
        }
      }
      return
    }
    // At a lookout: the sea, then perhaps the tree line, then perhaps a listen, then on
    const out = Math.atan2(-(here.fx - n.x), -(here.fz - n.z))
    switch (n.step) {
      case 0:
        face(n, here.fx, here.fz)
        n.pose = 'patrol'
        n.doing = 'come to a lookout'
        if (n.stepT <= 0) setStep(n, 1, rnd(n, 5, 9))
        return
      case 1:
        face(n, here.fx, here.fz)
        n.pose = 'watch_suspicious'
        n.doing = 'scan the water'
        sweepLook(n, 'the water', out, 0.8, 8.5)
        if (n.stepT <= 0) {
          if (n.plan & 1) {
            n.aim = seaYaw(n.x, n.z) + Math.PI + rnd(n, -0.6, 0.6)
            n.sweep = rnd(n, 0, TAU)
            setStep(n, 2, rnd(n, 4.5, 7.5))
          } else if (n.plan & 2) setStep(n, 3, rnd(n, 2.5, 4.5))
          else setStep(n, 4, rnd(n, 0.5, 0.9))
        }
        return
      case 2:
        faceDir(n, n.aim)
        n.pose = 'watch_suspicious'
        n.doing = 'scan the tree line'
        sweepLook(n, 'the tree line', n.aim, 0.55, 7)
        if (n.stepT <= 0) {
          if (n.plan & 2) setStep(n, 3, rnd(n, 2.5, 4.5))
          else setStep(n, 4, rnd(n, 0.5, 0.9))
        }
        return
      case 3:
        // Quite still, head a little to one side and down
        n.hasFace = false
        n.pose = 'idle'
        n.doing = 'listen'
        lookDir(n, 'nothing, listening', n.yaw + n.side * 0.6, -0.2)
        if (n.stepT <= 0) {
          n.side = -n.side
          setStep(n, 4, rnd(n, 0.5, 0.9))
        }
        return
      default: {
        // A look down the next leg, then off
        const leg = legs[n.act.index]
        n.hasFace = false
        n.pose = 'patrol'
        n.doing = 'look down the path'
        if (leg && leg.n >= 2) lookTo(n, 'the path', leg.pts[2], eyeOf(n), leg.pts[3])
        if (n.stepT <= 0) {
          n.act.index = (n.act.index + 1) % patrol.length
          setActivity(n, 'patrol', rnd(n, 12, 24))
          if (leg && leg.n >= 2) follow(n, leg.pts, leg.n, PATROL)
          else goTo(n, patrol[n.act.index].x, patrol[n.act.index].z, PATROL, false, 1.2)
        }
      }
    }
  }

  /** Night and weather: Kael stands out along the way in, between the fire and anyone coming. */
  function kaelPost(n: Npc) {
    if (n.act.kind !== 'camp') {
      setActivity(n, 'camp')
      n.spot = 0
      goTo(n, postX, postZ, WALK)
    }
    if (!n.arrived) {
      n.pose = 'patrol'
      n.doing = n.step === 3 ? 'pace the way in' : 'go to his post'
      return
    }
    const outYaw = Math.atan2(-approachX, -approachZ)
    switch (n.step) {
      case 1:
        faceDir(n, outYaw)
        n.pose = 'watch_suspicious'
        n.doing = 'watch the way in'
        sweepLook(n, 'the way in', outYaw, 0.5, 9)
        if (n.stepT <= 0) {
          const r = n.rng()
          if (r < 0.28) setStep(n, 2, rnd(n, 3, 5.5))
          else if (r < 0.52 && postOut.x !== postX) {
            // A few steps along the way in and stand there a while
            n.spot = 1 - n.spot
            const p = n.spot === 1 ? postOut : { x: postX, z: postZ }
            goTo(n, p.x, p.z, PATROL * 0.8, false, 0.6)
            setStep(n, 3, 0)
          } else if (r < 0.76) setStep(n, 4, rnd(n, 3, 5))
          else {
            n.sweep = rnd(n, 0, TAU)
            setStep(n, 1, rnd(n, 6, 12))
          }
        }
        return
      case 2:
        // Round to the fire: are they all in?
        face(n, fire.x, fire.z)
        n.pose = 'idle'
        n.doing = 'look back at the fire'
        lookTo(n, 'the fire', fire.x, fire.y + 0.6, fire.z)
        if (n.stepT <= 0) setStep(n, 1, rnd(n, 7, 14))
        return
      case 4:
        n.hasFace = false
        n.pose = 'idle'
        n.doing = 'listen'
        lookDir(n, 'nothing, listening', n.yaw + n.side * 0.55, -0.15)
        if (n.stepT <= 0) {
          n.side = -n.side
          setStep(n, 1, rnd(n, 7, 14))
        }
        return
      default:
        // Just arrived, or back from a few paces
        faceDir(n, outYaw)
        n.pose = 'watch_suspicious'
        n.doing = 'watch the way in'
        n.sweep = rnd(n, 0, TAU)
        setStep(n, 1, rnd(n, 7, 14))
    }
  }

  // —— Tala's day ——

  function scheduleTala(n: Npc) {
    if (n.act.kind === 'rocks' && (n.camp || !lowTide) && reefGate && Math.hypot(n.x - reefSpots[0].x, n.z - reefSpots[0].z) < 13) {
      // Done on the reef: off it by the same way she came on, clear of the hull
      if (n.step !== R_OFF) {
        goTo(n, reefGate.x, reefGate.z, WALK, true, 2)
        setStep(n, R_OFF, 0)
      }
      if (!n.arrived && !n.blocked && Math.hypot(n.x - reefGate.x, n.z - reefGate.z) > 2.5) {
        n.pose = 'idle'
        n.doing = 'leave the reef'
        return
      }
    }
    if (n.camp) campLife(n, talaSeat, talaTend, talaPool, WALK, npcs[2])
    else if (lowTide) talaReef(n)
    else if (highTide) talaShore(n)
    else talaComb(n)
    // A chin lifted at a wave shows whatever she was doing
    if (now < n.tiltUntil && n.pose === 'idle' && n.speed < 0.2) {
      n.pose = 'curious_tilt'
      n.reach = 0
    }
  }

  const R_GO = 0
  const R_BEND = 1
  const R_RISE = 2
  const R_OUT = 3
  const R_SWIM = 4
  const R_TREAD = 5
  const R_IN = 6
  const R_OFF = 7

  /** Low water: out on the reef crest by the coaster, working it from her feet. */
  function talaReef(n: Npc) {
    const wreck = opts.reefWreckPos
    if (n.act.kind !== 'rocks') {
      setActivity(n, 'rocks')
      n.spot = 0
      n.reps = 1
      if (reefGate && Math.hypot(n.x - reefSpots[0].x, n.z - reefSpots[0].z) > 20) {
        // Out from the beach: round the coaster's stern, not through it
        goTo(n, reefGate.x, reefGate.z, WALK, true, 2)
        setStep(n, R_IN, 0)
      } else {
        goTo(n, reefSpots[0].x, reefSpots[0].z, WALK, true, 1.0)
        setStep(n, R_GO, 0)
      }
    }
    n.pose = 'idle'
    switch (n.step) {
      case R_IN:
      case R_OFF:
        n.doing = n.swim > 0.5 ? 'swim out to the reef' : 'walk out to the reef'
        if (n.arrived || n.blocked) {
          goTo(n, reefSpots[0].x, reefSpots[0].z, WALK * 0.8, true, 0.7)
          setStep(n, R_GO, 0)
        }
        return
      case R_GO:
        n.doing = n.swim > 0.5 ? 'swim' : n.wade > 0.1 ? 'wade to another patch' : 'walk out to the reef'
        if ((n.arrived || n.blocked) && n.speed < 0.12) {
          n.aim = yawTo(n, wreck.x, wreck.z) + rnd(n, -0.7, 0.7)
          setStep(n, R_BEND, rnd(n, 2.6, 5))
        }
        return
      case R_BEND:
        faceDir(n, n.aim)
        n.reach = 1
        n.doing = 'bend to the reef'
        if (n.stepT <= 0) {
          n.plan = n.rng() < 0.45 ? 1 : 0
          setStep(n, R_RISE, n.plan ? rnd(n, 1.6, 2.8) : rnd(n, 0.9, 1.8))
        }
        return
      case R_RISE:
        faceDir(n, n.aim)
        if (n.plan) {
          // Something worth a second look, turned over in her hands
          n.pose = 'curious_tilt'
          n.doing = 'look at what she found'
          lookDir(n, 'her hands', n.yaw, -0.55)
        } else n.doing = 'straighten up'
        if (n.stepT <= 0) {
          if (n.reps > 0) {
            // Another patch within reach: a part turn, and down again
            n.reps--
            n.aim += (n.rng() < 0.5 ? -1 : 1) * rnd(n, 0.4, 0.9)
            setStep(n, R_BEND, rnd(n, 2.4, 4.6))
          } else {
            const r = n.rng()
            n.plan = r < 0.5 ? 0 : r < 0.8 ? 1 : 2
            n.sweep = rnd(n, 0, TAU)
            setStep(n, R_OUT, rnd(n, 3, 6.5))
          }
        }
        return
      case R_OUT:
        // Upright, hands at her sides, looking at something a long way off
        if (n.plan === 1) {
          face(n, wreck.x, wreck.z)
          lookTo(n, 'the wreck', wreck.x, W.tide + 3.2, wreck.z)
          n.doing = 'look up at the wreck'
        } else if (n.plan === 2) {
          face(n, places.landing.x, places.landing.z)
          sweepLook(n, 'the beach', yawTo(n, places.landing.x, places.landing.z), 0.3, 7)
          n.doing = 'look back at the beach'
        } else {
          faceDir(n, seaYaw(n.x, n.z))
          sweepLook(n, 'the sea', seaYaw(n.x, n.z), 0.45, 8)
          n.doing = 'look out to sea'
        }
        if (n.stepT <= 0) reefNext(n)
        return
      case R_SWIM:
        n.doing = 'swim out'
        if (n.arrived || n.blocked) {
          n.sweep = rnd(n, 0, TAU)
          setStep(n, R_TREAD, rnd(n, 3, 6))
        }
        return
      default:
        n.hasFace = false
        n.doing = 'tread water'
        sweepLook(n, 'the sea', n.aim, 0.7, 6)
        if (n.stepT <= 0) {
          const p = reefSpots[n.spot]
          goTo(n, p.x, p.z, WALK, true, 0.7)
          setStep(n, R_GO, 0)
        }
    }
  }

  /** After a look round: a swim now and then, otherwise a few steps along the crest to another patch. */
  function reefNext(n: Npc) {
    const here = reefSpots[n.spot]
    if (reefDeep.length > 0 && now - n.lastSwim > 70 && n.rng() < 0.3) {
      const first = Math.floor(n.rng() * reefDeep.length)
      for (let i = 0; i < reefDeep.length; i++) {
        const p = reefDeep[(first + i) % reefDeep.length]
        if (Math.hypot(p.x - here.x, p.z - here.z) > 9.6 || !reefWay(here.x, here.z, p.x, p.z)) continue
        n.lastSwim = now
        n.aim = seaYaw(p.x, p.z)
        goTo(n, p.x, p.z, WALK, true, 1.0)
        setStep(n, R_SWIM, 0)
        return
      }
    }
    let pick = n.spot
    for (let tries = 0; tries < 6 && pick === n.spot; tries++) {
      const i = Math.floor(n.rng() * reefSpots.length)
      if (i === n.spot) continue
      const p = reefSpots[i]
      // Only where the water is no more than waist deep at this state of the tide
      if (W.tide - ground(p.x, p.z) > 0.98) continue
      if (Math.hypot(p.x - here.x, p.z - here.z) < 9.6 && reefWay(here.x, here.z, p.x, p.z)) pick = i
    }
    n.reps = Math.floor(rnd(n, 0, 2.99))
    if (pick === n.spot) {
      // Nowhere else to stand: a fresh patch where she is
      n.aim += (n.rng() < 0.5 ? -1 : 1) * rnd(n, 0.8, 1.6)
      setStep(n, R_BEND, rnd(n, 2.6, 5))
      return
    }
    n.spot = pick
    goTo(n, reefSpots[pick].x, reefSpots[pick].z, WALK * 0.8, true, 0.7)
    setStep(n, R_GO, 0)
  }

  const tmpPt = { x: 0, z: 0 }
  /** A patch of the same sand a few steps off, for the next handful of shells. */
  function patchNear(n: Npc, out: { x: number; z: number }) {
    const h0 = ground(n.x, n.z)
    for (let i = 0; i < 6; i++) {
      const a = rnd(n, 0, TAU)
      const r = rnd(n, 1.8, 3.8)
      const x = n.x + Math.cos(a) * r
      const z = n.z + Math.sin(a) * r
      const k = nav.cellAt(x, z)
      if (k < 0 || !nav.reach[k]) continue
      const h = ground(x, z)
      if (h < 0.5 || h > 2.4 || Math.abs(h - h0) > r * 0.45) continue
      out.x = x
      out.z = z
      return true
    }
    return false
  }

  /** Between tides: beachcombing along the cove. */
  function talaComb(n: Npc) {
    if (n.act.kind !== 'comb') {
      setActivity(n, 'comb')
      n.act.index = Math.floor(n.rng() * combPoints.length)
      n.reps = 1
      const p = combPoints[n.act.index]
      goTo(n, p.x, p.z, WALK * 0.8, false, 0.8)
      setStep(n, R_GO, 0)
    }
    n.pose = 'idle'
    switch (n.step) {
      case R_GO:
        n.doing = 'walk the tideline'
        if ((n.arrived || n.blocked) && n.speed < 0.12) setStep(n, R_BEND, rnd(n, 2.6, 5))
        return
      case R_BEND:
        n.hasFace = false
        n.reach = 1
        n.doing = 'pick along the tideline'
        if (n.stepT <= 0) {
          n.plan = n.rng() < 0.4 ? 1 : 0
          setStep(n, R_RISE, n.plan ? rnd(n, 1.6, 2.8) : rnd(n, 0.9, 1.8))
        }
        return
      case R_RISE:
        n.hasFace = false
        if (n.plan) {
          n.pose = 'curious_tilt'
          n.doing = 'look at what she found'
          lookDir(n, 'her hands', n.yaw, -0.55)
        } else n.doing = 'straighten up'
        if (n.stepT <= 0) {
          if (n.reps > 0 && patchNear(n, tmpPt)) {
            n.reps--
            goTo(n, tmpPt.x, tmpPt.z, WALK * 0.6, false, 0.5)
            setStep(n, R_GO, 0)
          } else {
            n.plan = n.rng() < 0.7 ? 0 : 1
            n.sweep = rnd(n, 0, TAU)
            setStep(n, R_OUT, rnd(n, 3, 6))
          }
        }
        return
      default: {
        // A look out over the water, or along the sand toward the stranded coaster
        const yaw = n.plan === 0 ? seaYaw(n.x, n.z) : yawTo(n, opts.reefWreckPos.x, opts.reefWreckPos.z)
        faceDir(n, yaw)
        sweepLook(n, n.plan === 0 ? 'the sea' : 'the wreck', yaw, 0.4, 8)
        n.doing = n.plan === 0 ? 'look out to sea' : 'look along to the wreck'
        if (n.stepT <= 0) {
          // On to one of the three nearest other patches, not the length of the beach
          const want = Math.floor(n.rng() * 3)
          let last = -1
          let pick = n.act.index
          for (let k = 0; k <= want; k++) {
            let best = -1
            let bestD = Infinity
            const lastD = last < 0 ? -1 : Math.hypot(combPoints[last].x - n.x, combPoints[last].z - n.z)
            for (let i = 0; i < combPoints.length; i++) {
              if (i === n.act.index) continue
              const d = Math.hypot(combPoints[i].x - n.x, combPoints[i].z - n.z)
              if (d > lastD && d < bestD) {
                bestD = d
                best = i
              }
            }
            if (best < 0) break
            last = best
            pick = best
          }
          n.act.index = pick
          n.reps = Math.floor(rnd(n, 0, 2.99))
          goTo(n, combPoints[pick].x, combPoints[pick].z, WALK * 0.8, false, 0.8)
          setStep(n, R_GO, 0)
        }
      }
    }
  }

  /** High water: sitting on the shore nearest the caves, watching the water over them, and now and then down to its edge. */
  function talaShore(n: Npc) {
    const mouth = places.cavesMouth
    if (n.act.kind !== 'shore') {
      setActivity(n, 'shore', rnd(n, 25, 50))
      goTo(n, cavesShore.x, cavesShore.z, WALK, false, 0.8)
    }
    n.pose = 'idle'
    switch (n.step) {
      case 0:
        n.doing = 'walk to the shore by the caves'
        if (n.arrived || n.blocked) {
          n.sweep = rnd(n, 0, TAU)
          setStep(n, 1, rnd(n, 6, 12))
        }
        return
      case 1:
        face(n, mouth.x, mouth.z)
        n.pose = 'sit_fire'
        n.doing = 'sit and watch the water'
        if (n.stepAge > 2) sweepLook(n, 'the water', yawTo(n, mouth.x, mouth.z), 0.5, 11, -0.1)
        if (n.act.timer <= 0) setStep(n, 3, rnd(n, 1.2, 1.6))
        else if (n.stepT <= 0) {
          if (n.rng() < 0.4) {
            n.aim = seaYaw(n.x, n.z) + rnd(n, -0.9, 0.9)
            n.plan = n.rng() < 0.5 ? 1 : 0
            setStep(n, 2, rnd(n, 3, 6))
          } else {
            n.sweep = rnd(n, 0, TAU)
            setStep(n, 1, rnd(n, 6, 12))
          }
        }
        return
      case 2:
        face(n, mouth.x, mouth.z)
        n.pose = 'sit_fire'
        n.doing = n.plan ? 'look at the sky' : 'look along the shore'
        lookDir(n, n.plan ? 'the sky' : 'the shore', n.aim, n.plan ? 0.5 : 0)
        if (n.stepT <= 0) setStep(n, 1, rnd(n, 6, 12))
        return
      case 3:
        face(n, mouth.x, mouth.z)
        n.doing = 'get up'
        if (n.stepT <= 0) {
          goTo(n, cavesEdge.x, cavesEdge.z, WALK * 0.7, true, 0.6)
          setStep(n, 4, 0)
        }
        return
      case 4:
        n.doing = 'go down to the water'
        if (n.arrived || n.blocked) setStep(n, 5, rnd(n, 4.5, 7))
        return
      case 5:
        face(n, mouth.x, mouth.z)
        n.reach = n.stepAge > 0.8 && n.stepAge < 3.2 ? 0.7 : 0
        n.doing = n.reach > 0 ? 'put a hand in the water' : 'stand at the edge'
        if (n.reach === 0) sweepLook(n, 'the water', yawTo(n, mouth.x, mouth.z), 0.4, 7, -0.08)
        if (n.stepT <= 0) {
          goTo(n, cavesShore.x, cavesShore.z, WALK * 0.7, false, 0.8)
          setStep(n, 6, 0)
        }
        return
      default:
        n.doing = 'walk back up the sand'
        if (n.arrived || n.blocked) {
          n.act.timer = rnd(n, 25, 50)
          n.sweep = rnd(n, 0, TAU)
          setStep(n, 1, rnd(n, 6, 12))
        }
    }
  }

  // —— by the fire ——

  const S_REST = 0
  const S_TEND = 1
  const S_SKY = 2
  const S_PATH = 3
  const S_SHIFT = 4
  const S_OTHER = 5
  const S_RISE = 6

  const seatedNow = (n: Npc) => n.act.kind === 'seat' || n.act.kind === 'camp'

  /**
   * Sitting by the fire, and the errands that get someone up from it: the
   * pool, the fire itself, a look at the sky. It is the old man's whole day
   * and everyone's night. Nothing here goes further than four metres from
   * the fire, and all of it on the open side toward the pool and the way in.
   */
  function campLife(n: Npc, seat: { x: number; z: number }, tendAt: { x: number; z: number }, poolAt: { x: number; z: number }, speed: number, other: Npc) {
    const elder = n.id === 'oru'
    const home: Activity['kind'] = elder && !n.camp ? 'seat' : 'camp'
    const fireYaw = Math.atan2(-(fire.x - seat.x), -(fire.z - seat.z))
    const pace = elder ? speed : speed * 0.7
    switch (n.act.kind) {
      case 'seat':
      case 'camp': {
        n.act.kind = home
        if (!n.arrived) {
          n.pose = 'idle'
          n.doing = 'come in to the fire'
          return
        }
        if (n.step === S_RISE) {
          faceDir(n, fireYaw)
          n.pose = 'idle'
          n.doing = 'get up'
          if (n.stepT <= 0) campErrand(n, tendAt, poolAt, pace)
          return
        }
        n.pose = 'sit_fire'
        faceDir(n, fireYaw + n.seatOff)
        if (n.stepT <= 0) seatedNext(n, other)
        switch (n.step) {
          case S_TEND:
            n.reach = 0.42
            n.doing = 'lean in to the fire'
            break
          case S_SKY:
            lookDir(n, 'the sky', n.aim, 0.5)
            n.doing = 'look at the sky'
            break
          case S_PATH:
            lookDir(n, 'the way in', n.aim, 0)
            n.doing = 'look down the way in'
            break
          case S_OTHER:
            lookTo(n, elder ? 'the girl' : 'the old man', other.x, other.y + other.rig.height * (other.pose === 'sit_fire' ? 0.5 : 0.9), other.z)
            n.doing = elder ? 'look across at the girl' : 'look across at the old man'
            break
          case S_SHIFT:
            n.doing = 'shift where they sit'
            break
          default:
            n.doing = 'sit by the fire'
        }
        // Time to get up for something, one of them at a time
        if ((n.act.timer <= 0 || n.forceTend) && n.step === S_REST && n.stepAge > 1 && (seatedNow(other) || Math.hypot(other.x - n.x, other.z - n.z) > 14)) {
          setStep(n, S_RISE, rnd(n, 1.2, 1.7))
        }
        return
      }
      case 'pool':
        n.pose = 'idle'
        switch (n.step) {
          case 0:
            n.doing = 'walk to the pool'
            if (n.arrived || n.blocked) setStep(n, 1, rnd(n, 1.5, 3))
            return
          case 1:
            face(n, places.campPool.x, places.campPool.z)
            lookTo(n, 'the pool', places.campPool.x, places.campPool.y, places.campPool.z)
            n.doing = 'stand at the pool'
            if (n.stepT <= 0) setStep(n, 2, rnd(n, 3.5, 5.5))
            return
          case 2:
            face(n, places.campPool.x, places.campPool.z)
            n.reach = 0.75
            n.doing = 'bend to the water'
            if (n.stepT <= 0) {
              n.plan = n.rng() < 0.5 ? 1 : 0
              n.aim = n.plan ? seaYaw(n.x, n.z) + rnd(n, -0.6, 0.6) : Math.atan2(-approachX, -approachZ) + rnd(n, -0.3, 0.3)
              setStep(n, 3, rnd(n, 2.5, 4.5))
            }
            return
          default:
            n.hasFace = false
            lookDir(n, n.plan ? 'the sky' : 'the way in', n.aim, n.plan ? 0.45 : 0)
            n.doing = n.plan ? 'look at the sky' : 'look down the way in'
            if (n.stepT <= 0) campBack(n, seat, pace)
        }
        return
      case 'tend':
        n.pose = 'idle'
        switch (n.step) {
          case 0:
            n.doing = 'step round to the fire'
            if (n.arrived || n.blocked) setStep(n, 1, rnd(n, 3, 5.5))
            return
          case 1:
          case 3:
            face(n, fire.x, fire.z)
            n.reach = 0.7
            n.doing = 'feed the fire'
            if (n.stepT <= 0) {
              if (n.step === 1) setStep(n, 2, rnd(n, 1.5, 3))
              else campBack(n, seat, pace)
            }
            return
          default:
            face(n, fire.x, fire.z)
            lookTo(n, 'the fire', fire.x, fire.y + 0.5, fire.z)
            n.doing = 'watch it catch'
            if (n.stepT <= 0) {
              if (n.rng() < 0.5) setStep(n, 3, rnd(n, 2.5, 4))
              else campBack(n, seat, pace)
            }
        }
        return
      case 'weather':
        n.pose = 'idle'
        switch (n.step) {
          case 0:
            n.doing = 'walk out from the fire'
            if (n.arrived || n.blocked) {
              n.aim = seaYaw(n.x, n.z)
              n.sweep = rnd(n, 0, TAU)
              setStep(n, 1, rnd(n, 5, 9))
            }
            return
          case 1:
            faceDir(n, n.aim)
            sweepLook(n, 'the sky', n.aim, 0.5, 9, 0.5)
            n.doing = 'read the sky'
            if (n.stepT <= 0) setStep(n, 2, rnd(n, 2.5, 4.5))
            return
          default:
            n.hasFace = false
            lookDir(n, 'the way in', Math.atan2(-approachX, -approachZ), 0)
            n.doing = 'look down the way in'
            if (n.stepT <= 0) campBack(n, seat, pace)
        }
        return
      case 'back':
        n.pose = 'idle'
        if (n.step === 0) {
          n.doing = 'walk back to their place'
          if (n.arrived || n.blocked) setStep(n, 1, rnd(n, 0.5, 1))
          return
        }
        faceDir(n, fireYaw)
        n.doing = 'sit down'
        if (n.stepT <= 0) {
          setActivity(n, home, elder ? (n.camp ? rnd(n, 60, 130) : rnd(n, 45, 100)) : rnd(n, 55, 120))
          setStep(n, S_REST, rnd(n, 4, 9))
        }
        return
      default:
        // Coming in from wherever the day had them; quicker with rain on the way
        setActivity(n, home, elder ? rnd(n, 30, 80) : rnd(n, 40, 90))
        goTo(n, seat.x, seat.z, stormy && !elder ? speed * 1.15 : speed, false, 0.5)
        setStep(n, S_REST, rnd(n, 3, 7))
    }
  }

  /** The next small thing a seated islander does. Rest comes between any two others. */
  function seatedNext(n: Npc, other: Npc) {
    const elder = n.id === 'oru'
    if (n.step !== S_REST) {
      setStep(n, S_REST, elder ? rnd(n, 5, 11) : rnd(n, 4, 9))
      return
    }
    const near = other.visible && Math.hypot(other.x - n.x, other.z - n.z) < 9
    // With nobody across the fire to look at, that share of the time goes to the fire and the way in
    let r = n.rng()
    if (!near && r >= 0.78) r = (r - 0.78) * 2.5
    if (r < 0.24) setStep(n, S_TEND, rnd(n, 3, 5.5))
    else if (r < 0.44) {
      n.aim = seaYaw(n.x, n.z) + rnd(n, -0.8, 0.8)
      setStep(n, S_SKY, elder ? rnd(n, 5, 9) : rnd(n, 3, 5.5))
    } else if (r < 0.62) {
      n.aim = Math.atan2(-approachX, -approachZ) + rnd(n, -0.35, 0.35)
      setStep(n, S_PATH, elder ? rnd(n, 4, 8) : rnd(n, 2.5, 5))
    } else if (r < 0.78) {
      n.seatOff = rnd(n, -0.4, 0.4)
      setStep(n, S_SHIFT, rnd(n, 2, 3.5))
    } else setStep(n, S_OTHER, elder ? rnd(n, 3, 5.5) : rnd(n, 1.5, 3))
  }

  /** Up from the fire for something. What, depends on who, the hour and the weather. */
  function campErrand(n: Npc, tendAt: { x: number; z: number }, poolAt: { x: number; z: number }, pace: number) {
    const r = n.rng()
    let kind: 'pool' | 'tend' | 'weather'
    if (n.forceTend) kind = 'tend'
    else if (n.id !== 'oru') kind = stormy || r < 0.5 ? 'tend' : 'pool'
    else if (stormy) kind = r < 0.65 ? 'tend' : 'weather'
    else if (n.camp) kind = r < 0.55 ? 'tend' : r < 0.85 ? 'weather' : 'pool'
    else kind = r < 0.38 ? 'pool' : r < 0.72 ? 'tend' : 'weather'
    if (n.forceTend && n.visible && n.dist < 35 && n.id === 'oru') {
      whisper(W.storm > 0.3 ? 'The old man looks at the sky a while, then gets up to feed the fire.' : 'The old man builds the fire up against the dark.')
    }
    n.forceTend = false
    const p = kind === 'pool' ? poolAt : kind === 'tend' ? tendAt : skySpot
    setActivity(n, kind)
    goTo(n, p.x, p.z, pace, false, kind === 'tend' ? 0.15 : 0.6)
  }

  function campBack(n: Npc, seat: { x: number; z: number }, pace: number) {
    setActivity(n, 'back')
    goTo(n, seat.x, seat.z, pace, false, 0.5)
  }

  /** Where the schedule has someone right now, for a reset or the first frame. */
  function snapToSchedule(n: Npc) {
    let x = n.x
    let z = n.z
    let fx = fire.x
    let fz = fire.z
    n.camp = wantsCamp(n)
    setActivity(n, 'none')
    if (n.id === 'kael') {
      if (n.camp) {
        x = postX
        z = postZ
        fx = postX + approachX * 20
        fz = postZ + approachZ * 20
        setActivity(n, 'camp')
        n.spot = 0
        n.sweep = rnd(n, 0, TAU)
        setStep(n, 1, rnd(n, 5, 10))
      } else if (patrol.length > 0) {
        const i = Math.floor(W.dayPhase * 20) % patrol.length
        x = patrol[i].x
        z = patrol[i].z
        fx = patrol[i].fx
        fz = patrol[i].fz
        setActivity(n, 'dwell', 0)
        n.act.index = i
        n.plan = (n.rng() < 0.65 ? 1 : 0) | (n.rng() < 0.5 ? 2 : 0)
        n.sweep = rnd(n, 0, TAU)
        setStep(n, 1, rnd(n, 4, 8))
      }
    } else if (n.id === 'tala') {
      if (n.camp) {
        x = talaSeat.x
        z = talaSeat.z
        setActivity(n, 'camp', rnd(n, 40, 90))
        setStep(n, S_REST, rnd(n, 3, 8))
      } else if (lowTide) {
        x = reefSpots[0].x
        z = reefSpots[0].z
        fx = opts.reefWreckPos.x
        fz = opts.reefWreckPos.z
        setActivity(n, 'rocks')
        n.spot = 0
        n.reps = 1
        n.aim = Math.atan2(-(fx - x), -(fz - z))
        setStep(n, R_BEND, rnd(n, 2, 4))
      } else if (highTide) {
        x = cavesShore.x
        z = cavesShore.z
        fx = places.cavesMouth.x
        fz = places.cavesMouth.z
        setActivity(n, 'shore', rnd(n, 25, 50))
        n.sweep = rnd(n, 0, TAU)
        setStep(n, 1, rnd(n, 6, 12))
      } else {
        const i = Math.floor(n.rng() * combPoints.length)
        x = combPoints[i].x
        z = combPoints[i].z
        const f = seaFace(x, z)
        fx = f.x
        fz = f.z
        setActivity(n, 'comb')
        n.act.index = i
        n.reps = 1
        n.plan = 0
        n.sweep = rnd(n, 0, TAU)
        setStep(n, R_OUT, rnd(n, 2, 4))
      }
    } else {
      x = oruSeat.x
      z = oruSeat.z
      setActivity(n, n.camp ? 'camp' : 'seat', rnd(n, 30, 90))
      setStep(n, S_REST, rnd(n, 3, 8))
    }
    n.x = x
    n.z = z
    n.yaw = Math.atan2(-(fx - x), -(fz - z))
    n.faceYaw = n.yaw
    n.hasFace = true
    n.hasGoal = true
    n.goalX = x
    n.goalZ = z
    n.arrived = true
    n.pathLen = 0
    n.speed = 0
    n.want = 0
    n.cruise = 0
    // Nothing of the last moment's motion carries over a jump
    n.accel = 0
    n.yawVel = 0
    n.gspeed = 0
    n.slope = 0
    n.stillT = 10
    n.setOffT = 0
    n.going = false
    n.pivot = false
    n.urgent = false
    n.turning = false
    n.faceWait = 0
    n.seatOff = 0
    n.gazeOn = false
    n.gl.until = -Infinity
    n.lk = ''
    n.lkPri = -1
    n.farT = 0
    n.moveHold = 0
    n.forceTend = false
    n.doing = ''
    settle(n, 0)
    // Land on the right pose without a visible blend
    schedule(n, 0)
    n.rig.setPose(n.pose)
    n.rig.snapPose()
    n.rig.lookAt(null)
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

  /** Begin watching someone: the head goes first, and it is a moment before the feet or the spear do anything. */
  function enterWatch(n: Npc) {
    const T = TEMPER[n.id]
    n.state = 'watch'
    n.stateAt = now
    n.lead = rnd(n, T.leadLo, T.leadHi)
    // How long he looks before the spear comes up: short if they are running at him
    n.readyT = P.speed > 2.0 && n.approach > 1.5 ? 0.45 : rnd(n, 1.1, 1.7)
    n.turning = false
    n.faceWait = 0
    n.checkAt = now + rnd(n, 5, 9)
  }

  function calm(n: Npc) {
    n.state = 'step_back'
    n.stateAt = now
    n.calmUntil = now + 8
    n.chaseGround = false
    // Two and a half metres further off, taken half turned so his eyes never leave them
    const dx = n.x - P.x
    const dz = n.z - P.z
    const l = Math.hypot(dx, dz) || 1
    n.side = n.rng() < 0.5 ? -1 : 1
    n.holdX = n.x + (dx / l) * 2.5 + (-dz / l) * 1.7 * n.side
    n.holdZ = n.z + (dz / l) * 2.5 + (dx / l) * 1.7 * n.side
    whisper("He lowers the spear a hand's width. Not all the way.")
  }

  function thinkKael(n: Npc, dt: number) {
    const d = n.dist
    const escorted = now < escortedUntil && P.held !== 'spear'
    switch (n.state) {
      case 'captured':
        stop(n)
        face(n, n.holdX, n.holdZ)
        n.pose = 'warn_spear_raise'
        n.doing = 'hold you at spear point'
        lookPlayer(n)
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
          enterWatch(n)
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
        n.urgent = true
        n.pose = charging ? 'charge_attack' : 'stalk'
        n.doing = charging ? 'charge' : 'come on, slowly'
        lookPlayer(n)
        return
      }
      default:
        break
    }
    if (n.state === 'edge_hold') {
      stop(n)
      face(n, P.x, P.z)
      n.pose = 'warn_spear_raise'
      n.doing = 'hold at the waterline'
      lookPlayer(n)
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
        enterWatch(n)
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
      lookPlayer(n)
      n.doing = 'warn'
      if (escorted && !spearThreat) {
        calm(n)
        return
      }
      // Plant himself between the player and the camp. Once his feet are down they stay
      // down unless he is well out of place: a man holding a line, not one chasing a point.
      // Out on his rounds, far from the fire, there is no line to hold: he stands where he is.
      const guarding = Math.hypot(n.x - fire.x, n.z - fire.z) < 120
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
        const off = Math.hypot(px - n.x, pz - n.z)
        if (guarding && off < 15 && off > (n.planting ? 1.2 : 3.5) && d > (n.planting ? 5 : 7.5)) {
          n.planting = true
          steerTo(n, px, pz, WALK, 0.8)
        } else if (n.arrived || d <= 5 || !n.planting) {
          n.planting = false
          n.want = 0
        }
      }
      if (n.planting && n.arrived) n.planting = false
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
      if (d > 28 && !P.sacred) enterWatch(n)
      return
    }
    n.planting = false
    if (n.state === 'step_back') {
      // Giving ground: away and a little to one side, half turned, looking back over his shoulder
      goTo(n, n.holdX, n.holdZ, WALK * 0.7, false, 0.5)
      face(n, P.x, P.z)
      n.pose = 'watch_suspicious'
      n.doing = 'give ground'
      lookPlayer(n)
      const since = now - n.stateAt
      if ((since > 2.5 && n.arrived) || since > 5.5) enterWatch(n)
      return
    }
    if (n.state === 'watch') {
      stop(n)
      lookPlayer(n)
      // His eyes are on them at once. The feet come round a beat later, and after that stay square to them.
      const since = now - n.stateAt
      if (since > n.lead) faceLazy(n, P.x, P.z, 0.22, 0.25)
      else n.hasFace = false
      n.pose = 'watch_suspicious'
      n.doing = 'watch you'
      // Now and then his eyes leave them for the ground behind them: is this one alone?
      if (now > n.checkAt && d < 40) {
        n.checkAt = now + rnd(n, 6, 11)
        const b = yawTo(n, P.x, P.z) + (n.rng() < 0.5 ? -1 : 1) * rnd(n, 0.45, 0.8)
        glance(n, 'the ground behind you', -2, 0, rnd(n, 0.8, 1.3), 3, n.x - Math.sin(b) * 30, eyeOf(n), n.z - Math.cos(b) * 30)
      }
      // The spear comes up only once he has looked, and turned to face them
      const squared = n.snap.angle < 0.6 || since > n.readyT + 1.5
      if (noticed && (trespass || spearThreat) && since >= n.readyT && squared) {
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
      if (d < WATCH_RANGE || P.sacred || spearThreat) {
        enterWatch(n)
        if (!n.said.seen) {
          n.said.seen = true
          whisper(n.said.far ? 'He turns to face you square. He does not lower his spear.' : 'A tall man steps out of the trees. He does not lower his spear.')
        }
        return
      }
      // A long way off still: he stops walking and looks, hard, then goes on with his eyes on them
      if (n.farT <= 0 && now >= n.farNext && n.snap.seen) {
        n.farT = rnd(n, 3.5, 6.5)
        n.farNext = now + n.farT + rnd(n, 7, 12)
        n.turning = false
        n.faceWait = 0
        if (!n.said.far) {
          n.said.far = true
          whisper(n.y > P.y + 3 ? 'Up the slope a man has stopped walking. He is looking at you.' : 'A man with a spear has stopped walking. He is looking at you.')
        }
      }
      if (n.farT > 0) {
        n.farT -= dt
        pause(n)
        n.reach = 0
        n.pose = 'watch_suspicious'
        n.doing = 'stop and look at you'
        lookPlayer(n)
        faceLazy(n, P.x, P.z, 0.5, 0.5)
        return
      }
    } else n.farT = 0
    schedule(n, dt)
    if (noticed && d < 60 && (n.snap.seen || n.snap.heard)) lookPlayer(n)
  }

  // —— Tala ——————————————————————————————————————————————————

  /**
   * Someone seen a way off, before anything comes of it: a look, held as long
   * as that person holds one, then back to the work, then another.
   */
  function farLooks(n: Npc, holdLo: number, holdHi: number, gapLo: number, gapHi: number, delay: number) {
    if (!n.snap.seen || n.dist > 60 || now < n.glanceAt) return
    const hold = rnd(n, holdLo, holdHi)
    glance(n, 'you', -1, delay, hold, 2)
    // Closer, or coming on fast, and the looks come oftener
    n.glanceAt = now + delay + hold + rnd(n, gapLo, gapHi) * clamp(n.dist / 30, 0.45, 1.3) * (n.approach > 1 ? 0.6 : 1)
  }

  function thinkTala(n: Npc, dt: number) {
    const d = n.dist
    const noticed = n.alert >= 0.3
    const threat = P.held === 'spear' || (P.speed > 2.0 && n.approach > 1.4 && d < 16)
    const inWater = n.swim > 0.5
    if (n.state === 'wary') {
      const dx = n.x - P.x
      const dz = n.z - P.z
      const l = Math.hypot(dx, dz) || 1
      if (d < 13.5) steerTo(n, P.x + (dx / l) * 14.5, P.z + (dz / l) * 14.5, WALK * 1.2, 0.8)
      else n.want = 0
      face(n, P.x, P.z)
      n.pose = 'watch_suspicious'
      n.doing = 'back away'
      lookPlayer(n)
      if (!threat && now - n.stateAt > 4 && d >= 12) {
        n.state = 'curious'
        n.stateAt = now
        n.moveHold = 1
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
      const since = now - n.stateAt
      const dx = n.x - P.x
      const dz = n.z - P.z
      const l = Math.hypot(dx, dz) || 1
      n.moveHold -= dt
      const still = n.arrived || n.want <= 0
      // Keep six to eleven metres off. She goes round as she goes back, half turned, so she can
      // keep an eye on them; once she has stopped she stays put for a breath before moving again.
      if (d < 5.8 && still && (n.moveHold <= 0 || d < 3.6)) {
        n.side = n.rng() < 0.5 ? -1 : 1
        const c = Math.cos(0.75 * n.side)
        const s = Math.sin(0.75 * n.side)
        n.holdX = P.x + ((dx * c - dz * s) / l) * 9.2
        n.holdZ = P.z + ((dx * s + dz * c) / l) * 9.2
        steerTo(n, n.holdX, n.holdZ, WALK, 0.7)
        n.moveHold = rnd(n, 1.6, 3)
      } else if (d > 11.5 && still && n.approach > -0.5 && n.moveHold <= 0) {
        // They are drifting off: follow a little way, no nearer than nine metres
        n.holdX = P.x + (dx / l) * 9
        n.holdZ = P.z + (dz / l) * 9
        steerTo(n, n.holdX, n.holdZ, WALK * 0.8, 0.7)
        n.moveHold = rnd(n, 2, 4)
      } else if (!still) {
        // On her way: stop early once the gap is right again
        if (d > 8 && d < 10.5 && Math.hypot(n.holdX - n.x, n.holdZ - n.z) < 4) n.want = 0
        else steerTo(n, n.holdX, n.holdZ, n.cruise, 0.7)
      } else n.want = 0
      // Her head is on them first; her feet follow, and only when they have gone well round her
      if (since > n.lead) faceLazy(n, P.x, P.z, 0.45, 0.3)
      else n.hasFace = false
      // Quick looks, not a stare: a second or two on them, then away at nothing, then back
      n.peekT -= dt
      if (n.peekT <= 0) {
        n.peeking = !n.peeking
        n.peekT = n.peeking ? rnd(n, 1.4, 3) : rnd(n, 0.5, 1)
        if (!n.peeking) n.aim = (n.rng() < 0.5 ? -1 : 1) * rnd(n, 0.35, 0.7)
      }
      if (n.peeking || d < 4.5 || n.speed > 0.3 || now - lastGestureAt < 3) lookPlayer(n)
      else lookDir(n, 'away, at nothing', yawTo(n, P.x, P.z) + n.aim, -0.25, 2)
      // Now and then, three seconds of waving you toward the beach, away from Kael's rounds
      if (now > n.beckonAt + 3) n.beckonAt = now + rnd(n, 8, 14)
      const beckoning = now > n.beckonAt
      n.pose = beckoning && n.speed < 0.3 ? 'beckon_follow' : 'curious_tilt'
      n.doing = beckoning && n.speed < 0.3 ? 'wave you along' : n.speed > 0.3 ? 'keep her distance' : 'watch you'
      if (beckoning) lookPlayer(n)
      if (beckoning && n.speed < 0.3 && !n.said.beckon) {
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
      n.lead = rnd(n, TEMPER.tala.leadLo, TEMPER.tala.leadHi)
      n.turning = false
      n.faceWait = 0
      n.moveHold = rnd(n, 0.6, 1.2)
      n.peeking = true
      n.peekT = rnd(n, 1.6, 2.6)
      n.beckonAt = now + rnd(n, 3, 6)
      stop(n)
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
    // Someone a way off: she steals a look, goes back to what she was doing, steals another
    farLooks(n, 0.8, 1.7, 2.5, 5, rnd(n, 0.1, 0.3))
    if (glancing(n) && n.gl.who === -1) {
      // Nobody keeps their head down with a stranger in sight
      n.reach = 0
      if (n.pose === 'idle' && n.speed < 0.2) n.doing = 'steal a look at you'
    }
  }

  // —— Oru ———————————————————————————————————————————————————

  function thinkOru(n: Npc, dt: number) {
    const d = n.dist
    const noticed = n.alert >= 0.3
    if (n.state === 'watch') {
      if (n.alert < 0.12 || d > 30) {
        n.state = 'schedule'
        n.stateAt = now
        // He goes on looking after them a while
        glance(n, 'where you went', -1, 0, rnd(n, 4, 7), 2)
        // Caught on his feet, he picks the day up again from his place by the fire
        if (n.pose !== 'sit_fire') setActivity(n, 'none')
        return
      }
      const since = now - n.stateAt
      // His eyes go to them at once, in their own slow time, and then he keeps looking
      lookPlayer(n)
      if (n.pose === 'sit_fire') {
        // Seated, he stays seated. If they go round behind him he shifts round to them, in his own time
        n.doing = 'watch you from where he sits'
        if (since > n.lead + 1) faceLazy(n, P.x, P.z, 0.95, 1.8)
        else n.hasFace = false
        return
      }
      if (n.moveHold > 0) {
        // Crowded, he gives a pace: a part turn, a step or two on his own feet, and round to them again
        n.moveHold -= dt
        goTo(n, n.holdX, n.holdZ, ELDER * 0.8, false, 0.3)
        face(n, P.x, P.z)
        n.pose = 'watch_suspicious'
        n.doing = 'give you a pace'
        if (n.arrived) n.moveHold = 0
        return
      }
      stop(n)
      if (since > n.lead) faceLazy(n, P.x, P.z, 0.3, 0.7)
      else n.hasFace = false
      n.pose = 'watch_suspicious'
      n.doing = 'stand and watch you'
      if (d < 1.7 && n.approach > 0.1 && !n.said.gave) {
        // Once, and that is all he gives. Never onto the fire or the seats round it.
        n.said.gave = true
        const dx = n.x - P.x
        const dz = n.z - P.z
        const l = Math.hypot(dx, dz) || 1
        const hx = n.x + (dx / l) * 0.9 + (-dz / l) * 0.5 * n.side
        const hz = n.z + (dz / l) * 0.9 + (dx / l) * 0.5 * n.side
        const r = Math.hypot(hx - fire.x, hz - fire.z)
        if ((r > 3.1 || (r > FIRE_ROUND - 0.2 && r < 2.1)) && Math.abs(ground(hx, hz) - ground(n.x, n.z)) < 0.6) {
          n.holdX = hx
          n.holdZ = hz
          n.moveHold = 6
          whisper('The old man gives you one pace of ground, and no more.')
        }
      }
      return
    }
    const atFire = Math.hypot(n.x - fire.x, n.z - fire.z) < 6
    if (noticed && d < 16) {
      enterWatch(n)
      if (!n.said.seen) {
        n.said.seen = true
        whisper(atFire ? 'An old man by the fire looks up, and keeps looking.' : 'An old man leaning on a staff stops and watches you.')
      }
      return
    }
    schedule(n, dt)
    // Further off: he looks up slowly, and for a long time, and goes back to the fire, and looks again
    farLooks(n, 5, 9, 8, 14, rnd(n, 0.8, 1.6))
    if (glancing(n) && n.gl.who === -1) {
      n.reach = 0
      // On his feet he stops where he is to look
      if (n.pose !== 'sit_fire') pause(n)
      n.doing = n.pose === 'sit_fire' ? 'look up at you' : 'stop and look at you'
      if (!n.said.seen && now > n.gl.from + 0.9) {
        n.said.seen = true
        whisper(atFire ? 'An old man by the fire looks up, and keeps looking.' : 'An old man leaning on a staff stops and watches you.')
      }
    }
  }

  // —— the brain's override ——————————————————————————————————

  function lead(n: Npc, ai: Override, gx: number, gz: number, edge: boolean, fx: number, fz: number) {
    if (!ai.planned) {
      ai.planned = true
      goTo(n, gx, gz, LEAD, edge, 1.2)
    }
    if (n.arrived) {
      n.want = 0
      face(n, fx, fz)
      n.pose = 'beckon_follow'
      n.doing = 'wait for you there'
      lookPlayer(n)
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
      n.doing = 'wait for you to catch up'
      lookPlayer(n)
    } else {
      n.want = n.id === 'oru' ? OLD_PACE : LEAD
      n.cruise = n.want
      n.hasFace = false
      n.pose = n.id === 'kael' ? 'patrol' : 'idle'
      n.doing = 'lead the way'
      // A look back over the shoulder every few steps: are they coming?
      if ((now - ai.start) % 4.5 < 1.3) lookPlayer(n)
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
        if (n.alert > 0.3 && n.id !== 'tala') enterWatch(n)
        else {
          n.state = n.alert > 0.3 ? 'curious' : 'schedule'
          n.stateAt = now
          n.moveHold = 1
        }
        setActivity(n, 'none')
      }
      return false
    }
    if (n.state === 'captured') return false
    const since = now - ai.start
    n.doing = ai.action
    if (ai.action !== 'beckon_to_caves' && ai.action !== 'beckon_to_elder' && ai.action !== 'guide_escape') lookPlayer(n)
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

  /** The sky has turned: everyone going about their day looks up at it, each in their own time. */
  function skyTurned() {
    for (const n of npcs) {
      if (!n.visible || n.state !== 'schedule' || n.ai) continue
      const yaw = seaYaw(n.x, n.z) + rnd(n, -0.5, 0.5)
      const delay = n.id === 'tala' ? rnd(n, 0.4, 1.6) : n.id === 'kael' ? rnd(n, 1.5, 3.5) : rnd(n, 3, 5.5)
      const hold = n.id === 'oru' ? rnd(n, 5, 8) : rnd(n, 2.5, 4.5)
      glance(n, 'the sky', -2, delay, hold, 1, n.x - Math.sin(yaw) * 22, eyeOf(n) + 14, n.z - Math.cos(yaw) * 22)
    }
    // And the old man sees to the fire before the rain does
    const oru = npcs[2]
    oru.forceTend = true
  }

  /** People near each other look at each other: at once when one comes in, now and then when they sit together. */
  function social() {
    for (let i = 0; i < 3; i++) {
      const a = npcs[i === 2 ? 1 : 0]
      const b = npcs[i === 0 ? 1 : 2]
      if (!a.visible || !b.visible) continue
      if (Math.hypot(a.x - b.x, a.z - b.z) > 10) {
        pairNear[i] = false
        continue
      }
      const arriving = !pairNear[i]
      pairNear[i] = true
      // Someone beside you staring at a stranger is hard to miss, for as long as they can see or hear the stranger
      // themselves. Not Kael: what he notices, and when, is his own.
      if (a.state !== 'schedule' && (a.snap.seen || a.snap.heard) && b.id !== 'kael' && b.alert < 0.4) b.alert += frameDt * 0.4
      if (b.state !== 'schedule' && (b.snap.seen || b.snap.heard) && a.id !== 'kael' && a.alert < 0.4) a.alert += frameDt * 0.4
      if (now < pairNext[i] && !arriving) continue
      if (a.state !== 'schedule' || b.state !== 'schedule' || a.ai || b.ai) continue
      // Whoever is quicker looks first; the other answers
      const first = a.id === 'oru' ? b : a
      const second = first === a ? b : a
      glance(first, 'each other', second.index, rnd(first, 0.1, 0.5), rnd(first, 1.4, 2.8), 1)
      glance(second, 'each other', first.index, rnd(second, 0.6, 1.4), rnd(second, 2, 4), 1)
      pairNext[i] = now + rnd(a, 16, 34)
    }
  }

  const forward = new THREE.Vector3()

  // —— cues for the sound: read off the state after each think, never fed back ——
  const cueWas = npcs.map((n) => ({ state: n.state as string, pose: n.pose as string, look: false }))

  function cues(n: Npc) {
    const was = cueWas[n.index]
    const on = opts.onCue!
    const st = n.state
    if (st !== was.state) {
      if (st === 'warn') on(n.id, 'warn')
      else if (st === 'stalk' && was.state !== 'charge') on(n.id, 'chase')
      else if (st === 'step_back') on(n.id, 'calm')
      else if (st === 'wary') on(n.id, 'wary')
      else if ((st === 'watch' || st === 'curious') && was.state === 'schedule') on(n.id, 'notice')
      was.state = st
    }
    if (n.pose !== was.pose) {
      if (n.pose === 'laugh_baffled') on(n.id, 'laugh')
      else if (n.pose === 'accept_gift') on(n.id, 'accept')
      was.pose = n.pose
    }
    const look = st === 'schedule' && ((glancing(n) && n.gl.who === -1) || n.farT > 0)
    if (look && !was.look) on(n.id, 'look')
    was.look = look
  }

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
    frameDt = dt
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
    if (W.tidePhase < -0.25) lowTide = true
    else if (W.tidePhase > -0.12) lowTide = false
    if (W.tidePhase > 0.45) highTide = true
    else if (W.tidePhase < 0.32) highTide = false

    if (needSnap) {
      needSnap = false
      stormRising = W.storm > 0.32
      wasLight = W.daylight > 0.5
      for (const n of npcs) snapToSchedule(n)
    }

    // Each has their own hour for going in, and the girl is the first to turn for home
    const tala = npcs[1]
    const talaWasOut = !tala.camp
    for (const n of npcs) n.camp = wantsCamp(n)
    if (!tala.camp) saidHome = false
    else if (talaWasOut && tala.visible && tala.state === 'schedule') {
      const yaw = seaYaw(tala.x, tala.z)
      glance(tala, 'the sky', -2, 0.2, rnd(tala, 2, 3), 1, tala.x - Math.sin(yaw) * 22, eyeOf(tala) + 14, tala.z - Math.cos(yaw) * 22)
      if (!saidHome && tala.dist < 45) {
        saidHome = true
        whisper('The girl straightens, looks at the sky, and takes the path toward the smoke.')
      }
    }
    // The sky turning and the light going are things that happen once, and are noticed
    if (!stormRising && W.storm > 0.32) {
      stormRising = true
      skyTurned()
    } else if (stormRising && W.storm < 0.2) stormRising = false
    const light = W.daylight > 0.5
    if (wasLight && !light && W.dayPhase > 0.5) npcs[2].forceTend = true
    wasLight = light
    social()

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
          n.lk = ''
          n.lkPri = -1
          if (!thinkAi(n) && n.state !== 'captured') schedule(n, 0.5)
        }
        coarseMove(n, dt)
        continue
      }
      if (!wasVisible) {
        // Coming into view: on the ground where the coarse step left them, with nothing carried over from it
        settle(n, 0)
        n.rig.setPose(n.pose)
        n.rig.snapPose()
        n.speed = 0
        n.accel = 0
        n.yawVel = 0
        n.gspeed = 0
        n.slope = 0
        n.faceYaw = n.yaw
        n.gazeOn = false
      }

      perceive(n, dt)
      updateAlert(n, dt)
      proximity(n)
      n.lk = ''
      n.lkPri = -1
      n.urgent = false
      n.doing = ''
      // Bending to something is the schedule's to ask for, frame by frame; nobody stays bent while they watch a stranger
      n.reach = 0
      think(n, dt)
      applyGlance(n)
      if (opts.onCue) cues(n)
      move(n, dt)

      const rig = n.rig
      rig.root.position.set(n.x, n.y, n.z)
      rig.root.rotation.set(0, n.yaw, 0)
      rig.setPose(n.pose)
      updateGaze(n, dt)
      forward.set(-Math.sin(n.yaw), 0, -Math.cos(n.yaw))
      const hAhead = ground(n.x + forward.x * 0.6, n.z + forward.z * 0.6)
      // The slope under the feet, eased so a turn on a hillside does not pop them
      n.slope = damp(n.slope, n.swim > 0.5 ? 0 : (hAhead - ground(n.x, n.z)) / 0.6, 8, dt)
      // Arms come up for balance when someone pushes through water, and drop again when they stand in it
      n.wadeFed = n.wade * (0.3 + 0.7 * smooth01(n.speed / 0.45))
      motion.speed = n.speed
      motion.turnRate = n.turnRate
      motion.wading = n.wadeFed
      motion.slope = n.slope
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
      // A step back is taken away and a little to one side, so the eyes can stay on the player
      tx: n.x + (dx / l) * 3.5 + (-dz / l) * 1.6 * n.side,
      tz: n.z + (dz / l) * 3.5 + (dx / l) * 1.6 * n.side,
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
      clock: now,
      speed: n.speed,
      turnRate: n.turnRate,
      groundSpeed: n.gspeed,
      reach: n.reach,
      looking: n.gazeOn,
      look: n.lk,
      gazeYaw: n.gazeOn ? angleDelta(n.yaw, n.gazeYaw) : 0,
      gazePitch: n.gazeOn ? n.gazePitch : 0,
      doing: n.doing,
      wading: n.wadeFed,
      slope: n.slope,
      swim: n.swim,
      whisper: lastWhisper,
      whisperAt: lastWhisperAt,
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
      n.said.seen = n.said.beckon = n.said.back = n.said.warn = n.said.far = n.said.gave = false
      n.farNext = 0
      n.glanceAt = 0
      n.planting = false
      n.tiltUntil = -Infinity
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
    // Heads turn. Money in the air, a dropped bag or a wave carries a long way; the small
    // gestures only to someone close. Each looks in their own time and for their own while.
    const big = gesture === 'offer_cash' || gesture === 'drop_bag' || gesture === 'wave'
    for (const n of npcs) {
      if (!n.visible || n.state === 'captured' || n.dist > (big ? 30 : 14)) continue
      if (!n.snap.seen && !n.snap.heard && n.dist > 12) continue
      const delay = n.id === 'oru' ? rnd(n, 0.7, 1.3) : n.id === 'tala' ? rnd(n, 0.1, 0.3) : rnd(n, 0.25, 0.5)
      const hold = n.id === 'oru' ? rnd(n, 5, 8) : n.id === 'tala' ? rnd(n, 1.5, 2.6) : rnd(n, 3, 5)
      if (gesture === 'drop_bag') glance(n, 'the bag on the ground', -2, delay, hold, 3, P.x, P.ground + 0.2, P.z)
      else glance(n, gesture === 'offer_cash' ? 'the paper in the air' : 'what you did', -1, delay, hold, 3)
      // A wave gets the girl's chin, lifted: not quite a greeting
      if (n.id === 'tala' && gesture === 'wave') n.tiltUntil = now + delay + 2.2
    }
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
    reefSpots: reefSpots as readonly { x: number; z: number }[],
    reefDeep: reefDeep as readonly { x: number; z: number }[],
    reefGate,
    oruTend,
    talaTend,
    talaPool,
    skySpot,
    kaelPostOut: postOut,
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
