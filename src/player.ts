import type { PerspectiveCamera } from 'three'
import type { InputState } from './input'
import { WAVES, sampleOcean } from './waves'

const TAU = Math.PI * 2
const LOOK_SENS_MOUSE = 0.0022
/** Touch-drag look — a touch higher than mouse so a thumb swipe feels responsive. */
const LOOK_SENS_TOUCH = 0.0032

const SURFACE_SPEED = 5.2
const SUBMERGED_SPEED = 6.6
const SWIM_VERTICAL = 4.0
/** Eyes ride well clear of the water — this is a big swell to swim in. */
const EYE_HEIGHT = 1.5
const MAX_DEPTH = 30
/** Eye depth at which we treat the swimmer as fully submerged. */
const SUBMERGE_DEPTH = 1.1

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Frame-rate independent approach toward a target. */
const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))

/** Direction of the dominant swell — the orbital drift pushes along it. */
const SWELL = (() => {
  const [dx, dz] = WAVES[0].direction
  const len = Math.hypot(dx, dz) || 1
  return { x: dx / len, z: dz / len }
})()

export type PlayerState = {
  yaw: number
  pitch: number
  /** Head roll, driven by the wave surface you're lying on. */
  roll: number
  /** Extra pitch from riding up/down a wave face. */
  viewPitch: number
  x: number
  y: number
  z: number
  vy: number
  /** Heading we keep gliding along after the stick is released. */
  dirX: number
  dirZ: number
  speed: number
  /** 0..1 position in the current arm-stroke cycle. */
  stroke: number
  /** Smoothed "how hard am I swimming" — includes vertical effort. */
  effort: number
  /** Smoothed planar movement only. */
  moving: number
  /** 0 at the surface, 1 once fully under — carried over between frames. */
  submersion: number
  /** Last frame's water height, for the total surface derivative. */
  prevSurfaceY: number
  unlocked: boolean
}

/** Shoves the swimmer out of solid geometry, in place, after they've moved. */
export type Collider = (position: { x: number; y: number; z: number }) => void

/**
 * How much body the swimmer has left this frame, fed in by vitals. All 1 when
 * they're strong; a starving, exhausted swimmer keeps maybe half of each.
 */
export type SwimLimits = {
  /** Multiplies top speed. */
  speedScale: number
  /** Multiplies deliberate vertical swim power (and wave-recovery authority). */
  climbScale: number
  /** Multiplies stroke cadence — tired arms turn over slower. */
  cadenceScale: number
  /** 0..1 tremor folded into head roll — low breath, spent muscles. */
  wobble: number
}

export const FULL_STRENGTH: SwimLimits = {
  speedScale: 1,
  climbScale: 1,
  cadenceScale: 1,
  wobble: 0,
}

export type PlayerFrame = {
  underwater: boolean
  surfaceY: number
  /** Metres the eyes are below the surface (0 when above). */
  depth: number
  /** 0 at the surface, 1 once fully under. */
  submersion: number
  effort: number
  moving: number
  stroke: number
  speed: number
  /** Vertical speed of the water under you — the swell lifting/dropping. */
  surfaceVel: number
}

export function createPlayer(): PlayerState {
  return {
    yaw: 0.35,
    pitch: -0.08,
    roll: 0,
    viewPitch: 0,
    x: 0,
    y: 2.5,
    z: 4,
    vy: 0,
    dirX: 0,
    dirZ: -1,
    speed: 0,
    stroke: 0,
    effort: 0,
    moving: 0,
    submersion: 0,
    prevSurfaceY: Number.NaN,
    unlocked: false,
  }
}

