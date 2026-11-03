import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Hud } from './hud'
import { sampleOcean } from './waves'

/**
 * Island sky, freshwater pool, and nocturnal life:
 *
 *  - White-tailed tropicbirds (Phaethon lepturus) banking along the cove cliffs
 *    and palm crowns with long streaming tail ribbons.
 *  - Ancient giant tortoises (Aldabrachelys / Chelonoidis) grazing in the
 *    shady fern clearings and around the freshwater rain pools.
 *  - Spiny volcanic iguanas (Amblyrhynchus) basking on warm basalt boulders.
 *  - Twilight flying foxes (fruit bats - Pteropus) soaring across the volcanic peak.
 *  - Metallic emerald and sapphire dragonflies hovering, darting, and dipping
 *    concentric ripples onto the inland basalt rain pools.
 *  - Canopy fireflies waking under the palms and around the pools at dusk.
 *  - Noctiluca sea-sparkle: bioluminescent plankton stirred by your swimming
 *    strokes, wading steps, and surfacing sea life after dark.
 */

const TAU = Math.PI * 2

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt))
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
const angleDelta = (a: number, b: number) => ((b - a + Math.PI * 3) % TAU) - Math.PI

function stripBasic(geo: THREE.BufferGeometry) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone()
  if (!g.attributes.normal) g.computeVertexNormals()
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal') g.deleteAttribute(k)
  }
  return g
}

function paint(
  geo: THREE.BufferGeometry,
  pick: (x: number, y: number, z: number, ny: number) => THREE.Color,
) {
  const pos = geo.attributes.position
  const nor = geo.attributes.normal
  const out = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const c = pick(pos.getX(i), pos.getY(i), pos.getZ(i), nor.getY(i))
    out[i * 3] = c.r
    out[i * 3 + 1] = c.g
    out[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3))
}

// —— 1. White-tailed tropicbird (Phaethon lepturus) ——————————————————

function buildTropicbird(mat: THREE.Material) {
  const root = new THREE.Group()

  // Sleek spindle body (+X forward)
  const torso = stripBasic(new THREE.SphereGeometry(1, 10, 7))
  torso.scale(0.24, 0.068, 0.065)
  const head = stripBasic(new THREE.SphereGeometry(0.056, 8, 6))
  head.scale(1.25, 0.95, 0.9)
  head.translate(0.24, 0.022, 0)
  const bill = stripBasic(new THREE.ConeGeometry(0.02, 0.11, 5))
  bill.rotateZ(-Math.PI / 2)
  bill.translate(0.33, 0.016, 0)
  const fanTail = stripBasic(new THREE.ConeGeometry(0.055, 0.16, 4))
  fanTail.scale(1, 1, 0.25)
  fanTail.rotateZ(Math.PI / 2)
  fanTail.translate(-0.24, 0.005, 0)

  const bodyGeo = mergeGeometries([torso, head, bill, fanTail], false) as THREE.BufferGeometry
  bodyGeo.computeVertexNormals()

  const white = new THREE.Color('#f4f6f7')
  const shadowWhite = new THREE.Color('#cfd8de')
  const coralBill = new THREE.Color('#e27329')
  const blackMark = new THREE.Color('#1a2026')
  const tmp = new THREE.Color()

  paint(bodyGeo, (x, y, z, ny) => {
    if (x > 0.285) return tmp.copy(coralBill)
    // Crisp dark eye-mask crescent
    if (x > 0.22 && x < 0.27 && y > 0.015 && Math.abs(z) > 0.035) return tmp.copy(blackMark)
    return tmp.copy(white).lerp(shadowWhite, smooth(0.1, -0.5, ny) * 0.45)
  })
  root.add(new THREE.Mesh(bodyGeo, mat))

  // Swept tern-like wings with black outer primary slashes and dorsal bar
  const makeWing = (side: number) => {
    const pivot = new THREE.Group()
    pivot.position.set(0.04, 0.025, side * 0.045)
    const s = new THREE.Shape()
    s.moveTo(0.08, 0)
    // Forward wrist crook -> long pointed primary tip
    s.quadraticCurveTo(0.11, side * 0.22, -0.06, side * 0.54)
    s.quadraticCurveTo(-0.12, side * 0.52, -0.14, side * 0.36)
    s.quadraticCurveTo(-0.11, side * 0.18, -0.09, 0)
    s.closePath()
    const g = stripBasic(new THREE.ExtrudeGeometry(s, { depth: 0.01, bevelEnabled: false, curveSegments: 5 }))
    g.translate(0, 0, -0.005)
    g.rotateX(-Math.PI / 2)
    g.computeVertexNormals()
    paint(g, (x, _y, z, ny) => {
      const span = Math.abs(z) / 0.54
      // Signature black wingtips & diagonal black upper-wing bar
      if (span > 0.74 && x > -0.1) return tmp.copy(blackMark)
      const diagBar = ny > 0 && Math.abs(x - (-0.01 - span * 0.06)) < 0.024 && span > 0.22 && span < 0.68
      if (diagBar) return tmp.copy(blackMark)
      return tmp.copy(white).lerp(shadowWhite, smooth(0.2, -0.4, ny) * 0.35)
    })
    pivot.add(new THREE.Mesh(g, mat))
    root.add(pivot)
    return pivot
  }

  const wingL = makeWing(1)
  const wingR = makeWing(-1)

  // Two long streaming white tail ribbons (~0.95 m) trailing from -0.28 to -1.23
  const segs = 10
  const streamLen = 0.95
  const ribbonParts: THREE.BufferGeometry[] = []
  for (const side of [-1, 1]) {
    const p = new THREE.PlaneGeometry(streamLen, 0.022, segs, 1)
    // Taper to a fine point aft (-X)
    const pos = p.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const u = clamp(0.5 - pos.getX(i) / streamLen, 0, 1)
      pos.setY(i, pos.getY(i) * (1 - u * 0.72))
    }
    p.rotateX(Math.PI * 0.32 * side)
    p.translate(-0.28 - streamLen * 0.5, 0.004, side * 0.016)
    ribbonParts.push(stripBasic(p))
  }
  const streamGeo = mergeGeometries(ribbonParts, false) as THREE.BufferGeometry
  streamGeo.computeVertexNormals()
  paint(streamGeo, () => white)
  const streamRest = Float32Array.from(streamGeo.attributes.position.array as Float32Array)
  const streamers = new THREE.Mesh(streamGeo, mat)
  streamers.frustumCulled = false
  streamers.userData.noCast = true
  root.add(streamers)

  return { root, wingL, wingR, streamers, streamRest, streamLen }
}

// —— 2. Jewel dragonfly —————————————————————————————————————————————

function buildDragonfly(hue: 'emerald' | 'sapphire', bodyMat: THREE.Material, wingMat: THREE.Material) {
  const root = new THREE.Group()

  const thorax = stripBasic(new THREE.SphereGeometry(0.016, 7, 5))
  thorax.scale(1.4, 0.95, 0.9)
  const head = stripBasic(new THREE.SphereGeometry(0.014, 7, 5))
  head.scale(0.9, 0.95, 1.35)
  head.translate(0.028, 0.003, 0)
  const abdomen = stripBasic(new THREE.CylinderGeometry(0.004, 0.007, 0.095, 6))
  abdomen.rotateZ(Math.PI / 2)
  abdomen.translate(-0.062, -0.002, 0)

  const bodyGeo = mergeGeometries([thorax, head, abdomen], false) as THREE.BufferGeometry
  bodyGeo.computeVertexNormals()

  const primary = new THREE.Color(hue === 'emerald' ? '#12c488' : '#1f8cf0')
  const darkRing = new THREE.Color('#101c22')
  const eyeCol = new THREE.Color(hue === 'emerald' ? '#36f5a8' : '#58c4ff')
  const tmp = new THREE.Color()
  paint(bodyGeo, (x) => {
    if (x > 0.02) return tmp.copy(eyeCol)
    if (x < -0.018) {
      const seg = Math.sin(x * 260) * 0.5 + 0.5
      return tmp.copy(primary).lerp(darkRing, smooth(0.45, 0.85, seg) * 0.7)
    }
    return tmp.copy(primary)
  })
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat)
  bodyMesh.userData.noShadow = true
  root.add(bodyMesh)

  // Four slender hyaline wings (fore + hind pair)
  const wingPair = (xOff: number, sweep: number, span: number) => {
    const gL = new THREE.PlaneGeometry(0.016, span)
    gL.rotateX(-Math.PI / 2)
    gL.rotateY(sweep)
    gL.translate(0, 0, span * 0.5)
    const pivotL = new THREE.Group()
    pivotL.position.set(xOff, 0.008, 0.006)
    const mL = new THREE.Mesh(gL, wingMat)
    mL.userData.noShadow = true
    pivotL.add(mL)

    const gR = new THREE.PlaneGeometry(0.016, span)
    gR.rotateX(-Math.PI / 2)
    gR.rotateY(-sweep)
    gR.translate(0, 0, -span * 0.5)
    const pivotR = new THREE.Group()
    pivotR.position.set(xOff, 0.008, -0.006)
    const mR = new THREE.Mesh(gR, wingMat)
    mR.userData.noShadow = true
    pivotR.add(mR)

    root.add(pivotL, pivotR)
    return { pivotL, pivotR }
  }
  const fore = wingPair(0.008, 0.14, 0.068)
  const hind = wingPair(-0.008, -0.12, 0.062)

  root.userData.noShadow = true
  return { root, fore, hind }
}

