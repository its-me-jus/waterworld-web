import assert from 'node:assert/strict'
import * as THREE from 'three'
import { createCoastalTerrain } from '../src/coastmesh.ts'

// A bilinear cell has a curved interior but straight shared edges, like the
// island's sampled seabed. Test the mismatch which used to cut wedges of sand
// through the water, as well as face winding and the mobile triangle budget.
const height = (x, z) => -0.4 + x * 0.3 + z * 0.08 + x * z * 0.12
const span = 8, segments = 4
const original = new THREE.PlaneGeometry(span * 2, span * 2, segments, segments)
original.rotateX(-Math.PI / 2)
const pos = original.attributes.position
for (let i = 0; i < pos.count; i++) pos.setY(i, height(pos.getX(i), pos.getZ(i)))
function error(geometry) {
  const p = geometry.attributes.position, idx = geometry.index
  let sum = 0, count = 0
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), face = new THREE.Vector3()
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(p, idx.getX(i)); b.fromBufferAttribute(p, idx.getX(i + 1)); c.fromBufferAttribute(p, idx.getX(i + 2))
    face.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
    assert(face.y > 0, 'every terrain triangle faces up')
    const x = (a.x + b.x + c.x) / 3, z = (a.z + b.z + c.z) / 3
    if (height(x, z) > -3 && height(x, z) < 3) { sum += Math.abs((a.y + b.y + c.y) / 3 - height(x, z)); count++ }
  }
  return sum / count
}
const before = error(original)
for (const low of [true, false]) {
  const mesh = createCoastalTerrain(span, segments, height, low)
  const p = mesh.attributes.position, n = mesh.attributes.normal
  for (let i = 0; i < p.count; i++) {
    assert(Math.abs(p.getY(i) - height(p.getX(i), p.getZ(i))) < 0.00001)
    assert(Number.isFinite(n.getX(i)) && Number.isFinite(n.getZ(i)) && n.getY(i) > 0)
  }
  const after = error(mesh)
  assert(after < before * 0.35, 'refinement reduces tidal-band surface error')
  assert(mesh.index.count <= segments ** 2 * 6 * (low ? 4 : 9), 'bounded geometry budget')
  console.log(`${low ? 'Phone' : 'Desktop'}: ${(100 * (1 - after / before)).toFixed(1)}% lower surface error; ${mesh.index.count / 3} triangles; winding and normals pass`)
}
