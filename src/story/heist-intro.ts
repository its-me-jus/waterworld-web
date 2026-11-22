/**
 * The cold open, and the smoke that answers it.
 *
 * You robbed a bank, stole a bush plane, lost an engine over open water and
 * went out of the door with a soggy duffel of $2,400,000. The intro is the
 * last sixteen seconds of that, told over the real descent. There is no
 * video: the world is already rendering the drop behind it, so all this file
 * adds is a letterbox, a red wash that was the cockpit a moment ago, a few
 * lines of subtitle and a handful of synthesised sounds. It never takes the
 * controls. Everything it puts on screen ignores the pointer except its Skip
 * button, and the canopy flies exactly as it always does underneath.
 *
 * The smoke is the other half: a thin column rising out of the rainforest
 * off the run-in, which says somebody lives on the atoll Vince swore nobody
 * goes near.
 */
import './heist-intro.css'
import * as THREE from 'three'
import { DETAIL_LAYER } from '../quality'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

// —— the cold open ————————————————————————————————————————————————

/*
 * Beats, in seconds on the intro's own clock. The clock only moves when
 * update() is called, so a frame that stalls stalls the story with it and the
 * words never run ahead of the picture.
 */
/** Red wash and alarm, from the first frame. */
const ALARM_END = 3.2
const TITLE_IN = 1.0
const TITLE_OUT = 4.9
/** Static comes up under the last of the title. */
const RADIO_IN = 4.8
/** Vince is taken off the air mid-word. */
const CUT = 12.2
const FINAL_IN = 13.8
const FINAL_OUT = 15.6
const BARS_OUT = 15.3
const END = 16.2
/** The engine catches for the last time about here. */
const ENGINE_OUT = 5.2

/**
 * Metres of air at or under which the player is down. The intro only listens
 * for this after it has seen real height once, because the parachute reports
 * a height of zero until its first flight step has run.
 */
const LANDED = 1
const AIRBORNE = 5

type Cue = {
  at: number
  until: number
  text: string
  /** `radio` is Vince keying the mic; `sound` is a caption for what you hear. */
  kind: 'radio' | 'sound'
  /** Ends mid-word: the static takes it, so it goes without a fade. */
  cutOff?: boolean
}

const RADIO_WHO = 'VINCE · RADIO'

/*
 * All the words are here; nothing is spoken. The radio lines run back to back
 * so the subtitle stays up for the whole transmission and only its text
 * changes, the way a film subtitles one breathless speaker.
 */
const CUES: Cue[] = [
  { at: 0.3, until: 2.9, kind: 'sound', text: '(Cockpit alarm. The good engine coughs.)' },
  { at: 5.4, until: 7.4, kind: 'radio', text: 'Forty miles short!' },
  { at: 7.4, until: 9.5, kind: 'radio', text: 'That’s not San Marco—' },
  { at: 9.5, until: CUT, kind: 'radio', text: 'Don’t jump, nobody goes near that atoll—', cutOff: true },
  { at: 12.55, until: 13.6, kind: 'sound', text: '(Static. Then nothing.)' },
]

export type HeistIntroOptions = {
  /** main.ts passes `wantChute`: no drop, no story. Default true. */
  enabled?: boolean
  /**
   * Metres of air under the player. Pass `() => (chute.active ? chute.height : 0)`
   * and the intro ends itself on landing, so a short drop (`?alt=40`) or the
   * "Begin on the beach" button never leaves it running over the sand.
   */
  getAltitude?: () => number
  /**
   * The player chose to skip (the button, Enter, or Escape with the mouse free).
   * It runs inside that input event, so it is a good place to unlock other
   * audio: the Enter that skips is kept from every other key listener.
   * onDone follows it.
   */
  onSkip?: () => void
  /**
   * The intro is over, for whatever reason: it ran out, it was skipped, the
   * player landed, or skip() was called. Runs once, as the overlay starts to
   * fade. Never runs if the intro never started.
   */
  onDone?: () => void
}

export type HeistIntro = {
  /** Put the overlay up and start the clock. A no-op when disabled or already started. */
  start(): void
  /** End it now, quickly, without calling onSkip (for main.ts's own skips). */
  skip(): void
  /** Advance the clock; main.ts calls it once a frame, after the parachute's own step. */
  update(dt: number): void
  /** True from start() until the overlay begins to leave. Enter belongs to the intro while this is true. */
  readonly playing: boolean
  /** Take everything down at once, with no callbacks. */
  dispose(): void
}

type Ui = ReturnType<typeof buildOverlay>

