import './style.css'
import * as THREE from 'three'
import { createOceanAudio } from './audio'
import { createClimate } from './climate'
import { createTouchControls } from './controls'
import { createForage } from './forage'
import { createHud } from './hud'
import { createImprovise } from './improvise'
import { createInputState, isLowPowerDevice, preferTouchUI } from './input'
import { createInteractions } from './interact'
import { createIsland } from './island'
import { createOcean } from './ocean'
import { createOpMenu, type TeleportSpot } from './opmenu'
import { bindKeyboardMouse, createPlayer, updatePlayer } from './player'
import { createPostChain } from './post'
import { createSalvage } from './salvage'
import { createSeaState } from './sea'
import { createShark } from './shark'
import { createShoreSurf } from './shore'
import { createSky } from './sky'
import { createSplashLayer } from './splash'
import { createSwimmer } from './swimmer'
import {
  createVitals,
  debugSetVitals,
  resetVitals,
  swimLimits,
  updateVitals,
} from './survival'
import { burdenOf, burdenSpeedScale, heaviestKind, swimAidOf } from './logistics'
import { createUnderwaterWorld } from './underwater'
import { applyStormToWaves, oceanState, sampleOcean, setShelter, shelterAt } from './waves'
import { createWreck } from './wreck'
import { createWreckLoot } from './wreckloot'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('#app missing')

const mobile = preferTouchUI()
const lowPower = isLowPowerDevice()

const depthReadout = document.createElement('div')
depthReadout.id = 'depth'
app.appendChild(depthReadout)

const crosshair = document.createElement('div')
crosshair.id = 'crosshair'
app.appendChild(crosshair)

const underOverlay = document.createElement('div')
underOverlay.id = 'under-overlay'
app.appendChild(underOverlay)

const bubblesLayer = document.createElement('div')
bubblesLayer.id = 'bubbles'
app.appendChild(bubblesLayer)

const splash = createSplashLayer(app)

const scene = new THREE.Scene()
const airFog = new THREE.FogExp2(0x8fb3c9, 0.0045)
const underFog = new THREE.FogExp2(0x0c5c6b, 0.03)
scene.fog = airFog

const camera = new THREE.PerspectiveCamera(66, window.innerWidth / window.innerHeight, 0.05, 9000)
camera.rotation.order = 'YXZ'
// The swimmer body is parented to the camera, so the camera has to be in the scene
scene.add(camera)

const pixelRatioCap = lowPower ? 1.25 : 1.75
const renderer = new THREE.WebGLRenderer({
  antialias: !lowPower,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap))
renderer.setSize(window.innerWidth, window.innerHeight)
// Sun shadows are what stop the island reading as a painted hill: they give
// the canopy depth, sit the trunks on the sand, and turn a low sun into long
// rake across the beach. Phones get a smaller map over a tighter box rather
// than nothing — grass and terrain are excluded from casting there instead.
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
app.appendChild(renderer.domElement)

const post = createPostChain(renderer, { lowPower })
post.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio())

const skyRig = createSky(scene, 30, 38, {
  shadows: true,
  shadowSize: lowPower ? 1024 : 2048,
  shadowExtent: lowPower ? 52 : 80,
})
scene.background = skyRig.horizonColor.clone()

const { mesh: ocean, material: oceanMat, follow, syncWaves } = createOcean({
  size: lowPower ? 420 : 700,
  segments: lowPower ? 150 : 300,
  detailOctaves: lowPower ? 2 : 4,
})
oceanMat.uniforms.uHorizonColor.value.copy(skyRig.horizonColor)
scene.add(ocean)

const swimmer = createSwimmer(camera)

const underwaterWorld = createUnderwaterWorld(scene, {
  waterColor: new THREE.Color('#0c5c6b'),
  sunDir: skyRig.sunDir,
  lowPower,
})

// Placed dead ahead of the spawn heading, far enough out that the mast is a
// smudge on the horizon before it resolves into a ship
const wreck = createWreck(scene, { x: -38, z: -104, lowPower })

// Land, off the spawn heading's right shoulder and the better part of a
// kilometre out — far enough that it's haze and a shape. Nothing points at it:
// you either notice it on the horizon or you don't.
const island = createIsland(scene, {
  x: 980,
  z: -680,
  lowPower,
  hazeColor: skyRig.horizonColor,
})

