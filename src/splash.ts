/** Subtle underwater foam beads only — no surface spray / drip lines. */

type Drop = {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  life: number
  max: number
}

export function createSplashLayer(parent: HTMLElement) {
  const canvas = document.createElement('canvas')
  canvas.id = 'splash-canvas'
  parent.appendChild(canvas)
  const ctx = canvas.getContext('2d')!

  let w = 0
  let h = 0
  let dpr = 1
  const drops: Drop[] = []
  let spawnTimer = 0

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = window.innerWidth
    h = window.innerHeight
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  resize()
  window.addEventListener('resize', resize)

  function spawnOne() {
    drops.push({
      x: w * (0.15 + Math.random() * 0.7),
      y: h * (0.55 + Math.random() * 0.4),
      vx: (Math.random() - 0.5) * 18,
      vy: -(12 + Math.random() * 28),
      r: 3 + Math.random() * 7,
      life: 1,
      max: 0.7 + Math.random() * 1.1,
    })
  }

  function update(dt: number, eyeY: number, surfaceY: number, _moving: number) {
    const underwater = eyeY < surfaceY - 0.08

    if (!underwater) {
      // Clear quickly when you surface — no foam on open air
      drops.length = 0
      ctx.clearRect(0, 0, w, h)
      spawnTimer = 0
      return
    }

    spawnTimer -= dt
    if (spawnTimer <= 0 && drops.length < 10) {
      spawnOne()
      if (Math.random() < 0.35) spawnOne()
      spawnTimer = 0.35 + Math.random() * 0.55
    }

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i]
      d.life -= dt / d.max
      d.x += d.vx * dt
      d.y += d.vy * dt
      d.vy -= 8 * dt
      if (d.life <= 0 || d.y < -20) drops.splice(i, 1)
    }

    ctx.clearRect(0, 0, w, h)
    for (const d of drops) {
      const a = Math.max(0, d.life) * 0.4
      const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r)
      g.addColorStop(0, `rgba(220,240,250,${a})`)
      g.addColorStop(1, `rgba(180,210,220,0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  return { update }
}
