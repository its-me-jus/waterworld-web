import * as THREE from 'three'
import { Sky } from 'three/addons/objects/Sky.js'
import type { Climate } from './climate'

export type SkyRig = {
  sky: Sky
  clouds: THREE.Mesh
  stars: THREE.Points
  milky: THREE.Mesh
  moon: THREE.Group
  sunDir: THREE.Vector3
  sunLight: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  horizonColor: THREE.Color
  /** Baseline hemisphere colours — the frame loop restores from these in air. */
  dayHemiSky: THREE.Color
  dayHemiGround: THREE.Color
  update: (time: number, climate: Climate) => void
  /**
   * Park the shadow frustum on the player. A directional light shadows a fixed
   * box, so the box has to travel; snapping it to whole shadow texels is what
   * stops every edge in the world crawling as you walk.
   */
  focusShadow: (x: number, y: number, z: number) => void
}

const cloudVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const cloudFragment = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uTint;
uniform vec3 uShadow;
uniform float uCover;
uniform float uOpacity;

varying vec3 vDir;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.07 + vec2(31.4, 7.7);
    a *= 0.52;
  }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  if (d.y < 0.015) discard;

  // Project the dome onto a plane so clouds stretch toward the horizon
  vec2 uv = d.xz / (d.y + 0.16);
  vec2 drift = vec2(uTime * 0.0045, uTime * 0.0026);

  float shape = fbm(uv * 1.05 + drift);
  float detail = fbm(uv * 2.6 - drift * 1.7);
  float mask = shape * 0.75 + detail * 0.25;

  float cover = smoothstep(uCover, uCover + 0.22, mask);
  float wispy = smoothstep(uCover - 0.12, uCover + 0.35, mask);

  float sun = max(dot(d, normalize(uSunDir)), 0.0);
  float rim = pow(1.0 - cover, 2.0);
  vec3 col = mix(uShadow, uTint, cover);
  col += uTint * pow(sun, 6.0) * 0.55;
  col += vec3(1.0, 0.93, 0.82) * rim * pow(sun, 3.0) * 0.35;

  float horizonFade = smoothstep(0.015, 0.22, d.y);
  float topFade = 1.0 - smoothstep(0.75, 1.0, d.y) * 0.35;
  float alpha = mix(wispy * 0.45, cover, 0.75) * horizonFade * topFade * 0.9 * uOpacity;

  gl_FragColor = vec4(col, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const starVertex = /* glsl */ `
attribute float aSize;
attribute float aBright;
attribute float aPhase;

uniform float uTime;
uniform float uOpacity;

varying float vBright;
varying float vTwinkle;

void main() {
  float twinkle = 0.9 + 0.1 * sin(uTime * (0.7 + aPhase * 1.4) + aPhase * 6.28318);
  vBright = aBright;
  vTwinkle = twinkle;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * (0.85 + aBright * 0.55) * twinkle * mix(0.55, 1.0, uOpacity);
}
`

const starFragment = /* glsl */ `
uniform float uOpacity;

varying float vBright;
varying float vTwinkle;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = dot(p, p);
  if (r > 1.0) discard;

  // Soft core — bright stars keep a pin, dim ones stay faint dust
  float core = exp(-r * mix(4.5, 2.2, vBright));
  float halo = exp(-r * 1.1) * 0.35;
  float a = (core + halo) * vBright * vTwinkle * uOpacity;
  if (a < 0.01) discard;

  vec3 col = mix(vec3(0.72, 0.82, 0.95), vec3(0.92, 0.95, 1.0), vBright);
  gl_FragColor = vec4(col, a);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const milkyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const milkyFragment = /* glsl */ `
uniform float uOpacity;

varying vec3 vDir;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.13 + vec2(17.2, 9.1);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  if (d.y < 0.02) discard;

  // Tilted galactic plane — a soft dusty ridge across the dome
  float tilt = 0.55;
  float band = d.y * cos(tilt) + d.z * sin(tilt);
  float along = atan(d.x, d.z * cos(tilt) - d.y * sin(tilt));

  float ridge = 1.0 - smoothstep(0.0, 0.22, abs(band));
  float grit = fbm(vec2(along * 1.8, band * 6.0));
  float dust = fbm(vec2(along * 4.5 + 2.0, band * 12.0));
  float mask = ridge * (0.45 + grit * 0.55) * (0.65 + dust * 0.5);
  mask *= smoothstep(0.02, 0.18, d.y);

  float alpha = mask * uOpacity * 0.55;
  if (alpha < 0.004) discard;

  vec3 col = mix(vec3(0.55, 0.62, 0.78), vec3(0.82, 0.88, 0.96), grit);
  gl_FragColor = vec4(col, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const moonDiscFragment = /* glsl */ `
uniform float uOpacity;
varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float edge = smoothstep(1.0, 0.82, r);
  float shade = 0.88 + 0.12 * (1.0 - p.x * 0.4 - p.y * 0.15);
  vec3 col = vec3(0.91, 0.93, 0.97) * shade;
  gl_FragColor = vec4(col, edge * uOpacity);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const moonHaloFragment = /* glsl */ `
uniform float uOpacity;
varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = exp(-r * r * 2.8) * 0.55 * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(0.78, 0.84, 0.95, a);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** Billboard that faces the camera; mesh scale sets the on-screen disc size. */
const moonSpriteVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  // Center in view space, then expand by the mesh's world scale (PlaneGeometry is ±0.5)
  float sx = length(vec3(modelMatrix[0][0], modelMatrix[0][1], modelMatrix[0][2]));
  float sy = length(vec3(modelMatrix[1][0], modelMatrix[1][1], modelMatrix[1][2]));
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.x += position.x * sx;
  mv.y += position.y * sy;
  gl_Position = projectionMatrix * mv;
}
`

const DAY_HORIZON = new THREE.Color('#8fb3c9')
const DUSK_HORIZON = new THREE.Color('#c48a6a')
const NIGHT_HORIZON = new THREE.Color('#08141f')
const STORM_HORIZON = new THREE.Color('#3a4650')

const DAY_CLOUD = new THREE.Color('#f6f1e6')
const DAY_CLOUD_SHADOW = new THREE.Color('#5d7c94')
const STORM_CLOUD = new THREE.Color('#8a9198')
const STORM_CLOUD_SHADOW = new THREE.Color('#2a3238')
const NIGHT_CLOUD = new THREE.Color('#1a222c')
const NIGHT_CLOUD_SHADOW = new THREE.Color('#05080c')

/** Fixed moon direction — high enough to read, offset from the sun track. */
const MOON_ELEVATION = 42
const MOON_AZIMUTH = 210
const MOON_DISTANCE = 4200

/** Sky dome + drifting cloud layer + matched sun/ambient lights. */
export function createSky(
  scene: THREE.Scene,
  elevationDeg = 30,
  azimuthDeg = 155,
  opts: { shadows?: boolean; shadowSize?: number; shadowExtent?: number } = {},
): SkyRig {
  const sky = new Sky()
  sky.scale.setScalar(6000)
  scene.add(sky)

  const u = sky.material.uniforms
  u['turbidity'].value = 1.8
  u['rayleigh'].value = 1.55
  u['mieCoefficient'].value = 0.0025
  u['mieDirectionalG'].value = 0.8

  const sunDir = new THREE.Vector3()
  sunDir.setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - elevationDeg),
    THREE.MathUtils.degToRad(azimuthDeg),
  )
  u['sunPosition'].value.copy(sunDir)

  const sunLight = new THREE.DirectionalLight(0xfff0d4, 2.2)
  sunLight.position.copy(sunDir).multiplyScalar(200)
  scene.add(sunLight)
  scene.add(sunLight.target)

  const shadowExtent = opts.shadowExtent ?? 78
  const shadowSize = opts.shadowSize ?? 2048
  if (opts.shadows) {
    sunLight.castShadow = true
    sunLight.shadow.mapSize.set(shadowSize, shadowSize)
    const cam = sunLight.shadow.camera
    cam.left = -shadowExtent
    cam.right = shadowExtent
    cam.top = shadowExtent
    cam.bottom = -shadowExtent
    cam.near = 1
    cam.far = 620
    cam.updateProjectionMatrix()
    // Palm blades and grass are single-sided sheets a few centimetres thick;
    // a plain depth bias either acne-stripes them or lifts the shadow off the
    // sand. Normal bias moves the sample along the surface instead, which is
    // the only setting that holds for both.
    sunLight.shadow.bias = -0.0004
    sunLight.shadow.normalBias = 0.28
    // PCF's kernel is the only softness available now that the soft variant is
    // gone; a wide-ish radius reads as a canopy's diffuse edge rather than a
    // stencil, and hides the map's resolution on a phone.
    sunLight.shadow.radius = 2.4
  }

  const hemi = new THREE.HemisphereLight(0x9dc6e8, 0x07202b, 0.4)
  scene.add(hemi)

  const cloudGeo = new THREE.SphereGeometry(3200, 32, 20)
  const cloudMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: sunDir.clone() },
      uTint: { value: DAY_CLOUD.clone() },
      uShadow: { value: DAY_CLOUD_SHADOW.clone() },
      uCover: { value: 0.58 },
      uOpacity: { value: 1 },
    },
    vertexShader: cloudVertex,
    fragmentShader: cloudFragment,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
  })
  const clouds = new THREE.Mesh(cloudGeo, cloudMat)
  clouds.renderOrder = 1
  clouds.frustumCulled = false
  scene.add(clouds)

  // Varied starfield — sizes and brightness seeded once, twinkle in the shader
  const starCount = 1500
  const starPos = new Float32Array(starCount * 3)
  const starSize = new Float32Array(starCount)
  const starBright = new Float32Array(starCount)
  const starPhase = new Float32Array(starCount)
  for (let i = 0; i < starCount; i++) {
    const su = Math.random()
    const sv = Math.random()
    const theta = su * Math.PI * 2
    const phi = Math.acos(0.05 + sv * 0.95)
    const r = 4500
    starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    starPos[i * 3 + 1] = r * Math.cos(phi)
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)

    // Power curve: many dim, few bright
    const mag = Math.pow(Math.random(), 2.4)
    starBright[i] = 0.25 + mag * 0.75
    starSize[i] = 2.2 + mag * 5.5
    starPhase[i] = Math.random()
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1))
  starGeo.setAttribute('aBright', new THREE.BufferAttribute(starBright, 1))
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(starPhase, 1))
  const starMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
    },
    vertexShader: starVertex,
    fragmentShader: starFragment,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
  const stars = new THREE.Points(starGeo, starMat)
  stars.frustumCulled = false
  stars.renderOrder = -1
  scene.add(stars)

  // Soft Milky Way band — only reads on clear nights
  const milkyMat = new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: 0 },
    },
    vertexShader: milkyVertex,
    fragmentShader: milkyFragment,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
  const milky = new THREE.Mesh(new THREE.SphereGeometry(4400, 48, 28), milkyMat)
  milky.frustumCulled = false
  milky.renderOrder = -2
  milky.visible = false
  scene.add(milky)

  // Moon disc + soft halo, billboarded toward the camera
  const moonDir = new THREE.Vector3()
  moonDir.setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - MOON_ELEVATION),
    THREE.MathUtils.degToRad(MOON_AZIMUTH),
  )

  const moon = new THREE.Group()
  moon.visible = false
  moon.frustumCulled = false
  moon.renderOrder = 0

  const discMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: moonSpriteVertex,
    fragmentShader: moonDiscFragment,
    transparent: true,
    depthWrite: false,
    fog: false,
  })
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), discMat)
  disc.scale.setScalar(140)
  disc.renderOrder = 2

  const haloMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: moonSpriteVertex,
    fragmentShader: moonHaloFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), haloMat)
  halo.scale.setScalar(420)
  halo.renderOrder = 1

  moon.add(halo)
  moon.add(disc)
  moon.position.copy(moonDir).multiplyScalar(MOON_DISTANCE)
  moon.userData.ox = moon.position.x
  moon.userData.oy = moon.position.y
  moon.userData.oz = moon.position.z
  scene.add(moon)

  const horizonColor = DAY_HORIZON.clone()
  const dayHemiSky = new THREE.Color(0x9dc6e8)
  const dayHemiGround = new THREE.Color(0x07202b)
  const scratch = new THREE.Color()
  const sunTint = new THREE.Color()
  const lightDir = new THREE.Vector3().copy(sunDir)

  // Scratch vectors for the shadow follow — allocating per frame here would
  // churn the GC on the hot path
  const focusPoint = new THREE.Vector3()
  const lightRight = new THREE.Vector3()
  const lightUp = new THREE.Vector3()
  const worldUp = new THREE.Vector3(0, 1, 0)
  const texel = (shadowExtent * 2) / shadowSize

  function focusShadow(x: number, y: number, z: number) {
    if (!sunLight.castShadow) return
    focusPoint.set(x, y, z)
    // Build the light's screen basis and round the focus onto its texel grid.
    // Without this the shadow map resamples the world every frame and every
    // frond edge shimmers as you walk.
    lightRight.crossVectors(worldUp, lightDir)
    if (lightRight.lengthSq() < 1e-6) lightRight.set(1, 0, 0)
    lightRight.normalize()
    lightUp.crossVectors(lightDir, lightRight).normalize()
    const u = Math.round(focusPoint.dot(lightRight) / texel) * texel
    const v = Math.round(focusPoint.dot(lightUp) / texel) * texel
    const w = focusPoint.dot(lightDir)
    focusPoint
      .set(0, 0, 0)
      .addScaledVector(lightRight, u)
      .addScaledVector(lightUp, v)
      .addScaledVector(lightDir, w)
    sunLight.target.position.copy(focusPoint)
    sunLight.target.updateMatrixWorld()
    sunLight.position.copy(focusPoint).addScaledVector(lightDir, 300)
  }

  return {
    sky,
    clouds,
    stars,
    milky,
    moon,
    sunDir,
    sunLight,
    hemi,
    horizonColor,
    dayHemiSky,
    dayHemiGround,
    focusShadow,
    update(time: number, climate: Climate) {
      cloudMat.uniforms.uTime.value = time
      starMat.uniforms.uTime.value = time

      sunDir.setFromSphericalCoords(
        1,
        THREE.MathUtils.degToRad(90 - climate.sunElevation),
        THREE.MathUtils.degToRad(climate.sunAzimuth),
      )
      u['sunPosition'].value.copy(sunDir)
      cloudMat.uniforms.uSunDir.value.copy(sunDir)

      const day = climate.daylight
      const storm = climate.storm
      const fair = climate.fair
      const dusk = THREE.MathUtils.clamp(1 - Math.abs(climate.sunElevation - 4) / 14, 0, 1)
      const night = Math.max(0, 1 - day)

      // Horizon: day → dusk blush → night, then storm greys it out.
      // Floor the night mix so the sky never goes pure black — open ocean
      // at midnight still needs a readable horizon.
      const nightAmt = Math.min(0.9, night)
      scratch.copy(DAY_HORIZON).lerp(NIGHT_HORIZON, nightAmt)
      scratch.lerp(DUSK_HORIZON, dusk * Math.max(day, 0.15) * 0.7)
      scratch.lerp(STORM_HORIZON, storm * 0.75)
      horizonColor.copy(scratch)

      // Physical sky params — storms muddy the air, night drops the scatter
      // so the starfield isn't fighting grey Rayleigh. More Rayleigh and less
      // Mie than looks right on paper: the tone map now runs at the end of the
      // frame on real HDR values, and it flattens a pale sky into a white band
      // unless the zenith is given somewhere deeper to go.
      u['turbidity'].value = THREE.MathUtils.lerp(1.0, 12, storm) + night * 1.8
      u['rayleigh'].value = THREE.MathUtils.lerp(0.18, 2.7, day) * (1 - storm * 0.55)
      u['mieCoefficient'].value = 0.0014 + storm * 0.018 + night * 0.003

      // Cloud deck: lower uCover = more cloud. Storms fill the sky.
      cloudMat.uniforms.uCover.value = THREE.MathUtils.lerp(0.62, 0.12, storm)
      cloudMat.uniforms.uTint.value
        .copy(DAY_CLOUD)
        .lerp(NIGHT_CLOUD, night)
        .lerp(STORM_CLOUD, storm)
      cloudMat.uniforms.uShadow.value
        .copy(DAY_CLOUD_SHADOW)
        .lerp(NIGHT_CLOUD_SHADOW, night)
        .lerp(STORM_CLOUD_SHADOW, storm)
      cloudMat.uniforms.uOpacity.value = THREE.MathUtils.lerp(0.55, 1, Math.max(storm, 1 - day * 0.5))

      // Lights — after dusk the directional becomes cool moon fill from the moon.
      // Keep a readable floor of fill so silhouettes hold, but leave room for
      // campfire PointLights to own the warm pools on the sand.
      const sunUp = Math.max(0, climate.sunElevation / 62)
      const moonLift = night * (1 - storm * 0.75)
      const dayIntensity = THREE.MathUtils.lerp(0.15, 2.6, sunUp * sunUp) * (1 - storm * 0.6)
      const nightIntensity = THREE.MathUtils.lerp(0.28, 0.38, fair) * moonLift
      sunLight.intensity = Math.max(dayIntensity, nightIntensity)

      sunTint.setRGB(1, 0.94, 0.83).lerp(new THREE.Color('#8a9bb8'), night)
      sunTint.lerp(new THREE.Color('#c8d0d6'), storm * 0.5)
      sunLight.color.copy(sunTint)

      // Aim the key light at the moon once the sun is down so silhouettes read
      if (climate.sunElevation < 2) {
        lightDir.copy(moonDir)
      } else {
        lightDir.copy(sunDir)
      }
      // Placement is `focusShadow`'s job now; this is the fallback for the one
      // frame before the loop has a player position to follow.
      if (!sunLight.castShadow) sunLight.position.copy(lightDir).multiplyScalar(200)

      dayHemiSky.setRGB(0.62, 0.78, 0.91).lerp(new THREE.Color('#1a2838'), night)
      dayHemiSky.lerp(new THREE.Color('#3a4550'), storm * 0.55)
      dayHemiGround.setRGB(0.03, 0.125, 0.17).lerp(new THREE.Color('#0a1218'), night)
      // A squall dims the sun but turns the whole sky into one soft source, so
      // skylight goes up, not down. Cutting both is what made a storm at noon
      // as dark as dusk.
      hemi.intensity = THREE.MathUtils.lerp(0.28, 0.5, day) * (1 + storm * 0.85)

      // Stars fade in after dusk, wash out under a storm
      const starOp = Math.max(0, night * 0.95 - storm * 0.7)
      starMat.uniforms.uOpacity.value = starOp
      stars.visible = starOp > 0.02

      // Milky Way only on open, fair nights
      const milkyOp = Math.max(0, night * fair * (1 - storm * 1.2))
      milkyMat.uniforms.uOpacity.value = milkyOp
      milky.visible = milkyOp > 0.03

      // Moon disc eases in with night, dims hard under cloud cover
      const moonOp = Math.max(0, night * (0.55 + fair * 0.45) * (1 - storm * 0.85))
      discMat.uniforms.uOpacity.value = moonOp
      haloMat.uniforms.uOpacity.value = moonOp * 0.85
      moon.visible = moonOp > 0.04
    },
  }
}
