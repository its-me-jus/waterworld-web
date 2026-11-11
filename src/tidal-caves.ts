import * as THREE from 'three'
import { buildRockSurface, noise3, reefLife, reefRockMaterial, smoothUnion } from './reefrock'
import { createCaveLife } from './cave-life'

// On the seaward side of the landing reef. The island's seabed here lies below
// both galleries, so the tide can run all the way through the two pools.
const SITE = { x: 669, z: -495 }
const BOUNDS = { x0: -30, x1: 30, y0: -37, y1: 13, z0: -49, z1: 49 }
const centreX = (z: number) => 1.9 * Math.sin((z + 5) * 0.126) + 1.2 * Math.sin((z - 8) * 0.18)
const bell = (v: number) => Math.exp(-v * v)
const pools = [
  { x: centreX(13), z: 13, rx: 4.6, rz: 5.5, bottom: -8.8 },
  { x: centreX(-10), z: -10, rx: 6.3, rz: 5.0, bottom: -10.2 },
]
const smooth = THREE.MathUtils.smoothstep
const room = { x: -13.5, z: 0.5, rx: 6.2, rz: 7.25 }

// A side passage runs from the first pool, beneath the air bell and around
// the back of the ridge before it rises into the second pool.
const waypoints = [
  [1.6, -6.0, 13.3], [-4.5, -6.9, 10.5], [-9.4, -8.2, 8.3],
  [-13.6, -7.5, 5.4], [-13.5, -6.8, 0.5], [-15.3, -8.3, -5.4],
  [-15.1, -10.7, -10.4], [-11.7, -11.4, -14.4],
  [-7.6, -10.2, -15], [-4.4, -8.3, -13.0], [-1.3, -6.9, -10.1],
]
const verticalScale = 1.25
const passage = waypoints.slice(1).map(([x, y, z], i) => {
  const [ax, ay, az] = waypoints[i]
  const dx = x - ax, dy = (y - ay) * verticalScale, dz = z - az
  return { ax, ay, az, dx, dy, dz, lengthSq: dx * dx + dy * dy + dz * dz }
})
function passageDistance(x: number, y: number, z: number) {
  let closest = Infinity
  for (const s of passage) {
    const px = x - s.ax, py = (y - s.ay) * verticalScale, pz = z - s.az
    const t = THREE.MathUtils.clamp((px * s.dx + py * s.dy + pz * s.dz) / s.lengthSq, 0, 1)
    closest = Math.min(closest, (px - t * s.dx) ** 2 + (py - t * s.dy) ** 2 + (pz - t * s.dz) ** 2)
  }
  return Math.sqrt(closest) - 2.8
}

function roomRadius(x: number, y: number, z: number) {
  const dy = y + 2.15
  return Math.hypot((x - room.x + 0.65 * Math.sin(z * 0.46)) / room.rx,
    (z - room.z + 0.11 * (x - room.x)) / room.rz, dy / (dy > 0 ? 7.35 : 7.8))
}

// Tapering mineral folds hang down the side walls of the air chamber.
// Cutting them into the same field gives their ledges a solid silhouette
// at the tide line and gives the glowworms a real surface to cling to.
const folds = [
  [-17.0, -3.5, 0.82, 0.36], [-15.6, -4.7, 1.60, 0.33],
  [-11.8, -4.6, 1.12, 0.30], [-9.0, 1.3, 1.45, 0.36], [-16.8, 4.8, 1.72, 0.32],
]
function chamberDistance(x: number, y: number, z: number) {
  let cavity = (roomRadius(x, y, z) - 1) * 6.2
  if (y < 0.3 || cavity > 1.4) return cavity
  for (const [cx, cz, tip, taper] of folds) {
    const h = y - tip
    const width = 0.15 + Math.max(0, h) * taper
    const fold = Math.max(-h, Math.hypot((x - cx - h * 0.10) * 1.5, (z - cz) * 0.78) - width)
    cavity = -smoothUnion(-cavity, fold, 0.46)
  }
  return cavity
}

function skyOpening(x: number, z: number) {
  let light = smooth(Math.abs(z), 22, 34)
  for (const pool of pools) {
    const radius = Math.hypot((x - pool.x) / pool.rx, (z - pool.z) / pool.rz)
    light = Math.max(light, 1 - smooth(radius, 0.65, 1.65))
  }
  return light
}

