import './interaction-ui.css'
import type { EndingId, HeldItem, NpcAction, NpcAiDecision, NpcId, PlayerGesture } from './contract.ts'
import type { NpcBrain } from './npc-brain.ts'
import type { StoryManager } from './story-state.ts'

type Salvage = Extract<HeldItem, 'spear' | 'salvage_compass' | 'salvage_flare' | 'radio_battery'>
export type InteractionContext =
  | { kind: 'npc'; npcId: NpcId; talaPresent?: boolean; trespassing?: boolean; /** Spear up, stalking or charging right now. Only changes the panel's posture. */ hostile?: boolean }
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
const firstLook = {
  kael: 'The spear stops tapping.', tala: 'A diver tips water out of one ear.',
  oru: 'The elder watches the space between your hands.',
}
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
/** Beats that put the whole encounter on edge, whoever it is with. */
const edgy: readonly NpcAction[] = ['warn', 'stalk', 'attack_chase']
/** Words an islander says aloud inside a line of narration. Only Tala has any. */
const quoted = /“[^”]+”|"[^"]+"/g
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
// The game calls setContext every frame and the story commits often, so nothing below
// touches the DOM unless what it shows has changed. That also keeps animations from restarting.
function put(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text
}
function mark(el: HTMLElement, name: string, value: string | null) {
  if (value === null) el.removeAttribute('data-' + name)
  else if (el.getAttribute('data-' + name) !== value) el.setAttribute('data-' + name, value)
}
const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
function play(el: Element | null | undefined, frames: Keyframe[], duration: number, easing = 'ease-out') {
  if (el && typeof el.animate === 'function') el.animate(frames, { duration, easing })
}
/** The small give of a pressed key, for presses that came from the keyboard too. */
function nudge(el: Element | null | undefined) {
  if (!still()) play(el, [{ transform: 'scale(0.94)' }, { transform: 'scale(1)' }], 300, 'cubic-bezier(0.2, 0.9, 0.3, 1.4)')
}
/** One span per word (grouped when the line is long) so a voice arrives a word at a time. Returns the next beat. */
function voiced(el: HTMLElement, text: string, beat: number) {
  const parts = text.split(/\s+/).filter(Boolean)
  const size = Math.ceil(parts.length / 16) || 1
  for (let at = 0; at < parts.length; at += size) {
    const word = make('span', 'ww-word', parts.slice(at, at + size).join(' '))
    word.style.setProperty('--i', String(beat++))
    el.append(word, ' ')
  }
  return beat
}
function told(text: string, beat: number) {
  const el = make('span', 'ww-told', text)
  el.style.setProperty('--i', String(beat))
  return el
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
  const spent = make('span', 'ww-heist-spent')
  spent.setAttribute('aria-hidden', 'true')
  notesToggle.append(cash, notesLabel, tag, held, spent)

  // Their words sit above them, your replies low on the left, your hands low on the right.
  const dock = make('section', 'ww-dock')
  dock.setAttribute('aria-label', 'Nearby interaction')
  dock.hidden = true
  const card = make('div', 'ww-card')
  const heading = make('div', 'ww-encounter-heading')
  const title = make('strong'), subtitle = make('small'), mood = make('span', 'ww-mood')
  heading.append(title, subtitle, mood)
  const rule = make('span', 'ww-rule')
  rule.setAttribute('aria-hidden', 'true')
  const status = make('p', 'ww-status')
  status.setAttribute('role', 'status')
  const said = make('div', 'ww-said')
  said.setAttribute('aria-live', 'polite')
  said.setAttribute('aria-atomic', 'true')
  const caption = make('p', 'ww-caption'), utterance = make('p', 'ww-utterance'), translation = make('p', 'ww-translation')
  said.append(caption, utterance, translation)
  card.append(heading, rule, status, said)
  const choices = make('div', 'ww-choices')
  const rail = make('div', 'ww-gesture-rail')
  rail.setAttribute('aria-label', 'Actions')
  const interactHint = make('small', 'ww-interact-key')
  interactHint.append(make('kbd', '', 'E'), ' · interact')
  dock.append(card, choices, rail, interactHint)
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
  notes.classList.add('ww-notes')
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
      const [tone, label] = r.met ? readMood(id) : ['unmet', 'Unmet']
      const feeling = make('span', 'ww-mood', label)
      feeling.dataset.tone = tone
      row.append(make('strong', '', names[id]), feeling)
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
  speech.classList.add('ww-speak')
  const form = make('form'), speechLabel = make('label', '', 'Your words')
  const words = make('input')
  words.type = 'text'
  words.maxLength = 160
  words.autocomplete = 'off'
  words.enterKeyHint = 'send'
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
          mark(listen, 'live', null)
          if (micStatus.textContent === 'Listening…') micStatus.textContent = 'Mic off.'
        }
        session.onerror = () => { micStatus.textContent = 'Mic unavailable. You can type instead.' }
        session.start()
        listen.textContent = 'Stop mic'
        mark(listen, 'live', '')
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
  outcome.classList.add('ww-ending')
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
  function way(label: string, cost: string, act: () => void) {
    const b = button(label, act)
    b.append(' ', make('small', '', cost))
    return b
  }
  outcomeActions.append(way('Wash up on the cove', 'Keep progress', () => leaveOutcome(false)),
    way('Fresh parachute drop', 'Reset', () => leaveOutcome(true)))
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

  /** What the player just did, kept lit while the islander makes up their mind. */
  type Sent = { ack: string; el: Element | null }
  let sent: Sent | null = null
  async function takeTurn(input: { gesture?: PlayerGesture; say?: string }, from?: Sent) {
    if (context?.kind !== 'npc' || activeOutcome || pending || (input.say && !canSpeak())) return
    const current = context
    const controller = new AbortController()
    pending = controller
    sent = from ?? { ack: input.say ? '“' + input.say + '”' : '', el: null }
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
      if (pending === controller) { pending = null; sent = null; renderDock() }
    }
  }

  type Action = { label: string; run: () => void; disabled?: boolean; ending?: boolean }
  type Reply = { label: string; gesture?: PlayerGesture; say?: string; opens?: boolean }
  let actions: Action[] = []
  let primary: Action | undefined
  // What each part of the dock last drew. A part is rebuilt only when its key changes.
  let saidKey = '', statusKey = '', replyKey = '', railKey = ''
  let shownTone: string | null = null
  let scene = false
  let leaving = 0
  function arrive() {
    if (leaving) { window.clearTimeout(leaving); leaving = 0 }
    dock.classList.remove('is-leaving')
    dock.inert = false
    dock.hidden = false
  }
  /** Fade out first, then leave the layout: the game's whisper line watches the hidden attribute. */
  function leave() {
    if (dock.hidden || leaving) return
    dock.classList.add('is-leaving')
    dock.inert = true
    leaving = window.setTimeout(() => {
      leaving = 0
      dock.hidden = true
      dock.classList.remove('is-leaving')
    }, still() ? 110 : 260)
  }
  function worldAction(label: string, act: () => boolean, message: string, disabled = false): Action {
    return { label, disabled, run: () => {
      if (!context || !act()) return
      notice = message
      saidKey = ''
      options.onWorldAction?.(context)
      renderDock()
    } }
  }
  /** Narration in the game's whisper voice, the islander's own voice a word at a time, the guess a beat later. */
  function renderSaid(line: string, heard: string, hint: string, plain: boolean) {
    const key = [plain ? 'plain' : 'voiced', line, heard, hint].join('\n')
    if (key === saidKey) return
    saidKey = key
    caption.replaceChildren()
    utterance.replaceChildren()
    translation.replaceChildren()
    let beat = 0
    if (plain) {
      if (line) caption.append(told(line, 0))
    } else {
      const spoken = [...line.matchAll(quoted)]
      let from = 0
      for (const quote of spoken) {
        const before = line.slice(from, quote.index).trim()
        if (before) { caption.append(told(before, beat), ' '); beat += 5 }
        const voice = make('span', 'ww-voice')
        from = quote.index + quote[0].length
        if (spoken.length === 1 && (!before || !line.slice(from).trim())) voice.classList.add('is-line')
        if (quote[0].length > 64) voice.classList.add('is-long')
        beat = voiced(voice, quote[0], beat)
        caption.append(voice, ' ')
      }
      const rest = line.slice(from).trim()
      if (rest) { caption.append(told(rest, beat)); beat += 5 }
    }
    if (heard) beat = voiced(utterance, heard, beat)
    if (hint) {
      translation.append(make('span', 'ww-by', 'Tala translates'), make('span', 'ww-sep', ' · '), make('span', 'ww-guess', hint))
      translation.style.setProperty('--i', String(beat))
    }
  }
  function renderDock() {
    if (disposed) return
    const s = story.getState()
    if (!context) { actions = []; primary = undefined; leave(); return }
    arrive()
    actions = []
    primary = undefined
    const replies: Reply[] = []
    let line = '', heard = '', hint = ''
    let tone: string | null = null, air: string | null = null
    if (context.kind === 'npc') {
      const { npcId } = context
      const speaks = canSpeak()
      put(title, names[npcId])
      put(subtitle, roles[npcId])
      const [feel, label] = readMood(npcId)
      tone = feel
      put(mood, label)
      line = lastTurn?.caption ?? firstLook[npcId]
      if (lastTurn?.utterance && !line.includes(lastTurn.utterance)) heard = lastTurn.utterance
      if (lastTurn?.translationHint && npcId === 'oru' && speaks) hint = lastTurn.translationHint
      for (const c of lastTurn?.suggestedChoices ?? []) {
        if ((!c.gesture && !c.say) || (c.say && !speaks)) continue
        replies.push(c)
      }
      if (speaks) replies.push({ label: 'Speak / ask', opens: true })
      actions = gestures.map(([gesture, label], index) => ({
        label, run: () => void takeTurn({ gesture }, { ack: label, el: rail.children[index] ?? null }),
        disabled: !!pending || (gesture === 'offer_item' && s.heldItem === 'none') ||
          (gesture === 'offer_cash' && (s.cashAmount < 10_000 || s.bagState !== 'carried')),
      }))
      primary = actions[0]
      // The mood is carried by the panel's posture. Kael is taut until he trusts you.
      air = context.hostile || feel === 'hot' || (lastTurn && edgy.includes(lastTurn.action)) ? 'tense'
        : npcId === 'kael' ? (feel === 'warm' ? 'calm' : 'taut')
        : feel === 'wary' ? 'calm' : npcId === 'tala' ? 'light' : 'warm'
    } else {
      put(subtitle, '')
      if (context.kind === 'salvage') {
        const item = context.item
        put(title, items[item])
        const flag = { salvage_compass: 'salvagedCompass', salvage_flare: 'salvagedFlare', radio_battery: 'salvagedBattery' } as const
        const recovered = item === 'spear' ? s.inventory.includes(item) : s.flags[flag[item]]
        actions.push(worldAction(recovered ? 'Recovered' : 'Take ' + items[item].toLowerCase(),
          () => story.acquire(item), items[item] + ' in hand.', recovered))
      } else if (context.kind === 'totem') {
        put(title, 'Carved totem')
        actions.push(worldAction(s.flags.foundTotem ? 'Markings recorded' : 'Study the markings', () => {
          story.discover('foundTotem')
          return story.getState().flags.foundTotem
        }, 'Your fingers follow a channel worn smooth by salt.', s.flags.foundTotem))
      } else if (context.kind === 'cave') {
        put(title, 'Tidal caves')
        if (s.bagState === 'stashed_caves') actions.push(worldAction('Retrieve duffel', () => story.retrieveBag(), 'Duffel in hand.'))
        else actions.push(worldAction('Stash bag', () => story.stashBag(), 'The tide keeps your secret.', s.bagState !== 'carried'))
      } else if (context.kind === 'dropped_bag') {
        put(title, 'Waterlogged duffel')
        actions.push(worldAction('Pick up duffel', () => story.retrieveBag(), 'Duffel in hand.', s.bagState !== 'dropped'))
      } else if (context.kind === 'campfire') {
        put(title, 'Campfire')
        actions.push(worldAction('Burn $10k', () => story.burnCash(), 'A very short-lived investment.', s.cashAmount < 10_000 || s.bagState !== 'carried'))
      } else {
        put(title, 'Reef passage')
        line = 'Beyond the breakers lies open water.'
      }
      for (const ending of story.availableEndings()) {
        if (context.kind === (ending === 'burn_the_bag' ? 'campfire' : 'escape')) {
          actions.push({ label: endings[ending][1], ending: true, run: () => { story.finish(ending) } })
        }
      }
      primary = actions.find(a => !a.disabled)
    }
    const person = context.kind === 'npc'
    mood.hidden = !person
    mark(dock, 'kind', context.kind)
    mark(dock, 'npc', context.kind === 'npc' ? context.npcId : null)
    mark(dock, 'tone', tone)
    mark(mood, 'tone', tone)
    mark(dock, 'air', air)
    mark(dock, 'beat', person && lastTurn ? lastTurn.action : null)
    mark(dock, 'state', pending ? 'pending' : null)
    mark(said, 'first', person && !lastTurn ? '' : null)
    if (tone && shownTone && tone !== shownTone && !still()) {
      play(rule, [{ transform: 'scaleX(2.4)', opacity: 1 }, { transform: 'scaleX(1)' }], 900, 'cubic-bezier(0.2, 0.75, 0.25, 1)')
    }
    shownTone = tone

    // While the islander thinks, the last line stays where it is and dims. Nothing jumps.
    const waiting = pending ? 'wait\n' + (sent?.ack ?? '') : ''
    if (waiting !== statusKey) {
      statusKey = waiting
      status.replaceChildren()
      if (pending) {
        if (sent?.ack) status.append(make('span', 'ww-ack', sent.ack), make('span', 'ww-sep', ' · '))
        status.append(make('span', 'ww-wait', 'Watching for a response…'))
      }
    }
    renderSaid(notice || line, notice ? '' : heard, hint, !person || !!notice)

    const nextReplies = replies.map(r => [r.label, r.gesture ?? '', r.say ?? '', r.opens ? 'opens' : ''].join('\t')).join('\n')
    if (nextReplies !== replyKey) {
      replyKey = nextReplies
      choices.replaceChildren(...replies.map((reply, index) => {
        const b: HTMLButtonElement = reply.opens
          ? button(reply.label, () => openDialog(speech))
          : button(reply.label, () => void takeTurn({ gesture: reply.gesture, say: reply.say }, { ack: reply.label, el: b }))
        if (reply.opens) b.setAttribute('aria-haspopup', 'dialog')
        else if (reply.say) b.dataset.says = ''
        b.style.setProperty('--i', String(index))
        return b
      }))
    }
    for (const el of choices.children) {
      const b = el as HTMLButtonElement
      if (b.disabled !== !!pending) b.disabled = !!pending
      b.classList.toggle('is-sent', sent?.el === b)
    }

    const nextRail = actions.map(a => (a.ending ? 'ending\t' : '\t') + a.label).join('\n')
    if (nextRail !== railKey) {
      railKey = nextRail
      rail.replaceChildren(...actions.map((action, index) => {
        const b = button('', () => {
          const live = actions[index]
          if (live && !live.disabled) live.run()
        })
        const key = make('kbd', '', String(index + 1))
        key.setAttribute('aria-hidden', 'true')
        b.append(key, document.createTextNode(action.label))
        if (action.ending) b.dataset.ending = ''
        b.style.setProperty('--i', String(index))
        return b
      }))
    }
    actions.forEach((action, index) => {
      const b = rail.children[index] as HTMLButtonElement
      if (b.disabled !== !!action.disabled) b.disabled = !!action.disabled
      const tip = action.label + ' · ' + (index + 1) + (action === primary ? ' / E' : '')
      if (b.title !== tip) b.title = tip
      b.classList.toggle('is-sent', sent?.el === b)
    })
  }
  function setContext(next: InteractionContext | null) {
    if (disposed || next === context) return
    if (context && next && next.kind === context.kind) {
      if (next.kind === 'npc' && context.kind === 'npc') {
        if (next.npcId === context.npcId && !!next.talaPresent === !!context.talaPresent && !!next.trespassing === !!context.trespassing) {
          // The spear going up or down changes the panel's posture only: the turn in hand and the words stay.
          if (!!next.hostile !== !!context.hostile) {
            context.hostile = !!next.hostile
            renderDock()
          }
          return
        }
      } else if (next.kind !== 'salvage' || (context.kind === 'salvage' && context.item === next.item)) return
    }
    pending?.abort()
    pending = null
    sent = null
    if (speech.open) speech.close()
    // Tala walking up, or a step over the camp line, changes what you can do, not who you are with.
    const sameFace = !!context && !!next && context.kind === 'npc' && next.kind === 'npc' && context.npcId === next.npcId
    context = next ? { ...next } : null
    lastTurn = null
    notice = ''
    if (context && !sameFace) {
      // A new face or a new thing: let every part make its entrance again.
      saidKey = replyKey = railKey = '\n'
      shownTone = null
      scene = !scene
      mark(dock, 'scene', scene ? 'b' : 'a')
    }
    renderDock()
  }
  let purse: number | null = null
  const unsubscribe = story.subscribe(s => {
    put(cash, money.format(s.cashAmount))
    put(tag, statusTags[s.bagState])
    put(held, items[s.heldItem])
    const reading = 'Field notes · ' + [cash.textContent, tag.textContent, held.textContent].join(' · ')
    if (notesToggle.getAttribute('aria-label') !== reading) notesToggle.setAttribute('aria-label', reading)
    if (purse !== null && s.cashAmount < purse) {
      // The ledger takes the loss without comment.
      spent.textContent = '−' + money.format(purse - s.cashAmount)
      play(spent, still()
        ? [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }]
        : [{ opacity: 0, transform: 'translateY(-0.35rem)' }, { opacity: 1, transform: 'translateY(0)', offset: 0.12 },
          { opacity: 1, transform: 'translateY(0.2rem)', offset: 0.7 }, { opacity: 0, transform: 'translateY(1rem)' }], 2400)
    }
    purse = s.cashAmount
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
    if (action && !action.disabled) {
      e.preventDefault()
      e.stopImmediatePropagation()
      nudge(rail.children[actions.indexOf(action)])
      action.run()
    }
  }, { capture: true, signal })
  function dispose() {
    disposed = true
    pending?.abort()
    stopMic()
    listeners.abort()
    unsubscribe()
    window.clearTimeout(leaving)
    for (const modal of [notes, speech, outcome]) if (modal.open) modal.close()
    root.remove()
  }
  return { setContext, capture, dispose }
}
