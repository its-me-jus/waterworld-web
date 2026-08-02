// Visual-review pass: a fixed set of vantage points that between them cover
// every lighting path the renderer has — beach, canopy, ridge, open water,
// dusk, night, storm, underwater. Saves to `shots/look/` so a before/after
// can be eyeballed side by side. Needs `npm run dev` running.
// Usage: npm run shot:look   ·   LOOK_ONLY=canopy,dusk npm run shot:look
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable'
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'
const OUT = process.env.LOOK_OUT ?? 'shots/look'

// Landscape phone — the aspect most of the game is actually played at
const WIDE = { width: 1280, height: 600 }

const VIEWS = [
  // —— the island, which is where the eye spends the most time ——
  { name: 'cove-arrival', q: '?x=770&z=-530&yaw=0.61&pitch=0.02' },
  { name: 'canopy', q: '?x=830&z=-560&yaw=-0.6&pitch=0.12' },
  { name: 'canopy-up', q: '?x=830&z=-560&yaw=-0.6&pitch=0.42' },
  { name: 'beach-down', q: '?x=775&z=-532&yaw=-1.02&pitch=-0.55' },
  { name: 'ridge', q: '?x=905&z=-620&yaw=-2.1&pitch=0.05' },
  { name: 'island-far', q: '?yaw=-0.96&pitch=0.02' },
  { name: 'island-near', q: '?x=668&z=-463&yaw=-0.96&pitch=0.05' },
  // —— light through the day ——
  { name: 'dawn', q: '?x=830&z=-560&yaw=-0.6&pitch=0.1&hour=6.4' },
  { name: 'dusk', q: '?x=830&z=-560&yaw=-0.6&pitch=0.1&hour=17.8' },
  { name: 'night', q: '?x=830&z=-560&yaw=-0.6&pitch=0.1&hour=22' },
  { name: 'storm', q: '?x=790&z=-540&yaw=-0.6&pitch=0.08&storm=1&hour=14' },
  // —— open water and below it ——
  { name: 'ocean', q: '?yaw=-0.3&pitch=0.03' },
  { name: 'wreck', q: '?x=-24&z=-88&yaw=0.4&pitch=0.05' },
  { name: 'under', q: '?x=-30&z=-97&yaw=0.95&pitch=-0.25', dive: 3.6 },
]

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})

const only = process.env.LOOK_ONLY?.split(',').map((s) => s.trim()).filter(Boolean)

let bad = 0
for (const { name, q, dive = 0, fwd = 0 } of VIEWS) {
  if (only && !only.some((key) => name.includes(key))) continue
  const page = await browser.newPage({ viewport: WIDE })
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

  await page.goto(`${BASE}/${q}`, { waitUntil: 'load' })
  await page.waitForTimeout(3200)
  if (fwd > 0) await page.keyboard.down('KeyW')
  if (dive > 0) await page.keyboard.down('Shift')
  const wait = Math.max(dive, fwd)
  if (wait > 0) await page.waitForTimeout(wait * 1000)
  if (dive > 0) await page.keyboard.up('Shift')
  await page.screenshot({ path: `${OUT}/${name}.png` })
  if (fwd > 0) await page.keyboard.up('KeyW')
  console.log(`[${name}] captured`)
  await page.close()
}

await browser.close()
console.log(bad === 0 ? 'CLEAN: no errors or warnings' : `${bad} console problem(s)`)
