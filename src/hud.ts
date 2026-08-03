import { WOUND_CLOT, type Cause, type Vitals } from './survival'
import type { Stash, StashKind } from './salvage'

/**
 * The HUD stays out of the way on purpose: nothing here tells you where to go
 * or what exists. A vital only draws itself once it's worth worrying about, the
 * breath ring only shows while you're holding it, and the action prompt only
 * appears when something is already within arm's reach.
 *
 * Two quiet layers on top of that:
 *
 *  - Whispers: one fading line that names what the body already told you
 *    ("Your stomach knots."). Queued so a run of them can't stomp each other.
 *  - Veils: diegetic vignettes — the closing dark of a held breath, the grey
 *    weariness of an empty belly, the red pulse of an open wound.
 */

export type Prompt = { verb: string; label: string } | null

const RING_RADIUS = 30
const RING = 2 * Math.PI * RING_RADIUS

const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))

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
  taken: 'The ocean kept you',
}

export function createHud(app: HTMLElement, opts: { touch: boolean; onRestart: () => void }) {
  const root = document.createElement('div')
  root.id = 'hud'
  root.innerHTML = `
    <svg id="breath" viewBox="0 0 80 80" aria-hidden="true">
      <circle class="breath-track" cx="40" cy="40" r="${RING_RADIUS}" />
      <circle class="breath-fill" cx="40" cy="40" r="${RING_RADIUS}" />
    </svg>
    <div id="day"></div>
    <div id="vitals"></div>
    <div id="stash"></div>
    <div id="prompt"><kbd>F</kbd><span></span></div>
    <div id="hurt"></div>
  `
  app.appendChild(root)

  const whisperBox = document.createElement('div')
  whisperBox.id = 'whisper'
  app.appendChild(whisperBox)

  const breathVeil = document.createElement('div')
  breathVeil.id = 'breath-veil'
  app.appendChild(breathVeil)
  const wearyVeil = document.createElement('div')
  wearyVeil.id = 'weary-veil'
  app.appendChild(wearyVeil)
  const woundVeil = document.createElement('div')
  woundVeil.id = 'wound-veil'
  app.appendChild(woundVeil)

  const breath = root.querySelector('#breath') as SVGSVGElement
  const breathFill = root.querySelector('.breath-fill') as SVGCircleElement
  breathFill.style.strokeDasharray = String(RING)

  const vitalsBox = root.querySelector('#vitals') as HTMLElement
  const stashBox = root.querySelector('#stash') as HTMLElement
  const promptBox = root.querySelector('#prompt') as HTMLElement
  const promptText = promptBox.querySelector('span') as HTMLElement
  const hurt = root.querySelector('#hurt') as HTMLElement
  const dayChip = root.querySelector('#day') as HTMLElement
  if (opts.touch) promptBox.classList.add('no-key')

  const rows = ROWS.map(({ key, label, from }) => {
    const row = document.createElement('div')
    row.className = 'vital'
    row.innerHTML = `<span>${label}</span><i><b></b></i>`
    vitalsBox.appendChild(row)
    return { key, from, row, fill: row.querySelector('b') as HTMLElement }
  })

  // Wound clot meter — only draws while you're bleeding
  const woundRow = document.createElement('div')
  woundRow.className = 'vital wound'
  woundRow.innerHTML = `<span>Bleeding</span><i><b></b></i>`
  vitalsBox.appendChild(woundRow)
  const woundFill = woundRow.querySelector('b') as HTMLElement
  woundRow.classList.remove('on')

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
  let lastDay = 0

  const whisperQueue: string[] = []
  let whisperT = 0
  let whisperOn = false

  let veilBreath = 0
  let veilWeary = 0
  let veilWound = 0

  /** A quiet one-liner, queued so several can't stomp each other. */
  function whisper(text: string) {
    if (whisperQueue.length < 5) whisperQueue.push(text)
  }

  function setPrompt(prompt: Prompt | string | null) {
    const text =
      typeof prompt === 'string'
        ? prompt
        : prompt
          ? `${prompt.verb} ${prompt.label.toLowerCase()}`
          : ''
    if (text === lastPrompt) return
    lastPrompt = text
    promptText.textContent = text
    promptBox.classList.toggle('on', text !== '')
  }

  function setStash(
    stash: Stash,
    labels: Record<StashKind, { one: string; many: string }>,
    held?: { rawFish?: number; smokedFish?: number },
  ) {
    const parts: string[] = []
    for (const key of Object.keys(stash) as StashKind[]) {
      const count = stash[key]
      if (count > 0) parts.push(`${count === 1 ? labels[key].one : labels[key].many} ${count}`)
    }
    const fish = held?.rawFish ?? 0
    if (fish > 0) parts.push(`Raw fish ${fish}`)
    const smoked = held?.smokedFish ?? 0
    if (smoked > 0) parts.push(`Smoked fish ${smoked}`)
    const text = parts.join('  ·  ')
    if (text === lastStash) return
    lastStash = text
    stashBox.textContent = text
  }

  function update(vitals: Vitals, submerged: boolean, dt: number) {
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

    // Clot progress: full bar at the bite, empties as it seals
    if (vitals.wounded) {
      const left = Math.max(0, 1 - vitals.woundClock / WOUND_CLOT)
      woundRow.classList.add('on')
      woundFill.style.transform = `scaleX(${left})`
      woundFill.classList.toggle('low', left < 0.35)
    } else {
      woundRow.classList.remove('on')
    }

    hurt.style.opacity = String(
      Math.max(0, 1 - vitals.health / 0.55) * 0.55 + (vitals.wounded ? 0.18 : 0),
    )

    // —— whispers ————————————————————————————————————————————
    whisperT -= dt
    if (whisperT <= 0) {
      const next = whisperQueue.shift()
      if (next) {
        whisperBox.textContent = next
        whisperBox.classList.add('on')
        whisperOn = true
        whisperT = 3.6
      } else if (whisperOn) {
        whisperBox.classList.remove('on')
        whisperOn = false
      }
    }

    // —— veils: the body as readout ———————————————————————————
    const breathShort = vitals.breath < 0.35 ? (0.35 - vitals.breath) / 0.35 : 0
    veilBreath = damp(veilBreath, breathShort * (submerged ? 1 : 0.35), 5, dt)
    breathVeil.style.opacity = veilBreath.toFixed(3)
    breathVeil.classList.toggle('critical', submerged && vitals.breath < 0.18)
    if (!submerged && vitals.breath >= 0.99) breathVeil.style.opacity = '0'

    const weary =
      Math.max(vitals.food < 0.3 ? (0.3 - vitals.food) / 0.3 : 0, 1 - vitals.stamina) * 0.55
    veilWeary = damp(veilWeary, weary, 2.5, dt)
    wearyVeil.style.opacity = veilWeary.toFixed(3)

    const woundAmt = vitals.wounded ? 0.72 + Math.sin(vitals.elapsed * 3.6) * 0.06 : 0
    veilWound = damp(veilWound, woundAmt, vitals.wounded ? 5 : 1.2, dt)
    woundVeil.style.opacity = veilWound.toFixed(3)
    woundVeil.classList.toggle('bleeding', vitals.wounded)
  }

  /** The one scoreboard the game keeps: which day of the run you're on. */
  function setDay(day: number) {
    if (day === lastDay) return
    const first = lastDay === 0
    lastDay = day
    dayChip.textContent = `Day ${day}`
    if (!first) {
      // Re-arm the dawn pulse
      dayChip.classList.remove('turn')
      void dayChip.offsetWidth
      dayChip.classList.add('turn')
    }
  }

  function setDead(cause: Cause | null, day: number) {
    deathTitle.textContent = cause ? DEATH_TITLE[cause] : 'You died'
    let line = `Survived ${day} ${day === 1 ? 'day' : 'days'} · no save, no shortcut back`
    try {
      const best = Math.max(day, Number(localStorage.getItem('ww.bestDays') ?? 0))
      localStorage.setItem('ww.bestDays', String(best))
      if (best > day) line += ` · longest drift ${best} ${best === 1 ? 'day' : 'days'}`
    } catch {
      // Private-mode storage is a nice-to-have, never a reason to lose the ending
    }
    deathLine.textContent = line
    death.classList.add('on')
    root.classList.add('dim')
  }

  function clearDead() {
    death.classList.remove('on')
    root.classList.remove('dim')
    whisperQueue.length = 0
    whisperT = 0
    lastDay = 0
  }

  return {
    update,
    whisper,
    setPrompt,
    setStash,
    setDay,
    setDead,
    clearDead,
    get promptShowing() {
      return promptBox.classList.contains('on')
    },
  }
}

export type Hud = ReturnType<typeof createHud>
