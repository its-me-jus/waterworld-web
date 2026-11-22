import { normalizeDecision, type NpcAction, type NpcAiDecision, type NpcPose, type NpcTurnRequest } from './contract.ts'

type Beat = Pick<NpcAiDecision, 'pose' | 'action' | 'caption' | 'trustDelta' | 'suspicionDelta'>
  & Partial<Pick<NpcAiDecision, 'gossip' | 'utterance' | 'translationHint'>>

const openPalms = { label: 'Open palms', gesture: 'empty_hands' } as const
const giveSpace = { label: 'Give space', gesture: 'back_away' } as const

function beat(pose: NpcPose, action: NpcAction, caption: string, trustDelta = 0, suspicionDelta = 0): Beat {
  return { pose, action, caption, trustDelta, suspicionDelta }
}

function kael(r: NpcTurnRequest): Beat {
  const { gesture, heldItem, relationship } = r
  if (gesture === 'back_away') {
    return beat('watch_suspicious', 'step_back', 'Kael steps off the path. The spear follows you for one more pace.', 1, -2)
  }
  if (gesture === 'empty_hands' || gesture === 'crouch' && heldItem !== 'spear') {
    return beat('idle', 'watch', 'His eyes move from your fingers to your face. The spear tip sinks into the sand.', 2, -2)
  }
  if (heldItem === 'spear' && (gesture === 'wave' || gesture === 'offer_item') || r.trespassing && relationship.suspicion >= 5) {
    return { ...beat('charge_attack', 'attack_chase', 'One heel grinds into the grit. The spear levels. Kael breaks into a run.', -4, 5),
      utterance: 'Rakh!', gossip: 'Kael drove the stranger back from the path.' }
  }
  if (heldItem === 'spear' || r.trespassing) {
    return { ...beat('warn_spear_raise', 'warn', 'Wood cracks twice against basalt. Kael plants himself across the path.', -1, 2),
      utterance: 'Tuk. Tuk.', gossip: 'Kael sounded a warning at the boundary.' }
  }
  if (gesture === 'offer_cash' || gesture === 'offer_item' && (heldItem === 'cash_wad' || heldItem === 'cash_bag')) {
    return { ...beat('laugh_baffled', 'scoff_at_cash', 'A wet banknote clings to his thumb. Kael flings it off and scrubs his thumb on a leaf.', -1, 1),
      utterance: 'Hrr.' }
  }
  if (gesture === 'drop_bag') return beat('curious_tilt', 'step_back', 'The duffel lands with a wet slap. Kael takes a step back. His grip loosens.', 1, -1)
  if (gesture === 'offer_item' && isGift(heldItem)) {
    return { ...beat('accept_gift', 'accept_offer', 'Kael lifts the salvage to the light. Two fingers brush his chest before he pockets it.', 3, -2),
      gossip: 'Kael carried a gift from the reef into camp.' }
  }
  if (relationship.trust >= 3) return beat('beckon_follow', 'beckon_to_elder', 'Kael turns his spear sideways and motions toward the fire with his chin.')
  if (relationship.suspicion >= 6) return beat('stalk', 'stalk', 'Fronds stir a few paces behind you. The same spear point catches the sun.')
  if (gesture === 'wave') return beat('curious_tilt', 'watch', 'Kael tracks the arc of your hand. One eyebrow lifts. The other stays on duty.')
  return beat('watch_suspicious', 'watch', 'Kael taps the butt of his spear against a stone and waits.', 0, 0)
}

function isGift(item: NpcTurnRequest['heldItem']) {
  return item === 'salvage_compass' || item === 'salvage_flare' || item === 'radio_battery'
}