// —— 3. Ancient giant tortoise (Aldabrachelys / Chelonoidis) ——————

function buildTortoise(mat: THREE.Material) {
  const root = new THREE.Group()

  // High domed carapace (+X is forward)
  const shellGeo = stripBasic(new THREE.SphereGeometry(0.55, 16, 12, 0, TAU, 0, Math.PI * 0.54))
  shellGeo.scale(1.15, 0.72, 0.88)
  shellGeo.translate(0, 0.16, 0)

  // Raised vertebral scute domes along the dorsal ridge
  const scutes: THREE.BufferGeometry[] = [shellGeo]
  for (let i = 0; i < 4; i++) {
    const sc = stripBasic(new THREE.SphereGeometry(0.16, 8, 6, 0, TAU, 0, Math.PI * 0.45))
    sc.scale(1.05, 0.55, 0.95)
    sc.translate(0.32 - i * 0.22, 0.44 + (i === 1 || i === 2 ? 0.04 : 0), 0)
    scutes.push(sc)
  }

  // Flared marginal skirt rim around the bottom perimeter
  const skirt = stripBasic(new THREE.TorusGeometry(0.52, 0.055, 6, 20))
  skirt.scale(1.16, 0.5, 0.88)
  skirt.rotateX(Math.PI / 2)
  skirt.translate(0, 0.16, 0)
  scutes.push(skirt)

  // Plastron (flat bottom shell plate)
  const plastron = stripBasic(new THREE.CylinderGeometry(0.48, 0.52, 0.08, 12))
  plastron.scale(1.1, 1.0, 0.82)
  plastron.translate(0, 0.14, 0)
  scutes.push(plastron)

  // Stubby tail
  const tail = stripBasic(new THREE.ConeGeometry(0.04, 0.18, 5))
  tail.rotateZ(Math.PI / 2)
  tail.translate(-0.62, 0.16, 0)
  scutes.push(tail)

  const mergedShell = mergeGeometries(scutes, false) as THREE.BufferGeometry
  mergedShell.computeVertexNormals()

  const hornDark = new THREE.Color('#24201b')
  const amberScute = new THREE.Color('#86572b')
  const ringLight = new THREE.Color('#c29a62')
  const plastronCol = new THREE.Color('#8a7b64')
  const tmp = new THREE.Color()

  paint(mergedShell, (x, y, z, ny) => {
    if (y < 0.15 && ny < -0.2) return tmp.copy(plastronCol)
    const rad = Math.hypot(x * 0.9, z * 1.1)
    const ring = Math.sin(rad * 28.0) * 0.5 + 0.5
    const scuteCenter = Math.sin(x * 12.0) * Math.cos(z * 10.0)
    tmp.copy(hornDark).lerp(amberScute, smooth(0.15, 0.75, scuteCenter))
    tmp.lerp(ringLight, smooth(0.65, 0.95, ring) * 0.45)
    if (rad > 0.46) tmp.lerp(ringLight, smooth(0.46, 0.58, rad) * 0.35)
    return tmp
  })

  const shellMesh = new THREE.Mesh(mergedShell, mat)
  root.add(shellMesh)

  // Head and neck group (hinged / retractable at front shell aperture)
  const neckPivot = new THREE.Group()
  neckPivot.position.set(0.42, 0.24, 0)

  const neckGeo = stripBasic(new THREE.CylinderGeometry(0.09, 0.12, 0.28, 8))
  neckGeo.rotateZ(-Math.PI / 2)
  neckGeo.translate(0.14, 0.04, 0)

  const headGeo = stripBasic(new THREE.SphereGeometry(0.11, 10, 7))
  headGeo.scale(1.3, 0.95, 0.9)
  headGeo.translate(0.32, 0.08, 0)

  const beakGeo = stripBasic(new THREE.ConeGeometry(0.045, 0.12, 5))
  beakGeo.rotateZ(-Math.PI / 2)
  beakGeo.translate(0.44, 0.04, 0)

  const mergedHead = mergeGeometries([neckGeo, headGeo, beakGeo], false) as THREE.BufferGeometry
  mergedHead.computeVertexNormals()

  const skinDark = new THREE.Color('#38342e')
  const skinLight = new THREE.Color('#62584a')
  const beakHorn = new THREE.Color('#b58e5a')
  const eyeDark = new THREE.Color('#141210')

  paint(mergedHead, (x, y, z) => {
    if (x > 0.38) return tmp.copy(beakHorn)
    if (x > 0.28 && x < 0.35 && y > 0.08 && Math.abs(z) > 0.065) return tmp.copy(eyeDark)
    const wrinkle = Math.sin(x * 42.0) * 0.5 + 0.5
    return tmp.copy(skinDark).lerp(skinLight, wrinkle * 0.35)
  })

  const headMesh = new THREE.Mesh(mergedHead, mat)
  neckPivot.add(headMesh)
  root.add(neckPivot)

  // Four columnar elephantine legs
  const buildLeg = (isFront: boolean, side: number) => {
    const pivot = new THREE.Group()
    const legGeo = stripBasic(new THREE.CylinderGeometry(0.088, 0.105, 0.28, 8))
    legGeo.translate(0, -0.14, 0)

    const footParts: THREE.BufferGeometry[] = [legGeo]
    const clawCount = isFront ? 5 : 4
    for (let c = 0; c < clawCount; c++) {
      const a = ((c - (clawCount - 1) * 0.5) / clawCount) * 1.5 + (side > 0 ? 0.3 : -0.3)
      const claw = stripBasic(new THREE.ConeGeometry(0.02, 0.065, 4))
      claw.rotateX(Math.PI / 2)
      claw.rotateY(-a)
      claw.translate(Math.cos(a) * 0.1, -0.26, Math.sin(a) * 0.1)
      footParts.push(claw)
    }
    const mergedLeg = mergeGeometries(footParts, false) as THREE.BufferGeometry
    mergedLeg.computeVertexNormals()

    paint(mergedLeg, (x, y) => {
      if (y < -0.24 && x > 0.02) return tmp.copy(beakHorn)
      return tmp.copy(skinDark).lerp(skinLight, (Math.sin(y * 36.0) * 0.5 + 0.5) * 0.3)
    })

    const m = new THREE.Mesh(mergedLeg, mat)
    pivot.add(m)
    root.add(pivot)
    return pivot
  }

  const legFL = buildLeg(true, 1)
  legFL.position.set(0.36, 0.22, 0.34)
  const legFR = buildLeg(true, -1)
  legFR.position.set(0.36, 0.22, -0.34)
  const legBL = buildLeg(false, 1)
  legBL.position.set(-0.32, 0.22, 0.35)
  const legBR = buildLeg(false, -1)
  legBR.position.set(-0.32, 0.22, -0.35)

  return { root, neckPivot, legFL, legFR, legBL, legBR }
}

// —— 4. Spiny volcanic iguana (Amblyrhynchus) —————————————————————

