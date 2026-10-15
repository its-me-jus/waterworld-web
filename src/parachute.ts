/**
 * The way in: a parachute drop onto the island.
 *
 * You open above the sea with the island ahead and come down under a ram-air
 * canopy. It is a game, not a simulator: the descent is slow and forgiving
 * (about a minute and a half), the controls are the ones you already have,
 * and nothing about a bad landing hurts. What it asks of you is a little
 * judgement — you have more height than you need to reach the beach, so you
 * get to choose how to lose it (turns, brakes, a long straight glide) and
 * then to flare in the last few metres for a soft touchdown.
 *
 *   A / D or stick sideways   steer (the canopy banks, the view banks with it)
 *   W or stick forward         release the brakes — faster, a little steeper
 *   S or stick back            brakes — slower, flatter
 *   Space (touch: Rise)        flare: pull both brakes
 *
 * The flare only does its job low down; pulled high up it just stalls the
 * canopy, and you drop faster for a moment.
 *
 * This module owns the canopy, the flight and the touchdown. It does not own
 * the player: it is handed the same PlayerState the swim/walk controller
 * uses, moves it, and gives control back when you land.
 */
import * as THREE from 'three'
import type { InputState } from './input'
import type { PlayerFrame, PlayerState } from './player'
import { sampleOcean } from './waves'

/** Eye heights the swim / walk controllers settle at — landing hands over onto these. */
const WALK_EYE = 1.62
const SWIM_EYE = 1.5
/** Water shallower than this and you land on your feet, as the player's own walk-in rule does. */
const STAND_ENTER = 0.85

const TRIM_FORWARD = 10.5
const TRIM_SINK = 4.3
const TURN_RATE = 0.62
/** How far above the eye the canopy sits. */
const CANOPY_LIFT = 7.4

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export type Touchdown = {
  kind: 'land' | 'sea'
  /** Sink rate the moment the feet arrived, m/s — under ~1.5 is a good flare. */
  sink: number
}

export type ChuteStart = {
  x: number
  z: number
  /** Metres above the sea. */
  altitude: number
  /** Same convention as player.yaw. */
  yaw: number
  pitch?: number
}

/** The ram-air wing: an arched strip of cells, coral and cream with a teal stripe, seams darker. */
function buildCanopy() {
  const SPAN = 9.6
  const CHORD = 3.6
  const ARC = 1.5
  const R = SPAN / ARC
  const nx = 32
  const nz = 7
  const cell = nx / 11
  const palette = ['#f3ead2', '#e8552d', '#f3ead2', '#e8552d', '#f3ead2', '#1c9aa6', '#f3ead2', '#e8552d', '#f3ead2', '#e8552d', '#f3ead2'].map(
    (hex) => new THREE.Color(hex),
  )
  const pos: number[] = []
  const col: number[] = []
  const idx: number[] = []
  const under = new Map<string, THREE.Vector3>()
  const c = new THREE.Color()
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const u = i / nx
      const v = j / nz
      const ang = (u - 0.5) * ARC
      const taper = 1 - 0.28 * Math.pow(Math.abs(u - 0.5) * 2, 2)
      const x = R * Math.sin(ang)
      const y = R * (Math.cos(ang) - Math.cos(ARC / 2))
      const z = (v - 0.4) * CHORD * taper
      // A wing section: fat near the leading edge, knife at the trailing edge
      const puff = 0.46 * Math.pow(Math.sin(Math.PI * Math.min(1, v * 0.9 + 0.04)), 0.7) * taper
      pos.push(x, y + puff, z)
      const k = Math.min(palette.length - 1, Math.floor(i / cell))
      c.copy(palette[k])
      // Seams between cells, and a little shading toward the trailing edge
      const edge = Math.abs((i % cell) / cell - 0.5) * 2
      const seam = 1 - 0.32 * smooth(0.86, 1, edge)
      const trail = 1 - 0.18 * v
      c.multiplyScalar(seam * trail)
      col.push(c.r, c.g, c.b)
      if ((j === 2 || j === 5) && i % 8 === 4) under.set(`${i}:${j}`, new THREE.Vector3(x, y + puff - 0.08, z))
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i
      const b = a + 1
      const d = a + nx + 1
      const e = d + 1
      idx.push(a, d, b, b, d, e)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return { geo, anchors: [...under.values()] }
}

