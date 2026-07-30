import type { InputState } from './input'

type Stick = {
  root: HTMLElement
  knob: HTMLElement
  active: boolean
  id: number | null
  originX: number
  originY: number
  dx: number
  dy: number
  radius: number
}

function makeStick(id: string, label: string): Stick {
  const root = document.createElement('div')
  root.className = `stick stick-${id}`
  root.innerHTML = `<div class="stick-knob"></div><span class="stick-label">${label}</span>`
  const knob = root.querySelector('.stick-knob') as HTMLElement
  return {
    root,
    knob,
    active: false,
    id: null,
    originX: 0,
    originY: 0,
    dx: 0,
    dy: 0,
    radius: 54,
  }
}

function setKnob(stick: Stick) {
  stick.knob.style.transform = `translate(calc(-50% + ${stick.dx}px), calc(-50% + ${stick.dy}px))`
}

function resetStick(stick: Stick) {
  stick.active = false
  stick.id = null
  stick.dx = 0
  stick.dy = 0
  setKnob(stick)
}

export function createTouchControls(parent: HTMLElement) {
  const wrap = document.createElement('div')
  wrap.id = 'touch-controls'
  parent.appendChild(wrap)

  const move = makeStick('move', 'MOVE')
  const look = makeStick('look', 'LOOK')
  wrap.appendChild(move.root)
  wrap.appendChild(look.root)

  const actions = document.createElement('div')
  actions.className = 'touch-actions'
  actions.innerHTML = `
    <button type="button" class="touch-btn" data-act="rise" aria-label="Swim up">▲</button>
    <button type="button" class="touch-btn" data-act="dive" aria-label="Dive">▼</button>
  `
  wrap.appendChild(actions)

  let rise = false
  let dive = false

  const bindHold = (btn: HTMLButtonElement, set: (v: boolean) => void) => {
    const on = (e: Event) => {
      e.preventDefault()
      set(true)
      btn.classList.add('active')
    }
    const off = (e: Event) => {
      e.preventDefault()
      set(false)
      btn.classList.remove('active')
    }
    btn.addEventListener('pointerdown', on)
    btn.addEventListener('pointerup', off)
    btn.addEventListener('pointercancel', off)
    btn.addEventListener('pointerleave', off)
  }

  bindHold(actions.querySelector('[data-act="rise"]') as HTMLButtonElement, (v) => {
    rise = v
  })
  bindHold(actions.querySelector('[data-act="dive"]') as HTMLButtonElement, (v) => {
    dive = v
  })

  const sticks = [move, look]

  const startStick = (stick: Stick, e: PointerEvent) => {
    const rect = stick.root.getBoundingClientRect()
    stick.active = true
    stick.id = e.pointerId
    stick.originX = rect.left + rect.width / 2
    stick.originY = rect.top + rect.height / 2
    stick.root.setPointerCapture(e.pointerId)
    moveStick(stick, e)
  }

  const moveStick = (stick: Stick, e: PointerEvent) => {
    if (!stick.active || stick.id !== e.pointerId) return
    let dx = e.clientX - stick.originX
    let dy = e.clientY - stick.originY
    const len = Math.hypot(dx, dy)
    if (len > stick.radius) {
      dx = (dx / len) * stick.radius
      dy = (dy / len) * stick.radius
    }
    stick.dx = dx
    stick.dy = dy
    setKnob(stick)
  }

  for (const stick of sticks) {
    stick.root.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      startStick(stick, e)
    })
    stick.root.addEventListener('pointermove', (e) => {
      e.preventDefault()
      moveStick(stick, e)
    })
    const end = (e: PointerEvent) => {
      if (stick.id === e.pointerId) resetStick(stick)
    }
    stick.root.addEventListener('pointerup', end)
    stick.root.addEventListener('pointercancel', end)
  }

  /** Merge touch into input (call before keyboard merge). */
  function apply(input: InputState) {
    input.moveStrafe = move.dx / move.radius
    input.moveForward = -move.dy / move.radius
    input.lookX = -look.dx / look.radius
    input.lookY = -look.dy / look.radius
    input.rise = rise
    input.dive = dive
  }

  function setVisible(on: boolean) {
    wrap.classList.toggle('visible', on)
    document.body.classList.toggle('touch-ui', on)
  }

  return { apply, setVisible, root: wrap }
}
