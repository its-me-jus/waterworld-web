import * as THREE from 'three'
import { DAY_LENGTH } from './climate'
import type { Hud } from './hud'
import type { Interactable, Interactions } from './interact'
import type { PlayerFrame } from './player'
import type { Salvage, StashKind } from './salvage'
import { eat, type Vitals } from './survival'
import { sampleOcean } from './waves'
import { barrelObject, crateObject, plankObject } from './wreck'

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
  /** Hang one raw fish over the fire — returns false if none left. */
  takeRawForSmoke: () => boolean
  /** Finish a smoke cycle into the Pack. */
  addSmoked: (n?: number) => void
  /** 0 at night … 1 at noon — rest under a lean-to skips to dawn when dark. */
  daylight: () => number
  /** Jump the climate clock (seconds of day-cycle time). */
  skipTime: (seconds: number) => void
  /** Real seconds until the next dawn. */
  secondsUntilDawn: () => number
  /** True once the mate's spear is yours — unlocks the stern mark. */
  hasMark?: () => boolean
}

type BuildKind = 'lean-to' | 'fire' | 'raft' | 'catch' | 'seat' | 'rack' | 'signal'

type SmokeRack = {
  readyAt: number
  mesh: THREE.Object3D
}

type Hold = Record<StashKind, number>

type Build = {
  kind: BuildKind
  object: THREE.Group
  x: number
  z: number
  deckY: number
  radius: number
  shelter: number
  water?: number
  /** Barrel rafts pole a little harder. */
  buoyant?: boolean
  vx?: number
  vz?: number
  /** Fish hanging over this fire, waiting on the smoke. */
  smoking?: SmokeRack[]
  /** Deck fittings — only meaningful on rafts. */
  mast?: boolean
  rail?: boolean
  locker?: boolean
  /** Materials stowed in the deck locker. */
  hold?: Hold
  /** Stern scratched with the mate's mark. */
  marked?: boolean
  /** Extra hotspots this build registered (drink, etc.) — cleared on reset. */
  items: Interactable[]
}

const LEAN_COST: Cost = { plank: 2, rope: 1 }
const FIRE_COST: Cost = { plank: 1 }
const CATCH_COST: Cost = { canvas: 1, rope: 1 }
const RAFT_COST: Cost = { plank: 3, rope: 1 }
const RAFT_BARREL_COST: Cost = { plank: 3, rope: 1, barrel: 1 }
const MAST_COST: Cost = { plank: 1, canvas: 1, rope: 1 }
const RAIL_COST: Cost = { plank: 1, rope: 1 }
const LOCKER_COST: Cost = { crate: 1 }
const SEAT_COST: Cost = { plank: 1 }
const RACK_COST: Cost = { plank: 1, rope: 1 }
const SIGNAL_COST: Cost = { plank: 1, canvas: 1 }

const REACH = 3.2
const PLACE_AHEAD = 1.7
const CATCH_REFILL = 220
/** Daytime nap — a few hours of day-cycle time, not a full night. */
const NAP_HOURS = 2.8
/** Don't rest again until you've been awake this long (real seconds). */
const REST_COOLDOWN = 18
/** Real seconds for one fish to smoke through. */
const SMOKE_TIME = 28
const SMOKE_MAX = 2
/** Real seconds for one fish to dry on a rack (no fire). */
const DRY_TIME = 48
const DRY_MAX = 3
/** How hard you can pole a raft (m/s). */
const POLE_SPEED = 1.85
const POLE_SPEED_BARREL = 2.35
/** Passive sail drift (m/s) once the mast is rigged. */
const SAIL_SPEED = 0.95
const SAIL_SPEED_BARREL = 1.35
/** Standing eye height — match player.ts so Climb seats you on the deck. */
const WALK_EYE = 1.62
/** How far out you can still Climb aboard from the water. */
const CLIMB_RANGE = 4.8

const emptyHold = (): Hold => ({ plank: 0, barrel: 0, crate: 0, rope: 0, canvas: 0 })

function holdCount(h: Hold) {
  let n = 0
  for (const k of Object.keys(h) as StashKind[]) n += h[k]
  return n
}

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
      emissiveIntensity: 1.8,
    }),
    coal: new THREE.MeshStandardMaterial({
      color: 0x1a1210,
      roughness: 1,
      emissive: 0x8a2808,
      emissiveIntensity: 0.85,
    }),
    flameCore: new THREE.MeshBasicMaterial({
      color: 0xffcc66,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
    flameMid: new THREE.MeshBasicMaterial({
      color: 0xff6a18,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
    flameOuter: new THREE.MeshBasicMaterial({
      color: 0xd02008,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
    glow: new THREE.MeshBasicMaterial({
      color: 0xff6020,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
    sparkBit: new THREE.MeshBasicMaterial({
      color: 0xffd090,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    smokePuff: new THREE.MeshBasicMaterial({
      color: 0x4a4540,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    brand: new THREE.MeshStandardMaterial({
      color: 0x5a4430,
      roughness: 0.95,
    }),
    sail: new THREE.MeshStandardMaterial({
      color: 0xc4b89a,
      roughness: 0.9,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
    }),
    mark: new THREE.MeshStandardMaterial({
      color: 0x3a2e22,
      roughness: 1,
    }),
    water: new THREE.MeshStandardMaterial({
      color: 0x6a9aaa,
      roughness: 0.2,
      metalness: 0.05,
      transparent: true,
      opacity: 0.72,
    }),
    iron: new THREE.MeshStandardMaterial({ color: 0x5a5048, roughness: 0.65, metalness: 0.55 }),
    fish: new THREE.MeshStandardMaterial({
      color: 0x8a7a5c,
      roughness: 0.85,
      emissive: 0x3a2010,
      emissiveIntensity: 0.35,
    }),
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

/** Rising spark bits / smoke puffs — positions rewritten each frame in animateFire. */
function fireBits(
  count: number,
  material: THREE.Material,
  name: string,
  radius: number,
) {
  const g = new THREE.Group()
  g.name = name
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 5, 4), material.clone())
    mesh.userData.seed = Math.random()
    g.add(mesh)
  }
  return g
}

function attachFireLight(g: THREE.Group, torch: boolean) {
  // Candela units (Three r155+). A campfire is bright — hundreds of cd — so
  // the night sand actually takes the orange.
  const key = new THREE.PointLight(0xff8a3a, torch ? 55 : 110, torch ? 9 : 16, 2)
  key.name = 'fireLight'
  key.position.set(0, torch ? 0.55 : 0.5, 0)
  g.add(key)
  const fill = new THREE.PointLight(0xff6a28, torch ? 18 : 36, torch ? 14 : 26, 2)
  fill.name = 'fireFill'
  fill.position.set(0, torch ? 0.3 : 0.2, 0)
  g.add(fill)
}

function flameStack(m: ReturnType<typeof mats>, scale = 1) {
  const g = new THREE.Group()
  g.name = 'flames'
  const outer = new THREE.Mesh(new THREE.ConeGeometry(0.24 * scale, 0.78 * scale, 7), m.flameOuter.clone())
  outer.position.y = 0.4 * scale
  outer.name = 'flameOuter'
  outer.renderOrder = 2
  g.add(outer)
  const mid = new THREE.Mesh(new THREE.ConeGeometry(0.15 * scale, 0.62 * scale, 6), m.flameMid.clone())
  mid.position.y = 0.38 * scale
  mid.name = 'flameMid'
  mid.renderOrder = 3
  g.add(mid)
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.08 * scale, 0.46 * scale, 5), m.flameCore.clone())
  core.position.y = 0.34 * scale
  core.name = 'flameCore'
  core.renderOrder = 4
  g.add(core)
  return g
}

function fireMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  g.name = 'campfire'

  // Criss-crossed kindling — denser than the old five sticks
  for (let i = 0; i < 7; i++) {
    const stick = plankObject(0.72, 0.07, m.wood)
    const a = (i / 7) * Math.PI * 2
    stick.position.set(Math.cos(a) * 0.2, 0.05 + (i % 2) * 0.04, Math.sin(a) * 0.2)
    stick.rotation.set(0.55, a + 0.4, 0.15 + (i % 3) * 0.08)
    g.add(stick)
  }
  // Charred coals under the flame
  const bed = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 7), m.coal)
  bed.scale.set(1.15, 0.38, 1.15)
  bed.position.y = 0.06
  g.add(bed)
  const coal = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), m.ember.clone())
  coal.scale.set(1.1, 0.42, 1.1)
  coal.position.y = 0.1
  coal.name = 'ember'
  g.add(coal)

  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), m.glow.clone())
  glow.position.y = 0.3
  glow.name = 'glow'
  glow.renderOrder = 1
  g.add(glow)

  g.add(flameStack(m, 1))
  g.add(fireBits(14, m.sparkBit, 'sparks', 0.018))
  g.add(fireBits(6, m.smokePuff, 'smoke', 0.07))
  attachFireLight(g, false)
  return g
}

