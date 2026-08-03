import * as THREE from 'three'
import type { Hud } from './hud'
import type { Interactions } from './interact'
import { eat, type Vitals } from './survival'
import { oceanState } from './waves'

/**
 * Littoral life — food and wildlife that answer the tide.
 *
 *  - Limpets & mussels on the foreshore: pry them at low water when the rock
 *    is bare; dive for them when the tide covers. Same clusters, two windows.
 *  - Urchins a little deeper on the drop-off: always a dive, richer eating.
 *  - Seals haul out on cove rocks at low tide and slip when the water rises
 *    (or when you get too close). Atmosphere and a tell — not a hunt.
 *
 * Nothing here is signposted. Tide phase decides what's reachable.
 */

export type LittoralDeps = {
  interactions: Interactions
  vitals: Vitals
  hud: Hud
  heightAt: (x: number, z: number) => number
  /** Island world origin (centre). */
  origin: { x: number; z: number }
  /** Cove bias for planting — landing beach. */
  cove?: { x: number; z: number }
  /** Plant edible kelp / extra mussels on the wreck reef. */
  reefResolve?: (probe: { x: number; y: number; z: number }) => void
  wreckOrigin?: { x: number; z: number }
  lowPower?: boolean
}

type Pick = {
  object: THREE.Object3D
  kind: 'limpet' | 'mussel' | 'urchin' | 'kelp'
  taken: boolean
  /** Ground / rock height — exposed when this clears the tide. */
  rockY: number
  /** How deep underwater you may still pry (m below surface). */
  diveReach: number
}

type Seal = {
  object: THREE.Group
  haulX: number
  haulY: number
  haulZ: number
  swimX: number
  swimZ: number
  hauled: boolean
  spook: number
}

const mats = () => ({
  shell: new THREE.MeshStandardMaterial({
    color: '#8a7460',
    roughness: 0.85,
    flatShading: true,
  }),
  mussel: new THREE.MeshStandardMaterial({
    color: '#2a3540',
    roughness: 0.55,
    metalness: 0.15,
    flatShading: true,
  }),
  urchin: new THREE.MeshStandardMaterial({
    color: '#3a2040',
    roughness: 0.9,
    flatShading: true,
  }),
  weed: new THREE.MeshStandardMaterial({
    color: '#2f5a38',
    roughness: 0.95,
    side: THREE.DoubleSide,
    flatShading: true,
  }),
  seal: new THREE.MeshStandardMaterial({
    color: '#4a5560',
    roughness: 0.75,
    flatShading: true,
  }),
  belly: new THREE.MeshStandardMaterial({
    color: '#8a9098',
    roughness: 0.85,
    flatShading: true,
  }),
})

function limpetMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  for (let i = 0; i < 4; i++) {
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.05, 6), m.shell)
    cap.position.set(Math.cos(i * 1.7) * 0.08, 0.02, Math.sin(i * 1.7) * 0.08)
    g.add(cap)
  }
  return g
}

function musselMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  for (let i = 0; i < 6; i++) {
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), m.mussel)
    shell.scale.set(0.55, 1.4, 0.7)
    shell.rotation.set(0.4, i * 0.9, 0.2)
    shell.position.set(Math.cos(i * 1.1) * 0.07, 0.03 + (i % 2) * 0.02, Math.sin(i * 1.1) * 0.07)
    g.add(shell)
  }
  return g
}

function urchinMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 7, 5), m.urchin)
  g.add(body)
  for (let i = 0; i < 10; i++) {
    const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.004, 0.14, 3), m.urchin)
    const a = (i / 10) * Math.PI * 2
    const elev = 0.35 + (i % 3) * 0.15
    spine.position.set(Math.cos(a) * 0.06, Math.sin(elev) * 0.08, Math.sin(a) * 0.06)
    spine.lookAt(0, 0, 0)
    g.add(spine)
  }
  return g
}

function kelpClump(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  for (let i = 0; i < 5; i++) {
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 1.1 + (i % 3) * 0.35, 1, 3), m.weed)
    const pos = blade.geometry.attributes.position
    for (let v = 0; v < pos.count; v++) {
      pos.setZ(v, Math.sin(pos.getY(v) * 2.4 + i) * 0.1)
    }
    blade.geometry.computeVertexNormals()
    blade.rotation.set(-0.2, i * 1.2, 0)
    blade.position.set(Math.cos(i * 1.4) * 0.15, 0.4, Math.sin(i * 1.4) * 0.15)
    g.add(blade)
  }
  return g
}

function sealMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.55, 4, 8), m.seal)
  body.rotation.z = Math.PI / 2
  body.position.set(0.05, 0.18, 0)
  g.add(body)
  const belly = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.4, 3, 6), m.belly)
  belly.rotation.z = Math.PI / 2
  belly.position.set(0.05, 0.1, 0.06)
  g.add(belly)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 5), m.seal)
  head.scale.set(1.1, 0.85, 0.9)
  head.position.set(0.48, 0.28, 0)
  g.add(head)
  const snout = new THREE.Mesh(new THREE.SphereGeometry(0.07, 5, 4), m.belly)
  snout.scale.set(1.3, 0.7, 0.8)
  snout.position.set(0.62, 0.24, 0)
  g.add(snout)
  const flipL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 0.14), m.seal)
  flipL.position.set(0, 0.08, 0.2)
  flipL.rotation.set(0.3, 0.2, -0.4)
  g.add(flipL)
  const flipR = flipL.clone()
  flipR.position.z = -0.2
  flipR.rotation.z = 0.4
  g.add(flipR)
  return g
}

const FOOD: Record<Pick['kind'], { food: number; water: number; whisper: string }> = {
  limpet: { food: 0.1, water: 0.02, whisper: 'Limpets off the rock. Thin, salt, filling enough.' },
  mussel: { food: 0.16, water: 0.03, whisper: 'Mussels. The tide left them for you.' },
  urchin: { food: 0.22, water: 0.04, whisper: 'Urchin. Rich and strange — the drop-off keeps them.' },
  kelp: { food: 0.12, water: 0.05, whisper: 'Fresh kelp from the reef. Chewy, wet, alive.' },
}

const scatter = (i: number, salt: number) => {
  const n = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return n - Math.floor(n)
}

