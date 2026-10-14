import * as THREE from 'three'

/**
 * Caustics — the net of bright, shifting lines sunlight throws on a sandy
 * seabed. They are what tells your eye the water above you is moving and the
 * sun is out, and they do more for a shallow dive than any amount of fog.
 *
 * Rather than a projected light (a second shadow pass) the pattern is injected
 * into the lit materials of the seabed, the wreck and the island shelf with a
 * small `onBeforeCompile` patch. Everything shares one uniform block, so the
 * whole effect is driven by a single `update` per frame.
 */

const uniforms = {
  uCaustTime: { value: 0 },
  uCaustStrength: { value: 0 },
  uCaustSurface: { value: 0 },
  uCaustAir: { value: 0 },
  uCaustSun: { value: new THREE.Vector3(0, 1, 0) },
}

const VERT_DECL = /* glsl */ `
varying vec3 vCausticWorld;
`

const VERT_BODY = /* glsl */ `
#include <begin_vertex>
vCausticWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`

const FRAG_DECL = /* glsl */ `
uniform float uCaustTime;
uniform float uCaustStrength;
uniform float uCaustSurface;
uniform float uCaustAir;
uniform vec3 uCaustSun;
varying vec3 vCausticWorld;

// Tileable water caustic, after the well-known Shadertoy construction: four
// folded sine passes whose reciprocal lengths pile up into bright filaments.
float causticPattern(vec2 uv, float t) {
  vec2 p = mod(uv * 6.28318530718, 6.28318530718) - 250.0;
  vec2 i = p;
  float c = 1.0;
  const float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
`

const FRAG_BODY = /* glsl */ `
{
  float depthBelow = uCaustSurface - vCausticWorld.y;
  if (uCaustStrength > 0.001 && depthBelow > 0.0) {
    vec3 worldNormal = inverseTransformDirection(normal, viewMatrix);
    // Light lands on upward faces; walls and undersides only catch a little
    float facing = clamp(worldNormal.y * 0.75 + 0.25, 0.0, 1.0);
    // Shift the pattern with depth along the sun's slant so it doesn't read as
    // a flat decal stuck to every surface
    vec2 uv = vCausticWorld.xz * 0.09 + uCaustSun.xz * vCausticWorld.y * 0.06;
    float c = causticPattern(uv, uCaustTime * 0.55);
    // Fades in just under the surface and thins out with depth
    float fade = exp(-depthBelow * 0.085) * smoothstep(0.0, 0.9, depthBelow);
    // Seen from the beach, only ankle-to-waist water shows any of this: the
    // surface has already tinted and hidden anything deeper, and a net of
    // light on the reef twenty metres down would read as a glitch
    fade *= mix(1.0, 1.0 - smoothstep(1.2, 4.2, depthBelow), uCaustAir);
    outgoingLight += diffuseColor.rgb * c * facing * fade * uCaustStrength;
  }
}
#include <opaque_fragment>
`

export function createCaustics(sunDir: THREE.Vector3) {
  uniforms.uCaustSun.value.copy(sunDir)

  /** Patch every lit material under `root` (once each). */
  function apply(root: THREE.Object3D) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial
        if (!std.isMeshStandardMaterial || std.userData.caustics) continue
        // Instanced geometry has no single model matrix to read world position from
        if ((mesh as THREE.InstancedMesh).isInstancedMesh) continue
        std.userData.caustics = true
        const previous = std.onBeforeCompile
        std.onBeforeCompile = (shader, renderer) => {
          previous?.call(std, shader, renderer)
          Object.assign(shader.uniforms, uniforms)
          shader.vertexShader = VERT_DECL + shader.vertexShader.replace('#include <begin_vertex>', VERT_BODY)
          shader.fragmentShader =
            FRAG_DECL + shader.fragmentShader.replace('#include <opaque_fragment>', FRAG_BODY)
        }
        const key = std.customProgramCacheKey
        std.customProgramCacheKey = () => `${key.call(std)}|caustics`
        std.needsUpdate = true
      }
    })
  }

  /** `strength` is 0 at night; the sun does the rest. */
  function update(
    time: number,
    strength: number,
    surfaceY: number,
    sunDir: THREE.Vector3,
    /** Viewed from above the water — limits the pattern to the shallows. */
    air = false,
  ) {
    uniforms.uCaustTime.value = time
    uniforms.uCaustStrength.value = strength
    uniforms.uCaustSurface.value = surfaceY
    uniforms.uCaustSun.value.copy(sunDir)
    uniforms.uCaustAir.value = air ? 1 : 0
  }

  return { apply, update }
}
