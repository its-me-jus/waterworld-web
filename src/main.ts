import './style.css'
import * as THREE from 'three'
import { createOceanAudio, type AudioGround } from './audio'
import { createCaustics } from './caustics'
import { createClimate } from './climate'
import { createCreatures } from './creatures'
import { createTouchControls } from './controls'
import { createHud } from './hud'
import { createInputState, isLowPowerDevice, preferTouchUI } from './input'
import { createIsland } from './island'
import { createLittoral } from './littoral'
import { createOcean } from './ocean'
import { bindKeyboardMouse, createPlayer, updatePlayer } from './player'
import { createPostChain } from './post'
import { createSeaState } from './sea'
import { createShoreSurf } from './shore'
import { createSky } from './sky'
import { createSparBuoy } from './spar'
import { createSplashLayer } from './splash'
import { createSwimmer } from './swimmer'
import { createUnderwaterWorld } from './underwater'
import { applyStormToWaves, oceanState, sampleOcean, setShelter, shelterAt } from './waves'
import { createWreck } from './wreck'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('#app missing')

const mobile = preferTouchUI()
const lowPower = isLowPowerDevice()

const depthReadout = document.createElement('div')
depthReadout.id = 'depth'
app.appendChild(depthReadout)

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
  // Big enough that fog + radial rim fade eat the edge before a square shows
  size: lowPower ? 900 : 1400,
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

const shore = createShoreSurf(scene, {
  centre: island.centre,
  heightAt: island.heightAt,
  lowPower,
})

const collide = (p: { x: number; y: number; z: number }) => {
  wreck.resolve(p)
  island.resolve(p)
}

// What you can stand on — the island shelf and the reef spire.
const groundAt = (x: number, z: number) => Math.max(island.heightAt(x, z), wreck.standAt(x, z))
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
  onGlassOff: () => glassWhisper?.('The sea lies flat and clear.'),
  onSwellUp: () => glassWhisper?.('The swell finds its shape again.'),
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

const input = createInputState()
const touch = createTouchControls(app)
// Sticks and swim buttons are for fingers; a keyboard and mouse don't need them
touch.setVisible(mobile)

const hud = createHud(app)
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
window.setTimeout(
  () =>
    hud.whisper(
      mobile
        ? 'Drag to look around. The stick swims.'
        : 'WASD to swim · click to look · Space and Shift to rise and dive',
    ),
  navigator.webdriver ? 0 : 2600,
)

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
  hud.whisper('Soft sand underfoot.')
}

const beach = island.shore.length > 0 ? island.shore[0] : island.centre
const littoral = createLittoral(scene, {
  hud,
  heightAt: island.heightAt,
  origin: { x: island.centre.x, z: island.centre.z },
  cove: { x: beach.x, z: beach.z },
  reefResolve: wreck.resolve,
  wreckOrigin: { x: wreck.group.position.x, z: wreck.group.position.z },
  lowPower,
})

// Dolphins, turtles and rays — larger life to stop and watch
const creatures = createCreatures(scene, {
  wreckCentre: wreck.group.position,
  wreckResolve: wreck.resolve,
  island: { centre: island.centre, heightAt: island.heightAt, resolve: island.resolve },
  cove: { x: beach.x, z: beach.z },
  lowPower,
  pixelRatio: renderer.getPixelRatio(),
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
      sky: skyRig,
      underwater: underwaterWorld,
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
const caustics = createCaustics(skyRig.sunDir)
caustics.apply(wreck.group)
caustics.apply(island.terrain)

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
  sea.update(dt, climate.getElapsed())
  oceanState.tide = weather.tide
  oceanAudio.setSeaWeight(sea.weight)

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

  // The sea's set carries you gently between strokes — softened in the
  // island's lee so the beach isn't a treadmill
  const lee = 1 - shelterAt(player.x, player.z) * 0.9
  const drift = {
    x: sea.current.x * lee,
    z: sea.current.z * lee,
  }
  const view = updatePlayer(player, camera, input, dt, t, collide, groundAt, drift)
  const { underwater, surfaceY, depth } = view

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
    else if (view.groundY < 0.55) groundKind = 'wet-sand'
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
    lightning: weather.lightning,
    thunder: weather.thunder,
  })
  // Pointer-lock / first click also unlocks audio in case the global listeners missed it
  if (document.pointerLockElement) void oceanAudio.unlock()

  swimmer.update(dt, t, view, player.pitch + player.viewPitch, player.roll)

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
  follow(camera.position.x, camera.position.z)
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
  oceanMat.uniforms.uAmp.value = oceanState.amp
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
  depthReadout.textContent = underwater ? `${depth.toFixed(1)} m` : ''
  depthReadout.style.opacity = underwater ? '1' : '0'

  caustics.update(
    t,
    underwater ? weather.daylight * (1 - weather.storm * 0.7) * 13 : 0,
    oceanState.tide,
    skyRig.sunDir,
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
  })

  wreck.update(t, camera)
  island.update(camera, underwater, t)
  shore.update(t, camera, underwater)
  littoral.update(dt, player, { biolum: weather.biolum })
  underwaterWorld.fish.setAttractors(littoral.fishAttractors())
  creatures.update(dt, t, camera, {
    swimming: player.mode === 'swim',
    daylight: weather.daylight,
    storm: weather.storm,
  })
  spar.update(t)
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
