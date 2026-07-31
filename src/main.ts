import './style.css'
import * as THREE from 'three'
import { createOceanAudio } from './audio'
import { createClimate } from './climate'
import { createTouchControls } from './controls'
import { createHud } from './hud'
import { createInputState, isLowPowerDevice, preferTouchUI } from './input'
import { createInteractions } from './interact'
import { createIsland } from './island'
import { createOcean } from './ocean'
import { bindKeyboardMouse, createPlayer, updatePlayer } from './player'
import { createSalvage } from './salvage'
import { createShoreSurf } from './shore'
import { createSky } from './sky'
import { createSplashLayer } from './splash'
import { createSwimmer } from './swimmer'
import { createVitals, resetVitals, strokeThrottle, updateVitals } from './survival'
import { createUnderwaterWorld } from './underwater'
import { applyStormToWaves, sampleOcean } from './waves'
import { createWreck } from './wreck'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('#app missing')

const mobile = preferTouchUI()
const lowPower = isLowPowerDevice()

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
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.9
app.appendChild(renderer.domElement)

const skyRig = createSky(scene, 30, 38)
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

const shore = createShoreSurf(scene, {
  centre: island.centre,
  heightAt: island.heightAt,
  lowPower,
})

const collide = (p: { x: number; y: number; z: number }) => {
  wreck.resolve(p)
  island.resolve(p)
}

const oceanAudio = createOceanAudio()
let heave = 0
let prevSurfaceForAudio = Number.NaN

// ?depth=6&pitch=-0.2 spawns submerged, ?x=&z=&yaw= spawns somewhere specific —
// both handy when tuning the underwater look, the wreck, or the island.
// ?hour=18 starts at dusk, ?storm=1 locks a full squall.
const params = new URLSearchParams(location.search)
const num = (key: string, fallback: number) =>
  params.has(key) ? Number(params.get(key)) : fallback

const climate = createClimate({
  hour: num('hour', 9.5),
  storm: params.has('storm') ? Number(params.get('storm')) : undefined,
})

// Capture the sky (and clouds) into a cube map so the water reflects the real sky
const envRT = new THREE.WebGLCubeRenderTarget(lowPower ? 128 : 256)
envRT.texture.minFilter = THREE.LinearMipmapLinearFilter
envRT.texture.generateMipmaps = true
const envCam = new THREE.CubeCamera(1, 8000, envRT)
oceanMat.uniforms.uEnvMap.value = envRT.texture

function captureEnv() {
  ocean.visible = false
  swimmer.rig.visible = false
  envCam.position.set(camera.position.x, Math.max(camera.position.y, 2), camera.position.z)
  envCam.update(renderer, scene)
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
})

const input = createInputState()
const touch = createTouchControls(app)
touch.setVisible(true)

const hud = createHud(app, { touch: mobile, onRestart: restart })
let dead = false

function restart() {
  spawn()
  resetVitals(vitals)
  salvage.reset(new THREE.Vector3(player.x, player.y, player.z))
  hud.clearDead()
  hud.setPrompt(null)
  touch.setAction(null)
  dead = false
}

const desktop = bindKeyboardMouse(renderer.domElement, player, {
  enablePointerLock: !mobile,
  onLockChange: (locked) => {
    document.body.classList.toggle('playing', locked)
  },
})

if (mobile) document.body.classList.add('playing')

// Dev-only handle, for poking at state from the console or a headless run
if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, {
    ww: { player, camera, vitals, interactions, salvage, island, wreck, climate, shore },
  })
}

const clock = new THREE.Clock()
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

