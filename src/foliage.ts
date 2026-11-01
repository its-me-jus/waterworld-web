import * as THREE from 'three'
import { DETAIL_TILE, groundDetail } from './groundtex'

/**
 * Everything the island is made of, shaded.
 *
 * Three problems, one material. Aerial perspective, because scene fog erases
 * land at a kilometre where real distance leaves a silhouette. Wind, because a
 * frozen palm reads as scenery and a moving one reads as weather. And leaf
 * translucency, because a canopy lit only from the front is a black cut-out —
 * the thing that makes foliage look alive is the light that comes *through* it,
 * and no amount of ambient fill substitutes for it.
 *
 * The variation is baked, not sampled: every plant gets a colour multiplier, a
 * root-to-tip shade ramp and a wind phase written into its vertices before the
 * batch is merged, so five hundred ferns are one draw call and still no two of
 * them are the same green.
 */

export type FoliageRig = {
  /** Shared clock, wind and cloud deck — one write per frame drives every batch. */
  update: (
    time: number,
    strength: number,
    headingRad: number,
    cloudShadow: number,
    tide?: number,
  ) => void
  /** The key light the leaf backlight reads from. */
  setSun: (dir: THREE.Vector3, color: THREE.Color) => void
  /** Scale the aerial perspective — haze sits low, so it thins as the eye climbs. */
  setHazeScale: (k: number) => void
  /**
   * The forest roof seen from above, for the `underRoof` layers: r is how
   * closed the roof is, g the height of its underside in metres. `x`/`z` is
   * the world centre of the map, `extent` its half-width in metres.
   */
  setCanopy: (map: THREE.Texture, x: number, z: number, extent: number) => void
  /**
   * A lit material with aerial perspective, and optionally wind and leaf
   * backlight. `wind` is metres of sway at the tip of a fully-weighted vertex.
   */
  material: (params: FoliageParams) => THREE.MeshStandardMaterial
  /**
   * Build the mesh through this rather than `new THREE.Mesh`: a wind material
   * carries a matching depth material that has to be hung off the object, not
   * the material, or its shadow stands still while the plant moves.
   */
  mesh: (geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial) => THREE.Mesh
}

export type FoliageParams = THREE.MeshStandardMaterialParameters & {
  /** Sway distance in metres at full vertex weight. 0 leaves it rigid. */
  wind?: number
  /** Backlight bleed for thin leaves, 0–1. */
  translucency?: number
  /** Colour of the light that comes through — usually warmer than the leaf. */
  throughColor?: THREE.ColorRepresentation
  /**
   * Stop the backlight glowing where the leaf is already in shade. Worth an
   * extra shadow lookup on a canopy, which is large and cheap to cover; not
   * worth it on grass, which is small and overdraws itself many times.
   */
  shadowedBleed?: boolean
  /**
   * Break the surface up with procedural relief and colour drift. For the
   * terrain shell, which is one enormous smooth mesh and reads as a painted
   * plane without it.
   */
  ground?: boolean
  /**
   * Weight the emissive fill by which way the surface faces: full on top,
   * a third underneath. For stone, whose fill otherwise lights every face the
   * same and flattens a boulder into a pale blob.
   */
  shapedFill?: boolean
  /**
   * Roughen the surface normal with leaf-cluster relief, 0 for none. For a
   * canopy, which is a handful of smooth lumps: close up it reads as an
   * inflated balloon until something at the scale of a hand breaks it up.
   */
  leafBump?: number
  /** Basalt grain, pits and cracks up close, projected by the world normal. */
  stone?: boolean
  /**
   * Sun that comes straight through a leaf from behind it, whichever way you
   * look, 0 for none. For the roof seen from underneath, where every leaf
   * faces away from the sun and without this the whole ceiling is one dark lid.
   */
  transmit?: number
  /**
   * Lives under the forest roof: takes its shade from the canopy map (see
   * setCanopy) — sun pools under the gaps, flecks under the crowns, less sky.
   * Desktop only; a phone keeps the shade painted into the ground.
   */
  underRoof?: boolean
}

export type PlantBake = {
  /** Multiplies the material colour across this whole plant. */
  tint: THREE.Color
  /** Full plant height, so a frond nine metres up knows it's at the top. */
  height: number
  /** Share of the material's wind budget this plant's tip gets, 0–1. */
  sway: number
  /** Extra sway measured from this piece's own root — frond and blade flutter. */
  flutter?: number
  /** The piece hangs from its top, so the flutter runs from the tip up. */
  hang?: boolean
  /** Darkening where the plant meets the ground, 0–1. */
  rootShade?: number
  /** Darkening on the underside of this piece — canopy blobs and bushes. */
  underShade?: number
  /** Keeps a field of grass from moving as one sheet. */
  phase: number
}

/**
 * Write per-plant colour and wind attributes onto a geometry that is still in
 * plant space — root at y = 0, before it is moved onto the hillside.
 */
export function bakePlant(geo: THREE.BufferGeometry, bake: PlantBake) {
  const pos = geo.attributes.position
  const count = pos.count
  geo.computeBoundingBox()
  const box = geo.boundingBox
  const low = box ? box.min.y : 0
  const span = Math.max((box ? box.max.y : 1) - low, 0.0001)
  const height = Math.max(bake.height, 0.0001)
  const flutter = bake.flutter ?? 0
  const rootShade = bake.rootShade ?? 0
  const underShade = bake.underShade ?? 0
  // A piece that arcs over and hangs — a palm frond — has its tip below its
  // base, so height on the piece says nothing about how far out a vertex is.
  // Such pieces carry their own 0–1 distance from base to tip instead.
  const reach = geo.getAttribute('aReach') as THREE.BufferAttribute | undefined

  const colors = new Float32Array(count * 3)
  const wind = new Float32Array(count)
  const phase = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    const y = pos.getY(i)
    // Where this vertex sits on the whole plant, and where it sits on its own
    // piece. A palm needs both: the crown travels with the trunk's lean, and
    // each frond flutters about its own base on top of that.
    const up = THREE.MathUtils.clamp(y / height, 0, 1)
    const local = reach ? reach.getX(i) : bake.hang ? 1 - (y - low) / span : (y - low) / span
    wind[i] = up * up * bake.sway + local * flutter
    phase[i] = bake.phase

    let shade = 1
    if (rootShade > 0) shade -= rootShade * (1 - THREE.MathUtils.smoothstep(up, 0, 0.38))
    if (underShade > 0) shade -= underShade * (1 - THREE.MathUtils.smoothstep(local, 0.1, 0.75))
    colors[i * 3] = bake.tint.r * shade
    colors[i * 3 + 1] = bake.tint.g * shade
    colors[i * 3 + 2] = bake.tint.b * shade
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setAttribute('aWind', new THREE.BufferAttribute(wind, 1))
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
  // Spent — and a batch only merges if every piece carries the same attributes
  if (reach) geo.deleteAttribute('aReach')
  return geo
}

