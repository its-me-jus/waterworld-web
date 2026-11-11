/**
 * How much world this machine gets.
 *
 * The scene is built once, at one of two budgets: the full island, or the
 * lighter one first made for phones (sparser forest, smaller shadow map,
 * cheaper ground and canopy shading). Core count used to decide, which says
 * nothing about the graphics chip: a 28-thread laptop drawing on its built-in
 * Intel graphics got the full island at 14 frames a second, while the same
 * scene ran at well over a hundred on the discrete chip beside it. So the
 * graphics chip is timed directly, for a few milliseconds, before anything is
 * built.
 *
 * Whatever is chosen here, the frame-rate governor (see `createGovernor`)
 * then trims resolution live to hold the frame rate.
 */

/**
 * Small things on the ground sit on this three.js layer: the eye's cameras
 * draw it, the sky probe (six low-resolution views for reflections and
 * ambient light) does not. Grass and crabs never showed in a reflection, but
 * they were most of what the probe spent its time on.
 */
export const DETAIL_LAYER = 1

export type Detail = 'full' | 'light'
export type DetailChoice = Detail | 'auto'

const STORE_KEY = 'ww-detail'

/** Milliseconds the fill test may take before the machine is given the light budget. */
const SLOW_GPU_MS = 5

export type Quality = {
  detail: Detail
  /** What the player asked for; `auto` lets the timing decide. */
  choice: DetailChoice
  /** Why, in a few words, for the console and the World panel. */
  reason: string
  /** The fill test's time in ms, when it ran. */
  gpuMs: number | null
  /**
   * A desktop-sized screen with a mouse. The light budget was drawn for a
   * phone held at arm's length; on a monitor the same forest shows the hill
   * between its trees, so it gets a closer roof there (see island.ts).
   */
  bigScreen: boolean
}

function readChoice(): DetailChoice {
  const fromUrl = new URLSearchParams(location.search).get('quality')
  if (fromUrl === 'full' || fromUrl === 'light' || fromUrl === 'auto') return fromUrl
  try {
    const stored = localStorage.getItem(STORE_KEY)
    if (stored === 'full' || stored === 'light') return stored
  } catch {
    // Private windows can refuse storage; auto is the right answer there anyway
  }
  return 'auto'
}

/** Remember a choice and rebuild the world with it. */
export function setDetailChoice(choice: DetailChoice) {
  const url = new URL(location.href)
  // A choice in the address would outrank the one being saved
  url.searchParams.delete('quality')
  try {
    if (choice === 'auto') localStorage.removeItem(STORE_KEY)
    else localStorage.setItem(STORE_KEY, choice)
  } catch {
    // Nothing to remember it in (a private window): carry it in the address
    if (choice !== 'auto') url.searchParams.set('quality', choice)
  }
  location.replace(url)
}

/**
 * Time the graphics chip on the kind of work the sea and the forest are made
 * of: a screen of pixels, each running a long noise shader. Returns the best
 * of three short runs in milliseconds, or null if it could not be measured.
 */
