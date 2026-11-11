import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { groundDetail } from './groundtex'

/**
 * The Wanderer's reef, as rock rather than six balloons.
 *
 * It used to be six displaced icosahedra, flat-shaded and one colour, and from
 * the sand it read as a pile of grey dumplings. Real reef rock is a mass of
 * old coral and lime: bedded in layers that weather into ledges and undercuts,
 * split by joints into blocks, flared into the sand at its foot, and furred all
 * over with turf, crusts and sponges that collect in the hollows.
 *
 * So the shape is one signed-distance field — the old lumps blended together,
 * warped, then cut by strata, joints and grain — meshed once at load with
 * surface nets. The same sampled field is the collider, which means you touch
 * the rock you see instead of an ellipsoid somewhere inside it, and it is what
 * finds the rock's surface for planting. Paint and shading come from the field
 * too: how buried a point is (crevices go dark), which way it faces (turf on
 * the tops, crusts on the walls), how near the sand it sits (dusted pale).
 */

// —— noise ————————————————————————————————————————————————————

function hash3(x: number, y: number, z: number) {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

/** Value noise in 3D, 0–1, quintic eased so its gradient has no creases. */
export function noise3(x: number, y: number, z: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
  const a = hash3(ix, iy, iz)
  const b = hash3(ix + 1, iy, iz)
  const c = hash3(ix, iy + 1, iz)
  const d = hash3(ix + 1, iy + 1, iz)
  const e = hash3(ix, iy, iz + 1)
  const f = hash3(ix + 1, iy, iz + 1)
  const g = hash3(ix, iy + 1, iz + 1)
  const h = hash3(ix + 1, iy + 1, iz + 1)
  const ab = a + (b - a) * ux
  const cd = c + (d - c) * ux
  const ef = e + (f - e) * ux
  const gh = g + (h - g) * ux
  const lo = ab + (cd - ab) * uy
  const hi = ef + (gh - ef) * uy
  return lo + (hi - lo) * uz
}

function fbm3(x: number, y: number, z: number) {
  return noise3(x, y, z) * 0.55 + noise3(x * 2.03 + 5.2, y * 2.03, z * 2.03 - 3.1) * 0.3 + noise3(x * 4.1 - 7.7, y * 4.1, z * 4.1 + 1.3) * 0.15
}

/** 1 on a thin sheet where the noise crosses its middle, 0 elsewhere — a joint. */
function ridge(n: number, width: number) {
  const t = Math.max(0, 1 - Math.abs(n - 0.5) / width)
  return t * t
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// —— the shape ————————————————————————————————————————————————

export type ReefLump = {
  radius: number
  at: [number, number, number]
  scale: [number, number, number]
}

/** Signed distance to an ellipsoid (the cheap bound, close enough near the shell). */
function ellipsoid(px: number, py: number, pz: number, rx: number, ry: number, rz: number) {
  const k0 = Math.hypot(px / rx, py / ry, pz / rz)
  const k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz))
  return k1 > 1e-6 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz)
}

export function smoothUnion(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}

function reefField(lumps: ReefLump[], sandY: number) {
  return (x: number, y: number, z: number) => {
    // Warp first, so the strata and joints below bend with the mass the way
    // folded beds do, instead of slicing it like a ruler
    const wx = x + (noise3(x * 0.1, y * 0.1, z * 0.1) - 0.5) * 3.4
    const wy = y + (noise3(x * 0.1 + 17.3, y * 0.1, z * 0.1) - 0.5) * 1.6
    const wz = z + (noise3(x * 0.1, y * 0.1 + 31.7, z * 0.1) - 0.5) * 3.4
    let d = 1e9
    for (const l of lumps) {
      const ry = l.radius * l.scale[1]
      let px = wx - l.at[0]
      let py = wy - l.at[1]
      let pz = wz - l.at[2]
      // Below its middle each mass is draped down to the sand and widens as
      // it goes, so nothing sits on the seabed like a dropped ball
      if (py < 0) {
        const reach = l.at[1] - (sandY - 1.5)
        const s = Math.min(1, -py / reach)
        const spread = 1 + 0.45 * s
        px /= spread
        pz /= spread
        py *= Math.min(1, ry / reach)
      }
      const e = ellipsoid(px, py, pz, l.radius * l.scale[0], ry, l.radius * l.scale[2])
      d = d > 1e8 ? e : smoothUnion(d, e, 3.2)
    }
    // A boulder sat on sand is undercut all round its foot; a reef is not —
    // it flares out into a talus apron and the sand banks up against it
    d -= smooth(sandY + 6, sandY - 0.5, y) * 2.6
    // Detail never moves the surface by more than this, so well clear of the
    // shell only the sign matters and the cheap value will do
    if (d > 4.5 || d < -4.5) return d

    // Big swells and hollows
    d -= (fbm3(x * 0.15, y * 0.15, z * 0.15) - 0.5) * 2.6
    // Bedding: a wandering contour every ~1.9 m. Near the top of each bed the
    // face steps back, so walls read as stacked ledges with a lip at each one
    // Only some of the rock is bedded — the rest is massive, or so grown over
    // the beds don't show — or every pillar turns into a stack of plates
    const bedded = smooth(0.5, 0.78, noise3(x * 0.07 + 8.8, y * 0.07, z * 0.07))
    const bed = (wy + (noise3(x * 0.06, 3.3, z * 0.06) - 0.5) * 4.2) / 2.1
    const f = bed - Math.floor(bed)
    d += (smooth(0.6, 0.95, f) * 0.3 - smooth(0.0, 0.12, f) * 0.08) * bedded
    // Joints: two families of near-vertical cracks and one of bedding-parallel
    // partings, cut as grooves so the mass breaks into blocks
    const j1 = ridge(noise3(x * 0.22 + 4.1, y * 0.05, z * 0.22), 0.07)
    const j2 = ridge(noise3(x * 0.3 - 9.2, y * 0.07 + 2.2, z * 0.3 + 6.6), 0.06)
    d += Math.max(j1, j2 * 0.8) * 0.55
    // Pitted grain, at the finest scale the mesh can carry
    d -= (noise3(x * 0.85, y * 0.85, z * 0.85) - 0.5) * 0.4
    return d
  }
}

