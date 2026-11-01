import * as THREE from 'three'
import { rng, toTexture } from './leaftex'

/**
 * Ship's planking, painted once at load: one tile is eight strakes high and
 * four metres long. Every strake has its own tone, two butt joints at its own
 * offsets, long grain, caulked seams, and a pair of trenails either side of
 * each joint. Comes back as a colour map and a height map for the bump.
 *
 * The hull's uv puts one strake per row of quads, so the seams in the texture
 * land exactly on the strake edges in the mesh — which is where the torn
 * planks end.
 */

export const PLANK_TILE_LENGTH = 4
export const PLANKS_PER_TILE = 8

const S = 512
const ROW = S / PLANKS_PER_TILE

function valueNoise(r: () => number, cellsX: number, cellsY: number) {
  const g = new Float32Array(cellsX * cellsY)
  for (let i = 0; i < g.length; i++) g[i] = r()
  return (x: number, y: number) => {
    const fx = x * cellsX
    const fy = y * cellsY
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const tx = fx - ix
    const ty = fy - iy
    const ux = tx * tx * (3 - 2 * tx)
    const uy = ty * ty * (3 - 2 * ty)
    const at = (a: number, b: number) => g[(((b % cellsY) + cellsY) % cellsY) * cellsX + (((a % cellsX) + cellsX) % cellsX)]
    const a = at(ix, iy)
    const b = at(ix + 1, iy)
    const c = at(ix, iy + 1)
    const d = at(ix + 1, iy + 1)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
  }
}

let cache: { map: THREE.DataTexture; bump: THREE.DataTexture } | null = null

export function plankTextures() {
  if (cache) return cache
  const r = rng(733)
  // Long streaks: coarse along the plank, fine across it
  const grain = valueNoise(r, 6, 160)
  const figure = valueNoise(r, 3, 24)
  const blotch = valueNoise(r, 8, 8)
  const strakes = Array.from({ length: PLANKS_PER_TILE }, () => ({
    joint: Math.floor(r() * S),
    tones: [0.78 + r() * 0.34, 0.78 + r() * 0.34],
    warm: (r() - 0.5) * 0.12,
  }))

  const colour = new Uint8ClampedArray(S * S * 4)
  const height = new Uint8ClampedArray(S * S * 4)
  for (let y = 0; y < S; y++) {
    const k = Math.floor(y / ROW)
    const py = y - k * ROW
    const st = strakes[k]
    for (let x = 0; x < S; x++) {
      // Which board along the strake, and how far from the nearest butt
      const along = (x - st.joint + S) % S
      const board = along < S / 2 ? 0 : 1
      const toJoint = Math.min(along % (S / 2), S / 2 - (along % (S / 2)))
      const u = x / S
      const v = y / S
      const g = grain(u, v + board * 0.37)
      const f = figure(u + board * 0.5, v)
      let t = st.tones[board] * (0.82 + g * 0.3 + (f - 0.5) * 0.18)
      t *= 0.9 + blotch(u, v) * 0.2
      let h = 0.6 + (g - 0.5) * 0.25

      // Caulked seams between strakes, and the worn edge either side
      const edge = Math.min(py, ROW - 1 - py)
      if (edge < 1.5) {
        t *= 0.32
        h = 0.05
      } else if (edge < 4) {
        t *= 0.88
        h -= 0.12
      }
      // Butt joints
      if (toJoint < 1.2) {
        t *= 0.4
        h = 0.18
      } else if (toJoint < 3) {
        t *= 0.9
      }
      // Trenails, two each side of the joint
      for (const ny of [ROW * 0.27, ROW * 0.73]) {
        const d = Math.hypot(toJoint - 7, py - ny)
        if (d < 2.4) {
          t *= 0.55
          h = 0.4
        }
      }

      const i = (y * S + x) * 4
      // Waterlogged oak: grey-brown, a touch warm
      colour[i] = Math.min(255, 104 * t * (1 + st.warm))
      colour[i + 1] = Math.min(255, 90 * t)
      colour[i + 2] = Math.min(255, 72 * t * (1 - st.warm))
      colour[i + 3] = 255
      const hv = Math.max(0, Math.min(1, h)) * 255
      height[i] = hv
      height[i + 1] = hv
      height[i + 2] = hv
      height[i + 3] = 255
    }
  }
  cache = { map: toTexture(colour, S, S, true, true), bump: toTexture(height, S, S, true, false) }
  return cache
}

/**
 * Years on the bottom: a film of algae on every face that looks up, sparse
 * rose crusts on the walls, the wood darkening toward the deep. Fades out above
 * the surface, so the mast and spars that stand in the air stay bare.
 */
export function addGrowth(mat: THREE.MeshStandardMaterial, key: string) {
  const previous = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, renderer) => {
    previous?.call(mat, shader, renderer)
    shader.vertexShader = `varying vec3 vGrowP;\nvarying vec3 vGrowN;\n${shader.vertexShader}`.replace(
      '#include <project_vertex>',
      `vGrowP = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vGrowN = mat3(modelMatrix) * objectNormal;
      #include <project_vertex>`,
    )
    shader.fragmentShader = `varying vec3 vGrowP;
varying vec3 vGrowN;
float growHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float growNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(growHash(i), growHash(i + vec3(1, 0, 0)), f.x), mix(growHash(i + vec3(0, 1, 0)), growHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(growHash(i + vec3(0, 0, 1)), growHash(i + vec3(1, 0, 1)), f.x), mix(growHash(i + vec3(0, 1, 1)), growHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
${shader.fragmentShader}`.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        vec3 gn = normalize(vGrowN) * (gl_FrontFacing ? 1.0 : -1.0);
        float drowned = smoothstep(0.5, -1.5, vGrowP.y);
        float patchA = growNoise(vGrowP * 0.7);
        float patchB = growNoise(vGrowP * 2.3 + 5.1);
        float film = smoothstep(-0.15, 0.75, gn.y) * (0.35 + 0.65 * patchA) * drowned;
        vec3 algae = mix(vec3(0.16, 0.2, 0.08), vec3(0.24, 0.2, 0.1), patchB);
        diffuseColor.rgb = mix(diffuseColor.rgb, algae, film * 0.7);
        float crust = (1.0 - abs(gn.y)) * smoothstep(0.62, 0.8, patchB * 0.6 + patchA * 0.4) * drowned;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.25, 0.28), crust * 0.6);
        diffuseColor.rgb *= mix(1.0, 0.78, drowned * smoothstep(-0.3, -0.9, gn.y));
        // Silt settles in drifts on anything flat enough to hold it
        float silt = smoothstep(0.35, 0.85, gn.y) * smoothstep(0.42, 0.68, growNoise(vGrowP * 0.33 + 2.7)) * drowned;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.33, 0.26), silt * 0.75);
      }`,
    )
  }
  const prevKey = mat.customProgramCacheKey
  mat.customProgramCacheKey = () => `${prevKey.call(mat)}|growth:${key}`
  return mat
}