function tala(r: NpcTurnRequest): Beat {
  const { gesture, heldItem } = r
  if (gesture === 'offer_cash' || gesture === 'offer_item' && (heldItem === 'cash_bag' || heldItem === 'cash_wad')) {
    return beat('laugh_baffled', 'scoff_at_cash', 'Tala wrings a bill like a sock. “Ten thousand wet leaf. You buy one very small puddle.”', 0, -1)
  }
  if (gesture === 'offer_item' && isGift(heldItem)) {
    return { ...beat('accept_gift', 'accept_offer', 'Tala pockets the salvage. “Bright iron! You read cargo book too? Come, I show old one.”', 4, -2),
      gossip: 'Tala showed Kael the salvage the stranger gave her.' }
  }
  if (heldItem === 'spear' && gesture !== 'empty_hands' && gesture !== 'back_away') {
    return beat('watch_suspicious', 'warn', 'Tala ducks. “Cargo rule number one. Pointy end down. That one I learn twice.”', -1, 2)
  }
  if (gesture === 'back_away') return beat('idle', 'step_back', 'Tala gives you room. “Good distance. Kael count fingers from here.”', 1, -1)
  if (gesture === 'drop_bag') return beat('beckon_follow', 'beckon_to_caves', 'She toes the duffel. “Cave got dry shelf. Bag swim very bad.”', 1, -1)
  if (gesture === 'crouch' || gesture === 'empty_hands') {
    return { ...beat('curious_tilt', 'watch', 'Tala raises her palms to match. “Good. Show Kael this. Keep all original fingers.”', 2, -1),
      gossip: 'Tala showed Kael how the stranger lowered their hands.' }
  }
  if (gesture === 'wave') return beat('curious_tilt', 'watch', 'Tala waves with both hands. “Cargo people wave one. Island discount, you get two.”', 1, -1)
  if (r.relationship.trust >= 4 && /elder|oru|leave|escape|translate/i.test(r.say ?? '')) {
    return beat('beckon_follow', 'beckon_to_elder', 'Tala points inland. “Old one know tide. You bring compass. I do mouth work.”')
  }
  if (/bag|stash|cash|cave/i.test(r.say ?? '')) return beat('beckon_follow', 'beckon_to_caves', 'Tala traces a hollow under the rock. “Tidal cave. Put bag high. Sea charge storage.”')
  return beat('beckon_follow', 'beckon_to_elder', 'Tala points to your hands. “No green paper. Kael think cursed leaf. Show palm. Bring bright iron from broken boat.”')
}

function oru(r: NpcTurnRequest): Beat {
  const { gesture, heldItem } = r
  let response: Beat
  let hint: string
  if (gesture === 'back_away') {
    response = beat('sit_fire', 'step_back', 'Oru draws his feet back and leaves a gap in the circle.', 1, -1)
    hint = 'Room for you. Room for him. Good.'
  } else if (heldItem === 'spear' && gesture !== 'empty_hands' || r.trespassing && r.relationship.suspicion >= 5 && gesture !== 'empty_hands') {
    response = beat('watch_suspicious', 'warn', 'Oru lays a palm across the trail. Behind him, a shell rattle shivers.', -2, 3)
    hint = 'Pointy stick stay outside circle.'
  } else if (gesture === 'offer_cash' || gesture === 'offer_item' && (heldItem === 'cash_bag' || heldItem === 'cash_wad')) {
    response = beat('laugh_baffled', 'scoff_at_cash', 'Oru holds the bill to the sun, folds it around a beetle and lets the beetle go.', -1, 1)
    hint = 'Leaf make small boat. Beetle pay nothing.'
  } else if (gesture === 'offer_item' && isGift(heldItem)) {
    response = { ...beat('accept_gift', 'accept_offer', 'Oru weighs the salvage in one hand. With the other he traces a channel in the ash.', 3, -2),
      gossip: 'Oru traced the channel for the stranger.' }
    hint = 'Reef open when water turn. Watch line he draw.'
  } else if (gesture === 'crouch' || gesture === 'empty_hands' || gesture === 'drop_bag') {
    response = beat('sit_fire', 'watch', 'Oru slides a flat stone close to the coals and taps the seat beside it.', 2, -2)
    hint = 'Sit. Warm fingers first. Big questions after.'
  } else if (r.relationship.trust >= 3 && r.talaTranslating) {
    response = beat('beckon_follow', 'guide_escape', 'Oru points along a pale seam in the reef. Two shells part in his palm.')
    hint = 'See white line? Tide make road. Compass keep you on it.'
  } else {
    response = beat('sit_fire', 'watch', r.relationship.suspicion >= 5
      ? 'A watcher taps his spear behind Oru. Oru turns his stool across the path.'
      : 'Oru rolls a shell between his palms. His eyes settle on your hands.')
    hint = 'He wait. Hands tell better than mouth.'
  }
  if (r.talaTranslating && r.talaTrust >= 4) response.translationHint = hint
  return response
}

