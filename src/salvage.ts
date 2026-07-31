import * as THREE from 'three'
import type { Interactable, Interactions } from './interact'
import { eat, type Vitals } from './survival'
import { sampleOcean } from './waves'
import { barrelObject, crateObject, plankObject } from './wreck'

/**
 * Everything you can take out of the ocean.
 *
 * Two populations. **Drifters** are ocean debris: a rolling pool kept somewhere
 * in the haze around you and recycled once you've left them behind, so open
 * water always has something in it without ever pointing at it. **Fixed** finds
 * — the wreck's flotsam, shellfish on the reef, the hatch stash, coconuts on
 * the beach — exist once per run and stay taken.
 */

export type StashKind = 'plank' | 'barrel' | 'crate' | 'rope' | 'canvas'
export type Stash = Record<StashKind, number>

const STASH_LABEL: Record<StashKind, { one: string; many: string }> = {
  plank: { one: 'Plank', many: 'Planks' },
  barrel: { one: 'Barrel', many: 'Barrels' },
  crate: { one: 'Crate', many: 'Crates' },
  rope: { one: 'Rope', many: 'Rope' },
  canvas: { one: 'Canvas', many: 'Canvas' },
}

/** How far a drifter gets before it counts as left behind. */
const RECYCLE = 360
const RESPAWN_MIN = 170
const RESPAWN_MAX = 300

function materials() {
  return {
    wood: new THREE.MeshStandardMaterial({
      color: 0x8a6f4c,
      roughness: 0.94,
      side: THREE.DoubleSide,
    }),
    iron: new THREE.MeshStandardMaterial({ color: 0x5a5048, roughness: 0.65, metalness: 0.55 }),
    husk: new THREE.MeshStandardMaterial({ color: 0x6c4a2b, roughness: 1 }),
    weed: new THREE.MeshStandardMaterial({
      color: 0x4a6c3b,
      roughness: 0.9,
      side: THREE.DoubleSide,
    }),
    shell: new THREE.MeshStandardMaterial({ color: 0x9c907c, roughness: 0.62 }),
    rope: new THREE.MeshStandardMaterial({ color: 0x8d7c5c, roughness: 1 }),
    cloth: new THREE.MeshStandardMaterial({
      color: 0xb5a88e,
      roughness: 0.92,
      side: THREE.DoubleSide,
      emissive: 0x3c444b,
      emissiveIntensity: 0.4,
    }),
  }
}

type Mats = ReturnType<typeof materials>

function coconutObject(mat: Mats) {
  const group = new THREE.Group()
  const nut = new THREE.Mesh(new THREE.IcosahedronGeometry(0.21, 1), mat.husk)
  nut.scale.set(1, 1.2, 1)
  group.add(nut)
  const eyes = new THREE.Mesh(new THREE.CircleGeometry(0.09, 6), mat.wood)
  eyes.position.y = 0.24
  eyes.rotation.x = -Math.PI / 2
  group.add(eyes)
  return group
}

/** A raft of torn weed, the kind that collects in a slick out at sea. */
function kelpObject(mat: Mats) {
  const group = new THREE.Group()
  for (let i = 0; i < 6; i++) {
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 1.5 + (i % 3) * 0.5, 1, 3), mat.weed)
    const shape = blade.geometry.attributes.position
    for (let v = 0; v < shape.count; v++) {
      shape.setZ(v, Math.sin(shape.getY(v) * 2.2 + i) * 0.12)
    }
    blade.geometry.computeVertexNormals()
    blade.rotation.set(Math.PI / 2 + (i % 2) * 0.12, i * 1.05, 0)
    blade.position.set(Math.cos(i * 1.7) * 0.35, 0, Math.sin(i * 1.7) * 0.35)
    group.add(blade)
  }
  return group
}

function shellfishObject(mat: Mats) {
  const group = new THREE.Group()
  for (let i = 0; i < 5; i++) {
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 7, 5, 0, Math.PI * 2, 0, 1.2),
      mat.shell,
    )
    shell.scale.set(1, 0.55, 1.3)
    shell.rotation.set(0.3 + (i % 3) * 0.2, i * 1.3, (i % 2) * 0.4)
    shell.position.set(Math.cos(i * 2.1) * 0.2, (i % 2) * 0.05, Math.sin(i * 2.1) * 0.2)
    group.add(shell)
  }
  return group
}

function ropeObject(mat: Mats) {
  const group = new THREE.Group()
  for (let i = 0; i < 3; i++) {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.34 - i * 0.07, 0.05, 5, 14), mat.rope)
    coil.rotation.x = Math.PI / 2
    coil.position.y = i * 0.09
    group.add(coil)
  }
  return group
}