/**
 * A per-plant colour multiplier — deterministic, because a plant's colour has
 * to survive a reload or the island flickers between sessions.
 */
export function plantTint(seed: number, spread = 1, out = new THREE.Color(), accent = 0) {
  const r = (n: number) => {
    const v = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453
    return v - Math.floor(v)
  }
  // Green things vary far more in value than in hue, and what hue shift there
  // is runs yellow-to-blue rather than around the wheel
  const value = 1 + (r(1) - 0.5) * 0.5 * spread
  const warm = (r(2) - 0.5) * 0.22 * spread
  let red = value * (1 + warm)
  let green = value
  let blue = value * (1 - warm * 1.3)
  // A share of plants step well outside that band — deep emerald where growth
  // is lush, sun-bronzed olive where it is hard-pressed. Every plant in one
  // narrow yellow-green made the island a monochrome wash; a few in ten off
  // the main hue is what a real hillside has. `accent` is that share.
  if (accent > 0) {
    const pick = r(3)
    // These are multipliers on a leaf colour whose blue channel is nearly
    // nothing in linear light, so teal needs a big factor on blue before it
    // shows at all
    if (pick < accent * 0.55) {
      red *= 0.55
      blue *= 4
    } else if (pick < accent) {
      red *= 2
      green *= 0.82
      blue *= 0.9
    }
  }
  return out.setRGB(
    THREE.MathUtils.clamp(red, 0.3, 2.4),
    THREE.MathUtils.clamp(green, 0.35, 1.7),
    THREE.MathUtils.clamp(blue, 0.3, 4.6),
  )
}

const windVertexPars = /* glsl */ `
attribute float aWind;
attribute float aPhase;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uWindScale;
`

/**
 * Sway is applied in object space, which for the island group is a pure
 * translation of world space, so pushing along x/z pushes downwind. The small
 * drop on y keeps the tip on an arc instead of stretching the plant.
 */
const windVertexBody = /* glsl */ `
  if (aWind > 0.0001) {
    float t = uTime;
    float sway =
      sin(t * 1.35 + aPhase * 6.2831 + transformed.x * 0.11) * 0.6 +
      sin(t * 2.7 + aPhase * 3.1 + transformed.z * 0.19) * 0.28 +
      sin(t * 5.3 + aPhase * 9.4) * 0.12;
    // Gusts roll across the hillside rather than everything breathing together
    float gust = 0.55 + 0.45 * sin(t * 0.27 + (transformed.x + transformed.z) * 0.012);
    float amount = aWind * uWindScale * uWindStrength * (0.45 + 0.55 * sway) * gust;
    transformed.x += uWindDir.x * amount;
    transformed.z += uWindDir.y * amount;
    transformed.y -= abs(amount) * 0.22 * aWind;
  }
`

const leafFragmentPars = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uTranslucency;
uniform vec3 uThroughColor;
uniform float uTransmit;
`

/**
 * Cheap subsurface: light that entered the far side of the leaf leaves the near
 * side bent slightly around the normal, so it peaks when you are looking into
 * the sun through the canopy and falls off as you turn away. `getShadowMask`
 * keeps a frond that is already in shade from glowing.
 */
/**
 * Undo three's back-face normal flip.
 *
 * A double-sided surface normally shades its back faces with an inverted
 * normal, which is right for a wall and wrong for a leaf: it makes the far
 * half of every blade shade as though it were the underside of the ground,
 * and under a hemisphere light whose ground colour is near-black — because
 * for the ocean it should be — that half goes black. A leaf has one lighting
 * side, and both faces of it are that side.
 */
const leafNormalBody = /* glsl */ `
  normal *= faceDirection;
`

const leafFragmentBody = /* glsl */ `
  {
    vec3 leafN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
    vec3 leafV = normalize(cameraPosition - vGroundPos);
    vec3 leafL = normalize(uSunDir);
    vec3 through = normalize(-leafL + leafN * 0.4);
    float back = pow(max(dot(leafV, through), 0.0), 3.5) * 1.5;
    // Wrapped diffuse. A leaf a millimetre thick has no true shade side, and
    // without this the half of every blade facing away from the sun crushes to
    // black — which is exactly what a lawn of flat sheets must not do.
    float wrap = max(dot(leafN, leafL) * 0.5 + 0.5, 0.0);
    // Light that came in the far face and leaves this one scattered, which a
    // roof seen from below is almost nothing but. Scaled by how much the leaf
    // turns its back to the sun, so the tops of the crowns don't take it too.
    float bleed = back + wrap * 0.55 + max(-dot(leafN, leafL), 0.0) * uTransmit;
    #if defined( SHADOWED_BLEED ) && defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      bleed *= 0.35 + 0.65 * getShadowMask();
    #endif
    reflectedLight.directDiffuse +=
      uSunColor * uThroughColor * diffuseColor.rgb * bleed * uTranslucency;
  }
`

const noiseFragmentPars = /* glsl */ `
/**
 * Sine-free hash. The usual fract(sin(dot)) form runs a transcendental per
 * corner, and between the ground detail and the cloud deck this is evaluated a
 * few dozen times on every terrain pixel in the frame — enough that the sines
 * alone were the most expensive thing in the shader.
 */
float gHash(vec2 p) {
  vec2 q = fract(p * vec2(233.34, 851.73));
  q += dot(q, q + 23.45);
  return fract(q.x * q.y);
}

float gNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(gHash(i), gHash(i + vec2(1.0, 0.0)), u.x),
    mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

/** Two octaves of ground texture — clods over hummocks. */
float gRelief(vec2 p) {
  return gNoise(p * 0.7) * 0.62 + gNoise(p * 2.9) * 0.38;
}
`

/**
 * Cloud shadow.
 *
 * A hillside under an unbroken sun is one value from the beach to the ridge,
 * and no amount of surface detail fixes that — it is a lighting problem, not a
 * texture problem. Dragging the cloud deck's own shape across the land gives
 * the island slow bands of light and shade that move, which is most of what
 * makes a landscape look like weather is happening to it.
 *
 * Only direct light is masked. Ambient and skylight still reach the ground in
 * shade, or the shadowed bands read as holes.
 */
const cloudShadowPars = /* glsl */ `
uniform vec2 uCloudDrift;
uniform float uCloudShadow;
`

const cloudShadowBody = /* glsl */ `
  if (uCloudShadow > 0.001) {
    // One octave. This runs on every blade of grass in the frame and the
    // overdraw there is enormous; the second octave was invisible at the
    // scale a cloud shadow works at anyway.
    float deck = gNoise(vGroundPos.xz * 0.0026 + uCloudDrift);
    // Wide edges. A cloud's shadow has a penumbra a good fraction of its own
    // width — tighten this and the island gets a hard diagonal line across it
    // with a lit half and a dark half.
    float shade = smoothstep(0.38, 0.74, deck) * uCloudShadow;
    reflectedLight.directDiffuse *= 1.0 - shade;
    reflectedLight.directSpecular *= 1.0 - shade;
  }