/**
 * Height of one bed of the basalt, in metres: the sea cuts the rock back a
 * bed at a time. Two metres is thick for a bed, but the rock is meshed on a
 * grid of about 0.8 m and anything finer is rounded away to a plain slope.
 */
const BED = 2.1

/**
 * Out of the water the outcrop is bedded basalt, not a dune. Heights are
 * gathered onto benches a bed apart, with a short steep riser between, along
 * beds that dip a little toward the sea and are never quite flat. The
 * benching comes and goes over the rock, so some of the shore is stepped and
 * some is left a plain slope: a way up from the water on foot.
 */
function benched(x: number, y: number, z: number, warp: number) {
  const bed = y + 0.07 * x + 0.035 * z + warp * 0.5
  const q = bed / BED
  const level = Math.floor(q)
  // A bench still climbs a little across its width. Dead flat, the field
  // would be the same value through a whole slab of rock, and wherever that
  // value was near zero the mesher made loose crumbs of it.
  // (The 0.4 keeps the rock its old height on average: gathering every
  // height in a bed up onto that bed's bench made the whole outcrop taller.)
  const f = q - level
  const stair = (level + 0.14 * f + 0.86 * smooth(f, 0.62, 0.96) + 0.4) * BED
  const patch = smooth(noise3(x * 0.07 + 3.1, 0.4, z * 0.07 - 1.7), 0.22, 0.5)
  return y + (stair - bed) * patch * smooth(y, -1.5, 0.3)
}

/** Signed distance to the flooded gallery that runs the length of the rock between the pools. */
function galleryDistance(x: number, y: number, z: number) {
  const chamber = bell((z - 1.5) / 4.8)
  const bend = centreX(z) + 1.6 * bell((z - 6) / 3.6)
  const level = -5.55 + 0.75 * Math.sin(z * 0.16) - 1.25 * bell((z + 18) / 5.2)
  const dy = y - level
  const width = 3.65 + 1.9 * chamber + 0.55 * Math.sin(z * 0.23)
  const vault = 2.45 + 1.35 * chamber + 0.45 * Math.sin(z * 0.58 + x * 0.31)
  const height = dy > 0 ? vault : 2.55
  const across = x - bend + dy * 0.28 * Math.sin(z * 0.13)
  return (Math.hypot(across / width, dy / height) - 1) * height
}