// The island shelters its waterline: fully calm over the beach ring, the
// whole swell back a few hundred metres offshore. CPU and GPU both read it.
setShelter(island.centre.x, island.centre.z, 430, 800)
;(oceanMat.uniforms.uShelter.value as THREE.Vector4).set(
  island.centre.x,
  island.centre.z,
  430,
  800,
)
// Shallows: ankle-deep over the inner beach (~240 m), opaque blue again past ~400 m
;(oceanMat.uniforms.uShelf.value as THREE.Vector4).set(
  island.centre.x,
  island.centre.z,
  240,
  400,
)

const shore = createShoreSurf(scene, {
  centre: island.centre,
  heightAt: island.heightAt,
  lowPower,
})

const collide = (p: { x: number; y: number; z: number }) => {
  wreck.resolve(p)
  island.resolve(p)
}

// Terrain you can plant on — island shelf and reef spire. Raft decks layer on
// top via improvise.standAt once that system is wired below.
const terrainAt = (x: number, z: number) => Math.max(island.heightAt(x, z), wreck.standAt(x, z))
let raftAt = (_x: number, _z: number) => -1000
const groundAt = (x: number, z: number) => Math.max(terrainAt(x, z), raftAt(x, z))
/** True while the ground under you is the spire rather than the island. */
const onPerchAt = (x: number, z: number) => wreck.standAt(x, z) > island.heightAt(x, z)

const oceanAudio = createOceanAudio()
let heave = 0
let prevSurfaceForAudio = Number.NaN

// ?depth=6&pitch=-0.2 spawns submerged, ?x=&z=&yaw= spawns somewhere specific —
// both handy when tuning the underwater look, the wreck, or the island.
// ?hour=18 starts at dusk, ?storm=1 locks a full squall, ?calm=1 a glass-off.
const params = new URLSearchParams(location.search)
const num = (key: string, fallback: number) =>
  params.has(key) ? Number(params.get(key)) : fallback

const climate = createClimate({
  hour: num('hour', 9.5),
  storm: params.has('storm') ? Number(params.get('storm')) : undefined,
})

// The sea's slow breathing — seasons, glass-offs, and the set that carries you.
// Whispers attach after the HUD exists (see glassWhisper below).
let glassWhisper: ((text: string) => void) | null = null
const sea = createSeaState({
  onGlassOff: () => glassWhisper?.('The sea lies flat. Dive while it holds.'),
  onSwellUp: () => glassWhisper?.('The swell stands back up.'),
})
if (params.has('calm')) sea.pinCalm()

// Capture the sky (and clouds) into a cube map so the water reflects the real sky
const envRT = new THREE.WebGLCubeRenderTarget(lowPower ? 128 : 256)
envRT.texture.minFilter = THREE.LinearMipmapLinearFilter
envRT.texture.generateMipmaps = true
const envCam = new THREE.CubeCamera(1, 8000, envRT)
oceanMat.uniforms.uEnvMap.value = envRT.texture

// The same capture doubles as image-based light for every standard material in
// the scene. A hemisphere light can only say "sky above, ground below"; this
// carries the actual sun, the actual cloud deck, and the green bounce off the
// island, which is the difference between foliage that shades and foliage that
// silhouettes. three PMREM-filters it for us on `needsPMREMUpdate`.
scene.environment = envRT.texture
scene.environmentIntensity = 0.42

function captureEnv() {
  ocean.visible = false
  swimmer.rig.visible = false
  // Feeding the cube map back into the shading of the objects being captured
  // would compound its own brightness every refresh
  const wasEnv = scene.environmentIntensity
  scene.environmentIntensity = 0
  // Six faces would otherwise re-render the shadow map six times for a probe
  // that never shows a shadow edge at cube-map resolution. The first capture
  // happens before any frame has drawn, though, and skipping it there would
  // leave every lit material sampling a shadow map that doesn't exist yet.
  renderer.shadowMap.autoUpdate = false
  if (!skyRig.sunLight.shadow.map) renderer.shadowMap.needsUpdate = true
  envCam.position.set(camera.position.x, Math.max(camera.position.y, 2), camera.position.z)
  envCam.update(renderer, scene)
  renderer.shadowMap.autoUpdate = true
  scene.environmentIntensity = wasEnv
  envRT.texture.needsPMREMUpdate = true
  ocean.visible = true
  swimmer.rig.visible = true
}

const player = createPlayer()

function spawn() {
  Object.assign(player, createPlayer())
  player.x = num('x', player.x)
  player.z = num('z', player.z)
  player.yaw = num('yaw', player.yaw)
  const depth = num('depth', 0)
  player.y = sampleOcean(player.x, player.z, 0).y + (depth > 0 ? -depth : 1.5)
  if (depth > 0) player.pitch = 0.5
  player.pitch = num('pitch', player.pitch)
}
spawn()

