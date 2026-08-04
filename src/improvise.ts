import * as THREE from 'three'
import { DAY_LENGTH } from './climate'
import type { Hud } from './hud'
import type { Interactable, Interactions } from './interact'
import type { PlayerFrame } from './player'
import type { Salvage, StashKind } from './salvage'
import type { SavedBuild, SavedHold, SavedRoof } from './persist'
import { eat, rest, type Vitals } from './survival'
import { sampleOcean, oceanState } from './waves'
import { barrelObject, crateObject, plankObject } from './wreck'

/**
 * Improvise — spend what you've hauled so the world answers back.
 *
 * Recipes announce themselves when you're standing where they'd work, with the
 * materials on you — same F-to-use verbs as salvage. Pack also lists the ones
 * that are ready now (Camp tab), so you can Raise / Dig / Lash without hunting
 * the prompt. No markers in-world; none of the recipes is the "right" path.
 */

export type CampGroup = 'shelter' | 'build' | 'camp' | 'raft'

export type CampRecipe = {
  id: string
  group: CampGroup
  verb: string
  label: string
  /** Human cost line, e.g. "2 planks, 1 rope" or "hands". */
  cost: string
  use: () => void
}

export type Cost = Partial<Record<StashKind, number>>

export type ImproviseDeps = {
  interactions: Interactions
  salvage: Salvage
  vitals: Vitals
  hud: Hud
  /** Terrain only (island / spire) — builds place on this, not on other builds. */
  groundAt: (x: number, z: number) => number
  rawFish: () => number
  eatRawFish: () => boolean
  cookFish: () => boolean
  /** Hang one raw fish over the fire — returns false if none left. */
  takeRawForSmoke: () => boolean
  /** Finish a smoke cycle into the Pack. */
  addSmoked: (n?: number) => void
  /** Trap-caught fish land in the hand the same way grabbed ones do. */
  grantFish: (n?: number) => void
  /** Fashion a fishing rod from plank + rope. */
  fashionRod?: () => boolean
  /** Lash a cast net from rope + fronds. */
  fashionNet?: () => boolean
  /** Already carrying crafted fishing gear. */
  hasRod?: () => boolean
  hasNet?: () => boolean
  /** 0 at night … 1 at noon — rest under a lean-to skips to dawn when dark. */
  daylight: () => number
  /** Jump the climate clock (seconds of day-cycle time). */
  skipTime: (seconds: number) => void
  /** Real seconds until the next dawn. */
  secondsUntilDawn: () => number
  /** True once the mate's spear is yours — unlocks the stern mark. */
  hasMark?: () => boolean
  /** Live squall 0..1 — wash-off, rain-catch fill, camp value. */
  storm?: () => number
  /** Persistent sea set — rafts drift with the current. */
  current?: () => { x: number; z: number; strength: number }
  /** Optional foley — lash / wood / splash / sail / haul. */
  sfx?: (kind: 'lash' | 'wood' | 'splash' | 'sail' | 'haul', intensity?: number) => void
}

type BuildKind =
  | 'lean-to'
  | 'fire'
  | 'raft'
  | 'catch'
  | 'seat'
  | 'rack'
  | 'signal'
  | 'pit'
  | 'drip'
  | 'cistern'
  | 'camp-locker'
  | 'woodpile'
  | 'trap'
  // —— carpentry: the freeform pieces you architect a base from ——
  | 'platform'
  | 'wall'
  | 'roof'

type SmokeRack = {
  readyAt: number
  mesh: THREE.Object3D
}

type Hold = Record<StashKind, number>

type RoofKind = 'none' | 'leaf' | 'canvas' | 'scrap'

type Build = {
  kind: BuildKind
  object: THREE.Group
  x: number
  z: number
  deckY: number
  radius: number
  shelter: number
  water?: number
  /** Barrel rafts pole a little harder. */
  buoyant?: boolean
  vx?: number
  vz?: number
  /**
   * Heading in radians, stored off the mesh. Wave pitch/roll is applied as
   * Euler X/Z every frame — reading rotation.y after that corrupts yaw and
   * the raft spins. Keep the true heading here.
   */
  yaw?: number
  /** Fish hanging over this fire, waiting on the smoke. */
  smoking?: SmokeRack[]
  /** Deck fittings — only meaningful on rafts. */
  mast?: boolean
  rail?: boolean
  locker?: boolean
  /** Push oar lashed — poles harder and turns cleaner. */
  oar?: boolean
  /** Plastic bottles tied under the deck. */
  floats?: boolean
  /** How many times the deck has been widened (cap 3). */
  expands?: number
  /** Progressive shelter: walls lashed (0–2). */
  sides?: number
  /** Progressive shelter: roof covering. */
  roof?: RoofKind
  /** Shelter raised to walk-in height — you can stand inside it. */
  tall?: boolean
  /** Shelter footprint in bays; each Add a room is one more. */
  rooms?: number
  /** Fish waiting in a trap. */
  fish?: number
  /** Barrel set under the lean-to as a cistern / windbreak. */
  hasBarrel?: boolean
  /** Frond mat under the shelter — warmer Rest. */
  hasMat?: boolean
  /** Materials stowed in the deck locker. */
  hold?: Hold
  /** Stern scratched with the mate's mark. */
  marked?: boolean
  /** Grounded on a beach — no drift until Shove. */
  beached?: boolean
  /** Stone over the side, line made fast — the set can't take her. */
  anchored?: boolean
  /** Sail torn in a gale — Mend with canvas before it draws again. */
  torn?: boolean
  /** Locker took a sea — hold is wet / light items gone. */
  flooded?: boolean
  /** Soft-fail fill 0..1 while a foul sea works the rig. */
  failMeter?: number
  /** Carpentry piece variant — a wall can be hung as a door you walk through. */
  variant?: 'door'
  /** Extra hotspots this build registered (drink, etc.) — cleared on reset. */
  items: Interactable[]
}

const LEAN_COST: Cost = { plank: 2, rope: 1 }
const SIDE_COST: Cost = { plank: 1 }
const ROOF_LEAF_COST: Cost = { leaf: 2 }
const ROOF_CANVAS_COST: Cost = { canvas: 1 }
const ROOF_SCRAP_COST: Cost = { plastic: 3, rope: 1 }
const SHELTER_BARREL_COST: Cost = { barrel: 1 }
const CISTERN_COST: Cost = { barrel: 1 }
const MAT_COST: Cost = { leaf: 2, rope: 1 }
const RIDGE_COST: Cost = { plank: 3, rope: 1 }
const ROOM_COST: Cost = { plank: 2, rope: 1, leaf: 1 }
const TRAP_COST: Cost = { plastic: 1, rope: 1 }
const ROD_COST: Cost = { plank: 1, rope: 1 }
const NET_COST: Cost = { rope: 1, leaf: 2 }
const CAMP_LOCKER_COST: Cost = { crate: 1 }
const FIRE_COST: Cost = { plank: 1 }
const CATCH_COST: Cost = { canvas: 1, rope: 1 }
const RAFT_COST: Cost = { plank: 3, rope: 1 }
const RAFT_BARREL_COST: Cost = { plank: 3, rope: 1, barrel: 1 }
const MAST_COST: Cost = { plank: 1, canvas: 1, rope: 1 }
const RAIL_COST: Cost = { plank: 1, rope: 1 }
const LOCKER_COST: Cost = { crate: 1 }
const SEAT_COST: Cost = { plank: 1 }
const RACK_COST: Cost = { plank: 1, rope: 1 }
const SIGNAL_COST: Cost = { plank: 1, canvas: 1 }
const EXPAND_COST: Cost = { plank: 2 }
const OAR_COST: Cost = { plank: 1, rope: 1 }
const FLOAT_COST: Cost = { plastic: 2 }
const DRIP_COST: Cost = { can: 1, rope: 1 }
const PLATFORM_COST: Cost = { plank: 2 }
const WALL_COST: Cost = { plank: 1 }
const DOOR_COST: Cost = { plank: 1 }
const ROOF_COST: Cost = { plank: 1, leaf: 1 }
/** First sticks of a shore woodpile — the rest Stow in. */
const WOODPILE_COST: Cost = { plank: 1 }
/** Cap on planks sitting in one pile (mansion stockpile, not a cheat crate). */
const WOODPILE_MAX = 24
/** Max times you can widen one raft. */
const EXPAND_MAX = 3
const SIDE_MAX = 2
/** A shelter grows to three rooms — hut, then house, then hall. */
const ROOM_MAX = 3
/** Day-cycle hours a build stage takes: the price of a bigger shelter is time. */
const BUILD_RIDGE_HOURS = 2.4
const BUILD_ROOM_HOURS = 2.8
/** A set trap's first catch comes quick; after that the tide works slower. */
const TRAP_FIRST = 75
const TRAP_NEXT = 115
const TRAP_MAX = 2

const REACH = 3.2
const PLACE_AHEAD = 1.7
const CATCH_REFILL = 220
/** Foul weather puts water in a rain-catch faster — up to ~2.6× in a gale. */
const CATCH_STORM_BOOST = 1.6
/** Daytime nap — a few hours of day-cycle time, not a full night. */
const NAP_HOURS = 2.8
/** Don't rest again until you've been awake this long (real seconds). */
const REST_COOLDOWN = 18
/** Real seconds for one fish to smoke through. */
const SMOKE_TIME = 28
const SMOKE_MAX = 2
/** Real seconds for one fish to dry on a rack (no fire). */
const DRY_TIME = 48
const DRY_MAX = 3
/** How hard you can pole a raft (m/s). */
const POLE_SPEED = 2.15
const POLE_SPEED_BARREL = 2.6
const POLE_OAR_BONUS = 0.55
const POLE_FLOAT_BONUS = 0.28
/** Helmed sail drive (m/s) — steering from the stern with the canvas up. */
const SAIL_HELM_SPEED = 2.3
const SAIL_HELM_BARREL = 2.7
/** Local stern threshold — stand aft of this (toward the thwart) to take the helm. */
const HELM_STERN_X = 0.35
/**
 * Deck radius fraction: inside this is for walking / fittings; at or past it,
 * stick input poles. Lets you work the locker without driving the raft.
 */
const POLE_GUNWALE = 0.48
/** Past this fraction of radius you're over the gunwale. */
const DECK_LIP = 0.9
/** After Shove, ignore auto-beach so the wash doesn't pin her again. */
const SHOVE_GRACE = 3.2
/**
 * How far sand must sit above the live sea before the hull sticks.
 * Absolute ground thresholds fail on the island shelf (sand is metres high
 * while the waterline is still a long walk seaward).
 */
const BEACH_HARD_CLEAR = 0.42
/** Soft wash — stick only when nearly stopped. */
const BEACH_SOFT_CLEAR = 0.04
/** Clear of the shelf: sand clearly under water, not just wave-kissed. */
const SHOVE_CLEAR = -0.22
/** Extra metres past first clear sample so a trough doesn't re-pin her. */
const SHOVE_EXTRA = 3.5
/** Passive sail drift (m/s) once the mast is rigged. */
const SAIL_SPEED = 0.95
const SAIL_SPEED_BARREL = 1.35
/** Dug hollow / tin drip / cistern refill (seconds to full). */
const PIT_REFILL = 200
const DRIP_REFILL = 160
const CISTERN_REFILL = 280
const SHELTER_BARREL_REFILL = 240
/** Standing eye height — match player.ts so Climb seats you on the deck. */
const WALK_EYE = 1.62
/** How far out you can still Climb aboard from the water. */
const CLIMB_RANGE = 4.8
/**
 * Wash-off: how fast a foul sea fills the "over the side" meter while you're
 * on deck. Rail cuts it hard; a locker (mass) helps a little.
 */
const WASH_RATE = 0.55
const WASH_RAIL = 0.22
const WASH_LOCKER = 0.08
const WASH_STORM_GATE = 0.42
const WASH_RAIL_GATE = 0.72
/** Look-down pitch (radians) required to pole — accidental walk won't drive her. */
const POLE_LOOK_DOWN = -0.32
/** Look-down pitch required to Dig — same sign as pole (positive pitch is look up). */
const DIG_LOOK_DOWN = -0.28
/** Soft-fail: how fast a gale frays the sail while you're aboard. */
const FAIL_RATE = 0.22
const FAIL_STORM_GATE = 0.58
/** Mend a torn sail. */
const MEND_COST: Cost = { canvas: 1, rope: 1 }

// —— carpentry ————————————————————————————————————————————————
/** Every platform snaps to this world grid, so pieces always meet flush. */
const TILE = 2.4
/** Deck rise above dry ground (land) or the live sea (stilts in the shallows). */
const PLATFORM_RISE_LAND = 0.42
const PLATFORM_RISE_SEA = 0.55
/** Deepest seabed a stilt platform can stand on (mean sea level is 0). */
const PLATFORM_MAX_DEPTH = 2.1
const WALL_HEIGHT = 1.95
/** Roof floats at wall-top above the deck. */
const ROOF_RISE = 2.02
/** A free-standing wall is a windbreak; tile walls feed the platform instead. */
const WALL_SHELTER = 0.5
/** Sleep needs a roofed tile closed in about this much. */
const SLEEP_SHELTER = 0.7

const emptyHold = (): Hold => ({
  plank: 0,
  barrel: 0,
  crate: 0,
  rope: 0,
  canvas: 0,
  plastic: 0,
  can: 0,
  leaf: 0,
})

function holdCount(h: Hold) {
  let n = 0
  for (const k of Object.keys(h) as StashKind[]) n += h[k]
  return n
}

function mats() {
  return {
    wood: new THREE.MeshStandardMaterial({
      color: 0x7a6244,
      roughness: 0.95,
      side: THREE.DoubleSide,
    }),
    rope: new THREE.MeshStandardMaterial({ color: 0x8d7c5c, roughness: 1 }),
    cloth: new THREE.MeshStandardMaterial({
      color: 0xb5a88e,
      roughness: 0.92,
      side: THREE.DoubleSide,
    }),
    ember: new THREE.MeshStandardMaterial({
      color: 0x3a2a22,
      roughness: 1,
      emissive: 0xc45a1a,
      emissiveIntensity: 1.8,
    }),
    coal: new THREE.MeshStandardMaterial({
      color: 0x1a1210,
      roughness: 1,
      emissive: 0x8a2808,
      emissiveIntensity: 0.85,
    }),
    flameCore: new THREE.MeshBasicMaterial({
      color: 0xffcc66,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
    flameMid: new THREE.MeshBasicMaterial({
      color: 0xff6a18,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
    flameOuter: new THREE.MeshBasicMaterial({
      color: 0xd02008,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
    glow: new THREE.MeshBasicMaterial({
      color: 0xff6020,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
    sparkBit: new THREE.MeshBasicMaterial({
      color: 0xffd090,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    smokePuff: new THREE.MeshBasicMaterial({
      color: 0x4a4540,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    brand: new THREE.MeshStandardMaterial({
      color: 0x5a4430,
      roughness: 0.95,
    }),
    sail: new THREE.MeshStandardMaterial({
      color: 0xc4b89a,
      roughness: 0.9,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
    }),
    mark: new THREE.MeshStandardMaterial({
      color: 0x3a2e22,
      roughness: 1,
    }),
    water: new THREE.MeshStandardMaterial({
      color: 0x6a9aaa,
      roughness: 0.2,
      metalness: 0.05,
      transparent: true,
      opacity: 0.72,
    }),
    iron: new THREE.MeshStandardMaterial({ color: 0x5a5048, roughness: 0.65, metalness: 0.55 }),
    fish: new THREE.MeshStandardMaterial({
      color: 0x8a7a5c,
      roughness: 0.85,
      emissive: 0x3a2010,
      emissiveIntensity: 0.35,
    }),
    plastic: new THREE.MeshStandardMaterial({
      color: 0xc8d6e0,
      roughness: 0.35,
      metalness: 0.05,
      transparent: true,
      opacity: 0.82,
    }),
    tin: new THREE.MeshStandardMaterial({
      color: 0x8a9188,
      roughness: 0.45,
      metalness: 0.7,
    }),
    sand: new THREE.MeshStandardMaterial({ color: 0x9a8460, roughness: 1 }),
    leaf: new THREE.MeshStandardMaterial({
      color: 0x4a6e32,
      roughness: 0.92,
      side: THREE.DoubleSide,
    }),
  }
}

/**
 * Progressive shelter — start with a frame, then fashion walls and a roof.
 * Rest only once something is over your head.
 *
 * Past the roof it grows two ways, and both cost you hours: Raise the ridge
 * turns the crawl-in lean-to into a walk-in hut (`tall`), then Add a room
 * bolts another bay on the side, up to three. Rooms are laid symmetric about
 * the build origin so the Rest spot and the shelter radius stay honest.
 */
function shelterFrameMesh(m: ReturnType<typeof mats>, tall = false, bays = 1) {
  const g = new THREE.Group()
  g.name = 'lean-to'
  if (!tall) {
    for (const [x, z, h] of [
      [-1.0, 0.55, 1.35],
      [1.0, 0.55, 1.35],
      [-0.95, -0.55, 1.05],
      [0.95, -0.55, 1.05],
    ] as const) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, h, 0.1), m.wood)
      post.position.set(x, h / 2, z)
      g.add(post)
    }
    const ridge = plankObject(2.2, 0.1, m.wood)
    ridge.position.set(0, 1.35, 0.35)
    ridge.rotation.x = -0.35
    g.add(ridge)
    const cross = plankObject(1.5, 0.08, m.wood)
    cross.rotation.y = Math.PI / 2
    cross.position.set(0, 0.95, 0)
    g.add(cross)
    for (const [x, z] of [
      [-1.0, 0.55],
      [1.0, 0.55],
    ] as const) {
      const lash = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.025, 4, 8), m.rope)
      lash.position.set(x, 1.2, z)
      g.add(lash)
    }
  } else {
    // Walk-in hut — head-clear ridge over stouter posts, one bay per room
    const span = bays * 2.2
    for (let i = 0; i <= bays; i++) {
      const x = -span / 2 + i * 2.2
      for (const [z, h] of [
        [0.75, 2.05],
        [-0.75, 1.8],
      ] as const) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.11, h, 0.11), m.wood)
        post.position.set(x, h / 2, z)
        g.add(post)
      }
      const lash = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.026, 4, 8), m.rope)
      lash.position.set(x, 1.84, 0.75)
      g.add(lash)
    }
    for (let i = 0; i < bays; i++) {
      const cx = -span / 2 + i * 2.2 + 1.1
      const ridge = plankObject(2.5, 0.1, m.wood)
      ridge.position.set(cx, 2.0, 0.42)
      ridge.rotation.x = -0.28
      g.add(ridge)
      const cross = plankObject(1.7, 0.08, m.wood)
      cross.rotation.y = Math.PI / 2
      cross.position.set(cx, 1.62, 0)
      g.add(cross)
    }
  }
  const sideSlot = new THREE.Group()
  sideSlot.name = 'sideSlot'
  g.add(sideSlot)
  const roofSlot = new THREE.Group()
  roofSlot.name = 'roofSlot'
  g.add(roofSlot)
  const barrelSlot = new THREE.Group()
  barrelSlot.name = 'barrelSlot'
  barrelSlot.visible = false
  g.add(barrelSlot)
  const matSlot = new THREE.Group()
  matSlot.name = 'matSlot'
  matSlot.visible = false
  g.add(matSlot)
  return g
}

function fitShelterSide(
  shelter: THREE.Group,
  m: ReturnType<typeof mats>,
  n: number,
  tall = false,
  bays = 1,
) {
  const slot = shelter.getObjectByName('sideSlot') as THREE.Group
  if (!slot) return
  if (!tall) {
    const z = n === 1 ? 0.55 : -0.55
    for (let i = 0; i < 4; i++) {
      const slat = plankObject(1.9, 0.07, m.wood)
      slat.position.set(0, 0.25 + i * 0.28, z)
      slat.rotation.x = n === 1 ? -0.08 : 0.08
      slot.add(slat)
    }
    const lash = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.022, 4, 8), m.rope)
    lash.position.set(-0.9, 0.7, z)
    slot.add(lash)
    return
  }
  // Hut walls: a course of slats per bay, full standing height
  const z = n === 1 ? 0.75 : -0.75
  const span = bays * 2.2
  for (let b = 0; b < bays; b++) {
    const cx = -span / 2 + b * 2.2 + 1.1
    for (let i = 0; i < 6; i++) {
      const slat = plankObject(2.3, 0.07, m.wood)
      slat.position.set(cx, 0.24 + i * 0.3, z)
      slat.rotation.x = n === 1 ? -0.06 : 0.06
      slot.add(slat)
    }
    const lash = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.024, 4, 8), m.rope)
    lash.position.set(cx - 1.0, 1.05, z)
    slot.add(lash)
  }
}

function fitShelterRoof(
  shelter: THREE.Group,
  m: ReturnType<typeof mats>,
  kind: 'leaf' | 'canvas' | 'scrap',
  tall = false,
  bays = 1,
) {
  const slot = shelter.getObjectByName('roofSlot') as THREE.Group
  if (!slot) return
  while (slot.children.length) slot.remove(slot.children[0])
  // One run of covering per room, laid on the hut's taller ridge
  const y = tall ? 1.95 : 1.2
  const z = tall ? 0.08 : 0.1
  const pitch = tall ? -0.5 : -0.55
  const span = tall ? bays * 2.2 : 2.2
  const centres = tall ? bays : 1
  if (kind === 'leaf') {
    for (let b = 0; b < centres; b++) {
      const cx = -span / 2 + b * 2.2 + 1.1
      for (let i = 0; i < 10; i++) {
        const frond = new THREE.Mesh(new THREE.PlaneGeometry(0.55, tall ? 2.2 : 1.8, 1, 3), m.leaf)
        const pos = frond.geometry.attributes.position
        const h = tall ? 2.2 : 1.8
        for (let v = 0; v < pos.count; v++) {
          const t = (pos.getY(v) + h / 2) / h
          pos.setZ(v, (1 - t) * 0.25)
        }
        frond.geometry.computeVertexNormals()
        frond.position.set(cx + (i - 4.5) * 0.24, y, z)
        frond.rotation.x = pitch
        frond.rotation.z = ((i % 3) - 1) * 0.08
        slot.add(frond)
      }
    }
  } else if (kind === 'canvas') {
    for (let b = 0; b < centres; b++) {
      const cx = -span / 2 + b * 2.2 + 1.1
      const sheet = new THREE.Mesh(new THREE.PlaneGeometry(2.6, tall ? 2.3 : 2.0, 3, 3), m.cloth)
      const pos = sheet.geometry.attributes.position
      for (let i = 0; i < pos.count; i++) {
        pos.setZ(i, Math.sin(pos.getX(i) * 1.2) * 0.04)
      }
      sheet.geometry.computeVertexNormals()
      sheet.position.set(cx, y + 0.05, z + 0.02)
      sheet.rotation.x = pitch
      slot.add(sheet)
      const edge = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 2.4, 4), m.rope)
      edge.rotation.z = Math.PI / 2
      edge.position.set(cx, y - 0.2, z + 0.73)
      slot.add(edge)
    }
  } else {
    // Scrap tarp — bottles flattened under rope courses
    for (let b = 0; b < centres; b++) {
      const cx = -span / 2 + b * 2.2 + 1.1
      for (let i = 0; i < 6; i++) {
        const scrap = new THREE.Mesh(new THREE.PlaneGeometry(0.7, tall ? 1.3 : 1.1), m.plastic)
        scrap.position.set(cx + (i - 2.5) * 0.4, y + 0.02, z - 0.05 + (i % 2) * 0.08)
        scrap.rotation.x = pitch
        slot.add(scrap)
      }
      const course = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 2.5, 4), m.rope)
      course.rotation.z = Math.PI / 2
      course.position.set(cx, y - 0.05, z + 0.3)
      slot.add(course)
    }
  }
}

function fitShelterBarrel(shelter: THREE.Group, m: ReturnType<typeof mats>) {
  const slot = shelter.getObjectByName('barrelSlot') as THREE.Group
  if (!slot || slot.children.length) {
    if (slot) slot.visible = true
    return
  }
  const barrel = barrelObject(m.wood, m.iron)
  barrel.position.set(0.75, 0.35, -0.15)
  slot.add(barrel)
  const water = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.08, 10), m.water)
  water.position.set(0.75, 0.72, -0.15)
  water.name = 'water'
  water.visible = false
  slot.add(water)
  const lash = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.03, 4, 8), m.rope)
  lash.position.set(0.75, 0.55, -0.15)
  lash.rotation.x = Math.PI / 2
  slot.add(lash)
  slot.visible = true
}

function fitShelterMat(shelter: THREE.Group, m: ReturnType<typeof mats>) {
  const slot = shelter.getObjectByName('matSlot') as THREE.Group
  if (!slot || slot.children.length) {
    if (slot) slot.visible = true
    return
  }
  for (let i = 0; i < 7; i++) {
    const frond = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 1.6, 1, 2), m.leaf)
    frond.rotation.x = -Math.PI / 2
    frond.position.set((i - 3) * 0.22, 0.04, 0.05)
    frond.rotation.z = ((i % 3) - 1) * 0.05
    slot.add(frond)
  }
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.5, 4), m.rope)
  cord.rotation.z = Math.PI / 2
  cord.position.set(0, 0.05, 0.55)
  slot.add(cord)
  slot.visible = true
}

function campLockerMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  g.name = 'camp-locker'
  const box = crateObject(m.wood)
  box.position.y = 0.28
  box.scale.setScalar(0.95)
  g.add(box)
  const lash = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.03, 4, 8), m.rope)
  lash.position.set(0, 0.45, 0.2)
  lash.rotation.x = Math.PI / 2
  g.add(lash)
  return g
}

/**
 * A shore woodpile — sticks you can Stow into and Fetch from without a crate.
 * The stack mesh is rebuilt when the count changes so a fat pile reads as stock.
 */