function buildOverlay() {
  const root = document.createElement('div')
  root.id = 'heist-intro'
  root.innerHTML = `
    <div class="heist-alarm"><div class="heist-alarm-pulse"></div></div>
    <div class="heist-bar heist-bar-top"></div>
    <div class="heist-bar heist-bar-bottom"></div>
    <div class="heist-title">
      <span class="heist-kicker">$2,400,000 · ONE ENGINE · NO PLAN</span>
      <span class="heist-rule"></span>
      <p class="heist-tagline">The getaway had been going well.</p>
    </div>
    <div class="heist-sub" role="status" aria-live="polite">
      <span class="heist-who"></span>
      <span class="heist-line"></span>
    </div>
    <p class="heist-final">You jumped.</p>`
  const q = (selector: string) => root.querySelector<HTMLElement>(selector)!

  const skip = document.createElement('button')
  skip.id = 'heist-skip'
  skip.type = 'button'
  // "Skip" alone would sit beside "Begin on the beach" and read as skipping the drop
  skip.textContent = 'Skip intro'
  skip.title = 'Skip the intro · Enter'

  return {
    root,
    skip,
    title: q('.heist-title'),
    sub: q('.heist-sub'),
    who: q('.heist-who'),
    line: q('.heist-line'),
    final: q('.heist-final'),
  }
}

/** Events a browser may count as the gesture that lets sound start (touchend and pointerup on phones). */
const GESTURES = ['pointerdown', 'pointerup', 'touchstart', 'touchend'] as const

/**
 * The intro, over the drop.
 *
 * It runs on main.ts's clock: call update(dt) once a frame. Nothing advances
 * without it.
 */
