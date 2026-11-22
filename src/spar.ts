import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { skyFillUniform } from './skyfill'
import { chopScale, sampleOcean } from './waves'

export type SparBuoy = {
  group: THREE.Group
  update: (time: number, eye?: THREE.Vector3) => void
  position: { x: number; z: number }
}

/** The dark mast and barrel keep their outline in the haze and while the model loads. */
function distantMarker() {
  const body = new THREE.CylinderGeometry(0.53, 0.53, 1.64, 10)
  body.rotateZ(Math.PI / 2).translate(0, 0.14, 0)
  const mast = new THREE.CylinderGeometry(0.052, 0.086, 4.65, 6)
  mast.translate(0, 2.635, 0)
  const yard = new THREE.CylinderGeometry(0.032, 0.032, 1.81, 5)
  yard.rotateZ(Math.PI / 2).translate(0.075, 4.44, 0)
  const shape = mergeGeometries([body, mast, yard])
  return new THREE.Mesh(shape, new THREE.MeshStandardMaterial({ color: 0x8c7153, roughness: 0.94 }))
}

/** Long grain runs around the staves and up the mast; the cask's tide stain cuts across it. */
function weatherTimber(material: THREE.MeshStandardMaterial) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uSparSky = skyFillUniform
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSparWood;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSparWood = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSparWood;\nuniform float uSparSky;')
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        vec3 p = vSparWood;
        float stave = atan(p.y - 0.14, p.z);
        float barrel = 1.0 - smoothstep(0.67, 0.73, p.y);
        float mast = (1.0 - smoothstep(0.066, 0.093, length(p.xz))) * (1.0 - barrel);
        float crossGrain = mix(atan(p.z, p.x) * 0.23, stave, barrel);
        crossGrain = mix(crossGrain, p.y * 2.0, barrel * smoothstep(0.80, 0.81, abs(p.x)));
        float along = mix(p.y, p.x, barrel);
        float figure = sin(crossGrain * 11.0 + along * 2.4) + 0.5 * sin(crossGrain * 27.0 - along);
        float phase = crossGrain * 104.0 + figure * 1.8 + 0.5 * sin(along * 7.0);
        float grain = smoothstep(0.45, 0.94, sin(phase)) * (1.0 - smoothstep(0.45, 2.4, fwidth(phase)));
        float wetEdge = 0.15 + 0.035 * sin(p.x * 14.0 + p.z) + 0.02 * sin(p.x * 27.0);
        float soaked = barrel * (1.0 - smoothstep(wetEdge - 0.09, wetEdge + 0.04, p.y));
        diffuseColor.rgb *= 1.0 + (barrel + mast) * (0.035 * figure - 0.20 * grain);
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.66, 0.75, 0.67), soaked);
      `)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.17, 0.18, 0.19) * uSparSky;')
  }
}

/** A scrap hung by its top edge. Two old tears divide the hem into loose tongues. */
function makePennant() {
  const cols = 16
  const rows = 8
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const ochre = new THREE.Color(0xb19168)
  const flax = new THREE.Color(0xe4d3a9)
  const color = new THREE.Color()
  for (let j = 0; j <= rows; j++) {
    const v = j / rows
    for (let i = 0; i <= cols; i++) {
      const u = i / cols
      const nick = i === 4 ? 0.15 : i === 12 ? 0.22 : 0
      const drop = 0.48 + 0.10 * u + 0.035 * Math.sin(i * 2.5) - nick
      const sag = 0.035 * Math.abs(Math.sin(2 * Math.PI * u))
      positions.push(0.10 + u * 0.82, 4.428 - 0.025 * u - sag - v * drop, -0.016)
      const stain = 0.32 * v + 0.13 * Math.sin(i * 2.7 + v) + 0.16 * Math.cos(u * 9 + v * 5)
      color.copy(flax).lerp(ochre, THREE.MathUtils.clamp(stain, 0, 0.8))
      colors.push(color.r, color.g, color.b)
      if (i === cols || j === rows) continue
      const a = j * (cols + 1) + i
      const b = a + 1, c = a + cols + 1, d = c + 1
      if (!(i === 11 && j === 6)) indices.push(a, c, b)
      if (!(i === 3 && j === 7)) indices.push(b, c, d)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const material = new THREE.MeshStandardMaterial({
    side: THREE.DoubleSide, vertexColors: true, flatShading: true, roughness: 1,
  })
  const clock = { value: 0 }
  const gust = { value: 0 }
  material.onBeforeCompile = shader => {
    shader.uniforms.uSparTime = clock
    shader.uniforms.uSparWind = gust
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uSparTime;\nuniform float uSparWind;')
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        float loose = smoothstep(0.075, 0.54, 4.43 - position.y);
        float phase = position.x * 8.0 - uSparTime * (2.1 + uSparWind);
        float ripple = sin(phase) + 0.32 * sin(phase * 1.8 + position.y * 6.0);
        transformed.z += loose * (0.12 + ripple * (0.085 + 0.045 * uSparWind));
        transformed.y += loose * (0.035 + 0.028 * ripple);
      `)
  }
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'sparRag'
  geometry.computeBoundingSphere()
  geometry.boundingSphere!.radius += 0.32
  return { mesh, clock, gust }
}

