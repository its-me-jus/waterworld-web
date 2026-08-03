import * as THREE from 'three'

/**
 * Crafted fishing gear viewmodels — same shape as the mate's spear:
 * pure procedural factories, parented to the camera once owned.
 */

export function buildRod() {
  const wood = new THREE.MeshStandardMaterial({ color: 0x6a5234, roughness: 0.85 })
  const cork = new THREE.MeshStandardMaterial({ color: 0xc4a866, roughness: 0.95 })
  const lineMat = new THREE.LineBasicMaterial({ color: 0xb8c4c8, transparent: true, opacity: 0.55 })

  const rod = new THREE.Group()

  const blank = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.022, 1.55, 7), wood)
  blank.position.y = 0.55
  rod.add(blank)

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.026, 0.22, 8), cork)
  grip.position.y = -0.12
  rod.add(grip)

  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.014, 6, 5), wood)
  tip.position.y = 1.32
  tip.name = 'tip'
  rod.add(tip)

  // Thin monofilament — length animated during a cast
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 1.32, 0),
    new THREE.Vector3(0, 0.2, -0.05),
  ])
  const line = new THREE.Line(lineGeo, lineMat)
  line.name = 'line'
  line.visible = false
  rod.add(line)

  return rod
}

export function buildNet() {
  const rope = new THREE.MeshStandardMaterial({ color: 0x8a7a58, roughness: 0.92 })
  const frond = new THREE.MeshStandardMaterial({
    color: 0x5a7a48,
    roughness: 0.88,
    side: THREE.DoubleSide,
  })
  const meshMat = new THREE.MeshStandardMaterial({
    color: 0x9aa8a4,
    roughness: 0.7,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
  })

  const net = new THREE.Group()

  // Bundled throw — rope ring + frond weight
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.022, 6, 14), rope)
  ring.rotation.x = Math.PI / 2
  net.add(ring)

  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.22), frond)
    blade.position.set(Math.cos(a) * 0.12, -0.08, Math.sin(a) * 0.12)
    blade.rotation.y = a
    blade.rotation.x = 0.4
    net.add(blade)
  }

  // Opens on the cast — radial mesh disc
  const open = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), meshMat)
  open.rotation.x = -Math.PI / 2
  open.name = 'open'
  open.visible = false
  open.scale.setScalar(0.15)
  net.add(open)

  return net
}

/** Stretch the rod's monofilament toward a local-space tip. */
export function setRodLine(rod: THREE.Group, tipLocal: THREE.Vector3 | null) {
  const line = rod.getObjectByName('line') as THREE.Line | undefined
  if (!line) return
  if (!tipLocal) {
    line.visible = false
    return
  }
  line.visible = true
  const pos = line.geometry.attributes.position as THREE.BufferAttribute
  pos.setXYZ(0, 0, 1.32, 0)
  pos.setXYZ(1, tipLocal.x, tipLocal.y, tipLocal.z)
  pos.needsUpdate = true
  line.geometry.computeBoundingSphere()
}