/** Brand you carry — a stick with the same living fire on the tip. */
function torchMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  g.name = 'torch'
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.036, 0.85, 8), m.brand)
  shaft.position.y = 0.2
  g.add(shaft)
  const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.12, 8), m.wood)
  wrap.position.y = 0.58
  g.add(wrap)
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), m.ember.clone())
  tip.scale.set(1, 0.7, 1)
  tip.position.y = 0.66
  tip.name = 'ember'
  g.add(tip)
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), m.glow.clone())
  glow.position.y = 0.72
  glow.name = 'glow'
  glow.renderOrder = 1
  g.add(glow)
  const flames = flameStack(m, 0.55)
  flames.position.y = 0.42
  g.add(flames)
  g.add(fireBits(10, m.sparkBit, 'sparks', 0.014))
  g.add(fireBits(4, m.smokePuff, 'smoke', 0.05))
  attachFireLight(g, true)
  return g
}

function animateFire(root: THREE.Object3D, t: number, phase: number, daylight: number) {
  const flicker =
    0.78 +
    Math.sin(t * 11.2 + phase) * 0.12 +
    Math.sin(t * 17.7 + phase * 1.7) * 0.08 +
    Math.sin(t * 29.3 + phase * 0.4) * 0.05

  const flames = root.getObjectByName('flames')
  if (flames) {
    for (const child of flames.children) {
      const n = child.name
      const lean = Math.sin(t * 4.2 + phase + (n === 'flameOuter' ? 0.6 : n === 'flameMid' ? 0.2 : 0)) * 0.08
      child.rotation.z = lean
      child.rotation.x = Math.sin(t * 5.1 + phase * 1.3) * 0.05
      const yPulse =
        n === 'flameCore' ? 0.9 + flicker * 0.2 : n === 'flameMid' ? 0.85 + flicker * 0.22 : 0.8 + flicker * 0.28
      child.scale.set(0.92 + flicker * 0.12, yPulse, 0.92 + flicker * 0.12)
      child.rotation.y = t * (n === 'flameOuter' ? 0.9 : n === 'flameMid' ? 1.4 : 2.1)
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshBasicMaterial
        const base = n === 'flameCore' ? 0.95 : n === 'flameMid' ? 0.82 : 0.5
        mat.opacity = base * (0.7 + flicker * 0.4)
      }
    }
  }

  const glow = root.getObjectByName('glow')
  if (glow) {
    const s = 0.9 + flicker * 0.4
    glow.scale.setScalar(s)
    const mat = (glow as THREE.Mesh).material as THREE.MeshBasicMaterial
    mat.opacity = 0.28 + flicker * 0.28
  }

  const ember = root.getObjectByName('ember')
  if (ember && ember instanceof THREE.Mesh) {
    const mat = ember.material as THREE.MeshStandardMaterial
    mat.emissiveIntensity = 1.2 + flicker * 1.1
  }

  const sparks = root.getObjectByName('sparks')
  if (sparks) {
    for (const child of sparks.children) {
      if (!(child instanceof THREE.Mesh)) continue
      const s = child.userData.seed as number
      const life = ((t * (0.55 + s * 0.7) + s * 7) % 1.35) / 1.35
      const spin = s * Math.PI * 2 + t * (1.2 + s)
      const r = 0.03 + life * 0.14 + Math.sin(spin) * 0.02
      child.position.set(Math.cos(spin) * r, 0.28 + life * 0.9, Math.sin(spin) * r)
      const fade = life < 0.15 ? life / 0.15 : life > 0.7 ? 1 - (life - 0.7) / 0.3 : 1
      child.scale.setScalar(0.6 + fade * 0.8)
      ;(child.material as THREE.MeshBasicMaterial).opacity = fade * (0.55 + flicker * 0.4)
    }
  }
  const smoke = root.getObjectByName('smoke')
  if (smoke) {
    for (const child of smoke.children) {
      if (!(child instanceof THREE.Mesh)) continue
      const s = child.userData.seed as number
      const life = ((t * (0.16 + s * 0.18) + s * 4) % 2.4) / 2.4
      const spin = s * Math.PI * 2 + t * 0.3
      const r = 0.06 + life * 0.32
      child.position.set(Math.cos(spin) * r, 0.55 + life * 1.5, Math.sin(spin * 0.8) * r)
      child.scale.setScalar(0.7 + life * 1.6)
      const night = Math.max(0, 1 - daylight)
      ;(child.material as THREE.MeshBasicMaterial).opacity =
        (0.08 + night * 0.1) * (1 - life * 0.85)
    }
  }

  // Lights: strong at night, still a readable warm pool by day
  const night = Math.max(0, 1 - daylight)
  const key = root.getObjectByName('fireLight') as THREE.PointLight | undefined
  const fill = root.getObjectByName('fireFill') as THREE.PointLight | undefined
  const torch = root.name === 'torch'
  if (key) {
    const base = torch ? 28 + night * 55 : 40 + night * 95
    key.intensity = base * flicker
    key.color.setRGB(1, 0.48 + flicker * 0.12, 0.18 + flicker * 0.05)
  }
  if (fill) {
    const base = torch ? 10 + night * 18 : 14 + night * 32
    fill.intensity = base * (0.85 + flicker * 0.2)
  }
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

/** Driftwood seat — sit to get your legs back. */
function seatMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const bench = plankObject(1.4, 0.28, m.wood)
  bench.position.y = 0.38
  g.add(bench)
  for (const x of [-0.5, 0.5]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.38, 0.1), m.wood)
    leg.position.set(x, 0.19, 0)
    g.add(leg)
  }
  const back = plankObject(1.3, 0.1, m.wood)
  back.position.set(0, 0.62, -0.18)
  back.rotation.x = -0.15
  g.add(back)
  return g
}

/** Drying rack — hang fish without a fire; patience does the smoke's job slower. */
function rackMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  for (const x of [-0.55, 0.55]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.35, 0.08), m.wood)
    post.position.set(x, 0.65, 0)
    g.add(post)
  }
  const bar = plankObject(1.3, 0.08, m.wood)
  bar.position.set(0, 1.2, 0)
  g.add(bar)
  for (const x of [-0.35, 0, 0.35]) {
    const lash = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.015, 4, 6), m.rope)
    lash.position.set(x, 1.18, 0)
    lash.rotation.x = Math.PI / 2
    g.add(lash)
  }
  return g
}

