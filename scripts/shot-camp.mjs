// Camp-life beauty shots: the grown three-room hut (outside and in), the
// bottle trap riding the shallows with a catch, and the tired HUD.
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
// Hermetic — an old autosave would restore someone else's camp
await ctx.addInitScript(() => localStorage.clear())
const page = await ctx.newPage()
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

await page.goto(`${BASE}/?hour=10.5`, { waitUntil: 'load' })
await page.waitForTimeout(2500)

// —— the grown hut ————————————————————————————————————————————————
const spot = await dryBeach()
await teleport(spot.x, spot.z, spot.h + 1.7, 'walk')
await page.waitForFunction(() => window.ww.player.mode === 'walk', null, { timeout: 20000 })
await page.evaluate(() => {
  const s = window.ww.salvage.stash
  s.plank += 30
  s.rope += 10
  s.leaf += 10
  s.plastic += 4
})
await page.waitForTimeout(400)

await use('Frame', 'Raise')
await use('Wall', 'Lash')
await use('Wall', 'Lash')
await use('Fronds', 'Roof')
await use('the ridge', 'Raise')
await use('a room', 'Add')
await use('a room', 'Add')

const [hut] = await page.evaluate(() =>
  window.ww.improvise.snapshot().filter((b) => b.kind === 'lean-to'),
)
console.log(`hut: tall=${hut?.tall} rooms=${hut?.rooms}`)
// lean-to snapshots carry no deck height — read the ground it's planted on
const hutY = await page.evaluate(
  ([x, z]) => window.ww.island.heightAt(x, z),
  [hut.x, hut.z],
)

// Outside, three-quarter view from the open side
await teleport(hut.x + 5.2, hut.z + 4.6, hutY + 1.7, 'walk')
await face(hut.x, hut.z, -0.06)
await page.waitForTimeout(700)
await page.screenshot({ path: `${OUT}/hut-outside.png` })
console.log('[hut-outside] captured')

// Inside, looking along the rooms — standing height, your own hall
await teleport(hut.x + 2.6, hut.z + 0.2, hutY + 1.7, 'walk')
await face(hut.x - 2.5, hut.z, -0.05)
await page.waitForTimeout(700)
await page.screenshot({ path: `${OUT}/hut-inside.png` })
console.log('[hut-inside] captured')

// —— the trap ————————————————————————————————————————————————————
// Somewhere the water is wading-deep AND stays wading-deep two metres out,
// which is where the bottle lands
const wade = await page.evaluate(() => {
  const isl = window.ww.island
  let s = isl.shore[0]
  for (const p of isl.shore) if (p.y < s.y) s = p
  const dx = s.x - isl.centre.x
  const dz = s.z - isl.centre.z
  const len = Math.hypot(dx, dz)
    for (let d = 0; d < 160; d += 1) {
    const x = s.x + (dx / len) * d
    const z = s.z + (dz / len) * d
    const h = isl.heightAt(x, z)
    const ahead = isl.heightAt(x + (dx / len) * 3, z + (dz / len) * 3)
    if (h > -1.2 && h < -0.5 && ahead < -0.7 && ahead > -1.3) return { x, z, h }
  }
  return null
})
await teleport(wade.x, wade.z, 1.5, 'swim')
await page.evaluate(() => {
  const isl = window.ww.island
  const p = window.ww.player
  const dx = p.x - isl.centre.x
  const dz = p.z - isl.centre.z
  p.yaw = Math.atan2(-dx, -dz) + Math.PI
})
await page.waitForTimeout(600)
const trapSet = await use('Fish trap', 'Set')
await page.evaluate(() => window.ww.improvise.debugTick(90))
const [trap] = await page.evaluate(() =>
  window.ww.improvise.snapshot().filter((b) => b.kind === 'trap'),
)
console.log(`trap: set=${trapSet} fish=${trap?.fish}`)
if (trap) {
  await teleport(trap.x + 2.2, trap.z + 1.2, 1.5, 'swim')
  await face(trap.x, trap.z, -0.5)
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/fish-trap.png` })
  console.log('[fish-trap] captured')
} else {
  bad++
}

// —— the tired meter ————————————————————————————————————————————————
await page.goto(`${BASE}/?hour=13&energy=0.3`, { waitUntil: 'load' })
await page.waitForTimeout(2600)
await page.screenshot({ path: `${OUT}/hud-tired.png`, clip: { x: 0, y: 0, width: 340, height: 260 } })
console.log('[hud-tired] captured')

console.log(bad === 0 ? 'CAMP SHOTS: clean' : `${bad} problem(s)`)
await browser.close()
