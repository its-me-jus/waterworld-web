/**
 * Entry point. Checks the browser can draw the scene before loading it.
 *
 * With WebGL 2 switched off — a locked-down work machine, an old phone, a
 * browser with hardware acceleration disabled — three.js fails on its first
 * line and the page stays an empty dark rectangle with no word as to why.
 * This says why, in the game's own quiet voice, and stops there.
 */

function canDraw() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return false
    // Hand the test context straight back; browsers cap how many can be live
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

function explain(app: HTMLElement) {
  const card = document.createElement('div')
  card.setAttribute('role', 'alert')
  card.style.cssText = [
    'position:fixed',
    'inset:0',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:0.75rem',
    'padding:24px',
    'text-align:center',
    'background:#0b1118',
    'color:#d7e4ea',
    'font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
  ].join(';')
  const title = document.createElement('p')
  title.textContent = 'The sea needs 3D graphics to draw.'
  title.style.cssText = 'margin:0;font-size:1.25rem;font-style:italic'
  const detail = document.createElement('p')
  detail.textContent =
    'This browser has WebGL turned off or unavailable. Try turning on hardware acceleration in its settings, or open WaterWorld in a recent Chrome, Safari, Firefox or Edge.'
  detail.style.cssText = 'margin:0;max-width:32rem;opacity:0.75'
  card.append(title, detail)
  app.appendChild(card)
}

if (canDraw()) {
  void import('./main')
} else {
  explain(document.querySelector<HTMLElement>('#app') ?? document.body)
}
