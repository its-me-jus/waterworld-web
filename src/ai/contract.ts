/** Shared by the island simulation, the HUD, and the server. No runtime dependencies. */
export const NPC_IDS = ['kael', 'tala', 'oru'] as const
export const NPC_POSES = ['idle', 'patrol', 'watch_suspicious', 'warn_spear_raise', 'stalk',
  'charge_attack', 'curious_tilt', 'beckon_follow', 'accept_gift', 'laugh_baffled', 'sit_fire'] as const
export const NPC_ACTIONS = ['idle', 'watch', 'warn', 'stalk', 'attack_chase', 'step_back',
  'beckon_to_caves', 'beckon_to_elder', 'accept_offer', 'scoff_at_cash', 'guide_escape'] as const
export const PLAYER_GESTURES = ['empty_hands', 'crouch', 'back_away', 'offer_cash', 'offer_item', 'wave', 'drop_bag'] as const
export const HELD_ITEMS = ['none', 'cash_bag', 'cash_wad', 'spear', 'salvage_compass', 'salvage_flare', 'radio_battery'] as const
export type NpcId = typeof NPC_IDS[number]
export type NpcPose = typeof NPC_POSES[number]
export type NpcAction = typeof NPC_ACTIONS[number]
export type PlayerGesture = typeof PLAYER_GESTURES[number]
export type HeldItem = typeof HELD_ITEMS[number]
export type EndingId = 'smart_escape' | 'stealth_heist' | 'burn_the_bag'
export type NpcRelationship = {
  trust: number
  suspicion: number
  met: boolean
  history: Array<{ gesture?: PlayerGesture; say?: string; caption: string; action: NpcAction }>
}
export type StoryState = {
  cashAmount: number
  bagState: 'carried' | 'dropped' | 'stashed_caves'
  inventory: HeldItem[]
  heldItem: HeldItem
  relationships: Record<NpcId, NpcRelationship>
  gossip: string[]
  flags: {
    seenSmoke: boolean; foundTotem: boolean; stashedCashInCaves: boolean
    metTala: boolean; survivedKael: boolean; metOru: boolean
    salvagedCompass: boolean; salvagedFlare: boolean; salvagedBattery: boolean
    burnedCash: boolean; timesCaptured: number
  }
  ending: EndingId | null
}
export type NpcTurnRequest = {
  npcId: NpcId
  gesture?: PlayerGesture
  say?: string
  heldItem: HeldItem
  relationship: NpcRelationship
  gossip: string[]
  talaTranslating: boolean
  talaTrust: number
  trespassing?: boolean
}
export type NpcAiDecision = {
  npcId: NpcId
  /** Sensory narration for Kael/Oru. Only Tala speaks English. */
  caption: string
  utterance?: string
  translationHint?: string
  pose: NpcPose
  action: NpcAction
  trustDelta: number
  suspicionDelta: number
  suggestedChoices: Array<{ label: string; gesture?: PlayerGesture; say?: string }>
  unlockFlag?: string
  gossip?: string
  source: 'cloud' | 'fallback'
}

