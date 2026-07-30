import './style.css'
import * as THREE from 'three'
import { Sky } from 'three/addons/objects/Sky.js'
import { createTouchControls } from './controls'
import { createInputState, isLowPowerDevice, preferTouchUI } from './input'
import { createOcean } from './ocean'
import { bindKeyboardMouse, createPlayer, updatePlayer } from './player'
import { createSplashLayer } from './splash'
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
const airFog = new THREE.FogExp2(0x8ec8e0, 0.007)
const underFog = new THREE.FogExp2(0x03404a, 0.045)
scene.fog = airFog
scene.background = new THREE.Color(0x87b8d0)

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 2000)
camera.rotation.order = 'YXZ'

const pixelRatioCap = lowPower ? 1.25 : 2
const renderer = new THREE.WebGLRenderer({
  antialias: !lowPower,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05
app.appendChild(renderer.domElement)

const hemi = new THREE.HemisphereLight(0xb8d7ff, 0x1a3040, 0.55)
scene.add(hemi)

const sun = new THREE.DirectionalLight(0xfff1d6, 2.1)
sun.castShadow = false
scene.add(sun)

const sky = new Sky()
sky.scale.setScalar(4500)
scene.add(sky)
const skyUniforms = sky.material.uniforms
skyUniforms['turbidity'].value = 3.5
skyUniforms['rayleigh'].value = 2.4
skyUniforms['mieCoefficient'].value = 0.004
skyUniforms['mieDirectionalG'].value = 0.78
const sunPosition = new THREE.Vector3()
const phi = THREE.MathUtils.degToRad(84)
const theta = THREE.MathUtils.degToRad(160)
sunPosition.setFromSphericalCoords(1, phi, theta)
skyUniforms['sunPosition'].value.copy(sunPosition)
sun.position.copy(sunPosition).multiplyScalar(80)

const oceanSize = lowPower ? 360 : 560
const oceanSegs = lowPower ? 140 : 280
const { mesh: ocean, material: oceanMat } = createOcean(oceanSize, oceanSegs)
scene.add(ocean)

const player = createPlayer()
{
  const surface = sampleOcean(player.x, player.z, 0).y
  player.y = surface + 1.1
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

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap))
  renderer.setSize(window.innerWidth, window.innerHeight)
}
window.addEventListener('resize', onResize)

// Prevent page scroll / pinch while playing on mobile
app.addEventListener(
  'touchmove',
  (e) => {
    if ((e.target as HTMLElement).closest('#touch-controls')) e.preventDefault()
  },
  { passive: false },
)

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05)
  const t = clock.elapsedTime

  touch.apply(input)
  desktop.mergeKeys(input)

  const { underwater, surfaceY, moving } = updatePlayer(player, camera, input, dt, t)

  oceanMat.uniforms.uTime.value = t
  oceanMat.uniforms.uCameraPos.value.copy(camera.position)
  oceanMat.uniforms.uSunDir.value.copy(sunPosition).normalize()
  oceanMat.uniforms.uUnderwater.value = underwater ? 1 : 0

  scene.fog = underwater ? underFog : airFog
  scene.background = new THREE.Color(underwater ? 0x023038 : 0x87b8d0)
  renderer.toneMappingExposure = underwater ? 0.78 : 1.08
  sky.visible = !underwater
  hemi.intensity = underwater ? 0.35 : 0.6
  sun.intensity = underwater ? 0.7 : 2.1

  document.body.classList.toggle('underwater', underwater)
  underOverlay.style.opacity = underwater ? '1' : '0'

  splash.update(dt, player.y, surfaceY, moving)

  if (underwater) {
    bubbleTimer -= dt
    if (bubbleTimer <= 0) {
      spawnBubble()
      bubbleTimer = 0.7 + Math.random() * 1.1
    }
  } else {
    bubblesLayer.replaceChildren()
  }

  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}

frame()
