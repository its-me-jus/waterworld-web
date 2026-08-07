import { chromium } from 'playwright-core'

/**
 * Feature coverage for the player-freedom work:
 *   A — carpentry (platform / walls / door / roof / strike / fire on deck),
 *       sleeping in a self-built room, the days-alive counter, and the save
 *   B — raft helm steering under sail and the anchor
 *   C — the living base survives a reload
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

const dayChip = () => document.querySelector('#day')?.textContent ?? ''
const counts = () => window.ww.improvise.counts
const snap = (kind) => window.ww.improvise.snapshot().filter((b) => b.kind === kind)

/** The lowest shore point — the landing cove — plus dry sand a little inland. */
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

/** Slow headless env: wait until a recipe announces itself, then fire it. */
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

/** Wait until the F-prompt reads as expected (prompt lags a frame or two). */
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

async function faceAndPressF(page, { yaw, pitch = 0 }, prompt, timeout = 15000) {
  await page.evaluate(
    ([yaw, pitch]) => {
      window.ww.player.yaw = yaw
      window.ww.player.pitch = pitch
    },
    [yaw, pitch],
  )
  const shown = await waitPrompt(page, prompt, timeout)
  if (!shown) return false
  await page.keyboard.press('KeyF')
  await page.waitForTimeout(400)
  return true
}

