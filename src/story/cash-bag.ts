import * as THREE from 'three'
import { DETAIL_LAYER } from '../quality'
import { skyFill } from '../skyfill'
import { buildSpear } from '../spear'
import { getTribePlaces, type TribePlaces } from '../tribe/places'
import type {
  BagState,
  Interactable,
  InteractableKind,
  IslandLike,
  TidalCavesLike,
  TribeWeather,
} from '../tribe/types'
import { oceanState, sampleOcean } from '../waves'
import { createCamp } from './camp'
import {
  TAU,
  UP,
  emissiveByAlbedo,
  fill,
  hash,
  hex,
  lump,
  merge,
  paintFaces,
  paintVerts,
  place,
  smooth,
  stripBasic,
  triangles,
} from './prop-geo'

/**
 * The heist's leftovers and the islanders' home, as things you can find, carry
 * and pick up.
 *
 * You came down clutching a soggy black duffel of $2,400,000, and on an island
 * it buys nothing. This builds what the story needs on the ground:
 *
 *  - the duffel itself, which drags at you while you carry it, wallows
 *    half-sunk when you let it go in deep water, and can be hidden on a ledge
 *    in the tidal caves' sealed air chamber;
 *  - a pool of wet $100 bills that burst out of it, flutter down and lie on the
 *    sand or float on the sea until they fade, or curl up and burn to embers
 *    over the camp fire;
 *  - the islanders' warning post on the beach, a line of dark stones across the
 *    path in front of it, bare footprints leading home from it, and the camp
 *    by the rain pool (built in camp.ts) with the fire's one warm light;
 *  - salvage worth more than the money: a brass compass on the reef by the
 *    coaster, a flare and a spear on the Wanderer's spire, and a radio battery
 *    off the coaster's bow.
 *
 * Every spot is searched for on the real terrain at load (src/tribe/places.ts
 * and searches of its own), so a reshaped island moves the props with it, and
 * every shape is deterministic, so they are the same every load. Props are a
 * handful of merged, vertex-coloured meshes (the islandlife.ts pattern); the
 * bills are one instanced mesh.
 */

// —— options and results ——————————————————————————————————————————

export type HeistPropsOptions = {
  island: IslandLike
  /** reefWreck.position: mid-hull, a metre up. */
  reefWreckPos: THREE.Vector3
  /** wreck.group.position: the Wanderer. */
  wreckPos: THREE.Vector3
  /** wreck.perch: the dry shelf on the Wanderer's spire. Without it the flare and spear float by the wreck. */
  wreckPerch?: THREE.Vector3
  /**
   * reefWreck.standAt: deck height, or deep negative off the hull. Today it
   * always says -1000 (her deck is not climbable), so the battery goes on the
   * crest by her bow; if she ever gets a deck you can stand on, it moves there.
   */
  reefWreckStandAt?: (x: number, z: number) => number
  tidalCaves: TidalCavesLike
  lowPower: boolean
  /**
   * wreck.standAt, so the flare and spear sit on the spire's real rock (about
   * 6.8 m) rather than on an estimate of it. Optional, but worth passing.
   */
  wreckStandAt?: (x: number, z: number) => number
  /**
   * reefWreck.yaw, so the salvage can keep clear of her hull and find her bow.
   * Without it the yaw is worked out from the rule reefwreck.ts lays her down by.
   */
  reefWreckYaw?: number
}

/** How carrying the bag changes the swimmer and the walker. */
export type MovementModifiers = {
  /** Multiplies the swim speed (surface and submerged alike). */
  swimSpeedMult: number
  /**
   * Metres per second of extra downward pull while swimming. Positive means
   * down: subtract it from the swim controller's vertical-velocity target, so
   * at the surface you ride a little lower and when you hang still underwater
   * you sink slowly instead of hovering.
   */
  sinkBias: number
  /** Multiplies the walking speed. */
  walkSpeedMult: number
}

export type SalvageId = 'salvage_compass' | 'salvage_flare' | 'spear' | 'radio_battery'

export interface CashBag {
  readonly state: BagState
  /**
   * The duffel's mesh. While it is a child of the props' group this module
   * moves, shows and hides it; reparent it (to the camera, say) to carry it in
   * view, and it is left alone until the next drop() or stashInCaves() takes
   * it back.
   */
  readonly object: THREE.Group
  /** World position of the bag's middle. Follows the eye while it is carried. Read it, don't write it. */
  readonly position: THREE.Vector3
  /** Let it go here: it falls to the ground or seabed, or floats half-sunk in water deeper than about 0.6 m. */
  drop(at: THREE.Vector3): void
  /** Back in your hands. The world mesh hides. */
  pickUp(): void
  /** On the ledge in the air chamber. */
  stashInCaves(): void
  /** True inside the tidal caves' air chamber. */
  canStashAt(pos: THREE.Vector3): boolean
}

/** Where each prop ended up, for the dev handle and for checking. */
export type HeistSpots = {
  totem: THREE.Vector3
  campFire: THREE.Vector3
  compass: THREE.Vector3
  flare: THREE.Vector3
  spear: THREE.Vector3
  battery: THREE.Vector3
  caveStash: THREE.Vector3
  /** True when no dry ledge was found and the shelf was built for the bag. */
  caveShelfBuilt: boolean
  /** True when the battery sits on the coaster's deck rather than the crest by her bow. */
  batteryOnDeck: boolean
  footprints: number
}

export interface HeistProps {
  /** Root of everything here, already in the scene. */
  group: THREE.Group
  places: TribePlaces
  bag: CashBag
  /** The same object every call; read it, don't keep it. */
  getMovementModifiers(): MovementModifiers
  /** Wet bills out of the bag at `origin`. Returns how many were thrown. */
  burstCashBills(origin: THREE.Vector3, count: number): number
  /** Bills that catch, curl and rise as embers, for the camp fire. Returns how many. */
  burnCashBills(origin: THREE.Vector3, count: number): number
  /**
   * The nearest thing to act on, or null. The record is reused between calls;
   * copy what you need from it if you keep it.
   */
  getNearbyInteractable(pos: THREE.Vector3, maxDistance?: number): Interactable | null
  /** Take a piece of salvage (or the dropped bag) out of the world. Returns its kind, or null if it can't be taken. */
  pickUp(id: string): InteractableKind | null
  /** Whether a piece of salvage is still lying where it was found. */
  isInWorld(id: string): boolean
  /** Washed ashore: salvage back where it was, the bag back in your hands, no bills about. */
  resetProps(): void
  update(dt: number, t: number, weather: TribeWeather, eye?: THREE.Vector3): void
  spots: HeistSpots
}

// —— constants ——————————————————————————————————————————————————

const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))

/** The trade wind's heading, mirrored from island.ts (WIND_HEADING) so this file can't disturb it. */
const WIND_HEADING = 0.62
const WIND_X = Math.cos(WIND_HEADING)
const WIND_Z = Math.sin(WIND_HEADING)

/** Beyond this from every prop, a frame does no work here. */
const FAR = 250
/** A piece of salvage starts to glow inside this many metres of the eye. */
const GLOW_REACH = 6
/** How close the fire counts as "at the fire", where cash gets burnt. */
const FIRE_REACH = 3.5

/** A $100 bill is 156 x 66 mm; drawn half as large again so one reads at arm's length. */
const BILL_SCALE = 1.6
const BILL_W = 0.156 * BILL_SCALE
const BILL_H = 0.066 * BILL_SCALE

/** The duffel: a rounded holdall 0.62 m long. */
const BAG_R = 0.17
const BAG_HALF = 0.31
/** Squircle power of the profile: flat end panels with rounded edges, like a sewn holdall. */
const BAG_SQUARE = 5
/** Where the squashed bottom sits below the axis, as a fraction of the radius. */
const BAG_FLOOR = 0.62
/** The axis height once the squashed bottom rests on y = 0. */
const BAG_LIFT = BAG_FLOOR * BAG_R + (1 - BAG_FLOOR) * BAG_R * 0.25
/** Height of the bag's middle above its base. */
const BAG_MID = 0.14

/** Two dozen kilos of wet paper: slower in the water, pulled down a little, and a heavier step ashore. */
const CARRIED: MovementModifiers = { swimSpeedMult: 0.82, sinkBias: 0.18, walkSpeedMult: 0.93 }
const UNBURDENED: MovementModifiers = { swimSpeedMult: 1, sinkBias: 0, walkSpeedMult: 1 }

// Soaked canvas, not gloss black: the first bag was so dark and so smooth it read as a gas bottle
const NYLON = hex('#2c2f36')
const NYLON_WET = hex('#17191d')
const NYLON_PANEL = hex('#3b3f47')
const PIPING = hex('#4b5059')
const ZIP = hex('#5c6169')
const STEEL = hex('#8b8f94')
const MOUTH = hex('#050506')
const STRAP = hex('#40454d')
const WEBBING = hex('#585d66')
const GRIP = hex('#8b6a47')
const TAG = hex('#d9cfb4')
const BILL_FACE = hex('#a7b59b')
const BILL_EDGE = hex('#d6dacb')
const BAND = hex('#d3bd72')

// A hardwood post, weathered but kept: warm where it is sound, silvered only at
// the crown. Greys, however sun-bleached, read as a concrete post on the sand.
const DRIFT = hex('#9c7a56')
const DRIFT_DARK = hex('#765a3e')
const DRIFT_PALE = hex('#c2ad8c')
const DRIFT_WET = hex('#655443')
const GROOVE = hex('#42342a')
const ADZED = hex('#c9aa7e')
const LIME = hex('#e9e2cf')
const SENNIT = hex('#b39c68')
const SENNIT_DARK = hex('#8c7648')
const BARK_CLOTH = hex('#d8c7a0')
const BARK_CLOTH_DYE = hex('#6a4226')
const OCHRE = hex('#9b3a1f')
const OCHRE_LIGHT = hex('#b4502b')
const SHELL = hex('#f1ece2')
const SHELL_PINK = hex('#e8c8b8')
const BASALT = hex('#38342f')
const BASALT_LIGHT = hex('#4a453f')

const TEAK = hex('#6b4628')
const BRASS = hex('#b08a3c')
const BRASS_BRIGHT = hex('#caa24c')
const CARD = hex('#e6dcc2')
const CARD_RED = hex('#a8321f')
const NEEDLE = hex('#2a2a2a')
const FLARE_ORANGE = hex('#e8611c')
const FLARE_BAND = hex('#efe9dc')
const FLARE_CAP = hex('#2c2d2f')
const FLARE_STRIKER = hex('#b52a1c')
const BATTERY_YELLOW = hex('#e0b11f')
const BATTERY_BLACK = hex('#1c1c1c')
const TERMINAL_RED = hex('#b3261e')
const SALT = hex('#c8cbbd')

const SHELF_TOP = hex('#57514a')
const SHELF_SALT = hex('#8c8478')
const SHELF_SIDE = hex('#3a3632')

/** The proximity glow on salvage: a warm shimmer, not a beacon. */
const GLOW = hex('#ffe6b5')

// —— geometry helpers (the rest are in prop-geo.ts) ——————————————————————

const _v = new THREE.Vector3()
const _qa = new THREE.Quaternion()

