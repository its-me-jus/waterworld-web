import type { Vitals } from './survival'
import { eat, resetVitals } from './survival'
import type { Salvage, Stash, StashKind } from './salvage'
import type { WreckLoot } from './wreckloot'
import type { CampGroup, CampRecipe } from './improvise'

/**
 * The operating menu — one bag icon that opens a hub, then a screen.
 *
 * Opening the Pack is deliberate: the map stays clean, and you come here to
 * check the body, count what you're carrying, pick a build, or use the field kit.
 *
 * Hub destinations:
 * - Body: health and metrics (full read, not the urgent HUD alarms)
 * - Stash: salvage, fish, knife / spear / rod / net
 * - Camp: construction recipes ready right now (Raise / Dig / Lash…)
 * - Field kit: island / wreck teleport, fill-stash, Start again
 * - Dev extras (DEV only): vitals, fish, arms — tucked in Field kit
 */

export type TeleportSpot = { x: number; z: number; y?: number; yaw?: number }

export type OpMenuDeps = {
  salvage: Salvage
  loot: WreckLoot
  vitals: Vitals
  /** Hand-caught fish waiting to be eaten, cooked, or smoked. */
  rawFish: () => number
  /** Smoked fish kept in the Pack. */
  smokedFish: () => number
  /** Eat one held raw fish (from the Pack cell). */
  eatFish?: () => boolean
  /** Eat one smoked fish (from the Pack cell). */
  eatSmoked?: () => boolean
  /** Dev only — put fish in hand. */
  grantFish?: (n?: number) => void
  /** Crafted fishing gear — shows in the Pack Gear list. */
  hasRod?: () => boolean
  hasNet?: () => boolean
  equippedTool?: () => 'rod' | 'net' | null
  equipTool?: (tool: 'rod' | 'net') => void
  /** Ready construction recipes from improvise (same use as F). */
  campRecipes: () => CampRecipe[]
  /** Which day of the run this is — the score in the header. */
  day?: () => number
  teleport: (spot: TeleportSpot) => void
  spots: Record<string, TeleportSpot>
  /** Full run restart — the menu's reset is the real one, not a vitals patch. */
  resetRun: () => void
}

type Screen = 'hub' | 'body' | 'stash' | 'camp' | 'kit'

const GROUP_TITLE: Record<CampGroup, string> = {
  shelter: 'Shelter',
  build: 'Carpentry',
  camp: 'Camp',
  raft: 'Raft',
}

const GROUP_ORDER: CampGroup[] = ['shelter', 'build', 'camp', 'raft']

const BODY_ROWS: { key: keyof Vitals; label: string }[] = [
  { key: 'health', label: 'Condition' },
  { key: 'stamina', label: 'Strength' },
  { key: 'energy', label: 'Energy' },
  { key: 'warmth', label: 'Warmth' },
  { key: 'water', label: 'Water' },
  { key: 'food', label: 'Food' },
  { key: 'breath', label: 'Breath' },
]

const SCREEN_TITLE: Record<Exclude<Screen, 'hub'>, string> = {
  body: 'Body',
  stash: 'Stash',
  camp: 'Camp',
  kit: 'Field kit',
}