export function createHeistIntro(app: HTMLElement, opts: HeistIntroOptions = {}): HeistIntro {
  const params = new URLSearchParams(location.search)
  // Film stills and the screenshot scripts want the world and nothing else
  const allowed = opts.enabled !== false && !params.has('film') && !navigator.webdriver

  type State = 'idle' | 'playing' | 'leaving' | 'gone'
  let state: State = 'idle'
  let ui: Ui | null = null
  let t = 0
  let cueIndex = -1
  let cutPlayed = false
  let seenAir = false
  let removeTimer = 0
  let lockChangedAt = Number.NEGATIVE_INFINITY

  let ctx: AudioContext | null = null
  let sound: IntroSound | null = null
  let soundBegun = false
  let soundFailed = false
  let hiddenSuspend = false
  let gesturesBound = false

  function start() {
    if (!allowed || state !== 'idle') return
    ui = buildOverlay()
    app.append(ui.root, ui.skip)
    ui.skip.addEventListener('click', onSkipClick)
    // Styles are worked out now, so the bars and the wash transition in on the
    // first update rather than appearing already in place
    void ui.root.offsetWidth
    state = 'playing'
    t = 0
    window.addEventListener('keydown', onKey, { capture: true })
    bindGestures()
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('pointerlockchange', onLockChange)
  }

  function update(dt: number) {
    if (state !== 'playing' || !ui) return
    t += Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0

    const altitude = opts.getAltitude?.()
    if (altitude !== undefined && Number.isFinite(altitude)) {
      if (altitude > AIRBORNE) seenAir = true
      else if (seenAir && altitude <= LANDED) {
        finish('landed')
        return
      }
    }

    applyBeats()

    // Sound joins wherever the story has got to. Beats above only drive it
    // once it has begun, so a line that starts on this frame is not voiced twice.
    if (sound && ctx?.state === 'running') {
      if (!soundBegun) {
        soundBegun = true
        unbindGestures()
        const cue = cueIndex >= 0 ? CUES[cueIndex] : null
        sound.begin(t, cue?.kind === 'radio' ? cue : null)
      }
      sound.frame(t, cueIndex >= 0 && CUES[cueIndex].kind === 'radio')
    }

    if (t >= END) finish('done')
  }

  function applyBeats() {
    if (!ui) return
    ui.root.classList.toggle('heist-bars', t < BARS_OUT)
    ui.root.classList.toggle('heist-alarm-on', t < ALARM_END)
    ui.title.classList.toggle('heist-on', t >= TITLE_IN && t < TITLE_OUT)
    ui.final.classList.toggle('heist-on', t >= FINAL_IN && t < FINAL_OUT)

    let next = -1
    for (let i = 0; i < CUES.length; i++) {
      if (t >= CUES[i].at && t < CUES[i].until) {
        next = i
        break
      }
    }
    if (next !== cueIndex) {
      const was = cueIndex >= 0 ? CUES[cueIndex] : null
      const cue = next >= 0 ? CUES[next] : null
      cueIndex = next
      // A line the static takes is gone at once; everything else fades
      ui.sub.classList.toggle('heist-cut', !cue && !!was?.cutOff)
      if (cue) {
        ui.line.textContent = cue.text
        ui.who.textContent = cue.kind === 'radio' ? RADIO_WHO : ''
        ui.sub.dataset.kind = cue.kind
        if (cue.kind === 'radio' && soundBegun) sound?.voice(cue.until - t, !cue.cutOff)
      }
      ui.sub.classList.toggle('heist-on', !!cue)
    }

    if (t >= CUT && !cutPlayed) {
      cutPlayed = true
      if (soundBegun) sound?.cut()
    }
  }

  type Reason = 'done' | 'skipped' | 'landed' | 'told'

  function finish(reason: Reason) {
    if (state !== 'playing' || !ui) return
    state = 'leaving'
    unbind()
    const quick = reason !== 'done'
    ui.root.classList.add('heist-out')
    ui.root.classList.toggle('heist-fast', quick)
    ui.skip.remove()
    stopSound(quick)
    const leaving = ui.root
    removeTimer = window.setTimeout(() => {
      leaving.remove()
      if (state === 'leaving') state = 'gone'
    }, quick ? 450 : 1000)
    if (reason === 'skipped') opts.onSkip?.()
    opts.onDone?.()
  }

  function onSkipClick(e: MouseEvent) {
    e.stopPropagation()
    finish('skipped')
  }

  function onKey(e: KeyboardEvent) {
    if (state !== 'playing') return
    const target = e.target instanceof Element ? e.target : null
    // Typing in the World panel is not a request to skip anything
    if (target?.closest('dialog, input, textarea, select, [contenteditable="true"]')) return
    const enter = e.code === 'Enter' || e.code === 'NumpadEnter'
    if (enter && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      // Enter on a focused button presses that button ("Begin on the beach",
      // or this Skip), which main.ts already leaves alone
      if (target?.closest('button')) return
      // main.ts's own Enter cuts the whole drop away; while the story is up,
      // Enter means "skip the story" and goes no further
      e.preventDefault()
      e.stopImmediatePropagation()
      finish('skipped')
      return
    }
    // Escape is also how the mouse is let go. Only a free mouse skips, and not
    // in the moment just after the lock was released by this same press.
    if (e.code === 'Escape' && !document.pointerLockElement && performance.now() - lockChangedAt > 400) {
      e.stopImmediatePropagation()
      finish('skipped')
      return
    }
    wakeSound()
  }

  function onGesture(e: Event) {
    // Pressing Skip should not spin up sound only to close it a moment later
    if (e.target instanceof Element && e.target.closest('#heist-skip')) return
    wakeSound()
  }

  /**
   * Browsers hold sound back until the player does something, and the drop
   * starts with no gesture at all. The subtitles run regardless; the first
   * press, tap or key during the intro creates the sound, and it comes in at
   * whatever beat the story has reached.
   */
  function wakeSound() {
    if (state !== 'playing' || soundFailed) return
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      try {
        ctx = new AC()
        sound = createIntroSound(ctx)
      } catch {
        // No sound on this machine: the story is all in the words anyway
        soundFailed = true
        ctx = null
        sound = null
        unbindGestures()
        return
      }
    }
    // Some events (touchstart in Chrome) may not count; the next one will
    if (ctx.state === 'suspended' && !document.hidden) void ctx.resume().catch(() => {})
  }

  function stopSound(quick: boolean) {
    const c = ctx
    ctx = null
    if (c) {
      if (sound && soundBegun && c.state === 'running') sound.stop(quick)
      else void c.close().catch(() => {})
    }
    sound = null
  }

  function onVisibility() {
    if (!ctx) return
    if (document.hidden) {
      if (ctx.state === 'running') {
        hiddenSuspend = true
        void ctx.suspend()
      }
    } else if (hiddenSuspend) {
      hiddenSuspend = false
      void ctx.resume().catch(() => {})
    }
  }

  function onLockChange() {
    lockChangedAt = performance.now()
  }

  function bindGestures() {
    if (gesturesBound) return
    gesturesBound = true
    for (const type of GESTURES) window.addEventListener(type, onGesture, { capture: true, passive: true })
  }

  function unbindGestures() {
    if (!gesturesBound) return
    gesturesBound = false
    for (const type of GESTURES) window.removeEventListener(type, onGesture, { capture: true })
  }

  /** Hand Enter (and everything else) back to main.ts. */
  function unbind() {
    window.removeEventListener('keydown', onKey, { capture: true })
    unbindGestures()
    document.removeEventListener('visibilitychange', onVisibility)
    document.removeEventListener('pointerlockchange', onLockChange)
  }

  function dispose() {
    if (state === 'playing') {
      unbind()
      stopSound(true)
    }
    window.clearTimeout(removeTimer)
    ui?.root.remove()
    ui?.skip.remove()
    ui = null
    state = 'gone'
  }

  return {
    start,
    skip: () => finish('told'),
    update,
    get playing() {
      return state === 'playing'
    },
    dispose,
  }
}

// —— the intro's sound ————————————————————————————————————————————

/*
 * Levels before the intro's own master gain, which keeps the whole of it
 * under the game's sea.
 */
const MASTER_LEVEL = 0.25
const ALARM_LEVEL = 0.3
const ENGINE_LEVEL = 0.5
const STATIC_LEVEL = 0.42
const CRACKLE_LEVEL = 0.5
const VOICE_LEVEL = 0.45
const SQUELCH_LEVEL = 0.55

type IntroSound = ReturnType<typeof createIntroSound>

function whiteNoise(ctx: AudioContext, seconds: number) {
  const length = Math.floor(ctx.sampleRate * seconds)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  // White, not the brown the sea uses: a radio hiss lives up where brown noise has nothing
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
  return buffer
}

