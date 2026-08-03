import { chromium } from 'playwright-core'

// One-off: find the cadence that keeps the Spear Fish prompt available.
const CHROME = process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome'
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
page.on('pageerror', (e) => console.log('pageerror:', e.message))
await page.goto(`${BASE}/?hour=12&spear=1`, { waitUntil: 'load' })
await page.waitForTimeout(2500)

await page.evaluate(() => {
  const p = window.ww.player
  p.x = -24
  p.z = -88
  p.y = 1.5
  p.mode = 'swim'
})

// Get down into the school band first
await page.keyboard.down('Shift')
await page.waitForTimeout(4000)
await page.keyboard.up('Shift')

const deadline = Date.now() + 90000
let found = false
let cycles = 0
while (Date.now() < deadline && !found) {
  cycles++
  // Pin a fish ahead and slightly below, where the bob will carry the eyes
  const pinned = await page.evaluate(() => {
    const ww = window.ww
    const cam = ww.camera
    const dir = cam.getWorldDirection(cam.position.clone())
    const point = cam.position.clone().add(dir.multiplyScalar(1.8))
    point.y -= 0.6
    return ww.underwater.fish.debugDraw(point)
  })
  try {
    await page.waitForFunction(
      () =>
        window.ww.interactions
          .candidates(window.ww.camera)
          .some((c) => c.verb === 'Spear' && c.why === ''),
      null,
      { timeout: 2500 },
    )
    found = true
  } catch {
    // stay under with a gentle tap — effort spikes scatter them, so keep it short
    await page.keyboard.down('Shift')
    await page.waitForTimeout(500)
    await page.keyboard.up('Shift')
    await page.waitForTimeout(700)
  }
  if (pinned === false) console.log('pin returned false')
}
console.log(found ? `FOUND after ${cycles} cycle(s)` : `NOT FOUND in ${cycles} cycles`)
const final = await page.evaluate(() => ({
  prompt: document.querySelector('#prompt span')?.textContent ?? '',
  camY: +window.ww.camera.position.y.toFixed(2),
  effort: +window.ww.player.effort.toFixed(2),
}))
console.log(JSON.stringify(final))
await browser.close()
