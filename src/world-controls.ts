import './world-controls.css'

const destinations = { beach: 'Landing cove', forest: 'Rainforest', lagoon: 'Lagoon', wreck: 'Wanderer wreck' }
export type Destination = keyof typeof destinations

export function createWorldControls(app: HTMLElement, actions: {
  getMinutes: () => number
  setMinutes: (minutes: number) => void
  travelTo: (place: Destination) => void
  setTracking: (on: boolean) => void
}) {
  const toggle = document.createElement('button')
  toggle.id = 'world-toggle'
  toggle.type = 'button'
  toggle.textContent = 'World'
  toggle.title = 'World controls · G'
  toggle.setAttribute('aria-haspopup', 'dialog')
  toggle.setAttribute('aria-controls', 'world-panel')
  toggle.setAttribute('aria-expanded', 'false')

  const panel = document.createElement('dialog')
  panel.id = 'world-panel'
  panel.setAttribute('aria-labelledby', 'world-heading')
  panel.innerHTML = `
    <header><div><small>WATERWORLD</small><h2 id="world-heading">World controls</h2></div>
      <button type="button" class="world-close" aria-label="Close world controls">×</button></header>
    <section><div class="world-clock"><label for="world-hour">Time of day</label><output for="world-hour"></output></div>
      <input id="world-hour" type="range" min="0" max="1439" step="1">
      <div class="world-times"></div></section>
    <section><h3>Travel to</h3><div class="world-places"></div></section>
    <section><h3>Camera</h3><div class="world-places">
      <button type="button" id="track-diver" aria-pressed="false">Track diver</button>
    </div></section>`
  app.append(toggle, panel)
  const slider = panel.querySelector('input')!
  const readout = panel.querySelector('output')!
  let editing = false
  function showMinutes(minutes: number) {
    const time = [Math.floor(minutes / 60), minutes % 60].map(v => String(v).padStart(2, '0')).join(':')
    slider.value = String(minutes)
    readout.value = time
    slider.setAttribute('aria-valuetext', time)
  }
  function setTime(minutes: number) {
    actions.setMinutes(minutes)
    showMinutes(minutes)
  }
  slider.oninput = () => { editing = true; showMinutes(slider.valueAsNumber) }
  slider.onchange = () => { setTime(slider.valueAsNumber); editing = false }
  slider.onpointercancel = () => { editing = false }
  function addButton(group: Element, label: string, act: () => void) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.onclick = act
    group.append(button)
  }
  const times = panel.querySelector('.world-times')!
  for (const [label, minutes] of Object.entries({ Dawn: 375, Noon: 720, Dusk: 1065, Night: 1320 })) {
    addButton(times, label, () => setTime(minutes))
  }
  const places = panel.querySelector('.world-places')!
  const track = panel.querySelector<HTMLButtonElement>('#track-diver')!
  track.onclick = () => {
    const on = track.getAttribute('aria-pressed') !== 'true'
    track.setAttribute('aria-pressed', String(on))
    track.textContent = on ? 'First person' : 'Track diver'
    actions.setTracking(on)
    panel.close()
  }
  for (const place of Object.keys(destinations) as Destination[]) {
    addButton(places, destinations[place], () => { actions.travelTo(place); panel.close() })
  }

  let clockTick = 0
  function open() {
    if (document.pointerLockElement) document.exitPointerLock()
    showMinutes(actions.getMinutes())
    panel.showModal()
    toggle.setAttribute('aria-expanded', 'true')
    clockTick = window.setInterval(() => { if (!editing) showMinutes(actions.getMinutes()) }, 900)
  }
  toggle.onclick = open
  panel.querySelector<HTMLButtonElement>('.world-close')!.onclick = () => panel.close()
  panel.onclose = () => {
    window.clearInterval(clockTick)
    editing = false
    toggle.setAttribute('aria-expanded', 'false')
    toggle.focus({ preventScroll: true })
  }
  panel.onclick = e => {
    if (e.target !== panel) return
    const rect = panel.getBoundingClientRect()
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) panel.close()
  }
  // Keep arrows, Space and Enter inside the dialog, including during the opening drop.
  panel.onkeydown = e => e.stopPropagation()
  window.addEventListener('keydown', e => {
    if (e.code !== 'KeyG' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
    e.preventDefault()
    if (panel.open) panel.close()
    else open()
  }, true)
  return panel
}
