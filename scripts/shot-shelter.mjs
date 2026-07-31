// Shelter smoke test: the reef spire you can stand on, the gear locker's
// immersion suit, and the warmth each of them actually gives back.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173'
const CHROME = '/usr/local/bin/google-chrome'
const OUT = '/tmp/shots'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
})

let bad = 0
async function page(viewport = { width: 1280, height: 720 }) {
  const p = await browser.newPage({ viewport })
  p.on('console', (m) => {
    if (/deprecated/.test(m.text())) return
    // Headless has no user gesture, so the audio context always complains
    if (/AudioContext was not allowed to start/.test(m.text())) return
    if (m.type() === 'error' || m.type() === 'warning') {
      bad++
      console.log(`  ${m.type()}: ${m.text()}`)
    }
  })
  p.on('pageerror', (e) => {
    bad++
    console.log(`  pageerror: ${e.message}`)
  })
  return p
}

const state = (p) =>
  p.evaluate(() => {
    const ww = window.ww
    return {
      walking: ww.player.mode === 'walk',
      y: +ww.player.y.toFixed(2),
      warmth: +ww.vitals.warmth.toFixed(4),
      suited: ww.vitals.suited,
      regime: ww.climate.state.regime,
      storm: +ww.climate.state.storm.toFixed(2),
    }
  })

const whisper = (p) => p.evaluate(() => document.querySelector('#whisper')?.textContent)

// —— the spire: can you stand on it, and does it warm you? ————————————
{
  const p = await page()
  const perch = await (async () => {
    const probe = await page({ width: 640, height: 360 })
    await probe.goto(`${BASE}/`, { waitUntil: 'load' })
    await probe.waitForTimeout(1500)
    const at = await probe.evaluate(() => window.ww.wreck.perch.toArray())
    await probe.close()
    return at
  })()
  console.log('perch at:', perch.map((n) => n.toFixed(1)).join(', '))

  // Spawn cold, in the water at the foot of the ramp, and climb it
  const ramp = await (async () => {
    const probe = await page({ width: 640, height: 360 })
    await probe.goto(`${BASE}/`, { waitUntil: 'load' })
    await probe.waitForTimeout(1400)
    const at = await probe.evaluate(() => window.ww.wreck.perchRamp.toArray())
    await probe.close()
    return at
  })()
  const sx = perch[0] + (ramp[0] - perch[0]) * 1.25
  const sz = perch[2] + (ramp[2] - perch[2]) * 1.25
  await p.goto(`${BASE}/?x=${sx.toFixed(1)}&z=${sz.toFixed(1)}&warmth=0.3&calm=1`, {
    waitUntil: 'load',
  })
  await p.waitForTimeout(1400)
  const before = await state(p)
  console.log('[spire] in the water at the ramp foot:', JSON.stringify(before))

  // Face the shelf and climb. The ramp is a long shallow grade on purpose, so
  // this steers back onto the shelf each beat rather than swimming blind.
  const aim = async () => {
    await p.evaluate((at) => {
      const ww = window.ww
      ww.player.yaw = Math.atan2(-(at[0] - ww.player.x), -(at[2] - ww.player.z))
    }, perch)
  }
  await aim()
  await p.keyboard.down('KeyW')
  let ashore = false
  for (let i = 0; i < 30 && !ashore; i++) {
    await p.waitForTimeout(900)
    await aim()
    ashore = await p.evaluate(
      () => window.ww.player.mode === 'walk' && window.ww.wreck.standAt(window.ww.player.x, window.ww.player.z) > 0.3,
    )
  }
  await p.keyboard.up('KeyW')
  await p.waitForTimeout(1500)

  const standing = await state(p)
  console.log('[spire] after swimming at it:', JSON.stringify(standing))
  console.log('[spire] whisper:', JSON.stringify(await whisper(p)))
  await p.screenshot({ path: `${OUT}/perch-standing.png` })

  // Warmth should climb while out of the water
  await p.waitForTimeout(6000)
  const warmed = await state(p)
  console.log('[spire] after 6s ashore:', JSON.stringify(warmed))
  console.log(
    standing.walking && warmed.warmth > standing.warmth
      ? '  PASS: standing on the spire and warming'
      : `  FAIL: walking=${standing.walking} warmth ${standing.warmth} → ${warmed.warmth}`,
  )
  if (!standing.walking || warmed.warmth <= standing.warmth) bad++
  await p.close()
}

