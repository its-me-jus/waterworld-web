/**
 * Live ocean sound: procedural water bed + optional Lyria atmospheric beds.
 *
 * The interactive layer is synthesised in Web Audio (noise → filters → swell LFO)
 * so depth, bobbing and surface crossings react every frame. If Lyria beds exist
 * under `/audio/`, they layer quietly underneath as a musical atmosphere.
 *
 * Browsers refuse AudioContext until a user gesture — `unlock` is bound to the
 * first pointer/key/touch event (and again when pointer-lock engages).
 */

const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))

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

async function tryLoadBed(ctx: AudioContext, url: string) {
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

export function createOceanAudio() {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let ready = false
  let unlocking: Promise<void> | null = null

  // Procedural chain
  let surfaceNoise: { gain: GainNode } | null = null
  let underNoise: { gain: GainNode } | null = null
  let bobNoise: { gain: GainNode } | null = null
  let surfaceFilter: BiquadFilterNode | null = null
  let underFilter: BiquadFilterNode | null = null
  let bobFilter: BiquadFilterNode | null = null
  let underRumble: OscillatorNode | null = null
  let rumbleGain: GainNode | null = null
  let bubbleTimer = 0

  // Optional Lyria beds
  let surfaceBed: { gain: GainNode } | null = null
  let underBed: { gain: GainNode } | null = null

  let lastSub = 0
  let splashCool = 0
  let resumeCool = 0

  let gSurface = 0
  let gUnder = 0
  let gBob = 0
  let gMaster = 0
  let gSurfaceBed = 0
  let gUnderBed = 0
  let underCutoff = 900

  async function boot() {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0
    master.connect(ctx.destination)

    const noise = noiseBuffer(ctx, 4)

    // —— surface wash ————————————————————————————————
    surfaceFilter = ctx.createBiquadFilter()
    surfaceFilter.type = 'bandpass'
    surfaceFilter.frequency.value = 780
    surfaceFilter.Q.value = 0.55
    surfaceFilter.connect(master)
    surfaceNoise = startNoise(ctx, noise, surfaceFilter)

    // —— close-mic bob / ear water ————————————————————
    bobFilter = ctx.createBiquadFilter()
    bobFilter.type = 'lowpass'
    bobFilter.frequency.value = 420
    bobFilter.Q.value = 0.8
    bobFilter.connect(master)
    bobNoise = startNoise(ctx, noise, bobFilter)

    // —— underwater hush ——————————————————————————————
    underFilter = ctx.createBiquadFilter()
    underFilter.type = 'lowpass'
    underFilter.frequency.value = 900
    underFilter.Q.value = 0.6
    underFilter.connect(master)
    underNoise = startNoise(ctx, noise, underFilter)

    rumbleGain = ctx.createGain()
    rumbleGain.gain.value = 0
    rumbleGain.connect(master)
    underRumble = ctx.createOscillator()
    underRumble.type = 'sine'
    underRumble.frequency.value = 42
    underRumble.connect(rumbleGain)
    underRumble.start(0)

    // Optional Lyria beds (generated offline by scripts/gen-audio-lyria.mjs)
    const [surfBuf, underBuf] = await Promise.all([
      tryLoadBed(ctx, '/audio/surface-bed.mp3'),
      tryLoadBed(ctx, '/audio/underwater-bed.mp3'),
    ])
    if (surfBuf) surfaceBed = startBed(ctx, surfBuf, master)
    if (underBuf) underBed = startBed(ctx, underBuf, master)

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

  /** Soft plunge when the camera crosses the surface. */
  function playSplash(intensity = 0.5) {
    if (!ctx || !master || splashCool > 0) return
    splashCool = 0.85

    const duration = 0.55
    const length = Math.floor(ctx.sampleRate * duration)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    let last = 0
    for (let i = 0; i < length; i++) {
      const t = i / length
      const env = Math.exp(-t * 6.5) * (1 - t * 0.35)
      const white = Math.random() * 2 - 1
      last = (last + 0.035 * white) / 1.035
      data[i] = last * 4.2 * env
    }

    const src = ctx.createBufferSource()
    src.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 650 + intensity * 400
    filter.Q.value = 0.7
    const gain = ctx.createGain()
    gain.gain.value = 0.55 * intensity
    src.connect(filter)
    filter.connect(gain)
    gain.connect(master)
    src.start(0)
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
    gain.connect(master)
    src.start(0)
  }

  /**
   * @param submersion 0 at surface, 1 fully under
   * @param depth metres below the swell
   * @param heave local surface height — drives the close bob layer
   * @param storm 0..1 squall strength — louder wash, harsher wind band
   */
  function update(dt: number, submersion: number, depth: number, heave = 0, storm = 0) {
    splashCool = Math.max(0, splashCool - dt)

    if (ready && ((lastSub < 0.42 && submersion >= 0.55) || (lastSub > 0.55 && submersion <= 0.42))) {
      playSplash(0.4 + Math.min(0.45, Math.abs(submersion - lastSub)) + storm * 0.25)
    }
    lastSub = submersion

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

    gSurface = damp(gSurface, surfaceW * 0.42 * wind, 3.4, dt)
    gUnder = damp(gUnder, underW * (0.55 + murk * 0.15), 3.4, dt)
    gBob = damp(gBob, bobW * 0.5 * (1 + storm * 0.4), 5, dt)
    gMaster = damp(gMaster, 0.9 + storm * 0.08, 2.2, dt)
    gSurfaceBed = damp(gSurfaceBed, surfaceW * 0.22 * (1 + storm * 0.3), 2.5, dt)
    gUnderBed = damp(gUnderBed, underW * 0.28, 2.5, dt)
    underCutoff = damp(underCutoff, 1050 - murk * 650, 2.6, dt)

    const now = ctx.currentTime
    surfaceNoise.gain.gain.setTargetAtTime(gSurface, now, 0.05)
    underNoise.gain.gain.setTargetAtTime(gUnder, now, 0.05)
    bobNoise.gain.gain.setTargetAtTime(gBob, now, 0.04)
    master.gain.setTargetAtTime(gMaster, now, 0.05)
    if (underFilter) underFilter.frequency.setTargetAtTime(underCutoff, now, 0.08)
    if (rumbleGain) rumbleGain.gain.setTargetAtTime(underW * (0.08 + murk * 0.1), now, 0.08)
    if (surfaceBed) surfaceBed.gain.gain.setTargetAtTime(gSurfaceBed, now, 0.08)
    if (underBed) underBed.gain.gain.setTargetAtTime(gUnderBed, now, 0.08)

    // Swell breathing on the surface filter — storms push it brighter / windier
    if (surfaceFilter) {
      const breath = 720 + Math.sin(now * 0.35) * 90 + heave * 40 + storm * 380
      surfaceFilter.frequency.setTargetAtTime(breath, now, 0.1)
      surfaceFilter.Q.setTargetAtTime(0.55 + storm * 0.35, now, 0.12)
    }
    if (bobFilter) {
      bobFilter.frequency.setTargetAtTime(360 + Math.abs(heave) * 80 + storm * 60, now, 0.08)
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
  }

  bindUnlock()

  return { unlock, update }
}