/**
 * Everything is built at once and left running silent; the clock then only
 * moves levels. Continuous layers follow the intro's clock frame by frame, so
 * they stay with the picture. Only what needs sample timing is scheduled
 * ahead: the alarm's beeping (oscillators) and each radio line's syllables,
 * which last a couple of seconds at most.
 */
function createIntroSound(ctx: AudioContext) {
  const master = ctx.createGain()
  master.gain.value = 0
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -12
  limiter.knee.value = 10
  limiter.ratio.value = 5
  limiter.attack.value = 0.004
  limiter.release.value = 0.25
  master.connect(limiter).connect(ctx.destination)

  const noise = whiteNoise(ctx, 2)
  const loop = (dest: AudioNode) => {
    const src = ctx.createBufferSource()
    src.buffer = noise
    src.loop = true
    src.connect(dest)
    src.start(0, Math.random() * 1.8)
  }
  const gain = (value: number, dest: AudioNode) => {
    const g = ctx.createGain()
    g.gain.value = value
    g.connect(dest)
    return g
  }
  const filter = (type: BiquadFilterType, hz: number, q: number, dest: AudioNode) => {
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = hz
    f.Q.value = q
    f.connect(dest)
    return f
  }
  const osc = (type: OscillatorType, hz: number, dest: AudioNode) => {
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = hz
    o.connect(dest)
    o.start(0)
    return o
  }

  // —— cockpit alarm: two tones swapped by a square wave, beeping through a gate
  const alarmLevel = gain(0, master)
  const alarmGate = gain(0.5, alarmLevel)
  const alarmTone = filter('lowpass', 1700, 0.7, alarmGate)
  const alarmSquare = osc('square', 640, alarmTone)
  const alarmSaw = osc('sawtooth', 641.5, gain(0.35, alarmTone))
  {
    const swapDepth = ctx.createGain()
    swapDepth.gain.value = 150
    swapDepth.connect(alarmSquare.frequency)
    swapDepth.connect(alarmSaw.frequency)
    osc('square', 1.6, swapDepth)
    // The gate's edges go through a low-pass so each beep starts without a click
    const gateDepth = ctx.createGain()
    gateDepth.gain.value = 0.5
    gateDepth.connect(alarmGate.gain)
    osc('square', 3.2, filter('lowpass', 30, 0.7, gateDepth))
  }

  // —— the good engine: a sagging sawtooth and some combustion noise, chopped by
  // the prop and by misfires
  const engLevel = gain(0, master)
  const engMisfire = gain(0.8, engLevel)
  const engAm = gain(0.6, engMisfire)
  const engTone = filter('lowpass', 950, 1.1, engAm)
  const engSaw = osc('sawtooth', 58, engTone)
  const engSaw2 = osc('sawtooth', 116.7, gain(0.4, engTone))
  loop(filter('bandpass', 240, 0.9, gain(0.7, engTone)))
  const propDepth = ctx.createGain()
  propDepth.gain.value = 0.4
  propDepth.connect(engAm.gain)
  const prop = osc('sine', 21, propDepth)

  // —— radio: band-passed hiss, and crackle on its own path so it can spike
  const staticLevel = gain(0, master)
  const staticBand = filter('bandpass', 1800, 0.75, filter('highpass', 380, 0.7, staticLevel))
  loop(staticBand)
  const crackle = gain(0, master)
  loop(filter('highpass', 3000, 0.8, crackle))

  // —— Vince: not speech, a buzz through two telephone-band formants with a
  // little breath in it, shaped into syllables under each subtitle
  const voiceGain = gain(0, master)
  const voiceHigh = filter('highpass', 420, 0.8, voiceGain)
  const formantA = filter('bandpass', 850, 2.4, voiceHigh)
  const formantB = filter('bandpass', 1750, 3.2, gain(0.7, voiceHigh))
  const voiceBuzz = osc('sawtooth', 170, formantA)
  voiceBuzz.connect(formantB)
  loop(gain(0.25, formantA))

  let cutDone = false
  let firing = true
  let engineDead = false
  let nextMisfire = 0
  let nextCrackle = 0

  /** The radio's key-up click and key-down hiss. */
  function squelch(when: number, hz: number, seconds: number, level: number) {
    const src = ctx.createBufferSource()
    src.buffer = noise
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = hz
    band.Q.value = 1.4
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, when)
    env.gain.linearRampToValueAtTime(level, when + 0.004)
    env.gain.setTargetAtTime(0, when + 0.012, seconds / 3)
    src.connect(band).connect(env).connect(master)
    src.start(when, Math.random() * 1.5, seconds + 0.05)
  }

  /** One radio line: key up, a few seconds of syllables, key down unless the static gets him first. */
  function voice(seconds: number, keyDown: boolean) {
    if (cutDone || seconds < 0.2) return
    const at = ctx.currentTime
    const g = voiceGain.gain
    g.cancelScheduledValues(at)
    g.setValueAtTime(0, at)
    squelch(at, 2700, 0.06, SQUELCH_LEVEL)
    const end = at + seconds - (keyDown ? 0.14 : 0)
    let s = at + 0.08
    let n = 0
    while (s < end - 0.07) {
      const len = Math.min(0.07 + Math.random() * 0.13, end - s)
      g.setTargetAtTime(VOICE_LEVEL * (0.5 + Math.random() * 0.5), s, 0.012)
      g.setTargetAtTime(0, s + len, 0.022)
      // Panic sits high and wanders: every syllable lands on its own pitch
      voiceBuzz.frequency.setTargetAtTime(150 + Math.random() * 85, s, 0.025)
      s += len + 0.02 + Math.random() * 0.05
      n++
      // A catch of breath between words
      if (n % 4 === 0) s += 0.07 + Math.random() * 0.1
    }
    g.setTargetAtTime(0, end, 0.02)
    if (keyDown) squelch(end + 0.02, 1900, 0.14, SQUELCH_LEVEL * 0.7)
  }

  /** The good engine is going: it catches less often, and drops out for longer each time. */
  function misfire(t: number, at: number) {
    const failing = smooth(0.5, ENGINE_OUT, t)
    firing = Math.random() > 0.15 + 0.6 * failing
    const level = firing ? 0.55 + Math.random() * 0.45 : 0.03 + Math.random() * 0.06
    engMisfire.gain.setTargetAtTime(level, at, firing ? 0.012 : 0.02)
    nextMisfire =
      t + (firing ? 0.06 + Math.random() * (0.26 - 0.15 * failing) : 0.04 + Math.random() * (0.08 + 0.22 * failing))
  }

  /** Sound joins the story at `t`: fade up, and pick up a radio line already in progress. */
  function begin(t: number, line: Cue | null) {
    master.gain.setTargetAtTime(MASTER_LEVEL, ctx.currentTime, 0.08)
    nextMisfire = t
    nextCrackle = t
    if (t >= CUT) cutDone = true
    else if (line) voice(line.until - t, !line.cutOff)
  }

  function frame(t: number, speaking: boolean) {
    const at = ctx.currentTime

    // The plane flies on without you: the alarm falls behind, lower and duller, then gone
    const behind = smooth(2.0, ALARM_END + 0.2, t)
    alarmLevel.gain.setTargetAtTime(ALARM_LEVEL * (1 - behind), at, 0.06)
    alarmTone.frequency.setTargetAtTime(1700 - 1150 * behind, at, 0.08)
    alarmSquare.detune.setTargetAtTime(-160 * behind, at, 0.1)
    alarmSaw.detune.setTargetAtTime(-160 * behind, at, 0.1)

    // The engine sags in pitch as it dies and goes faint as the plane goes away
    const dying = smooth(0, ENGINE_OUT, t)
    const away = smooth(1.8, 6.2, t)
    engLevel.gain.setTargetAtTime(ENGINE_LEVEL * (1 - away), at, 0.08)
    engTone.frequency.setTargetAtTime(950 - 600 * away, at, 0.1)
    const pitch = (1 - 0.48 * dying) * (firing ? 1 : 0.9)
    engSaw.frequency.setTargetAtTime(58 * pitch, at, 0.05)
    engSaw2.frequency.setTargetAtTime(116.7 * pitch, at, 0.05)
    // The prop's beat slows with it, from a buzz to a lazy whup
    prop.frequency.setTargetAtTime(7 + 14 * (1 - dying), at, 0.1)
    if (t < ENGINE_OUT) {
      if (t >= nextMisfire) misfire(t, at)
    } else if (!engineDead) {
      engineDead = true
      engMisfire.gain.setTargetAtTime(0, at, 0.12)
    }

    if (!cutDone) {
      const radio = smooth(RADIO_IN, RADIO_IN + 0.7, t)
      // The hiss settles a little while he holds the key down
      staticLevel.gain.setTargetAtTime(STATIC_LEVEL * radio * (speaking ? 0.6 : 1), at, 0.06)
      staticBand.frequency.setTargetAtTime(1750 + 280 * Math.sin(t * 1.7) + 120 * Math.sin(t * 5.3), at, 0.05)
      if (radio > 0.05 && t >= nextCrackle) {
        crackle.gain.setValueAtTime(CRACKLE_LEVEL * radio * (0.25 + 0.75 * Math.random()), at)
        crackle.gain.setTargetAtTime(0, at + 0.003, 0.006 + Math.random() * 0.016)
        nextCrackle = t + 0.03 + Math.random() * Math.random() * 0.45
      }
    }
  }

  /** Static takes Vince mid-word, roars for a moment, and then there is nothing at all. */
  function cut() {
    if (cutDone) return
    cutDone = true
    const at = ctx.currentTime
    const v = voiceGain.gain
    v.cancelScheduledValues(at)
    v.setValueAtTime(v.value, at)
    v.linearRampToValueAtTime(0, at + 0.004)
    const s = staticLevel.gain
    s.cancelScheduledValues(at)
    s.setValueAtTime(s.value, at)
    s.linearRampToValueAtTime(STATIC_LEVEL * 2.2, at + 0.01)
    s.setValueAtTime(STATIC_LEVEL * 1.6, at + 0.12)
    s.setValueAtTime(STATIC_LEVEL * 2.4, at + 0.18)
    // Abrupt on purpose; the few milliseconds only keep it from clicking
    s.setValueAtTime(STATIC_LEVEL * 2.4, at + 0.295)
    s.linearRampToValueAtTime(0, at + 0.3)
    staticBand.frequency.cancelScheduledValues(at)
    staticBand.frequency.setValueAtTime(2400, at)
    const c = crackle.gain
    c.cancelScheduledValues(at)
    c.setValueAtTime(CRACKLE_LEVEL, at)
    c.setTargetAtTime(0, at + 0.02, 0.03)
  }

  /** Fade out and let the context go. */
  function stop(quick: boolean) {
    const at = ctx.currentTime
    master.gain.cancelScheduledValues(at)
    master.gain.setValueAtTime(master.gain.value, at)
    master.gain.setTargetAtTime(0, at, quick ? 0.04 : 0.25)
    window.setTimeout(() => void ctx.close().catch(() => {}), quick ? 300 : 1400)
  }

  return { begin, frame, voice, cut, stop }
}

