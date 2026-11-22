// Shoot the islanders, their camp and the encounter panel in the running game.
// Needs the dev server (default http://localhost:5175, or set SHOT_BASE).
//
//   node scripts/tribe-shot.mjs                                  the default set
//   TRIBE_VIEWS=oru-face,kael-front,camp-wide node scripts/tribe-shot.mjs
//   SHOT_OUT=shots/tribe/after TRIBE_HOUR=17.5 node scripts/tribe-shot.mjs
//
// Views (each is one fresh page load, so each costs 10-40 s):
//   <id>-front | -face | -side | -back | -far      id = kael, tala, oru (camera placed from where they stand)
//   camp-wide | camp-air | camp-fire | camp-night  the camp clearing
//   camp-above | camp-sea | camp-houses | camp-roof | camp-canoe | camp-hearth-night
//                                                  the camp from over the beach, from the shore below, the two houses
//                                                  from along the hill, from under the sleeping house's roof, the
//                                                  canoe, and the fire close up after dark
//   totem | bag | bills                            the landing beach props (bag and bills drop the bag by the post first)
//   ui-<id> | ui-fire                              the real game (HUD on), player put 3 m in front of them
//
// Options:
//   TRIBE_POSE=beckon_follow   hold that pose on the islander in the view (through applyAiDecision, ~12 s)
//   TRIBE_ACTION=beckon_to_caves   the action sent with it (default idle)
//   TRIBE_STRIP=6              six frames 0.35 s apart, saved as name-0.png … name-5.png (to judge motion)
//   TRIBE_FOLLOW=1             with a strip: re-aim the camera at the islander before every frame
//   TRIBE_KEYS=KeyE,Digit1     ui views: press these keys (0.6 s apart) before the picture
//   TRIBE_PHONE=1              ui views: a 390x844 touch phone
//   TRIBE_QUALITY=full         default light
//   TRIBE_SOFT=1               software rendering instead of the laptop's GPU (slow; only if the GPU launch fails)
//   TRIBE_SETTLE=40            frames to wait after placing the camera (default 40)
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5175'
const OUT = process.env.SHOT_OUT ?? 'shots/tribe'
const HOUR = Number(process.env.TRIBE_HOUR ?? 10)
const QUALITY = process.env.TRIBE_QUALITY ?? 'light'
const STRIP = Number(process.env.TRIBE_STRIP ?? 0)
const SETTLE = Number(process.env.TRIBE_SETTLE ?? 40)
const POSE = process.env.TRIBE_POSE ?? ''
const ACTION = process.env.TRIBE_ACTION ?? 'idle'
const KEYS = (process.env.TRIBE_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const PHONE = !!process.env.TRIBE_PHONE
const DEFAULT = ['kael-front', 'kael-face', 'tala-front', 'tala-face', 'oru-front', 'oru-face', 'camp-wide', 'camp-night']
const views = (process.env.TRIBE_VIEWS ?? DEFAULT.join(',')).split(',').map((s) => s.trim()).filter(Boolean)

// Camp fire and landing on today's island; only used to choose where the page loads.
const CAMP = [758.5, -752.5]
const LANDING = [771, -522]

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({
  executablePath: CHROME,
  args: process.env.TRIBE_SOFT
    ? ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
    : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const noise = /THREE.Clock: This module has been deprecated|AudioContext was not allowed to start|X4122|\[vite\]/
let bad = 0

/** Runs in the page: put the film camera on a view. Returns what it aimed at. */
function aim([view, hour]) {
  const f = window.__film
  const w = window.ww
  f.hour(hour)
  const look = (cx, cy, cz, tx, ty, tz) => {
    const dx = tx - cx
    const dz = tz - cz
    f.camera(cx, cy, cz, Math.atan2(-dx, -dz), Math.atan2(ty - cy, Math.hypot(dx, dz)))
  }
  const m = /^(kael|tala|oru)-(front|face|side|back|far)$/.exec(view)
  if (m) {
    const id = m[1]
    const s = w.tribe.getNpcState(id)
    const rig = w.tribe.npcs.find((n) => n.id === id).rig
    const h = rig.height ?? 1.7
    const seated = s.pose === 'sit_fire'
    const head = s.position.y + (seated ? h * 0.52 : h * 0.93)
    const mid = s.position.y + (seated ? h * 0.35 : h * 0.58)
    const fx = -Math.sin(s.yaw)
    const fz = -Math.cos(s.yaw)
    const sx = -fz
    const sz = fx
    const spot = {
      front: [3.2, 0.7, mid + 0.25, mid],
      face: [1.15, 0.18, head + 0.02, head - 0.03],
      side: [0.3, 3.1, mid + 0.25, mid],
      back: [-3.2, 0.6, mid + 0.3, mid],
      far: [11, 2.5, mid + 0.6, mid],
    }[m[2]]
    const cx = s.position.x + fx * spot[0] + sx * spot[1]
    const cz = s.position.z + fz * spot[0] + sz * spot[1]
    const cy = Math.max(f.ground(cx, cz) + 0.35, spot[2])
    look(cx, cy, cz, s.position.x, spot[3], s.position.z)
    return { id, pose: s.pose, activity: s.activity, at: [s.position.x, s.position.y, s.position.z].map((v) => +v.toFixed(1)) }
  }
  const p = w.places
  const fire = p.campFire
  const out = p.outward ?? { x: 0, z: 1 }
  if (view === 'camp-wide' || view === 'camp-night') {
    const cx = fire.x + 7.5
    const cz = fire.z + 6.5
    look(cx, f.ground(cx, cz) + 1.9, cz, fire.x, fire.y + 0.9, fire.z)
  } else if (view === 'camp-air') {
    look(fire.x + 9, fire.y + 15, fire.z + 9, fire.x, fire.y, fire.z)
  } else if (view === 'camp-fire') {
    const cx = fire.x + 2.2
    const cz = fire.z + 1.6
    look(cx, f.ground(cx, cz) + 0.9, cz, fire.x, fire.y + 0.45, fire.z)
  } else if (view === 'camp-above') {
    // Out over the beach, clear of the trees that stand over the fire
    look(fire.x - 9, fire.y + 13, fire.z + 3, fire.x + 1, fire.y, fire.z - 4)
  } else if (view === 'camp-hearth-night') {
    const cx = fire.x + 2.6
    const cz = fire.z + 1.9
    look(cx, f.ground(cx, cz) + 1.1, cz, fire.x, fire.y + 0.5, fire.z)
  } else if (/^camp-(sea|houses|roof|canoe)$/.test(view)) {
    // Placed from where the camp's own things ended up (they move to stand clear of the trees)
    const site = (id) => w.heistProps.group.userData.camp.sites.find((s) => s.id === id)
    const house = site('sleeping_house')
    const canoe = site('canoe')
    if (view === 'camp-sea') {
      // Standing at the canoe, looking up the hill at the camp
      const cx = canoe.x - (fire.x - canoe.x) * 0.25
      const cz = canoe.z - (fire.z - canoe.z) * 0.25
      look(cx, f.ground(cx, cz) + 1.7, cz, (fire.x + house.x) / 2, fire.y + 1.5, (fire.z + house.z) / 2)
    } else if (view === 'camp-houses') {
      const dx = house.x - fire.x
      const dz = house.z - fire.z
      const l = Math.hypot(dx, dz) || 1
      // From beyond the sleeping house and a little down the hill, looking back along it
      const cx = house.x + (dx / l) * 9 + (dz / l) * 3
      const cz = house.z + (dz / l) * 9 - (dx / l) * 3
      look(cx, f.ground(cx, cz) + 1.7, cz, house.x, house.y + 2, house.z)
    } else if (view === 'camp-roof') {
      // A walker's eye under the sleeping house's eave, looking back at the fire
      look(house.x, f.ground(house.x, house.z) + 1.62, house.z, fire.x, fire.y + 0.6, fire.z)
    } else {
      // From the water's edge below her and a little along the beach, so the camp is behind her
      const dx = canoe.x - fire.x
      const dz = canoe.z - fire.z
      const l = Math.hypot(dx, dz) || 1
      const cx = canoe.x + (dx / l) * 4.5 - (dz / l) * 3.5
      const cz = canoe.z + (dz / l) * 4.5 + (dx / l) * 3.5
      look(cx, Math.max(f.ground(cx, cz), 0.4) + 1.6, cz, canoe.x, canoe.y + 0.4, canoe.z)
    }
  } else if (view === 'totem') {
    const t = p.totem
    const cx = t.x - 3.4
    const cz = t.z + 2.2
    look(cx, f.ground(cx, cz) + 1.5, cz, t.x, t.y + 1.2, t.z)
  } else if (view === 'bag' || view === 'bills') {
    // In your hands it is nowhere to be looked at: put it down by the post (and, for the bills, shake some out)
    if (w.heistProps.bag.state === 'carried') {
      const t = p.totem
      const at = t.clone()
      at.x += 2.2
      at.z += 1
      at.y = f.ground(at.x, at.z) + 0.3
      w.heistProps.bag.drop(at)
      if (view === 'bills') {
        at.y += 0.7
        w.heistProps.burstCashBills(at, 40)
      }
    }
    const b = w.heistProps.bag.position
    const cx = b.x + 1.8
    const cz = b.z + 1.5
    look(cx, f.ground(cx, cz) + 0.9, cz, b.x, b.y + 0.2, b.z)
  } else {
    throw new Error('unknown view ' + view)
  }
  void out
  return { view }
}

for (const view of views) {
  const ui = view.startsWith('ui-')
  const hour = view === 'camp-night' || view === 'camp-hearth-night' ? 21 : HOUR
  const context = await browser.newContext(
    ui && PHONE
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1280, height: 720 } },
  )
  const page = await context.newPage()
  page.on('console', (m) => {
    if (noise.test(m.text())) return
    if (m.type() === 'error' || m.type() === 'warning') {
      bad++
      console.log(`[${view}] ${m.type()}: ${m.text().slice(0, 300)}`)
    }
  })
  page.on('pageerror', (e) => {
    bad++
    console.log(`[${view}] pageerror: ${e.message}`)
  })
  const near = /^(totem|bag|bills)$/.test(view) ? LANDING : CAMP
  const save = (suffix = '') => page.screenshot({ path: `${OUT}/${view}${suffix}.png`, timeout: 150000 })
  const id = /(kael|tala|oru)/.exec(view)?.[1]
  const hold = () =>
    POSE && id ? page.evaluate(([i, a, p]) => window.ww.tribe.applyAiDecision(i, a, p), [id, ACTION, POSE]) : null

  if (ui) {
    await page.goto(`${BASE}/?x=${near[0]}&z=${near[1]}&hour=${hour}&quality=${QUALITY}`, { waitUntil: 'load' })
    await page.waitForFunction(() => !!window.ww?.tribe, null, { timeout: 150000 })
    await page.waitForTimeout(7000)
    const info = await page.evaluate((v) => {
      const w = window.ww
      const target = v === 'ui-fire' ? null : v.slice(3)
      let tx, tz, fx, fz
      if (target) {
        const s = w.tribe.getNpcState(target)
        tx = s.position.x
        tz = s.position.z
        fx = -Math.sin(s.yaw)
        fz = -Math.cos(s.yaw)
      } else {
        tx = w.places.campFire.x
        tz = w.places.campFire.z
        fx = 0.7
        fz = 0.7
      }
      w.player.x = tx + fx * 3
      w.player.z = tz + fz * 3
      w.player.yaw = Math.atan2(-(tx - w.player.x), -(tz - w.player.z))
      if ('pitch' in w.player) w.player.pitch = -0.08
      return { target: target ?? 'fire', player: [w.player.x, w.player.z].map((n) => +n.toFixed(1)) }
    }, view)
    console.log(`[${view}]`, JSON.stringify(info))
    await page.waitForTimeout(2500)
    await hold()
    for (const key of KEYS) {
      await page.keyboard.press(key)
      await page.waitForTimeout(600)
    }
    await page.waitForTimeout(900)
    await save()
  } else {
    await page.goto(`${BASE}/?film=1&x=${near[0]}&z=${near[1]}&hour=${hour}&quality=${QUALITY}`, { waitUntil: 'load' })
    await page.waitForFunction(() => (window.__film?.frames ?? 0) > 2 && !!window.ww?.tribe, null, { timeout: 150000 })
    // First aim brings the islander into range so the sim shows and updates them; then aim again where they now stand.
    await page.evaluate(aim, [view, hour])
    await page.waitForTimeout(1500)
    await hold()
    if (POSE) await page.waitForTimeout(900)
    const info = await page.evaluate(aim, [view, hour])
    console.log(`[${view}]`, JSON.stringify(info))
    const start = await page.evaluate(() => window.__film.frames)
    await page.waitForFunction((n) => window.__film.frames > n, start + SETTLE, { timeout: 150000 })
    if (STRIP > 0) {
      for (let i = 0; i < STRIP; i++) {
        if (process.env.TRIBE_FOLLOW) await page.evaluate(aim, [view, hour])
        await save(`-${i}`)
        await page.waitForTimeout(350)
      }
    } else {
      await save()
    }
  }
  console.log(`[${view}] captured`)
  await context.close()
}
await browser.close()
console.log(bad === 0 ? 'CLEAN' : `${bad} console problem(s)`)