/** Layers are not inherited, so every part of a small thing on the ground is marked. */
function smallThing(obj: THREE.Object3D) {
  obj.traverse((part) => {
    // A light must stay on the default layer: lights are culled by layer too,
    // and the sky probe counting one light fewer than the eye would compile
    // every lit shader twice
    if (!(part as THREE.Light).isLight) part.layers.set(DETAIL_LAYER)
  })
}

// —— the duffel ———————————————————————————————————————————————————

/** Radius of the round, unloaded bag at distance x along it. */
function bagRadius(x: number) {
  const a = Math.min(1, Math.abs(x) / BAG_HALF)
  return BAG_R * Math.pow(Math.max(0, 1 - a ** BAG_SQUARE), 1 / BAG_SQUARE)
}

/** Moves a point of the round, empty bag to where the soaked, loaded one has it. */
function slump(p: THREE.Vector3) {
  const floor = -BAG_FLOOR * BAG_R
  let y = p.y
  // The weight of wet paper flattens the bottom against the ground...
  if (y < floor) y = floor + (y - floor) * 0.25
  // ...pushes the lower sides out a little...
  const spread = 1 + 0.07 * smooth(-p.y, 0, BAG_R)
  // ...and the top sags between the end panels, where the zip has been forced
  const along = p.x / BAG_HALF
  y -= 0.042 * Math.max(0, 1 - along * along) * smooth(y, 0, BAG_R)
  return p.set(p.x, y + BAG_LIFT, p.z * spread)
}

function slumpGeometry(g: THREE.BufferGeometry) {
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) {
    slump(_v.fromBufferAttribute(pos, i))
    pos.setXYZ(i, _v.x, _v.y, _v.z)
  }
}

/** Height of the bag's top seam x along it. */
function bagTop(x: number) {
  return slump(_v.set(x, bagRadius(x), 0)).y
}

/** One banded stack of hundreds: $10,000 in a paper strap. */
function cashStack() {
  const g = stripBasic(new THREE.BoxGeometry(0.156, 0.024, 0.066, 3, 1, 1))
  return paintFaces(g, (p, n, c) => {
    if (Math.abs(p.x) < 0.027) c.copy(BAND)
    else if (Math.abs(n.y) > 0.5) c.copy(BILL_FACE)
    else c.copy(BILL_EDGE)
  })
}

/**
 * The holdall, in its own frame: length along x, resting on y = 0, the
 * shoulder strap lying on the +z side. One merged, vertex-coloured mesh.
 */
function buildBag(rich: boolean) {
  const parts: THREE.BufferGeometry[] = []

  // Body: a lathe of the squircle profile, turned so its axis runs along x
  const profile: THREE.Vector2[] = []
  const rows = rich ? 14 : 10
  for (let i = 0; i <= rows; i++) {
    const phi = -Math.PI / 2 + (Math.PI * i) / rows
    const s = Math.sin(phi)
    const x = BAG_HALF * Math.sign(s) * Math.abs(s) ** (2 / BAG_SQUARE)
    profile.push(new THREE.Vector2(Math.max(0.003, bagRadius(x)), x))
  }
  const lathe = new THREE.LatheGeometry(profile, rich ? 16 : 14)
  lathe.rotateZ(-Math.PI / 2)
  slumpGeometry(lathe)
  // Cloth over a load of paper is never a clean cylinder: it puckers between
  // the straps and creases along its length. Without this it shone like a tank.
  const pucker = (x: number, y: number, z: number) => {
    const round = Math.atan2(z, y - BAG_LIFT)
    return Math.sin(x * 44 + round * 2) * 0.6 + Math.sin(round * 5 - x * 19) * 0.4
  }
  {
    const lp = lathe.attributes.position
    for (let i = 0; i < lp.count; i++) {
      const x = lp.getX(i)
      const y = lp.getY(i)
      const z = lp.getZ(i)
      if (Math.abs(x) > BAG_HALF - 0.07 || y < 0.045) continue
      const k = 1 + 0.065 * pucker(x, y, z) * smooth(y, 0.045, 0.1)
      lp.setXYZ(i, x, BAG_LIFT + (y - BAG_LIFT) * k, z * k)
    }
  }
  lathe.computeVertexNormals()
  const body = stripBasic(lathe)
  parts.push(
    paintVerts(body, (p, _n, c) => {
      // Darkest where it has sat in the wet; the end panels are a stiffer, matte fabric
      c.copy(NYLON).lerp(NYLON_WET, 1 - smooth(p.y, 0.015, 0.11))
      if (Math.abs(p.x) > BAG_HALF - 0.05) c.lerp(NYLON_PANEL, 0.55)
      // and the folds hold the wet longer than the ridges between them
      else c.multiplyScalar(0.9 + 0.14 * pucker(p.x, p.y, p.z))
    }),
  )

  // Two bands of webbing round its girth, the carry handles sewn to them
  for (const end of [-1, 1]) {
    const x = end * 0.09
    const band = new THREE.CylinderGeometry(bagRadius(x) + 0.014, bagRadius(x) + 0.014, 0.038, rich ? 16 : 12, 1, true)
    band.rotateZ(-Math.PI / 2)
    band.translate(x, 0, 0)
    slumpGeometry(band)
    band.computeVertexNormals()
    parts.push(fill(stripBasic(band), WEBBING))
  }

  // Piping round the end panels, so it reads as a sewn holdall and not a pillow
  for (const end of [-1, 1]) {
    const x = end * (BAG_HALF - 0.045)
    const ring = new THREE.TorusGeometry(bagRadius(x) + 0.002, 0.007, 3, 12)
    ring.rotateY(Math.PI / 2)
    ring.translate(x, 0, 0)
    slumpGeometry(ring)
    ring.computeVertexNormals()
    parts.push(fill(stripBasic(ring), PIPING))
  }

  // The zip: closed at both ends, forced open across the middle
  const zipRun = (x0: number, x1: number, z: number, w: number) => {
    const y0 = bagTop(x0)
    const y1 = bagTop(x1)
    const g = stripBasic(new THREE.BoxGeometry(x1 - x0, 0.011, w))
    _qa.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(y1 - y0, x1 - x0))
    parts.push(fill(place(g, (x0 + x1) / 2, (y0 + y1) / 2 - 0.002, z, _qa), ZIP))
  }
  zipRun(-0.26, -0.075, 0, 0.022)
  zipRun(0.205, 0.26, 0, 0.022)
  // The parted tracks either side of the gap
  zipRun(-0.075, 0.205, 0.05, 0.012)
  zipRun(-0.075, 0.205, -0.05, 0.012)
  const pull = stripBasic(new THREE.BoxGeometry(0.03, 0.006, 0.015))
  parts.push(fill(place(pull, -0.09, bagTop(-0.09) + 0.006, 0.012), STEEL))

  // The dark of the open mouth
  const mouth = stripBasic(new THREE.SphereGeometry(1, 8, 4))
  parts.push(fill(place(mouth, 0.065, bagTop(0.065) - 0.008, 0, undefined, 0.14, 0.03, 0.048), MOUTH))

  // Banded stacks shoved up through the gap, and two loose bills
  const stacks = [
    { x: -0.01, z: 0.004, ry: 0.15, rz: 0.55, lift: 0.022 },
    { x: 0.06, z: -0.012, ry: -0.2, rz: -0.38, lift: 0.03 },
    { x: 0.128, z: 0.008, ry: 0.35, rz: 0.24, lift: 0.018 },
    { x: 0.045, z: 0.018, ry: 1.35, rz: 0.1, lift: 0.01 },
  ]
  const e = new THREE.Euler()
  for (const s of stacks) {
    _qa.setFromEuler(e.set(0, s.ry, s.rz))
    parts.push(place(cashStack(), s.x, bagTop(s.x) + s.lift - 0.02, s.z, _qa))
  }
  for (const [x, rx, rz, z] of [
    [0.15, 0, 0.95, -0.01],
    [-0.035, -0.85, 0.2, 0.055],
  ]) {
    const bill = stripBasic(new THREE.BoxGeometry(0.156, 0.0016, 0.066))
    _qa.setFromEuler(e.set(rx, 0.3, rz))
    parts.push(fill(place(bill, x, bagTop(x) + 0.012, z, _qa), BILL_FACE))
  }

  // Carry handles, flopped over to either side, each with a wrapped grip
  for (const side of [-1, 1]) {
    const arch = stripBasic(new THREE.TorusGeometry(0.085, 0.011, 4, 8, Math.PI))
    const grip = stripBasic(new THREE.CylinderGeometry(0.017, 0.017, 0.075, 6, 1))
    grip.rotateZ(Math.PI / 2)
    grip.translate(0, 0.085, 0)
    const handle = merge([fill(arch, WEBBING), fill(grip, GRIP)])
    handle.rotateX(side * 0.45)
    handle.translate(0, bagTop(0.085) - 0.02, side * 0.075)
    parts.push(handle)
  }

  // Shoulder strap: clipped to both end panels, lying in a loose loop on the ground beside it
  const strapCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-BAG_HALF - 0.01, BAG_LIFT + 0.05, 0.04),
    new THREE.Vector3(-BAG_HALF - 0.08, 0.09, 0.15),
    new THREE.Vector3(-0.17, 0.011, 0.29),
    new THREE.Vector3(0.08, 0.01, 0.33),
    new THREE.Vector3(BAG_HALF + 0.05, 0.03, 0.21),
    new THREE.Vector3(BAG_HALF + 0.01, BAG_LIFT + 0.05, 0.04),
  ])
  parts.push(fill(stripBasic(new THREE.TubeGeometry(strapCurve, 16, 0.009, 4, false)), STRAP))
  for (const end of [-1, 1]) {
    const ring = stripBasic(new THREE.TorusGeometry(0.018, 0.0045, 3, 6))
    ring.rotateY(Math.PI / 2)
    parts.push(fill(place(ring, end * (BAG_HALF + 0.012), BAG_LIFT + 0.05, 0.04), STEEL))
  }

  // A zipped side pocket on the far side from the strap
  const pocket = stripBasic(new THREE.BoxGeometry(0.22, 0.11, 0.018, 1, 3, 1))
  paintFaces(pocket, (p, _n, c) => {
    c.copy(p.y > 0.028 ? ZIP : NYLON_PANEL)
  })
  parts.push(place(pocket, 0, BAG_LIFT + 0.005, -BAG_R - 0.006))

  // A card tag on a loop at one handle, the writing long since run
  const tag = stripBasic(new THREE.BoxGeometry(0.05, 0.003, 0.03))
  _qa.setFromEuler(e.set(0.5, 0.4, -0.5))
  parts.push(fill(place(tag, -0.125, bagTop(-0.125) + 0.012, 0.115, _qa), TAG))

  return merge(parts)
}

// —— textures drawn at runtime ——————————————————————————————————————

/**
 * A wet hundred: grey-green paper, a ruled frame, an oval with a palm in it
 * and the denomination. A note from nowhere in particular, not a copy of a
 * real one.
 */
