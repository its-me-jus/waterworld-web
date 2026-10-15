import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Hud } from './hud'
import { oceanState } from './waves'

/**
 * Littoral life — the shoreline that answers the tide.
 *
 *  - Limpets, mussels and urchins dotting the foreshore and the drop-off wall.
 *  - Coral gardens that take the night glow the jellies already know.
 *  - Seals that haul out on the cove rocks at low tide and slip away when it
 *    makes — while they swim, fish schools gather under them.
 *
 * All of it is to look at. Nothing here is signposted; tide phase decides what
 * the shore looks like.
 */

export type LittoralDeps = {
  hud: Hud
  heightAt: (x: number, z: number) => number
  /** Island world origin (centre). */
  origin: { x: number; z: number }
  /** Cove bias for planting — landing beach. */
  cove?: { x: number; z: number }
  /** Plant kelp / extra mussels on the wreck reef. */
  reefResolve?: (probe: { x: number; y: number; z: number }) => void
  wreckOrigin?: { x: number; z: number }
  lowPower?: boolean
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
  // Plain lit stone goes black in shade, so rocks carry a warm fill of their own.
  // Smooth-shaded: the lumps are welded for it, and flat facets read as a
  // low-poly model rather than worn rock.
  rock: new THREE.MeshStandardMaterial({
    color: '#6a6358',
    roughness: 0.95,
    emissive: '#7a7160',
    emissiveIntensity: 0.5,
  }),
  periwinkle: new THREE.MeshStandardMaterial({
    color: '#5a6a78',
    roughness: 0.6,
    flatShading: true,
  }),
  coral: new THREE.MeshStandardMaterial({
    color: '#c87888',
    roughness: 0.75,
    flatShading: true,
    emissive: '#ff6a9a',
    emissiveIntensity: 0,
  }),
  coralDeep: new THREE.MeshStandardMaterial({
    color: '#6a4a78',
    roughness: 0.8,
    flatShading: true,
    emissive: '#5a8aff',
    emissiveIntensity: 0,
  }),
  oyster: new THREE.MeshStandardMaterial({
    color: '#9a8a70',
    roughness: 0.7,
    flatShading: true,
  }),
  /** Sheer face of the island shelf drop-off — swim-along reef wall. */
  wall: new THREE.MeshStandardMaterial({
    color: '#5a554c',
    roughness: 0.97,
    emissive: '#6f6859',
    emissiveIntensity: 0.7,
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

/** A short buttress of shelf rock — reads the drop-off as a wall you follow. */
function wallButtress(m: ReturnType<typeof mats>, seed: number) {
  // A heap of rounded boulders rather than a slab — reads as fallen rock at the
  // foot of the drop-off, and stays low enough not to break the surface at ebb
  const g = new THREE.Group()
  const lumps = 3 + (seed % 3)
  for (let i = 0; i < lumps; i++) {
    const r = 0.45 + scatter(seed * 7 + i, 1.7) * 0.55
    // Welded first, so the displacement moves shared corners together and the
    // lump stays solid instead of tearing along its facets
    const base = new THREE.IcosahedronGeometry(r, 1)
    base.deleteAttribute('uv')
    base.deleteAttribute('normal')
    const geo = mergeVertices(base)
    const pos = geo.attributes.position
    for (let v = 0; v < pos.count; v++) {
      const k = 0.82 + scatter(seed * 31 + i * 13 + v, 2.9) * 0.36
      pos.setXYZ(v, pos.getX(v) * k * 1.15, pos.getY(v) * k * 0.7, pos.getZ(v) * k)
    }
    geo.computeVertexNormals()
    const rock = new THREE.Mesh(geo, i % 2 === 0 ? m.rock : m.wall)
    rock.position.set(
      (scatter(seed + i, 3.1) - 0.5) * 1.8,
      r * 0.35 + (i === 0 ? 0 : 0.15 * i),
      (scatter(seed + i, 4.3) - 0.5) * 1.2,
    )
    rock.rotation.y = i * 1.9
    g.add(rock)
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

const scatter = (i: number, salt: number) => {
  const n = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return n - Math.floor(n)
}

export function createLittoral(scene: THREE.Scene, deps: LittoralDeps) {
  const m = mats()
  const seals: Seal[] = []
  const ox = deps.origin.x
  const oz = deps.origin.z
  const coveX = deps.cove?.x ?? ox
  const coveZ = deps.cove?.z ?? oz
  const want = deps.lowPower
    ? { limpet: 8, mussel: 6, urchin: 4, kelp: 3, seal: 1, coral: 3 }
    : { limpet: 18, mussel: 14, urchin: 9, kelp: 6, seal: 3, coral: 7 }

  /** Plant a bit of shore life. */
  function place(object: THREE.Object3D, x: number, y: number, z: number) {
    object.position.set(x, y, z)
    scene.add(object)
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
    place(limpetMesh(m), wx, h + 0.04, wz)
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
    place(musselMesh(m), wx, h + 0.05, wz)
    mussels++
  }

  // —— drop-off wall (shelf face you swim along) + urchins ——————————
  {
    const wallCount = deps.lowPower ? 8 : 16
    let walls = 0
    for (let i = 0; i < 1500 && walls < wallCount; i++) {
      const angle = i * 2.399 + 0.15
      // The barrier reef's outer face, wherever it wanders off this bearing
      const radius = 300 + ((i * 7) % 120)
      const wx = ox + Math.cos(angle) * radius
      const wz = oz + Math.sin(angle) * radius
      const h = deps.heightAt(wx, wz)
      if (h > -0.4 || h < -9.5) continue
      // Prefer the steep face — probe a step seaward; wall where it drops hard
      const outX = ox + Math.cos(angle) * (radius + 6)
      const outZ = oz + Math.sin(angle) * (radius + 6)
      const drop = h - deps.heightAt(outX, outZ)
      if (drop < 1.8) continue
      if (scatter(i, 5.5) > 0.55) continue
      const buttress = wallButtress(m, i)
      buttress.position.set(wx, h + 0.05, wz)
      buttress.rotation.y = angle + Math.PI
      scene.add(buttress)
      walls++
    }
  }

  let urchins = 0
  for (let i = 0; i < 900 && urchins < want.urchin; i++) {
    const angle = i * 2.618
    const radius = 250 + ((i * 23) % 90)
    const wx = ox + Math.cos(angle) * radius
    const wz = oz + Math.sin(angle) * radius
    const h = deps.heightAt(wx, wz)
    if (h > -0.2 || h < -8.5) continue
    if (scatter(i, 3.3) > 0.48) continue
    place(urchinMesh(m), wx, h + 0.06, wz)
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
        place(kelpClump(m), probe.x, probe.y - 0.2, probe.z)
      } else {
        place(musselMesh(m), probe.x, probe.y - 0.35, probe.z)
      }
      kelp++
    }
  }

  // —— coral gardens (geometry + dive forage) ————————————————————
  const coralRoots: THREE.Object3D[] = []
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
        coralRoots.push(coral)
        if (kind === 0) {
          place(oysterMesh(m), probe.x + 0.2, probe.y + 0.15, probe.z)
        } else {
          place(coralSnailMesh(m), probe.x - 0.15, probe.y + 0.25, probe.z + 0.1)
        }
        planted++
      }
    }
    // Island shelf / drop-off wall gardens — cling to the steep face
    for (let i = 0; i < 700 && planted < want.coral + (deps.lowPower ? 3 : 7); i++) {
      const angle = i * 2.155 + 1.2
      const radius = 255 + ((i * 29) % 85)
      const wx = ox + Math.cos(angle) * radius
      const wz = oz + Math.sin(angle) * radius
      const h = deps.heightAt(wx, wz)
      if (h > -0.5 || h < -9) continue
      if (scatter(i, 4.4) > 0.38) continue
      const kind = planted % 3
      const coral = kind === 0 ? brainCoral(m, i) : kind === 1 ? stagCoral(m, i) : plateCoral(m)
      coral.position.set(wx, h + 0.05, wz)
      coral.rotation.y = i * 0.9
      // Tip slightly seaward so plates read on the wall face
      coral.rotation.z = Math.cos(angle) * 0.25
      coral.rotation.x = Math.sin(angle) * 0.25
      scene.add(coral)
      coralRoots.push(coral)
      if (kind !== 2) {
        place(oysterMesh(m), wx + 0.15, h + 0.35, wz)
      } else {
        place(coralSnailMesh(m), wx - 0.12, h + 0.4, wz + 0.1)
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
  // Unknown until the first frame, so a low tide at arrival isn't announced
  // over the fade-in as if it had just happened
  let lastLow: boolean | null = null
  let saidSealFish = false
  let saidWall = false
  let saidAbyss = false
  let saidCoralGlow = false

  function update(
    dt: number,
    player: { x: number; z: number; y?: number },
    weather: { biolum?: number } = {},
  ) {
    const tide = oceanState.tide
    const biolum = weather.biolum ?? 0
    const low = tide < -0.2
    if (lastLow === null) {
      lastLow = low
    } else if (low !== lastLow) {
      lastLow = low
      if (low && !saidTide) {
        saidTide = true
        deps.hud.whisper('The tide has gone out.')
      } else if (!low && saidTide && tide > 0.25) {
        deps.hud.whisper('The tide is turning.')
      }
    }

    // Night bioluminescence — coral takes the same glow the jellies already know
    const pulse = 0.85 + 0.15 * Math.sin(performance.now() * 0.0021)
    const glow = biolum * pulse
    m.coral.emissiveIntensity = glow * 1.45
    m.coralDeep.emissiveIntensity = glow * 1.85
    if (biolum > 0.45 && !saidCoralGlow && coralRoots.length > 0) {
      let near = false
      for (const c of coralRoots) {
        if (Math.hypot(player.x - c.position.x, player.z - c.position.z) < 12) {
          near = true
          break
        }
      }
      if (near) {
        saidCoralGlow = true
        deps.hud.whisper('The coral glows softly in the dark.')
      }
    }

    // Drop-off wall — whisper once when you find the steep face
    if (!saidWall) {
      const lx = player.x - ox
      const lz = player.z - oz
      const r = Math.hypot(lx, lz)
      const py = player.y ?? 0
      if (r > 250 && r < 340 && py < -0.8 && py > -12) {
        const bearing = Math.atan2(lz, lx)
        const outX = ox + Math.cos(bearing) * (r + 8)
        const outZ = oz + Math.sin(bearing) * (r + 8)
        const drop = deps.heightAt(player.x, player.z) - deps.heightAt(outX, outZ)
        if (drop > 2.2) {
          saidWall = true
          deps.hud.whisper('The shelf falls away into deeper blue.')
        }
      }
    }

    // Abyss between wreck and island — the column goes black past the lip
    if (!saidAbyss) {
      const lx = player.x - ox
      const lz = player.z - oz
      const r = Math.hypot(lx, lz)
      const py = player.y ?? 0
      const floor = deps.heightAt(player.x, player.z)
      if (r > 310 && r < 520 && py < -1.2 && floor < -28) {
        saidAbyss = true
        deps.hud.whisper('The floor drops away. Blue deepens toward black.')
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
        if (s.spook > 0) deps.hud.whisper('The seal slips quietly into the water.')
        s.object.position.set(s.swimX, tide - 0.35, s.swimZ)
        s.object.rotation.x = 0.25
      } else if (!s.hauled) {
        s.object.position.y = tide - 0.3 + Math.sin(performance.now() * 0.0015 + s.haulX) * 0.08
        s.object.visible = true
        if (!saidSealFish && dist < 14) {
          saidSealFish = true
          deps.hud.whisper('Fish gather in the water around the seal.')
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

  return { update, fishAttractors }
}

export type Littoral = ReturnType<typeof createLittoral>
