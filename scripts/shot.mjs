// Dev-only smoke check: load the scene from a few vantage points, fail loudly on
// console or shader errors, and save screenshots to `shots/` for eyeballing.
// Needs `npm run dev` already running. Usage: npm run shot
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const OUT = 'shots'
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
  {
    name: 'hand-closeup',
    url: 'http://localhost:5173/',
    zoom: { x: 560, y: 340, width: 500, height: 330 },
  },
]

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})

let bad = 0
for (const { name, url, dive = 0, zoom } of VIEWS) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: zoom ? 3 : 1,
  })
  const noise = /THREE.Clock: This module has been deprecated/
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
  if (dive > 0) {
    await page.keyboard.down('Shift')
    await page.waitForTimeout(dive * 1000)
    await page.keyboard.up('Shift')
  }
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: zoom })
  console.log(`[${name}] captured`)
  await page.close()
}

await browser.close()
console.log(bad === 0 ? 'CLEAN: no errors or warnings' : `${bad} console problem(s)`)
