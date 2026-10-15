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
  // Round-3 close looks: blossoms on the cove shrubs, and the same hillside
  // from out in the shallows, where colour variety across the crowns shows
  { name: 'bloom-cove', url: 'http://localhost:5173/?x=805&z=-552&yaw=-2.3&pitch=0.0' },
  { name: 'bloom-cove-b', url: 'http://localhost:5173/?x=757&z=-583&yaw=-0.64&pitch=0.0' },
  { name: 'foam-zoom', url: 'http://localhost:5173/?x=755&z=-520&yaw=-0.4&pitch=-0.2', zoom: { x: 200, y: 320, width: 480, height: 240 } },
  { name: 'shallows-look', url: 'http://localhost:5173/?x=770&z=-530&yaw=0.61&pitch=-0.55' },
  { name: 'shallows-look-b', url: 'http://localhost:5173/?x=765&z=-526&yaw=1.6&pitch=-0.5' },
  { name: 'canopy-up', url: 'http://localhost:5173/?x=790&z=-545&yaw=-0.9&pitch=0.35' },
  // Low sun dead ahead. Its azimuth is 95 + 170 * hour/24 degrees, so at 16.9 h
  // yaw 0.6 faces it: through the cove palms, and over open water
  { name: 'sun-trees', url: 'http://localhost:5173/?x=770&z=-530&yaw=0.6&pitch=0.02&hour=16.9' },
  { name: 'sun-low', url: 'http://localhost:5173/?hour=17.5&yaw=0.68&pitch=0.1' },
  { name: 'crowns-far', url: 'http://localhost:5173/?x=690&z=-478&yaw=-1.0&pitch=0.12' },
  // Round-4 jungle: under the closed forest roof, and back out at the cove
  // looking up at where the roof starts
  { name: 'jungle-in', url: 'http://localhost:5173/?x=860&z=-600&yaw=-0.6&pitch=0.1' },
  // Drone views of the whole island (?fly lifts the eye, dev only): the
  // approach side from high and off-axis, and the far side
  { name: 'aerial-approach', url: 'http://localhost:5173/?x=560&z=-380&yaw=-0.96&pitch=-0.32&fly=170' },
  { name: 'aerial-side', url: 'http://localhost:5173/?x=1080&z=-170&yaw=0.2&pitch=-0.3&fly=150' },
  { name: 'aerial-far', url: 'http://localhost:5173/?x=1420&z=-900&yaw=2.0&pitch=-0.28&fly=140' },
  // Sea-level circuit of the coast: bays, headlands, the spire from each side
  { name: 'coast-e', url: 'http://localhost:5173/?x=1410&z=-640&yaw=1.48&pitch=0.08' },
  { name: 'coast-n', url: 'http://localhost:5173/?x=1040&z=-1110&yaw=3.0&pitch=0.08' },
  { name: 'coast-s', url: 'http://localhost:5173/?x=1080&z=-260&yaw=0.23&pitch=0.08' },
  // Rock round: the spire from a drone close in, four headlands from just
  // off the reef (ridge ends, from the scan of the valley field), and the strand where the
  // landing beach meets the grass
  { name: 'spire-air', url: 'http://localhost:5173/?x=1180&z=-480&yaw=0.65&pitch=-0.12&fly=90' },
  { name: 'spire-zoom', url: 'http://localhost:5173/?x=1180&z=-480&yaw=0.65&pitch=-0.12&fly=90', zoom: { x: 380, y: 60, width: 420, height: 300 } },
  { name: 'cliff-zoom', url: 'http://localhost:5173/?x=1180&z=-480&yaw=0.65&pitch=-0.12&fly=90', zoom: { x: 0, y: 440, width: 420, height: 280 } },
  // Canopy round: a drone low over the roof, where emergents and valley palms stand clear
  { name: 'canopy-air', url: 'http://localhost:5173/?x=1130&z=-560&yaw=0.95&pitch=-0.22&fly=45' },
  { name: 'canopy-air-b', url: 'http://localhost:5173/?x=900&z=-840&yaw=-0.4&pitch=-0.2&fly=40' },
  { name: 'valley-palms', url: 'http://localhost:5173/?x=950&z=-600&yaw=1.03&pitch=-0.05&fly=22' },
  // Close to the wall (drone 70 m up, 90 m off, looking up): the rock's own
  // colour with little haze in front of it
  { name: 'spire-close', url: 'http://localhost:5173/?x=1075&z=-650&yaw=0.88&pitch=0.42&fly=70' },
  { name: 'spire-close-b', url: 'http://localhost:5173/?x=1090&z=-760&yaw=-1.15&pitch=0.35&fly=60' },
  { name: 'headland-a', url: 'http://localhost:5173/?x=606&z=-746&yaw=-1.75&pitch=0.04' },
  { name: 'headland-b', url: 'http://localhost:5173/?x=1175&z=-1018&yaw=2.62&pitch=0.04' },
  { name: 'headland-c', url: 'http://localhost:5173/?x=1170&z=-351&yaw=0.52&pitch=0.04' },
  { name: 'headland-d', url: 'http://localhost:5173/?x=1294&z=-944&yaw=2.28&pitch=0.04' },
  { name: 'strand-look', url: 'http://localhost:5173/?x=765&z=-526&yaw=-0.2&pitch=-0.3' },
  // Lagoon round: floating in it, outside the reef looking along the crest,
  // and under it at the crest
  { name: 'lagoon-in', url: 'http://localhost:5173/?x=804&z=-437&yaw=-0.63&pitch=0.0' },
  { name: 'reef-out', url: 'http://localhost:5173/?x=805&z=-298&yaw=-0.43&pitch=-0.05' },
  { name: 'reef-under', url: 'http://localhost:5173/?x=832&z=-356&yaw=-0.43&pitch=0.05&depth=4' },
  // On the crest looking out over the reef's outer face into the deep
  { name: 'reef-wall', url: 'http://localhost:5173/?x=839&z=-373&yaw=2.71&pitch=-0.3', dive: 0.9 },
  { name: 'jungle-edge', url: 'http://localhost:5173/?x=780&z=-536&yaw=-0.75&pitch=0.18' },
  // Climate — storm locked, night locked, shore foam up close
  { name: 'storm', url: 'http://localhost:5173/?storm=1&hour=14&yaw=-0.3&pitch=0.05' },
  { name: 'dusk', url: 'http://localhost:5173/?hour=17.6&yaw=-0.96&pitch=0.02' },
  { name: 'night', url: 'http://localhost:5173/?hour=22&yaw=-0.4&pitch=0.05' },
  { name: 'night-dive', url: 'http://localhost:5173/?hour=22&pitch=-0.15', dive: 2.4 },
  { name: 'shore-foam', url: 'http://localhost:5173/?x=755&z=-520&yaw=-0.4&pitch=-0.2' },
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
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: zoom, timeout: 150000 })
  if (fwd > 0) await page.keyboard.up('KeyW')
  if (rise > 0) await page.keyboard.up('Space')
  console.log(`[${name}] captured`)
  await page.close()
}

await browser.close()
console.log(bad === 0 ? 'CLEAN: no errors or warnings' : `${bad} console problem(s)`)
