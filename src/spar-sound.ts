import type { Camera, Group } from 'three'

type WorldOutput = { ctx: BaseAudioContext; bus: AudioNode }

// A short woody attack as the link catches the barrel, with two inharmonic
// iron partials and a much softer second contact as the next link settles.
function makeLinkKnock(ctx: BaseAudioContext) {
  const rate = 24000
  const buffer = ctx.createBuffer(1, Math.ceil(0.2 * rate), rate)
  const samples = buffer.getChannelData(0)
  for (const [offset, weight] of [[0, 1], [0.037, 0.27]]) {
    const start = Math.round(offset * rate)
    for (let i = start; i < samples.length; i++) {
      const t = (i - start) / rate
      const phase = 2 * Math.PI * t
      const body = 0.46 * Math.sin(phase * 264) * Math.exp(-t * 96)
      const iron = 0.44 * Math.sin(phase * 1183) * Math.exp(-t * 59)
        + 0.21 * Math.sin(phase * 1871) * Math.exp(-t * 88)
      samples[i] += weight * Math.min(1, t / 0.0009) * (body + iron)
    }
  }
  return buffer
}

/** The loose mooring catches as the attachment side crests a sufficiently long roll. */
export function createSparSound(spar: Group, output: () => WorldOutput | null) {
  const radius = 18
  let previousRoll = NaN
  let trough = 0
  let rising = false
  let lastKnock = -Infinity
  let sample: AudioBuffer | undefined
  return {
    update(time: number, camera: Camera, submersion: number) {
      const dx = spar.position.x - camera.position.x
      const dy = spar.position.y - 0.3 - camera.position.y
      const dz = spar.position.z - camera.position.z
      const distSq = dx * dx + dy * dy + dz * dz
      if (distSq >= radius * radius || document.hidden) {
        previousRoll = NaN
        return
      }

      // The chain fastens at local (+0.53, -0.30, -0.09). Most of the
      // rise at its side comes from roll about Z, a little from pitch about X.
      const roll = spar.rotation.z + 0.17 * spar.rotation.x
      if (!Number.isFinite(previousRoll)) {
        previousRoll = trough = roll
        rising = false
        return
      }
      const nowRising = roll > previousRoll
      if (nowRising && !rising) trough = previousRoll
      const throwAngle = previousRoll - trough
      const caught = rising && !nowRising && throwAngle > 0.14
      rising = nowRising
      previousRoll = roll
      if (!caught || time - lastKnock < 5) return

      const out = output()
      if (!out || out.ctx.state !== 'running') return
      lastKnock = time
      const { ctx, bus } = out
      const distance = Math.sqrt(distSq)
      const reach = Math.min(1, (radius - distance) / (radius - 2))
      const force = Math.min(1, throwAngle / 0.32)
      const level = (0.065 + 0.055 * force) * reach * reach * (1 - 0.74 * submersion)
      // Project onto camera-right at the instant of impact, independent of
      // whether the islanders' AudioListener updates have been enabled.
      const { x, y, z, w } = camera.quaternion
      const side = dx * (1 - 2 * (y * y + z * z)) + dy * 2 * (x * y + z * w) + dz * 2 * (x * z - y * w)
      const pan = ctx.createStereoPanner()
      pan.pan.value = Math.max(-1, Math.min(1, side / Math.max(1, distance)))
      const gain = ctx.createGain()
      gain.gain.value = level
      const strike = ctx.createBufferSource()
      strike.buffer = sample ??= makeLinkKnock(ctx)
      strike.playbackRate.value = 0.89 + Math.random() * 0.18
      strike.connect(gain).connect(pan).connect(bus)
      strike.onended = () => {
        strike.disconnect()
        gain.disconnect()
        pan.disconnect()
      }
      strike.start()
    },
  }
}
