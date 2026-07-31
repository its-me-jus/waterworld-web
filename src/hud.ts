import { formatRun, type Cause, type Vitals } from './survival'
import type { Stash, StashKind } from './salvage'

/**
 * The HUD stays out of the way on purpose: nothing here tells you where to go
 * or what exists. A vital only draws itself once it's worth worrying about, the
 * breath ring only shows while you're holding it, and the action prompt only
 * appears when something is already within arm's reach.
 */

export type Prompt = { verb: string; label: string } | null

const RING_RADIUS = 30
const RING = 2 * Math.PI * RING_RADIUS

const ROWS: { key: keyof Vitals; label: string; from: number }[] = [
  { key: 'health', label: 'Condition', from: 0.99 },
  { key: 'stamina', label: 'Strength', from: 0.7 },
  { key: 'warmth', label: 'Warmth', from: 0.72 },
  { key: 'water', label: 'Water', from: 0.72 },
  { key: 'food', label: 'Food', from: 0.72 },
]

const DEATH_TITLE: Record<Cause, string> = {
  drowned: 'You drowned',
  exposure: 'The cold took you',
  thirst: 'You died of thirst',
  hunger: 'You starved',
}

export function createHud(app: HTMLElement, opts: { touch: boolean; onRestart: () => void }) {
  const root = document.createElement('div')
  root.id = 'hud'
  root.innerHTML = `
    <svg id="breath" viewBox="0 0 80 80" aria-hidden="true">
      <circle class="breath-track" cx="40" cy="40" r="${RING_RADIUS}" />
      <circle class="breath-fill" cx="40" cy="40" r="${RING_RADIUS}" />
    </svg>
    <div id="vitals"></div>
    <div id="stash"></div>
    <div id="prompt"><kbd>F</kbd><span></span></div>
    <div id="hurt"></div>
  `
  app.appendChild(root)

  const breath = root.querySelector('#breath') as SVGSVGElement
  const breathFill = root.querySelector('.breath-fill') as SVGCircleElement
  breathFill.style.strokeDasharray = String(RING)

  const vitalsBox = root.querySelector('#vitals') as HTMLElement
  const stashBox = root.querySelector('#stash') as HTMLElement
  const promptBox = root.querySelector('#prompt') as HTMLElement
  const promptText = promptBox.querySelector('span') as HTMLElement
  const hurt = root.querySelector('#hurt') as HTMLElement
  if (opts.touch) promptBox.classList.add('no-key')

  const rows = ROWS.map(({ key, label, from }) => {
    const row = document.createElement('div')
    row.className = 'vital'
    row.innerHTML = `<span>${label}</span><i><b></b></i>`
    vitalsBox.appendChild(row)
    return { key, from, row, fill: row.querySelector('b') as HTMLElement }
  })

  const death = document.createElement('div')
  death.id = 'death'
  death.innerHTML = `
    <h1></h1>
    <p></p>
    <button type="button">Swim again</button>
  `
  app.appendChild(death)
  const deathTitle = death.querySelector('h1') as HTMLElement
  const deathLine = death.querySelector('p') as HTMLElement
  ;(death.querySelector('button') as HTMLButtonElement).addEventListener('click', (e) => {
    e.stopPropagation()
    opts.onRestart()
  })

  let lastPrompt = ''
  let lastStash = ''

  function setPrompt(prompt: Prompt) {
    const text = prompt ? `${prompt.verb} ${prompt.label.toLowerCase()}` : ''
    if (text === lastPrompt) return
    lastPrompt = text
    promptText.textContent = text
    promptBox.classList.toggle('on', text !== '')
  }

  function setStash(stash: Stash, labels: Record<StashKind, { one: string; many: string }>) {
    const parts: string[] = []
    for (const key of Object.keys(stash) as StashKind[]) {
      const count = stash[key]
      if (count > 0) parts.push(`${count === 1 ? labels[key].one : labels[key].many} ${count}`)
    }
    const text = parts.join('  ·  ')
    if (text === lastStash) return
    lastStash = text
    stashBox.textContent = text
  }

  function update(vitals: Vitals, submerged: boolean) {
    const showBreath = submerged || vitals.breath < 0.995
    breath.style.opacity = showBreath ? '1' : '0'
    if (showBreath) {
      breathFill.style.strokeDashoffset = String(RING * (1 - vitals.breath))
      breathFill.classList.toggle('low', vitals.breath < 0.3)
    }

    for (const { key, from, row, fill } of rows) {
      const value = vitals[key] as number
      row.classList.toggle('on', value < from)
      fill.style.transform = `scaleX(${Math.max(0, value)})`
      fill.classList.toggle('low', value < 0.25)
    }

    hurt.style.opacity = String(Math.max(0, 1 - vitals.health / 0.55) * 0.55)
  }

  function setDead(cause: Cause | null, elapsed: number) {
    deathTitle.textContent = cause ? DEATH_TITLE[cause] : 'You died'
    deathLine.textContent = `Survived ${formatRun(elapsed)} · no save, no shortcut back`
    death.classList.add('on')
    root.classList.add('dim')
  }

  function clearDead() {
    death.classList.remove('on')
    root.classList.remove('dim')
  }

  return { update, setPrompt, setStash, setDead, clearDead }
}

export type Hud = ReturnType<typeof createHud>
