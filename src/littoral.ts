import * as THREE from 'three'
import type { Hud } from './hud'
import type { Interactions } from './interact'
import { eat, type Vitals } from './survival'
import { oceanState } from './waves'

/**
 * Littoral life — food and wildlife that answer the tide.
 *
 *  - Limpets & mussels on the foreshore: pry at low water, dive when covered.
 *  - Tidal pools: hollows that hold their own biota only while the tide is out.
 *  - Urchins on the drop-off; coral gardens with oysters & snails to pry.
 *  - Seals haul out at low tide, slip when it makes — and while swimming they
 *    draw fish schools in (a hunting ground, not a hunt of the seal).
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

type PickKind =
  | 'limpet'
  | 'mussel'
  | 'urchin'
  | 'kelp'
  | 'anemone'
  | 'periwinkle'
  | 'starfish'
  | 'oyster'
  | 'coral-snail'

type Pick = {
  object: THREE.Object3D
  kind: PickKind
  taken: boolean
  rockY: number
  diveReach: number
  /** Only reachable while the tide is below this height (tidal-pool biota). */
  poolOnly?: boolean
  poolLip?: number
}

type TidePool = {
  x: number
  z: number
  lip: number
  size: number
  water: THREE.Mesh
  rim: THREE.Mesh
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
  rock: new THREE.MeshStandardMaterial({
    color: '#6a6358',
    roughness: 0.95,
    flatShading: true,
  }),
  pool: new THREE.MeshStandardMaterial({
    color: 0x3f757b,
    roughness: 0.28,
    metalness: 0.05,
    emissive: 0x27505a,
    emissiveIntensity: 0.7,
    transparent: true,
    opacity: 0.88,
  }),
  anemone: new THREE.MeshStandardMaterial({
    color: '#c45a6a',
    roughness: 0.7,
    flatShading: true,
  }),
  periwinkle: new THREE.MeshStandardMaterial({
    color: '#5a6a78',
    roughness: 0.6,
    flatShading: true,
  }),
  starfish: new THREE.MeshStandardMaterial({
    color: '#c4783a',
    roughness: 0.8,
    flatShading: true,
  }),
  coral: new THREE.MeshStandardMaterial({
    color: '#c87888',
    roughness: 0.75,
    flatShading: true,
  }),
  coralDeep: new THREE.MeshStandardMaterial({
    color: '#6a4a78',
    roughness: 0.8,
    flatShading: true,
  }),
  oyster: new THREE.MeshStandardMaterial({
    color: '#9a8a70',
    roughness: 0.7,
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

function anemoneMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.08, 7), m.anemone)
  base.position.y = 0.04
  g.add(base)
  for (let i = 0; i < 8; i++) {
    const tent = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.006, 0.16, 4), m.anemone)
    const a = (i / 8) * Math.PI * 2
    tent.position.set(Math.cos(a) * 0.04, 0.14, Math.sin(a) * 0.04)
    tent.rotation.z = Math.cos(a) * 0.35
    tent.rotation.x = Math.sin(a) * 0.35
    g.add(tent)
  }
  return g
}

function periwinkleMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  for (let i = 0; i < 3; i++) {
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 5), m.periwinkle)
    shell.scale.set(1, 0.85, 1.15)
    shell.position.set(Math.cos(i * 2.1) * 0.05, 0.03, Math.sin(i * 2.1) * 0.05)
    g.add(shell)
  }
  return g
}

function starfishMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const hub = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 4), m.starfish)
  hub.scale.set(1, 0.35, 1)
  g.add(hub)
  for (let i = 0; i < 5; i++) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.02, 0.16), m.starfish)
    const a = (i / 5) * Math.PI * 2
    arm.position.set(Math.cos(a) * 0.08, 0.01, Math.sin(a) * 0.08)
    arm.rotation.y = -a
    g.add(arm)
  }
  return g
}

function oysterMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  for (let i = 0; i < 3; i++) {
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), m.oyster)
    shell.scale.set(1.2, 0.35, 0.9)
    shell.rotation.set(0.2, i * 1.1, 0.15)
    shell.position.set(Math.cos(i * 2) * 0.06, 0.02, Math.sin(i * 2) * 0.06)
    g.add(shell)
  }
  return g
}

function coralSnailMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), m.periwinkle)
  shell.scale.set(1.1, 0.9, 1.3)
  g.add(shell)
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.06, 5), m.shell)
  tip.rotation.z = Math.PI / 2
  tip.position.set(0.05, 0.01, 0)
  g.add(tip)
  return g
}