function buildIguana(mat: THREE.Material) {
  const root = new THREE.Group()

  // Torso (+X forward)
  const bodyGeo = stripBasic(new THREE.SphereGeometry(1, 10, 7))
  bodyGeo.scale(0.24, 0.075, 0.09)
  bodyGeo.translate(0, 0.07, 0)

  // Triangular robust iguana head
  const headGeo = stripBasic(new THREE.ConeGeometry(0.065, 0.17, 6))
  headGeo.scale(1.1, 0.85, 1.25)
  headGeo.rotateZ(-Math.PI / 2)
  headGeo.translate(0.29, 0.095, 0)

  // Serrated dorsal crest of spines from nape to mid-tail
  const spineParts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 14; i++) {
    const u = i / 13
    const sp = stripBasic(new THREE.ConeGeometry(0.012, 0.038 * (1 - u * 0.4), 3))
    sp.translate(0.22 - i * 0.042, 0.13 - i * 0.003, 0)
    spineParts.push(sp)
  }

  // Throat dewlap fan
  const dewlapGeo = stripBasic(new THREE.CylinderGeometry(0.045, 0.015, 0.012, 6))
  dewlapGeo.scale(1.3, 0.6, 1.0)
  dewlapGeo.rotateX(Math.PI / 2)
  dewlapGeo.translate(0.24, 0.045, 0)

  // Long muscular tail tapering back
  const tailGeo = stripBasic(new THREE.ConeGeometry(0.045, 0.54, 7))
  tailGeo.rotateZ(Math.PI / 2)
  tailGeo.translate(-0.46, 0.065, 0)

  // Splayed clawed limbs
  const limbParts: THREE.BufferGeometry[] = []
  for (const fwd of [0.16, -0.16]) {
    for (const side of [-1, 1]) {
      const upper = stripBasic(new THREE.CylinderGeometry(0.018, 0.016, 0.09, 5))
      upper.rotateX(side * 1.1)
      upper.translate(fwd, 0.065, side * 0.1)
      const lower = stripBasic(new THREE.CylinderGeometry(0.014, 0.011, 0.08, 4))
      lower.translate(fwd + 0.02, 0.025, side * 0.15)
      const foot = stripBasic(new THREE.BoxGeometry(0.05, 0.008, 0.045))
      foot.translate(fwd + 0.03, 0.005, side * 0.155)
      limbParts.push(upper, lower, foot)
    }
  }

  const mergedBody = mergeGeometries(
    [bodyGeo, headGeo, dewlapGeo, tailGeo, ...spineParts, ...limbParts],
    false,
  ) as THREE.BufferGeometry
  mergedBody.computeVertexNormals()

  const slate = new THREE.Color('#242b2e')
  const moss = new THREE.Color('#4d6644')
  const ochre = new THREE.Color('#b2883e')
  const eye = new THREE.Color('#121517')
  const belly = new THREE.Color('#7a8876')
  const tmp = new THREE.Color()

  paint(mergedBody, (x, y, z, ny) => {
    if (x > 0.18 && x < 0.28 && y < 0.06 && Math.abs(z) < 0.03) return tmp.copy(ochre)
    if (x > 0.24 && x < 0.31 && y > 0.09 && Math.abs(z) > 0.04) return tmp.copy(eye)
    if (ny < -0.3) return tmp.copy(belly)
    const band = Math.sin(x * 38.0 + Math.abs(z) * 12.0) * 0.5 + 0.5
    return tmp.copy(slate).lerp(moss, smooth(0.35, 0.85, band) * 0.65)
  })

  const bodyMesh = new THREE.Mesh(mergedBody, mat)
  root.add(bodyMesh)

  // Tongue for darting flick
  const tongueGeo = stripBasic(new THREE.CylinderGeometry(0.004, 0.006, 0.07, 4))
  tongueGeo.rotateZ(-Math.PI / 2)
  tongueGeo.translate(0.4, 0.08, 0)
  tongueGeo.computeVertexNormals()
  const tongueMat = new THREE.MeshBasicMaterial({ color: '#e6587a' })
  const tongue = new THREE.Mesh(tongueGeo, tongueMat)
  tongue.scale.set(0, 1, 1)
  root.add(tongue)

  return { root, bodyMesh, tongue }
}

// —— 5. Twilight flying fox (Pteropus) ————————————————————————————

function buildFlyingFox(mat: THREE.Material) {
  const root = new THREE.Group()

  // Furry spindle torso (+X forward)
  const body = stripBasic(new THREE.SphereGeometry(1, 10, 7))
  body.scale(0.22, 0.075, 0.07)
  body.translate(0, 0, 0)

  // Head with fox-like snout and upright ears
  const head = stripBasic(new THREE.ConeGeometry(0.05, 0.14, 6))
  head.rotateZ(-Math.PI / 2)
  head.translate(0.24, 0.02, 0)

  const earL = stripBasic(new THREE.ConeGeometry(0.02, 0.06, 4))
  earL.rotateZ(-0.4)
  earL.rotateX(0.3)
  earL.translate(0.21, 0.065, 0.035)

  const earR = stripBasic(new THREE.ConeGeometry(0.02, 0.06, 4))
  earR.rotateZ(-0.4)
  earR.rotateX(-0.3)
  earR.translate(0.21, 0.065, -0.035)

  const bodyParts = [body, head, earL, earR]
  const mergedBody = mergeGeometries(bodyParts, false) as THREE.BufferGeometry
  mergedBody.computeVertexNormals()

  const furDark = new THREE.Color('#382016')
  const mantleOchre = new THREE.Color('#825624')
  const earDark = new THREE.Color('#22140d')
  const tmp = new THREE.Color()

  paint(mergedBody, (x, y) => {
    if (y > 0.05) return tmp.copy(earDark)
    if (x > 0.08 && x < 0.22) return tmp.copy(mantleOchre)
    return tmp.copy(furDark)
  })

  const bodyMesh = new THREE.Mesh(mergedBody, mat)
  root.add(bodyMesh)

  // Pair of broad scalloped leathery wings (~1.45 m wingspan)
  const makeWing = (side: number) => {
    const pivot = new THREE.Group()
    pivot.position.set(0.04, 0.015, side * 0.05)

    const s = new THREE.Shape()
    s.moveTo(0.06, 0)
    s.quadraticCurveTo(0.08, side * 0.22, 0.03, side * 0.45)
    s.quadraticCurveTo(0.02, side * 0.62, -0.12, side * 0.72)
    s.quadraticCurveTo(-0.16, side * 0.54, -0.12, side * 0.44)
    s.quadraticCurveTo(-0.18, side * 0.32, -0.11, side * 0.22)
    s.quadraticCurveTo(-0.16, side * 0.11, -0.08, 0)
    s.closePath()

    const g = stripBasic(
      new THREE.ExtrudeGeometry(s, { depth: 0.008, bevelEnabled: false, curveSegments: 5 }),
    )
    g.translate(0, 0, -0.004)
    g.rotateX(-Math.PI / 2)
    g.computeVertexNormals()

    const wingLeather = new THREE.Color('#1d1816')
    const wingRim = new THREE.Color('#4a3828')
    paint(g, (x, _y, z) => {
      const span = Math.abs(z) / 0.72
      if (span > 0.85 || x > 0.03) return tmp.copy(wingRim)
      return tmp.copy(wingLeather).lerp(wingRim, smooth(0.5, 0.9, span) * 0.4)
    })

    const m = new THREE.Mesh(g, mat)
    pivot.add(m)
    root.add(pivot)
    return pivot
  }

  const wingL = makeWing(1)
  const wingR = makeWing(-1)

  return { root, wingL, wingR }
}

// —— 3 & 4. Glow shaders (Fireflies & Noctiluca sea-sparkle) —————————

const glowVertex = /* glsl */ `
attribute float aAlpha;
attribute float aSize;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
uniform float uPixelRatio;
uniform float uMaxSize;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // ~world-scaled: aSize is roughly the glow diameter in metres
  gl_PointSize = clamp(aSize * uPixelRatio * (520.0 / max(-mv.z, 0.6)), 1.8, uMaxSize);
}
`