const vitals = createVitals()
// ?breath / ?food / ?water / ?warmth / ?wound pre-set the body, for tuning
debugSetVitals(vitals, {
  breath: params.has('breath') ? Number(params.get('breath')) : undefined,
  food: params.has('food') ? Number(params.get('food')) : undefined,
  water: params.has('water') ? Number(params.get('water')) : undefined,
  warmth: params.has('warmth') ? Number(params.get('warmth')) : undefined,
  wound: params.has('wound') ? true : undefined,
})

const interactions = createInteractions()
const salvage = createSalvage(scene, {
  interactions,
  vitals,
  lowPower,
  wreckFlotsam: wreck.flotsam,
  wreckOrigin: wreck.group.position,
  reefResolve: wreck.resolve,
  hatch: wreck.hatch,
  shore: island.shore,
  pools: island.pools,
  cairn: island.cairn,
  whisper: (text) => hud.whisper(text),
})

const input = createInputState()
const touch = createTouchControls(app)
touch.setVisible(true)

const hud = createHud(app, { touch: mobile, onRestart: restart })
glassWhisper = hud.whisper
let dead = false
let deathT = 0
let hasDived = false

// First time out of the water, whichever way you managed it. The line is the
// only reward — no counter, no achievement, just the body noticing.
let saidPerch = false
let saidShore = false
let saidBurden = false
let saidAid = false

function landfall(onPerch: boolean) {
  if (onPerch) {
    if (saidPerch) return
    saidPerch = true
    hud.whisper('Rock under you, and the sea below it. Your heat comes back slowly.')
    return
  }
  if (saidShore) return
  saidShore = true
  hud.whisper('Sand. You are out of the ocean, and it cannot reach you here.')
}

// —— the shark, and the wreck's answer to it ————————————————————————
// The fin is a rare event until you've dived the wreck; the mate's spear,
// once found, makes a run a question you can answer.
let loot: ReturnType<typeof createWreckLoot>
const shark = createShark(scene, {
  resolve: wreck.resolve,
  whisper: hud.whisper,
  // ?shark=8 summons the first pass in eight seconds, for tuning
  summonIn: params.has('shark') ? Number(params.get('shark')) : undefined,
  // ?commit=1 makes every armed pass run at you — combat tuning
  alwaysCommit: params.has('commit'),
  onCommit: () => {
    hud.whisper('It comes.')
  },
  onBite: () => loot.onBite(),
})

loot = createWreckLoot(app, camera, hud, vitals, {
  interactions,
  knifeSpot: wreck.knifeSpot,
  takeKnife: wreck.takeKnife,
  lockerSpot: wreck.lockerSpot,
  lockerState: () => wreck.lockerState,
  cutLashing: wreck.cutLashing,
  stripLocker: wreck.stripLocker,
  gearSpot: wreck.gearSpot,
  gearState: () => wreck.gearLockerState,
  pryGear: wreck.pryGear,
  takeSuit: wreck.takeSuit,
  tinSpot: wreck.tinSpot,
  takeTin: wreck.takeTin,
  logSpot: wreck.logSpot,
  takeLog: wreck.takeLog,
  onSuit: () => swimmer.setSurvivalSuit(true),
  shark,
  thump: (i) => oceanAudio.impact(i),
})
// ?knife=1 skips the deck dive, ?spear=1 starts armed, ?suit=1 already dressed
if (params.has('knife')) loot.grant('knife')
if (params.has('spear')) loot.grant('spear')
if (params.has('suit')) loot.grant('suit')

const forage = createForage(hud, vitals, {
  interactions,
  provisionSpot: wreck.provisionSpot,
  takeProvision: wreck.takeProvision,
  fish: underwaterWorld.fish,
  crabs: island.crabs,
})

const improvise = createImprovise(scene, camera, {
  interactions,
  salvage,
  vitals,
  hud,
  groundAt: terrainAt,
  rawFish: () => forage.rawFish,
  eatRawFish: () => forage.eatRaw(),
  cookFish: () => forage.cook(),
  takeRawForSmoke: () => forage.takeRawForSmoke(),
  addSmoked: (n) => forage.addSmoked(n),
  daylight: () => climate.state.daylight,
  skipTime: (seconds) => climate.skip(seconds),
  secondsUntilDawn: () => climate.secondsUntilDawn(),
  hasMark: () => loot.hasSpear,
  storm: () => climate.state.storm,
  current: () => sea.current,
})
raftAt = improvise.standAt

