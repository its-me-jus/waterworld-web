import type * as THREE from 'three'

/**
 * Light the sky would give, where the light rig cannot.
 *
 * Under a near-black sea the hemisphere light has almost nothing to say about
 * a shaded surface, so stone, driftwood, bark, a steel hull and the cliffs
 * each carry a little light of their own in the colour open shade would give
 * them. That stand-in was a constant. The sky it stands in for is not: after
 * dark the moon gives a fifteenth of what the sun did while these surfaces
 * went on giving all of theirs, and with the night's longer exposure on top
 * the beach stones, the logs and the wreck's hull were the brightest things
 * on the island.
 *
 * Every such material is registered here and follows one level, set once a
 * frame from the daylight. A real light source (a lantern, coral that glows)
 * is not sky fill and stays out of it.
 */

const fills: { material: THREE.MeshStandardMaterial; full: number }[] = []
let level = 1

/** For shaders that add their own fill in code (the island's cliffs). */
export const skyFillUniform = { value: 1 }

/** Mark a material's emissive as sky fill. Returns the material, so it wraps a constructor call. */
export function skyFill<T extends THREE.MeshStandardMaterial>(material: T): T {
  fills.push({ material, full: material.emissiveIntensity })
  material.emissiveIntensity *= level
  return material
}

/**
 * What is left after dark. Low enough that a stone sits darker than the
 * moonlit sand around it, as dark rock on pale sand does; not so low that
 * stones, logs and the wreck's hull lose their form to flat black.
 */
const NIGHT = 0.17

/**
 * `daylight` is the climate's 0–1 curve, which holds near 1 through the
 * golden hour and falls away after the sun is down. Twilight keeps the fill:
 * that is when the sky is doing the most work as a light, not the least.
 */
export function setSkyFill(daylight: number) {
  const t = Math.min(1, Math.max(0, (daylight - 0.02) / 0.48))
  const next = NIGHT + (1 - NIGHT) * t * t * (3 - 2 * t)
  if (Math.abs(next - level) < 0.003) return
  level = next
  skyFillUniform.value = next
  for (const fill of fills) fill.material.emissiveIntensity = fill.full * next
}
