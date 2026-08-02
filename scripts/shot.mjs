// Dev-only smoke check: load the scene from a few vantage points, fail loudly on
// console or shader errors, and save screenshots to `shots/` for eyeballing.
// Needs `npm run dev` already running. Usage: npm run shot
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
// Vite moves to 5174+ when 5173 is already taken — SHOT_BASE follows it there
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'
const OUT = 'shots'
// iPhone-ish portrait — the tightest FOV we have to keep the hands inside
const PORTRAIT = { width: 430, height: 932 }
// `dive` holds Shift for N seconds (~4 m/s down) then releases and shoots
// immediately, since buoyancy starts floating the swimmer back up
const VIEWS = [
  { name: 'surface', url: 'http://localhost:5173/' },
  // The island sits ~1.2 km off the spawn heading's right shoulder. These check
  // that it reads as land at range, that the haze keeps a silhouette instead of
  // dissolving, and that its underwater shelf isn't hanging below the horizon.
  { name: 'island-far', url: 'http://localhost:5173/?yaw=-0.96&pitch=0.02' },
  { name: 'island-near', url: 'http://localhost:5173/?x=668&z=-463&yaw=-0.96&pitch=0.05' },
  { name: 'island-shore', url: 'http://localhost:5173/?x=717&z=-498&yaw=-0.96&pitch=0.02' },
  // Standing in the shallows of the landing cove, looking along the beach
  { name: 'island-land', url: 'http://localhost:5173/?x=770&z=-530&yaw=0.61&pitch=0.02' },
  // Ashore in walk mode — eye height, upright body, mid-stride arms and legs
  { name: 'beach-walk', url: 'http://localhost:5173/?x=775&z=-532&yaw=-1.02&pitch=0.05' },
  { name: 'beach-stride', url: 'http://localhost:5173/?x=775&z=-532&yaw=-1.02&pitch=-0.45', fwd: 1.6 },
  { name: 'beach-lookdown', url: 'http://localhost:5173/?x=775&z=-532&yaw=-1.02&pitch=-1.25' },
  // Looking inland from the cove up into the green
  { name: 'island-inland', url: 'http://localhost:5173/?x=800&z=-550&yaw=-0.6&pitch=0.12' },
  // Climate — storm locked, night locked, shore foam up close
  { name: 'storm', url: 'http://localhost:5173/?storm=1&hour=14&yaw=-0.3&pitch=0.05' },
  { name: 'dusk', url: 'http://localhost:5173/?hour=17.6&yaw=-0.96&pitch=0.02' },
  { name: 'night', url: 'http://localhost:5173/?hour=22&yaw=-0.4&pitch=0.05' },
  { name: 'night-dive', url: 'http://localhost:5173/?hour=22&pitch=-0.15', dive: 2.4 },
  { name: 'shore-foam', url: 'http://localhost:5173/?x=755&z=-520&yaw=-0.4&pitch=-0.2' },
  // Floating within arm's reach of the wreck's first plank — the action prompt
  { name: 'prompt', url: 'http://localhost:5173/?x=-32.5&z=-96.4&yaw=0&pitch=-0.35' },
  { name: 'jelly', url: 'http://localhost:5173/?pitch=-0.05', dive: 2.2 },
  { name: 'wreck-surface', url: 'http://localhost:5173/?x=-24&z=-88&yaw=0.4&pitch=0.05' },
  { name: 'reef-top', url: 'http://localhost:5173/?x=-30&z=-98&yaw=1.1&pitch=-0.5', dive: 1.6 },
  { name: 'wreck-under', url: 'http://localhost:5173/?x=-30&z=-97&yaw=0.95&pitch=-0.25', dive: 3.6 },
  { name: 'wreck-deep', url: 'http://localhost:5173/?x=-31&z=-94&yaw=0.95&pitch=-0.1', dive: 6 },
  { name: 'seabed', url: 'http://localhost:5173/?x=-30&z=-118&yaw=1.9&pitch=-0.15', dive: 9 },
  // `zoom` renders at 3x and crops, which is the only way to inspect small
  // detail given the FOV is locked wide for phones
  {
    name: 'jelly-closeup',
    url: 'http://localhost:5173/?pitch=-0.1',
    dive: 2.6,
    zoom: { x: 340, y: 100, width: 600, height: 400 },
  },
  {
    name: 'hand-closeup',
    url: 'http://localhost:5173/',
    zoom: { x: 640, y: 380, width: 560, height: 380 },
  },
  // Looking straight down: chest, belt, legs — the "is this a body" check
  { name: 'body-lookdown', url: 'http://localhost:5173/?pitch=-1.3' },
  // Mid front-crawl: two different waits catch different stroke phases.
  // W stays held through the screenshot so effort doesn't decay
  { name: 'crawl-a', url: 'http://localhost:5173/?pitch=-0.4', fwd: 2.2 },
  { name: 'crawl-b', url: 'http://localhost:5173/?pitch=-0.4', fwd: 2.9 },
  // Descending breaststroke — arms and whip kick should read as a pair
  { name: 'breast-under', url: 'http://localhost:5173/?pitch=-0.35', dive: 2.4, fwd: 2.4 },
  {
    name: 'hand-crawl-closeup',
    url: 'http://localhost:5173/?pitch=-0.4',
    fwd: 2.5,
    zoom: { x: 640, y: 380, width: 560, height: 380 },
  },
  // Idle float — arms should stay tucked by the sides, out of frame
  {
    name: 'idle-hands',
    url: 'http://localhost:5173/?pitch=-0.2',
    zoom: { x: 320, y: 340, width: 640, height: 380 },
  },
  // Pure vertical movement — no planar input, so arms stay out of sight
  { name: 'dive-straight', url: 'http://localhost:5173/?pitch=-0.3', dive: 2.2 },
  { name: 'rise-straight', url: 'http://localhost:5173/?depth=6&pitch=0.3', rise: 2.2 },
  // Portrait phones: narrow horizontal FOV, hands crop easily
  { name: 'idle-portrait', url: 'http://localhost:5173/?pitch=-0.2', viewport: PORTRAIT },
  { name: 'crawl-portrait', url: 'http://localhost:5173/?pitch=-0.35', fwd: 2.4, viewport: PORTRAIT },
  { name: 'body-portrait', url: 'http://localhost:5173/?pitch=-1.3', viewport: PORTRAIT },
]

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})