function restart() {
  spawn()
  resetVitals(vitals)
  salvage.reset(new THREE.Vector3(player.x, player.y, player.z))
  wreck.reset()
  loot.reset()
  forage.reset()
  improvise.reset()
  swimmer.setSurvivalSuit(false)
  hud.clearDead()
  hud.setPrompt(null)
  touch.setAction(null)
  dead = false
  deathT = 0
  hasDived = false
  saidPerch = false
  saidShore = false
  saidBurden = false
  saidAid = false
}

// —— the operating menu: pack + dev field kit ————————————————————————
function teleport(spot: TeleportSpot) {
  player.x = spot.x
  player.z = spot.z
  if (spot.y !== undefined) {
    player.y = spot.y
  } else {
    const ground = island.heightAt(spot.x, spot.z)
    player.y =
      ground > 0.3 ? ground + 1.7 : sampleOcean(spot.x, spot.z, 0).y + 1.5
  }
  if (spot.yaw !== undefined) player.yaw = spot.yaw
  player.pitch = -0.05
  player.vy = 0
  player.speed = 0
  collide(player)
}

const beach = island.shore.length > 0 ? island.shore[0] : island.centre
const opMenu = createOpMenu(app, {
  salvage,
  loot,
  vitals,
  rawFish: () => forage.rawFish,
  smokedFish: () => forage.smokedFish,
  eatFish: () => {
    if (!forage.eatRaw()) return false
    hud.whisper('Raw fish. It stays down.')
    return true
  },
  eatSmoked: () => {
    if (!forage.eatSmoked()) return false
    hud.whisper('Smoked fish. It travels well.')
    return true
  },
  grantFish: (n) => forage.grant(n),
  teleport,
  spots: {
    island: { x: beach.x, z: beach.z, y: beach.y + 1.7 },
    wreck: { x: wreck.group.position.x + 5, z: wreck.group.position.z + 5 },
  },
  resetRun: restart,
})

const desktop = bindKeyboardMouse(renderer.domElement, player, {
  enablePointerLock: !mobile,
  onLockChange: (locked) => {
    document.body.classList.toggle('playing', locked)
  },
})

if (mobile) document.body.classList.add('playing')

// Dev-only handle, for poking at state from the console or a headless run
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>
  // Loot world spots, for the headless shot suite and tuning sessions
  const spots: Record<string, unknown> = { locker: wreck.lockerSpot().toArray() }
  const knife = wreck.knifeSpot()
  if (knife) spots.knife = knife.toArray()

  Object.assign(w, {
    ww: {
      player,
      camera,
      vitals,
      interactions,
      salvage,
      island,
      wreck,
      climate,
      sea,
      shore,
      shark,
      loot,
      forage,
      improvise,
      opMenu,
    },
    __shark: shark,
    __spots: spots,
    // Aim the swimmer's eye at the shark — headless combat tests and tuning
    __faceShark: () => {
      if (!shark.active) return false
      const p = shark.position
      const dx = p.x - camera.position.x
      const dy = p.y - camera.position.y
      const dz = p.z - camera.position.z
      player.yaw = Math.atan2(-dx, -dz)
      player.pitch = Math.atan2(dy, Math.hypot(dx, dz))
      return true
    },
  })
}

const timer = new THREE.Timer()
timer.connect(document)
let bubbleTimer = 0
let envTimer = 0

function spawnBubble() {
  const b = document.createElement('span')
  b.className = 'bubble'
  b.style.left = `${20 + Math.random() * 60}%`
  b.style.bottom = `${8 + Math.random() * 20}%`
  b.style.setProperty('--s', `${0.35 + Math.random() * 0.9}`)
  b.style.setProperty('--d', `${1.8 + Math.random() * 2.2}s`)
  bubblesLayer.appendChild(b)
  window.setTimeout(() => b.remove(), 4200)
}

/**
 * Portrait phones are extremely narrow — a fixed vertical FOV crops the view to
 * a letterbox slit. Widen vertically until the horizontal FOV stays playable.
 */
function applyView() {
  const aspect = window.innerWidth / window.innerHeight
  camera.aspect = aspect
  const needed = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(74) / 2) / aspect)
  camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(needed), 66, 96)
  camera.updateProjectionMatrix()
}

function onResize() {
  applyView()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap))
  renderer.setSize(window.innerWidth, window.innerHeight)
  post.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio())
}
window.addEventListener('resize', onResize)
applyView()