function woodpileMesh(m: ReturnType<typeof mats>, planks = 1) {
  const g = new THREE.Group()
  g.name = 'woodpile'
  const n = Math.max(1, Math.min(WOODPILE_MAX, planks))
  const rows = Math.min(4, Math.ceil(n / 3))
  let left = n
  for (let row = 0; row < rows && left > 0; row++) {
    const across = Math.min(3, left)
    for (let i = 0; i < across; i++) {
      const plank = plankObject(1.35 - row * 0.08, 0.16, m.wood)
      plank.position.set((i - (across - 1) / 2) * 0.22, 0.1 + row * 0.18, (row % 2) * 0.08)
      plank.rotation.y = ((i + row) % 3) * 0.04
      g.add(plank)
      left--
    }
  }
  return g
}

function cisternMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  g.name = 'cistern'
  const barrel = barrelObject(m.wood, m.iron)
  barrel.position.y = 0.35
  g.add(barrel)
  const water = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.1, 10), m.water)
  water.position.y = 0.72
  water.name = 'water'
  water.visible = false
  g.add(water)
  // Open bung — reads as a rain mouth
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 4, 10), m.iron)
  rim.rotation.x = Math.PI / 2
  rim.position.y = 0.78
  g.add(rim)
  return g
}

function recomputeShelter(b: Build) {
  let s = 0.28
  s += (b.sides ?? 0) * 0.2
  if (b.roof === 'leaf') s += 0.38
  else if (b.roof === 'canvas') s += 0.52
  else if (b.roof === 'scrap') s += 0.32
  if (b.hasBarrel) s += 0.1
  if (b.hasMat) s += 0.06
  // A walk-in hut holds heat like a building; every room after that a little more
  if (b.tall) s += 0.18
  s += Math.max(0, (b.rooms ?? 1) - 1) * 0.07
  // Height band: inland frames hold heat a touch better
  if (b.deckY > 2) s += 0.08
  b.shelter = s
}

/** Rising spark bits / smoke puffs — positions rewritten each frame in animateFire. */
function fireBits(
  count: number,
  material: THREE.Material,
  name: string,
  radius: number,
) {
  const g = new THREE.Group()
  g.name = name
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 5, 4), material.clone())
    mesh.userData.seed = Math.random()
    g.add(mesh)
  }
  return g
}

function attachFireLight(g: THREE.Group, torch: boolean) {
  // Candela units (Three r155+). A campfire is bright — hundreds of cd — so
  // the night sand actually takes the orange.
  const key = new THREE.PointLight(0xff8a3a, torch ? 55 : 110, torch ? 9 : 16, 2)
  key.name = 'fireLight'
  key.position.set(0, torch ? 0.55 : 0.5, 0)
  g.add(key)
  const fill = new THREE.PointLight(0xff6a28, torch ? 18 : 36, torch ? 14 : 26, 2)
  fill.name = 'fireFill'
  fill.position.set(0, torch ? 0.3 : 0.2, 0)
  g.add(fill)
}

function flameStack(m: ReturnType<typeof mats>, scale = 1) {
  const g = new THREE.Group()
  g.name = 'flames'
  const outer = new THREE.Mesh(new THREE.ConeGeometry(0.24 * scale, 0.78 * scale, 7), m.flameOuter.clone())
  outer.position.y = 0.4 * scale
  outer.name = 'flameOuter'
  outer.renderOrder = 2
  g.add(outer)
  const mid = new THREE.Mesh(new THREE.ConeGeometry(0.15 * scale, 0.62 * scale, 6), m.flameMid.clone())
  mid.position.y = 0.38 * scale
  mid.name = 'flameMid'
  mid.renderOrder = 3
  g.add(mid)
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.08 * scale, 0.46 * scale, 5), m.flameCore.clone())
  core.position.y = 0.34 * scale
  core.name = 'flameCore'
  core.renderOrder = 4
  g.add(core)
  return g
}

function fireMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  g.name = 'campfire'

  // Criss-crossed kindling — denser than the old five sticks
  for (let i = 0; i < 7; i++) {
    const stick = plankObject(0.72, 0.07, m.wood)
    const a = (i / 7) * Math.PI * 2
    stick.position.set(Math.cos(a) * 0.2, 0.05 + (i % 2) * 0.04, Math.sin(a) * 0.2)
    stick.rotation.set(0.55, a + 0.4, 0.15 + (i % 3) * 0.08)
    g.add(stick)
  }
  // Charred coals under the flame
  const bed = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 7), m.coal)
  bed.scale.set(1.15, 0.38, 1.15)
  bed.position.y = 0.06
  g.add(bed)
  const coal = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), m.ember.clone())
  coal.scale.set(1.1, 0.42, 1.1)
  coal.position.y = 0.1
  coal.name = 'ember'
  g.add(coal)

  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), m.glow.clone())
  glow.position.y = 0.3
  glow.name = 'glow'
  glow.renderOrder = 1
  g.add(glow)

  g.add(flameStack(m, 1))
  g.add(fireBits(14, m.sparkBit, 'sparks', 0.018))
  g.add(fireBits(6, m.smokePuff, 'smoke', 0.07))
  attachFireLight(g, false)
  return g
}

/** Brand you carry — a stick with the same living fire on the tip. */
function torchMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  g.name = 'torch'
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.036, 0.85, 8), m.brand)
  shaft.position.y = 0.2
  g.add(shaft)
  const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.12, 8), m.wood)
  wrap.position.y = 0.58
  g.add(wrap)
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), m.ember.clone())
  tip.scale.set(1, 0.7, 1)
  tip.position.y = 0.66
  tip.name = 'ember'
  g.add(tip)
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), m.glow.clone())
  glow.position.y = 0.72
  glow.name = 'glow'
  glow.renderOrder = 1
  g.add(glow)
  const flames = flameStack(m, 0.55)
  flames.position.y = 0.42
  g.add(flames)
  g.add(fireBits(10, m.sparkBit, 'sparks', 0.014))
  g.add(fireBits(4, m.smokePuff, 'smoke', 0.05))
  attachFireLight(g, true)
  return g
}

function animateFire(root: THREE.Object3D, t: number, phase: number, daylight: number) {
  const flicker =
    0.78 +
    Math.sin(t * 11.2 + phase) * 0.12 +
    Math.sin(t * 17.7 + phase * 1.7) * 0.08 +
    Math.sin(t * 29.3 + phase * 0.4) * 0.05

  const flames = root.getObjectByName('flames')
  if (flames) {
    for (const child of flames.children) {
      const n = child.name
      const lean = Math.sin(t * 4.2 + phase + (n === 'flameOuter' ? 0.6 : n === 'flameMid' ? 0.2 : 0)) * 0.08
      child.rotation.z = lean
      child.rotation.x = Math.sin(t * 5.1 + phase * 1.3) * 0.05
      const yPulse =
        n === 'flameCore' ? 0.9 + flicker * 0.2 : n === 'flameMid' ? 0.85 + flicker * 0.22 : 0.8 + flicker * 0.28
      child.scale.set(0.92 + flicker * 0.12, yPulse, 0.92 + flicker * 0.12)
      child.rotation.y = t * (n === 'flameOuter' ? 0.9 : n === 'flameMid' ? 1.4 : 2.1)
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshBasicMaterial
        const base = n === 'flameCore' ? 0.95 : n === 'flameMid' ? 0.82 : 0.5
        mat.opacity = base * (0.7 + flicker * 0.4)
      }
    }
  }

  const glow = root.getObjectByName('glow')
  if (glow) {
    const s = 0.9 + flicker * 0.4
    glow.scale.setScalar(s)
    const mat = (glow as THREE.Mesh).material as THREE.MeshBasicMaterial
    mat.opacity = 0.28 + flicker * 0.28
  }

  const ember = root.getObjectByName('ember')
  if (ember && ember instanceof THREE.Mesh) {
    const mat = ember.material as THREE.MeshStandardMaterial
    mat.emissiveIntensity = 1.2 + flicker * 1.1
  }

  const sparks = root.getObjectByName('sparks')
  if (sparks) {
    for (const child of sparks.children) {
      if (!(child instanceof THREE.Mesh)) continue
      const s = child.userData.seed as number
      const life = ((t * (0.55 + s * 0.7) + s * 7) % 1.35) / 1.35
      const spin = s * Math.PI * 2 + t * (1.2 + s)
      const r = 0.03 + life * 0.14 + Math.sin(spin) * 0.02
      child.position.set(Math.cos(spin) * r, 0.28 + life * 0.9, Math.sin(spin) * r)
      const fade = life < 0.15 ? life / 0.15 : life > 0.7 ? 1 - (life - 0.7) / 0.3 : 1
      child.scale.setScalar(0.6 + fade * 0.8)
      ;(child.material as THREE.MeshBasicMaterial).opacity = fade * (0.55 + flicker * 0.4)
    }
  }
  const smoke = root.getObjectByName('smoke')
  if (smoke) {
    for (const child of smoke.children) {
      if (!(child instanceof THREE.Mesh)) continue
      const s = child.userData.seed as number
      const life = ((t * (0.16 + s * 0.18) + s * 4) % 2.4) / 2.4
      const spin = s * Math.PI * 2 + t * 0.3
      const r = 0.06 + life * 0.32
      child.position.set(Math.cos(spin) * r, 0.55 + life * 1.5, Math.sin(spin * 0.8) * r)
      child.scale.setScalar(0.7 + life * 1.6)
      const night = Math.max(0, 1 - daylight)
      ;(child.material as THREE.MeshBasicMaterial).opacity =
        (0.08 + night * 0.1) * (1 - life * 0.85)
    }
  }

  // Lights: strong at night, still a readable warm pool by day
  const night = Math.max(0, 1 - daylight)
  const key = root.getObjectByName('fireLight') as THREE.PointLight | undefined
  const fill = root.getObjectByName('fireFill') as THREE.PointLight | undefined
  const torch = root.name === 'torch'
  if (key) {
    const base = torch ? 28 + night * 55 : 40 + night * 95
    key.intensity = base * flicker
    key.color.setRGB(1, 0.48 + flicker * 0.12, 0.18 + flicker * 0.05)
  }
  if (fill) {
    const base = torch ? 10 + night * 18 : 14 + night * 32
    fill.intensity = base * (0.85 + flicker * 0.2)
  }
}

function catchMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  for (const [x, z] of [
    [-0.7, -0.7],
    [0.7, -0.7],
    [-0.7, 0.7],
    [0.7, 0.7],
  ] as const) {
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.5, 0.07), m.wood)
    pole.position.set(x, 0.7, z)
    g.add(pole)
  }
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6, 2, 2), m.cloth)
  sheet.rotation.x = -Math.PI / 2
  sheet.position.y = 1.35
  const pos = sheet.geometry.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    pos.setZ(i, (x * x + y * y) * 0.18)
  }
  pos.needsUpdate = true
  sheet.geometry.computeVertexNormals()
  g.add(sheet)
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.4, 0.18, 10), m.wood)
  basin.position.y = 0.12
  g.add(basin)
  const water = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.06, 10), m.water)
  water.position.y = 0.2
  water.name = 'water'
  g.add(water)
  return g
}

/**
 * Bottle fish trap — a big bottle on its side, the neck cut and turned back
 * in on itself, a rope bridle to a small float. Set it in the shallows and
 * the tide fills it; the little dark shapes show when it has.
 */
function trapMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  g.name = 'trap'
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.62, 9), m.plastic)
  body.rotation.z = Math.PI / 2
  g.add(body)
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.13, 0.22, 9), m.plastic)
  neck.rotation.z = -Math.PI / 2
  neck.position.x = 0.36
  g.add(neck)
  const bridle = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.018, 4, 10), m.rope)
  bridle.rotation.y = Math.PI / 2
  bridle.position.x = -0.16
  g.add(bridle)
  const float = new THREE.Mesh(new THREE.SphereGeometry(0.08, 7, 6), m.plastic)
  float.position.set(-0.42, 0.14, 0)
  g.add(float)
  const line = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 4), m.rope)
  line.rotation.z = 0.7
  line.position.set(-0.32, 0.06, 0)
  g.add(line)
  // The catch — small dark shapes knocking about inside the bottle
  const stock = new THREE.Group()
  stock.name = 'trapStock'
  for (let i = 0; i < TRAP_MAX; i++) {
    const fish = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.24, 6), m.fish)
    fish.rotation.z = Math.PI / 2 + (i - 0.5) * 0.5
    fish.position.set((i - 0.5) * 0.18, 0.01 + i * 0.03, (i % 2) * 0.07 - 0.035)
    stock.add(fish)
  }
  stock.visible = false
  g.add(stock)
  return g
}

/** Driftwood seat — sit to get your legs back. */
function seatMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const bench = plankObject(1.4, 0.28, m.wood)
  bench.position.y = 0.38
  g.add(bench)
  for (const x of [-0.5, 0.5]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.38, 0.1), m.wood)
    leg.position.set(x, 0.19, 0)
    g.add(leg)
  }
  const back = plankObject(1.3, 0.1, m.wood)
  back.position.set(0, 0.62, -0.18)
  back.rotation.x = -0.15
  g.add(back)
  return g
}

/** Drying rack — hang fish without a fire; patience does the smoke's job slower. */
function rackMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  for (const x of [-0.55, 0.55]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.35, 0.08), m.wood)
    post.position.set(x, 0.65, 0)
    g.add(post)
  }
  const bar = plankObject(1.3, 0.08, m.wood)
  bar.position.set(0, 1.2, 0)
  g.add(bar)
  for (const x of [-0.35, 0, 0.35]) {
    const lash = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.015, 4, 6), m.rope)
    lash.position.set(x, 1.18, 0)
    lash.rotation.x = Math.PI / 2
    g.add(lash)
  }
  return g
}

/** Signal post — a scrap of canvas and a thin column of smoke you can read from the water. */
function signalMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.6, 6), m.brand)
  post.position.y = 1.3
  g.add(post)
  const rag = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.55), m.sail)
  rag.position.set(0.35, 2.35, 0)
  rag.name = 'signalRag'
  g.add(rag)
  const stay = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.1, 4), m.rope)
  stay.position.set(0.2, 1.9, 0)
  stay.rotation.z = 0.7
  g.add(stay)
  // Rising smoke puffs — animated in update
  for (let i = 0; i < 8; i++) {
    const puff = new THREE.Mesh(
      new THREE.SphereGeometry(0.08 + (i % 3) * 0.03, 5, 4),
      m.smokePuff.clone(),
    )
    puff.userData.seed = Math.random()
    puff.name = 'signalSmoke'
    g.add(puff)
  }
  return g
}

function raftMesh(m: ReturnType<typeof mats>, withBarrel: boolean) {
  const g = new THREE.Group()
  g.name = 'raft'

  // Deck — denser planking, a touch longer so it reads as a craft not a pallet
  for (let i = 0; i < 6; i++) {
    const plank = plankObject(3.2, 0.3, m.wood)
    plank.position.set(0, 0.05, (i - 2.5) * 0.3)
    g.add(plank)
  }
  for (const z of [-0.85, 0, 0.85]) {
    const cross = plankObject(1.9, 0.14, m.wood)
    cross.rotation.y = Math.PI / 2
    cross.position.set(0, 0.12, z * 0.05)
    g.add(cross)
  }

  // Low gunwales — the lip that keeps gear (and you) from sliding off
  for (const z of [-0.95, 0.95]) {
    const rail = plankObject(2.9, 0.08, m.wood)
    rail.position.set(0, 0.22, z)
    rail.scale.set(1, 1.6, 1)
    g.add(rail)
  }

  // Bow stem — a raised nose so it reads as going somewhere
  const stem = plankObject(0.7, 0.12, m.wood)
  stem.position.set(-1.55, 0.28, 0)
  stem.rotation.z = 0.45
  g.add(stem)
  const stemPost = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.55, 0.1), m.wood)
  stemPost.position.set(-1.65, 0.4, 0)
  g.add(stemPost)

  // Stern thwart + blank name board (mark carved later)
  const thwart = plankObject(1.6, 0.18, m.wood)
  thwart.rotation.y = Math.PI / 2
  thwart.position.set(1.35, 0.2, 0)
  g.add(thwart)
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.7), m.wood)
  board.position.set(1.55, 0.42, 0)
  board.name = 'sternBoard'
  g.add(board)

  // Push pole — lashed along the starboard rail, ready to hand
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 2.6, 6), m.brand)
  pole.rotation.z = Math.PI / 2
  pole.position.set(0.15, 0.28, 0.72)
  g.add(pole)
  const poleGrip = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.015, 4, 8), m.rope)
  poleGrip.position.set(1.1, 0.28, 0.72)
  poleGrip.rotation.y = Math.PI / 2
  g.add(poleGrip)

  // Lashings at the joints
  for (const [x, z] of [
    [1.2, 0.7],
    [1.2, -0.7],
    [-1.1, 0.7],
    [-1.1, -0.7],
  ] as const) {
    const lash = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.03, 4, 8), m.rope)
    lash.rotation.x = Math.PI / 2
    lash.position.set(x, 0.14, z)
    g.add(lash)
  }

  if (withBarrel) {
    const left = barrelObject(m.wood, m.iron)
    left.position.set(-1.15, -0.12, 0.65)
    left.rotation.z = Math.PI / 2
    g.add(left)
    const right = barrelObject(m.wood, m.iron)
    right.position.set(-1.15, -0.12, -0.65)
    right.rotation.z = Math.PI / 2
    g.add(right)
  }

  // Upgrade slots — empty groups filled when you lash fittings on
  const mastSlot = new THREE.Group()
  mastSlot.name = 'mastSlot'
  mastSlot.visible = false
  g.add(mastSlot)
  const railSlot = new THREE.Group()
  railSlot.name = 'railSlot'
  railSlot.visible = false
  g.add(railSlot)
  const lockerSlot = new THREE.Group()
  lockerSlot.name = 'lockerSlot'
  lockerSlot.visible = false
  g.add(lockerSlot)
  const markSlot = new THREE.Group()
  markSlot.name = 'markSlot'
  markSlot.visible = false
  g.add(markSlot)
  const expandSlot = new THREE.Group()
  expandSlot.name = 'expandSlot'
  g.add(expandSlot)
  const oarSlot = new THREE.Group()
  oarSlot.name = 'oarSlot'
  oarSlot.visible = false
  g.add(oarSlot)
  const floatSlot = new THREE.Group()
  floatSlot.name = 'floatSlot'
  floatSlot.visible = false
  g.add(floatSlot)
  const anchorSlot = new THREE.Group()
  anchorSlot.name = 'anchorSlot'
  anchorSlot.visible = false
  g.add(anchorSlot)

  return g
}

/** A beach stone on a line over the bow — toggle when the anchor drops/weighs. */
function fitAnchor(raft: THREE.Group, m: ReturnType<typeof mats>, down: boolean) {
  const slot = raft.getObjectByName('anchorSlot') as THREE.Group
  if (!slot) return
  if (!slot.children.length) {
    const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 0), m.iron)
    stone.position.set(-1.72, -0.75, 0.35)
    stone.scale.set(1, 0.75, 1)
    slot.add(stone)
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1.1, 4), m.rope)
    line.position.set(-1.68, -0.28, 0.35)
    line.rotation.z = 0.12
    slot.add(line)
    const cleat = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.016, 4, 8), m.rope)
    cleat.position.set(-1.6, 0.24, 0.35)
    cleat.rotation.x = Math.PI / 2
    slot.add(cleat)
  }
  slot.visible = down
}

function fitMast(raft: THREE.Group, m: ReturnType<typeof mats>) {
  const slot = raft.getObjectByName('mastSlot') as THREE.Group
  if (!slot || slot.children.length) {
    if (slot) slot.visible = true
    return
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 2.8, 8), m.brand)
  mast.position.set(-0.35, 1.45, 0)
  slot.add(mast)
  const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1.8, 6), m.wood)
  yard.rotation.z = Math.PI / 2
  yard.position.set(-0.35, 2.35, 0)
  slot.add(yard)
  // Scrap of canvas on a yard — billows a little in animateSail
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.9, 3, 4), m.sail)
  const pos = sail.geometry.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const z = pos.getZ(i)
    pos.setX(i, 0.08 + (1.1 - y) * 0.12 + z * z * 0.08)
  }
  pos.needsUpdate = true
  sail.geometry.computeVertexNormals()
  sail.position.set(-0.35, 1.45, 0)
  sail.name = 'sail'
  slot.add(sail)
  const stay = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 2.2, 4), m.rope)
  stay.position.set(0.4, 1.2, 0)
  stay.rotation.z = 0.55
  slot.add(stay)
  slot.visible = true
}

function fitRail(raft: THREE.Group, m: ReturnType<typeof mats>) {
  const slot = raft.getObjectByName('railSlot') as THREE.Group
  if (!slot || slot.children.length) {
    if (slot) slot.visible = true
    return
  }
  for (const z of [-1.05, 1.05]) {
    for (const x of [-1.1, 0, 1.1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.55, 0.07), m.wood)
      post.position.set(x, 0.45, z)
      slot.add(post)
    }
    const top = plankObject(2.6, 0.07, m.wood)
    top.position.set(0, 0.72, z)
    slot.add(top)
    // Rope course between posts
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 2.4, 5), m.rope)
    rope.rotation.z = Math.PI / 2
    rope.position.set(0, 0.5, z)
    slot.add(rope)
  }
  slot.visible = true
}

function fitLocker(raft: THREE.Group, m: ReturnType<typeof mats>) {
  const slot = raft.getObjectByName('lockerSlot') as THREE.Group
  if (!slot || slot.children.length) {
    if (slot) slot.visible = true
    return
  }
  const box = crateObject(m.wood)
  box.rotation.set(0, 0.15, 0)
  // Starboard of the centreline so bow↔stern stays a clear walk
  box.position.set(0.7, 0.42, -0.62)
  box.scale.setScalar(0.85)
  slot.add(box)
  const lash = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.03, 4, 8), m.rope)
  lash.position.set(0.7, 0.55, -0.62)
  lash.rotation.x = Math.PI / 2
  slot.add(lash)
  slot.visible = true
}

function fitMark(raft: THREE.Group, m: ReturnType<typeof mats>) {
  const slot = raft.getObjectByName('markSlot') as THREE.Group
  if (!slot || slot.children.length) {
    if (slot) slot.visible = true
    return
  }
  // Scratched W — the Wanderer's mark, cut with the knife you earned
  for (const [dx, dy, rot] of [
    [-0.08, 0.04, 0.4],
    [0.08, 0.04, -0.4],
    [0, -0.02, 0],
  ] as const) {
    const cut = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2, 0.04), m.mark)
    cut.position.set(1.6, 0.42 + dy, dx)
    cut.rotation.z = rot
    slot.add(cut)
  }
  slot.visible = true
}

/** Lash another course of planks — the deck grows under your feet. */
function fitExpand(raft: THREE.Group, m: ReturnType<typeof mats>, n: number) {
  const slot = raft.getObjectByName('expandSlot') as THREE.Group
  if (!slot) return
  const side = n % 2 === 1 ? 1 : -1
  const row = Math.floor((n - 1) / 2)
  for (let i = 0; i < 3; i++) {
    const plank = plankObject(2.4 + row * 0.2, 0.28, m.wood)
    plank.position.set(row * 0.15, 0.06, side * (1.05 + row * 0.32) + (i - 1) * 0.08)
    plank.rotation.y = side * 0.04
    slot.add(plank)
  }
  const lash = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.025, 4, 8), m.rope)
  lash.rotation.x = Math.PI / 2
  lash.position.set(0.4, 0.14, side * (1.05 + row * 0.32))
  slot.add(lash)
}

function fitOar(raft: THREE.Group, m: ReturnType<typeof mats>) {
  const slot = raft.getObjectByName('oarSlot') as THREE.Group
  if (!slot || slot.children.length) {
    if (slot) slot.visible = true
    return
  }
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 2.4, 6), m.brand)
  shaft.rotation.z = Math.PI / 2
  shaft.rotation.y = -0.35
  shaft.position.set(0.2, 0.45, -0.95)
  slot.add(shaft)
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.55, 0.22), m.wood)
  blade.position.set(-0.95, 0.45, -1.15)
  blade.rotation.y = -0.35
  blade.rotation.z = 0.15
  slot.add(blade)
  const grip = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.012, 4, 8), m.rope)
  grip.position.set(1.15, 0.45, -0.75)
  grip.rotation.y = Math.PI / 2
  slot.add(grip)
  slot.visible = true
}

function fitFloat(raft: THREE.Group, m: ReturnType<typeof mats>) {
  const slot = raft.getObjectByName('floatSlot') as THREE.Group
  if (!slot || slot.children.length) {
    if (slot) slot.visible = true
    return
  }
  for (const [x, z] of [
    [0.9, 0.85],
    [0.9, -0.85],
    [-0.6, 0.9],
    [-0.6, -0.9],
  ] as const) {
    const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.32, 8), m.plastic)
    bottle.rotation.z = Math.PI / 2
    bottle.position.set(x, -0.08, z)
    slot.add(bottle)
    const lash = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.02, 4, 8), m.rope)
    lash.rotation.y = Math.PI / 2
    lash.position.set(x, -0.02, z)
    slot.add(lash)
  }
  slot.visible = true
}

function digPitMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  g.name = 'pit'
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.08, 6, 16), m.sand)
  rim.rotation.x = Math.PI / 2
  rim.position.y = 0.04
  g.add(rim)
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.28, 0.22, 12), m.sand)
  bowl.position.y = -0.02
  g.add(bowl)
  const water = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.28, 0.05, 12), m.water)
  water.position.y = 0.02
  water.name = 'water'
  water.visible = false
  g.add(water)
  return g
}

function dripMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  g.name = 'drip'
  const stake = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.1, 0.06), m.wood)
  stake.position.set(0, 0.5, 0)
  g.add(stake)
  const can = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.18, 10), m.tin)
  can.position.set(0.05, 0.85, 0)
  can.rotation.z = 0.55
  g.add(can)
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.35, 4), m.rope)
  cord.position.set(0.02, 0.95, 0)
  cord.rotation.z = 0.4
  g.add(cord)
  const drip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), m.water)
  drip.position.set(0.12, 0.72, 0)
  drip.name = 'water'
  drip.visible = false
  g.add(drip)
  return g
}

// —— carpentry pieces —————————————————————————————————————————