// —— A: carpentry, sleep, days, the save ————————————————————————————
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } })
{
  const page = await ctxA.newPage()
  page.on('pageerror', (e) => console.log('pageerror:', e.message))
  await page.goto(`${BASE}/?hour=21`, { waitUntil: 'load' })
  await page.waitForTimeout(2500)

  const spot = await beachSpot(page)
  ok('found dry beach spot', !!spot)
  await teleport(page, spot.x, spot.z, spot.h + 1.7, 'walk')
  await page.waitForFunction(() => window.ww.player.mode === 'walk', null, { timeout: 20000 })
  ok('day chip reads Day 1', (await page.evaluate(dayChip)) === 'Day 1')

  await fillStash(page)
  await page.waitForTimeout(400)

  ok('Lay Platform available', await waitRecipe(page, 'Platform'))
  ok('platform built', (await page.evaluate(counts)).platform === 1)

  const [plat] = await page.evaluate(snap, 'platform')
  ok('platform snapped to the grid', Math.abs(plat.x / 2.4 - Math.round(plat.x / 2.4)) < 1e-6)

  // Expand: stand on the deck, face each cardinal until Lay aims an empty neighbour
  await teleport(page, plat.x, plat.z, plat.y + 1.75, 'walk')
  await page.waitForTimeout(400)
  let expanded = false
  for (const yaw of [Math.PI / 2, Math.PI, -Math.PI / 2, 0]) {
    await page.evaluate((y) => {
      window.ww.player.yaw = y
      window.ww.player.pitch = 0
    }, yaw)
    await page.waitForTimeout(300)
    if (await waitRecipe(page, 'Platform', null, 4000)) {
      expanded = true
      break
    }
  }
  ok('expand Lay Platform available', expanded)
  ok('second platform joined', (await page.evaluate(counts)).platform === 2)
  const plats = await page.evaluate(snap, 'platform')
  const joined = plats.some((p) => {
    if (p.x === plat.x && p.z === plat.z) return false
    const dx = Math.abs(p.x - plat.x)
    const dz = Math.abs(p.z - plat.z)
    return (dx < 0.01 && Math.abs(dz - 2.4) < 0.01) || (dz < 0.01 && Math.abs(dx - 2.4) < 0.01)
  })
  ok('neighbour snapped one tile away', joined)

  // Woodpile stockpile beside the house
  await teleport(page, plat.x - 3.2, plat.z, plat.y + 1.75, 'walk')
  await page.waitForTimeout(400)
  ok('Stack Woodpile available', await waitRecipe(page, 'Woodpile'))
  ok('woodpile planted', (await page.evaluate(counts)).woodpile === 1)
  const [pile] = await page.evaluate(snap, 'woodpile')
  await teleport(page, pile.x + 0.4, pile.z + 0.4, (pile.y ?? plat.y) + 1.6, 'walk')
  await page.evaluate(() => {
    window.ww.salvage.stash.plank += 6
  })
  await page.waitForTimeout(400)
  const piled = await faceAndPressF(page, { yaw: Math.PI, pitch: -0.4 }, /stow on pile/i, 15000)
  ok('stowed planks on pile', piled)
  const pileHold = await page.evaluate(() => {
    const w = window.ww.improvise.snapshot().find((b) => b.kind === 'woodpile')
    return w?.hold?.plank ?? 0
  })
  ok(`woodpile holds more than the seed (${pileHold})`, pileHold > 1)
  // Restock arms for the room build — pile kept the surplus
  await fillStash(page)

  // Stand on the first tile and wall all four sides
  await teleport(page, plat.x, plat.z, plat.y + 1.75, 'walk')
  await page.waitForTimeout(400)
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    await page.evaluate(
      ([y]) => {
        window.ww.player.yaw = y
        window.ww.player.pitch = 0
      },
      [yaw],
    )
    await page.waitForTimeout(300)
    await waitRecipe(page, 'Wall')
  }
  ok('four walls raised', (await page.evaluate(counts)).wall === 4)

  ok('Pitch Roof available', await waitRecipe(page, 'Roof'))
  ok('roof pitched', (await page.evaluate(counts)).roof === 1)

  // Second story: look up on the roofed bay and Lay Platform again
  await fillStash(page)
  await teleport(page, plat.x, plat.z, plat.y + 1.75, 'walk')
  await page.evaluate(() => {
    window.ww.player.yaw = 0
    window.ww.player.pitch = 0.7
  })
  await page.waitForTimeout(400)
  ok('stack Lay Platform available (look up)', await waitRecipe(page, 'Platform', null, 8000))
  ok('second-story platform laid', (await page.evaluate(counts)).platform === 3)
  const stories = await page.evaluate(() => {
    const plats = window.ww.improvise.snapshot().filter((b) => b.kind === 'platform')
    const ground = plats.find((p) => Math.abs(p.x - window.ww.player.x) < 1.3 && Math.abs(p.z - window.ww.player.z) < 1.3)
    // Prefer the lowest at this cell, then its stacked neighbour
    const here = plats
      .filter((p) => Math.abs(p.x - plats[0].x) < 0.01 && Math.abs(p.z - plats[0].z) < 0.01)
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0))
    // Find any stacked pair sharing x/z
    for (const a of plats) {
      const above = plats.find(
        (b) => b !== a && Math.abs(b.x - a.x) < 0.01 && Math.abs(b.z - a.z) < 0.01 && (b.y ?? 0) > (a.y ?? 0) + 1.5,
      )
      if (above) return { low: a.y, high: above.y, dx: 0, dz: 0 }
    }
    return { low: ground?.y, high: null, count: plats.length }
  })
  ok(
    `stacked decks share a footprint (${stories.low?.toFixed?.(2)} → ${stories.high?.toFixed?.(2)})`,
    stories.high != null && stories.low != null && stories.high > stories.low + 1.5,
  )

  // Climb up: look up and Climb Platform
  await teleport(page, plat.x, plat.z, plat.y + 1.75, 'walk')
  await page.evaluate(() => {
    window.ww.player.yaw = 0
    window.ww.player.pitch = 0.7
  })
  const climbed = await faceAndPressF(page, { yaw: 0, pitch: 0.7 }, /climb platform/i, 12000)
  ok('climbed to the second story', climbed)
  const onUpper = await page.evaluate(() => {
    const plats = window.ww.improvise
      .snapshot()
      .filter((b) => b.kind === 'platform')
      .sort((a, b) => (b.y ?? 0) - (a.y ?? 0))
    const top = plats[0]
    return Math.abs(window.ww.player.y - ((top.y ?? 0) + 1.62)) < 0.35
  })
  ok('standing on the upper deck', onUpper)

  // Ladder: hang on the ground bay, climb without looking up
  await teleport(page, plat.x, plat.z, plat.y + 1.75, 'walk')
  await page.evaluate(() => {
    window.ww.player.pitch = 0
    window.ww.salvage.stash.plank += 4
    window.ww.salvage.stash.rope += 2
  })
  await page.waitForTimeout(400)
  ok('Hang Ladder available', await waitRecipe(page, 'Ladder', null, 8000))
  ok('ladder hung', (await page.evaluate(counts)).ladder === 1)
  await teleport(page, plat.x, plat.z, plat.y + 1.75, 'walk')
  await page.evaluate(() => {
    window.ww.player.pitch = 0.15
    window.ww.player.yaw = 0
  })
  const climbedLadder = await faceAndPressF(page, { yaw: 0, pitch: 0.15 }, /climb ladder/i, 12000)
  ok('climbed via ladder', climbedLadder)
  const onUpperViaLadder = await page.evaluate(() => {
    const plats = window.ww.improvise
      .snapshot()
      .filter((b) => b.kind === 'platform')
      .sort((a, b) => (b.y ?? 0) - (a.y ?? 0))
    const top = plats[0]
    return Math.abs(window.ww.player.y - ((top.y ?? 0) + 1.62)) < 0.35
  })
  ok('ladder left you on the upper deck', onUpperViaLadder)

  // Ground floor still walkable under the stack (height-aware standAt)
  const floors = await page.evaluate(() => {
    const plats = window.ww.improvise.snapshot().filter((b) => b.kind === 'platform')
    let low = null
    let high = null
    for (const a of plats) {
      const above = plats.find(
        (b) => b !== a && Math.abs(b.x - a.x) < 0.01 && Math.abs(b.z - a.z) < 0.01 && (b.y ?? 0) > (a.y ?? 0) + 1.5,
      )
      if (above) {
        low = a
        high = above
        break
      }
    }
    if (!low || !high) return null
    const atLow = window.ww.improvise.standAt(low.x, low.z, (low.y ?? 0) + 1.62)
    const atHigh = window.ww.improvise.standAt(high.x, high.z, (high.y ?? 0) + 1.62)
    return {
      lowY: low.y,
      highY: high.y,
      standLow: atLow,
      standHigh: atHigh,
    }
  })
  ok(
    'standAt keeps you on the story you are on',
    !!floors &&
      Math.abs(floors.standLow - floors.lowY) < 0.15 &&
      Math.abs(floors.standHigh - floors.highY) < 0.15,
  )

  // Back to the ground bay for fire / sleep
  await teleport(page, plat.x, plat.z, plat.y + 1.75, 'walk')
  await page.evaluate(() => {
    window.ww.player.pitch = 0
  })
  await page.waitForTimeout(300)

  // A fire on the wooden deck
  ok('Kindle Fire on deck available', await waitRecipe(page, 'Fire'))
  ok('fire on the deck', (await page.evaluate(counts)).fire === 1)

  // Sleep: look down at the floor of a roofed, walled tile
  ok(
    'slept in the self-built room',
    await faceAndPressF(page, { yaw: 0, pitch: -1.1 }, /sleep under roof/i),
  )
  await page.waitForFunction(() => document.querySelector('#day')?.textContent === 'Day 2', null, {
    timeout: 15000,
  }).catch(() => {})
  ok('woke to Day 2', (await page.evaluate(dayChip)) === 'Day 2')

  // Walls block: outside, push in until stuck — the plane holds
  const [tile] = await page.evaluate(snap, 'platform')
  await teleport(page, tile.x + 2.3, tile.z, tile.y + 1.75, 'walk')
  await page.evaluate(() => {
    window.ww.player.yaw = Math.PI / 2 // face -x, into the wall
    window.ww.player.pitch = 0
  })
  await page.keyboard.down('KeyW')
  // Walk until the position stops changing (stuck at the wall plane)
  let blockedAt = 0
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1500)
    const x = await page.evaluate(() => window.ww.player.x)
    if (Math.abs(x - blockedAt) < 0.06) {
      blockedAt = x
      break
    }
    blockedAt = x
  }
  await page.keyboard.up('KeyW')
  ok(`wall blocks (${blockedAt.toFixed(2)} from centre ${tile.x.toFixed(2)})`, Math.abs(blockedAt - tile.x) > 1.0)

  // Strike the +x wall down from outside — the hearth can't steal the prompt
  const planksBefore = await page.evaluate(() => window.ww.salvage.stash.plank)
  await teleport(page, tile.x + 2.3, tile.z, tile.y + 1.75, 'walk')
  await page.waitForTimeout(300)
  ok('struck a wall', await faceAndPressF(page, { yaw: Math.PI / 2, pitch: 0.1 }, /strike wall/i))
  ok('wall count drops', (await page.evaluate(counts)).wall === 3)
  ok(
    'plank refunded',
    (await page.evaluate(() => window.ww.salvage.stash.plank)) === planksBefore + 1,
  )

  // Hang a door where the wall was, then walk out through the gap
  await teleport(page, tile.x, tile.z, tile.y + 1.75, 'walk')
  await page.evaluate(() => {
    window.ww.player.yaw = -Math.PI / 2
    window.ww.player.pitch = 0
  })
  await page.waitForTimeout(300)
  ok('Hang Door available', await waitRecipe(page, 'Door'))
  const [door] = await page.evaluate(() =>
    window.ww.improvise.snapshot().filter((b) => b.kind === 'wall' && b.variant === 'door'),
  )
  ok('door hung', !!door)
  await page.keyboard.down('KeyW')
  let outX = 0
  try {
    await page.waitForFunction(
      (tx) => Math.abs(window.ww.player.x - tx) > 1.35,
      tile.x,
      { timeout: 45000 },
    )
    outX = await page.evaluate(() => window.ww.player.x)
  } catch {
    outX = await page.evaluate(() => window.ww.player.x)
  }
  await page.keyboard.up('KeyW')
  ok(`walked out through the door (${outX.toFixed(2)})`, Math.abs(outX - tile.x) > 1.35)

  // Force the save (pagehide persists), then read it back
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await page.waitForTimeout(300)
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('waterworld.run.v1')))
  ok('save written', !!saved?.builds?.length)
  ok(
    'carpentry persisted with deck heights',
    !!saved &&
      saved.builds.some((b) => b.kind === 'platform' && typeof b.y === 'number') &&
      saved.builds.some((b) => b.kind === 'wall') &&
      saved.builds.some((b) => b.kind === 'roof'),
  )
  ok('door variant persisted', !!saved && saved.builds.some((b) => b.variant === 'door'))
  ok('run age persisted for the day count', !!saved && typeof saved.runElapsed === 'number')
  await page.close()
}

