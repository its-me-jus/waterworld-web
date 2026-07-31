import './style.css'
import * as THREE from 'three'
import { createTouchControls } from './controls'
import { createInputState, isLowPowerDevice, preferTouchUI } from './input'
import { createOcean } from './ocean'
import { bindKeyboardMouse, createPlayer, updatePlayer } from './player'
import { createSky } from './sky'
import { createSplashLayer } from './splash'
import { createSwimmer } from './swimmer'
import { createUnderwaterWorld } from './underwater'
import { sampleOcean } from './waves'
import { createWreck } from './wreck'
import { createOceanAudio } from './audio'

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

const marker = document.createElement('div')
marker.id = 'marker'
marker.innerHTML = '<span class="marker-ring"></span><span class="marker-range"></span>'
app.appendChild(marker)
const markerRange = marker.querySelector<HTMLElement>('.marker-range')

const found = document.createElement('div')
found.id = 'found'
found.innerHTML = '<strong>The Wanderer</strong><span>Dive the hull</span>'
app.appendChild(found)

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

const { mesh: ocean, material: oceanMat, follow } = createOcean({
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
const oceanAudio = createOceanAudio()
let heave = 0
let prevSurfaceForAudio = Number.NaN

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
{
  // ?depth=6&pitch=-0.2 spawns submerged, ?x=&z=&yaw= spawns somewhere specific —
  // both handy when tuning the underwater look or the wreck
  const params = new URLSearchParams(location.search)
  const num = (key: string, fallback: number) =>
    params.has(key) ? Number(params.get(key)) : fallback
  player.x = num('x', player.x)
  player.z = num('z', player.z)
  player.yaw = num('yaw', player.yaw)
  const depth = num('depth', 0)
  const surface = sampleOcean(player.x, player.z, 0).y
  player.y = surface + (depth > 0 ? -depth : 1.5)
  if (depth > 0) player.pitch = 0.5
  player.pitch = num('pitch', player.pitch)
}

const input = createInputState()
const touch = createTouchControls(app)
touch.setVisible(true)

const desktop = bindKeyboardMouse(renderer.domElement, player, {
  enablePointerLock: !mobile,
  onLockChange: (locked) => {
    document.body.classList.toggle('playing', locked)
  },
})

if (mobile) document.body.classList.add('playing')

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
const waterTint = new THREE.Color()

const airHemiSky = skyRig.hemi.color.clone()
const airHemiGround = skyRig.hemi.groundColor.clone()
const underHemiSky = new THREE.Color('#6fc6d8')

const beaconView = new THREE.Vector3()
const beaconClip = new THREE.Vector3()
let foundAt = -1

/**
 * Pin a small pip on the wreck's mast head — clamped to the screen edge when
 * it's behind you — so an ocean with no features still has a direction in it.
 * Fades out once you're on top of it and back in if you wander off.
 */
function updateMarker(time: number) {
  const range = camera.position.distanceTo(wreck.centre)

  if (range < 26 && foundAt < 0) foundAt = time
  const since = foundAt < 0 ? -1 : time - foundAt
  found.style.opacity =
    since < 0 ? '0' : String(THREE.MathUtils.clamp(Math.min(since / 0.6, (5.5 - since) / 1.2), 0, 1))

  const strength = THREE.MathUtils.smoothstep(range, 26, 48)
  marker.style.opacity = String(strength * 0.8)
  if (strength < 0.01) return

  camera.updateMatrixWorld()
  beaconView.copy(wreck.beacon).applyMatrix4(camera.matrixWorldInverse)

  let nx: number
  let ny: number
  if (beaconView.z > -0.5) {
    // Behind us — park it on the side you'd have to turn toward
    nx = beaconView.x >= 0 ? 0.93 : -0.93
    ny = THREE.MathUtils.clamp(beaconView.y / Math.max(4, Math.abs(beaconView.z)), -0.8, 0.8)
  } else {
    beaconClip.copy(beaconView).applyMatrix4(camera.projectionMatrix)
    nx = THREE.MathUtils.clamp(beaconClip.x, -0.93, 0.93)
    ny = THREE.MathUtils.clamp(beaconClip.y, -0.88, 0.88)
  }

  marker.style.transform = `translate(-50%, -50%) translate(${(nx * 50 + 50).toFixed(2)}vw, ${(50 - ny * 50).toFixed(2)}vh)`
  if (markerRange) markerRange.textContent = `${range.toFixed(0)} m`
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05)
  const t = clock.elapsedTime

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

  const view = updatePlayer(player, camera, input, dt, t, wreck.resolve)
  const { underwater, surfaceY, depth } = view

  if (Number.isNaN(prevSurfaceForAudio)) prevSurfaceForAudio = surfaceY
  heave = THREE.MathUtils.damp(heave, surfaceY - prevSurfaceForAudio, 6, dt)
  prevSurfaceForAudio = surfaceY
  oceanAudio.update(dt, view.submersion, depth, heave)
  // Pointer-lock / first click also unlocks audio in case the global listeners missed it
  if (document.pointerLockElement) void oceanAudio.unlock()

  swimmer.update(dt, t, view, player.pitch + player.viewPitch, player.roll)

  skyRig.update(t)
  skyRig.sky.position.set(camera.position.x, 0, camera.position.z)
  skyRig.clouds.position.set(camera.position.x, 0, camera.position.z)
  follow(camera.position.x, camera.position.z)

  oceanMat.uniforms.uTime.value = t
  oceanMat.uniforms.uCameraPos.value.copy(camera.position)
  oceanMat.uniforms.uSunDir.value.copy(skyRig.sunDir)
  oceanMat.uniforms.uUnderwater.value = underwater ? 1 : 0

  // The deeper you go, the tighter and darker the water closes in
  const murk = Math.min(1, depth / 24)
  underFog.density = 0.026 + murk * 0.032
  waterTint.copy(shallowTint).lerp(deepTint, murk)
  // Fog has to track the tint or distant geometry fades to the wrong colour and
  // reads as a flat cutout against the water instead of dissolving into it
  underFog.color.copy(waterTint)

  scene.fog = underwater ? underFog : airFog
  scene.background = underwater ? waterTint : skyRig.horizonColor
  renderer.toneMappingExposure = underwater ? 0.98 - murk * 0.25 : 0.9
  skyRig.sky.visible = !underwater
  skyRig.clouds.visible = !underwater
  if (underwater) {
    // Backscatter off the water is the only fill down here. Without a lit lower
    // hemisphere every underside — reef flank, hull, kelp — goes flat black.
    skyRig.hemi.color.copy(underHemiSky)
    skyRig.hemi.groundColor.copy(waterTint).multiplyScalar(2.4)
    skyRig.hemi.intensity = 1.35 - murk * 0.45
  } else {
    skyRig.hemi.color.copy(airHemiSky)
    skyRig.hemi.groundColor.copy(airHemiGround)
    skyRig.hemi.intensity = 0.5
  }
  skyRig.sunLight.intensity = underwater ? 1.5 - murk * 0.6 : 2.6

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
  })

  wreck.update(t, camera)
  updateMarker(t)

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

  // Refresh reflections as the clouds drift (cheap, not every frame)
  envTimer -= dt
  if (envTimer <= 0 && !underwater) {
    captureEnv()
    envTimer = lowPower ? 12 : 3
  }

  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

captureEnv()
frame()
