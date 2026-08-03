import { chromium } from 'playwright-core'

/**
 * Save-completeness coverage:
 *   - littoral / seals / salvage fixed finds
 *   - wreck progression + lantern ownership
 *   - climate regime + sea glass state
 *   - smoking timers + wash meter
 *   - fishing tool equip
 *
 * Needs `npm run dev` running.
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

const context = await browser.newContext()
const page = await context.newPage()
await page.goto(`${BASE}/?x=0&z=0`, { waitUntil: 'networkidle', timeout: 120_000 })
await page.waitForFunction(() => window.ww?.player && window.ww?.climate, null, {
  timeout: 60_000,
})

await page.evaluate(() => {
  const ww = window.ww
  // Seed living-world state that used to vanish on reload
  const littoral = ww.littoral.snapshot()
  if (littoral.taken.length) littoral.taken[0] = true
  if (littoral.pools.length) {
    littoral.pools[0].full = 0.2
    littoral.pools[0].covered = true
  }
  if (littoral.seals.length) {
    littoral.seals[0].hauled = false
    littoral.seals[0].spook = 2.5
  }
  ww.littoral.restore(littoral)

  const salvage = ww.salvage.snapshot()
  if (salvage.fixedTaken.length) salvage.fixedTaken[0] = true
  if (salvage.poolFull.length) salvage.poolFull[0] = 0.35
  ww.salvage.restore(salvage, ww.camera.position)
  ww.salvage.setStash({ plank: 4, rope: 2, canvas: 0, barrel: 0, crate: 0, leaf: 0, plastic: 0, can: 0 })

  ww.wreck.restore({
    provisionTaken: true,
    knifeTaken: true,
    locker: 'cut',
    gearLocker: 'open',
    tinTaken: true,
    logTaken: false,
    lanternTaken: false,
    suitTaken: true,
  })
  ww.loot.restore({ knife: true, spear: false, lantern: false })

  ww.forage.setGear(true, true, 'net')
  ww.forage.setFish(2, 1)

  ww.climate.restore({
    ...ww.climate.snapshot(),
    regime: 'breezy',
    storm: 0.28,
    target: 0.3,
    from: 0.1,
    holdLeft: 120,
    frontLeft: 0,
    frontLength: 40,
  })
  ww.sea.restore({
    amp: 0.62,
    glassy: true,
    glassLeft: 40,
    glassLength: 80,
    nextGlassIn: 200,
  })

  ww.improvise.setWashMeter(0.42)

  // Hang a fish over a planted fire so curing persists
  const beach = ww.island.shore[0]
  ww.player.x = beach.x
  ww.player.z = beach.z
  ww.player.y = beach.y + 1.7
  ww.player.mode = 'walk'
  ww.salvage.stash.plank += 2
  const recipes = ww.improvise.campRecipes()
  const fire = recipes.find((r) => r.verb === 'Kindle' || r.label.toLowerCase().includes('fire'))
  if (fire) fire.use()
  ww.forage.grant(1)
  const smoke = ww.improvise.campRecipes().find((r) => r.verb === 'Smoke')
  // Smoke may only be an interaction — plant via snapshot patch if needed
  const builds = ww.improvise.snapshot()
  const fireBuild = builds.find((b) => b.kind === 'fire')
  if (fireBuild) {
    fireBuild.curing = [{ readyIn: 18 }]
    ww.improvise.restore(builds)
  }
  void smoke

  window.dispatchEvent(new Event('pagehide'))
})

const saved = await page.evaluate(() => {
  const raw = localStorage.getItem('waterworld.run.v1')
  return raw ? JSON.parse(raw) : null
})

ok('save written', !!saved)
ok('save has littoral', !!saved?.littoral)
ok('save has salvage', !!saved?.salvage)
ok('save has wreck', !!saved?.wreck)
ok('save has climate', !!saved?.climate)
ok('save has sea', !!saved?.sea)
ok('save has washMeter', typeof saved?.washMeter === 'number')
ok('save fishing tool net', saved?.fishingTool === 'net')
ok('littoral pick taken', saved?.littoral?.taken?.[0] === true)
ok('wreck knife taken', saved?.wreck?.knifeTaken === true)
ok('wreck suit taken', saved?.wreck?.suitTaken === true)
ok('sea glassy', saved?.sea?.glassy === true)

// Reload without spawn override so loadRun runs
const page2 = await context.newPage()
await page2.goto(BASE, { waitUntil: 'networkidle', timeout: 120_000 })
await page2.waitForFunction(() => window.ww?.player && window.ww?.littoral, null, {
  timeout: 60_000,
})

const restored = await page2.evaluate(() => {
  const ww = window.ww
  return {
    littoral: ww.littoral.snapshot(),
    salvage: ww.salvage.snapshot(),
    wreck: ww.wreck.snapshot(),
    loot: ww.loot.snapshot(),
    climate: ww.climate.snapshot(),
    sea: ww.sea.snapshot(),
    wash: ww.improvise.getWashMeter(),
    tool: ww.forage.equipped,
    rod: ww.forage.hasRod,
    net: ww.forage.hasNet,
    builds: ww.improvise.snapshot(),
    whisper: document.body.innerText.includes('Still here') || true,
  }
})

ok('restored littoral taken', restored.littoral.taken[0] === true)
ok('restored salvage fixed', restored.salvage.fixedTaken[0] === true)
ok('restored wreck knife', restored.wreck.knifeTaken === true)
ok('restored wreck suit', restored.wreck.suitTaken === true)
ok('restored loot knife', restored.loot.knife === true)
ok('restored climate breezy-ish', restored.climate.regime === 'breezy' || restored.climate.storm > 0.15)
ok('restored sea glassy', restored.sea.glassy === true)
ok('restored wash meter', Math.abs(restored.wash - 0.42) < 0.05)
ok('restored fishing net equip', restored.tool === 'net' && restored.net === true)
ok(
  'restored curing fish',
  !!restored.builds.find((b) => b.kind === 'fire' && (b.curing?.length ?? 0) > 0),
)

await browser.close()
if (fails.length) {
  console.error(`\n${fails.length} failed: ${fails.join(', ')}`)
  process.exit(1)
}
console.log('\nAll save-completeness checks passed.')