/** Low-poly brain / boulder coral. */
function brainCoral(m: ReturnType<typeof mats>, seed: number) {
  const g = new THREE.Group()
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45 + (seed % 5) * 0.06, 1), m.coral)
  body.scale.set(1.1, 0.7, 1)
  g.add(body)
  for (let i = 0; i < 4; i++) {
    const bump = new THREE.Mesh(new THREE.SphereGeometry(0.18, 5, 4), m.coral)
    bump.position.set(Math.cos(i * 1.7) * 0.28, 0.15, Math.sin(i * 1.7) * 0.28)
    bump.scale.set(1, 0.6, 1)
    g.add(bump)
  }
  return g
}

/** Staghorn-ish branching coral. */
function stagCoral(m: ReturnType<typeof mats>, seed: number) {
  const g = new THREE.Group()
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 0.35, 5), m.coralDeep)
  trunk.position.y = 0.18
  g.add(trunk)
  for (let i = 0; i < 5; i++) {
    const branch = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.045, 0.35 + ((seed + i) % 3) * 0.08, 4),
      m.coral,
    )
    const a = (i / 5) * Math.PI * 2
    branch.position.set(Math.cos(a) * 0.12, 0.4, Math.sin(a) * 0.12)
    branch.rotation.z = Math.cos(a) * 0.55
    branch.rotation.x = Math.sin(a) * 0.55
    g.add(branch)
  }
  return g
}

/** Plate / table coral. */
function plateCoral(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.28, 5), m.coralDeep)
  stem.position.y = 0.14
  g.add(stem)
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.5, 0.06, 8), m.coral)
  plate.position.y = 0.32
  g.add(plate)
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

const FOOD: Record<
  PickKind,
  { food: number; water: number; whisper: string; verb: string; label: string }
> = {
  limpet: {
    food: 0.1,
    water: 0.02,
    whisper: 'Limpets off the rock. Thin, salt, filling enough.',
    verb: 'Pry',
    label: 'Limpets',
  },
  mussel: {
    food: 0.16,
    water: 0.03,
    whisper: 'Mussels. The tide left them for you.',
    verb: 'Pry',
    label: 'Mussels',
  },
  urchin: {
    food: 0.22,
    water: 0.04,
    whisper: 'Urchin. Rich and strange — the drop-off keeps them.',
    verb: 'Pry',
    label: 'Urchin',
  },
  kelp: {
    food: 0.12,
    water: 0.05,
    whisper: 'Fresh kelp from the reef. Chewy, wet, alive.',
    verb: 'Pull',
    label: 'Kelp',
  },
  anemone: {
    food: 0.11,
    water: 0.04,
    whisper: 'Anemone from the pool. Soft and salt.',
    verb: 'Pull',
    label: 'Anemone',
  },
  periwinkle: {
    food: 0.08,
    water: 0.02,
    whisper: 'Periwinkles. A pocketful of the pool.',
    verb: 'Pick',
    label: 'Periwinkles',
  },
  starfish: {
    food: 0.09,
    water: 0.02,
    whisper: 'A starfish. Not much meat — the pool still gave.',
    verb: 'Take',
    label: 'Starfish',
  },
  oyster: {
    food: 0.2,
    water: 0.05,
    whisper: 'Oysters on the coral. Briny and cold.',
    verb: 'Pry',
    label: 'Oysters',
  },
  'coral-snail': {
    food: 0.1,
    water: 0.02,
    whisper: 'A snail from the coral garden.',
    verb: 'Pick',
    label: 'Coral snail',
  },
}

const scatter = (i: number, salt: number) => {
  const n = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return n - Math.floor(n)
}

