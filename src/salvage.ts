import * as THREE from 'three'
import type { Interactable, Interactions } from './interact'
import { heaviestKind } from './logistics'
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

export type StashKind =
  | 'plank'
  | 'barrel'
  | 'crate'
  | 'rope'
  | 'canvas'
  | 'plastic'
  | 'can'
  | 'leaf'
  | 'nut'
  | 'shell'
export type Stash = Record<StashKind, number>

const STASH_LABEL: Record<StashKind, { one: string; many: string }> = {
  plank: { one: 'Plank', many: 'Planks' },
  barrel: { one: 'Barrel', many: 'Barrels' },
  crate: { one: 'Crate', many: 'Crates' },
  rope: { one: 'Rope', many: 'Rope' },
  canvas: { one: 'Canvas', many: 'Canvas' },
  plastic: { one: 'Bottle', many: 'Bottles' },
  can: { one: 'Can', many: 'Cans' },
  leaf: { one: 'Frond', many: 'Fronds' },
  nut: { one: 'Coconut', many: 'Coconuts' },
  shell: { one: 'Shell', many: 'Shells' },
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
    plastic: new THREE.MeshStandardMaterial({
      color: 0xc8d6e0,
      roughness: 0.35,
      metalness: 0.05,
      transparent: true,
      opacity: 0.82,
    }),
    tin: new THREE.MeshStandardMaterial({
      color: 0x8a9188,
      roughness: 0.45,
      metalness: 0.7,
    }),
    label: new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.95 }),
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

function shellObject(mat: Mats) {
  const group = new THREE.Group()
  const cup = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 8, 6, 0, Math.PI * 2, 0, 1.35),
    mat.shell,
  )
  cup.scale.set(1.1, 0.55, 1.25)
  cup.rotation.x = 0.35
  group.add(cup)
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.018, 4, 10), mat.shell)
  lip.rotation.x = Math.PI / 2
  lip.position.y = 0.06
  group.add(lip)
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

/** A washed-up plastic bottle — ugly, sealed, and it floats. */
function plasticBottleObject(mat: Mats) {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.32, 8), mat.plastic)
  body.position.y = 0.06
  group.add(body)
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.045, 0.1, 6), mat.plastic)
  neck.position.y = 0.26
  group.add(neck)
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.035, 6), mat.tin)
  cap.position.y = 0.32
  group.add(cap)
  return group
}

/** A rusted tin — whatever was in it is gone; the metal is still useful. */
function tinCanObject(mat: Mats) {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.16, 10), mat.tin)
  group.add(body)
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.078, 0.04, 10), mat.label)
  band.position.y = 0.01
  group.add(band)
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.008, 4, 12), mat.tin)
  rim.rotation.x = Math.PI / 2
  rim.position.y = 0.08
  group.add(rim)
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
  /** Dropped from the arms — not a pool drifter; gone once taken or left behind. */
  jettisoned?: boolean
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
  /** Rain-filled rock hollows above the beach — the island's one renewable. */
  pools: THREE.Vector3[]
  /** Inland rock stack — one takeable find, no marker. */
  cairn: THREE.Vector3 | null
  /** Soft line when a find is more than materials. */
  whisper?: (text: string) => void
}

/** Seconds a drained rock hollow takes to catch enough rain to matter again. */
const POOL_REFILL = 260