/** Stilt deck tile — a floor that isn't sand, on the beach or over the shallows. */
function platformMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  g.name = 'platform'
  for (let i = 0; i < 7; i++) {
    const plank = plankObject(TILE - 0.06, 0.32, m.wood)
    plank.position.set(0, 0.06, (i - 3) * 0.34)
    g.add(plank)
  }
  for (const z of [-0.8, 0.8]) {
    const beam = plankObject(TILE - 0.2, 0.13, m.wood)
    beam.rotation.y = Math.PI / 2
    beam.position.set(0, -0.06, z)
    g.add(beam)
  }
  // Stilt piles — long enough to read over water, buried short on sand
  for (const [x, z] of [
    [-1.0, -1.0],
    [1.0, -1.0],
    [-1.0, 1.0],
    [1.0, 1.0],
  ] as const) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.13, 2.4, 0.13), m.brand)
    post.position.set(x, -0.95, z)
    g.add(post)
    const lash = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.024, 4, 8), m.rope)
    lash.rotation.x = Math.PI / 2
    lash.position.set(x, 0.1, z)
    g.add(lash)
  }
  return g
}

/**
 * Deck-edge wall (or a free-standing windbreak). The door hangs two narrow
 * panels with a gap you walk through — it keeps the wind's count for the
 * tile without boxing you in.
 */
function wallMesh(m: ReturnType<typeof mats>, door: boolean) {
  const g = new THREE.Group()
  g.name = 'wall'
  const H = WALL_HEIGHT
  const W = TILE - 0.24
  for (const x of [-W / 2, W / 2]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, H, 0.1), m.brand)
    post.position.set(x, H / 2, 0)
    g.add(post)
  }
  const railTop = plankObject(W + 0.1, 0.09, m.wood)
  railTop.position.set(0, H - 0.06, 0)
  g.add(railTop)
  const railLow = plankObject(W + 0.1, 0.09, m.wood)
  railLow.position.set(0, 0.12, 0)
  g.add(railLow)
  const slat = (x: number, w: number) => {
    const s = new THREE.Mesh(new THREE.BoxGeometry(w, H - 0.28, 0.05), m.wood)
    s.position.set(x, H / 2 - 0.02, 0)
    g.add(s)
  }
  if (door) {
    // Two cheeks and a lintel — a man-shaped gap between
    slat(-W / 2 + 0.45, 0.72)
    slat(W / 2 - 0.45, 0.72)
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.34, 0.05), m.wood)
    lintel.position.set(0, H - 0.32, 0)
    g.add(lintel)
  } else {
    for (let i = 0; i < 5; i++) slat((i - 2) * (W / 5), W / 5 - 0.06)
  }
  for (const x of [-W / 2 + 0.06, W / 2 - 0.06]) {
    const lash = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.02, 4, 8), m.rope)
    lash.position.set(x, H - 0.18, 0)
    g.add(lash)
  }
  return g
}

/** Shed roof — plank courses under a thatch of fronds, tilted to shed rain. */
function roofMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  g.name = 'roof'
  const panel = new THREE.Group()
  for (let i = 0; i < 6; i++) {
    const plank = plankObject(TILE - 0.02, 0.36, m.wood)
    plank.position.set(0, 0.05, (i - 2.5) * 0.4)
    panel.add(plank)
  }
  for (let i = 0; i < 6; i++) {
    const frond = new THREE.Mesh(new THREE.PlaneGeometry(0.5, TILE - 0.1, 1, 2), m.leaf)
    frond.rotation.x = -Math.PI / 2
    frond.rotation.z = ((i % 3) - 1) * 0.05
    frond.position.set((i - 2.5) * 0.38, 0.16, 0)
    panel.add(frond)
  }
  for (const x of [-0.9, 0.9]) {
    const batten = plankObject(TILE - 0.1, 0.08, m.brand)
    batten.rotation.y = Math.PI / 2
    batten.position.set(x, 0.12, 0)
    panel.add(batten)
  }
  // Shed tilt — high edge faces the build's +z
  panel.rotation.x = -0.14
  g.add(panel)
  // Stub posts that read as resting on the wall top plates
  for (const [x, z] of [
    [-1.0, -1.0],
    [1.0, -1.0],
    [-1.0, 1.0],
    [1.0, 1.0],
  ] as const) {
    const stub = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.5, 0.09), m.brand)
    stub.position.set(x, -0.22, z)
    g.add(stub)
  }
  return g
}

function animateSail(raft: THREE.Object3D, t: number, torn = false) {
  const sail = raft.getObjectByName('sail')
  if (!sail) return
  if (torn) {
    // Hangs slack — the gale already took the wind out of it
    sail.rotation.y = Math.sin(t * 0.35) * 0.02
    sail.rotation.z = -0.55 + Math.sin(t * 0.5) * 0.04
    sail.scale.set(1, 0.72, 1)
  } else {
    sail.scale.set(1, 1, 1)
    sail.rotation.y = Math.sin(t * 0.7) * 0.06
    sail.rotation.z = Math.sin(t * 0.45 + 1) * 0.03
  }
}

function smokedFishMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.28, 3, 6), m.fish)
  body.rotation.z = Math.PI / 2
  g.add(body)
  return g
}

function costLabel(cost: Cost, labels: Salvage['labels']) {
  return (Object.keys(cost) as StashKind[])
    .filter((k) => (cost[k] ?? 0) > 0)
    .map((k) => {
      const n = cost[k] ?? 0
      const name = n === 1 ? labels[k].one : labels[k].many
      return `${n} ${name.toLowerCase()}`
    })
    .join(', ')
}

function offset(player: { x: number; z: number }, yaw: number, ahead: number, side: number) {
  const s = Math.sin(yaw)
  const c = Math.cos(yaw)
  return {
    x: player.x - s * ahead - c * side,
    z: player.z - c * ahead + s * side,
  }
}

/** Local deck offset → world XZ, using the raft's stored heading. */
function raftLocal(b: Build, lx: number, lz: number) {
  const heading = b.yaw ?? b.object.rotation.y
  const s = Math.sin(heading)
  const c = Math.cos(heading)
  return {
    x: b.x + lx * c + lz * s,
    z: b.z - lx * s + lz * c,
  }
}

/**
 * Beached hull sits on sand. Waves may wet the planks but must not lift the
 * whole craft — that was the hover-over-beach glitch.
 */
function beachedDeckY(ground: number, seaY: number) {
  const wash = Math.max(0, seaY - ground)
  return ground + 0.1 + Math.min(0.06, wash * 0.12)
}

/** Sand height minus live sea — positive means the beach is dry under the hull. */
function beachClearance(ground: number, seaY: number) {
  return ground - seaY
}

