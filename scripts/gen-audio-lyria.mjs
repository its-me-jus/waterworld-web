/**
 * Generate sparse ocean ambience beds with Google Lyria 3 Clip (30s loops).
 *
 * Reads GEMINI_API_KEY from the environment or a sibling project `.env*`.
 * ElevenLabs Sound Effects would be better for pure SFX, but the Respect key
 * lacks `sound_generation` — Lyria fills the musical/atmospheric bed instead.
 *
 *   node scripts/gen-audio-lyria.mjs
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GoogleGenAI } from '@google/genai'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'audio')
mkdirSync(outDir, { recursive: true })

function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return process.env.GOOGLE_GENERATIVE_AI_API_KEY

  const candidates = [
    join(root, '.env'),
    join(root, '.env.local'),
    join(root, '..', 'adaptory', '.env.local'),
    join(root, '..', 'AI-Finance', '.env'),
    join(root, '..', 'AI-Legal', '.env'),
    join(root, '..', 'unstaffed', '.env.local'),
    join(root, '..', 'myCroft', '.env.local'),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']) {
      const match = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)\\s*$`, 'm'))
      if (match) return match[1].trim().replace(/^["']|["']$/g, '')
    }
  }
  return null
}

const CLIPS = [
  {
    file: 'surface-bed.mp3',
    prompt:
      'Instrumental only, no vocals, no lyrics, no singing. A 30-second seamless ambient soundscape of being alone in the open ocean at the surface on a calm clear day: soft wind, distant rolling swell as low pads, sparse airy textures, gentle water-like white noise, very minimal and naturalistic. No melody, no drums, no guitars, no piano. Designed to loop under a swimming game.',
  },
  {
    file: 'underwater-bed.mp3',
    prompt:
      'Instrumental only, no vocals, no lyrics, no singing. A 30-second seamless deep underwater ambient drone: muffled low rumbles, dark aquatic pads, slow breathing pressure, soft filtered noise, sparse and vast. No melody, no drums, no bright instruments. Designed to loop under a swimming game when submerged.',
  },
]

async function generate(ai, { file, prompt }) {
  process.stdout.write(`Lyria → ${file}… `)
  const response = await ai.models.generateContent({
    model: 'lyria-3-clip-preview',
    contents: prompt,
  })

  const parts = response.candidates?.[0]?.content?.parts ?? []
  let saved = false
  for (const part of parts) {
    if (part.inlineData?.data) {
      const buffer = Buffer.from(part.inlineData.data, 'base64')
      writeFileSync(join(outDir, file), buffer)
      console.log(`${(buffer.length / 1024).toFixed(0)} KB`)
      saved = true
      break
    }
  }
  if (!saved) {
    const text = parts.map((p) => p.text).filter(Boolean).join(' ').slice(0, 300)
    throw new Error(`No audio in response for ${file}. ${text || JSON.stringify(response).slice(0, 300)}`)
  }
}

const key = loadKey()
if (!key) throw new Error('GEMINI_API_KEY not found (checked env + sibling project .env files)')

const ai = new GoogleGenAI({ apiKey: key })
for (const clip of CLIPS) {
  await generate(ai, clip)
}
console.log('Done → public/audio/')