// SHOT_ONLY=island re-shoots matching views; comma-separated for several
const only = process.env.SHOT_ONLY?.split(',').map((s) => s.trim()).filter(Boolean)

let bad = 0
for (const { name, url, dive = 0, fwd = 0, rise = 0, zoom, viewport } of VIEWS) {
  if (only && !only.some((key) => name.includes(key))) continue
  const page = await browser.newPage({
    viewport: viewport ?? { width: 1280, height: 720 },
    deviceScaleFactor: zoom ? 3 : 1,
  })
  // Benign: three's Clock nag, and headless Chrome has no user gesture for audio
  const noise = /THREE.Clock: This module has been deprecated|AudioContext was not allowed to start/
  page.on('console', (m) => {
    const text = m.text()
    if (noise.test(text)) return
    if (m.type() === 'error' || m.type() === 'warning') {
      bad++
      console.log(`[${name}] ${m.type()}: ${text}`)
    }
  })
  page.on('pageerror', (e) => {
    bad++
    console.log(`[${name}] pageerror: ${e.message}`)
  })

  await page.goto(url.replace('http://localhost:5173', BASE), { waitUntil: 'load' })
  await page.waitForTimeout(2500)
  if (fwd > 0) await page.keyboard.down('KeyW')
  if (dive > 0) await page.keyboard.down('Shift')
  if (rise > 0) await page.keyboard.down('Space')
  const wait = Math.max(dive, fwd, rise)
  if (wait > 0) await page.waitForTimeout(wait * 1000)
  if (dive > 0) await page.keyboard.up('Shift')
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: zoom })
  if (fwd > 0) await page.keyboard.up('KeyW')
  if (rise > 0) await page.keyboard.up('Space')
  console.log(`[${name}] captured`)
  await page.close()
}

await browser.close()
console.log(bad === 0 ? 'CLEAN: no errors or warnings' : `${bad} console problem(s)`)
