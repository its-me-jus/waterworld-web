import './style.css'
import * as THREE from 'three'
import { createOceanAudio, type AudioGround } from './audio'
import { createArrival } from './arrival'
import { createCaustics } from './caustics'
import { createClimate, DAY_LENGTH } from './climate'
import { createCreatures } from './creatures'
import { createIslandLife } from './islandlife'
import { createPelagicLife } from './pelagic'
import { createTouchControls } from './controls'
import { createHud } from './hud'
import { createInputState, isLowPowerDevice, preferTouchUI } from './input'
import { createIsland } from './island'
import { createLittoral } from './littoral'
import { createLagoonLife } from './lagoon'
import { createOcean } from './ocean'
import { createParachute } from './parachute'
import { bindKeyboardMouse, createPlayer, updatePlayer, type PlayerFrame } from './player'
import { createPostChain } from './post'
import { createReefWreck } from './reefwreck'
import { createSeaState } from './sea'
import { createShoreSurf } from './shore'
import { createSky } from './sky'
import { createSparBuoy } from './spar'
import { createSplashLayer } from './splash'
import { createSwimmer } from './swimmer'
import { createUnderwaterWorld } from './underwater'
import { createLowClouds } from './lowclouds'
import { applyStormToWaves, oceanState, sampleOcean, setShelter, shelterAt } from './waves'
import { createWreck } from './wreck'
import { createWorldControls, type Destination } from './world-controls'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('#app missing')

let mobile = preferTouchUI()
const lowPower = isLowPowerDevice()
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
let reducedMotion = motionPreference.matches
motionPreference.addEventListener('change', (e) => { reducedMotion = e.matches })

const depthReadout = document.createElement('div')
depthReadout.id = 'depth'
app.appendChild(depthReadout)
let showDepth = false

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
const sunForward = new THREE.Vector3()
const sunNdc = new THREE.Vector3()
post.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio())

const skyRig = createSky(scene, 30, 38, {
  shadows: true,
  shadowSize: lowPower ? 1024 : 2048,
  shadowExtent: lowPower ? 52 : 80,
})
scene.background = skyRig.horizonColor.clone()

const OCEAN_SIZE = lowPower ? 900 : 1400
const OCEAN_SEGMENTS = lowPower ? 150 : 300
const { mesh: ocean, material: oceanMat, follow, syncWaves } = createOcean({
  // Big enough that fog + radial rim fade eat the edge before a square shows
  size: OCEAN_SIZE,
  segments: OCEAN_SEGMENTS,
  detailOctaves: lowPower ? 2 : 4,
})
/** The sea mesh grows in whole steps with height (see frame): from a parachute it has to reach the horizon. */
let seaScale = 1
oceanMat.uniforms.uHorizonColor.value.copy(skyRig.horizonColor)
scene.add(ocean)

const swimmer = createSwimmer(camera)

