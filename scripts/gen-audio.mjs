/**
 * Generate looping ocean ambience with ElevenLabs Sound Effects.
 *
 * Reads ELEVENLABS_API_KEY from the environment, or from the Respect project
 * .env (same business key Justin already pays for). Usage:
 *
 *   node scripts/gen-audio.mjs
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'audio')
mkdirSync(outDir, { recursive: true })

function loadKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  const candidates = [
    join(root, '.env'),
    join(root, '.env.local'),
    join(root, '..', 'Respect', '.env'),
    join(root, '..', 'Respect', '.env.local'),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const match = readFileSync(path, 'utf8').match(/^\s*ELEVENLABS_API_KEY\s*=\s*(.+)\s*$/m)
    if (match) return match[1].trim().replace(/^["']|["']$/g, '')
  }
  return null
}

const CLIPS = [
  {
    file: 'surface.mp3',
    duration: 22,
    prompt:
      'Seamless looping open-ocean ambience from a first-person swimmer at the surface: close soft water lapping near the ears, rolling mid-distance swells, light wind over water, distant gentle wave wash. Natural, sparse, no music, no voices, no birds, no ships. Soft and continuous so it can loop forever.',
  },
  {
    file: 'underwater.mp3',
    duration: 22,
    prompt:
      'Seamless looping underwater ocean ambience from inside a swimmer\'s ears: deep muffled low-frequency water pressure rumble, soft distant swell filtered through water, occasional tiny bubble ticks, thick aquatic hush. No music, no voices, no sonar pings, no creatures. Dark, continuous, loopable.',
  },
  {
    file: 'bob.mp3',
    duration: 8,
    prompt:
      'Seamless looping soft close-mic water bobbing against the ears at the ocean surface: gentle rise and fall of water around the head, quiet wet lapping, intimate and subtle. No music, no voices. Designed to layer under louder ocean ambience.',
  },
  {
    file: 'splash.mp3',
    duration: 1.6,
    loop: false,
    prompt:
      'Single short soft splash as a swimmer\'s head dips through the ocean surface: wet plunge then brief bubble rush. Natural, not cinematic, no music, no voices.',
  },
]

async function generate({ file, duration, prompt, loop = true }) {
  const key = loadKey()
  if (!key) throw new Error('ELEVENLABS_API_KEY not found in env or Respect/.env')

  const url = new URL('https://api.elevenlabs.io/v1/sound-generation')
  url.searchParams.set('output_format', 'mp3_44100_128')

  process.stdout.write(`Generating ${file} (${duration}s${loop ? ', loop' : ''})… `)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: prompt,
      duration_seconds: duration,
      prompt_influence: 0.45,
      loop,
      model_id: 'eleven_text_to_sound_v2',
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${file}: ${res.status} ${body.slice(0, 400)}`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(join(outDir, file), buf)
  console.log(`${(buf.length / 1024).toFixed(0)} KB`)
}

for (const clip of CLIPS) {
  await generate(clip)
}
console.log('Done → public/audio/')
