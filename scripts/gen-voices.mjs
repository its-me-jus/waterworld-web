/**
 * Generate the islanders' short wordless vocalisations with ElevenLabs Sound
 * Effects (same endpoint and key lookup as gen-audio.mjs). Takes land in
 * shots/sound/takes/ (git-ignored); the chosen ones are trimmed into
 * public/audio/voices/ by hand (see src/tribe/tribe-sound.ts).
 *
 *   node scripts/gen-voices.mjs                 every cue not yet taken
 *   node scripts/gen-voices.mjs --only oru-hm   one cue
 *
 * Hard budget: never more than MAX_TAKES files in the takes folder, whatever
 * the arguments. Existing takes are kept and skipped.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'shots', 'sound', 'takes')
mkdirSync(outDir, { recursive: true })
const MAX_TAKES = 30

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

const DRY = 'Dry close-mic recording, no reverb, no words, no music, no background noise, silence after.'

/** Short nonverbal human sounds only: breath, hums, a soft laugh. No language, no chanting, no cries. */
const CUES = [
  {
    name: 'oru-hm',
    takes: 3,
    duration: 1.0,
    prompt: `A single quiet, low, thoughtful "hm" from an elderly man, a closed-mouth hum through the nose, calm and attentive, as if he has just looked up from his work. ${DRY}`,
  },
  {
    name: 'oru-chuckle',
    takes: 3,
    duration: 1.5,
    prompt: `An elderly man's soft, warm, amused chuckle: a quiet breathy laugh through the nose, gentle and kind, not mocking, one short laugh. ${DRY}`,
  },
  {
    name: 'tala-breath',
    takes: 3,
    duration: 0.8,
    prompt: `A young woman's quick, quiet, surprised intake of breath, the small gasp of noticing something unexpected. Breath only, no voice. ${DRY}`,
  },
  {
    name: 'tala-eh',
    takes: 3,
    duration: 0.8,
    prompt: `A young woman's soft, curious, questioning "eh?": one short rising breathy vowel, gentle and quiet, not a word. ${DRY}`,
  },
  {
    name: 'tala-call',
    takes: 3,
    duration: 1.2,
    prompt: `A young woman's short, light, hummed two-note call "mm-mm?" to get someone's attention across a clearing: closed mouth, rising at the end, gentle, no words. ${DRY}`,
  },
  {
    name: 'kael-exhale',
    takes: 3,
    duration: 0.7,
    prompt: `A strong young man's single sharp, forceful exhale through the nose, tense and alert, squaring up. Breath only, no voice. ${DRY}`,
  },
  {
    name: 'kael-breath',
    takes: 3,
    duration: 1.0,
    prompt: `A strong young man's low, slow, controlled warning breath out through the teeth, a quiet tense hiss. Breath only, no voice. ${DRY}`,
  },
  {
    name: 'oru-yes',
    takes: 2,
    duration: 1.0,
    prompt: `An elderly man's quiet, warm, approving "mm-hm": a closed-mouth hum of two soft notes, gentle and pleased. ${DRY}`,
  },
  {
    name: 'tala-laugh',
    takes: 2,
    duration: 1.0,
    prompt: `A young woman's short, soft, surprised little laugh through the nose, light and amused, not mocking, two or three breaths of it. ${DRY}`,
  },
  {
    name: 'kael-snort',
    takes: 2,
    duration: 0.7,
    prompt: `A strong young man's short, dismissive snort through the nose, a quick unimpressed huff. Breath only, no voice. ${DRY}`,
  },
  {
    name: 'kael-sigh',
    takes: 2,
    duration: 1.2,
    prompt: `A strong young man's slow, controlled breath out through the nose as he lowers his guard, a quiet low sigh. Breath only, no voice. ${DRY}`,
  },
]

const onlyArg = process.argv.find((a) => a.startsWith('--only'))
const onlyList = onlyArg
  ? (onlyArg.split('=')[1] || process.argv[process.argv.indexOf(onlyArg) + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)
  : null

const taken = () => readdirSync(outDir).filter((f) => f.endsWith('.mp3')).length
let generated = 0
let seconds = 0

async function generate(cue, file, attempt = 1) {
  const key = loadKey()
  if (!key) throw new Error('ELEVENLABS_API_KEY not found in env or a sibling .env')
  const url = new URL('https://api.elevenlabs.io/v1/sound-generation')
  url.searchParams.set('output_format', 'mp3_44100_128')
  const secs = Math.min(30, Math.max(0.5, cue.duration))
  process.stdout.write(`Generating ${file} (${secs}s${attempt > 1 ? `, try ${attempt}` : ''})… `)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: cue.prompt,
      duration_seconds: secs,
      prompt_influence: 0.6,
      loop: false,
      model_id: 'eleven_text_to_sound_v2',
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      const wait = Math.min(60, 4 * attempt * attempt)
      console.log(`busy, wait ${wait}s`)
      await new Promise((r) => setTimeout(r, wait * 1000))
      return generate(cue, file, attempt + 1)
    }
    throw new Error(`${file}: ${res.status} ${body.slice(0, 300)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(join(outDir, file), buf)
  generated++
  seconds += secs
  console.log(`${(buf.length / 1024).toFixed(0)} KB`)
}

const queue = onlyList ? CUES.filter((c) => onlyList.includes(c.name)) : CUES
for (const cue of queue) {
  for (let k = 1; k <= cue.takes; k++) {
    const file = `${cue.name}-${k}.mp3`
    if (existsSync(join(outDir, file))) {
      console.log(`skip ${file} (exists)`)
      continue
    }
    if (taken() >= MAX_TAKES) {
      console.log(`budget reached (${MAX_TAKES} takes); stopping`)
      process.exit(0)
    }
    await generate(cue, file)
  }
}
console.log(`Done: ${generated} generated this run, ${seconds.toFixed(1)} s requested; ${taken()} takes in shots/sound/takes/`)