const underwaterWorld = createUnderwaterWorld(scene, {
  waterColor: new THREE.Color('#0c5c6b'),
  sunDir: skyRig.sunDir,
  lowPower,
  // Circling the Wanderer's reef (the wreck sits at -38, -104)
  reefSchool: { x: -46, y: -12, z: -110, r: 15 },
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

// The second wreck: a coaster stranded on the barrier reef beside the landing pass
const reefWreck = createReefWreck(scene, { heightAt: island.heightAt, lowPower })

// Spar buoy ~a third of the way to the island — a mast in the haze so the
// crossing isn't wreck-or-island and nothing between.
const spar = createSparBuoy(scene, {
  x: -38 + (980 - -38) * 0.32,
  z: -104 + (-680 - -104) * 0.32,
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
// Shallows: ankle-deep over the inner beach (~180 m), opaque deep blue again
// by ~300 m — so the wreck→island abyss past the shelf doesn't read as a
// turquoise bathtub from above.
;(oceanMat.uniforms.uShelf.value as THREE.Vector4).set(
  island.centre.x,
  island.centre.z,
  180,
  300,
)

// Real water depth over the island's own terrain grid — the shallows colour,
// the soft waterline and the surf lines all read it
oceanMat.uniforms.uSeabed.value = island.seabed.texture
;(oceanMat.uniforms.uSeabedRect.value as THREE.Vector4).copy(island.seabed.rect)
;(oceanMat.uniforms.uSeabedRange.value as THREE.Vector2).copy(island.seabed.range)

const shore = createShoreSurf(scene, {
  centre: island.centre,
  heightAt: island.heightAt,
  lowPower,
})

const collide = (p: { x: number; y: number; z: number }) => {
  wreck.resolve(p)
  reefWreck.resolve(p)
  island.resolve(p)
}

// What you can stand on — the island shelf and the reef spire.
const groundAt = (x: number, z: number) => Math.max(island.heightAt(x, z), wreck.standAt(x, z))
swimmer.setGroundSampler(groundAt)
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
const flyLift = import.meta.env.DEV ? num('fly', 0) : 0

const climate = createClimate({
  hour: num('hour', 9.5),
  storm: params.has('storm') ? Number(params.get('storm')) : undefined,
})

// The sea's slow breathing — seasons, glass-offs, and the set that carries you.
// Whispers attach after the HUD exists (see glassWhisper below).
let glassWhisper: ((text: string) => void) | null = null
const sea = createSeaState({
  onGlassOff: () => glassWhisper?.('The sea lies flat and clear.'),
  onSwellUp: () => glassWhisper?.('The swell finds its shape again.'),
})
if (params.has('calm')) sea.pinCalm()

// ?film=1 is for shooting stills and fly-throughs of the real build (the
// homepage uses them): no labels, no hands, no drop, and a handle on
// window.__film to pin the time of day and put the camera anywhere from code.
//   __film.hour(17.6)                    set the clock and hold it there
//   __film.freeze(false)                 let the day run again
//   __film.camera(x, y, z, yaw, pitch)   hold the camera at a pose (y is height;
//                                        below the swell is underwater)
//   __film.release()                     hand the camera back to the swimmer
//   __film.hud(true)                     show the labels again
//   __film.frames                        frames drawn so far, to wait on
//   __film.ground(x, z)                  ground height there, for shots on land
// The sea, fish and weather keep moving while the camera is held.
const film = {
  on: params.has('film'),
  frozen: false,
  pose: null as null | { x: number; y: number; z: number; yaw: number; pitch: number },
  frames: 0,
  /** Re-capture the sky reflection on the next frame (the camera jumped). */
  freshEnv: false,
}
if (film.on) {
  document.body.classList.add('film')
  Object.assign(window, {
    __film: {
      camera(x: number, y: number, z: number, yaw = 0, pitch = 0) {
        // A jump of more than a few metres leaves the water reflecting the
        // sky as it was seen from the old spot until the next refresh
        const was = film.pose
        if (!was || Math.hypot(x - was.x, y - was.y, z - was.z) > 5) film.freshEnv = true
        film.pose = { x, y, z, yaw, pitch }
      },
      release() {
        film.pose = null
      },
      hour(h: number) {
        climate.setElapsed((((h % 24) + 24) % 24 / 24) * DAY_LENGTH)
        film.frozen = true
      },
      freeze(on = true) {
        film.frozen = on
      },
      hud(show: boolean) {
        document.body.classList.toggle('film', !show)
      },
      get frames() {
        return film.frames
      },
      /** Height of the ground (island or the spire) at a point, for placing a camera on land. */
      ground(x: number, z: number) {
        return groundAt(x, z)
      },
      /** Where the land animals are now, for framing them in a shot. */
      animals() {
        const at = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).toArray()
        return {
          tortoises: islandLife.tortoises.map((a) => at(a.built.root)),
          iguanas: islandLife.iguanas.map((a) => at(a.built.root)),
          flyingFoxes: islandLife.flyingFoxes.map((a) => at(a.built.root)),
          crabs: (island.crabs ?? []).map((a) => at(a.mesh)),
        }
      },
    },
  })
}

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

let glowProbeHide: THREE.Object3D | null = null

function captureEnv() {
  if (glowProbeHide) glowProbeHide.visible = false
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
  if (glowProbeHide) glowProbeHide.visible = true
  ocean.visible = true
  swimmer.rig.visible = true
}

const player = createPlayer()

// The way in is a parachute drop onto the island (src/parachute.ts). Anything
// that asks for a specific place — ?x= ?z= ?yaw= ?pitch= ?depth=, the headless
// screenshot script, ?chute=0 — skips it and spawns in the water as before;
// ?chute=1 forces it, ?alt= sets the opening height.
const wantChute =
  params.get('chute') === '1' ||
  (params.get('chute') !== '0' &&
    !navigator.webdriver &&
    !['x', 'z', 'yaw', 'pitch', 'depth', 'film'].some((k) => params.has(k)))
const chute = createParachute(scene)

// Where the drop starts and where the skip lands you. The cove is the one
// beach with a proper approach, so the run-in is straight down its axis from
// the open sea, high enough that the island is a shape and not yet a place.
const coveBeach = island.shore.length > 0 ? island.shore[0] : island.centre
const outward = new THREE.Vector2(coveBeach.x - island.centre.x, coveBeach.z - island.centre.z).normalize()
const chuteStart = {
  x: coveBeach.x + outward.x * 600,
  z: coveBeach.z + outward.y * 600,
  altitude: num('alt', 290),
  // Facing the beach: forward is (-sin yaw, -cos yaw)
  yaw: Math.atan2(outward.x, outward.y),
}

/** What you face when the drop is skipped. */
const skipLookAt = { x: reefWreck.group.position.x, z: reefWreck.group.position.z }

function spawn() {
  Object.assign(player, createPlayer())
  player.x = num('x', player.x)
  player.z = num('z', player.z)
  player.yaw = num('yaw', player.yaw)
  const depth = num('depth', 0)
  player.y = sampleOcean(player.x, player.z, 0).y + (depth > 0 ? -depth : 1.5)
  if (depth > 0) player.pitch = 0.5
  player.pitch = num('pitch', player.pitch)
  if (wantChute) chute.begin(player, { ...chuteStart, pitch: -0.12 }, 0)
}
spawn()

const input = createInputState()
const touch = createTouchControls(app)
// Sticks and swim buttons are for fingers; a keyboard and mouse don't need them
touch.setVisible(mobile)

const hud = createHud(app)
const arrival = createArrival(app, { drop: wantChute, touch: () => mobile, enabled: !film.on })
glassWhisper = hud.whisper
// Arrive gently: the world fades up out of the dark, and only then does one
// quiet line say how to move. After that the world speaks for itself.
// (Skipped under test automation, so screenshots catch the finished picture.)
if (!navigator.webdriver) {
  const introFade = document.createElement('div')
  introFade.id = 'intro-fade'
  app.appendChild(introFade)
  requestAnimationFrame(() => requestAnimationFrame(() => introFade.classList.add('done')))
  window.setTimeout(() => introFade.remove(), 4200)
}

// One way out of the drop for anyone who has seen it: land on the beach now
const skipChute = document.createElement('button')
skipChute.id = 'skip-chute'
skipChute.type = 'button'
skipChute.textContent = 'Begin on the beach'
skipChute.hidden = !wantChute
app.appendChild(skipChute)

/** Where you stand when the drop is skipped: the first dry sand seaward along the cove's axis. */
function landOnBeach() {
  let x = coveBeach.x
  let z = coveBeach.z
  for (let d = -30; d < 90; d += 1) {
    x = coveBeach.x + outward.x * d
    z = coveBeach.z + outward.y * d
    if (groundAt(x, z) < 2.2) break
  }
  player.x = x
  player.z = z
  player.mode = 'walk'
  player.y = groundAt(x, z) + 1.62
  player.vy = 0
  player.speed = 0
  player.fallFrom = null
  player.roll = 0
  // Face the wreck: out to sea, the way you would have come in
  const toWreck = Math.atan2(-(skipLookAt.x - x), -(skipLookAt.z - z))
  player.yaw = toWreck
  player.pitch = 0.02
  saidShore = true
  hud.whisper('You step onto the sand. A ship lies broken on the reef, just offshore.', true)
}
function cutAwayToBeach() {
  if (!chute.active) return
  chute.cut()
  landOnBeach()
}
skipChute.addEventListener('click', cutAwayToBeach)
// Dev hook for scripts/chute-flight.mjs — fly the whole drop without rendering it
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__chute = { chute, player, camera, groundAt, input, chuteStart, coveBeach, outward }
}
window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && !(e.target as HTMLElement)?.closest?.('button')) cutAwayToBeach()
})

