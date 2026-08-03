/**
 * Generate looping ambience + one-shots with ElevenLabs Sound Effects.
 *
 * Reads ELEVENLABS_API_KEY from the environment, or from a sibling project
 * .env (same business key Justin already pays for). Usage:
 *
 *   npm run audio
 *   npm run audio -- --only rain,thunder,foot-sand
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
    file: 'rain.mp3',
    duration: 16,
    prompt:
      'Seamless looping moderate rain on open ocean and sparse palm fronds: steady precipitation, soft hiss, occasional heavier drops, no thunder, no music, no voices. Natural, continuous, designed to layer under a storm ambience bed.',
  },
  {
    file: 'wind.mp3',
    duration: 16,
    prompt:
      'Seamless looping strong coastal wind over open water in a squall: rushing air, soft howl through nothing, no music, no voices, no birds. Continuous and loopable under a survival game storm.',
  },
  {
    file: 'shore-lap.mp3',
    duration: 12,
    prompt:
      'Seamless looping close-mic gentle waves lapping a sandy beach waterline: soft foam wash, intimate wet lap against sand, sparse and natural. No music, no voices, no seagulls. Designed to loop at the shoreline.',
  },
  {
    file: 'heavy-surf.mp3',
    duration: 16,
    prompt:
      'Seamless looping rough open-ocean surface with whitecaps: heavier swell wash, wind-chopped water, mid-distance wave crash texture. Natural, no music, no voices. Loopable stormy surface bed.',
  },
  {
    file: 'thunder.mp3',
    duration: 2.8,
    loop: false,
    prompt:
      'Single distant-to-mid thunder clap over the ocean: low rumble boom with a soft crackling tail, natural and not cinematic trailer thunder. No rain bed, no music, no voices.',
  },
  {
    file: 'foot-sand.mp3',
    duration: 0.5,
    loop: false,
    prompt:
      'Single soft barefoot step on dry beach sand: quiet grit crunch, short and natural, silence after the hit. No music, no voices.',
  },
  {
    file: 'foot-rock.mp3',
    duration: 0.5,
    loop: false,
    prompt:
      'Single barefoot step on wet volcanic rock: short hard contact with light scrape, silence after. Natural, no music, no voices.',
  },
  {
    file: 'foot-wood.mp3',
    duration: 0.5,
    loop: false,
    prompt:
      'Single barefoot step on weathered wooden planks of a raft: short hollow wood thump, silence after. Natural, no music, no voices.',
  },
  {
    file: 'lash.mp3',
    duration: 0.7,
    loop: false,
    prompt:
      'Short rope lashing foley: cord pulled tight around wood, soft creak and friction. Natural, no music, no voices.',
  },
  {
    file: 'wood-knock.mp3',
    duration: 0.55,
    loop: false,
    prompt:
      'Short wooden knock of a plank or crate being hauled: dull hollow wood contact. Natural, no music, no voices.',
  },
  {
    file: 'splash.mp3',
    duration: 1.6,
    loop: false,
    prompt:
      'Single short soft splash as a swimmer\'s head dips through the ocean surface: wet plunge then brief bubble rush. Natural, not cinematic, no music, no voices.',
  },
  {
    file: 'enter-water.mp3',
    duration: 1.8,
    loop: false,
    prompt:
      'First-person body entering ocean from a beach: heavy wet splash as legs then torso hit the water, shove of displaced water, brief bubble rush near the ears. Intimate, natural, not cinematic trailer splash. No music, no voices, no birds.',
  },
  {
    file: 'exit-water.mp3',
    duration: 0.9,
    loop: false,
    prompt:
      'Very short natural foley only: water dripping off a wet body onto sand as someone steps out of the ocean. Soft wet drips and a tiny splash, then silence. No tones, no synth, no sci-fi, no music, no voices, no birds, no continuous drone.',
  },
  {
    file: 'dive.mp3',
    duration: 1.4,
    loop: false,
    prompt:
      'First-person head diving under the ocean surface: muffled plunge, ear pressure whoomp, close bubble rush filling the ears. Thick aquatic, intimate. No music, no voices, no sonar.',
  },
  {
    file: 'breach.mp3',
    duration: 1.5,
    loop: false,
    prompt:
      'First-person swimmer bursting back through the ocean surface into air: bright wet splash, brief air gasp texture, water shedding off the face and ears. Natural, intimate. No music, no voices.',
  },
  {
    file: 'sail-flap.mp3',
    duration: 1.2,
    loop: false,
    prompt:
      'Short canvas sail flap in wind: fabric snap and soft flutter. Natural, no music, no voices.',
  },
  {
    file: 'bush-rustle.mp3',
    duration: 0.55,
    loop: false,
    prompt:
      'Short dry scrub and grass rustle as bare legs brush through coastal bushes and ferns: leafy scrape, soft plant noise, natural and brief. No music, no voices, no birds, no footsteps.',
  },
]

const onlyArg = process.argv.find((a) => a.startsWith('--only'))
const onlyList = onlyArg
  ? (onlyArg.split('=')[1] || process.argv[process.argv.indexOf(onlyArg) + 1] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : null

async function generate({ file, duration, prompt, loop = true }, attempt = 1) {
  const key = loadKey()
  if (!key) throw new Error('ELEVENLABS_API_KEY not found in env or Respect/.env')

  const url = new URL('https://api.elevenlabs.io/v1/sound-generation')
  url.searchParams.set('output_format', 'mp3_44100_128')
  const secs = Math.min(30, Math.max(0.5, duration))

  process.stdout.write(
    `Generating ${file} (${secs}s${loop ? ', loop' : ''}${attempt > 1 ? `, try ${attempt}` : ''})… `,
  )
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: prompt,
      duration_seconds: secs,
      prompt_influence: 0.45,
      loop,
      model_id: 'eleven_text_to_sound_v2',
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    if ((res.status === 429 || res.status === 503) && attempt < 6) {
      const wait = Math.min(60, 4 * attempt * attempt)
      console.log(`busy, wait ${wait}s`)
      await new Promise((r) => setTimeout(r, wait * 1000))
      return generate({ file, duration, prompt, loop }, attempt + 1)
    }
    throw new Error(`${file}: ${res.status} ${body.slice(0, 400)}`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(join(outDir, file), buf)
  console.log(`${(buf.length / 1024).toFixed(0)} KB`)
}

const queue = onlyList
  ? CLIPS.filter((c) => onlyList.some((name) => c.file === name || c.file.startsWith(name)))
  : CLIPS

if (queue.length === 0) {
  console.error('No clips matched --only filter')
  process.exit(1)
}

for (const clip of queue) {
  const out = join(outDir, clip.file)
  if (existsSync(out) && !process.argv.includes('--force')) {
    console.log(`skip ${clip.file} (exists; pass --force to redo)`)
    continue
  }
  await generate(clip)
}
console.log('Done → public/audio/')
