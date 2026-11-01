// Shoot the homepage film's key frames through ?film=1 and window.__film: no
// labels, the clock held, the camera placed from code. Needs `npm run dev`
// (or point SHOT_BASE at the live site). Usage:
//   node scripts/film-shot.mjs            all shots
//   FILM_ONLY=wreck,dusk node scripts/film-shot.mjs
// SHOT_LOW=1 fakes a 2-core device (the phone budget); SHOT_OUT picks the folder.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'
const OUT = process.env.SHOT_OUT ?? 'shots/film'

// [x, y, z, yaw, pitch]; y is height above mean sea level, or 'g+1.7' for
// that far above the ground. Yaw 0 faces -z.
const SHOTS = [
  // Falling toward the island from the open sea
  { name: 'drop', hour: 10.5, pose: [520, 230, -330, -0.96, -0.42] },
  // Swimming in toward the cove, eye just above the water
  { name: 'approach', hour: 11, pose: [690, 1.1, -478, -0.96, 0.02] },
  // Through the lagoon from above, the reef ring blending shallow to deep
  { name: 'lagoon-air', hour: 11, pose: [640, 70, -420, -0.9, -0.55] },
  // Ashore on the cove sand, the reef wreck offshore
  { name: 'landing', hour: 12, pose: [775, 'g+1.7', -532, 1.446, 0.02] },
  // The waterline at our feet: swash foam, the leafy dune scrub, palm bark
  { name: 'shore', hour: 12, pose: [768, 'g+1.6', -528, 0.9, -0.35] },
  { name: 'palms', hour: 15, pose: [790, 'g+1.6', -540, -2.0, 0.25] },
  // The Wanderer's reef from the sand: bow across the shoulder
  { name: 'wreck', hour: 12, pose: [-22, -15, -93, 0.95, -0.1] },
  { name: 'wreck-low', hour: 12, pose: [-27, -21, -92, 1.05, 0.12] },
  // The hull up close, and from the far side
  { name: 'hull-close', hour: 12, pose: [-33, -11, -96, 0.9, -0.25] },
  { name: 'hull-side', hour: 12, pose: [-46, -12, -86, -0.42, -0.2] },
  // Looking up at the surface from mid-water, toward the sun
  { name: 'surface-up', hour: 12, pose: [-30, -9, -96, 0.3, 0.55] },
  // Dusk off the island
  { name: 'dusk', hour: 17.6, pose: [690, 1.1, -478, -0.96, 0.03] },
  // The climb: high over the lagoon looking down
  { name: 'climb', hour: 17.6, pose: [760, 420, -560, -0.96, -1.1] },
  // Partway up the climb, level-ish, clouds sliding by
  { name: 'climb-mid', hour: 17.6, pose: [640, 240, -430, -0.96, -0.35] },
  { name: 'climb-noon', hour: 12, pose: [640, 260, -430, -0.96, -0.45] },
]

mkdirSync(OUT, { recursive: true })
const only = process.env.FILM_ONLY?.split(',').map((s) => s.trim()).filter(Boolean)
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const noise = /THREE.Clock: This module has been deprecated|AudioContext was not allowed to start|X4122/
let bad = 0
for (const shot of SHOTS) {
  if (only && !only.some((k) => shot.name.includes(k))) continue
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  if (process.env.SHOT_LOW) {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 })
    })
  }
  page.on('console', (m) => {
    if (noise.test(m.text())) return
    if (m.type() === 'error' || m.type() === 'warning') {
      bad++
      console.log(`[${shot.name}] ${m.type()}: ${m.text().slice(0, 300)}`)
    }
  })
  page.on('pageerror', (e) => {
    bad++
    console.log(`[${shot.name}] pageerror: ${e.message}`)
  })
  const [x, y, z, yaw, pitch] = shot.pose
  await page.goto(`${BASE}/?film=1&x=${x}&z=${z}&hour=${shot.hour}`, { waitUntil: 'load' })
  await page.waitForFunction(() => (window.__film?.frames ?? 0) > 2, null, { timeout: 150000 })
  await page.evaluate(
    ([h, x, y, z, yaw, pitch]) => {
      window.__film.hour(h)
      const height = typeof y === 'string' ? window.__film.ground(x, z) + Number(y.slice(2)) : y
      window.__film.camera(x, height, z, yaw, pitch)
    },
    [shot.hour, x, y, z, yaw, pitch],
  )
  // Let the env map, fog and fades settle on the new pose
  const start = await page.evaluate(() => window.__film.frames)
  await page.waitForFunction((n) => window.__film.frames > n + 40, start, { timeout: 150000 })
  await page.screenshot({ path: `${OUT}/${process.env.SHOT_LOW ? 'low-' : ''}${shot.name}.png`, timeout: 150000 })
  console.log(`[${shot.name}] captured`)
  await page.close()
}
await browser.close()
console.log(bad === 0 ? 'CLEAN' : `${bad} console problem(s)`)
