import { HELD_ITEMS, NPC_ACTIONS, NPC_IDS, PLAYER_GESTURES } from './contract.ts'
import type { EndingId, HeldItem, NpcAiDecision, NpcId, NpcRelationship, NpcTurnRequest, PlayerGesture, StoryState } from './contract.ts'

const SAVE_KEY = 'waterworld.heist.v1'
const INITIAL_CASH = 2_400_000
const WAD = 10_000
const HISTORY_LIMIT = 6
const GOSSIP_LIMIT = 12
const salvageFlags = {
  salvage_compass: 'salvagedCompass',
  salvage_flare: 'salvagedFlare',
  radio_battery: 'salvagedBattery',
} as const
type Salvage = keyof typeof salvageFlags
type SaveStorage = Pick<Storage, 'getItem' | 'setItem'>
type TurnInput = { gesture?: PlayerGesture; say?: string; talaPresent?: boolean; trespassing?: boolean }

function defaultStory(): StoryState {
  const relationship = (suspicion: number): NpcRelationship => ({ trust: 0, suspicion, met: false, history: [] })
  return {
    cashAmount: INITIAL_CASH, bagState: 'carried', inventory: ['cash_bag', 'cash_wad'], heldItem: 'cash_bag',
    relationships: { kael: relationship(3), tala: relationship(1), oru: relationship(2) },
    gossip: [], ending: null,
    flags: { seenSmoke: false, foundTotem: false, stashedCashInCaves: false, metTala: false, survivedKael: false,
      metOru: false, salvagedCompass: false, salvagedFlare: false, salvagedBattery: false, burnedCash: false, timesCaptured: 0 },
  }
}

function defaultStorage(): SaveStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function integer(value: unknown, min: number, max: number, fallback = min) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback
}
function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function syncCashInventory(state: StoryState) {
  state.inventory = state.inventory.filter(item => item !== 'cash_bag' && item !== 'cash_wad')
  if (state.bagState === 'carried') {
    state.inventory.push('cash_bag')
    if (state.cashAmount >= WAD) state.inventory.push('cash_wad')
  }
  if (!state.inventory.includes(state.heldItem)) state.heldItem = 'none'
}

function restoreRelationship(raw: unknown, initial: NpcRelationship): NpcRelationship {
  if (!record(raw)) return initial
  const history: NpcRelationship['history'] = []
  if (Array.isArray(raw.history)) {
    for (const entry of raw.history.slice(-HISTORY_LIMIT)) {
      if (!record(entry) || !member(entry.action, NPC_ACTIONS) || !text(entry.caption, 240)) continue
      history.push({ caption: text(entry.caption, 240), action: entry.action,
        ...(member(entry.gesture, PLAYER_GESTURES) ? { gesture: entry.gesture } : {}),
        ...(text(entry.say, 160) ? { say: text(entry.say, 160) } : {}) })
    }
  }
  return { trust: integer(raw.trust, -10, 10, initial.trust), suspicion: integer(raw.suspicion, 0, 10, initial.suspicion),
    met: raw.met === true, history }
}

function load(storage: SaveStorage | null): StoryState {
  const state = defaultStory()
  try {
    const saved = storage?.getItem(SAVE_KEY)
    if (!saved || saved.length > 64_000) return state
    const raw: unknown = JSON.parse(saved)
    if (!record(raw)) return state
    state.cashAmount = integer(raw.cashAmount, 0, INITIAL_CASH, INITIAL_CASH)
    if (member(raw.bagState, ['carried', 'dropped', 'stashed_caves'])) state.bagState = raw.bagState
    if (Array.isArray(raw.inventory)) state.inventory = [...new Set(raw.inventory.filter((item): item is HeldItem => member(item, HELD_ITEMS) && item !== 'none'))]
    if (member(raw.heldItem, HELD_ITEMS)) state.heldItem = raw.heldItem
    if (record(raw.flags)) {
      for (const name of Object.keys(state.flags) as Array<keyof StoryState['flags']>) {
        if (name === 'timesCaptured') state.flags[name] = integer(raw.flags[name], 0, Number.MAX_SAFE_INTEGER)
        else state.flags[name] = raw.flags[name] === true
      }
    }
    if (record(raw.relationships)) {
      for (const id of NPC_IDS) state.relationships[id] = restoreRelationship(raw.relationships[id], state.relationships[id])
    }
    state.flags.metTala = state.relationships.tala.met
    state.flags.metOru = state.relationships.oru.met
    if (state.bagState === 'stashed_caves') state.flags.stashedCashInCaves = true
    for (const item of Object.keys(salvageFlags) as Salvage[]) {
      if (state.inventory.includes(item)) state.flags[salvageFlags[item]] = true
    }
    if (Array.isArray(raw.gossip)) state.gossip = raw.gossip.slice(-GOSSIP_LIMIT).map(note => text(note, 160)).filter(Boolean)
    if (member(raw.ending, ['smart_escape', 'stealth_heist', 'burn_the_bag'])) state.ending = raw.ending
    syncCashInventory(state)
  } catch { return defaultStory() }
  return state
}