const glowFragment = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  if (vAlpha <= 0.002) discard;
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;
  float core = exp(-r2 * 22.0);
  float halo = pow(1.0 - r2 * 4.0, 2.0) * 0.45;
  gl_FragColor = vec4(vColor * (core + halo), (core + halo) * vAlpha);
}
`

// —— Assembly ———————————————————————————————————————————————————————

export type IslandLifeDeps = {
  hud: Hud
  island: {
    centre: THREE.Vector3
    heightAt: (x: number, z: number) => number
    pools: THREE.Vector3[]
  }
  cove: THREE.Vector3
  lowPower: boolean
  pixelRatio: number
  onSeabirdCry?: (distance: number) => void
}

export function createIslandLife(scene: THREE.Scene, deps: IslandLifeDeps) {
  const group = new THREE.Group()
  group.name = 'IslandLife'
  scene.add(group)

  const dummy = new THREE.Object3D()

  // —— A. White-tailed tropicbirds soaring the cove cliffs & palms ——
  const birdMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.48,
    metalness: 0.0,
    side: THREE.DoubleSide,
  })

  // Cove-to-interior axis so birds wheel naturally across the cove valley, cliffs, and lagoon edge
  const inDir = new THREE.Vector2(
    deps.island.centre.x - deps.cove.x,
    deps.island.centre.z - deps.cove.z,
  ).normalize()
  const sideDir = new THREE.Vector2(-inDir.y, inDir.x)

  const birdCount = deps.lowPower ? 3 : 5
  const tropicbirds = Array.from({ length: birdCount }, (_, i) => {
    const built = buildTropicbird(birdMat)
    built.root.scale.setScalar(1.18 + (i % 3) * 0.1)
    group.add(built.root)
    // First pair wheels out over the open cove bay/lagoon; others soar high above the cliffs & canopy roof
    const overBay = i < 2
    const along = overBay ? -26 + i * 18 : 36 + (i - 2) * 28
    const across = overBay
      ? (i === 0 ? -1 : 1) * 24
      : (i % 2 === 0 ? 1 : -1) * (38 + (i % 3) * 20)
    const altAbove = overBay ? 18 + i * 5 : 30 + (i % 3) * 6
    return {
      ...built,
      cx: deps.cove.x + inDir.x * along + sideDir.x * across,
      cz: deps.cove.z + inDir.y * along + sideDir.y * across,
      rx: overBay ? 32 : 40 + (i % 3) * 14,
      rz: overBay ? 22 : 28 + ((i + 1) % 3) * 12,
      speed: (0.19 + (i % 3) * 0.035) * (i % 2 === 0 ? 1 : -1),
      phase: (i / birdCount) * TAU,
      altAbove,
      yaw: 0,
      roll: 0,
      pitch: 0,
      y: altAbove + 4,
    }
  })

  let cryTimer = rand(14, 28)

  function updateTropicbirds(dt: number, t: number, cam: THREE.Camera, daylight: number, storm: number) {
    const islandDist = Math.hypot(cam.position.x - deps.cove.x, cam.position.z - deps.cove.z)
    const active = islandDist < 620 && daylight > 0.08
    for (const b of tropicbirds) b.root.visible = active
    if (!active) return

    let nearestDist = Infinity
    for (let idx = 0; idx < tropicbirds.length; idx++) {
      const b = tropicbirds[idx]
      const a = t * b.speed + b.phase
      // Sweeping figure-eight / thermal arc
      const x = b.cx + Math.cos(a) * b.rx
      const z = b.cz + Math.sin(a) * b.rz + Math.sin(a * 2) * 8
      const vx = -Math.sin(a) * b.rx * b.speed
      const vz = (Math.cos(a) * b.rz + Math.cos(a * 2) * 16) * b.speed

      const ground = Math.max(0, deps.island.heightAt(x, z))
      const wantY = ground + b.altAbove + Math.sin(a * 2 + b.phase) * 3.8
      const prevY = b.y
      b.y = damp(b.y, wantY, 1.8, dt)

      const heading = Math.atan2(-vx, -vz)
      const dYaw = angleDelta(b.yaw, heading)
      b.yaw += dYaw
      const bankTarget = clamp((-dYaw / Math.max(dt, 1e-3)) * 0.42, -0.78, 0.78)
      b.roll = damp(b.roll, bankTarget, 3.2, dt)
      b.pitch = damp(b.pitch, clamp((b.y - prevY) / Math.max(dt * 8, 1e-3), -0.3, 0.3), 3, dt)

      // Alternate between crisp climbing wingbeats and long motionless banked glides
      const cycle = (t * 0.16 + b.phase) % 1
      const flapping = smooth(0.0, 0.08, cycle) * (1 - smooth(0.32, 0.42, cycle))
      const beat = Math.sin(t * 14.5 + b.phase * 5) * 0.58 * flapping
      const glideDihedral = 0.08 + Math.abs(b.roll) * 0.08
      b.wingL.rotation.x = glideDihedral + beat
      b.wingR.rotation.x = -(glideDihedral + beat)

      // Trailing tail streamers ripple with airspeed and bank
      const dBird = Math.hypot(x - cam.position.x, z - cam.position.z)
      if (dBird < nearestDist) nearestDist = dBird
      if (dBird < 220) {
        const pos = b.streamers.geometry.attributes.position as THREE.BufferAttribute
        const arr = pos.array as Float32Array
        for (let i = 0; i < pos.count; i++) {
          const rx = b.streamRest[i * 3]
          const u = clamp((-0.28 - rx) / b.streamLen, 0, 1)
          const wave = Math.sin(t * 8.5 - u * 5.2 + b.phase) * 0.052 * u * u
          const turnTrail = clamp(dYaw * 18, -0.25, 0.25) * u * u
          arr[i * 3] = rx
          arr[i * 3 + 1] = b.streamRest[i * 3 + 1] + wave
          arr[i * 3 + 2] = b.streamRest[i * 3 + 2] + turnTrail
        }
        pos.needsUpdate = true
      }

      b.root.position.set(x, b.y, z)
      dummy.rotation.set(0, 0, 0)
      dummy.rotateY(b.yaw + Math.PI / 2)
      dummy.rotateZ(b.pitch)
      dummy.rotateX(b.roll)
      b.root.quaternion.copy(dummy.quaternion)
    }

    cryTimer -= dt
    if (cryTimer <= 0) {
      if (nearestDist < 135 && storm < 0.45 && daylight > 0.22) {
        deps.onSeabirdCry?.(nearestDist)
        cryTimer = rand(18, 36)
      } else {
        cryTimer = 8
      }
    }
  }

  // —— B. Jewel dragonflies & water rings over inland rain pools ——
  const dfBodyMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.22,
    metalness: 0.65,
  })
  const dfWingMat = new THREE.MeshBasicMaterial({
    color: '#dff6ff',
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
    depthWrite: false,
  })

  type Dragonfly = {
    poolIdx: number
    built: ReturnType<typeof buildDragonfly>
    x: number
    y: number
    z: number
    tx: number
    ty: number
    tz: number
    yaw: number
    wait: number
    dipNext: boolean
    dipped: boolean
    phase: number
  }

  const dragonflies: Dragonfly[] = []
  const perPool = deps.lowPower ? 3 : 5
  deps.island.pools.forEach((pool, pIdx) => {
    for (let k = 0; k < perPool; k++) {
      const built = buildDragonfly(k % 2 === 0 ? 'emerald' : 'sapphire', dfBodyMat, dfWingMat)
      built.root.scale.setScalar(1.35)
      built.root.visible = false
      group.add(built.root)
      const a = (k / perPool) * TAU
      const r = 0.4 + (k % 3) * 0.35
      const sx = pool.x + Math.cos(a) * r
      const sz = pool.z + Math.sin(a) * r
      const sy = pool.y + 0.18 + (k % 3) * 0.12
      dragonflies.push({
        poolIdx: pIdx,
        built,
        x: sx,
        y: sy,
        z: sz,
        tx: sx,
        ty: sy,
        tz: sz,
        yaw: a,
        wait: rand(0.4, 1.8),
        dipNext: k === 0,
        dipped: false,
        phase: rand(0, TAU),
      })
    }
  })

  const POOL_RINGS = 8
  const poolRings = Array.from({ length: POOL_RINGS }, () => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.06, 0.085, 22),
      new THREE.MeshBasicMaterial({
        color: '#b8f0f5',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    m.rotation.x = -Math.PI / 2
    m.visible = false
    m.userData.noShadow = true
    group.add(m)
    return { mesh: m, age: 99, life: 1.5 }
  })
  let poolRingCursor = 0

  function spawnPoolRipple(x: number, y: number, z: number) {
    const r = poolRings[poolRingCursor]
    poolRingCursor = (poolRingCursor + 1) % POOL_RINGS
    r.age = 0
    r.mesh.position.set(x, y + 0.026, z)
    r.mesh.scale.setScalar(1)
    r.mesh.visible = true
  }

  function updateDragonflies(dt: number, t: number, cam: THREE.Camera, daylight: number, storm: number) {
    const pools = deps.island.pools
    if (pools.length === 0) return
    const activeWeather = daylight > 0.2 && storm < 0.45

    for (const d of dragonflies) {
      const pool = pools[d.poolIdx]
      const distSq = (cam.position.x - pool.x) ** 2 + (cam.position.z - pool.z) ** 2
      const show = activeWeather && distSq < 56 * 56
      d.built.root.visible = show
      if (!show) continue

      d.wait -= dt
      if (d.wait <= 0) {
        const a = Math.random() * TAU
        const rad = rand(0.15, 1.15)
        d.tx = pool.x + Math.cos(a) * rad
        d.tz = pool.z + Math.sin(a) * rad
        if (d.dipNext) {
          d.ty = pool.y + 0.045
          d.dipped = false
          d.dipNext = false
          d.wait = rand(0.45, 0.75)
        } else {
          d.ty = pool.y + rand(0.16, 0.52)
          d.dipNext = Math.random() < 0.3
          d.wait = rand(0.9, 2.2)
        }
        const dx = d.tx - d.x
        const dz = d.tz - d.z
        if (dx * dx + dz * dz > 1e-4) d.yaw = Math.atan2(-dx, -dz)
      }

      // Snap-dart between hover stations
      d.x = damp(d.x, d.tx, 9.5, dt)
      d.y = damp(d.y, d.ty, 9.5, dt)
      d.z = damp(d.z, d.tz, 9.5, dt)

      if (!d.dipped && d.ty < pool.y + 0.06 && Math.abs(d.y - d.ty) < 0.025) {
        d.dipped = true
        spawnPoolRipple(d.x, pool.y, d.z)
        d.ty = pool.y + rand(0.22, 0.45)
      }

      const hoverBob = Math.sin(t * 7.5 + d.phase) * 0.008
      const blur = Math.sin(t * 58 + d.phase) * 0.38
      d.built.fore.pivotL.rotation.x = blur
      d.built.fore.pivotR.rotation.x = -blur
      d.built.hind.pivotL.rotation.x = -blur * 0.9
      d.built.hind.pivotR.rotation.x = blur * 0.9

      d.built.root.position.set(d.x, d.y + hoverBob, d.z)
      d.built.root.rotation.set(0, d.yaw + Math.PI / 2, 0)
    }

    for (const r of poolRings) {
      if (!r.mesh.visible) continue
      r.age += dt
      const u = r.age / r.life
      if (u >= 1) {
        r.mesh.visible = false
        continue
      }
      r.mesh.scale.setScalar(1 + u * 6.5)
      ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - u) * (1 - u) * 0.65
    }
  }

  // —— C. Canopy & rain-pool fireflies (twilight & night) ——
  const ffCount = deps.lowPower ? 70 : 160
  const ffPos = new Float32Array(ffCount * 3)
  const ffAlpha = new Float32Array(ffCount)
  const ffSize = new Float32Array(ffCount)
  const ffCol = new Float32Array(ffCount * 3)

  type FireflySeed = { hx: number; hy: number; hz: number; phase: number; rate: number; wander: number }
  const ffSeeds: FireflySeed[] = []

  for (let i = 0; i < ffCount; i++) {
    let hx: number
    let hz: number
    // Anchor ~30% around the freshwater rain pools, ~70% through the cove palm grove & inland path
    if (deps.island.pools.length > 0 && i % 3 === 0) {
      const p = deps.island.pools[i % deps.island.pools.length]
      const a = (i * 2.399) % TAU
      const r = 1.5 + (i % 7) * 2.2
      hx = p.x + Math.cos(a) * r
      hz = p.z + Math.sin(a) * r
    } else {
      const along = 4 + ((i * 17) % 80)
      const across = (((i * 37) % 100) / 100 - 0.5) * 80
      hx = deps.cove.x + inDir.x * along + sideDir.x * across
      hz = deps.cove.z + inDir.y * along + sideDir.y * across
    }
    const g = Math.max(1.8, deps.island.heightAt(hx, hz))
    // Drift at head height and above, clear of the grass and shrub layer
    const hy = g + 1.4 + ((i * 13) % 10) * 0.26
    ffSeeds.push({
      hx,
      hy,
      hz,
      phase: (i * 1.618) % TAU,
      rate: 0.55 + ((i * 7) % 10) * 0.06,
      wander: 0.75 + (i % 5) * 0.25,
    })
    // Warm HDR amber-chartreuse glow so the post-process bloom gives a soft lantern halo
    const warmMix = (i % 4) * 0.08
    ffCol[i * 3] = 1.55 + warmMix * 0.75
    ffCol[i * 3 + 1] = 2.35 - warmMix * 0.35
    ffCol[i * 3 + 2] = 0.38
    ffSize[i] = 0.2 + (i % 3) * 0.05
  }

  const ffGeo = new THREE.BufferGeometry()
  ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPos, 3))
  ffGeo.setAttribute('aAlpha', new THREE.BufferAttribute(ffAlpha, 1))
  ffGeo.setAttribute('aSize', new THREE.BufferAttribute(ffSize, 1))
  ffGeo.setAttribute('aColor', new THREE.BufferAttribute(ffCol, 3))

  const glowMat = (maxSize: number) =>
    new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: deps.pixelRatio },
        uMaxSize: { value: maxSize },
      },
      vertexShader: glowVertex,
      fragmentShader: glowFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

  const glowGroup = new THREE.Group()
  glowGroup.name = 'IslandGlow'
  scene.add(glowGroup)

  const ffPoints = new THREE.Points(ffGeo, glowMat(42.0))
  ffPoints.frustumCulled = false
  ffPoints.renderOrder = 6
  ffPoints.visible = false
  glowGroup.add(ffPoints)

  let whisperedFireflies = false

  function updateFireflies(
    t: number,
    cam: THREE.Camera,
    daylight: number,
    storm: number,
    underwater: boolean,
    walking: boolean,
  ) {
    const duskGlow = (1 - smooth(0.12, 0.44, daylight)) * (1 - storm * 0.85)
    const nearIsland = Math.hypot(cam.position.x - deps.cove.x, cam.position.z - deps.cove.z) < 260
    ffPoints.visible = !underwater && duskGlow > 0.02 && nearIsland
    if (!ffPoints.visible) return

    let closeLit = 0
    for (let i = 0; i < ffCount; i++) {
      const s = ffSeeds[i]
      const x = s.hx + Math.sin(t * 0.42 + s.phase) * s.wander
      const y = s.hy + Math.sin(t * 0.68 + s.phase * 1.7) * 0.32
      const z = s.hz + Math.cos(t * 0.37 + s.phase * 1.3) * s.wander
      ffPos[i * 3] = x
      ffPos[i * 3 + 1] = y
      ffPos[i * 3 + 2] = z

      // Organic firefly lantern pulse: warm swell with a soft lingering ember glow
      const wave = Math.sin(t * s.rate * 2.2 + s.phase) * 0.5 + 0.5
      const flash = 0.16 + 0.84 * Math.pow(wave, 2.2)
      const dSq = (x - cam.position.x) ** 2 + (z - cam.position.z) ** 2
      const rangeFade = 1 - smooth(85 * 85, 165 * 165, dSq)
      ffAlpha[i] = flash * duskGlow * rangeFade
      if (dSq < 18 * 18 && ffAlpha[i] > 0.35) closeLit++
    }
    ffGeo.attributes.position.needsUpdate = true
    ffGeo.attributes.aAlpha.needsUpdate = true

    if (!whisperedFireflies && walking && duskGlow > 0.6 && closeLit >= 2) {
      whisperedFireflies = true
      deps.hud.whisper('Small lights drift under the trees.')
    }
  }

  // —— D. Noctiluca sea-sparkle (bioluminescent plankton wake at night) ——
  const bioMax = deps.lowPower ? 260 : 560
  const bioPos = new Float32Array(bioMax * 3)
  const bioVel = new Float32Array(bioMax * 3)
  const bioAlpha = new Float32Array(bioMax)
  const bioSize = new Float32Array(bioMax)
  const bioCol = new Float32Array(bioMax * 3)
  const bioAge = new Float32Array(bioMax).fill(99)
  const bioLife = new Float32Array(bioMax).fill(1)

  const bioGeo = new THREE.BufferGeometry()
  bioGeo.setAttribute('position', new THREE.BufferAttribute(bioPos, 3))
  bioGeo.setAttribute('aAlpha', new THREE.BufferAttribute(bioAlpha, 1))
  bioGeo.setAttribute('aSize', new THREE.BufferAttribute(bioSize, 1))
  bioGeo.setAttribute('aColor', new THREE.BufferAttribute(bioCol, 3))

  const bioPoints = new THREE.Points(bioGeo, glowMat(7.5))
  bioPoints.frustumCulled = false
  bioPoints.renderOrder = 6
  bioPoints.visible = false
  glowGroup.add(bioPoints)

  let bioCursor = 0
  let currentBiolum = 0
  let currentTime = 0
  let strokeSpawnAcc = 0
  let whisperedBio = false
  // Sparks ride a film just above the surface when seen from the air (the water
  // surface is opaque to depth), and just beneath it when seen from below
  let bioLift = 0.06

  function disturbWater(x: number, z: number, power = 1) {
    if (currentBiolum < 0.04) return
    const n = Math.min(48, Math.max(4, Math.round(power * (deps.lowPower ? 14 : 26))))
    for (let k = 0; k < n; k++) {
      const i = bioCursor
      bioCursor = (bioCursor + 1) % bioMax
      const a = Math.random() * TAU
      const r = rand(0.06, 1.35 * Math.sqrt(power))
      bioPos[i * 3] = x + Math.cos(a) * r
      bioPos[i * 3 + 2] = z + Math.sin(a) * r
      bioPos[i * 3 + 1] = sampleOcean(bioPos[i * 3], bioPos[i * 3 + 2], currentTime).y + bioLift
      const spd = rand(0.22, 0.95) * Math.sqrt(power)
      bioVel[i * 3] = Math.cos(a) * spd
      bioVel[i * 3 + 1] = 0
      bioVel[i * 3 + 2] = Math.sin(a) * spd
      bioAge[i] = 0
      bioLife[i] = rand(1.2, 2.5)
      bioSize[i] = rand(0.038, 0.088)
      // Saturated electric turquoise-sapphire sparks (low R prevents additive white blowout)
      const cyanShift = Math.random()
      bioCol[i * 3] = 0.02 + cyanShift * 0.06
      bioCol[i * 3 + 1] = 0.58 + cyanShift * 0.36
      bioCol[i * 3 + 2] = 1.22 + cyanShift * 0.28
    }
  }

  function updateBiolum(
    dt: number,
    t: number,
    cam: THREE.Camera,
    biolum: number,
    underwater: boolean,
    playerActivity: { x: number; y: number; z: number; moving: number; inSea: boolean },
  ) {
    currentBiolum = biolum
    currentTime = t
    bioLift = underwater ? -0.08 : 0.06
    if (biolum < 0.03) {
      bioPoints.visible = false
      return
    }

    // Swimmer's own strokes / wading stir glowing plankton trails around them
    if (playerActivity.inSea && playerActivity.moving > 0.12) {
      strokeSpawnAcc += dt * playerActivity.moving * (deps.lowPower ? 16 : 30)
      while (strokeSpawnAcc >= 1) {
        strokeSpawnAcc -= 1
        const a = Math.random() * TAU
        const rad = rand(0.28, 1.35)
        disturbWater(
          playerActivity.x + Math.cos(a) * rad,
          playerActivity.z + Math.sin(a) * rad,
          0.22,
        )
      }
      if (!whisperedBio && biolum > 0.45 && playerActivity.moving > 0.45) {
        whisperedBio = true
        deps.hud.whisper('Every stroke wakes pale fire in the dark water.')
      }
    }

    let anyLive = false
    for (let i = 0; i < bioMax; i++) {
      if (bioAge[i] >= bioLife[i]) {
        bioAlpha[i] = 0
        continue
      }
      anyLive = true
      bioAge[i] += dt
      const u = bioAge[i] / bioLife[i]
      const drag = Math.exp(-1.9 * dt)
      bioVel[i * 3] *= drag
      bioVel[i * 3 + 2] *= drag
      bioPos[i * 3] += bioVel[i * 3] * dt
      bioPos[i * 3 + 2] += bioVel[i * 3 + 2] * dt
      // Ride the live swell surface
      const surf = sampleOcean(bioPos[i * 3], bioPos[i * 3 + 2], t).y
      bioPos[i * 3 + 1] = surf + bioLift
      const dSq = (bioPos[i * 3] - cam.position.x) ** 2 + (bioPos[i * 3 + 2] - cam.position.z) ** 2
      const rangeFade = 1 - smooth(65 * 65, 130 * 130, dSq)
      bioAlpha[i] = smooth(0, 0.1, u) * Math.pow(1 - u, 1.6) * biolum * rangeFade
    }

    bioPoints.visible = anyLive
    if (anyLive) {
      bioGeo.attributes.position.needsUpdate = true
      bioGeo.attributes.aAlpha.needsUpdate = true
      bioGeo.attributes.aSize.needsUpdate = true
      bioGeo.attributes.aColor.needsUpdate = true
    }
  }

  // —— E. Ancient giant tortoises (Aldabrachelys / Chelonoidis) ——————
  const tortoiseMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.64,
    metalness: 0.04,
  })

  type Tortoise = {
    built: ReturnType<typeof buildTortoise>
    x: number
    y: number
    z: number
    yaw: number
    pitch: number
    roll: number
    baseX: number
    baseZ: number
    targetX: number
    targetZ: number
    wanderRadius: number
    speed: number
    state: 'graze' | 'walk'
    timer: number
    gaitPhase: number
    retract: number
    scale: number
  }

  const tortoiseCount = deps.lowPower ? 2 : 3
  const tortoises: Tortoise[] = []
  let whisperedTortoise = false

  for (let i = 0; i < tortoiseCount; i++) {
    const built = buildTortoise(tortoiseMat)
    const scale = 1.18 + (i % 2) * 0.16
    built.root.scale.setScalar(scale)
    group.add(built.root)

    let bx: number
    let bz: number
    if (i === 0 && deps.island.pools.length > 0) {
      // By the first inland freshwater pool, browsing lush ferns
      const p = deps.island.pools[0]
      bx = p.x + 3.8
      bz = p.z + 2.2
    } else if (i === 1 && deps.island.pools.length > 1) {
      // By the second inland rain pool
      const p = deps.island.pools[1]
      bx = p.x - 3.4
      bz = p.z + 2.6
    } else {
      // Shady inland fern glade along the rising valley
      bx = deps.cove.x + inDir.x * 24 + sideDir.x * 12
      bz = deps.cove.z + inDir.y * 24 + sideDir.y * 12
    }

    const by = deps.island.heightAt(bx, bz)
    const startYaw = rand(0, TAU)
    built.root.position.set(bx, by, bz)
    dummy.rotation.set(0, startYaw + Math.PI / 2, 0)
    built.root.quaternion.copy(dummy.quaternion)

    tortoises.push({
      built,
      x: bx,
      y: by,
      z: bz,
      yaw: startYaw,
      pitch: 0,
      roll: 0,
      baseX: bx,
      baseZ: bz,
      targetX: bx + Math.cos(startYaw) * 1.5,
      targetZ: bz + Math.sin(startYaw) * 1.5,
      wanderRadius: 4.8,
      speed: 0.12 + (i % 2) * 0.04,
      state: i === 0 ? 'graze' : 'walk',
      timer: rand(4, 10),
      gaitPhase: rand(0, TAU),
      retract: 0,
      scale,
    })
  }

  function updateTortoises(
    dt: number,
    t: number,
    cam: THREE.Camera,
    playerX: number,
    playerZ: number,
    moving: number,
    walking: boolean,
  ) {
    for (const tort of tortoises) {
      const dCamSq = (tort.x - cam.position.x) ** 2 + (tort.z - cam.position.z) ** 2
      const visible = dCamSq < 130 * 130
      tort.built.root.visible = visible
      if (!visible) continue

      const dPlayer = Math.hypot(tort.x - playerX, tort.z - playerZ)
      const alarmed = dPlayer < (moving > 0.4 ? 4.8 : 3.6)
      const targetRetract = alarmed ? 1.0 : 0.0
      tort.retract = damp(tort.retract, targetRetract, alarmed ? 4.5 : 1.6, dt)

      if (!whisperedTortoise && walking && dPlayer < 4.8) {
        whisperedTortoise = true
        deps.hud.whisper('An ancient tortoise grazes quietly in the shade.')
      }

      // Smooth shell retraction: neck pulls in, scale shrinks, legs tuck against shell
      tort.built.neckPivot.position.x = 0.52 - tort.retract * 0.34
      const neckS = 1.0 - tort.retract * 0.45
      tort.built.neckPivot.scale.set(neckS, neckS, neckS)
      const tuck = tort.retract * 0.07
      tort.built.legFL.position.x = 0.36 - tuck
      tort.built.legFR.position.x = 0.36 - tuck
      tort.built.legBL.position.x = -0.32 + tuck
      tort.built.legBR.position.x = -0.32 + tuck

      if (tort.retract <= 0.4) {
        tort.timer -= dt
        if (tort.state === 'graze') {
          // Subtle grazing bobbing
          const chew = Math.sin(t * 1.5 + tort.gaitPhase)
          tort.built.neckPivot.rotation.z = -0.06 + chew * 0.08
          tort.built.neckPivot.rotation.y = Math.sin(t * 0.7 + tort.gaitPhase) * 0.12
          if (tort.timer <= 0) {
            const a = Math.random() * TAU
            const r = rand(1.2, tort.wanderRadius)
            tort.targetX = tort.baseX + Math.cos(a) * r
            tort.targetZ = tort.baseZ + Math.sin(a) * r
            tort.state = 'walk'
            tort.timer = rand(8, 18)
          }
        } else {
          // Ambling
          const dx = tort.targetX - tort.x
          const dz = tort.targetZ - tort.z
          const distTarget = Math.hypot(dx, dz)
          if (distTarget < 0.4 || tort.timer <= 0) {
            tort.state = 'graze'
            tort.timer = rand(6, 15)
          } else {
            const wantYaw = Math.atan2(-dx, -dz)
            tort.yaw += angleDelta(tort.yaw, wantYaw) * Math.min(1, dt * 1.1)
            const fwd = tort.speed * dt * (1 - tort.retract)
            tort.x += -Math.sin(tort.yaw) * fwd
            tort.z += -Math.cos(tort.yaw) * fwd
            tort.gaitPhase += dt * (tort.speed * 8.5)

            const s1 = Math.sin(tort.gaitPhase)
            tort.built.legFL.rotation.z = s1 * 0.26
            tort.built.legBR.rotation.z = s1 * 0.24
            tort.built.legFR.rotation.z = -s1 * 0.26
            tort.built.legBL.rotation.z = -s1 * 0.24
            tort.built.neckPivot.rotation.z = -0.05 + Math.sin(tort.gaitPhase * 2) * 0.04
            tort.built.neckPivot.rotation.y = Math.sin(tort.gaitPhase) * 0.06
          }
        }
      }

      // Terrain slope matching
      const hC = deps.island.heightAt(tort.x, tort.z)
      const fX = -Math.sin(tort.yaw) * 0.45
      const fZ = -Math.cos(tort.yaw) * 0.45
      const rX = Math.cos(tort.yaw) * 0.4
      const rZ = -Math.sin(tort.yaw) * 0.4
      const hF = deps.island.heightAt(tort.x + fX, tort.z + fZ)
      const hB = deps.island.heightAt(tort.x - fX, tort.z - fZ)
      const hR = deps.island.heightAt(tort.x + rX, tort.z + rZ)
      const hL = deps.island.heightAt(tort.x - rX, tort.z - rZ)
      const wantPitch = Math.atan2(hF - hB, 0.9)
      const wantRoll = Math.atan2(hR - hL, 0.8)
      tort.pitch = damp(tort.pitch, wantPitch, 4.0, dt)
      tort.roll = damp(tort.roll, wantRoll, 4.0, dt)
      tort.y = damp(tort.y, hC, 8.0, dt)

      tort.built.root.position.set(tort.x, tort.y, tort.z)
      dummy.rotation.set(0, 0, 0)
      dummy.rotateY(tort.yaw + Math.PI / 2)
      dummy.rotateZ(tort.pitch)
      dummy.rotateX(tort.roll)
      tort.built.root.quaternion.copy(dummy.quaternion)
    }
  }

  // —— F. Spiny volcanic iguanas (Amblyrhynchus) —————————————————————
  const iguanaMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.68,
    metalness: 0.08,
  })

  type Iguana = {
    built: ReturnType<typeof buildIguana>
    x: number
    y: number
    z: number
    baseX: number
    baseZ: number
    yaw: number
    pitch: number
    roll: number
    bobTimer: number
    bobPhase: number
    flickTimer: number
    flicking: boolean
    scurryTimer: number
    scale: number
  }

  const iguanaCount = deps.lowPower ? 2 : 4
  const iguanas: Iguana[] = []
  let whisperedIguana = false

  // Warm sunny basalt perches around the cove and volcanic ridges
  const iguanaOffsets = [
    { along: 6, across: 22 },   // North cliff ledge over the bay
    { along: 12, across: -26 }, // South headland rocks
    { along: 38, across: 10 },  // Lower basalt trail
    { along: -8, across: -16 }, // Rocks by the sand edge
  ]

  for (let i = 0; i < iguanaCount; i++) {
    const built = buildIguana(iguanaMat)
    const scale = 1.05 + (i % 2) * 0.15
    built.root.scale.setScalar(scale)
    group.add(built.root)

    const off = iguanaOffsets[i % iguanaOffsets.length]
    const bx = deps.cove.x + inDir.x * off.along + sideDir.x * off.across
    const bz = deps.cove.z + inDir.y * off.along + sideDir.y * off.across
    const by = deps.island.heightAt(bx, bz)
    const yaw = rand(0, TAU)
    built.root.position.set(bx, by, bz)
    dummy.rotation.set(0, yaw + Math.PI / 2, 0)
    built.root.quaternion.copy(dummy.quaternion)

    iguanas.push({
      built,
      x: bx,
      y: by,
      z: bz,
      baseX: bx,
      baseZ: bz,
      yaw,
      pitch: 0,
      roll: 0,
      bobTimer: rand(2, 6),
      bobPhase: rand(0, TAU),
      flickTimer: rand(3, 8),
      flicking: false,
      scurryTimer: 0,
      scale,
    })
  }

  function updateIguanas(
    dt: number,
    t: number,
    cam: THREE.Camera,
    playerX: number,
    playerZ: number,
    moving: number,
    walking: boolean,
  ) {
    for (const ig of iguanas) {
      const dCamSq = (ig.x - cam.position.x) ** 2 + (ig.z - cam.position.z) ** 2
      const visible = dCamSq < 95 * 95
      ig.built.root.visible = visible
      if (!visible) continue

      const dPlayer = Math.hypot(ig.x - playerX, ig.z - playerZ)

      if (!whisperedIguana && walking && dPlayer < 4.2) {
        whisperedIguana = true
        deps.hud.whisper('A spiny iguana watches motionless from the basalt.')
      }

      // If player rushes in too close, scurry a few feet away
      if (dPlayer < (moving > 0.4 ? 2.8 : 1.8) && ig.scurryTimer <= 0) {
        ig.scurryTimer = rand(1.2, 2.0)
        // Run away from player
        const fleeAngle = Math.atan2(ig.x - playerX, ig.z - playerZ) + rand(-0.4, 0.4)
        ig.yaw = fleeAngle
      }

      let bobY = 0
      if (ig.scurryTimer > 0) {
        ig.scurryTimer -= dt
        const spd = 2.4 * dt
        const nx = ig.x - Math.sin(ig.yaw) * spd
        const nz = ig.z - Math.cos(ig.yaw) * spd
        // Stay near its perch and out of the sea, however often it is chased
        if (Math.hypot(nx - ig.baseX, nz - ig.baseZ) < 7 && deps.island.heightAt(nx, nz) > 0.5) {
          ig.x = nx
          ig.z = nz
        } else {
          ig.scurryTimer = 0
        }
        // Fast scurrying wiggle
        const scurryWiggle = Math.sin(t * 26) * 0.12
        ig.built.bodyMesh.rotation.y = scurryWiggle
      } else {
        ig.built.bodyMesh.rotation.y = 0
        // Periodic head bobs
        ig.bobTimer -= dt
        if (ig.bobTimer <= 0) {
          const u = -ig.bobTimer // 0 to 1.2
          if (u < 1.1) {
            bobY = Math.max(0, Math.sin(u * 16.0)) * 0.035
          } else {
            ig.bobTimer = rand(4, 9)
          }
        }

        // Periodic tongue flick
        ig.flickTimer -= dt
        if (ig.flickTimer <= 0) {
          const fu = -ig.flickTimer
          if (fu < 0.26) {
            ig.flicking = true
          } else {
            ig.flicking = false
            ig.flickTimer = rand(3.8, 8.0)
          }
        }
      }

      ig.built.tongue.scale.x = damp(ig.built.tongue.scale.x, ig.flicking ? 1.0 : 0.0, 24.0, dt)

      // Rock terrain alignment
      const hC = deps.island.heightAt(ig.x, ig.z)
      const fX = -Math.sin(ig.yaw) * 0.25
      const fZ = -Math.cos(ig.yaw) * 0.25
      const rX = Math.cos(ig.yaw) * 0.2
      const rZ = -Math.sin(ig.yaw) * 0.2
      const hF = deps.island.heightAt(ig.x + fX, ig.z + fZ)
      const hB = deps.island.heightAt(ig.x - fX, ig.z - fZ)
      const hR = deps.island.heightAt(ig.x + rX, ig.z + rZ)
      const hL = deps.island.heightAt(ig.x - rX, ig.z - rZ)
      const wantPitch = Math.atan2(hF - hB, 0.5)
      const wantRoll = Math.atan2(hR - hL, 0.4)
      ig.pitch = damp(ig.pitch, wantPitch, 6.0, dt)
      ig.roll = damp(ig.roll, wantRoll, 6.0, dt)
      ig.y = damp(ig.y, hC, 10.0, dt)

      ig.built.root.position.set(ig.x, ig.y + bobY, ig.z)
      dummy.rotation.set(0, 0, 0)
      dummy.rotateY(ig.yaw + Math.PI / 2)
      dummy.rotateZ(ig.pitch)
      dummy.rotateX(ig.roll)
      ig.built.root.quaternion.copy(dummy.quaternion)
    }
  }

  // —— G. Twilight flying foxes (Pteropus) ————————————————————————
  const foxMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.58,
    metalness: 0.02,
    side: THREE.DoubleSide,
  })

  type FlyingFox = {
    built: ReturnType<typeof buildFlyingFox>
    cx: number
    cz: number
    rx: number
    rz: number
    altAbove: number
    speed: number
    phase: number
    yaw: number
    pitch: number
    roll: number
    y: number
  }

  const foxCount = deps.lowPower ? 2 : 4
  let whisperedFox = false

  const flyingFoxes: FlyingFox[] = Array.from({ length: foxCount }, (_, i) => {
    const built = buildFlyingFox(foxMat)
    built.root.scale.setScalar(1.22 + (i % 2) * 0.18)
    group.add(built.root)

    const along = 55 + i * 28
    const across = (i % 2 === 0 ? 1 : -1) * (34 + (i % 2) * 16)
    const cx = deps.cove.x + inDir.x * along + sideDir.x * across
    const cz = deps.cove.z + inDir.y * along + sideDir.y * across
    const altAbove = 24 + (i % 3) * 7
    const initialY = Math.max(12, deps.island.heightAt(cx, cz)) + altAbove
    built.root.position.set(cx, initialY, cz)

    return {
      built,
      cx,
      cz,
      rx: 42 + (i % 2) * 16,
      rz: 30 + ((i + 1) % 2) * 14,
      altAbove,
      speed: (0.16 + (i % 2) * 0.032) * (i % 2 === 0 ? 1 : -1),
      phase: (i / foxCount) * TAU,
      yaw: 0,
      pitch: 0,
      roll: 0,
      y: altAbove + 30,
    }
  })

  function updateFlyingFoxes(
    dt: number,
    t: number,
    cam: THREE.Camera,
    daylight: number,
    walking: boolean,
  ) {
    const dIsland = Math.hypot(cam.position.x - deps.cove.x, cam.position.z - deps.cove.z)
    // Active during twilight, dusk, night, and early dawn; roost high during harsh midday
    const activeTime = daylight < 0.68
    const show = dIsland < 520 && activeTime

    for (const fox of flyingFoxes) {
      fox.built.root.visible = show
    }
    if (!show) return

    for (let i = 0; i < flyingFoxes.length; i++) {
      const fox = flyingFoxes[i]
      const a = t * fox.speed + fox.phase
      const x = fox.cx + Math.cos(a) * fox.rx
      const z = fox.cz + Math.sin(a) * fox.rz + Math.sin(a * 2) * 6
      const vx = -Math.sin(a) * fox.rx * fox.speed
      const vz = (Math.cos(a) * fox.rz + Math.cos(a * 2) * 12) * fox.speed

      const ground = Math.max(0, deps.island.heightAt(x, z))
      const wantY = ground + fox.altAbove + Math.sin(a * 1.5 + fox.phase) * 3.2
      const prevY = fox.y
      fox.y = damp(fox.y, wantY, 1.6, dt)

      const heading = Math.atan2(-vx, -vz)
      const dYaw = angleDelta(fox.yaw, heading)
      fox.yaw += dYaw
      const bankTarget = clamp((-dYaw / Math.max(dt, 1e-3)) * 0.38, -0.65, 0.65)
      fox.roll = damp(fox.roll, bankTarget, 3.0, dt)
      fox.pitch = damp(fox.pitch, clamp((fox.y - prevY) / Math.max(dt * 7, 1e-3), -0.28, 0.28), 3.0, dt)

      // Slow deep rhythmic bat wingbeat alternating with banked glides
      const cycle = (t * 0.22 + fox.phase) % 1
      const flapping = smooth(0.0, 0.12, cycle) * (1 - smooth(0.55, 0.68, cycle))
      const beat = Math.sin(t * 13.5 + fox.phase * 3) * 0.68 * flapping
      const twist = Math.cos(t * 13.5 + fox.phase * 3) * 0.12 * flapping
      fox.built.wingL.rotation.x = beat
      fox.built.wingL.rotation.z = twist
      fox.built.wingR.rotation.x = -beat
      fox.built.wingR.rotation.z = twist

      fox.built.root.position.set(x, fox.y, z)
      dummy.rotation.set(0, 0, 0)
      dummy.rotateY(fox.yaw + Math.PI / 2)
      dummy.rotateZ(fox.pitch)
      dummy.rotateX(fox.roll)
      fox.built.root.quaternion.copy(dummy.quaternion)

      const dCam = Math.hypot(x - cam.position.x, z - cam.position.z)
      if (!whisperedFox && walking && daylight < 0.45 && dCam < 85) {
        whisperedFox = true
        deps.hud.whisper('Dark wings wheel against the evening sky.')
      }
    }
  }

  function update(
    dt: number,
    t: number,
    camera: THREE.Camera,
    state: {
      daylight: number
      storm: number
      biolum: number
      underwater: boolean
      walking: boolean
      playerX: number
      playerY: number
      playerZ: number
      moving: number
      inSea: boolean
    },
  ) {
    updateTropicbirds(dt, t, camera, state.daylight, state.storm)
    updateDragonflies(dt, t, camera, state.daylight, state.storm)
    updateFireflies(t, camera, state.daylight, state.storm, state.underwater, state.walking)
    updateBiolum(dt, t, camera, state.biolum, state.underwater, {
      x: state.playerX,
      y: state.playerY,
      z: state.playerZ,
      moving: state.moving,
      inSea: state.inSea,
    })
    updateTortoises(dt, t, camera, state.playerX, state.playerZ, state.moving, state.walking)
    updateIguanas(dt, t, camera, state.playerX, state.playerZ, state.moving, state.walking)
    updateFlyingFoxes(dt, t, camera, state.daylight, state.walking)
  }

  function setPixelRatio(pr: number) {
    ;(ffPoints.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = pr
    ;(bioPoints.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = pr
  }

  return {
    group,
    glowGroup,
    update,
    disturbWater,
    setPixelRatio,
    tropicbirds,
    dragonflies,
    tortoises,
    iguanas,
    flyingFoxes,
  }
}

export type IslandLife = ReturnType<typeof createIslandLife>