// —— surface nets —————————————————————————————————————————————

const CORNERS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
]
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
]

export type ReefRock = {
  geometry: THREE.BufferGeometry
  /** Signed distance (metres, roughly) from the rock, local coords. Far outside the grid: large. */
  distance(x: number, y: number, z: number): number
  /** Push a local-space point out of the rock to at least `clearance`. Returns true if it moved. */
  pushOut(p: { x: number; y: number; z: number }, clearance: number): boolean
  /** First rock surface straight down from `fromY`, with its normal, or null. */
  surfaceDown(x: number, z: number, fromY?: number): { y: number; normal: THREE.Vector3 } | null
}

export function buildReefRock(lumps: ReefLump[], sandY: number, low: boolean): ReefRock {
  const field = reefField(lumps, sandY)
  const h = low ? 0.85 : 0.5

  // Bounds from the lumps, padded for the warp, flare and detail
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = -Infinity
  for (const l of lumps) {
    x0 = Math.min(x0, l.at[0] - l.radius * l.scale[0])
    x1 = Math.max(x1, l.at[0] + l.radius * l.scale[0])
    z0 = Math.min(z0, l.at[2] - l.radius * l.scale[2])
    z1 = Math.max(z1, l.at[2] + l.radius * l.scale[2])
    y1 = Math.max(y1, l.at[1] + l.radius * l.scale[1])
  }
  const pad = 5
  return buildRockSurface(field, {
    x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad,
    y0: sandY - 3, y1: Math.min(y1 + pad, -0.5),
  }, h, rockPainter(sandY))
}