export function createSalvage(scene: THREE.Scene, opts: SalvageOptions) {
  const mat = materials()
  const { interactions, vitals } = opts

  const stash: Stash = {
    plank: 0,
    barrel: 0,
    crate: 0,
    rope: 0,
    canvas: 0,
    plastic: 0,
    can: 0,
    leaf: 0,
    nut: 0,
    shell: 0,
  }
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

  /** True when every listed cost is covered. */
  const has = (cost: Partial<Record<StashKind, number>>) => {
    for (const key of Object.keys(cost) as StashKind[]) {
      if (stash[key] < (cost[key] ?? 0)) return false
    }
    return true
  }

  /** Spend materials. Returns false and changes nothing if short. */
  const spend = (cost: Partial<Record<StashKind, number>>) => {
    if (!has(cost)) return false
    for (const key of Object.keys(cost) as StashKind[]) {
      stash[key] -= cost[key] ?? 0
    }
    return true
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

  // —— rain pools ————————————————————————————————————————————————
  // Not a find: a place. Drink it down and it's damp rock until the weather
  // puts something back, which is the whole argument for staying ashore
  // rather than treating the island as a one-way finish line.
  const pools = opts.pools.map((at) => ({ at, full: 1 }))
  for (const pool of pools) {
    interactions.add({
      // Reach is measured from the eye, so a hotspot pinned to the ground is
      // most of a body's height further away than it looks. Lift it to about
      // where your hands would be when you crouch to the water.
      position: pool.at.clone().setY(pool.at.y + 0.85),
      verb: 'Drink from',
      label: 'the rain pool',
      radius: 3.4,
      available: () => vitals.alive && pool.full > 0.45,
      use: () => {
        eat(vitals, 0, pool.full * 0.85)
        pool.full = 0
      },
    })
  }

  /**
   * Draw fresh water from the nearest rain pool into a barrel/cistern.
   * Returns how much was taken (0 if none in reach / too empty).
   */
  function drawFromPool(x: number, z: number, want: number, maxDist = 4.2): number {
    let best: (typeof pools)[number] | null = null
    let bestD = maxDist
    for (const pool of pools) {
      const d = Math.hypot(pool.at.x - x, pool.at.z - z)
      if (d >= bestD || pool.full < 0.12) continue
      bestD = d
      best = pool
    }
    if (!best) return 0
    const take = Math.min(want, best.full)
    best.full -= take
    return take
  }

  /** True when a drinkable rock hollow is close enough to scoop from. */
  function poolNear(x: number, z: number, maxDist = 4.2): boolean {
    for (const pool of pools) {
      if (pool.full < 0.12) continue
      if (Math.hypot(pool.at.x - x, pool.at.z - z) <= maxDist) return true
    }
    return false
  }

  for (let i = 0; i < opts.shore.length; i += 3) {
    const at = opts.shore[i].clone()
    at.y += 0.22
    register(dropAt(coconutObject(mat), at), 'Take', 'Coconut', (f) => take(f, 'nut'), 2.6)
  }

  // Tide shells — scoops for barrel work, light to carry
  for (let i = 1; i < opts.shore.length; i += 4) {
    const at = opts.shore[i].clone()
    at.y += 0.12
    const sh = dropAt(shellObject(mat), at)
    sh.rotation.y = i * 0.7
    register(sh, 'Take', 'Shell', (f) => take(f, 'shell'), 2.3)
  }

  // —— inland cairn ————————————————————————————————————————————————
  // Someone stacked these stones and left rope under the top course. Finding
  // it is walking inland — no marker, same as the pools.
  if (opts.cairn) {
    const at = opts.cairn.clone()
    at.y += 0.55
    const coil = dropAt(ropeObject(mat), at)
    coil.scale.setScalar(0.85)
    register(
      coil,
      'Take',
      'Rope',
      (find) => {
        take(find, 'rope')
        opts.whisper?.('Someone stacked these. The rope still holds.')
      },
      2.8,
    )
  }

  // —— drifters ————————————————————————————————————————————————
  const drifterKinds = [
    { build: () => plankObject(2.6, 0.34, mat.wood), verb: 'Take', label: 'Plank', lift: 0.04, use: (f: Find) => take(f, 'plank') },
    { build: () => barrelObject(mat.wood, mat.iron), verb: 'Take', label: 'Barrel', lift: 0.12, use: (f: Find) => take(f, 'barrel') },
    { build: () => kelpObject(mat), verb: 'Eat', label: 'Kelp', lift: 0.02, use: (f: Find) => consume(f, 0.14, 0.02) },
    { build: () => plasticBottleObject(mat), verb: 'Take', label: 'Bottle', lift: 0.09, use: (f: Find) => take(f, 'plastic') },
    { build: () => plankObject(1.7, 0.26, mat.wood), verb: 'Take', label: 'Plank', lift: 0.03, use: (f: Find) => take(f, 'plank') },
    { build: () => coconutObject(mat), verb: 'Take', label: 'Coconut', lift: 0.08, use: (f: Find) => take(f, 'nut') },
    { build: () => tinCanObject(mat), verb: 'Take', label: 'Can', lift: 0.05, use: (f: Find) => take(f, 'can') },
    { build: () => shellObject(mat), verb: 'Take', label: 'Shell', lift: 0.04, use: (f: Find) => take(f, 'shell') },
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

  let lastTime = -1

  function buildDropped(kind: StashKind) {
    if (kind === 'barrel') return barrelObject(mat.wood, mat.iron)
    if (kind === 'crate') return crateObject(mat.wood)
    if (kind === 'rope') return ropeObject(mat)
    if (kind === 'canvas') return canvasObject(mat)
    if (kind === 'plastic') return plasticBottleObject(mat)
    if (kind === 'can') return tinCanObject(mat)
    if (kind === 'nut') return coconutObject(mat)
    if (kind === 'shell') return shellObject(mat)
    if (kind === 'leaf') {
      const g = new THREE.Group()
      for (let i = 0; i < 3; i++) {
        const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 1.4, 1, 3), mat.weed)
        blade.position.set((i - 1) * 0.12, 0.2, i * 0.05)
        blade.rotation.z = (i - 1) * 0.2
        g.add(blade)
      }
      return g
    }
    return plankObject(2.2, 0.3, mat.wood)
  }

  function disposeFind(find: Find) {
    interactions.remove(find.item)
    scene.remove(find.object)
    const idx = finds.indexOf(find)
    if (idx >= 0) finds.splice(idx, 1)
  }

  function update(time: number, viewer: THREE.Vector3, rain = 0) {
    // Rain pools refill on their own clock. Foul weather puts water back faster
    // — the cascade that makes a rain-catch and a rock hollow pay off in a gale.
    const dt = lastTime < 0 ? 0 : Math.min(0.25, time - lastTime)
    lastTime = time
    const rainBoost = 1 + Math.min(1, Math.max(0, rain)) * 1.85
    for (const pool of pools) {
      if (pool.full < 1) pool.full = Math.min(1, pool.full + (dt / POOL_REFILL) * rainBoost)
    }

    const drop: Find[] = []
    for (const find of finds) {
      const drift = find.drift

      if (drift) {
        if (find.taken) {
          if (find.jettisoned) {
            drop.push(find)
            continue
          }
          // Taken debris comes back as fresh debris, but not straight away
          if (drift.returnAt === 0) drift.returnAt = time + 30 + Math.random() * 45
          if (time < drift.returnAt) continue
          drift.returnAt = 0
          scatter(find, viewer)
        } else if (Math.hypot(drift.x - viewer.x, drift.z - viewer.z) > RECYCLE) {
          if (find.jettisoned) {
            drop.push(find)
            continue
          }
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
    for (const find of drop) disposeFind(find)
  }

  /**
   * Shed the heaviest piece into the water at `at`. Returns the kind dropped,
   * or null if the arms were empty. Debris bobs until Taken or left behind.
   */
  function jettison(at: THREE.Vector3): StashKind | null {
    const kind = heaviestKind(stash)
    if (!kind || stash[kind] <= 0) return null
    stash[kind] -= 1

    const object = dropAt(buildDropped(kind), at.clone())
    const find = register(object, 'Take', STASH_LABEL[kind].one, (f) => take(f, kind), 2.8)
    find.jettisoned = true
    find.drift = {
      x: at.x,
      z: at.z,
      lift:
        kind === 'barrel' || kind === 'crate'
          ? 0.14
          : kind === 'plastic'
            ? 0.09
            : kind === 'plank'
              ? 0.04
              : kind === 'can'
                ? 0.05
                : 0.08,
      spin: (Math.random() - 0.5) * 0.06,
      phase: Math.random() * 6,
      returnAt: 0,
    }
    return kind
  }

  function reset(viewer: THREE.Vector3) {
    for (const key of Object.keys(stash) as StashKind[]) stash[key] = 0
    for (const pool of pools) pool.full = 1
    for (let i = finds.length - 1; i >= 0; i--) {
      if (finds[i].jettisoned) disposeFind(finds[i])
    }
    for (const find of finds) {
      find.taken = false
      find.object.visible = true
      if (find.drift) {
        find.drift.returnAt = 0
        scatter(find, viewer, 22, 140)
      }
    }
  }

  function snapshot() {
    return {
      fixedTaken: finds.filter((f) => !f.drift).map((f) => f.taken),
      poolFull: pools.map((p) => p.full),
    }
  }

  function restore(
    saved: { fixedTaken: boolean[]; poolFull: number[] } | undefined,
    viewer: THREE.Vector3,
  ) {
    reset(viewer)
    if (!saved) return
    const fixed = finds.filter((f) => !f.drift)
    fixed.forEach((find, i) => {
      find.taken = !!saved.fixedTaken[i]
      find.object.visible = !find.taken
    })
    pools.forEach((pool, i) => {
      pool.full = Math.min(1, Math.max(0, saved.poolFull[i] ?? 1))
    })
  }

  function setStash(next: Stash) {
    for (const key of Object.keys(stash) as StashKind[]) {
      stash[key] = Math.max(0, Math.floor(next[key] ?? 0))
    }
  }

  // Seed the first spread close in, so the opening minute has something in it
  const origin = new THREE.Vector3()
  drifters.forEach((find, i) => scatter(find, origin, 18 + i * 14, 40 + i * 20))

  return {
    stash,
    labels: STASH_LABEL,
    has,
    spend,
    update,
    reset,
    snapshot,
    restore,
    setStash,
    jettison,
    drawFromPool,
    poolNear,
  }
}

export type Salvage = ReturnType<typeof createSalvage>
