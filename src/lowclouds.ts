import * as THREE from 'three'

/**
 * Fair-weather cumulus a couple of hundred metres up, scattered round the
 * island. From the sea they'd only crowd the sky the dome already paints, so
 * they fade in as the eye climbs: they're for the parachute and the climb,
 * where a puff sliding past underneath is what tells you how high you are.
 *
 * Each cloud is a cluster of soft billboards — one instanced quad, its shape
 * all in the fragment shader: a lumpy disc, lit from the sun's side, grey
 * underneath, warm at dusk. Puffs within a hundred metres of the lens fade
 * away, so flying past one never turns into a white-out or a wall of quads.
 */

const vertex = /* glsl */ `
attribute vec4 aPuff; // xyz centre, w radius
attribute float aSeed;
uniform float uTime;
uniform vec2 uDrift;
varying vec2 vUv;
varying float vSeed;
varying vec3 vCentre;
varying float vDist;
varying float vLow;

void main() {
  vec3 c = aPuff.xyz + vec3(uDrift.x, 0.0, uDrift.y) * uTime;
  // Billboard: spread the quad across the camera's right and up
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 world = c + (right * position.x + up * position.y) * aPuff.w;
  vUv = position.xy;
  vSeed = aSeed;
  vCentre = c;
  // How low in its cloud this corner sits — the base is flat and grey
  vLow = clamp(-position.y * 0.5 + 0.5, 0.0, 1.0);
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`

const fragment = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShade;
uniform float uFade;
uniform vec3 uIslandCentre;
varying vec2 vUv;
varying float vSeed;
varying vec3 vCentre;
varying float vDist;
varying float vLow;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 p = vUv;
  float r = length(p);
  // Lumpy edge: the disc's radius wobbles with angle and a little noise
  float a = atan(p.y, p.x);
  float edge = 0.78 + 0.12 * sin(a * 3.0 + vSeed * 9.0) + 0.1 * noise(p * 3.5 + vSeed * 17.0);
  float body = 1.0 - smoothstep(edge - 0.35, edge, r);
  // Cumulus have flat bases
  body *= smoothstep(-0.75, -0.45, p.y);
  float detail = noise(p * 6.0 + vSeed * 31.0) * 0.5 + noise(p * 12.0 - vSeed * 7.0) * 0.25;
  float alpha = body * (0.55 + detail * 0.6);
  // Lit side toward the sun, shaded base
  vec3 n = normalize(vec3(p, sqrt(max(0.0, 1.0 - r * r)) + 0.2));
  float lit = clamp(0.72 + 0.3 * (p.y * 0.8 + dot(normalize(uSunDir.xz + 0.0001), p) * 0.3), 0.0, 1.0);
  vec3 col = mix(uShade, uSunColor, lit * (1.0 - vLow * 0.45));
  col *= 0.92 + detail * 0.16;
  // Fade well before the lens: a puff beside the camera veils half the frame,
  // and the drop starts inside the cloud band. They slide past, never over.
  alpha *= smoothstep(65.0, 180.0, length(vCentre - cameraPosition)) * uFade;
  // Keep a broad window onto the island. Side clouds still give the descent
  // scale, but a billboard between the eye and the beach must not hide it.
  vec3 sight = uIslandCentre - cameraPosition;
  float along = dot(vCentre - cameraPosition, sight) / max(dot(sight, sight), 1.0);
  vec3 nearest = cameraPosition + sight * clamp(along, 0.0, 1.0);
  float corridor = 1.0 - smoothstep(100.0, 270.0, length(vCentre - nearest));
  float inFront = smoothstep(-0.1, 0.1, along) * (1.0 - smoothstep(0.8, 1.2, along));
  alpha *= 1.0 - corridor * inFront * 0.96;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export function createLowClouds(scene: THREE.Scene, centre: THREE.Vector3, low: boolean) {
  const clouds = low ? 26 : 48
  const puffsPer = low ? 6 : 9
  const count = clouds * puffsPer
  const base = new THREE.PlaneGeometry(2, 2)
  const geo = new THREE.InstancedBufferGeometry()
  geo.index = base.index
  geo.setAttribute('position', base.getAttribute('position'))
  const puffs = new Float32Array(count * 4)
  const seeds = new Float32Array(count)
  let s = 7
  const rand = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
  let k = 0
  for (let c = 0; c < clouds; c++) {
    // Round the island out to two kilometres, a few right over it
    const a = rand() * Math.PI * 2
    const d = 150 + Math.sqrt(rand()) * 1900
    const cx = centre.x + Math.cos(a) * d
    const cz = centre.z + Math.sin(a) * d
    const cy = 190 + rand() * 140
    const size = 35 + rand() * 45
    for (let p = 0; p < puffsPer; p++) {
      const t = p / puffsPer
      // Big puffs low and central, smaller ones heaped on top and round the sides
      puffs[k * 4] = cx + (rand() - 0.5) * size * 1.6
      puffs[k * 4 + 1] = cy + t * size * 0.5 + rand() * size * 0.2
      puffs[k * 4 + 2] = cz + (rand() - 0.5) * size * 1.6
      puffs[k * 4 + 3] = size * (0.55 + (1 - t) * 0.35 + rand() * 0.2)
      seeds[k] = rand()
      k++
    }
  }
  geo.setAttribute('aPuff', new THREE.InstancedBufferAttribute(puffs, 4))
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1))
  geo.instanceCount = count

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uDrift: { value: new THREE.Vector2(0.9, 0.6) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uShade: { value: new THREE.Color(0.55, 0.62, 0.7) },
      uFade: { value: 0 },
      uIslandCentre: { value: new THREE.Vector3(centre.x, 35, centre.z) },
    },
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    fog: false,
  })
  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 6
  mesh.visible = false
  scene.add(mesh)

  /**
   * `tint`/`shadow` are the sky dome's own cloud colours, so these match its
   * deck. By day they are lifted: lit cloud is the brightest thing under the
   * sun, and at the short midday exposure plain white tone-maps to grey.
   */
  function update(time: number, camera: THREE.Camera, sunDir: THREE.Vector3, tint: THREE.Color, shadow: THREE.Color, daylight: number) {
    const fade = THREE.MathUtils.smoothstep(camera.position.y, 60, 150)
    mesh.visible = fade > 0.01
    if (!mesh.visible) return
    material.uniforms.uTime.value = time
    material.uniforms.uFade.value = fade
    material.uniforms.uSunDir.value.copy(sunDir)
    const lift = 1 + 1.5 * THREE.MathUtils.smoothstep(daylight, 0.45, 0.9)
    material.uniforms.uSunColor.value.copy(tint).multiplyScalar(lift)
    material.uniforms.uShade.value.copy(shadow).multiplyScalar(lift)
  }

  return { mesh, update }
}
