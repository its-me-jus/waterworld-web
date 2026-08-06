import type { CampGroup, CampRecipe } from './improvise'

/**
 * Nearby Actions — a hand icon beside the Pack bag.
 *
 * Soft F still teaches the facing-best verb. When several things are ready,
 * the centre prompt (and mobile CTA) point at Actions for the rest. Dig and
 * other menuReady recipes stay listed here even when F needs look-down.
 *
 * Pack stays the bag; Camp inside Pack remains a second door for builds.
 */

export type NearbyRow = {
  id: string
  group: 'reach' | CampGroup
  verb: string
  label: string
  cost: string
  use: () => void
}

export type NearbyDeps = {
  /** Non-camp interactables currently in arm's reach. */
  reachables: () => NearbyRow[]
  /** Construction recipes (menuReady / available) — Dig included without look-down. */
  campRecipes: () => CampRecipe[]
  /** Close Pack when Actions opens (and vice versa from Pack side). */
  closePack?: () => void
}

const GROUP_TITLE: Record<NearbyRow['group'], string> = {
  reach: 'Within reach',
  build: 'Carpentry',
  shelter: 'Shelter',
  camp: 'Camp',
  raft: 'Raft',
}

const GROUP_ORDER: NearbyRow['group'][] = ['reach', 'build', 'shelter', 'camp', 'raft']

function collectRows(deps: NearbyDeps): NearbyRow[] {
  const rows: NearbyRow[] = [...deps.reachables()]
  for (const r of deps.campRecipes()) {
    rows.push({
      id: r.id,
      group: r.group,
      verb: r.verb,
      label: r.label,
      cost: r.cost,
      use: r.use,
    })
  }
  return rows
}

export function createNearbyActions(app: HTMLElement, deps: NearbyDeps) {
  const button = document.createElement('button')
  button.id = 'ax-open'
  button.type = 'button'
  button.setAttribute('aria-label', 'Open actions')
  button.title = 'Actions (V)'
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.5 11.2V7.1a1.6 1.6 0 0 1 3.2 0v2.4"
        fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M11.7 9.5V6.4a1.55 1.55 0 0 1 3.1 0v3.4"
        fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M14.8 9.8V7.6a1.45 1.45 0 0 1 2.9 0v5.2"
        fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M5.6 12.2V10a1.7 1.7 0 0 1 3.4 0v5.4c0 3.1 1.5 4.8 4.2 4.8 2.9 0 5.2-1.7 5.2-5.1V12"
        fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="ax-badge" hidden>0</span>`
  app.appendChild(button)

  const badge = button.querySelector('.ax-badge') as HTMLElement

  const overlay = document.createElement('div')
  overlay.id = 'ax-sheet'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.innerHTML = `
    <div class="ax-panel">
      <div class="ax-head">
        <h2 id="ax-title">Actions</h2>
        <button class="ax-close" type="button" aria-label="Close">×</button>
      </div>
      <div id="ax-body" class="ax-body"></div>
    </div>`
  app.appendChild(overlay)

  const body = overlay.querySelector('#ax-body') as HTMLElement

  let open = false
  let liveTimer = 0
  let lastPaint = ''
  let flatRows: NearbyRow[] = []

  function badgeText(n: number) {
    if (n <= 0) return ''
    return n > 9 ? '9+' : String(n)
  }

  function setBadge(n: number) {
    const text = badgeText(n)
    badge.textContent = text
    badge.hidden = !text
    button.classList.toggle('has-ready', n > 0)
  }

  function paint(html: string) {
    if (html === lastPaint) return
    lastPaint = html
    body.innerHTML = html
  }

  function render() {
    const rows = collectRows(deps)
    flatRows = rows
    setBadge(rows.length)

    if (!open) return

    if (!rows.length) {
      paint(
        '<p class="ax-empty">Nothing in reach yet. Walk up to salvage, forage, or a build site — Dig and other builds also show here when materials are ready.</p>',
      )
      return
    }

    const byGroup = new Map<NearbyRow['group'], NearbyRow[]>()
    for (const r of rows) {
      const list = byGroup.get(r.group) ?? []
      list.push(r)
      byGroup.set(r.group, list)
    }

    const chunks: string[] = []
    let index = 0
    for (const group of GROUP_ORDER) {
      const list = byGroup.get(group)
      if (!list?.length) continue
      chunks.push(`<div class="ax-group"><div class="ax-label">${GROUP_TITLE[group]}</div>`)
      for (const r of list) {
        index += 1
        const key = index <= 9 ? `<kbd class="ax-key">${index}</kbd>` : `<span class="ax-key ax-key-blank"></span>`
        chunks.push(
          `<button type="button" class="ax-row" data-ax="${r.id}">` +
            key +
            `<span class="ax-verb">${r.verb} ${r.label}</span>` +
            `<span class="ax-cost">${r.cost}</span>` +
            `</button>`,
        )
      }
      chunks.push('</div>')
    }
    paint(chunks.join(''))
  }

  function setOpen(next: boolean) {
    if (open === next) return
    open = next
    overlay.classList.toggle('open', open)
    button.classList.toggle('active', open)

    if (open) {
      deps.closePack?.()
      document.body.classList.add('menu-open')
      if (document.pointerLockElement) document.exitPointerLock()
      lastPaint = ''
      render()
      liveTimer = window.setInterval(render, 350)
    } else {
      window.clearInterval(liveTimer)
      if (!document.getElementById('op-menu')?.classList.contains('open')) {
        document.body.classList.remove('menu-open')
      }
    }
  }

  function runRow(id: string) {
    const row = flatRows.find((r) => r.id === id) ?? collectRows(deps).find((r) => r.id === id)
    if (!row) return
    row.use()
    setOpen(false)
  }

  button.addEventListener('click', () => setOpen(!open))
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) setOpen(false)
  })
  overlay.querySelector('.ax-close')?.addEventListener('click', () => setOpen(false))

  overlay.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-ax]')
    if (row?.dataset.ax) runRow(row.dataset.ax)
  })

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyV' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Don't steal typing if a real text field ever appears
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      setOpen(!open)
      return
    }
    if (e.code === 'Escape' && open) {
      setOpen(false)
      return
    }
    if (!open) return
    const match = /^Digit([1-9])$/.exec(e.code)
    if (!match) return
    const n = Number(match[1])
    const row = flatRows[n - 1]
    if (!row) return
    e.preventDefault()
    runRow(row.id)
  })

  /** Refresh badge while the sheet is closed. */
  function tick() {
    if (!open) setBadge(collectRows(deps).length)
    else render()
  }

  return {
    setOpen,
    tick,
    get open() {
      return open
    },
    /** Total ready verbs — for prompt "N more · Actions" and mobile · +N. */
    readyCount() {
      return collectRows(deps).length
    },
  }
}

export type NearbyActions = ReturnType<typeof createNearbyActions>