/** Signal post — a scrap of canvas and a thin column of smoke you can read from the water. */
function signalMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.6, 6), m.brand)
  post.position.y = 1.3
  g.add(post)
  const rag = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.55), m.sail)
  rag.position.set(0.35, 2.35, 0)
  rag.name = 'signalRag'
  g.add(rag)
  const stay = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.1, 4), m.rope)
  stay.position.set(0.2, 1.9, 0)
  stay.rotation.z = 0.7
  g.add(stay)
  // Rising smoke puffs — animated in update
  for (let i = 0; i < 8; i++) {
    const puff = new THREE.Mesh(
      new THREE.SphereGeometry(0.08 + (i % 3) * 0.03, 5, 4),
      m.smokePuff.clone(),
    )
    puff.userData.seed = Math.random()
    puff.name = 'signalSmoke'
    g.add(puff)
  }
  return g
}

function raftMesh(m: ReturnType<typeof mats>, withBarrel: boolean) {
  const g = new THREE.Group()
  g.name = 'raft'

  // Deck — denser planking, a touch longer so it reads as a craft not a pallet
  for (let i = 0; i < 6; i++) {
    const plank = plankObject(3.2, 0.3, m.wood)
    plank.position.set(0, 0.05, (i - 2.5) * 0.3)
    g.add(plank)
  }
  for (const z of [-0.85, 0, 0.85]) {
    const cross = plankObject(1.9, 0.14, m.wood)
    cross.rotation.y = Math.PI / 2
    cross.position.set(0, 0.12, z * 0.05)
    g.add(cross)
  }

  // Low gunwales — the lip that keeps gear (and you) from sliding off
  for (const z of [-0.95, 0.95]) {
    const rail = plankObject(2.9, 0.08, m.wood)
    rail.position.set(0, 0.22, z)
    rail.scale.set(1, 1.6, 1)
    g.add(rail)
  }

  // Bow stem — a raised nose so it reads as going somewhere
  const stem = plankObject(0.7, 0.12, m.wood)
  stem.position.set(-1.55, 0.28, 0)
  stem.rotation.z = 0.45
  g.add(stem)
  const stemPost = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.55, 0.1), m.wood)
  stemPost.position.set(-1.65, 0.4, 0)
  g.add(stemPost)

  // Stern thwart + blank name board (mark carved later)
  const thwart = plankObject(1.6, 0.18, m.wood)
  thwart.rotation.y = Math.PI / 2
  thwart.position.set(1.35, 0.2, 0)
  g.add(thwart)
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.7), m.wood)
  board.position.set(1.55, 0.42, 0)
  board.name = 'sternBoard'
  g.add(board)

  // Push pole — lashed along the starboard rail, ready to hand
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 2.6, 6), m.brand)
  pole.rotation.z = Math.PI / 2
  pole.position.set(0.15, 0.28, 0.72)
  g.add(pole)
  const poleGrip = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.015, 4, 8), m.rope)
  poleGrip.position.set(1.1, 0.28, 0.72)
  poleGrip.rotation.y = Math.PI / 2
  g.add(poleGrip)

  // Lashings at the joints
  for (const [x, z] of [
    [1.2, 0.7],
    [1.2, -0.7],
    [-1.1, 0.7],
    [-1.1, -0.7],
  ] as const) {
    const lash = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.03, 4, 8), m.rope)
    lash.rotation.x = Math.PI / 2
    lash.position.set(x, 0.14, z)
    g.add(lash)
  }

  if (withBarrel) {
    const left = barrelObject(m.wood, m.iron)
    left.position.set(-1.15, -0.12, 0.65)
    left.rotation.z = Math.PI / 2
    g.add(left)
    const right = barrelObject(m.wood, m.iron)
    right.position.set(-1.15, -0.12, -0.65)
    right.rotation.z = Math.PI / 2
    g.add(right)
  }

  // Upgrade slots — empty groups filled when you lash fittings on
  const mastSlot = new THREE.Group()
  mastSlot.name = 'mastSlot'
  mastSlot.visible = false
  g.add(mastSlot)
  const railSlot = new THREE.Group()
  railSlot.name = 'railSlot'
  railSlot.visible = false
  g.add(railSlot)
  const lockerSlot = new THREE.Group()
  lockerSlot.name = 'lockerSlot'
  lockerSlot.visible = false
  g.add(lockerSlot)
  const markSlot = new THREE.Group()
  markSlot.name = 'markSlot'
  markSlot.visible = false
  g.add(markSlot)

  return g
}

function fitMast(raft: THREE.Group, m: ReturnType<typeof mats>) {
  const slot = raft.getObjectByName('mastSlot') as THREE.Group
  if (!slot || slot.children.length) {
    if (slot) slot.visible = true
    return
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 2.8, 8), m.brand)
  mast.position.set(-0.35, 1.45, 0)
  slot.add(mast)
  const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1.8, 6), m.wood)
  yard.rotation.z = Math.PI / 2
  yard.position.set(-0.35, 2.35, 0)
  slot.add(yard)
  // Scrap of canvas on a yard — billows a little in animateSail
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.9, 3, 4), m.sail)
  const pos = sail.geometry.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const z = pos.getZ(i)
    pos.setX(i, 0.08 + (1.1 - y) * 0.12 + z * z * 0.08)
  }
  pos.needsUpdate = true
  sail.geometry.computeVertexNormals()
  sail.position.set(-0.35, 1.45, 0)
  sail.name = 'sail'
  slot.add(sail)
  const stay = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 2.2, 4), m.rope)
  stay.position.set(0.4, 1.2, 0)
  stay.rotation.z = 0.55
  slot.add(stay)
  slot.visible = true
}

function fitRail(raft: THREE.Group, m: ReturnType<typeof mats>) {
  const slot = raft.getObjectByName('railSlot') as THREE.Group
  if (!slot || slot.children.length) {
    if (slot) slot.visible = true
    return
  }
  for (const z of [-1.05, 1.05]) {
    for (const x of [-1.1, 0, 1.1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.55, 0.07), m.wood)
      post.position.set(x, 0.45, z)
      slot.add(post)
    }
    const top = plankObject(2.6, 0.07, m.wood)
    top.position.set(0, 0.72, z)
    slot.add(top)
    // Rope course between posts
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 2.4, 5), m.rope)
    rope.rotation.z = Math.PI / 2
    rope.position.set(0, 0.5, z)
    slot.add(rope)
  }
  slot.visible = true
}

function fitLocker(raft: THREE.Group, m: ReturnType<typeof mats>) {
  const slot = raft.getObjectByName('lockerSlot') as THREE.Group
  if (!slot || slot.children.length) {
    if (slot) slot.visible = true
    return
  }
  const box = crateObject(m.wood)
  box.rotation.set(0, 0.15, 0)
  box.position.set(0.85, 0.42, -0.35)
  box.scale.setScalar(0.85)
  slot.add(box)
  const lash = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.03, 4, 8), m.rope)
  lash.position.set(0.85, 0.55, -0.35)
  lash.rotation.x = Math.PI / 2
  slot.add(lash)
  slot.visible = true
}

function fitMark(raft: THREE.Group, m: ReturnType<typeof mats>) {
  const slot = raft.getObjectByName('markSlot') as THREE.Group
  if (!slot || slot.children.length) {
    if (slot) slot.visible = true
    return
  }
  // Scratched W — the Wanderer's mark, cut with the knife you earned
  for (const [dx, dy, rot] of [
    [-0.08, 0.04, 0.4],
    [0.08, 0.04, -0.4],
    [0, -0.02, 0],
  ] as const) {
    const cut = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2, 0.04), m.mark)
    cut.position.set(1.6, 0.42 + dy, dx)
    cut.rotation.z = rot
    slot.add(cut)
  }
  slot.visible = true
}

