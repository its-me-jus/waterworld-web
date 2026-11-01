import * as THREE from 'three'

/** Refine only the tidal band so the drawn beach agrees with the bilinear seabed. */
export function createCoastalTerrain(span: number, segments: number, heightAt: (x: number, z: number) => number, low: boolean) {
  const fine = low ? 2 : 3
  const step = span * 2 / segments
  const stride = segments * fine + 1
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const vertices = new Map<number, number>()
  const up = new THREE.Vector3()
  const vertex = (i: number, j: number) => {
    const key = j * stride + i
    const existing = vertices.get(key)
    if (existing !== undefined) return existing
    const x = -span + i / fine * step
    const z = -span + j / fine * step
    const index = positions.length / 3
    positions.push(x, heightAt(x, z), z)
    // Derivative normals agree across coarse/fine boundaries, including the
    // intermediate vertices which lie on an unrefined neighbour's edge.
    const e = step * 0.12
    up.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize()
    normals.push(up.x, up.y, up.z)
    uvs.push((x + span) / (span * 2), (span - z) / (span * 2))
    vertices.set(key, index)
    return index
  }
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const x = -span + i * step, z = -span + j * step
      const corners = [heightAt(x, z), heightAt(x + step, z), heightAt(x, z + step), heightAt(x + step, z + step)]
      const tidal = Math.min(...corners) < 4 && Math.max(...corners) > -5
      const n = tidal ? fine : 1
      const jump = fine / n
      for (let v = 0; v < n; v++) {
        for (let u = 0; u < n; u++) {
          const gx = i * fine + u * jump, gz = j * fine + v * jump
          const a = vertex(gx, gz), b = vertex(gx + jump, gz)
          const c = vertex(gx, gz + jump), d = vertex(gx + jump, gz + jump)
          indices.push(a, c, b, b, c, d)
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return geometry
}
