import * as THREE from 'three'
import type { Hud } from './hud'
import type { Interactable, Interactions } from './interact'
import type { Salvage } from './salvage'
import type { Vitals } from './survival'

/**
 * Island harvest — the decorative palms and grass stay scenery; a thinner
 * set of workable plants sit on top of them so Chop / Pull / Break read as
 * real verbs without fighting the instanced foliage.
 *
 * Wood becomes planks. Grass twists into rope. Fell a standing palm only
 * once you have the galley knife — fallen wood breaks by hand.
 */

export type HarvestDeps = {
  interactions: Interactions
  salvage: Salvage
  vitals: Vitals
  hud: Hud
  /** World ground height (mesh surface). */
  heightAt: (x: number, z: number) => number
  /** Beach landing spots — soft wood and grass near landfall. */
  shore: THREE.Vector3[]
  islandCentre: THREE.Vector3
  /** Knife opens standing palms. */
  hasKnife: () => boolean
  lowPower?: boolean
}

type Node = {
  kind: 'palm' | 'log' | 'grass'
  object: THREE.Group
  item: Interactable
  taken: boolean
  /** Grass comes back; wood does not. */
  returnAt: number
}

function mats() {
  return {
    trunk: new THREE.MeshStandardMaterial({
      color: 0x6a5338,
      roughness: 0.96,
      side: THREE.DoubleSide,
    }),
    frond: new THREE.MeshStandardMaterial({
      color: 0x3d6a2e,
      roughness: 0.9,
      side: THREE.DoubleSide,
    }),
    stump: new THREE.MeshStandardMaterial({ color: 0x4a3828, roughness: 1 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x7a6244, roughness: 0.95 }),
    grass: new THREE.MeshStandardMaterial({
      color: 0x5a7a38,
      roughness: 0.92,
      side: THREE.DoubleSide,
    }),
    nut: new THREE.MeshStandardMaterial({ color: 0x6c4a2b, roughness: 1 }),
  }
}

type Mats = ReturnType<typeof mats>

function palmMesh(m: Mats, seed: number) {
  const g = new THREE.Group()
  g.name = 'harvestPalm'
  const h = 5.2 + (seed % 7) * 0.35
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.26, h, 6, 3), m.trunk)
  trunk.position.y = h / 2
  trunk.rotation.z = ((seed % 5) - 2) * 0.04
  g.add(trunk)
  for (let i = 0; i < 8; i++) {
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 2.6, 1, 3), m.frond)
    const pos = blade.geometry.attributes.position
    for (let v = 0; v < pos.count; v++) {
      const t = (pos.getY(v) + 1.3) / 2.6
      pos.setZ(v, (1 - t) * (1 - t) * 0.55)
    }
    blade.geometry.computeVertexNormals()
    blade.position.set(0, h - 0.15, 0)
    blade.rotation.order = 'YXZ'
    blade.rotation.y = (i / 8) * Math.PI * 2
    blade.rotation.x = 0.85 + (i % 3) * 0.12
    g.add(blade)
  }
  for (let i = 0; i < 2; i++) {
    const nut = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14, 0), m.nut)
    nut.position.set(Math.cos(i * 2.2) * 0.22, h - 0.4, Math.sin(i * 2.2) * 0.22)
    g.add(nut)
  }
  const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.35, 6), m.stump)
  stump.position.y = 0.12
  stump.name = 'stump'
  stump.visible = false
  g.add(stump)
  return g
}

function logMesh(m: Mats, seed: number) {
  const g = new THREE.Group()
  g.name = 'harvestLog'
  const len = 2.4 + (seed % 5) * 0.25
  const log = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, len, 6, 2), m.wood)
  log.rotation.z = Math.PI / 2
  log.rotation.y = (seed % 10) * 0.31
  log.position.y = 0.16
  g.add(log)
  return g
}

function grassMesh(m: Mats, seed: number) {
  const g = new THREE.Group()
  g.name = 'harvestGrass'
  const blades = 7 + (seed % 4)
  for (let i = 0; i < blades; i++) {
    const h = 0.55 + ((seed + i) % 5) * 0.08
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.08, h, 1, 2), m.grass)
    const pos = blade.geometry.attributes.position
    for (let v = 0; v < pos.count; v++) {
      const t = (pos.getY(v) + h / 2) / h
      pos.setX(v, pos.getX(v) + Math.sin(t * 2.2) * 0.04)
    }
    blade.geometry.computeVertexNormals()
    blade.position.set(
      Math.cos(i * 1.7 + seed) * 0.12,
      h / 2,
      Math.sin(i * 1.7 + seed) * 0.12,
    )
    blade.rotation.y = i * 0.9
    blade.rotation.z = ((i % 3) - 1) * 0.15
    g.add(blade)
  }
  return g
}

function plantAt(
  scene: THREE.Scene,
  object: THREE.Group,
  x: number,
  z: number,
  heightAt: (x: number, z: number) => number,
) {
  const y = heightAt(x, z)
  object.position.set(x, y, z)
  scene.add(object)
  return y
}