/** The water is drawn in triangles several metres wide. Follow the same three
 * wave vertices in all axes so the barrel sits in its face as a crest passes. */
function waterlineSupports(x: number, z: number, step: number) {
  const x0 = Math.floor(x / step) * step, z0 = Math.floor(z / step) * step
  const u = (x - x0) / step, v = (z - z0) / step
  return u + v <= 1 ? [
    { x: x0, z: z0, weight: 1 - u - v },
    { x: x0 + step, z: z0, weight: u },
    { x: x0, z: z0 + step, weight: v },
  ] : [
    { x: x0 + step, z: z0, weight: 1 - v },
    { x: x0, z: z0 + step, weight: 1 - u },
    { x: x0 + step, z: z0 + step, weight: u + v - 1 },
  ]
}

export function createSparBuoy(scene: THREE.Scene, opts: { x: number; z: number; gridStep?: number }): SparBuoy {
  const group = new THREE.Group()
  group.name = 'sparBuoy'
  group.position.set(opts.x, 0, opts.z)
  group.rotation.order = 'YXZ'
  const proxy = distantMarker()
  const flag = makePennant()
  group.add(proxy, flag.mesh)
  scene.add(group)

  let model: THREE.Group | undefined
  let requested = false
  let close = false
  const supports = opts.gridStep ? waterlineSupports(opts.x, opts.z, opts.gridStep) : [{ ...opts, weight: 1 }]
  const orbit = { x: 0, z: 0 }
  return {
    group,
    position: { x: opts.x, z: opts.z },
    update(time, eye) {
      const distanceSq = eye ? (eye.x - opts.x) ** 2 + (eye.z - opts.z) ** 2 : 0
      close = distanceSq < (close ? 115 ** 2 : 100 ** 2)
      if (!requested && distanceSq < 150 ** 2) {
        requested = true
        new GLTFLoader().load(`${import.meta.env.BASE_URL}props/spar-buoy.glb`, gltf => {
          model = gltf.scene
          model.name = 'Coopered spar'
          model.traverse(node => {
            if (node instanceof THREE.Mesh && node.material.name === 'Oak, hemp and shell') {
              weatherTimber(node.material)
            }
          })
          model.visible = close
          proxy.visible = !close
          group.add(model)
        }, undefined, () => { /* Keep the marker visible if the connection drops. */ })
      }
      if (model) {
        model.visible = close
        proxy.visible = !close
      }
      group.position.set(opts.x, -0.10, opts.z)
      group.rotation.x = group.rotation.z = 0
      for (const support of supports) {
        const sea = sampleOcean(support.x, support.z, time, undefined, orbit)
        group.position.x += support.weight * orbit.x
        group.position.y += support.weight * sea.y
        group.position.z += support.weight * orbit.z
        group.rotation.x += support.weight * sea.normal.z * 0.4
        group.rotation.z -= support.weight * sea.normal.x * 0.4
      }
      group.rotation.y = Math.sin(time * 0.11) * 0.35
      flag.clock.value = time
      flag.gust.value = THREE.MathUtils.clamp((chopScale - 1) / 2.1, 0, 1)
    },
  }
}