export function createParachute(scene: THREE.Scene) {
  const group = new THREE.Group()
  group.visible = false
  group.rotation.order = 'YXZ'
  scene.add(group)

  const { geo, anchors } = buildCanopy()
  // Unlit: lit nylon seen from underneath is black, and real canopy glows
  // with the sky behind it. `setLight` dims it with the day instead.
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false })
  const wing = new THREE.Mesh(geo, material)
  wing.frustumCulled = false
  group.add(wing)

  // Suspension lines: each underside anchor to the two risers at the shoulders
  const linePts: number[] = []
  for (const a of anchors) {
    const side = a.x < 0 ? -1 : 1
    linePts.push(a.x, a.y, a.z, side * 0.38, -CANOPY_LIFT - 0.3, 0.05)
  }
  const lineGeo = new THREE.BufferGeometry()
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3))
  const lines = new THREE.LineSegments(
    lineGeo,
    new THREE.LineBasicMaterial({ color: 0xf2efe2, transparent: true, opacity: 0.85, fog: false }),
  )
  lines.frustumCulled = false
  group.add(lines)

  type Phase = 'off' | 'flying' | 'down'
  let phase: Phase = 'off'
  let heading = 0
  let fwd = TRIM_FORWARD
  let sink = TRIM_SINK
  let bank = 0
  let height = 0
  let downFor = 0
  let downKind: 'land' | 'sea' = 'land'
  const downAt = new THREE.Vector3()
  const fwdVec = new THREE.Vector2()

  function floorAt(player: PlayerState, groundAt: (x: number, z: number) => number, t: number) {
    const ground = groundAt(player.x, player.z)
    const surface = sampleOcean(player.x, player.z, t).y
    if (ground > -STAND_ENTER) return { y: ground + WALK_EYE, land: true, surface, ground }
    return { y: surface + SWIM_EYE, land: false, surface, ground }
  }

  function begin(player: PlayerState, start: ChuteStart, t: number) {
    player.x = start.x
    player.z = start.z
    player.y = sampleOcean(start.x, start.z, t).y + start.altitude
    player.yaw = start.yaw
    player.pitch = start.pitch ?? -0.1
    player.roll = 0
    player.viewPitch = 0
    player.vy = 0
    player.speed = 0
    player.mode = 'swim'
    player.fallFrom = null
    heading = start.yaw
    fwd = TRIM_FORWARD
    sink = TRIM_SINK
    bank = 0
    phase = 'flying'
    group.visible = true
    group.scale.set(1, 1, 1)
  }

  /** One step of flight. Returns null unless flying. */
  function update(
    dt: number,
    t: number,
    player: PlayerState,
    camera: THREE.PerspectiveCamera,
    input: InputState,
    groundAt: (x: number, z: number) => number,
  ): { frame: PlayerFrame; touchdown: Touchdown | null } | null {
    if (phase !== 'flying') return null

    const bar = clamp(Math.max(input.moveForward, 0) + (input.dive ? 1 : 0), 0, 1)
    const brake = clamp(Math.max(-input.moveForward, 0) + (input.rise ? 0.9 : 0), 0, 1)
    const steer = clamp(input.moveStrafe, -1, 1)

    const floor = floorAt(player, groundAt, t)
    height = player.y - floor.y

    // Flare: brakes only buy you a soft touchdown low down. Pulled high up
    // they stall the wing and you drop faster until you let them off.
    const lowFlare = 1 - smooth(3, 16, height)
    const stall = brake > 0.7 ? smooth(0.7, 1, brake) * smooth(12, 26, height) : 0
    const targetFwd = TRIM_FORWARD + 3.5 * bar - 5.5 * brake
    let targetSink = TRIM_SINK + 1.7 * bar - 1.3 * brake + 0.9 * Math.abs(steer) + 2.2 * stall
    targetSink -= brake * lowFlare * 2.9
    // Never hover: there is always a little sink
    targetSink = Math.max(targetSink, height < 5 ? 0.25 : 2.0)

    fwd = damp(fwd, targetFwd, 1.1, dt)
    sink = damp(sink, targetSink, 1.8, dt)

    // Turning. Right is a clockwise turn seen from above, which is yaw falling
    const turn = -steer * TURN_RATE * (0.6 + fwd / 16) * dt
    heading += turn
    player.yaw += turn
    bank = damp(bank, steer * 0.42, 2.4, dt)

    fwdVec.set(-Math.sin(heading), -Math.cos(heading))
    player.x += fwdVec.x * fwd * dt
    player.z += fwdVec.y * fwd * dt
    player.y -= sink * dt
    player.dirX = fwdVec.x
    player.dirZ = fwdVec.y

    // A little buffeting, more at speed: enough to feel air, not enough to tire
    const gust = (Math.sin(t * 1.7) * 0.012 + Math.sin(t * 3.3 + 1.2) * 0.007) * (fwd / TRIM_FORWARD)
    player.roll = damp(player.roll, -bank * 0.6 + gust, 6, dt)
    player.viewPitch = damp(player.viewPitch, Math.sin(t * 2.1) * 0.006, 4, dt)

    // Camera, as the swim and walk controllers set it
    const rightX = Math.cos(player.yaw)
    const rightZ = -Math.sin(player.yaw)
    camera.position.set(player.x + rightX * 0, player.y, player.z + rightZ * 0)
    camera.rotation.order = 'YXZ'
    camera.rotation.y = player.yaw
    camera.rotation.x = clamp(player.pitch + player.viewPitch, -1.5, 1.5)
    camera.rotation.z = player.roll

    // The wing rides over you, a little ahead, nose down — and lifts its nose
    // as the brakes come on
    group.position.set(
      player.x + fwdVec.x * 1.0,
      player.y + CANOPY_LIFT,
      player.z + fwdVec.y * 1.0,
    )
    group.rotation.y = heading
    group.rotation.x = -0.2 + 0.32 * brake
    group.rotation.z = -bank

    let touchdown: Touchdown | null = null
    if (player.y <= floor.y) {
      touchdown = { kind: floor.land ? 'land' : 'sea', sink }
      // A hard arrival dips the eyes and the controller springs them back up
      const dip = floor.land ? clamp((sink - 2) * 0.1, 0, 0.5) : 0
      player.y = floor.y - dip
      player.vy = floor.land ? 0 : -1.5
      player.mode = floor.land ? 'walk' : 'swim'
      player.speed = floor.land ? Math.min(fwd * 0.45, 5) : 0
      player.fallFrom = null
      player.roll = 0
      phase = 'down'
      downFor = 0
      downKind = touchdown.kind
      downAt.set(player.x, floor.land ? floor.ground : floor.surface, player.z)
    }

    const frame: PlayerFrame = {
      underwater: false,
      surfaceY: floor.surface,
      depth: 0,
      submersion: 0,
      effort: 0,
      moving: 0,
      stroke: 0,
      // Zero, not the airspeed: the swimmer's body reads speed as legs moving
      speed: 0,
      surfaceVel: 0,
      walking: true,
      groundY: Number.NEGATIVE_INFINITY,
      fallLanded: 0,
    }
    return { frame, touchdown }
  }

  /** Per frame, whatever the phase: the canopy collapsing behind you after touchdown. */
  function animate(dt: number, light: number) {
    material.color.setScalar(clamp(0.22 + 0.9 * light, 0.2, 1.1))
    if (phase !== 'down') return
    downFor += dt
    const k = 1 - Math.exp(-downFor * 1.6)
    // It falls and folds behind where you stood
    group.position.set(
      downAt.x - fwdVec.x * 7 * k,
      THREE.MathUtils.lerp(downAt.y + CANOPY_LIFT, downAt.y + (downKind === 'sea' ? -0.1 : 0.25), k),
      downAt.z - fwdVec.y * 7 * k,
    )
    group.rotation.x = THREE.MathUtils.lerp(group.rotation.x, 0.15, k)
    group.rotation.z = THREE.MathUtils.lerp(group.rotation.z, 0, k)
    group.scale.set(1 + 0.12 * k, Math.max(0.1, 1 - 0.9 * k), 1 + 0.12 * k)
    if (downFor > 4.2) {
      group.visible = false
      phase = 'off'
    }
  }

  /** Throw the canopy away at once (skipping the drop, or a restart). */
  function cut() {
    phase = 'off'
    group.visible = false
  }

  return {
    begin,
    update,
    animate,
    cut,
    get active() {
      return phase === 'flying'
    },
    /** Metres of air between the feet and wherever they will land. */
    get height() {
      return height
    },
    /** 0..1 — how hard the wind is rushing past, for the sound. */
    get rush() {
      return phase === 'flying' ? clamp((fwd + sink * 0.6) / 17, 0, 1) : 0
    },
    get airspeed() {
      return fwd
    },
    get sinkRate() {
      return sink
    },
  }
}

export type Parachute = ReturnType<typeof createParachute>