`

/**
 * Shade under the forest roof.
 *
 * The roof can't cast — a few thousand crowns in the shadow map put the whole
 * interior in one night-dark shadow and cost a depth pass — so this reads a
 * top-down map of it instead. One tap straight up finds the roof's underside;
 * the second is slid toward the sun by that height, so the pool of light
 * under a gap lands where the gap actually throws it and drifts with the day.
 * Under the crowns the sun only gets through in flecks, small and moving
 * gently as the leaves above them do, and the sky is mostly hidden, so the
 * ambient drops too.
 */
const canopyShadePars = /* glsl */ `
uniform sampler2D uCanopy;
uniform vec3 uCanopyXf;
uniform vec3 uCanopySun;
uniform float uTime;
`

const canopyShadeBody = /* glsl */ `
  {
    vec2 cuv = (vGroundPos.xz - uCanopyXf.xy) * uCanopyXf.z;
    vec2 over = texture2D(uCanopy, cuv).rg;
    vec3 sunW = normalize(uCanopySun);
    float above = max(over.g * 255.0 - vGroundPos.y, 0.0);
    float roofShadow = texture2D(uCanopy, cuv + sunW.xz / max(sunW.y, 0.3) * above * uCanopyXf.z).r;
    float ft = uTime * 0.4;
    // Along the sun's rays down to sea level, so a fleck on a trunk is part of
    // the same pattern as the ones on the floor beside it rather than a stripe
    vec2 ray = vGroundPos.xz - sunW.xz / max(sunW.y, 0.3) * vGroundPos.y;
    vec2 fp = ray * 0.9 + vec2(sin(ft + ray.y * 0.07), cos(ft * 0.8 + ray.x * 0.07)) * 0.1;
    // Two octaves, cut high: small spots in loose clusters, not soft blobs
    float spots = gNoise(fp) * 0.55 + gNoise(fp * 2.7 + 5.2) * 0.45;
    float fleck = smoothstep(0.6, 0.71, spots) * (0.35 + 0.65 * smoothstep(0.3, 0.62, gNoise(vGroundPos.xz * 0.09 + 3.0)));
    // A roof of leaves is not a slab: over a quarter of the sun still comes through
    // scattered, and the flecks are the sun itself through a hole
    float lit = 1.0 - roofShadow * (0.72 - fleck * 0.7);
    reflectedLight.directDiffuse *= lit;
    reflectedLight.directSpecular *= lit;
    float sky = 1.0 - over.r * 0.15;
    reflectedLight.indirectDiffuse *= sky;
    reflectedLight.indirectSpecular *= sky;
    totalEmissiveRadiance *= sky;
  }
`

/**
 * Leaf-cluster relief for a canopy. A broadleaf crown is five or six smooth
 * lumps, and the light slides over each one like a polished egg. Tilting the
 * normal by two octaves of world-space noise — clusters a hand or two across —
 * gives the sun something to catch and lose, so a crown reads as a mass of
 * leaves rather than one. Fades out with range, where it would only shimmer.
 */
const leafBumpPars = /* glsl */ `
uniform float uLeafBump;
`

const leafBumpBody = /* glsl */ `
  {
    float bumpFade = 1.0 - smoothstep(18.0, 75.0, length(vGroundPos - cameraPosition));
    if (bumpFade > 0.01) {
      // Height skews the lookup so the pattern doesn't stripe straight up a crown
      vec2 lp = vGroundPos.xz * 4.2 + vGroundPos.y * vec2(1.7, 2.3);
      float b0 = gNoise(lp) * 0.65 + gNoise(lp * 2.3 + 7.1) * 0.35;
      vec2 lx = lp + vec2(0.35, 0.0);
      vec2 lz = lp + vec2(0.0, 0.35);
      float bx = gNoise(lx) * 0.65 + gNoise(lx * 2.3 + 7.1) * 0.35;
      float bz = gNoise(lz) * 0.65 + gNoise(lz * 2.3 + 7.1) * 0.35;
      vec3 bw = normalize((vec4(normal, 0.0) * viewMatrix).xyz + vec3(b0 - bx, 0.0, b0 - bz) * uLeafBump * bumpFade);
      normal = normalize((viewMatrix * vec4(bw, 0.0)).xyz);
    }
  }
