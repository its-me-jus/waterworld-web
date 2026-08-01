import * as THREE from 'three'
import type { Hud } from './hud'
import type { Interactable, Interactions } from './interact'
import type { PlayerFrame } from './player'
import type { Salvage, StashKind } from './salvage'
import { eat, type Vitals } from './survival'
import { sampleOcean } from './waves'
import { barrelObject, plankObject } from './wreck'

/**
 * Improvise — spend what you've hauled so the world answers back.
 *
 * No craft menu, no markers. Recipes announce themselves the same way
 * everything else does: when you're standing where they'd work, with the
 * materials on you. A lean-to on the beach, a fire on the spire, a raft
 * lashed at the wreck's waterline — same F-to-use verbs, different ground.
 * The stash finally has a sink, and none of the recipes is the "right" path.
 */

export type Cost = Partial<Record<StashKind, number>>

export type ImproviseDeps = {
  interactions: Interactions
  salvage: Salvage
  vitals: Vitals
  hud: Hud
  /** Terrain only (island / spire) — builds place on this, not on other builds. */
  groundAt: (x: number, z: number) => number
  rawFish: () => number
  eatRawFish: () => boolean
  cookFish: () => boolean
}

type BuildKind = 'lean-to' | 'fire' | 'raft' | 'catch'

type Build = {
  kind: BuildKind
  object: THREE.Group
  x: number
  z: number
  deckY: number
  radius: number
  shelter: number
  water?: number
  /** Extra hotspots this build registered (drink, etc.) — cleared on reset. */
  items: Interactable[]
}

const LEAN_COST: Cost = { plank: 2, rope: 1 }
const FIRE_COST: Cost = { plank: 1 }
const CATCH_COST: Cost = { canvas: 1, rope: 1 }
const RAFT_COST: Cost = { plank: 3, rope: 1 }
const RAFT_BARREL_COST: Cost = { plank: 3, rope: 1, barrel: 1 }

const REACH = 3.2
const PLACE_AHEAD = 1.7
const CATCH_REFILL = 220

function mats() {
  return {
    wood: new THREE.MeshStandardMaterial({
      color: 0x7a6244,
      roughness: 0.95,
      side: THREE.DoubleSide,
    }),
    rope: new THREE.MeshStandardMaterial({ color: 0x8d7c5c, roughness: 1 }),
    cloth: new THREE.MeshStandardMaterial({
      color: 0xb5a88e,
      roughness: 0.92,
      side: THREE.DoubleSide,
    }),
    ember: new THREE.MeshStandardMaterial({
      color: 0x3a2a22,
      roughness: 1,
      emissive: 0xc45a1a,
      emissiveIntensity: 1.4,
    }),
    flame: new THREE.MeshStandardMaterial({
      color: 0xffb14a,
      roughness: 1,
      emissive: 0xff6a1a,
      emissiveIntensity: 2.2,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
    }),
    water: new THREE.MeshStandardMaterial({
      color: 0x6a9aaa,
      roughness: 0.2,
      metalness: 0.05,
      transparent: true,
      opacity: 0.72,
    }),
    iron: new THREE.MeshStandardMaterial({ color: 0x5a5048, roughness: 0.65, metalness: 0.55 }),
  }
}

function leanToMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 1.6), m.wood)
  roof.position.set(0, 1.15, 0.15)
  roof.rotation.x = -0.55
  g.add(roof)
  for (const [x, z] of [
    [-1.0, 0.55],
    [1.0, 0.55],
    [-0.95, -0.55],
  ] as const) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.35, 0.1), m.wood)
    post.position.set(x, 0.55, z)
    g.add(post)
  }
  const lash = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.03, 4, 8), m.rope)
  lash.position.set(-1.0, 1.05, 0.55)
  g.add(lash)
  return g
}

function fireMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  for (let i = 0; i < 5; i++) {
    const stick = plankObject(0.7, 0.08, m.wood)
    stick.position.set(Math.cos(i * 1.3) * 0.18, 0.06, Math.sin(i * 1.3) * 0.18)
    stick.rotation.set(0.4, i, 0.2)
    g.add(stick)
  }
  const coal = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), m.ember)
  coal.scale.set(1.2, 0.45, 1.2)
  coal.position.y = 0.08
  g.add(coal)
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.55, 6), m.flame)
  flame.position.y = 0.42
  flame.name = 'flame'
  g.add(flame)
  return g
}

function catchMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  for (const [x, z] of [
    [-0.7, -0.7],
    [0.7, -0.7],
    [-0.7, 0.7],
    [0.7, 0.7],
  ] as const) {
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.5, 0.07), m.wood)
    pole.position.set(x, 0.7, z)
    g.add(pole)
  }
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6, 2, 2), m.cloth)
  sheet.rotation.x = -Math.PI / 2
  sheet.position.y = 1.35
  const pos = sheet.geometry.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    pos.setZ(i, (x * x + y * y) * 0.18)
  }
  pos.needsUpdate = true
  sheet.geometry.computeVertexNormals()
  g.add(sheet)
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.4, 0.18, 10), m.wood)
  basin.position.y = 0.12
  g.add(basin)
  const water = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.06, 10), m.water)
  water.position.y = 0.2
  water.name = 'water'
  g.add(water)
  return g
}

function raftMesh(m: ReturnType<typeof mats>, withBarrel: boolean) {
  const g = new THREE.Group()
  for (let i = 0; i < 5; i++) {
    const plank = plankObject(2.8, 0.28, m.wood)
    plank.position.set(0, 0.05, (i - 2) * 0.32)
    g.add(plank)
  }
  for (const z of [-0.7, 0.7]) {
    const cross = plankObject(1.7, 0.16, m.wood)
    cross.rotation.y = Math.PI / 2
    cross.position.set(0, 0.12, z * 0.15)
    g.add(cross)
  }
  const lash = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.04, 4, 10), m.rope)
  lash.rotation.x = Math.PI / 2
  lash.position.set(1.1, 0.1, 0)
  g.add(lash)
  if (withBarrel) {
    const left = barrelObject(m.wood, m.iron)
    left.position.set(-1.3, -0.15, 0.55)
    left.rotation.z = Math.PI / 2
    g.add(left)
    const right = barrelObject(m.wood, m.iron)
    right.position.set(-1.3, -0.15, -0.55)
    right.rotation.z = Math.PI / 2
    g.add(right)
  }
  return g
}

function costLabel(cost: Cost, labels: Salvage['labels']) {
  return (Object.keys(cost) as StashKind[])
    .filter((k) => (cost[k] ?? 0) > 0)
    .map((k) => {
      const n = cost[k] ?? 0
      const name = n === 1 ? labels[k].one : labels[k].many
      return `${n} ${name.toLowerCase()}`
    })
    .join(', ')
}

function offset(player: { x: number; z: number }, yaw: number, ahead: number, side: number) {
  const s = Math.sin(yaw)
  const c = Math.cos(yaw)
  return {
    x: player.x - s * ahead - c * side,
    z: player.z - c * ahead + s * side,
  }
}