export function createHarvest(scene: THREE.Scene, deps: HarvestDeps) {
  const m = mats()
  const nodes: Node[] = []
  const low = !!deps.lowPower

  const palmWanted = low ? 4 : 8
  const logWanted = low ? 5 : 10
  const grassWanted = low ? 8 : 16

  function addNode(
    kind: Node['kind'],
    object: THREE.Group,
    x: number,
    z: number,
    verb: string,
    label: string,
    use: (node: Node) => void,
    radius = 2.8,
  ) {
    plantAt(scene, object, x, z, deps.heightAt)
    const node: Node = {
      kind,
      object,
      taken: false,
      returnAt: 0,
      item: deps.interactions.add({
        position: new THREE.Vector3(x, deps.heightAt(x, z) + 0.9, z),
        verb,
        label,
        radius,
        available: () => deps.vitals.alive && !node.taken,
        use: () => use(node),
      }),
    }
    nodes.push(node)
    return node
  }

  // —— palms near the cove and inland fringe ————————————————
  const shore = deps.shore
  let palms = 0
  for (let i = 0; i < 40 && palms < palmWanted; i++) {
    const base =
      shore.length > 0
        ? shore[i % shore.length]
        : deps.islandCentre
    const ang = i * 2.399
    const r = 8 + (i % 5) * 6.5
    const x = base.x + Math.cos(ang) * r + ((i * 17) % 7) - 3
    const z = base.z + Math.sin(ang) * r + ((i * 13) % 7) - 3
    const h = deps.heightAt(x, z)
    if (h < 0.8 || h > 9) continue
    // Keep clear of the wet wash
    if (h < 1.1 && i % 2 === 0) continue
    addNode(
      'palm',
      palmMesh(m, i + 3),
      x,
      z,
      'Fell',
      'Palm',
      (node) => {
        if (!deps.hasKnife()) {
          deps.hud.whisper('The trunk will not give without a blade.')
          return
        }
        node.taken = true
        // Hide crown and trunk; leave the stump
        for (const child of node.object.children) {
          if (child.name === 'stump') child.visible = true
          else child.visible = false
        }
        deps.salvage.stash.plank += 2
        deps.hud.whisper('The palm comes down. Two lengths of wood.')
      },
      3.2,
    )
    palms++
  }

  // —— fallen / beach wood ————————————————————————————————
  let logs = 0
  for (let i = 0; i < 50 && logs < logWanted; i++) {
    const base =
      shore.length > 0
        ? shore[(i * 3) % shore.length]
        : deps.islandCentre
    const ang = i * 1.7 + 0.4
    const r = 4 + (i % 6) * 5.5
    const x = base.x + Math.cos(ang) * r + ((i * 11) % 5) - 2
    const z = base.z + Math.sin(ang) * r + ((i * 19) % 5) - 2
    const h = deps.heightAt(x, z)
    if (h < 0.35 || h > 7.5) continue
    addNode(
      'log',
      logMesh(m, i + 9),
      x,
      z,
      'Break',
      'Driftwood',
      (node) => {
        node.taken = true
        node.object.visible = false
        deps.salvage.stash.plank += 1
        deps.hud.whisper('The wood splits. One plank.')
      },
      2.6,
    )
    logs++
  }

  // —— grass tufts ——————————————————————————————————————————
  let grasses = 0
  for (let i = 0; i < 80 && grasses < grassWanted; i++) {
    const base =
      shore.length > 0
        ? shore[(i * 5) % shore.length]
        : deps.islandCentre
    const ang = i * 2.05
    const r = 6 + (i % 8) * 4.2
    const x = base.x + Math.cos(ang) * r + ((i * 7) % 9) - 4
    const z = base.z + Math.sin(ang) * r + ((i * 23) % 9) - 4
    const h = deps.heightAt(x, z)
    if (h < 0.9 || h > 11) continue
    addNode(
      'grass',
      grassMesh(m, i + 21),
      x,
      z,
      'Pull',
      'Grass',
      (node) => {
        node.taken = true
        node.object.visible = false
        node.returnAt = performance.now() / 1000 + 90 + (i % 5) * 12
        deps.salvage.stash.rope += 1
        deps.hud.whisper('Long blades. Twist them and they hold like rope.')
      },
      2.4,
    )
    grasses++
  }

  function update(_time: number) {
    const now = performance.now() / 1000
    for (const node of nodes) {
      if (!node.taken) continue
      if (node.kind !== 'grass') continue
      if (node.returnAt <= 0 || now < node.returnAt) continue
      node.taken = false
      node.returnAt = 0
      node.object.visible = true
    }
  }

  function reset() {
    for (const node of nodes) {
      node.taken = false
      node.returnAt = 0
      node.object.visible = true
      if (node.kind === 'palm') {
        for (const child of node.object.children) {
          child.visible = child.name !== 'stump'
        }
      }
    }
  }

  return { update, reset }
}

export type Harvest = ReturnType<typeof createHarvest>