`

/**
 * The terrain mesh samples its height every few metres, so between grid lines
 * it is perfectly flat and shades as a single tone across a whole hillside.
 * This gives it back the two things a real slope has: a normal that wobbles,
 * and a colour that drifts. Both fade out with distance, where they would only
 * alias.
 */
const groundNormalBody = /* glsl */ `
  {
    vec2 gp = vGroundPos.xz;
    float gDist = length(vGroundPos - cameraPosition);
    // Two scales, because one can't cover both jobs. The coarse one is roughly
    // twenty metres across and stays on at any range — it's what gives a
    // distant hillside form instead of a silhouette. The fine one is clods
    // underfoot and has to fade out before it starts aliasing into fizz.
    //
    // Both are deliberately weak. A tilted normal costs whatever the key light
    // is worth, so the amplitude that read as gentle undulation under a dim
    // sun turns into soft black lobes the size of a house once the sun is
    // doing most of the lighting.
    float coarse = gNoise(gp * 0.055);
    vec3 bump = vec3(
      coarse - gNoise(gp * 0.055 + vec2(0.35, 0.0)),
      0.0,
      coarse - gNoise(gp * 0.055 + vec2(0.0, 0.35))
    ) * 0.2;
    float gNear = 1.0 - smoothstep(10.0, 55.0, gDist);
    if (gNear > 0.01) {
      float h0 = gRelief(gp);
      bump += vec3(h0 - gRelief(gp + vec2(0.55, 0.0)), 0.0, h0 - gRelief(gp + vec2(0.0, 0.55)))
        * 0.7 * gNear;
    }
    // Ledges on rock faces: the strata below, tilted up where a band steps
    // out, so a low sun picks out lines across a cliff instead of one flat
    // plane. Steep faces only — vGroundUp is the mesh normal before any bump.
    float cliffN = 1.0 - smoothstep(0.35, 0.62, vGroundUp);
    if (cliffN > 0.01) {
      float ly = vGroundPos.y * 0.55 + gNoise(gp * 0.035) * 6.0 + gNoise(gp * 0.11) * 1.5;
      float ledge = gNoise(vec2(ly + 0.25, 0.5)) - gNoise(vec2(ly - 0.25, 0.5));
      bump.y += ledge * 0.9 * cliffN;
      // Columns. Basalt cools into vertical prisms, so the face is tilted
      // sideways by stripes that depend on where you are along it and not on
      // how high — a low sun then lights one flank of each column and not the
      // other. Two diagonals so a wall facing any way still gets stripes.
      float along = (gp.x + gp.y) * 0.7071;
      float across = (gp.x - gp.y) * 0.7071;
      // Six-metre flutes, so the sun picks out vertical stripes across a wall
      // seen from the water, and metre-wide joints that fade by fifty metres
      float fA = gNoise(vec2(along * 0.16, 3.1));
      float fB = gNoise(vec2(across * 0.16, 8.7));
      bump.xz += vec2(0.7071, 0.7071) * (fA - gNoise(vec2(along * 0.16 + 0.35, 3.1))) * 1.6 * cliffN;
      bump.xz += vec2(0.7071, -0.7071) * (fB - gNoise(vec2(across * 0.16 + 0.35, 8.7))) * 1.6 * cliffN;
      float jointNear = 1.0 - smoothstep(20.0, 70.0, gDist);
      if (jointNear > 0.01) {
        float jA = gNoise(vec2(along * 0.85, 5.3));
        float jB = gNoise(vec2(across * 0.85, 1.9));
        bump.xz += vec2(0.7071, 0.7071) * (jA - gNoise(vec2(along * 0.85 + 0.3, 5.3))) * 1.0 * cliffN * jointNear;
        bump.xz += vec2(0.7071, -0.7071) * (jB - gNoise(vec2(across * 0.85 + 0.3, 1.9))) * 1.0 * cliffN * jointNear;
      }
    }
    vec3 nw = normalize((vec4(normal, 0.0) * viewMatrix).xyz + bump);
    normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
    normal = gDetailBump(normal, -vViewPosition, gDetailH);
  }
`

/**
 * Close-up detail, shared by the terrain and the stones: one tiling texture
 * of data channels (see groundtex.ts), and a bump that needs no tangents.
 *
 * `gDetailH` is a height in metres, set during the colour stage — which runs
 * before the normal stage in three's shader — and turned into a normal by its
 * screen-space derivatives (Mikkelsen's surface-gradient bump). It has to be
 * written outside any branch the derivatives would straddle.
 */
const detailPars = /* glsl */ `
uniform sampler2D uDetail;
float gDetailH = 0.0;
float gDetailTone = 1.0;
vec3 gDetailBump(vec3 N, vec3 p, float h) {
  vec3 dpdx = dFdx(p);
  vec3 dpdy = dFdy(p);
  float dhx = dFdx(h);
  float dhy = dFdy(h);
  vec3 r1 = cross(dpdy, N);
  vec3 r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * N - grad);
}
`

/**
 * Boulders and stones: basalt grain, pits and cracks, projected from three
 * sides by the world normal, since stones carry no uv. Fades with range,
 * where it would only shimmer.
 */
const stoneColorBody = /* glsl */ `
  {
    vec3 sw = pow(abs(normalize(vStoneN)), vec3(4.0));
    sw /= dot(sw, vec3(1.0));
    vec3 sp = vGroundPos / ${(DETAIL_TILE * 0.8).toFixed(3)};
    float sr = texture2D(uDetail, sp.zy).b * sw.x + texture2D(uDetail, sp.xz).b * sw.y + texture2D(uDetail, sp.xy).b * sw.z;
    float sFade = 1.0 - smoothstep(15.0, 45.0, length(vGroundPos - cameraPosition));
    gDetailTone = mix(1.0, 0.7 + sr * 0.6, sFade);
    diffuseColor.rgb *= gDetailTone;
    gDetailH = (sr - 0.5) * 0.025 * sFade;
  }
`

/** A colour as a GLSL literal. Linear, because that is what the vertex colours the ramp mixes with hold. */
const glslColor = (hex: string) => {
  const c = new THREE.Color(hex)
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`
}

/**
 * The beach: shelf, wet sand, dry sand, as a ramp in height.
 *
 * It used to be painted into the terrain's vertices, and on a 5.8 m grid a
 * ramp only a metre or two tall came out as a sawtooth of diagonal bands where
 * triangle edges cut across it. Evaluated here it follows the pixel's own
 * height instead — and the height is nudged by a slow noise, so the lines
 * between wet and dry wander the way a real tide line does rather than
 * tracing a contour.
 *
 * `vSandW` is how much of the pixel the beach owns after the green and the rock
 * have taken their shares; it is baked per vertex in island.ts.
 */
const beachRampBody = /* glsl */ `
    if (vSandW != 0.0) {
      float ys = vGroundPos.y + (gNoise(gp * 0.27 + vec2(11.0, -4.0)) - 0.5) * 0.45;
      float sandGrit = gNoise(gp * 0.09 + vec2(-1.4, 3.7)) * 0.6 + gNoise(gp * 0.52) * 0.4;
      // Lagoon sand stays pale a few metres down — coral sand is near white,
      // and it is what makes the water over it turquoise rather than teal
      vec3 sand = mix(${glslColor('#4f6458')}, ${glslColor('#cbbb95')}, smoothstep(-12.0, -3.0, ys));
      sand = mix(sand, ${glslColor('#b89468')}, smoothstep(-1.2, -0.3, ys));
      float wetBand = smoothstep(-1.1, 0.2, ys) * (1.0 - smoothstep(0.5, 2.6, ys));
      sand = mix(sand, ${glslColor('#b0a082')}, wetBand * (0.28 + sandGrit * 0.18));
      sand = mix(sand, ${glslColor('#f2e2b4')}, smoothstep(1.0, 5.2, ys));
      // vSandW is interpolated between corners, so a triangle with one low
      // corner on a steep wall smears pale sand up the rock as a wedge. A
      // beach does not exist far above the tide: cut it by the pixel's height.
      diffuseColor.rgb += sand * vSandW * (1.0 - smoothstep(7.0, 14.0, vGroundPos.y));
    }
`