/** Mesh a solid and keep its sampled field for collision. Its foot can extend below the seabed. */
export function buildRockSurface(
  field: (x: number, y: number, z: number) => number,
  bounds: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number },
  h: number,
  paint: (x: number, y: number, z: number, n: THREE.Vector3, ao: number, out: THREE.Color) => void,
): ReefRock {
  const { x0: ox, y0: oy, z0: oz } = bounds
  const nx = Math.ceil((bounds.x1 - ox) / h) + 1
  const ny = Math.ceil((bounds.y1 - oy) / h) + 1
  const nz = Math.ceil((bounds.z1 - oz) / h) + 1

  const grid = new Float32Array(nx * ny * nz)
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k)
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let d = field(ox + i * h, oy + j * h, oz + k * h)
        // Closed on every side but the bottom, so the shell has no holes
        if (i === 0 || j === ny - 1 || k === 0 || i === nx - 1 || k === nz - 1) d = Math.max(d, 0.01)
        grid[at(i, j, k)] = d
      }
    }
  }

  /** Trilinear lookup of the sampled field — the mesh and the collider agree exactly. */
  function distance(x: number, y: number, z: number) {
    const gx = (x - ox) / h
    const gy = (y - oy) / h
    const gz = (z - oz) / h
    if (gx < 0 || gz < 0 || gx >= nx - 1 || gz >= nz - 1 || gy >= ny - 1) return 99
    const cy = Math.max(gy, 0)
    const i = Math.floor(gx)
    const j = Math.min(Math.floor(cy), ny - 2)
    const k = Math.floor(gz)
    const fx = gx - i
    const fy = cy - j
    const fz = gz - k
    const c000 = grid[at(i, j, k)]
    const c100 = grid[at(i + 1, j, k)]
    const c010 = grid[at(i, j + 1, k)]
    const c110 = grid[at(i + 1, j + 1, k)]
    const c001 = grid[at(i, j, k + 1)]
    const c101 = grid[at(i + 1, j, k + 1)]
    const c011 = grid[at(i, j + 1, k + 1)]
    const c111 = grid[at(i + 1, j + 1, k + 1)]
    const a = c000 + (c100 - c000) * fx
    const b = c010 + (c110 - c010) * fx
    const c = c001 + (c101 - c001) * fx
    const d = c011 + (c111 - c011) * fx
    const lo = a + (b - a) * fy
    const hi = c + (d - c) * fy
    return lo + (hi - lo) * fz
  }

  const gradient = (x: number, y: number, z: number, out: THREE.Vector3, e = h * 0.5) =>
    out
      .set(
        distance(x + e, y, z) - distance(x - e, y, z),
        distance(x, y + e, z) - distance(x, y - e, z),
        distance(x, y, z + e) - distance(x, y, z - e),
      )
      .normalize()

  // Vertices: one per cell the surface passes through, at the mean of its
  // edge crossings
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1)
  const cellAt = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k)
  const positions: number[] = []
  const v = new Float32Array(8)
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0
        for (let c = 0; c < 8; c++) {
          const [a, b, e] = CORNERS[c]
          v[c] = grid[at(i + a, j + b, k + e)]
          if (v[c] < 0) mask |= 1 << c
        }
        if (mask === 0 || mask === 255) continue
        let sx = 0, sy = 0, sz = 0, n = 0
        for (const [p, q] of EDGES) {
          if (v[p] < 0 === v[q] < 0) continue
          const t = v[p] / (v[p] - v[q])
          const [ax, ay, az] = CORNERS[p]
          const [bx, by, bz] = CORNERS[q]
          sx += ax + (bx - ax) * t
          sy += ay + (by - ay) * t
          sz += az + (bz - az) * t
          n++
        }
        cellVert[cellAt(i, j, k)] = positions.length / 3
        positions.push(ox + (i + sx / n) * h, oy + (j + sy / n) * h, oz + (k + sz / n) * h)
      }
    }
  }

  // Faces: a quad across every grid edge the surface crosses, joining the four
  // cells around it, wound so the front faces out of the rock
  const index: number[] = []
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    if (flip) [b, d] = [d, b]
    // Split along the shorter diagonal, which keeps slivers out of the creases
    const pa = a * 3, pb = b * 3, pc = c * 3, pd = d * 3
    const ac = (positions[pa] - positions[pc]) ** 2 + (positions[pa + 1] - positions[pc + 1]) ** 2 + (positions[pa + 2] - positions[pc + 2]) ** 2
    const bd = (positions[pb] - positions[pd]) ** 2 + (positions[pb + 1] - positions[pd + 1]) ** 2 + (positions[pb + 2] - positions[pd + 2]) ** 2
    if (ac < bd) index.push(a, b, c, a, c, d)
    else index.push(a, b, d, b, c, d)
  }
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const inside = grid[at(i, j, k)] < 0
        if (inside !== grid[at(i + 1, j, k)] < 0) {
          quad(cellVert[cellAt(i, j - 1, k - 1)], cellVert[cellAt(i, j, k - 1)], cellVert[cellAt(i, j, k)], cellVert[cellAt(i, j - 1, k)], !inside)
        }
        if (inside !== grid[at(i, j + 1, k)] < 0) {
          quad(cellVert[cellAt(i - 1, j, k - 1)], cellVert[cellAt(i - 1, j, k)], cellVert[cellAt(i, j, k)], cellVert[cellAt(i, j, k - 1)], !inside)
        }
        if (inside !== grid[at(i, j, k + 1)] < 0) {
          quad(cellVert[cellAt(i - 1, j - 1, k)], cellVert[cellAt(i, j - 1, k)], cellVert[cellAt(i, j, k)], cellVert[cellAt(i - 1, j, k)], !inside)
        }
      }
    }
  }

  const count = positions.length / 3
  const pos = new Float32Array(positions)
  const normals = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const g = new THREE.Vector3()
  const col = new THREE.Color()
  for (let vi = 0; vi < count; vi++) {
    let x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2]
    // One Newton step onto the true surface sharpens ledges the cell average rounds off
    gradient(x, y, z, g)
    const d = distance(x, y, z)
    if (Math.abs(d) < h) {
      x -= g.x * d
      y -= g.y * d
      z -= g.z * d
    }
    pos[vi * 3] = x
    pos[vi * 3 + 1] = y
    pos[vi * 3 + 2] = z
    gradient(x, y, z, g)
    normals[vi * 3] = g.x
    normals[vi * 3 + 1] = g.y
    normals[vi * 3 + 2] = g.z

    // How buried the point is: march out along the normal and see how much
    // rock is still closer than the distance travelled. Plus a look straight
    // up, because overhangs shade the face below them most of all.
    let occ = 0
    for (const [s, w] of [[0.5, 0.5], [1.2, 0.3], [2.6, 0.2]] as const) {
      occ += w * Math.max(0, s - distance(x + g.x * s, y + g.y * s, z + g.z * s)) / s
    }
    const over = Math.max(0, 1.5 - distance(x, y + 3, z)) / 4.5
    const ao = Math.max(0, 1 - occ * 1.3 - over)
    paint(x, y, z, g, ao, col)
    colors[vi * 3] = col.r
    colors[vi * 3 + 1] = col.g
    colors[vi * 3 + 2] = col.b
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.setIndex(index)
  geometry.computeBoundingSphere()

  const n = new THREE.Vector3()
  function pushOut(p: { x: number; y: number; z: number }, clearance: number) {
    let moved = false
    for (let it = 0; it < 3; it++) {
      const d = distance(p.x, p.y, p.z)
      if (d >= clearance) break
      gradient(p.x, p.y, p.z, n)
      const step = clearance - d + 0.002
      p.x += n.x * step
      p.y += n.y * step
      p.z += n.z * step
      moved = true
    }
    return moved
  }

  function surfaceDown(x: number, z: number, fromY = oy + (ny - 1) * h) {
    let prev = distance(x, fromY, z)
    if (prev < 0) return null
    for (let y = fromY - h * 0.5; y > oy; y -= h * 0.5) {
      const d = distance(x, y, z)
      if (d < 0) {
        // Bisect the last step
        let hiY = y + h * 0.5, loY = y
        for (let b = 0; b < 6; b++) {
          const mid = (hiY + loY) / 2
          if (distance(x, mid, z) < 0) loY = mid
          else hiY = mid
        }
        const sy = (hiY + loY) / 2
        return { y: sy, normal: gradient(x, sy, z, new THREE.Vector3()) }
      }
      prev = d
    }
    return null
  }

  return { geometry, distance, pushOut, surfaceDown }
}

