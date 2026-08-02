import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

/**
 * The frame's last mile: bloom, tone mapping, a filmic grade, and a vignette.
 *
 * The scene renders into a half-float buffer, which means three skips both the
 * tone map and the sRGB encode in the materials — `tonemapping_fragment` and
 * `colorspace_fragment` compile to no-ops whenever the target isn't the canvas.
 * So the buffer holds real HDR: a sun glint off a wave crest is genuinely 12,
 * not clipped to white, and bloom has something to bloom from. Everything
 * downstream of the scene happens exactly once, here.
 *
 * Two consequences worth knowing about. The island's aerial perspective splices
 * itself in after the fog chunk, which used to be downstream of the encode and
 * now isn't, so its horizon colour stays linear. And exposure has to be handed
 * in rather than read off the renderer, since nothing in the scene applies it
 * any more.
 *
 * Bloom is a threshold plus two blurred levels rather than a full pyramid: one
 * tight halo for sun glitter, one wide one for the sky and for firelight at
 * night. Both run at a fraction of the frame, so it stays on for phones too —
 * the glow is most of what makes the water read as bright.
 */

export type Grade = {
  /** Scene stops before the tone map. Mirrors the old renderer exposure. */
  exposure: number
  /** Overall bloom weight. 0 turns the glow off without a rebuild. */
  bloom: number
  /** Tone pushed into the shadows — cool at sea, warmer around a fire. */
  lift: THREE.Color
  /** Tone pushed into the highlights. */
  gain: THREE.Color
  /** S-curve strength around mid grey. */
  contrast: number
  saturation: number
  /** Corner darkening, 0–1. */
  vignette: number
}

export type PostChain = {
  /** Draw `scene` through the chain and onto the canvas. */
  render: (scene: THREE.Scene, camera: THREE.Camera) => void
  setSize: (width: number, height: number, pixelRatio: number) => void
  grade: Grade
  dispose: () => void
}

const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/**
 * Soft-knee bright pass. A hard threshold pops as a highlight crosses it,
 * which reads as flickering on a moving water surface more than anything else
 * in the scene. The clamp is a guard against a single blown sample smearing a
 * square of white across the blur.
 */
const brightFragment = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uKnee;
uniform float uExposure;
varying vec2 vUv;

void main() {
  vec3 c = min(texture2D(tDiffuse, vUv).rgb * uExposure, vec3(48.0));
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float soft = clamp(luma - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 0.0001);
  float weight = max(soft, luma - uThreshold) / max(luma, 0.0001);
  gl_FragColor = vec4(c * weight, 1.0);
}
`

/** Nine-tap Gaussian along one axis, sampled on the half-texel for free lerps. */
const blurFragment = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uDirection;
varying vec2 vUv;

void main() {
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
  vec2 off1 = uDirection * 1.3846153846;
  vec2 off2 = uDirection * 3.2307692308;
  sum += texture2D(tDiffuse, vUv + off1).rgb * 0.3162162162;
  sum += texture2D(tDiffuse, vUv - off1).rgb * 0.3162162162;
  sum += texture2D(tDiffuse, vUv + off2).rgb * 0.0702702703;
  sum += texture2D(tDiffuse, vUv - off2).rgb * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}
`

const compositeFragment = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tBloomNear;
uniform sampler2D tBloomFar;
uniform float uBloom;
uniform float uExposure;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uContrast;
uniform float uSaturation;
uniform float uVignette;
uniform vec2 uResolution;

varying vec2 vUv;

// ACES filmic, the same fit three uses. Inlined because the chunk that would
// normally supply it is compiled out for render targets.
const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);

vec3 acesFilmic(vec3 color) {
  color = ACES_IN * color;
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = ACES_OUT * (a / b);
  return clamp(color, 0.0, 1.0);
}

// Ordered dither, so the sky's long shallow gradient doesn't band once the
// grade has compressed it. Cheaper and steadier than a hash under motion.
float dither(vec2 p) {
  vec2 k = floor(mod(p, 4.0));
  float i = k.y * 4.0 + k.x;
  const float m[16] = float[16](
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0
  );
  float v = 0.0;
  for (int j = 0; j < 16; j++) {
    if (float(j) == i) v = m[j];
  }
  return (v / 16.0 - 0.5) / 255.0;
}