// —— the smoke ——————————————————————————————————————————————————————

/**
 * Which way the trade wind runs, as island.ts has it (WIND_HEADING there).
 * The plants lean along (cos, sin) of it in x and z, so that is downwind.
 */
const WIND_HEADING = 0.62
/** Seconds a puff lives, fire to nothing. The column is about this many seconds of smoke. */
const SMOKE_LIFE = 80

export type SmokeWeather = { daylight: number; storm: number }

const smokeVertex = /* glsl */ `
attribute vec4 aSeed; // x: where in its life the puff starts; yzw: its own scatter
uniform float uTime;
uniform float uLife;
uniform float uStorm;
uniform vec2 uWind;
uniform float uSize;
uniform float uDensity;
varying vec2 vUv;
varying float vAlpha;
varying float vUp;
varying float vHigh;
varying float vBase;
#include <fog_pars_vertex>

void main() {
  // Every puff's place is worked out from its age alone, so the column costs
  // the CPU nothing from one frame to the next
  float age = fract(uTime / uLife + aSeed.x) * uLife;
  float lifeFrac = age / uLife;
  float born = uTime - age;
  float storm = uStorm;

  // Heat runs out with height: quick off the fire, then barely climbing.
  // A squall knocks the top off the column.
  float top = mix(125.0, 44.0, storm);
  float h = top * (1.0 - exp(-age / mix(34.0, 15.0, storm)));

  // Drift is what the wind has done to the puff on its way up. Under the
  // canopy there is hardly any; above it the trade wind takes it. Reading the
  // gust at the middle of the puff's life sends ripples up the column instead
  // of swinging the whole column at once.
  float g = born + age * 0.5;
  float gust = 1.0 + 0.26 * sin(g * 0.13 + 0.7) + 0.14 * sin(g * 0.41 + 2.3);
  float wind = mix(1.35, 4.6, storm) * gust;
  float down = wind * age * (0.18 + 0.82 * smoothstep(4.0, 50.0, h));

  // A slow meander keyed to when the puff left the fire, so neighbours share
  // it and the column snakes rather than fizzing
  float wander = (1.0 + 0.13 * h) * (1.0 + 0.8 * storm);
  float side = sin(born * 0.093 + 1.3) + 0.55 * sin(born * 0.29 + 4.1);
  float along = sin(born * 0.071 + 2.2) + 0.5 * sin(born * 0.23);
  // And each puff's own scatter, wider as the column spreads with height
  float spread = (0.5 + 0.11 * h) * (1.0 + 1.1 * storm);
  vec3 jitter = aSeed.yzw * 2.0 - 1.0 + 0.4 * sin(age * vec3(0.37, 0.29, 0.33) + aSeed.yzw * 6.2831);

  vec2 across = vec2(-uWind.y, uWind.x);
  vec3 place = vec3(0.0, 0.8 + h + jitter.y * spread * 0.45, 0.0);
  place.xz = uWind * (down + along * wander * 0.5 + jitter.x * spread) + across * (side * wander + jitter.z * spread);
  vec3 centre = (modelMatrix * vec4(place, 1.0)).xyz;

  // Wisps off the fire, broad soft billows at the top
  float size = (mix(1.8, 9.5, smoothstep(0.0, 60.0, h)) + h * 0.1)
    * (0.5 + 0.5 * smoothstep(0.0, 4.0, age))
    * (0.8 + 0.4 * aSeed.w) * uSize * (1.0 - 0.2 * storm);

  // Each puff turns slowly, so the one texture never shows the same face twice
  float spin = aSeed.y * 6.2831 + age * (aSeed.z - 0.5) * 0.2;
  vec2 corner = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * position.xy;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  // A squall drags each puff into a streak along the wind; the wind is level,
  // so on screen that is near enough sideways from anywhere but straight above
  vec3 world = centre + (right * corner.x * (1.0 + 1.1 * storm) + up * corner.y) * size;

  vUv = position.xy * 0.5 + 0.5;
  vUp = corner.y;
  vHigh = h / top;
  vBase = 1.0 - smoothstep(2.0, 28.0, h);

  float alpha = smoothstep(0.0, 2.5, age);
  // Fades out at the end of its life, much sooner in a squall, which shreds it
  float cut = mix(1.0, 0.5, storm);
  alpha *= 1.0 - smoothstep(cut - 0.3, cut, lifeFrac);
  // Dense over the fire, a thin veil once it has spread
  alpha *= mix(0.5, 0.1, smoothstep(0.0, 105.0, h));
  // Shredding: in a blow, more and more puffs simply are not there
  float keep = fract(aSeed.y * 7.13 + aSeed.z * 3.71);
  alpha *= mix(1.0, smoothstep(storm * 0.7 - 0.1, storm * 0.7 + 0.1, keep), smoothstep(0.0, 0.2, storm));
  // Walking into the column must not turn the screen into one grey puff
  alpha *= smoothstep(size * 0.3, size * 1.1, distance(centre, cameraPosition));
  vAlpha = alpha * uDensity;

  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`

