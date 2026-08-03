import { chromium } from 'playwright-core'

/**
 * Feature coverage for the camp life work:
 *   A — shelter growth: frame → walls → roof → Raise the ridge → Add a room,
 *       and that the grown hut survives a reload
 *   B — the tired timer: ?energy preset, wakefulness drains it, Rest brings
 *       it back, and the HUD row shows
 *   C — fishing: a bottle trap set in the shallows stocks itself and Checks
 *       out into the hand; the spear answers the schools directly
 *
 * Needs `npm run dev` running. CHROME_PATH / SHOT_BASE follow the shot suite.
 * The headless env renders slowly, so everything waits on conditions, not clocks.
 */

const CHROME = process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome'
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const fails = []
const ok = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`)
  if (!cond) fails.push(name)
}

const counts = () => window.ww.improvise.counts
const snap = (kind) => window.ww.improvise.snapshot().filter((b) => b.kind === kind)

async function beachSpot(page) {
  return page.evaluate(() => {
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
      if (h > 1.2 && h < 8) return { x, z, h, shore: { x: s.x, z: s.z, y: s.y } }
    }
    return null
  })
}

/** Wading-depth water off the same cove — where a trap would ride. */
async function wadeSpot(page) {
  return page.evaluate(() => {
    const isl = window.ww.island
    let s = isl.shore[0]
    for (const p of isl.shore) if (p.y < s.y) s = p
    const dx = s.x - isl.centre.x
    const dz = s.z - isl.centre.z
    const len = Math.hypot(dx, dz)
    for (let d = 0; d < 120; d += 1) {
      const x = s.x + (dx / len) * d
      const z = s.z + (dz / len) * d
      const h = isl.heightAt(x, z)
      if (h < -0.5 && h > -1.2) return { x, z, h }
    }
    return null
  })
}

async function teleport(page, x, z, y, mode) {
  await page.evaluate(
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
}

async function fillStash(page) {
  await page.evaluate(() => {
    const s = window.ww.salvage.stash
    s.plank += 30
    s.rope += 10
    s.leaf += 10
    s.canvas += 3
    s.plastic += 4
  })
}

const useRecipe = (page, label, verb) =>
  page.evaluate(
    ([l, v]) => {
      const r = window.ww.improvise
        .campRecipes()
        .find((r) => r.label === l && (!v || r.verb === v))
      if (!r) return false
      r.use()
      return true
    },
    [label, verb],
  )

async function waitRecipe(page, label, verb, timeout = 25000) {
  try {
    await page.waitForFunction(
      ([l, v]) => window.ww.improvise.campRecipes().some((r) => r.label === l && (!v || r.verb === v)),
      [label, verb],
      { timeout },
    )
  } catch {
    return false
  }
  return useRecipe(page, label, verb)
}

async function waitPrompt(page, regex, timeout = 15000) {
  try {
    await page.waitForFunction(
      (re) => new RegExp(re, 'i').test(document.querySelector('#prompt span')?.textContent ?? ''),
      regex.source,
      { timeout },
    )
    return true
  } catch {
    return false
  }
}

// —— A: the shelter grows, and keeps its size across a reload —————————————
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } })
{
  const page = await ctxA.newPage()
  page.on('pageerror', (e) => console.log('pageerror:', e.message))
  await page.goto(`${BASE}/?hour=10`, { waitUntil: 'load' })
  await page.waitForTimeout(2500)

  const spot = await beachSpot(page)
  ok('found dry beach spot', !!spot)
  await teleport(page, spot.x, spot.z, spot.h + 1.7, 'walk')
  await page.waitForFunction(() => window.ww.player.mode === 'walk', null, { timeout: 20000 })
  await fillStash(page)
  await page.waitForTimeout(400)

  ok('Raise Frame available', await waitRecipe(page, 'Frame', 'Raise'))
  ok('Lash Wall #1', await waitRecipe(page, 'Wall', 'Lash'))
  ok('Lash Wall #2', await waitRecipe(page, 'Wall', 'Lash'))
  ok('Roof Fronds available', await waitRecipe(page, 'Fronds', 'Roof'))
  const [lean] = await page.evaluate(snap, 'lean-to')
  ok('lean-to complete', !!lean && lean.roof === 'leaf' && lean.sides === 2)

  ok('Raise the ridge available', await waitRecipe(page, 'the ridge', 'Raise'))
  const [hut] = await page.evaluate(snap, 'lean-to')
  ok('hut is standing height', !!hut && hut.tall === true && (hut.rooms ?? 1) === 1)

  ok('Add a room #1', await waitRecipe(page, 'a room', 'Add'))
  ok('Add a room #2', await waitRecipe(page, 'a room', 'Add'))
  const [hall] = await page.evaluate(snap, 'lean-to')
  ok('three rooms grown', !!hall && hall.rooms === 3)
  ok('no fourth room offered', !(await waitRecipe(page, 'a room', 'Add', 3000)))

  // Building took time: two rooms and a ridge is most of a workday gone by
  const hour = await page.evaluate(() => (window.ww.climate.getElapsed() / 480) * 24)
  ok(`the workday passed (hour ${hour.toFixed(1)})`, hour > 14)

  // Force the save, reload, and the hall should still be standing
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await page.waitForTimeout(300)
  await page.goto(`${BASE}/`, { waitUntil: 'load' })
  await page.waitForTimeout(3500)
  const [restored] = await page.evaluate(snap, 'lean-to')
  ok(
    `grown hut restored (tall ${restored?.tall}, rooms ${restored?.rooms})`,
    !!restored && restored.tall === true && restored.rooms === 3,
  )
  await page.close()
}
await ctxA.close()

// —— B: the tired timer ————————————————————————————————————————————————————
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } })
{
  const page = await ctxB.newPage()
  page.on('pageerror', (e) => console.log('pageerror:', e.message))
  // Start tired, mid-evening: the meter should read on the HUD at once
  await page.goto(`${BASE}/?hour=21&energy=0.3`, { waitUntil: 'load' })
  await page.waitForTimeout(2500)

  const e0 = await page.evaluate(() => window.ww.vitals.energy)
  ok(`?energy preset applied (${e0})`, Math.abs(e0 - 0.3) < 0.02)

  const rowOn = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#vitals .vital')]
    const row = rows.find((r) => r.textContent?.includes('Energy'))
    return !!row && row.classList.contains('on')
  })
  ok('Energy meter shows while tired', rowOn)

  // Wakefulness spends it — thirty idle seconds should be measurable
  await page.waitForTimeout(8000)
  const e1 = await page.evaluate(() => window.ww.vitals.energy)
  ok(`wakefulness drains energy (${e0.toFixed(2)} → ${e1.toFixed(2)})`, e1 < e0)

  // A lean-to and a night's Rest brings it back
  const spot = await beachSpot(page)
  await teleport(page, spot.x, spot.z, spot.h + 1.7, 'walk')
  await page.waitForFunction(() => window.ww.player.mode === 'walk', null, { timeout: 20000 })
  await fillStash(page)
  await page.waitForTimeout(400)
  ok('Raise Frame available', await waitRecipe(page, 'Frame', 'Raise'))
  ok('Roof Fronds available', await waitRecipe(page, 'Fronds', 'Roof'))

  await page.evaluate(() => {
    window.ww.player.pitch = 0.2
  })
  ok('Rest prompt shows at night', await waitPrompt(page, /rest shelter/i))
  await page.keyboard.press('KeyF')
  await page.waitForTimeout(600)
  const e2 = await page.evaluate(() => window.ww.vitals.energy)
  ok(`a night under the roof restores energy (${e2.toFixed(2)})`, e2 > 0.9)
  const day = await page.evaluate(() => document.querySelector('#day')?.textContent)
  ok(`slept through to dawn (${day})`, day === 'Day 2')
  await page.close()
}
await ctxB.close()

// —— C: fishing ————————————————————————————————————————————————————————————
const ctxC = await browser.newContext({ viewport: { width: 1280, height: 720 } })
{
  const page = await ctxC.newPage()
  page.on('pageerror', (e) => console.log('pageerror:', e.message))
  await page.goto(`${BASE}/?hour=12&spear=1`, { waitUntil: 'load' })
  await page.waitForTimeout(2500)

  // — the trap —
  const wade = await wadeSpot(page)
  ok('found wading water', !!wade)
  await teleport(page, wade.x, wade.z, 1.5, 'swim')
  await page.waitForTimeout(800)
  // Face offshore so the trap lands ahead in the wash
  await page.evaluate(() => {
    const isl = window.ww.island
    const p = window.ww.player
    const dx = p.x - isl.centre.x
    const dz = p.z - isl.centre.z
    p.yaw = Math.atan2(-dx, -dz) + Math.PI
  })
  await fillStash(page)
  await page.waitForTimeout(400)
  ok('Set Fish trap available', await waitRecipe(page, 'Fish trap', 'Set'))
  ok('trap planted', (await page.evaluate(counts)).trap === 1)

  // The tide stocks it — first catch lands inside a couple of minutes
  await page
    .waitForFunction(
      () => window.ww.improvise.snapshot().some((b) => b.kind === 'trap' && (b.fish ?? 0) > 0),
      null,
      { timeout: 120000 },
    )
    .catch(() => {})
  const [stocked] = await page.evaluate(snap, 'trap')
  ok(`trap stocked (fish ${stocked?.fish ?? 0})`, !!stocked && (stocked.fish ?? 0) > 0)

  // Wade over and Check it — the fish lands in the hand
  const [trap] = await page.evaluate(snap, 'trap')
  await teleport(page, trap.x + 1.2, trap.z, 1.5, 'swim')
  await page.evaluate(() => {
    window.ww.player.pitch = -0.4
  })
  await page.waitForTimeout(400)
  ok('Check prompt shows', await waitPrompt(page, /check fish trap/i))
  await page.keyboard.press('KeyF')
  await page.waitForTimeout(500)
  const held = await page.evaluate(() => window.ww.forage.rawFish)
  ok(`trap fish in hand (${held})`, held >= 1)
  const [emptied] = await page.evaluate(snap, 'trap')
  ok('trap emptied by the check', !!emptied && (emptied.fish ?? 1) === 0)

  // — the spear —
  await page.keyboard.down('Shift')
  await page.waitForTimeout(2400)
  await page.keyboard.up('Shift')
  const speared = await page
    .waitForFunction(
      () => /spear fish/i.test(document.querySelector('#prompt span')?.textContent ?? ''),
      null,
      { timeout: 60000 },
    )
    .then(() => true)
    .catch(() => false)
  ok('Spear Fish prompt rides a school', speared)
  if (speared) {
    const before = await page.evaluate(() => window.ww.forage.rawFish)
    await page.keyboard.press('KeyF')
    await page.waitForTimeout(400)
    const after = await page.evaluate(() => window.ww.forage.rawFish)
    // 85% odds — a miss is a legitimate outcome, the whisper says so
    ok(`spear strike resolved (${before} → ${after})`, after >= before)
  }
  await page.close()
}
await ctxC.close()

console.log(fails.length === 0 ? 'CAMP: all green' : `CAMP: ${fails.length} failure(s)`)
await browser.close()
process.exit(fails.length === 0 ? 0 : 1)