const groundColorBody = /* glsl */ `
  {
    vec2 gp = vGroundPos.xz;
    // The forest floor is painted darker under the roof; litter follows it
    float floorLum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
    // Taps before any branch, so their mip selection never straddles one
    vec4 det = texture2D(uDetail, gp / ${DETAIL_TILE.toFixed(3)});
    #ifdef GROUND_MICRO
      // Cliffs: two side-on taps at a coarser repeat, weighted by the facet's
      // own facing, since a top-down tap smears straight down a wall
      vec3 facet = abs(normalize(cross(dFdx(vGroundPos), dFdy(vGroundPos))));
      vec2 cw = facet.xz / max(facet.x + facet.z, 0.001);
      float rockDet =
        texture2D(uDetail, vGroundPos.zy / ${(DETAIL_TILE * 3).toFixed(3)}).b * cw.x +
        texture2D(uDetail, vGroundPos.xy / ${(DETAIL_TILE * 3).toFixed(3)}).b * cw.y;
    #else
      float rockDet = 0.5;
    #endif
    ${beachRampBody}
    // None of these bands fade with distance: the whole point is that a
    // hillside seen from four hundred metres still has patches on it. Only the
    // relief bump above fades, because only the bump aliases.
    float gDist = length(vGroundPos - cameraPosition);
    float macro = gNoise(gp * 0.0105);
    float mid = gNoise(gp * 0.062);
    float fine = gNoise(gp * 0.31);
    // Nothing in the bands above is smaller than three metres across, which is
    // why the ground held up at four hundred metres and turned to smooth
    // plastic at four. Two more octaves carry it down to tussock and then to
    // blade, and both have to be gone by the time a pixel covers more than one
    // of them or the hillside boils.
    #ifdef GROUND_MICRO
      float tussockFade = 1.0 - smoothstep(14.0, 46.0, gDist);
      float bladeFade = 1.0 - smoothstep(3.0, 13.0, gDist);
      float tussock = tussockFade > 0.01 ? gNoise(gp * 1.35) : 0.5;
      float blade = bladeFade > 0.01 ? gNoise(gp * 6.2) : 0.5;
    #endif

    // Value alone barely survives the tone map at these brightnesses, so the
    // patches change hue too: sun-bleached on the exposed shoulders, deep and
    // blue-green where growth collects, bare dirt in between.
    vec3 bleached = diffuseColor.rgb * vec3(1.3, 1.19, 0.78);
    vec3 deep = diffuseColor.rgb * vec3(0.62, 0.86, 0.62);
    vec3 bare = diffuseColor.rgb * vec3(1.12, 1.02, 0.9);

    // Value noise clusters hard around 0.5 — it is an average of averages — so
    // these windows have to straddle the middle. Thresholds anywhere near the
    // ends simply never fire and the whole hillside comes out one colour.
    // Sand takes the value break-up but not the hue: green patches on a beach
    // read as algae. The band only opens above the tide line.
    // Bare rock keeps its own colour: the sun-bleached and lush patches below
    // are for soil, and on a cliff they came out as pink and olive stains.
    float cliff = 1.0 - smoothstep(0.35, 0.62, vGroundUp);
    float green = smoothstep(5.0, 13.0, vGroundPos.y) * (1.0 - cliff * 0.9);
    float dry = smoothstep(0.46, 0.66, macro * 0.65 + fine * 0.35) * green;
    float lush = smoothstep(0.46, 0.66, (1.0 - macro) * 0.5 + mid * 0.5) * green;
    vec3 patched = mix(bare, bleached, dry);
    patched = mix(patched, deep, lush);

    // Value break-up. The near octaves are signed about their own mean so they
    // only ever add texture, never a brightness step at the distance they fade
    // in at.
    float shading = 0.66 + macro * 0.26 + mid * 0.3 + fine * 0.18;
    #ifdef GROUND_MICRO
      shading += (tussock - 0.5) * 0.3 * tussockFade;
      shading += (blade - 0.5) * 0.22 * bladeFade;
    #endif
    diffuseColor.rgb = patched * shading;

    // Rock faces. The vertex paint already turns steep ground to stone, but a
    // whole cliff came out one tone per facet — a smooth slab. This is basalt,
    // so what it needs is what basalt has: vertical columns (joint lines
    // darker than the crown of each prism), faint flow bands that wander with
    // the face, dark streaks where rain runs down, and a little moss and
    // lichen on the seeps. It stays cool and nearly neutral — warm ochre bands
    // are what made it read as sandstone — with the warmth confined to the
    // weathered patches, because value alone dies in the tone map.
    if (cliff > 0.01) {
      float ly = vGroundPos.y * 0.55 + gNoise(gp * 0.035) * 6.0 + gNoise(gp * 0.11) * 1.5;
      float strata = gNoise(vec2(ly, 0.5));
      float beds = gNoise(vec2(ly * 3.1, 7.3));
      float along = (gp.x + gp.y) * 0.7071;
      float across = (gp.x - gp.y) * 0.7071;
      // Flutes six metres wide, which still show from the sea, and joints a
      // metre wide that only the nearer view resolves
      float flute = gNoise(vec2(along * 0.16, 3.1)) * 0.5 + gNoise(vec2(across * 0.16, 8.7)) * 0.5;
      float joint = gNoise(vec2(along * 0.85, 5.3)) * 0.5 + gNoise(vec2(across * 0.85, 1.9)) * 0.5;
      float prism = (1.0 - abs(flute * 2.0 - 1.0)) * 0.7 + (1.0 - abs(joint * 2.0 - 1.0)) * 0.3 * (1.0 - smoothstep(60.0, 170.0, gDist));
      float streak = smoothstep(0.55, 0.8, gNoise(vec2((gp.x + gp.y) * 0.45, vGroundPos.y * 0.04)));
      float tone = 0.78 + prism * 0.36 + (strata - 0.5) * 0.14 + (beds - 0.5) * 0.12 - streak * 0.3;
      float weathered = smoothstep(0.5, 0.75, gNoise(gp * 0.07 + vec2(vGroundPos.y * 0.03, 2.2)));
      // Held a touch warm: the sky that lights a shaded face is blue, and a
      // neutral albedo under it came out navy
      vec3 hue = mix(vec3(1.0, 1.0, 1.0), vec3(1.16, 1.07, 0.9), weathered * 0.8);
      vec3 rockC = diffuseColor.rgb * hue * tone;
      // Moss collects on the benches and in the wet seams, never on a clean face
      float seep = smoothstep(0.64, 0.84, gNoise(vec2(along * 0.3 + 4.0, vGroundPos.y * 0.09)));
      rockC = mix(rockC, vec3(0.05, 0.085, 0.02) * (0.8 + prism * 0.5), seep * (1.0 - streak) * 0.4);
      diffuseColor.rgb = mix(diffuseColor.rgb, rockC, cliff);
    }

    // Rocky-shore zones. A band a metre tall cannot live in vertex paint on a
    // 5.8 m grid, so it comes from the pixel's own height: green alga at the
    // waterline, a pale barnacle band at the high-tide mark, a dab of orange
    // lichen above it, and the black rock over that. Only on bare rock (the
    // beach owns the pixels with sand in them) and only where the sea reaches.
    float rockLow = 1.0 - smoothstep(0.1, 0.8, vSandW);
    if (rockLow > 0.02 && vGroundPos.y > -1.0 && vGroundPos.y < 3.8) {
      float zy = vGroundPos.y + (gNoise(gp * 0.23 + vec2(3.0, 8.0)) - 0.5) * 0.9;
      float zp = gNoise(gp * 1.9 + vec2(-6.0, 1.0));
      float cover = smoothstep(0.3, 0.62, zp);
      float zFade = rockLow * (1.0 - smoothstep(3.2, 3.8, vGroundPos.y));
      float algae = smoothstep(-0.35, 0.05, zy) * (1.0 - smoothstep(0.55, 1.05, zy));
      float barn = smoothstep(0.85, 1.25, zy) * (1.0 - smoothstep(2.3, 2.9, zy));
      float lichen = smoothstep(2.5, 2.9, zy) * (1.0 - smoothstep(3.2, 3.6, zy)) *
        smoothstep(0.55, 0.72, gNoise(gp * 1.3 - vec2(2.0, 9.0)));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.12, 0.02), algae * (0.45 + 0.4 * cover) * zFade);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.24, 0.235, 0.2) * (0.85 + 0.3 * zp), barn * (0.25 + 0.4 * cover) * zFade);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.34, 0.17, 0.03), lichen * 0.4 * zFade);
    }

    // Close-up detail: sand grain, dead leaves on the soil, grain in the rock.
    // All of it is gone by fifty metres, where one texture repeat is a pixel
    // or two and the tiling would start to show.
    float detFade = 1.0 - smoothstep(22.0, 50.0, gDist);
    float sandAmt = clamp(vSandW, 0.0, 1.0) * (1.0 - smoothstep(7.0, 14.0, vGroundPos.y));
    diffuseColor.rgb *= mix(1.0, 0.8 + det.r * 0.4, sandAmt * detFade);
    // Litter thickest where the floor is darkest, under the roof; thin on the
    // open lawn, none on sand or bare rock. Drifts by a slow noise too.
    float soil = green * (1.0 - cliff) * (1.0 - sandAmt);
    // Where the canopy map does the shading the floor is painted lighter
    // (island.ts), so the same litter sits a step further up the scale
    #ifdef CANOPY_SHADE
      float litterLum = 1.0 - smoothstep(0.075, 0.16, floorLum);
    #else
      float litterLum = 1.0 - smoothstep(0.06, 0.14, floorLum);
    #endif
    float litterAmt = soil * (0.25 + 0.75 * litterLum) *
      (0.55 + 0.45 * smoothstep(0.25, 0.55, gNoise(gp * 0.21 + vec2(5.0, -2.0))));
    float leafMask = smoothstep(0.03, 0.12, det.g);
    vec3 leafC = mix(${glslColor('#5a3d22')}, ${glslColor('#94703c')}, smoothstep(0.08, 0.6, det.a));
    leafC = mix(leafC, ${glslColor('#6f6a38')}, smoothstep(0.78, 0.96, det.a));
    leafC = mix(leafC, ${glslColor('#3e3226')}, 1.0 - smoothstep(0.03, 0.06, det.a));
    diffuseColor.rgb = mix(diffuseColor.rgb, leafC * (0.42 + det.g * 0.55), leafMask * litterAmt * detFade);
    float cliffFade = 1.0 - smoothstep(40.0, 120.0, gDist);
    diffuseColor.rgb *= mix(1.0, 0.8 + rockDet * 0.4, cliff * cliffFade);

    // Live tide wetness — the painted beach was a fixed band; the foreshore
    // now darkens and cools where the water actually sits, and sheens a touch.
    float relative = vGroundPos.y - uTide;
    float sandMask = 1.0 - smoothstep(3.5, 11.0, vGroundPos.y);
    float awash =
      (1.0 - smoothstep(-0.35, 1.55, relative)) *
      smoothstep(-7.0, -0.15, relative);
    // Soft lace of darker sand just above the lip — recently washed
    float swash = smoothstep(0.05, 0.55, relative) * (1.0 - smoothstep(0.9, 2.2, relative));
    float wetNoise = 0.72 + 0.28 * gNoise(gp * 0.85 + vec2(uTide * 0.4, 0.0));
    gWetness = clamp((awash * 0.92 + swash * 0.55) * sandMask * wetNoise, 0.0, 1.0);
    // Wet coral sand holds its pale mineral colour. Most of the change is
    // sheen, not a second dark-brown stripe painted over the beach ramp.
    vec3 wetTint = diffuseColor.rgb * vec3(0.72, 0.79, 0.81);
    diffuseColor.rgb = mix(diffuseColor.rgb, wetTint, gWetness * 0.62);

    // Relief for the bump: grain and wind ripples on dry sand (water smooths
    // both), a few millimetres of leaf over the soil, centimetres on rock.
    // Ripples run across the trade wind about a hand apart, so they are gone
    // by ten metres, before they alias.
    float rippleAmt = sandAmt * smoothstep(2.2, 4.0, vGroundPos.y) * (1.0 - smoothstep(3.0, 10.0, gDist));
    float rp = dot(gp, vec2(0.83, 0.56)) * 26.0 + gNoise(gp * 0.9) * 7.0 + gNoise(gp * 3.1) * 1.5;
    float ripple = pow(0.5 + 0.5 * sin(rp), 1.6);
    float tidalRipple = sandAmt * smoothstep(-7.0, -2.0, relative) *
      (1.0 - smoothstep(0.0, 1.2, relative)) * (1.0 - smoothstep(5.0, 18.0, gDist));
    float tidalRidge = sin(dot(gp, vec2(0.57, 0.82)) * 18.0 + gNoise(gp * 1.2) * 3.5);
    diffuseColor.rgb *= 1.0 + tidalRidge * tidalRipple * 0.045;
    gDetailH =
      (sandAmt * (det.r - 0.5) * 0.0022 * (1.0 - gWetness) + ripple * 0.02 * rippleAmt + tidalRidge * tidalRipple * 0.008) * detFade +
      leafMask * litterAmt * det.g * 0.012 * detFade +
      cliff * (rockDet - 0.5) * 0.08 * cliffFade;

    // A cliff in shade is lit by a clear sky, which is blue, and then has the
    // grade's blue shadow lift added on top: a dark rock face lands on that
    // floor and reads as ink however it is painted. Basalt has a colour of its
    // own, so give it a share of itself back as emission, which keeps the
    // columns, streaks and moss visible in shade and takes the cast off.
    totalEmissiveRadiance += diffuseColor.rgb * cliff * 0.3;
  }
`

