/**
 * Dev only (loaded by main.ts under import.meta.env.DEV): auditions of the
 * islanders' sound rendered offline through the same engine the game runs,
 * and taps that record the live mix. Used by the scripts in shots/sound.
 *
 *   await ww.soundDev.audition({ kind: 'fire', night: 1, rain: 0 })       -> { wav (base64) }
 *   await ww.soundDev.audition({ kind: 'steps', who: 'kael', surface: 'sand' })
 *   await ww.soundDev.audition({ kind: 'voices', who: 'oru' })
 *   await ww.soundDev.audition({ kind: 'loop', name: 'crackle' })          two passes over a loop point, float WAV
 *   ww.soundDev.tapStart(); ...; await ww.soundDev.tapStop()              -> { master, mine, webm } (base64)
 */

import {
  bankJobs,
  createEngine,
  placePanner,
  VOICES,
  type IslandSound,
  type SoundBanks,
  type Surface,
  type VoiceName,
} from './tribe-sound'
import type { NpcId } from './types'

type Ocean = { getWorldOutput(): { ctx: AudioContext; bus: AudioNode; master: AudioNode } | null }

export type Audition =
  | { kind: 'fire'; night: number; rain?: number; storm?: number; seconds?: number; distance?: number }
  | { kind: 'steps'; who: NpcId; surface: Surface; seconds?: number; speed?: number; run?: number }
  | { kind: 'voices'; who: NpcId; gap?: number }
  | { kind: 'loop'; name: 'roar' | 'hiss' | 'crackle' | 'pops' | 'sputter' }

const RATE = 48000

/** Little-endian WAV, 16-bit PCM or 32-bit float, as base64. */
export function wavBase64(channels: Float32Array[], rate: number, float = false) {
  const n = channels[0].length
  const ch = channels.length
  const bytes = float ? 4 : 2
  const buf = new ArrayBuffer(44 + n * ch * bytes)
  const v = new DataView(buf)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + n * ch * bytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, float ? 3 : 1, true)
  v.setUint16(22, ch, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * ch * bytes, true)
  v.setUint16(32, ch * bytes, true)
  v.setUint16(34, bytes * 8, true)
  str(36, 'data')
  v.setUint32(40, n * ch * bytes, true)
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = channels[c][i]
      if (float) v.setFloat32(o, s, true)
      else v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(s * 32767))), true)
      o += bytes
    }
  }
  return toBase64(new Uint8Array(buf))
}

function toBase64(u: Uint8Array) {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}

/** The gait's own cadence (npc-mesh.ts): steps per second at a ground speed. */
function stepsPerSecond(speed: number, scale: number) {
  const v = speed / scale
  const t = Math.max(0, Math.min(1, (v - 2.2) / 0.7))
  const runW = t * t * (3 - 2 * t)
  const cadence = (0.66 + 0.3 * Math.min(v, 2.4)) * (1 - runW) + (1.25 + 0.06 * v) * runW
  return { perSecond: 2 * cadence, runW }
}

const HEIGHT: Record<NpcId, number> = { kael: 1.86, tala: 1.6, oru: 1.68 }
const PACE: Record<NpcId, number> = { kael: 1.2, tala: 1.3, oru: 0.65 }