export function bindKeyboardMouse(
  canvas: HTMLElement,
  player: PlayerState,
  opts: { enablePointerLock: boolean; onLockChange?: (locked: boolean) => void },
) {
  const keys = new Set<string>()

  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code)
    if (e.code === 'Space') e.preventDefault()
  }
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code)

  const onClick = () => {
    if (!opts.enablePointerLock) return
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock()
  }

  const onLock = () => {
    player.unlocked = document.pointerLockElement === canvas
    opts.onLockChange?.(player.unlocked)
  }

  const onMouse = (e: MouseEvent) => {
    if (!player.unlocked) return
    player.yaw -= e.movementX * LOOK_SENS_MOUSE
    player.pitch -= e.movementY * LOOK_SENS_MOUSE
    player.pitch = clamp(player.pitch, -1.45, 1.45)
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  canvas.addEventListener('click', onClick)
  document.addEventListener('pointerlockchange', onLock)
  window.addEventListener('mousemove', onMouse)

  /** After touch.apply — OR keyboard onto input. */
  function mergeKeys(input: InputState) {
    let f = 0
    let s = 0
    if (keys.has('KeyW')) f += 1
    if (keys.has('KeyS')) f -= 1
    if (keys.has('KeyD')) s += 1
    if (keys.has('KeyA')) s -= 1

    const stickUsed = Math.hypot(input.moveForward, input.moveStrafe) > 0.08
    if (!stickUsed) {
      input.moveForward = f
      input.moveStrafe = s
    }

    if (keys.has('Space') || keys.has('KeyE')) input.rise = true
    if (keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('KeyQ')) input.dive = true
  }

  return {
    mergeKeys,
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      canvas.removeEventListener('click', onClick)
      document.removeEventListener('pointerlockchange', onLock)
      window.removeEventListener('mousemove', onMouse)
    },
  }
}

