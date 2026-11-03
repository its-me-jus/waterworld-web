import * as THREE from 'three'

/** [distance down the body, half width, half depth, front/back centre]. */
type Section = readonly [number, number, number, number]

function surface(sections: readonly Section[], rings: number, sides = 32) {
  const start = sections[0][0]
  const length = sections[sections.length - 1][0]
  const positions: number[] = [], uvs: number[] = [], colors: number[] = [], indices: number[] = []
  for (let row = 0; row <= rings; row++) {
    const y = start + row / rings * (length - start)
    let section = 0
    while (section < sections.length - 2 && sections[section + 1][0] < y) section++
    const a = sections[section], b = sections[section + 1]
    const u = THREE.MathUtils.smoothstep(y, a[0], b[0])
    const width = THREE.MathUtils.lerp(a[1], b[1], u)
    const depth = THREE.MathUtils.lerp(a[2], b[2], u)
    const centre = THREE.MathUtils.lerp(a[3], b[3], u)
    for (let col = 0; col <= sides; col++) {
      const angle = col / sides * Math.PI * 2
      positions.push(Math.cos(angle) * width, -y, Math.sin(angle) * depth + centre)
      uvs.push(col / sides, row / rings)
      // Integral fabric panels: no floating rings, slabs or intersection seams.
      const side = Math.abs(Math.cos(angle))
      const panel = THREE.MathUtils.smoothstep(side, 0.72, 0.9)
      const seam = Math.exp(-(((side - 0.73) / 0.025) ** 2))
      const value = 1 - panel * 0.2 + seam * 0.1
      // Curved ochre shoulder and thigh inserts with a narrow sea-glass seam.
      const band = side + 0.24 * Math.sin(row / rings * Math.PI * 1.55)
      const insert = THREE.MathUtils.smoothstep(band, 0.87, 0.94)
      const piping = Math.exp(-(((band - 0.83) / 0.045) ** 2))
      colors.push(value * (0.17 + insert * 0.78 + piping * 0.35),
        value * (0.29 + insert * 0.19 + piping * 0.53),
        value * (0.34 - insert * 0.23 + piping * 0.39))
      if (row < rings && col < sides) {
        const n = row * (sides + 1) + col
        indices.push(n, n + 1, n + sides + 1, n + 1, n + sides + 2, n + sides + 1)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  // The UV seam duplicates vertices; weld their normals without welding the UVs.
  const normal = geometry.getAttribute('normal')
  const average = new THREE.Vector3()
  for (let row = 0; row <= rings; row++) {
    const a = row * (sides + 1), b = a + sides
    average.set(normal.getX(a) + normal.getX(b), normal.getY(a) + normal.getY(b), normal.getZ(a) + normal.getZ(b)).normalize()
    normal.setXYZ(a, average.x, average.y, average.z)
    normal.setXYZ(b, average.x, average.y, average.z)
  }
  return geometry
}

/** One continuous surface through an articulated joint, driven by real bones. */
export function createArticulatedLimb(material: THREE.Material, leg = false) {
  const upper = leg ? 0.4 : 0.305
  const lower = leg ? 0.385 : 0.275
  const length = upper + lower
  const sections: Section[] = leg ? [
    [-0.04, 0.001, 0.001, 0], [0, 0.073, 0.071, 0], [0.09, 0.081, 0.076, 0.003],
    [0.28, 0.06, 0.059, 0], [upper, 0.05, 0.048, -0.003],
    [upper + 0.11, 0.06, 0.055, 0.008], [length - 0.09, 0.034, 0.035, 0],
    [length, 0.03, 0.031, 0],
  ] : [
    [-0.040, 0.011, 0.013, 0], [-0.034, 0.029, 0.032, 0],
    [-0.019, 0.045, 0.046, 0], [0, 0.052, 0.052, 0], [0.065, 0.06, 0.053, -0.003],
    [0.17, 0.054, 0.047, -0.004], [upper, 0.036, 0.036, 0],
    [upper + 0.065, 0.047, 0.038, -0.002], [length - 0.07, 0.031, 0.026, 0],
    [length, 0.026, 0.023, 0],
  ]
  const geometry = surface(sections, 48)
  const positions = geometry.getAttribute('position')
  const weights: number[] = [], joints: number[] = []
  for (let i = 0; i < positions.count; i++) {
    const y = -positions.getY(i)
    const elbow = THREE.MathUtils.smoothstep(y, upper - 0.055, upper + 0.065)
    const wrist = THREE.MathUtils.smoothstep(y, length - 0.085, length)
    joints.push(0, 1, 2, 0)
    weights.push(1 - elbow, elbow * (1 - wrist), elbow * wrist, 0)
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
  const root = new THREE.Group()
  const shoulder = new THREE.Bone(), elbow = new THREE.Bone(), wrist = new THREE.Bone()
  shoulder.name = leg ? 'Hip' : 'Shoulder'
  elbow.name = leg ? 'Knee' : 'Elbow'
  wrist.name = leg ? 'Ankle' : 'Wrist'
  elbow.position.y = -upper
  wrist.position.y = -lower
  root.add(shoulder)
  shoulder.add(elbow)
  elbow.add(wrist)
  const mesh = new THREE.SkinnedMesh(geometry, material)
  mesh.name = leg ? 'ContinuousLeg' : 'ContinuousSleeve'
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([shoulder, elbow, wrist]))
  // Bind-pose bounds do not cover the crawl's overhead recovery.
  mesh.frustumCulled = false
  return { root, shoulder, elbow, wrist, mesh }
}

export function createTorso(material: THREE.Material) {
  const geometry = surface([
    [0, 0.075, 0.064, 0.018], [0.065, 0.165, 0.085, 0.01],
    [0.15, 0.185, 0.105, 0], [0.28, 0.16, 0.1, 0.004],
    [0.42, 0.126, 0.085, 0.006], [0.55, 0.145, 0.095, 0.008],
    [0.59, 0.142, 0.09, 0.006], [0.63, 0.118, 0.07, 0.01],
    [0.665, 0.06, 0.043, 0.012], [0.68, 0.008, 0.012, 0.012],
  ], 48, 48)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'FittedTorso'
  return mesh
}