/** Rock is negative. Carve the flooded passages, open pools and sealed air chamber. */
function tidalRock(x: number, y: number, z: number) {
  const warp = noise3(x * 0.11, y * 0.10, z * 0.09) - 0.5
  const bedding = Math.sin(y * 2.65 + x * 0.17 + 0.9 * Math.sin(z * 0.23))
  const rim = (Math.hypot((x - 1.6 * Math.sin(z * 0.17)) / 13.2, z / 31.5) - 1) * 13.2
  // Only the part that stands in the air is benched and broken; under water
  // the shelf keeps the smooth run the reef and the passages were cut into
  const inAir = y > -2
  // The gallery's roof is thin where it passes under the saddle between the
  // pools. Close over it the rock keeps its old plain surface: a cleft there
  // opened a third hole into the dive, which has exactly two ways in.
  const free = inAir ? smooth(galleryDistance(x, y, z), 1.6, 4.4) : 0
  const yb = inAir ? y + (benched(x, y, z, warp) - y) * free : y
  const top = 3.6 + 1.45 * Math.sin(z * 0.21 + x * 0.23) - x * 0.12
    + 3.5 * bell((x + 7) / 4.1) * bell((z + 8) / 12) + 2.1 * warp
    + 2.7 * bell((x - 7) / 3.2) * bell((z - 11) / 4.0)
    - 3.2 * bell((x - 3) / 4.8) * bell((z - 6.9) / 3.1)
  // Crags and clefts a few metres across, so the skyline is broken rock.
  // Rounded, not creased: a sharp ridge in the noise meshed as thorns.
  let crag = 0
  if (inAir) {
    const c = 2 * noise3(x * 0.2 + 7.3, y * 0.15, z * 0.2 - 2.9) - 1
    crag = (0.42 - c * c * 1.5) * 2.4 * smooth(y, -1, 1.5) * free
    // A cleft may not cut down where the rock is already low (in the saddle
    // it went under the tide and left a blind pool), nor along the line of
    // the gallery, where a deep hollow between the two pools read from above
    // as a third opening
    if (crag < 0) crag *= smooth(top, 1.0, 2.8) * smooth(Math.abs(x - centreX(z)), 4, 8.5)
  }
  const crest = top + crag
  const oldRidge = Math.max(
    (yb - crest + Math.max(0, rim + 4.5) * 0.75) * 0.85,
    rim + Math.max(-5.2, (yb - 0.5) * 0.32) + warp * 2.6 + bedding * 0.24,
  )
  const shoulder = (Math.hypot((x + 12.6) / 10.9, (z + 1) / 21.4) - 1) * 10.9
  const westRidge = Math.max(shoulder + Math.max(-3, (yb - 1) * 0.16) + warp * 1.9,
    (yb - 8.5 + Math.max(0, shoulder + 5) * 0.83 + 1.15 * Math.sin(x * 0.43 + z * 0.19) + warp - crag) * 0.9)
  let outside = smoothUnion(oldRidge, westRidge, 2.7)
  // Whatever the benches and clefts do to the outside, the air chamber keeps
  // close on two metres of rock over it: a hole in that roof would let the
  // daylight and the sea into a room that is meant to have neither
  if (y > -1 && x < -3 && Math.abs(z - room.z) < 14) {
    outside = smoothUnion(outside, (roomRadius(x, y, z) - 1) * 6.2 - 1.9, 1.2)
  }
  if (outside > 2.5 || y < -16) return outside

  let water = galleryDistance(x, y, z)
  for (const pool of pools) {
    const dx = x - pool.x + 0.9 * Math.sin((z - pool.z) * 0.46 + 1.8) + 0.14 * y
    const dz = z - pool.z + 0.18 * dx + 0.62 * Math.sin(x * 0.53)
    const radius = Math.hypot(dx / pool.rx, dz / pool.rz)
    // The lip spreads outward above the waterline. A dished floor under the
    // skylight joins the sandy floor of the passage.
    const shaft = Math.max((radius - 1) * pool.rx - (y + 3) * 0.09, pool.bottom + radius * radius * 0.8 - y)
    water = smoothUnion(water, shaft, 1.65)
  }
  if (x < 5 && z > -19 && z < 18) {
    const chamber = chamberDistance(x, y, z)
    water = smoothUnion(water, smoothUnion(passageDistance(x, y, z), chamber, 1.2), 0.95)
  }
  const chippedWall = warp * 1.5 + bedding * 0.24
  // A leaning basalt rib splits the edge of the first vault. Its far side
  // frames the second pool while leaving the main swim line wide.
  const rib = Math.hypot((x + 2.6 + (y + 5) * 0.33) / 1.05, (z - 3.0) / 1.7) - 1 + warp * 0.55
  return Math.max(outside, smoothUnion(-water + chippedWall, rib, 0.8))
}

const basalt = new THREE.Color('#696560')
const fracture = new THREE.Color('#a0998f')
const seam = new THREE.Color('#cdad84')
const moss = new THREE.Color('#6d7847')
/** The rock in the air: dark where it is steep and sheltered, bleached where sun and salt work on it. */
const darkBasalt = new THREE.Color('#47433e')
const bleached = new THREE.Color('#8a8272')
const silt = new THREE.Color('#dfc9a2')
const wetStone = new THREE.Color('#665446')
const flowstone = new THREE.Color('#d7b788')

