import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { type ReefRock, noise3 } from './reefrock'
import { createShoalMesh } from './underwater'
import { sampleOcean } from './waves'

type Room = { x: number; z: number; rx: number; rz: number }
type Triple = [number, number, number]
const up = new THREE.Vector3(0, 1, 0)

/** Start in the cavity and walk the same distance field that stops the diver. */
function rockFace(rock: ReefRock, start: THREE.Vector3, direction: THREE.Vector3, reach: number) {
  const p = start.clone()
  let d = rock.distance(p.x, p.y, p.z)
  if (d <= 0) return null
  for (let travelled = 0; travelled < reach;) {
    const step = THREE.MathUtils.clamp(d * 0.72, 0.025, 0.55)
    p.addScaledVector(direction, step)
    travelled += step
    d = rock.distance(p.x, p.y, p.z)
    if (d < 0.025) {
      const e = 0.17
      const normal = new THREE.Vector3(
        rock.distance(p.x + e, p.y, p.z) - rock.distance(p.x - e, p.y, p.z),
        rock.distance(p.x, p.y + e, p.z) - rock.distance(p.x, p.y - e, p.z),
        rock.distance(p.x, p.y, p.z + e) - rock.distance(p.x, p.y, p.z - e),
      ).normalize()
      return { p, normal }
    }
  }
  return null
}

/** One coloured mesh per species. The antennae, articulated legs and tail fan
 * retain their silhouette when the swimmer gets close to the rock. */
function crustacean(lobster: boolean) {
  const parts: THREE.BufferGeometry[] = []
  const shell = lobster ? '#995239' : '#ed7357'
  const plate = lobster ? '#ba7546' : '#ffe4c9'
  const ivory = '#f5d7a1'
  const wide = lobster ? 1.0 : 0.63
  function add(geo: THREE.BufferGeometry, tone: string) {
    geo.deleteAttribute('uv')
    const colors = new Float32Array(geo.attributes.position.count * 3)
    const color = new THREE.Color(tone)
    for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i)
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    parts.push(geo)
  }
  function oval(at: Triple, size: Triple, tone: string, yaw = 0) {
    const g = new THREE.SphereGeometry(1, 10, 7)
    g.scale(...size).rotateY(yaw).translate(...at)
    add(g, tone)
  }
  function rod(a: Triple, b: Triple, r1: number, r2: number, tone: string) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b)
    const axis = end.clone().sub(start)
    const g = new THREE.CylinderGeometry(r2, r1, axis.length(), 5)
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, axis.normalize()))
    const mid = start.lerp(end, 0.5)
    add(g.translate(mid.x, mid.y, mid.z), tone)
  }
  oval([0, 0.135, 0.10], [0.14 * wide, 0.105, 0.23], shell)
  // Longitudinal saddle and overlapping armoured tail plates.
  oval([0, 0.228, 0.10], [0.032 * wide, 0.013, 0.165], plate)
  for (let i = 0; i < 6; i++) {
    const taper = 1 - i * 0.09
    const y = 0.12 - i * 0.01, z = -0.102 - i * 0.052
    oval([0, y, z], [0.115 * wide * taper, 0.083 * taper, 0.065], shell)
    oval([0, y + 0.007, z - 0.020], [0.117 * wide * taper, 0.083 * taper, 0.019], plate)
  }
  for (let k = -2; k <= 2; k++) {
    oval([k * 0.036 * wide, 0.056, -0.45 + Math.abs(k) * 0.014],
      [0.040 * wide, 0.018, 0.108], k % 2 ? plate : shell, -k * 0.29)
  }
  for (const s of [-1, 1]) {
    const eye = s * 0.085 * wide
    rod([eye * 0.85, 0.174, 0.24], [eye, 0.237, 0.28], 0.024, 0.019, plate)
    oval([eye, 0.24, 0.285], [0.030, 0.030, 0.035], '#172523')
    oval([eye + s * 0.011, 0.255, 0.305], [0.009, 0.009, 0.009], ivory)
    const horn: Triple = [s * 0.125, 0.25, 0.43]
    const mid: Triple = [s * (lobster ? 0.34 : 0.28), 0.36, 0.66]
    rod([s * 0.050, 0.185, 0.26], horn, lobster ? 0.027 : 0.012, 0.010, plate)
    rod(horn, mid, 0.010, 0.006, ivory)
    rod(mid, [s * 0.43, 0.295, lobster ? 0.97 : 1.02], 0.006, 0.002, ivory)
    for (let j = 0; j < 4; j++) {
      const z = 0.16 - j * 0.074
      const knee: Triple = [s * (0.23 * wide + 0.035), 0.139, z + 0.055 - j * 0.012]
      rod([s * 0.073 * wide, 0.10, z], knee, 0.017, 0.013, shell)
      rod(knee, [s * (0.29 * wide + 0.05), 0.012, z - 0.015 - j * 0.024], 0.014, 0.0045, plate)
    }
    if (lobster) {
      rod([s * 0.096, 0.115, 0.22], [s * 0.245, 0.125, 0.27], 0.038, 0.033, shell)
      oval([s * 0.25, 0.135, 0.34], [0.058, 0.046, 0.11], shell, s * 0.14)
      rod([s * 0.278, 0.14, 0.395], [s * 0.26, 0.145, 0.49], 0.025, 0.006, plate)
      rod([s * 0.224, 0.14, 0.394], [s * 0.244, 0.15, 0.467], 0.020, 0.004, ivory)
    }
  }
  const geometry = mergeGeometries(parts)!
  parts.forEach(g => g.dispose())
  return geometry
}

