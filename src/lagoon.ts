import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { oceanState } from './waves'

/** Resident shoals in the landing cove. They belong to places, not the camera. */
export function createLagoonLife(scene: THREE.Scene, opts: {
  beach: THREE.Vector3
  wreck: THREE.Vector3
  heightAt: (x: number, z: number) => number
  lowPower: boolean
}) {
  let seed = 9281
  const rand = () => ((seed = seed * 16807 % 2147483647) - 1) / 2147483646
  const body = new THREE.SphereGeometry(1, 9, 6)
  body.scale(0.22, 0.07, 0.045)
  const tail = new THREE.BufferGeometry()
  tail.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.17, 0, 0, -0.34, 0.11, 0, -0.29, 0, 0,
    -0.17, 0, 0, -0.29, 0, 0, -0.34, -0.10, 0,
    0.02, 0.05, 0, -0.10, 0.13, 0, -0.15, 0.04, 0,
  ], 3))
  tail.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(18), 2))
  tail.computeVertexNormals()
  const geometry = mergeGeometries([body.toNonIndexed(), tail])!
  const fishPer = opts.lowPower ? 18 : 32
  const count = fishPer * 3
  const phases = new Float32Array(count)
  for (let i = 0; i < count; i++) phases[i] = rand() * Math.PI * 2
  geometry.setAttribute('aFishPhase', new THREE.InstancedBufferAttribute(phases, 1))
  const clock = { value: 0 }
  const material = new THREE.MeshStandardMaterial({
    color: '#d2e9df', roughness: 0.38, metalness: 0.25, side: THREE.DoubleSide,
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uShoalTime = clock
    shader.vertexShader = 'uniform float uShoalTime;\nattribute float aFishPhase;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      float tailWeight = smoothstep(0.06, 0.34, -position.x);
      transformed.z += sin(uShoalTime * 7.0 + aFishPhase + position.x * 11.0) * tailWeight * 0.055;
    `)
  }
  const fish = new THREE.InstancedMesh(geometry, material, count)
  fish.name = 'LandingCoveShoals'
  fish.frustumCulled = false
  fish.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  fish.userData.noCast = true
  const tint = new THREE.Color()
  const schools = [0.26, 0.48, 0.67].map((t, i) => ({
    x: THREE.MathUtils.lerp(opts.beach.x, opts.wreck.x, t),
    z: THREE.MathUtils.lerp(opts.beach.z, opts.wreck.z, t),
    radius: 3.3 + i * 1.5,
    depth: 1.3 + i * 0.65,
  }))
  const members = Array.from({ length: count }, (_, i) => {
    const warm = i % 7 === 0
    tint.set(warm ? '#cbb46a' : i % 3 === 0 ? '#728e8d' : '#b4d2ca')
    fish.setColorAt(i, tint)
    return { phase: phases[i], spread: 0.45 + rand() * 0.7, size: 0.65 + rand() * 0.6, bed: -20, y: 0, ready: false }
  })
  const dummy = new THREE.Object3D()
  let bedTick = 0
  scene.add(fish)

  function update(dt: number, time: number, camera: THREE.Camera, daylight: number) {
    const near = schools.some(s => Math.hypot(camera.position.x - s.x, camera.position.z - s.z) < 105)
    fish.visible = near && camera.position.y < 22 && daylight > 0.08
    if (!fish.visible) return
    clock.value = time
    bedTick -= dt
    const sampleBed = bedTick <= 0
    if (sampleBed) bedTick = 0.18
    for (let i = 0; i < count; i++) {
      const school = schools[Math.floor(i / fishPer)]
      const f = members[i]
      const a = time * (0.17 + Math.floor(i / fishPer) * 0.025) + f.phase * 0.22
      const spread = f.spread * school.radius
      const x = school.x + Math.cos(a) * spread + Math.sin(f.phase * 7) * 0.6
      const z = school.z + Math.sin(a) * spread * 0.58 + Math.cos(f.phase * 3) * 0.5
      if (sampleBed || !f.ready) f.bed = opts.heightAt(x, z)
      const water = oceanState.tide
      const target = Math.max(f.bed + 0.42, water - school.depth + Math.sin(time * 0.8 + f.phase) * 0.22)
      f.y = f.ready ? THREE.MathUtils.damp(f.y, target, 7, dt) : target
      f.ready = true
      dummy.position.set(x, Math.max(f.bed + 0.22, f.y), z)
      dummy.rotation.set(0, Math.atan2(-Math.cos(a) * 0.58, -Math.sin(a)), Math.cos(time + f.phase) * 0.04)
      // Hide residents when a low tide bares their patch instead of floating over sand.
      dummy.scale.setScalar(f.bed < water - 0.8 ? f.size : 0)
      dummy.updateMatrix()
      fish.setMatrixAt(i, dummy.matrix)
    }
    fish.instanceMatrix.needsUpdate = true
  }
  return { update, fish, count }
}