function billTexture() {
  const canvas = document.createElement('canvas')
  const W = 256
  const H = 108
  canvas.width = W
  canvas.height = H
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  const g = canvas.getContext('2d')
  if (!g) return tex
  g.fillStyle = '#c6cfbb'
  g.fillRect(0, 0, W, H)
  // Darker where the water has soaked in from the edges
  const soak = g.createRadialGradient(W / 2, H / 2, 24, W / 2, H / 2, 150)
  soak.addColorStop(0, 'rgba(255,255,255,0)')
  soak.addColorStop(1, 'rgba(66,88,68,0.38)')
  g.fillStyle = soak
  g.fillRect(0, 0, W, H)
  // Frame: two rules with a band of fine hatching between them
  g.strokeStyle = '#4f6a55'
  g.lineWidth = 2
  g.strokeRect(5, 5, W - 10, H - 10)
  g.lineWidth = 1
  g.strokeRect(11, 11, W - 22, H - 22)
  g.strokeStyle = 'rgba(79,106,85,0.55)'
  for (let x = 6; x < W - 8; x += 4) {
    g.beginPath()
    g.moveTo(x, 6)
    g.lineTo(x + 4, 11)
    g.moveTo(x, H - 11)
    g.lineTo(x + 4, H - 6)
    g.stroke()
  }
  // The oval and its palm
  g.fillStyle = '#b3c1a9'
  g.beginPath()
  g.ellipse(84, 54, 30, 36, 0, 0, TAU)
  g.fill()
  g.strokeStyle = '#3d5845'
  g.lineWidth = 2
  g.stroke()
  g.strokeStyle = '#2f4a37'
  g.lineWidth = 3
  g.beginPath()
  g.moveTo(80, 84)
  g.quadraticCurveTo(77, 60, 88, 37)
  g.stroke()
  g.lineWidth = 2
  for (const [dx, dy] of [
    [-17, 7],
    [-13, -6],
    [0, -13],
    [13, -6],
    [17, 7],
  ]) {
    g.beginPath()
    g.moveTo(88, 37)
    g.quadraticCurveTo(88 + dx * 0.5, 37 + dy - 7, 88 + dx, 37 + dy)
    g.stroke()
  }
  // The denomination: big on the right, small in the corners
  g.fillStyle = '#2c4634'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = 'bold 46px Georgia, "Times New Roman", serif'
  g.fillText('100', 182, 60)
  g.font = 'bold 15px Georgia, "Times New Roman", serif'
  g.fillText('100', 31, 24)
  g.fillText('100', W - 31, 24)
  g.fillText('100', 31, H - 22)
  g.fillText('100', W - 31, H - 22)
  g.font = '9px Georgia, "Times New Roman", serif'
  g.fillText('ONE HUNDRED', 182, 27)
  // Tide marks where it dried and got wet again
  for (const [x, y, r] of [
    [150, 80, 26],
    [42, 62, 18],
    [222, 40, 20],
  ]) {
    const stain = g.createRadialGradient(x, y, 2, x, y, r)
    stain.addColorStop(0, 'rgba(58,76,56,0.16)')
    stain.addColorStop(0.8, 'rgba(58,76,56,0.1)')
    stain.addColorStop(1, 'rgba(58,76,56,0)')
    g.fillStyle = stain
    g.fillRect(x - r, y - r, r * 2, r * 2)
  }
  tex.needsUpdate = true
  return tex
}

/** A bare left foot, toes up, white on clear: the material's colour does the darkening. */
function footTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 128
  const tex = new THREE.CanvasTexture(canvas)
  const g = canvas.getContext('2d')
  if (!g) return tex
  g.fillStyle = '#ffffff'
  g.beginPath()
  g.ellipse(30, 103, 12, 16, 0, 0, TAU)
  g.fill()
  g.beginPath()
  g.ellipse(35, 50, 16, 14, -0.1, 0, TAU)
  g.fill()
  // The outer edge carries the weight from heel to ball; the arch stays off the sand
  g.beginPath()
  g.moveTo(19, 52)
  g.quadraticCurveTo(14, 80, 20, 100)
  g.lineTo(31, 100)
  g.quadraticCurveTo(27, 78, 33, 54)
  g.closePath()
  g.fill()
  for (const [x, y, r] of [
    [45, 23, 7],
    [34, 18, 5],
    [26, 20, 4.4],
    [19, 25, 4],
    [13, 32, 3.4],
  ]) {
    g.beginPath()
    g.arc(x, y, r, 0, TAU)
    g.fill()
  }
  tex.needsUpdate = true
  return tex
}

// —— the salvage, each in its own frame, resting on y = 0 ————————————————

/** A brass boat compass in an open teak box. */
function buildCompass() {
  const parts: THREE.BufferGeometry[] = []
  parts.push(fill(place(stripBasic(new THREE.BoxGeometry(0.17, 0.07, 0.17)), 0, 0.035, 0), TEAK))
  // The lid, hinged at the back and thrown open past upright
  const lid = stripBasic(new THREE.BoxGeometry(0.17, 0.012, 0.17))
  lid.translate(0, 0.006, 0.085)
  lid.rotateX(-1.85)
  lid.translate(0, 0.07, -0.085)
  parts.push(fill(lid, TEAK))
  parts.push(fill(place(stripBasic(new THREE.CylinderGeometry(0.062, 0.055, 0.035, 12, 1)), 0, 0.078, 0), BRASS))
  const card = stripBasic(new THREE.CircleGeometry(0.055, 12))
  card.rotateX(-Math.PI / 2)
  card.translate(0, 0.0965, 0)
  paintFaces(card, (p, _n, c) => {
    // North is the wedge toward -z; every other point a shade darker
    const a = Math.atan2(p.x, -p.z)
    const wedge = Math.round(((a + TAU) % TAU) / (TAU / 12)) % 12
    if (wedge === 0) c.copy(CARD_RED)
    else c.copy(CARD).multiplyScalar(wedge % 2 ? 0.86 : 1)
  })
  parts.push(card)
  const needle = stripBasic(new THREE.BoxGeometry(0.006, 0.004, 0.092))
  _qa.setFromAxisAngle(UP, 0.4)
  parts.push(fill(place(needle, 0, 0.1, 0, _qa), NEEDLE))
  const gimbal = stripBasic(new THREE.TorusGeometry(0.064, 0.005, 4, 12))
  gimbal.rotateX(Math.PI / 2)
  parts.push(fill(place(gimbal, 0, 0.098, 0), BRASS_BRIGHT))
  return merge(parts)
}

/** An orange waterproof hand flare, lying along x. */
function buildFlare() {
  const parts: THREE.BufferGeometry[] = []
  const tube = stripBasic(new THREE.CylinderGeometry(0.022, 0.022, 0.3, 8, 3))
  tube.rotateZ(Math.PI / 2)
  paintFaces(tube, (p, _n, c) => {
    // A white label band, and the black ring that says which end to hold
    if (p.x > -0.05 && p.x < 0.05) c.copy(FLARE_BAND)
    else if (p.x > 0.05 && p.x < 0.11) c.copy(FLARE_CAP)
    else c.copy(FLARE_ORANGE)
  })
  parts.push(place(tube, 0, 0.022, 0))
  const cap = stripBasic(new THREE.CylinderGeometry(0.026, 0.026, 0.05, 8, 1))
  cap.rotateZ(Math.PI / 2)
  parts.push(fill(place(cap, 0.17, 0.026, 0), FLARE_CAP))
  const striker = stripBasic(new THREE.CylinderGeometry(0.02, 0.024, 0.02, 8, 1))
  striker.rotateZ(Math.PI / 2)
  parts.push(fill(place(striker, -0.16, 0.022, 0), FLARE_STRIKER))
  const ring = stripBasic(new THREE.TorusGeometry(0.014, 0.003, 3, 8))
  ring.rotateY(Math.PI / 2)
  parts.push(fill(place(ring, 0.205, 0.026, 0), STEEL))
  return merge(parts)
}

/** A VHF battery pack off the coaster's bridge: yellow and black, two terminals, a strap. */
function buildBattery() {
  const parts: THREE.BufferGeometry[] = []
  const block = stripBasic(new THREE.BoxGeometry(0.2, 0.13, 0.11, 2, 2, 1))
  paintFaces(block, (p, n, c) => {
    c.copy(p.y > 0 || n.y > 0.5 ? BATTERY_YELLOW : BATTERY_BLACK)
    // A crust of dried salt along the bottom edge on one side
    if (p.y < -0.03 && n.z > 0.5 && p.x > 0) c.lerp(SALT, 0.55)
  })
  parts.push(place(block, 0, 0.065, 0))
  for (const [x, color] of [
    [0.05, TERMINAL_RED],
    [-0.05, BATTERY_BLACK],
  ] as const) {
    parts.push(fill(place(stripBasic(new THREE.CylinderGeometry(0.011, 0.011, 0.02, 6, 1)), x, 0.14, 0.022), color))
  }
  parts.push(fill(place(stripBasic(new THREE.TorusGeometry(0.05, 0.007, 4, 8, Math.PI)), 0, 0.13, -0.02), BATTERY_BLACK))
  return merge(parts)
}

/**
 * The mate's spear from spear.ts, baked to one vertex-coloured mesh lying
 * along x (eight meshes and three materials would be eight draw calls).
 * Returns the geometry and how far it runs either side of its origin.
 */
function buildSpearProp() {
  const source = buildSpear()
  source.updateMatrixWorld(true)
  const parts: THREE.BufferGeometry[] = []
  source.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    const g = stripBasic(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld))
    mesh.geometry.dispose()
    const mat = mesh.material as THREE.MeshStandardMaterial
    parts.push(fill(g, mat.color))
    mat.dispose()
  })
  const geo = merge(parts)
  // Forward is +y in spear.ts; lying down, the head points along +x
  geo.rotateZ(-Math.PI / 2)
  geo.computeBoundingBox()
  const box = geo.boundingBox ?? new THREE.Box3()
  // Its thickest part (the butt cap) touches the ground
  geo.translate(0, -box.min.y, 0)
  return { geo, back: -box.min.x, ahead: box.max.x }
}

// —— the module ——————————————————————————————————————————————————

const DEAD = 0
const AIR = 1
const GROUND = 2
const FLOAT = 3
const SINK = 4
const BURN = 5

type Salvage = {
  id: SalvageId
  label: string
  mesh: THREE.Mesh
  material: THREE.MeshStandardMaterial
  home: THREE.Vector3
  homeQuat: THREE.Quaternion
  /** Bobbing on the sea rather than lying on something. */
  floats: boolean
  inWorld: boolean
  phase: number
  info: Interactable
}