// —— paint ————————————————————————————————————————————————————

/**
 * Reef rock is hardly ever bare. Tops carry a turf of short algae, olive to
 * brown; walls and lips take crusts of coralline algae, rose and violet; small
 * sponges spot the shaded faces; the foot is dusted with sand; hollows go dark.
 * Colours are a touch louder than they'd photograph, because twenty metres of
 * water takes the reds back on the way to your eye.
 */
function rockPainter(sandY: number) {
  const bare = new THREE.Color('#77715f')
  const dark = new THREE.Color('#47443c')
  const olive = new THREE.Color('#5f6c37')
  const brown = new THREE.Color('#77603a')
  const rose = new THREE.Color('#a67e80')
  const violet = new THREE.Color('#7b6a80')
  const orange = new THREE.Color('#b8743c')
  const yellow = new THREE.Color('#ad9a4c')
  const sand = new THREE.Color('#aea288')
  const bleach = new THREE.Color('#bdb6a3')
  const t = new THREE.Color()
  return (x: number, y: number, z: number, n: THREE.Vector3, ao: number, out: THREE.Color) => {
    const up = n.y
    const p1 = noise3(x * 0.3 + 2.1, y * 0.3, z * 0.3 - 4.4)
    const p2 = noise3(x * 0.55 - 8.3, y * 0.55 + 1.7, z * 0.55)
    const mottle = noise3(x * 1.4, y * 1.4 + 9.1, z * 1.4)
    out.copy(bare).lerp(dark, smooth(0.55, 0.15, p2) * 0.5)
    // Turf on anything facing the light, thicker toward the crest
    const turf = smooth(0.1, 0.65, up) * (0.5 + 0.5 * smooth(sandY + 2, sandY + 14, y)) * (0.55 + 0.45 * p1)
    out.lerp(t.copy(olive).lerp(brown, p2), turf)
    // Coralline crust on walls and the lips of ledges
    const wall = 1 - Math.abs(up)
    const crust = wall * smooth(0.45, 0.68, p1) * 0.65
    out.lerp(t.copy(rose).lerp(violet, smooth(0.3, 0.7, p2)), crust)
    // Bleached patches: dead coral skeleton, pale and chalky
    out.lerp(bleach, smooth(0.74, 0.86, p2) * smooth(-0.2, 0.5, up) * 0.6)
    // Sponge spots on the shaded walls
    const spot = smooth(0.74, 0.82, noise3(x * 0.8 + 13.3, y * 0.8, z * 0.8 - 2.2)) * (1 - turf)
    out.lerp(t.copy(orange).lerp(yellow, p1), spot * 0.6)
    // Sand settles on the low tops and banks against the foot
    const dust = smooth(0.35, 0.85, up) * (1 - smooth(sandY + 0.5, sandY + 4, y))
    out.lerp(sand, Math.max(dust, 1 - smooth(sandY - 0.6, sandY + 1.2, y)))
    out.multiplyScalar(0.84 + mottle * 0.32)
    // Hollows and the undersides of ledges
    out.multiplyScalar((0.3 + 0.7 * ao) * (0.72 + 0.28 * smooth(-0.85, 0.2, up)))
  }
}

