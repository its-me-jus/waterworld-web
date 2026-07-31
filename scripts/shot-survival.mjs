// Phase A smoke test: exercise vitals, forage prompt, sea state, death flow.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const CHROME = '/usr/local/bin/google-chrome'
const OUT = '/tmp/shots'
mkdirSync(OUT, { recursive: true })

const VIEWS = [
  { name: 'surface', url: 'http://localhost:5173/', wait: 3000 },
  { name: 'calm-sea', url: 'http://localhost:5173/?calm=1', wait: 6000 },
  { name: 'hungry', url: 'http://localhost:5173/?hunger=0.15', wait: 6500 },
  {
    name: 'low-breath',
    url: 'http://localhost:5173/?breath=0.12&depth=2',
    wait: 3000,
  },
  {
    name: 'crate-prompt',
    url: 'http://localhost:5173/?x=-22&z=-98.4&yaw=0&pitch=0.1',
    wait: 3500,
  },
  {
    name: 'crate-eat',
    url: 'http://localhost:5173/?x=-22&z=-98.4&yaw=0&pitch=0.1',
    wait: 3500,
    pressF: true,
    afterWait: 2500,
  },
  {
    name: 'death',
    url: 'http://localhost:5173/?breath=0.04&depth=3',
    wait: 12000,
    small: true,
  },
  {
    name: 'shark',
    url: 'http://localhost:5173/?depth=5&shark=5&pitch=0.15',
    wait: 0,
    sharkWatch: true,
    small: true,
  },
]

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})

let bad = 0
for (const v of VIEWS) {
  // Small viewport for timed waits: swiftshader frames are slow, and the
  // game's dt clamp means wall-clock waits stretch on big canvases
  const page = await browser.newPage({
    viewport: v.small ? { width: 640, height: 360 } : { width: 1280, height: 720 },
  })
  page.on('console', (m) => {
    if (/deprecated/.test(m.text())) return
    if (m.type() === 'error' || m.type() === 'warning') {
      bad++
      console.log(`[${v.name}] ${m.type()}: ${m.text()}`)
    }
  })
  page.on('pageerror', (e) => {
    bad++
    console.log(`[${v.name}] pageerror: ${e.message}`)
  })

  await page.goto(v.url, { waitUntil: 'load' })
  if (v.sharkWatch) {
    // Wait for the pass to begin and close in, then catch it mid-circle
    await page.waitForFunction(() => window.__shark?.active, null, { timeout: 60000 })
    await page.waitForFunction(() => window.__shark?.proximity > 0.5, null, { timeout: 120000 })
    for (let i = 0; i < 3; i++) {
      await page.screenshot({ path: `${OUT}/${v.name}-${i + 1}.png` })
      console.log(`[${v.name}-${i + 1}] captured`)
      await page.waitForTimeout(4500)
    }
    await page.close()
    continue
  }
  await page.waitForTimeout(v.wait)
  if (v.name === 'hungry') {
    const whisper = await page.evaluate(() => document.querySelector('#whisper')?.textContent)
    console.log(`[hungry] whisper showing: "${whisper}"`)
  }
  if (v.pressF) {
    const prompt = await page.evaluate(() => document.querySelector('#prompt')?.textContent)
    console.log(`[${v.name}] prompt before F: "${prompt}"`)
    await page.keyboard.press('KeyF')
    await page.waitForTimeout(v.afterWait)
    const whisper = await page.evaluate(() => document.querySelector('#whisper')?.textContent)
    console.log(`[${v.name}] whisper after F: "${whisper}"`)
  }
  await page.screenshot({ path: `${OUT}/${v.name}.png` })
  console.log(`[${v.name}] captured`)
  await page.close()
}

await browser.close()
console.log(bad === 0 ? 'CLEAN: no errors or warnings' : `${bad} console problem(s)`)
