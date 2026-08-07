/**
 * Local run persistence — browser localStorage only.
 *
 * Keeps a living camp across reloads so a shelter you built is still there
 * when you come back. Death and "Start again" clear it. No backend.
 */

import type { Regime } from './climate'
import type { Stash, StashKind } from './salvage'
import type { Cause, Vitals } from './survival'

export const SAVE_KEY = 'waterworld.run.v1'

export type SavedRoof = 'none' | 'leaf' | 'canvas' | 'scrap'

export type SavedHold = Partial<Record<StashKind, number>>

export type SavedCuring = {
  /** Seconds remaining until the fish is ready (0 = collectable now). */
  readyIn: number
}

export type SavedBuild = {
  kind: string
  x: number
  z: number
  yaw?: number
  /** Absolute deck height — carpentry pieces need it, terrain can't recompute it. */
  y?: number
  /** Carpentry piece variant (a wall hung as a door). */
  variant?: string
  water?: number
  buoyant?: boolean
  mast?: boolean
  rail?: boolean
  locker?: boolean
  oar?: boolean
  floats?: boolean
  expands?: number
  /** Live walkable radius — diagnostics / tests; restore recomputes from fittings. */
  radius?: number
  marked?: boolean
  beached?: boolean
  anchored?: boolean
  torn?: boolean
  flooded?: boolean
  sides?: number
  roof?: SavedRoof
  hasBarrel?: boolean
  hasMat?: boolean
  /** Shelter raised to walk-in height. */
  tall?: boolean
  /** Shelter footprint in bays — one room each. */
  rooms?: number
  /** Fish waiting in a trap. */
  fish?: number
  hold?: SavedHold
  /** Smoked fish stowed in a crate / raft locker. */
  holdSmoked?: number
  /** Raft drift velocity. */
  vx?: number
  vz?: number
  /** Soft-fail fill while a foul sea works the rig. */
  failMeter?: number
  /** Signal smoke got a distant answer once. */
  answered?: boolean
  /** Fish smoking/drying on this fire or rack. */
  curing?: SavedCuring[]
  /** This fire is in the player's hand, not planted in the world. */
  carried?: boolean
}

export type SavedHarvest = {
  taken: boolean
  palmStage?: 'fronds' | 'trunk' | 'gone'
  /** Seconds until grass comes back; 0 if not waiting. */
  returnIn?: number
}

export type SavedSalvage = {
  /** Taken flags for fixed (non-drifting) finds, in creation order. */
  fixedTaken: boolean[]
  /** Rain-pool fullness 0..1, in creation order. */
  poolFull: number[]
  /** Inland ledge seep fullness 0..1 when the island hosts one. */
  ledgeFull?: number | null
}

export type SavedLittoral = {
  taken: boolean[]
  pools: { full: number; covered: boolean }[]
  seals: { hauled: boolean; spook: number }[]
}

export type SavedWreck = {
  provisionTaken: boolean
  knifeTaken: boolean
  locker: 'sealed' | 'cut' | 'stripped'
  gearLocker: 'shut' | 'open' | 'stripped'
  tinTaken: boolean
  logTaken: boolean
  lanternTaken?: boolean
  /** Suit removed from the open gear locker. */
  suitTaken?: boolean
}

export type SavedWreckLoot = {
  knife: boolean
  spear: boolean
  lantern?: boolean
}

export type SavedCrab = {
  /** Seconds until the crab returns; 0 if present. */
  returnIn: number
}

export type SavedClimate = {
  elapsed: number
  regime: Regime
  storm: number
  target: number
  from: number
  holdLeft: number
  frontLeft: number
  frontLength: number
  nextStrikeIn: number
  thunderLeft: number
  thunderPower: number
  lightning: number
}

export type SavedSea = {
  amp: number
  glassy: boolean
  glassLeft: number
  glassLength: number
  nextGlassIn: number
}

export type SavedRun = {
  v: 1
  savedAt: number
  player: {
    x: number
    y: number
    z: number
    yaw: number
    pitch: number
    mode: 'swim' | 'walk'
  }
  vitals: {
    breath: number
    stamina: number
    warmth: number
    water: number
    food: number
    energy?: number
    health: number
    elapsed: number
    wounded: boolean
    woundClock: number
    suited: boolean
  }
  stash: Stash
  rawFish: number
  smokedFish: number
  knife?: boolean
  spear?: boolean
  rod?: boolean
  net?: boolean
  /** Equipped fishing tool when both are owned. */
  fishingTool?: 'rod' | 'net'
  suit: boolean
  lantern?: boolean
  climateElapsed: number
  /** World seconds this run has lasted — the days-alive score derives from it. */
  runElapsed?: number
  hasDived: boolean
  builds: SavedBuild[]
  harvest: SavedHarvest[]
  /** Deck wash-off meter (player-centric). */
  washMeter?: number
  salvage?: SavedSalvage
  littoral?: SavedLittoral
  wreck?: SavedWreck
  loot?: SavedWreckLoot
  crabs?: SavedCrab[]
  climate?: SavedClimate
  sea?: SavedSea
}

export function readSave(): SavedRun | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as SavedRun
    if (!data || data.v !== 1) return null
    if (!data.player || !data.vitals || !data.stash) return null
    return data
  } catch {
    return null
  }
}

export function writeSave(data: SavedRun) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data))
  } catch {
    // Quota / private mode — fail quietly; the run still plays
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY)
  } catch {
    /* ignore */
  }
}

export function applyVitals(vitals: Vitals, saved: SavedRun['vitals']) {
  vitals.breath = saved.breath
  vitals.stamina = saved.stamina
  vitals.warmth = saved.warmth
  vitals.water = saved.water
  vitals.food = saved.food
  // Older saves predate the tired timer — wake rested rather than exhausted
  vitals.energy = saved.energy ?? 1
  vitals.health = saved.health
  vitals.elapsed = saved.elapsed
  vitals.wounded = saved.wounded
  vitals.woundClock = saved.woundClock
  vitals.suited = saved.suited
  vitals.alive = true
  vitals.cause = null as Cause | null
}

/** Infer wreck physical state from older saves that only stored gear flags. */
export function legacyWreck(data: SavedRun): SavedWreck {
  const knife = !!(data.knife || data.spear || data.loot?.knife || data.loot?.spear)
  const spear = !!(data.spear || data.loot?.spear)
  const suit = !!(data.suit || data.vitals.suited)
  const lantern = !!(data.lantern || data.loot?.lantern)
  return {
    provisionTaken: false,
    knifeTaken: knife,
    locker: spear ? 'stripped' : 'sealed',
    gearLocker: suit ? 'stripped' : lantern ? 'open' : 'shut',
    tinTaken: false,
    logTaken: false,
    lanternTaken: lantern,
    suitTaken: suit,
  }
}
