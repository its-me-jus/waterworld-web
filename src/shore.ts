import * as THREE from 'three'
import { sampleOcean } from './waves'

/**
 * Soft foam along the island waterline. The ocean mesh ends in a hard cut
 * against the sand; a ring of discs riding the swell sells the beach instead.
 */

export type ShoreSurfOptions = {
  centre: THREE.Vector3
  heightAt: (x: number, z: number) => number
  lowPower?: boolean
}

type Flake = {
  x: number
  z: number
  phase: number
  size: number
}

export function createShoreSurf(scene: THREE.Scene, opts: ShoreSurfOptions) {
  const low = opts.lowPower ?? false
  const flakes: Flake[] = []
  const max = low ? 160 : 280

  const push = (x: number, z: number, dx: number, dz: number) => {
    if (flakes.length >= max) return
    // Sit just offshore so the disc floats on water, not on sand
    const ox = x + dx * (2 + Math.random() * 5)
    const oz = z + dz * (2 + Math.random() * 5)
    const h = opts.heightAt(ox, oz)
    if (h > 1.5 || h < -10) return
    flakes.push({
      x: ox,
      z: oz,
      phase: Math.random() * Math.PI * 2,
      size: 1.8 + Math.random() * 3.2,
    })
  }

  const rays = low ? 100 : 180
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2
    const dx = Math.cos(angle)
    const dz = Math.sin(angle)
    let prev = opts.heightAt(opts.centre.x + dx * 100, opts.centre.z + dz * 100)
    for (let r = 110; r < 430; r += 5) {
      const x = opts.centre.x + dx * r
      const z = opts.centre.z + dz * r
      const h = opts.heightAt(x, z)
      if (prev > 0.8 && h <= 0.8) {
        const t = (prev - 0.8) / (prev - h + 1e-4)
        const at = r - 5 + 5 * t
        push(opts.centre.x + dx * at, opts.centre.z + dz * at, dx, dz)
        if (!low) push(opts.centre.x + dx * at, opts.centre.z + dz * at, dx, dz)
        break
      }
      prev = h
    }
  }

  // Soft disc — reads as a foam patch, not a hard rectangle
  const geo = new THREE.CircleGeometry(0.5, low ? 8 : 12)
  geo.rotateX(-Math.PI / 2)
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    depthTest: false,
    fog: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, flakes.length))
  mesh.name = 'ShoreSurf'
  mesh.frustumCulled = false
  mesh.renderOrder = 4
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  scene.add(mesh)

  const dummy = new THREE.Object3D()
  const up = new THREE.Vector3(0, 1, 0)
  const waveUp = new THREE.Vector3()
  const tilt = new THREE.Quaternion()

  function update(time: number, camera: THREE.Camera, underwater: boolean) {
    const near = camera.position.distanceToSquared(opts.centre) < 560 * 560
    mesh.visible = near && !underwater && flakes.length > 0
    if (!mesh.visible) return

    for (let i = 0; i < flakes.length; i++) {
      const f = flakes[i]
      const water = sampleOcean(f.x, f.z, time)
      const ground = opts.heightAt(f.x, f.z)
      // Never plant foam on dry sand — hide the instance by collapsing it
      if (ground > water.y + 0.35) {
        dummy.scale.setScalar(0)
        dummy.position.set(f.x, water.y, f.z)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        continue
      }
      const pulse = 0.75 + 0.25 * Math.sin(time * 2.4 + f.phase)
      dummy.position.set(f.x, water.y + 0.12, f.z)
      waveUp.set(water.normal.x, water.normal.y, water.normal.z)
      tilt.setFromUnitVectors(up, waveUp)
      dummy.quaternion.copy(tilt)
      const s = f.size * pulse * 1.35
      dummy.scale.set(s, 1, s * (0.5 + 0.2 * Math.sin(time * 1.1 + f.phase)))
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    mat.opacity = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(time * 1.4))
  }

  return { mesh, update, count: flakes.length }
}

export type ShoreSurf = ReturnType<typeof createShoreSurf>