const smokeFragment = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uGlow;
varying vec2 vUv;
varying float vAlpha;
varying float vUp;
varying float vHigh;
varying float vBase;
#include <fog_pars_fragment>

void main() {
  float body = texture2D(uMap, vUv).r;
  // The same puff again, turned and enlarged, so no two read as one stamp
  vec2 q = (vUv - 0.5) * 1.7;
  body *= 0.55 + 0.45 * texture2D(uMap, vec2(q.y, -q.x) + 0.5).r;
  float alpha = body * vAlpha;
  if (alpha < 0.004) discard;

  // Tops of puffs and the high column catch the sky; undersides and the base sit in their own shade
  vec3 col = mix(uShade, uLit, clamp(0.3 + 0.35 * vUp + 0.35 * vHigh, 0.0, 1.0));
  // The fire lights the smoke just above it, once there is no sun to drown it out
  col += uGlow * vBase * (0.7 - 0.3 * vUp);

  #ifdef USE_FOG
    #ifdef FOG_EXP2
      // The scene's fog, at the strength the island's own aerial haze uses
      // (foliage.ts mixes toward the same horizon at about half the scene
      // fog's density). Taken at full strength the column washed out to the
      // horizon colour well before the canopy it rises out of did. Under the
      // sea the fog is thick, and there it is allowed to swallow the smoke.
      float fogDepth = fogDensity * 0.55 * vFogDepth;
      float fogFactor = min(1.0 - exp(-fogDepth * fogDepth), fogDensity > 0.011 ? 1.0 : 0.9);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col = mix(col, fogColor, fogFactor);
  #endif

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** One soft, lumpy puff: a body and a ring of smaller lobes, a little grain, nothing at the edge of the square. */
function puffTexture() {
  const size = 128
  const data = new Uint8Array(size * size * 4)
  let seed = 5
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const lobes: { x: number; y: number; r: number; k: number }[] = [{ x: 0, y: 0, r: 0.46, k: 1 }]
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rand() * 0.6
    const d = 0.2 + rand() * 0.18
    lobes.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: 0.16 + rand() * 0.12, k: 0.45 + rand() * 0.45 })
  }
  // Coarse value noise, for some texture inside the puff
  const G = 12
  const grid = new Float32Array((G + 1) * (G + 1))
  for (let i = 0; i < grid.length; i++) grid[i] = rand()
  const cell = (gx: number, gy: number) => grid[gy * (G + 1) + gx]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1
      const v = ((y + 0.5) / size) * 2 - 1
      let d = 0
      for (const l of lobes) {
        const dx = u - l.x
        const dy = v - l.y
        d += l.k * Math.exp(-(dx * dx + dy * dy) / (l.r * l.r))
      }
      const fx = ((u + 1) / 2) * G
      const fy = ((v + 1) / 2) * G
      const ix = Math.min(G - 1, Math.floor(fx))
      const iy = Math.min(G - 1, Math.floor(fy))
      const sx = smooth(0, 1, fx - ix)
      const sy = smooth(0, 1, fy - iy)
      const top = cell(ix, iy) + (cell(ix + 1, iy) - cell(ix, iy)) * sx
      const bottom = cell(ix, iy + 1) + (cell(ix + 1, iy + 1) - cell(ix, iy + 1)) * sx
      const grain = top + (bottom - top) * sy
      const edge = 1 - smooth(0.6, 0.97, Math.hypot(u, v))
      const value = clamp((1 - Math.exp(-d * 1.4)) * edge * (0.7 + 0.3 * grain), 0, 1)
      const o = (y * size + x) * 4
      const b = Math.round(value * 255)
      data[o] = b
      data[o + 1] = b
      data[o + 2] = b
      data[o + 3] = b
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  // Mipmapped: from the parachute each puff is a few dozen pixels across
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

