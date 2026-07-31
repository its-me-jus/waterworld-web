// Phase B smoke test: knife, sealed locker, memory + spear, and the armed shark.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const CHROME = '/usr/local/bin/google-chrome'
const OUT = '/tmp/shots'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})

let bad = 0
async function page(viewport = { width: 1280, height: 720 }) {
  const p = await browser.newPage({ viewport })
  p.on('console', (m) => {
    if (/deprecated/.test(m.text())) return
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

const whisper = (p) => p.evaluate(() => document.querySelector('#whisper')?.textContent)
const prompt = (p) => p.evaluate(() => document.querySelector('#prompt')?.textContent)

// —— probe: where did the wreck put the salvage this build? ————————————
const probe = await page({ width: 640, height: 360 })
await probe.goto('http://localhost:5173/', { waitUntil: 'load' })
await probe.waitForTimeout(1500)
const spots = await probe.evaluate(() => window.__spots)
console.log('spots:', JSON.stringify(spots))
await probe.close()

/**
 * Spawn params placing the eye just off a spot, facing it. The swimmer is
 * buoyant, so the spawn alone isn't enough — hover() holds the depth.
 */
function near(spot) {
  const [x, y, z] = spot
  const sx = x + 1.2
  const sz = z + 0.96
  const depth = Math.max(0.5, -(y + 0.5))
  const yaw = Math.atan2(-(x - sx), -(z - sz))
  const pitch = Math.atan2(y - -depth, Math.hypot(x - sx, z - sz))
  return {
    depth,
    url: `x=${sx.toFixed(1)}&z=${sz.toFixed(1)}&depth=${depth.toFixed(1)}&yaw=${yaw.toFixed(2)}&pitch=${pitch.toFixed(2)}`,
  }
}

/** Hold depth by pulsing the dive key off the #depth readout. */
async function hover(p, targetDepth, ms) {
  const until = Date.now() + ms
  let holding = false
  while (Date.now() < until) {
    const d = await p.evaluate(
      () => parseFloat(document.querySelector('#depth')?.textContent ?? '0') || 0,
    )
    if (!holding && d < targetDepth + 0.05) {
      await p.keyboard.down('ShiftLeft')
      holding = true
    } else if (holding && d > targetDepth + 0.45) {
      await p.keyboard.up('ShiftLeft')
      holding = false
    }
    await p.waitForTimeout(110)
  }
  if (holding) await p.keyboard.up('ShiftLeft')
}

// —— the knife on the bow deck ————————————————————————————————————————
{
  const at = near(spots.knife)
  const p = await page()
  await p.goto(`http://localhost:5173/?${at.url}&calm=1`, { waitUntil: 'load' })
  await p.waitForTimeout(1200)
  await hover(p, at.depth, 2200)
  console.log('[knife] prompt:', JSON.stringify(await prompt(p)))
  await hover(p, at.depth, 400)
  await p.screenshot({ path: `${OUT}/knife-prompt.png` })
  await p.keyboard.press('KeyF')
  await p.waitForTimeout(2600)
  console.log('[knife] whisper after F:', JSON.stringify(await whisper(p)))
  await hover(p, at.depth, 300)
  await p.screenshot({ path: `${OUT}/knife-taken.png` })
  await p.close()
}

// —— the sealed locker: no knife, the rope wins ————————————————————————
{
  const at = near(spots.locker)
  const p = await page()
  await p.goto(`http://localhost:5173/?${at.url}&calm=1`, { waitUntil: 'load' })
  await p.waitForTimeout(1200)
  await hover(p, at.depth, 2200)
  console.log('[locker-sealed] prompt:', JSON.stringify(await prompt(p)))
  await hover(p, at.depth, 400)
  await p.screenshot({ path: `${OUT}/locker-sealed.png` })
  await p.keyboard.press('KeyF')
  await p.waitForTimeout(2600)
  console.log('[locker-sealed] whisper after F:', JSON.stringify(await whisper(p)))
  await p.close()
}

// —— with the knife: cut, the lid swings, reach inside ——————————————————
{
  const at = near(spots.locker)
  const p = await page()
  await p.goto(`http://localhost:5173/?${at.url}&calm=1&knife=1`, { waitUntil: 'load' })
  await p.waitForTimeout(1200)
  await hover(p, at.depth, 2000)
  console.log('[locker-cut] prompt:', JSON.stringify(await prompt(p)))
  await p.keyboard.press('KeyF')
  await hover(p, at.depth, 2400)
  console.log('[locker-cut] prompt after cut:', JSON.stringify(await prompt(p)))
  await p.screenshot({ path: `${OUT}/locker-open.png` })
  await p.keyboard.press('KeyF')
  await hover(p, at.depth, 5200)
  console.log('[memory] whisper:', JSON.stringify(await whisper(p)))
  await p.screenshot({ path: `${OUT}/memory.png` })
  await p.waitForTimeout(9000)
  console.log('[memory] late whisper:', JSON.stringify(await whisper(p)))
  await p.screenshot({ path: `${OUT}/spear-held.png` })
  await p.close()
}

// —— the spear answers: armed pass, commit, jab ———————————————————————
{
  const p = await page({ width: 640, height: 360 })
  await p.goto('http://localhost:5173/?depth=6&pitch=0.1&spear=1&shark=4&commit=1', { waitUntil: 'load' })
  await p.waitForFunction(() => window.__shark?.active, null, { timeout: 60000 })
  // Face it as it circles; screenshot the armed pass once it's close
  for (let i = 0; i < 200; i++) {
    const d = await p.evaluate(() => {
      window.__faceShark?.()
      return window.__shark?.distance ?? Infinity
    })
    if (d < 16) break
    await p.waitForTimeout(250)
  }
  await p.screenshot({ path: `${OUT}/shark-armed.png` })
  console.log('[shark-armed] pass close, waiting for the run')

  // Wait for the commit run, then answer it: keep jabbing as it closes — a
  // single F can land between frames (pending is computed per-frame), so
  // spam once it's near and read the outcome off the wound veil
  let outcome = 'no-run'
  try {
    await p.waitForFunction(() => window.__shark?.mode === 'commit', null, { timeout: 120000 })
    for (let i = 0; i < 600; i++) {
      const state = await p.evaluate(() => {
        window.__faceShark?.()
        return {
          d: window.__shark?.distance ?? Infinity,
          mode: window.__shark?.mode,
          veil: Number(document.querySelector('#wound-veil')?.style.opacity ?? 0),
        }
      })
      if (state.veil > 0.05) {
        outcome = 'bitten'
        break
      }
      if (state.mode === 'flee') {
        outcome = 'jabbed'
        break
      }
      if (state.d < 6) await p.keyboard.press('KeyF')
      await p.waitForTimeout(60)
    }
  } catch {
    console.log('[shark-armed] it circled and left without committing')
  }
  await p.waitForTimeout(5200)
  console.log('[shark-armed] outcome:', outcome, '| whisper:', JSON.stringify(await whisper(p)))
  await p.screenshot({ path: `${OUT}/shark-answered.png` })

  if (outcome !== 'jabbed') bad++
  await p.close()
}

// —— the bite you don't answer: the wound veil ————————————————————————
{
  const p = await page({ width: 640, height: 360 })
  await p.goto('http://localhost:5173/?depth=6&spear=1&shark=4&commit=1', { waitUntil: 'load' })
  await p.waitForFunction(() => window.__shark?.active, null, { timeout: 60000 })
  let bitten = false
  try {
    await p.waitForFunction(() => window.__shark?.mode === 'commit', null, { timeout: 120000 })
    // Deliberately don't answer — let the run connect
    await p.waitForFunction(
      () => Number(document.querySelector('#wound-veil')?.style.opacity ?? 0) > 0.1,
      null,
      { timeout: 60000 },
    )
    bitten = true
  } catch {
    console.log('[bite] no commit this encounter — skipping (random roll)')
  }
  if (bitten) {
    await p.waitForTimeout(5500)
    console.log('[bite] whisper:', JSON.stringify(await whisper(p)))
    await p.screenshot({ path: `${OUT}/bitten.png` })
  }
  await p.close()
}

await browser.close()
console.log(bad === 0 ? 'CLEAN: no errors or warnings' : `${bad} console problem(s)`)
