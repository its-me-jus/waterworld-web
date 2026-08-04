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

  // Full-screen drag surface for look — sits under the move stick & dive buttons
  const lookPad = document.createElement('div')
  lookPad.className = 'look-pad'
  lookPad.setAttribute('aria-label', 'Look')
  wrap.appendChild(lookPad)

  const move = makeStick('move', 'MOVE')
  wrap.appendChild(move.root)

  const actions = document.createElement('div')
  actions.className = 'touch-actions'
  actions.innerHTML = `
    <button type="button" class="touch-btn touch-use" data-act="use"></button>
    <button type="button" class="touch-btn" data-act="rise" aria-label="Swim up">▲</button>
    <button type="button" class="touch-btn touch-dive" data-act="dive" aria-label="Dive">▼</button>
  `
  wrap.appendChild(actions)

  let rise = false
  let dive = false
  let usePending = false
  let lookDeltaX = 0
  let lookDeltaY = 0
  let lookId: number | null = null
  let lookLastX = 0
  let lookLastY = 0
  let driveMode: 'pole' | 'helm' | null = null

  const useBtn = actions.querySelector('[data-act="use"]') as HTMLButtonElement
  const diveBtn = actions.querySelector('[data-act="dive"]') as HTMLButtonElement
  useBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    usePending = true
    useBtn.classList.add('active')
  })
  const releaseUse = () => useBtn.classList.remove('active')
  useBtn.addEventListener('pointerup', releaseUse)
  useBtn.addEventListener('pointercancel', releaseUse)
  useBtn.addEventListener('pointerleave', releaseUse)

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
  bindHold(diveBtn, (v) => {
    dive = v
  })

  function paintDiveBtn() {
    if (driveMode === 'helm') {
      diveBtn.textContent = 'HELM'
      diveBtn.setAttribute('aria-label', 'Hold to helm')
      diveBtn.classList.add('drive')
    } else if (driveMode === 'pole') {
      diveBtn.textContent = 'POLE'
      diveBtn.setAttribute('aria-label', 'Hold to pole')
      diveBtn.classList.add('drive')
    } else {
      diveBtn.textContent = '▼'
      diveBtn.setAttribute('aria-label', 'Dive')
      diveBtn.classList.remove('drive')
    }
  }

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

  move.root.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    startStick(move, e)
  })
  move.root.addEventListener('pointermove', (e) => {
    e.preventDefault()
    moveStick(move, e)
  })
  const endMove = (e: PointerEvent) => {
    if (move.id === e.pointerId) resetStick(move)
  }
  move.root.addEventListener('pointerup', endMove)
  move.root.addEventListener('pointercancel', endMove)

  lookPad.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    // One look finger at a time; extra fingers are ignored
    if (lookId !== null) return
    lookId = e.pointerId
    lookLastX = e.clientX
    lookLastY = e.clientY
    lookPad.setPointerCapture(e.pointerId)
  })
  lookPad.addEventListener('pointermove', (e) => {
    if (lookId !== e.pointerId) return
    e.preventDefault()
    lookDeltaX += e.clientX - lookLastX
    lookDeltaY += e.clientY - lookLastY
    lookLastX = e.clientX
    lookLastY = e.clientY
  })
  const endLook = (e: PointerEvent) => {
    if (lookId === e.pointerId) lookId = null
  }
  lookPad.addEventListener('pointerup', endLook)
  lookPad.addEventListener('pointercancel', endLook)

  /** Merge touch into input (call before keyboard merge). */
  function apply(input: InputState) {
    input.moveStrafe = move.dx / move.radius
    input.moveForward = -move.dy / move.radius
    input.lookDeltaX = lookDeltaX
    input.lookDeltaY = lookDeltaY
    lookDeltaX = 0
    lookDeltaY = 0
    input.rise = rise
    input.dive = dive
    if (usePending) {
      input.interact = true
      usePending = false
    }
  }

  function setVisible(on: boolean) {
    wrap.classList.toggle('visible', on)
    document.body.classList.toggle('touch-ui', on)
  }

  /** The use button only exists while something is in reach. */
  function setAction(label: string | null) {
    useBtn.textContent = label ?? ''
    useBtn.setAttribute('aria-label', label ? label : 'Use')
    useBtn.classList.toggle('on', label !== null)
  }

  /** While aboard, ▼ becomes POLE / HELM so drive is obvious on a phone. */
  function setDriveMode(mode: 'pole' | 'helm' | null) {
    if (mode === driveMode) return
    driveMode = mode
    paintDiveBtn()
  }

  return { apply, setVisible, setAction, setDriveMode, root: wrap }
}
