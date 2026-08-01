import type { Vitals } from './survival'
import { resetVitals } from './survival'
import type { Salvage, Stash, StashKind } from './salvage'
import type { WreckLoot } from './wreckloot'

/**
 * The operating menu — one bag icon that opens the modal the game is run from.
 *
 * Three halves:
 *  - Stash: what you're actually carrying (salvage counts, held fish, knife /
 *    spear). A real readout, not the corner strip's sentence.
 *  - Field kit: island / wreck teleport and fill-stash — always on, so you can
 *    keep building on a live deploy without a swim.
 *  - Dev extras (DEV only): vitals, fish, arms, reset run.
 */

export type TeleportSpot = { x: number; z: number; y?: number; yaw?: number }

export type OpMenuDeps = {
  salvage: Salvage
  loot: WreckLoot
  vitals: Vitals
  /** Hand-caught fish waiting to be eaten or cooked. */
  rawFish: () => number
  /** Eat one held fish (from the Pack cell). */
  eatFish?: () => boolean
  /** Dev only — put fish in hand. */
  grantFish?: (n?: number) => void
  teleport: (spot: TeleportSpot) => void
  spots: Record<string, TeleportSpot>
  /** Full run restart — the menu's reset is the real one, not a vitals patch. */
  resetRun: () => void
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
        <h2>Pack</h2>
        <button class="op-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="op-section">
        <h3>Stash</h3>
        <div id="op-stash" class="op-grid"></div>
      </div>
      <div class="op-section">
        <h3>Gear</h3>
        <div id="op-gear" class="op-gear"></div>
      </div>
      <div class="op-section op-dev">
        <h3>Field kit</h3>
        <div class="op-cheats">
          <button data-tp="island" type="button">Island</button>
          <button data-tp="wreck" type="button">Wreck</button>
          <button data-cheat="stash" type="button">Fill stash</button>
          ${
            dev
              ? `<button data-cheat="fill" type="button">Fill vitals</button>
          <button data-cheat="fish" type="button">Fish</button>
          <button data-cheat="knife" type="button">Knife</button>
          <button data-cheat="spear" type="button">Spear</button>
          <button data-cheat="reset" type="button" class="warn">Reset run</button>`
              : ''
          }
        </div>
      </div>
    </div>`
  app.appendChild(overlay)

  const stashBox = overlay.querySelector('#op-stash') as HTMLElement
  const gearBox = overlay.querySelector('#op-gear') as HTMLElement

  let open = false
  let liveTimer = 0

  const GEAR: { key: 'knife' | 'spear'; label: string; has: () => boolean }[] = [
    { key: 'knife', label: 'Galley knife', has: () => deps.loot.hasKnife },
    { key: 'spear', label: "Mate's spear", has: () => deps.loot.hasSpear },
  ]

  function renderStash(stash: Stash, labels: Salvage['labels']) {
    const rows = (Object.keys(stash) as StashKind[]).map((key) => {
      const n = stash[key]
      const name = n === 1 ? labels[key].one : labels[key].many
      return `<div class="op-cell${n ? '' : ' empty'}"><span class="n">${n}</span><span class="k">${name}</span></div>`
    })
    const fish = deps.rawFish()
    rows.push(
      `<div class="op-cell${fish ? '' : ' empty'}${fish ? ' op-use' : ''}" data-eat-fish="1"><span class="n">${fish}</span><span class="k">Raw fish</span></div>`,
    )
    stashBox.innerHTML = rows.join('')
  }

  function renderGear() {
    gearBox.innerHTML = GEAR.map(
      (g) =>
        `<div class="op-gear-item${g.has() ? '' : ' missing'}"><span class="dot"></span>${g.label}</div>`,
    ).join('')
  }

  function render() {
    renderStash(deps.salvage.stash, deps.salvage.labels)
    renderGear()
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
      render()
      // Stash counts can change while the menu's up (grab, then open)
      liveTimer = window.setInterval(render, 350)
    } else {
      window.clearInterval(liveTimer)
    }
  }

  button.addEventListener('click', () => setOpen(!open))
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) setOpen(false)
  })
  overlay.querySelector('.op-close')?.addEventListener('click', () => setOpen(false))

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab') {
      e.preventDefault()
      setOpen(!open)
    } else if (e.code === 'Escape' && open) {
      setOpen(false)
    }
  })

  // —— cheats ——————————————————————————————————————————————————————
  overlay.addEventListener('click', (e) => {
    const eatFish = (e.target as HTMLElement).closest<HTMLElement>('[data-eat-fish]')
    if (eatFish && deps.rawFish() > 0) {
      if (deps.eatFish?.()) render()
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
