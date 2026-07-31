// Dev-only smoke check: load the scene from a few vantage points, fail loudly on
// console or shader errors, and save screenshots to `shots/` for eyeballing.
// Needs `npm run dev` already running. Usage: npm run shot
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const OUT = 'shots'
// iPhone-ish portrait — the tightest FOV we have to keep the hands inside
const PORTRAIT = { width: 430, height: 932 }
// `dive` holds Shift for N seconds (~4 m/s down) then releases and shoots
// immediately, since buoyancy starts floating the swimmer back up
const VIEWS = [
  { name: 'surface', url: 'http://localhost:5173/' },
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
  // Hands only show while swimming — hold W so effort doesn't decay
  {
    name: 'hand-closeup',
    url: 'http://localhost:5173/',
    fwd: 2.2,
    zoom: { x: 560, y: 340, width: 500, height: 330 },
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
  // Idle rest: arms hang by the sides — should be out of the forward view
  {
    name: 'idle-clear',
    url: 'http://localhost:5173/?pitch=-0.2',
    zoom: { x: 320, y: 340, width: 640, height: 380 },
  },
  // Portrait phones: narrow horizontal FOV — rest pose must stay clear of frame
  { name: 'idle-portrait', url: 'http://localhost:5173/?pitch=-0.2', viewport: PORTRAIT },
  { name: 'crawl-portrait', url: 'http://localhost:5173/?pitch=-0.35', fwd: 2.4, viewport: PORTRAIT },
  { name: 'body-portrait', url: 'http://localhost:5173/?pitch=-1.3', viewport: PORTRAIT },
]

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})

let bad = 0
for (const { name, url, dive = 0, fwd = 0, zoom, viewport } of VIEWS) {
  const page = await browser.newPage({
    viewport: viewport ?? { width: 1280, height: 720 },
    deviceScaleFactor: zoom ? 3 : 1,
  })
  const noise = /deprecated/
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

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(2500)
  if (fwd > 0) await page.keyboard.down('KeyW')
  if (dive > 0) await page.keyboard.down('Shift')
  const wait = Math.max(dive, fwd)
  if (wait > 0) await page.waitForTimeout(wait * 1000)
  if (dive > 0) await page.keyboard.up('Shift')
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: zoom })
  if (fwd > 0) await page.keyboard.up('KeyW')
  console.log(`[${name}] captured`)
  await page.close()
}

await browser.close()
console.log(bad === 0 ? 'CLEAN: no errors or warnings' : `${bad} console problem(s)`)