function paintCaves(x: number, y: number, z: number, normal: THREE.Vector3, ao: number, color: THREE.Color) {
  const grain = noise3(x * 0.45, y * 0.61, z * 0.46)
  const bed = y * 1.8 + x * 0.15 + 0.65 * Math.sin(z * 0.22) + grain * 0.45
  const vein = 1 - smooth(Math.abs(Math.sin(bed)), 0.06, 0.35)
  color.copy(basalt).lerp(fracture, grain * 0.72).lerp(seam, vein * (0.38 + grain * 0.32))
  const inRoom = roomRadius(x, y, z) < 1.15
  if (inRoom) {
    // Ochre runnels follow the wet walls from the roof down to the tide mark.
    const runnel = Math.cos(x * 2.2 + z * 1.4 + 1.1 * Math.sin(z * 1.55) + y * 0.14 + grain * 0.9)
    color.lerp(wetStone, 0.46).lerp(flowstone, smooth(runnel, 0.45, 1) * (0.27 + 0.32 * grain))
  } else if (y > 0) {
    // Bare basalt. The benches weather pale, the risers stay dark, and the
    // only green is a little dry growth in the cracks of the highest ground:
    // an even moss over the whole top read as a lawn on a dune.
    const flat = smooth(normal.y, 0.55, 0.9)
    color.copy(darkBasalt).lerp(basalt, 0.3 + 0.45 * grain)
      .lerp(bleached, flat * smooth(y, 1.4, 4.2) * (0.3 + 0.5 * grain))
    const tuft = smooth(noise3(x * 0.55 + 4.2, y * 0.3, z * 0.55 - 9.1), 0.6, 0.78)
    color.lerp(moss, tuft * flat * smooth(y, 3.0, 5.5) * 0.4)
  } else {
    // A pale silty thread catches the skylight and leads around the blind bend.
    const channel = bell((x - centreX(z)) / 4.3)
    color.lerp(silt, smooth(normal.y, 0.45, 0.91) * channel * smooth(-y, 2.3, 5.7))
    color.multiplyScalar(THREE.MathUtils.lerp(1, 0.48 + 0.67 * skyOpening(x, z), channel * smooth(-y, 0, 3)))
  }
  // Wet basalt is darkest at the tide mark.
  color.multiplyScalar((0.65 + 0.35 * ao) * (1 - 0.31 * bell((y - 0.1) / 0.95)))
}

