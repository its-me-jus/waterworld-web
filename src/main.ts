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

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('#app missing')

const mobile = preferTouchUI()
const lowPower = isLowPowerDevice()

const hud = document.createElement('div')
hud.id = 'hud'
hud.innerHTML = mobile
  ? '<strong>WaterWorld</strong><span id="hud-hint">Left stick move · Right stick look · ▲▼ depth</span>'
  : '<strong>WaterWorld</strong><span id="hud-hint">Sticks or WASD · Click canvas to mouse-look · Space/Shift depth</span>'
app.appendChild(hud)

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
  // ?depth=6&pitch=-0.2 spawns submerged — handy when tuning the underwater look
  const params = new URLSearchParams(location.search)
  const depth = Number(params.get('depth') ?? 0)
  const surface = sampleOcean(player.x, player.z, 0).y
  player.y = surface + (depth > 0 ? -depth : 1.5)
  if (depth > 0) player.pitch = 0.5
  if (params.has('pitch')) player.pitch = Number(params.get('pitch'))
}

const input = createInputState()
const touch = createTouchControls(app)
touch.setVisible(true)

const desktop = bindKeyboardMouse(renderer.domElement, player, {
  enablePointerLock: !mobile,
  onLockChange: (locked) => {
    document.body.classList.toggle('playing', locked)
    const hint = document.querySelector('#hud-hint')
    if (hint && !mobile) {
      hint.textContent = locked
        ? 'WASD · Space up · Shift dive · Esc release'
        : 'Click to look · WASD · Space up · Shift dive'
    }
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

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05)
  const t = clock.elapsedTime

  touch.apply(input)
  desktop.mergeKeys(input)

  const view = updatePlayer(player, camera, input, dt, t)
  const { underwater, surfaceY, depth } = view

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

  scene.fog = underwater ? underFog : airFog
  scene.background = underwater ? waterTint : skyRig.horizonColor
  renderer.toneMappingExposure = underwater ? 0.98 - murk * 0.25 : 0.9
  skyRig.sky.visible = !underwater
  skyRig.clouds.visible = !underwater
  skyRig.hemi.intensity = underwater ? 0.34 - murk * 0.14 : 0.5
  skyRig.sunLight.intensity = underwater ? 1.1 - murk * 0.5 : 2.6

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