/** Paint loose rock (rubble, the spire's drowned flank) the reef's way, with occlusion faked from the normal. */
export function paintRock(geo: THREE.BufferGeometry, sandY: number, below = Infinity, keep?: THREE.BufferAttribute) {
  const paint = rockPainter(sandY)
  const pos = geo.attributes.position
  const nrm = geo.attributes.normal
  const colors = keep ?? new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3)
  const n = new THREE.Vector3()
  const c = new THREE.Color()
  const was = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    n.fromBufferAttribute(nrm, i)
    paint(pos.getX(i), y, pos.getZ(i), n, 0.55 + 0.45 * smooth(-0.6, 0.6, n.y), c)
    if (keep) {
      // Only below `below`, eased in over three metres
      was.fromBufferAttribute(keep, i)
      c.lerp(was, smooth(below - 3, below, y))
    }
    colors.setXYZ(i, c.r, c.g, c.b)
  }
  geo.setAttribute('color', colors)
  return geo
}

// —— material —————————————————————————————————————————————————

/**
 * Close-up grain from the island's detail texture (its basalt channel), cast
 * from three sides since the rock has no uv, at two scales: a fine one that
 * fades out past swimming distance, and a coarse one that carries the stone's
 * texture as far as you can see through the water. Both feed a tangent-free
 * bump. `drownEmissive` fades the material's emissive out below the surface,
 * for rock that needs a skylight in air and none under it.
 *
 * `shore` is for rock that stands out of the sea: by height above the tide it
 * paints the wet splash zone, the pale barnacle line and the dark band over
 * it, and rules fine beds on the steep faces. Write the tide into
 * `material.userData.shoreTide.value` each frame.
 */
