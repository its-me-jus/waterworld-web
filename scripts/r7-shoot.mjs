// Scratch (round 7): shoot named views from shot.mjs with a long screenshot timeout,
// for when other sessions are loading the machine. Usage: node scripts/r7-shoot.mjs r7-shell-down r7-rock-c
import { chromium } from 'playwright-core'
import { readFileSync, mkdirSync } from 'node:fs'

const src = readFileSync('scripts/shot.mjs', 'utf8')
const wanted = process.argv.slice(2)
const views = wanted.map((name) => {
  const m = src.match(new RegExp(`name: '${name}', url: '([^']+)'`))
  if (!m) throw new Error('no view ' + name)
  return { name, url: m[1] }
})
mkdirSync('shots', { recursive: true })
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
for (const { name, url } of views) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[${name}] error: ${m.text().slice(0, 200)}`)
  })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `shots/${name}.png`, timeout: 500000 })
  console.log(`[${name}] captured`)
  await page.close()
}
await browser.close()
