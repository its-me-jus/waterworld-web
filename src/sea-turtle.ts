import * as THREE from 'three'

const tau = Math.PI * 2

// Paint in plan view so the centre plates, paired costal plates and small
// marginal plates follow the same tapered outline as the shell.
function carapaceMap() {
  const seeds: { x: number; z: number; edge: boolean }[] = []
  for (let i = -2; i <= 2; i++) seeds.push({ x: i * .36, z: 0, edge: false })
  for (const side of [-1, 1]) {
    for (const x of [-.65, -.24, .18, .59]) {
      seeds.push({ x, z: side * .49 * Math.sqrt(1 - x * x), edge: false })
    }
  }
  for (let i = 0; i < 26; i++) {
    const a = i * tau / 26
    seeds.push({ x: .97 * Math.cos(a), z: .91 * Math.sin(a), edge: true })
  }
  const size = 256
  const data = new Uint8Array(size * size * 4)
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    const x = (col + .5) / size * 2 - 1, z = (row + .5) / size * 2 - 1
    let closest = Infinity, second = Infinity, plate = 0
    for (let i = 0; i < seeds.length; i++) {
      const dx = x - seeds[i].x, dz = (z - seeds[i].z) * .82
      const distance = dx * dx + dz * dz
      if (distance < closest) { second = closest; closest = distance; plate = i }
      else if (distance < second) second = distance
    }
    const gap = Math.sqrt(second) - Math.sqrt(closest)
    const seed = seeds[plate]
    const angle = Math.atan2(z - seed.z, x - seed.x)
    const grain = Math.sin(angle * 9 + Math.sqrt(closest) * 22 + Math.sin(angle * 4 + plate))
    const mottle = Math.sin(x * 21 + Math.sin(z * 27)) * Math.cos(z * 12 + x * 6)
    const ring = Math.cos(gap * 100) * Math.exp(-gap * 10)
    const groove = Math.exp(-gap * gap / .00009)
    const light = .78 + grain * .025 + mottle * .065 + ring * .09 + Math.sin(plate * 3.7) * .12 - groove * .48
    const i = (row * size + col) * 4
    data[i] = (seed.edge ? 179 : 152) * light
    data[i + 1] = (seed.edge ? 148 : 107) * light
    data[i + 2] = (seed.edge ? 85 : 53) * light
    data[i + 3] = 255
  }
  const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  map.colorSpace = THREE.SRGBColorSpace
  map.generateMipmaps = true
  map.minFilter = THREE.LinearMipmapLinearFilter
  map.magFilter = THREE.LinearFilter
  map.needsUpdate = true
  return map
}

// Light seams between the olive shields on the cheeks and paddles.
function scaleMap() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#c8bc85'
  ctx.fillRect(0, 0, 256, 256)
  const cells = ['#6e704b', '#868356', '#88805a', '#79794f']
  for (let j = -1; j < 9; j++) for (let i = -1; i < 9; i++) {
    const x = (i + (j & 1) * .5) * 32, y = j * 32
    ctx.fillStyle = cells[(i * 7 + j * 3 + (i & 3) * (j & 3)) & 3]
    ctx.beginPath()
    for (const [k, [dx, dy]] of [[0,-20],[15,-11],[15,10],[0,20],[-15,10],[-15,-11]].entries()) {
      if (k === 0) ctx.moveTo(x + dx, y + dy)
      else ctx.lineTo(x + dx, y + dy)
    }
    ctx.closePath()
    ctx.fill()
  }
  const map = new THREE.CanvasTexture(canvas)
  map.colorSpace = THREE.SRGBColorSpace
  return map
}

function makeTurtle() {
  const group = new THREE.Group()
  const shell = new THREE.SphereGeometry(1, 48, 20)
  const pos = shell.attributes.position, uv = shell.attributes.uv
  const colors: number[] = []
  const tint = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    // Broad across the shoulders, pinched towards the little rudder feet.
    pos.setXYZ(i, .60 * x, .045 + (y > 0 ? .216 : .124) * y, .395 * z * (1 + .27 * x))
    uv.setXY(i, (x + 1) / 2, (z + 1) / 2)
    tint.set(y < -.10 ? '#f1dba4' : '#ffffff')
    colors.push(tint.r, tint.g, tint.b)
  }
  shell.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  shell.computeVertexNormals()
  shell.clearGroups()
  const topIndices = 48 * (1 + 2 * 9) * 3
  shell.addGroup(0, topIndices, 0)
  shell.addGroup(topIndices, shell.index!.count - topIndices, 1)
  const shellMat = new THREE.MeshStandardMaterial({ map: carapaceMap(), roughness: .51 })
  const belly = new THREE.MeshStandardMaterial({ color: '#e4d3a6', vertexColors: true, roughness: .74 })
  group.add(new THREE.Mesh(shell, [shellMat, belly]))

  const skin = new THREE.MeshStandardMaterial({ map: scaleMap(), roughness: .72 })
  const horn = new THREE.MeshStandardMaterial({ color: '#bdb38b', roughness: .67 })
  const dark = new THREE.MeshStandardMaterial({ color: '#191e17', roughness: .22 })
  function oval(parent: THREE.Group, mat: THREE.Material, x: number, y: number, z: number,
    length: number, height: number, width: number) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), mat)
    mesh.position.set(x, y, z)
    mesh.scale.set(length, height, width)
    parent.add(mesh)
    return mesh
  }
  const head = new THREE.Group()
  head.name = 'Head'
  head.position.set(.48, .04, 0)
  group.add(head)
  oval(head, skin, .059, -.002, 0, .185, .078, .087)
  oval(head, skin, .205, .034, 0, .151, .107, .103)
  oval(head, horn, .279, -.004, 0, .095, .047, .084)
  const beak = oval(head, skin, .292, .030, 0, .094, .049, .083)
  beak.rotation.z = -.24
  for (const side of [-1, 1]) {
    oval(head, horn, .247, .058, side * .088, .032, .027, .016)
    oval(head, dark, .251, .059, side * .100, .021, .020, .010)
  }

  function paddle(front: boolean, side: number, name: string) {
    const pivot = new THREE.Group()
    pivot.name = name
    pivot.position.set(front ? .34 : -.40, -.014, (front ? .231 : .166) * side)
    const blade = new THREE.SphereGeometry(1, 20, 16)
    const p = blade.attributes.position
    for (let i = 0; i < p.count; i++) {
      const reach = (1 - p.getY(i)) * .5
      const chord = (front ? .156 : .106) * (1.18 - reach * .68)
      const sweep = front ? .075 * Math.sin(reach * Math.PI) - .25 * reach ** 2 : -.25 * reach
      p.setXYZ(i, sweep + p.getX(i) * chord, p.getZ(i) * side * .039 - .055 * reach ** 2,
        side * reach * (front ? .75 : .27))
    }
    blade.computeVertexNormals()
    pivot.add(new THREE.Mesh(blade, skin))
    group.add(pivot)
  }
  paddle(true, 1, 'Front L')
  paddle(true, -1, 'Front R')
  paddle(false, 1, 'Rear L')
  paddle(false, -1, 'Rear R')
  return group
}

let template: THREE.Group | undefined
export function buildTurtle() {
  template ??= makeTurtle()
  const group = template.clone(true)
  const joint = (name: string) => group.getObjectByName(name) as THREE.Group
  return { group, head: joint('Head'), frontL: joint('Front L'), frontR: joint('Front R'),
    rearL: joint('Rear L'), rearR: joint('Rear R') }
}
