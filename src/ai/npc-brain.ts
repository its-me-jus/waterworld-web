import { normalizeDecision, type NpcAiDecision, type NpcId, type NpcTurnRequest } from './contract.ts'
import { fallbackDecision, reconcileDecision } from './fallback-brain.ts'
import type { StoryManager } from './story-state.ts'

/** Cancel slow fetchers even if a custom transport ignores AbortSignal. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function createNpcBrain(story: StoryManager, fetcher: typeof fetch = globalThis.fetch) {
  let current: AbortController | undefined
  let retryAfter = 0
  let disposed = false
  // A new run, equip, capture or newer turn makes the old response obsolete.
  const unsubscribe = story.subscribe(() => current?.abort())
  async function cloud(request: NpcTurnRequest, signal: AbortSignal) {
    const response = await fetcher('/api/npc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal, credentials: 'same-origin', cache: 'no-store',
    })
    signal.throwIfAborted()
    if (response.status === 429 || response.status === 503) retryAfter = Date.now() + 30_000
    if (!response.ok) return null
    const decision = normalizeDecision(await response.json(), request, 'cloud')
    return decision && reconcileDecision(request, decision)
  }
  async function turn(npcId: NpcId, input: Parameters<StoryManager['request']>[1] = {},
    signal?: AbortSignal): Promise<NpcAiDecision> {
    if (disposed) throw new Error('NPC brain has been disposed')
    signal?.throwIfAborted()
    if (story.getState().ending) throw new Error('This run has ended')
    current?.abort()
    const request = story.request(npcId, input)
    const owner = new AbortController()
    current = owner
    const stop = () => owner.abort()
    signal?.addEventListener('abort', stop, { once: true })
    const deadline = new AbortController()
    const combined = AbortSignal.any([owner.signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(), 8_250)
    try {
      let decision: NpcAiDecision | null = null
      if (Date.now() >= retryAfter) {
        try { decision = await untilAborted(cloud(request, combined), combined) }
        catch { owner.signal.throwIfAborted() }
      }
      owner.signal.throwIfAborted()
      decision ??= fallbackDecision(request)
      current = undefined
      story.applyDecision(request, decision)
      return decision
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (current === owner) current = undefined
    }
  }
  return {
    turn,
    dispose() { disposed = true; current?.abort(); unsubscribe() },
  }
}
export type NpcBrain = ReturnType<typeof createNpcBrain>
