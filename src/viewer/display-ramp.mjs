import * as THREE from 'three';
import { createCrtDisplay } from './crt-shader.mjs';
export { CRT_PRESETS, prepareCrtPreset } from './crt-shader.mjs';

/** The original display gamma ramp over the finished frame (D3DDrv
 * 0x2e3e, docs/lighting.md): D3D draws every pass, the HUD included, into
 * an 8-bit framebuffer and SetGammaRamp maps each stored channel x through
 * pow(x/255, 1/(2.5*Brightness)) at scanout. Play draws raw colours into
 * the canvas the same way; this pass copies the finished drawing buffer to
 * a texture and draws it back through the ramp, one fragment per pixel.
 *
 * Host choice, noted: the ramp's 16-bit entries reach an 8-bit canvas here
 * as round(255 * pow(x/255, g)); how a display reduced them is not
 * modelled. */
/** The ramp exponent D3DDrv's UD3DRenderDevice::Flush 0x10002e32 builds from Client->Brightness
 * (UClient +0x6c, a float32): `fld Brightness; fmul 2.5f (0x10018434); fstp dword`, then
 * `1.0f / that` as the exponent of appPow. Brightness 0 divides by zero (the ramp becomes black
 * below full scale); the shader gets the largest float then. */
export function brightnessGamma(brightness) {
  const divisor = Math.fround(Math.fround(brightness) * 2.5);
  return divisor > 0 ? Math.min(1 / divisor, 3.4028234663852886e38) : 3.4028234663852886e38;
}

/** A FramebufferTexture of the drawing buffer's size (`current` when it already is). */
function sized(current, width, height) {
  if (current && current.image.width === width && current.image.height === height) return current;
  current?.dispose();
  const texture = new THREE.FramebufferTexture(width, height);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.NoColorSpace;
  // three leaves the allocation's UNPACK_FLIP_Y in place, which raw
  // typed-array uploads (gpu-mesh.mjs) would inherit.
  texture.flipY = false;
  return texture;
}

export function createDisplayRamp() {
  let texture = null, progressTexture = null;
  let crtDisplay = null;
  const savedScissor = new THREE.Vector4();
  const uniforms = { frame: { value: null }, gamma: { value: 1 } };
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms, depthTest: false, depthWrite: false,
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D frame; uniform float gamma;
      layout(location = 0) out highp vec4 ramped;
      void main() {
        vec3 raw = texelFetch(frame, ivec2(gl_FragCoord.xy), 0).rgb;
        ramped = vec4(pow(raw, vec3(gamma)), 1.0);
      }`,
  });
  // One triangle over the whole viewport.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(mesh); scene.matrixAutoUpdate = false;
  return {
    /** The ramp's scene, for the shader warm-up (shader-warmup.mjs). */
    scene,
    reset() { crtDisplay?.reset(); },
    /** The last frame's raw colours (the drawing buffer before the ramp, as `apply` copied it), or null before the first. */
    get rawFrame() { return texture; },
    /** The clear colour whose ramped value is `color` (a THREE.Color). */
    rawClear(color, gamma) {
      const inverse = 1 / gamma;
      return new THREE.Color(color.r ** inverse, color.g ** inverse, color.b ** inverse);
    },
    /** Ramp the default framebuffer in place; the renderer's viewport must
     * cover the whole drawing buffer. */
    apply(renderer, gamma, crt = false, preset = 'aperture', compare = false, { progress = false } = {}) {
      const width = renderer.domElement.width, height = renderer.domElement.height;
      // A PaintProgress frame drawn over the last frame (main.mjs drawProgressFrame) goes through a copy of its own: `rawFrame` stays the
      // last frame's, which a second one draws again.
      const copy = progress ? (progressTexture = sized(progressTexture, width, height)) : (texture = sized(texture, width, height));
      uniforms.frame.value = copy;
      renderer.setRenderTarget(null);
      renderer.copyFramebufferToTexture(copy);
      uniforms.gamma.value = gamma;
      if (crt) {
        (crtDisplay ??= createCrtDisplay(geometry)).apply(renderer, copy, gamma, preset);
        if (compare) {
          // Same original frame, gamma and full-image coordinates on both
          // sides. Scissor only the final original pass; never recopy CRT.
          renderer.getScissor(savedScissor);
          const scissorTest = renderer.getScissorTest(), pr = renderer.getPixelRatio();
          renderer.setScissor(0, 0, Math.floor(width / 2) / pr, height / pr);
          renderer.setScissorTest(true);
          try { renderer.render(scene, camera); }
          finally { renderer.setScissor(savedScissor); renderer.setScissorTest(scissorTest); }
        }
      } else { crtDisplay?.reset(); renderer.render(scene, camera); }
    },
    dispose() { texture?.dispose(); progressTexture?.dispose(); geometry.dispose(); material.dispose(); crtDisplay?.dispose(); },
  };
}
