import * as THREE from 'three'
import { sampleOcean } from './waves'

/**
 * Spar buoy — a second landmark between the wreck and the island.
 * Not a destination, just something to notice: a mast in the haze so the
 * crossing isn't one binary swim.
 */

export type SparBuoy = {
  group: THREE.Group
  update: (time: number) => void
  /** World XZ of the buoy — useful for tests / debug spawns. */
  position: { x: number; z: number }
}

function mats() {
  return {
    mast: new THREE.MeshStandardMaterial({
      color: 0x6a4e32,
      roughness: 0.92,
      metalness: 0.02,
    }),
    iron: new THREE.MeshStandardMaterial({
      color: 0x3a3e44,
      roughness: 0.55,
      metalness: 0.45,
    }),
    cork: new THREE.MeshStandardMaterial({
      color: 0xb87a3a,
      roughness: 0.95,
      metalness: 0,
    }),
    rag: new THREE.MeshStandardMaterial({
      color: 0xc4b89a,
      roughness: 0.9,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
    rope: new THREE.MeshStandardMaterial({
      color: 0x8a7348,
      roughness: 1,
      metalness: 0,
    }),
  }
}

export function createSparBuoy(
  scene: THREE.Scene,
  opts: { x: number; z: number },
): SparBuoy {
  const m = mats()
  const group = new THREE.Group()
  group.name = 'sparBuoy'
  group.position.set(opts.x, 0, opts.z)

  // Float — weathered barrel on its side, half sunk
  const float = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.58, 1.4, 10), m.cork)
  float.rotation.z = Math.PI / 2
  float.position.set(0, 0.15, 0)
  group.add(float)
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.04, 5, 12), m.iron)
  band.rotation.y = Math.PI / 2
  band.position.set(0, 0.15, 0)
  group.add(band)

  // Spar mast
  const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 5.2, 7), m.mast)
  spar.position.set(0, 2.4, 0)
  group.add(spar)

  // Cross tree + scrap rag — readable silhouette from a long way off
  const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.6, 5), m.mast)
  yard.rotation.z = Math.PI / 2
  yard.position.set(0, 4.4, 0)
  group.add(yard)
  const rag = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.55, 2, 2), m.rag)
  rag.position.set(0.45, 4.15, 0)
  rag.name = 'sparRag'
  group.add(rag)

  const stay = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 3.2, 4), m.rope)
  stay.position.set(0.35, 2.2, 0)
  stay.rotation.z = 0.45
  group.add(stay)

  // Rusty chain dipping into the water
  for (let i = 0; i < 5; i++) {
    const link = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 4, 8), m.iron)
    link.position.set(0.15 + i * 0.04, -0.15 - i * 0.18, 0.1)
    link.rotation.set(0.4, 0.2, i * 0.5)
    group.add(link)
  }

  scene.add(group)

  return {
    group,
    position: { x: opts.x, z: opts.z },
    update(time: number) {
      const sea = sampleOcean(opts.x, opts.z, time)
      group.position.y = sea.y + 0.05
      group.rotation.order = 'YXZ'
      group.rotation.x = sea.normal.z * 0.4
      group.rotation.z = -sea.normal.x * 0.4
      // Slow yaw drift so the rag catches light from different sides
      group.rotation.y = Math.sin(time * 0.11) * 0.35
      const flag = group.getObjectByName('sparRag')
      if (flag) {
        flag.rotation.y = Math.sin(time * 1.4) * 0.45
        flag.rotation.z = Math.sin(time * 0.9) * 0.12
      }
    },
  }
}