export function createOpMenu(app: HTMLElement, deps: OpMenuDeps) {
  const dev = import.meta.env.DEV

  const button = document.createElement('button')
  button.id = 'op-open'
  button.type = 'button'
  button.setAttribute('aria-label', 'Open pack')
  button.title = 'Pack (Tab)'
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 8V7a5 5 0 0 1 10 0v1" fill="none" stroke="currentColor" stroke-width="1.7"/>
      <path d="M4.5 8h15l-1.1 12.2a2 2 0 0 1-2 1.8H7.6a2 2 0 0 1-2-1.8L4.5 8Z"
        fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
      <path d="M9 11.5v3M15 11.5v3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>`
  app.appendChild(button)

  const overlay = document.createElement('div')
  overlay.id = 'op-menu'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.innerHTML = `
    <div class="op-panel">
      <div class="op-head">
        <button class="op-back" type="button" aria-label="Back to pack" hidden>←</button>
        <h2 id="op-title">Pack</h2>
        <span id="op-day" class="op-day"></span>
        <button class="op-close" type="button" aria-label="Close">×</button>
      </div>
      <div id="op-screen" class="op-screen"></div>
    </div>`
  app.appendChild(overlay)

  const screenBox = overlay.querySelector('#op-screen') as HTMLElement
  const titleEl = overlay.querySelector('#op-title') as HTMLElement
  const dayChip = overlay.querySelector('#op-day') as HTMLElement
  const backBtn = overlay.querySelector('.op-back') as HTMLButtonElement

  let open = false
  let screen: Screen = 'hub'
  let liveTimer = 0
  /** Skip innerHTML writes that would detach buttons mid-tap. */
  let lastPaint = ''

  const GEAR: {
    key: string
    label: string
    has: () => boolean
    equip?: 'rod' | 'net'
  }[] = [
    { key: 'knife', label: 'Galley knife', has: () => deps.loot.hasKnife },
    { key: 'spear', label: "Mate's spear", has: () => deps.loot.hasSpear },
    { key: 'lantern', label: 'Diving lantern', has: () => deps.loot.hasLantern },
    { key: 'rod', label: 'Fishing rod', has: () => deps.hasRod?.() ?? false, equip: 'rod' },
    { key: 'net', label: 'Cast net', has: () => deps.hasNet?.() ?? false, equip: 'net' },
  ]

  function stashCount(stash: Stash) {
    let n = 0
    for (const key of Object.keys(stash) as StashKind[]) n += stash[key]
    return n + deps.rawFish() + deps.smokedFish()
  }

  function bodyHint(v: Vitals) {
    if (!v.alive) return 'Gone'
    if (v.wounded) return 'Bleeding'
    if (v.health < 0.45) return 'Hurting'
    if (v.energy < 0.3) return 'Spent'
    if (v.water < 0.3) return 'Thirsty'
    if (v.food < 0.3) return 'Hungry'
    if (v.warmth < 0.35) return 'Cold'
    if (v.stamina < 0.35) return 'Winded'
    return 'Steady'
  }

  function paint(html: string) {
    if (html === lastPaint) return
    lastPaint = html
    screenBox.innerHTML = html
  }

  function renderHub() {
    const recipes = deps.campRecipes().length
    const carried = stashCount(deps.salvage.stash)
    const hint = bodyHint(deps.vitals)
    paint(`
      <p class="op-lead">Open a screen — the map stays for acting.</p>
      <div class="op-hub">
        <button type="button" class="op-hub-btn" data-go="body">
          <span class="op-hub-name">Body</span>
          <span class="op-hub-meta">${hint}</span>
        </button>
        <button type="button" class="op-hub-btn" data-go="stash">
          <span class="op-hub-name">Stash</span>
          <span class="op-hub-meta">${carried ? `${carried} carried` : 'Empty'}</span>
        </button>
        <button type="button" class="op-hub-btn" data-go="camp">
          <span class="op-hub-name">Camp</span>
          <span class="op-hub-meta">${recipes ? `${recipes} ready` : 'Nothing ready'}</span>
        </button>
        <button type="button" class="op-hub-btn" data-go="kit">
          <span class="op-hub-name">Field kit</span>
          <span class="op-hub-meta">Places · restart</span>
        </button>
      </div>`)
  }

  function renderBody() {
    const v = deps.vitals
    const rows = BODY_ROWS.map(({ key, label }) => {
      const value = v[key] as number
      const low = value < 0.25
      // Quantize the bar so live refresh doesn't thrash the DOM every tick
      const bar = Math.round(Math.max(0, Math.min(1, value)) * 40) / 40
      return (
        `<div class="op-vital${low ? ' low' : ''}">` +
        `<span class="op-vital-label">${label}</span>` +
        `<i class="op-vital-track"><b style="transform:scaleX(${bar})"></b></i>` +
        `<span class="op-vital-n">${Math.round(value * 100)}</span>` +
        `</div>`
      )
    })
    if (v.wounded) {
      rows.push(
        `<div class="op-vital low">` +
          `<span class="op-vital-label">Bleeding</span>` +
          `<i class="op-vital-track wound"><b style="transform:scaleX(1)"></b></i>` +
          `<span class="op-vital-n">Open</span>` +
          `</div>`,
      )
    }
    const suited = v.suited ? 'Immersion suit on' : 'No suit'
    paint(`
      <p class="op-lead">How the body is holding — read it here, feel it out there.</p>
      <div class="op-vitals">${rows.join('')}</div>
      <p class="op-aside">${suited}</p>`)
  }

  function renderStash(stash: Stash, labels: Salvage['labels']) {
    const rows = (Object.keys(stash) as StashKind[]).map((key) => {
      const n = stash[key]
      const name = n === 1 ? labels[key].one : labels[key].many
      const drinkable = key === 'nut' && n > 0
      return (
        `<div class="op-cell${n ? '' : ' empty'}${drinkable ? ' op-use' : ''}"` +
        `${drinkable ? ' data-drink-nut="1"' : ''}>` +
        `<span class="n">${n}</span>` +
        `<span class="k">${name}${drinkable ? ' · drink' : ''}</span></div>`
      )
    })
    const fish = deps.rawFish()
    rows.push(
      `<div class="op-cell${fish ? '' : ' empty'}${fish ? ' op-use' : ''}" data-eat-fish="1"><span class="n">${fish}</span><span class="k">Raw fish</span></div>`,
    )
    const smoked = deps.smokedFish()
    rows.push(
      `<div class="op-cell${smoked ? '' : ' empty'}${smoked ? ' op-use' : ''}" data-eat-smoked="1"><span class="n">${smoked}</span><span class="k">Smoked fish</span></div>`,
    )
    const equipped = deps.equippedTool?.() ?? null
    const gear = GEAR.map((g) => {
      const on = g.has()
      const active = g.equip && equipped === g.equip
      const cls = [
        'op-gear-item',
        on ? '' : ' missing',
        on && g.equip ? ' op-use' : '',
        active ? ' active' : '',
      ].join('')
      const equipAttr = on && g.equip ? ` data-equip="${g.equip}"` : ''
      return `<div class="${cls}"${equipAttr}><span class="dot"></span>${g.label}${active ? ' · ready' : ''}</div>`
    }).join('')
    paint(`
      <div class="op-section op-section-first">
        <h3>Carried</h3>
        <div class="op-grid">${rows.join('')}</div>
      </div>
      <div class="op-section">
        <h3>Gear</h3>
        <div class="op-gear">${gear}</div>
      </div>`)
  }

  function renderCamp() {
    const recipes = deps.campRecipes()
    if (!recipes.length) {
      paint(
        '<p class="op-camp-empty">Stand where a build would work, with the materials on you — then it shows up here. Carpentry: face the next empty square to Lay a platform, then Raise walls and Pitch a roof. Pack stays open as a second way in when the world prompt is busy.</p>',
      )
      return
    }

    const byGroup = new Map<CampGroup, CampRecipe[]>()
    for (const r of recipes) {
      const list = byGroup.get(r.group) ?? []
      list.push(r)
      byGroup.set(r.group, list)
    }

    const chunks: string[] = ['<div class="op-camp">']
    for (const group of GROUP_ORDER) {
      const list = byGroup.get(group)
      if (!list?.length) continue
      chunks.push(`<div class="op-camp-group"><div class="op-camp-label">${GROUP_TITLE[group]}</div>`)
      for (const r of list) {
        chunks.push(
          `<button type="button" class="op-camp-btn" data-camp="${r.id}">` +
            `<span class="op-camp-verb">${r.verb} ${r.label}</span>` +
            `<span class="op-camp-cost">${r.cost}</span>` +
            `</button>`,
        )
      }
      chunks.push('</div>')
    }
    chunks.push('</div>')
    paint(chunks.join(''))
  }

  function renderKit() {
    paint(`
      <div class="op-cheats">
        <button data-tp="island" type="button">Island</button>
        <button data-tp="wreck" type="button">Wreck</button>
        <button data-tp="spar" type="button">Spar</button>
        <button data-cheat="stash" type="button">Fill stash</button>
        <button data-cheat="reset" type="button" class="warn">Start again</button>
        ${
          dev
            ? `<button data-cheat="fill" type="button">Fill vitals</button>
        <button data-cheat="fish" type="button">Fish</button>
        <button data-cheat="knife" type="button">Knife</button>
        <button data-cheat="spear" type="button">Spear</button>`
            : ''
        }
      </div>`)
  }

  function setScreen(next: Screen) {
    screen = next
    lastPaint = ''
    const onHub = next === 'hub'
    titleEl.textContent = onHub ? 'Pack' : SCREEN_TITLE[next]
    backBtn.hidden = onHub
    dayChip.hidden = !onHub
    render()
  }

  function render() {
    dayChip.textContent = deps.day ? `Day ${deps.day()}` : ''
    switch (screen) {
      case 'hub':
        renderHub()
        break
      case 'body':
        renderBody()
        break
      case 'stash':
        renderStash(deps.salvage.stash, deps.salvage.labels)
        break
      case 'camp':
        renderCamp()
        break
      case 'kit':
        renderKit()
        break
    }
  }

  function setOpen(next: boolean) {
    if (open === next) return
    open = next
    overlay.classList.toggle('open', open)
    button.classList.toggle('active', open)
    document.body.classList.toggle('menu-open', open)

    if (open) {
      // Hand the pointer back so the modal is clickable; re-locks on click
      if (document.pointerLockElement) document.exitPointerLock()
      setScreen('hub')
      // Counts / vitals can change while the menu's up
      liveTimer = window.setInterval(render, 350)
    } else {
      window.clearInterval(liveTimer)
      screen = 'hub'
    }
  }

  button.addEventListener('click', () => setOpen(!open))
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) setOpen(false)
  })
  overlay.querySelector('.op-close')?.addEventListener('click', () => setOpen(false))
  backBtn.addEventListener('click', () => setScreen('hub'))

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab') {
      e.preventDefault()
      setOpen(!open)
    } else if (e.code === 'Escape' && open) {
      if (screen !== 'hub') setScreen('hub')
      else setOpen(false)
    }
  })

  // —— navigation + cheats + camp builds ——————————————————————————
  overlay.addEventListener('click', (e) => {
    const go = (e.target as HTMLElement).closest<HTMLElement>('[data-go]')
    if (go?.dataset.go) {
      setScreen(go.dataset.go as Screen)
      return
    }

    const campBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-camp]')
    if (campBtn?.dataset.camp) {
      const id = campBtn.dataset.camp
      const recipe = deps.campRecipes().find((r) => r.id === id)
      if (recipe) {
        recipe.use()
        setOpen(false)
      }
      return
    }

    const eatFish = (e.target as HTMLElement).closest<HTMLElement>('[data-eat-fish]')
    if (eatFish && deps.rawFish() > 0) {
      if (deps.eatFish?.()) render()
      return
    }
    const eatSmoked = (e.target as HTMLElement).closest<HTMLElement>('[data-eat-smoked]')
    if (eatSmoked && deps.smokedFish() > 0) {
      if (deps.eatSmoked?.()) render()
      return
    }

    const drinkNut = (e.target as HTMLElement).closest<HTMLElement>('[data-drink-nut]')
    if (drinkNut && deps.salvage.stash.nut > 0) {
      deps.salvage.stash.nut -= 1
      eat(deps.vitals, 0.08, 0.42)
      render()
      return
    }

    const equipEl = (e.target as HTMLElement).closest<HTMLElement>('[data-equip]')
    if (equipEl?.dataset.equip === 'rod' || equipEl?.dataset.equip === 'net') {
      deps.equipTool?.(equipEl.dataset.equip)
      render()
      return
    }

    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tp],[data-cheat]')
    if (!el) return

    const tp = el.dataset.tp
    if (tp && deps.spots[tp]) {
      deps.teleport(deps.spots[tp])
      setOpen(false)
      return
    }

    switch (el.dataset.cheat) {
      case 'fill':
        resetVitals(deps.vitals)
        break
      case 'stash':
        deps.salvage.stash.plank += 6
        deps.salvage.stash.rope += 3
        deps.salvage.stash.canvas += 2
        deps.salvage.stash.barrel += 2
        deps.salvage.stash.crate += 1
        deps.salvage.stash.plastic += 3
        deps.salvage.stash.can += 2
        deps.salvage.stash.leaf += 4
        deps.salvage.stash.nut += 3
        deps.salvage.stash.shell += 4
        break
      case 'fish':
        deps.grantFish?.(2)
        break
      case 'knife':
        deps.loot.grant('knife')
        break
      case 'spear':
        deps.loot.grant('spear')
        break
      case 'reset':
        deps.resetRun()
        setOpen(false)
        return
    }
    render()
  })

  return {
    setOpen,
    get open() {
      return open
    },
  }
}

export type OpMenu = ReturnType<typeof createOpMenu>