export function reefRockMaterial(params: THREE.MeshStandardMaterialParameters, drownEmissive = false, shore = false) {
  const mat = new THREE.MeshStandardMaterial(params)
  const uDetail = { value: groundDetail() }
  const uShoreTide = { value: 0 }
  mat.userData.shoreTide = uShoreTide
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uReefDetail = uDetail
    if (shore) shader.uniforms.uShoreTide = uShoreTide
    shader.vertexShader = `varying vec3 vReefPos;\nvarying vec3 vReefN;\n${shader.vertexShader}`.replace(
      '#include <project_vertex>',
      `vReefPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vReefN = mat3(modelMatrix) * objectNormal;
      #include <project_vertex>`,
    )
    shader.fragmentShader = `uniform sampler2D uReefDetail;
${shore ? 'uniform float uShoreTide;' : ''}
varying vec3 vReefPos;
varying vec3 vReefN;
float rDetailH = 0.0;
vec2 rDetailD = vec2(0.0);
float rTone = 1.0;
float rShoreWet = 0.0;
float rShoreAir = 0.0;
${shader.fragmentShader}`
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 sw = pow(abs(normalize(vReefN)), vec3(4.0));
          sw /= dot(sw, vec3(1.0));
          // The bump needs the slope of this grain across the screen. Asking
          // the GPU for the screen-space difference of the height itself gives
          // one answer per 2x2 block of pixels, and the grain changes from one
          // pixel to the next: every block tilted its own way and the rock
          // came out in little squares, worst up close in the caves. So the
          // fine grain is differenced here instead, by reading the texture
          // again one pixel along each screen axis (the coordinates vary
          // smoothly, so their differences are safe to take per block).
          vec3 sp = vReefPos / 1.25;
          vec2 uA = sp.zy, uB = sp.xz, uC = sp.xy;
          float fA = texture2D(uReefDetail, uA).b, fB = texture2D(uReefDetail, uB).b, fC = texture2D(uReefDetail, uC).b;
          float fine = fA * sw.x + fB * sw.y + fC * sw.z;
          float fineX = (texture2D(uReefDetail, uA + dFdx(uA)).b - fA) * sw.x + (texture2D(uReefDetail, uB + dFdx(uB)).b - fB) * sw.y + (texture2D(uReefDetail, uC + dFdx(uC)).b - fC) * sw.z;
          float fineY = (texture2D(uReefDetail, uA + dFdy(uA)).b - fA) * sw.x + (texture2D(uReefDetail, uB + dFdy(uB)).b - fB) * sw.y + (texture2D(uReefDetail, uC + dFdy(uC)).b - fC) * sw.z;
          // The coarse relief is read a mip and a half soft: broad enough that
          // neighbouring blocks agree, so it can still be differenced on screen
          vec3 sq = vReefPos / 7.0;
          float coarse = texture2D(uReefDetail, sq.yz + 0.37, 1.5).b * sw.x + texture2D(uReefDetail, sq.zx + 0.61, 1.5).b * sw.y + texture2D(uReefDetail, sq.yx + 0.13, 1.5).b * sw.z;
          float dist = length(vReefPos - cameraPosition);
          float fadeF = 1.0 - smoothstep(6.0, 24.0, dist);
          float fadeC = 1.0 - smoothstep(45.0, 140.0, dist);
          rTone = mix(1.0, 0.78 + fine * 0.44, fadeF) * mix(1.0, 0.85 + coarse * 0.3, fadeC);
          diffuseColor.rgb *= rTone;
          rDetailH = (coarse - 0.5) * 0.12 * fadeC;
          rDetailD = vec2(fineX, fineY) * 0.035 * fadeF;
          ${shore ? `
          // A rocky shore is banded by how long each level spends under water
          float hgt = vReefPos.y - uShoreTide;
          float air = smoothstep(-0.25, 0.1, hgt);
          rShoreAir = air;
          float steep = 1.0 - smoothstep(0.45, 0.8, abs(normalize(vReefN).y));
          // Wet and near-black where the swell still reaches, drying upward
          rShoreWet = (1.0 - smoothstep(0.1, 0.7 + coarse * 0.6, hgt)) * air;
          diffuseColor.rgb *= 1.0 - 0.5 * rShoreWet;
          // Barnacles: a pale broken line just above the wet rock
          // (mixed with the coarse grain so a wide shelf does not show the fine tile repeating, and thinner on the flat)
          float barnacle = smoothstep(0.55, 0.85, hgt) * (1.0 - smoothstep(0.95, 1.2 + coarse * 0.5, hgt)) * smoothstep(0.42, 0.6, fine * 0.45 + coarse * 0.55);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.46, 0.44, 0.39), barnacle * 0.42 * air * mix(0.4, 1.0, steep));
          // The dark band of salt-crust above them, fading out by head height
          float crust = smoothstep(1.1, 1.6, hgt) * (1.0 - smoothstep(2.2, 3.4, hgt));
          diffuseColor.rgb *= 1.0 - 0.25 * crust * air;
          // Beds: thin dark seams ruled along the steep faces, gone before they could shimmer
          // (bent by the coarse grain and broken into runs, or they read as contour lines on a map)
          float seam = smoothstep(0.86, 0.99, sin((vReefPos.y + coarse * 1.8) * 5.2)) * smoothstep(0.4, 0.6, fine * 0.4 + coarse * 0.6);
          diffuseColor.rgb *= 1.0 - 0.2 * seam * steep * air * (1.0 - smoothstep(50.0, 130.0, dist));
          ` : ''}
        }`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        {
          vec3 p = -vViewPosition;
          vec3 dpdx = dFdx(p);
          vec3 dpdy = dFdy(p);
          float dhx = dFdx(rDetailH) + rDetailD.x;
          float dhy = dFdy(rDetailH) + rDetailD.y;
          vec3 r1 = cross(dpdy, normal);
          vec3 r2 = cross(normal, dpdx);
          float det = dot(dpdx, r1);
          vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
          normal = normalize(abs(det) * normal - grad);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance *= rTone;
        ${drownEmissive ? 'totalEmissiveRadiance *= smoothstep(-6.0, 0.5, vReefPos.y);' : ''}`,
      )
    // Wet rock shines
    if (shore) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.3, rShoreWet);`,
        )
        // Dark rock in open shade sits right on the grade's blue shadow lift
        // and comes out as ink. Out of the water it takes more of the sky's
        // own light instead: scaled from what is already falling on it, so a
        // sealed chamber and the night stay as dark as they were.
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          reflectedLight.indirectDiffuse *= 1.0 + 1.1 * rShoreAir;`,
        )
    }
  }
  mat.customProgramCacheKey = () => `reefrock:${drownEmissive}:${shore}`
  return mat
}

// —— life on the reef —————————————————————————————————————————

const rand = (seed: number, n: number) => hash3(Math.floor(seed * 97) + n * 7919, n * 31, 17)

function tint(geo: THREE.BufferGeometry, fn: (x: number, y: number, z: number, out: THREE.Color) => void) {
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    fn(pos.getX(i), pos.getY(i), pos.getZ(i), c)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geo
}

function clean(geo: THREE.BufferGeometry) {
  geo.deleteAttribute('uv')
  return geo
}

