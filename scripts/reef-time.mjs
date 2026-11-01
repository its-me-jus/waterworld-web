// Dev-only: how long the wreck's reef rock takes to build at load, and its
// triangle count, on the desktop and the phone budget. Needs `npm run dev`
// running. Usage: node scripts/reef-time.mjs
import { chromium } from 'playwright-core'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
for (const low of [false, true]) {
  const page = await browser.newPage()
  if (low) {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 })
    })
  }
  page.on('console', (m) => {
    if (/reef rock/.test(m.text()) || m.type() === 'error') console.log(low ? 'phone' : 'desktop', m.text().slice(0, 300))
  })
  page.on('pageerror', (e) => console.log('pageerror', e.message))
  await page.goto(`${BASE}/?x=-22&z=-93&yaw=0.95&depth=15`, { waitUntil: 'load' })
  await page.waitForTimeout(6000)
  await page.close()
}
await browser.close()
