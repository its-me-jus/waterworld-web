/**
 * Live ocean sound: procedural water + weather + footsteps, with optional
 * offline-baked beds/SFX under `/audio/`.
 *
 * Reactive layers (crossfades, splash, bubbles, vitals, thunder timing, stride
 * hits) are synthesised in Web Audio every frame. If Lyria/ElevenLabs MP3s
 * exist they layer underneath; missing files fail soft so the procedural bed
 * still runs.
 *
 * Browsers refuse AudioContext until a user gesture — `unlock` is bound to the
 * first pointer/key/touch event (and again when pointer-lock engages).
 */

const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export type AudioGround = 'water' | 'sand' | 'wet-sand' | 'rock' | 'wood' | 'scrub'

export type AudioFrame = {
  dt: number
  submersion: number
  depth: number
  heave: number
  storm: number
  rain: number
  /** 0 open water … 1 standing in the wash / on the beach lip. */
  shore: number
  onLand: boolean
  /** swim ⇄ walk — enter/exit water fire on this flip. */
  mode: 'swim' | 'walk'
  walking: boolean
  moving: number
  speed: number
  /** Stride / stroke phase — footfalls fire on rising zero-crossings ashore. */
  stroke: number
  ground: AudioGround
  /** Climate lightning residual (visual); thunder one-shot is separate. */
  lightning: number
  /** One-shot clap intensity this frame (0 most of the time). */
  thunder: number
  /** PACK / op menu open — Lyria music beds only play while this is true. */
  menuOpen: boolean
}

export type SfxKind = 'lash' | 'wood' | 'splash' | 'sail' | 'haul'

function noiseBuffer(ctx: AudioContext, seconds = 3) {
  const length = Math.floor(ctx.sampleRate * seconds)
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    let last = 0
    for (let i = 0; i < length; i++) {
      // Brown-ish noise — closer to water/wind than white
      const white = Math.random() * 2 - 1
      last = (last + 0.02 * white) / 1.02
      data[i] = last * 3.5
    }
  }
  return buffer
}

function startNoise(ctx: AudioContext, buffer: AudioBuffer, dest: AudioNode) {
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.loop = true
  const gain = ctx.createGain()
  gain.gain.value = 0
  src.connect(gain)
  gain.connect(dest)
  src.start(0)
  return { src, gain }
}

async function tryLoadSample(ctx: AudioContext, url: string) {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    // The dev server's SPA fallback answers missing files with index.html —
    // without this gate we try to decode markup and boot() rejects, which
    // leaves `ready` false and kills the whole procedural layer too
    const type = res.headers.get('content-type') ?? ''
    if (!type.startsWith('audio')) return null
    return await ctx.decodeAudioData(await res.arrayBuffer())
  } catch {
    return null
  }
}

function startBed(ctx: AudioContext, buffer: AudioBuffer, dest: AudioNode) {
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.loop = true
  const gain = ctx.createGain()
  gain.gain.value = 0
  src.connect(gain)
  gain.connect(dest)
  src.start(0)
  return { src, gain }
}

function playBuffer(
  ctx: AudioContext,
  master: AudioNode,
  buffer: AudioBuffer,
  opts: { gain?: number; playbackRate?: number; filterFreq?: number; filterQ?: number } = {},
) {
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.playbackRate.value = opts.playbackRate ?? 1
  let node: AudioNode = src
  if (opts.filterFreq) {
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = opts.filterFreq
    filter.Q.value = opts.filterQ ?? 0.8
    src.connect(filter)
    node = filter
  }
  const gain = ctx.createGain()
  gain.gain.value = opts.gain ?? 0.5
  node.connect(gain)
  gain.connect(master)
  src.start(0)
  return src
}