// —— C: the base is still there after a reload ————————————————————————
{
  const page = await ctxA.newPage()
  page.on('pageerror', (e) => console.log('pageerror:', e.message))
  await page.goto(`${BASE}/`, { waitUntil: 'load' })
  await page.waitForTimeout(3500)
  const c = await page.evaluate(counts)
  ok(
    `base restored (platform ${c.platform}, walls ${c.wall}, roof ${c.roof}, woodpile ${c.woodpile}, ladder ${c.ladder})`,
    c.platform === 3 && c.wall === 4 && c.roof === 1 && c.woodpile === 1 && c.ladder === 1,
  )
  const plats = await page.evaluate(snap, 'platform')
  const ground = plats.reduce((a, b) => ((a.y ?? 0) <= (b.y ?? 0) ? a : b))
  const stand = await page.evaluate(
    (p) => window.ww.improvise.standAt(p.x, p.z, (p.y ?? 0) + 1.62),
    ground,
  )
  ok(`deck walkable after reload (${stand.toFixed(2)})`, Math.abs(stand - (ground.y ?? 0)) < 0.05)
  ok('still Day 2 after reload', (await page.evaluate(dayChip)) === 'Day 2')
  await page.close()
}
await ctxA.close()

// —— B: raft helm + anchor —————————————————————————————————————————
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } })
{
  const page = await ctxB.newPage()
  page.on('pageerror', (e) => console.log('pageerror:', e.message))
  await page.goto(`${BASE}/?hour=12`, { waitUntil: 'load' })
  await page.waitForTimeout(2500)

  // Swim out to real water — a raft lashed in the wash beaches on the spot
  const wade = await page.evaluate(() => {
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
      if (h < -1.4) return { x, z, h }
    }
    return null
  })
  ok('found open water', !!wade)
  await teleport(page, wade.x, wade.z, 1.5, 'swim')
  await page.waitForTimeout(800)
  await page.evaluate(() => {
    const isl = window.ww.island
    const p = window.ww.player
    const dx = p.x - isl.centre.x
    const dz = p.z - isl.centre.z
    p.yaw = Math.atan2(-dx, -dz) + Math.PI // forward = away from centre
  })
  await fillStash(page)
  await page.waitForTimeout(400)

  ok('Lash Raft available', await waitRecipe(page, 'Raft'))
  ok('raft built', (await page.evaluate(counts)).raft === 1)
  const [raft] = await page.evaluate(snap, 'raft')

  // Aboard: drop onto the deck, then rig the sail
  await teleport(page, raft.x, raft.z, 3.2, 'walk')
  await page.waitForTimeout(500)
  ok('Rig Sail available', await waitRecipe(page, 'Sail'))
  ok('sail rigged', (await page.evaluate(snap, 'raft'))[0].mast === true)

  // Helm: stand at the stern, look down, push — she goes where you look
  const [r1] = await page.evaluate(snap, 'raft')
  await page.evaluate((r) => {
    const c = Math.cos(r.yaw)
    const s = Math.sin(r.yaw)
    const p = window.ww.player
    p.x = r.x + 1.2 * c
    p.z = r.z - 1.2 * s
    p.y = 3.2
    p.vy = 0
    p.mode = 'walk'
    p.yaw = -Math.PI / 2 // face +x
    p.pitch = -0.55
  }, r1)
  await page.waitForTimeout(400)
  const before = await page.evaluate(() => {
    const [r] = window.ww.improvise.snapshot().filter((b) => b.kind === 'raft')
    return { x: r.x, z: r.z, t: window.ww.vitals.elapsed }
  })
  await page.keyboard.down('KeyW')
  let after = before
  try {
    await page.waitForFunction(
      (bx) => {
        const [r] = window.ww.improvise.snapshot().filter((b) => b.kind === 'raft')
        return r && r.x - bx > 1.2
      },
      before.x,
      { timeout: 45000 },
    )
  } catch {
    /* fall through to the assertion */
  }
  await page.keyboard.up('KeyW')
  after = await page.evaluate(() => {
    const [r] = window.ww.improvise.snapshot().filter((b) => b.kind === 'raft')
    return { x: r.x, z: r.z, t: window.ww.vitals.elapsed }
  })
  const helmDx = after.x - before.x
  const helmSpeed = Math.hypot(helmDx, after.z - before.z) / Math.max(0.1, after.t - before.t)
  ok(`helm drives toward the look (${helmDx.toFixed(2)} m +x)`, helmDx > 1.0)
  ok(`helm beats passive sail speed (${helmSpeed.toFixed(2)} m/s)`, helmSpeed > 1.1)

  // Feet stay planted while driving — MOVE must not stroll you over the lip
  await page.evaluate((r) => {
    const c = Math.cos(r.yaw)
    const s = Math.sin(r.yaw)
    const p = window.ww.player
    p.x = r.x + 0.3 * c
    p.z = r.z - 0.3 * s
    p.y = 3.2
    p.vy = 0
    p.mode = 'walk'
    p.yaw = -Math.PI / 2
    p.pitch = -0.55
  }, (await page.evaluate(snap, 'raft'))[0])
  await page.waitForTimeout(300)
  const plantBefore = await page.evaluate(() => {
    const [r] = window.ww.improvise.snapshot().filter((b) => b.kind === 'raft')
    return { rx: r.x, rz: r.z, radius: r.radius }
  })
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(2800)
  await page.keyboard.up('KeyW')
  const plantResult = await page.evaluate((b) => {
    const [r] = window.ww.improvise.snapshot().filter((b) => b.kind === 'raft')
    const p = window.ww.player
    return {
      mode: p.mode,
      dist: Math.hypot(p.x - r.x, p.z - r.z),
      moved: Math.hypot(r.x - b.rx, r.z - b.rz),
      radius: r.radius,
    }
  }, plantBefore)
  ok(
    `feet planted while poling (dist ${plantResult.dist.toFixed(2)}, mode ${plantResult.mode})`,
    plantResult.mode === 'walk' && plantResult.dist < plantResult.radius * 0.85,
  )
  ok(`hull still drove with planted feet (${plantResult.moved.toFixed(2)} m)`, plantResult.moved > 0.8)

  // Anchor from aboard — Pack → Camp carries the verb too
  ok('Drop Anchor available', await waitRecipe(page, 'Anchor', 'Drop'))
  ok('anchor down', (await page.evaluate(snap, 'raft'))[0].anchored === true)

  // She holds against the helm while the stone is down
  const anchoredAt = await page.evaluate(() => {
    const [r] = window.ww.improvise.snapshot().filter((b) => b.kind === 'raft')
    return { x: r.x, z: r.z }
  })
  await page.evaluate(() => {
    window.ww.player.yaw = -Math.PI / 2
    window.ww.player.pitch = -0.55
  })
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(900)
  await page.keyboard.up('KeyW')
  const heldAt = await page.evaluate(() => {
    const [r] = window.ww.improvise.snapshot().filter((b) => b.kind === 'raft')
    return { x: r.x, z: r.z }
  })
  const drift = Math.hypot(heldAt.x - anchoredAt.x, heldAt.z - anchoredAt.z)
  ok(`anchored hull holds (${drift.toFixed(2)} m)`, drift < 0.3)

  // Weigh and she's free again — re-seat on the deck in case the hold walk
  // edged you off the lip (headless physics is sticky).
  const [rAnchor] = await page.evaluate(snap, 'raft')
  await teleport(page, rAnchor.x, rAnchor.z, 3.2, 'walk')
  await page.waitForTimeout(400)
  ok('Weigh Anchor available', await waitRecipe(page, 'Anchor', 'Weigh'))
  ok('anchor weighed', (await page.evaluate(snap, 'raft'))[0].anchored === false)

  // —— upgrades: oar, floats, deck expand + radius restore ————————————————
  await teleport(page, (await page.evaluate(snap, 'raft'))[0].x, (await page.evaluate(snap, 'raft'))[0].z, 3.2, 'walk')
  await page.waitForTimeout(400)
  ok('Lash Oar available', await waitRecipe(page, 'Oar'))
  ok('oar lashed', (await page.evaluate(snap, 'raft'))[0].oar === true)
  ok('Lash Floats available', await waitRecipe(page, 'Floats'))
  ok('floats lashed', (await page.evaluate(snap, 'raft'))[0].floats === true)

  const beforeExpand = await page.evaluate(snap, 'raft')
  const baseRadius = beforeExpand[0].radius
  ok('Lash Deck available', await waitRecipe(page, 'Deck'))
  ok('Lash Deck available again', await waitRecipe(page, 'Deck'))
  const afterExpand = (await page.evaluate(snap, 'raft'))[0]
  ok(`deck expanded twice (${afterExpand.expands})`, afterExpand.expands === 2)
  ok(
    `radius grew with expands (${baseRadius?.toFixed(2)} → ${afterExpand.radius?.toFixed(2)})`,
    Math.abs((afterExpand.radius ?? 0) - (baseRadius ?? 0) - 0.84) < 0.02,
  )

  // Craft status chip while aboard
  const craftOn = await page.evaluate(() => {
    const el = document.querySelector('#craft')
    return !!el && el.classList.contains('on') && (el.textContent?.length ?? 0) > 0
  })
  ok('craft status chip shows while aboard', craftOn)

  // Save / restore keeps expand radius (was 0.38 vs 0.42 mismatch)
  const saved = await page.evaluate(() => {
    const snap = window.ww.improvise.snapshot()
    window.ww.improvise.restore(snap)
    return window.ww.improvise.snapshot().find((b) => b.kind === 'raft')
  })
  ok('expands survive restore', saved?.expands === 2)
  ok(
    `expand radius survives restore (${saved?.radius?.toFixed(2)})`,
    Math.abs((saved?.radius ?? 0) - (afterExpand.radius ?? 0)) < 0.02,
  )
  ok('oar/floats/mast survive restore', saved?.oar && saved?.floats && saved?.mast)

  await page.close()
}
await ctxB.close()

console.log(fails.length === 0 ? 'BASE: all green' : `BASE: ${fails.length} failure(s)`)
await browser.close()
process.exit(fails.length === 0 ? 0 : 1)
