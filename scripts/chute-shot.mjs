// Dev-only: screenshots of the parachute drop at a few moments, written to shots/.
// Fast-forwards the flight with the DEV hook (no rendering between), then lets the
// page draw one frame and captures it. Needs `npm run dev`. Usage: node scripts/chute-shot.mjs
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'
mkdirSync('shots', { recursive: true })

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => {
  const t = m.text()
  if (m.type() === 'error' || (m.type() === 'warning' && !/X4122|Clock|AudioContext/.test(t))) console.log(m.type(), t.slice(0, 200))
})
await page.goto(`${BASE}/?chute=1`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__chute, null, { timeout: 240000 })

// Hold the game loop's own flight still while we pose a shot: freeze by zeroing dt effects is not
// possible, so each shot poses, waits for a frame, and captures straight away.
const advance = (seconds, pilot, untilHeight = null) =>
  page.evaluate(
    ([seconds, pilot, untilHeight]) => {
      const { chute, player, camera, groundAt, input, coveBeach, outward } = window.__chute
      let ax = coveBeach.x
      let az = coveBeach.z
      for (let d = -30; d < 90; d += 1) {
        ax = coveBeach.x + outward.x * d
        az = coveBeach.z + outward.y * d
        if (groundAt(ax, az) < 2.2) break
      }
      const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
      let t = window.__chuteT ?? 0
      for (let i = 0; i < seconds / 0.05; i++) {
        t += 0.05
        const diff = wrap(player.yaw - Math.atan2(-(ax - player.x), -(az - player.z)))
        input.moveStrafe = pilot === 'bank' ? 1 : Math.max(-1, Math.min(1, diff * 2.2))
        input.moveForward = 0
        input.rise = pilot === 'flare' && chute.height < 9
        const r = chute.update(0.05, t, player, camera, input, groundAt)
        if (!r) break
        if (r.touchdown) break
        if (untilHeight != null && chute.height < untilHeight) break
      }
      window.__chuteT = t
      input.moveStrafe = 0
      input.rise = false
    },
    [seconds, pilot, untilHeight],
  )

const only = process.env.SHOT_ONLY?.split(',').map((v) => v.trim()).filter(Boolean)
const shoot = async (name, pitch, yawOffset = 0) => {
  if (only && !only.some((k) => name.includes(k))) return
  await page.evaluate(([pitch, yawOffset]) => {
    const { player } = window.__chute
    player.pitch = pitch
    player.yaw += yawOffset
  }, [pitch, yawOffset])
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `shots/${name}.png`, timeout: 150000 })
  console.log(`[${name}] captured`)
}

await shoot('chute-start', -0.12)
await shoot('chute-look-up', 1.05)
await shoot('chute-start-down', -0.75)
await advance(6, 'bank')
await shoot('chute-bank', -0.1)
await advance(40, 'steer')
await shoot('chute-mid', -0.12)
await advance(60, 'steer', 90)
await shoot('chute-high-approach', -0.2)
await advance(60, 'steer', 30)
await shoot('chute-approach', -0.25)
await advance(60, 'flare')
await shoot('chute-landed', 0)
await page.waitForTimeout(3000)
await shoot('chute-landed-2', 0.15, 2.6)
await browser.close()