app.addEventListener(
  'touchmove',
  (e) => {
    if ((e.target as HTMLElement).closest('#touch-controls')) e.preventDefault()
  },
  { passive: false },
)

/**
 * Opt geometry into the shadow pass.
 *
 * Only lit materials qualify: the sky dome, the cloud shell, the ocean and the
 * particle layers are all hand-written shaders that would either cast a
 * planet-sized shadow or cost a depth pass for nothing. The swimmer's own body
 * is parented to the camera and opts out by hand — a first-person torso throws
 * a shadow that reads as a second person standing behind you.
 *
 * New geometry appears as you build, so this re-runs on a slow tick rather
 * than only at startup.
 */
function markShadowCasters(root: THREE.Object3D) {
  root.traverse((obj) => {
    if (obj.userData.noShadow) return
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || obj.userData.shadowChecked) return
    obj.userData.shadowChecked = true
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const lit = (mat as THREE.MeshStandardMaterial | undefined)?.isMeshStandardMaterial
    if (!lit) return
    mesh.receiveShadow = true
    mesh.castShadow = !obj.userData.noCast
  })
}
swimmer.rig.userData.noShadow = true
// Grass and the terrain shell are the two heaviest things on the island. They
// still take shadow; on a phone they stop giving it, which halves the depth
// pass for detail you can't resolve at 1024 anyway.
if (lowPower) {
  for (const obj of island.group.children) {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && (mesh.geometry.attributes.position?.count ?? 0) > 40000) {
      obj.userData.noCast = true
    }
  }
}
markShadowCasters(scene)
let shadowScanTimer = 0

const keyLight = new THREE.Color()
const shallowTint = new THREE.Color('#0a4f5e')
const deepTint = new THREE.Color('#031f2d')
const nightWater = new THREE.Color('#020c14')
const waterTint = new THREE.Color()
const underHemiSky = new THREE.Color('#6fc6d8')
const underHemiNight = new THREE.Color('#1a3a48')

