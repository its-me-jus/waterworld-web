import * as THREE from 'three'
import { oceanState, sampleOcean } from './waves'

/**
 * Soft foam along the island waterline. The ocean mesh used to end in a hard
 * cut against the sand; a band of soft elongated patches riding the swell
 * sells the beach instead — a lap and a lace of white, not a row of discs.
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
  /** Soft sheet (0) vs bright lace (1). */
  kind: 0 | 1
}

/** Soft elliptical falloff — stretches into lace when the instance is long. */
function softFoamTexture(lace: boolean) {
  const size = 96
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context missing')

  const img = ctx.createImageData(size, size)
  const half = (size - 1) * 0.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x - half) / half
      const ny = (y - half) / half
      // Wider along X so along-shore stretch reads as a ribbon, not a blob
      const d = Math.hypot(nx * 0.62, ny * 1.15)
      let a = 1 - Math.min(1, d)
      a = a * a * (3 - 2 * a)
      if (lace) {
        // Feathered edge so the lace breaks into soft white
        const edge = Math.sin(nx * 9.4 + ny * 5.1) * 0.5 + 0.5
        a *= 0.55 + edge * 0.55
        a = Math.pow(Math.max(0, a), 1.35)
      } else {
        a = Math.pow(Math.max(0, a), 1.15) * 0.85
      }
      const i = (y * size + x) * 4
      const v = lace ? 255 : 245
      img.data[i] = v
      img.data[i + 1] = v
      img.data[i + 2] = lace ? 255 : 250
      img.data[i + 3] = Math.floor(a * 255)
    }
  }
  ctx.putImageData(img, 0, 0)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

function foamMaterial(map: THREE.Texture, opacity: number) {
  return new THREE.MeshBasicMaterial({
    map,
    color: 0xf4f9fc,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: true,
    fog: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  })
}