// First time out of the water, whichever way you managed it
let saidPerch = false
let saidShore = false

function landfall(onPerch: boolean) {
  if (onPerch) {
    if (saidPerch) return
    saidPerch = true
    hud.whisper('Warm rock under you, and the sea all around.')
    return
  }
  if (saidShore) return
  saidShore = true
  // Say what is actually there: the terrain paints rock where it is steep and
  // grass from a few metres up, the same split the footsteps make
  const h = island.heightAt(player.x, player.z)
  const fall = Math.hypot(
    island.heightAt(player.x + 2, player.z) - island.heightAt(player.x - 2, player.z),
    island.heightAt(player.x, player.z + 2) - island.heightAt(player.x, player.z - 2),
  )
  if (fall > 4) hud.whisper('Rough rock under your feet.')
  else if (h > 6) hud.whisper('Grass underfoot, and the sea behind you.')
  else hud.whisper('Soft sand underfoot.')
}

const beach = island.shore.length > 0 ? island.shore[0] : island.centre
const lagoon = createLagoonLife(scene, {
  beach, wreck: reefWreck.group.position, heightAt: island.heightAt, lowPower,
})
const littoral = createLittoral(scene, {
  hud,
  heightAt: island.heightAt,
  origin: { x: island.centre.x, z: island.centre.z },
  cove: { x: beach.x, z: beach.z },

  reefResolve: wreck.resolve,
  wreckOrigin: { x: wreck.group.position.x, z: wreck.group.position.z },
  lowPower,
})

const islandLife = createIslandLife(scene, {
  hud,
  island: { centre: island.centre, heightAt: island.heightAt, pools: island.pools },
  cove: beach,
  lowPower,
  pixelRatio: renderer.getPixelRatio(),
  onSeabirdCry: oceanAudio.playSeabirdCry,
})
glowProbeHide = islandLife.glowGroup

// Dolphins, turtles and rays — larger life to stop and watch
const creatures = createCreatures(scene, {
  onSurfaceDisturb: islandLife.disturbWater,
  wreckCentre: wreck.group.position,
  wreckResolve: wreck.resolve,
  island: { centre: island.centre, heightAt: island.heightAt, resolve: island.resolve },
  cove: { x: beach.x, z: beach.z },

  lowPower,
  pixelRatio: renderer.getPixelRatio(),
})

// Humpback whale & calf, spotted eagle-ray squadron, blacktip reef sharks, and flying fish
const pelagic = createPelagicLife(scene, {
  onSurfaceDisturb: islandLife.disturbWater,
  hud,
  wreckCentre: wreck.group.position,
  wreckResolve: wreck.resolve,
  reefWreckPos: reefWreck.position,
  reefWreckResolve: reefWreck.resolve,
  island: { centre: island.centre, heightAt: island.heightAt, resolve: island.resolve },
  cove: beach,
  lowPower,
  pixelRatio: renderer.getPixelRatio(),
  onWhaleBlow: oceanAudio.playWhaleBlow,
  onWhaleSong: oceanAudio.playWhaleSong,

})

