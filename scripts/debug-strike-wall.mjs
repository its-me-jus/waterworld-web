/**
 * Focused repro for Strike Wall after sleep — dumps prompt candidates to
 * /opt/cursor/logs/debug.log (and relies on in-game agentLog ingest).
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const LOG = '/opt/cursor/logs/debug.log'
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome'

function dump(hypothesisId, location, message, data) {
  fs.appendFileSync(
    LOG,
    JSON.stringify({ hypothesisId, location, message, data, timestamp: Date.now() }) + '\n',
  )
}

const snap = (kind) => window.ww.improvise.snapshot().filter((b) => b.kind === kind)

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
    s.rope += 8
    s.leaf += 8
    s.canvas += 3
    s.barrel += 1
    s.plastic += 4
    s.crate += 1
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

async function faceAndPressF(page, { yaw, pitch = 0 }, prompt, timeout = 15000) {
  await page.evaluate(
    ([yaw, pitch]) => {
      window.ww.player.yaw = yaw
      window.ww.player.pitch = pitch
    },
    [yaw, pitch],
  )
  try {
    await page.waitForFunction(
      (re) => new RegExp(re, 'i').test(document.querySelector('#prompt span')?.textContent ?? ''),
      prompt.source,
      { timeout },
    )
  } catch {
    return false
  }
  await page.keyboard.press('KeyF')
  await page.waitForTimeout(400)
  return true
}

async function beachSpot(page) {
  return page.evaluate(() => {
    const isl = window.ww.island
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * Math.PI * 2
      const r = 18 + (i % 7) * 2.2
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      const h = isl.heightAt(x, z)
      if (h > 0.55 && h < 2.2) return { x, z, h }
    }
    return null
  })
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => dump('E', 'pageerror', e.message, {}))

dump('setup', 'debug-strike-wall.mjs', 'start', { BASE })

await page.goto(`${BASE}/?hour=21`, { waitUntil: 'load' })
await page.waitForTimeout(2500)
const spot = await beachSpot(page)
await teleport(page, spot.x, spot.z, spot.h + 1.7, 'walk')
await page.waitForFunction(() => window.ww.player.mode === 'walk', null, { timeout: 20000 })
await fillStash(page)
await page.waitForTimeout(400)

// Minimal closed room: platform + 4 walls + roof (+ upper story like test-base)
for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
  await page.evaluate((y) => {
    window.ww.player.yaw = y
    window.ww.player.pitch = 0
  }, yaw)
  await page.waitForTimeout(200)
  if (await waitRecipe(page, 'Platform', 'Lay', 4000)) break
}
const [plat] = await page.evaluate(snap, 'platform')
dump('setup', 'platform', 'laid', plat)

for (let i = 0; i < 4; i++) {
  await page.evaluate((i) => {
    window.ww.player.yaw = (i * Math.PI) / 2
    window.ww.player.pitch = 0
  }, i)
  await page.waitForTimeout(250)
  await waitRecipe(page, 'Wall', 'Raise', 8000)
}
await page.evaluate(() => {
  window.ww.player.pitch = 0.55
})
await page.waitForTimeout(300)
await waitRecipe(page, 'Roof', 'Pitch', 8000)

// Second story like test-base (multi-story nearestOfKind)
await page.evaluate(() => {
  window.ww.player.pitch = 0.7
})
await page.waitForTimeout(300)
await faceAndPressF(page, { yaw: 0, pitch: 0.7 }, /climb platform/i, 12000).catch(() => false)
await fillStash(page)
await page.evaluate(() => {
  window.ww.salvage.stash.plank += 4
  window.ww.salvage.stash.rope += 2
})
await waitRecipe(page, 'Ladder', 'Hang', 8000).catch(() => false)
await faceAndPressF(page, { yaw: 0, pitch: 0.35 }, /climb ladder/i, 8000).catch(() => false)

// Back to ground bay, fire, sleep
await teleport(page, plat.x, plat.z, plat.y + 1.75, 'walk')
await page.evaluate(() => {
  window.ww.player.pitch = 0
})
await page.waitForTimeout(300)
await waitRecipe(page, 'Fire')
await page.evaluate(() => {
  const v = window.ww.vitals
  v.food = Math.max(v.food, 0.6)
  v.water = Math.max(v.water, 0.6)
})
await faceAndPressF(page, { yaw: 0, pitch: -1.1 }, /sleep under roof/i)
await page
  .waitForFunction(() => !window.ww.improvise.sleeping, null, { timeout: 20000 })
  .catch(() => {})
dump('setup', 'sleep', 'finished', {
  day: await page.evaluate(() => document.querySelector('#day')?.textContent),
  sleeping: await page.evaluate(() => window.ww.improvise.sleeping),
})

const [tile] = await page.evaluate(snap, 'platform')
await teleport(page, tile.x + 2.3, tile.z, tile.y + 1.75, 'walk')
await page.waitForTimeout(400)
await page.evaluate(() => {
  window.ww.player.yaw = Math.PI / 2
  window.ww.player.pitch = 0.1
})
await page.waitForTimeout(600)

const probe = await page.evaluate(() => {
  const p = window.ww.player
  const walls = window.ww.improvise.snapshot().filter((b) => b.kind === 'wall')
  const prompt = document.querySelector('#prompt span')?.textContent ?? ''
  const cands = window.ww.interactions.candidates(window.ww.camera)
  const recipes = window.ww.improvise.campRecipes().map((r) => `${r.verb} ${r.label}`)
  return {
    player: { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, mode: p.mode },
    tileY: walls[0] ? undefined : null,
    walls: walls.map((w) => ({
      x: w.x,
      z: w.z,
      y: w.y,
      variant: w.variant ?? 'solid',
      d: Math.hypot(w.x - p.x, w.z - p.z),
    })),
    prompt,
    recipes,
    cands: cands.filter((c) =>
      /strike|shelf|climb|hang|raise|door|window|bed|sleep/i.test(`${c.verb} ${c.label}`),
    ),
  }
})
dump('A/D', 'debug-strike-wall.mjs:probe', 'outside +x wall facing strike pose', probe)

const struck = await faceAndPressF(page, { yaw: Math.PI / 2, pitch: 0.1 }, /strike wall/i, 8000)
dump('A', 'debug-strike-wall.mjs:result', 'faceAndPressF Strike Wall', {
  struck,
  promptAfter: await page.evaluate(() => document.querySelector('#prompt span')?.textContent ?? ''),
  wallCount: await page.evaluate(() => window.ww.improvise.counts.wall),
})

console.log(JSON.stringify({ struck, prompt: probe.prompt, recipes: probe.recipes, cands: probe.cands }, null, 2))
await browser.close()
process.exit(struck ? 0 : 1)
