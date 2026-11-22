import type * as THREE from 'three'
import type { Climate } from '../climate'

/**
 * The shared contract between the world side (Track A: src/story, src/tribe)
 * and the brain side (Track B: src/ai, api). Names here are mirrored exactly
 * by Track B; change one only when both sides change together.
 */

export type NpcId = 'kael' | 'tala' | 'oru'

/** What the body is doing. The mesh blends between these. */
export type NpcPose =
  | 'idle'
  | 'patrol'
  | 'watch_suspicious'
  | 'warn_spear_raise'
  | 'stalk'
  | 'charge_attack'
  | 'curious_tilt'
  | 'beckon_follow'
  | 'accept_gift'
  | 'laugh_baffled'
  | 'sit_fire'

/** What the islander means to do. The sim turns these into movement and a pose. */
export type NpcAction =
  | 'idle'
  | 'watch'
  | 'warn'
  | 'stalk'
  | 'attack_chase'
  | 'step_back'
  | 'beckon_to_caves'
  | 'beckon_to_elder'
  | 'accept_offer'
  | 'scoff_at_cash'
  | 'guide_escape'

/** What the player does with their body. No words cross the language barrier; these do. */
export type PlayerGesture =
  | 'empty_hands'
  | 'crouch'
  | 'back_away'
  | 'offer_cash'
  | 'offer_item'
  | 'wave'
  | 'drop_bag'

/** What is in the player's hands. */
export type HeldItem =
  | 'none'
  | 'cash_bag'
  | 'cash_wad'
  | 'spear'
  | 'salvage_compass'
  | 'salvage_flare'
  | 'radio_battery'

/**
 * What one islander can tell about the player right now, from their own
 * eyes and ears. This is what goes to the brain, so it holds only what the
 * islander could actually know.
 */
export interface NpcPerceptionSnapshot {
  npcId: NpcId
  /** Metres, islander to player. */
  distance: number
  /** Radians between where the islander faces and where the player is: 0 dead ahead, PI behind. */
  angle: number
  /** Player's ground speed, m/s. */
  playerSpeed: number
  crouched: boolean
  heldItem: HeldItem
  /** Inside the elder's fire clearing. */
  inSacredZone: boolean
  /** The duffel is on the player (in hand or on the back). */
  carryingBag: boolean
  /** Climate dayPhase, 0..1, midnight at 0 and 1. */
  timeOfDay: number
  /** Climate tidePhase: -1 low water, 0 mean, +1 high water. */
  tide: number
  /** 0 clear .. 1 full squall. */
  storm: number
  /** Inside the vision cone with a clear enough view. */
  seen: boolean
  /** Within earshot (closer when the player is crouched or still). */
  heard: boolean
}

/** The bits of the player the tribe needs each frame. main.ts builds this from its PlayerState. */
export interface TribePlayerState {
  x: number
  y: number
  z: number
  /** Same convention as player.yaw: forward is (-sin yaw, -cos yaw). */
  yaw: number
  /** Ground speed, m/s. */
  speed: number
  crouched: boolean
  mode: 'walk' | 'swim' | 'glide'
}

/** The slice of the climate the tribe and the props read. Pass the whole Climate if that is easier. */
export type TribeWeather = Pick<Climate, 'dayPhase' | 'daylight' | 'storm' | 'tide' | 'tidePhase'>

/** Where an islander is and what they are doing, for the HUD and the brain. */
export interface NpcInfo {
  id: NpcId
  position: THREE.Vector3
  distance: number
  pose: NpcPose
  action: NpcAction
}

/** The duffel's whereabouts. */
export type BagState = 'carried' | 'dropped' | 'stashed_caves'

/** Things in the world the player can act on. */
export type InteractableKind =
  | 'salvage_compass'
  | 'salvage_flare'
  | 'radio_battery'
  | 'spear'
  | 'cash_bag'
  | 'campfire'
  | 'cave_stash'
  | 'totem'

export interface Interactable {
  id: string
  kind: InteractableKind
  position: THREE.Vector3
  /** Metres from the query point. */
  distance: number
  /** Short plain label for a button, e.g. 'Brass compass'. */
  label: string
}

/** Minimal island surface the story and tribe modules read (the real Island satisfies it). */
export interface IslandLike {
  centre: THREE.Vector3
  heightAt: (x: number, z: number) => number
  shore: THREE.Vector3[]
  pools: THREE.Vector3[]
}

/** Minimal tidal-caves surface (the real createTidalCaves result satisfies it). */
export interface TidalCavesLike {
  entrance: { x: number; z: number; yaw: number; pitch: number }
  chamberPresence: (eye: THREE.Vector3) => number
  floorAt: (x: number, z: number, fromY?: number) => number
  /** x, y = the air chamber's centre in world x, z (about 655.5, -494.5 today). */
  chamberWater: THREE.Vector4
}
