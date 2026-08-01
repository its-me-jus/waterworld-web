import type { Vitals } from './survival'
import { resetVitals } from './survival'
import type { Salvage, Stash, StashKind } from './salvage'
import type { WreckLoot } from './wreckloot'

/**
 * The operating menu — one bag icon that opens the modal the game is run from.
 *
 * Two halves:
 *  - Stash: what you're actually carrying (salvage counts + knife/spear). A
 *    real readout, not the corner strip's sentence.
 *  - Field kit (DEV only): the cheats the world gets built with — teleport to
 *    the island or the wreck, refill the body, arm up. Stripped from prod
 *    builds automatically since `import.meta.env.DEV` is compile-time.
 */

export type TeleportSpot = { x: number; z: number; y?: number; yaw?: number }

export type OpMenuDeps = {
  salvage: Salvage
  loot: WreckLoot
  vitals: Vitals
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
      ${
        dev
          ? `<div class="op-section op-dev">
        <h3>Field kit <span>dev</span></h3>
        <div class="op-cheats">
          <button data-tp="island" type="button">Island</button>
          <button data-tp="wreck" type="button">Wreck</button>
          <button data-cheat="fill" type="button">Fill vitals</button>
          <button data-cheat="knife" type="button">Knife</button>
          <button data-cheat="spear" type="button">Spear</button>
          <button data-cheat="reset" type="button" class="warn">Reset run</button>
        </div>
      </div>`
          : ''
      }
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
    renderStash(deps.salvage.stash, deps.salvage.labels)
    renderGear()
  })

  return {
    setOpen,
    get open() {
      return open
    },
  }
}

export type OpMenu = ReturnType<typeof createOpMenu>