function canvasObject(mat: Mats) {
  const group = new THREE.Group()
  const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.95, 8), mat.cloth)
  roll.rotation.z = Math.PI / 2
  group.add(roll)
  const flap = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.5, 3, 2), mat.cloth)
  const shape = flap.geometry.attributes.position
  for (let v = 0; v < shape.count; v++) shape.setZ(v, Math.sin(shape.getX(v) * 4) * 0.06)
  flap.geometry.computeVertexNormals()
  flap.position.set(0.1, -0.14, 0.1)
  flap.rotation.set(-1.3, 0.2, 0)
  group.add(flap)
  return group
}

type Drift = {
  x: number
  z: number
  lift: number
  spin: number
  phase: number
  /** Earliest time this slot may come back after being taken. */
  returnAt: number
}

type Find = {
  object: THREE.Object3D
  item: Interactable
  taken: boolean
  drift?: Drift
}

export type SalvageOptions = {
  interactions: Interactions
  vitals: Vitals
  lowPower?: boolean
  /** The wreck's own flotsam, made takeable where it floats. */
  wreckFlotsam: { object: THREE.Object3D; kind: StashKind }[]
  wreckOrigin: THREE.Vector3
  /** Pushes a point out of the reef — used to plant shellfish on real rock. */
  reefResolve: (p: { x: number; y: number; z: number }) => void
  /** Deck hatch on the bow section, in world space. */
  hatch: THREE.Vector3
  /** Beach spots, for whoever makes the crossing. */
  shore: THREE.Vector3[]
}