// The model directs a beat. These are physical observations with no implied subtitles.
const beats: Record<'kael' | 'oru', Record<NpcAction, string>> = {
  kael: {
    idle: 'Kael stands barefoot in the wash. His spear casts a longer shadow than he does.',
    watch: 'Kael counts your fingers with the tip of his spear. He counts them again.',
    warn: 'Two hard taps on the stone. Kael lays the spear across your path.',
    stalk: 'A shell cracks behind you. Kael is keeping pace just inside the trees.',
    attack_chase: 'Sand kicks up under Kael’s heel. The spear comes level and he breaks into a run.',
    step_back: 'Kael lowers the point. One footprint fills with seawater as he steps back.',
    beckon_to_caves: 'Kael taps the black mouth of the cave with the spear’s shadow, then crooks a finger.',
    beckon_to_elder: 'Kael points past the smoke to a seated figure. He waits for you to move first.',
    accept_offer: 'Kael weighs the gift on his palm. The spear tip dips toward the sand.',
    scoff_at_cash: 'Kael pinches the wet note with two shells and drops it like a dead jellyfish.',
    guide_escape: 'Kael paces to the waterline and traces a channel through the breakers with his spear.',
  },
  oru: {
    idle: 'Oru turns a coal with a stick. A thread of smoke curls past one half-closed eye.',
    watch: 'Oru’s gaze moves from the duffel to your hands. The fire pops once.',
    warn: 'Oru lays the charred stick across your shadow. The people by the fire go still.',
    stalk: 'Oru walks around the fire, eyes fixed on the space between your hands.',
    attack_chase: 'Oru strikes the fire ring. Behind you, bare feet drum on the hard sand.',
    step_back: 'Oru slides a second flat stone into the warmth at the edge of the fire.',
    beckon_to_caves: 'Oru dusts ash from two fingers and points them toward the tidal caves.',
    beckon_to_elder: 'Oru pats the stone by the embers, then holds an open palm above it.',
    accept_offer: 'Oru takes the offering in both hands and makes room for you by the fire.',
    scoff_at_cash: 'Oru holds a damp bill up to the sun. It drips into the tea. One slow blink.',
    guide_escape: 'Oru draws a reef gap in the ash, sets a shell boat in it, and pushes it out to sea.',
  },
}
const syllables = /^(?:(?:keh|rru|tok|ka|hru|tah|oru|ah|ho|nuh|ha|ru|eh|mm|tuk|sha)[.!?…,-]*\s*){1,4}$/i
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function line(value: unknown, max: number) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}
function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}
function delta(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(-5, Math.min(5, Math.round(value))) : null
}

/** Validate both sides of the HTTP boundary. Narration for silent speakers is closed-vocabulary. */
export function normalizeDecision(value: unknown, request: NpcTurnRequest, source: NpcAiDecision['source']): NpcAiDecision | null {
  if (!record(value) || value.npcId !== request.npcId || !member(value.pose, NPC_POSES)
    || !member(value.action, NPC_ACTIONS) || !line(value.caption, 240) || !Array.isArray(value.suggestedChoices)
    || value.suggestedChoices.length < 2 || value.suggestedChoices.length > 3) return null
  const trustDelta = delta(value.trustDelta)
  const suspicionDelta = delta(value.suspicionDelta)
  if (trustDelta === null || suspicionDelta === null) return null
  const { npcId } = request
  const translating = npcId === 'oru' && request.talaTranslating && request.talaTrust >= 4
  const choices: NpcAiDecision['suggestedChoices'] = []
  for (const choice of value.suggestedChoices) {
    if (!record(choice) || !line(choice.label, 32)) return null
    const gesture = choice.gesture
    const say = line(choice.say, 160)
    if (gesture !== undefined && !member(gesture, PLAYER_GESTURES)) return null
    if (!gesture && !say) return null
    if (!gesture && !(npcId === 'tala' || translating)) continue
    choices.push({ label: line(choice.label, 32), ...(member(gesture, PLAYER_GESTURES) ? { gesture } : {}),
      ...(say && (npcId === 'tala' || translating) ? { say } : {}) })
  }
  for (const [label, gesture] of [['Show palms', 'empty_hands'], ['Step back', 'back_away'], ['Kneel', 'crouch']] as const) {
    if (choices.length >= 2) break
    if (!choices.some(choice => choice.gesture === gesture)) choices.push({ label, gesture })
  }
  const utterance = line(value.utterance, 120)
  const hint = line(value.translationHint, 180)
  const gossip = line(value.gossip, 160)
  const unlockFlag = line(value.unlockFlag, 40)
  return {
    npcId, action: value.action, pose: value.pose, source, trustDelta, suspicionDelta,
    caption: npcId === 'tala' ? line(value.caption, 240) : beats[npcId][value.action],
    suggestedChoices: choices,
    ...(utterance && (npcId === 'tala' || syllables.test(utterance)) ? { utterance } : {}),
    ...(translating && hint ? { translationHint: hint } : {}),
    ...(gossip ? { gossip } : {}), ...(unlockFlag ? { unlockFlag } : {}),
  }
}