/** Brain coral: a squat dome with meandering grooves painted into it. */
function brainCoral(seed: number) {
  const r = 0.3 + rand(seed, 1) * 0.5
  const geo = clean(new THREE.SphereGeometry(r, 14, 9))
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    // Lobed and slumped, the way a colony grows over the rock it started on
    const lobe = 0.8 + 0.4 * noise3(x * 2.2 / r + seed * 3, y * 2.2 / r, z * 2.2 / r)
    pos.setXYZ(i, x * lobe * 1.15, (y < 0 ? y * 0.15 : y * 0.55) * lobe, z * lobe * 1.15)
  }
  geo.computeVertexNormals()
  const base = new THREE.Color(rand(seed, 2) < 0.5 ? '#8f7d52' : '#6c7550')
  const groove = base.clone().multiplyScalar(0.55)
  return tint(geo, (x, y, z, out) => {
    const m = Math.sin((x * 7 + noise3(x * 2.5 + seed, y * 2.5, z * 2.5) * 6) * 2.2)
    out.copy(base).lerp(groove, smooth(0.3, 0.9, m))
  })
}

/** Table coral: a flat plate on a short stem, edges paler where it is growing. */
function tableCoral(seed: number) {
  const r = 0.35 + rand(seed, 3) * 0.5
  const stem = new THREE.CylinderGeometry(0.06, 0.14, 0.35, 6, 1)
  stem.translate(0, 0.17, 0)
  const plate = new THREE.CylinderGeometry(r, r * 0.8, 0.07, 16, 1)
  plate.translate(0, 0.37, 0)
  const geo = mergeGeometries([clean(stem), clean(plate)], false) as THREE.BufferGeometry
  geo.rotateZ((rand(seed, 4) - 0.5) * 0.35)
  const base = new THREE.Color(rand(seed, 5) < 0.5 ? '#6f7d5a' : '#857558')
  const rim = new THREE.Color('#b8b096')
  return tint(geo, (x, y, z, out) => {
    out.copy(base).lerp(rim, smooth(r * 0.75, r, Math.hypot(x, z)) * 0.4)
    // The top is a mat of polyps, not a dinner plate
    out.multiplyScalar(0.8 + 0.35 * noise3(x * 9 + seed, y * 9, z * 9))
  })
}

/** Branching coral: forked tines, tips paler. */
function branchCoral(seed: number) {
  const parts: THREE.BufferGeometry[] = []
  const n = 6 + Math.floor(rand(seed, 6) * 6)
  for (let i = 0; i < n; i++) {
    const len = 0.35 + rand(seed, 10 + i) * 0.5
    const tine = new THREE.CylinderGeometry(0.025, 0.05, len, 5, 1)
    tine.translate(0, len / 2, 0)
    tine.rotateZ((rand(seed, 30 + i) - 0.5) * 1.2)
    tine.rotateY(rand(seed, 50 + i) * Math.PI * 2)
    parts.push(clean(tine))
    // A fork off the upper half
    if (rand(seed, 70 + i) < 0.6) {
      const fork = new THREE.CylinderGeometry(0.02, 0.035, len * 0.5, 5, 1)
      fork.translate(0, len * 0.25, 0)
      fork.rotateZ(0.7)
      fork.translate(0, len * 0.55, 0)
      fork.rotateZ((rand(seed, 30 + i) - 0.5) * 1.2)
      fork.rotateY(rand(seed, 50 + i) * Math.PI * 2 + 0.8)
      parts.push(clean(fork))
    }
  }
  const geo = mergeGeometries(parts, false) as THREE.BufferGeometry
  const base = new THREE.Color(rand(seed, 7) < 0.6 ? '#b39a72' : '#9c7f8f')
  const tip = new THREE.Color('#e3d9c2')
  return tint(geo, (_x, y, _z, out) => out.copy(base).lerp(tip, smooth(0.25, 0.75, y)))
}

/** Tube sponges: a few open, flared pipes from one footing. */
function tubeSponge(seed: number) {
  const parts: THREE.BufferGeometry[] = []
  const n = 2 + Math.floor(rand(seed, 8) * 4)
  for (let i = 0; i < n; i++) {
    const len = 0.4 + rand(seed, 80 + i) * 0.8
    const rr = 0.07 + rand(seed, 90 + i) * 0.06
    const tube = new THREE.CylinderGeometry(rr * 1.25, rr, len, 9, 3, true)
    tube.translate(0, len / 2, 0)
    tube.rotateZ((rand(seed, 100 + i) - 0.5) * 0.7)
    tube.rotateY(rand(seed, 110 + i) * Math.PI * 2)
    tube.translate((rand(seed, 120 + i) - 0.5) * 0.25, 0, (rand(seed, 130 + i) - 0.5) * 0.25)
    parts.push(clean(tube))
  }
  const geo = mergeGeometries(parts, false) as THREE.BufferGeometry
  const pick = rand(seed, 9)
  const base = new THREE.Color(pick < 0.4 ? '#8a5a98' : pick < 0.75 ? '#cf7836' : '#c9ad3f')
  return tint(geo, (_x, y, _z, out) => out.copy(base).multiplyScalar(0.75 + 0.35 * smooth(0, 0.8, y)))
}