// —— the gear locker: pry it with the knife, wear the suit ————————————
{
  const p = await page()
  await p.goto(`${BASE}/?knife=1&calm=1`, { waitUntil: 'load' })
  await p.waitForTimeout(1500)

  const gear = await p.evaluate(() => window.ww.wreck.gearSpot().toArray())
  console.log('gear locker at:', gear.map((n) => n.toFixed(1)).join(', '))

  // Drop the eye right in front of the locker, facing it
  const sx = gear[0] + 1.1
  const sz = gear[2] + 1.1
  const depth = Math.max(0.5, -gear[1])
  const yaw = Math.atan2(-(gear[0] - sx), -(gear[2] - sz))
  await p.goto(
    `${BASE}/?knife=1&calm=1&x=${sx.toFixed(1)}&z=${sz.toFixed(1)}&depth=${depth.toFixed(1)}&yaw=${yaw.toFixed(2)}`,
    { waitUntil: 'load' },
  )
  await p.waitForTimeout(1600)

  // Hold position at depth and read the prompt
  const holdAndUse = async (label) => {
    await p.keyboard.down('ShiftLeft')
    await p.waitForTimeout(900)
    await p.keyboard.up('ShiftLeft')
    await p.waitForTimeout(300)
    const prompt = await p.evaluate(() => document.querySelector('#prompt')?.textContent)
    console.log(`[gear] ${label} prompt:`, JSON.stringify(prompt))
    await p.keyboard.press('KeyF')
    await p.waitForTimeout(900)
    return prompt
  }

  await holdAndUse('door')
  await p.screenshot({ path: `${OUT}/gear-open.png` })
  await holdAndUse('suit')
  await p.waitForTimeout(600)

  const after = await p.evaluate(() => ({
    suited: window.ww.vitals.suited,
    gear: window.ww.wreck.gearLockerState,
  }))
  console.log('[gear] after:', JSON.stringify(after), 'whisper:', JSON.stringify(await whisper(p)))
  await p.screenshot({ path: `${OUT}/suit-worn.png` })
  console.log(after.suited ? '  PASS: immersion suit worn' : '  FAIL: suit not worn')
  if (!after.suited) bad++
  await p.close()
}

// —— the hold's tin and the stern's log ————————————————————————————————
{
  const p = await page()
  await p.goto(`${BASE}/`, { waitUntil: 'load' })
  await p.waitForTimeout(1500)
  const spots = await p.evaluate(() => ({
    tin: window.ww.wreck.tinSpot().toArray(),
    log: window.ww.wreck.logSpot().toArray(),
  }))

  for (const [name, at] of Object.entries(spots)) {
    const sx = at[0] + 1.1
    const sz = at[2] + 1.1
    const depth = Math.max(0.5, -at[1])
    const yaw = Math.atan2(-(at[0] - sx), -(at[2] - sz))
    await p.goto(
      `${BASE}/?calm=1&x=${sx.toFixed(1)}&z=${sz.toFixed(1)}&depth=${depth.toFixed(1)}&yaw=${yaw.toFixed(2)}&pitch=-0.3`,
      { waitUntil: 'load' },
    )
    await p.waitForTimeout(1400)
    // Hold the dive so buoyancy can't lift you off the find mid-reach
    await p.keyboard.down('ShiftLeft')
    let used = false
    for (let i = 0; i < 14 && !used; i++) {
      await p.waitForTimeout(260)
      const prompt = await p.evaluate(() => document.querySelector('#prompt')?.textContent ?? '')
      if (prompt.includes('tin') || prompt.includes('log')) {
        await p.keyboard.press('KeyF')
        await p.waitForTimeout(500)
        used = await p.evaluate(
          (which) =>
            which === 'tin'
              ? window.ww.wreck.tinSpot() === null
              : window.ww.wreck.logSpot() === null,
          name,
        )
      }
    }
    await p.keyboard.up('ShiftLeft')
    await p.waitForTimeout(900)
    console.log(`[${name}] taken:`, used, 'whisper:', JSON.stringify(await whisper(p)))
    if (!used) bad++
  }
  await p.screenshot({ path: `${OUT}/deep-finds.png` })
  await p.close()
}

// —— weather: long spells, mostly fair ————————————————————————————————
{
  const p = await page({ width: 640, height: 360 })
  await p.goto(`${BASE}/`, { waitUntil: 'load' })
  await p.waitForTimeout(1200)
  const seen = await p.evaluate(async () => {
    const out = []
    for (let i = 0; i < 40; i++) {
      out.push(window.ww.climate.state.regime)
      await new Promise((r) => setTimeout(r, 120))
    }
    return out
  })
  const unique = [...new Set(seen)]
  console.log('[weather] regimes seen over ~5s:', unique.join(', '))
  console.log(
    unique.length === 1 ? '  PASS: a spell holds rather than flickering' : '  NOTE: spell changed',
  )
  await p.close()
}

await browser.close()
console.log(bad ? `\n${bad} problem(s)` : '\nall shelter checks passed')
process.exit(bad ? 1 : 0)
