import * as THREE from 'three'
import { Sky } from 'three/addons/objects/Sky.js'

export type SkyRig = {
  sky: Sky
  clouds: THREE.Mesh
  sunDir: THREE.Vector3
  sunLight: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  horizonColor: THREE.Color
  update: (time: number) => void
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
  float alpha = mix(wispy * 0.45, cover, 0.75) * horizonFade * topFade * 0.9;

  gl_FragColor = vec4(col, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** Sky dome + drifting cloud layer + matched sun/ambient lights. */
export function createSky(scene: THREE.Scene, elevationDeg = 14, azimuthDeg = 155): SkyRig {
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
      uTint: { value: new THREE.Color('#f6f1e6') },
      uShadow: { value: new THREE.Color('#5d7c94') },
      uCover: { value: 0.58 },
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

  const horizonColor = new THREE.Color('#8fb3c9')

  return {
    sky,
    clouds,
    sunDir,
    sunLight,
    hemi,
    horizonColor,
    update(time: number) {
      cloudMat.uniforms.uTime.value = time
    },
  }
}
