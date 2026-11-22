import './interaction-ui.css'
import type { EndingId, HeldItem, NpcAiDecision, NpcId, PlayerGesture } from './contract.ts'
import type { NpcBrain } from './npc-brain.ts'
import type { StoryManager } from './story-state.ts'

type Salvage = Extract<HeldItem, 'spear' | 'salvage_compass' | 'salvage_flare' | 'radio_battery'>
export type InteractionContext =
  | { kind: 'npc'; npcId: NpcId; talaPresent?: boolean; trespassing?: boolean }
  | { kind: 'salvage'; item: Salvage }
  | { kind: 'cave' | 'campfire' | 'escape' | 'dropped_bag' | 'totem' }

export type InteractionOptions = {
  story: StoryManager
  brain: NpcBrain
  onGesture?: (gesture: PlayerGesture, npcId: NpcId) => void
  /** Apply the decision to the simulation. Call ui.capture() when a chase catches the player. */
  onDecision?: (decision: NpcAiDecision) => void
  onWorldAction?: (context: InteractionContext) => void
  onWashAshore: () => void
  onFreshDrop: () => void
}

const names = { kael: 'Kael', tala: 'Tala', oru: 'Oru' }
const roles = { kael: 'The watcher', tala: 'Reef diver', oru: 'The elder' }
const items: Record<HeldItem, string> = {
  none: 'Empty hands', cash_bag: 'Cash duffel', cash_wad: 'Cash wad', spear: 'Spear',
  salvage_compass: 'Brass compass', salvage_flare: 'Signal flare', radio_battery: 'Radio battery',
}
const statusTags = { carried: 'Soggy duffel', dropped: 'Duffel dropped', stashed_caves: 'Stashed in caves' }
const endings = {
  smart_escape: ['Passage at first light', 'Take the passage', 'Tala checks the compass twice. Oru pushes the boat out. For once, Vince has nothing to add.'],
  stealth_heist: ['The quiet withdrawal', 'Slip away with the haul', 'The reef radio coughs up a rendezvous. Your retirement fund smells permanently of low tide.'],
  burn_the_bag: ['A very expensive signal', 'Burn the duffel', 'The wet bills finally catch. Offshore, a boat turns. Vince asks if smoke damage is tax deductible.'],
} satisfies Record<EndingId, [string, string, string]>
const gestures: [PlayerGesture, string][] = [
  ['empty_hands', 'Empty hands'], ['crouch', 'Kneel'], ['back_away', 'Back away'],
  ['offer_cash', 'Flash $10k'], ['offer_item', 'Offer item'],
]
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text) el.textContent = text
  return el
}
function button(text: string, act: () => void) {
  const b = make('button', '', text)
  b.type = 'button'
  b.onclick = act
  return b
}

type Mic = {
  lang: string
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start(): void
  abort(): void
}

