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
  water?: number
  buoyant?: boolean
  mast?: boolean
  rail?: boolean
  locker?: boolean
  oar?: boolean
  floats?: boolean
  expands?: number
  marked?: boolean
  sides?: number
  roof?: SavedRoof
  hasBarrel?: boolean
  hasMat?: boolean
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
    health: number
    elapsed: number
    wounded: boolean
    woundClock: number
    suited: boolean
  }
  stash: Stash
  rawFish: number
  smokedFish: number
  knife: boolean
  spear: boolean
  suit: boolean
  climateElapsed: number
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
  vitals.health = saved.health
  vitals.elapsed = saved.elapsed
  vitals.wounded = saved.wounded
  vitals.woundClock = saved.woundClock
  vitals.suited = saved.suited
  vitals.alive = true
  vitals.cause = null as Cause | null
}
