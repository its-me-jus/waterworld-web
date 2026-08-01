import * as THREE from 'three'
import { sampleOcean } from './waves'

/**
 * Soft foam along the island waterline. The ocean mesh used to end in a hard
 * cut against the sand; a ring of soft elongated patches riding the swell
 * sells the beach instead — a lap, not a row of hard discs.
 */

export type ShoreSurfOptions = {
  centre: THREE.Vector3
  heightAt: (x: number, z: number) => number
  lowPower?: boolean
}

type Flake = {
  x: number
  z: number
  /** Outward from the island — used to stretch the patch along the beach. */
  dx: number
  dz: number
  phase: number
  size: number
  /** How far offshore this patch sits, for staggered lap timing. */
  reach: number
}

/** Soft radial falloff so patches dissolve instead of reading as discs. */
function softFoamTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context missing')

  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,0.95)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)')
  g.addColorStop(0.7, 'rgba(255,255,255,0.12)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

export function createShoreSurf(scene: THREE.Scene, opts: ShoreSurfOptions) {
  const low = opts.lowPower ?? false
  const flakes: Flake[] = []
  const max = low ? 280 : 520

  const push = (x: number, z: number, dx: number, dz: number, reach: number) => {
    if (flakes.length >= max) return
    const ox = x + dx * reach
    const oz = z + dz * reach
    const h = opts.heightAt(ox, oz)
    if (h > 1.2 || h < -8) return
    flakes.push({
      x: ox,
      z: oz,
      dx,
      dz,
      phase: Math.random() * Math.PI * 2,
      size: 1.6 + Math.random() * 2.8,
      reach,
    })
  }

  const rays = low ? 120 : 220
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
        const bx = opts.centre.x + dx * at
        const bz = opts.centre.z + dz * at
        // A band of patches at staggered reaches — the lap advances and retreats
        push(bx, bz, dx, dz, 0.4 + Math.random() * 1.1)
        push(bx, bz, dx, dz, 1.8 + Math.random() * 1.8)
        if (!low) {
          push(bx, bz, dx, dz, 3.4 + Math.random() * 2.4)
          // Slight along-shore jitter so the line isn't a picket fence
          const jx = -dz * (Math.random() - 0.5) * 4
          const jz = dx * (Math.random() - 0.5) * 4
          push(bx + jx, bz + jz, dx, dz, 1.0 + Math.random() * 2.0)
        }
        break
      }
      prev = h
    }
  }

  const geo = new THREE.PlaneGeometry(1, 1)
  geo.rotateX(-Math.PI / 2)
  const mat = new THREE.MeshBasicMaterial({
    map: softFoamTexture(),
    color: 0xf2f8fc,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    depthTest: true,
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
  const yaw = new THREE.Quaternion()
  const along = new THREE.Vector3()
  const east = new THREE.Vector3(1, 0, 0)

  function update(time: number, camera: THREE.Camera, underwater: boolean) {
    const near = camera.position.distanceToSquared(opts.centre) < 560 * 560
    mesh.visible = near && !underwater && flakes.length > 0
    if (!mesh.visible) return

    for (let i = 0; i < flakes.length; i++) {
      const f = flakes[i]
      const water = sampleOcean(f.x, f.z, time)
      const ground = opts.heightAt(f.x, f.z)
      // Never plant foam on dry sand — hide the instance by collapsing it
      if (ground > water.y + 0.25) {
        dummy.scale.setScalar(0)
        dummy.position.set(f.x, water.y, f.z)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        continue
      }

      // Slow lap: outer patches crest later than the ones against the sand
      const lap = 0.55 + 0.45 * Math.sin(time * 1.35 - f.reach * 0.55 + f.phase)
      const breath = 0.85 + 0.15 * Math.sin(time * 0.7 + f.phase * 0.5)
      dummy.position.set(f.x, water.y + 0.06, f.z)

      waveUp.set(water.normal.x, water.normal.y, water.normal.z)
      tilt.setFromUnitVectors(up, waveUp)
      // Stretch along the beach (perpendicular to outward normal)
      along.set(-f.dz, 0, f.dx).normalize()
      yaw.setFromUnitVectors(east, along)
      dummy.quaternion.copy(tilt).multiply(yaw)

      const alongLen = f.size * (2.0 + lap * 0.9) * breath
      const outLen = f.size * (0.28 + lap * 0.4)
      dummy.scale.set(alongLen, 1, outLen)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    mat.opacity = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(time * 1.15))
  }

  return { mesh, update, count: flakes.length }
}

export type ShoreSurf = ReturnType<typeof createShoreSurf>
