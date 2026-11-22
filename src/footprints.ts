import * as THREE from 'three'
import type { AudioGround } from './audio'
import { crossedPhase } from './foley'
import type { PlayerFrame, PlayerState } from './player'
import { DETAIL_LAYER } from './quality'
import { oceanState, sampleOcean } from './waves'

/** Pressure left by a soft dive boot: a loaded heel and ball, shallow instep,
 * and broken grooves in the rubber. The texture is a left sole, heel at v=0. */
function soleTexture() {
  const width = 64, height = 128
  const data = new Uint8Array(width * height * 4)
  const smooth = THREE.MathUtils.smoothstep
  for (let row = 0; row < height; row++) {
    const v = 2 * (row + 0.5) / height - 1
    for (let col = 0; col < width; col++) {
      const u = 2 * (col + 0.5) / width - 1
      const grain = Math.sin(col * 93.13 + row * 17.17) * 29517.3
      const grit = grain - Math.floor(grain)
      const edge = 0.93 + 0.09 * grit
      const heel = Math.hypot((u + 0.03) / 0.60, (v + 0.57) / 0.34)
      const instep = Math.hypot((u + 0.29) / 0.40, (v + 0.10) / 0.53)
      const ball = Math.hypot((u - 0.04 - 0.17 * v) / 0.80, (v - 0.38) / 0.53)
      const pressure = Math.max(
        1 - smooth(heel, 0.62, edge),
        (1 - smooth(instep, 0.41, edge)) * 0.68,
        (1 - smooth(ball, 0.61, edge)) * 0.94,
      )
      const chevron = (v + Math.abs(u + 0.10) * 0.17) * 5
      const groove = smooth(Math.abs(chevron - Math.round(chevron)), 0.025, 0.14)
      const i = 4 * (row * width + col)
      data[i] = data[i + 1] = data[i + 2] = 255
      data[i + 3] = Math.round(255 * pressure * (0.58 + 0.42 * groove) * (0.82 + 0.18 * grit))
    }
  }
  const texture = new THREE.DataTexture(data, width, height)
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const

/** A bounded trail shared by both feet. Quad corners sit on the beach;
 * receiving their own wave samples lets the lower prints wash out first. */
export function createFootprints(scene: THREE.Scene, heightAt: (x: number, z: number) => number, lowPower: boolean) {
  const capacity = lowPower ? 24 : 48
  const slots = Array.from({ length: capacity }, () => ({ x: 0, z: 0, y: 0, life: 0, strength: 0 }))
  const positions = new THREE.BufferAttribute(new Float32Array(capacity * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage)
  const uvs = new THREE.BufferAttribute(new Float32Array(capacity * 4 * 2), 2).setUsage(THREE.DynamicDrawUsage)
  const colors = new THREE.BufferAttribute(new Uint8Array(capacity * 4 * 4), 4, true).setUsage(THREE.DynamicDrawUsage)
  const index: number[] = []
  for (let slot = 0; slot < capacity; slot++) {
    const base = slot * 4
    for (let i = 0; i < 4; i++) colors.setXYZW(base + i, 1, 1, 1, 0)
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', positions)
  geometry.setAttribute('uv', uvs)
  geometry.setAttribute('color', colors)
  geometry.setIndex(index)
  const material = new THREE.MeshBasicMaterial({
    color: 0x22180f, map: soleTexture(), vertexColors: true, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'Player bootprints'
  mesh.layers.set(DETAIL_LAYER)
  mesh.userData.noShadow = true
  mesh.frustumCulled = false
  mesh.visible = false
  mesh.renderOrder = 1
  scene.add(mesh)

  let cursor = 0, weatherTime = 0, lastPhase = 0, lastX = NaN, lastZ = NaN
  let distanceSinceStep = 0, wasGrounded = false
  const footprintCorners = corners.map(() => new THREE.Vector3())

  function setOpacity(slot: number, value: number) {
    for (let corner = 0; corner < 4; corner++) colors.setW(4 * slot + corner, value)
    colors.needsUpdate = true
  }

  function plant(player: PlayerState, view: PlayerFrame, side: number, wet: boolean) {
    const yaw = player.yaw
    const cx = player.x + side * 0.095 * Math.cos(yaw)
    const cz = player.z - side * 0.095 * Math.sin(yaw)
    const y = heightAt(cx, cz)
    // A wreck ledge, a gallery floor, and a wall can all share the beach's altitude.
    if (!Number.isFinite(y) || Math.abs(y - view.groundY) > 0.17 || view.surfaceY > y + 0.055) return
    const heading = yaw - side * 0.07
    const sin = Math.sin(heading), cos = Math.cos(heading)
    const base = cursor * 4
    for (let i = 0; i < 4; i++) {
      const [lateral, forward] = corners[i]
      const x = cx + cos * lateral * 0.064 - sin * forward * 0.15
      const z = cz - sin * lateral * 0.064 - cos * forward * 0.15
      const floor = heightAt(x, z)
      if (!Number.isFinite(floor)) return
      footprintCorners[i].set(x, floor + 0.006, z)
    }
    for (let i = 0; i < 4; i++) {
      const [lateral, forward] = corners[i]
      const corner = footprintCorners[i]
      positions.setXYZ(base + i, corner.x, corner.y, corner.z)
      uvs.setXY(base + i, (1 - side * lateral) / 2, (forward + 1) / 2)
    }
    const slot = slots[cursor]
    slot.x = cx
    slot.z = cz
    slot.y = y
    slot.life = 1
    slot.strength = wet ? 0.72 : 0.53
    setOpacity(cursor, slot.strength)
    positions.needsUpdate = uvs.needsUpdate = true
    mesh.visible = true
    cursor = (cursor + 1) % capacity
  }

  function update(dt: number, time: number, player: PlayerState, view: PlayerFrame, ground: AudioGround, rain: number, allowSteps: boolean) {
    const available = allowSteps && view.walking && player.fallFrom === null && (ground === 'wet-sand' || ground === 'sand')
    const travel = Math.hypot(player.x - lastX, player.z - lastZ)
    if (available && wasGrounded && travel < 0.65 && view.moving > 0.15 && view.speed > 0.3) {
      distanceSinceStep += travel
      const right = crossedPhase(lastPhase, view.stroke, 0)
      const left = crossedPhase(lastPhase, view.stroke, 0.5)
      if (right || left) {
        // A blocked player can keep cycling their legs at a wall.
        if (distanceSinceStep > 0.22) plant(player, view, right ? 1 : -1, ground === 'wet-sand')
        distanceSinceStep = 0
      }
    } else {
      distanceSinceStep = 0
    }
    wasGrounded = available
    lastPhase = view.stroke
    lastX = player.x
    lastZ = player.z

    weatherTime += dt
    if (weatherTime < 0.24) return
    let nearby = false
    for (let i = 0; i < capacity; i++) {
      const p = slots[i]
      if (p.life <= 0) continue
      let erosion = (1 + 4 * rain) / 60
      if (p.y < oceanState.tide + 1.8) {
        const wash = sampleOcean(p.x, p.z, time).y - p.y
        erosion += THREE.MathUtils.smoothstep(wash, 0.005, 0.15) * 1.7
      }
      p.life = Math.max(0, p.life - weatherTime * erosion)
      setOpacity(i, p.strength * THREE.MathUtils.smoothstep(p.life, 0, 0.85))
      if (p.life > 0 && Math.hypot(p.x - player.x, p.z - player.z) < 46) nearby = true
    }
    mesh.visible = nearby
    weatherTime = 0
  }
  return { update }
}