export function createSoundDev(ocean: Ocean, island: IslandSound) {
  let banks: SoundBanks | null = null
  function getBanks() {
    if (!banks) {
      const scratch = new OfflineAudioContext(1, 1, RATE)
      const b = bankJobs(scratch, false)
      for (const j of b.jobs) j()
      banks = b.banks
    }
    return banks
  }

  function listener(ctx: BaseAudioContext) {
    const L = ctx.listener
    L.positionX.value = 0
    L.positionY.value = 1.6
    L.positionZ.value = 0
    L.forwardX.value = 0
    L.forwardY.value = 0
    L.forwardZ.value = -1
  }

  async function audition(a: Audition) {
    const b = getBanks()
    if (a.kind === 'loop') {
      // Play the loop across its seam twice, as the browser will, and hand back the raw samples
      const buf = b[a.name]
      const seconds = buf.duration * 2.2
      const ctx = new OfflineAudioContext(1, Math.ceil(seconds * RATE), RATE)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      src.connect(ctx.destination)
      src.start(0)
      const out = await ctx.startRendering()
      return { wav: wavBase64([out.getChannelData(0)], RATE, true), loopSeconds: buf.duration, bufferRate: buf.sampleRate }
    }
    const events: { t: number; what: string }[] = []
    let seconds = 0
    if (a.kind === 'fire') seconds = a.seconds ?? 10
    else if (a.kind === 'steps') seconds = a.seconds ?? 6
    else {
      const gap = a.gap ?? 1
      seconds = 0.5
      for (const v of VOICES[a.who]) seconds += b.voices[v]!.duration + gap
      if (a.who === 'kael') seconds += 0.9 + gap
    }
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * RATE), RATE)
    listener(ctx)
    const eng = createEngine(ctx, ctx.destination, b)
    if (a.kind === 'fire') {
      const dist = a.distance ?? 3
      placePanner(eng.firePan, 0, 0.4, -dist, 0, true)
      eng.connectFire(true)
      eng.fireWin.gain.value = 1
      const storm = a.storm ?? 0
      const night = a.night
      const f = { night, strength: (0.7 + 0.3 * night) * (1 - 0.5 * storm), storm, flicker: 0.8 }
      const wet = Math.max(a.rain ?? 0, (storm - 0.3) / 0.6)
      const step = 1 / 30
      for (let t = 0; t < seconds; t += step) {
        f.flicker = 0.8 + 0.1 * Math.sin(t * 7.3) + 0.07 * Math.sin(t * 12.9 + 1.3) + 0.05 * Math.sin(t * 23.1 + 0.4) + (Math.random() - 0.5) * 0.05
        const before = eng.stats.started
        eng.fire(f, wet, t, step, true, Infinity)
        if (eng.stats.started > before) events.push({ t, what: 'snap' })
      }
    } else if (a.kind === 'steps') {
      const p = eng.people.find((q) => q.id === a.who)!
      const speed = a.speed ?? PACE[a.who]
      const { perSecond, runW } = stepsPerSecond(speed, HEIGHT[a.who] / 1.75)
      // Walking across in front of you, three metres off, left to right
      const half = Math.min(4, (speed * seconds) / 2)
      placePanner(p.panner, -half, 0.9, -3, 0, true)
      p.panner.positionX.linearRampToValueAtTime(half, seconds)
      for (let t = 0.25; t < seconds - 0.4; t += 1 / perSecond) {
        eng.step(p, a.surface, 1, a.run ?? runW, speed, t, Infinity)
        events.push({ t, what: `${a.who} ${a.surface}` })
      }
    } else {
      const p = eng.people.find((q) => q.id === a.who)!
      placePanner(p.panner, 0.6, 1.6, -3, 0, true)
      const gap = a.gap ?? 1
      let t = 0.4
      for (const v of VOICES[a.who] as readonly VoiceName[]) {
        eng.say(p, v, t, Infinity)
        events.push({ t, what: v })
        t += b.voices[v]!.duration + gap
      }
      if (a.who === 'kael') {
        // At 3 m: struck at its normal weight (the live game strikes harder from further off)
        eng.knock(p, false, t, 3, Infinity)
        events.push({ t, what: 'kael-knock (sand), twice' })
      }
    }
    const out = await ctx.startRendering()
    return { wav: wavBase64([out.getChannelData(0), out.getChannelData(1)], RATE), seconds, events }
  }

  // —— live taps on the running mix ——
  type Tap = { node: ScriptProcessorNode; sink: GainNode; from: AudioNode; chunks: Float32Array[][] }
  let taps: Tap[] = []
  let recorder: MediaRecorder | null = null
  let webm: Blob[] = []
  let tapRate = 48000

  function tapOn(ctx: AudioContext, from: AudioNode) {
    const node = ctx.createScriptProcessor(4096, 2, 2)
    const sink = ctx.createGain()
    sink.gain.value = 0
    const chunks: Float32Array[][] = [[], []]
    node.onaudioprocess = (e) => {
      for (let c = 0; c < 2; c++) chunks[c].push(new Float32Array(e.inputBuffer.getChannelData(Math.min(c, e.inputBuffer.numberOfChannels - 1))))
    }
    from.connect(node)
    node.connect(sink).connect(ctx.destination)
    return { node, sink, from, chunks }
  }

  /** Start recording the master (pre-limiter) and this module's own bus. */
  function tapStart() {
    const out = ocean.getWorldOutput()
    if (!out) return false
    tapRate = out.ctx.sampleRate
    taps = [tapOn(out.ctx, out.master)]
    if (island.bus) taps.push(tapOn(out.ctx, island.bus))
    const md = out.ctx.createMediaStreamDestination()
    out.master.connect(md)
    webm = []
    recorder = new MediaRecorder(md.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192000 })
    recorder.ondataavailable = (e) => webm.push(e.data)
    recorder.start()
    return true
  }

  async function tapStop() {
    const join = (parts: Float32Array[]) => {
      const n = parts.reduce((s, p) => s + p.length, 0)
      const o = new Float32Array(n)
      let k = 0
      for (const p of parts) {
        o.set(p, k)
        k += p.length
      }
      return o
    }
    const result: { master?: string; mine?: string; webm?: string; seconds: number; rate: number } = { seconds: 0, rate: tapRate }
    taps.forEach((t, i) => {
      t.from.disconnect(t.node)
      t.node.disconnect()
      t.sink.disconnect()
      const ch = [join(t.chunks[0]), join(t.chunks[1])]
      result.seconds = ch[0].length / tapRate
      const w = wavBase64(ch, tapRate)
      if (i === 0) result.master = w
      else result.mine = w
    })
    taps = []
    if (recorder) {
      const r = recorder
      await new Promise<void>((done) => {
        r.onstop = () => done()
        r.stop()
      })
      const blob = new Blob(webm, { type: 'audio/webm' })
      result.webm = toBase64(new Uint8Array(await blob.arrayBuffer()))
      recorder = null
    }
    return result
  }

  /** How long each bank job takes here (the live game runs one a frame after unlock). */
  function timeJobs(lowPower = false) {
    const scratch = new OfflineAudioContext(1, 1, 48000)
    const { jobs } = bankJobs(scratch, lowPower)
    return jobs.map((j) => {
      const t = performance.now()
      j()
      return +(performance.now() - t).toFixed(1)
    })
  }

  return { audition, tapStart, tapStop, getBanks, timeJobs }
}
