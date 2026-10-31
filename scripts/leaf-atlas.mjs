// Dev-only: dump the painted leaf atlas, bark and ground detail to shots/ for eyeballing.
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
  // Ground detail: one channel at a time as grey, side by side
  const g = await import(`${base}/src/groundtex.ts`)
  const gt = g.groundDetail().image
  const S = gt.width
  const c = document.createElement('canvas')
  c.width = S * 4
  c.height = S
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(S * 4, S)
  for (let ch = 0; ch < 4; ch++) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const v = gt.data[(y * S + x) * 4 + ch]
        const o = (y * S * 4 + ch * S + x) * 4
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v
        img.data[o + 3] = 255
      }
    }
  }
  ctx.putImageData(img, 0, 0)
  const ground = c.toDataURL('image/png').split(',')[1]
  return { leaf: dump(m.leafAtlas(), '#7fb0e0'), bark: dump(m.barkTexture(), '#000'), ground }
}, BASE)
writeFileSync('shots/atlas-leaf.png', Buffer.from(out.leaf, 'base64'))
writeFileSync('shots/atlas-bark.png', Buffer.from(out.bark, 'base64'))
writeFileSync('shots/atlas-ground.png', Buffer.from(out.ground, 'base64'))
await browser.close()
console.log('wrote shots/atlas-leaf.png, shots/atlas-bark.png')