const desktop = bindKeyboardMouse(renderer.domElement, player, {
  enablePointerLock: () => !mobile,
  onLockChange: (locked) => {
    document.body.classList.toggle('playing', locked)
    if (!locked) arrival.show(8)
  },
})

if (mobile) document.body.classList.add('playing')

// Dev-only handle, for poking at state from the console or a headless run
if (import.meta.env.DEV) {
  Object.assign(window, {
    ww: {
      player,
      camera,
      renderer,
      post,
      scene,
      island,
      wreck,
      climate,
      sea,
      shore,
      littoral,
      creatures,
      pelagic,
      islandLife,
      lagoon,
      sky: skyRig,
      underwater: underwaterWorld,
    },
  })
}

const timer = new THREE.Timer()
timer.connect(document)
let bubbleTimer = 0
let envTimer = 0
function travelTo(place: Destination) {
  chute.cut()
  Object.assign(player, createPlayer(), { unlocked: document.pointerLockElement === renderer.domElement })
  prevSurfaceForAudio = Number.NaN
  heave = 0
  envTimer = 0
  if (place === 'beach') {
    landOnBeach()
    return
  }
  // Looking into the rainforest, over the barrier reef, or down the bow of the Wanderer.
  const spots = {
    forest: { x: 860, z: -600, yaw: -0.6, pitch: 0.14 },
    lagoon: { x: 804, z: -437, yaw: -0.63, pitch: -0.16 },
    wreck: { x: wreck.group.position.x + 14, z: wreck.group.position.z + 16, yaw: 0.72, pitch: -0.3 },
  }
  Object.assign(player, spots[place])
  const seaY = sampleOcean(player.x, player.z, timer.getElapsed()).y
  if (place === 'forest') {
    player.mode = 'walk'
    player.y = groundAt(player.x, player.z) + 1.62
  } else {
    player.y = Math.max(groundAt(player.x, player.z) + 1.62, seaY + (place === 'wreck' ? -6 : 1.5))
  }
}

let tracking = false
const trackingCamera = new THREE.PerspectiveCamera(41, camera.aspect, 0.05, camera.far)
const cameraTarget = new THREE.Vector3()
const worldControls = film.on ? null : createWorldControls(app, {
  setTracking: on => { tracking = on },
  getMinutes: () => Math.floor(climate.state.dayPhase * 1440),
  setMinutes: (minutes) => {
    const day = Math.floor(climate.getElapsed() / DAY_LENGTH)
    climate.setElapsed((day + minutes / 1440) * DAY_LENGTH)
    envTimer = 0
  },
  travelTo,
})
const idleInput = createInputState()
const SEA_FAR_TINT = new THREE.Color(0.55, 0.68, 0.8)
const seaFarHigh = new THREE.Color()

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
  mobile = preferTouchUI()
  touch.setVisible(mobile)
  document.body.classList.toggle('playing', mobile || document.pointerLockElement === renderer.domElement)
  applyView()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap))
  renderer.setSize(window.innerWidth, window.innerHeight)
  post.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio())
  islandLife.setPixelRatio(renderer.getPixelRatio())
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
    // `traverse` walks children regardless of what the callback returns, so an
    // opted-out root has to disqualify its subtree explicitly
    if (obj.parent?.userData.noShadow) obj.userData.noShadow = true
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
// Grass and the terrain shell are the two heaviest things on the island, and
// between them they're most of the depth pass. On a phone they still take
// shadow but stop giving it: a hill's own shadow needs a wider frustum than
// the phone gets anyway, and grass shadows don't survive a 1024 map.
if (lowPower) {
  island.terrain.userData.noCast = true
  for (const obj of island.group.children) {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && (mesh.geometry.attributes.position?.count ?? 0) > 40000) {
      obj.userData.noCast = true
    }
  }
}
markShadowCasters(scene)
let shadowScanTimer = 0

// Dancing sunlight on the seabed, the wreck and the island shelf
// Cumulus under the parachute and the climb (fade in above ~60 m)
const lowClouds = createLowClouds(scene, island.centre, lowPower)

const caustics = createCaustics(skyRig.sunDir)
caustics.apply(wreck.group)
caustics.apply(reefWreck.group)
caustics.apply(island.terrain)
caustics.apply(creatures.group)
caustics.apply(pelagic.group)

const keyLight = new THREE.Color()
// Clear tropical water: bright aqua in the shallows, deepening to ink-blue
const shallowTint = new THREE.Color('#1598ae')
const deepTint = new THREE.Color('#05324d')
const nightWater = new THREE.Color('#020c14')
const waterTint = new THREE.Color()
const oceanDayDeep = new THREE.Color('#031d2b')
const oceanDayShallow = new THREE.Color('#12718c')
const oceanNightDeep = new THREE.Color('#020d18')
const oceanNightShallow = new THREE.Color('#0a2c44')
const moonColor = new THREE.Color('#9fb8ea')
const oceanStormShallow = new THREE.Color('#1a3a48')
const underHemiSky = new THREE.Color('#6fc6d8')
const underHemiNight = new THREE.Color('#1a3a48')

