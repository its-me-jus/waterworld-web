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

export function sampleOcean(x: number, z: number, time: number) {
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
    const a = wave.steepness / k
    const cosF = Math.cos(f)
    const sinF = Math.sin(f)

    y += a * sinF

    tangentX += -dX * dX * wave.steepness * sinF
    tangentY += dX * wave.steepness * cosF
    tangentZ += -dX * dZ * wave.steepness * sinF

    binormalX += -dX * dZ * wave.steepness * sinF
    binormalY += dZ * wave.steepness * cosF
    binormalZ += -dZ * dZ * wave.steepness * sinF
  }

  // Wind chop — breaks repeating Gerstner ridges
  const chop =
    (fbm(x * 0.08 + time * 0.07, z * 0.08 - time * 0.05) - 0.5) * 0.55 +
    (fbm(x * 0.22 - time * 0.11, z * 0.22) - 0.5) * 0.22
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