/** The host owns proximity, movement, chase collisions and restarting the parachute. */
export function createInteractionUI(app: HTMLElement, options: InteractionOptions) {
  const { story, brain } = options
  const root = make('div', 'ww-encounters')
  app.append(root)
  const listeners = new AbortController()
  const signal = listeners.signal
  let context: InteractionContext | null = null
  let lastTurn: NpcAiDecision | null = null
  let pending: AbortController | null = null
  let activeOutcome: EndingId | 'captured' | null = null
  let notice = ''
  let mic: Mic | null = null
  let disposed = false
  const notesToggle = button('', () => openDialog(notes))
  notesToggle.className = 'ww-heist'
  notesToggle.setAttribute('aria-haspopup', 'dialog')
  notesToggle.setAttribute('aria-expanded', 'false')
  const cash = make('strong'), tag = make('span'), held = make('span', 'ww-heist-hand')
  const notesLabel = make('span', 'ww-notes-label', 'Field notes')
  notesToggle.append(cash, notesLabel, tag, held)
  const dock = make('section', 'ww-dock')
  dock.setAttribute('aria-label', 'Nearby interaction')
  dock.hidden = true
  const card = make('div', 'ww-card')
  const heading = make('div', 'ww-encounter-heading')
  const title = make('strong'), subtitle = make('small'), mood = make('span', 'ww-mood')
  const interactHint = make('small', 'ww-interact-key', 'E · interact')
  heading.append(title, subtitle, mood, interactHint)
  const caption = make('p', 'ww-caption')
  caption.setAttribute('aria-live', 'polite')
  const translation = make('p', 'ww-translation')
  const choices = make('div', 'ww-choices')
  const rail = make('div', 'ww-gesture-rail')
  rail.setAttribute('aria-label', 'Actions')
  card.append(heading, caption, translation, choices)
  dock.append(card, rail)
  root.append(notesToggle, dock)

  function panel(label: string, dismissible = true) {
    const el = make('dialog', 'ww-panel')
    el.setAttribute('aria-label', label)
    const header = make('header'), h = make('h2', '', label)
    header.append(h)
    if (dismissible) {
      const close = button('×', () => el.close())
      close.className = 'ww-close'
      close.setAttribute('aria-label', 'Close ' + label)
      close.autofocus = true
      header.append(close)
    }
    el.append(header)
    el.addEventListener('keydown', e => e.stopPropagation())
    el.addEventListener('click', e => {
      if (!dismissible || e.target !== el) return
      const rect = el.getBoundingClientRect()
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) el.close()
    })
    root.append(el)
    return el
  }
  function openDialog(el: HTMLDialogElement) {
    if (el.open || disposed) return
    if (document.pointerLockElement) document.exitPointerLock()
    el.showModal()
  }

  const notes = panel('Field notes')
  const notesBody = make('div')
  notes.append(notesBody)
  notesToggle.onclick = () => {
    renderNotes()
    openDialog(notes)
    notesToggle.setAttribute('aria-expanded', String(notes.open))
  }
  notes.onclose = () => notesToggle.setAttribute('aria-expanded', 'false')

  function readMood(npc: NpcId) {
    const r = story.getState().relationships[npc]
    if (r.suspicion >= 7) return ['hot', 'On edge']
    if (r.suspicion >= 4 || r.trust < 0) return ['wary', 'Guarded']
    if (r.trust >= 4) return ['warm', 'At ease']
    return ['neutral', 'Watching']
  }
  function renderNotes() {
    const s = story.getState()
    const focusedItem = (document.activeElement as HTMLElement | null)?.dataset.heldItem
    const people = make('section')
    people.append(make('h3', '', 'The islanders'))
    for (const id of ['kael', 'tala', 'oru'] as const) {
      const r = s.relationships[id]
      const row = make('div', 'ww-notes-row')
      row.append(make('strong', '', names[id]), make('span', '', r.met ? readMood(id)[1] : 'Unmet'))
      people.append(row)
      const previous = r.history.at(-1)
      if (previous) people.append(make('p', 'ww-note', previous.caption))
    }
    const pack = make('section')
    pack.append(make('h3', '', 'Carry in hand'))
    const equipment = make('div', 'ww-pack')
    for (const item of new Set<HeldItem>(['none', ...s.inventory])) {
      const b = button(items[item], () => { story.equip(item) })
      b.dataset.heldItem = item
      b.setAttribute('aria-pressed', String(s.heldItem === item))
      equipment.append(b)
    }
    pack.append(equipment)
    notesBody.replaceChildren(people, pack)
    if (s.gossip.length) {
      const section = make('section'), list = make('ul')
      section.append(make('h3', '', 'Word around camp'), list)
      for (const line of s.gossip.slice(-3).reverse()) list.append(make('li', '', line))
      notesBody.append(section)
    }
    Array.from(equipment.querySelectorAll('button')).find(b => b.dataset.heldItem === focusedItem)?.focus({ preventScroll: true })
  }

  const speech = panel('Speak / ask')
  const form = make('form'), speechLabel = make('label', '', 'Your words')
  const words = make('input')
  words.type = 'text'
  words.maxLength = 160
  words.autocomplete = 'off'
  words.placeholder = 'How do I cross the reef?'
  speechLabel.append(words)
  const formActions = make('div', 'ww-pack')
  const send = make('button', '', 'Say it')
  send.type = 'submit'
  const micStatus = make('p', 'ww-note')
  micStatus.setAttribute('role', 'status')
  formActions.append(send)
  const voices = window as Window & { SpeechRecognition?: new () => Mic; webkitSpeechRecognition?: new () => Mic }
  const MicInput = voices.SpeechRecognition ?? voices.webkitSpeechRecognition
  if (MicInput) {
    const listen = button('Use mic', () => {
      if (mic) { stopMic(); micStatus.textContent = 'Mic off.'; return }
      try {
        const session = new MicInput()
        mic = session
        session.lang = document.documentElement.lang || 'en'
        session.onresult = e => {
          if (mic !== session || !speech.open) return
          words.value = (e.results[0]?.[0]?.transcript ?? '').slice(0, words.maxLength)
          micStatus.textContent = 'Review your words, then choose Say it.'
        }
        session.onend = () => {
          if (mic === session) mic = null
          listen.textContent = 'Use mic'
          if (micStatus.textContent === 'Listening…') micStatus.textContent = 'Mic off.'
        }
        session.onerror = () => { micStatus.textContent = 'Mic unavailable. You can type instead.' }
        session.start()
        listen.textContent = 'Stop mic'
        micStatus.textContent = 'Listening…'
      } catch { stopMic(); micStatus.textContent = 'Mic unavailable. You can type instead.' }
    })
    formActions.append(listen)
  }
  function stopMic() {
    const session = mic
    mic = null
    if (session) { session.onresult = null; session.abort() }
  }
  function canSpeak() {
    return context?.kind === 'npc' && (context.npcId === 'tala' ||
      (context.npcId === 'oru' && story.request('oru', { talaPresent: context.talaPresent }).talaTranslating))
  }
  form.onsubmit = event => {
    event.preventDefault()
    const say = words.value.trim()
    if (say && canSpeak() && !pending) { speech.close(); void takeTurn({ say }) }
  }
  form.append(speechLabel, formActions, micStatus)
  speech.append(form)
  speech.onclose = () => { stopMic(); words.value = ''; micStatus.textContent = '' }

  const outcome = panel('Wash ashore', false)
  const summary = make('p'), outcomeActions = make('div', 'ww-outcome-actions')
  outcome.addEventListener('cancel', e => e.preventDefault())
  function leaveOutcome(fresh: boolean) {
    if (!activeOutcome) return
    activeOutcome = null
    setContext(null)
    outcome.close()
    if (fresh) { story.reset(); options.onFreshDrop() }
    else { story.resumeAfterEnding(); options.onWashAshore() }
  }
  outcomeActions.append(button('Wash Up on the Cove (Keep Progress)', () => leaveOutcome(false)),
    button('Fresh Parachute Drop (Reset)', () => leaveOutcome(true)))
  outcome.append(summary, outcomeActions)
  function showOutcome(id: EndingId | 'captured') {
    if (activeOutcome || disposed) return
    pending?.abort()
    activeOutcome = id
    for (const modal of [notes, speech]) if (modal.open) modal.close()
    const [name, , copy] = id === 'captured'
      ? ['Back in the wash', '', 'Salt in your cuffs. Sand in the zipper. The tide has charged a handling fee.']
      : endings[id]
    outcome.querySelector('h2')!.textContent = name
    outcome.setAttribute('aria-label', name)
    summary.textContent = copy
    openDialog(outcome)
  }
  function capture() {
    if (disposed || activeOutcome) return
    showOutcome('captured')
    story.onCaptured()
  }

  async function takeTurn(input: { gesture?: PlayerGesture; say?: string }) {
    if (context?.kind !== 'npc' || activeOutcome || pending || (input.say && !canSpeak())) return
    const current = context
    const controller = new AbortController()
    pending = controller
    notice = ''
    renderDock()
    try {
      if (input.gesture) options.onGesture?.(input.gesture, current.npcId)
      const decision = await brain.turn(current.npcId, {
        ...input, talaPresent: current.talaPresent, trespassing: current.trespassing,
      }, controller.signal)
      if (controller.signal.aborted) return
      lastTurn = decision
      if (options.onDecision) options.onDecision(decision)
      else if (decision.action === 'attack_chase') capture()
    } catch {
      if (!controller.signal.aborted) notice = 'The moment passes. Try another gesture.'
    } finally {
      if (pending === controller) { pending = null; renderDock() }
    }
  }

  type Action = { label: string; run: () => void; disabled?: boolean }
  let actions: Action[] = []
  let primary: Action | undefined
  function worldAction(label: string, act: () => boolean, message: string, disabled = false): Action {
    return { label, disabled, run: () => {
      if (!context || !act()) return
      notice = message
      options.onWorldAction?.(context)
      renderDock()
    } }
  }
  function renderDock() {
    if (disposed) return
    const s = story.getState()
    dock.hidden = !context
    if (!context) { actions = []; primary = undefined; return }
    choices.replaceChildren()
    mood.hidden = context.kind !== 'npc'
    subtitle.textContent = ''
    translation.textContent = ''
    actions = []
    primary = undefined
    let line = ''
    if (context.kind === 'npc') {
      const { npcId } = context
      title.textContent = names[npcId]
      subtitle.textContent = roles[npcId]
      const [tone, label] = readMood(npcId)
      mood.dataset.tone = tone
      mood.textContent = label
      line = lastTurn?.caption ?? { kael: 'The spear stops tapping.', tala: 'A diver tips water out of one ear.', oru: 'The elder watches the space between your hands.' }[npcId]
      if (lastTurn?.utterance && !line.includes(lastTurn.utterance)) line += ' · ' + lastTurn.utterance
      if (lastTurn?.translationHint && npcId === 'oru' && canSpeak()) translation.textContent = 'Tala translates · ' + lastTurn.translationHint
      for (const c of lastTurn?.suggestedChoices ?? []) {
        if ((!c.gesture && !c.say) || (c.say && !canSpeak())) continue
        const b = button(c.label, () => void takeTurn({ gesture: c.gesture, say: c.say }))
        b.disabled = !!pending
        choices.append(b)
      }
      if (canSpeak()) {
        const speak = button('Speak / ask', () => openDialog(speech))
        speak.setAttribute('aria-haspopup', 'dialog')
        speak.disabled = !!pending
        choices.append(speak)
      }
      actions = gestures.map(([gesture, label]) => ({
        label, run: () => void takeTurn({ gesture }),
        disabled: !!pending || (gesture === 'offer_item' && s.heldItem === 'none') ||
          (gesture === 'offer_cash' && (s.cashAmount < 10_000 || s.bagState !== 'carried')),
      }))
      primary = actions[0]
    } else {
      if (context.kind === 'salvage') {
        const item = context.item
        title.textContent = items[item]
        const flag = { salvage_compass: 'salvagedCompass', salvage_flare: 'salvagedFlare', radio_battery: 'salvagedBattery' } as const
        const recovered = item === 'spear' ? s.inventory.includes(item) : s.flags[flag[item]]
        actions.push(worldAction(recovered ? 'Recovered' : 'Take ' + items[item].toLowerCase(),
          () => story.acquire(item), items[item] + ' in hand.', recovered))
      } else if (context.kind === 'totem') {
        title.textContent = 'Carved totem'
        actions.push(worldAction(s.flags.foundTotem ? 'Markings recorded' : 'Study the markings', () => {
          story.discover('foundTotem')
          return story.getState().flags.foundTotem
        }, 'Your fingers follow a channel worn smooth by salt.', s.flags.foundTotem))
      } else if (context.kind === 'cave') {
        title.textContent = 'Tidal caves'
        if (s.bagState === 'stashed_caves') actions.push(worldAction('Retrieve duffel', () => story.retrieveBag(), 'Duffel in hand.'))
        else actions.push(worldAction('Stash bag', () => story.stashBag(), 'The tide keeps your secret.', s.bagState !== 'carried'))
      } else if (context.kind === 'dropped_bag') {
        title.textContent = 'Waterlogged duffel'
        actions.push(worldAction('Pick up duffel', () => story.retrieveBag(), 'Duffel in hand.', s.bagState !== 'dropped'))
      } else if (context.kind === 'campfire') {
        title.textContent = 'Campfire'
        actions.push(worldAction('Burn $10k', () => story.burnCash(), 'A very short-lived investment.', s.cashAmount < 10_000 || s.bagState !== 'carried'))
      } else {
        title.textContent = 'Reef passage'
        line = 'Beyond the breakers lies open water.'
      }
      for (const ending of story.availableEndings()) {
        if (context.kind === (ending === 'burn_the_bag' ? 'campfire' : 'escape')) {
          actions.push({ label: endings[ending][1], run: () => { story.finish(ending) } })
        }
      }
      primary = actions.find(a => !a.disabled)
    }
    const feedback = notice || (pending ? 'Watching for a response…' : line)
    if (caption.textContent !== feedback) caption.textContent = feedback
    rail.replaceChildren(...actions.map((action, index) => {
      const b = button('', action.run)
      const key = make('kbd', '', String(index + 1))
      key.setAttribute('aria-hidden', 'true')
      b.append(key, document.createTextNode(action.label))
      b.disabled = !!action.disabled
      b.title = action.label + ' · ' + (index + 1) + (action === primary ? ' / E' : '')
      return b
    }))
  }
  function setContext(next: InteractionContext | null) {
    if (disposed || next === context) return
    if (context && next && next.kind === context.kind) {
      if (next.kind === 'npc' && context.kind === 'npc') {
        if (next.npcId === context.npcId && !!next.talaPresent === !!context.talaPresent && !!next.trespassing === !!context.trespassing) return
      } else if (next.kind !== 'salvage' || (context.kind === 'salvage' && context.item === next.item)) return
    }
    pending?.abort()
    pending = null
    if (speech.open) speech.close()
    context = next ? { ...next } : null
    lastTurn = null
    notice = ''
    rail.scrollLeft = 0
    card.scrollTop = 0
    renderDock()
  }
  const unsubscribe = story.subscribe(s => {
    cash.textContent = money.format(s.cashAmount)
    tag.textContent = statusTags[s.bagState]
    held.textContent = items[s.heldItem]
    notesToggle.setAttribute('aria-label', 'Field notes · ' + [cash.textContent, tag.textContent, held.textContent].join(' · '))
    if (s.ending) showOutcome(s.ending)
    if (speech.open && !canSpeak()) speech.close()
    if (notes.open) renderNotes()
    renderDock()
  })
  window.addEventListener('keydown', e => {
    // Register this UI before createWorldControls so its window-capture G shortcut
    // cannot open another dialog while the player is typing.
    if (root.querySelector('dialog[open]') && e.code === 'KeyG') {
      e.stopImmediatePropagation()
      return
    }
    if (e.defaultPrevented || e.repeat || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey ||
      !context || document.querySelector('dialog[open]') || document.body.classList.contains('film') ||
      (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]'))) return
    const index = /^Digit[1-5]$/.test(e.code) ? Number(e.code.slice(-1)) - 1 : -1
    const action = e.code === 'KeyE' ? primary : actions[index]
    if (e.code === 'KeyE' && document.pointerLockElement) {
      e.preventDefault()
      e.stopImmediatePropagation()
      document.exitPointerLock()
      const first = dock.querySelector<HTMLButtonElement>('button:not(:disabled)')
      first?.focus({ preventScroll: true })
      return
    }
    if (action && !action.disabled) { e.preventDefault(); e.stopImmediatePropagation(); action.run() }
  }, { capture: true, signal })
  function dispose() {
    disposed = true
    pending?.abort()
    stopMic()
    listeners.abort()
    unsubscribe()
    for (const modal of [notes, speech, outcome]) if (modal.open) modal.close()
    root.remove()
  }
  return { setContext, capture, dispose }
}