void main() {
  vec3 col = min(texture2D(tDiffuse, vUv).rgb, vec3(64.0)) * uExposure;

  #ifdef USE_BLOOM
    #ifdef USE_WIDE_BLOOM
      vec3 glow = texture2D(tBloomNear, vUv).rgb * 0.62 + texture2D(tBloomFar, vUv).rgb * 0.38;
    #else
      vec3 glow = texture2D(tBloomNear, vUv).rgb;
    #endif
    col += glow * uBloom;
  #endif

  col = acesFilmic(col);

  // Split-tone: lift the shadows toward one hue, the highlights toward another.
  // Pivoted on luma so mid-tone skin and sand don't drift.
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float shadow = 1.0 - smoothstep(0.0, 0.55, luma);
  float highlight = smoothstep(0.35, 1.0, luma);
  col += uLift * shadow * 0.16;
  col *= mix(vec3(1.0), uGain, highlight * 0.55);

  // Gentle S-curve about mid grey — filmic contrast without crushing either end
  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);

  luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);

  vec2 v = (vUv - 0.5) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
  float vig = 1.0 - uVignette * smoothstep(0.32, 0.98, length(v) * 1.1);
  col *= vig;

  col = clamp(col, 0.0, 1.0);
  gl_FragColor = vec4(col, 1.0);

  #include <colorspace_fragment>

  gl_FragColor.rgb += dither(gl_FragCoord.xy);
}
`

export function createPostChain(
  renderer: THREE.WebGLRenderer,
  opts: { lowPower?: boolean } = {},
): PostChain {
  const useBloom = true
  // Phones keep the tight halo and drop the wide one: the second octave is
  // four more passes for a spread you mostly notice on a big screen.
  const useWideBloom = !opts.lowPower

  const grade: Grade = {
    exposure: 1,
    bloom: 0.5,
    lift: new THREE.Color('#0d1c2a'),
    gain: new THREE.Color('#fff2dd'),
    contrast: 0.14,
    saturation: 1.1,
    vignette: 0.3,
  }

  const sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  })
  sceneTarget.texture.colorSpace = THREE.NoColorSpace

  const divisors = new WeakMap<THREE.WebGLRenderTarget, number>()
  const bloomTarget = (divisor: number) => {
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    })
    rt.texture.colorSpace = THREE.NoColorSpace
    divisors.set(rt, divisor)
    return rt
  }

  // Near halo at quarter res, far halo at sixteenth — two octaves is enough
  // spread for a sun on water without a full pyramid's worth of passes.
  const nearA = bloomTarget(4)
  const nearB = bloomTarget(4)
  const farA = bloomTarget(16)
  const farB = bloomTarget(16)

  const brightMat = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      // Has to sit above the sky, not just above white. A daylit sky is 2–5 in
      // scene-linear and covers half the frame; with the threshold under that,
      // the bright pass returns "the sky, slightly dimmer", the blur turns it
      // into one flat sheet of glow, and every tree punches a soft grey hole in
      // it. What looked like a blur artefact around the palms was the sky's
      // own bloom missing behind them.
      uThreshold: { value: 5.5 },
      uKnee: { value: 2.2 },
      uExposure: { value: 1 },
    },
    vertexShader: fullscreenVertex,
    fragmentShader: brightFragment,
    depthTest: false,
    depthWrite: false,
  })

  const blurMat = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uDirection: { value: new THREE.Vector2() },
    },
    vertexShader: fullscreenVertex,
    fragmentShader: blurFragment,
    depthTest: false,
    depthWrite: false,
  })

  const compositeMat = new THREE.ShaderMaterial({
    defines: useWideBloom ? { USE_BLOOM: '', USE_WIDE_BLOOM: '' } : { USE_BLOOM: '' },
    uniforms: {
      tDiffuse: { value: sceneTarget.texture },
      tBloomNear: { value: nearA.texture },
      tBloomFar: { value: farA.texture },
      uBloom: { value: grade.bloom },
      uExposure: { value: grade.exposure },
      uLift: { value: grade.lift },
      uGain: { value: grade.gain },
      uContrast: { value: grade.contrast },
      uSaturation: { value: grade.saturation },
      uVignette: { value: grade.vignette },
      uResolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: fullscreenVertex,
    fragmentShader: compositeFragment,
    depthTest: false,
    depthWrite: false,
  })

  const quad = new FullScreenQuad(compositeMat)

  let bufferWidth = 1
  let bufferHeight = 1

  function setSize(width: number, height: number, pixelRatio: number) {
    bufferWidth = Math.max(1, Math.floor(width * pixelRatio))
    bufferHeight = Math.max(1, Math.floor(height * pixelRatio))
    sceneTarget.setSize(bufferWidth, bufferHeight)
    compositeMat.uniforms.uResolution.value.set(bufferWidth, bufferHeight)
    for (const rt of [nearA, nearB, farA, farB]) {
      const d = divisors.get(rt) ?? 4
      rt.setSize(Math.max(1, Math.floor(bufferWidth / d)), Math.max(1, Math.floor(bufferHeight / d)))
    }
  }

  function blurInto(
    source: THREE.Texture,
    scratch: THREE.WebGLRenderTarget,
    dest: THREE.WebGLRenderTarget,
    radius: number,
  ) {
    blurMat.uniforms.tDiffuse.value = source
    blurMat.uniforms.uDirection.value.set(radius / dest.width, 0)
    quad.material = blurMat
    renderer.setRenderTarget(scratch)
    quad.render(renderer)

    blurMat.uniforms.tDiffuse.value = scratch.texture
    blurMat.uniforms.uDirection.value.set(0, radius / dest.height)
    renderer.setRenderTarget(dest)
    quad.render(renderer)
  }

  function render(scene: THREE.Scene, camera: THREE.Camera) {
    renderer.setRenderTarget(sceneTarget)
    renderer.render(scene, camera)

    if (useBloom && grade.bloom > 0.001) {
      brightMat.uniforms.tDiffuse.value = sceneTarget.texture
      brightMat.uniforms.uExposure.value = grade.exposure
      quad.material = brightMat
      renderer.setRenderTarget(nearB)
      quad.render(renderer)

      // The kernel's taps are placed for a one-texel step. Stretching it out to
      // reach further turns the Gaussian into a box, and every sun glint comes
      // back as a white square — spread has to come from the smaller buffer,
      // not from a wider stride.
      blurInto(nearB.texture, nearA, nearB, 1.0)
      blurInto(nearB.texture, nearA, nearB, 1.0)
      // A third round on anything with the headroom for it. A sun glint is a
      // couple of texels at quarter res, and two Gaussians leave it a rounded
      // square; the shape only stops reading as a sprite after a third.
      if (!opts.lowPower) blurInto(nearB.texture, nearA, nearB, 1.0)
      compositeMat.uniforms.tBloomNear.value = nearB.texture
      if (useWideBloom) {
        // nearB holds the tight halo; farA takes the wide one off it
        blurInto(nearB.texture, farB, farA, 1.0)
        blurInto(farA.texture, farB, farA, 1.0)
        compositeMat.uniforms.tBloomFar.value = farA.texture
      }
    }

    compositeMat.uniforms.uBloom.value = grade.bloom
    compositeMat.uniforms.uExposure.value = grade.exposure
    compositeMat.uniforms.uContrast.value = grade.contrast
    compositeMat.uniforms.uSaturation.value = grade.saturation
    compositeMat.uniforms.uVignette.value = grade.vignette

    quad.material = compositeMat
    renderer.setRenderTarget(null)
    quad.render(renderer)
  }

  function dispose() {
    sceneTarget.dispose()
    for (const rt of [nearA, nearB, farA, farB]) rt.dispose()
    quad.dispose()
  }

  return { render, setSize, grade, dispose }
}