export function createLittoral(scene: THREE.Scene, deps: LittoralDeps) {
  const m = mats()
  const picks: Pick[] = []
  const seals: Seal[] = []
  const tidePools: TidePool[] = []
  const ox = deps.origin.x
  const oz = deps.origin.z
  const coveX = deps.cove?.x ?? ox
  const coveZ = deps.cove?.z ?? oz
  const want = deps.lowPower
    ? { limpet: 8, mussel: 6, urchin: 4, kelp: 3, seal: 1, pool: 3, coral: 3 }
    : { limpet: 18, mussel: 14, urchin: 9, kelp: 6, seal: 3, pool: 6, coral: 7 }

  function addPick(
    kind: PickKind,
    object: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    diveReach: number,
    pool?: { lip: number },
  ) {
    object.position.set(x, y, z)
    scene.add(object)
    const meta = FOOD[kind]
    const pick: Pick = {
      object,
      kind,
      taken: false,
      rockY: y,
      diveReach,
      poolOnly: !!pool,
      poolLip: pool?.lip,
    }
    picks.push(pick)
    deps.interactions.add({
      position: object.position,
      verb: meta.verb,
      label: meta.label,
      radius: kind === 'urchin' || kind === 'kelp' || kind === 'oyster' ? 2.6 : 2.3,
      available: () => {
        if (pick.taken || !deps.vitals.alive) return false
        const surface = oceanState.tide
        if (pick.poolOnly && pick.poolLip !== undefined) {
          // Pool biota only while the tide is out of the hollow
          return surface < pick.poolLip - 0.05
        }
        const exposed = pick.rockY > surface + 0.08
        if (exposed) return true
        const depth = surface - pick.rockY
        return depth > 0.15 && depth < pick.diveReach
      },
      use: () => {
        if (pick.taken) return
        pick.taken = true
        pick.object.visible = false
        eat(deps.vitals, meta.food, meta.water)
        deps.hud.whisper(meta.whisper)
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

  // —— tidal pools (intertidal hollows, own biota at low water) ————
  {
    const candidates: { x: number; z: number; h: number }[] = []
    for (let i = 0; i < 800; i++) {
      const coveBias = i % 2 === 0
      const angle = i * 2.399 + 0.4
      const radius = coveBias ? 158 + ((i * 17) % 90) : 200 + ((i * 23) % 180)
      const lx = coveBias
        ? coveX - ox + Math.cos(angle) * (radius * 0.4)
        : Math.cos(angle) * radius
      const lz = coveBias
        ? coveZ - oz + Math.sin(angle) * (radius * 0.4)
        : Math.sin(angle) * radius
      const wx = ox + lx
      const wz = oz + lz
      const h = deps.heightAt(wx, wz)
      if (h < 0.2 || h > 0.95) continue
      candidates.push({ x: wx, z: wz, h })
    }
    for (const spot of candidates) {
      if (tidePools.length >= want.pool) break
      if (tidePools.some((p) => Math.hypot(p.x - spot.x, p.z - spot.z) < 14)) continue
      const size = 0.85 + (tidePools.length % 3) * 0.2
      const rim = new THREE.Mesh(new THREE.TorusGeometry(size, 0.22, 5, 14), m.rock)
      rim.rotation.x = Math.PI / 2
      rim.scale.y = 0.45
      rim.position.set(spot.x, spot.h - 0.08, spot.z)
      scene.add(rim)
      const water = new THREE.Mesh(new THREE.CircleGeometry(size - 0.12, 16), m.pool)
      water.rotation.x = -Math.PI / 2
      water.position.set(spot.x, spot.h + 0.01, spot.z)
      scene.add(water)
      const pool: TidePool = { x: spot.x, z: spot.z, lip: spot.h, size, water, rim }
      tidePools.push(pool)

      const poolOpt = { lip: spot.h }
      addPick('anemone', anemoneMesh(m), spot.x + 0.25, spot.h + 0.02, spot.z - 0.1, 1.2, poolOpt)
      addPick(
        'periwinkle',
        periwinkleMesh(m),
        spot.x - 0.3,
        spot.h + 0.02,
        spot.z + 0.15,
        1.2,
        poolOpt,
      )
      if (tidePools.length % 2 === 0) {
        addPick(
          'starfish',
          starfishMesh(m),
          spot.x + 0.05,
          spot.h + 0.02,
          spot.z + 0.28,
          1.2,
          poolOpt,
        )
      }
    }
  }

  // —— drop-off urchins (shelf edge, always dive) ————————————————
  let urchins = 0
  for (let i = 0; i < 900 && urchins < want.urchin; i++) {
    const angle = i * 2.618
    const radius = 240 + ((i * 23) % 160)
    const wx = ox + Math.cos(angle) * radius
    const wz = oz + Math.sin(angle) * radius
    const h = deps.heightAt(wx, wz)
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

  // —— coral gardens (geometry + dive forage) ————————————————————
  {
    let planted = 0
    if (deps.reefResolve && deps.wreckOrigin) {
      const wo = deps.wreckOrigin
      for (let i = 0; i < 40 && planted < want.coral; i++) {
        const angle = i * 2.513 + 0.7
        const radius = 8 + (i % 5) * 4.2
        const probe = {
          x: wo.x + Math.cos(angle) * radius,
          y: -4 - (i % 4) * 2.5,
          z: wo.z + Math.sin(angle) * radius,
        }
        const before = probe.y
        deps.reefResolve(probe)
        if (probe.y <= before + 0.05) continue
        const kind = i % 3
        const coral =
          kind === 0 ? brainCoral(m, i) : kind === 1 ? stagCoral(m, i) : plateCoral(m)
        coral.position.set(probe.x, probe.y - 0.15, probe.z)
        coral.rotation.y = i * 0.7
        scene.add(coral)
        if (kind === 0) {
          addPick('oyster', oysterMesh(m), probe.x + 0.2, probe.y + 0.15, probe.z, 5.5)
        } else {
          addPick(
            'coral-snail',
            coralSnailMesh(m),
            probe.x - 0.15,
            probe.y + 0.25,
            probe.z + 0.1,
            5.5,
          )
        }
        planted++
      }
    }
    // Island shelf gardens — shallow reef patches off the drop-off
    for (let i = 0; i < 600 && planted < want.coral + (deps.lowPower ? 2 : 5); i++) {
      const angle = i * 2.155 + 1.2
      const radius = 255 + ((i * 29) % 140)
      const wx = ox + Math.cos(angle) * radius
      const wz = oz + Math.sin(angle) * radius
      const h = deps.heightAt(wx, wz)
      if (h > -0.8 || h < -4.5) continue
      if (scatter(i, 4.4) > 0.35) continue
      const kind = planted % 3
      const coral = kind === 0 ? brainCoral(m, i) : kind === 1 ? stagCoral(m, i) : plateCoral(m)
      coral.position.set(wx, h + 0.05, wz)
      coral.rotation.y = i * 0.9
      scene.add(coral)
      if (kind !== 2) {
        addPick('oyster', oysterMesh(m), wx + 0.15, h + 0.35, wz, 4.8)
      } else {
        addPick('coral-snail', coralSnailMesh(m), wx - 0.12, h + 0.4, wz + 0.1, 4.8)
      }
      planted++
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
  let saidPool = false
  let saidSealFish = false

  function update(dt: number, player: { x: number; z: number; y?: number }) {
    const tide = oceanState.tide
    const low = tide < -0.2
    if (low !== lastLow) {
      lastLow = low
      if (low && !saidTide) {
        saidTide = true
        deps.hud.whisper('Low water. Rock shows its teeth.')
      } else if (!low && saidTide && tide > 0.25) {
        deps.hud.whisper('The tide is making. The foreshore drowns.')
        saidPool = false
      }
    }

    // Tide pools: water sits in the hollow until the sea covers the lip
    for (const pool of tidePools) {
      const covered = tide > pool.lip - 0.02
      pool.water.visible = !covered
      if (!covered) {
        pool.water.position.y = Math.min(pool.lip + 0.02, Math.max(pool.lip - 0.12, tide + 0.05))
      }
      if (low && !saidPool && Math.hypot(player.x - pool.x, player.z - pool.z) < 6) {
        saidPool = true
        deps.hud.whisper('A tide pool. Life trapped until the sea returns.')
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
        s.object.position.y = tide - 0.3 + Math.sin(performance.now() * 0.0015 + s.haulX) * 0.08
        s.object.visible = true
        if (!saidSealFish && dist < 14) {
          saidSealFish = true
          deps.hud.whisper('Fish work under the seal. The water is thick with them.')
        }
      }
    }
  }

  /** Swim spots that pull fish schools in — strength low while hauled out. */
  function fishAttractors() {
    return seals.map((s) => ({
      x: s.hauled ? s.haulX : s.swimX,
      z: s.hauled ? s.haulZ : s.swimZ,
      strength: s.hauled ? 0.15 : 1,
    }))
  }

  function reset() {
    for (const p of picks) {
      p.taken = false
      p.object.visible = true
    }
    saidTide = false
    lastLow = false
    saidPool = false
    saidSealFish = false
    for (const s of seals) {
      s.hauled = true
      s.spook = 0
      s.object.position.set(s.haulX, s.haulY, s.haulZ)
      s.object.rotation.x = 0
      s.object.visible = true
    }
  }

  return { update, reset, fishAttractors }
}

export type Littoral = ReturnType<typeof createLittoral>
