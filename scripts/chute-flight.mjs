// Dev-only: fly the parachute drop without rendering it, to check the flight model.
// Needs `npm run dev` running. Usage: node scripts/chute-flight.mjs
// Prints where each scripted pilot lands, how long it took, and how softly.
import { chromium } from 'playwright-core'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.goto(`${BASE}/?chute=1`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__chute, null, { timeout: 240000 })

const results = await page.evaluate(() => {
  const { chute, player, camera, groundAt, input, chuteStart, coveBeach, outward } = window.__chute
  // Aim point: first dry sand seaward of the cove beach, as the skip does
  let ax = coveBeach.x
  let az = coveBeach.z
  for (let d = -30; d < 90; d += 1) {
    ax = coveBeach.x + outward.x * d
    az = coveBeach.z + outward.y * d
    if (groundAt(ax, az) < 2.2) break
  }
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
  const reset = () => {
    input.moveForward = input.moveStrafe = 0
    input.rise = input.dive = false
  }

  const fly = (name, pilot, opts = {}) => {
    reset()
    chute.begin(player, { ...chuteStart, altitude: opts.altitude ?? chuteStart.altitude }, 0)
    let t = 0
    let heading = chuteStart.yaw
    const log = []
    for (let step = 0; step < 6000; step++) {
      t += 0.05
      const h = chute.height
      pilot({ t, h, x: player.x, z: player.z, yaw: player.yaw, ax, az })
      const r = chute.update(0.05, t, player, camera, input, groundAt)
      if (!r) break
      if (step % 100 === 0) log.push(`${t.toFixed(0)}s h=${h.toFixed(0)} d=${Math.hypot(player.x - ax, player.z - az).toFixed(0)}`)
      if (r.touchdown) {
        return {
          name,
          time: +t.toFixed(1),
          kind: r.touchdown.kind,
          sink: +r.touchdown.sink.toFixed(2),
          missBy: +Math.hypot(player.x - ax, player.z - az).toFixed(0),
          x: Math.round(player.x),
          z: Math.round(player.z),
          groundHere: +groundAt(player.x, player.z).toFixed(1),
          log: log.join(' | '),
        }
      }
    }
    return { name, time: 'never landed', log: log.join(' | ') }
  }

  const toward = (s) => {
    const want = Math.atan2(-(s.ax - s.x), -(s.az - s.z))
    return Math.max(-1, Math.min(1, (s.yaw - want) * 2.2 * -1 * -1))
  }
  // yaw falls as you turn right: steer > 0 when the target is to the right (want < yaw)
  const steerTo = (s) => {
    const diff = wrap(s.yaw - Math.atan2(-(s.ax - s.x), -(s.az - s.z)))
    return Math.max(-1, Math.min(1, diff * 2.2))
  }

  const out = []
  out.push(fly('hands off (trim, no input)', () => {}))
  out.push(fly('hold W (speed bar) toward beach', (s) => {
    input.moveForward = 1
    input.moveStrafe = steerTo(s)
  }))
  out.push(fly('hold S (brakes) toward beach', (s) => {
    input.moveForward = -1
    input.moveStrafe = steerTo(s)
  }))
  out.push(fly('steer to beach, flare at 8 m', (s) => {
    input.moveStrafe = steerTo(s)
    input.rise = s.h < 8
  }))
  out.push(fly('steer to beach, no flare', (s) => {
    input.moveStrafe = steerTo(s)
  }))
  out.push(fly('steer to beach, flare far too early (40 m)', (s) => {
    input.moveStrafe = steerTo(s)
    input.rise = s.h < 40
  }))
  // A sensible pilot: burn spare height with S-turns while there is more than
  // 1.5x what the glide needs, then run in and flare
  out.push(fly('S-turns to burn height, then run in and flare', (s) => {
    const dist = Math.hypot(s.ax - s.x, s.az - s.z)
    const needed = dist / 2.2
    const spare = s.h > needed * 1.5 && s.h > 30
    input.rise = s.h < 9
    input.moveForward = 0
    if (spare) input.moveStrafe = Math.floor(s.t / 5) % 2 ? 1 : -1
    else input.moveStrafe = steerTo(s)
  }))
  out.push(fly('from 120 m up', (s) => {
    input.moveStrafe = steerTo(s)
    input.rise = s.h < 9
  }, { altitude: 120 }))
  return out
})

for (const r of results) console.log(JSON.stringify(r))
await browser.close()