export function updatePlayer(
  player: PlayerState,
  camera: PerspectiveCamera,
  input: InputState,
  dt: number,
  time: number,
  collide?: Collider,
  limits: SwimLimits = FULL_STRENGTH,
): PlayerFrame {
  if (Math.abs(input.lookDeltaX) > 0.01 || Math.abs(input.lookDeltaY) > 0.01) {
    player.yaw -= input.lookDeltaX * LOOK_SENS_TOUCH
    player.pitch = clamp(player.pitch - input.lookDeltaY * LOOK_SENS_TOUCH, -1.45, 1.45)
  }

  const forwardX = -Math.sin(player.yaw)
  const forwardZ = -Math.cos(player.yaw)
  const rightX = Math.cos(player.yaw)
  const rightZ = -Math.sin(player.yaw)

  // —— effort & stroke cadence ————————————————————————————————
  // Uses last frame's submersion so the swim style is known before we move
  const wasUnder = player.submersion

  let mx = forwardX * input.moveForward + rightX * input.moveStrafe
  let mz = forwardZ * input.moveForward + rightZ * input.moveStrafe
  const len = Math.hypot(mx, mz)
  if (len > 1) {
    mx /= len
    mz /= len
  }
  const planar = Math.min(1, len)
  const vertical = (input.rise ? 0.75 : 0) + (input.dive ? 0.65 : 0)

  player.effort = damp(player.effort, Math.min(1, Math.max(planar, vertical)), 5, dt)
  player.moving = damp(player.moving, planar, 4.5, dt)

  const cadence = (0.28 + (wasUnder > 0.5 ? 0.4 : 0.6) * player.effort) * limits.cadenceScale
  player.stroke = (player.stroke + cadence * dt) % 1

  // Thrust arrives in pulses — one per arm at the surface, one per sweep below
  const pulse =
    wasUnder > 0.5
      ? 0.7 + 0.55 * Math.max(0, Math.sin(player.stroke * TAU))
      : 0.84 + 0.32 * Math.sin(player.stroke * TAU * 2)
  const surge = 1 + (pulse - 1) * player.effort

  const maxSpeed =
    (SURFACE_SPEED + (SUBMERGED_SPEED - SURFACE_SPEED) * wasUnder) * limits.speedScale
  player.speed = damp(player.speed, planar * maxSpeed * surge, planar > 0.02 ? 3.6 : 1.5, dt)

  if (len > 0.02) {
    player.dirX = mx / len
    player.dirZ = mz / len
  }
  player.x += player.dirX * player.speed * dt
  player.z += player.dirZ * player.speed * dt

  // Orbital motion: a passing swell carries you forward on the crest and back
  // in the trough. Horizontal velocity tracks surface elevation, not its slope.
  const orbital = (Number.isNaN(player.prevSurfaceY) ? 0 : player.prevSurfaceY) * 0.45 * (1 - wasUnder)
  player.x += SWELL.x * orbital * dt
  player.z += SWELL.z * orbital * dt

  // —— water under us, after moving ————————————————————————
  const water = sampleOcean(player.x, player.z, time)
  const surfaceY = water.y

  // Total derivative of the surface height: the wave's own motion *plus* the
  // slope we're swimming across. Feeding only the time term made fast swimming
  // lag behind the water and sink.
  if (Number.isNaN(player.prevSurfaceY)) player.prevSurfaceY = surfaceY
  const surfaceVel = clamp((surfaceY - player.prevSurfaceY) / Math.max(dt, 1e-4), -8, 8)
  player.prevSurfaceY = surfaceY

  const depth = Math.max(0, surfaceY - player.y)
  const submersion = clamp(depth / SUBMERGE_DEPTH, 0, 1)
  player.submersion = submersion
  const ride = 1 - submersion

  // —— vertical ————————————————————————————————————————————
  // Velocity control rather than a positional spring: a spring gated by
  // submersion loses all authority once a steep wave face pushes you under, and
  // you sink for good. A capped target velocity always recovers.
  const floatEye = surfaceY + EYE_HEIGHT
  const climbing = input.rise && depth > 0.05

  if (climbing || input.dive) {
    const target =
      ((climbing ? SWIM_VERTICAL : 0) - (input.dive ? SWIM_VERTICAL : 0)) * limits.climbScale
    player.vy = damp(player.vy, target, 6, dt)
  } else {
    // Plenty of authority to climb back out of a wave that washed over us, but
    // it tapers off with depth so a dive still lets you hang and look around.
    // Exhaustion takes the edge off the cap too — spent, you ride the swell
    // more than you fight it.
    const climbCap = (1.0 + 6.5 * clamp(1 - depth / 6, 0, 1)) * (0.35 + 0.65 * limits.climbScale)
    const target = clamp((floatEye - player.y) * 7, -3.5, climbCap) + surfaceVel * ride
    player.vy = damp(player.vy, target, 13, dt)
  }
  player.vy = clamp(player.vy, -9, 9)
  player.y += player.vy * dt
  player.y = clamp(player.y, surfaceY - MAX_DEPTH, surfaceY + 2.5)

  if (collide) {
    const before = player.y
    collide(player)
    // Settling onto rock or sand shouldn't keep banking downward velocity
    if (player.y > before && player.vy < 0) player.vy = 0
  }

  // —— head attitude ———————————————————————————————————————
  const n = water.normal
  const slopeRight = n.x * rightX + n.z * rightZ
  const slopeForward = n.x * forwardX + n.z * forwardZ

  const strafeLean = -input.moveStrafe * 0.06
  const strokeRoll = Math.sin(player.stroke * TAU) * 0.09 * player.effort
  // Tremor when the body's running out — two incommensurate sines so it never
  // reads as a steady oscillation
  const tremor =
    (Math.sin(time * 6.9) * 0.055 + Math.sin(time * 12.7 + 1.3) * 0.03) * limits.wobble
  const targetRoll =
    (-slopeRight * 0.8 + strafeLean + strokeRoll) * (0.3 + 0.7 * ride) + tremor
  player.roll = damp(player.roll, targetRoll, 6, dt)
  player.viewPitch = damp(player.viewPitch, -slopeForward * 0.2 * ride, 5, dt)

  // Stroke bob + idle breathing
  const phase = player.stroke * TAU
  const bobAmount = player.effort * (0.6 + 0.4 * ride)
  const bobY = Math.sin(phase * 2) * 0.05 * bobAmount
  const bobSide = Math.sin(phase) * 0.06 * bobAmount
  const breathe = Math.sin(time * 0.85) * 0.02 * (1 - player.effort)

  camera.position.set(
    player.x + rightX * bobSide,
    player.y + bobY + breathe,
    player.z + rightZ * bobSide,
  )
  camera.rotation.order = 'YXZ'
  camera.rotation.y = player.yaw
  camera.rotation.x = clamp(player.pitch + player.viewPitch, -1.5, 1.5)
  camera.rotation.z = player.roll

  return {
    underwater: depth > 0.06,
    surfaceY,
    depth,
    submersion,
    effort: player.effort,
    moving: player.moving,
    stroke: player.stroke,
    speed: player.speed,
    surfaceVel,
  }
}