export function createImprovise(scene: THREE.Scene, deps: ImproviseDeps) {
  const m = mats()
  const builds: Build[] = []

  // Separate anchors so recipes don't fight for one F-prompt when materials overlap
  const leanPos = new THREE.Vector3()
  const firePos = new THREE.Vector3()
  const catchPos = new THREE.Vector3()
  const raftPos = new THREE.Vector3()
  const eatPos = new THREE.Vector3()
  const cookPos = new THREE.Vector3()

  let yaw = 0
  let onLand = false
  let groundY = -1000
  let nearWaterline = false
  let time = 0
  let px = 0
  let pz = 0

  function nearestOfKind(x: number, z: number, kind: BuildKind, maxDist: number): Build | null {
    let best: Build | null = null
    let bestD = maxDist
    for (const b of builds) {
      if (b.kind !== kind) continue
      const d = Math.hypot(b.x - x, b.z - z)
      if (d < bestD) {
        bestD = d
        best = b
      }
    }
    return best
  }

  function clearOfBuilds(x: number, z: number, min = 2.4) {
    for (const b of builds) {
      if (Math.hypot(b.x - x, b.z - z) < min) return false
    }
    return true
  }

  function addBuild(
    kind: BuildKind,
    object: THREE.Group,
    x: number,
    z: number,
    y: number,
    radius: number,
    shelter: number,
    extra?: Partial<Build>,
  ) {
    object.position.set(x, y, z)
    object.rotation.y = yaw
    scene.add(object)
    const build: Build = { kind, object, x, z, deckY: y, radius, shelter, items: [], ...extra }
    builds.push(build)
    return build
  }

  deps.interactions.add({
    position: leanPos,
    verb: 'Lash',
    label: 'Lean-to',
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 0.8 &&
      deps.salvage.has(LEAN_COST) &&
      clearOfBuilds(leanPos.x, leanPos.z, 2.2),
    use: () => {
      if (!deps.salvage.spend(LEAN_COST)) return
      const x = leanPos.x
      const z = leanPos.z
      const y = deps.groundAt(x, z)
      addBuild('lean-to', leanToMesh(m), x, z, y, 2.8, groundY > 2 ? 1.05 : 0.88)
      deps.hud.whisper('Lashed. The wind finds less of you.')
    },
  })

  deps.interactions.add({
    position: firePos,
    verb: 'Kindle',
    label: 'Fire',
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 0.6 &&
      deps.salvage.has(FIRE_COST) &&
      !nearestOfKind(firePos.x, firePos.z, 'fire', 3.5) &&
      clearOfBuilds(firePos.x, firePos.z, 1.4),
    use: () => {
      if (!deps.salvage.spend(FIRE_COST)) return
      const x = firePos.x
      const z = firePos.z
      const y = deps.groundAt(x, z)
      addBuild('fire', fireMesh(m), x, z, y, 2.4, 1.35)
      deps.hud.whisper('Smoke. Heat. Something like a camp.')
    },
  })

  deps.interactions.add({
    position: catchPos,
    verb: 'Rig',
    label: 'Rain-catch',
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 1.2 &&
      deps.salvage.has(CATCH_COST) &&
      clearOfBuilds(catchPos.x, catchPos.z, 2.4),
    use: () => {
      if (!deps.salvage.spend(CATCH_COST)) return
      const x = catchPos.x
      const z = catchPos.z
      const y = deps.groundAt(x, z)
      const build = addBuild('catch', catchMesh(m), x, z, y, 2.2, 0, { water: 0.55 })
      const drinkPos = build.object.position
      const drink = deps.interactions.add({
        position: drinkPos,
        verb: 'Drink',
        label: 'Rain-catch',
        radius: 2.6,
        available: () => deps.vitals.alive && (build.water ?? 0) > 0.08,
        use: () => {
          const left = build.water ?? 0
          if (left <= 0.08) return
          const sip = Math.min(0.35, left)
          build.water = left - sip
          eat(deps.vitals, 0, sip * 0.85)
          const waterMesh = build.object.getObjectByName('water')
          if (waterMesh) waterMesh.visible = (build.water ?? 0) > 0.05
          deps.hud.whisper(
            (build.water ?? 0) > 0.1 ? 'Cool. Flat. Better than the sea.' : 'The last of it.',
          )
        },
      })
      build.items.push(drink)
      deps.hud.whisper('Canvas bowls the rain. Patience does the rest.')
    },
  })

  deps.interactions.add({
    position: raftPos,
    verb: 'Lash',
    label: 'Raft',
    radius: REACH,
    available: () => {
      if (!deps.vitals.alive || !nearWaterline) return false
      if (!clearOfBuilds(raftPos.x, raftPos.z, 3.5)) return false
      return deps.salvage.has(RAFT_COST)
    },
    use: () => {
      const withBarrel = deps.salvage.has(RAFT_BARREL_COST)
      const cost = withBarrel ? RAFT_BARREL_COST : RAFT_COST
      if (!deps.salvage.spend(cost)) return
      const x = raftPos.x
      const z = raftPos.z
      const sea = sampleOcean(x, z, time).y
      const radius = withBarrel ? 2.1 : 1.7
      addBuild('raft', raftMesh(m, withBarrel), x, z, sea + 0.22, radius, 0.55)
      deps.hud.whisper(
        withBarrel
          ? 'Barrels under planks. It bears weight.'
          : 'Three planks and a lashing. It floats — for now.',
      )
    },
  })

  deps.interactions.add({
    position: eatPos,
    verb: 'Eat',
    label: 'Raw fish',
    radius: 1.8,
    available: () =>
      deps.vitals.alive && deps.rawFish() > 0 && !nearestOfKind(px, pz, 'fire', 2.8),
    use: () => {
      if (!deps.eatRawFish()) return
      deps.hud.whisper('Raw fish. It stays down.')
    },
  })

  deps.interactions.add({
    position: cookPos,
    verb: 'Cook',
    label: 'Fish',
    radius: 2.8,
    available: () =>
      deps.vitals.alive && deps.rawFish() > 0 && !!nearestOfKind(px, pz, 'fire', 2.8),
    use: () => {
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire || !deps.cookFish()) return
      deps.vitals.warmth = Math.min(1, deps.vitals.warmth + 0.08)
      deps.hud.whisper('Cooked through. Heat in the hands and the gut.')
    },
  })

  function setAnchor(out: THREE.Vector3, x: number, z: number, y: number) {
    out.set(x, y, z)
  }

  function update(
    dt: number,
    t: number,
    player: { x: number; y: number; z: number },
    view: PlayerFrame,
    facingYaw: number,
  ) {
    time = t
    yaw = facingYaw
    px = player.x
    pz = player.z
    onLand = view.walking && view.groundY > 0.3
    groundY = view.groundY

    const ahead = offset(player, facingYaw, PLACE_AHEAD, 0)
    const fireAt = offset(player, facingYaw, 0.9, 0)
    const catchAt = offset(player, facingYaw, PLACE_AHEAD, 1.1)
    const raftAt = offset(player, facingYaw, 2.2, 0)

    const aheadY = deps.groundAt(ahead.x, ahead.z)
    const fireY = deps.groundAt(fireAt.x, fireAt.z)
    const catchY = deps.groundAt(catchAt.x, catchAt.z)

    if (onLand && aheadY > 0.3) setAnchor(leanPos, ahead.x, ahead.z, aheadY + 0.5)
    else setAnchor(leanPos, player.x, player.z, player.y)

    if (onLand && fireY > 0.3) setAnchor(firePos, fireAt.x, fireAt.z, fireY + 0.3)
    else setAnchor(firePos, player.x, player.z, player.y)

    if (onLand && catchY > 0.3) setAnchor(catchPos, catchAt.x, catchAt.z, catchY + 0.5)
    else setAnchor(catchPos, player.x, player.z, player.y)

    const foot = deps.groundAt(player.x, player.z)
    const seaHere = sampleOcean(player.x, player.z, t).y
    // Wading a beach/spire edge, or swimming at the surface anywhere — a raft
    // is something you lash in the water, not only where the mesh shelves.
    nearWaterline =
      (view.walking && foot > -0.2 && foot < 1.6) ||
      (!view.walking && view.submersion < 0.55 && player.y > seaHere - 0.8)

    const raftSea = sampleOcean(raftAt.x, raftAt.z, t).y
    setAnchor(raftPos, raftAt.x, raftAt.z, Math.max(raftSea, foot) + 0.25)
    void seaHere

    eatPos.set(player.x, player.y - 0.2, player.z)
    const fire = nearestOfKind(player.x, player.z, 'fire', 2.8)
    if (fire) cookPos.set(fire.x, fire.deckY + 0.5, fire.z)
    else cookPos.copy(eatPos)

    for (const b of builds) {
      if (b.kind === 'raft') {
        const sea = sampleOcean(b.x, b.z, t)
        b.deckY = sea.y + 0.22
        b.object.position.y = b.deckY
        b.object.rotation.x = sea.normal.z * 0.35
        b.object.rotation.z = -sea.normal.x * 0.35
      }
      if (b.kind === 'fire') {
        const flame = b.object.getObjectByName('flame')
        if (flame) {
          flame.scale.y = 0.85 + Math.sin(t * 9 + b.x) * 0.18
          flame.rotation.y = t * 1.4
        }
      }
      if (b.kind === 'catch') {
        b.water = Math.min(1, (b.water ?? 0) + dt / CATCH_REFILL)
        const waterMesh = b.object.getObjectByName('water')
        if (waterMesh) {
          waterMesh.visible = (b.water ?? 0) > 0.05
          waterMesh.scale.y = 0.4 + (b.water ?? 0) * 0.8
        }
      }
    }
  }

  function standAt(x: number, z: number) {
    let best = -1000
    for (const b of builds) {
      if (b.kind !== 'raft') continue
      const d = Math.hypot(b.x - x, b.z - z)
      // Soft skirt past the deck so the walker's slope probe doesn't see a
      // cliff into the analytic ocean floor and refuse the edge
      if (d > b.radius * 2.2) continue
      if (d <= b.radius) {
        const lip = 1 - (d / b.radius) ** 2
        best = Math.max(best, b.deckY + lip * 0.04)
      } else {
        const t = Math.min(1, (d - b.radius) / (b.radius * 1.2))
        best = Math.max(best, THREE.MathUtils.lerp(b.deckY, b.deckY - 0.55, t))
      }
    }
    return best
  }

  function shelterAt(x: number, z: number, base: number) {
    let s = base
    for (const b of builds) {
      if (b.shelter <= 0) continue
      const d = Math.hypot(b.x - x, b.z - z)
      if (d > b.radius) continue
      const falloff = 1 - d / b.radius
      s = Math.max(s, THREE.MathUtils.lerp(base, b.shelter, falloff))
    }
    return s
  }

  function reset() {
    for (const b of builds) {
      for (const item of b.items) deps.interactions.remove(item)
      scene.remove(b.object)
      b.object.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose()
      })
    }
    builds.length = 0
  }

  return {
    update,
    standAt,
    shelterAt,
    reset,
    get counts() {
      const out: Record<BuildKind, number> = { 'lean-to': 0, fire: 0, raft: 0, catch: 0 }
      for (const b of builds) out[b.kind]++
      return out
    },
    costs: {
      leanTo: LEAN_COST,
      fire: FIRE_COST,
      catch: CATCH_COST,
      raft: RAFT_COST,
      raftBarrel: RAFT_BARREL_COST,
      label: costLabel,
    },
  }
}

export type Improvise = ReturnType<typeof createImprovise>