function shellfish(parent: THREE.Group, rock: ReefRock, low: boolean) {
  const clock = { value: 0 }
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.47, metalness: 0.06 })
  material.onBeforeCompile = shader => {
    shader.uniforms.uCaveTime = clock
    shader.vertexShader = 'uniform float uCaveTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      float feeler = smoothstep(.38, 1.02, position.z);
      float beat = uCaveTime * 1.7 + instanceMatrix[3].x * 2.8;
      transformed.x += sin(beat + position.z * 3.2) * feeler * .071;
      transformed.y += cos(beat * .73 + sign(position.x)) * feeler * .035;
    `)
  }
  // Cast from the entrances toward opposing side walls. The lobsters sit
  // lower, where the wall folds into the floor of the deeper return arch.
  const ledges: Triple[] = [[-3.7,-6.7,10.9], [-9.7,-8.0,8.0], [-13.6,-10.4,-12.6], [-4.2,-8.0,-12.8]]
  for (const lobster of [false, true]) {
    const count = lobster ? (low ? 3 : 5) : (low ? 12 : 21)
    const mesh = new THREE.InstancedMesh(crustacean(lobster), material, count)
    mesh.name = lobster ? 'Lobsters in basalt crevices' : 'Banded shrimp on the side walls'
    mesh.userData.noCast = true
    const pose = new THREE.Object3D()
    let used = 0
    for (let i = 0; used < count && i < count * 3; i++) {
      const ledge = ledges[(i + (lobster ? 2 : 0)) % ledges.length]
      const angle = i * 2.39996 + (lobster ? 1.3 : 0)
      const start = new THREE.Vector3(...ledge)
      start.z += 0.85 * Math.sin(angle * 1.8)
      const dir = new THREE.Vector3(Math.cos(angle), lobster ? -0.78 : 0.30 * Math.sin(angle * 2.7), Math.sin(angle)).normalize()
      const hit = rockFace(rock, start, dir, 7.3)
      if (!hit || hit.p.y > -2.2) continue
      pose.position.copy(hit.p)
      pose.quaternion.setFromUnitVectors(up, hit.normal)
      pose.rotateY(angle)
      pose.scale.setScalar((lobster ? 0.94 : 0.46) * (1 + 0.17 * Math.sin(i * 3.73)))
      pose.updateMatrix()
      mesh.setMatrixAt(used++, pose.matrix)
    }
    mesh.count = used
    mesh.computeBoundingSphere()
    parent.add(mesh)
  }
  return clock
}

function ceilingLights(parent: THREE.Group, rock: ReefRock, room: Room, low: boolean) {
  const positions: number[] = [], strands: number[] = [], phases: number[] = []
  // Clusters grow along damp seams. Beads hang off short silk threads, each
  // starting on the real underside rather than at a flat height.
  const candidates = low ? 320 : 610
  const random = (i: number, salt: number) => THREE.MathUtils.euclideanModulo(Math.sin(i * 127.1 + salt * 311.7) * 43758.5453, 1)
  for (let i = 0; i < candidates; i++) {
    const a = i * 2.39996, r = Math.sqrt((i + 0.5) / candidates)
    const x = room.x + Math.cos(a) * r * room.rx * 0.98
    const z = room.z + Math.sin(a) * r * room.rz
    if (noise3(x * 0.48, 3.7, z * 0.41) < 0.40) continue
    const hit = rockFace(rock, new THREE.Vector3(x, 0.96, z), up, 8)
    if (!hit || hit.p.y < 1.56) continue
    const root = hit.p
    const length = 0.055 + 0.64 * random(i, 9) ** 2
    const tx = x + 0.045 * Math.sin(a), tz = z + 0.046 * Math.cos(a)
    strands.push(x, root.y, z, tx, root.y - length, tz)
    positions.push(x, root.y - 0.04, z)
    phases.push(random(i, 7))
    if (length > 0.23) {
      positions.push(tx, root.y - length, tz)
      phases.push(random(i, 12) * 0.75)
    }
  }
  const strandGeo = new THREE.BufferGeometry()
  strandGeo.setAttribute('position', new THREE.Float32BufferAttribute(strands, 3))
  const silk = new THREE.LineBasicMaterial({ color: '#8bbfae', transparent: true, opacity: 0.16, depthWrite: false })
  parent.add(new THREE.LineSegments(strandGeo, silk))
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(phases, 1))
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uNight: { value: 0 }, uTime: { value: 0 }, uPixels: { value: 640 } },
    vertexShader: `
      uniform float uTime, uPixels; attribute float aSeed; varying float vPulse, vSeed;
      void main() {
        vec4 eye = modelViewMatrix * vec4(position, 1.);
        vSeed = aSeed;
        vPulse = .77 + .23 * sin(uTime * (.4 + aSeed * .5) + aSeed * 56.);
        gl_PointSize = clamp(uPixels * (.040 + .050 * aSeed) / max(.25, -eye.z), 2., 22.);
        gl_Position = projectionMatrix * eye;
      }`,
    fragmentShader: `
      uniform float uNight; varying float vPulse, vSeed;
      void main() {
        float r = length(gl_PointCoord - .5) * 2.;
        float halo = max(0., exp(-4.5*r*r) - .012);
        vec3 tint = mix(vec3(.035,.76,.71), vec3(.29,1.,.55), vSeed);
        tint += vec3(.55,.75,.63) * exp(-30.*r*r);
        gl_FragColor = vec4(tint, halo * vPulse * (.12 + 1.45*uNight));
      }`,
  })
  const dots = new THREE.Points(geometry, material)
  dots.name = 'Glowworm ceiling'
  dots.renderOrder = 3
  // The scene buffer can be smaller than the canvas (post.ts setScale)
  dots.onBeforeRender = renderer => {
    material.uniforms.uPixels.value = renderer.getRenderTarget()?.height ?? renderer.domElement.height
  }
  parent.add(dots)
  return { material, silk }
}

export function createCaveLife(parent: THREE.Mesh, rock: ReefRock, room: Room, low: boolean) {
  const life = new THREE.Group()
  life.name = 'Tidal cave residents'
  parent.add(life)
  const antennaClock = shellfish(life, rock, low)
  const glow = ceilingLights(life, rock, room, low)
  // Hung on the rock, not on `life`, which is hidden when you are far away:
  // a light that leaves the scene makes every lit shader in it rebuild (a
  // freeze of seconds on the approach to the caves). It dims to nothing instead.
  const poolLight = new THREE.PointLight('#98d6c6', 0, 18, 2)
  poolLight.position.set(room.x - 0.9, 1.05, room.z - 2.4)
  parent.add(poolLight)

  // Sheltered little schools at the two junctions. Their short orbits stay
  // inside the deep mouths of the pools and pass clear of the rock.
  const perSchool = low ? 6 : 10
  const fish = createShoalMesh(perSchool * 2, new THREE.Color('#175c66'))
  fish.name = 'Fish sheltering in the pool mouths'
  fish.material.uniforms.uBody.value.set('#a85a42')
  fish.material.uniforms.uBelly.value.set('#d8b994')
  fish.userData.noCast = true
  life.add(fish)
  const pose = new THREE.Object3D()

  const dropMaterial = new THREE.MeshBasicMaterial({ color: '#92ccca', transparent: true, opacity: 0.7 })
  const dropGeo = new THREE.SphereGeometry(0.026, 7, 5).scale(0.8, 2.8, 0.8)
  const ringGeo = new THREE.RingGeometry(0.94, 1, 40).rotateX(-Math.PI / 2)
  const seeps = [[-2.8,1.4,2.85], [2.1,-2.5,4.13], [1.6,3.1,3.57]].flatMap(([dx,dz,period], i) => {
    const x = room.x + dx, z = room.z + dz
    const roof = rockFace(rock, new THREE.Vector3(x, 1.0, z), up, 8)
    if (!roof) return []
    const drop = new THREE.Mesh(dropGeo, dropMaterial)
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: '#88b7ae', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    }))
    ring.renderOrder = 4
    life.add(drop, ring)
    return [{ x, z, roof: roof.p.y, phase: i * 0.93, period, drop, ring, age: -1 }]
  })

  function update(camera: THREE.PerspectiveCamera, sun: THREE.Vector3, t: number, night: number,
    underwater: boolean, onDrip: (level: number, pan: number) => void) {
    const eye = camera.position
    const x = eye.x - parent.position.x, z = eye.z - parent.position.z
    life.visible = Math.abs(x + 5) < 50 && Math.abs(z) < 57 && eye.y < 20
    if (!life.visible) {
      poolLight.intensity = 0
      for (const seep of seeps) seep.age = -1
      return
    }
    antennaClock.value = t
    glow.material.uniforms.uNight.value = night
    glow.material.uniforms.uTime.value = t
    glow.silk.opacity = 0.055 + 0.17 * night
    poolLight.intensity = 39 - 9 * night
    fish.material.uniforms.uTime.value = t
    fish.material.uniforms.uSunDir.value.copy(sun)
    for (let i = 0; i < fish.count; i++) {
      const first = i < perSchool
      const k = i % perSchool, a = t * (first ? 0.37 : -0.32) + k * 0.47
      const r = 0.72 + 0.28 * Math.sin(k * 1.7)
      pose.position.set((first ? 1.9 : -1.4) + r * Math.cos(a),
        (first ? -5.28 : -6.48) + 0.25 * Math.sin(a + k * 2.1),
        (first ? 11.8 : -10.6) + 0.72 * r * Math.sin(a))
      pose.rotation.set(0, Math.atan2(-Math.sin(a), 0.72 * Math.cos(a)) + (first ? 0 : Math.PI), 0.08 * Math.sin(t + k))
      pose.scale.setScalar(0.26 + 0.065 * Math.sin(k))
      pose.updateMatrix()
      fish.setMatrixAt(i, pose.matrix)
    }
    fish.instanceMatrix.needsUpdate = true

    const nearRoom = Math.hypot(x - room.x, z - room.z) < 8.1 && eye.y < 5.6 && eye.y > -3
    for (const s of seeps) {
      if (!nearRoom) {
        s.drop.visible = s.ring.visible = false
        s.age = -1
        continue
      }
      const water = sampleOcean(parent.position.x + s.x, parent.position.z + s.z, t).y
      const age = (t + s.phase) % s.period
      const fall = Math.sqrt(2 * Math.max(0.1, s.roof - water) / 9.81)
      const elapsed = age - (s.period - fall)
      s.drop.visible = elapsed >= 0
      s.drop.position.set(s.x, s.roof - 4.905 * Math.max(0, elapsed) ** 2, s.z)
      s.ring.visible = age < 1.15
      s.ring.position.set(s.x, water + 0.032, s.z)
      s.ring.scale.setScalar(0.04 + age * 0.48)
      s.ring.material.opacity = Math.max(0, 1 - age / 1.15) * 0.55
      if (age < s.age && !underwater) {
        const dx = s.x - x, dz = s.z - z
        const pan = (dx * Math.cos(camera.rotation.y) - dz * Math.sin(camera.rotation.y)) / 6
        onDrip(0.72 / (1 + 0.12 * Math.hypot(dx, dz)), THREE.MathUtils.clamp(pan, -0.85, 0.85))
      }
      s.age = age
    }
  }
  return { update }
}
