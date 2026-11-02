/** Close, non-tonal movement foley. Small cached variation banks avoid decoding
 * or allocating a noise buffer on every step. All assets are generated locally. */
export type Contact = 'sand' | 'wet-sand' | 'rock' | 'scrub' | 'wade' | 'stroke' | 'pull'

export function crossedPhase(previous: number, current: number, at: number) {
  return current >= previous
    ? previous < at && current >= at
    : previous < at || current >= at
}

export function createMovementFoley(ctx: AudioContext, destination: AudioNode) {
  const banks = new Map<Contact, AudioBuffer[]>()
  const previous = new Map<Contact, number>()
  const kinds: Contact[] = ['sand', 'wet-sand', 'rock', 'scrub', 'wade', 'stroke', 'pull']
  for (const kind of kinds) {
    const water = kind === 'wade' || kind === 'stroke' || kind === 'pull'
    const duration = water ? 0.48 : kind === 'rock' ? 0.16 : 0.29
    const bank: AudioBuffer[] = []
    for (let variant = 0; variant < 6; variant++) {
      const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate)
      const data = buffer.getChannelData(0)
      let low = 0, mid = 0
      const wet = kind === 'wet-sand'
      const grit = kind === 'sand' ? 0.32 : kind === 'scrub' ? 0.42 : wet ? 0.09 : 0.13
      for (let n = 0; n < data.length; n++) {
        const t = n / ctx.sampleRate
        const white = Math.random() * 2 - 1
        low += (white - low) * (water ? 0.035 : 0.065)
        mid += (white - mid) * (water ? 0.23 : 0.42)
        // Soft compression then granular toe-release; no pitched kick-drum thud.
        const attack = 1 - Math.exp(-t / (water ? 0.018 : 0.004))
        const weight = Math.exp(-t / (water ? 0.11 : kind === 'rock' ? 0.026 : 0.045))
        const release = Math.exp(-(((t - (water ? 0.12 : 0.085)) / (water ? 0.11 : 0.055)) ** 2))
        const grains = 0.55 + 0.45 * Math.sin(t * (117 + variant * 17)) ** 2
        data[n] = attack * (low * weight * (water ? 1.9 : 1.2)
          + (mid - low) * release * grains * (water ? 0.65 : grit))
          * Math.min(1, (duration - t) / 0.025)
      }
      bank.push(buffer)
    }
    banks.set(kind, bank)
  }

  function play(kind: Contact, intensity: number, side: number, submersion = 0) {
    const bank = banks.get(kind)!
    // Never repeat a take back to back.
    const index = ((previous.get(kind) ?? 0) + 1 + Math.floor(Math.random() * (bank.length - 1))) % bank.length
    previous.set(kind, index)
    const source = ctx.createBufferSource()
    source.buffer = bank[index]
    source.playbackRate.value = 0.94 + Math.random() * 0.12
    const tone = ctx.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = kind === 'pull' ? 650 : 6500 - submersion * 5600
    tone.Q.value = 0.45
    const gain = ctx.createGain()
    gain.gain.value = intensity * (kind === 'stroke' ? 0.65 : kind === 'pull' ? 0.38 : 0.9)
    const pan = ctx.createStereoPanner()
    pan.pan.value = side * 0.28
    source.connect(tone).connect(gain).connect(pan).connect(destination)
    source.onended = () => { source.disconnect(); tone.disconnect(); gain.disconnect(); pan.disconnect() }
    source.start()
  }
  return { play }
}