function animateSail(raft: THREE.Object3D, t: number) {
  const sail = raft.getObjectByName('sail')
  if (!sail) return
  sail.rotation.y = Math.sin(t * 0.7) * 0.06
  sail.rotation.z = Math.sin(t * 0.45 + 1) * 0.03
}

function smokedFishMesh(m: ReturnType<typeof mats>) {
  const g = new THREE.Group()
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.28, 3, 6), m.fish)
  body.rotation.z = Math.PI / 2
  g.add(body)
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

export function createImprovise(scene: THREE.Scene, camera: THREE.Camera, deps: ImproviseDeps) {
  const m = mats()
  const builds: Build[] = []

  // Separate anchors so recipes don't fight for one F-prompt when materials overlap
  const leanPos = new THREE.Vector3()
  const firePos = new THREE.Vector3()
  const catchPos = new THREE.Vector3()
  const raftPos = new THREE.Vector3()
  const eatPos = new THREE.Vector3()
  const cookPos = new THREE.Vector3()
  const smokePos = new THREE.Vector3()
  const takeSmokePos = new THREE.Vector3()
  const restPos = new THREE.Vector3()
  const takeFirePos = new THREE.Vector3()
  const plantFirePos = new THREE.Vector3()
  const climbPos = new THREE.Vector3()
  const raftFitPos = new THREE.Vector3()
  const stowPos = new THREE.Vector3()
  const markPos = new THREE.Vector3()
  const seatPos = new THREE.Vector3()
  const rackPos = new THREE.Vector3()
  const signalPos = new THREE.Vector3()
  const sitPos = new THREE.Vector3()
  const dryPos = new THREE.Vector3()
  const takeDryPos = new THREE.Vector3()

  let yaw = 0
  let onLand = false
  let groundY = -1000
  let nearWaterline = false
  let time = 0
  let px = 0
  let pz = 0
  let restReadyAt = 0
  let sitReadyAt = 0
  let saidPole = false
  let saidSail = false
  let swimming = false
  let onRaftDeck = false
  /** Seconds of stickiness after Climb — kills leftover swim speed that throws you off. */
  let boardGrace = 0
  /** Live player ref — Climb mutates this to seat you on the deck. */
  let live: {
    x: number
    y: number
    z: number
    mode: 'swim' | 'walk'
    vy: number
    submersion: number
  } | null = null
  /** Living brand in hand — null when every fire is planted. */
  let carried: Build | null = null
  const torch = torchMesh(m)
  torch.visible = false
  camera.add(torch)
  // Lower-right, tip forward — reads as carried, not bolted to the lens
  const torchBase = new THREE.Vector3(0.38, -0.42, -0.55)
  const torchSway = new THREE.Vector3()
  /** Trade-wind axis the sail draws on — steady, not a weather toy. */
  const WIND = { x: Math.sin(0.85), z: Math.cos(0.85) }

  function disposeBuildObject(object: THREE.Object3D) {
    object.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
        obj.geometry.dispose()
      }
    })
  }

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
      !carried &&
      ((onLand && groundY > 0.6) || onRaftDeck) &&
      deps.salvage.has(FIRE_COST) &&
      !nearestOfKind(firePos.x, firePos.z, 'fire', 3.5) &&
      clearOfBuilds(firePos.x, firePos.z, 1.4),
    use: () => {
      if (!deps.salvage.spend(FIRE_COST)) return
      const x = firePos.x
      const z = firePos.z
      const y = onRaftDeck
        ? (nearestOfKind(px, pz, 'raft', 3.2)?.deckY ?? deps.groundAt(x, z)) + 0.08
        : deps.groundAt(x, z)
      addBuild('fire', fireMesh(m), x, z, y, 2.4, 1.35)
      deps.hud.whisper(
        onRaftDeck ? 'Fire on the deck. Mind the planks.' : 'Smoke. Heat. Something like a camp.',
      )
    },
  })

  // Lift the fire as a brand — night walking, or to move camp. Fish still
  // hanging in the smoke keep it planted until you take them (or they finish).
  deps.interactions.add({
    position: takeFirePos,
    verb: 'Take',
    label: 'Fire',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive || carried) return false
      const fire = nearestOfKind(px, pz, 'fire', 2.6)
      if (!fire) return false
      if (fire.smoking?.length) return false
      return true
    },
    use: () => {
      const fire = nearestOfKind(px, pz, 'fire', 2.6)
      if (!fire || fire.smoking?.length) return
      const idx = builds.indexOf(fire)
      if (idx < 0) return
      builds.splice(idx, 1)
      scene.remove(fire.object)
      // Keep the planted mesh for restore; the viewmodel is the torch brand
      fire.object.visible = false
      carried = fire
      torch.visible = true
      deps.hud.whisper('A brand. Heat travels with you.')
    },
  })

  deps.interactions.add({
    position: plantFirePos,
    verb: 'Plant',
    label: 'Fire',
    radius: REACH,
    available: () =>
      !!carried &&
      deps.vitals.alive &&
      ((onLand && groundY > 0.6) || onRaftDeck) &&
      clearOfBuilds(plantFirePos.x, plantFirePos.z, 1.4),
    use: () => {
      if (!carried) return
      const x = plantFirePos.x
      const z = plantFirePos.z
      const y = onRaftDeck
        ? (nearestOfKind(px, pz, 'raft', 3.2)?.deckY ?? deps.groundAt(x, z)) + 0.08
        : deps.groundAt(x, z)
      carried.x = x
      carried.z = z
      carried.deckY = y
      carried.object.position.set(x, y, z)
      carried.object.rotation.y = yaw
      carried.object.visible = true
      scene.add(carried.object)
      builds.push(carried)
      carried = null
      torch.visible = false
      deps.hud.whisper(onRaftDeck ? 'Embers on the deck.' : 'Embers in the sand. Camp again.')
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

  // —— island workshop ————————————————————————————————————————
  deps.interactions.add({
    position: seatPos,
    verb: 'Lash',
    label: 'Seat',
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 0.8 &&
      deps.salvage.has(SEAT_COST) &&
      clearOfBuilds(seatPos.x, seatPos.z, 1.6),
    use: () => {
      if (!deps.salvage.spend(SEAT_COST)) return
      const x = seatPos.x
      const z = seatPos.z
      addBuild('seat', seatMesh(m), x, z, deps.groundAt(x, z), 1.8, 0.15)
      deps.hud.whisper('A seat. The legs stop arguing.')
    },
  })

  deps.interactions.add({
    position: sitPos,
    verb: 'Sit',
    label: 'Seat',
    radius: 2.4,
    available: () =>
      deps.vitals.alive && onLand && time >= sitReadyAt && !!nearestOfKind(px, pz, 'seat', 2.2),
    use: () => {
      const seat = nearestOfKind(px, pz, 'seat', 2.2)
      if (!seat) return
      const v = deps.vitals
      v.stamina = Math.min(1, v.stamina + 0.42)
      v.warmth = Math.min(1, v.warmth + 0.05)
      sitReadyAt = time + 16
      sitPos.set(seat.x, seat.deckY + 0.5, seat.z)
      deps.hud.whisper(
        v.stamina > 0.85 ? 'Rested. The ground holds you a moment.' : 'Breath comes back. Slowly.',
      )
    },
  })

  deps.interactions.add({
    position: rackPos,
    verb: 'Lash',
    label: 'Drying rack',
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 0.8 &&
      deps.salvage.has(RACK_COST) &&
      clearOfBuilds(rackPos.x, rackPos.z, 1.8),
    use: () => {
      if (!deps.salvage.spend(RACK_COST)) return
      const x = rackPos.x
      const z = rackPos.z
      addBuild('rack', rackMesh(m), x, z, deps.groundAt(x, z), 2.0, 0, { smoking: [] })
      deps.hud.whisper('A rack. Hang fish — the air will do what fire does, slower.')
    },
  })

  deps.interactions.add({
    position: dryPos,
    verb: 'Hang',
    label: 'Fish',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive || deps.rawFish() <= 0) return false
      const rack = nearestOfKind(px, pz, 'rack', 2.6)
      if (!rack) return false
      return (rack.smoking?.length ?? 0) < DRY_MAX
    },
    use: () => {
      const rack = nearestOfKind(px, pz, 'rack', 2.6)
      if (!rack || !deps.takeRawForSmoke()) return
      if (!rack.smoking) rack.smoking = []
      const slot = rack.smoking.length
      const mesh = smokedFishMesh(m)
      mesh.position.set((slot - 1) * 0.32, 1.05, 0.05)
      rack.object.add(mesh)
      rack.smoking.push({ readyAt: time + DRY_TIME, mesh })
      deps.hud.whisper(slot === 0 ? 'Hung to dry. The wind works.' : 'Another on the rack.')
    },
  })

  deps.interactions.add({
    position: takeDryPos,
    verb: 'Take',
    label: 'Dried fish',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive) return false
      const rack = nearestOfKind(px, pz, 'rack', 2.6)
      if (!rack?.smoking?.length) return false
      return rack.smoking.some((s) => time >= s.readyAt)
    },
    use: () => {
      const rack = nearestOfKind(px, pz, 'rack', 2.6)
      if (!rack?.smoking) return
      const idx = rack.smoking.findIndex((s) => time >= s.readyAt)
      if (idx < 0) return
      const [done] = rack.smoking.splice(idx, 1)
      rack.object.remove(done.mesh)
      deps.addSmoked(1)
      deps.hud.whisper('Dried through. It will keep.')
    },
  })

  deps.interactions.add({
    position: signalPos,
    verb: 'Rig',
    label: 'Signal',
    radius: REACH,
    available: () =>
      deps.vitals.alive &&
      onLand &&
      groundY > 1.5 &&
      deps.salvage.has(SIGNAL_COST) &&
      !nearestOfKind(signalPos.x, signalPos.z, 'signal', 40) &&
      clearOfBuilds(signalPos.x, signalPos.z, 2.0),
    use: () => {
      if (!deps.salvage.spend(SIGNAL_COST)) return
      const x = signalPos.x
      const z = signalPos.z
      addBuild('signal', signalMesh(m), x, z, deps.groundAt(x, z), 1.6, 0)
      deps.hud.whisper('Smoke on the ridge. You can read it from the water.')
    },
  })

  deps.interactions.add({
    position: raftPos,
    verb: 'Lash',
    label: 'Raft',
    radius: REACH,
    available: () => {
      if (!deps.vitals.alive || !nearWaterline || carried) return false
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
      const radius = withBarrel ? 2.35 : 2.05
      addBuild('raft', raftMesh(m, withBarrel), x, z, sea + 0.22, radius, withBarrel ? 0.62 : 0.55, {
        buoyant: withBarrel,
        vx: 0,
        vz: 0,
        hold: emptyHold(),
      })
      deps.hud.whisper(
        withBarrel
          ? 'Barrels under planks. Climb aboard. Pole from the deck.'
          : 'Three planks and a lashing. Climb aboard — pole from the deck.',
      )
    },
  })

  // Swim up, grab the gunwale, haul yourself onto the deck. The soft skirt
  // helps, but this is the sure verb when the swell keeps knocking you off.
  deps.interactions.add({
    position: climbPos,
    verb: 'Climb',
    label: 'Raft',
    radius: CLIMB_RANGE,
    available: () => {
      if (!deps.vitals.alive || !live || !swimming) return false
      const raft = nearestOfKind(px, pz, 'raft', CLIMB_RANGE)
      return !!raft
    },
    use: () => {
      if (!live) return
      const raft = nearestOfKind(px, pz, 'raft', CLIMB_RANGE)
      if (!raft) return
      live.mode = 'walk'
      live.x = raft.x
      live.z = raft.z
      live.y = raft.deckY + WALK_EYE
      live.vy = 0
      live.submersion = 0
      boardGrace = 1.4
      deps.hud.whisper('Hands on the gunwale. Up.')
    },
  })

  function nearestRaftOnDeck() {
    if (!onRaftDeck) return null
    return nearestOfKind(px, pz, 'raft', 3.2)
  }

  // —— deck fittings —————————————————————————————————————————
  deps.interactions.add({
    position: raftFitPos,
    verb: 'Rig',
    label: 'Sail',
    radius: 2.8,
    available: () => {
      const raft = nearestRaftOnDeck()
      return !!raft && !raft.mast && deps.vitals.alive && deps.salvage.has(MAST_COST)
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft || !deps.salvage.spend(MAST_COST)) return
      raft.mast = true
      raft.shelter = Math.max(raft.shelter, raft.buoyant ? 0.78 : 0.7)
      fitMast(raft.object, m)
      deps.hud.whisper('Canvas on a yard. The wind will do some of the work.')
    },
  })

  deps.interactions.add({
    position: raftFitPos,
    verb: 'Lash',
    label: 'Rail',
    radius: 2.8,
    available: () => {
      const raft = nearestRaftOnDeck()
      return !!raft && !raft.rail && deps.vitals.alive && deps.salvage.has(RAIL_COST)
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft || !deps.salvage.spend(RAIL_COST)) return
      raft.rail = true
      raft.radius += 0.35
      raft.shelter = Math.max(raft.shelter, raft.shelter + 0.12)
      fitRail(raft.object, m)
      deps.hud.whisper('A rail. The deck keeps more of you.')
    },
  })

  deps.interactions.add({
    position: raftFitPos,
    verb: 'Lash',
    label: 'Locker',
    radius: 2.8,
    available: () => {
      const raft = nearestRaftOnDeck()
      return !!raft && !raft.locker && deps.vitals.alive && deps.salvage.has(LOCKER_COST)
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft || !deps.salvage.spend(LOCKER_COST)) return
      raft.locker = true
      if (!raft.hold) raft.hold = emptyHold()
      fitLocker(raft.object, m)
      deps.hud.whisper('A crate, lashed dry. Stow what you cannot swim with.')
    },
  })

  deps.interactions.add({
    position: stowPos,
    verb: 'Stow',
    label: 'Gear',
    radius: 2.6,
    available: () => {
      const raft = nearestRaftOnDeck()
      if (!raft?.locker || !deps.vitals.alive) return false
      const s = deps.salvage.stash
      return s.plank + s.barrel + s.crate + s.rope + s.canvas > 0
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft?.hold) return
      const s = deps.salvage.stash
      let moved = 0
      for (const k of Object.keys(s) as StashKind[]) {
        if (s[k] <= 0) continue
        raft.hold[k] += s[k]
        moved += s[k]
        s[k] = 0
      }
      if (moved <= 0) return
      deps.hud.whisper(
        moved === 1 ? 'One piece in the locker.' : `${moved} pieces stowed. The swim lightens.`,
      )
    },
  })

  deps.interactions.add({
    position: stowPos,
    verb: 'Fetch',
    label: 'Gear',
    radius: 2.6,
    available: () => {
      const raft = nearestRaftOnDeck()
      if (!raft?.locker || !raft.hold || !deps.vitals.alive) return false
      return holdCount(raft.hold) > 0
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft?.hold) return
      const s = deps.salvage.stash
      let moved = 0
      for (const k of Object.keys(raft.hold) as StashKind[]) {
        if (raft.hold[k] <= 0) continue
        s[k] += raft.hold[k]
        moved += raft.hold[k]
        raft.hold[k] = 0
      }
      if (moved <= 0) return
      deps.hud.whisper(moved === 1 ? 'Back in the hands.' : 'The locker empties into your arms.')
    },
  })

  deps.interactions.add({
    position: markPos,
    verb: 'Scratch',
    label: 'Stern',
    radius: 2.6,
    available: () => {
      const raft = nearestRaftOnDeck()
      return !!raft && !raft.marked && deps.vitals.alive && !!deps.hasMark?.()
    },
    use: () => {
      const raft = nearestRaftOnDeck()
      if (!raft) return
      raft.marked = true
      fitMark(raft.object, m)
      deps.hud.whisper("The Wanderer's mark. Your watch. Your deck.")
    },
  })

  // Held fish — eat when nothing more urgent is in reach; cook at a fire.
  // The eat hotspot sits on the body, so without this gate it beats every
  // world prompt (lash, rest, …) on mobile.
  function craftPending() {
    if (carried) {
      return (
        onLand && groundY > 0.6 && clearOfBuilds(plantFirePos.x, plantFirePos.z, 1.4)
      ) || (onRaftDeck && clearOfBuilds(plantFirePos.x, plantFirePos.z, 1.4))
    }
    if (onRaftDeck) {
      const raft = nearestOfKind(px, pz, 'raft', 3.2)
      if (raft && !raft.mast && deps.salvage.has(MAST_COST)) return true
      if (raft && !raft.rail && deps.salvage.has(RAIL_COST)) return true
      if (raft && !raft.locker && deps.salvage.has(LOCKER_COST)) return true
      if (deps.salvage.has(FIRE_COST)) return true
      return false
    }
    if (!onLand) {
      if (swimming && nearestOfKind(px, pz, 'raft', CLIMB_RANGE)) return true
      return nearWaterline && deps.salvage.has(RAFT_COST) && clearOfBuilds(raftPos.x, raftPos.z, 3.5)
    }
    if (groundY > 0.8 && deps.salvage.has(LEAN_COST) && clearOfBuilds(leanPos.x, leanPos.z, 2.2)) {
      return true
    }
    if (groundY > 0.8 && deps.salvage.has(SEAT_COST) && clearOfBuilds(seatPos.x, seatPos.z, 1.6)) {
      return true
    }
    if (groundY > 0.8 && deps.salvage.has(RACK_COST) && clearOfBuilds(rackPos.x, rackPos.z, 1.8)) {
      return true
    }
    if (
      groundY > 1.5 &&
      deps.salvage.has(SIGNAL_COST) &&
      !nearestOfKind(signalPos.x, signalPos.z, 'signal', 40) &&
      clearOfBuilds(signalPos.x, signalPos.z, 2.0)
    ) {
      return true
    }
    if (
      groundY > 0.6 &&
      deps.salvage.has(FIRE_COST) &&
      !nearestOfKind(firePos.x, firePos.z, 'fire', 3.5) &&
      clearOfBuilds(firePos.x, firePos.z, 1.4)
    ) {
      return true
    }
    if (groundY > 1.2 && deps.salvage.has(CATCH_COST) && clearOfBuilds(catchPos.x, catchPos.z, 2.4)) {
      return true
    }
    return nearWaterline && deps.salvage.has(RAFT_COST) && clearOfBuilds(raftPos.x, raftPos.z, 3.5)
  }

  deps.interactions.add({
    position: eatPos,
    verb: 'Eat',
    label: 'Raw fish',
    radius: 1.8,
    available: () =>
      deps.vitals.alive &&
      deps.rawFish() > 0 &&
      // Near a campfire, cook or smoke instead of eating raw
      !nearestOfKind(px, pz, 'fire', 10) &&
      !nearestOfKind(px, pz, 'lean-to', 2.4) &&
      !craftPending(),
    use: () => {
      if (!deps.eatRawFish()) return
      deps.hud.whisper('Raw fish. It stays down.')
    },
  })

  deps.interactions.add({
    position: cookPos,
    verb: 'Cook',
    label: 'Fish',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive || deps.rawFish() <= 0) return false
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire) return false
      // Hungry → cook now. Otherwise leave the prompt to Smoke when there's a rack slot.
      const hanging = fire.smoking?.length ?? 0
      if (deps.vitals.food >= 0.55 && hanging < SMOKE_MAX) return false
      return true
    },
    use: () => {
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire || !deps.cookFish()) return
      deps.vitals.warmth = Math.min(1, deps.vitals.warmth + 0.08)
      deps.hud.whisper('Cooked through. Heat in the hands and the gut.')
    },
  })

  deps.interactions.add({
    position: smokePos,
    verb: 'Smoke',
    label: 'Fish',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive || deps.rawFish() <= 0) return false
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire) return false
      const hanging = fire.smoking?.length ?? 0
      return hanging < SMOKE_MAX
    },
    use: () => {
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire || !deps.takeRawForSmoke()) return
      if (!fire.smoking) fire.smoking = []
      const slot = fire.smoking.length
      const mesh = smokedFishMesh(m)
      mesh.position.set((slot - 0.5) * 0.28, 0.85, 0.15)
      fire.object.add(mesh)
      fire.smoking.push({ readyAt: time + SMOKE_TIME, mesh })
      deps.hud.whisper(
        slot === 0 ? 'Hung in the smoke. Patience.' : 'Another in the smoke.',
      )
    },
  })

  deps.interactions.add({
    position: takeSmokePos,
    verb: 'Take',
    label: 'Smoked fish',
    radius: 2.6,
    available: () => {
      if (!deps.vitals.alive) return false
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire?.smoking?.length) return false
      return fire.smoking.some((s) => time >= s.readyAt)
    },
    use: () => {
      const fire = nearestOfKind(px, pz, 'fire', 2.8)
      if (!fire?.smoking) return
      const idx = fire.smoking.findIndex((s) => time >= s.readyAt)
      if (idx < 0) return
      const [done] = fire.smoking.splice(idx, 1)
      fire.object.remove(done.mesh)
      deps.addSmoked(1)
      deps.hud.whisper('Smoked through. It will keep.')
    },
  })

  deps.interactions.add({
    position: restPos,
    verb: 'Rest',
    label: 'Lean-to',
    radius: 2.6,
    available: () =>
      deps.vitals.alive && onLand && time >= restReadyAt && !!nearestOfKind(px, pz, 'lean-to', 2.4),
    use: () => {
      const shelter = nearestOfKind(px, pz, 'lean-to', 2.4)
      if (!shelter) return
      const v = deps.vitals
      if (v.food < 0.1 || v.water < 0.1) {
        deps.hud.whisper('Too empty to sleep.')
        return
      }

      const night = deps.daylight() < 0.38
      const nearFire =
        !!nearestOfKind(shelter.x, shelter.z, 'fire', 4.5) || !!carried
      let smokedDone = 0
      // Sleep finishes anything hanging in a nearby smoke rack
      if (nearFire) {
        for (const b of builds) {
          if (b.kind !== 'fire' || !b.smoking?.length) continue
          if (Math.hypot(b.x - shelter.x, b.z - shelter.z) > 4.5) continue
          const left = b.smoking
          b.smoking = []
          for (const s of left) {
            b.object.remove(s.mesh)
            deps.addSmoked(1)
            smokedDone++
          }
        }
      }
      let seconds: number
      let hours: number
      if (night) {
        seconds = Math.max(deps.secondsUntilDawn(), (1.5 / 24) * DAY_LENGTH)
        hours = (seconds / DAY_LENGTH) * 24
      } else {
        hours = NAP_HOURS
        seconds = (hours / 24) * DAY_LENGTH
      }

      deps.skipTime(seconds)

      // Shelter + optional fire do the warming; sleep itself mends the body
      const warmthGain = (night ? 0.42 : 0.22) + (nearFire ? 0.18 : 0)
      v.warmth = Math.min(1, v.warmth + warmthGain)
      v.stamina = Math.min(1, v.stamina + 0.75)
      v.food = Math.max(0, v.food - hours * 0.035)
      v.water = Math.max(0, v.water - hours * 0.045)
      if (v.wounded) v.woundClock += hours * 35

      restReadyAt = time + (night ? 40 : REST_COOLDOWN)
      restPos.set(shelter.x, shelter.deckY + 0.6, shelter.z)

      if (smokedDone > 0) {
        deps.hud.whisper(
          smokedDone > 1 ? 'The smoke rack is done. Fish for the road.' : 'Smoked fish waits in the Pack.',
        )
      } else if (night) {
        deps.hud.whisper(
          nearFire
            ? 'Dawn. Embers still warm the lean-to.'
            : 'Dawn finds you under plank and lashing.',
        )
      } else {
        deps.hud.whisper('You rest. The sun has moved.')
      }
    },
  })

  function setAnchor(out: THREE.Vector3, x: number, z: number, y: number) {
    out.set(x, y, z)
  }

  function update(
    dt: number,
    t: number,
    player: {
      x: number
      y: number
      z: number
      dirX: number
      dirZ: number
      mode: 'swim' | 'walk'
      vy: number
      submersion: number
      speed: number
    },
    view: PlayerFrame,
    facingYaw: number,
  ) {
    time = t
    yaw = facingYaw
    px = player.x
    pz = player.z
    live = player
    swimming = !view.walking
    onLand = view.walking && view.groundY > 0.3
    groundY = view.groundY
    onRaftDeck =
      view.walking && !!nearestOfKind(player.x, player.z, 'raft', 3.4) && view.groundY > -0.5

    // After Climb, kill swim inertia and keep them seated for a beat
    if (boardGrace > 0) {
      boardGrace = Math.max(0, boardGrace - dt)
      player.speed = 0
      const raft = nearestOfKind(player.x, player.z, 'raft', CLIMB_RANGE)
      if (raft) {
        player.mode = 'walk'
        player.submersion = 0
        player.vy = 0
        if (Math.hypot(player.x - raft.x, player.z - raft.z) > raft.radius * 0.7) {
          player.x = raft.x
          player.z = raft.z
        }
        player.y = raft.deckY + WALK_EYE
        onRaftDeck = true
        swimming = false
      }
    }
    const ahead = offset(player, facingYaw, PLACE_AHEAD, 0)
    const fireAt = offset(player, facingYaw, 0.9, 0)
    const catchAt = offset(player, facingYaw, PLACE_AHEAD, 1.1)
    const raftAt = offset(player, facingYaw, 2.2, 0)
    const seatAt = offset(player, facingYaw, 1.2, 0.6)
    const rackAt = offset(player, facingYaw, 1.3, -0.7)
    const signalAt = offset(player, facingYaw, PLACE_AHEAD, 0)

    const aheadY = deps.groundAt(ahead.x, ahead.z)
    const fireY = deps.groundAt(fireAt.x, fireAt.z)
    const catchY = deps.groundAt(catchAt.x, catchAt.z)
    const seatY = deps.groundAt(seatAt.x, seatAt.z)
    const rackY = deps.groundAt(rackAt.x, rackAt.z)
    const signalY = deps.groundAt(signalAt.x, signalAt.z)

    if (onLand && aheadY > 0.3) setAnchor(leanPos, ahead.x, ahead.z, aheadY + 0.5)
    else setAnchor(leanPos, player.x, player.z, player.y)

    if ((onLand && fireY > 0.3) || onRaftDeck) {
      const y = onRaftDeck
        ? (nearestOfKind(px, pz, 'raft', 3.2)?.deckY ?? player.y) + 0.35
        : fireY + 0.3
      setAnchor(firePos, fireAt.x, fireAt.z, y)
      setAnchor(plantFirePos, fireAt.x, fireAt.z, y)
    } else {
      setAnchor(firePos, player.x, player.z, player.y)
      setAnchor(plantFirePos, player.x, player.z, player.y)
    }

    if (onLand && catchY > 0.3) setAnchor(catchPos, catchAt.x, catchAt.z, catchY + 0.5)
    else setAnchor(catchPos, player.x, player.z, player.y)

    if (onLand && seatY > 0.5) setAnchor(seatPos, seatAt.x, seatAt.z, seatY + 0.4)
    else setAnchor(seatPos, player.x, player.z, player.y)

    if (onLand && rackY > 0.5) setAnchor(rackPos, rackAt.x, rackAt.z, rackY + 0.45)
    else setAnchor(rackPos, player.x, player.z, player.y)

    if (onLand && signalY > 1.2) setAnchor(signalPos, signalAt.x, signalAt.z, signalY + 0.6)
    else setAnchor(signalPos, player.x, player.z, player.y)

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

    const nearRaft = nearestOfKind(player.x, player.z, 'raft', CLIMB_RANGE)
    if (nearRaft) {
      climbPos.set(nearRaft.x, nearRaft.deckY + 0.4, nearRaft.z)
      raftFitPos.set(nearRaft.x, nearRaft.deckY + 0.55, nearRaft.z)
      stowPos.set(nearRaft.x + 0.7, nearRaft.deckY + 0.5, nearRaft.z - 0.3)
      markPos.set(nearRaft.x + 1.2, nearRaft.deckY + 0.5, nearRaft.z)
    } else {
      climbPos.copy(eatPos)
      raftFitPos.copy(eatPos)
      stowPos.copy(eatPos)
      markPos.copy(eatPos)
    }

    const fire = nearestOfKind(player.x, player.z, 'fire', 2.8)
    if (fire) {
      takeFirePos.set(fire.x, fire.deckY + 0.45, fire.z)
      cookPos.set(fire.x, fire.deckY + 0.5, fire.z)
      // Prefer a clear side offset so Cook and Smoke don't share one spot
      smokePos.set(fire.x + 0.55, fire.deckY + 0.55, fire.z + 0.35)
      takeSmokePos.set(fire.x - 0.4, fire.deckY + 0.55, fire.z - 0.35)
    } else {
      takeFirePos.copy(eatPos)
      cookPos.copy(eatPos)
      smokePos.copy(eatPos)
      takeSmokePos.copy(eatPos)
    }

    const lean = nearestOfKind(player.x, player.z, 'lean-to', 2.4)
    if (lean) restPos.set(lean.x, lean.deckY + 0.6, lean.z)
    else restPos.copy(eatPos)

    const seat = nearestOfKind(player.x, player.z, 'seat', 2.2)
    if (seat) sitPos.set(seat.x, seat.deckY + 0.5, seat.z)
    else sitPos.copy(eatPos)

    const rack = nearestOfKind(player.x, player.z, 'rack', 2.6)
    if (rack) {
      dryPos.set(rack.x + 0.4, rack.deckY + 0.7, rack.z)
      takeDryPos.set(rack.x - 0.35, rack.deckY + 0.7, rack.z)
    } else {
      dryPos.copy(eatPos)
      takeDryPos.copy(eatPos)
    }

    // Dive with a brand and the sea takes it — diegetic, no inventory slot
    if (carried && view.submersion > 0.72) {
      disposeBuildObject(carried.object)
      carried = null
      torch.visible = false
      deps.hud.whisper('The brand hisses out in the water.')
    }

    // Torch viewmodel — soft sway with the walk / swim effort
    if (carried && torch.visible) {
      const sway = Math.sin(t * 5.5) * 0.012 * (0.4 + view.speed * 0.15)
      const bob = Math.sin(t * 7.2) * 0.01
      torchSway.set(sway, bob, 0)
      torch.position.copy(torchBase).add(torchSway)
      torch.rotation.set(0.35 + bob * 2, -0.25, 0.15 + sway * 3)
      animateFire(torch, t, 2.1, deps.daylight())
    } else if (!carried) {
      // Keep dormant brand lights from leaking into the night
      const key = torch.getObjectByName('fireLight') as THREE.PointLight | undefined
      const fill = torch.getObjectByName('fireFill') as THREE.PointLight | undefined
      if (key) key.intensity = 0
      if (fill) fill.intensity = 0
    }

    for (const b of builds) {
      if (b.kind === 'raft') {
        const prevX = b.x
        const prevZ = b.z
        const onDeck =
          view.walking && Math.hypot(player.x - b.x, player.z - b.z) <= b.radius * 0.95
        const top = b.buoyant ? POLE_SPEED_BARREL : POLE_SPEED
        let vx = b.vx ?? 0
        let vz = b.vz ?? 0
        if (onDeck && view.speed > 0.2) {
          const aimX = player.dirX
          const aimZ = player.dirZ
          const blend = 1 - Math.exp(-2.4 * dt)
          vx += (aimX * top - vx) * blend
          vz += (aimZ * top - vz) * blend
          if (!saidPole && Math.hypot(vx, vz) > 0.4) {
            saidPole = true
            deps.hud.whisper('The deck answers the pole.')
          }
        } else if (b.mast && onDeck) {
          // Sail draws while you're aboard — falls idle if you go overboard
          const sail = b.buoyant ? SAIL_SPEED_BARREL : SAIL_SPEED
          const draw = 1 - Math.exp(-0.55 * dt)
          vx += (WIND.x * sail - vx) * draw * 0.65
          vz += (WIND.z * sail - vz) * draw * 0.65
          if (!saidSail && Math.hypot(vx, vz) > 0.35) {
            saidSail = true
            deps.hud.whisper('Canvas fills. The raft finds a heading.')
          }
        } else {
          const drag = Math.exp(-1.15 * dt)
          vx *= drag
          vz *= drag
        }
        // Soft water drag always — even under sail / pole
        const waterDrag = Math.exp(-0.15 * dt)
        vx *= waterDrag
        vz *= waterDrag
        b.vx = vx
        b.vz = vz
        b.x += vx * dt
        b.z += vz * dt

        const sea = sampleOcean(b.x, b.z, t)
        b.deckY = sea.y + 0.22
        b.object.position.set(b.x, b.deckY, b.z)
        b.object.rotation.x = sea.normal.z * 0.35
        b.object.rotation.z = -sea.normal.x * 0.35
        // Yaw into the push so the raft reads as steered
        if (Math.hypot(vx, vz) > 0.12) {
          const want = Math.atan2(-vx, -vz)
          let dyaw = want - b.object.rotation.y
          while (dyaw > Math.PI) dyaw -= Math.PI * 2
          while (dyaw < -Math.PI) dyaw += Math.PI * 2
          b.object.rotation.y += dyaw * (1 - Math.exp(-1.2 * dt))
        }
        if (b.mast) animateSail(b.object, t)

        if (onDeck) {
          player.x += b.x - prevX
          player.z += b.z - prevZ
          px = player.x
          pz = player.z
        }

        // Deck fire rides with the raft
        for (const other of builds) {
          if (other.kind !== 'fire') continue
          if (Math.hypot(other.x - prevX, other.z - prevZ) > b.radius * 0.95) continue
          other.x += b.x - prevX
          other.z += b.z - prevZ
          other.deckY = b.deckY + 0.08
          other.object.position.set(other.x, other.deckY, other.z)
        }
      }
      if (b.kind === 'fire') {
        animateFire(b.object, t, b.x * 0.7 + b.z * 0.3, deps.daylight())
      }
      if (b.kind === 'signal') {
        const rag = b.object.getObjectByName('signalRag')
        if (rag) {
          rag.rotation.y = Math.sin(t * 1.1 + b.x) * 0.35
          rag.rotation.z = Math.sin(t * 0.7) * 0.08
        }
        for (const child of b.object.children) {
          if (child.name !== 'signalSmoke' || !(child instanceof THREE.Mesh)) continue
          const s = child.userData.seed as number
          const life = ((t * (0.22 + s * 0.15) + s * 5) % 3.2) / 3.2
          const spin = s * Math.PI * 2 + t * 0.25
          child.position.set(Math.cos(spin) * life * 0.25, 2.4 + life * 4.5, Math.sin(spin) * life * 0.25)
          child.scale.setScalar(0.6 + life * 2.2)
          ;(child.material as THREE.MeshBasicMaterial).opacity = 0.22 * (1 - life)
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
      // cliff into the analytic ocean floor — and so a swimmer can find the
      // lip before they have to Climb.
      const skirt = b.radius * (b.rail ? 2.8 : 2.55)
      if (d > skirt) continue
      if (d <= b.radius) {
        const lip = 1 - (d / b.radius) ** 2
        best = Math.max(best, b.deckY + lip * 0.04)
      } else {
        const t = Math.min(1, (d - b.radius) / (skirt - b.radius))
        best = Math.max(best, THREE.MathUtils.lerp(b.deckY, b.deckY - 0.45, t))
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
    // A brand in hand is a personal hearth — warmth travels with you
    if (carried) s = Math.max(s, 1.2)
    return s
  }

  function reset() {
    for (const b of builds) {
      for (const item of b.items) deps.interactions.remove(item)
      scene.remove(b.object)
      disposeBuildObject(b.object)
    }
    builds.length = 0
    if (carried) {
      disposeBuildObject(carried.object)
      carried = null
    }
    torch.visible = false
    restReadyAt = 0
    sitReadyAt = 0
    saidPole = false
    saidSail = false
    boardGrace = 0
  }

  return {
    update,
    standAt,
    shelterAt,
    reset,
    /** True while the player is holding a living brand. */
    get carryingFire() {
      return !!carried
    },
    get counts() {
      const out: Record<BuildKind, number> = {
        'lean-to': 0,
        fire: 0,
        raft: 0,
        catch: 0,
        seat: 0,
        rack: 0,
        signal: 0,
      }
      for (const b of builds) out[b.kind]++
      if (carried) out.fire++
      return out
    },
    costs: {
      leanTo: LEAN_COST,
      fire: FIRE_COST,
      catch: CATCH_COST,
      raft: RAFT_COST,
      raftBarrel: RAFT_BARREL_COST,
      mast: MAST_COST,
      rail: RAIL_COST,
      locker: LOCKER_COST,
      seat: SEAT_COST,
      rack: RACK_COST,
      signal: SIGNAL_COST,
      label: costLabel,
    },
  }
}

export type Improvise = ReturnType<typeof createImprovise>
