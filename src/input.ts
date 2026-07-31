/** Unified input — keyboard + on-screen touch pads. */

export type InputState = {
  /** -1..1 forward/back in camera space (W/S or left stick Y) */
  moveForward: number
  /** -1..1 strafe (A/D or left stick X) */
  moveStrafe: number
  lookX: number
  lookY: number
  rise: boolean
  dive: boolean
  /** One-shot: set on the frame the use key/button goes down, cleared by the game. */
  interact: boolean
}

export function createInputState(): InputState {
  return {
    moveForward: 0,
    moveStrafe: 0,
    lookX: 0,
    lookY: 0,
    rise: false,
    dive: false,
    interact: false,
  }
}

export function preferTouchUI() {
  return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 820
}

/** Slightly cheaper render path for phones / small screens. */
export function isLowPowerDevice() {
  return preferTouchUI() || (navigator.hardwareConcurrency || 8) <= 4
}