function frame() {
  timer.update()
  const dt = Math.min(timer.getDelta(), 0.05)
  const t = timer.getElapsed()

  const weather = climate.update(dt)
  applyStormToWaves(weather.storm)
  syncWaves()
  // The sea breathes under the squalls — glass-offs oil the chop down, and
  // they only come while the sky is settled. Storm raises the set.
  sea.setFair(weather.fair)
  sea.setStorm(weather.storm)
  sea.update(dt, t)
  oceanAudio.setSeaWeight(sea.weight)

  input.interact = false
  touch.apply(input)
  desktop.mergeKeys(input)
  // Any keyboard use unlocks the audio context (WASD before click)
  if (
    input.moveForward ||
    input.moveStrafe ||
    input.lookDeltaX ||
    input.lookDeltaY ||
    input.rise ||
    input.dive
  ) {
    void oceanAudio.unlock()
  }

  // Logistics: what you carry slows the stroke; a plank/barrel buys float
  const burden = burdenOf(salvage.stash)
  const burdenScale = burdenSpeedScale(burden)
  const aid = swimAidOf(salvage.stash)
  if (vitals.alive && player.mode === 'swim') {
    if (aid > 0 && !saidAid) {
      saidAid = true
      hud.whisper(
        salvage.stash.barrel > 0
          ? 'The barrel buoys you. Heavy, but it rides.'
          : 'A plank under the arm. The surface comes easier.',
      )
    }
    if (burdenScale < 0.82 && !saidBurden) {
      saidBurden = true
      hud.whisper('The stash pulls you down. Drop it, stow it, or build.')
    }
  }

  // Glass-off is the dive window — every stroke costs less while it holds
  const diveEase = sea.glassy ? 1 : Math.max(0, (0.68 - oceanState.amp) / 0.2)
  const swimTax = weather.swimCost * (sea.glassy ? 0.72 : 1 - diveEase * 0.15)

  if (!vitals.alive) {
    // Dead men don't swim — the swell still has the body, though
    input.moveForward = 0
    input.moveStrafe = 0
    input.rise = false
    input.dive = false
    input.interact = false
  } else {
    // A squall taxes every stroke; exhaustion is handled inside the swim model
    input.moveForward /= swimTax
    input.moveStrafe /= swimTax
  }

  // Last frame's tanks drive this frame's body — one frame of lag on a
  // minutes-long decline is nothing. Burden and swim aid fold in here.
  const limits = swimLimits(vitals, { burdenScale, swimAid: aid })
  // Current, softened in the island's lee so the beach isn't a treadmill
  const lee = 1 - shelterAt(player.x, player.z) * 0.9
  const drift = {
    x: sea.current.x * lee,
    z: sea.current.z * lee,
  }
  const view = updatePlayer(player, camera, input, dt, t, collide, groundAt, limits, drift)
  const { underwater, surfaceY, depth } = view
  if (depth > 1) hasDived = true

  // Ashore and on dry ground — wading the shallows still counts as in the sea
  const onLand = view.walking && view.groundY > 0.3
  const onPerch = onLand && onPerchAt(player.x, player.z)
  // A wave-washed spire gives back far less heat than dry sand up the beach,
  // and the beach itself is better the further you are from the wash. Lean-tos
  // and fires layer on top wherever you've planted them.
  const terrainShelter = onPerch ? 0.42 : Math.min(1, 0.55 + view.groundY * 0.12)
  const shelter = onLand
    ? improvise.shelterAt(player.x, player.z, terrainShelter)
    : terrainShelter
  // A raft deck counts as out of the water — chill perch, but dry feet
  const onRaft = !onLand && improvise.standAt(player.x, player.z) > -100
  const dry = onLand || onRaft
  const raftShelter = onRaft ? improvise.shelterAt(player.x, player.z, 0.5) : shelter
  if (onLand) landfall(onPerch)
  updateVitals(vitals, dt, {
    submerged: view.submersion > 0.85,
    depth,
    effort: view.effort,
    onLand: dry,
    shelter: onRaft ? raftShelter : shelter,
    cold: weather.cold,
    swimCost: swimTax,
    diveEase: sea.glassy ? 1 : diveEase,
    whisper: hud.whisper,
  })
  // Heartbeat and stomach, off the same tanks the HUD reads
  oceanAudio.setVitals({
    breath: vitals.breath < 0.35 ? (0.35 - vitals.breath) / 0.35 : 0,
    hunger: 1 - vitals.food,
  })

  if (!vitals.alive && !dead) {
    dead = true
    opMenu.setOpen(false)
    hud.setDead(vitals.cause, vitals.elapsed)
    if (document.pointerLockElement) document.exitPointerLock()
  }
  if (dead) {
    deathT += dt
    oceanAudio.dim(Math.min(1, deathT / 3.2))
  }

  if (Number.isNaN(prevSurfaceForAudio)) prevSurfaceForAudio = surfaceY
  heave = THREE.MathUtils.damp(heave, surfaceY - prevSurfaceForAudio, 6, dt)
  prevSurfaceForAudio = surfaceY
  oceanAudio.update(dt, view.submersion, depth, heave, weather.storm)
  // Pointer-lock / first click also unlocks audio in case the global listeners missed it
  if (document.pointerLockElement) void oceanAudio.unlock()

  swimmer.update(dt, t, view, player.pitch + player.viewPitch, player.roll)

  skyRig.update(t, weather)
  skyRig.sky.position.set(camera.position.x, 0, camera.position.z)
  skyRig.clouds.position.set(camera.position.x, 0, camera.position.z)
  skyRig.stars.position.set(camera.position.x, 0, camera.position.z)
  skyRig.milky.position.set(camera.position.x, 0, camera.position.z)
  // Moon rides with the camera origin; its local offset is set in createSky
  skyRig.moon.position.set(
    camera.position.x + skyRig.moon.userData.ox,
    skyRig.moon.userData.oy,
    camera.position.z + skyRig.moon.userData.oz,
  )
  // A heavy sea carries more cloud; a glass-off opens the sky up — on top of
  // whatever the squall clock is already doing
  const cover = skyRig.clouds.material as THREE.ShaderMaterial
  cover.uniforms.uCover.value = THREE.MathUtils.clamp(
    cover.uniforms.uCover.value + (0.5 - sea.weight) * 0.14,
    0.1,
    0.7,
  )
  follow(camera.position.x, camera.position.z)
  island.setHaze(skyRig.horizonColor)
  // A dead calm looks like a screenshot, so the trade wind never quite stops;
  // a squall roughly triples it.
  // The leaf backlight has to fade with the sun, and `sunLight.color` is only
  // a hue — the strength lives in its intensity
  keyLight.copy(skyRig.sunLight.color).multiplyScalar(Math.min(1, skyRig.sunLight.intensity * 0.55))
  island.setWeather(
    t,
    0.45 + sea.weight * 0.35 + weather.storm * 1.5,
    // Cloud shade needs a sun to block. Under a squall the deck is unbroken,
    // so there are no bands left to cast — everything is in shade already.
    weather.daylight * (0.55 - weather.storm * 0.45),
    skyRig.sunDir,
    keyLight,
  )

  oceanMat.uniforms.uTime.value = t
  oceanMat.uniforms.uAmp.value = oceanState.amp
  oceanMat.uniforms.uCameraPos.value.copy(camera.position)
  oceanMat.uniforms.uSunDir.value.copy(skyRig.sunDir)
  oceanMat.uniforms.uHorizonColor.value.copy(skyRig.horizonColor)
  oceanMat.uniforms.uUnderwater.value = underwater ? 1 : 0
  oceanMat.uniforms.uSunColor.value.setRGB(1, 0.95, 0.85).lerp(new THREE.Color('#6a7a9a'), 1 - weather.daylight)

  // The deeper you go, the tighter and darker the water closes in.
  // Glass-offs clear the murk a touch — the dive window you can see as well as feel.
  const murk = Math.min(1, depth / 24) * (sea.glassy ? 0.7 : 1)
  underFog.density = 0.026 + murk * 0.032 + (1 - weather.daylight) * 0.012
  waterTint.copy(shallowTint).lerp(deepTint, murk)
  waterTint.lerp(nightWater, (1 - weather.daylight) * 0.55)
  // Fog has to track the tint or distant geometry fades to the wrong colour and
  // reads as a flat cutout against the water instead of dissolving into it
  underFog.color.copy(waterTint)

  airFog.color.copy(skyRig.horizonColor)
  airFog.density = 0.0045 + weather.storm * 0.0035 + (1 - weather.daylight) * 0.002

  scene.fog = underwater ? underFog : airFog
  scene.background = underwater ? waterTint : skyRig.horizonColor
  // Exposure lives in the post chain now: nothing inside the scene tone-maps
  // any more, so the renderer's own setting would never be read.
  post.grade.exposure = underwater
    ? 1.16 - murk * 0.26 - (1 - weather.daylight) * 0.16
    : 0.82 + weather.daylight * 0.36 - weather.storm * 0.14

  // The grade is where the day gets its mood. Above water it runs a warm-
  // highlight / cool-shadow split that widens at dusk; below it goes cold and
  // desaturated and the glow drops away, because water eats contrast long
  // before it eats colour.
  const dusk = THREE.MathUtils.clamp(1 - Math.abs(weather.daylight - 0.42) / 0.3, 0, 1)
  if (underwater) {
    post.grade.bloom = 0.24 + weather.biolum * 0.3
    post.grade.lift.setRGB(0.03, 0.13, 0.16)
    post.grade.gain.setRGB(0.78, 0.95, 1)
    post.grade.contrast = 0.09
    // Water is already a colour cast; pulling saturation on top of it turns
    // the whole dive muddy rather than deep
    post.grade.saturation = 1.06 - murk * 0.1
    post.grade.vignette = 0.24 + murk * 0.14
    scene.environmentIntensity = 0.06
  } else {
    post.grade.bloom = 0.34 + weather.daylight * 0.3 + dusk * 0.22 - weather.storm * 0.18
    post.grade.lift
      .setRGB(0.05, 0.1, 0.18)
      .lerp(new THREE.Color(0.16, 0.09, 0.05), dusk * 0.7)
    post.grade.gain
      .setRGB(1, 0.97, 0.9)
      .lerp(new THREE.Color(1, 0.86, 0.7), dusk)
      .lerp(new THREE.Color(0.86, 0.9, 0.95), weather.storm * 0.8)
    post.grade.contrast = 0.16 + weather.storm * 0.05
    post.grade.saturation = 1.12 + dusk * 0.1 - weather.storm * 0.2
    post.grade.vignette = 0.26 + weather.storm * 0.12 + (1 - weather.daylight) * 0.08
    // The probe is a picture of the sky, so it has to go out with the sky. Left
    // at full strength after dark it lights the hillside with green bounce off
    // itself and puts a glow on the ground with nothing casting it.
    scene.environmentIntensity = (0.12 + weather.daylight * 0.34) * (1 - weather.storm * 0.25)
  }
  skyRig.sky.visible = !underwater
  skyRig.clouds.visible = !underwater
  skyRig.stars.visible = !underwater && skyRig.stars.visible
  skyRig.milky.visible = !underwater && skyRig.milky.visible
  skyRig.moon.visible = !underwater && skyRig.moon.visible
  if (underwater) {
    // Backscatter off the water is the only fill down here. Without a lit lower
    // hemisphere every underside — reef flank, hull, kelp — goes flat black.
    skyRig.hemi.color.copy(underHemiSky).lerp(underHemiNight, 1 - weather.daylight)
    skyRig.hemi.groundColor.copy(waterTint).multiplyScalar(2.4)
    skyRig.hemi.intensity = (1.35 - murk * 0.45) * (0.45 + weather.daylight * 0.55)
    skyRig.sunLight.intensity *= 0.45 + weather.daylight * 0.25
  } else {
    skyRig.hemi.color.copy(skyRig.dayHemiSky)
    skyRig.hemi.groundColor.copy(skyRig.dayHemiGround)
  }

  document.body.classList.toggle('underwater', underwater)
  underOverlay.style.opacity = String(view.submersion)
  depthReadout.textContent = underwater ? `${depth.toFixed(1)} m` : ''
  depthReadout.style.opacity = underwater ? '1' : '0'

  underwaterWorld.update({
    dt,
    time: t,
    camera,
    surfaceY,
    submersion: view.submersion,
    underwater,
    pixelRatio: renderer.getPixelRatio(),
    biolum: weather.biolum,
    effort: view.effort,
  })

  wreck.update(t, camera)
  island.update(camera, underwater, t)
  shore.update(t, camera, underwater)
  salvage.update(t, camera.position, weather.storm)
  loot.update(dt, view)
  forage.update(camera, view)
  improvise.update(dt, t, player, view, player.yaw)
  shark.update(dt, t, camera, hasDived)
  oceanAudio.setDanger(shark.proximity)

  const reachable = vitals.alive ? interactions.find(camera) : null
  // Drop only when nothing else is in reach — the stash is a last resort,
  // not a verb that steals Take / Climb / Lash.
  const dropKind =
    !reachable &&
    vitals.alive &&
    player.mode === 'swim' &&
    view.submersion < 0.92 &&
    burden > 0.8
      ? heaviestKind(salvage.stash)
      : null
  if (reachable && input.interact) reachable.use()
  else if (dropKind && input.interact) {
    const at = new THREE.Vector3(player.x, player.y, player.z)
    const kind = salvage.jettison(at)
    if (kind) {
      hud.whisper(
        kind === 'crate'
          ? 'The crate goes. Arms lighten.'
          : kind === 'barrel'
            ? 'Barrel away. You swim freer.'
            : `You let the ${salvage.labels[kind].one.toLowerCase()} go.`,
      )
    }
  }
  const prompt = reachable
    ? { verb: reachable.verb, label: reachable.label }
    : dropKind
      ? { verb: 'Drop', label: salvage.labels[dropKind].one }
      : null
  hud.setPrompt(prompt)
  // Mobile action button carries the same words as the centre prompt — verb
  // alone ("Lash") is ambiguous once lean-to and raft share a verb.
  touch.setAction(prompt ? `${prompt.verb} ${prompt.label}` : null)
  hud.setStash(salvage.stash, salvage.labels, {
    rawFish: forage.rawFish,
    smokedFish: forage.smokedFish,
  })
  hud.update(vitals, view.submersion > 0.85, dt)

  splash.update(dt, camera.position.y, surfaceY, view.moving, view.submersion)

  if (underwater) {
    bubbleTimer -= dt
    if (bubbleTimer <= 0) {
      spawnBubble()
      bubbleTimer = 0.7 + Math.random() * 1.1
    }
  } else {
    bubblesLayer.replaceChildren()
  }

  // Refresh reflections as the sky and clouds move — storms need it more often
  envTimer -= dt
  if (envTimer <= 0 && !underwater) {
    captureEnv()
    envTimer = lowPower ? 10 : weather.storm > 0.2 || weather.daylight < 0.35 ? 2 : 4
  }

  shadowScanTimer -= dt
  if (shadowScanTimer <= 0) {
    markShadowCasters(scene)
    shadowScanTimer = 1.5
  }
  skyRig.focusShadow(camera.position.x, Math.max(view.groundY, 0), camera.position.z)

  post.render(scene, camera)
  requestAnimationFrame(frame)
}

{
  const weather = climate.update(0)
  applyStormToWaves(weather.storm)
  syncWaves()
  sea.update(0, 0)
  skyRig.update(0, weather)
  skyRig.focusShadow(player.x, 0, player.z)
  island.setHaze(skyRig.horizonColor)
  scene.background.copy(skyRig.horizonColor)
  airFog.color.copy(skyRig.horizonColor)
}
captureEnv()
frame()
