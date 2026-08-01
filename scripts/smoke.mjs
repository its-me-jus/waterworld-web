import { chromium } from 'playwright-core'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5174'

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const fails = []
const ok = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`)
  if (!cond) fails.push(name)
}

// —— A: the wreck's loot chain through the registry ————————————————
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log('pageerror:', e.message))
  await page.goto(`${BASE}/`, { waitUntil: 'load' })
  await page.waitForTimeout(2500)

  const promptText = () =>
    page.evaluate(() => document.querySelector('#prompt span')?.textContent ?? '')
  const tp = (x, y, z) =>
    page.evaluate(([x, y, z]) => {
      const p = window.ww.player
      p.x = x
      p.y = y
      p.z = z
      p.vy = 0
    }, [x, y, z])

  const spots = await page.evaluate(() => window.__spots)
  await tp(...spots.knife)
  await page.waitForTimeout(400)
  const knifePrompt = await promptText()
  ok(`knife prompt shown ("${knifePrompt}")`, /work free/i.test(knifePrompt))
  await page.keyboard.press('KeyF')
  await page.waitForTimeout(300)
  ok('knife taken', await page.evaluate(() => window.ww.loot.hasKnife))

  await tp(...spots.locker)
  await page.waitForTimeout(400)
  ok('lashing cut prompt', /cut the lashing/i.test(await promptText()))
  await page.keyboard.press('KeyF')
  await page.waitForTimeout(300)
  ok('reach inside prompt', /reach inside/i.test(await promptText()))
  await page.keyboard.press('KeyF')
  await page.waitForTimeout(400)
  ok('spear granted', await page.evaluate(() => window.ww.loot.hasSpear))
  ok(
    'memory overlay shown',
    await page.evaluate(() => document.querySelector('#memory')?.classList.contains('show')),
  )
  const whisper = await page.evaluate(() => document.querySelector('#whisper')?.textContent ?? '')
  ok(`whisper queue draining ("${whisper.slice(0, 40)}…")`, whisper.length > 0)
  await page.close()
}

// —— B: the shark answers, the bite prices, death resets ———————————
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log('pageerror:', e.message))
  await page.goto(`${BASE}/?shark=2&spear=1&commit=1`, { waitUntil: 'load' })
  await page.waitForTimeout(2500)

  try {
    await page.waitForFunction(
      () => {
        const m = window.__shark?.mode
        return m === 'telegraph' || m === 'commit'
      },
      null,
      { timeout: 120000 },
    )
    ok('shark armed for a run', true)
  } catch {
    ok('shark armed for a run', false)
  }

  // Face the run and jab when the spear prompt is live
  let jabbed = false
  for (let i = 0; i < 160; i++) {
    await page.evaluate(() => window.__faceShark?.())
    const ready = await page.evaluate(() => {
      const m = window.__shark?.mode
      const d = window.__shark?.distance ?? Infinity
      const prompt = document.querySelector('#prompt span')?.textContent ?? ''
      return {
        close: d < 4.0 && (m === 'telegraph' || m === 'commit'),
        jabPrompt: /jab/i.test(prompt),
      }
    })
    if (ready.close || ready.jabPrompt) {
      await page.keyboard.press('KeyF')
      // Confirm the strike landed — flee mode, or the spear line queued/shown
      await page.waitForTimeout(200)
      const landed = await page.evaluate(() => {
        const m = window.__shark?.mode
        const w = document.querySelector('#whisper')?.textContent ?? ''
        return m === 'flee' || /spear finds it|gone/i.test(w)
      })
      if (landed) {
        jabbed = true
        break
      }
    }
    await page.waitForTimeout(100)
  }
  ok('jabbed the run', jabbed)
  // Telegraph + commit lines sit in the whisper queue ahead of the spear line
  let spearLine = ''
  try {
    await page.waitForFunction(
      () => /spear finds it|gone/i.test(document.querySelector('#whisper')?.textContent ?? ''),
      null,
      { timeout: 22000 },
    )
    spearLine = await page.evaluate(() => document.querySelector('#whisper')?.textContent ?? '')
  } catch {
    spearLine = await page.evaluate(() => document.querySelector('#whisper')?.textContent ?? '')
  }
  ok(`spear whisper ("${spearLine.slice(0, 40)}")`, /spear finds it|gone/i.test(spearLine))

  // Two bites → taken → death screen → swim again resets the run
  await page.evaluate(() => {
    window.ww.loot.onBite()
  })
  ok('first bite wounds', await page.evaluate(() => window.ww.vitals.wounded))
  await page.evaluate(() => {
    window.ww.loot.onBite()
  })
  await page.waitForTimeout(600)
  ok('second bite is taken', await page.evaluate(() => !window.ww.vitals.alive))
  ok(
    'death screen shows',
    await page.evaluate(() => document.querySelector('#death')?.classList.contains('on')),
  )
  await page.click('#death button')
  await page.waitForTimeout(400)
  const after = await page.evaluate(() => ({
    alive: window.ww.vitals.alive,
    wounded: window.ww.vitals.wounded,
    hasKnife: window.ww.loot.hasKnife,
    hasSpear: window.ww.loot.hasSpear,
    locker: window.ww.wreck.lockerState,
    provision: window.ww.wreck.provisionSpot() !== null,
  }))
  ok('run resets (alive, unwounded)', after.alive && !after.wounded)
  ok('loot resets (no knife/spear, locker sealed, crate back)',
    !after.hasKnife && !after.hasSpear && after.locker === 'sealed' && after.provision)
  await page.close()
}

// —— C: swim ⇄ walk still fires both ways after the merge —————————
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => console.log('pageerror:', e.message))
  await page.goto(`${BASE}/?x=700&z=-500&yaw=-1.0&pitch=0`, { waitUntil: 'load' })
  await page.waitForTimeout(2500)
  const mode = () => page.evaluate(() => window.ww.player.mode)

  await page.keyboard.down('KeyW')
  let walked = false
  for (let i = 0; i < 30 && !walked; i++) {
    await page.waitForTimeout(1000)
    walked = (await mode()) === 'walk'
  }
  await page.keyboard.up('KeyW')
  ok('swim → walk on the beach', walked)

  await page.evaluate(() => {
    window.ww.player.yaw += Math.PI
  })
  await page.keyboard.down('KeyW')
  let swam = false
  for (let i = 0; i < 30 && !swam; i++) {
    await page.waitForTimeout(1000)
    swam = (await mode()) === 'swim'
  }
  await page.keyboard.up('KeyW')
  ok('walk → swim back out', swam)
  await page.close()
}

console.log(fails.length === 0 ? 'SMOKE: all green' : `SMOKE: ${fails.length} failure(s)`)
await browser.close()
process.exit(fails.length === 0 ? 0 : 1)
