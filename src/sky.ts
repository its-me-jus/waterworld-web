import * as THREE from 'three'
import { Sky } from 'three/addons/objects/Sky.js'
import type { Climate } from './climate'

export type SkyRig = {
  sky: Sky
  clouds: THREE.Mesh
  stars: THREE.Points
  sunDir: THREE.Vector3
  sunLight: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  horizonColor: THREE.Color
  /** Baseline hemisphere colours — the frame loop restores from these in air. */
  dayHemiSky: THREE.Color
  dayHemiGround: THREE.Color
  update: (time: number, climate: Climate) => void
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

const DAY_HORIZON = new THREE.Color('#8fb3c9')
const DUSK_HORIZON = new THREE.Color('#c48a6a')
const NIGHT_HORIZON = new THREE.Color('#0c1a28')
const STORM_HORIZON = new THREE.Color('#3a4650')

const DAY_CLOUD = new THREE.Color('#f6f1e6')
const DAY_CLOUD_SHADOW = new THREE.Color('#5d7c94')
const STORM_CLOUD = new THREE.Color('#8a9198')
const STORM_CLOUD_SHADOW = new THREE.Color('#2a3238')
const NIGHT_CLOUD = new THREE.Color('#1a222c')
const NIGHT_CLOUD_SHADOW = new THREE.Color('#05080c')

/** Sky dome + drifting cloud layer + matched sun/ambient lights. */
export function createSky(scene: THREE.Scene, elevationDeg = 30, azimuthDeg = 155): SkyRig {
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

  // A handful of stars — only matter once the day has gone
  const starCount = 600
  const starPos = new Float32Array(starCount * 3)
  for (let i = 0; i < starCount; i++) {
    // Hemisphere above the horizon
    const u = Math.random()
    const v = Math.random()
    const theta = u * Math.PI * 2
    const phi = Math.acos(0.05 + v * 0.95)
    const r = 4500
    starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    starPos[i * 3 + 1] = r * Math.cos(phi)
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
  const starMat = new THREE.PointsMaterial({
    color: 0xd8e6f4,
    size: 3.5,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  })
  const stars = new THREE.Points(starGeo, starMat)
  stars.frustumCulled = false
  stars.renderOrder = 0
  scene.add(stars)

  const horizonColor = DAY_HORIZON.clone()
  const dayHemiSky = new THREE.Color(0x9dc6e8)
  const dayHemiGround = new THREE.Color(0x07202b)
  const scratch = new THREE.Color()
  const sunTint = new THREE.Color()

  return {
    sky,
    clouds,
    stars,
    sunDir,
    sunLight,
    hemi,
    horizonColor,
    dayHemiSky,
    dayHemiGround,
    update(time: number, climate: Climate) {
      cloudMat.uniforms.uTime.value = time

      sunDir.setFromSphericalCoords(
        1,
        THREE.MathUtils.degToRad(90 - climate.sunElevation),
        THREE.MathUtils.degToRad(climate.sunAzimuth),
      )
      u['sunPosition'].value.copy(sunDir)
      cloudMat.uniforms.uSunDir.value.copy(sunDir)
      sunLight.position.copy(sunDir).multiplyScalar(200)

      const day = climate.daylight
      const storm = climate.storm
      const dusk = THREE.MathUtils.clamp(1 - Math.abs(climate.sunElevation - 4) / 14, 0, 1)

      // Horizon: day → dusk blush → night, then storm greys it out.
      // Floor the night mix so the sky never goes pure black — open ocean
      // at midnight still needs a readable horizon.
      const nightAmt = Math.min(0.82, 1 - day)
      scratch.copy(DAY_HORIZON).lerp(NIGHT_HORIZON, nightAmt)
      scratch.lerp(DUSK_HORIZON, dusk * Math.max(day, 0.15) * 0.7)
      scratch.lerp(STORM_HORIZON, storm * 0.75)
      horizonColor.copy(scratch)

      // Physical sky params — storms muddy the air, night drops the scatter
      u['turbidity'].value = THREE.MathUtils.lerp(1.2, 12, storm) + (1 - day) * 2.5
      u['rayleigh'].value = THREE.MathUtils.lerp(0.35, 1.7, day) * (1 - storm * 0.55)
      u['mieCoefficient'].value = 0.002 + storm * 0.018 + (1 - day) * 0.004

      // Cloud deck: lower uCover = more cloud. Storms fill the sky.
      cloudMat.uniforms.uCover.value = THREE.MathUtils.lerp(0.62, 0.12, storm)
      cloudMat.uniforms.uTint.value
        .copy(DAY_CLOUD)
        .lerp(NIGHT_CLOUD, 1 - day)
        .lerp(STORM_CLOUD, storm)
      cloudMat.uniforms.uShadow.value
        .copy(DAY_CLOUD_SHADOW)
        .lerp(NIGHT_CLOUD_SHADOW, 1 - day)
        .lerp(STORM_CLOUD_SHADOW, storm)
      cloudMat.uniforms.uOpacity.value = THREE.MathUtils.lerp(0.55, 1, Math.max(storm, 1 - day * 0.5))

      // Lights — night keeps a thin moon fill so the wreck silhouette still reads
      const sunUp = Math.max(0, climate.sunElevation / 62)
      sunLight.intensity = THREE.MathUtils.lerp(0.15, 2.6, sunUp * sunUp) * (1 - storm * 0.6)
      sunTint.setRGB(1, 0.94, 0.83).lerp(new THREE.Color('#8a9bb8'), 1 - day)
      sunTint.lerp(new THREE.Color('#c8d0d6'), storm * 0.5)
      sunLight.color.copy(sunTint)

      dayHemiSky.setRGB(0.62, 0.78, 0.91).lerp(new THREE.Color('#1a2838'), 1 - day)
      dayHemiSky.lerp(new THREE.Color('#3a4550'), storm * 0.55)
      dayHemiGround.setRGB(0.03, 0.125, 0.17).lerp(new THREE.Color('#050a10'), 1 - day)
      hemi.intensity = THREE.MathUtils.lerp(0.22, 0.5, day) * (1 - storm * 0.3)

      // Stars fade in after dusk, wash out under a storm
      starMat.opacity = Math.max(0, (1 - day) * 0.95 - storm * 0.7)
      stars.visible = starMat.opacity > 0.02
    },
  }
}