/**
 * Fill that has a direction. A flat emissive term keeps stone out of black
 * shade, but it lights the underside of a boulder as brightly as its crown,
 * and that is what turned rocks into unlit dough. Weighting it by the
 * world-space normal gives the fill a sky above and dark ground below.
 *
 * Switched by a uniform rather than a define: every variant is another
 * program to compile at load, and on a phone each one is felt.
 */
const shapedFillPars = /* glsl */ `
uniform float uShapedFill;
`

const shapedFillBody = /* glsl */ `
  if (uShapedFill > 0.5) {
    vec3 fillN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
    totalEmissiveRadiance *= 0.3 + 0.9 * (fillN.y * 0.5 + 0.5);
  }
`

const groundWetPars = /* glsl */ `
uniform float uTide;
float gWetness = 0.0;
`

const groundWetBody = /* glsl */ `
  roughnessFactor = mix(roughnessFactor, 0.22, gWetness * 0.92);
  metalnessFactor = mix(metalnessFactor, 0.06, gWetness * 0.55);
`

/** Texels across the leaf atlas, for the mip-level estimate on cards whose map doesn't say. */
const CARD_TEX_SIZE = 1024

export function createFoliage(haze: THREE.Color, opts: { lowPower?: boolean } = {}): FoliageRig {
  // Shared uniform holders. onBeforeCompile copies the reference, so one write
  // here reaches every material built off this rig.
  const uTime = { value: 0 }
  const uWindDir = { value: new THREE.Vector2(0.82, 0.57) }
  const uWindStrength = { value: 1 }
  const uSunDir = { value: new THREE.Vector3(0, 1, 0) }
  const uSunColor = { value: new THREE.Color(1, 0.95, 0.85) }
  const uHaze = { value: haze }
  const uHazeDensity = { value: 0.0021 }
  const uCloudDrift = { value: new THREE.Vector2() }
  const uCloudShadow = { value: 0.45 }
  const uTide = { value: 0 }
  // Painted on first use; the island's terrain and stones share it
  const uDetail = { value: null as THREE.Texture | null }
  const uCanopy = { value: null as THREE.Texture | null }
  const uCanopyXf = { value: new THREE.Vector3(0, 0, 1) }
  const depthMaterials = new WeakMap<THREE.Material, THREE.MeshDepthMaterial>()

  function material(params: FoliageParams) {
    const {
      wind = 0,
      translucency = 0,
      throughColor,
      ground = false,
      shadowedBleed = false,
      shapedFill = false,
      stone = false,
      leafBump = 0,
      transmit = 0,
      underRoof = false,
      ...rest
    } = params
    const mat = new THREE.MeshStandardMaterial({ ...rest, fog: false })
    if (shadowedBleed) mat.defines = { ...mat.defines, SHADOWED_BLEED: '' }
    const roofShade = underRoof && !opts.lowPower
    if (roofShade) mat.defines = { ...mat.defines, CANOPY_SHADE: '' }
    // The two closest octaves of ground colour are the finest detail in the
    // frame and the least visible on a five-inch screen. They come out on a
    // phone, where the terrain is most of the fill in any shot facing inland.
    if (ground && !opts.lowPower) mat.defines = { ...mat.defines, GROUND_MICRO: '' }
    // Every material off this rig shares one onBeforeCompile source, which is
    // what three keys compiled programs on — so a rock and a log could be
    // handed the same program whichever compiled first. Name what actually
    // changes the shader.
    const cards = !!rest.map && (rest.alphaTest ?? 0) > 0
    const programKey = `foliage:${wind > 0}:${translucency > 0}:${ground}:${leafBump > 0}:${cards}:${stone}:${roofShade}`
    mat.customProgramCacheKey = () => programKey
    const uShapedFill = { value: shapedFill ? 1 : 0 }
    if ((ground || stone) && !uDetail.value) uDetail.value = groundDetail()
    const uWindScale = { value: wind }
    const uTranslucency = { value: translucency }
    const uTransmit = { value: transmit }
    // Texels across this card's texture, for the mip estimate below
    const cardTexels = { value: (rest.map?.image as { width?: number } | undefined)?.width ?? CARD_TEX_SIZE }
    const uLeafBump = { value: leafBump }
    const uThrough = { value: new THREE.Color(throughColor ?? '#cfe27a') }

    const addWind = (shader: THREE.WebGLProgramParametersWithUniforms) => {
      shader.uniforms.uTime = uTime
      shader.uniforms.uWindDir = uWindDir
      shader.uniforms.uWindStrength = uWindStrength
      shader.uniforms.uWindScale = uWindScale
      shader.vertexShader = `${windVertexPars}\n${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${windVertexBody}`,
      )
    }

    // Shadows come out of a depth pass that knows nothing about the wind, so a
    // swaying frond would drop a rigid shadow. Give the depth material the
    // same displacement.
    if (wind > 0) {
      // A leaf card's shadow has to be cut out the same as the card, or every
      // spray drops a solid rectangle
      const depth = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        map: rest.map ?? null,
        alphaTest: rest.alphaTest ?? 0,
      })
      depth.onBeforeCompile = addWind
      depthMaterials.set(mat, depth)
    }

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uHaze = uHaze
      shader.uniforms.uHazeDensity = uHazeDensity
      shader.uniforms.uHazeMax = { value: 0.88 }

      shader.vertexShader = `varying vec3 vGroundPos;\n${ground ? 'varying float vGroundUp;\nattribute float aSandW;\nvarying float vSandW;\n' : ''}${stone ? 'varying vec3 vStoneN;\n' : ''}${shader.vertexShader}`

      if (wind > 0) addWind(shader)

      // World position has to be read after the wind has moved the vertex, or
      // the haze distance and the leaf backlight both lag the geometry
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `vGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        ${ground ? 'vGroundUp = normalize(mat3(modelMatrix) * objectNormal).y;\n        vSandW = aSandW;' : ''}
        ${stone ? 'vStoneN = mat3(modelMatrix) * objectNormal;' : ''}
        #include <project_vertex>`,
      )

      shader.uniforms.uCloudDrift = uCloudDrift
      shader.uniforms.uCloudShadow = uCloudShadow
      shader.uniforms.uShapedFill = uShapedFill
      if (roofShade) {
        shader.uniforms.uCanopy = uCanopy
        shader.uniforms.uCanopyXf = uCanopyXf
        shader.uniforms.uCanopySun = uSunDir
        shader.uniforms.uTime = uTime
      }
      if (cards) shader.uniforms.uCardTexels = cardTexels

      shader.fragmentShader = `
        uniform vec3 uHaze;
        uniform float uHazeDensity;
        uniform float uHazeMax;
        varying vec3 vGroundPos;
        ${translucency > 0 ? leafFragmentPars : ''}
        ${translucency > 0 && leafBump > 0 ? leafBumpPars : ''}
        ${noiseFragmentPars}
        ${cloudShadowPars}
        ${shapedFillPars}
        ${ground ? groundWetPars : ''}
        ${ground || stone ? detailPars : ''}
        ${stone ? 'varying vec3 vStoneN;' : ''}
        ${roofShade ? canopyShadePars : ''}
        ${cards ? 'uniform float uCardTexels;' : ''}
        ${ground ? 'varying float vGroundUp;\n        varying float vSandW;' : ''}
        ${shader.fragmentShader}
      `
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${cloudShadowBody}${roofShade ? canopyShadeBody : ''}`)
        .replace(
          '#include <emissivemap_fragment>',
          // The fill lifts shade evenly, which on a textured surface washes out
          // exactly the bark fissures and leaf edges the texture is there for.
          // Let the texel carry through it (its mean is about 0.55 linear).
          `#include <emissivemap_fragment>\n#ifdef USE_MAP\ntotalEmissiveRadiance *= sampledDiffuseColor.rgb * 1.8;\n#endif\n${shapedFillBody}`,
        )

      if (ground || stone) shader.uniforms.uDetail = uDetail
      if (stone) {
        // The fill would light the pits as brightly as the crowns between
        // them, so it takes the same grain
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <color_fragment>', `#include <color_fragment>\n${stoneColorBody}`)
          .replace(
            '#include <normal_fragment_begin>',
            `#include <normal_fragment_begin>\nnormal = gDetailBump(normal, -vViewPosition, gDetailH);`,
          )
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance *= gDetailTone;`)
      }

      if (ground) {
        shader.uniforms.uTide = uTide
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <color_fragment>', `#include <color_fragment>\n${groundColorBody}`)
          .replace(
            '#include <normal_fragment_begin>',
            `#include <normal_fragment_begin>\n${groundNormalBody}`,
          )
          .replace(
            '#include <metalnessmap_fragment>',
            `#include <metalnessmap_fragment>\n${groundWetBody}`,
          )
      }

      if (translucency > 0) {
        shader.uniforms.uSunDir = uSunDir
        shader.uniforms.uSunColor = uSunColor
        shader.uniforms.uTranslucency = uTranslucency
        shader.uniforms.uTransmit = uTransmit
        shader.uniforms.uLeafBump = uLeafBump
        shader.uniforms.uThroughColor = uThrough
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <normal_fragment_begin>',
            `#include <normal_fragment_begin>\n${leafNormalBody}${leafBump > 0 ? leafBumpBody : ''}`,
          )
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>\n${leafFragmentBody}`,
          )
        if (shadowedBleed) {
          // getShadowMask lives in a chunk the standard material doesn't pull
          // in; it has to be declared after the shadow uniforms it reads
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <shadowmap_pars_fragment>',
            '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>',
          )
        }
      }

      if (cards || translucency > 0) {
        // A card's normal is the crown's, so at the rim of a crown it faces
        // across the view and Schlick takes the specular to full: a ring of
        // pale sky-coloured sprays round every tree. A real spray's leaves
        // face every way and never line up for that, so cap the grazing term.
        // Palm fronds and blades seen edge-on against the sky flashed the
        // same pale grey-blue, so every leaf takes the cap.
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <lights_physical_fragment>',
          `#include <lights_physical_fragment>
          material.specularF90 = 0.25;`,
        )
      }
      if (cards) {
        // Alpha-tested leaves thin out with range: each mip level averages
        // leaf with gap, the average drops under the cutoff, and a crown
        // that is a solid spray up close is a sparse net at a hundred metres.
        // Scaling alpha back up by how far down the mip chain the lookup is
        // keeps the coverage the near view had.
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <alphatest_fragment>',
          `{
            vec2 texel = vMapUv * uCardTexels;
            float lod = 0.5 * log2(max(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel))), 1.0));
            diffuseColor.a *= 1.0 + lod * 0.3;
          }
          #include <alphatest_fragment>`,
        )
      }

      shader.fragmentShader = shader.fragmentShader.replace(
        // Sits where the fog would go. The scene renders into a linear buffer
        // and post.ts owns the encode, so this mixes toward a linear horizon.
        '#include <fog_fragment>',
        `float hazeDist = length(vGroundPos - cameraPosition);
        if (smoothstep(0.0, -6.0, vGroundPos.y) * smoothstep(300.0, 470.0, hazeDist) > 0.45) discard;
        float haze = min(1.0 - exp(-pow(hazeDist * uHazeDensity, 2.0)), uHazeMax);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, haze);`,
      )
    }

    return mat
  }

  function update(
    time: number,
    strength: number,
    headingRad: number,
    cloudShadow: number,
    tide = 0,
  ) {
    uTime.value = time
    uWindStrength.value = strength
    uWindDir.value.set(Math.cos(headingRad), Math.sin(headingRad))
    // The deck runs downwind, a good deal faster than the plants below it
    uCloudDrift.value.set(
      Math.cos(headingRad) * time * 0.0042,
      Math.sin(headingRad) * time * 0.0042,
    )
    uCloudShadow.value = cloudShadow
    uTide.value = tide
  }

  function setSun(dir: THREE.Vector3, color: THREE.Color) {
    uSunDir.value.copy(dir)
    uSunColor.value.copy(color)
  }

  function setCanopy(map: THREE.Texture, x: number, z: number, extent: number) {
    uCanopy.value = map
    uCanopyXf.value.set(x - extent, z - extent, 1 / (extent * 2))
  }

  function mesh(geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial) {
    const m = new THREE.Mesh(geometry, material)
    const depth = depthMaterials.get(material)
    if (depth) m.customDepthMaterial = depth
    return m
  }

  function setHazeScale(k: number) {
    uHazeDensity.value = 0.0021 * k
  }

  return { update, setSun, setHazeScale, setCanopy, material, mesh }
}