export function createShoreSurf(scene: THREE.Scene, opts: ShoreSurfOptions) {
  const low = opts.lowPower ?? false
  const flakes: Flake[] = []
  const max = low ? 360 : 780

  const push = (
    x: number,
    z: number,
    dx: number,
    dz: number,
    reach: number,
    kind: 0 | 1,
  ) => {
    if (flakes.length >= max) return
    const ox = x + dx * reach
    const oz = z + dz * reach
    const h = opts.heightAt(ox, oz)
    if (h > 1.4 || h < -9) return
    flakes.push({
      x: ox,
      z: oz,
      dx,
      dz,
      phase: Math.random() * Math.PI * 2,
      size: kind === 0 ? 2.2 + Math.random() * 3.4 : 1.2 + Math.random() * 2.2,
      reach,
      kind,
    })
  }

  const rays = low ? 140 : 260
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2
    const dx = Math.cos(angle)
    const dz = Math.sin(angle)
    let prev = opts.heightAt(opts.centre.x + dx * 100, opts.centre.z + dz * 100)
    for (let r = 110; r < 430; r += 4) {
      const x = opts.centre.x + dx * r
      const z = opts.centre.z + dz * r
      const h = opts.heightAt(x, z)
      if (prev > 0.75 && h <= 0.75) {
        const t = (prev - 0.75) / (prev - h + 1e-4)
        const at = r - 4 + 4 * t
        const bx = opts.centre.x + dx * at
        const bz = opts.centre.z + dz * at
        // Soft sheet against the sand — the body of the lap
        push(bx, bz, dx, dz, 0.25 + Math.random() * 0.9, 0)
        push(bx, bz, dx, dz, 1.4 + Math.random() * 1.6, 0)
        // Brighter lace slightly out — the lip that breaks
        push(bx, bz, dx, dz, 0.8 + Math.random() * 1.2, 1)
        if (!low) {
          push(bx, bz, dx, dz, 2.8 + Math.random() * 2.2, 0)
          push(bx, bz, dx, dz, 2.0 + Math.random() * 2.0, 1)
          // Along-shore jitter so the line isn't a picket fence
          const jx = -dz * (Math.random() - 0.5) * 5
          const jz = dx * (Math.random() - 0.5) * 5
          push(bx + jx, bz + jz, dx, dz, 0.6 + Math.random() * 2.2, Math.random() > 0.45 ? 1 : 0)
        }
        break
      }
      prev = h
    }
  }

  const sheets = flakes.filter((f) => f.kind === 0)
  const lace = flakes.filter((f) => f.kind === 1)

  const geo = new THREE.PlaneGeometry(1, 1)
  geo.rotateX(-Math.PI / 2)

  const sheetMat = foamMaterial(softFoamTexture(false), 0.7)
  const laceMat = foamMaterial(softFoamTexture(true), 0.9)

  const sheetMesh = new THREE.InstancedMesh(geo, sheetMat, Math.max(1, sheets.length))
  sheetMesh.name = 'ShoreSurfSheet'
  sheetMesh.frustumCulled = false
  sheetMesh.renderOrder = 4
  sheetMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  scene.add(sheetMesh)

  const laceMesh = new THREE.InstancedMesh(geo, laceMat, Math.max(1, lace.length))
  laceMesh.name = 'ShoreSurfLace'
  laceMesh.frustumCulled = false
  laceMesh.renderOrder = 5
  laceMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  scene.add(laceMesh)

  const dummy = new THREE.Object3D()
  const up = new THREE.Vector3(0, 1, 0)
  const waveUp = new THREE.Vector3()
  const tilt = new THREE.Quaternion()
  const yaw = new THREE.Quaternion()
  const along = new THREE.Vector3()
  const east = new THREE.Vector3(1, 0, 0)

  function paint(
    list: Flake[],
    mesh: THREE.InstancedMesh,
    mat: THREE.MeshBasicMaterial,
    time: number,
    layer: 0 | 1,
  ) {
    for (let i = 0; i < list.length; i++) {
      const f = list[i]
      const water = sampleOcean(f.x, f.z, time)
      const ground = opts.heightAt(f.x, f.z)
      const depth = water.y - ground
      // Never plant foam on dry sand, or out in deep water past the lap
      if (ground > water.y + 0.2 || depth > 2.8) {
        dummy.scale.setScalar(0)
        dummy.position.set(f.x, water.y, f.z)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        continue
      }

      // Crest relative to mean tide — higher water = fuller foam
      const crest = Math.max(0, Math.min(1, (water.y - oceanState.tide + 0.2) / 0.85))
      // Slow lap: outer patches crest later than the ones against the sand
      const lap =
        0.42 +
        0.58 * Math.sin(time * 1.28 - f.reach * 0.62 + f.phase) * (0.5 + 0.5 * crest)
      const breath = 0.82 + 0.18 * Math.sin(time * 0.65 + f.phase * 0.45)
      // Sheets sit a hair lower; lace rides the lip
      const lift = layer === 1 ? 0.08 : 0.045
      dummy.position.set(f.x, water.y + lift, f.z)

      waveUp.set(water.normal.x, water.normal.y, water.normal.z)
      tilt.setFromUnitVectors(up, waveUp)
      along.set(-f.dz, 0, f.dx).normalize()
      yaw.setFromUnitVectors(east, along)
      dummy.quaternion.copy(tilt).multiply(yaw)

      const alongMul = layer === 0 ? 2.35 + lap * 1.05 : 1.85 + lap * 1.15
      const outMul = layer === 0 ? 0.32 + lap * 0.38 : 0.22 + lap * 0.48
      // Fade scale as depth grows so the band hugs the waterline
      const depthFade = 1 - Math.min(1, Math.max(0, (depth - 0.15) / 2.4))
      const alongLen = f.size * alongMul * breath * (0.55 + 0.45 * depthFade)
      const outLen = f.size * outMul * (0.65 + 0.35 * depthFade)
      dummy.scale.set(alongLen, 1, outLen)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    const pulse = 0.5 + 0.5 * Math.sin(time * 1.12)
    mat.opacity = layer === 0 ? 0.38 + 0.22 * pulse : 0.48 + 0.32 * pulse
  }

  function update(time: number, camera: THREE.Camera, underwater: boolean) {
    const near = camera.position.distanceToSquared(opts.centre) < 560 * 560
    const show = near && !underwater && flakes.length > 0
    sheetMesh.visible = show && sheets.length > 0
    laceMesh.visible = show && lace.length > 0
    if (!show) return

    if (sheetMesh.visible) paint(sheets, sheetMesh, sheetMat, time, 0)
    if (laceMesh.visible) paint(lace, laceMesh, laceMat, time, 1)
  }

  return { mesh: sheetMesh, update, count: flakes.length }
}

export type ShoreSurf = ReturnType<typeof createShoreSurf>