/** Barrel sponge: a thick vase, ridged, open at the top. */
function barrelSponge(seed: number) {
  const s = 0.5 + rand(seed, 11) * 0.6
  const pts: THREE.Vector2[] = []
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    pts.push(new THREE.Vector2((0.3 + Math.sin(t * Math.PI * 0.85) * 0.22) * s, t * 0.9 * s))
  }
  pts.push(new THREE.Vector2(0.3 * s, 0.86 * s))
  const geo = clean(new THREE.LatheGeometry(pts, 14))
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const a = Math.atan2(pos.getZ(i), pos.getX(i))
    const k = 1 + Math.sin(a * 7) * 0.05
    pos.setX(i, pos.getX(i) * k)
    pos.setZ(i, pos.getZ(i) * k)
  }
  geo.computeVertexNormals()
  const base = new THREE.Color('#8e5038')
  return tint(geo, (x, y, z, out) => {
    const a = Math.atan2(z, x)
    out.copy(base).multiplyScalar(0.8 + 0.25 * Math.sin(a * 7) + 0.15 * smooth(0, s, y))
  })
}

/** Soft coral: a sea whip — a few thin rods, bending a little. */
function seaWhip(seed: number) {
  const parts: THREE.BufferGeometry[] = []
  const n = 3 + Math.floor(rand(seed, 12) * 4)
  for (let i = 0; i < n; i++) {
    const len = 0.8 + rand(seed, 140 + i) * 1.1
    const rod = new THREE.CylinderGeometry(0.012, 0.03, len, 4, 4)
    rod.translate(0, len / 2, 0)
    const p = rod.attributes.position
    for (let k = 0; k < p.count; k++) {
      const y = p.getY(k)
      p.setX(k, p.getX(k) + (y / len) ** 2 * 0.25)
    }
    rod.rotateY(rand(seed, 150 + i) * Math.PI * 2)
    rod.rotateZ((rand(seed, 160 + i) - 0.5) * 0.5)
    parts.push(clean(rod))
  }
  const geo = mergeGeometries(parts, false) as THREE.BufferGeometry
  const base = new THREE.Color(rand(seed, 13) < 0.5 ? '#c05a4a' : '#d29a3a')
  return tint(geo, (_x, _y, _z, out) => out.copy(base))
}

const KINDS = [brainCoral, brainCoral, brainCoral, tableCoral, branchCoral, branchCoral, tubeSponge, tubeSponge, barrelSponge, seaWhip, seaWhip]

/**
 * Corals and sponges planted on the rock: sampled on a golden-angle spiral,
 * dropped onto the surface, kept where it faces up enough to grow on, and
 * leaned a little toward the face they stand on.
 */
export function reefLife(rock: ReefRock, opts: { count: number; reach: number; centre: [number, number]; minY: number; maxY: number }) {
  const parts: THREE.BufferGeometry[] = []
  const up = new THREE.Vector3(0, 1, 0)
  const q = new THREE.Quaternion()
  const lean = new THREE.Vector3()
  const m = new THREE.Matrix4()
  const tries = opts.count * 4
  for (let i = 0; i < tries && parts.length < opts.count; i++) {
    const a = i * 2.39996 + 0.4
    const r = Math.sqrt(i / tries) * opts.reach
    const x = opts.centre[0] + Math.cos(a) * r
    const z = opts.centre[1] + Math.sin(a) * r
    const hit = rock.surfaceDown(x, z)
    if (!hit || hit.normal.y < 0.45 || hit.y < opts.minY || hit.y > opts.maxY) continue
    // Clusters: thin out where a slow noise says the rock is bare
    if (noise3(x * 0.18, 0.5, z * 0.18) < 0.32) continue
    const kind = KINDS[Math.floor(rand(i, 14) * KINDS.length)]
    let geo = kind(i + 0.5)
    if (geo.index) geo = geo.toNonIndexed()
    lean.copy(up).lerp(hit.normal, 0.5).normalize()
    q.setFromUnitVectors(up, lean)
    const yaw = new THREE.Quaternion().setFromAxisAngle(up, rand(i, 15) * Math.PI * 2)
    const scale = 0.8 + rand(i, 16) * 0.6
    m.compose(new THREE.Vector3(x, hit.y - 0.05, z), q.multiply(yaw), new THREE.Vector3(scale, scale, scale))
    parts.push(geo.applyMatrix4(m))
  }
  return parts.length ? (mergeGeometries(parts, false) as THREE.BufferGeometry) : null
}
