/**
 * Smoke: beached raft sits on sand, bow walk stays aboard, Shove clears shelf.
 * Needs `npm run dev` (default http://127.0.0.1:5173).
 */
import { chromium } from 'playwright-core'

const CHROME = process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome'
const BASE = process.env.SHOT_BASE ?? 'http://127.0.0.1:5173'

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const fails = []
const ok = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`)
  if (!cond) fails.push(name)
}

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.log('pageerror:', e.message))

await page.goto(`${BASE}/?x=775&z=-532&yaw=-1.02&pitch=-0.2`, { waitUntil: 'load' })
await page.waitForFunction(() => !!window.ww?.improvise, null, { timeout: 30000 })
await page.waitForTimeout(2000)

const result = await page.evaluate(() => {
  const ww = window.ww
  // Place on the true wash — sand just above the sea — not the inland shore marker
  const s0 = ww.island.shore[0]
  const c = ww.island.centre
  const dx = s0.x - c.x
  const dz = s0.z - c.z
  const len = Math.hypot(dx, dz) || 1
  let sandX = s0.x
  let sandZ = s0.z
  for (let r = 40; r <= 90; r += 2) {
    const x = s0.x + (dx / len) * r
    const z = s0.z + (dz / len) * r
    const h = ww.island.heightAt(x, z)
    if (h > 0.2 && h < 1.2) {
      sandX = x
      sandZ = z
      break
    }
  }
  const sandY = ww.island.heightAt(sandX, sandZ)

  // No mast — Rest under sail must not steal Shove from the F prompt
  ww.improvise.restore([
    {
      kind: 'raft',
      x: sandX,
      z: sandZ,
      yaw: 0.4,
      buoyant: true,
      locker: true,
      beached: true,
    },
  ])

  const player = ww.player
  player.x = sandX
  player.z = sandZ
  player.y = sandY + 1.7
  player.mode = 'walk'
  player.submersion = 0
  player.vy = 0
  player.speed = 0
  player.yaw = 0.4
  player.pitch = -0.45

  const view = {
    walking: true,
    groundY: sandY,
    submersion: 0,
    speed: 0,
  }
  for (let i = 0; i < 8; i++) {
    ww.improvise.update(0.05, i * 0.05, player, view, 0.4, {})
  }

  const stand = ww.improvise.standAt(sandX, sandZ)
  const before = ww.improvise.snapshot().find((b) => b.kind === 'raft')

  const heading = before.yaw ?? 0.4
  const cos = Math.cos(heading)
  const sin = Math.sin(heading)
  const frontX = sandX + -1.85 * cos
  const frontZ = sandZ - -1.85 * sin
  player.x = frontX
  player.z = frontZ
  player.dirX = (frontX - sandX) / 1.85
  player.dirZ = (frontZ - sandZ) / 1.85
  player.speed = 1.5
  view.speed = 1.5
  view.groundY = ww.improvise.standAt(frontX, frontZ)

  for (let i = 0; i < 24; i++) {
    player.speed = 1.5
    view.speed = 1.5
    ww.improvise.update(0.05, 1 + i * 0.05, player, view, heading, {})
  }

  const afterBow = {
    mode: player.mode,
    dist: Math.hypot(player.x - sandX, player.z - sandZ),
  }

  player.x = before.x
  player.z = before.z
  player.y = stand + 1.62
  player.mode = 'walk'
  player.speed = 0
  player.submersion = 0
  view.speed = 0
  view.walking = true
  view.groundY = stand

  let shoved = false
  let prompt = ''
  const seen = []
  for (let attempt = 0; attempt < 24; attempt++) {
    player.yaw = attempt * 0.3
    ww.camera.position.set(player.x, player.y, player.z)
    ww.camera.rotation.order = 'YXZ'
    ww.camera.rotation.y = player.yaw
    ww.camera.rotation.x = player.pitch
    ww.improvise.update(0.05, 3 + attempt * 0.05, player, view, player.yaw, {})
    const hit = ww.interactions.find(ww.camera)
    if (hit) seen.push(`${hit.verb} ${hit.label}`)
    if (hit?.verb === 'Shove' && hit.available()) {
      prompt = `${hit.verb} ${hit.label}`
      hit.use()
      shoved = true
      break
    }
  }

  // Tick past shove grace a little while poling — must stay free
  for (let i = 0; i < 40; i++) {
    ww.improvise.update(0.08, 5 + i * 0.08, player, view, player.yaw, { dive: true })
  }

  const afterShove = ww.improvise.snapshot().find((b) => b.kind === 'raft')
  const groundAfter = ww.island.heightAt(afterShove.x, afterShove.z)

  return {
    sandY,
    stand,
    beached: !!before.beached,
    deckNearSand: stand < sandY + 0.45 && stand > sandY - 0.05,
    afterBow,
    shoved,
    prompt,
    seen: [...new Set(seen)].slice(0, 8),
    afterBeached: !!afterShove.beached,
    groundAfter,
    moved: Math.hypot(afterShove.x - before.x, afterShove.z - before.z),
  }
})

console.log(JSON.stringify(result, null, 2))

ok('raft restored beached', result.beached)
ok('deck sits near sand (no wave hover)', result.deckNearSand)
ok('bow walk stays in walk mode', result.afterBow.mode === 'walk')
ok('bow walk stays near deck', result.afterBow.dist < 2.5)
ok(`Shove fired (${result.prompt || result.seen?.join(',') || 'none'})`, result.shoved)
ok('Shove cleared beached flag', !result.afterBeached)
ok('Shove moved hull seaward', result.moved > 2)
ok('Shove reached wet shelf', result.groundAfter < 0.55)

await browser.close()
if (fails.length) {
  console.error('Failed:', fails.join(', '))
  process.exit(1)
}
console.log('raft-shore smoke ok')
