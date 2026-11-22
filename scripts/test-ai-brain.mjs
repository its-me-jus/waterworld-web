/**
 * Run with Node 24+ from the repo: node scripts/test-ai-brain.mjs
 * Pass --offline to suppress the optional, real Gemini smoke test.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseEnv } from 'node:util'
import { handleNpc } from '../api/npc.ts'
import { NPC_IDS, NPC_POSES, NPC_ACTIONS, PLAYER_GESTURES, normalizeDecision } from '../src/ai/contract.ts'
import { createEarpiece } from '../src/ai/earpiece.ts'
import { fallbackDecision } from '../src/ai/fallback-brain.ts'
import { createNpcBrain } from '../src/ai/npc-brain.ts'
import { createStoryState } from '../src/ai/story-state.ts'

const fresh = () => createStoryState(null)
const endpoint = 'http://localhost/api/npc'

function turn(story, npcId, input) {
  const request = story.request(npcId, input)
  const decision = fallbackDecision(request)
  assert.deepEqual(decision, fallbackDecision(request), 'Identical turns should get identical offline decisions')
  checkDecision(decision, npcId, 'fallback')
  story.applyDecision(request, decision)
  return decision
}

function checkDecision(decision, npcId, source) {
  assert.equal(decision.npcId, npcId)
  assert.equal(decision.source, source)
  assert.ok(decision.caption.trim().length)
  assert.ok(NPC_POSES.includes(decision.pose))
  assert.ok(NPC_ACTIONS.includes(decision.action))
  for (const delta of [decision.trustDelta, decision.suspicionDelta]) {
    assert.ok(Number.isInteger(delta) && delta >= -5 && delta <= 5)
  }
  assert.ok(decision.suggestedChoices.length >= 2 && decision.suggestedChoices.length <= 3)
  for (const choice of decision.suggestedChoices) {
    assert.ok(choice.label.trim().length)
    assert.ok(PLAYER_GESTURES.includes(choice.gesture) || choice.say?.trim().length)
  }
}

test('Every NPC responds to every gesture offline with playable reaction choices', () => {
  for (const npcId of NPC_IDS) {
    for (const gesture of PLAYER_GESTURES) turn(fresh(), npcId, { gesture })
  }
})

test('Cash, calm hands and a raised spear get distinct reactions from Kael', () => {
  const story = fresh()
  assert.equal(story.getState().cashAmount, 2_400_000)
  assert.equal(turn(story, 'kael', { gesture: 'offer_cash' }).action, 'scoff_at_cash')
  for (const gesture of ['crouch', 'empty_hands']) {
    assert.ok(turn(story, 'kael', { gesture }).trustDelta > 0)
  }
  const request = { ...story.request('kael', { gesture: 'wave' }), heldItem: 'spear' }
  const charge = fallbackDecision(request)
  assert.equal(charge.action, 'attack_chase')
  assert.equal(charge.pose, 'charge_attack')
})

test('Tala explains island etiquette and only a trusted, present Tala can translate for Oru', () => {
  const story = fresh()
  const ask = { say: 'How do I get past the watcher?', talaPresent: true }
  const guidance = turn(story, 'tala', ask)
  assert.match([guidance.caption, guidance.utterance].join(' '), /palm|spear|stick|iron|hand|leaf|Kael/i)
  assert.equal(story.request('oru', ask).talaTranslating, false)
  for (let i = 0; i < 5; i++) turn(story, 'tala', { gesture: 'empty_hands' })
  const interpreted = story.request('oru', ask)
  assert.equal(interpreted.talaTranslating, true)
  assert.ok(fallbackDecision(interpreted).translationHint?.trim())
  assert.equal(story.request('oru', { ...ask, talaPresent: false }).talaTranslating, false)
  assert.equal(fallbackDecision(story.request('oru', { gesture: 'wave' })).translationHint, undefined)
})

test('Cloud output cannot give the watcher or elder English speech or an unearned translation', () => {
  for (const npcId of ['kael', 'oru']) {
    const request = fresh().request(npcId, { gesture: 'wave' })
    const injected = {
      ...fallbackDecision(request),
      caption: 'I am the manager of the bank.',
      utterance: 'Please give the bank its money back.',
      translationHint: 'The bank manager requests a refund.',
      trustDelta: 88,
      suspicionDelta: -99,
      source: 'cloud',
    }
    const safe = normalizeDecision(injected, request, 'cloud')
    // Rejection or a curated physical beat both preserve the language barrier.
    if (safe) {
      checkDecision(safe, npcId, 'cloud')
      assert.doesNotMatch([safe.caption, safe.utterance].join(' '), /the bank/i)
      assert.equal(safe.translationHint, undefined)
      assert.equal(safe.trustDelta, 5)
      assert.equal(safe.suspicionDelta, -5)
    }
    const valid = { ...fallbackDecision(request), source: 'cloud' }
    assert.ok(normalizeDecision(valid, request, 'cloud'))
    assert.equal(normalizeDecision({ ...valid, pose: 'fire_lasers' }, request, 'cloud'), null)
    assert.equal(normalizeDecision({ ...valid, action: 'wire_transfer' }, request, 'cloud'), null)
  }
})

test('The tribe hears about threats and gifts across encounters', () => {
  const story = fresh()
  story.acquire('spear')
  const initial = story.getState().relationships.oru.suspicion
  assert.equal(turn(story, 'kael', { gesture: 'wave' }).action, 'attack_chase')
  const threatened = story.getState()
  assert.ok(threatened.relationships.oru.suspicion > initial)
  assert.ok(threatened.gossip.length)
  story.acquire('salvage_compass')
  assert.equal(turn(story, 'tala', { gesture: 'offer_item' }).action, 'accept_offer')
  const helped = story.getState()
  assert.ok(helped.relationships.kael.suspicion < threatened.relationships.kael.suspicion)
  assert.ok(!helped.inventory.includes('salvage_compass'))
  assert.ok(story.request('oru', {}).gossip.length)
})

test('Cash handling, wash-ashore, bounded turn history and persisted progress', () => {
  const data = new Map()
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
  const story = createStoryState(storage)
  turn(story, 'kael', { gesture: 'offer_cash' })
  assert.equal(story.getState().cashAmount, 2_400_000, 'Flashing a wad does not spend it')
  for (let i = 0; i < 10; i++) turn(story, 'kael', { gesture: 'crouch' })
  const kael = story.getState().relationships.kael
  assert.equal(kael.history.length, 6)
  assert.ok(kael.trust <= 10 && kael.suspicion >= 0)
  story.stashBag()
  assert.equal(story.getState().bagState, 'stashed_caves')
  story.retrieveBag()
  assert.equal(story.getState().bagState, 'carried')
  story.onCaptured()
  assert.equal(story.getState().flags.timesCaptured, 1)
  assert.ok(story.getState().cashAmount < 2_400_000)
  const restored = createStoryState(storage)
  assert.deepEqual(restored.getState(), story.getState())
  restored.reset()
  assert.deepEqual(createStoryState(storage).getState(), fresh().getState())
  const denied = () => { throw new Error('Storage unavailable') }
  const privateMode = createStoryState({ getItem: denied, setItem: denied })
  turn(privateMode, 'tala', { gesture: 'wave' })
  assert.equal(privateMode.getState().flags.metTala, true)
})

test('Each ending requires its own gameplay conditions and Keep Progress resumes island play', async () => {
  for (const ending of ['smart_escape', 'stealth_heist', 'burn_the_bag']) {
    const story = fresh()
    assert.equal(story.finish(ending), false)
    if (ending === 'smart_escape') {
      for (let i = 0; i < 5; i++) turn(story, 'tala', { gesture: 'empty_hands' })
      for (let i = 0; i < 5; i++) turn(story, 'oru', { gesture: 'crouch', talaPresent: true })
      story.acquire('salvage_compass')
    } else if (ending === 'stealth_heist') {
      story.discover('foundTotem')
      story.acquire('radio_battery')
      story.stashBag()
    } else {
      story.burnCash()
      assert.equal(story.getState().cashAmount, 2_390_000)
    }
    assert.ok(story.availableEndings().includes(ending), `Expected ${ending} to unlock`)
    assert.equal(story.getState().ending, null)
    assert.equal(story.finish(ending), true)
    assert.equal(story.getState().ending, ending)
    const finished = story.getState()
    const brain = createNpcBrain(story, async () => new Response(null, { status: 503 }))
    await assert.rejects(brain.turn('kael', { gesture: 'wave' }))
    story.resumeAfterEnding()
    assert.deepEqual(story.getState(), { ...finished, ending: null })
    const resumed = await brain.turn('kael', { gesture: 'wave' })
    checkDecision(resumed, 'kael', 'fallback')
    assert.equal(story.getState().relationships.kael.history.at(-1).gesture, 'wave')
    brain.dispose()
  }
})

test('Browser brain uses the same-origin proxy, falls back on failure and commits one turn', async () => {
  for (const failure of ['offline', 'unavailable', 'invalid']) {
    const story = fresh()
    const calls = []
    const brain = createNpcBrain(story, async (url, options) => {
      calls.push({ url, options })
      if (failure === 'offline') throw new TypeError('Network unavailable')
      if (failure === 'unavailable') return new Response(null, { status: 503 })
      return Response.json({ action: 'wire_transfer' })
    })
    const decision = await brain.turn('kael', { gesture: 'crouch' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/api/npc')
    assert.equal(calls[0].options.method, 'POST')
    assert.equal(JSON.parse(calls[0].options.body).npcId, 'kael')
    checkDecision(decision, 'kael', 'fallback')
    assert.equal(story.getState().relationships.kael.history.length, 1)
  }
})

test('A validated cloud decision is committed and an abandoned encounter cannot mutate the save', async () => {
  const story = fresh()
  const brain = createNpcBrain(story, async (_url, options) => {
    return Response.json({ ...fallbackDecision(JSON.parse(options.body)), source: 'cloud' })
  })
  const decision = await brain.turn('tala', { gesture: 'wave' })
  checkDecision(decision, 'tala', 'cloud')
  assert.equal(story.getState().relationships.tala.history.length, 1)
  const before = story.getState()
  await assert.rejects(brain.turn('oru', { gesture: 'crouch' }, AbortSignal.abort()))
  assert.deepEqual(story.getState(), before)
  brain.dispose()

})

test('Late NPC responses cannot cross encounters, reset progress, or disable cloud in the new run', async () => {
  for (const transition of ['leave encounter', 'reset story', 'superseding turn']) {
    const story = fresh()
    const deferred = Promise.withResolvers()
    let oldRequest
    const brain = createNpcBrain(story, async (_url, options) => {
      const request = JSON.parse(options.body)
      if (!oldRequest) {
        oldRequest = request
        return deferred.promise // Simulate a transport that ignores its abort signal.
      }
      return Response.json({ ...fallbackDecision(request), source: 'cloud' })
    })
    const leaving = new AbortController()
    const pending = brain.turn('kael', { gesture: 'offer_cash' }, leaving.signal)
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    if (transition === 'leave encounter') leaving.abort()
    if (transition === 'reset story') story.reset()
    const next = await brain.turn('tala', { gesture: 'wave' })
    assert.equal(next.source, 'cloud')
    await rejected
    const committed = story.getState()
    assert.equal(committed.relationships.kael.history.length, 0)
    assert.equal(committed.relationships.tala.history.length, 1)
    deferred.resolve(transition === 'reset story' ? new Response(null, { status: 503 }) :
      Response.json({ ...fallbackDecision(oldRequest), source: 'cloud' }))
    // Let the obsolete transport finish decoding its own response.
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(story.getState(), committed)
    assert.equal((await brain.turn('oru', { gesture: 'crouch' })).source, 'cloud')
    brain.dispose()
  }
})

test('Vince only gets a signal above 18 metres and does not repeat per frame', () => {
  const radio = createEarpiece()
  const state = fresh().getState()
  assert.equal(radio.update(240, state, false), null, 'An airborne parachute has no ridge signal')
  for (const altitude of [0, 10, 18]) assert.equal(radio.update(altitude, state), null)
  assert.ok(radio.update(19, state)?.trim())
  assert.equal(radio.update(20, state), null)
  const story = fresh()
  story.stashBag()
  assert.equal(radio.update(5, story.getState()), null)
  assert.match(radio.update(19, story.getState()), /cave|stash/i)
  story.retrieveBag()
  story.onCaptured()
  radio.update(5, story.getState())
  assert.match(radio.update(19, story.getState()), /2,390,000/)
})

const post = (payload) => new Request(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

test('The proxy rejects unsupported methods, malformed requests and oversized payloads', async () => {
  assert.equal((await handleNpc(new Request(endpoint), {}, '192.0.2.1')).status, 405)
  assert.equal((await handleNpc(post({ npcId: 'vince' }), {}, '192.0.2.1')).status, 400)
  assert.equal((await handleNpc(post({ say: 'x'.repeat(200_000) }), {}, '192.0.2.1')).status, 413)
})

test('A single address cannot spend an unlimited per-minute request budget', async () => {
  for (let i = 0; i < 30; i++) {
    const response = await handleNpc(post({ npcId: 'invalid' }), {}, '192.0.2.3')
    assert.equal(response.status, 400)
  }
  assert.equal((await handleNpc(post({ npcId: 'invalid' }), {}, '192.0.2.3')).status, 429)
  assert.equal((await handleNpc(post({ npcId: 'invalid' }), {}, '192.0.2.4')).status, 400)
})

test('The proxy sends a constrained Gemini request and validates the actual SDK response', async t => {
  const story = fresh()
  const notes = []
  for (let i = 1; i <= 12; i++) {
    const request = story.request('tala', { gesture: 'wave' })
    const gossip = `Tala counted ${i} passing boats.`
    notes.push(gossip)
    story.applyDecision(request, { ...fallbackDecision(request), gossip })
  }
  const request = story.request('kael', { gesture: 'empty_hands' })
  assert.deepEqual(request.gossip, notes.slice(-8), 'Only the eight latest notes may enter a proxy turn')
  const generated = { ...fallbackDecision(request), source: 'cloud', utterance: 'Give me your wallet',
    translationHint: 'I can speak fluent English', caption: 'I can speak fluent English' }
  let envelope
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    envelope = JSON.parse(options.body)
    return Response.json({
      candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(generated) }] } }],
    })
  })
  const response = await handleNpc(post(request), { GEMINI_API_KEY: 'fixture-key', GEMINI_NPC_MODEL: 'gemini-3.5-flash-lite' }, '192.0.2.5')
  assert.equal(response.status, 200)
  assert.equal(envelope.generationConfig.responseMimeType, 'application/json')
  assert.ok(envelope.generationConfig.responseJsonSchema.required.includes('action'))
  assert.ok(envelope.systemInstruction.parts.length)
  const result = await response.json()
  checkDecision(result, 'kael', 'cloud')
  assert.notEqual(result.caption, generated.caption)
  assert.equal(result.utterance, undefined)
  assert.equal(result.translationHint, undefined)
})

function readLiveEnvironment() {
  const candidates = process.env.WATERWORLD_ENV_FILE ? [process.env.WATERWORLD_ENV_FILE] : [
    new URL('../.env', import.meta.url), new URL('../.env.local', import.meta.url),
  ]
  const file = Object.assign({}, ...candidates.filter(path => existsSync(path)).map(path => parseEnv(readFileSync(path, 'utf8'))))
  const values = {}
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_NPC_MODEL']) {
    if (process.env[name] || file[name]) values[name] = process.env[name] || file[name]
  }
  return values
}

const env = process.argv.includes('--offline') ? {} : readLiveEnvironment()
const skip = process.argv.includes('--offline') ? 'offline requested' :
  !env.GEMINI_API_KEY && !env.GOOGLE_API_KEY ? 'no project API key configured' : false

test('Live Gemini via POST /api/npc returns a schema-valid, untranslated Kael encounter', { skip }, async () => {
  const request = fresh().request('kael', { gesture: 'empty_hands' })
  const response = await handleNpc(post(request), env, '192.0.2.2')
  assert.equal(response.status, 200, `Live proxy returned HTTP ${response.status}`)
  const decision = await response.json()
  checkDecision(decision, 'kael', 'cloud')
  const normalized = normalizeDecision(decision, request, 'cloud')
  const local = fallbackDecision(request)
  assert.ok(normalized)
  assert.ok(decision.caption === normalized.caption || decision.caption === local.caption, 'Only authored physical narration may describe Kael')
  assert.ok(decision.utterance === normalized.utterance || decision.utterance === local.utterance)
  assert.equal(decision.translationHint, undefined)
  // Kael may be described in English. Dialogue has a separate, constrained field.
  assert.doesNotMatch(decision.caption, /["\u201c\u201d]/)
  assert.doesNotMatch(decision.utterance ?? '', /\b(the|you|your|I|give|money|leave|drop|hand|hands|please|stranger|hello|back|away|stop)\b/i)
})
