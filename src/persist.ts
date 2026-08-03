/**
 * Local run persistence — browser localStorage only.
 *
 * Keeps a living camp across reloads so a shelter you built is still there
 * when you come back. Death and "Start again" clear it. No backend.
 */

import type { Stash, StashKind } from './salvage'
import type { Cause, Vitals } from './survival'

export const SAVE_KEY = 'waterworld.run.v1'

export type SavedRoof = 'none' | 'leaf' | 'canvas' | 'scrap'

export type SavedHold = Partial<Record<StashKind, number>>

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
}

export type SavedHarvest = {
  taken: boolean
  palmStage?: 'fronds' | 'trunk' | 'gone'
  /** Seconds until grass comes back; 0 if not waiting. */
  returnIn?: number
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
  climateElapsed: number
  /** World seconds this run has lasted — the days-alive score derives from it. */
  runElapsed?: number
  hasDived: boolean
  builds: SavedBuild[]
  harvest: SavedHarvest[]
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