/** The moment the feet arrive. The controller takes over from the next frame. */
function touchdown(td: { kind: 'land' | 'sea'; sink: number }) {
  hud.clear()
  if (td.kind === 'sea') hud.whisper('Splashdown. The canopy settles on the water behind you.')
  else if (td.sink < 1.6) hud.whisper('A soft landing.')
  else if (td.sink < 3.2) hud.whisper('Firm, but you stay on your feet.')
  else hud.whisper('A hard landing. You walk it off.')
}

let diveControls = false
let firstDive = false

function frame() {
  timer.update()
  const dt = Math.min(timer.getDelta(), 0.05)
  const t = timer.getElapsed()

  const weather = climate.update(film.frozen ? 0 : dt)
  oceanMat.uniforms.uDaylight.value = weather.daylight
  applyStormToWaves(weather.storm)
  syncWaves()
  // The sea breathes under the squalls — glass-offs oil the chop down, and
  // they only come while the sky is settled. Storm raises the set.
  sea.setFair(weather.fair)
  sea.setStorm(weather.storm)
  sea.update(dt, climate.getElapsed())
  oceanState.tide = weather.tide
  oceanAudio.setSeaWeight(sea.weight)

  touch.apply(input)
  desktop.mergeKeys(input)
  if (worldControls?.open) Object.assign(input, idleInput)
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

  // The sea's set carries you gently between strokes — softened in the
  // island's lee so the beach isn't a treadmill
  const lee = 1 - shelterAt(player.x, player.z) * 0.9
  const drift = {
    x: sea.current.x * lee,
    z: sea.current.z * lee,
  }
  const flight = chute.update(dt, t, player, camera, input, groundAt)
  if (flight?.touchdown) touchdown(flight.touchdown)
  const view: PlayerFrame = flight ? flight.frame : updatePlayer(player, camera, input, dt, t, collide, groundAt, drift)
  // Retain the physical sea but honour a request for a steady head and horizon.
  if (reducedMotion && !film.pose) {
    camera.rotation.z = 0
    if (!flight) {
      camera.position.set(player.x, player.y, player.z)
      camera.rotation.x = player.pitch
    }
  }
  chute.animate(dt, weather.daylight)
  // The wind in the lines, for the sound
  oceanAudio.setWindRush(chute.rush)
  skipChute.hidden = !chute.active
  // ?fly=120 lifts the eye that many metres above the swimmer — a drone view
  // for judging the island's shape. Dev only; the swimmer stays below.
  if (flyLift) camera.position.y += flyLift
  if (film.pose) {
    // The swimmer goes where the camera is, so the sea, the island's detail
    // and the sound all centre on the shot
    const p = film.pose
    player.x = p.x
    player.z = p.z
    camera.position.set(p.x, p.y, p.z)
    camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ')
    const sy = sampleOcean(p.x, p.z, t).y
    const under = p.y < sy
    Object.assign(view, {
      underwater: under,
      surfaceY: sy,
      depth: Math.max(0, sy - p.y),
      submersion: under ? 1 : 0,
      walking: false,
      groundY: -Infinity,
      fallLanded: 0,
      moving: 0,
      effort: 0,
    })
  }
  const { underwater, surfaceY, depth } = view
  if (depth > 1) diveControls = true
  else if (depth < 0.25) diveControls = false
  const travelMode = chute.active ? 'glide' : diveControls ? 'swim' : view.walking ? 'walk' : 'swim'
  touch.setMode(travelMode)
  arrival.update(dt, travelMode === 'swim' && diveControls ? 'dive' : travelMode)
  if (!firstDive && depth > 1.5 && !film.on) {
    firstDive = true
    hud.whisper('The swell goes quiet above you.')
  }

  // Ashore and on dry ground — wading the shallows still counts as in the sea
  const onLand = view.walking && view.groundY > 0.3
  const onPerch = onLand && onPerchAt(player.x, player.z)
  if (onLand) landfall(onPerch)

  if (Number.isNaN(prevSurfaceForAudio)) prevSurfaceForAudio = surfaceY
  heave = THREE.MathUtils.damp(heave, surfaceY - prevSurfaceForAudio, 6, dt)
  prevSurfaceForAudio = surfaceY

  // Shore proximity: soft falloff from the nearest beach point so the lap
  // lives at the waterline and dies inland / offshore.
  let shoreNear = 0
  if (island.shore.length > 0) {
    let best = Infinity
    for (const s of island.shore) {
      const d = Math.hypot(player.x - s.x, player.z - s.z)
      if (d < best) best = d
    }
    shoreNear = THREE.MathUtils.clamp(1 - best / 28, 0, 1)
    shoreNear *= shoreNear
  }
  // Wading the shelf also counts even without a planted palm nearby
  if (view.walking && view.groundY > -0.2 && view.groundY < 1.2) {
    shoreNear = Math.max(shoreNear, THREE.MathUtils.clamp(1 - Math.abs(view.groundY - 0.15) / 1.1, 0, 1))
  }

  let groundKind: AudioGround = 'water'
  if (view.walking) {
    if (onPerch) groundKind = 'rock'
    else if (view.groundY < oceanState.tide + 0.55) groundKind = 'wet-sand'
    else if (view.groundY < 2.6) groundKind = 'sand'
    else if (view.groundY < 48) groundKind = 'scrub'
    else groundKind = 'rock'
  }

  oceanAudio.update({
    dt,
    submersion: view.submersion,
    depth,
    heave,
    storm: weather.storm,
    rain: weather.rain,
    shore: shoreNear,
    onLand,
    mode: player.mode,
    walking: view.walking,
    moving: view.moving,
    speed: view.speed,
    stroke: view.stroke,
    ground: groundKind,
    grounded: player.fallFrom === null,
    waterDepth: Math.max(0, view.surfaceY - view.groundY),
    lightning: weather.lightning,
    thunder: weather.thunder,
    daylight: weather.daylight,
  })
  // Pointer-lock / first click also unlocks audio in case the global listeners missed it
  if (document.pointerLockElement) void oceanAudio.unlock()

  const showDiver = tracking && !chute.active
  swimmer.update(dt, t, view, player.pitch + player.viewPitch, player.roll, showDiver)
  if (film.on) swimmer.rig.visible = false

  skyRig.update(t, weather)
  // Keep every sky layer centred on the eye — an XZ-only follow left the
  // Preetham box a couple of metres low and one face could read as a slab.
  const cx = camera.position.x
  const cy = camera.position.y
  const cz = camera.position.z
  skyRig.sky.position.set(cx, cy, cz)
  skyRig.clouds.position.set(cx, cy, cz)
  skyRig.stars.position.set(cx, cy, cz)
  skyRig.milky.position.set(cx, cy, cz)
  // Moon rides with the camera origin; its local offset is set in createSky
  skyRig.moon.position.set(
    cx + skyRig.moon.userData.ox,
    cy + skyRig.moon.userData.oy,
    cz + skyRig.moon.userData.oz,
  )
  // A heavy sea carries more cloud; a glass-off opens the sky up — on top of
  // whatever the squall clock is already doing
  const cover = skyRig.clouds.material as THREE.ShaderMaterial
  cover.uniforms.uCover.value = THREE.MathUtils.clamp(
    cover.uniforms.uCover.value + (0.5 - sea.weight) * 0.14,
    0.1,
    0.7,
  )
  // From a parachute the sea has to run out to the horizon, or the strip beyond
  // the mesh shows as a flat white plane. The mesh grows with height in whole
  // steps (a continuous scale would shimmer its vertices); the waves live in
  // world space, so scaling x and z changes nothing but how far it reaches.
  const seaWant = THREE.MathUtils.clamp(1 + (camera.position.y - 25) / 55, 1, 5)
  if (seaWant > seaScale + 0.6) seaScale++
  else if (seaWant < seaScale - 0.6) seaScale--
  ocean.scale.set(seaScale, 1, seaScale)
  oceanMat.uniforms.uHalfExtent.value = OCEAN_SIZE * 0.5 * seaScale
  follow(camera.position.x, camera.position.z)
  // follow() snaps to the unscaled vertex spacing; the grid is coarser now
  const seaStep = (OCEAN_SIZE / OCEAN_SEGMENTS) * seaScale
  ocean.position.x = Math.round(camera.position.x / seaStep) * seaStep
  ocean.position.z = Math.round(camera.position.z / seaStep) * seaStep
  island.setHaze(skyRig.horizonColor)
  // A dead calm looks like a screenshot, so the trade wind never quite stops;
  // a squall roughly triples it.
  // The leaf backlight has to fade with the sun, and `sunLight.color` is only
  // a hue — the strength lives in its intensity
  keyLight.copy(skyRig.sunLight.color).multiplyScalar(Math.min(1.7, skyRig.sunLight.intensity * 0.3))
  island.setWeather(
    t,
    0.45 + sea.weight * 0.35 + weather.storm * 1.5,
    // Cloud shade needs a sun to block. Under a squall the deck is unbroken,
    // so there are no bands left to cast — everything is in shade already.
    weather.daylight * (0.55 - weather.storm * 0.45),
    skyRig.sunDir,
    keyLight,
    oceanState.tide,
  )

  oceanMat.uniforms.uTime.value = t
  // From height the sea is too coarse a grid to carry the short waves (they
  // alias into a honeycomb), and a real one looks calmer from up there anyway
  oceanMat.uniforms.uAmp.value = oceanState.amp * (1 - 0.6 * THREE.MathUtils.smoothstep(camera.position.y, 40, 170))
  oceanMat.uniforms.uTide.value = oceanState.tide
  oceanMat.uniforms.uCameraPos.value.copy(camera.position)
  // Once the sun is down the sea catches the moon instead, laying a silver
  // path of glitter across the water
  const moonlit = weather.sunElevation < -3
  oceanMat.uniforms.uSunDir.value.copy(moonlit ? skyRig.moonDir : skyRig.sunDir)
  oceanMat.uniforms.uHorizonColor.value.copy(skyRig.horizonColor)
  oceanMat.uniforms.uUnderwater.value = underwater ? 1 : 0
  // From the air the sea writes depth, so a near crest hides the trough behind
  // it — one transparent mesh can't sort its own triangles, and without this a
  // steep swell drew the far side of a wave over the near one in jagged teeth.
  // Underwater it stays off, so everything above shows through Snell's window.
  oceanMat.depthWrite = !underwater
  oceanMat.uniforms.uSunColor.value
    .setRGB(1, 0.95, 0.85)
    .lerp(moonColor, 1 - weather.daylight)
    .multiplyScalar(moonlit ? 1 - weather.storm * 0.8 : 1)
  // Body colour used to stay noon-teal after dark, and night exposure is
  // *higher* than midday — the shelf glowed like a pool. Walk it down with
  // the sky, and grey it a little when a front is in.
  const nightMix = 1 - weather.daylight
  oceanMat.uniforms.uDeepColor.value.copy(oceanDayDeep).lerp(oceanNightDeep, nightMix)
  oceanMat.uniforms.uShallowColor.value
    .copy(oceanDayShallow)
    .lerp(oceanNightShallow, nightMix)
    .lerp(oceanStormShallow, weather.storm * 0.4)

  // The deeper you go, the tighter and darker the water closes in.
  // Glass-offs clear the murk a touch — the dive window you can see as well as feel.
  // Over the wreck→island abyss the column itself darkens the water when you
  // look down, even before you've descended the full twenty-odd metres.
  const diveMurk = Math.min(1, depth / 24) * (sea.glassy ? 0.7 : 1)
  const seabed = island.heightAt(player.x, player.z)
  const column = Math.max(0, oceanState.tide - seabed)
  const abyssMurk = Math.min(1, Math.max(0, (column - 22) / 30))
  const lookDown = THREE.MathUtils.clamp((-player.pitch - 0.12) / 0.75, 0, 1)
  const murk = Math.min(
    1,
    Math.max(diveMurk, underwater ? abyssMurk * (0.35 + lookDown * 0.65) : 0),
  )
  underFog.density =
    0.012 + murk * 0.024 + abyssMurk * lookDown * 0.018 + (1 - weather.daylight) * 0.01
  waterTint.copy(shallowTint).lerp(deepTint, murk)
  waterTint.lerp(nightWater, (1 - weather.daylight) * 0.55)
  // Fog has to track the tint or distant geometry fades to the wrong colour and
  // reads as a flat cutout against the water instead of dissolving into it
  underFog.color.copy(waterTint)
  oceanMat.uniforms.uUnderColor.value.copy(waterTint)

  airFog.color.copy(skyRig.horizonColor)
  airFog.density = 0.0045 + weather.storm * 0.0035 + (1 - weather.daylight) * 0.002
  // Haze lies low over the sea. Looking down from the canopy or the climb, most
  // of the air between you and the island is above it, and at sea-level
  // density the whole drop was a white wash
  const hazeThin = THREE.MathUtils.smoothstep(camera.position.y, 25, 220)
  airFog.density *= 1 - 0.65 * hazeThin
  island.setHaze(skyRig.horizonColor, 1 - 0.55 * hazeThin)
  // Matches the ocean's own far colour at this height (ocean.ts)
  skyRig.seaFar
    .copy(skyRig.horizonColor)
    .multiplyScalar(0.85)
    .lerp(seaFarHigh.copy(skyRig.horizonColor).multiply(SEA_FAR_TINT), hazeThin)

  scene.fog = underwater ? underFog : airFog
  scene.background = underwater ? waterTint : skyRig.horizonColor
  // Exposure lives in the post chain now: nothing inside the scene tone-maps
  // any more, so the renderer's own setting would never be read.
  // Stops come off as the light goes up, the way they would on a camera. The
  // key is nine times what it used to be at noon, so midday now needs the
  // shortest exposure of the day and a moonlit night the longest.
  post.grade.exposure = underwater
    ? 0.92 - murk * 0.2 - (1 - weather.daylight) * 0.14
    : 1.35 - weather.daylight * 0.4 + weather.storm * 0.15

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
    // The probe is a picture of the sky, so most of the dimming happens on its
    // own — after dark the cube it samples is dark. Scaling hard by daylight on
    // top of that squares the falloff and drops the whole shaded side of the
    // island out from under golden hour. Just enough taper is left to stop the
    // probe lighting the hillside with green bounce off itself at night.
    // Same twilight argument as the hemisphere in sky.ts: the probe is a
    // picture of a sky that is still bright and now deeply coloured, and it is
    // the only thing lighting the half of the island the sun has left.
    const lowSun = THREE.MathUtils.clamp(1 - Math.abs(weather.sunElevation - 6) / 22, 0, 1)
    scene.environmentIntensity =
      (0.24 + weather.daylight * 0.22 + lowSun * lowSun * 0.5) * (1 - weather.storm * 0.25)
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
  // Head-height swell dips the eye under for a frame at a time; showing the
  // readout on every dip flashed an empty box at the top of the screen. It
  // waits until you are properly down, and keeps its number while it fades.
  if (depth > 0.5) showDepth = true
  else if (depth < 0.25) showDepth = false
  if (showDepth) depthReadout.textContent = `${depth.toFixed(1)} m`
  depthReadout.style.opacity = showDepth ? '1' : '0'
  // Under the canopy the same box reads height instead
  if (chute.active) {
    depthReadout.textContent = `${Math.max(0, Math.round(chute.height))} m up`
    depthReadout.style.opacity = '1'
  }

  // Under the surface the net of light is the whole show; from the beach it
  // is a shimmer on the sand in the shallows, so a good deal gentler
  const sunOnWater = weather.daylight * (1 - weather.storm * 0.7)
  caustics.update(
    t,
    sunOnWater * (underwater ? 13 : 6),
    oceanState.tide,
    skyRig.sunDir,
    !underwater,
  )
  underwaterWorld.update({
    dt,
    time: t,
    camera,
    surfaceY,
    submersion: view.submersion,
    underwater,
    pixelRatio: renderer.getPixelRatio(),
    biolum: weather.biolum,
    daylight: weather.daylight,
    effort: view.effort,
    tint: waterTint,
  })

  wreck.update(t, camera)
  reefWreck.update(t, camera)
  {
    const deck = (skyRig.clouds.material as THREE.ShaderMaterial).uniforms
    lowClouds.update(t, camera, skyRig.sunDir, deck.uTint.value, deck.uShadow.value, weather.daylight)
  }
  island.update(camera, underwater, t)
  shore.update(t, camera, underwater, weather.daylight)
  lagoon.update(dt, t, camera, weather.daylight)
  littoral.update(dt, player, { biolum: weather.biolum })
  underwaterWorld.fish.setAttractors(littoral.fishAttractors())
  creatures.update(dt, t, camera, {
    swimming: player.mode === 'swim',
    daylight: weather.daylight,
    storm: weather.storm,
  })
  spar.update(t)
  pelagic.update(dt, t, camera, {
    underwater,
    daylight: weather.daylight,
    storm: weather.storm,
  })
  islandLife.update(dt, t, camera, {
    daylight: weather.daylight,
    storm: weather.storm,
    biolum: weather.biolum,
    underwater,
    walking: onLand,
    playerX: player.x,
    playerY: player.y,
    playerZ: player.z,
    moving: view.moving,
    inSea: !onLand && (!chute.active || view.submersion > 0.05),
  })
  hud.update(dt)

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
  if (film.freshEnv) {
    envTimer = 0
    film.freshEnv = false
  }
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

  let renderCamera = camera
  if (showDiver) {
    if (trackingCamera.aspect !== camera.aspect) {
      trackingCamera.aspect = camera.aspect
      trackingCamera.updateProjectionMatrix()
    }
    const heading = player.yaw + 1.16
    const distance = Math.max(3.1, 2.6 / camera.aspect)
    const x = player.x - Math.sin(heading) * distance
    const z = player.z - Math.cos(heading) * distance
    const eye = view.walking ? player.y : Math.min(player.y, surfaceY + 0.12)
    cameraTarget.set(player.x, eye - (view.walking ? 0.78 : 0.27), player.z)
    let y = Math.max(groundAt(x, z) + 0.35, eye + (view.walking ? -0.38 : 0.47))
    const water = sampleOcean(x, z, t).y
    if (!underwater) y = Math.max(y, water + 0.42)
    else y = Math.max(groundAt(x, z) + 0.13, Math.min(y, water - 0.15))
    trackingCamera.position.set(x, y, z)
    trackingCamera.lookAt(cameraTarget)
    renderCamera = trackingCamera
    oceanMat.uniforms.uCameraPos.value.copy(renderCamera.position)
  }

  // Sun shafts: only worth drawing with the sun in the air and in front of
  // you, and they die away as it slides off the edge of the frame, since the
  // bright pass they smear has nothing to start from once the disc is gone
  {
    renderCamera.updateMatrixWorld()
    renderCamera.getWorldDirection(sunForward)
    const ahead = THREE.MathUtils.smoothstep(sunForward.dot(skyRig.sunDir), 0.05, 0.4)
    sunNdc.copy(renderCamera.position).addScaledVector(skyRig.sunDir, 1000).project(renderCamera)
    post.sun.uv.set(sunNdc.x * 0.5 + 0.5, sunNdc.y * 0.5 + 0.5)
    const onScreen =
      1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(sunNdc.x), Math.abs(sunNdc.y)), 1.0, 1.7)
    const sunUp = THREE.MathUtils.smoothstep(weather.sunElevation, -1.5, 5)
    post.sun.strength = underwater ? 0 : ahead * onScreen * sunUp * (1 - weather.storm * 0.85)
  }

  post.render(scene, renderCamera)
  film.frames++
  requestAnimationFrame(frame)
}

{
  const weather = climate.update(0)
  applyStormToWaves(weather.storm)
  syncWaves()
  sea.update(0, climate.getElapsed())
  oceanState.tide = weather.tide
  skyRig.update(0, weather)
  skyRig.focusShadow(player.x, 0, player.z)
  island.setHaze(skyRig.horizonColor)
  scene.background.copy(skyRig.horizonColor)
  airFog.color.copy(skyRig.horizonColor)
}
captureEnv()
frame()
