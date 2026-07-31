import * as THREE from 'three'

/**
 * The mate's spear — one mesh, two lives:
 *
 *  - as a prop lying inside the sealed locker, waiting;
 *  - as the first-person viewmodel once it's yours (scaled up a touch, since
 *    it's half a metre from your eye instead of across the wreck).
 *
 * A whaling spear rather than a pole with a nail in it: hardwood shaft, an
 * iron head with two rearward barbs, and a serving of whipping where head
 * meets wood. Forward is +Y in the mesh's local frame, tip at the top.
 */
export function buildSpear() {
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 0.82 })
  const iron = new THREE.MeshStandardMaterial({
    color: 0x4c443c,
    roughness: 0.4,
    metalness: 0.72,
    emissive: 0x15181b,
    emissiveIntensity: 0.55,
  })
  const twine = new THREE.MeshStandardMaterial({ color: 0x9a8862, roughness: 1 })

  const spear = new THREE.Group()

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.024, 1.9, 8), wood)
  spear.add(shaft)

  // Whipping: the wrapped twine that keeps the head seated
  const serving = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.09, 8), twine)
  serving.position.y = 0.92
  spear.add(serving)

  // Socket and leaf-shaped head
  const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.026, 0.07, 8), iron)
  socket.position.y = 1.0
  spear.add(socket)

  const head = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.3, 6), iron)
  head.scale.set(1, 1, 0.45)
  head.position.y = 1.18
  spear.add(head)

  // Rearward barbs — what makes it a shark spear and not a barge pole
  for (const sign of [-1, 1]) {
    const barb = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.12, 5), iron)
    barb.position.set(sign * 0.028, 1.06, 0)
    barb.rotation.z = sign * 2.55
    spear.add(barb)
  }

  // Butt cap so the wood doesn't split when you ground it on a rib
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.023, 0.05, 8), iron)
  butt.position.y = -0.96
  spear.add(butt)

  return spear
}