const shallowTint = new THREE.Color('#0a4f5e')
const deepTint = new THREE.Color('#031f2d')
const nightWater = new THREE.Color('#020c14')
const waterTint = new THREE.Color()
const underHemiSky = new THREE.Color('#6fc6d8')
const underHemiNight = new THREE.Color('#1a3a48')

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05)
  const t = clock.elapsedTime

  const weather = climate.update(dt)
  applyStormToWaves(weather.storm)
  syncWaves()

  input.interact = false
  touch.apply(input)
  desktop.mergeKeys(input)
  // Any keyboard use unlocks the audio context (WASD before click)
  if (
    input.moveForward ||
    input.moveStrafe ||
    input.lookX ||
    input.lookY ||
    input.rise ||
    input.dive
  ) {
    void oceanAudio.unlock()
  }

  if (!vitals.alive) {
    // Dead men don't swim — the swell still has the body, though
    input.moveForward = 0
    input.moveStrafe = 0
    input.rise = false
    input.dive = false
    input.interact = false
  } else {
    // Exhaustion throttles the stroke rather than stopping it dead
    const throttle = strokeThrottle(vitals) / weather.swimCost
    input.moveForward *= throttle
    input.moveStrafe *= throttle
  }

  const view = updatePlayer(player, camera, input, dt, t, collide, island.heightAt)
  const { underwater, surfaceY, depth } = view

  // Ashore and on dry ground — wading the shallows still counts as in the sea
  const onLand = view.walking && view.groundY > 0.3
  updateVitals(vitals, dt, {
    submerged: view.submersion > 0.85,
    depth,
    effort: view.effort,
    onLand,
    cold: weather.cold,
    swimCost: weather.swimCost,
  })

  if (!vitals.alive && !dead) {
    dead = true
    hud.setDead(vitals.cause, vitals.elapsed)
    if (document.pointerLockElement) document.exitPointerLock()
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
  follow(camera.position.x, camera.position.z)
  island.setHaze(skyRig.horizonColor)

  oceanMat.uniforms.uTime.value = t
  oceanMat.uniforms.uCameraPos.value.copy(camera.position)
  oceanMat.uniforms.uSunDir.value.copy(skyRig.sunDir)
  oceanMat.uniforms.uHorizonColor.value.copy(skyRig.horizonColor)
  oceanMat.uniforms.uUnderwater.value = underwater ? 1 : 0
  oceanMat.uniforms.uSunColor.value.setRGB(1, 0.95, 0.85).lerp(new THREE.Color('#6a7a9a'), 1 - weather.daylight)

  // The deeper you go, the tighter and darker the water closes in
  const murk = Math.min(1, depth / 24)
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
  renderer.toneMappingExposure = underwater
    ? 0.98 - murk * 0.25 - (1 - weather.daylight) * 0.15
    : 0.72 + weather.daylight * 0.28 - weather.storm * 0.22
  skyRig.sky.visible = !underwater
  skyRig.clouds.visible = !underwater
  skyRig.stars.visible = !underwater && skyRig.stars.visible
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

  underwaterWorld.update({
    dt,
    time: t,
    camera,
    surfaceY,
    submersion: view.submersion,
    underwater,
    pixelRatio: renderer.getPixelRatio(),
    biolum: weather.biolum,
  })

  wreck.update(t, camera)
  island.update(camera, underwater)
  shore.update(t, camera, underwater)
  salvage.update(t, camera.position)

  const reachable = vitals.alive ? interactions.find(camera) : null
  if (reachable && input.interact) reachable.use()
  hud.setPrompt(reachable ? { verb: reachable.verb, label: reachable.label } : null)
  touch.setAction(reachable ? reachable.verb : null)
  hud.setStash(salvage.stash, salvage.labels)
  hud.update(vitals, view.submersion > 0.85)

  splash.update(dt, camera.position.y, surfaceY, view.moving)

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

  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

{
  const weather = climate.update(0)
  applyStormToWaves(weather.storm)
  syncWaves()
  skyRig.update(0, weather)
  island.setHaze(skyRig.horizonColor)
  scene.background.copy(skyRig.horizonColor)
  airFog.color.copy(skyRig.horizonColor)
}
captureEnv()
frame()
