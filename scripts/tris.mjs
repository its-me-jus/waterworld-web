// Dev-only: count triangles and draw calls per frame from a few vantage points.
// Needs `npm run dev` running. Usage: node scripts/tris.mjs [low]  (low fakes a 2-core device)
import { chromium } from 'playwright-core'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'
const VIEWS = {
  spawn: '/?yaw=-0.96&pitch=0.02',
  'island-near': '/?x=668&z=-463&yaw=-0.96&pitch=0.05',
  'beach-walk': '/?x=775&z=-532&yaw=-1.02&pitch=0.05',
  inland: '/?x=800&z=-550&yaw=-0.6&pitch=0.12',
}
const low = process.argv[2] === 'low'

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
for (const [name, path] of Object.entries(VIEWS)) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  if (low) {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 })
    })
  }
  await page.addInitScript(() => {
    const w = window
    w.__frame = { tris: 0, draws: 0 }
    w.__last = { tris: 0, draws: 0 }
    const proto = WebGL2RenderingContext.prototype
    const count = (mode, n, inst = 1) => {
      // 4 = TRIANGLES, 5 = STRIP, 6 = FAN
      const t = mode === 4 ? n / 3 : mode === 5 || mode === 6 ? n - 2 : 0
      w.__frame.tris += t * inst
      w.__frame.draws++
    }
    for (const fn of ['drawArrays', 'drawElements']) {
      const orig = proto[fn]
      proto[fn] = function (mode, a, b, c) {
        count(mode, fn === 'drawArrays' ? b : a)
        return orig.call(this, mode, a, b, c)
      }
    }
    for (const fn of ['drawArraysInstanced', 'drawElementsInstanced']) {
      const orig = proto[fn]
      proto[fn] = function (mode, a, b, c, d) {
        count(mode, fn === 'drawArraysInstanced' ? b : a, fn === 'drawArraysInstanced' ? c : d)
        return orig.call(this, mode, a, b, c, d)
      }
    }
    const raf = w.requestAnimationFrame.bind(w)
    w.requestAnimationFrame = (cb) =>
      raf((t) => {
        w.__last = w.__frame
        w.__frame = { tris: 0, draws: 0 }
        cb(t)
      })
  })
  await page.goto(BASE + path)
  await page.waitForFunction(() => window.__last.draws > 20, null, { timeout: 240000 })
  await page.waitForTimeout(3000)
  const r = await page.evaluate(() => window.__last)
  console.log(`${name}: ${(r.tris / 1e6).toFixed(2)}M tris, ${r.draws} draws`)
  await page.close()
}
await browser.close()
