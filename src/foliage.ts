import * as THREE from 'three'

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
  update: (time: number, strength: number, headingRad: number, cloudShadow: number) => void
  /** The key light the leaf backlight reads from. */
  setSun: (dir: THREE.Vector3, color: THREE.Color) => void
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

  const colors = new Float32Array(count * 3)
  const wind = new Float32Array(count)
  const phase = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    const y = pos.getY(i)
    // Where this vertex sits on the whole plant, and where it sits on its own
    // piece. A palm needs both: the crown travels with the trunk's lean, and
    // each frond flutters about its own base on top of that.
    const up = THREE.MathUtils.clamp(y / height, 0, 1)
    const local = (y - low) / span
    wind[i] = up * up * bake.sway + (bake.hang ? 1 - local : local) * flutter
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
  return geo
}

/**
 * A per-plant colour multiplier — deterministic, because a plant's colour has
 * to survive a reload or the island flickers between sessions.
 */
export function plantTint(seed: number, spread = 1, out = new THREE.Color()) {
  const r = (n: number) => {
    const v = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453
    return v - Math.floor(v)
  }
  // Green things vary far more in value than in hue, and what hue shift there
  // is runs yellow-to-blue rather than around the wheel
  const value = 1 + (r(1) - 0.5) * 0.5 * spread
  const warm = (r(2) - 0.5) * 0.22 * spread
  return out.setRGB(
    THREE.MathUtils.clamp(value * (1 + warm), 0.35, 1.7),
    THREE.MathUtils.clamp(value, 0.35, 1.7),
    THREE.MathUtils.clamp(value * (1 - warm * 1.3), 0.3, 1.7),
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
    float bleed = back + wrap * 0.55;
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
    float shade = smoothstep(0.44, 0.62, deck) * uCloudShadow;
    reflectedLight.directDiffuse *= 1.0 - shade;
    reflectedLight.directSpecular *= 1.0 - shade;
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
    float coarse = gNoise(gp * 0.055);
    vec3 bump = vec3(
      coarse - gNoise(gp * 0.055 + vec2(0.35, 0.0)),
      0.0,
      coarse - gNoise(gp * 0.055 + vec2(0.0, 0.35))
    ) * 0.55;
    float gNear = 1.0 - smoothstep(10.0, 55.0, gDist);
    if (gNear > 0.01) {
      float h0 = gRelief(gp);
      bump += vec3(h0 - gRelief(gp + vec2(0.55, 0.0)), 0.0, h0 - gRelief(gp + vec2(0.0, 0.55)))
        * 1.5 * gNear;
    }
    vec3 nw = normalize((vec4(normal, 0.0) * viewMatrix).xyz + bump);
    normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
  }
`

const groundColorBody = /* glsl */ `
  {
    vec2 gp = vGroundPos.xz;
    // None of these bands fade with distance: the whole point is that a
    // hillside seen from four hundred metres still has patches on it. Only the
    // relief bump above fades, because only the bump aliases.
    float macro = gNoise(gp * 0.0105);
    float mid = gNoise(gp * 0.062);
    float fine = gNoise(gp * 0.31);

    // Value alone barely survives the tone map at these brightnesses, so the
    // patches change hue too: sun-bleached on the exposed shoulders, deep and
    // blue-green where growth collects, bare dirt in between.
    vec3 bleached = diffuseColor.rgb * vec3(1.34, 1.2, 0.74);
    vec3 deep = diffuseColor.rgb * vec3(0.44, 0.74, 0.5);
    vec3 bare = diffuseColor.rgb * vec3(1.12, 1.02, 0.9);

    // Value noise clusters hard around 0.5 — it is an average of averages — so
    // these windows have to straddle the middle. Thresholds anywhere near the
    // ends simply never fire and the whole hillside comes out one colour.
    // Sand takes the value break-up but not the hue: green patches on a beach
    // read as algae. The band only opens above the tide line.
    float green = smoothstep(5.0, 13.0, vGroundPos.y);
    float dry = smoothstep(0.46, 0.66, macro * 0.65 + fine * 0.35) * green;
    float lush = smoothstep(0.46, 0.66, (1.0 - macro) * 0.5 + mid * 0.5) * green;
    vec3 patched = mix(bare, bleached, dry);
    patched = mix(patched, deep, lush);

    diffuseColor.rgb = patched * (0.66 + macro * 0.26 + mid * 0.3 + fine * 0.18);
  }
`

export function createFoliage(haze: THREE.Color): FoliageRig {
  // Shared uniform holders. onBeforeCompile copies the reference, so one write
  // here reaches every material built off this rig.
  const uTime = { value: 0 }
  const uWindDir = { value: new THREE.Vector2(0.82, 0.57) }
  const uWindStrength = { value: 1 }
  const uSunDir = { value: new THREE.Vector3(0, 1, 0) }
  const uSunColor = { value: new THREE.Color(1, 0.95, 0.85) }
  const uHaze = { value: haze }
  const uCloudDrift = { value: new THREE.Vector2() }
  const uCloudShadow = { value: 0.45 }
  const depthMaterials = new WeakMap<THREE.Material, THREE.MeshDepthMaterial>()

  function material(params: FoliageParams) {
    const {
      wind = 0,
      translucency = 0,
      throughColor,
      ground = false,
      shadowedBleed = false,
      ...rest
    } = params
    const mat = new THREE.MeshStandardMaterial({ ...rest, fog: false })
    if (shadowedBleed) mat.defines = { ...mat.defines, SHADOWED_BLEED: '' }
    const uWindScale = { value: wind }
    const uTranslucency = { value: translucency }
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
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
      depth.onBeforeCompile = addWind
      depthMaterials.set(mat, depth)
    }

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uHaze = uHaze
      shader.uniforms.uHazeDensity = { value: 0.0016 }
      shader.uniforms.uHazeMax = { value: 0.88 }

      shader.vertexShader = `varying vec3 vGroundPos;\n${shader.vertexShader}`

      if (wind > 0) addWind(shader)

      // World position has to be read after the wind has moved the vertex, or
      // the haze distance and the leaf backlight both lag the geometry
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `vGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #include <project_vertex>`,
      )

      shader.uniforms.uCloudDrift = uCloudDrift
      shader.uniforms.uCloudShadow = uCloudShadow

      shader.fragmentShader = `
        uniform vec3 uHaze;
        uniform float uHazeDensity;
        uniform float uHazeMax;
        varying vec3 vGroundPos;
        ${translucency > 0 ? leafFragmentPars : ''}
        ${noiseFragmentPars}
        ${cloudShadowPars}
        ${shader.fragmentShader}
      `.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>\n${cloudShadowBody}`,
      )

      if (ground) {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <color_fragment>', `#include <color_fragment>\n${groundColorBody}`)
          .replace(
            '#include <normal_fragment_begin>',
            `#include <normal_fragment_begin>\n${groundNormalBody}`,
          )
      }

      if (translucency > 0) {
        shader.uniforms.uSunDir = uSunDir
        shader.uniforms.uSunColor = uSunColor
        shader.uniforms.uTranslucency = uTranslucency
        shader.uniforms.uThroughColor = uThrough
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <normal_fragment_begin>',
            `#include <normal_fragment_begin>\n${leafNormalBody}`,
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

  function update(time: number, strength: number, headingRad: number, cloudShadow: number) {
    uTime.value = time
    uWindStrength.value = strength
    uWindDir.value.set(Math.cos(headingRad), Math.sin(headingRad))
    // The deck runs downwind, a good deal faster than the plants below it
    uCloudDrift.value.set(
      Math.cos(headingRad) * time * 0.0042,
      Math.sin(headingRad) * time * 0.0042,
    )
    uCloudShadow.value = cloudShadow
  }

  function setSun(dir: THREE.Vector3, color: THREE.Color) {
    uSunDir.value.copy(dir)
    uSunColor.value.copy(color)
  }

  function mesh(geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial) {
    const m = new THREE.Mesh(geometry, material)
    const depth = depthMaterials.get(material)
    if (depth) m.customDepthMaterial = depth
    return m
  }

  return { update, setSun, material, mesh }
}
