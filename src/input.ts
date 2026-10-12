/** Unified input — keyboard + on-screen touch pads. */

export type InputState = {
  /** -1..1 forward/back in camera space (W/S or left stick Y) */
  moveForward: number
  /** -1..1 strafe (A/D or left stick X) */
  moveStrafe: number
  /** Touch-drag look pixels this frame (screen X). */
  lookDeltaX: number
  /** Touch-drag look pixels this frame (screen Y). */
  lookDeltaY: number
  rise: boolean
  dive: boolean
}

export function createInputState(): InputState {
  return {
    moveForward: 0,
    moveStrafe: 0,
    lookDeltaX: 0,
    lookDeltaY: 0,
    rise: false,
    dive: false,
  }
}

export function preferTouchUI() {
  return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 820
}

/** Slightly cheaper render path for phones / small screens. */
export function isLowPowerDevice() {
  return preferTouchUI() || (navigator.hardwareConcurrency || 8) <= 4
}