/**
 * The camp's smoke: a thin column that leans away on the trade wind, spreads
 * and thins as it climbs, and is visible from the parachute well before
 * anything else about the camp is.
 *
 * `pos` is the fire pit (getTribePlaces(...).campFire). The column is soft
 * billboards on one instanced quad, every puff placed in the vertex shader
 * from its age, so a frame costs a few uniform writes and nothing else. It
 * lights nothing: a real light here would make every shader in the scene
 * recompile when it came or went. The glow at night is painted into the smoke.
 */
export function createIslandSmoke(scene: THREE.Scene, pos: THREE.Vector3, lowPower: boolean) {
  const count = lowPower ? 120 : 240
  const base = new THREE.PlaneGeometry(2, 2)
  const geo = new THREE.InstancedBufferGeometry()
  geo.index = base.index
  geo.setAttribute('position', base.getAttribute('position'))
  const seeds = new Float32Array(count * 4)
  let seed = 29
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  for (let i = 0; i < count; i++) {
    // Spaced evenly through a life, so the column has no gaps and no clumps
    seeds[i * 4] = (i + rand() * 0.8) / count
    seeds[i * 4 + 1] = rand()
    seeds[i * 4 + 2] = rand()
    seeds[i * 4 + 3] = rand()
  }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4))
  geo.instanceCount = count

  const wind = new THREE.Vector2(Math.cos(WIND_HEADING), Math.sin(WIND_HEADING))
  // The puffs are placed in the shader, so the bounds cannot be measured from
  // the geometry. This holds the whole column, calm or leaning far over in a
  // squall, which is what frustum culling needs to be right.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(wind.x * 110, 60, wind.y * 110), 240)

  const u = {
    uMap: { value: puffTexture() },
    uTime: { value: 0 },
    uLife: { value: SMOKE_LIFE },
    uStorm: { value: 0 },
    uWind: { value: wind },
    // Half the puffs on a phone: each one a little larger and denser so the column stays whole
    uSize: { value: lowPower ? 1.2 : 1 },
    uDensity: { value: lowPower ? 1.3 : 1 },
    uLit: { value: new THREE.Color() },
    uShade: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() },
  }
  const material = new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...u },
    vertexShader: smokeVertex,
    fragmentShader: smokeFragment,
    transparent: true,
    depthWrite: false,
    fog: true,
  })

  const mesh = new THREE.Mesh(geo, material)
  // Drawn before the low clouds, which sit above it and should veil it, not the other way round
  mesh.renderOrder = 5
  // The sky probe has no use for it
  mesh.layers.set(DETAIL_LAYER)

  const group = new THREE.Group()
  group.name = 'island-smoke'
  group.position.copy(pos)
  group.layers.set(DETAIL_LAYER)
  group.userData.noShadow = true
  group.add(mesh)
  scene.add(group)

  // Linear colours, before exposure. Lit cloud at noon has to sit well above
  // 1 or the short midday exposure greys it (see lowclouds.ts); smoke is a
  // little greyer than cloud.
  const dayLit = new THREE.Color(1.45, 1.47, 1.52)
  const dayShade = new THREE.Color(0.78, 0.82, 0.88)
  const nightLit = new THREE.Color(0.055, 0.062, 0.08)
  const nightShade = new THREE.Color(0.028, 0.032, 0.042)
  const duskTint = new THREE.Color(1.0, 0.8, 0.62)
  const ember = new THREE.Color(1.0, 0.42, 0.13)
  const tint = new THREE.Color()
  let storm = 0
  let primed = false

  function update(dt: number, t: number, weather: SmokeWeather) {
    if (!group.visible) return
    const day = clamp(weather.daylight, 0, 1)
    const target = clamp(weather.storm, 0, 1)
    // A squall arriving bends the column over gradually, never in one frame
    storm = primed ? storm + (target - storm) * (1 - Math.exp(-0.5 * Math.max(0, dt))) : target
    primed = true
    u.uTime.value = t
    u.uStorm.value = storm

    const light = smooth(0.03, 0.7, day)
    const lit = u.uLit.value.copy(nightLit).lerp(dayLit, light)
    const shade = u.uShade.value.copy(nightShade).lerp(dayShade, light)
    // A low sun warms it, as it warms the clouds
    const dusk = clamp(1 - Math.abs(day - 0.42) / 0.3, 0, 1)
    tint.setRGB(1, 1, 1).lerp(duskTint, dusk * 0.65)
    lit.multiply(tint)
    shade.multiply(tint)
    // Under a squall there is no sunlit side, and everything is a shade darker
    lit.lerp(shade, storm * 0.55).multiplyScalar(1 - storm * 0.3)
    shade.multiplyScalar(1 - storm * 0.3)

    // Firelight on the underside, only once the day has gone, with a slow flicker
    const flicker = 0.82 + 0.18 * Math.sin(t * 7.1) * Math.sin(t * 2.3 + 1)
    u.uGlow.value.copy(ember).multiplyScalar(0.22 * (1 - smooth(0.08, 0.45, day)) * flicker)
  }

  function setVisible(on: boolean) {
    group.visible = on
  }

  function dispose() {
    scene.remove(group)
    geo.dispose()
    base.dispose()
    material.dispose()
    u.uMap.value.dispose()
  }

  return { group, update, setVisible, dispose }
}

export type IslandSmoke = ReturnType<typeof createIslandSmoke>