export function createImprovise(scene: THREE.Scene, camera: THREE.Camera, deps: ImproviseDeps) {
  const m = mats()
  const builds: Build[] = []
  const tap = (kind: 'lash' | 'wood' | 'splash' | 'sail' | 'haul', intensity = 0.7) =>
    deps.sfx?.(kind, intensity)

  // Separate anchors so recipes don't fight for one F-prompt when materials overlap
  const leanPos = new THREE.Vector3()
  const firePos = new THREE.Vector3()
  const catchPos = new THREE.Vector3()
  const raftPos = new THREE.Vector3()
  const eatPos = new THREE.Vector3()
  const cookPos = new THREE.Vector3()
  const smokePos = new THREE.Vector3()
  const takeSmokePos = new THREE.Vector3()
  const restPos = new THREE.Vector3()
  const takeFirePos = new THREE.Vector3()
  const plantFirePos = new THREE.Vector3()
  const climbPos = new THREE.Vector3()
  const raftFitPos = new THREE.Vector3()
  const stowPos = new THREE.Vector3()
  const markPos = new THREE.Vector3()
  const seatPos = new THREE.Vector3()
  const rackPos = new THREE.Vector3()
  const signalPos = new THREE.Vector3()
  const sitPos = new THREE.Vector3()
  const dryPos = new THREE.Vector3()
  const takeDryPos = new THREE.Vector3()
  const digPos = new THREE.Vector3()
  const dripPos = new THREE.Vector3()
  const trapPos = new THREE.Vector3()
  const thwartPos = new THREE.Vector3()
  const sailRestPos = new THREE.Vector3()
  const beachPos = new THREE.Vector3()
  const shovePos = new THREE.Vector3()
  const mendPos = new THREE.Vector3()
  const platPos = new THREE.Vector3()
  const wallPos = new THREE.Vector3()
  const roofPos = new THREE.Vector3()
  const strikePos = new THREE.Vector3()
  const climbPlatPos = new THREE.Vector3()
  const sleepPlatPos = new THREE.Vector3()

  /** Construction recipes also listed in Pack → Camp (same use() as F). */
  type CampEntry = {
    group: CampGroup
    cost?: Cost
    /** Menu availability — Dig skips look-down; F still requires it. */
    menuReady?: () => boolean
    item: Interactable
  }
  const campEntries: CampEntry[] = []
  /** Set when the Lay Platform recipe is registered — update() raises its priority while expanding. */
  let layPlatformItem: Interactable | null = null

  function addCamp(
    group: CampGroup,
    spec: Parameters<Interactions['add']>[0] & { cost?: Cost; menuReady?: () => boolean },
  ) {
    const { cost, menuReady, ...rest } = spec
    const item = deps.interactions.add(rest)
    campEntries.push({ group, cost, menuReady, item })
    return item
  }

  let yaw = 0
  let lookPitch = 0
  let onLand = false
  let groundY = -1000
  let nearWaterline = false
  let time = 0
  let px = 0
  let pz = 0
  let restReadyAt = 0
  let sitReadyAt = 0
  /** The trap anchor is over wading-depth water on the shelf. */
  let trapSpotValid = false
  let saidPole = false
  let saidSail = false
  let saidWash = false
  let saidOar = false
  let saidPoleHint = false
  let saidHelm = false
  let saidHelmHint = false
  let saidFail = false
  let saidBeach = false
  let swimming = false
  let onRaftDeck = false
  /** Standing on a platform tile — fires, sleep and wall work read it. */
  let onPlatformDeck = false
  /** Ground / live sea under the platform anchor (recomputed every frame). */
  let platGround = -1000
  let platSea = 0
  /** Dive/look-down held — intentional pole when at the gunwale. */
  let poleIntent = false
  /** Seconds of stickiness after Climb — kills leftover swim speed that throws you off. */
  let boardGrace = 0
  /** After a wash-off, stay swimming briefly so the deck skirt can't reclaim you. */
  let washGrace = 0
  /** After Shove — don't snap beached again while she clears the shelf. */
  let shoveGrace = 0
  /** 0..1 — fills in foul weather on an open deck; rail buys you time. */
  let washMeter = 0
  /** Live player ref — Climb mutates this to seat you on the deck. */
  let live: {
    x: number
    y: number
    z: number
    mode: 'swim' | 'walk'
    vy: number
    submersion: number
    speed?: number
  } | null = null
  /** Living brand in hand — null when every fire is planted. */
  let carried: Build | null = null
  const torch = torchMesh(m)
  torch.visible = false
  camera.add(torch)
  // Lower-right, tip forward — reads as carried, not bolted to the lens
  const torchBase = new THREE.Vector3(0.38, -0.42, -0.55)
  const torchSway = new THREE.Vector3()
  /** Trade-wind axis the sail draws on — steady, not a weather toy. */
  const WIND = { x: Math.sin(0.85), z: Math.cos(0.85) }

  function disposeBuildObject(object: THREE.Object3D) {
    object.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
        obj.geometry.dispose()
      }
    })
  }

  function nearestOfKind(x: number, z: number, kind: BuildKind, maxDist: number): Build | null {
    let best: Build | null = null
    let bestD = maxDist
    for (const b of builds) {
      if (b.kind !== kind) continue
      const d = Math.hypot(b.x - x, b.z - z)
      if (d < bestD) {
        bestD = d
        best = b
      }
    }
    return best
  }

  function clearOfBuilds(x: number, z: number, min = 2.4) {
    for (const b of builds) {
      if (Math.hypot(b.x - x, b.z - z) < min) return false
    }
    return true
  }

  // —— carpentry helpers ————————————————————————————————————

  const snapTile = (v: number) => Math.round(v / TILE) * TILE

  /** Live snap target for Lay Platform — recomputed every frame. */
  let platSnapX = 0
  let platSnapZ = 0
  /** True when the snap is an empty neighbour of a deck you're on / facing. */
  let platExpanding = false

  /** The platform tile containing (x, z) — Chebyshev within half a tile. */
  function platformAt(x: number, z: number, slack = 0.06): Build | null {
    for (const b of builds) {
      if (b.kind !== 'platform') continue
      if (Math.max(Math.abs(b.x - x), Math.abs(b.z - z)) < TILE / 2 + slack) return b
    }
    return null
  }

  /**
   * Where the next deck tile wants to land.
   *
   * Standing on a platform: always the empty neighbour you're facing — that's
   * how rooms grow. Looking at a deck from outside: the empty cell past it if
   * you're aimed that way, else the ordinary look-ahead snap. Occupied cells
   * never win, which is why Lay Platform used to flicker off when you glanced
   * back at your own floor.
   */
  function resolvePlatformSnap(lookX: number, lookZ: number): { x: number; z: number; expanding: boolean } {
    const under = platformAt(px, pz)
    if (under) {
      const side = tileSide(under)
      const nx = under.x + side.dx * TILE
      const nz = under.z + side.dz * TILE
      if (!platformAt(nx, nz, TILE / 2)) return { x: nx, z: nz, expanding: true }
    }
    const near = nearestOfKind(px, pz, 'platform', TILE * 1.35)
    if (near) {
      const side = tileSide(near)
      const nx = near.x + side.dx * TILE
      const nz = near.z + side.dz * TILE
      if (!platformAt(nx, nz, TILE / 2)) {
        const toEmpty = Math.hypot(lookX - nx, lookZ - nz)
        const toNear = Math.hypot(lookX - near.x, lookZ - near.z)
        if (toEmpty <= toNear + 0.4) return { x: nx, z: nz, expanding: true }
      }
    }
    const sx = snapTile(lookX)
    const sz = snapTile(lookZ)
    return { x: sx, z: sz, expanding: false }
  }

  /** Carpentry pieces belonging to a tile — walls at its edges, its roof. */
  function tilePieces(tile: Build, kind: BuildKind) {
    const out: Build[] = []
    for (const b of builds) {
      if (b.kind !== kind) continue
      if (Math.hypot(b.x - tile.x, b.z - tile.z) < TILE * 0.68) out.push(b)
    }
    return out
  }

  /** Which tile edge the player is working: facing when aboard, else the near edge. */
  function tileSide(tile: Build): { dx: 1 | -1 | 0; dz: 1 | -1 | 0 } {
    const onTile = Math.max(Math.abs(px - tile.x), Math.abs(pz - tile.z)) < TILE / 2
    const vx = onTile ? -Math.sin(yaw) : px - tile.x
    const vz = onTile ? -Math.cos(yaw) : pz - tile.z
    if (Math.abs(vx) >= Math.abs(vz)) return { dx: vx >= 0 ? 1 : -1, dz: 0 }
    return { dx: 0, dz: vz >= 0 ? 1 : -1 }
  }

  function tileEdgeMid(tile: Build, side: { dx: number; dz: number }) {
    return { x: tile.x + side.dx * (TILE / 2), z: tile.z + side.dz * (TILE / 2) }
  }

  function wallOnEdge(tile: Build, side: { dx: number; dz: number }) {
    const mid = tileEdgeMid(tile, side)
    for (const b of builds) {
      if (b.kind !== 'wall') continue
      if (Math.hypot(b.x - mid.x, b.z - mid.z) < 0.6) return b
    }
    return null
  }

  function tileRoof(tile: Build) {
    return tilePieces(tile, 'roof')[0] ?? null
  }

  /** The tile the player can hang a piece on: under them, or the one they face. */
  function wallTargetTile() {
    return platformAt(px, pz) ?? platformAt(wallPos.x, wallPos.z, 0.35)
  }

  /** A tile's shelter is the sum of what's hung on it — walls, door, roof. */
  function recomputeTileShelter(tile: Build) {
    let s = 0.18
    for (const w of tilePieces(tile, 'wall')) s += w.variant === 'door' ? 0.08 : 0.11
    if (tileRoof(tile)) s += 0.26
    if (tile.deckY > 2) s += 0.08
    tile.shelter = s
  }

  function refund(cost: Cost) {
    const s = deps.salvage.stash
    for (const k of Object.keys(cost) as StashKind[]) s[k] += cost[k] ?? 0
  }

  /**
   * Fire clearance. On carpentry decks the platform itself must not block a
   * hearth — walls only keep the flame out of their own plane. Everything
   * else keeps the usual 1.4 m.
   */
  function clearForFire(x: number, z: number) {
    for (const b of builds) {
      if (b.kind === 'platform' || b.kind === 'roof') continue
      // A hearth by the wall is the point of a closed-in tile — just keep the
      // flame out of the wall plane itself
      const min = b.kind === 'wall' ? 0.2 : 1.4
      if (Math.hypot(b.x - x, b.z - z) < min) return false
    }
    return true
  }

  /** cos between the look direction and the direction to (x, z) — teardown gates. */
  function facingDot(x: number, z: number) {
    const dx = x - px
    const dz = z - pz
    const len = Math.hypot(dx, dz) || 1
    return (-Math.sin(yaw) * dx + -Math.cos(yaw) * dz) / len
  }

  function strikeDown(b: Build, cost: Cost, line: string) {
    const idx = builds.indexOf(b)
    if (idx < 0) return
    builds.splice(idx, 1)
    for (const item of b.items) deps.interactions.remove(item)
    scene.remove(b.object)
    disposeBuildObject(b.object)
    refund(cost)
    const tile = platformAt(b.x, b.z, 0.9)
    if (tile) recomputeTileShelter(tile)
    deps.hud.whisper(line)
    tap('wood', 0.6)
  }

  /** Builds that share a plot with carpentry without blocking the next tile. */
  function blocksPlatform(b: Build) {
    return (
      b.kind !== 'platform' &&
      b.kind !== 'wall' &&
      b.kind !== 'roof' &&
      b.kind !== 'woodpile'
    )
  }

  function canLayPlatform() {
    if (!deps.vitals.alive || carried) return false
    if (!deps.salvage.has(PLATFORM_COST)) return false
    // Dry sand, the wash, or the shallows — stilts reach a couple metres down
    if (platGround < -PLATFORM_MAX_DEPTH) return false
    if (platformAt(platSnapX, platSnapZ, TILE / 2)) return false
    // Other camps own their ground; carpentry tiles may sit beside anything wooden
    for (const b of builds) {
      if (!blocksPlatform(b)) continue
      if (Math.hypot(b.x - platSnapX, b.z - platSnapZ) < 2.1) return false
    }
    return true
  }

  function canRaiseWall() {
    if (!deps.vitals.alive || !deps.salvage.has(WALL_COST)) return false
    if (!onLand && !onPlatformDeck) return false
    const tile = wallTargetTile()
    if (!tile) {
      // No tile in reach — a free-standing windbreak on dry ground
      return onLand && groundY > 0.5 && clearOfBuilds(wallPos.x, wallPos.z, 1.1)
    }
    return !wallOnEdge(tile, tileSide(tile))
  }

  function canHangDoor() {
    if (!deps.vitals.alive || !deps.salvage.has(DOOR_COST)) return false
    if (!onLand && !onPlatformDeck) return false
    const tile = wallTargetTile()
    if (!tile) return false
    return !wallOnEdge(tile, tileSide(tile))
  }

  function canPitchRoof() {
    if (!deps.vitals.alive || !deps.salvage.has(ROOF_COST)) return false
    if (!onLand && !onPlatformDeck) return false
    const tile = wallTargetTile()
    return !!tile && !tileRoof(tile)
  }

  function refitWoodpile(pile: Build) {
    const n = Math.max(1, pile.hold?.plank ?? 1)
    const next = woodpileMesh(m, n)
    next.position.copy(pile.object.position)
    next.rotation.y = pile.yaw ?? pile.object.rotation.y
    scene.remove(pile.object)
    disposeBuildObject(pile.object)
    pile.object = next
    scene.add(next)
  }

  // Faint placement ghosts — where the next piece will land, not a marker.
  const ghostMat = new THREE.MeshStandardMaterial({
    color: 0x9a8264,
    roughness: 1,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const ghostLeaf = new THREE.MeshStandardMaterial({
    color: 0x6a8a4a,
    roughness: 1,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const ghostRoot = new THREE.Group()
  ghostRoot.name = 'carpentryGhost'
  ghostRoot.visible = false
  scene.add(ghostRoot)

  function clearGhost() {
    while (ghostRoot.children.length) {
      const c = ghostRoot.children[0]
      ghostRoot.remove(c)
      c.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose()
      })
    }
    ghostRoot.visible = false
  }

  function showGhostPlatform(x: number, z: number, y: number) {
    clearGhost()
    const deck = new THREE.Mesh(new THREE.BoxGeometry(TILE - 0.12, 0.08, TILE - 0.12), ghostMat)
    deck.position.y = 0.04
    ghostRoot.add(deck)
    ghostRoot.position.set(x, y, z)
    ghostRoot.visible = true
  }

  function showGhostWall(x: number, z: number, y: number, yaw: number, door: boolean) {
    clearGhost()
    const W = TILE - 0.24
    if (door) {
      const left = new THREE.Mesh(new THREE.BoxGeometry(0.72, WALL_HEIGHT - 0.2, 0.06), ghostMat)
      left.position.set(-W / 2 + 0.45, WALL_HEIGHT / 2, 0)
      ghostRoot.add(left)
      const right = new THREE.Mesh(new THREE.BoxGeometry(0.72, WALL_HEIGHT - 0.2, 0.06), ghostMat)
      right.position.set(W / 2 - 0.45, WALL_HEIGHT / 2, 0)
      ghostRoot.add(right)
    } else {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(W, WALL_HEIGHT - 0.15, 0.06), ghostMat)
      panel.position.y = WALL_HEIGHT / 2
      ghostRoot.add(panel)
    }
    ghostRoot.position.set(x, y, z)
    ghostRoot.rotation.y = yaw
    ghostRoot.visible = true
  }

  function showGhostRoof(x: number, z: number, y: number) {
    clearGhost()
    const panel = new THREE.Mesh(new THREE.BoxGeometry(TILE - 0.05, 0.06, TILE - 0.05), ghostMat)
    panel.rotation.x = -0.28
    panel.position.y = 0.1
    ghostRoot.add(panel)
    const thatch = new THREE.Mesh(new THREE.BoxGeometry(TILE - 0.2, 0.04, TILE - 0.2), ghostLeaf)
    thatch.rotation.x = -0.28
    thatch.position.y = 0.16
    ghostRoot.add(thatch)
    ghostRoot.position.set(x, y, z)
    ghostRoot.rotation.y = 0
    ghostRoot.visible = true
  }

  function updateCarpentryGhost() {
    if (canLayPlatform()) {
      const ground = deps.groundAt(platSnapX, platSnapZ)
      const sea = sampleOcean(platSnapX, platSnapZ, time).y
      const overWater = ground <= sea - 0.3
      const deckY = overWater ? sea + PLATFORM_RISE_SEA : ground + PLATFORM_RISE_LAND
      showGhostPlatform(platSnapX, platSnapZ, deckY)
      return
    }
    if (canRaiseWall() || canHangDoor()) {
      const tile = wallTargetTile()
      const door = !canRaiseWall() && canHangDoor()
      if (tile) {
        const side = tileSide(tile)
        const mid = tileEdgeMid(tile, side)
        showGhostWall(
          mid.x,
          mid.z,
          tile.deckY,
          side.dx !== 0 ? Math.PI / 2 : 0,
          door,
        )
      } else {
        const snapped = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2)
        showGhostWall(wallPos.x, wallPos.z, deps.groundAt(wallPos.x, wallPos.z), snapped, false)
      }
      return
    }
    if (canPitchRoof()) {
      const tile = wallTargetTile()
      if (tile) {
        showGhostRoof(tile.x, tile.z, tile.deckY + ROOF_RISE)
        return
      }
    }
    clearGhost()
  }

  function addBuild(
    kind: BuildKind,
    object: THREE.Group,
    x: number,
    z: number,
    y: number,
    radius: number,
    shelter: number,
    extra?: Partial<Build>,
  ) {
    object.position.set(x, y, z)
    // Rafts rock on the swell (X/Z). YXZ keeps our stored heading as yaw.
    if (kind === 'raft') object.rotation.order = 'YXZ'
    object.rotation.y = extra?.yaw ?? yaw
    scene.add(object)
    const build: Build = {
      kind,
      object,
      x,
      z,
      deckY: y,
      radius,
      shelter,
      items: [],
      yaw: extra?.yaw ?? yaw,
      ...extra,
    }
    builds.push(build)
    return build
  }

  addCamp('shelter', {
    position: leanPos,
    verb: 'Raise',
    label: 'Frame',
    radius: REACH,
    cost: LEAN_COST,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 0.8 &&
      deps.salvage.has(LEAN_COST) &&
      clearOfBuilds(leanPos.x, leanPos.z, 2.2),
    use: () => {
      if (!deps.salvage.spend(LEAN_COST)) return
      const x = leanPos.x
      const z = leanPos.z
      const y = deps.groundAt(x, z)
      const build = addBuild('lean-to', shelterFrameMesh(m), x, z, y, 2.8, 0.28, {
        sides: 0,
        roof: 'none',
        hasBarrel: false,
        water: 0,
      })
      recomputeShelter(build)
      deps.hud.whisper('Posts in the sand. Walls and a roof still to fashion.')
    },
  })

  function nearestShelter(maxDist = 2.8) {
    // Centre-near first; anywhere inside a grown hut's footprint after
    return nearestOfKind(px, pz, 'lean-to', maxDist) ?? leanToAt(px, pz)
  }

  /**
   * The lean-to whose footprint you're in. A grown hut covers real ground, so
   * its own radius says how near is near — the 2.4 m of the crawl-in frame
   * would lose the far room of a three-bay house.
   */
  function leanToAt(x: number, z: number, slack = 0.5): Build | null {
    let best: Build | null = null
    let bestD = Infinity
    for (const b of builds) {
      if (b.kind !== 'lean-to') continue
      const d = Math.hypot(b.x - x, b.z - z)
      if (d < Math.max(2.4, b.radius - slack) && d < bestD) {
        bestD = d
        best = b
      }
    }
    return best
  }

  function shelterComplete(b: Build) {
    return (b.roof ?? 'none') !== 'none'
  }

  function attachBarrelDrink(build: Build, label: string) {
    const drink = deps.interactions.add({
      position: build.object.position,
      verb: 'Drink',
      label,
      radius: 2.5,
      available: () => deps.vitals.alive && (build.water ?? 0) > 0.1,
      use: () => {
        const left = build.water ?? 0
        if (left <= 0.1) return
        const sip = Math.min(0.4, left)
        build.water = left - sip
        eat(deps.vitals, 0, sip * 0.88)
        const waterMesh = build.object.getObjectByName('water')
        if (waterMesh) waterMesh.visible = (build.water ?? 0) > 0.08
        deps.hud.whisper(
          (build.water ?? 0) > 0.15 ? 'From the barrel. Cool and still.' : 'The cask runs low.',
        )
      },
    })
    build.items.push(drink)
  }

  addCamp('shelter', {
    position: leanPos,
    verb: 'Lash',
    label: 'Wall',
    cost: SIDE_COST,
    radius: REACH,
    available: () => {
      const s = nearestShelter()
      return (
        !!s &&
        deps.vitals.alive &&
        onLand &&
        (s.sides ?? 0) < SIDE_MAX &&
        deps.salvage.has(SIDE_COST)
      )
    },
    use: () => {
      const s = nearestShelter()
      if (!s || !deps.salvage.spend(SIDE_COST)) return
      s.sides = (s.sides ?? 0) + 1
      fitShelterSide(s.object, m, s.sides)
      recomputeShelter(s)
      deps.hud.whisper(
        s.sides === 1
          ? 'One wall. The wind finds less of you.'
          : 'Both sides closed. Only the roof left open.',
      )
    },
  })

  addCamp('shelter', {
    position: leanPos,
    verb: 'Roof',
    label: 'Fronds',
    cost: ROOF_LEAF_COST,
    radius: REACH,
    available: () => {
      const s = nearestShelter()
      return (
        !!s &&
        deps.vitals.alive &&
        onLand &&
        (s.roof ?? 'none') === 'none' &&
        deps.salvage.has(ROOF_LEAF_COST)
      )
    },
    use: () => {
      const s = nearestShelter()
      if (!s || !deps.salvage.spend(ROOF_LEAF_COST)) return
      s.roof = 'leaf'
      fitShelterRoof(s.object, m, 'leaf')
      recomputeShelter(s)
      deps.hud.whisper('Fronds layered thick. Shade enough to Rest.')
    },
  })

  addCamp('shelter', {
    position: leanPos,
    verb: 'Roof',
    label: 'Tarp',
    cost: ROOF_CANVAS_COST,
    radius: REACH,
    available: () => {
      const s = nearestShelter()
      if (!s || !deps.vitals.alive || !onLand) return false
      if (!deps.salvage.has(ROOF_CANVAS_COST)) return false
      const roof = s.roof ?? 'none'
      // Fresh roof, or upgrade leaf/scrap later when you find canvas
      return roof === 'none' || roof === 'leaf' || roof === 'scrap'
    },
    use: () => {
      const s = nearestShelter()
      if (!s || !deps.salvage.spend(ROOF_CANVAS_COST)) return
      const was = s.roof ?? 'none'
      s.roof = 'canvas'
      fitShelterRoof(s.object, m, 'canvas')
      recomputeShelter(s)
      deps.hud.whisper(
        was === 'none'
          ? 'Canvas stretched taut. A real roof. Rest under it.'
          : 'Better tarp over the old cover. The rain sheds clean.',
      )
    },
  })

  addCamp('shelter', {
    position: leanPos,
    verb: 'Roof',
    label: 'Scrap',
    cost: ROOF_SCRAP_COST,
    radius: REACH,
    available: () => {
      const s = nearestShelter()
      // Prefer canvas/leaf when you have them — scrap is the improviser's last roof
      if (!s || (s.roof ?? 'none') !== 'none') return false
      if (deps.salvage.has(ROOF_CANVAS_COST) || deps.salvage.has(ROOF_LEAF_COST)) return false
      return deps.vitals.alive && onLand && deps.salvage.has(ROOF_SCRAP_COST)
    },
    use: () => {
      const s = nearestShelter()
      if (!s || !deps.salvage.spend(ROOF_SCRAP_COST)) return
      s.roof = 'scrap'
      fitShelterRoof(s.object, m, 'scrap')
      recomputeShelter(s)
      deps.hud.whisper('Bottles and rope. Ugly — but it keeps the rain off.')
    },
  })

  addCamp('shelter', {
    position: leanPos,
    verb: 'Set',
    label: 'Barrel',
    cost: SHELTER_BARREL_COST,
    radius: REACH,
    available: () => {
      const s = nearestShelter()
      return (
        !!s &&
        deps.vitals.alive &&
        onLand &&
        !s.hasBarrel &&
        deps.salvage.has(SHELTER_BARREL_COST)
      )
    },
    use: () => {
      const s = nearestShelter()
      if (!s || !deps.salvage.spend(SHELTER_BARREL_COST)) return
      s.hasBarrel = true
      s.water = 0.25
      fitShelterBarrel(s.object, m)
      recomputeShelter(s)
      attachBarrelDrink(s, 'Barrel')
      deps.hud.whisper('Barrel under the eaves. Rain will fill it. Drink when it does.')
    },
  })

  addCamp('shelter', {
    position: leanPos,
    verb: 'Lay',
    label: 'Mat',
    cost: MAT_COST,
    radius: REACH,
    available: () => {
      const s = nearestShelter()
      return (
        !!s &&
        shelterComplete(s) &&
        deps.vitals.alive &&
        onLand &&
        !s.hasMat &&
        deps.salvage.has(MAT_COST)
      )
    },
    use: () => {
      const s = nearestShelter()
      if (!s || !deps.salvage.spend(MAT_COST)) return
      s.hasMat = true
      fitShelterMat(s.object, m)
      recomputeShelter(s)
      deps.hud.whisper('Fronds under you. Sleep will find the ground softer.')
    },
  })

  /**
   * Rebuild a lean-to's dressing in place after it grows. The Build and its
   * registered interactions keep their identity — only the mesh is swapped.
   */
  function reskinShelter(b: Build) {
    while (b.object.children.length) {
      const child = b.object.children[0]
      b.object.remove(child)
      disposeBuildObject(child)
    }
    const tall = !!b.tall
    const bays = Math.max(1, b.rooms ?? 1)
    const fresh = shelterFrameMesh(m, tall, bays)
    for (const child of [...fresh.children]) b.object.add(child)
    const sides = b.sides ?? 0
    for (let i = 1; i <= sides; i++) fitShelterSide(b.object, m, i, tall, bays)
    if ((b.roof ?? 'none') !== 'none') {
      fitShelterRoof(b.object, m, b.roof as 'leaf' | 'canvas' | 'scrap', tall, bays)
    }
    if (b.hasBarrel) {
      fitShelterBarrel(b.object, m)
      const waterMesh = b.object.getObjectByName('water')
      if (waterMesh) waterMesh.visible = (b.water ?? 0) > 0.08
    }
    if (b.hasMat) fitShelterMat(b.object, m)
  }

  /**
   * Building takes time. The hours pass on the day clock like a nap does,
   * and the body pays for the work — you come out of it hungry, thirsty,
   * and ready to sit down.
   */
  function workHours(hours: number) {
    deps.skipTime((hours / 24) * DAY_LENGTH)
    const v = deps.vitals
    v.stamina = Math.max(0.05, v.stamina - hours * 0.08)
    v.food = Math.max(0, v.food - hours * 0.035)
    v.water = Math.max(0, v.water - hours * 0.05)
    v.energy = Math.max(0, v.energy - hours * 0.045)
  }

  // Raise the ridge — the crawl-in lean-to becomes a hut you can stand in.
  // The first stage of a bigger shelter, and the first one that costs hours.
  addCamp('shelter', {
    position: leanPos,
    verb: 'Raise',
    label: 'the ridge',
    cost: RIDGE_COST,
    radius: REACH,
    available: () => {
      const s = nearestShelter()
      return (
        !!s &&
        shelterComplete(s) &&
        !s.tall &&
        deps.vitals.alive &&
        onLand &&
        deps.salvage.has(RIDGE_COST)
      )
    },
    use: () => {
      const s = nearestShelter()
      if (!s || !deps.salvage.spend(RIDGE_COST)) return
      workHours(BUILD_RIDGE_HOURS)
      s.tall = true
      s.rooms = Math.max(1, s.rooms ?? 1)
      reskinShelter(s)
      recomputeShelter(s)
      deps.hud.whisper('Hours of lifting and lashing. You can stand inside it now.')
    },
  })

  // Add a room — another bay on the hut, up to three. Each one is a morning
  // of work; the shelter gets bigger because you keep giving it time.
  addCamp('shelter', {
    position: leanPos,
    verb: 'Add',
    label: 'a room',
    cost: ROOM_COST,
    radius: REACH,
    available: () => {
      const s = nearestShelter()
      return (
        !!s &&
        !!s.tall &&
        (s.rooms ?? 1) < ROOM_MAX &&
        deps.vitals.alive &&
        onLand &&
        deps.salvage.has(ROOM_COST)
      )
    },
    use: () => {
      const s = nearestShelter()
      if (!s || !deps.salvage.spend(ROOM_COST)) return
      workHours(BUILD_ROOM_HOURS)
      s.rooms = (s.rooms ?? 1) + 1
      s.radius = 2.8 + (s.rooms - 1) * 1.15
      reskinShelter(s)
      recomputeShelter(s)
      deps.hud.whisper(
        s.rooms >= ROOM_MAX
          ? 'The last bay goes up. A house, by any measure you have out here.'
          : 'Another room framed, walled and roofed. The place is growing.',
      )
    },
  })

  // Scoop rain-pool / catch water into a barrel — can in hand is the ladle
  // (not spent). Without a can you can still tip a catch into a nearby cask.
  function nearestFillableBarrel() {
    const shelter = nearestShelter(3.2)
    if (shelter?.hasBarrel && (shelter.water ?? 0) < 0.92) return shelter
    const cistern = nearestOfKind(px, pz, 'cistern', 3.2)
    if (cistern && (cistern.water ?? 0) < 0.92) return cistern
    return null
  }

  function tryFillBarrel(target: Build): boolean {
    const room = 1 - (target.water ?? 0)
    if (room < 0.08) return false
    // Prefer a rain-catch in arm's reach, then a rock pool
    const catchBuild = nearestOfKind(px, pz, 'catch', 3.4)
    if (catchBuild && (catchBuild.water ?? 0) > 0.1) {
      const take = Math.min(room, catchBuild.water ?? 0, 0.45)
      catchBuild.water = (catchBuild.water ?? 0) - take
      target.water = (target.water ?? 0) + take
      const catchWater = catchBuild.object.getObjectByName('water')
      if (catchWater) catchWater.visible = (catchBuild.water ?? 0) > 0.05
      const barrelWater = target.object.getObjectByName('water')
      if (barrelWater) barrelWater.visible = (target.water ?? 0) > 0.08
      deps.hud.whisper('Tipped into the barrel. Kept.')
      return true
    }
    if (!deps.salvage.poolNear(px, pz)) return false
    // A tin can scoops from a rock hollow; bare hands spill most of it
    const want = deps.salvage.stash.can > 0 ? Math.min(room, 0.4) : Math.min(room, 0.18)
    const got = deps.salvage.drawFromPool(px, pz, want)
    if (got < 0.05) return false
    target.water = (target.water ?? 0) + got
    const barrelWater = target.object.getObjectByName('water')
    if (barrelWater) barrelWater.visible = true
    deps.hud.whisper(
      deps.salvage.stash.can > 0
        ? 'Scooped with the tin. The barrel takes it.'
        : 'Cupped hands. Most spills — some stays.',
    )
    return true
  }

  deps.interactions.add({
    position: leanPos,
    verb: 'Fill',
    label: 'Barrel',
    radius: 3.2,
    available: () => {
      if (!deps.vitals.alive || !onLand) return false
      const target = nearestFillableBarrel()
      if (!target) return false
      if (nearestOfKind(px, pz, 'catch', 3.4) && (nearestOfKind(px, pz, 'catch', 3.4)?.water ?? 0) > 0.1) {
        return true
      }
      return deps.salvage.poolNear(px, pz)
    },
    use: () => {
      const target = nearestFillableBarrel()
      if (!target) return
      tryFillBarrel(target)
    },
  })

  // Standalone cistern — a barrel planted open to the sky, no shelter needed
  addCamp('camp', {
    position: leanPos,
    verb: 'Plant',
    label: 'Cistern',
    cost: CISTERN_COST,
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 0.6 &&
      deps.salvage.has(CISTERN_COST) &&
      // Don't steal the Set Barrel prompt when you're at a frame
      !(nearestShelter(2.8) && !nearestShelter(2.8)?.hasBarrel) &&
      clearOfBuilds(leanPos.x, leanPos.z, 1.8) &&
      !nearestOfKind(leanPos.x, leanPos.z, 'cistern', 3.5),
    use: () => {
      if (!deps.salvage.spend(CISTERN_COST)) return
      const x = leanPos.x
      const z = leanPos.z
      const y = deps.groundAt(x, z)
      const build = addBuild('cistern', cisternMesh(m), x, z, y, 1.5, 0.05, { water: 0.2 })
      attachBarrelDrink(build, 'Cistern')
      deps.hud.whisper('Barrel open to the sky. Patience fills it.')
    },
  })

  /**
   * The bottle trap — fishing that works while you don't. Set it in wading
   * water and the tide swims the catch in; Check it when you pass again.
   */
  function attachTrapCheck(build: Build) {
    const item = deps.interactions.add({
      position: build.object.position,
      verb: 'Check',
      label: 'Fish trap',
      radius: 2.7,
      available: () => deps.vitals.alive,
      use: () => {
        const n = build.fish ?? 0
        if (n <= 0) {
          deps.hud.whisper('Nothing yet. The tide works slow.')
          return
        }
        build.fish = 0
        deps.grantFish(n)
        const stock = build.object.getObjectByName('trapStock')
        if (stock) stock.visible = false
        deps.hud.whisper(
          n > 1
            ? 'Two fish knocking about in the bottle. Breakfast and a spare.'
            : 'A fish in the trap. It stops being hungry work today.',
        )
      },
    })
    build.items.push(item)
  }

  addCamp('camp', {
    position: trapPos,
    verb: 'Set',
    label: 'Fish trap',
    cost: TRAP_COST,
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      // Swimming or wading the wash — anywhere the tide can reach the bottle
      !onLand &&
      trapSpotValid &&
      deps.salvage.has(TRAP_COST) &&
      clearOfBuilds(trapPos.x, trapPos.z, 1.6) &&
      !nearestOfKind(trapPos.x, trapPos.z, 'trap', 3.2),
    use: () => {
      if (!deps.salvage.spend(TRAP_COST)) return
      const x = trapPos.x
      const z = trapPos.z
      const y = deps.groundAt(x, z)
      const build = addBuild('trap', trapMesh(m), x, z, y, 1.6, 0, { fish: 0 })
      build.object.position.set(x, trapPos.y, z)
      attachTrapCheck(build)
      tap('splash', 0.4)
      deps.hud.whisper('The trap rides the wash. Check it when the tide has worked.')
    },
  })

  // Fashion a rod — plank + rope. Cast from shore into schools you can see.
  addCamp('camp', {
    position: leanPos,
    verb: 'Fashion',
    label: 'Fishing rod',
    cost: ROD_COST,
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      !(deps.hasRod?.() ?? false) &&
      deps.salvage.has(ROD_COST),
    use: () => {
      if (!deps.salvage.spend(ROD_COST)) return
      if (!deps.fashionRod?.()) {
        // Refund if already fashioned somehow
        deps.salvage.stash.plank += ROD_COST.plank ?? 0
        deps.salvage.stash.rope += ROD_COST.rope ?? 0
        return
      }
      tap('wood', 0.45)
      deps.hud.whisper('A crooked rod and a length of line. Cast from the shore.')
    },
  })

  // Lash a cast net — rope + fronds. Scoop the wash while wading.
  addCamp('camp', {
    position: leanPos,
    verb: 'Lash',
    label: 'Cast net',
    cost: NET_COST,
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      !(deps.hasNet?.() ?? false) &&
      deps.salvage.has(NET_COST),
    use: () => {
      if (!deps.salvage.spend(NET_COST)) return
      if (!deps.fashionNet?.()) {
        deps.salvage.stash.rope += NET_COST.rope ?? 0
        deps.salvage.stash.leaf += NET_COST.leaf ?? 0
        return
      }
      tap('lash', 0.45)
      deps.hud.whisper('Fronds lashed into a mesh. Scoop the wash while you wade.')
    },
  })

  // Dry-ground crate locker — the island answer to the raft hold
  addCamp('camp', {
    position: leanPos,
    verb: 'Lash',
    label: 'Crate',
    cost: CAMP_LOCKER_COST,
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 0.7 &&
      deps.salvage.has(CAMP_LOCKER_COST) &&
      clearOfBuilds(leanPos.x, leanPos.z, 1.7) &&
      !nearestOfKind(leanPos.x, leanPos.z, 'camp-locker', 4) &&
      // Prefer Set Barrel when you're standing at a frame that needs one
      !(nearestShelter(2.8) && !nearestShelter(2.8)?.hasBarrel && deps.salvage.has(SHELTER_BARREL_COST)),
    use: () => {
      if (!deps.salvage.spend(CAMP_LOCKER_COST)) return
      const x = leanPos.x
      const z = leanPos.z
      const y = deps.groundAt(x, z)
      addBuild('camp-locker', campLockerMesh(m), x, z, y, 1.6, 0.08, { hold: emptyHold() })
      deps.hud.whisper('Crate on dry sand. Stow what the swim cannot carry.')
    },
  })

  // Woodpile — stock planks for a long build without needing a crate
  addCamp('build', {
    position: leanPos,
    verb: 'Stack',
    label: 'Woodpile',
    cost: WOODPILE_COST,
    radius: REACH,
    available: () => {
      if (!deps.vitals.alive || carried || !deps.salvage.has(WOODPILE_COST)) return false
      if (!(onLand || onPlatformDeck)) return false
      if (onLand && groundY < 0.5) return false
      if (nearestOfKind(leanPos.x, leanPos.z, 'woodpile', 2.8)) return false
      for (const b of builds) {
        if (!blocksPlatform(b) || b.kind === 'woodpile') continue
        if (Math.hypot(b.x - leanPos.x, b.z - leanPos.z) < 1.2) return false
      }
      return true
    },
    use: () => {
      if (!deps.salvage.spend(WOODPILE_COST)) return
      const x = leanPos.x
      const z = leanPos.z
      const y = onPlatformDeck
        ? (platformAt(px, pz)?.deckY ?? deps.groundAt(x, z) + 0.08)
        : deps.groundAt(x, z)
      const hold = emptyHold()
      hold.plank = 1
      addBuild('woodpile', woodpileMesh(m, 1), x, z, y, 1.5, 0.05, { hold })
      deps.hud.whisper('A pile of sticks. Stow planks here — Fetch when the house needs them.')
      tap('wood', 0.55)
    },
  })

  deps.interactions.add({
    position: leanPos,
    verb: 'Stow',
    label: 'on pile',
    radius: 2.5,
    available: () => {
      const pile = nearestOfKind(px, pz, 'woodpile', 2.5)
      if (!pile?.hold || !deps.vitals.alive) return false
      if (deps.salvage.stash.plank <= 0) return false
      return (pile.hold.plank ?? 0) < WOODPILE_MAX
    },
    use: () => {
      const pile = nearestOfKind(px, pz, 'woodpile', 2.5)
      if (!pile?.hold) return
      const room = WOODPILE_MAX - pile.hold.plank
      if (room <= 0) return
      const move = Math.min(room, deps.salvage.stash.plank)
      deps.salvage.stash.plank -= move
      pile.hold.plank += move
      refitWoodpile(pile)
      deps.hud.whisper(
        move === 1 ? 'One plank on the pile.' : `${move} planks stacked. The pile grows.`,
      )
      tap('wood', 0.4)
    },
  })

  deps.interactions.add({
    position: leanPos,
    verb: 'Fetch',
    label: 'from pile',
    radius: 2.5,
    available: () => {
      const pile = nearestOfKind(px, pz, 'woodpile', 2.5)
      if (!pile?.hold || !deps.vitals.alive) return false
      return pile.hold.plank > 0
    },
    use: () => {
      const pile = nearestOfKind(px, pz, 'woodpile', 2.5)
      if (!pile?.hold) return
      // A handful at a time — leave the rest stacked for the next bay
      const take = Math.min(4, pile.hold.plank)
      deps.salvage.stash.plank += take
      pile.hold.plank -= take
      if (pile.hold.plank <= 0) {
        builds.splice(builds.indexOf(pile), 1)
        for (const item of pile.items) deps.interactions.remove(item)
        scene.remove(pile.object)
        disposeBuildObject(pile.object)
        deps.hud.whisper(
          take === 1 ? 'The last plank. The sand is bare again.' : `${take} planks — the pile is gone.`,
        )
      } else {
        refitWoodpile(pile)
        deps.hud.whisper(
          take === 1
            ? `One plank off the pile. ${pile.hold.plank} left.`
            : `${take} planks off the pile. ${pile.hold.plank} still stacked.`,
        )
      }
      tap('wood', 0.45)
    },
  })

  deps.interactions.add({
    position: leanPos,
    verb: 'Stow',
    label: 'in crate',
    radius: 2.5,
    available: () => {
      const locker = nearestOfKind(px, pz, 'camp-locker', 2.5)
      if (!locker?.hold || !deps.vitals.alive) return false
      const s = deps.salvage.stash
      return s.plank + s.barrel + s.crate + s.rope + s.canvas + s.plastic + s.can + s.leaf > 0
    },
    use: () => {
      const locker = nearestOfKind(px, pz, 'camp-locker', 2.5)
      if (!locker?.hold) return
      const s = deps.salvage.stash
      let moved = 0
      for (const k of Object.keys(s) as StashKind[]) {
        if (s[k] <= 0) continue
        locker.hold[k] += s[k]
        moved += s[k]
        s[k] = 0
      }
      if (moved <= 0) return
      deps.hud.whisper(
        moved === 1 ? 'One piece in the crate.' : `${moved} pieces stowed ashore.`,
      )
    },
  })

  deps.interactions.add({
    position: leanPos,
    verb: 'Fetch',
    label: 'from crate',
    radius: 2.5,
    available: () => {
      const locker = nearestOfKind(px, pz, 'camp-locker', 2.5)
      if (!locker?.hold || !deps.vitals.alive) return false
      return holdCount(locker.hold) > 0
    },
    use: () => {
      const locker = nearestOfKind(px, pz, 'camp-locker', 2.5)
      if (!locker?.hold) return
      const s = deps.salvage.stash
      let moved = 0
      for (const k of Object.keys(locker.hold) as StashKind[]) {
        if (locker.hold[k] <= 0) continue
        s[k] += locker.hold[k]
        moved += locker.hold[k]
        locker.hold[k] = 0
      }
      if (moved <= 0) return
      deps.hud.whisper(moved === 1 ? 'Back in the hands.' : 'The crate empties into your arms.')
    },
  })

  addCamp('camp', {
    position: firePos,
    verb: 'Kindle',
    label: 'Fire',
    cost: FIRE_COST,
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      !carried &&
      ((onLand && groundY > 0.6) || onRaftDeck || onPlatformDeck) &&
      deps.salvage.has(FIRE_COST) &&
      !nearestOfKind(firePos.x, firePos.z, 'fire', 3.5) &&
      clearForFire(firePos.x, firePos.z),
    use: () => {
      if (!deps.salvage.spend(FIRE_COST)) return
      const x = firePos.x
      const z = firePos.z
      const deck = onRaftDeck
        ? nearestOfKind(px, pz, 'raft', 3.2)?.deckY
        : onPlatformDeck
          ? platformAt(px, pz)?.deckY
          : undefined
      const y = (deck ?? deps.groundAt(x, z)) + (deck !== undefined ? 0.08 : 0)
      addBuild('fire', fireMesh(m), x, z, y, 2.4, 1.35)
      deps.hud.whisper(
        deck !== undefined ? 'Fire on the deck. Mind the planks.' : 'Smoke. Heat. Something like a camp.',
      )
    },
  })

  // Lift the fire as a brand — night walking, or to move camp. Fish still
  // hanging in the smoke keep it planted until you take them (or they finish).
  deps.interactions.add({
    position: takeFirePos,
    verb: 'Take',
    label: 'Fire',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive || carried) return false
      const fire = nearestOfKind(px, pz, 'fire', 2.6)
      if (!fire) return false
      if (fire.smoking?.length) return false
      return true
    },
    use: () => {
      const fire = nearestOfKind(px, pz, 'fire', 2.6)
      if (!fire || fire.smoking?.length) return
      const idx = builds.indexOf(fire)
      if (idx < 0) return
      builds.splice(idx, 1)
      scene.remove(fire.object)
      // Keep the planted mesh for restore; the viewmodel is the torch brand
      fire.object.visible = false
      carried = fire
      torch.visible = true
      deps.hud.whisper('A brand. Heat travels with you.')
    },
  })

  addCamp('camp', {
    position: plantFirePos,
    verb: 'Plant',
    label: 'Fire',
    radius: REACH,
    available: () =>
      !!carried &&
      deps.vitals.alive &&
      ((onLand && groundY > 0.6) || onRaftDeck || onPlatformDeck) &&
      clearForFire(plantFirePos.x, plantFirePos.z),
    use: () => {
      if (!carried) return
      const x = plantFirePos.x
      const z = plantFirePos.z
      const deck = onRaftDeck
        ? nearestOfKind(px, pz, 'raft', 3.2)?.deckY
        : onPlatformDeck
          ? platformAt(px, pz)?.deckY
          : undefined
      const y = (deck ?? deps.groundAt(x, z)) + (deck !== undefined ? 0.08 : 0)
      carried.x = x
      carried.z = z
      carried.deckY = y
      carried.object.position.set(x, y, z)
      carried.object.rotation.y = yaw
      carried.object.visible = true
      scene.add(carried.object)
      builds.push(carried)
      carried = null
      torch.visible = false
      deps.hud.whisper(
        onRaftDeck || onPlatformDeck ? 'Embers on the deck.' : 'Embers in the sand. Camp again.',
      )
    },
  })

  addCamp('camp', {
    position: catchPos,
    verb: 'Rig',
    label: 'Rain-catch',
    cost: CATCH_COST,
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 1.2 &&
      deps.salvage.has(CATCH_COST) &&
      clearOfBuilds(catchPos.x, catchPos.z, 2.4),
    use: () => {
      if (!deps.salvage.spend(CATCH_COST)) return
      const x = catchPos.x
      const z = catchPos.z
      const y = deps.groundAt(x, z)
      const build = addBuild('catch', catchMesh(m), x, z, y, 2.2, 0, { water: 0.55 })
      const drinkPos = build.object.position
      const drink = deps.interactions.add({
        position: drinkPos,
        verb: 'Drink',
        label: 'Rain-catch',
        radius: 2.6,
        available: () => deps.vitals.alive && (build.water ?? 0) > 0.08,
        use: () => {
          const left = build.water ?? 0
          if (left <= 0.08) return
          const sip = Math.min(0.35, left)
          build.water = left - sip
          eat(deps.vitals, 0, sip * 0.85)
          const waterMesh = build.object.getObjectByName('water')
          if (waterMesh) waterMesh.visible = (build.water ?? 0) > 0.05
          deps.hud.whisper(
            (build.water ?? 0) > 0.1 ? 'Cool. Flat. Better than the sea.' : 'The last of it.',
          )
        },
      })
      build.items.push(drink)
      deps.hud.whisper('Canvas bowls the rain. Patience does the rest.')
    },
  })

  // —— island workshop ————————————————————————————————————————
  addCamp('camp', {
    position: seatPos,
    verb: 'Lash',
    label: 'Seat',
    cost: SEAT_COST,
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 0.8 &&
      deps.salvage.has(SEAT_COST) &&
      clearOfBuilds(seatPos.x, seatPos.z, 1.6),
    use: () => {
      if (!deps.salvage.spend(SEAT_COST)) return
      const x = seatPos.x
      const z = seatPos.z
      addBuild('seat', seatMesh(m), x, z, deps.groundAt(x, z), 1.8, 0.15)
      deps.hud.whisper('A seat. The legs stop arguing.')
    },
  })

  deps.interactions.add({
    position: sitPos,
    verb: 'Sit',
    label: 'Seat',
    radius: 2.4,
    available: () =>
      deps.vitals.alive && onLand && time >= sitReadyAt && !!nearestOfKind(px, pz, 'seat', 2.2),
    use: () => {
      const seat = nearestOfKind(px, pz, 'seat', 2.2)
      if (!seat) return
      const v = deps.vitals
      v.stamina = Math.min(1, v.stamina + 0.42)
      v.warmth = Math.min(1, v.warmth + 0.05)
      sitReadyAt = time + 16
      sitPos.set(seat.x, seat.deckY + 0.5, seat.z)
      deps.hud.whisper(
        v.stamina > 0.85 ? 'Rested. The ground holds you a moment.' : 'Breath comes back. Slowly.',
      )
    },
  })

  addCamp('camp', {
    position: rackPos,
    verb: 'Lash',
    label: 'Drying rack',
    cost: RACK_COST,
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 0.8 &&
      deps.salvage.has(RACK_COST) &&
      clearOfBuilds(rackPos.x, rackPos.z, 1.8),
    use: () => {
      if (!deps.salvage.spend(RACK_COST)) return
      const x = rackPos.x
      const z = rackPos.z
      addBuild('rack', rackMesh(m), x, z, deps.groundAt(x, z), 2.0, 0, { smoking: [] })
      deps.hud.whisper('A rack. Hang fish — the air will do what fire does, slower.')
    },
  })

  deps.interactions.add({
    position: dryPos,
    verb: 'Hang',
    label: 'Fish',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive || deps.rawFish() <= 0) return false
      const rack = nearestOfKind(px, pz, 'rack', 2.6)
      if (!rack) return false
      return (rack.smoking?.length ?? 0) < DRY_MAX
    },
    use: () => {
      const rack = nearestOfKind(px, pz, 'rack', 2.6)
      if (!rack || !deps.takeRawForSmoke()) return
      if (!rack.smoking) rack.smoking = []
      const slot = rack.smoking.length
      const mesh = smokedFishMesh(m)
      mesh.position.set((slot - 1) * 0.32, 1.05, 0.05)
      rack.object.add(mesh)
      rack.smoking.push({ readyAt: time + DRY_TIME, mesh })
      deps.hud.whisper(slot === 0 ? 'Hung to dry. The wind works.' : 'Another on the rack.')
    },
  })

  deps.interactions.add({
    position: takeDryPos,
    verb: 'Take',
    label: 'Dried fish',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive) return false
      const rack = nearestOfKind(px, pz, 'rack', 2.6)
      if (!rack?.smoking?.length) return false
      return rack.smoking.some((s) => time >= s.readyAt)
    },
    use: () => {
      const rack = nearestOfKind(px, pz, 'rack', 2.6)
      if (!rack?.smoking) return
      const idx = rack.smoking.findIndex((s) => time >= s.readyAt)
      if (idx < 0) return
      const [done] = rack.smoking.splice(idx, 1)
      rack.object.remove(done.mesh)
      deps.addSmoked(1)
      deps.hud.whisper('Dried through. It will keep.')
    },
  })

  addCamp('camp', {
    position: signalPos,
    verb: 'Rig',
    label: 'Signal',
    cost: SIGNAL_COST,
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 1.5 &&
      deps.salvage.has(SIGNAL_COST) &&
      !nearestOfKind(signalPos.x, signalPos.z, 'signal', 40) &&
      clearOfBuilds(signalPos.x, signalPos.z, 2.0),
    use: () => {
      if (!deps.salvage.spend(SIGNAL_COST)) return
      const x = signalPos.x
      const z = signalPos.z
      addBuild('signal', signalMesh(m), x, z, deps.groundAt(x, z), 1.6, 0)
      deps.hud.whisper('Smoke on the ridge. You can read it from the water.')
    },
  })

  addCamp('raft', {
    position: raftPos,
    verb: 'Lash',
    label: 'Raft',
    cost: RAFT_COST,
    radius: REACH,
    available: () => {
      if (!deps.vitals.alive || !nearWaterline || carried) return false
      if (!clearOfBuilds(raftPos.x, raftPos.z, 3.5)) return false
      return deps.salvage.has(RAFT_COST)
    },
    use: () => {
      const withBarrel = deps.salvage.has(RAFT_BARREL_COST)
      const cost = withBarrel ? RAFT_BARREL_COST : RAFT_COST
      if (!deps.salvage.spend(cost)) return
      const x = raftPos.x
      const z = raftPos.z
      const sea = sampleOcean(x, z, time).y
      const radius = withBarrel ? 2.35 : 2.05
      addBuild('raft', raftMesh(m, withBarrel), x, z, sea + 0.22, radius, withBarrel ? 0.62 : 0.55, {
        buoyant: withBarrel,
        vx: 0,
        vz: 0,
        yaw,
        hold: emptyHold(),
      })
      deps.hud.whisper(
        withBarrel
          ? 'Barrels under planks. Climb aboard. Walk the deck — pole from the edge.'
          : 'Three planks and a lashing. Climb aboard — walk the deck, pole from the edge.',
      )
      tap('lash', 0.85)
    },
  })

  // Swim up, grab the gunwale, haul yourself onto the deck. The soft skirt
  // helps, but this is the sure verb when the swell keeps knocking you off.
  deps.interactions.add({
    position: climbPos,
    verb: 'Climb',
    label: 'Raft',
    radius: CLIMB_RANGE,
    available: () => {
      if (!deps.vitals.alive || !live || !swimming) return false
      const raft = nearestOfKind(px, pz, 'raft', CLIMB_RANGE)
      return !!raft
    },
    use: () => {
      if (!live) return
      const raft = nearestOfKind(px, pz, 'raft', CLIMB_RANGE)
      if (!raft) return
      live.mode = 'walk'
      live.x = raft.x
      live.z = raft.z
      live.y = raft.deckY + WALK_EYE
      live.vy = 0
      live.submersion = 0
      boardGrace = 1.4
      deps.hud.whisper('Hands on the gunwale. Up.')
      tap('wood', 0.7)
      tap('splash', 0.35)
    },
  })

  function nearestRaftOnDeck() {
    if (!onRaftDeck) return null
    return nearestOfKind(px, pz, 'raft', 3.2)
  }

  // Sit the stern thwart — the raft's built-in seat
  deps.interactions.add({
    position: thwartPos,
    verb: 'Sit',
    label: 'Thwart',
    radius: 2.2,
    available: () =>
      deps.vitals.alive &&
      onRaftDeck &&
      time >= sitReadyAt &&
      !!nearestRaftOnDeck() &&
      // Prefer a planted seat ashore when both are in reach
      !nearestOfKind(px, pz, 'seat', 2.0),
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft || !live) return
      const v = deps.vitals
      v.stamina = Math.min(1, v.stamina + 0.38)
      v.warmth = Math.min(1, v.warmth + 0.04)
      sitReadyAt = time + 14
      const seat = raftLocal(raft, 1.2, 0)
      live.x = seat.x
      live.z = seat.z
      live.y = raft.deckY + WALK_EYE * 0.72
      live.speed = 0
      thwartPos.set(seat.x, raft.deckY + 0.45, seat.z)
      deps.hud.whisper(
        raft.beached
          ? 'Thwart under you. The beach holds the hull.'
          : "Thwart under you. The deck moves, you don't.",
      )
    },
  })

  // Rest under the sail — a nap on the deck, not a full lean-to sleep
  deps.interactions.add({
    position: sailRestPos,
    verb: 'Rest',
    label: 'Under sail',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive || !onRaftDeck || time < restReadyAt) return false
      const raft = nearestRaftOnDeck()
      return !!raft && !!raft.mast && !raft.torn
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft || !raft.mast || raft.torn) return
      const v = deps.vitals
      if (v.food < 0.08 || v.water < 0.08) {
        deps.hud.whisper('Too empty to sleep.')
        return
      }
      const night = deps.daylight() < 0.38
      const nearFire =
        !!nearestOfKind(raft.x, raft.z, 'fire', raft.radius + 0.5) || !!carried
      let smokedDone = 0
      if (nearFire) {
        for (const b of builds) {
          if (b.kind !== 'fire' || !b.smoking?.length) continue
          if (Math.hypot(b.x - raft.x, b.z - raft.z) > raft.radius + 0.8) continue
          const left = b.smoking
          b.smoking = []
          for (const s of left) {
            b.object.remove(s.mesh)
            deps.addSmoked(1)
            smokedDone++
          }
        }
      }
      const hours = night ? 2.2 : NAP_HOURS * 0.85
      const seconds = (hours / 24) * DAY_LENGTH
      deps.skipTime(seconds)
      const storm = deps.storm?.() ?? 0
      const warmthGain =
        (night ? 0.28 : 0.14) + (nearFire ? 0.16 : 0) + (raft.rail ? 0.06 : 0) - storm * 0.08
      v.warmth = Math.min(1, Math.max(0, v.warmth + warmthGain))
      v.stamina = Math.min(1, v.stamina + 0.62)
      v.food = Math.max(0, v.food - hours * 0.04)
      v.water = Math.max(0, v.water - hours * 0.05)
      if (v.wounded) v.woundClock += hours * 28
      // A deck nap is thin sleep — it takes the edge off, no more
      rest(v, hours, 0.7)
      restReadyAt = time + (night ? 36 : REST_COOLDOWN)
      if (live) {
        const mid = raftLocal(raft, -0.2, 0)
        live.x = mid.x
        live.z = mid.z
        live.y = raft.deckY + WALK_EYE
        live.speed = 0
      }
      if (smokedDone > 0) {
        deps.hud.whisper(
          smokedDone > 1 ? 'Smoke finished while you slept. Fish for the road.' : 'Smoked fish waits in the Pack.',
        )
      } else if (night) {
        deps.hud.whisper(
          nearFire ? 'Dawn under canvas. Embers on the deck.' : 'Dawn. Canvas over you, sea under.',
        )
      } else {
        deps.hud.whisper(nearFire ? 'A nap by the deck fire.' : 'Eyes shut under the sail. Strength back.')
      }
    },
  })

  // Mend a sail the gale tore
  addCamp('raft', {
    position: mendPos,
    verb: 'Mend',
    label: 'Sail',
    cost: MEND_COST,
    radius: 2.8,
    available: () => {
      const raft = nearestRaftOnDeck()
      return !!raft && !!raft.torn && deps.vitals.alive && deps.salvage.has(MEND_COST)
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft || !raft.torn || !deps.salvage.spend(MEND_COST)) return
      raft.torn = false
      raft.failMeter = 0
      saidFail = false
      animateSail(raft.object, time, false)
      deps.hud.whisper('Needle and scrap. The canvas holds again.')
      tap('sail', 0.55)
      tap('lash', 0.4)
    },
  })

  // Haul the raft onto sand when the water shoals
  deps.interactions.add({
    position: beachPos,
    verb: 'Haul',
    label: 'Ashore',
    radius: 3.4,
    available: () => {
      if (!deps.vitals.alive) return false
      const raft = nearestOfKind(px, pz, 'raft', 4.2)
      if (!raft || raft.beached) return false
      // Need real ground under or beside the hull
      const under = deps.groundAt(raft.x, raft.z)
      if (under > 0.05) return true
      for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const hx = raft.x + Math.cos(a) * (raft.radius + 1.2)
        const hz = raft.z + Math.sin(a) * (raft.radius + 1.2)
        if (deps.groundAt(hx, hz) > 0.45) return true
      }
      return false
    },
    use: () => {
      const raft = nearestOfKind(px, pz, 'raft', 4.2)
      if (!raft || raft.beached) return
      // Pull toward the highest nearby sand
      let bestX = raft.x
      let bestZ = raft.z
      let bestH = deps.groundAt(raft.x, raft.z)
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2
        const hx = raft.x + Math.cos(a) * 2.4
        const hz = raft.z + Math.sin(a) * 2.4
        const h = deps.groundAt(hx, hz)
        if (h > bestH) {
          bestH = h
          bestX = hx
          bestZ = hz
        }
      }
      raft.x = bestX
      raft.z = bestZ
      raft.vx = 0
      raft.vz = 0
      raft.beached = true
      const sand = deps.groundAt(raft.x, raft.z)
      raft.deckY = beachedDeckY(sand, sampleOcean(raft.x, raft.z, time).y)
      raft.object.position.set(raft.x, raft.deckY, raft.z)
      raft.object.rotation.x = 0
      raft.object.rotation.z = 0
      if (live && (onRaftDeck || Math.hypot(live.x - raft.x, live.z - raft.z) < 4)) {
        live.x = raft.x
        live.z = raft.z
        live.y = raft.deckY + WALK_EYE
        live.mode = 'walk'
        live.submersion = 0
        boardGrace = 0.8
      }
      deps.hud.whisper('Hull on sand. She rests. Shove when you want the sea again.')
      tap('haul', 0.85)
      tap('wood', 0.5)
    },
  })

  deps.interactions.add({
    position: shovePos,
    verb: 'Shove',
    label: 'Off',
    radius: 3.4,
    available: () => {
      if (!deps.vitals.alive) return false
      const raft = nearestOfKind(px, pz, 'raft', 4.2)
      return !!raft && !!raft.beached
    },
    use: () => {
      const raft = nearestOfKind(px, pz, 'raft', 4.2)
      if (!raft || !raft.beached) return
      // Hunt water that covers the sand — island shelves are tall, so absolute
      // ground height is a liar; clearance against the live sea is the truth.
      let bestX = raft.x
      let bestZ = raft.z
      let bestScore = Infinity
      for (let r = 3; r <= 28; r += 1.5) {
        for (let i = 0; i < 20; i++) {
          const a = (i / 20) * Math.PI * 2
          const hx = raft.x + Math.cos(a) * r
          const hz = raft.z + Math.sin(a) * r
          const h = deps.groundAt(hx, hz)
          const seaY = sampleOcean(hx, hz, time).y
          const clear = beachClearance(h, seaY)
          // Prefer real water (negative clearance); then lower sand; then farther
          const score = clear * 8 + h * 0.05 - r * 0.04
          if (score < bestScore) {
            bestScore = score
            bestX = hx
            bestZ = hz
          }
        }
      }
      let dx = bestX - raft.x
      let dz = bestZ - raft.z
      let len = Math.hypot(dx, dz) || 1
      const wasAboard =
        !!live && Math.hypot(live.x - raft.x, live.z - raft.z) <= raft.radius * DECK_LIP + 0.4
      // Step seaward until water covers the sand, or we've pushed far enough
      let cleared = false
      for (let step = 0; step < 22; step++) {
        raft.x += (dx / len) * 1.85
        raft.z += (dz / len) * 1.85
        const h = deps.groundAt(raft.x, raft.z)
        const seaY = sampleOcean(raft.x, raft.z, time).y
        if (!cleared && beachClearance(h, seaY) <= SHOVE_CLEAR) {
          cleared = true
          // Keep going a touch past the first wet sample
          raft.x += (dx / len) * SHOVE_EXTRA
          raft.z += (dz / len) * SHOVE_EXTRA
          break
        }
        if (step === 3 || step === 8 || step === 14) {
          let redoX = raft.x
          let redoZ = raft.z
          let redoScore = Infinity
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2
            const hx = raft.x + Math.cos(a) * 5.5
            const hz = raft.z + Math.sin(a) * 5.5
            const hh = deps.groundAt(hx, hz)
            const ss = sampleOcean(hx, hz, time).y
            const score = beachClearance(hh, ss) * 8 - 0.08
            if (score < redoScore) {
              redoScore = score
              redoX = hx
              redoZ = hz
            }
          }
          dx = redoX - raft.x
          dz = redoZ - raft.z
          len = Math.hypot(dx, dz) || 1
        }
      }
      raft.vx = (dx / len) * 1.6
      raft.vz = (dz / len) * 1.6
      raft.beached = false
      shoveGrace = SHOVE_GRACE
      saidBeach = false
      const sea = sampleOcean(raft.x, raft.z, time)
      raft.deckY = sea.y + 0.22
      raft.object.position.set(raft.x, raft.deckY, raft.z)
      if (live && wasAboard) {
        live.x = raft.x
        live.z = raft.z
        live.y = raft.deckY + WALK_EYE
        live.mode = 'walk'
        live.submersion = 0
        boardGrace = 0.6
        onRaftDeck = true
      }
      deps.hud.whisper('Off the sand. Look down at the gunwale to pole her out.')
      tap('haul', 0.7)
      tap('splash', 0.55)
    },
  })

  // Drop the stone over the side — the set stops taking her while you work
  // the shallows (or sleep aboard). Weigh it when you mean to move again.
  addCamp('raft', {
    position: shovePos,
    verb: 'Drop',
    label: 'Anchor',
    radius: 3.4,
    available: () => {
      if (!deps.vitals.alive) return false
      const raft = nearestOfKind(px, pz, 'raft', 4.2)
      return !!raft && !raft.beached && !raft.anchored
    },
    use: () => {
      const raft = nearestOfKind(px, pz, 'raft', 4.2)
      if (!raft || raft.beached || raft.anchored) return
      raft.anchored = true
      raft.vx = 0
      raft.vz = 0
      fitAnchor(raft.object, m, true)
      deps.hud.whisper('A stone over the side, the line made fast. She holds.')
      tap('splash', 0.5)
      tap('lash', 0.4)
    },
  })

  addCamp('raft', {
    position: shovePos,
    verb: 'Weigh',
    label: 'Anchor',
    radius: 3.4,
    available: () => {
      if (!deps.vitals.alive) return false
      const raft = nearestOfKind(px, pz, 'raft', 4.2)
      return !!raft && !!raft.anchored
    },
    use: () => {
      const raft = nearestOfKind(px, pz, 'raft', 4.2)
      if (!raft || !raft.anchored) return
      raft.anchored = false
      fitAnchor(raft.object, m, false)
      deps.hud.whisper('Stone up. The sea has her again.')
      tap('splash', 0.4)
    },
  })

  // —— deck fittings —————————————————————————————————————————
  addCamp('raft', {
    position: raftFitPos,
    verb: 'Rig',
    label: 'Sail',
    cost: MAST_COST,
    radius: 2.8,
    available: () => {
      const raft = nearestRaftOnDeck()
      return !!raft && !raft.mast && deps.vitals.alive && deps.salvage.has(MAST_COST)
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft || !deps.salvage.spend(MAST_COST)) return
      raft.mast = true
      raft.shelter = Math.max(raft.shelter, raft.buoyant ? 0.78 : 0.7)
      fitMast(raft.object, m)
      deps.hud.whisper('Canvas on a yard. Take the stern and look down — the tiller steers her.')
      tap('sail', 0.7)
      tap('lash', 0.55)
    },
  })

  addCamp('raft', {
    position: raftFitPos,
    verb: 'Lash',
    label: 'Rail',
    cost: RAIL_COST,
    radius: 2.8,
    available: () => {
      const raft = nearestRaftOnDeck()
      return !!raft && !raft.rail && deps.vitals.alive && deps.salvage.has(RAIL_COST)
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft || !deps.salvage.spend(RAIL_COST)) return
      raft.rail = true
      raft.radius += 0.35
      raft.shelter = Math.max(raft.shelter, raft.shelter + 0.12)
      fitRail(raft.object, m)
      deps.hud.whisper('A rail. The deck keeps more of you.')
    },
  })

  addCamp('raft', {
    position: raftFitPos,
    verb: 'Lash',
    label: 'Locker',
    cost: LOCKER_COST,
    radius: 2.8,
    available: () => {
      const raft = nearestRaftOnDeck()
      return !!raft && !raft.locker && deps.vitals.alive && deps.salvage.has(LOCKER_COST)
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft || !deps.salvage.spend(LOCKER_COST)) return
      raft.locker = true
      if (!raft.hold) raft.hold = emptyHold()
      fitLocker(raft.object, m)
      deps.hud.whisper('A crate, lashed dry. Stow what you cannot swim with.')
    },
  })

  deps.interactions.add({
    position: stowPos,
    verb: 'Stow',
    label: 'Gear',
    radius: 2.6,
    available: () => {
      const raft = nearestRaftOnDeck()
      if (!raft?.locker || !deps.vitals.alive) return false
      const s = deps.salvage.stash
      return (
        s.plank + s.barrel + s.crate + s.rope + s.canvas + s.plastic + s.can + s.leaf > 0
      )
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft?.hold) return
      const s = deps.salvage.stash
      let moved = 0
      for (const k of Object.keys(s) as StashKind[]) {
        if (s[k] <= 0) continue
        raft.hold[k] += s[k]
        moved += s[k]
        s[k] = 0
      }
      if (moved <= 0) return
      deps.hud.whisper(
        moved === 1 ? 'One piece in the locker.' : `${moved} pieces stowed. The swim lightens.`,
      )
    },
  })

  deps.interactions.add({
    position: stowPos,
    verb: 'Fetch',
    label: 'Gear',
    radius: 2.6,
    available: () => {
      const raft = nearestRaftOnDeck()
      if (!raft?.locker || !raft.hold || !deps.vitals.alive) return false
      return holdCount(raft.hold) > 0
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft?.hold) return
      const s = deps.salvage.stash
      let moved = 0
      for (const k of Object.keys(raft.hold) as StashKind[]) {
        if (raft.hold[k] <= 0) continue
        s[k] += raft.hold[k]
        moved += raft.hold[k]
        raft.hold[k] = 0
      }
      if (moved <= 0) return
      deps.hud.whisper(moved === 1 ? 'Back in the hands.' : 'The locker empties into your arms.')
    },
  })

  deps.interactions.add({
    position: markPos,
    verb: 'Scratch',
    label: 'Stern',
    radius: 2.6,
    available: () => {
      const raft = nearestRaftOnDeck()
      return !!raft && !raft.marked && deps.vitals.alive && !!deps.hasMark?.()
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft) return
      raft.marked = true
      fitMark(raft.object, m)
      deps.hud.whisper("The Wanderer's mark. Your watch. Your deck.")
    },
  })

  addCamp('raft', {
    position: raftFitPos,
    verb: 'Lash',
    label: 'Deck',
    cost: EXPAND_COST,
    radius: 2.8,
    available: () => {
      const raft = nearestRaftOnDeck()
      return (
        !!raft &&
        (raft.expands ?? 0) < EXPAND_MAX &&
        deps.vitals.alive &&
        deps.salvage.has(EXPAND_COST)
      )
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft || !deps.salvage.spend(EXPAND_COST)) return
      raft.expands = (raft.expands ?? 0) + 1
      raft.radius += 0.38
      fitExpand(raft.object, m, raft.expands)
      deps.hud.whisper(
        raft.expands === 1
          ? 'Two more planks. The deck grows.'
          : raft.expands >= EXPAND_MAX
            ? 'As wide as the lashing will hold.'
            : 'Wider still. Room to work.',
      )
    },
  })

  addCamp('raft', {
    position: raftFitPos,
    verb: 'Lash',
    label: 'Oar',
    cost: OAR_COST,
    radius: 2.8,
    available: () => {
      const raft = nearestRaftOnDeck()
      return !!raft && !raft.oar && deps.vitals.alive && deps.salvage.has(OAR_COST)
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft || !deps.salvage.spend(OAR_COST)) return
      raft.oar = true
      fitOar(raft.object, m)
      deps.hud.whisper('An oar on the thwart. The pole has a partner.')
    },
  })

  addCamp('raft', {
    position: raftFitPos,
    verb: 'Lash',
    label: 'Floats',
    cost: FLOAT_COST,
    radius: 2.8,
    available: () => {
      const raft = nearestRaftOnDeck()
      return !!raft && !raft.floats && deps.vitals.alive && deps.salvage.has(FLOAT_COST)
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft || !deps.salvage.spend(FLOAT_COST)) return
      raft.floats = true
      raft.buoyant = true
      raft.shelter = Math.max(raft.shelter, raft.shelter + 0.08)
      fitFloat(raft.object, m)
      deps.hud.whisper('Bottles under the deck. She rides higher.')
    },
  })

  // Dig a hollow in soft sand — rain fills it the way rock pools do, slower.
  // F requires looking at the ground so it doesn't steal every beach prompt;
  // Pack → Camp skips the look-down gate (opening the menu is the intent).
  const digReady = () =>
    deps.vitals.alive &&
    onLand &&
    !carried &&
    groundY > 0.45 &&
    groundY < 3.2 &&
    clearOfBuilds(digPos.x, digPos.z, 1.8) &&
    !nearestOfKind(digPos.x, digPos.z, 'pit', 4)

  addCamp('camp', {
    position: digPos,
    verb: 'Dig',
    label: 'Hollow',
    radius: REACH,
    menuReady: digReady,
    available: () => digReady() && lookPitch <= DIG_LOOK_DOWN,
    use: () => {
      const x = digPos.x
      const z = digPos.z
      const y = deps.groundAt(x, z)
      const build = addBuild('pit', digPitMesh(m), x, z, y, 1.6, 0, { water: 0.15 })
      const drink = deps.interactions.add({
        position: build.object.position,
        verb: 'Drink',
        label: 'Hollow',
        radius: 2.4,
        available: () => deps.vitals.alive && (build.water ?? 0) > 0.1,
        use: () => {
          const left = build.water ?? 0
          if (left <= 0.1) return
          const sip = Math.min(0.28, left)
          build.water = left - sip
          eat(deps.vitals, 0, sip * 0.75)
          const waterMesh = build.object.getObjectByName('water')
          if (waterMesh) waterMesh.visible = (build.water ?? 0) > 0.08
          deps.hud.whisper(
            (build.water ?? 0) > 0.12 ? 'Brackish. Better than salt.' : 'Muddy dregs.',
          )
        },
      })
      build.items.push(drink)
      deps.hud.whisper('Sand under the nails. A hollow that will hold rain.')
    },
  })

  addCamp('camp', {
    position: dripPos,
    verb: 'Hang',
    label: 'Tin drip',
    cost: DRIP_COST,
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 0.8 &&
      deps.salvage.has(DRIP_COST) &&
      clearOfBuilds(dripPos.x, dripPos.z, 1.5),
    use: () => {
      if (!deps.salvage.spend(DRIP_COST)) return
      const x = dripPos.x
      const z = dripPos.z
      const y = deps.groundAt(x, z)
      const build = addBuild('drip', dripMesh(m), x, z, y, 1.4, 0, { water: 0.2 })
      const drink = deps.interactions.add({
        position: build.object.position,
        verb: 'Drink',
        label: 'Tin drip',
        radius: 2.3,
        available: () => deps.vitals.alive && (build.water ?? 0) > 0.08,
        use: () => {
          const left = build.water ?? 0
          if (left <= 0.08) return
          const sip = Math.min(0.22, left)
          build.water = left - sip
          eat(deps.vitals, 0, sip * 0.9)
          const waterMesh = build.object.getObjectByName('water')
          if (waterMesh) waterMesh.visible = (build.water ?? 0) > 0.06
          deps.hud.whisper(
            (build.water ?? 0) > 0.1 ? 'A mouthful from the tin.' : 'The tin runs dry.',
          )
        },
      })
      build.items.push(drink)
      deps.hud.whisper('A can on a stake. Rain will find it.')
    },
  })

  // —— carpentry: architect your own base ————————————————————————————
  // A platform is a floor tile snapped to a world grid — on sand, in the
  // wash, or on stilts over the shallows. Walls hang on tile edges (or stand
  // free as windbreaks), a door hangs where a wall would box you in, and a
  // roof over a closed-in tile turns it into somewhere you can Sleep.
  // Stand on a deck and face the next square to join another tile; a faint
  // ghost shows where the piece will land. Pack → Camp lists ready recipes
  // when the F-prompt is busy with something closer.

  const layPlatformItemRegistered = addCamp('build', {
    position: platPos,
    verb: 'Lay',
    label: 'Platform',
    cost: PLATFORM_COST,
    radius: REACH,
    priority: 0,
    available: canLayPlatform,
    use: () => {
      if (!deps.salvage.spend(PLATFORM_COST)) return
      const sx = platSnapX
      const sz = platSnapZ
      const ground = deps.groundAt(sx, sz)
      const sea = sampleOcean(sx, sz, time).y
      const overWater = ground <= sea - 0.3
      const deckY = overWater ? sea + PLATFORM_RISE_SEA : ground + PLATFORM_RISE_LAND
      addBuild('platform', platformMesh(m), sx, sz, deckY, 1.8, 0.18, { yaw: 0 })
      deps.hud.whisper(
        overWater
          ? 'Piles in the shallows. A deck over the water.'
          : platExpanding
            ? 'Joined. Face the next square to grow the floor.'
            : "Stilts and planks. A floor that isn't sand.",
      )
      tap('wood', 0.8)
      tap('lash', 0.5)
    },
  })
  layPlatformItem = layPlatformItemRegistered

  addCamp('build', {
    position: wallPos,
    verb: 'Raise',
    label: 'Wall',
    cost: WALL_COST,
    radius: REACH,
    available: canRaiseWall,
    use: () => {
      if (!deps.salvage.spend(WALL_COST)) return
      const tile = wallTargetTile()
      if (tile) {
        const side = tileSide(tile)
        const mid = tileEdgeMid(tile, side)
        addBuild('wall', wallMesh(m, false), mid.x, mid.z, tile.deckY, 1.6, 0, {
          yaw: side.dx !== 0 ? Math.PI / 2 : 0,
        })
        recomputeTileShelter(tile)
        deps.hud.whisper('A wall on the deck edge. The wind loses a way in.')
      } else {
        const x = wallPos.x
        const z = wallPos.z
        const y = deps.groundAt(x, z)
        const snapped = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2)
        addBuild('wall', wallMesh(m, false), x, z, y, 1.7, WALL_SHELTER, { yaw: snapped })
        deps.hud.whisper('A windbreak. Thin — but the gusts notice.')
      }
      tap('wood', 0.7)
      tap('lash', 0.45)
    },
  })

  addCamp('build', {
    position: wallPos,
    verb: 'Hang',
    label: 'Door',
    cost: DOOR_COST,
    radius: REACH,
    available: canHangDoor,
    use: () => {
      if (!deps.salvage.spend(DOOR_COST)) return
      const tile = wallTargetTile()
      if (!tile) return
      const side = tileSide(tile)
      const mid = tileEdgeMid(tile, side)
      addBuild('wall', wallMesh(m, true), mid.x, mid.z, tile.deckY, 1.6, 0, {
        yaw: side.dx !== 0 ? Math.PI / 2 : 0,
        variant: 'door',
      })
      recomputeTileShelter(tile)
      deps.hud.whisper('A door hung. In and out — and the wind, mostly out.')
      tap('wood', 0.7)
      tap('lash', 0.45)
    },
  })

  addCamp('build', {
    position: roofPos,
    verb: 'Pitch',
    label: 'Roof',
    cost: ROOF_COST,
    radius: REACH,
    available: canPitchRoof,
    use: () => {
      const tile = wallTargetTile()
      if (!tile || !deps.salvage.spend(ROOF_COST)) return
      addBuild('roof', roofMesh(m), tile.x, tile.z, tile.deckY + ROOF_RISE, 1.8, 0, { yaw: 0 })
      recomputeTileShelter(tile)
      const neighbours = [
        platformAt(tile.x + TILE, tile.z),
        platformAt(tile.x - TILE, tile.z),
        platformAt(tile.x, tile.z + TILE),
        platformAt(tile.x, tile.z - TILE),
      ].filter(Boolean)
      const roofedBay = neighbours.some((n) => n && tileRoof(n))
      deps.hud.whisper(
        roofedBay
          ? 'Another bay under cover. Keep joining decks — each lid its own planks and fronds.'
          : 'A lid on it. Rain sheds. Shade stays. Sleep if it’s closed in.',
      )
      tap('wood', 0.75)
      tap('lash', 0.4)
    },
  })

  // Teardown — every piece comes back to the arms. Freedom means rethinking.
  // Strike only announces itself when you're looking at the piece, so it can
  // never steal the prompt from Sleep / work verbs on a closed-in tile.
  const striking = (kind: BuildKind, dist: number) => {
    if (!deps.vitals.alive) return null
    const b = nearestOfKind(px, pz, kind, dist)
    if (!b || facingDot(b.x, b.z) < 0.35) return null
    return b
  }

  deps.interactions.add({
    position: strikePos,
    verb: 'Strike',
    label: 'Wall',
    radius: 2.7,
    available: () => !!striking('wall', 2.5),
    use: () => {
      const b = striking('wall', 2.5)
      if (!b) return
      strikeDown(b, WALL_COST, 'Struck. The planks come back to your arms.')
    },
  })

  deps.interactions.add({
    position: strikePos,
    verb: 'Strike',
    label: 'Roof',
    radius: 2.7,
    available: () => !striking('wall', 2.5) && !!striking('roof', 3.0),
    use: () => {
      const b = striking('roof', 3.0)
      if (!b) return
      strikeDown(b, ROOF_COST, 'The roof comes down. Materials back in hand.')
    },
  })

  deps.interactions.add({
    position: strikePos,
    verb: 'Strike',
    label: 'Platform',
    radius: 2.7,
    available: () => {
      if (striking('wall', 2.5) || striking('roof', 3.0)) return false
      const b = striking('platform', 2.5)
      if (!b) return false
      // Not from under your own feet, and not with pieces still on it
      if (platformAt(px, pz) === b) return false
      return tilePieces(b, 'wall').length === 0 && !tileRoof(b)
    },
    use: () => {
      const b = striking('platform', 2.5)
      if (!b) return
      strikeDown(b, PLATFORM_COST, 'The deck comes apart. Planks back in the arms.')
    },
  })

  // Swim up to a stilt deck and haul aboard — the same grab as the raft.
  deps.interactions.add({
    position: climbPlatPos,
    verb: 'Climb',
    label: 'Platform',
    radius: 3.6,
    available: () => {
      if (!deps.vitals.alive || !live || !swimming) return false
      const t = nearestOfKind(px, pz, 'platform', 3.0)
      if (!t) return false
      const sea = sampleOcean(px, pz, time).y
      return t.deckY - sea < 1.15
    },
    use: () => {
      if (!live) return
      const t = nearestOfKind(px, pz, 'platform', 3.0)
      if (!t) return
      live.mode = 'walk'
      live.x = t.x
      live.z = t.z
      live.y = t.deckY + WALK_EYE
      live.vy = 0
      live.submersion = 0
      boardGrace = 0.9
      deps.hud.whisper('Up onto the deck. Dry feet, and the sea below.')
      tap('wood', 0.7)
      tap('splash', 0.35)
    },
  })

  // Held fish — eat when nothing more urgent is in reach; cook at a fire.
  // The eat hotspot sits on the body, so without this gate it beats every
  // world prompt (lash, rest, …) on mobile.
  function craftPending() {
    if (carried) {
      return (
        (onLand && groundY > 0.6 && clearForFire(plantFirePos.x, plantFirePos.z)) ||
        ((onRaftDeck || onPlatformDeck) && clearForFire(plantFirePos.x, plantFirePos.z))
      )
    }
    // Carpentry ready suppresses the raw-fish prompt the same as any build
    if (canLayPlatform() || canRaiseWall() || canHangDoor() || canPitchRoof()) return true
    if (onRaftDeck) {
      const raft = nearestOfKind(px, pz, 'raft', 3.2)
      if (raft && !raft.mast && deps.salvage.has(MAST_COST)) return true
      if (raft && !raft.rail && deps.salvage.has(RAIL_COST)) return true
      if (raft && !raft.locker && deps.salvage.has(LOCKER_COST)) return true
      if (raft && !raft.oar && deps.salvage.has(OAR_COST)) return true
      if (raft && !raft.floats && deps.salvage.has(FLOAT_COST)) return true
      if (raft && (raft.expands ?? 0) < EXPAND_MAX && deps.salvage.has(EXPAND_COST)) return true
      if (deps.salvage.has(FIRE_COST)) return true
      return false
    }
    if (!onLand) {
      if (swimming && nearestOfKind(px, pz, 'raft', CLIMB_RANGE)) return true
      return nearWaterline && deps.salvage.has(RAFT_COST) && clearOfBuilds(raftPos.x, raftPos.z, 3.5)
    }
    if (groundY > 0.8 && deps.salvage.has(LEAN_COST) && clearOfBuilds(leanPos.x, leanPos.z, 2.2)) {
      return true
    }
    {
      const s = nearestShelter(2.8)
      if (s) {
        if ((s.sides ?? 0) < SIDE_MAX && deps.salvage.has(SIDE_COST)) return true
        if ((s.roof ?? 'none') === 'none') {
          if (deps.salvage.has(ROOF_LEAF_COST)) return true
          if (deps.salvage.has(ROOF_CANVAS_COST)) return true
          if (deps.salvage.has(ROOF_SCRAP_COST)) return true
        }
        if (!s.hasBarrel && deps.salvage.has(SHELTER_BARREL_COST)) return true
        if (shelterComplete(s) && !s.hasMat && deps.salvage.has(MAT_COST)) return true
        if (
          ((s.roof ?? 'none') === 'leaf' || (s.roof ?? 'none') === 'scrap') &&
          deps.salvage.has(ROOF_CANVAS_COST)
        ) {
          return true
        }
      } else if (
        groundY > 0.6 &&
        deps.salvage.has(CISTERN_COST) &&
        clearOfBuilds(leanPos.x, leanPos.z, 1.8)
      ) {
        return true
      }
      if (
        groundY > 0.7 &&
        deps.salvage.has(CAMP_LOCKER_COST) &&
        clearOfBuilds(leanPos.x, leanPos.z, 1.7)
      ) {
        return true
      }
    }
    if (groundY > 0.8 && deps.salvage.has(SEAT_COST) && clearOfBuilds(seatPos.x, seatPos.z, 1.6)) {
      return true
    }
    if (groundY > 0.8 && deps.salvage.has(RACK_COST) && clearOfBuilds(rackPos.x, rackPos.z, 1.8)) {
      return true
    }
    if (groundY > 0.8 && deps.salvage.has(DRIP_COST) && clearOfBuilds(dripPos.x, dripPos.z, 1.5)) {
      return true
    }
    if (
      groundY > 1.5 &&
      deps.salvage.has(SIGNAL_COST) &&
      !nearestOfKind(signalPos.x, signalPos.z, 'signal', 40) &&
      clearOfBuilds(signalPos.x, signalPos.z, 2.0)
    ) {
      return true
    }
    if (
      groundY > 0.6 &&
      deps.salvage.has(FIRE_COST) &&
      !nearestOfKind(firePos.x, firePos.z, 'fire', 3.5) &&
      clearForFire(firePos.x, firePos.z)
    ) {
      return true
    }
    if (groundY > 1.2 && deps.salvage.has(CATCH_COST) && clearOfBuilds(catchPos.x, catchPos.z, 2.4)) {
      return true
    }
    if (digReady() && lookPitch <= DIG_LOOK_DOWN) return true
    return nearWaterline && deps.salvage.has(RAFT_COST) && clearOfBuilds(raftPos.x, raftPos.z, 3.5)
  }

  deps.interactions.add({
    position: eatPos,
    verb: 'Eat',
    label: 'Raw fish',
    radius: 1.8,
    available: () =>
      deps.vitals.alive &&
      deps.rawFish() > 0 &&
      // Near a campfire, cook or smoke instead of eating raw
      !nearestOfKind(px, pz, 'fire', 10) &&
      !nearestOfKind(px, pz, 'lean-to', 2.4) &&
      !craftPending(),
    use: () => {
      if (!deps.eatRawFish()) return
      deps.hud.whisper('Raw fish. It stays down.')
    },
  })

  deps.interactions.add({
    position: cookPos,
    verb: 'Cook',
    label: 'Fish',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive || deps.rawFish() <= 0) return false
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire) return false
      // Hungry → cook now. Otherwise leave the prompt to Smoke when there's a rack slot.
      const hanging = fire.smoking?.length ?? 0
      if (deps.vitals.food >= 0.55 && hanging < SMOKE_MAX) return false
      return true
    },
    use: () => {
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire || !deps.cookFish()) return
      deps.vitals.warmth = Math.min(1, deps.vitals.warmth + 0.08)
      deps.hud.whisper(
        onRaftDeck ? 'Cooked on the deck. Heat and grease on the planks.' : 'Cooked through. Heat in the hands and the gut.',
      )
    },
  })

  deps.interactions.add({
    position: smokePos,
    verb: 'Smoke',
    label: 'Fish',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive || deps.rawFish() <= 0) return false
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire) return false
      const hanging = fire.smoking?.length ?? 0
      return hanging < SMOKE_MAX
    },
    use: () => {
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire || !deps.takeRawForSmoke()) return
      if (!fire.smoking) fire.smoking = []
      const slot = fire.smoking.length
      const mesh = smokedFishMesh(m)
      mesh.position.set((slot - 0.5) * 0.28, 0.85, 0.15)
      fire.object.add(mesh)
      fire.smoking.push({ readyAt: time + SMOKE_TIME, mesh })
      deps.hud.whisper(
        slot === 0 ? 'Hung in the smoke. Patience.' : 'Another in the smoke.',
      )
    },
  })

  deps.interactions.add({
    position: takeSmokePos,
    verb: 'Take',
    label: 'Smoked fish',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive) return false
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire?.smoking?.length) return false
      return fire.smoking.some((s) => time >= s.readyAt)
    },
    use: () => {
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire?.smoking) return
      const idx = fire.smoking.findIndex((s) => time >= s.readyAt)
      if (idx < 0) return
      const [done] = fire.smoking.splice(idx, 1)
      fire.object.remove(done.mesh)
      deps.addSmoked(1)
      deps.hud.whisper('Smoked through. It will keep.')
    },
  })

  /**
   * The shared sleep body — lean-to Rest and platform Sleep both run through
   * this. Night skips to dawn (the day counter turns); a nearby fire finishes
   * anything hanging in its smoke. Returns what happened so each caller can
   * whisper its own version of it.
   */
  function sleepThrough(opts: {
    at: { x: number; z: number }
    fireRadius: number
    warmthNight: number
    warmthDay: number
    warmthFire: number
    warmthExtra?: number
    /** How well the place sleeps — a walk-in hut beats a deck. */
    restQuality?: number
  }) {
    const v = deps.vitals
    const night = deps.daylight() < 0.38
    const nearFire = !!nearestOfKind(opts.at.x, opts.at.z, 'fire', opts.fireRadius) || !!carried
    let smokedDone = 0
    // Sleep finishes anything hanging in a nearby smoke rack
    if (nearFire) {
      for (const b of builds) {
        if (b.kind !== 'fire' || !b.smoking?.length) continue
        if (Math.hypot(b.x - opts.at.x, b.z - opts.at.z) > opts.fireRadius) continue
        const left = b.smoking
        b.smoking = []
        for (const s of left) {
          b.object.remove(s.mesh)
          deps.addSmoked(1)
          smokedDone++
        }
      }
    }
    let seconds: number
    let hours: number
    if (night) {
      seconds = Math.max(deps.secondsUntilDawn(), (1.5 / 24) * DAY_LENGTH)
      hours = (seconds / DAY_LENGTH) * 24
    } else {
      hours = NAP_HOURS
      seconds = (hours / 24) * DAY_LENGTH
    }

    deps.skipTime(seconds)

    // Shelter + optional fire do the warming; sleep itself mends the body.
    // Foul weather is when a roof earns its keep — more warmth back.
    const storm = deps.storm?.() ?? 0
    const foulBonus = storm > 0.35 ? 0.1 + storm * 0.18 : 0
    const warmthGain =
      (night ? opts.warmthNight : opts.warmthDay) +
      (nearFire ? opts.warmthFire : 0) +
      foulBonus +
      (opts.warmthExtra ?? 0)
    v.warmth = Math.min(1, v.warmth + warmthGain)
    v.stamina = Math.min(1, v.stamina + 0.75)
    v.food = Math.max(0, v.food - hours * 0.035)
    v.water = Math.max(0, v.water - hours * 0.045)
    if (v.wounded) v.woundClock += hours * 35
    // The tired timer only unwinds here — a nap takes the edge off, a night
    // under a real roof brings you back whole
    rest(v, hours, opts.restQuality ?? 1)

    restReadyAt = time + (night ? 40 : REST_COOLDOWN)
    return { night, nearFire, smokedDone, storm }
  }

  deps.interactions.add({
    position: restPos,
    verb: 'Rest',
    label: 'Shelter',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive || !onLand || time < restReadyAt) return false
      const s = leanToAt(px, pz)
      return !!s && shelterComplete(s)
    },
    use: () => {
      const shelter = leanToAt(px, pz)
      if (!shelter || !shelterComplete(shelter)) return
      const v = deps.vitals
      if (v.food < 0.1 || v.water < 0.1) {
        deps.hud.whisper('Too empty to sleep.')
        return
      }

      const { night, nearFire, smokedDone, storm } = sleepThrough({
        at: shelter,
        fireRadius: 4.5,
        warmthNight: 0.42,
        warmthDay: 0.22,
        warmthFire: 0.18,
        warmthExtra: shelter.hasMat ? 0.12 : 0,
        // Standing room and a soft mat are what sleep is measured in
        restQuality:
          (shelter.tall ? 1.12 : 1) + (shelter.hasMat ? 0.1 : 0) + ((shelter.rooms ?? 1) - 1) * 0.06,
      })
      restPos.set(shelter.x, shelter.deckY + 0.6, shelter.z)

      if (smokedDone > 0) {
        deps.hud.whisper(
          smokedDone > 1 ? 'The smoke rack is done. Fish for the road.' : 'Smoked fish waits in the Pack.',
        )
      } else if (night && storm > 0.55) {
        deps.hud.whisper(
          nearFire
            ? 'The gale works the canvas. Embers hold. Dawn.'
            : 'You rode the night out under plank. Dawn.',
        )
      } else if (night) {
        deps.hud.whisper(
          shelter.tall && (shelter.rooms ?? 1) > 1
            ? 'Dawn comes through the far room. Your own hall around you.'
            : shelter.tall
              ? 'Dawn, standing height and all. The hut holds.'
              : nearFire
                ? 'Dawn. Embers still warm the lean-to.'
                : 'Dawn finds you under plank and lashing.',
        )
      } else if (storm > 0.5) {
        deps.hud.whisper('You rest while the front works the roof.')
      } else {
        deps.hud.whisper(
          shelter.tall ? 'A nap on your own floor. The hours turn.' : 'You rest. The sun has moved.',
        )
      }
    },
  })

  // Sleep in a base you built yourself — a roofed, walled-in platform tile.
  // Same night skip as the lean-to: dawn comes, the day counter turns.
  deps.interactions.add({
    position: sleepPlatPos,
    verb: 'Sleep',
    label: 'Under roof',
    radius: 2.4,
    available: () => {
      if (!deps.vitals.alive || swimming || time < restReadyAt) return false
      const t = platformAt(px, pz)
      return !!t && !!tileRoof(t) && t.shelter >= SLEEP_SHELTER
    },
    use: () => {
      const tile = platformAt(px, pz)
      if (!tile || !tileRoof(tile) || tile.shelter < SLEEP_SHELTER) return
      const v = deps.vitals
      if (v.food < 0.1 || v.water < 0.1) {
        deps.hud.whisper('Too empty to sleep.')
        return
      }

      const { night, nearFire, smokedDone, storm } = sleepThrough({
        at: tile,
        fireRadius: 4,
        warmthNight: 0.38,
        warmthDay: 0.2,
        warmthFire: 0.15,
        warmthExtra: tile.shelter >= 0.85 ? 0.06 : 0,
        restQuality: tile.shelter >= 0.85 ? 1.15 : 1,
      })
      sleepPlatPos.set(tile.x, tile.deckY + 0.6, tile.z)

      if (smokedDone > 0) {
        deps.hud.whisper(
          smokedDone > 1 ? 'The smoke rack is done. Fish for the road.' : 'Smoked fish waits in the Pack.',
        )
      } else if (night && storm > 0.55) {
        deps.hud.whisper(
          nearFire
            ? 'The gale works the roof you pitched. Embers hold. Dawn.'
            : 'Walls you raised, a roof you pitched. The night passes. Dawn.',
        )
      } else if (night) {
        deps.hud.whisper(
          nearFire
            ? 'Dawn. Embers in the corner of a room you built.'
            : 'Dawn, under a roof of your own making.',
        )
      } else if (storm > 0.5) {
        deps.hud.whisper('You rest while the front works the roof you pitched.')
      } else {
        deps.hud.whisper('You rest. Your own roof over you.')
      }
    },
  })

  function setAnchor(out: THREE.Vector3, x: number, z: number, y: number) {
    out.set(x, y, z)
  }

  function update(
    dt: number,
    t: number,
    player: {
      x: number
      y: number
      z: number
      dirX: number
      dirZ: number
      mode: 'swim' | 'walk'
      vy: number
      submersion: number
      speed: number
      pitch?: number
    },
    view: PlayerFrame,
    facingYaw: number,
    intent?: { dive?: boolean },
  ) {
    time = t
    yaw = facingYaw
    lookPitch = player.pitch ?? 0
    px = player.x
    pz = player.z
    live = player
    swimming = !view.walking
    // Pole: look down at the water, or hold dive (mobile) while at the gunwale
    poleIntent = lookPitch <= POLE_LOOK_DOWN || !!intent?.dive
    onLand = view.walking && view.groundY > 0.3
    groundY = view.groundY
    if (shoveGrace > 0) shoveGrace = Math.max(0, shoveGrace - dt)
    {
      const raftNear = nearestOfKind(player.x, player.z, 'raft', 3.4)
      onRaftDeck =
        washGrace <= 0 &&
        view.walking &&
        !!raftNear &&
        Math.hypot(player.x - raftNear.x, player.z - raftNear.z) <= raftNear.radius * DECK_LIP
    }
    onPlatformDeck = view.walking && platformAt(player.x, player.z) !== null

    // After Climb, kill swim inertia and keep them seated for a beat
    if (boardGrace > 0) {
      boardGrace = Math.max(0, boardGrace - dt)
      player.speed = 0
      const raft = nearestOfKind(player.x, player.z, 'raft', CLIMB_RANGE)
      if (raft) {
        player.mode = 'walk'
        player.submersion = 0
        player.vy = 0
        if (Math.hypot(player.x - raft.x, player.z - raft.z) > raft.radius * 0.7) {
          player.x = raft.x
          player.z = raft.z
        }
        player.y = raft.deckY + WALK_EYE
        onRaftDeck = true
        swimming = false
      } else {
        // Hauled out onto a stilt platform
        const plat = platformAt(player.x, player.z, 1.6)
        if (plat) {
          player.mode = 'walk'
          player.submersion = 0
          player.vy = 0
          player.y = plat.deckY + WALK_EYE
          swimming = false
        }
      }
    }
    if (washGrace > 0) {
      washGrace = Math.max(0, washGrace - dt)
      player.mode = 'swim'
      onRaftDeck = false
      swimming = true
    }
    const ahead = offset(player, facingYaw, PLACE_AHEAD, 0)
    const fireAt = offset(player, facingYaw, 0.9, 0)
    const catchAt = offset(player, facingYaw, PLACE_AHEAD, 1.1)
    const raftAt = offset(player, facingYaw, 2.2, 0)
    const seatAt = offset(player, facingYaw, 1.2, 0.6)
    const rackAt = offset(player, facingYaw, 1.3, -0.7)
    const signalAt = offset(player, facingYaw, PLACE_AHEAD, 0)

    const aheadY = deps.groundAt(ahead.x, ahead.z)
    const fireY = deps.groundAt(fireAt.x, fireAt.z)
    const catchY = deps.groundAt(catchAt.x, catchAt.z)
    const seatY = deps.groundAt(seatAt.x, seatAt.z)
    const rackY = deps.groundAt(rackAt.x, rackAt.z)
    const signalY = deps.groundAt(signalAt.x, signalAt.z)

    if (onLand && aheadY > 0.3) setAnchor(leanPos, ahead.x, ahead.z, aheadY + 0.5)
    else if (onPlatformDeck) {
      const deck = platformAt(px, pz)?.deckY ?? player.y
      setAnchor(leanPos, ahead.x, ahead.z, deck + 0.35)
    } else setAnchor(leanPos, player.x, player.z, player.y)

    if ((onLand && fireY > 0.3) || onRaftDeck || onPlatformDeck) {
      const y = onRaftDeck
        ? (nearestOfKind(px, pz, 'raft', 3.2)?.deckY ?? player.y) + 0.35
        : onPlatformDeck
          ? (platformAt(px, pz)?.deckY ?? player.y) + 0.35
          : fireY + 0.3
      setAnchor(firePos, fireAt.x, fireAt.z, y)
      setAnchor(plantFirePos, fireAt.x, fireAt.z, y)
    } else {
      setAnchor(firePos, player.x, player.z, player.y)
      setAnchor(plantFirePos, player.x, player.z, player.y)
    }

    if (onLand && catchY > 0.3) setAnchor(catchPos, catchAt.x, catchAt.z, catchY + 0.5)
    else setAnchor(catchPos, player.x, player.z, player.y)

    if (onLand && seatY > 0.5) setAnchor(seatPos, seatAt.x, seatAt.z, seatY + 0.4)
    else setAnchor(seatPos, player.x, player.z, player.y)

    if (onLand && rackY > 0.5) setAnchor(rackPos, rackAt.x, rackAt.z, rackY + 0.45)
    else setAnchor(rackPos, player.x, player.z, player.y)

    if (onLand && signalY > 1.2) setAnchor(signalPos, signalAt.x, signalAt.z, signalY + 0.6)
    else setAnchor(signalPos, player.x, player.z, player.y)

    const digAt = offset(player, facingYaw, 1.1, 0)
    const digY = deps.groundAt(digAt.x, digAt.z)
    if (onLand && digY > 0.3) setAnchor(digPos, digAt.x, digAt.z, digY + 0.35)
    else setAnchor(digPos, player.x, player.z, player.y)

    const dripAt = offset(player, facingYaw, 1.15, 0.55)
    const dripY = deps.groundAt(dripAt.x, dripAt.z)
    if (onLand && dripY > 0.5) setAnchor(dripPos, dripAt.x, dripAt.z, dripY + 0.45)
    else setAnchor(dripPos, player.x, player.z, player.y)

    // Trap anchor — ahead in the shallows. Depth is read against the mean
    // sea, not the swell: a trough is a moment, the tide is what fills it.
    const trapAt = offset(player, facingYaw, 2.0, 0)
    const trapGround = deps.groundAt(trapAt.x, trapAt.z)
    const trapSea = sampleOcean(trapAt.x, trapAt.z, t).y
    trapSpotValid = trapGround > -1.45 && trapGround < -0.35
    setAnchor(trapPos, trapAt.x, trapAt.z, trapSea + 0.05)

    // —— carpentry anchors ———————————————————————————————————
    // Platform snaps to the world tile grid; walls hang on tile edges when a
    // tile is in reach, else stand free where you face. Standing on a deck
    // always aims the next empty neighbour you're facing so rooms grow cleanly.
    const platAt = offset(player, facingYaw, 1.9, 0)
    const snap = resolvePlatformSnap(platAt.x, platAt.z)
    platSnapX = snap.x
    platSnapZ = snap.z
    platExpanding = snap.expanding
    platGround = deps.groundAt(platSnapX, platSnapZ)
    platSea = sampleOcean(platSnapX, platSnapZ, t).y
    // Prompt sits on the near edge when expanding so Lay beats Raise Wall
    if (platExpanding) {
      const under = platformAt(px, pz) ?? nearestOfKind(px, pz, 'platform', TILE * 1.35)
      if (under) {
        setAnchor(
          platPos,
          (under.x + platSnapX) * 0.5,
          (under.z + platSnapZ) * 0.5,
          Math.max(under.deckY + 0.5, platGround + 0.6, platSea + 0.7),
        )
      } else {
        setAnchor(
          platPos,
          platSnapX,
          platSnapZ,
          Math.max(platGround + 0.6, platSea + 0.7),
        )
      }
    } else {
      setAnchor(
        platPos,
        platSnapX,
        platSnapZ,
        Math.max(platGround + 0.6, platSea + 0.7),
      )
    }
    layPlatformItem && (layPlatformItem.priority = platExpanding && canLayPlatform() ? 2.6 : 0)
    const wallAt = offset(player, facingYaw, 1.5, 0)
    setAnchor(wallPos, wallAt.x, wallAt.z, deps.groundAt(wallAt.x, wallAt.z) + 1.0)
    {
      const tile = wallTargetTile()
      if (tile) {
        const mid = tileEdgeMid(tile, tileSide(tile))
        setAnchor(wallPos, mid.x, mid.z, tile.deckY + 1.0)
        setAnchor(roofPos, tile.x, tile.z, tile.deckY + ROOF_RISE + 0.35)
        setAnchor(sleepPlatPos, tile.x, tile.z, tile.deckY + 0.6)
      } else {
        setAnchor(roofPos, wallAt.x, wallAt.z, deps.groundAt(wallAt.x, wallAt.z) + 2.3)
        sleepPlatPos.copy(eatPos)
      }
    }
    {
      const struck =
        nearestOfKind(player.x, player.z, 'wall', 2.5) ??
        nearestOfKind(player.x, player.z, 'roof', 3.0) ??
        nearestOfKind(player.x, player.z, 'platform', 2.5)
      if (struck) setAnchor(strikePos, struck.x, struck.z, struck.deckY + 0.9)
      else strikePos.copy(eatPos)
      const plat = nearestOfKind(player.x, player.z, 'platform', 3.0)
      if (plat) setAnchor(climbPlatPos, plat.x, plat.z, plat.deckY + 0.4)
      else climbPlatPos.copy(eatPos)
    }

    updateCarpentryGhost()

    const foot = deps.groundAt(player.x, player.z)
    const seaHere = sampleOcean(player.x, player.z, t).y
    // Wading a beach/spire edge, or swimming at the surface anywhere — a raft
    // is something you lash in the water, not only where the mesh shelves.
    nearWaterline =
      (view.walking && foot > -0.2 && foot < 1.6) ||
      (!view.walking && view.submersion < 0.55 && player.y > seaHere - 0.8)

    const raftSea = sampleOcean(raftAt.x, raftAt.z, t).y
    setAnchor(raftPos, raftAt.x, raftAt.z, Math.max(raftSea, foot) + 0.25)
    void seaHere

    eatPos.set(player.x, player.y - 0.2, player.z)

    const nearRaft = nearestOfKind(player.x, player.z, 'raft', CLIMB_RANGE)
    if (nearRaft) {
      climbPos.set(nearRaft.x, nearRaft.deckY + 0.4, nearRaft.z)
      raftFitPos.set(nearRaft.x, nearRaft.deckY + 0.55, nearRaft.z)
      stowPos.set(nearRaft.x + 0.55, nearRaft.deckY + 0.5, nearRaft.z - 0.55)
      markPos.set(nearRaft.x + 1.2, nearRaft.deckY + 0.5, nearRaft.z)
      const thwart = raftLocal(nearRaft, 1.25, 0)
      thwartPos.set(thwart.x, nearRaft.deckY + 0.45, thwart.z)
      const underSail = raftLocal(nearRaft, -0.35, 0)
      sailRestPos.set(underSail.x, nearRaft.deckY + 0.7, underSail.z)
      mendPos.set(underSail.x, nearRaft.deckY + 0.65, underSail.z)
      beachPos.set(nearRaft.x, nearRaft.deckY + 0.35, nearRaft.z)
      shovePos.set(nearRaft.x, nearRaft.deckY + 0.35, nearRaft.z)
    } else {
      climbPos.copy(eatPos)
      raftFitPos.copy(eatPos)
      stowPos.copy(eatPos)
      markPos.copy(eatPos)
      thwartPos.copy(eatPos)
      sailRestPos.copy(eatPos)
      mendPos.copy(eatPos)
      beachPos.copy(eatPos)
      shovePos.copy(eatPos)
    }

    const fire = nearestOfKind(player.x, player.z, 'fire', 2.8)
    if (fire) {
      takeFirePos.set(fire.x, fire.deckY + 0.45, fire.z)
      cookPos.set(fire.x, fire.deckY + 0.5, fire.z)
      // Prefer a clear side offset so Cook and Smoke don't share one spot
      smokePos.set(fire.x + 0.55, fire.deckY + 0.55, fire.z + 0.35)
      takeSmokePos.set(fire.x - 0.4, fire.deckY + 0.55, fire.z - 0.35)
    } else {
      takeFirePos.copy(eatPos)
      cookPos.copy(eatPos)
      smokePos.copy(eatPos)
      takeSmokePos.copy(eatPos)
    }

    const lean = leanToAt(player.x, player.z)
    if (lean) restPos.set(lean.x, lean.deckY + 0.6, lean.z)
    else restPos.copy(eatPos)

    const seat = nearestOfKind(player.x, player.z, 'seat', 2.2)
    if (seat) sitPos.set(seat.x, seat.deckY + 0.5, seat.z)
    else sitPos.copy(eatPos)

    const rack = nearestOfKind(player.x, player.z, 'rack', 2.6)
    if (rack) {
      dryPos.set(rack.x + 0.4, rack.deckY + 0.7, rack.z)
      takeDryPos.set(rack.x - 0.35, rack.deckY + 0.7, rack.z)
    } else {
      dryPos.copy(eatPos)
      takeDryPos.copy(eatPos)
    }

    // Dive with a brand and the sea takes it — diegetic, no inventory slot
    if (carried && view.submersion > 0.72) {
      disposeBuildObject(carried.object)
      carried = null
      torch.visible = false
      deps.hud.whisper('The brand hisses out in the water.')
    }

    // Torch viewmodel — soft sway with the walk / swim effort
    if (carried && torch.visible) {
      const sway = Math.sin(t * 5.5) * 0.012 * (0.4 + view.speed * 0.15)
      const bob = Math.sin(t * 7.2) * 0.01
      torchSway.set(sway, bob, 0)
      torch.position.copy(torchBase).add(torchSway)
      torch.rotation.set(0.35 + bob * 2, -0.25, 0.15 + sway * 3)
      animateFire(torch, t, 2.1, deps.daylight())
    } else if (!carried) {
      // Keep dormant brand lights from leaking into the night
      const key = torch.getObjectByName('fireLight') as THREE.PointLight | undefined
      const fill = torch.getObjectByName('fireFill') as THREE.PointLight | undefined
      if (key) key.intensity = 0
      if (fill) fill.intensity = 0
    }

    for (const b of builds) {
      if (b.kind === 'raft') {
        const prevX = b.x
        const prevZ = b.z
        const deckDist = Math.hypot(player.x - b.x, player.z - b.z)
        // Aboard = feet on the real deck. Soft skirt still props the walker for
        // slope probes, but past the lip you're swimming — Climb to get back.
        const aboard =
          washGrace <= 0 &&
          (boardGrace > 0 || view.walking) &&
          deckDist <= b.radius * DECK_LIP
        // Pole from the gunwale — look down (or hold dive) so walk ≠ thrust.
        const atGunwale = aboard && !b.beached && deckDist >= b.radius * POLE_GUNWALE
        const poling =
          atGunwale && poleIntent && view.speed > 0.35 && boardGrace <= 0
        if (atGunwale && view.speed > 0.4 && !poleIntent && !saidPoleHint && aboard) {
          saidPoleHint = true
          deps.hud.whisper('Look down to pole — or hold dive on a phone.')
        }

        // The helm: stand aft by the thwart with canvas up, and the same
        // look-down (or held dive) that poles a bare raft steers her under
        // sail — faster than the pole, and it goes where you look.
        const headingNow = b.yaw ?? b.object.rotation.y
        const helmS = Math.sin(headingNow)
        const helmC = Math.cos(headingNow)
        const helmLX = (player.x - b.x) * helmC - (player.z - b.z) * helmS
        const atHelm =
          aboard && !b.beached && !!b.mast && !b.torn && !b.anchored && helmLX > HELM_STERN_X
        const sailing = atHelm && poleIntent && view.speed > 0.35 && boardGrace <= 0
        if (
          atHelm &&
          view.speed > 0.4 &&
          !poleIntent &&
          !saidHelmHint &&
          !sailing &&
          !poling
        ) {
          saidHelmHint = true
          deps.hud.whisper('The tiller. Look down and push — the sail will take her where you look.')
        }

        // Ran aground — sand above the live sea sticks the hull. Soft wash
        // only when nearly stopped. Shove grace keeps a push from snapping back.
        // An anchored hull doesn't stick either — the stone holds her off the set.
        if (!b.beached && !b.anchored && shoveGrace <= 0) {
          const ground = deps.groundAt(b.x, b.z)
          const seaY = sampleOcean(b.x, b.z, t).y
          const clear = beachClearance(ground, seaY)
          const speed = Math.hypot(b.vx ?? 0, b.vz ?? 0)
          if (clear > BEACH_HARD_CLEAR || (clear > BEACH_SOFT_CLEAR && speed < 0.28 && aboard)) {
            b.beached = true
            b.vx = 0
            b.vz = 0
            // Ease onto higher sand so she doesn't sit half in the wash
            let bestX = b.x
            let bestZ = b.z
            let bestH = ground
            for (let i = 0; i < 8; i++) {
              const a = (i / 8) * Math.PI * 2
              const hx = b.x + Math.cos(a) * 1.8
              const hz = b.z + Math.sin(a) * 1.8
              const h = deps.groundAt(hx, hz)
              if (h > bestH) {
                bestH = h
                bestX = hx
                bestZ = hz
              }
            }
            if (bestH > ground + 0.12) {
              b.x = bestX
              b.z = bestZ
            }
            if (!saidBeach) {
              saidBeach = true
              deps.hud.whisper('Sand under the planks. Shove off when you want deep water.')
            }
          }
        }

        let top = b.buoyant ? POLE_SPEED_BARREL : POLE_SPEED
        if (b.oar) top += POLE_OAR_BONUS
        if (b.floats) top += POLE_FLOAT_BONUS
        const helmTop =
          (b.buoyant ? SAIL_HELM_BARREL : SAIL_HELM_SPEED) +
          (b.oar ? POLE_OAR_BONUS : 0) +
          (b.floats ? POLE_FLOAT_BONUS : 0)
        let vx = b.vx ?? 0
        let vz = b.vz ?? 0
        if (b.beached || b.anchored) {
          vx = 0
          vz = 0
        } else if (sailing) {
          // Helmed under canvas — the tiller puts the wind where you aim it
          const aimX = player.dirX
          const aimZ = player.dirZ
          const blend = 1 - Math.exp(-(b.oar ? 2.9 : 2.2) * dt)
          vx += (aimX * helmTop - vx) * blend
          vz += (aimZ * helmTop - vz) * blend
          if (!saidHelm && Math.hypot(vx, vz) > 0.6) {
            saidHelm = true
            deps.hud.whisper('Hands on the tiller. Canvas draws, and she answers.')
            tap('sail', 0.5)
          }
        } else if (poling) {
          const aimX = player.dirX
          const aimZ = player.dirZ
          // Oar bites harder into a new heading
          const blend = 1 - Math.exp(-(b.oar ? 3.4 : 2.4) * dt)
          vx += (aimX * top - vx) * blend
          vz += (aimZ * top - vz) * blend
          if (!saidPole && Math.hypot(vx, vz) > 0.4) {
            saidPole = true
            deps.hud.whisper(b.oar ? 'The oar finds water.' : 'The deck answers the pole.')
          }
          if (b.oar && !saidOar && Math.hypot(vx, vz) > 0.9) {
            saidOar = true
            deps.hud.whisper('Blade and shaft. She turns when you ask.')
          }
        } else if (b.mast && aboard && !b.torn) {
          // Sail draws while you're aboard — idle if torn or overboard
          const sail = b.buoyant ? SAIL_SPEED_BARREL : SAIL_SPEED
          const draw = 1 - Math.exp(-0.55 * dt)
          vx += (WIND.x * sail - vx) * draw * 0.65
          vz += (WIND.z * sail - vz) * draw * 0.65
          if (!saidSail && Math.hypot(vx, vz) > 0.35) {
            saidSail = true
            deps.hud.whisper('Canvas fills. The raft finds a heading.')
          }
        } else {
          // Empty / unmanned: bleed speed faster so she doesn't keep circling
          const drag = Math.exp(-(aboard ? 1.15 : 2.1) * dt)
          vx *= drag
          vz *= drag
        }
        // Soft water drag always — even under sail / pole
        const waterDrag = Math.exp(-0.15 * dt)
        vx *= waterDrag
        vz *= waterDrag

        // Shallow shelf drag while still free — wash fights you, but you can
        // still pole back out (auto-beach only sticks when nearly stopped).
        if (!b.beached) {
          const shelf = deps.groundAt(b.x, b.z)
          const seaHere = sampleOcean(b.x, b.z, t).y
          const clear = beachClearance(shelf, seaHere)
          if (clear > -0.05 && clear < BEACH_HARD_CLEAR) {
            const shelfDrag = Math.exp(-(0.55 + clear * 2.4) * dt)
            vx *= shelfDrag
            vz *= shelfDrag
          }
        }

        // Current carries the deck. Poling fights it; an empty raft goes with
        // the set. Beached or anchored hulls ignore the set entirely.
        const set = deps.current?.()
        const carry =
          b.beached || b.anchored || !set || set.strength <= 1e-4
            ? 0
            : poling || sailing
              ? 0.35
              : aboard && b.mast && !b.torn
                ? 0.5
                : 0.85

        b.vx = vx
        b.vz = vz
        if (!b.beached) {
          b.x += vx * dt + (set ? set.x * carry * dt : 0)
          b.z += vz * dt + (set ? set.z * carry * dt : 0)
        }

        const sea = sampleOcean(b.x, b.z, t)
        const groundHere = deps.groundAt(b.x, b.z)
        if (b.beached) {
          b.deckY = beachedDeckY(groundHere, sea.y)
          b.object.position.set(b.x, b.deckY, b.z)
        } else {
          b.deckY = sea.y + 0.22
          b.object.position.set(b.x, b.deckY, b.z)
        }

        // Steer only while poling or helmed — residual drift must not chase a
        // heading (that, plus Euler rock, was the spin-in-circles bug).
        let heading = b.yaw ?? b.object.rotation.y
        if ((poling || sailing) && Math.hypot(vx, vz) > 0.12) {
          const want = Math.atan2(-vx, -vz)
          let dyaw = want - heading
          while (dyaw > Math.PI) dyaw -= Math.PI * 2
          while (dyaw < -Math.PI) dyaw += Math.PI * 2
          const yawRate = b.oar ? 1.85 : 1.2
          heading += dyaw * (1 - Math.exp(-yawRate * dt))
        }
        b.yaw = heading
        b.object.rotation.order = 'YXZ'
        b.object.rotation.y = heading
        if (b.beached) {
          b.object.rotation.x = 0.04
          b.object.rotation.z = -0.02
        } else {
          b.object.rotation.x = sea.normal.z * 0.35
          b.object.rotation.z = -sea.normal.x * 0.35
        }
        if (b.mast) animateSail(b.object, t, !!b.torn)

        // Soft fail — a gale works the sail; locker can take a sea
        if (aboard && boardGrace <= 0 && !b.beached && b.mast && !b.torn) {
          const storm = deps.storm?.() ?? 0
          if (storm > FAIL_STORM_GATE) {
            const rate =
              FAIL_RATE * ((storm - FAIL_STORM_GATE) / Math.max(0.05, 1 - FAIL_STORM_GATE))
            b.failMeter = Math.min(1, (b.failMeter ?? 0) + rate * dt)
            if ((b.failMeter ?? 0) > 0.55 && !saidFail) {
              saidFail = true
              deps.hud.whisper('The sail cracks like a whip. Hold the sheet.')
            }
            if ((b.failMeter ?? 0) >= 1) {
              b.torn = true
              b.failMeter = 0
              saidFail = false
              animateSail(b.object, t, true)
              deps.hud.whisper('Canvas tears. Mend it when you can.')
              tap('sail', 0.95)
              // Locker floods if one is lashed — light gear goes
              if (b.locker && b.hold && !b.flooded) {
                b.flooded = true
                let lost = 0
                for (const k of ['leaf', 'plastic', 'can', 'rope'] as const) {
                  if ((b.hold[k] ?? 0) > 0) {
                    const n = Math.min(b.hold[k], k === 'rope' ? 1 : 2)
                    b.hold[k] -= n
                    lost += n
                  }
                }
                if (lost > 0) {
                  deps.hud.whisper('Seas in the locker. Something light is gone.')
                } else {
                  deps.hud.whisper('Seas in the locker. The hold runs wet.')
                }
              }
            }
          } else {
            b.failMeter = Math.max(0, (b.failMeter ?? 0) - dt * 0.15)
            if ((b.failMeter ?? 0) < 0.3) saidFail = false
          }
        }

        if (aboard) {
          player.x += b.x - prevX
          player.z += b.z - prevZ
          // Keep feet on the deck while boarding; free walk after
          if (boardGrace > 0) {
            const d = Math.hypot(player.x - b.x, player.z - b.z)
            if (d > b.radius * 0.7) {
              player.x = b.x
              player.z = b.z
            }
          } else {
            // Soft clamp inside the lip so micro-overshoot doesn't drop you
            const d = Math.hypot(player.x - b.x, player.z - b.z)
            const lip = b.radius * DECK_LIP
            if (d > lip) {
              // Still pushing out hard → over the side; else stay aboard
              const outX = (player.x - b.x) / (d || 1)
              const outZ = (player.z - b.z) / (d || 1)
              const outward = player.dirX * outX + player.dirZ * outZ
              if (view.speed > 0.55 && outward > 0.35) {
                const shoreY = deps.groundAt(
                  b.x + outX * (b.radius + 1.1),
                  b.z + outZ * (b.radius + 1.1),
                )
                if (b.beached && shoreY > 0.35) {
                  // Step onto sand from a hauled hull
                  player.mode = 'walk'
                  player.x = b.x + outX * (b.radius + 0.85)
                  player.z = b.z + outZ * (b.radius + 0.85)
                  player.y = shoreY + WALK_EYE
                  player.vy = 0
                  player.submersion = 0
                  onRaftDeck = false
                  swimming = false
                } else if (b.beached) {
                  // Bow over water — stay on the planks. Don't dump you for
                  // walking the length of a grounded hull.
                  const s = lip / d
                  player.x = b.x + (player.x - b.x) * s
                  player.z = b.z + (player.z - b.z) * s
                } else {
                  washGrace = 0.85
                  live = player
                  player.mode = 'swim'
                  player.x = b.x + outX * (b.radius + 1.25)
                  player.z = b.z + outZ * (b.radius + 1.25)
                  player.y = sea.y - 0.15
                  player.vy = 0
                  player.submersion = 0.7
                  player.speed = Math.min(player.speed, 1.2)
                  onRaftDeck = false
                  swimming = true
                }
              } else {
                const s = lip / d
                player.x = b.x + (player.x - b.x) * s
                player.z = b.z + (player.z - b.z) * s
              }
            }
          }
          px = player.x
          pz = player.z
        } else if (
          live &&
          view.walking &&
          boardGrace <= 0 &&
          washGrace <= 0 &&
          deckDist > b.radius * DECK_LIP &&
          deckDist < b.radius + 1.05
        ) {
          const ang = Math.atan2(player.z - b.z, player.x - b.x)
          const edgeX = b.x + Math.cos(ang) * (b.radius + 1.1)
          const edgeZ = b.z + Math.sin(ang) * (b.radius + 1.1)
          const shoreY = deps.groundAt(edgeX, edgeZ)
          if (b.beached && shoreY > 0.35) {
            player.mode = 'walk'
            player.x = edgeX
            player.z = edgeZ
            player.y = shoreY + WALK_EYE
            player.vy = 0
            player.submersion = 0
            onRaftDeck = false
            swimming = false
          } else if (b.beached) {
            // Soft skirt past a beached bow — pull back onto the deck
            const back = b.radius * DECK_LIP * 0.92
            player.x = b.x + Math.cos(ang) * back
            player.z = b.z + Math.sin(ang) * back
            player.y = b.deckY + WALK_EYE
            player.vy = 0
            player.submersion = 0
            player.mode = 'walk'
            onRaftDeck = true
            swimming = false
          } else {
            // Soft skirt was holding a walker past the gunwale — put them in the sea
            washGrace = 0.85
            player.mode = 'swim'
            player.x = b.x + Math.cos(ang) * (b.radius + 1.25)
            player.z = b.z + Math.sin(ang) * (b.radius + 1.25)
            player.y = sea.y - 0.15
            player.vy = 0
            player.submersion = 0.7
            player.speed = Math.min(player.speed, 1.2)
            onRaftDeck = false
            swimming = true
          }
          px = player.x
          pz = player.z
        }

        // Wash-off — foul weather fills a meter; rail and mass buy you time.
        // Climb grace is invulnerable so boarding isn't instantly punished.
        const onDeck =
          washGrace <= 0 &&
          (boardGrace > 0 || view.walking) &&
          Math.hypot(player.x - b.x, player.z - b.z) <= b.radius * DECK_LIP
        if (onDeck && boardGrace <= 0 && live) {
          const storm = deps.storm?.() ?? 0
          const gate = b.rail ? WASH_RAIL_GATE : WASH_STORM_GATE
          if (storm > gate) {
            let rate = WASH_RATE * ((storm - gate) / Math.max(0.05, 1 - gate))
            if (b.rail) rate *= WASH_RAIL / WASH_RATE
            if (b.locker) rate = Math.max(0, rate - WASH_LOCKER)
            // Steeper wave faces shove harder
            rate *= 0.65 + Math.min(0.7, Math.hypot(sea.normal.x, sea.normal.z) * 2.2)
            washMeter = Math.min(1, washMeter + rate * dt)
            if (washMeter > 0.55 && !saidWash) {
              saidWash = true
              deps.hud.whisper(
                b.rail ? 'Seas over the rail. Hold on.' : 'The deck wants you off.',
              )
            }
            if (washMeter >= 1) {
              washMeter = 0
              saidWash = false
              washGrace = 1.35
              // Knock clear of the deck skirt, into the swim
              const side = Math.random() > 0.5 ? 1 : -1
              const raftYaw = b.yaw ?? b.object.rotation.y
              live.x = b.x + Math.cos(raftYaw) * side * (b.radius + 2.4)
              live.z = b.z + Math.sin(raftYaw) * side * (b.radius + 2.4)
              live.y = sea.y - 0.25
              live.mode = 'swim'
              live.vy = 0
              live.submersion = 0.85
              if (live.speed !== undefined) live.speed = 0
              onRaftDeck = false
              swimming = true
              deps.hud.whisper('A wave takes you over the side.')
              tap('splash', 0.9)
            }
          } else {
            washMeter = Math.max(0, washMeter - dt * 0.45)
            if (washMeter < 0.3) saidWash = false
          }
        } else if (!onDeck) {
          washMeter = Math.max(0, washMeter - dt * 0.8)
        }

        // Deck fire rides with the raft
        for (const other of builds) {
          if (other.kind !== 'fire') continue
          if (Math.hypot(other.x - prevX, other.z - prevZ) > b.radius * 0.95) continue
          other.x += b.x - prevX
          other.z += b.z - prevZ
          other.deckY = b.deckY + 0.08
          other.object.position.set(other.x, other.deckY, other.z)
        }
      }
      if (b.kind === 'fire') {
        animateFire(b.object, t, b.x * 0.7 + b.z * 0.3, deps.daylight())
      }
      if (b.kind === 'signal') {
        const rag = b.object.getObjectByName('signalRag')
        if (rag) {
          rag.rotation.y = Math.sin(t * 1.1 + b.x) * 0.35
          rag.rotation.z = Math.sin(t * 0.7) * 0.08
        }
        for (const child of b.object.children) {
          if (child.name !== 'signalSmoke' || !(child instanceof THREE.Mesh)) continue
          const s = child.userData.seed as number
          const life = ((t * (0.22 + s * 0.15) + s * 5) % 3.2) / 3.2
          const spin = s * Math.PI * 2 + t * 0.25
          child.position.set(Math.cos(spin) * life * 0.25, 2.4 + life * 4.5, Math.sin(spin) * life * 0.25)
          child.scale.setScalar(0.6 + life * 2.2)
          ;(child.material as THREE.MeshBasicMaterial).opacity = 0.22 * (1 - life)
        }
      }
      if (b.kind === 'catch' || b.kind === 'pit' || b.kind === 'drip' || b.kind === 'cistern') {
        const storm = deps.storm?.() ?? 0
        const rainRate = 1 + storm * CATCH_STORM_BOOST
        const refill =
          b.kind === 'catch'
            ? CATCH_REFILL
            : b.kind === 'pit'
              ? PIT_REFILL
              : b.kind === 'drip'
                ? DRIP_REFILL
                : CISTERN_REFILL
        b.water = Math.min(1, (b.water ?? 0) + (dt / refill) * rainRate)
        const waterMesh = b.object.getObjectByName('water')
        if (waterMesh) {
          waterMesh.visible = (b.water ?? 0) > 0.05
          if (b.kind === 'catch') {
            waterMesh.scale.y = 0.4 + (b.water ?? 0) * 0.8
          } else if (b.kind === 'pit') {
            waterMesh.scale.y = 0.5 + (b.water ?? 0) * 1.2
          } else if (b.kind === 'drip') {
            waterMesh.scale.setScalar(0.6 + (b.water ?? 0) * 0.9)
          } else {
            waterMesh.scale.y = 0.5 + (b.water ?? 0) * 1.4
          }
        }
      }
      if (b.kind === 'lean-to' && b.hasBarrel) {
        const storm = deps.storm?.() ?? 0
        const rainRate = 1 + storm * CATCH_STORM_BOOST
        // Roofed shelter barrels fill slower — eave drip, not open sky
        const roofMul = (b.roof ?? 'none') !== 'none' ? 0.7 : 1.15
        b.water = Math.min(1, (b.water ?? 0) + (dt / SHELTER_BARREL_REFILL) * rainRate * roofMul)
        const waterMesh = b.object.getObjectByName('water')
        if (waterMesh) waterMesh.visible = (b.water ?? 0) > 0.08
      }
      if (b.kind === 'trap') {
        // Ride the swell; the tide stocks it (see stockTraps)
        const sea = sampleOcean(b.x, b.z, t).y
        b.object.position.set(b.x, sea + 0.05, b.z)
        b.object.rotation.x = Math.sin(t * 1.1 + b.x * 0.7) * 0.08
        b.object.rotation.z = Math.sin(t * 0.9 + b.z * 0.6) * 0.1
      }
    }
    stockTraps(dt)

    // Carpentry walls are real: the body stops at a solid panel and passes a
    // door's gap. Push back to whichever side of the plane you're on.
    if (deps.vitals.alive) {
      for (const b of builds) {
        if (b.kind !== 'wall') continue
        const dx = player.x - b.x
        const dz = player.z - b.z
        if (Math.abs(dx) > 1.9 || Math.abs(dz) > 1.9) continue
        if (player.y > b.deckY + WALL_HEIGHT + 0.5 || player.y < b.deckY - 0.7) continue
        const wyaw = b.yaw ?? b.object.rotation.y
        const ws = Math.sin(wyaw)
        const wc = Math.cos(wyaw)
        const lx = dx * wc - dz * ws
        const lz = dx * ws + dz * wc
        if (Math.abs(lx) > TILE / 2 + 0.15 || Math.abs(lz) > 0.18) continue
        // A door blocks its cheeks and lets the middle through
        if (b.variant === 'door' && Math.abs(lx) <= 0.5) continue
        const out = (lz >= 0 ? 1 : -1) * 0.18
        player.x = b.x + lx * wc + out * ws
        player.z = b.z - lx * ws + out * wc
      }
    }
  }

  /** The tide stocks the traps — quick first fish, slower after, up to the bottle's fit. */
  function stockTraps(dt: number) {
    // Rising / falling water works the bottle harder than slack high water
    const rush = 1 + Math.abs(oceanState.tide) * 0.15 + (oceanState.tide < 0 ? 0.35 : 0)
    for (const b of builds) {
      if (b.kind !== 'trap') continue
      const stock = b.fish ?? 0
      if (stock >= TRAP_MAX) continue
      b.water = (b.water ?? 0) + dt * rush
      const need = stock === 0 ? TRAP_FIRST : TRAP_NEXT
      if ((b.water ?? 0) < need) continue
      b.water = 0
      b.fish = stock + 1
      const stockMesh = b.object.getObjectByName('trapStock')
      if (stockMesh) stockMesh.visible = true
    }
  }

  function standAt(x: number, z: number) {
    let best = -1000
    for (const b of builds) {
      if (b.kind === 'platform') {
        // Square deck — walk on top; a short skirt ramps down to sand or sea
        const half = TILE / 2
        const d = Math.max(Math.abs(b.x - x), Math.abs(b.z - z))
        const skirt = half + 1.0
        if (d > skirt) continue
        if (d <= half) {
          best = Math.max(best, b.deckY)
        } else {
          const f = Math.min(1, (d - half) / (skirt - half))
          const under = deps.groundAt(x, z)
          const target = Math.min(b.deckY, Math.max(under, -1.25))
          best = Math.max(best, THREE.MathUtils.lerp(b.deckY, target, Math.pow(f, 0.8)))
        }
        continue
      }
      if (b.kind !== 'raft') continue
      const d = Math.hypot(b.x - x, b.z - z)
      // Narrow shelf past the gunwale so the walker's slope probe (±0.9 m)
      // doesn't see a cliff into the ocean floor — but steep enough that a
      // swimmer past the lip can't auto-stand. Climb is the way back aboard.
      // Beached hulls offer a longer ramp onto sand.
      const skirt = b.beached ? b.radius + 2.2 : b.radius + 1.0
      if (d > skirt) continue
      if (d <= b.radius) {
        const lip = 1 - (d / b.radius) ** 2
        best = Math.max(best, b.deckY + lip * 0.04)
      } else if (b.beached) {
        const t = Math.min(1, (d - b.radius) / (skirt - b.radius))
        const sand = deps.groundAt(x, z)
        best = Math.max(best, THREE.MathUtils.lerp(b.deckY, Math.max(sand, b.deckY - 0.3), t))
      } else {
        const t = Math.min(1, (d - b.radius) / (skirt - b.radius))
        best = Math.max(best, THREE.MathUtils.lerp(b.deckY, -1.25, Math.pow(t, 0.7)))
      }
    }
    return best
  }

  function shelterAt(x: number, z: number, base: number) {
    let s = base
    const storm = deps.storm?.() ?? 0
    // Foul weather is when planted shelter earns its keep — lean-to / fire
    // warmth reads higher once the sky closes over you.
    const foulLift = storm > 0.3 ? 1 + (storm - 0.3) * 0.55 : 1
    for (const b of builds) {
      if (b.shelter <= 0) continue
      const d = Math.hypot(b.x - x, b.z - z)
      if (d > b.radius) continue
      const falloff = 1 - d / b.radius
      const value = b.kind === 'lean-to' || b.kind === 'fire' ? b.shelter * foulLift : b.shelter
      s = Math.max(s, THREE.MathUtils.lerp(base, value, falloff))
    }
    // A brand in hand is a personal hearth — warmth travels with you
    if (carried) s = Math.max(s, 1.2)
    return s
  }

  function reset() {
    for (const b of builds) {
      for (const item of b.items) deps.interactions.remove(item)
      scene.remove(b.object)
      disposeBuildObject(b.object)
    }
    builds.length = 0
    if (carried) {
      disposeBuildObject(carried.object)
      carried = null
    }
    clearGhost()
    torch.visible = false
    restReadyAt = 0
    sitReadyAt = 0
    saidPole = false
    saidSail = false
    saidWash = false
    saidOar = false
    saidPoleHint = false
    saidHelm = false
    saidHelmHint = false
    saidFail = false
    saidBeach = false
    washMeter = 0
    boardGrace = 0
    washGrace = 0
    shoveGrace = 0
  }

  function fillHold(src?: SavedHold): Hold {
    const h = emptyHold()
    if (!src) return h
    for (const k of Object.keys(h) as StashKind[]) {
      h[k] = Math.max(0, Math.floor(src[k] ?? 0))
    }
    return h
  }

  function snapshot(): SavedBuild[] {
    const list = carried ? [...builds, carried] : builds
    return list.map((b) => ({
      kind: b.kind,
      x: b.x,
      z: b.z,
      yaw: b.yaw ?? b.object.rotation.y,
      y:
        b.kind === 'platform' || b.kind === 'wall' || b.kind === 'roof' || b.kind === 'woodpile'
          ? b.deckY
          : undefined,
      variant: b.variant,
      water: b.water,
      buoyant: b.buoyant,
      mast: b.mast,
      rail: b.rail,
      locker: b.locker,
      oar: b.oar,
      floats: b.floats,
      expands: b.expands,
      marked: b.marked,
      beached: b.beached,
      anchored: b.anchored,
      torn: b.torn,
      flooded: b.flooded,
      sides: b.sides,
      roof: (b.roof ?? 'none') as SavedRoof,
      tall: b.tall,
      rooms: b.rooms,
      fish: b.fish,
      hasBarrel: b.hasBarrel,
      hasMat: b.hasMat,
      hold: b.hold ? { ...b.hold } : undefined,
      vx: b.vx,
      vz: b.vz,
      failMeter: b.failMeter,
      curing: b.smoking?.map((fish) => ({
        readyIn: Math.max(0, fish.readyAt - time),
      })),
      carried: b === carried || undefined,
    }))
  }

  function attachWaterDrink(
    build: Build,
    label: string,
    sipMax: number,
    sipScale: number,
    emptyLine: string,
    fullLine: string,
  ) {
    const drink = deps.interactions.add({
      position: build.object.position,
      verb: 'Drink',
      label,
      radius: 2.5,
      available: () => deps.vitals.alive && (build.water ?? 0) > 0.08,
      use: () => {
        const left = build.water ?? 0
        if (left <= 0.08) return
        const sip = Math.min(sipMax, left)
        build.water = left - sip
        eat(deps.vitals, 0, sip * sipScale)
        const waterMesh = build.object.getObjectByName('water')
        if (waterMesh) waterMesh.visible = (build.water ?? 0) > 0.05
        deps.hud.whisper((build.water ?? 0) > 0.1 ? fullLine : emptyLine)
      },
    })
    build.items.push(drink)
  }

  function restore(saved: SavedBuild[]) {
    reset()
    for (const s of saved) {
      const x = s.x
      const z = s.z
      const kind = s.kind as BuildKind
      let build: Build | null = null

      if (kind === 'lean-to') {
        const y = deps.groundAt(x, z)
        const tall = !!s.tall
        const bays = Math.max(1, s.rooms ?? 1)
        build = addBuild(
          'lean-to',
          shelterFrameMesh(m, tall, bays),
          x,
          z,
          y,
          2.8 + (bays - 1) * 1.15,
          0.28,
          {
            sides: s.sides ?? 0,
            roof: (s.roof ?? 'none') as RoofKind,
            tall,
            rooms: bays,
            hasBarrel: !!s.hasBarrel,
            hasMat: !!s.hasMat,
            water: s.water ?? 0,
          },
        )
        const sides = s.sides ?? 0
        for (let i = 1; i <= sides; i++) fitShelterSide(build.object, m, i, tall, bays)
        if (s.roof && s.roof !== 'none') fitShelterRoof(build.object, m, s.roof, tall, bays)
        if (s.hasBarrel) {
          fitShelterBarrel(build.object, m)
          attachBarrelDrink(build, 'Barrel')
        }
        if (s.hasMat) fitShelterMat(build.object, m)
        recomputeShelter(build)
      } else if (kind === 'fire') {
        const y = deps.groundAt(x, z)
        // Deck fires: if near a raft snapshot, sit on ground for restore simplicity
        build = addBuild('fire', fireMesh(m), x, z, y, 2.4, 1.35, { smoking: [] })
      } else if (kind === 'catch') {
        const y = deps.groundAt(x, z)
        build = addBuild('catch', catchMesh(m), x, z, y, 2.2, 0, { water: s.water ?? 0.4 })
        attachWaterDrink(
          build,
          'Rain-catch',
          0.35,
          0.85,
          'The last of it.',
          'Cool. Flat. Better than the sea.',
        )
      } else if (kind === 'seat') {
        build = addBuild('seat', seatMesh(m), x, z, deps.groundAt(x, z), 1.8, 0.15)
      } else if (kind === 'rack') {
        build = addBuild('rack', rackMesh(m), x, z, deps.groundAt(x, z), 2.0, 0, { smoking: [] })
      } else if (kind === 'signal') {
        build = addBuild('signal', signalMesh(m), x, z, deps.groundAt(x, z), 1.6, 0)
      } else if (kind === 'pit') {
        build = addBuild('pit', digPitMesh(m), x, z, deps.groundAt(x, z), 1.6, 0, {
          water: s.water ?? 0,
        })
        attachWaterDrink(build, 'Hollow', 0.28, 0.75, 'Muddy dregs.', 'Brackish. Better than salt.')
      } else if (kind === 'drip') {
        build = addBuild('drip', dripMesh(m), x, z, deps.groundAt(x, z), 1.4, 0, {
          water: s.water ?? 0,
        })
        attachWaterDrink(build, 'Tin drip', 0.22, 0.9, 'The tin runs dry.', 'A mouthful from the tin.')
      } else if (kind === 'cistern') {
        build = addBuild('cistern', cisternMesh(m), x, z, deps.groundAt(x, z), 1.5, 0.05, {
          water: s.water ?? 0,
        })
        attachBarrelDrink(build, 'Cistern')
      } else if (kind === 'camp-locker') {
        build = addBuild('camp-locker', campLockerMesh(m), x, z, deps.groundAt(x, z), 1.6, 0.08, {
          hold: fillHold(s.hold),
        })
      } else if (kind === 'woodpile') {
        const hold = fillHold(s.hold)
        if (hold.plank < 1) hold.plank = 1
        const y = s.y ?? deps.groundAt(x, z)
        build = addBuild('woodpile', woodpileMesh(m, hold.plank), x, z, y, 1.5, 0.05, { hold })
      } else if (kind === 'trap') {
        build = addBuild('trap', trapMesh(m), x, z, deps.groundAt(x, z), 1.6, 0, {
          fish: s.fish ?? 0,
          water: s.water ?? 0,
        })
        const stockMesh = build.object.getObjectByName('trapStock')
        if (stockMesh) stockMesh.visible = (s.fish ?? 0) > 0
        attachTrapCheck(build)
      } else if (kind === 'platform') {
        const y = s.y ?? deps.groundAt(x, z) + PLATFORM_RISE_LAND
        build = addBuild('platform', platformMesh(m), x, z, y, 1.8, 0.18, { yaw: 0 })
      } else if (kind === 'wall') {
        const door = s.variant === 'door'
        const y = s.y ?? deps.groundAt(x, z)
        build = addBuild('wall', wallMesh(m, door), x, z, y, 1.7, WALL_SHELTER, {
          yaw: s.yaw ?? 0,
          variant: door ? 'door' : undefined,
        })
      } else if (kind === 'roof') {
        const y = s.y ?? deps.groundAt(x, z) + ROOF_RISE
        build = addBuild('roof', roofMesh(m), x, z, y, 1.8, 0, { yaw: 0 })
      } else if (kind === 'raft') {
        const withBarrel = !!s.buoyant
        const sea = sampleOcean(x, z, 0).y
        const radius = (withBarrel ? 2.35 : 2.05) + (s.rail ? 0.35 : 0) + (s.expands ?? 0) * 0.38
        build = addBuild('raft', raftMesh(m, withBarrel), x, z, sea + 0.22, radius, withBarrel ? 0.62 : 0.55, {
          buoyant: withBarrel,
          vx: s.vx ?? 0,
          vz: s.vz ?? 0,
          failMeter: s.failMeter ?? 0,
          yaw: s.yaw ?? 0,
          hold: fillHold(s.hold),
          mast: !!s.mast,
          rail: !!s.rail,
          locker: !!s.locker,
          oar: !!s.oar,
          floats: !!s.floats,
          expands: s.expands ?? 0,
          marked: !!s.marked,
          beached: !!s.beached,
          anchored: !!s.anchored,
          torn: !!s.torn,
          flooded: !!s.flooded,
        })
        if (s.mast) fitMast(build.object, m)
        if (s.rail) fitRail(build.object, m)
        if (s.locker) fitLocker(build.object, m)
        if (s.oar) fitOar(build.object, m)
        if (s.floats) fitFloat(build.object, m)
        if (s.marked) fitMark(build.object, m)
        if (s.anchored) fitAnchor(build.object, m, true)
        const expands = s.expands ?? 0
        for (let i = 1; i <= expands; i++) fitExpand(build.object, m, i)
        if (s.mast) build.shelter = Math.max(build.shelter, withBarrel ? 0.78 : 0.7)
        if (s.rail) build.shelter = Math.max(build.shelter, build.shelter + 0.12)
        if (s.floats) {
          build.buoyant = true
          build.shelter = Math.max(build.shelter, build.shelter + 0.08)
        }
        if (s.torn) animateSail(build.object, 0, true)
        if (s.beached) {
          build.deckY = beachedDeckY(deps.groundAt(x, z), sampleOcean(x, z, 0).y)
          build.object.position.set(x, build.deckY, z)
        }
      }

      if (build && s.yaw !== undefined) {
        build.yaw = s.yaw
        if (build.kind === 'raft') build.object.rotation.order = 'YXZ'
        build.object.rotation.y = s.yaw
      }
      if (build && build.water !== undefined) {
        const waterMesh = build.object.getObjectByName('water')
        if (waterMesh) waterMesh.visible = (build.water ?? 0) > 0.05
      }
      if (build && s.curing?.length && (build.kind === 'fire' || build.kind === 'rack')) {
        if (!build.smoking) build.smoking = []
        s.curing.forEach((fish, slot) => {
          const mesh = smokedFishMesh(m)
          if (build!.kind === 'fire') {
            mesh.position.set((slot - 0.5) * 0.28, 0.85, 0.15)
          } else {
            mesh.position.set((slot - 1) * 0.32, 1.05, 0.05)
          }
          build!.object.add(mesh)
          build!.smoking!.push({
            readyAt: time + Math.max(0, fish.readyIn),
            mesh,
          })
        })
      }
      if (build && s.carried && build.kind === 'fire') {
        const idx = builds.indexOf(build)
        if (idx >= 0) builds.splice(idx, 1)
        scene.remove(build.object)
        build.object.visible = false
        carried = build
        torch.visible = true
      }
    }

    // Carpentry shelters depend on neighbours — recompute once everything is up
    for (const b of builds) {
      if (b.kind === 'platform') recomputeTileShelter(b)
      if (b.kind === 'wall' && platformAt(b.x, b.z, 0.9)) b.shelter = 0
    }
  }

  function getWashMeter() {
    return washMeter
  }

  function setWashMeter(value: number) {
    washMeter = Math.min(1, Math.max(0, value))
  }

  return {
    update,
    standAt,
    shelterAt,
    reset,
    snapshot,
    restore,
    getWashMeter,
    setWashMeter,
    /** Dev/tests — fast-forward the slow camp clocks (trap stocking). */
    debugTick(seconds: number) {
      stockTraps(seconds)
    },
    /** Construction recipes ready right now — Pack Camp tab. */
    campRecipes(): CampRecipe[] {
      return campEntries
        .filter((e) => (e.menuReady ? e.menuReady() : e.item.available()))
        .map((e) => ({
          id: `${e.group}:${e.item.verb}:${e.item.label}`,
          group: e.group,
          verb: e.item.verb,
          label: e.item.label,
          cost: e.cost ? costLabel(e.cost, deps.salvage.labels) : 'hands',
          use: () => e.item.use(),
        }))
    },
    /** True while the player is holding a living brand. */
    get carryingFire() {
      return !!carried
    },
    get counts() {
      const out: Record<BuildKind, number> = {
        'lean-to': 0,
        fire: 0,
        raft: 0,
        catch: 0,
        seat: 0,
        rack: 0,
        signal: 0,
        pit: 0,
        drip: 0,
        cistern: 0,
        'camp-locker': 0,
        woodpile: 0,
        trap: 0,
        platform: 0,
        wall: 0,
        roof: 0,
      }
      for (const b of builds) out[b.kind]++
      if (carried) out.fire++
      return out
    },
    costs: {
      leanTo: LEAN_COST,
      side: SIDE_COST,
      roofLeaf: ROOF_LEAF_COST,
      roofCanvas: ROOF_CANVAS_COST,
      roofScrap: ROOF_SCRAP_COST,
      shelterBarrel: SHELTER_BARREL_COST,
      cistern: CISTERN_COST,
      mat: MAT_COST,
      ridge: RIDGE_COST,
      room: ROOM_COST,
      trap: TRAP_COST,
      rod: ROD_COST,
      net: NET_COST,
      campLocker: CAMP_LOCKER_COST,
      fire: FIRE_COST,
      catch: CATCH_COST,
      raft: RAFT_COST,
      raftBarrel: RAFT_BARREL_COST,
      mast: MAST_COST,
      rail: RAIL_COST,
      locker: LOCKER_COST,
      seat: SEAT_COST,
      rack: RACK_COST,
      signal: SIGNAL_COST,
      expand: EXPAND_COST,
      oar: OAR_COST,
      floats: FLOAT_COST,
      drip: DRIP_COST,
      mend: MEND_COST,
      platform: PLATFORM_COST,
      wall: WALL_COST,
      door: DOOR_COST,
      roof: ROOF_COST,
      woodpile: WOODPILE_COST,
      label: costLabel,
    },
  }
}

export type Improvise = ReturnType<typeof createImprovise>
