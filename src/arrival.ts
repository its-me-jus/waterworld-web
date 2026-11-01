/** Small, recoverable instructions. The world takes over once you can move. */
export type TravelMode = 'glide' | 'walk' | 'swim' | 'dive'

export function createArrival(app: HTMLElement, opts: { drop: boolean; touch: () => boolean; enabled: boolean }) {
  const hint = document.createElement('div')
  hint.id = 'control-hint'
  hint.setAttribute('role', 'status')
  hint.setAttribute('aria-live', 'polite')
  hint.innerHTML = '<span class="control-context"></span><span class="control-copy"></span>'
  const context = hint.querySelector<HTMLElement>('.control-context')!
  const copy = hint.querySelector<HTMLElement>('.control-copy')!

  const help = document.createElement('button')
  help.id = 'sea-help'
  help.type = 'button'
  help.textContent = '?'
  help.setAttribute('aria-label', 'Show movement controls')
  help.title = 'Movement controls · H'
  if (opts.enabled) app.append(hint, help)

  if (opts.drop && opts.enabled) {
    const title = document.createElement('div')
    title.id = 'arrival-title'
    title.innerHTML = '<span class="arrival-kicker">AN ISLAND. AN OPEN SEA.</span><h1>Waterworld</h1><span class="arrival-rule"></span><p>Let your curiosity lead.</p>'
    app.appendChild(title)
    window.setTimeout(() => title.remove(), 12500)
  }

  let mode: TravelMode | '' = ''
  let wasTouch = opts.touch()
  let remaining = 0
  let alive = 0
  let first = true

  function show(seconds = 9) {
    if (!opts.enabled) return
    remaining = seconds
    hint.classList.add('on')
    hint.removeAttribute('aria-hidden')
  }

  function describe(next: TravelMode) {
    const touch = opts.touch()
    context.textContent = next === 'glide' ? 'THE WAY DOWN' : next === 'walk' ? 'ASHORE' : next === 'dive' ? 'BELOW THE SURFACE' : 'ON THE WATER'
    const instructions = touch ? {
      glide: 'Stick to steer · drag to look · hold Flare near the sand',
      walk: 'Stick to walk · drag to look around',
      swim: 'Stick to swim · ↓ to dive · drag to look',
      dive: '↑ to rise · ↓ to dive · stick to swim',
    } : {
      glide: 'A / D steer · W / S change speed · Space flares near the sand',
      walk: 'WASD to walk · click to look · Esc releases the mouse',
      swim: 'WASD to swim · Shift to dive · click to look',
      dive: 'Space to rise · Shift to dive · WASD to swim',
    }
    copy.textContent = instructions[next]
    wasTouch = touch
  }

  help.addEventListener('click', () => show(12))
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyH' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) show(12)
  })

  function update(dt: number, next: TravelMode) {
    alive += dt
    if (next !== mode || wasTouch !== opts.touch()) {
      mode = next
      describe(next)
      show(first && opts.drop ? 16 : 8)
      first = false
    }
    // Keep the opening landscape free for a moment before teaching the controls.
    hint.classList.toggle('on', remaining > 0 && (!opts.drop || alive > 3.5))
    remaining = Math.max(0, remaining - dt)
    if (!remaining) hint.setAttribute('aria-hidden', 'true')
  }

  return { update, show }
}
