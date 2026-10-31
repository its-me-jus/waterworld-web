// Dev-only: dump the painted leaf atlas and bark to shots/ for eyeballing.
// Needs `npm run dev` running.
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'
const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage()
// A bare same-origin HTML page, so the module import works without booting the scene
await page.route(`${BASE}/__blank.html`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }))
await page.goto(`${BASE}/__blank.html`)
const out = await page.evaluate(async (base) => {
  const m = await import(`${base}/src/leaftex.ts`)
  const dump = (tex, bg) => {
    const { width, height, data } = tex.image
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)
    const img = new ImageData(new Uint8ClampedArray(data), width, height)
    const tmp = document.createElement('canvas')
    tmp.width = width
    tmp.height = height
    tmp.getContext('2d').putImageData(img, 0, 0)
    ctx.drawImage(tmp, 0, 0)
    return c.toDataURL('image/png').split(',')[1]
  }
  return { leaf: dump(m.leafAtlas(), '#7fb0e0'), bark: dump(m.barkTexture(), '#000') }
}, BASE)
writeFileSync('shots/atlas-leaf.png', Buffer.from(out.leaf, 'base64'))
writeFileSync('shots/atlas-bark.png', Buffer.from(out.bark, 'base64'))
await browser.close()
console.log('wrote shots/atlas-leaf.png, shots/atlas-bark.png')