export function createHeistProps(scene: THREE.Scene, opts: HeistPropsOptions): HeistProps {
  const { island, tidalCaves } = opts
  const places = getTribePlaces(island, opts.reefWreckPos, tidalCaves.entrance)
  const group = new THREE.Group()
  group.name = 'Heist props'
  scene.add(group)

  const H = (x: number, z: number) => island.heightAt(x, z)
  /** Ground under a point, wherever there is any: the island, the spire, the caves' rock. */
  const groundAt = (x: number, z: number, fromY = 40) => {
    let g = H(x, z)
    if (opts.wreckStandAt) g = Math.max(g, opts.wreckStandAt(x, z))
    const cave = tidalCaves.floorAt(x, z, fromY)
    return cave > g ? cave : g
  }
  const normalAt = (x: number, z: number, out: THREE.Vector3) => {
    const e = 0.35
    return out.set(H(x - e, z) - H(x + e, z), 2 * e, H(x, z - e) - H(x, z + e)).normalize()
  }
  const slopeAt = (x: number, z: number) =>
    Math.hypot(H(x + 1, z) - H(x - 1, z), H(x, z + 1) - H(x, z - 1)) / 2
  const probe = new THREE.Vector3()
  const inChamber = (x: number, y: number, z: number) => tidalCaves.chamberPresence(probe.set(x, y, z)) > 0.5
  let tideNow = oceanState.tide
  let now = 0
  /** The water's surface: the swell outside, a still pool at the tide's height in the sealed chamber. */
  const waterAt = (x: number, z: number, t: number) =>
    inChamber(x, tideNow + 0.3, z) ? tideNow : sampleOcean(x, z, t).y

  const tris: Record<string, number> = {}
  const n = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const yawQ = (yaw: number) => _qa.setFromAxisAngle(UP, yaw)
  /** Lying on the ground at a point: tilted to the slope, turned to `yaw`. */
  const groundQuat = (x: number, z: number, yaw: number, out: THREE.Quaternion) =>
    out.setFromUnitVectors(UP, normalAt(x, z, n)).multiply(yawQ(yaw))

  // —— materials ——
  // Wood, stone and shell carry the sky's light in shade, so they follow it down after dark
  const propMat = skyFill(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, emissive: '#8c9db3', emissiveIntensity: 0.32 }),
  )
  propMat.onBeforeCompile = emissiveByAlbedo
  // Damp canvas: a dull sheen, not a polish
  const bagMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.02 })

  // —— the reef wreck's lie ——
  const site = opts.reefWreckPos
  const heading = (() => {
    if (opts.reefWreckYaw !== undefined) {
      return new THREE.Vector2(Math.sin(opts.reefWreckYaw), Math.cos(opts.reefWreckYaw))
    }
    // Her own rule (reefwreck.ts): bow swung 0.45 rad seaward of the reef line
    const rx = site.x - island.centre.x
    const rz = site.z - island.centre.z
    const len = Math.hypot(rx, rz) || 1
    const radial = new THREE.Vector2(rx / len, rz / len)
    return new THREE.Vector2(-radial.y, radial.x)
      .multiplyScalar(Math.cos(0.45))
      .addScaledVector(radial, Math.sin(0.45))
      .normalize()
  })()
  const beam = new THREE.Vector2(-heading.y, heading.x)
  const lagoonSide =
    Math.sign(beam.x * (island.centre.x - site.x) + beam.y * (island.centre.z - site.z)) || 1
  /**
   * Off her hull. She is about 35 m long and 8 across, and lies heeled toward
   * the lagoon with her foremast and rigging trailing into it, so the lagoon
   * side keeps a wider berth.
   */
  const clearOfHull = (x: number, z: number, margin: number) => {
    const dx = x - site.x
    const dz = z - site.z
    const along = dx * heading.x + dz * heading.y
    const across = dx * beam.x + dz * beam.y
    const halfBeam = across * lagoonSide > 0 ? 7.5 : 5
    return Math.abs(along) > 18.5 + margin || Math.abs(across) > halfBeam + margin
  }
  const tala = places.lagoonRocks
  const fromTala = (x: number, z: number) => Math.hypot(x - tala.x, z - tala.z)

  // —— where the salvage lies ——
  // Compass: on the reef crest beside her, knee-deep at low water, clear of
  // Tala's rock and the hull. The seaward side is preferred: that is where a
  // thing washed out of a wheelhouse would fetch up.
  const compassAt = new THREE.Vector3()
  {
    let best = Infinity
    for (let along = -16; along <= 16; along += 1) {
      for (let across = -14; across <= 14; across += 1) {
        const x = site.x + heading.x * along + beam.x * across
        const z = site.z + heading.y * along + beam.y * across
        if (!clearOfHull(x, z, 0.5)) continue
        const h = H(x, z)
        if (h < -1.6 || h > 0.5 || fromTala(x, z) < 7 || slopeAt(x, z) > 0.5) continue
        const score =
          Math.abs(h + 0.7) + Math.abs(along) * 0.03 + Math.abs(across) * 0.02 + (across * lagoonSide > 0 ? 0.4 : 0)
        if (score < best) {
          best = score
          compassAt.set(x, h, z)
        }
      }
    }
    if (best === Infinity) compassAt.set(tala.x + beam.x * 6, H(tala.x + beam.x * 6, tala.z + beam.y * 6), tala.z + beam.y * 6)
  }

  // Battery: on her deck if there were one to stand on; there isn't today, so
  // on the crest just off her bow, clear of the compass and of Tala's rock
  const batteryAt = new THREE.Vector3()
  let batteryOnDeck = false
  if (opts.reefWreckStandAt) {
    let best = Infinity
    for (let r = 0; r <= 8; r += 1) {
      for (let a = 0; a < TAU; a += Math.PI / 8) {
        const x = site.x + Math.cos(a) * r
        const z = site.z + Math.sin(a) * r
        const h = opts.reefWreckStandAt(x, z)
        if (!Number.isFinite(h) || h < 0.4 || h > 9) continue
        if (r < best) {
          best = r
          batteryAt.set(x, h, z)
          batteryOnDeck = true
        }
      }
    }
  }
  if (!batteryOnDeck) {
    const bowX = site.x + heading.x * 17.5
    const bowZ = site.z + heading.y * 17.5
    let best = Infinity
    const search = (strict: boolean) => {
      for (let along = 12; along <= 28; along += 0.75) {
        for (let across = -9; across <= 9; across += 0.75) {
          const x = site.x + heading.x * along + beam.x * across
          const z = site.z + heading.y * along + beam.y * across
          if (!clearOfHull(x, z, 0.5)) continue
          const h = H(x, z)
          if (h < -1.6 || h > 0.5) continue
          if (strict && (fromTala(x, z) < 6 || compassAt.distanceTo(_v.set(x, h, z)) < 5 || slopeAt(x, z) > 0.5)) continue
          const score = Math.abs(h + 0.45) + Math.hypot(x - bowX, z - bowZ) * 0.05
          if (score < best) {
            best = score
            batteryAt.set(x, h, z)
          }
        }
      }
    }
    search(true)
    if (best === Infinity) search(false)
    if (best === Infinity) batteryAt.set(bowX, H(bowX, bowZ), bowZ)
  }

  // Flare and spear: on the Wanderer's spire shelf, or bobbing by her if there is no shelf
  const perch = opts.wreckPerch
  const perchY = (x: number, z: number) => {
    if (!perch) return 0
    const h = opts.wreckStandAt ? opts.wreckStandAt(x, z) : perch.y + 0.3
    // Off the shelf's edge the spire says -1000: pull back to the shelf's own height
    return h > perch.y - 1.5 ? h : perch.y + 0.3
  }
  const flareAt = new THREE.Vector3()
  const spearAt = new THREE.Vector3()
  const spearYaw = 2.4
  let spearPitch = 0
  const spearProp = buildSpearProp()
  if (perch) {
    flareAt.set(perch.x + 0.55, 0, perch.z - 0.35)
    flareAt.y = perchY(flareAt.x, flareAt.z)
    // The spear is 2.3 m long, so it rests on the high points under it rather than on its middle
    const cx = perch.x - 0.35
    const cz = perch.z + 0.45
    const ax = Math.cos(spearYaw)
    const az = -Math.sin(spearYaw)
    const hBack = perchY(cx - ax * spearProp.back, cz - az * spearProp.back)
    const hAhead = perchY(cx + ax * spearProp.ahead, cz + az * spearProp.ahead)
    const span = spearProp.back + spearProp.ahead
    let lift = 0
    for (let k = 0; k <= 6; k++) {
      const s = -spearProp.back + (span * k) / 6
      const line = hBack + ((hAhead - hBack) * (s + spearProp.back)) / span
      lift = Math.max(lift, perchY(cx + ax * s, cz + az * s) - line)
    }
    spearPitch = Math.atan2(hAhead - hBack, span)
    const lineAtOrigin = hBack + ((hAhead - hBack) * spearProp.back) / span
    spearAt.set(cx, lineAtOrigin + lift, cz)
  } else {
    flareAt.set(opts.wreckPos.x + 10, 0, opts.wreckPos.z + 9)
    spearAt.set(opts.wreckPos.x + 12.5, 0, opts.wreckPos.z + 6.5)
  }

  // —— the stash in the caves ——
  // A dry ledge just above the tide line inside the air chamber, flat enough
  // for the bag on every side. The chamber today has none (only slivers of
  // steep wall that happen to sit at the right height), so a basalt shelf is
  // built against the nearest sheer stretch of wall instead.
  const stashAt = new THREE.Vector3()
  let stashYaw = 0
  let shelf: { x: number; z: number; yaw: number } | null = null
  {
    const cx = tidalCaves.chamberWater.x
    const cz = tidalCaves.chamberWater.y
    let best = Infinity
    for (let dx = -7; dx <= 7; dx += 0.25) {
      for (let dz = -7; dz <= 7; dz += 0.25) {
        const x = cx + dx
        const z = cz + dz
        if (!inChamber(x, 0.6, z)) continue
        const f = tidalCaves.floorAt(x, z, 1.2)
        if (!(f > -0.5 && f < 0.9) || !inChamber(x, f + 0.4, z)) continue
        let flat = true
        for (let k = 0; k < 8 && flat; k++) {
          const a = (k / 8) * TAU
          const g = tidalCaves.floorAt(x + Math.cos(a) * 0.32, z + Math.sin(a) * 0.32, f + 0.6)
          if (!(Math.abs(g - f) < 0.12)) flat = false
        }
        if (!flat) continue
        // High and dry first, then near the middle of the room
        const score = 0.9 - f + Math.hypot(dx, dz) * 0.02
        if (score < best) {
          best = score
          stashAt.set(x, f, z)
          stashYaw = Math.atan2(cx - x, cz - z)
        }
      }
    }
    if (best === Infinity) {
      // The wall's distance along a bearing at one height: the first point the rock closes over
      const wallAt = (ca: number, sa: number, y: number) => {
        for (let r = 1.5; r < 9; r += 0.1) {
          if (!Number.isFinite(tidalCaves.floorAt(cx + ca * r, cz + sa * r, y))) return r
        }
        return Infinity
      }
      let pick = { r: Infinity, a: 0, sheer: false }
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * TAU
        const ca = Math.cos(a)
        const sa = Math.sin(a)
        const low = wallAt(ca, sa, 0.65)
        const high = wallAt(ca, sa, 1.15)
        const r = Math.min(low, high)
        if (r === Infinity || !inChamber(cx + ca * (r - 0.4), 1.0, cz + sa * (r - 0.4))) continue
        // A sheer wall, not the tip of a hanging fold, gives the shelf something to grow from
        const sheer = Math.abs(low - high) < 0.6
        if ((sheer && !pick.sheer) || (sheer === pick.sheer && r < pick.r)) pick = { r, a, sheer }
      }
      if (pick.r === Infinity) pick = { r: 4.5, a: Math.PI, sheer: false }
      const ca = Math.cos(pick.a)
      const sa = Math.sin(pick.a)
      // Facing back into the room: the bag's strap side toward the water, its length along the wall
      const yaw = Math.atan2(-ca, -sa)
      shelf = { x: cx + ca * (pick.r - 0.3), z: cz + sa * (pick.r - 0.3), yaw }
      stashAt.set(cx + ca * (pick.r - 0.45), 0.85, cz + sa * (pick.r - 0.45))
      stashYaw = yaw
    }
  }

  // —— warning post ——
  const totemAt = places.totem
  const outward = places.outward
  {
    const parts: THREE.BufferGeometry[] = []
    const crookX = (y: number) => 0.05 * (Math.sin(y * 1.4 + 0.3) - Math.sin(0.3))
    const crookZ = (y: number) => 0.035 * Math.sin(y * 1.9) - 0.018 * y
    const PANEL = 0.104
    // Profile, foot buried in the sand to the rounded, sun-split top: three carved grooves and a flat for the hand
    const profile = [
      [0.004, -0.32], [0.15, -0.3], [0.156, 0], [0.151, 0.35], [0.148, 0.52], [0.126, 0.545], [0.126, 0.595],
      [0.148, 0.62], [0.142, 0.95], [0.14, 1.025], [0.119, 1.05], [0.14, 1.075], [0.136, 1.16], [0.136, 1.2],
      [0.136, 1.62], [0.135, 1.66], [0.13, 1.745], [0.109, 1.77], [0.109, 1.82], [0.13, 1.845], [0.12, 2.05],
      [0.104, 2.14], [0.074, 2.2], [0.03, 2.23], [0.004, 2.236],
    ].map(([r, y]) => new THREE.Vector2(r, y))
    const sides = opts.lowPower ? 10 : 14
    const post = stripBasic(new THREE.LatheGeometry(profile, sides))
    const pos = post.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      let z = pos.getZ(i)
      // An adzed flat on the seaward face, where the hand is laid on
      if (y > 1.18 && y < 1.64 && z > 0.06) z = Math.min(z, PANEL)
      pos.setXYZ(i, x + crookX(y), y, z + crookZ(y))
    }
    post.computeVertexNormals()
    paintFaces(post, (p, _n, c) => {
      const y = p.y
      const lx = p.x - crookX(y)
      const lz = p.z - crookZ(y)
      const phi = Math.atan2(lx, lz)
      const grain = 0.5 + 0.5 * Math.sin(phi * 5 + y * 2.3 + Math.sin(y * 7.1) * 0.8)
      c.copy(DRIFT).lerp(DRIFT_DARK, grain * 0.5)
      if (y > 2.05) c.lerp(DRIFT_PALE, smooth(y, 2.05, 2.2) * 0.7)
      if (y < 0.3) c.lerp(DRIFT_WET, 1 - smooth(y, -0.05, 0.3))
      const groove = (y > 0.53 && y < 0.61) || (y > 1.03 && y < 1.07) || (y > 1.755 && y < 1.835)
      // Two painted bands, each a ring of teeth: ochre pointing up out of the
      // lime, renewed often enough that they are the brightest thing on the beach.
      // (Each facet of the ring is two triangles, one hanging from the top edge
      // and one standing on the bottom: colouring them apart is the pattern.)
      const tooth = (y0: number, y1: number) => (y > y0 && y < y1 ? (y - y0) / (y1 - y0) : -1)
      const band = tooth(0.62, 0.95)
      // (under the crown the same teeth are ochre on bare wood: in white they made a mouth of it)
      const crown = tooth(1.845, 2.05)
      if (groove) c.copy(GROOVE)
      else if (band >= 0) c.copy(band < 0.5 ? OCHRE : LIME).multiplyScalar(0.86 + grain * 0.14)
      else if (crown >= 0) c.copy(crown < 0.5 ? OCHRE_LIGHT : ADZED).multiplyScalar(0.86 + grain * 0.14)
      // Sennit bound round under the head, turn on turn
      else if (y > 1.66 && y < 1.745) c.copy(Math.floor(((phi + Math.PI) / TAU) * sides * 2) % 2 ? SENNIT : SENNIT_DARK)
      else if (y > 1.19 && y < 1.63 && lz > PANEL - 0.006) c.copy(ADZED)
    })
    // The hand: ochre pressed on flat, fingers a little spread, as a person
    // leaves it rather than as a sign-painter would
    const hand: THREE.BufferGeometry[] = []
    const palm = new THREE.Shape()
    palm.absellipse(0, 0, 0.041, 0.049, 0, TAU, false, 0)
    hand.push(stripBasic(new THREE.ShapeGeometry(palm, 8)))
    for (const [x, y, len, w, lean] of [
      [-0.026, 0.03, 0.07, 0.016, 0.14],
      [-0.008, 0.036, 0.081, 0.017, 0.04],
      [0.011, 0.034, 0.075, 0.016, -0.07],
      [0.028, 0.026, 0.058, 0.014, -0.2],
      [0.036, -0.012, 0.06, 0.018, -1.05],
    ]) {
      const finger = new THREE.Shape()
      finger.moveTo(-w / 2, 0)
      finger.lineTo(w / 2, 0)
      finger.lineTo(w / 2, len - w / 2)
      finger.absarc(0, len - w / 2, w / 2, 0, Math.PI, false)
      finger.lineTo(-w / 2, 0)
      const g = stripBasic(new THREE.ShapeGeometry(finger, 3))
      g.rotateZ(lean)
      g.translate(x, y, 0)
      hand.push(g)
    }
    const print = merge(hand)
    print.rotateZ(0.12)
    print.scale(1.3, 1.3, 1)
    print.translate(0.004, 1.4, PANEL + 0.005)
    const hp = print.attributes.position
    for (let i = 0; i < hp.count; i++) {
      const y = hp.getY(i)
      hp.setXYZ(i, hp.getX(i) + crookX(y), y, hp.getZ(i) + crookZ(y))
    }
    paintVerts(print, (p, _n, c) => {
      // Pressed on unevenly: thicker in the middle of the palm
      c.copy(OCHRE).lerp(OCHRE_LIGHT, 0.5 + 0.5 * Math.sin(p.x * 140 + p.y * 90))
    })
    // A crosspiece lashed on under the head, hung with what says whose beach this is
    const dress: THREE.BufferGeometry[] = []
    {
      const barY = 1.705
      const bar = stripBasic(new THREE.CylinderGeometry(0.017, 0.021, 0.86, 5, 1))
      bar.rotateZ(Math.PI / 2 + 0.03)
      paintFaces(bar, (_p, nn, c) => {
        c.copy(Math.abs(nn.x) > 0.9 ? ADZED : DRIFT_DARK)
      })
      dress.push(place(bar, crookX(barY), barY, crookZ(barY) + 0.012))
      for (const side of [-1, 1]) {
        const x = crookX(barY) + side * 0.39
        const z = crookZ(barY) + 0.012
        const y = barY + side * 0.012
        // A string of cowries
        const drop = 0.4 + (side > 0 ? 0.07 : 0)
        dress.push(fill(place(stripBasic(new THREE.CylinderGeometry(0.004, 0.004, drop, 3, 1)), x, y - drop / 2, z), SENNIT_DARK))
        const strung = opts.lowPower ? 2 : 4
        for (let k = 0; k < strung; k++) {
          const g = stripBasic(new THREE.OctahedronGeometry(1, 0))
          place(g, x, y - drop * ((k + 1) / strung), z, yawQ(k * 1.3), 0.024, 0.03, 0.018)
          dress.push(fill(g, k % 2 ? SHELL : SHELL.clone().lerp(SHELL_PINK, 0.4)))
        }
        // and a strip of bark cloth, dyed at the foot
        const len = 0.34 + (side < 0 ? 0.08 : 0)
        const strip = stripBasic(new THREE.BoxGeometry(0.05, len, 0.006, 1, 3, 1))
        paintFaces(strip, (p, _n, c) => {
          c.copy(p.y < -len * 0.2 ? BARK_CLOTH_DYE : BARK_CLOTH)
        })
        _qa.setFromEuler(new THREE.Euler(0.05 * side, 0.5 * side, 0.06 * side))
        dress.push(place(strip, x - side * 0.13, y - len / 2 - 0.01, z, _qa))
      }
    }
    // Half as tall again as a man, and stout: it has to be seen from a boat
    const carved = merge([post, print, ...dress])
    carved.scale(1.3, 1.27, 1.3)
    carved.rotateY(Math.atan2(outward.x, outward.y))
    parts.push(carved)

    const rel = (x: number, z: number) => H(totemAt.x + x, totemAt.z + z) - totemAt.y
    // A ring of white shells round its foot
    const shells = 15
    for (let i = 0; i < shells; i++) {
      const a = (i / shells) * TAU + (hash(i * 3.1) - 0.5) * 0.25
      const r = 0.52 + hash(i * 7.7) * 0.1
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      groundQuat(totemAt.x + x, totemAt.z + z, a + hash(i) * 1.2, q)
      let g: THREE.BufferGeometry
      if (i % 3 === 1) {
        // An auger shell on its side
        g = stripBasic(new THREE.ConeGeometry(0.03, 0.095, 5))
        g.rotateZ(Math.PI / 2)
        g.translate(0, 0.018, 0)
        const base = rel(x, z)
        place(g, x, base, z, q)
        paintVerts(g, (p, _n, c) => {
          // Pink on the underside, bleached white where the sun gets at it
          c.copy(SHELL).lerp(SHELL_PINK, (1 - smooth(p.y - base, 0, 0.03)) * 0.5)
        })
      } else {
        // A cowrie, dome up
        g = lump(40 + i)
        place(g, x, rel(x, z) + 0.01, z, q, 0.052, 0.026, 0.036)
        fill(g, i % 2 ? SHELL : SHELL.clone().lerp(SHELL_PINK, 0.35))
      }
      parts.push(g)
    }
    // Three wedge stones that hold it upright
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.5
      const x = Math.cos(a) * 0.29
      const z = Math.sin(a) * 0.29
      const g = lump(70 + i)
      place(g, x, rel(x, z) + 0.03, z, groundQuat(totemAt.x + x, totemAt.z + z, a, q), 0.15, 0.11, 0.12)
      parts.push(fill(g, BASALT))
    }
    // A short line of dark stones across the path, on the seaward side: this far, and no further
    const perpX = -outward.y
    const perpZ = outward.x
    const stones = 9
    for (let i = 0; i < stones; i++) {
      const s = -2.2 + (4.4 * i) / (stones - 1) + (hash(i * 5.3) - 0.5) * 0.18
      const off = 1.7 + (hash(i * 9.1) - 0.5) * 0.16
      const x = outward.x * off + perpX * s
      const z = outward.y * off + perpZ * s
      const sx = 0.12 + hash(i * 2.3) * 0.05
      const sy = 0.07 + hash(i * 4.9) * 0.03
      const sz = 0.1 + hash(i * 6.1) * 0.04
      const g = lump(80 + i)
      place(g, x, rel(x, z) + sy * 0.35, z, groundQuat(totemAt.x + x, totemAt.z + z, hash(i * 8.8) * TAU, q), sx, sy, sz)
      paintFaces(g, (_p, nn, c) => {
        c.copy(nn.y > 0.6 ? BASALT_LIGHT : BASALT)
      })
      parts.push(g)
    }
    const geo = merge(parts)
    tris.totem = triangles(geo)
    const mesh = new THREE.Mesh(geo, propMat)
    mesh.name = 'Warning post'
    mesh.position.copy(totemAt)
    group.add(mesh)
  }

  // —— bare footprints from the post toward home ——
  let footprintCount = 0
  {
    const fire = places.campFire
    let fx = fire.x - totemAt.x
    let fz = fire.z - totemAt.z
    const fl = Math.hypot(fx, fz) || 1
    // Toward the camp, leaning a little inland off the beach
    fx = fx / fl - outward.x * 0.35
    fz = fz / fl - outward.y * 0.35
    // Forward is (sin walk, cos walk); the walker's left is then (cos walk, -sin walk)
    let walk = Math.atan2(fx, fz)
    const STEP = 1.25
    // A shade over life size: a real 26 cm print vanished into the sand's
    // ripple shading from standing height
    const FOOT_L = 0.3
    const FOOT_W = 0.13
    const prints = 18
    const verts: number[] = []
    const uvs: number[] = []
    const colours: number[] = []
    const index: number[] = []
    let x = totemAt.x + Math.sin(walk) * 1.3
    let z = totemAt.z + Math.cos(walk) * 1.3
    for (let i = 0; i < prints; i++) {
      // A gentle curve, as a path really runs, and someone running: long strides
      walk += 0.012 * STEP + (hash(i * 4.4) - 0.5) * 0.05
      x += Math.sin(walk) * STEP
      z += Math.cos(walk) * STEP
      const h = H(x, z)
      // Nothing shows in the wash, or on a slope you'd climb hands and feet
      if (h < 1.0 || slopeAt(x, z) > 0.7) continue
      const left = i % 2 === 0
      const sideOff = left ? 0.1 : -0.1
      const px = x + Math.cos(walk) * sideOff
      const pz = z - Math.sin(walk) * sideOff
      // Toes turn out a little (a positive turn swings the toe to the walker's left)
      const toe = walk + (left ? 0.1 : -0.1)
      const fwdX = Math.sin(toe)
      const fwdZ = Math.cos(toe)
      // The foot's own right: with it, the corners below wind facing up
      const rx = -Math.cos(toe)
      const rz = Math.sin(toe)
      // Fresh in the sand; fading where the ground turns to grass, and at the far end
      // (the cove climbs fast: the post stands at ~4 m and the trail reaches ~8 m)
      const alpha = (1 - smooth(h, 8.5, 11)) * (1 - smooth(i, prints - 5, prints)) * (0.75 + hash(i * 1.9) * 0.25)
      if (alpha < 0.05) continue
      const base = verts.length / 3
      for (const [f, s] of [
        [-1, -1],
        [-1, 1],
        [1, 1],
        [1, -1],
      ]) {
        const vx = px + fwdX * f * FOOT_L * 0.5 + rx * s * FOOT_W * 0.5
        const vz = pz + fwdZ * f * FOOT_L * 0.5 + rz * s * FOOT_W * 0.5
        // The terrain mesh runs straight between its grid points, so between
        // them it can stand a few centimetres proud of heightAt: lift clear of it
        verts.push(vx, H(vx, vz) + 0.045, vz)
        // The texture is a left foot; the right is its mirror
        const u = s < 0 ? 0 : 1
        uvs.push(left ? u : 1 - u, f < 0 ? 0 : 1)
        colours.push(1, 1, 1, alpha)
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3)
      footprintCount++
    }
    if (footprintCount > 0) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colours, 4))
      geo.setIndex(index)
      tris.footprints = triangles(geo)
      const mat = new THREE.MeshBasicMaterial({
        map: footTexture(),
        color: '#1e150d',
        transparent: true,
        // Checked by eye on the cove at mid-afternoon: under 0.6 the prints are
        // lost among the sand's ripple shading and the palms' shadow bands
        opacity: 0.8,
        vertexColors: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.name = 'Bare footprints'
      mesh.renderOrder = 1
      mesh.userData.noShadow = true
      smallThing(mesh)
      group.add(mesh)
    }
  }

  // —— the camp, and the fire at its heart ——
  const fireAt = places.campFire
  const fireGroup = new THREE.Group()
  fireGroup.name = 'Camp fire'
  fireGroup.position.copy(fireAt)
  group.add(fireGroup)
  // Added once and never hidden or removed: a light leaving the scene rebuilds
  // every lit shader in it. By day it is simply at zero.
  const fireLight = new THREE.PointLight('#ff9a4a', 0, 22, 2)
  fireLight.castShadow = false
  fireLight.position.set(0, 0.6, 0)
  fireGroup.add(fireLight)
  // The houses, the hearth and everything a household leaves about (camp.ts)
  const camp = createCamp({
    scene,
    parent: group,
    fireGroup,
    fireLight,
    island,
    // The real island has its terrain mesh to give; a stand-in for it need not
    terrain: (island as { terrain?: THREE.Mesh }).terrain,
    places,
    lowPower: opts.lowPower,
  })
  Object.assign(tris, camp.triangles)

  // —— salvage ——
  const salvage: Salvage[] = []
  const makeSalvage = (id: SalvageId, label: string, geo: THREE.BufferGeometry, roughness: number, metalness: number) => {
    // Its own material, so its glow is its own; the glow is a hint, not sky fill
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness,
      metalness,
      emissive: GLOW,
      emissiveIntensity: 0,
    })
    const mesh = new THREE.Mesh(geo, material)
    mesh.name = label
    smallThing(mesh)
    group.add(mesh)
    tris[id] = triangles(geo)
    const s: Salvage = {
      id,
      label,
      mesh,
      material,
      home: new THREE.Vector3(),
      homeQuat: new THREE.Quaternion(),
      floats: false,
      inWorld: true,
      phase: salvage.length * 1.9,
      info: { id, kind: id, label, position: new THREE.Vector3(), distance: 0 },
    }
    salvage.push(s)
    return s
  }
  const putAt = (s: Salvage, at: THREE.Vector3, quat: THREE.Quaternion) => {
    s.home.copy(at)
    s.homeQuat.copy(quat)
    s.mesh.position.copy(at)
    s.mesh.quaternion.copy(quat)
  }

  const compass = makeSalvage('salvage_compass', 'Brass compass', buildCompass(), 0.45, 0.35)
  putAt(compass, compassAt, groundQuat(compassAt.x, compassAt.z, hash(compassAt.x) * TAU, q))

  const battery = makeSalvage('radio_battery', 'Radio battery', buildBattery(), 0.55, 0.15)
  if (batteryOnDeck) putAt(battery, batteryAt, yawQ(0.7))
  else putAt(battery, batteryAt, groundQuat(batteryAt.x, batteryAt.z, hash(batteryAt.z) * TAU, q))

  const flare = makeSalvage('salvage_flare', 'Flare', buildFlare(), 0.5, 0.05)
  const spear = makeSalvage('spear', 'Spear', spearProp.geo, 0.7, 0.25)
  if (perch) {
    putAt(flare, flareAt, yawQ(0.8))
    const pitchQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), spearPitch)
    putAt(spear, spearAt, yawQ(spearYaw).multiply(pitchQ))
  } else {
    flare.floats = true
    spear.floats = true
    putAt(flare, flareAt, yawQ(0.8))
    putAt(spear, spearAt, yawQ(spearYaw))
  }
  const salvageById = new Map<string, Salvage>(salvage.map((s) => [s.id, s]))

  // —— the shelf in the caves, if one had to be built ——
  if (shelf) {
    const g = lump(91, 1)
    g.scale(0.66, 0.26, 0.52)
    const sp = g.attributes.position
    // Sheared flat across the top, the way a basalt bed breaks
    let top = -Infinity
    for (let i = 0; i < sp.count; i++) {
      const y = sp.getY(i)
      if (y > 0.02) sp.setY(i, 0.02 + (y - 0.02) * 0.1)
      top = Math.max(top, sp.getY(i))
    }
    g.translate(0, -top, 0)
    g.computeVertexNormals()
    paintFaces(g, (p, nn, c) => {
      if (nn.y > 0.75) c.copy(SHELF_TOP).lerp(SHELF_SALT, hash(p.x * 23.1 + p.z * 41.7) * 0.5)
      else c.copy(SHELF_SIDE)
    })
    tris.caveShelf = triangles(g)
    // No sky fill: the chamber is sealed from the sky, and its own lights do the work
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }))
    mesh.name = 'Cave shelf'
    mesh.position.set(shelf.x, 0.85, shelf.z)
    mesh.rotation.y = shelf.yaw
    group.add(mesh)
  }

  // —— the bag ——
  const bagGeo = buildBag(!opts.lowPower)
  tris.bag = triangles(bagGeo)
  const bagObj = new THREE.Group()
  bagObj.name = 'Cash duffel'
  const bagMesh = new THREE.Mesh(bagGeo, bagMat)
  bagMesh.name = 'Cash duffel body'
  bagObj.add(bagMesh)
  smallThing(bagObj)
  bagObj.visible = false
  group.add(bagObj)
  let bagState: BagState = 'carried'
  const bagPos = new THREE.Vector3().copy(places.landing)
  let bagX = 0
  let bagZ = 0
  let bagY = 0
  let bagYaw = 0
  let bagGround = 0
  let bagInChamber = false
  let bagFloating = false
  let floatAge = 0
  const bagInfo: Interactable = { id: 'cash_bag', kind: 'cash_bag', label: 'The bag', position: new THREE.Vector3(), distance: 0 }
  const stashQuat = new THREE.Quaternion().setFromAxisAngle(UP, stashYaw)
  const tiltQ = new THREE.Quaternion()
  const rockQ = new THREE.Quaternion()
  const wave = new THREE.Vector3()
  const rockE = new THREE.Euler()
  const mine = () => bagObj.parent === group

  function adopt() {
    if (!mine()) group.add(bagObj)
    bagObj.visible = true
  }

  function drop(at: THREE.Vector3) {
    adopt()
    bagState = 'dropped'
    bagX = at.x
    bagZ = at.z
    bagInChamber = inChamber(at.x, tideNow + 0.3, at.z)
    bagGround = groundAt(at.x, at.z, at.y + 0.5)
    bagY = Math.max(at.y, bagGround)
    bagYaw = Math.random() * TAU
    bagFloating = false
    floatAge = 0
    bagObj.position.set(bagX, bagY, bagZ)
    bagObj.quaternion.setFromAxisAngle(UP, bagYaw)
    bagPos.set(bagX, bagY + BAG_MID, bagZ)
  }

  function bagPickUp() {
    bagState = 'carried'
    bagFloating = false
    if (mine()) bagObj.visible = false
  }

  function stashInCaves() {
    adopt()
    bagState = 'stashed_caves'
    bagFloating = false
    bagObj.position.copy(stashAt)
    bagObj.quaternion.copy(stashQuat)
    bagPos.set(stashAt.x, stashAt.y + BAG_MID, stashAt.z)
  }

  const canStashAt = (pos: THREE.Vector3) => tidalCaves.chamberPresence(pos) > 0.5

  function updateBag(dt: number, t: number, eye?: THREE.Vector3) {
    if (bagState === 'carried') {
      if (eye) bagPos.copy(eye)
      return
    }
    if (bagState !== 'dropped' || !mine()) return
    if (eye && eye.distanceToSquared(bagPos) > FAR * FAR) return
    let water: number
    if (bagInChamber) {
      water = tideNow
      wave.set(0, 1, 0)
    } else {
      const s = sampleOcean(bagX, bagZ, t)
      water = s.y
      wave.set(s.normal.x, s.normal.y, s.normal.z)
    }
    // It floats where it can't touch bottom, and grounds again as the tide leaves it
    const depth = water - bagGround
    if (!bagFloating && depth > 0.6) {
      bagFloating = true
      floatAge = 0
    } else if (bagFloating && depth < 0.45) {
      bagFloating = false
    }
    if (bagFloating) {
      floatAge += dt
      // Half under at first, lower as the water gets in among the paper
      const target = water - (0.13 + 0.07 * smooth(floatAge, 0, 30))
      // A plop down onto the water, or a slow rise if it was let go under it;
      // once afloat it rides the swell closely, just a little behind it
      const settling = Math.abs(bagY - target) > 0.5
      bagY = damp(bagY, target, settling ? (bagY > target ? 4 : 1.6) : 8, dt)
      // A heavy roll after the splash, settling to a slow wallow
      const wallow = 0.07 + 0.42 * Math.exp(-floatAge / 3.5)
      rockE.set(wallow * 0.45 * Math.sin(t * 0.9 + 2), 0, wallow * Math.sin(t * 1.25 + 0.6))
      // It rides the swell, but too heavy to follow every face of it
      tiltQ.setFromUnitVectors(UP, wave.lerp(UP, 0.3).normalize())
      bagObj.quaternion.copy(tiltQ).multiply(yawQ(bagYaw)).multiply(rockQ.setFromEuler(rockE))
    } else {
      bagY = damp(bagY, bagGround, 9, dt)
      if (bagGround > H(bagX, bagZ) + 0.05) bagObj.quaternion.setFromAxisAngle(UP, bagYaw)
      else groundQuat(bagX, bagZ, bagYaw, bagObj.quaternion)
    }
    bagObj.position.set(bagX, bagY, bagZ)
    bagPos.set(bagX, bagY + BAG_MID, bagZ)
  }

  const bag: CashBag = {
    get state() {
      return bagState
    },
    object: bagObj,
    position: bagPos,
    drop,
    pickUp: bagPickUp,
    stashInCaves,
    canStashAt,
  }

  // —— the bills ——
  const POOL = opts.lowPower ? 80 : 160
  const billGeo = new THREE.PlaneGeometry(BILL_W, BILL_H, 4, 1)
  billGeo.rotateX(-Math.PI / 2)
  /** Per bill: x = how far it has burnt (0 none .. 1 ash), y = how much it bends (wet sag, flutter, curl). */
  const billState = new Float32Array(POOL * 2)
  const stateAttr = new THREE.InstancedBufferAttribute(billState, 2)
  stateAttr.setUsage(THREE.DynamicDrawUsage)
  billGeo.setAttribute('aState', stateAttr)
  tris.billEach = triangles(billGeo)
  const billMat = new THREE.MeshStandardMaterial({
    map: billTexture(),
    roughness: 0.62,
    side: THREE.DoubleSide,
  })
  const halfW = (BILL_W / 2).toFixed(4)
  billMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aState;\nvarying float vBurn;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vBurn = aState.x;
        // Wet paper sags at both ends; burning paper curls up hard
        float across = position.x / ${halfW};
        transformed.y += (aState.y + aState.x * 0.9) * across * across * ${halfW} * 0.55;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBurn;')
      .replace(
        '#include <map_fragment>',
        `// The back face reads the right way round, not mirrored
        vec2 billUv = gl_FrontFacing ? vMapUv : vec2(1.0 - vMapUv.x, vMapUv.y);
        diffuseColor *= texture2D(map, billUv);
        // Burning eats in from the edges: a glowing line, char behind it, then nothing
        float billEdge = max(abs(vMapUv.x - 0.5), abs(vMapUv.y - 0.5)) * 2.0;
        float charLine = 1.0 - vBurn * 1.25;
        float burning = step(0.001, vBurn);
        if (burning > 0.5 && billEdge > charLine + 0.12) discard;
        float charred = burning * smoothstep(charLine - 0.35, charLine, billEdge);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.03, 0.028), max(charred, burning * smoothstep(0.55, 0.9, vBurn)));
        float glowBand = burning * (1.0 - smoothstep(0.0, 0.2, abs(billEdge - charLine - 0.05))) * (1.0 - smoothstep(0.8, 1.0, vBurn));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.36, 0.07) * glowBand * 3.0;`,
      )
  }
  billMat.customProgramCacheKey = () => 'heist-bill-1'
  const bills = new THREE.InstancedMesh(billGeo, billMat, POOL)
  bills.name = 'Wet hundreds'
  bills.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  // They are only ever near the eye, and the bounds would go stale as they fly
  bills.frustumCulled = false
  bills.userData.noShadow = true
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0)
  const tint = new THREE.Color()
  for (let i = 0; i < POOL; i++) {
    bills.setMatrixAt(i, hidden)
    bills.setColorAt(i, tint.setRGB(1, 1, 1))
  }
  bills.visible = false
  smallThing(bills)
  group.add(bills)

  const bMode = new Uint8Array(POOL)
  const bChamber = new Uint8Array(POOL)
  const bPx = new Float32Array(POOL)
  const bPy = new Float32Array(POOL)
  const bPz = new Float32Array(POOL)
  const bVx = new Float32Array(POOL)
  const bVy = new Float32Array(POOL)
  const bVz = new Float32Array(POOL)
  const bYaw = new Float32Array(POOL)
  const bSpin = new Float32Array(POOL)
  const bSwayDir = new Float32Array(POOL)
  const bFreq = new Float32Array(POOL)
  const bPhase = new Float32Array(POOL)
  const bAge = new Float32Array(POOL)
  const bLife = new Float32Array(POOL)
  const bBurn = new Float32Array(POOL)
  const bBurnRate = new Float32Array(POOL)
  const bNx = new Float32Array(POOL)
  const bNz = new Float32Array(POOL)
  const bGround = new Float32Array(POOL)
  const bLift = new Float32Array(POOL)
  let billsLive = 0
  let cursor = 0
  const bm = new THREE.Matrix4()
  const bq = new THREE.Quaternion()
  const bq2 = new THREE.Quaternion()
  const be = new THREE.Euler(0, 0, 0, 'YXZ')
  const bp = new THREE.Vector3()
  const bs = new THREE.Vector3()
  const bn = new THREE.Vector3()

  function freeSlot() {
    for (let k = 0; k < POOL; k++) {
      const i = (cursor + k) % POOL
      if (bMode[i] === DEAD) {
        cursor = (i + 1) % POOL
        return i
      }
    }
    // All in the air: the oldest one goes first
    let oldest = 0
    for (let i = 1; i < POOL; i++) if (bAge[i] > bAge[oldest]) oldest = i
    return oldest
  }

  function spawnBills(origin: THREE.Vector3, count: number, burning: boolean) {
    const total = Math.min(POOL, Math.max(0, Math.floor(count)))
    if (total === 0) return 0
    const under = !burning && waterAt(origin.x, origin.z, now) > origin.y + 0.05
    for (let k = 0; k < total; k++) {
      const i = freeSlot()
      if (bMode[i] === DEAD) billsLive++
      const a = Math.random() * TAU
      const out = burning ? 0.15 + Math.random() * 0.45 : under ? 0.2 + Math.random() * 0.5 : 0.8 + Math.random() * 2.2
      bPx[i] = origin.x + Math.cos(a) * 0.06
      bPy[i] = origin.y + (burning ? 0.1 : 0)
      bPz[i] = origin.z + Math.sin(a) * 0.06
      bVx[i] = Math.cos(a) * out
      bVz[i] = Math.sin(a) * out
      bVy[i] = burning ? 0.9 + Math.random() * 1.2 : under ? 0.2 + Math.random() * 0.3 : 2.4 + Math.random() * 2.6
      bYaw[i] = Math.random() * TAU
      bSpin[i] = (Math.random() - 0.5) * 6
      bSwayDir[i] = Math.random() * TAU
      bFreq[i] = 2.2 + Math.random() * 1.6
      bPhase[i] = Math.random() * TAU
      bAge[i] = 0
      bLife[i] = 12 + Math.random() * 8
      bBurn[i] = burning ? 0.02 : 0
      bBurnRate[i] = 1 / (2.2 + Math.random() * 1.6)
      // A few millimetres apart in height, so bills lying on bills don't flicker
      bLift[i] = 0.012 + Math.random() * 0.006
      bChamber[i] = 0
      bMode[i] = burning ? BURN : under ? SINK : AIR
      // Some soaked darker than others
      const wet = 0.78 + Math.random() * 0.22
      bills.setColorAt(i, tint.setRGB(wet, wet * (0.98 + Math.random() * 0.04), wet))
    }
    if (bills.instanceColor) bills.instanceColor.needsUpdate = true
    bills.visible = true
    return total
  }

  function killBill(i: number) {
    bMode[i] = DEAD
    bills.setMatrixAt(i, hidden)
    billsLive--
  }

  function landBill(i: number, g: number) {
    bMode[i] = GROUND
    bPy[i] = g + bLift[i]
    if (g > H(bPx[i], bPz[i]) + 0.05) {
      // On the spire or the caves' rock: lie flat
      bNx[i] = 0
      bNz[i] = 0
    } else {
      normalAt(bPx[i], bPz[i], bn)
      bNx[i] = bn.x
      bNz[i] = bn.z
    }
    bVx[i] = 0
    bVy[i] = 0
    bVz[i] = 0
    // What lands in the fire burns
    if (Math.hypot(bPx[i] - fireAt.x, bPz[i] - fireAt.z) < 0.75 && Math.abs(g - fireAt.y) < 0.6) {
      bMode[i] = BURN
      bBurn[i] = Math.max(bBurn[i], 0.05)
      bVy[i] = 0.3
    }
  }

  function stepBills(dt: number, t: number, storm: number) {
    const windK = 0.35 + storm * 1.6
    for (let i = 0; i < POOL; i++) {
      const mode = bMode[i]
      if (mode === DEAD) continue
      bAge[i] += dt
      const age = bAge[i]
      const swing = bPhase[i] + age * bFreq[i]
      let scale = 1
      let bend = 0.08
      let resting = false
      let tiltX = 0
      let tiltZ = 0
      if (mode === BURN) {
        bBurn[i] += dt * bBurnRate[i]
        if (bBurn[i] >= 1) {
          killBill(i)
          continue
        }
        const burn = bBurn[i]
        // The heat carries it up, turning, until there is nothing left of it
        bVy[i] = damp(bVy[i], 0.55 + 0.35 * Math.sin(swing), 2.5, dt)
        bVx[i] = damp(bVx[i], Math.cos(bPhase[i] + age * 1.9) * 0.3 + WIND_X * windK * 0.5, 2, dt)
        bVz[i] = damp(bVz[i], Math.sin(bPhase[i] + age * 1.9) * 0.3 + WIND_Z * windK * 0.5, 2, dt)
        bPx[i] += bVx[i] * dt
        bPy[i] += bVy[i] * dt
        bPz[i] += bVz[i] * dt
        bYaw[i] += bSpin[i] * dt
        tiltX = Math.cos(swing * 1.3) * 0.7
        tiltZ = Math.sin(swing) * 0.4
        scale = 1 - 0.5 * smooth(burn, 0.45, 1)
        bend = 0.25 + burn * 0.75
      } else {
        const left = bLife[i] - age
        if (left <= 0) {
          killBill(i)
          continue
        }
        scale = smooth(left, 0, 1.4)
        if (mode === AIR) {
          // The clump flies off the stack first, then each bill catches the air on its own
          const settled = smooth(age, 0.25, 0.6)
          const sway = Math.sin(swing) * 0.85 * settled
          const tx = WIND_X * windK * settled + Math.cos(bSwayDir[i]) * sway
          const tz = WIND_Z * windK * settled + Math.sin(bSwayDir[i]) * sway
          const k = 1 - Math.exp(-(0.4 + 2.8 * settled) * dt)
          bVx[i] += (tx - bVx[i]) * k
          bVz[i] += (tz - bVz[i]) * k
          // Quadratic drag, stepped implicitly so it can't overshoot: paper
          // falls at about a metre a second once it is presenting its face
          const drag = 0.5 + 7 * settled
          bVy[i] = (bVy[i] - 9.8 * dt) / (1 + drag * Math.abs(bVy[i]) * dt)
          bPx[i] += bVx[i] * dt
          bPy[i] += bVy[i] * dt
          bPz[i] += bVz[i] * dt
          bYaw[i] += bSpin[i] * dt
          // Tumbling off the stack, then rocking down like a falling leaf
          tiltX = (1 - settled) * age * 11 + settled * Math.cos(swing) * 0.9
          tiltZ = settled * Math.sin(swing * 2) * 0.22
          bend = 0.22 * Math.sin(age * 9 + bPhase[i])
          const g = groundAt(bPx[i], bPz[i], bPy[i] + 0.25)
          // Only sample the sea where there could be any
          const water = g < tideNow + 1.4 ? waterAt(bPx[i], bPz[i], t) : -Infinity
          if (water > g + 0.03 && bPy[i] <= water) {
            bMode[i] = FLOAT
            bGround[i] = g
            bChamber[i] = inChamber(bPx[i], tideNow + 0.3, bPz[i]) ? 1 : 0
            bVy[i] = 0
          } else if (bPy[i] <= g + bLift[i]) {
            landBill(i, g)
          }
        } else if (mode === SINK) {
          // Let go under water, a soaked bill drifts slowly down to the bottom
          bVy[i] = damp(bVy[i], -0.12, 1.2, dt)
          const sway = Math.sin(swing * 0.5) * 0.12
          bVx[i] = damp(bVx[i], Math.cos(bSwayDir[i]) * sway, 1.5, dt)
          bVz[i] = damp(bVz[i], Math.sin(bSwayDir[i]) * sway, 1.5, dt)
          bPx[i] += bVx[i] * dt
          bPy[i] += bVy[i] * dt
          bPz[i] += bVz[i] * dt
          bYaw[i] += bSpin[i] * 0.2 * dt
          tiltX = Math.cos(swing * 0.5) * 0.5
          bend = 0.1 * Math.sin(age * 2 + bPhase[i])
          const g = groundAt(bPx[i], bPz[i], bPy[i] + 0.25)
          if (bPy[i] <= g + bLift[i]) landBill(i, g)
        } else if (mode === FLOAT) {
          resting = true
          if (bChamber[i]) {
            bPy[i] = tideNow + 0.004
            bNx[i] = 0
            bNz[i] = 0
          } else {
            const s = sampleOcean(bPx[i], bPz[i], t)
            bPy[i] = s.y + 0.004
            bNx[i] = s.normal.x
            bNz[i] = s.normal.z
          }
          bSpin[i] *= Math.exp(-1.5 * dt)
          bYaw[i] += bSpin[i] * dt
          bPx[i] += (bVx[i] * Math.exp(-age * 0.6) + WIND_X * 0.05) * dt
          bPz[i] += (bVz[i] * Math.exp(-age * 0.6) + WIND_Z * 0.05) * dt
          bend = 0.03
          // Sinking as it goes, once it is soaked through
          bPy[i] -= (1 - scale) * 0.05
          // The tide (or a trough over the reef) has gone out from under it.
          // It has drifted since it settled, so the ground is looked up afresh.
          if (bPy[i] < bGround[i] + bLift[i]) landBill(i, groundAt(bPx[i], bPz[i], bPy[i] + 0.25))
        } else {
          resting = true
        }
      }
      if (resting) {
        bn.set(bNx[i], Math.sqrt(Math.max(0, 1 - bNx[i] * bNx[i] - bNz[i] * bNz[i])), bNz[i])
        bq.setFromUnitVectors(UP, bn).multiply(bq2.setFromAxisAngle(UP, bYaw[i]))
      } else {
        bq.setFromEuler(be.set(tiltX, bYaw[i], tiltZ, 'YXZ'))
      }
      bm.compose(bp.set(bPx[i], bPy[i], bPz[i]), bq, bs.setScalar(scale))
      bills.setMatrixAt(i, bm)
      billState[i * 2] = bMode[i] === BURN ? bBurn[i] : 0
      billState[i * 2 + 1] = bend
    }
    bills.instanceMatrix.needsUpdate = true
    stateAttr.needsUpdate = true
    if (billsLive <= 0) {
      billsLive = 0
      bills.visible = false
    }
  }

  function clearBills() {
    for (let i = 0; i < POOL; i++) {
      bMode[i] = DEAD
      bills.setMatrixAt(i, hidden)
    }
    billsLive = 0
    bills.instanceMatrix.needsUpdate = true
    bills.visible = false
  }

  // —— what you can act on ——
  const fireInfo: Interactable = { id: 'campfire', kind: 'campfire', label: 'Fire', position: fireAt.clone(), distance: 0 }
  const totemInfo: Interactable = { id: 'totem', kind: 'totem', label: 'Carved post', position: totemAt.clone().setY(totemAt.y + 1.2), distance: 0 }
  const stashInfo: Interactable = { id: 'cave_stash', kind: 'cave_stash', label: 'Stash the bag', position: stashAt.clone(), distance: 0 }
  let pick: Interactable | null = null
  let pickD = Infinity
  const offer = (rec: Interactable, d: number, reach: number) => {
    if (d <= reach && d < pickD) {
      pickD = d
      pick = rec
      rec.distance = d
    }
  }
  /** Ground-standing things are reached across the ground, so standing height doesn't count against you. */
  const overGround = (pos: THREE.Vector3, at: THREE.Vector3) =>
    Math.abs(pos.y - at.y) < 3 ? Math.hypot(pos.x - at.x, pos.z - at.z) : Infinity

  function getNearbyInteractable(pos: THREE.Vector3, maxDistance = 3): Interactable | null {
    pick = null
    pickD = Infinity
    for (const s of salvage) {
      if (!s.inWorld) continue
      s.info.position.copy(s.mesh.position)
      offer(s.info, pos.distanceTo(s.info.position), maxDistance)
    }
    if (bagState !== 'carried' && mine()) {
      bagInfo.position.copy(bagPos)
      offer(bagInfo, pos.distanceTo(bagPos), maxDistance)
    }
    offer(fireInfo, overGround(pos, fireAt), Math.max(FIRE_REACH, maxDistance))
    offer(totemInfo, overGround(pos, totemAt), maxDistance)
    // Anywhere in the chamber will do: the ledge is where the bag goes, not where you have to be
    if (bagState === 'carried' && canStashAt(pos)) offer(stashInfo, pos.distanceTo(stashAt), Infinity)
    return pick
  }

  function pickUp(id: string): InteractableKind | null {
    if (id === 'cash_bag') {
      if (bagState === 'carried') return null
      bagPickUp()
      return 'cash_bag'
    }
    const s = salvageById.get(id)
    if (!s || !s.inWorld) return null
    s.inWorld = false
    s.mesh.visible = false
    s.material.emissiveIntensity = 0
    return s.id
  }

  const isInWorld = (id: string) => salvageById.get(id)?.inWorld ?? false

  function resetProps() {
    for (const s of salvage) {
      s.inWorld = true
      s.mesh.visible = true
      s.mesh.position.copy(s.home)
      s.mesh.quaternion.copy(s.homeQuat)
      s.material.emissiveIntensity = 0
    }
    bagPickUp()
    clearBills()
  }

  const modifiers: MovementModifiers = { ...UNBURDENED }
  function getMovementModifiers() {
    return Object.assign(modifiers, bagState === 'carried' ? CARRIED : UNBURDENED)
  }

  // —— per frame ——
  const reefAnchor = new THREE.Vector3(site.x, 0, site.z)
  const perchAnchor = perch ? perch.clone() : new THREE.Vector3(opts.wreckPos.x, 0, opts.wreckPos.z)
  const anchors = [totemAt, fireAt, reefAnchor, stashAt, perchAnchor]
  const FAR2 = FAR * FAR

  function update(dt: number, t: number, weather: TribeWeather, eye?: THREE.Vector3) {
    now = t
    tideNow = weather.tide
    let anyNear = !eye
    if (eye) for (const a of anchors) if (eye.distanceToSquared(a) < FAR2) anyNear = true

    // The camp: its fire is a light only after dark, damped by rain, never put away
    camp.update(dt, t, weather, eye)

    if (anyNear) {
      for (const s of salvage) {
        if (!s.inWorld) continue
        if (s.floats && (!eye || eye.distanceToSquared(s.home) < FAR2)) {
          const w = sampleOcean(s.home.x, s.home.z, t)
          s.mesh.position.set(s.home.x, w.y - 0.01, s.home.z)
          wave.set(w.normal.x, w.normal.y, w.normal.z)
          s.mesh.quaternion.setFromUnitVectors(UP, wave).multiply(s.homeQuat)
        }
        // A shimmer as you come close enough to see what it is, and nothing from further off
        let glow = 0
        if (eye) {
          const d = eye.distanceTo(s.mesh.position)
          if (d < GLOW_REACH) {
            const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 2.6 + s.phase))
            glow = (1 - smooth(d, 2, GLOW_REACH)) * pulse * (0.25 + 0.75 * weather.daylight)
          }
        }
        s.material.emissiveIntensity = glow
      }
    }

    updateBag(dt, t, eye)
    if (billsLive > 0) stepBills(dt, t, weather.storm)
  }

  const spots: HeistSpots = {
    totem: totemAt.clone(),
    campFire: fireAt.clone(),
    compass: compassAt.clone(),
    flare: flare.home.clone(),
    spear: spear.home.clone(),
    battery: batteryAt.clone(),
    caveStash: stashAt.clone(),
    caveShelfBuilt: shelf !== null,
    batteryOnDeck,
    footprints: footprintCount,
  }
  group.userData.triangles = tris
  // Where the camp's houses and gear ended up, for checking the islanders' routes against
  group.userData.camp = { sites: camp.sites, triangles: camp.triangles, parts: camp.parts, notes: camp.notes, draws: camp.draws }

  return {
    group,
    places,
    bag,
    getMovementModifiers,
    burstCashBills: (origin, count) => spawnBills(origin, count, false),
    burnCashBills: (origin, count) => spawnBills(origin, count, true),
    getNearbyInteractable,
    pickUp,
    isInWorld,
    resetProps,
    update,
    spots,
  }
}