function adjust(relationship: NpcRelationship, trust: number, suspicion: number) {
  relationship.trust = integer(relationship.trust + trust, -10, 10)
  relationship.suspicion = integer(relationship.suspicion + suspicion, 0, 10)
}

/** All physical interactions are explicit. Opening field notes or approaching an NPC never spends cash. */
export function createStoryState(storage: SaveStorage | null = defaultStorage()) {
  let state = load(storage)
  let revision = 0
  const listeners = new Set<(value: StoryState) => void>()
  const pending = new WeakMap<NpcTurnRequest, number>()
  const completed = new WeakSet<NpcTurnRequest>()
  const getState = () => structuredClone(state)
  function commit() {
    revision++
    try { storage?.setItem(SAVE_KEY, JSON.stringify(state)) } catch { /* A memory-only run is still playable. */ }
    for (const listener of listeners) listener(getState())
  }
  function subscribe(listener: (value: StoryState) => void) {
    listeners.add(listener)
    listener(getState())
    return () => { listeners.delete(listener) }
  }
  function request(npcId: NpcId, input: TurnInput = {}): NpcTurnRequest {
    const tala = state.relationships.tala
    const talaTranslating = npcId === 'oru' && input.talaPresent === true && tala.met && tala.trust >= 4
    const say = npcId === 'tala' || talaTranslating ? text(input.say, 160) : ''
    let gesture = input.gesture
    if (gesture === 'offer_cash' && !state.inventory.includes('cash_wad')) gesture = 'empty_hands'
    if (gesture === 'drop_bag' && state.bagState !== 'carried') gesture = 'empty_hands'
    const turn: NpcTurnRequest = { npcId, heldItem: state.heldItem, relationship: structuredClone(state.relationships[npcId]),
      gossip: state.gossip.slice(-8), talaTrust: tala.trust, talaTranslating,
      ...(gesture ? { gesture } : {}), ...(say ? { say } : {}), ...(input.trespassing ? { trespassing: true } : {}) }
    pending.set(turn, revision)
    return turn
  }
  function applyDecision(turn: NpcTurnRequest, decision: NpcAiDecision) {
    if (decision.npcId !== turn.npcId || state.ending || completed.has(turn) || pending.get(turn) !== revision) return false
    completed.add(turn)
    const { npcId, gesture } = turn
    const relation = state.relationships[npcId]
    const trust = integer(decision.trustDelta, -5, 5, 0)
    const suspicion = integer(decision.suspicionDelta, -5, 5, 0)
    adjust(relation, trust, suspicion)
    relation.met = true
    relation.history.push({ caption: text(decision.caption, 240), action: decision.action,
      ...(gesture ? { gesture } : {}), ...(turn.say ? { say: text(turn.say, 160) } : {}) })
    relation.history = relation.history.slice(-HISTORY_LIMIT)
    if (npcId === 'tala') state.flags.metTala = true
    if (npcId === 'oru') state.flags.metOru = true
    if (npcId === 'kael' && trust > 0 && suspicion < 0 && decision.action !== 'attack_chase') state.flags.survivedKael = true
    if (gesture === 'drop_bag') state.bagState = 'dropped'
    if (gesture === 'empty_hands' || gesture === 'drop_bag') state.heldItem = 'none'
    if (gesture === 'offer_item' && decision.action === 'accept_offer' && Object.hasOwn(salvageFlags, turn.heldItem)) {
      state.inventory = state.inventory.filter(item => item !== turn.heldItem)
      state.heldItem = 'none'
    }
    syncCashInventory(state)

    let note = text(decision.gossip, 160)
    if (npcId === 'kael' && (decision.action === 'attack_chase' || decision.action === 'warn')) {
      adjust(state.relationships.oru, 0, decision.action === 'attack_chase' ? 2 : 1)
      note ||= 'Kael sounded the boundary alarm. Oru heard.'
    }
    if (npcId === 'tala' && trust > 0 && (decision.action === 'accept_offer' || gesture === 'empty_hands' || gesture === 'crouch')) {
      adjust(state.relationships.kael, decision.action === 'accept_offer' ? 1 : 0, -1)
      note ||= 'Tala put in a good word with Kael.'
    }
    if (note && state.gossip.at(-1) !== note) state.gossip = [...state.gossip, note].slice(-GOSSIP_LIMIT)
    commit()
    return true
  }
  function acquire(item: HeldItem) {
    if (state.ending || item !== 'spear' && !Object.hasOwn(salvageFlags, item) || state.inventory.includes(item)) return false
    if (item !== 'spear') {
      const flag = salvageFlags[item as Salvage]
      if (state.flags[flag]) return false
      state.flags[flag] = true
    }
    state.inventory.push(item)
    state.heldItem = item
    commit()
    return true
  }
  function equip(item: HeldItem) {
    if (state.ending || item !== 'none' && !state.inventory.includes(item)) return false
    if (state.heldItem !== item) { state.heldItem = item; commit() }
    return true
  }
  function stashBag() {
    if (state.ending || state.bagState !== 'carried') return false
    state.bagState = 'stashed_caves'
    state.flags.stashedCashInCaves = true
    syncCashInventory(state)
    commit()
    return true
  }
  function retrieveBag() {
    if (state.ending || state.bagState === 'carried') return false
    state.bagState = 'carried'
    syncCashInventory(state)
    state.heldItem = 'cash_bag'
    commit()
    return true
  }
  function burnCash() {
    if (state.ending || state.bagState !== 'carried' || state.cashAmount < WAD) return false
    state.cashAmount -= WAD
    state.flags.burnedCash = true
    syncCashInventory(state)
    commit()
    return true
  }
  function discover(flag: 'seenSmoke' | 'foundTotem') {
    if (state.ending || state.flags[flag]) return
    state.flags[flag] = true
    commit()
  }
  function availableEndings(): EndingId[] {
    if (state.ending) return []
    const endings: EndingId[] = []
    const { tala, oru } = state.relationships
    if (tala.met && tala.trust >= 4 && oru.met && oru.trust >= 3 && state.flags.salvagedCompass) endings.push('smart_escape')
    if (state.bagState === 'stashed_caves' && state.cashAmount >= WAD && state.flags.foundTotem && state.flags.salvagedBattery) endings.push('stealth_heist')
    if (state.bagState === 'carried' && state.flags.burnedCash) endings.push('burn_the_bag')
    return endings
  }
  function finish(ending: EndingId) {
    if (!availableEndings().includes(ending)) return false
    state.ending = ending
    if (ending === 'burn_the_bag') { state.cashAmount = 0; state.bagState = 'dropped' }
    if (ending === 'stealth_heist') state.bagState = 'carried'
    syncCashInventory(state)
    commit()
    return true
  }
  function onCaptured() {
    if (state.ending) return
    state.flags.timesCaptured++
    if (state.bagState === 'carried') state.cashAmount = Math.max(0, state.cashAmount - WAD)
    state.heldItem = 'none'
    syncCashInventory(state)
    commit()
  }
  function resumeAfterEnding() {
    if (!state.ending) return
    state.ending = null
    commit()
  }
  function reset() { state = defaultStory(); commit() }
  return { getState, subscribe, request, applyDecision, acquire, equip, stashBag, retrieveBag, burnCash,
    discover, availableEndings, finish, onCaptured, resumeAfterEnding, reset }
}

export type StoryManager = ReturnType<typeof createStoryState>
