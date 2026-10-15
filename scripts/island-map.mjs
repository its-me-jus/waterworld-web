// Dev-only: paint the island's shape fields top-down into shots/map-*.png —
// height (hillshaded), valley/ridge, and forest cover. Needs `npm run dev`.
import { chromium } from 'playwright-core'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
await page.goto(BASE + '/')
await page.waitForFunction(() => window.__islandFields, null, { timeout: 240000 })
console.log('closed-forest crowns:', await page.evaluate(() => window.__islandJungle))
console.log('coral heads:', await page.evaluate(() => window.__islandCoral))
const shots = await page.evaluate(() => {
  const f = window.__islandFields
  const N = 512
  const reach = 340
  const out = {}
  const paint = (name, pixel) => {
    const c = document.createElement('canvas')
    c.width = c.height = N
    const g = c.getContext('2d')
    const img = g.createImageData(N, N)
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const lx = -reach + (i / N) * reach * 2
        const lz = -reach + (j / N) * reach * 2
        const [r, gg, b] = pixel(lx, lz)
        const k = (j * N + i) * 4
        img.data[k] = r
        img.data[k + 1] = gg
        img.data[k + 2] = b
        img.data[k + 3] = 255
      }
    }
    g.putImageData(img, 0, 0)
    out[name] = c.toDataURL('image/png')
  }
  paint('height', (x, z) => {
    const h = f.height(x, z)
    if (h < 0) {
      const d = Math.min(1, -h / 30)
      return [40 * (1 - d), 140 * (1 - d) + 40, 170 * (1 - d) + 70]
    }
    const e = 1.5
    const nx = (f.height(x - e, z) - f.height(x + e, z)) / (2 * e)
    const nz = (f.height(x, z - e) - f.height(x, z + e)) / (2 * e)
    const shade = Math.max(0, Math.min(1, 0.6 + (nx * -0.6 + nz * -0.6) * 0.5))
    const t = Math.min(1, h / 260)
    return [(90 + 140 * t) * shade, (140 + 60 * t) * shade, (70 + 120 * t) * shade]
  })
  paint('valley', (x, z) => {
    const v = f.valley(x, z)
    const land = f.height(x, z) > 0 ? 1 : 0.4
    return [255 * (1 - v) * land, 120 * land, 255 * v * land]
  })
  paint('reef', (x, z) => {
    const h = f.height(x, z)
    if (h > 0) return [60, 90, 50]
    const r = f.reef(x, z)
    const d = Math.min(1, -h / 12)
    return [40 + 200 * r, 140 * (1 - d) + 40 + 40 * r, 180 * (1 - d) + 60]
  })
  paint('cover', (x, z) => {
    const h = f.height(x, z)
    if (h < 0) return [30, 70, 110]
    const c = f.cover(x, z)
    return [200 * (1 - c), 120 + 100 * c * 0.3, 60]
  })
  return out
})
const { writeFileSync } = await import('node:fs')
for (const [name, url] of Object.entries(shots)) {
  writeFileSync(`shots/map-${name}.png`, Buffer.from(url.split(',')[1], 'base64'))
  console.log(`shots/map-${name}.png`)
}
await browser.close()
