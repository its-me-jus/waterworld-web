/** Two layers: underwater foam beads, and a film of water that clings to the
 *  lens after you surface — heavy droplets slide down while the light film
 *  takes several seconds to evaporate, longer the deeper you've just been. */

type Bead = {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  life: number
  max: number
}

type Droplet = {
  x: number
  y: number
  r: number
  /** Fraction of original water still held — heavy drops slide as they lose it. */
  water: number
  speed: number
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
  const beads: Bead[] = []
  const droplets: Droplet[] = []
  /** 0..1 how wet the lens is right now — drives the light film. */
  let film = 0
  let spawnTimer = 0
  let prevUnder = false

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

  function spawnBead() {
    beads.push({
      x: w * (0.15 + Math.random() * 0.7),
      y: h * (0.55 + Math.random() * 0.4),
      vx: (Math.random() - 0.5) * 18,
      vy: -(12 + Math.random() * 28),
      r: 3 + Math.random() * 7,
      life: 1,
      max: 0.7 + Math.random() * 1.1,
    })
  }

  function spawnDroplet(big: boolean) {
    const r = big ? 2.6 + Math.random() * 3.4 : 0.9 + Math.random() * 1.7
    droplets.push({
      x: w * (0.06 + Math.random() * 0.88),
      y: h * (0.06 + Math.random() * 0.88),
      r,
      water: 1,
      // Heavier drops creep down the lens sooner
      speed: (0.02 + Math.random() * 0.05) * (r / 2.2) * h,
      max: 1.4 + Math.random() * 2.4,
    })
  }

  /** Soak the lens in proportion to how deep and how long you've been under. */
  function wet(amount: number) {
    film = Math.min(1, film + amount)
    const target = Math.floor(6 + film * 26)
    while (droplets.length < target) spawnDroplet(Math.random() < 0.45)
  }

  function update(dt: number, eyeY: number, surfaceY: number, _moving: number, submersion = 0) {
    const underwater = eyeY < surfaceY - 0.08

    if (underwater) {
      // You can't see beads on a lens that's behind the water; they only matter
      // for the surfacing moment. Film charges up while you're down.
      beads.length = 0
      film = Math.min(1, film + (0.12 + submersion * 0.25) * dt)
      spawnTimer -= dt
      if (spawnTimer <= 0 && beads.length < 10) {
        spawnBead()
        if (Math.random() < 0.35) spawnBead()
        spawnTimer = 0.35 + Math.random() * 0.55
      }
      prevUnder = true
    } else {
      // Just broke the surface — flash the lens wet in proportion to the dive
      if (prevUnder) {
        wet(0.4 + submersion * 0.6)
        prevUnder = false
      }
      // Film evaporates over ~6-14 s, not the instant the old layer cleared
      film = Math.max(0, film - dt / (6 + film * 8))
    }

    // —— underwater foam beads ——
    for (let i = beads.length - 1; i >= 0; i--) {
      const d = beads[i]
      d.life -= dt / d.max
      d.x += d.vx * dt
      d.y += d.vy * dt
      d.vy -= 8 * dt
      if (d.life <= 0 || d.y < -20) beads.splice(i, 1)
    }

    // —— clinging droplets ——
    for (let i = droplets.length - 1; i >= 0; i--) {
      const d = droplets[i]
      d.water -= dt / d.max
      d.y += d.speed * d.water * dt
      if (d.water <= 0 || d.y > h + 24) droplets.splice(i, 1)
    }

    ctx.clearRect(0, 0, w, h)

    // Light film — a cool wash with a faint bottom-up streak pattern
    if (film > 0.005 && !underwater) {
      const f = Math.min(1, film)
      const wash = ctx.createLinearGradient(0, 0, 0, h)
      wash.addColorStop(0, `rgba(178, 214, 228, ${0.05 * f})`)
      wash.addColorStop(0.7, `rgba(150, 196, 214, ${0.11 * f})`)
      wash.addColorStop(1, `rgba(120, 170, 190, ${0.16 * f})`)
      ctx.fillStyle = wash
      ctx.fillRect(0, 0, w, h)
    }

    for (const d of droplets) {
      const a = Math.max(0, Math.min(1, d.water)) * (0.35 + film * 0.4)
      const g = ctx.createRadialGradient(d.x - d.r * 0.35, d.y - d.r * 0.4, 0, d.x, d.y, d.r)
      g.addColorStop(0, `rgba(235, 248, 255, ${a})`)
      g.addColorStop(0.55, `rgba(190, 220, 232, ${a * 0.5})`)
      g.addColorStop(1, `rgba(140, 175, 190, 0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
      ctx.fill()
    }

    for (const d of beads) {
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