export function createTidalCaves(scene: THREE.Scene, lowPower: boolean) {
  const rock = buildRockSurface(tidalRock, BOUNDS, lowPower ? 1.05 : 0.78, paintCaves)
  const pos = rock.geometry.attributes.position
  const exposure = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    const exterior = smooth(Math.abs(x - centreX(z)), 6.5, 10)
    const y = pos.getY(i)
    const sealed = roomRadius(x, y, z) < 1.20 || (x < -4 && y < -3 && passageDistance(x, y, z) < 1.35)
    exposure[i] = sealed ? 0 : Math.max(exterior, skyOpening(x, z))
  }
  rock.geometry.setAttribute('causticExposure', new THREE.BufferAttribute(exposure, 1))
  const rockMaterial = reefRockMaterial({ vertexColors: true, roughness: 0.88 }, false, true)
  const shoreTide = rockMaterial.userData.shoreTide as { value: number }
  const mesh = new THREE.Mesh(rock.geometry, rockMaterial)
  mesh.name = 'Tidal caves'
  mesh.position.set(SITE.x, 0, SITE.z)
  scene.add(mesh)
  const coral = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.89 })
  for (const pool of pools) {
    const garden = reefLife(rock, { count: lowPower ? 9 : 17, centre: [pool.x + 3.3, pool.z], reach: 4.8, minY: -11, maxY: -1.7 })
    if (garden) mesh.add(new THREE.Mesh(garden, coral))
  }
  const residents = createCaveLife(mesh, rock, room, lowPower)
  // Only the water within this footprint can see the chamber ceiling. Its
  // outer edge lies in solid rock at both tidal extremes.
  const chamberWater = new THREE.Vector4(SITE.x + room.x, SITE.z + room.z, 1 / 7.9, 1 / 9.1)
  function chamberPresence(eye: THREE.Vector3) {
    if (!nearby(eye.x, eye.z)) return 0
    return 1 - smooth(roomRadius(eye.x - SITE.x, eye.y, eye.z - SITE.z), 0.90, 1.22)
  }

  // Suspended silt catches the sun below each opening. The feathered sheets
  // turn about the shafts, so the light stays at the pools as the diver moves.
  const light = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uTide: { value: 0 }, uSlant: { value: new THREE.Vector2() }, uSun: { value: 0 }, uTime: { value: 0 } },
    vertexShader: `
      uniform float uTide; uniform vec2 uSlant; varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.);
        world.y += uTide;
        world.xz -= uSlant * (uTide - world.y);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      uniform float uSun; uniform float uTime; varying vec2 vUv;
      void main() {
        float across = vUv.x * 2. - 1.;
        float feather = exp(-4.5 * across * across) * (1. - smoothstep(.7, 1., abs(across)));
        float streak = .65 + .22 * sin(vUv.x * 23. + .55 * sin(uTime * .42))
                            + .13 * sin(vUv.x * 47. + vUv.y * .7 + uTime * .19);
        float fade = smoothstep(0., .40, vUv.y) * (1. - smoothstep(.90, 1., vUv.y));
        gl_FragColor = vec4(.46, .85, .81, feather * streak * fade * uSun * .22);
      }`,
  })
  const shafts = pools.map(pool => {
    const depth = -pool.bottom
    const shaft = new THREE.Mesh(new THREE.PlaneGeometry(pool.rx * 1.5, depth), light)
    shaft.position.set(pool.x, -depth * 0.5, pool.z)
    shaft.visible = false
    shaft.renderOrder = 2
    mesh.add(shaft)
    return shaft
  })
  function update(camera: THREE.PerspectiveCamera, sun: THREE.Vector3, strength: number, tide: number, time: number,
    night: number, underwater: boolean, onDrip: (level: number, pan: number) => void) {
    const eye = camera.position
    shoreTide.value = tide
    residents.update(camera, sun, time, night, underwater, onDrip)
    const visible = strength > 0.02 && nearby(eye.x, eye.z) && eye.y < tide
    for (const shaft of shafts) {
      shaft.visible = visible
      if (visible) shaft.rotation.y = Math.atan2(eye.x - SITE.x - shaft.position.x, eye.z - SITE.z - shaft.position.z)
    }
    if (!visible) return
    light.uniforms.uSun.value = strength
    light.uniforms.uSlant.value.set(sun.x * 0.46, sun.z * 0.46)
    light.uniforms.uTide.value = tide
    light.uniforms.uTime.value = time
  }

  function nearby(x: number, z: number) {
    return Math.abs(x - SITE.x) < BOUNDS.x1 && Math.abs(z - SITE.z) < BOUNDS.z1
  }
  const local = new THREE.Vector3()
  function resolve(p: { x: number; y: number; z: number }) {
    if (!nearby(p.x, p.z) || p.y > BOUNDS.y1) return
    local.set(p.x - SITE.x, p.y, p.z - SITE.z)
    if (rock.pushOut(local, 0.52)) {
      p.x = SITE.x + local.x
      p.y = local.y
      p.z = SITE.z + local.z
    }
  }
  function floorAt(x: number, z: number, fromY = BOUNDS.y1) {
    if (!nearby(x, z)) return -Infinity
    return rock.surfaceDown(x - SITE.x, z - SITE.z, Math.min(fromY, BOUNDS.y1))?.y ?? -Infinity
  }
  function inGallery(x: number, y: number, z: number) {
    const along = z - SITE.z
    // Include the approaches. The open-ocean buoyancy would otherwise sweep
    // a returning diver above the arch just before they reach its mouth.
    if (y >= -2 || y < -15 || !nearby(x, z)) return false
    const across = x - SITE.x
    return (Math.abs(along) < 43 && Math.abs(across - centreX(along)) < 7 && y > -11)
      || roomRadius(across, y, along) < 1.08 || passageDistance(across, y, along) < 0.8
  }

  // Keep the optional tracking camera on the diver's side of a cave wall.
  function clipView(target: THREE.Vector3, eye: THREE.Vector3) {
    if (!nearby(target.x, target.z)) return
    const steps = Math.ceil(eye.distanceTo(target) / 0.25)
    for (let i = 1; i <= steps; i++) {
      local.lerpVectors(target, eye, i / steps)
      if (rock.distance(local.x - SITE.x, local.y, local.z - SITE.z) < 0.24) {
        eye.lerpVectors(target, eye, (i - 1) / steps)
        return
      }
    }
  }
  const entrance = { x: SITE.x + pools[0].x, z: SITE.z + pools[0].z + 2.3, yaw: 0.15, pitch: -0.11 }
  return { mesh, entrance, chamberWater, chamberPresence, resolve, floorAt, inGallery, clipView, update }
}
