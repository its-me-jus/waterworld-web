import type { PerspectiveCamera } from 'three'
import type { InputState } from './input'
import { sampleOcean } from './waves'

const LOOK_SENS_MOUSE = 0.0022
const LOOK_SENS_STICK = 2.4
const MOVE_SPEED = 7.5
const SWIM_VERTICAL = 4.2
const EYE_HEIGHT = 1.5

export type PlayerState = {
  yaw: number
  pitch: number
  x: number
  y: number
  z: number
  unlocked: boolean
}

export function createPlayer(): PlayerState {
  return {
    yaw: 0.35,
    pitch: -0.08,
    x: 0,
    y: 2.5,
    z: 4,
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
    player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch))
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
) {
  if (Math.abs(input.lookX) > 0.02 || Math.abs(input.lookY) > 0.02) {
    player.yaw += input.lookX * LOOK_SENS_STICK * dt
    player.pitch += input.lookY * LOOK_SENS_STICK * dt
    player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch))
  }

  const forwardX = -Math.sin(player.yaw)
  const forwardZ = -Math.cos(player.yaw)
  const rightX = Math.cos(player.yaw)
  const rightZ = -Math.sin(player.yaw)

  let mx = forwardX * input.moveForward + rightX * input.moveStrafe
  let mz = forwardZ * input.moveForward + rightZ * input.moveStrafe
  const len = Math.hypot(mx, mz)
  const moving = Math.min(1, len)
  if (len > 1) {
    mx /= len
    mz /= len
  }
  if (len > 0.02) {
    player.x += mx * MOVE_SPEED * dt
    player.z += mz * MOVE_SPEED * dt
  }

  const water = sampleOcean(player.x, player.z, time)
  const surfaceY = water.y
  const floatingEye = surfaceY + EYE_HEIGHT

  if (input.rise) player.y += SWIM_VERTICAL * dt
  if (input.dive) player.y -= SWIM_VERTICAL * dt

  if (!input.dive && !input.rise) {
    player.y += (floatingEye - player.y) * Math.min(1, dt * 2.2)
  }

  player.y = Math.max(surfaceY - 28, Math.min(surfaceY + 8, player.y))

  camera.position.set(player.x, player.y, player.z)
  camera.rotation.order = 'YXZ'
  camera.rotation.y = player.yaw
  camera.rotation.x = player.pitch

  const underwater = player.y < surfaceY - 0.08
  return { underwater, surfaceY, moving }
}