export function createOceanAudio() {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let ambientBus: GainNode | null = null
  let weatherBus: GainNode | null = null
  let foleyBus: GainNode | null = null
  let musicBus: GainNode | null = null
  let ready = false
  let unlocking: Promise<void> | null = null

  // Procedural ocean chain
  let surfaceNoise: { gain: GainNode } | null = null
  let underNoise: { gain: GainNode } | null = null
  let bobNoise: { gain: GainNode } | null = null
  let shoreNoise: { gain: GainNode } | null = null
  let rainNoise: { gain: GainNode } | null = null
  let windNoise: { gain: GainNode } | null = null
  let landNoise: { gain: GainNode } | null = null
  let surfaceFilter: BiquadFilterNode | null = null
  let underFilter: BiquadFilterNode | null = null
  let bobFilter: BiquadFilterNode | null = null
  let shoreFilter: BiquadFilterNode | null = null
  let rainFilter: BiquadFilterNode | null = null
  let windFilter: BiquadFilterNode | null = null
  let landFilter: BiquadFilterNode | null = null
  let underRumble: OscillatorNode | null = null
  let rumbleGain: GainNode | null = null
  let bubbleTimer = 0
  let chirpTimer = 18 + Math.random() * 20

  // Optional baked beds / one-shots
  let surfaceBed: { gain: GainNode } | null = null
  let underBed: { gain: GainNode } | null = null
  let stormBed: { gain: GainNode } | null = null
  let shoreBed: { gain: GainNode } | null = null
  let shoreLapBed: { gain: GainNode } | null = null
  let rainBed: { gain: GainNode } | null = null
  let windBed: { gain: GainNode } | null = null
  let heavySurfBed: { gain: GainNode } | null = null
  const samples: Partial<Record<string, AudioBuffer>> = {}

  // Vitals & danger layers
  let dangerGain: GainNode | null = null
  let breathShortage = 0
  let hungerShortage = 0
  let heartbeatTimer = 0
  let growlTimer = 12
  let seaWeight = 1
  let dangerLevel = 0
  let dimLevel = 0
  let menuOpen = false
  let gMusic = 0

  let lastSub = 0
  let lastMode: 'swim' | 'walk' | null = null
  let splashCool = 0
  let enterCool = 0
  let exitCool = 0
  let diveCool = 0
  let breachCool = 0
  let strokeSplashCool = 0
  let resumeCool = 0
  let lastStroke = 0
  let footCool = 0
  let earMuffle = 0
  let earFilter: BiquadFilterNode | null = null
  let wetFromExit = 0

  let gSurface = 0
  let gUnder = 0
  let gBob = 0
  let gShore = 0
  let gRain = 0
  let gWind = 0
  let gLand = 0
  let gMaster = 0
  let gSurfaceBed = 0
  let gUnderBed = 0
  let gStormBed = 0
  let gShoreBed = 0
  let gHeavySurf = 0
  let underCutoff = 900

  async function boot() {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0
    master.connect(ctx.destination)

    ambientBus = ctx.createGain()
    ambientBus.gain.value = 1
    // Ear-pressure muffling after a dive — ambient ducks through a lowpass
    earFilter = ctx.createBiquadFilter()
    earFilter.type = 'lowpass'
    earFilter.frequency.value = 18000
    earFilter.Q.value = 0.5
    ambientBus.connect(earFilter)
    earFilter.connect(master)
    weatherBus = ctx.createGain()
    weatherBus.gain.value = 1
    weatherBus.connect(master)
    foleyBus = ctx.createGain()
    foleyBus.gain.value = 1
    foleyBus.connect(master)
    // Lyria beds live here — muted in-world, only when the PACK menu is open
    musicBus = ctx.createGain()
    musicBus.gain.value = 0
    musicBus.connect(master)

    const noise = noiseBuffer(ctx, 4)

    // —— surface wash ————————————————————————————————
    surfaceFilter = ctx.createBiquadFilter()
    surfaceFilter.type = 'bandpass'
    surfaceFilter.frequency.value = 780
    surfaceFilter.Q.value = 0.55
    surfaceFilter.connect(ambientBus)
    surfaceNoise = startNoise(ctx, noise, surfaceFilter)

    // —— close-mic bob / ear water ————————————————————
    bobFilter = ctx.createBiquadFilter()
    bobFilter.type = 'lowpass'
    bobFilter.frequency.value = 420
    bobFilter.Q.value = 0.8
    bobFilter.connect(ambientBus)
    bobNoise = startNoise(ctx, noise, bobFilter)

    // —— underwater hush ——————————————————————————————
    underFilter = ctx.createBiquadFilter()
    underFilter.type = 'lowpass'
    underFilter.frequency.value = 900
    underFilter.Q.value = 0.6
    underFilter.connect(ambientBus)
    underNoise = startNoise(ctx, noise, underFilter)

    rumbleGain = ctx.createGain()
    rumbleGain.gain.value = 0
    rumbleGain.connect(ambientBus)
    underRumble = ctx.createOscillator()
    underRumble.type = 'sine'
    underRumble.frequency.value = 42
    underRumble.connect(rumbleGain)
    underRumble.start(0)

    // —— shoreline lap (close waterline character) ——————
    shoreFilter = ctx.createBiquadFilter()
    shoreFilter.type = 'bandpass'
    shoreFilter.frequency.value = 520
    shoreFilter.Q.value = 0.7
    shoreFilter.connect(ambientBus)
    shoreNoise = startNoise(ctx, noise, shoreFilter)

    // —— rain hiss ————————————————————————————————————
    rainFilter = ctx.createBiquadFilter()
    rainFilter.type = 'highpass'
    rainFilter.frequency.value = 1800
    rainFilter.Q.value = 0.4
    rainFilter.connect(weatherBus)
    rainNoise = startNoise(ctx, noise, rainFilter)

    // —— storm wind ———————————————————————————————————
    windFilter = ctx.createBiquadFilter()
    windFilter.type = 'bandpass'
    windFilter.frequency.value = 320
    windFilter.Q.value = 0.45
    windFilter.connect(weatherBus)
    windNoise = startNoise(ctx, noise, windFilter)

    // —— inland hush: soft canopy / leaf bed (hills, not beach) ————
    // Kept very quiet on purpose — the island can stay contemplative.
    landFilter = ctx.createBiquadFilter()
    landFilter.type = 'bandpass'
    landFilter.frequency.value = 2100
    landFilter.Q.value = 0.55
    landFilter.connect(ambientBus)
    landNoise = startNoise(ctx, noise, landFilter)

    // —— proximity dread: two detuned lows beating against each other ————
    dangerGain = ctx.createGain()
    dangerGain.gain.value = 0
    dangerGain.connect(master)
    for (const freq of [52, 55.4]) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.connect(dangerGain)
      osc.start(0)
    }

    // Optional beds / one-shots (generated offline — fail soft)
    const urls: [string, string][] = [
      ['surfaceBed', '/audio/surface-bed.mp3'],
      ['underBed', '/audio/underwater-bed.mp3'],
      ['stormBed', '/audio/storm-bed.mp3'],
      ['shoreBed', '/audio/shore-bed.mp3'],
      ['rainBed', '/audio/rain.mp3'],
      ['windBed', '/audio/wind.mp3'],
      ['heavySurf', '/audio/heavy-surf.mp3'],
      ['splash', '/audio/splash.mp3'],
      ['enter', '/audio/enter-water.mp3'],
      ['exit', '/audio/exit-water.mp3'],
      ['dive', '/audio/dive.mp3'],
      ['breach', '/audio/breach.mp3'],
      ['thunder', '/audio/thunder.mp3'],
      ['footSand', '/audio/foot-sand.mp3'],
      ['footRock', '/audio/foot-rock.mp3'],
      ['footWood', '/audio/foot-wood.mp3'],
      ['bush', '/audio/bush-rustle.mp3'],
      ['lash', '/audio/lash.mp3'],
      ['woodKnock', '/audio/wood-knock.mp3'],
      ['sailFlap', '/audio/sail-flap.mp3'],
      ['shoreLap', '/audio/shore-lap.mp3'],
    ]
    const loaded = await Promise.all(urls.map(async ([key, url]) => [key, await tryLoadSample(ctx!, url)] as const))
    for (const [key, buf] of loaded) {
      if (!buf) continue
      if (key === 'surfaceBed') surfaceBed = startBed(ctx, buf, musicBus!)
      else if (key === 'underBed') underBed = startBed(ctx, buf, musicBus!)
      else if (key === 'stormBed') stormBed = startBed(ctx, buf, musicBus!)
      else if (key === 'shoreBed') shoreBed = startBed(ctx, buf, musicBus!)
      else if (key === 'rainBed') rainBed = startBed(ctx, buf, weatherBus)
      else if (key === 'windBed') windBed = startBed(ctx, buf, weatherBus)
      else if (key === 'heavySurf') heavySurfBed = startBed(ctx, buf, ambientBus)
      else if (key === 'shoreLap') {
        samples.shoreLap = buf
        shoreLapBed = startBed(ctx, buf, ambientBus)
      } else samples[key] = buf
    }

    ready = true
  }

  function unlock() {
    if (ready || unlocking) return unlocking ?? Promise.resolve()
    unlocking = boot()
      .then(async () => {
        if (ctx?.state === 'suspended') await ctx.resume()
      })
      .catch((err) => {
        console.warn('[audio]', err)
        unlocking = null
      })
    return unlocking
  }

  function bindUnlock() {
    const once = () => {
      void unlock()
      window.removeEventListener('pointerdown', once)
      window.removeEventListener('keydown', once)
      window.removeEventListener('touchstart', once)
    }
    window.addEventListener('pointerdown', once, { passive: true })
    window.addEventListener('keydown', once)
    window.addEventListener('touchstart', once, { passive: true })
  }

  /** Soft plunge — kept for raft wash-off / generic callers. */
  function playSplash(intensity = 0.5) {
    playWaterMoment('splash', intensity, 0)
  }

  function noiseBurst(
    dest: AudioNode,
    opts: {
      duration: number
      gain: number
      freq: number
      q?: number
      type?: BiquadFilterType
      brown?: number
    },
  ) {
    if (!ctx) return
    const length = Math.floor(ctx.sampleRate * opts.duration)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    let last = 0
    const brown = opts.brown ?? 0.04
    for (let i = 0; i < length; i++) {
      const t = i / length
      const env = Math.exp(-t * (2.8 + (1 - opts.gain) * 4)) * (1 - t * 0.25)
      const white = Math.random() * 2 - 1
      last = (last + brown * white) / (1 + brown)
      data[i] = last * 4.2 * env
    }
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = opts.type ?? 'bandpass'
    filter.frequency.value = opts.freq
    filter.Q.value = opts.q ?? 0.7
    const gain = ctx.createGain()
    gain.gain.value = opts.gain
    src.connect(filter)
    filter.connect(gain)
    gain.connect(dest)
    src.start(0)
  }

  function toneWhoomp(dest: AudioNode, intensity: number, startHz: number, endHz: number, dur = 0.35) {
    if (!ctx) return
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(startHz, now)
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), now + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(0.55 * intensity, now + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur)
    osc.connect(g)
    g.connect(dest)
    osc.start(now)
    osc.stop(now + dur + 0.05)
  }

  function bubbleCascade(dest: AudioNode, intensity: number, count = 6) {
    if (!ctx) return
    const now = ctx.currentTime
    for (let i = 0; i < count; i++) {
      const at = now + i * (0.04 + Math.random() * 0.06)
      const duration = 0.06 + Math.random() * 0.1
      const length = Math.floor(ctx.sampleRate * duration)
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
      const data = buffer.getChannelData(0)
      const freq = 350 + Math.random() * 1100
      for (let n = 0; n < length; n++) {
        const t = n / ctx.sampleRate
        data[n] = Math.sin(2 * Math.PI * freq * t * (1 + t * 3)) * Math.exp(-t * 30) * 0.35
      }
      const src = ctx.createBufferSource()
      src.buffer = buffer
      const g = ctx.createGain()
      g.gain.value = (0.12 + Math.random() * 0.14) * intensity
      src.connect(g)
      g.connect(dest)
      src.start(at)
    }
  }

  /** Soft water leaving skin — brown noise ticks, never tonal (tones read as lasers). */
  function waterShed(dest: AudioNode, intensity: number) {
    if (!ctx) return
    noiseBurst(dest, {
      duration: 0.35,
      gain: 0.18 * intensity,
      freq: 1100,
      q: 0.4,
      type: 'bandpass',
      brown: 0.07,
    })
    // A couple of soft wet ticks — filtered noise pops, not sine beeps
    const now = ctx.currentTime
    for (let i = 0; i < 3; i++) {
      const at = now + 0.08 + i * 0.11
      const length = Math.floor(ctx.sampleRate * 0.04)
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
      const data = buffer.getChannelData(0)
      for (let n = 0; n < length; n++) {
        const t = n / length
        data[n] = (Math.random() * 2 - 1) * Math.exp(-t * 18) * 0.5
      }
      const src = ctx.createBufferSource()
      src.buffer = buffer
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = 700 + Math.random() * 500
      filter.Q.value = 1.2
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, at)
      g.gain.exponentialRampToValueAtTime(0.1 * intensity * (1 - i * 0.25), at + 0.005)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05)
      src.connect(filter)
      filter.connect(g)
      g.connect(dest)
      src.start(at)
    }
  }

  /** Leaf / scrub brush as you push through the green band. */
  function playBush(intensity: number) {
    if (!ctx || !master) return
    const dest = foleyBus ?? master
    if (samples.bush) {
      playBuffer(ctx, dest, samples.bush, {
        gain: 0.22 * intensity,
        playbackRate: 0.88 + Math.random() * 0.28,
      })
      return
    }
    noiseBurst(dest, {
      duration: 0.16 + Math.random() * 0.1,
      gain: 0.2 * intensity,
      freq: 1800 + Math.random() * 900,
      q: 0.55,
      type: 'bandpass',
      brown: 0.09,
    })
    noiseBurst(dest, {
      duration: 0.1,
      gain: 0.1 * intensity,
      freq: 420,
      q: 0.7,
      type: 'lowpass',
      brown: 0.06,
    })
  }

  type WaterMoment = 'splash' | 'enter' | 'exit' | 'dive' | 'breach' | 'wade' | 'stroke'

  function playWaterMoment(kind: WaterMoment, intensity = 0.7, storm = 0) {
    if (!ctx || !master) return
    const dest = foleyBus ?? master
    const i = clamp01(intensity + storm * 0.15)

    const sampleKey =
      kind === 'enter'
        ? 'enter'
        : kind === 'exit'
          ? 'exit'
          : kind === 'dive'
            ? 'dive'
            : kind === 'breach'
              ? 'breach'
              : kind === 'splash' || kind === 'wade' || kind === 'stroke'
                ? 'splash'
                : null
    if (sampleKey && samples[sampleKey]) {
      const rate =
        kind === 'dive'
          ? 0.82 + Math.random() * 0.1
          : kind === 'breach'
            ? 1.05 + Math.random() * 0.12
            : kind === 'exit'
              ? 0.95 + Math.random() * 0.1
              : kind === 'stroke'
                ? 1.15 + Math.random() * 0.2
                : 0.9 + Math.random() * 0.18
      playBuffer(ctx, dest, samples[sampleKey]!, {
        gain: (kind === 'stroke' ? 0.22 : kind === 'wade' ? 0.28 : 0.5) * i,
        playbackRate: rate,
      })
    }

    if (kind === 'enter') {
      // Body hits the wash — heavy mid splash + low shove + bubble rush
      if (!samples.enter) {
        noiseBurst(dest, { duration: 0.7, gain: 0.7 * i, freq: 520 + storm * 180, q: 0.55, brown: 0.035 })
        noiseBurst(dest, { duration: 0.45, gain: 0.35 * i, freq: 1400, q: 0.5, type: 'highpass', brown: 0.06 })
      }
      toneWhoomp(dest, i * 0.85, 160, 38, 0.42)
      bubbleCascade(dest, i, 8 + Math.floor(storm * 4))
      earMuffle = Math.max(earMuffle, 0.35 + i * 0.25)
      wetFromExit = 0
    } else if (kind === 'exit') {
      // Climbing out — one shed of water, then bare feet take over. No drip loop.
      if (!samples.exit) {
        noiseBurst(dest, { duration: 0.45, gain: 0.32 * i, freq: 680, q: 0.55, brown: 0.045 })
      }
      waterShed(dest, i * 0.7)
      earMuffle = 0
      wetFromExit = 0
    } else if (kind === 'dive') {
      // Head goes under — pressure whoomp, muffling, bubbles in the ear
      if (!samples.dive) {
        noiseBurst(dest, { duration: 0.5, gain: 0.55 * i, freq: 380, q: 0.8, brown: 0.03 })
      }
      toneWhoomp(dest, i, 95, 28, 0.5)
      bubbleCascade(dest, i * 1.1, 10)
      earMuffle = Math.max(earMuffle, 0.75 + i * 0.25)
    } else if (kind === 'breach') {
      // Burst back to air — splash + brief shed, no laser drips
      if (!samples.breach) {
        noiseBurst(dest, { duration: 0.55, gain: 0.65 * i, freq: 720 + storm * 200, q: 0.55, brown: 0.035 })
      }
      toneWhoomp(dest, i * 0.55, 200, 55, 0.22)
      waterShed(dest, i * 0.55)
      bubbleCascade(dest, i * 0.55, 4)
      earMuffle = 0
      wetFromExit = 0
    } else if (kind === 'wade') {
      if (!samples.splash) {
        noiseBurst(dest, { duration: 0.22, gain: 0.28 * i, freq: 640, q: 0.9, brown: 0.05 })
      }
    } else if (kind === 'stroke') {
      if (!samples.splash) {
        noiseBurst(dest, { duration: 0.18, gain: 0.18 * i, freq: 900, q: 0.7, brown: 0.055 })
      }
      if (Math.random() > 0.55) bubbleCascade(dest, i * 0.35, 2)
    } else {
      // generic splash
      if (!samples.splash) {
        noiseBurst(dest, { duration: 0.55, gain: 0.55 * i, freq: 650 + i * 400, q: 0.7, brown: 0.035 })
      }
    }
  }

  /** Lub-dub. Rate and weight track how thin your air is running. */
  function thump(intensity: number) {
    if (!ctx || !master) return
    const beat = (at: number, gain: number) => {
      if (!ctx || !master) return
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(58, at)
      osc.frequency.exponentialRampToValueAtTime(38, at + 0.09)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, at)
      g.gain.exponentialRampToValueAtTime(gain, at + 0.015)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.14)
      osc.connect(g)
      g.connect(master)
      osc.start(at)
      osc.stop(at + 0.2)
    }
    const now = ctx.currentTime
    beat(now, 0.5 * intensity)
    beat(now + 0.17, 0.34 * intensity)
  }

  /** Empty-belly gurgle — low noise through a wandering bandpass. */
  function growl(intensity: number) {
    if (!ctx || !master) return
    const duration = 0.7 + Math.random() * 0.5
    const length = Math.floor(ctx.sampleRate * duration)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    let last = 0
    const wobble = 2.2 + Math.random() * 2.6
    for (let i = 0; i < length; i++) {
      const t = i / length
      const env = Math.sin(Math.PI * t) * (0.55 + 0.45 * Math.sin(t * wobble * Math.PI * 2))
      const white = Math.random() * 2 - 1
      last = (last + 0.06 * white) / 1.06
      data[i] = last * 3.4 * env
    }
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 95 + Math.random() * 60
    filter.Q.value = 1.1
    const gain = ctx.createGain()
    gain.gain.value = 0.4 * intensity
    src.connect(filter)
    filter.connect(gain)
    gain.connect(master)
    src.start(0)
  }

  /** A hard contact underwater — the spear finding flesh, or teeth finding you. */
  function impact(intensity: number) {
    if (!ctx || !master) return
    const now = ctx.currentTime
    const dest = foleyBus ?? master

    // The blow itself: a fast low drop you feel in the jaw
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(120, now)
    osc.frequency.exponentialRampToValueAtTime(34, now + 0.16)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(0.75 * intensity, now + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.26)
    osc.connect(g)
    g.connect(dest)
    osc.start(now)
    osc.stop(now + 0.3)

    // The water the hit shoves aside
    const length = Math.floor(ctx.sampleRate * 0.3)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    let last = 0
    for (let i = 0; i < length; i++) {
      const t = i / length
      const white = Math.random() * 2 - 1
      last = (last + 0.05 * white) / 1.05
      data[i] = last * 3.2 * Math.exp(-t * 7)
    }
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 300
    filter.Q.value = 0.8
    const ng = ctx.createGain()
    ng.gain.value = 0.5 * intensity
    src.connect(filter)
    filter.connect(ng)
    ng.connect(dest)
    src.start(now)
  }

  /** Distant→close thunder clap after a lightning flash. */
  function playThunder(intensity: number) {
    if (!ctx || !master || intensity <= 0) return
    const dest = weatherBus ?? master

    if (samples.thunder) {
      playBuffer(ctx, dest, samples.thunder, {
        gain: 0.55 * intensity,
        playbackRate: 0.88 + Math.random() * 0.2,
      })
      return
    }

    const now = ctx.currentTime
    // Low boom
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(55 + Math.random() * 25, now)
    osc.frequency.exponentialRampToValueAtTime(28, now + 0.9)
    const og = ctx.createGain()
    og.gain.setValueAtTime(0.0001, now)
    og.gain.exponentialRampToValueAtTime(0.7 * intensity, now + 0.04)
    og.gain.exponentialRampToValueAtTime(0.0001, now + 1.6)
    osc.connect(og)
    og.connect(dest)
    osc.start(now)
    osc.stop(now + 1.8)

    // Crackling rumble tail
    const duration = 1.4 + Math.random() * 0.8
    const length = Math.floor(ctx.sampleRate * duration)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    let last = 0
    for (let i = 0; i < length; i++) {
      const t = i / length
      const env = Math.exp(-t * 2.2) * (0.4 + 0.6 * Math.sin(t * Math.PI))
      const white = Math.random() * 2 - 1
      last = (last + 0.04 * white) / 1.04
      data[i] = last * 3.8 * env
    }
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 180 + intensity * 220
    const ng = ctx.createGain()
    ng.gain.value = 0.55 * intensity
    src.connect(filter)
    filter.connect(ng)
    ng.connect(dest)
    src.start(now)
  }

  function playFoot(ground: AudioGround, intensity: number) {
    if (!ctx || !master || ground === 'water') return
    const dest = foleyBus ?? master

    if (ground === 'scrub') {
      // Soft earth underfoot + leaves brushing past
      const sampleKey = samples.footSand ? 'footSand' : null
      if (sampleKey) {
        playBuffer(ctx, dest, samples[sampleKey]!, {
          gain: 0.2 * intensity,
          playbackRate: 0.85 + Math.random() * 0.15,
        })
      } else {
        noiseBurst(dest, {
          duration: 0.1,
          gain: 0.22 * intensity,
          freq: 140,
          q: 0.8,
          type: 'lowpass',
          brown: 0.08,
        })
      }
      playBush(intensity * (0.55 + Math.random() * 0.45))
      return
    }

    const sampleKey =
      ground === 'wood' ? 'footWood' : ground === 'rock' ? 'footRock' : 'footSand'
    if (samples[sampleKey]) {
      playBuffer(ctx, dest, samples[sampleKey]!, {
        gain: 0.32 * intensity * (ground === 'wet-sand' ? 0.7 : 1),
        playbackRate: 0.9 + Math.random() * 0.22,
      })
      // Wet sand still gets a tiny water kiss — dry beach stays grit only
      if (ground === 'wet-sand') {
        noiseBurst(dest, {
          duration: 0.12,
          gain: 0.12 * intensity,
          freq: 520,
          q: 1.1,
          brown: 0.05,
        })
      }
      return
    }

    // Procedural footfall — short noise thump coloured by surface
    const duration = ground === 'sand' || ground === 'wet-sand' ? 0.12 : 0.08
    const length = Math.floor(ctx.sampleRate * duration)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    let last = 0
    for (let i = 0; i < length; i++) {
      const t = i / length
      const env = Math.exp(-t * (ground === 'rock' ? 28 : 18))
      const white = Math.random() * 2 - 1
      last = (last + 0.08 * white) / 1.08
      data[i] = last * 3.2 * env
    }
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value =
      ground === 'rock' ? 420 : ground === 'wood' ? 280 : ground === 'wet-sand' ? 190 : 150
    filter.Q.value = ground === 'rock' ? 1.2 : 0.7
    const gain = ctx.createGain()
    gain.gain.value = 0.34 * intensity * (ground === 'wet-sand' ? 0.75 : 1)
    src.connect(filter)
    filter.connect(gain)
    gain.connect(dest)
    src.start(0)

    if (ground === 'rock' || ground === 'wood') {
      const t0 = ctx.currentTime
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(ground === 'wood' ? 90 : 110, t0)
      osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.06)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(0.18 * intensity, t0 + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09)
      osc.connect(g)
      g.connect(dest)
      osc.start(t0)
      osc.stop(t0 + 0.12)
    }
  }

  /** Build / raft foley — samples when present, procedural fallback. */
  function sfx(kind: SfxKind, intensity = 0.7) {
    if (!ctx || !master) return
    const dest = foleyBus ?? master
    const i = clamp01(intensity)

    if (kind === 'splash') {
      playSplash(0.5 + i * 0.5)
      return
    }
    if (kind === 'lash' && samples.lash) {
      playBuffer(ctx, dest, samples.lash, { gain: 0.4 * i, playbackRate: 0.95 + Math.random() * 0.1 })
      return
    }
    if ((kind === 'wood' || kind === 'haul') && samples.woodKnock) {
      playBuffer(ctx, dest, samples.woodKnock, { gain: 0.4 * i, playbackRate: 0.9 + Math.random() * 0.15 })
      return
    }
    if (kind === 'sail' && samples.sailFlap) {
      playBuffer(ctx, dest, samples.sailFlap, { gain: 0.35 * i, playbackRate: 0.92 + Math.random() * 0.16 })
      return
    }

    // Procedural rope / wood / canvas
    const now = ctx.currentTime
    if (kind === 'lash') {
      const duration = 0.25
      const length = Math.floor(ctx.sampleRate * duration)
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
      const data = buffer.getChannelData(0)
      for (let n = 0; n < length; n++) {
        const t = n / length
        data[n] = (Math.random() * 2 - 1) * Math.exp(-t * 14) * (0.5 + 0.5 * Math.sin(t * 40))
      }
      playBuffer(ctx, dest, buffer, { gain: 0.35 * i, filterFreq: 900, filterQ: 1.4 })
      return
    }
    if (kind === 'sail') {
      const duration = 0.45
      const length = Math.floor(ctx.sampleRate * duration)
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
      const data = buffer.getChannelData(0)
      let last = 0
      for (let n = 0; n < length; n++) {
        const t = n / length
        const white = Math.random() * 2 - 1
        last = (last + 0.05 * white) / 1.05
        data[n] = last * 3 * Math.sin(Math.PI * t) * (0.6 + 0.4 * Math.sin(t * 18))
      }
      playBuffer(ctx, dest, buffer, { gain: 0.3 * i, filterFreq: 650, filterQ: 0.6 })
      return
    }
    // wood / haul
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(140 + Math.random() * 40, now)
    osc.frequency.exponentialRampToValueAtTime(70, now + 0.12)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(0.35 * i, now + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.2)
    osc.connect(g)
    g.connect(dest)
    osc.start(now)
    osc.stop(now + 0.25)
  }

  /** Vitals, once per frame: breath shortage drives the heartbeat, hunger the growls. */
  function setVitals(shortage: { breath: number; hunger: number }) {
    breathShortage = shortage.breath
    hungerShortage = shortage.hunger
  }

  /** 0 calm → 1 heavy: the surface wash wears the sea state. */
  function setSeaWeight(w: number) {
    seaWeight = w
  }

  /** 0..1 — something big is in your water. */
  function setDanger(level: number) {
    dangerLevel = level
  }

  /** Duck everything (the long fade after the ocean wins). */
  function dim(level: number) {
    dimLevel = level
  }

  /** Occasional tiny bubble ticks while submerged. */
  function tickBubble() {
    if (!ctx || !master) return
    const duration = 0.08 + Math.random() * 0.12
    const length = Math.floor(ctx.sampleRate * duration)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    const freq = 400 + Math.random() * 900
    for (let i = 0; i < length; i++) {
      const t = i / ctx.sampleRate
      const env = Math.exp(-t * 28)
      data[i] = Math.sin(2 * Math.PI * freq * t * (1 + t * 2)) * env * 0.22
    }
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = 0.18 + Math.random() * 0.2
    src.connect(gain)
    gain.connect(ambientBus ?? master)
    src.start(0)
  }

  /**
   * A sparse inland chirp — short sine with a little bend so it reads as a bird
   * without looping. Gain stays tiny; storms and the beach stay quiet.
   */
  function tickChirp() {
    if (!ctx || !master || !ambientBus) return
    const duration = 0.09 + Math.random() * 0.14
    const length = Math.floor(ctx.sampleRate * duration)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    const f0 = 1800 + Math.random() * 2200
    const bend = 0.7 + Math.random() * 0.9
    for (let i = 0; i < length; i++) {
      const t = i / ctx.sampleRate
      const env = Math.sin(Math.PI * Math.min(1, t / duration)) ** 1.6
      const freq = f0 * (1 + bend * t)
      data[i] = Math.sin(2 * Math.PI * freq * t) * env * 0.55
      // Soft second partial — less whistle, more throat
      data[i] += Math.sin(2 * Math.PI * freq * 1.5 * t) * env * 0.12
    }
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = f0
    filter.Q.value = 4
    const gain = ctx.createGain()
    gain.gain.value = 0.045 + Math.random() * 0.05
    src.connect(filter)
    filter.connect(gain)
    gain.connect(ambientBus)
    src.start(0)
  }

  function update(frame: AudioFrame) {
    const {
      dt,
      submersion,
      depth,
      heave,
      storm,
      rain,
      shore,
      onLand,
      mode,
      walking,
      moving,
      speed,
      stroke,
      ground,
      thunder,
      menuOpen: menu,
    } = frame
    menuOpen = menu

    splashCool = Math.max(0, splashCool - dt)
    enterCool = Math.max(0, enterCool - dt)
    exitCool = Math.max(0, exitCool - dt)
    diveCool = Math.max(0, diveCool - dt)
    breachCool = Math.max(0, breachCool - dt)
    strokeSplashCool = Math.max(0, strokeSplashCool - dt)
    footCool = Math.max(0, footCool - dt)
    wetFromExit = Math.max(0, wetFromExit - dt)
    earMuffle = damp(earMuffle, mode === 'swim' && submersion > 0.55 ? Math.max(earMuffle, 0.15) : 0, 1.8, dt)

    // —— water moments: enter / exit / dive / breach ——————————
    if (ready) {
      if (lastMode === 'walk' && mode === 'swim' && enterCool <= 0) {
        const inten = 0.55 + Math.min(0.45, speed / 5) + storm * 0.2
        playWaterMoment('enter', inten, storm)
        enterCool = 1.1
        diveCool = 0.6 // don't double with an immediate dive
      }
      if (lastMode === 'swim' && mode === 'walk' && exitCool <= 0) {
        playWaterMoment('exit', 0.55 + shore * 0.25 + storm * 0.15, storm)
        exitCool = 1.1
        breachCool = 0.5
      }
      // Head under / back to air while already swimming
      if (mode === 'swim') {
        if (lastSub < 0.42 && submersion >= 0.58 && diveCool <= 0) {
          playWaterMoment(
            'dive',
            0.5 + Math.min(0.45, Math.abs(submersion - lastSub)) + storm * 0.2,
            storm,
          )
          diveCool = 0.95
        }
        if (lastSub > 0.55 && submersion <= 0.4 && breachCool <= 0) {
          playWaterMoment(
            'breach',
            0.55 + Math.min(0.4, Math.abs(submersion - lastSub)) + storm * 0.25,
            storm,
          )
          breachCool = 0.95
        }
        // Surface stroke slap — arms finding the chop
        if (
          submersion < 0.45 &&
          moving > 0.25 &&
          speed > 0.8 &&
          strokeSplashCool <= 0 &&
          ((lastStroke < 0.5 && stroke >= 0.5) || stroke < lastStroke)
        ) {
          playWaterMoment('stroke', 0.3 + moving * 0.35 + storm * 0.2, storm)
          strokeSplashCool = 0.28
        }
      }
    }
    lastSub = submersion
    lastMode = mode

    if (thunder > 0) playThunder(thunder)

    // Footfalls: sand on the beach, scrub through the green, wade only in the wash
    if (walking && moving > 0.15 && speed > 0.4 && footCool <= 0) {
      const hitHalf = lastStroke < 0.5 && stroke >= 0.5
      const hitWrap = stroke < lastStroke
      if (hitHalf || hitWrap) {
        const inten = clamp01(0.35 + speed / 4.5) * (0.7 + moving * 0.3)
        if (ground === 'wet-sand') {
          playWaterMoment('wade', inten * 0.65, storm)
        } else {
          playFoot(ground, inten)
        }
        footCool = 0.16
      }
    }
    lastStroke = stroke

    if (!ready || !ctx || !master || !surfaceNoise || !underNoise || !bobNoise) return
    // Recovery from a mid-session browser suspension — throttled: without a
    // user gesture every attempt just logs a Chrome warning, per frame
    resumeCool -= dt
    if (ctx.state === 'suspended' && resumeCool <= 0) {
      resumeCool = 1
      void ctx.resume()
    }

    const underW = Math.min(1, Math.max(0, (submersion - 0.12) / 0.72))
    const surfaceW = 1 - underW
    const bobW =
      Math.max(0, 1 - submersion * 2.4) * (0.28 + Math.min(0.7, Math.abs(heave) * 1.1))
    const murk = Math.min(1, depth / 22)
    const wind = 1 + storm * 1.35

    // Dry land ducks the open-ocean wash; shore proximity keeps a lap alive
    const landDuck = onLand ? 0.12 + shore * 0.35 : 1
    const shoreW = shore * surfaceW * (onLand ? 0.85 : 0.55)
    const rainAir = rain * (1 - underW * 0.85) * (onLand ? 0.9 : 0.7)
    const windAir = clamp01((storm - 0.25) / 0.6) * (1 - underW * 0.75)

    // A glassed-off sea is quiet; a squall whips the wash up. Storm (minutes)
    // and sea weight (hours) stay independent multipliers.
    const seaLoud = 0.3 + 0.7 * seaWeight
    gSurface = damp(gSurface, surfaceW * 0.42 * wind * seaLoud * landDuck, 3.4, dt)
    gUnder = damp(gUnder, underW * (0.55 + murk * 0.15), 3.4, dt)
    gBob = damp(gBob, bobW * 0.5 * (1 + storm * 0.4) * seaLoud * (onLand ? 0.15 : 1), 5, dt)
    gShore = damp(gShore, shoreW * 0.38 * (0.7 + seaLoud * 0.3), 3.2, dt)
    gRain = damp(gRain, rainAir * 0.32, 2.4, dt)
    gWind = damp(gWind, windAir * 0.28 * (0.5 + seaLoud * 0.5), 2.2, dt)
    // Inland only — scrub/rock hills get a soft canopy bed; beach stays ocean-led.
    const inland =
      onLand &&
      underW < 0.15 &&
      shore < 0.35 &&
      storm < 0.45 &&
      (ground === 'scrub' || ground === 'rock')
    gLand = damp(gLand, inland ? 0.07 + (1 - shore) * 0.04 : 0, 2.6, dt)
    gMaster = damp(gMaster, (0.9 + storm * 0.08) * (1 - dimLevel * 0.85), 2.2, dt)
    gSurfaceBed = damp(gSurfaceBed, surfaceW * 0.55 * (1 + storm * 0.2), 2.5, dt)
    gUnderBed = damp(gUnderBed, underW * 0.6, 2.5, dt)
    gStormBed = damp(gStormBed, windAir * 0.5, 2.2, dt)
    gShoreBed = damp(gShoreBed, Math.max(shoreW, onLand ? 0.35 : 0) * 0.45, 2.4, dt)
    gMusic = damp(gMusic, menuOpen ? 0.55 : 0, 3.2, dt)
    gHeavySurf = damp(
      gHeavySurf,
      surfaceW * landDuck * clamp01((storm - 0.35) / 0.5) * 0.28 * seaLoud,
      2.3,
      dt,
    )
    underCutoff = damp(underCutoff, 1050 - murk * 650, 2.6, dt)

    const now = ctx.currentTime
    surfaceNoise.gain.gain.setTargetAtTime(gSurface, now, 0.05)
    underNoise.gain.gain.setTargetAtTime(gUnder, now, 0.05)
    bobNoise.gain.gain.setTargetAtTime(gBob, now, 0.04)
    if (shoreNoise) shoreNoise.gain.gain.setTargetAtTime(gShore, now, 0.05)
    if (rainNoise) rainNoise.gain.gain.setTargetAtTime(gRain, now, 0.06)
    if (windNoise) windNoise.gain.gain.setTargetAtTime(gWind, now, 0.06)
    if (landNoise) landNoise.gain.gain.setTargetAtTime(gLand, now, 0.08)
    master.gain.setTargetAtTime(gMaster, now, 0.05)
    if (musicBus) musicBus.gain.setTargetAtTime(gMusic, now, 0.08)
    // Dive muffles the world through your ears for a beat
    if (earFilter) {
      const cut = 18000 - earMuffle * 15500
      earFilter.frequency.setTargetAtTime(cut, now, 0.06)
    }
    if (underFilter) underFilter.frequency.setTargetAtTime(underCutoff, now, 0.08)
    if (rumbleGain) rumbleGain.gain.setTargetAtTime(underW * (0.08 + murk * 0.1), now, 0.08)
    if (dangerGain) dangerGain.gain.setTargetAtTime(dangerLevel * 0.16 * (onLand ? 0.25 : 1), now, 0.45)
    if (surfaceBed) surfaceBed.gain.gain.setTargetAtTime(gSurfaceBed, now, 0.08)
    if (underBed) underBed.gain.gain.setTargetAtTime(gUnderBed, now, 0.08)
    if (stormBed) stormBed.gain.gain.setTargetAtTime(gStormBed, now, 0.08)
    if (shoreBed) shoreBed.gain.gain.setTargetAtTime(gShoreBed, now, 0.08)
    if (shoreLapBed) shoreLapBed.gain.gain.setTargetAtTime(gShore * 0.9, now, 0.08)
    if (rainBed) rainBed.gain.gain.setTargetAtTime(gRain * 0.85, now, 0.08)
    if (windBed) windBed.gain.gain.setTargetAtTime(gWind * 0.85, now, 0.08)
    if (heavySurfBed) heavySurfBed.gain.gain.setTargetAtTime(gHeavySurf, now, 0.08)

    // —— vitals-driven one-shots ————————————————————————————
    if (breathShortage > 0.04) {
      heartbeatTimer -= dt
      if (heartbeatTimer <= 0) {
        thump(0.45 + breathShortage * 0.55)
        heartbeatTimer = 1.7 - breathShortage * 1.15
      }
    } else {
      heartbeatTimer = 0.3
    }
    if (hungerShortage > 0.45) {
      growlTimer -= dt
      if (growlTimer <= 0) {
        growl(0.5 + hungerShortage * 0.5)
        growlTimer = 17 + Math.random() * 16
      }
    } else {
      growlTimer = 12
    }

    // Swell breathing on the surface filter — storms push it brighter / windier
    if (surfaceFilter) {
      const breath = 720 + Math.sin(now * 0.35) * 90 + heave * 40 + storm * 380
      surfaceFilter.frequency.setTargetAtTime(breath, now, 0.1)
      surfaceFilter.Q.setTargetAtTime(0.55 + storm * 0.35, now, 0.12)
    }
    if (bobFilter) {
      bobFilter.frequency.setTargetAtTime(360 + Math.abs(heave) * 80 + storm * 60, now, 0.08)
    }
    if (shoreFilter) {
      shoreFilter.frequency.setTargetAtTime(480 + Math.sin(now * 0.55) * 70 + storm * 120, now, 0.1)
    }
    if (rainFilter) {
      rainFilter.frequency.setTargetAtTime(1600 + rain * 900, now, 0.12)
    }
    if (windFilter) {
      windFilter.frequency.setTargetAtTime(260 + storm * 220 + Math.sin(now * 0.2) * 40, now, 0.1)
    }
    if (landFilter) {
      landFilter.frequency.setTargetAtTime(1800 + Math.sin(now * 0.15) * 280, now, 0.15)
    }

    if (underW > 0.35) {
      bubbleTimer -= dt
      if (bubbleTimer <= 0) {
        tickBubble()
        bubbleTimer = 0.9 + Math.random() * 2.4
      }
    } else {
      bubbleTimer = 0.4
    }

    // Sparse bird chirps inland — long gaps so the hill can stay contemplative
    if (gLand > 0.04 && underW < 0.1 && storm < 0.4) {
      chirpTimer -= dt
      if (chirpTimer <= 0) {
        tickChirp()
        chirpTimer = 14 + Math.random() * 28
      }
    } else {
      chirpTimer = Math.max(chirpTimer, 8)
    }
  }

  bindUnlock()

  return { unlock, update, setVitals, setSeaWeight, setDanger, dim, impact, sfx, playSplash }
}
