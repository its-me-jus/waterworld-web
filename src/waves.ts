/** Shared Gerstner + chop — keep GPU shader + CPU sample in sync. */

export type Wave = {
  direction: [number, number]
  steepness: number
  wavelength: number
  /** phase offset in radians — breaks the marching-band look */
  phase: number
  /** speed scale vs deep-water √(g/k) */
  speed: number
}

/** Irregular open-ocean set: long swell + cross chop + short wind ripples. */
export const WAVES: Wave[] = [
  { direction: [1.0, 0.12], steepness: 0.22, wavelength: 68, phase: 0.4, speed: 0.92 },
  { direction: [0.55, 0.82], steepness: 0.18, wavelength: 41, phase: 1.7, speed: 1.05 },
  { direction: [-0.78, 0.48], steepness: 0.14, wavelength: 27, phase: 2.9, speed: 0.88 },
  { direction: [0.22, -0.9], steepness: 0.12, wavelength: 19, phase: 0.9, speed: 1.12 },
  { direction: [-0.4, -0.65], steepness: 0.09, wavelength: 13, phase: 4.1, speed: 0.95 },
  { direction: [0.92, -0.35], steepness: 0.07, wavelength: 9.5, phase: 5.2, speed: 1.2 },
  { direction: [-0.15, 0.98], steepness: 0.05, wavelength: 6.2, phase: 1.1, speed: 0.85 },
  { direction: [0.7, 0.55], steepness: 0.04, wavelength: 4.1, phase: 3.6, speed: 1.35 },
]

export const WAVE_COUNT = WAVES.length

/** Calm-day steepness — storms write back into WAVES from this base. */
const WAVE_BASE = WAVES.map((w) => w.steepness)

/** Extra wind chop on top of the Gerstners — storms raise this too. */
export let chopScale = 1

/**
 * Push the sea into a squall. Short waves take more of the boost than the long
 * swell, so the surface gets mean without the mesh folding over itself.
 * Mutates WAVES in place — the ocean shader copies the same numbers each frame.
 *
 * Composes with the sea state's slow `amp` (below): storms are the minutes-fast
 * squall, `amp` is the hours-slow breathing. Sample-time multiply keeps them
 * independent.
 */
export function applyStormToWaves(storm: number) {
  const s = Math.max(0, Math.min(1, storm))
  chopScale = 1 + s * 2.1
  for (let i = 0; i < WAVES.length; i++) {
    const short = Math.min(1, 18 / WAVES[i].wavelength)
    WAVES[i].steepness = WAVE_BASE[i] * (1 + s * (0.35 + 0.95 * short))
  }
}

/**
 * Shared sea state, written once per frame by main (see sea.ts). Every CPU
 * consumer of the swell — player, flotsam, splash — samples through this so
 * calm spells flatten the whole world at once, not just the shader.
 */
export const oceanState = { amp: 1 }

/**
 * The island's lee. Inside `inner` the swell is down to a lap; by `outer` the
 * open ocean has it all back. One zone, set once from main — and mirrored in
 * the ocean vertex shader, so the water you see is the water you float on.
 */
const shelter = { x: 0, z: 0, inner: 0, outer: -1 }

export function setShelter(x: number, z: number, inner: number, outer: number) {
  shelter.x = x
  shelter.z = z
  shelter.inner = inner
  shelter.outer = outer
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** 1 on the beach, 0 out at the wreck — how sheltered this spot is. */
export function shelterAt(x: number, z: number) {
  if (shelter.outer <= shelter.inner) return 0
  const d = Math.hypot(x - shelter.x, z - shelter.z)
  const t = clamp01((d - shelter.inner) / (shelter.outer - shelter.inner))
  return 1 - t * t * (3 - 2 * t)
}

/**
 * Long swell dies hardest against the island; the short stuff keeps enough of
 * a pulse to read as lapping on the sand. Keep GLSL in sync (ocean.ts).
 */
function shelterKeep(wavelength: number) {
  return 0.1 + 0.35 * (1 - Math.min(1, wavelength / 60))
}

/** Cheap hash noise for chop / caustics (matches GLSL hash vibe). */
export function hash2(x: number, z: number) {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return n - Math.floor(n)
}

export function noise2(x: number, z: number) {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz)
  const b = hash2(ix + 1, iz)
  const c = hash2(ix, iz + 1)
  const d = hash2(ix + 1, iz + 1)
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz
}

export function fbm(x: number, z: number) {
  let v = 0
  let a = 0.5
  let f = 1
  for (let i = 0; i < 4; i++) {
    v += a * noise2(x * f, z * f)
    a *= 0.5
    f *= 2.02
  }
  return v
}

export function sampleOcean(x: number, z: number, time: number, amp = oceanState.amp) {
  const lee = shelterAt(x, z)
  let y = 0
  let tangentX = 1
  let tangentY = 0
  let tangentZ = 0
  let binormalX = 0
  let binormalY = 0
  let binormalZ = 1

  for (const wave of WAVES) {
    const [dx, dz] = wave.direction
    const len = Math.hypot(dx, dz) || 1
    const dX = dx / len
    const dZ = dz / len
    const k = (Math.PI * 2) / wave.wavelength
    const c = Math.sqrt(9.8 / k) * wave.speed
    const f = k * (dX * x + dZ * z - c * time) + wave.phase
    const steepness = wave.steepness * amp * (1 + (shelterKeep(wave.wavelength) - 1) * lee)
    const a = steepness / k
    const cosF = Math.cos(f)
    const sinF = Math.sin(f)

    y += a * sinF

    tangentX += -dX * dX * steepness * sinF
    tangentY += dX * steepness * cosF
    tangentZ += -dX * dZ * steepness * sinF

    binormalX += -dX * dZ * steepness * sinF
    binormalY += dZ * steepness * cosF
    binormalZ += -dZ * dZ * steepness * sinF
  }

  // Wind chop — breaks repeating Gerstner ridges. Storms raise chopScale;
  // the sea state's amp oils it down on a glass-off so calm reads as calm.
  // The island's lee hushes it too, leaving just a ripple against the sand.
  const chop =
    ((fbm(x * 0.08 + time * 0.07, z * 0.08 - time * 0.05) - 0.5) * 0.55 +
      (fbm(x * 0.22 - time * 0.11, z * 0.22) - 0.5) * 0.22) *
    chopScale *
    amp *
    (1 - 0.65 * lee)
  y += chop

  const nx = binormalY * tangentZ - binormalZ * tangentY
  const ny = binormalZ * tangentX - binormalX * tangentZ
  const nz = binormalX * tangentY - binormalY * tangentX
  const nLen = Math.hypot(nx, ny, nz) || 1

  return {
    y,
    normal: { x: nx / nLen, y: ny / nLen, z: nz / nLen },
  }
}
