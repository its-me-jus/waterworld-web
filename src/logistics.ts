/**
 * Logistics — what you carry, and what the sea does with it.
 *
 * The stash is not free. Planks and barrels buy a little float under the arm,
 * but every piece you keep swimming with pulls against the stroke. Stow it in
 * a locker, build it into a raft, or Drop it — those are the answers. Nothing
 * here draws; swimLimits and the jettison prompt read the numbers.
 */

import type { Stash, StashKind } from './salvage'

/** How hard each piece pulls when you swim with it. */
export const BURDEN_WEIGHT: Record<StashKind, number> = {
  plank: 1.0,
  barrel: 1.8,
  crate: 2.2,
  rope: 0.35,
  canvas: 0.5,
  plastic: 0.2,
  can: 0.28,
  leaf: 0.12,
}

/** Heaviest-first — Drop sheds the piece that hurts the swim most. */
const JETTISON_ORDER: StashKind[] = [
  'crate',
  'barrel',
  'plank',
  'canvas',
  'can',
  'rope',
  'plastic',
  'leaf',
]

export function burdenOf(stash: Stash): number {
  let n = 0
  for (const key of Object.keys(BURDEN_WEIGHT) as StashKind[]) {
    n += stash[key] * BURDEN_WEIGHT[key]
  }
  return n
}

/**
 * Speed multiplier from carried weight. One plank is a shrug; a full arms-
 * load is a real tax. Floors at ~0.52 so a loaded swim is still a swim.
 */
export function burdenSpeedScale(burden: number): number {
  if (burden <= 0) return 1
  return Math.max(0.52, 1 / (1 + burden * 0.16))
}

/**
 * A plank, barrel, or sealed bottle under the arm is a swim aid — not a raft,
 * just enough buoyancy to keep the head clearer and the climb out of a wave
 * cheaper. Barrels float best; plastic is light help; stacking helps a touch.
 */
export function swimAidOf(stash: Stash): number {
  const plank = stash.plank > 0 ? 0.5 : 0
  const barrel = stash.barrel > 0 ? 0.72 : 0
  const bottle = stash.plastic > 0 ? 0.38 : 0
  const best = Math.max(plank, barrel, bottle)
  if (best <= 0) return 0
  const extras =
    (plank > 0 && barrel > 0 ? 0.12 : 0) +
    (bottle > 0 && (plank > 0 || barrel > 0) ? 0.06 : 0)
  return Math.min(0.9, best + extras)
}

/** Which piece Drop would shed next, or null if the arms are empty. */
export function heaviestKind(stash: Stash): StashKind | null {
  for (const key of JETTISON_ORDER) {
    if (stash[key] > 0) return key
  }
  return null
}

export function stashCount(stash: Stash): number {
  let n = 0
  for (const key of Object.keys(stash) as StashKind[]) n += stash[key]
  return n
}