export function createLittoral(scene: THREE.Scene, deps: LittoralDeps) {
  const m = mats()
  const picks: Pick[] = []
  const seals: Seal[] = []
  const ox = deps.origin.x
  const oz = deps.origin.z
  const coveX = deps.cove?.x ?? ox
  const coveZ = deps.cove?.z ?? oz
  const want = deps.lowPower ? { limpet: 8, mussel: 6, urchin: 4, kelp: 3, seal: 1 } : { limpet: 18, mussel: 14, urchin: 9, kelp: 6, seal: 3 }

  function addPick(
    kind: Pick['kind'],
    object: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    diveReach: number,
  ) {
    object.position.set(x, y, z)
    scene.add(object)
    const pick: Pick = { object, kind, taken: false, rockY: y, diveReach }
    picks.push(pick)
    const label =
      kind === 'limpet' ? 'Limpets' : kind === 'mussel' ? 'Mussels' : kind === 'urchin' ? 'Urchin' : 'Kelp'
    deps.interactions.add({
      position: object.position,
      verb: kind === 'kelp' ? 'Pull' : 'Pry',
      label,
      radius: kind === 'urchin' || kind === 'kelp' ? 2.6 : 2.4,
      available: () => {
        if (pick.taken || !deps.vitals.alive) return false
        const surface = oceanState.tide
        const exposed = pick.rockY > surface + 0.08
        // Low tide: grab from shore. High tide / always-deep: dive within reach.
        if (exposed) return true
        const depth = surface - pick.rockY
        return depth > 0.15 && depth < pick.diveReach
      },
      use: () => {
        if (pick.taken) return
        pick.taken = true
        pick.object.visible = false
        const bite = FOOD[pick.kind]
        eat(deps.vitals, bite.food, bite.water)
        deps.hud.whisper(bite.whisper)
      },
    })
  }

  // —— foreshore limpets & mussels (island) ——————————————————————
  let limpets = 0
  for (let i = 0; i < 1200 && limpets < want.limpet; i++) {
    const coveBias = i % 3 !== 2
    const angle = i * 2.193
    const radius = coveBias ? 155 + ((i * 13) % 95) : 195 + ((i * 17) % 220)
    const lx = coveBias
      ? coveX - ox + Math.cos(angle) * (radius * 0.42)
      : Math.cos(angle) * radius
    const lz = coveBias
      ? coveZ - oz + Math.sin(angle) * (radius * 0.42)
      : Math.sin(angle) * radius
    const wx = ox + lx
    const wz = oz + lz
    const h = deps.heightAt(wx, wz)
    // Intertidal band — high tide covers, low tide bares
    if (h < 0.05 || h > 1.15) continue
    if (scatter(i, 1.1) > 0.55) continue
    addPick('limpet', limpetMesh(m), wx, h + 0.04, wz, 1.8)
    limpets++
  }

  let mussels = 0
  for (let i = 0; i < 1200 && mussels < want.mussel; i++) {
    const coveBias = i % 2 === 0
    const angle = i * 2.467
    const radius = coveBias ? 150 + ((i * 11) % 100) : 200 + ((i * 19) % 210)
    const lx = coveBias
      ? coveX - ox + Math.cos(angle) * (radius * 0.4)
      : Math.cos(angle) * radius
    const lz = coveBias
      ? coveZ - oz + Math.sin(angle) * (radius * 0.4)
      : Math.sin(angle) * radius
    const wx = ox + lx
    const wz = oz + lz
    const h = deps.heightAt(wx, wz)
    if (h < -0.05 || h > 0.95) continue
    if (scatter(i, 2.2) > 0.5) continue
    addPick('mussel', musselMesh(m), wx, h + 0.05, wz, 2.1)
    mussels++
  }

  // —— drop-off urchins (shelf edge, always dive) ————————————————
  let urchins = 0
  for (let i = 0; i < 900 && urchins < want.urchin; i++) {
    const angle = i * 2.618
    const radius = 240 + ((i * 23) % 160)
    const wx = ox + Math.cos(angle) * radius
    const wz = oz + Math.sin(angle) * radius
    const h = deps.heightAt(wx, wz)
    // Just off the wadable shelf — deeper rock
    if (h > -0.2 || h < -3.2) continue
    if (scatter(i, 3.3) > 0.48) continue
    addPick('urchin', urchinMesh(m), wx, h + 0.06, wz, 4.5)
    urchins++
  }

  // —— wreck reef: edible kelp + mussels on real rock ————————————
  if (deps.reefResolve && deps.wreckOrigin) {
    const wo = deps.wreckOrigin
    let kelp = 0
    for (let i = 0; i < 50 && kelp < want.kelp; i++) {
      const angle = i * 2.399
      const radius = 4 + (i % 6) * 3.8
      const probe = {
        x: wo.x + Math.cos(angle) * radius,
        y: -5 - (i % 5) * 2.2,
        z: wo.z + Math.sin(angle) * radius,
      }
      const before = probe.y
      deps.reefResolve(probe)
      if (probe.y <= before + 0.05) continue
      if (i % 2 === 0) {
        addPick('kelp', kelpClump(m), probe.x, probe.y - 0.2, probe.z, 6)
      } else {
        addPick('mussel', musselMesh(m), probe.x, probe.y - 0.35, probe.z, 5)
      }
      kelp++
    }
  }

  // —— seals haul out at low tide ——————————————————————————————
  for (let i = 0; i < want.seal; i++) {
    const angle = -0.4 + i * 0.55
    const radius = 168 + i * 12
    const haulX = coveX + Math.cos(angle) * radius * 0.35
    const haulZ = coveZ + Math.sin(angle) * radius * 0.35
    let haulY = deps.heightAt(haulX, haulZ)
    if (haulY < 0.2 || haulY > 2.8) {
      haulY = 0.55 + i * 0.15
    }
    const swimX = haulX + Math.cos(angle) * 18
    const swimZ = haulZ + Math.sin(angle) * 18
    const object = sealMesh(m)
    object.position.set(haulX, haulY, haulZ)
    object.rotation.y = angle + Math.PI
    scene.add(object)
    seals.push({
      object,
      haulX,
      haulY,
      haulZ,
      swimX,
      swimZ,
      hauled: true,
      spook: 0,
    })
  }

  let saidTide = false
  let lastLow = false

  function update(dt: number, player: { x: number; z: number }) {
    const tide = oceanState.tide
    const low = tide < -0.2
    if (low !== lastLow) {
      lastLow = low
      if (low && !saidTide) {
        saidTide = true
        deps.hud.whisper('Low water. Rock shows its teeth.')
      } else if (!low && saidTide && tide > 0.25) {
        deps.hud.whisper('The tide is making. The foreshore drowns.')
      }
    }

    for (const s of seals) {
      const dist = Math.hypot(player.x - s.object.position.x, player.z - s.object.position.z)
      if (dist < 7.5) s.spook = Math.max(s.spook, 4.5)
      s.spook = Math.max(0, s.spook - dt)

      const wantHaul = low && s.spook <= 0
      if (wantHaul && !s.hauled) {
        s.hauled = true
        s.object.position.set(s.haulX, s.haulY, s.haulZ)
        s.object.visible = true
        s.object.rotation.x = 0
      } else if (!wantHaul && s.hauled) {
        s.hauled = false
        if (s.spook > 0) deps.hud.whisper('The seal slips. Eyes on you until the wash takes it.')
        s.object.position.set(s.swimX, tide - 0.35, s.swimZ)
        s.object.rotation.x = 0.25
      } else if (!s.hauled) {
        // Bob in the wash just offshore
        s.object.position.y = tide - 0.3 + Math.sin(performance.now() * 0.0015 + s.haulX) * 0.08
        s.object.visible = true
      }
    }
  }

  function reset() {
    for (const p of picks) {
      p.taken = false
      p.object.visible = true
    }
    saidTide = false
    lastLow = false
    for (const s of seals) {
      s.hauled = true
      s.spook = 0
      s.object.position.set(s.haulX, s.haulY, s.haulZ)
      s.object.rotation.x = 0
      s.object.visible = true
    }
  }

  return { update, reset }
}

export type Littoral = ReturnType<typeof createLittoral>
