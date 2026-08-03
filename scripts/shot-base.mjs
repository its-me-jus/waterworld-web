// Base & raft beauty shots: a walled room with a door and a hearth, a stilt
// deck over the shallows, and the raft under sail with the anchor down.
// Needs `npm run dev` running. SHOT_BASE / CHROME_PATH follow the shot suite.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'
const CHROME = process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome'
const OUT = new URL('../shots/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})

let bad = 0
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => {
  bad++
  console.log('pageerror:', e.message)
})

const use = async (label, verb) => {
  try {
    await page.waitForFunction(
      ([l, v]) => window.ww.improvise.campRecipes().some((r) => r.label === l && (!v || r.verb === v)),
      [label, verb],
      { timeout: 25000 },
    )
  } catch {
    console.log(`missing recipe: ${verb ?? ''} ${label}`)
    bad++
    return false
  }
  return page.evaluate(
    ([l, v]) => {
      const r = window.ww.improvise.campRecipes().find((r) => r.label === l && (!v || r.verb === v))
      r.use()
      return true
    },
    [label, verb],
  )
}

const teleport = (x, z, y, mode) =>
  page.evaluate(
    ([x, z, y, mode]) => {
      const p = window.ww.player
      p.x = x
      p.z = z
      p.y = y
      p.vy = 0
      p.speed = 0
      if (mode) p.mode = mode
    },
    [x, z, y, mode],
  )

const face = (tx, tz, pitch = -0.1) =>
  page.evaluate(
    ([tx, tz, pitch]) => {
      const p = window.ww.player
      p.yaw = Math.atan2(-(tx - p.x), -(tz - p.z))
      p.pitch = pitch
    },
    [tx, tz, pitch],
  )

const dryBeach = () =>
  page.evaluate(() => {
    const isl = window.ww.island
    let s = isl.shore[0]
    for (const p of isl.shore) if (p.y < s.y) s = p
    const dx = isl.centre.x - s.x
    const dz = isl.centre.z - s.z
    const len = Math.hypot(dx, dz)
    for (let d = 3; d < 80; d += 1.5) {
      const x = s.x + (dx / len) * d
      const z = s.z + (dz / len) * d
      const h = isl.heightAt(x, z)
      if (h > 1.2 && h < 8) return { x, z, h }
    }
    return null
  })

const seaward = (minH, maxH, lateral = 0) =>
  page.evaluate(
    ([minH, maxH, lateral]) => {
      const isl = window.ww.island
      let s = isl.shore[0]
      for (const p of isl.shore) if (p.y < s.y) s = p
      const dx = s.x - isl.centre.x
      const dz = s.z - isl.centre.z
      const len = Math.hypot(dx, dz)
      const ox = s.x + (-dz / len) * lateral
      const oz = s.z + (dx / len) * lateral
      for (let d = 0; d < 120; d += 1) {
        const x = ox + (dx / len) * d
        const z = oz + (dz / len) * d
        const h = isl.heightAt(x, z)
        if (h > minH && h < maxH) return { x, z, h }
      }
      return null
    },
    [minH, maxH, lateral],
  )

const fill = () =>
  page.evaluate(() => {
    const s = window.ww.salvage.stash
    s.plank += 40
    s.rope += 10
    s.leaf += 10
    s.canvas += 3
  })

// —— a room of your own, golden hour ————————————————————————————
await page.goto(`${BASE}/?hour=17.4`, { waitUntil: 'load' })
await page.waitForTimeout(2500)
const spot = await dryBeach()
await teleport(spot.x, spot.z, spot.h + 1.7, 'walk')
await page.waitForTimeout(600)
await fill()
await page.waitForTimeout(400)
await use('Platform')
const [p1] = await page.evaluate(() => window.ww.improvise.snapshot().filter((b) => b.kind === 'platform'))
await teleport(p1.x, p1.z, p1.y + 1.75, 'walk')
await page.waitForTimeout(500)
for (const yaw of [0, Math.PI, -Math.PI / 2]) {
  await page.evaluate((y) => {
    window.ww.player.yaw = y
    window.ww.player.pitch = 0
  }, yaw)
  await page.waitForTimeout(300)
  await use('Wall')
}
await page.evaluate(() => {
  window.ww.player.yaw = Math.PI / 2
  window.ww.player.pitch = 0
})
await page.waitForTimeout(300)
await use('Door')
await use('Roof')
await use('Fire')

await teleport(p1.x + 6.5, p1.z + 4, p1.y + 2.2, 'walk')
await face(p1.x, p1.z)
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/base-room.png` })

await teleport(p1.x - 0.4, p1.z - 0.3, p1.y + 1.75, 'walk')
await page.evaluate(() => {
  window.ww.player.yaw = -Math.PI / 2 + 0.6
  window.ww.player.pitch = -0.02
})
await page.waitForTimeout(1200)
await page.screenshot({ path: `${OUT}/base-hearth.png` })

// —— stilt deck over the shallows ————————————————————————————————
const stiltSea = await seaward(-2.0, -1.0)
await teleport(stiltSea.x, stiltSea.z, 1.6, 'swim')
await page.waitForTimeout(600)
await use('Platform')
const stilts = await page.evaluate(() => window.ww.improvise.snapshot().filter((b) => b.kind === 'platform'))
const stilt = stilts[stilts.length - 1]
await teleport(stilt.x + 7, stilt.z + 2, 1.6, 'swim')
await face(stilt.x, stilt.z, -0.06)
await page.waitForTimeout(1400)
await page.screenshot({ path: `${OUT}/stilt-deck.png` })

// —— raft under sail, anchor down ————————————————————————————————
const deep = await seaward(-3.5, -1.4, 45)
await teleport(deep.x, deep.z, 1.5, 'swim')
await page.waitForTimeout(600)
await fill()
await page.waitForTimeout(300)
await page.evaluate(() => {
  const isl = window.ww.island
  const p = window.ww.player
  const dx = p.x - isl.centre.x
  const dz = p.z - isl.centre.z
  p.yaw = Math.atan2(-dx, -dz) + Math.PI
})
await page.waitForTimeout(300)
await use('Raft')
const [raft] = await page.evaluate(() => window.ww.improvise.snapshot().filter((b) => b.kind === 'raft'))
await teleport(raft.x, raft.z, 3.2, 'walk')
await page.waitForTimeout(600)
await use('Sail')
await use('Rail')
await use('Oar')
await use('Anchor', 'Drop')
await page.waitForTimeout(400)
const [r2] = await page.evaluate(() => window.ww.improvise.snapshot().filter((b) => b.kind === 'raft'))
await teleport(r2.x + 5.5, r2.z + 2.5, 2.1, 'swim')
await face(r2.x, r2.z)
await page.waitForTimeout(1400)
await page.screenshot({ path: `${OUT}/raft-anchored.png` })

console.log(bad ? `${bad} problem(s)` : `shots written to ${OUT}`)
await browser.close()
process.exit(bad ? 1 : 0)