export function createSalvage(scene: THREE.Scene, opts: SalvageOptions) {
  const mat = materials()
  const { interactions, vitals } = opts

  const stash: Stash = { plank: 0, barrel: 0, crate: 0, rope: 0, canvas: 0 }
  const finds: Find[] = []
  const up = new THREE.Vector3(0, 1, 0)
  const waveUp = new THREE.Vector3()
  const tilt = new THREE.Quaternion()
  const spin = new THREE.Quaternion()

  function retire(find: Find) {
    find.taken = true
    find.object.visible = false
  }

  const take = (find: Find, kind: StashKind) => {
    stash[kind] += 1
    retire(find)
  }

  const consume = (find: Find, food: number, water: number) => {
    eat(vitals, food, water)
    retire(find)
  }

  function register(
    object: THREE.Object3D,
    verb: string,
    label: string,
    use: (find: Find) => void,
    radius = 2.9,
  ): Find {
    const find: Find = {
      object,
      taken: false,
      item: interactions.add({
        position: new THREE.Vector3(),
        verb,
        label,
        radius,
        available: () => !find.taken,
        use: () => use(find),
      }),
    }
    finds.push(find)
    return find
  }

  const dropAt = (object: THREE.Object3D, at: THREE.Vector3) => {
    object.position.copy(at)
    scene.add(object)
    return object
  }

  // —— the wreck's flotsam, now worth swimming out for ————————————
  // Named pieces (the provision crate) belong to the wreck's own loot
  // chain, not the stash pool
  for (const item of opts.wreckFlotsam) {
    if ((item as { id?: string }).id) continue
    register(item.object, 'Take', STASH_LABEL[item.kind].one, (find) => take(find, item.kind))
  }

  // —— the wreck itself ————————————————————————————————————————
  {
    const rope = dropAt(ropeObject(mat), opts.hatch.clone().add(new THREE.Vector3(1.5, 0.6, -0.9)))
    register(rope, 'Take', 'Rope', (find) => take(find, 'rope'))

    const cloth = dropAt(canvasObject(mat), opts.hatch.clone().add(new THREE.Vector3(-1.2, 0.5, 1.4)))
    register(cloth, 'Take', 'Canvas', (find) => take(find, 'canvas'))

    // The hatch has one stash in it per run: salt pork and a stoppered jar.
    // Its lid is already modelled on the deck, so this find is only a hotspot.
    const hotspot = dropAt(new THREE.Object3D(), opts.hatch)
    register(
      hotspot,
      'Open',
      'Hatch',
      (find) => {
        eat(vitals, 0.45, 0.4)
        stash.canvas += 1
        find.taken = true
      },
      3.4,
    )
  }

  // Shellfish only stick where there is actually rock, so every candidate goes
  // through the reef collider and is kept only if the reef caught it.
  {
    const wanted = opts.lowPower ? 4 : 7
    let planted = 0
    for (let i = 0; i < 40 && planted < wanted; i++) {
      const angle = i * 2.399
      const radius = 5 + (i % 5) * 4.5
      const probe = {
        x: opts.wreckOrigin.x + Math.cos(angle) * radius,
        y: -6 - (i % 4) * 2.4,
        z: opts.wreckOrigin.z + Math.sin(angle) * radius,
      }
      const before = probe.y
      opts.reefResolve(probe)
      if (probe.y <= before + 0.05) continue

      const cluster = dropAt(
        shellfishObject(mat),
        new THREE.Vector3(probe.x, probe.y - 0.45, probe.z),
      )
      register(cluster, 'Eat', 'Shellfish', (find) => consume(find, 0.22, 0.04), 2.4)
      planted++
    }
  }

  for (let i = 0; i < opts.shore.length; i += 3) {
    const at = opts.shore[i].clone()
    at.y += 0.22
    register(dropAt(coconutObject(mat), at), 'Drink', 'Coconut', (f) => consume(f, 0.12, 0.45), 2.6)
  }

  // —— drifters ————————————————————————————————————————————————
  const drifterKinds = [
    { build: () => plankObject(2.6, 0.34, mat.wood), verb: 'Take', label: 'Plank', lift: 0.04, use: (f: Find) => take(f, 'plank') },
    { build: () => barrelObject(mat.wood, mat.iron), verb: 'Take', label: 'Barrel', lift: 0.12, use: (f: Find) => take(f, 'barrel') },
    { build: () => kelpObject(mat), verb: 'Eat', label: 'Kelp', lift: 0.02, use: (f: Find) => consume(f, 0.14, 0.02) },
    { build: () => plankObject(1.7, 0.26, mat.wood), verb: 'Take', label: 'Plank', lift: 0.03, use: (f: Find) => take(f, 'plank') },
    { build: () => coconutObject(mat), verb: 'Drink', label: 'Coconut', lift: 0.08, use: (f: Find) => consume(f, 0.12, 0.45) },
    { build: () => crateObject(mat.wood), verb: 'Take', label: 'Crate', lift: 0.16, use: (f: Find) => take(f, 'crate') },
  ]

  const drifters: Find[] = []
  for (let i = 0; i < (opts.lowPower ? 9 : 14); i++) {
    const kind = drifterKinds[i % drifterKinds.length]
    const find = register(dropAt(kind.build(), new THREE.Vector3()), kind.verb, kind.label, kind.use)
    find.drift = {
      x: 0,
      z: 0,
      lift: kind.lift,
      spin: (i % 5) * 0.02 - 0.04,
      phase: i * 1.7,
      returnAt: 0,
    }
    drifters.push(find)
  }

  /** Park a drifter somewhere out in the haze. */
  function scatter(find: Find, around: THREE.Vector3, near = RESPAWN_MIN, far = RESPAWN_MAX) {
    const drift = find.drift
    if (!drift) return
    const angle = Math.random() * Math.PI * 2
    const range = near + Math.random() * Math.max(1, far - near)
    drift.x = around.x + Math.cos(angle) * range
    drift.z = around.z + Math.sin(angle) * range
    find.taken = false
    find.object.visible = true
  }

  function update(time: number, viewer: THREE.Vector3) {
    for (const find of finds) {
      const drift = find.drift

      if (drift) {
        if (find.taken) {
          // Taken debris comes back as fresh debris, but not straight away
          if (drift.returnAt === 0) drift.returnAt = time + 30 + Math.random() * 45
          if (time < drift.returnAt) continue
          drift.returnAt = 0
          scatter(find, viewer)
        } else if (Math.hypot(drift.x - viewer.x, drift.z - viewer.z) > RECYCLE) {
          scatter(find, viewer)
        }

        const water = sampleOcean(drift.x, drift.z, time)
        find.object.position.set(drift.x, water.y + drift.lift, drift.z)
        waveUp.set(water.normal.x, water.normal.y, water.normal.z)
        tilt.setFromUnitVectors(up, waveUp)
        spin.setFromAxisAngle(up, drift.phase + time * drift.spin)
        find.object.quaternion.copy(tilt).multiply(spin)
        find.item.position.copy(find.object.position)
        continue
      }

      if (find.taken) continue
      // Wreck flotsam is parented to the wreck and rides its own swell; the
      // rest was dropped straight into the scene at a world position.
      if (find.object.parent && find.object.parent !== scene) {
        find.item.position.copy(find.object.position).add(opts.wreckOrigin)
      } else {
        find.item.position.copy(find.object.position)
      }
    }
  }

  function reset(viewer: THREE.Vector3) {
    for (const key of Object.keys(stash) as StashKind[]) stash[key] = 0
    for (const find of finds) {
      find.taken = false
      find.object.visible = true
      if (find.drift) {
        find.drift.returnAt = 0
        scatter(find, viewer, 22, 140)
      }
    }
  }

  // Seed the first spread close in, so the opening minute has something in it
  const origin = new THREE.Vector3()
  drifters.forEach((find, i) => scatter(find, origin, 18 + i * 14, 40 + i * 20))

  return { stash, labels: STASH_LABEL, update, reset }
}

export type Salvage = ReturnType<typeof createSalvage>