export function timeGpu(): number | null {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' })
  if (!gl) return null
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)
      if (!shader) return null
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      return shader
    }
    const vs = compile(gl.VERTEX_SHADER, `#version 300 es
      void main() {
        vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`)
    const fs = compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform float uSeed;
      out vec4 color;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      void main() {
        vec2 p = gl_FragCoord.xy * 0.05 + uSeed;
        float v = 0.0;
        for (int i = 0; i < 48; i++) {
          v += noise(p);
          p = p * 1.07 + vec2(1.3, 0.7);
        }
        color = vec4(vec3(v / 48.0), 1.0);
      }`)
    const program = gl.createProgram()
    if (!vs || !fs || !program) return null
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
    gl.useProgram(program)
    const seed = gl.getUniformLocation(program, 'uSeed')
    const pixel = new Uint8Array(4)
    const run = (draws: number, from: number) => {
      for (let i = 0; i < draws; i++) {
        gl.uniform1f(seed, from + i)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
      // Reading a pixel back is the one call that waits for the chip to finish
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    }
    // The first draw pays for the compile and wakes the chip up
    run(2, 0)
    let best = Infinity
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = performance.now()
      run(6, 10 + attempt * 10)
      best = Math.min(best, performance.now() - t0)
    }
    return Number.isFinite(best) ? best : null
  } catch {
    return null
  } finally {
    // Hand the context straight back; browsers cap how many can be live
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

let chosen: Quality | null = null

/** Decided once per page load; every module that asks gets the same answer. */
export function quality(): Quality {
  if (chosen) return chosen
  const choice = readChoice()
  const touch = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 820
  let detail: Detail
  let reason: string
  let gpuMs: number | null = null
  if (choice !== 'auto') {
    detail = choice
    reason = 'your choice'
  } else if (touch) {
    detail = 'light'
    reason = 'phone or tablet'
  } else if ((navigator.hardwareConcurrency || 8) <= 4) {
    detail = 'light'
    reason = 'small processor'
  } else if (navigator.webdriver && new URLSearchParams(location.search).get('quality') !== 'auto') {
    // The screenshot scripts draw on a software renderer: timing it would send
    // every shot to the light budget. `?quality=auto` asks for the test anyway.
    detail = 'full'
    reason = 'automated run'
  } else {
    gpuMs = timeGpu()
    if (gpuMs !== null && gpuMs > SLOW_GPU_MS) {
      detail = 'light'
      reason = 'built-in graphics'
    } else {
      detail = 'full'
      reason = gpuMs === null ? 'graphics speed unknown' : 'fast graphics'
    }
  }
  chosen = { detail, choice, reason, gpuMs, bigScreen: !touch }
  return chosen
}

/**
 * Holds the frame rate by trimming resolution.
 *
 * The scene draws into its own buffer and is scaled up onto the canvas, so
 * the buffer can shrink without the page or the labels changing size. When
 * frames run long the buffer steps down; when they run short for a while it
 * steps back up, and if that step proves too much it waits longer before
 * trying again, so it settles instead of pumping.
 */
export function createGovernor(apply: (scale: number) => void, opts: { min?: number; enabled?: boolean } = {}) {
  const min = opts.min ?? 0.5
  const STEPS = [1, 0.87, 0.76, 0.66, 0.58, 0.5].filter((s) => s >= min - 0.001)
  // The two marks are a full step apart: one step changes the frame time by
  // up to a third, so a picture sharpened from just under FAST lands at or
  // under SLOW and stays put, where a narrower gap would send it straight back.
  /** Longer than this on average and the picture is trimmed (40 fps). */
  const SLOW_MS = 25
  /** Shorter than this and there may be room to sharpen (about 53 fps). */
  const FAST_MS = 19
  let step = 0
  let avg = 16.7
  let settle = 1.5
  let fastFor = 0
  let slowFor = 0
  /** Seconds of short frames wanted before trying a sharper picture. */
  let upWait = 4
  /** Seconds since the last step up, while it is still on trial; -1 otherwise. */
  let trial = -1
  let enabled = opts.enabled ?? true

  function set(next: number) {
    step = Math.max(0, Math.min(STEPS.length - 1, next))
    apply(STEPS[step])
    settle = 0.7
    fastFor = 0
    slowFor = 0
  }

  /** `dt` is the real time since the last frame, in seconds. */
  function update(dt: number) {
    if (!enabled || document.hidden) return
    // A stall (tab switch, a shader compiling) says nothing about the steady rate
    if (dt > 0.25) {
      settle = Math.max(settle, 0.5)
      return
    }
    if (trial >= 0) {
      trial += dt
      // It held: the next try can come as quickly as the first did
      if (trial > 10) {
        trial = -1
        upWait = 4
      }
    }
    if (settle > 0) {
      settle -= dt
      // Start the average from scratch at the new size
      avg = dt * 1000
      return
    }
    // One long frame (a new stretch of coast loading in) is not the steady
    // rate. Each frame may pull the average up only so far, so a lone hitch
    // barely moves it while a real slowdown still gets there in a few frames.
    const sample = Math.min(dt * 1000, avg * 1.4 + 4)
    avg += (sample - avg) * Math.min(1, dt * 4)
    if (avg > SLOW_MS) {
      slowFor += dt
      fastFor = 0
      if (slowFor > 0.8 && step < STEPS.length - 1) {
        // On a screen locked to its refresh rate there is no telling how much
        // room is left without trying. A try that fails waits twice as long
        // before the next, so the picture settles instead of pumping.
        if (trial >= 0) {
          upWait = Math.min(60, upWait * 2)
          trial = -1
        }
        // Far over the mark, one step will not be enough: take two
        set(step + (avg > SLOW_MS * 1.7 ? 2 : 1))
      }
    } else if (avg < FAST_MS) {
      fastFor += dt
      slowFor = 0
      // Frames far shorter than the target are room that can be seen, not guessed
      const wait = avg < 12 ? Math.min(upWait, 1.5) : upWait
      if (fastFor > wait && step > 0) {
        trial = 0
        set(step - 1)
      }
    } else {
      // In between is where it should sit. Time already banked toward a
      // sharper picture drains slowly, so hovering at the mark still gets there.
      fastFor = Math.max(0, fastFor - dt * 0.5)
      slowFor = 0
    }
  }

  return {
    update,
    get scale() {
      return STEPS[step]
    },
    get frameMs() {
      return avg
    },
    setEnabled(on: boolean) {
      enabled = on
      if (!on) set(0)
    },
  }
}