/** One reproducible reaction to the visible gesture, the equipment and the tribe's memory. */
export function fallbackDecision(request: NpcTurnRequest): NpcAiDecision {
  const { npcId } = request
  const response = npcId === 'kael' ? kael(request) : npcId === 'tala' ? tala(request) : oru(request)
  const canSpeak = npcId === 'tala' || npcId === 'oru' && request.talaTranslating && request.talaTrust >= 4
  const choices: NpcAiDecision['suggestedChoices'] = canSpeak && response.action !== 'warn'
    ? [openPalms, { label: npcId === 'tala' ? 'Ask about the elder' : 'Ask about the tide',
      say: npcId === 'tala' ? 'Can you take me to the elder?' : 'When can we leave the reef?' }]
    : [openPalms, giveSpace]
  const nextHeld = request.gesture === 'drop_bag' || request.gesture === 'empty_hands' || response.action === 'accept_offer'
    ? 'none' : request.heldItem
  if (nextHeld === 'spear') choices.push({ label: 'Wave spear · risky', gesture: 'wave' })
  else if (nextHeld === 'cash_bag' || nextHeld === 'cash_wad') choices.push({ label: 'Drop duffel', gesture: 'drop_bag' })
  else choices.push({ label: 'Give a wave', gesture: 'wave' })
  const firstMeeting = !request.relationship.met
  const unlockFlag = firstMeeting && npcId === 'tala' ? 'metTala' : firstMeeting && npcId === 'oru' ? 'metOru'
    : npcId === 'kael' && response.trustDelta > 0 && response.suspicionDelta < 0 ? 'survivedKael' : undefined
  return { npcId, ...response, source: 'fallback', suggestedChoices: choices.map(choice => ({ ...choice })),
    ...(unlockFlag ? { unlockFlag } : {}) }
}

/** A model can stage an encounter, while the same physical choice has the same game consequences online and offline. */
export function reconcileDecision(request: NpcTurnRequest, cloud: NpcAiDecision): NpcAiDecision {
  const local = fallbackDecision(request)
  const observing = !request.gesture && !request.trespassing && request.heldItem !== 'spear'
  const ambient = cloud.action === 'idle' || cloud.action === 'watch' || cloud.action === 'step_back'
    || cloud.action === 'beckon_to_elder' || cloud.action === 'beckon_to_caves'
  const compatible = cloud.action === local.action || observing && ambient && local.action !== 'guide_escape'
  const flavor = compatible ? cloud : local
  const result: NpcAiDecision = {
    npcId: request.npcId, caption: flavor.caption, action: flavor.action,
    pose: observing && compatible && ambient && (cloud.pose === 'idle' || cloud.pose === 'watch_suspicious'
      || cloud.pose === 'curious_tilt' || cloud.pose === 'beckon_follow' || cloud.pose === 'sit_fire') ? cloud.pose : local.pose,
    ...(flavor.utterance ? { utterance: flavor.utterance } : {}),
    ...(flavor.translationHint ? { translationHint: flavor.translationHint } : {}),
    ...(local.gossip ? { gossip: local.gossip } : {}),
    ...(local.unlockFlag ? { unlockFlag: local.unlockFlag } : {}),
    trustDelta: local.trustDelta, suspicionDelta: local.suspicionDelta,
    source: 'cloud', suggestedChoices: cloud.suggestedChoices,
  }
  return normalizeDecision(result, request, 'cloud') ?? local
}
