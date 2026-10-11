import * as THREE from 'three';
import apertureSource from './shaders/crt-aperture.mjs';
import easymodeSource from './shaders/crt-easymode.mjs';
import lottesSource from './shaders/crt-lottes.mjs';
import { createSatpixie } from './crt-satpixie.mjs';

let royale, royaleTextures;
export async function prepareCrtPreset(id) {
  if (id !== 'royale') return;
  royale ??= await import('./crt-royale.mjs');
  royaleTextures = await royale.prepareRoyale();
}

export const CRT_PRESETS = {
  aperture: { name: 'CRT-Aperture', label: 'Aperture · soft glow', source: apertureSource, coords: 2, parameters: {
    SHARPNESS_IMAGE: 1, SHARPNESS_EDGES: 3,
    GLOW_WIDTH: 0.5, GLOW_HEIGHT: 0.5, GLOW_HALATION: 0.1, GLOW_DIFFUSION: 0.05,
    MASK_COLORS: 2, MASK_STRENGTH: 0.12, MASK_SIZE: 1,
    SCANLINE_SIZE_MIN: 1.1, SCANLINE_SIZE_MAX: 1.5, SCANLINE_SHAPE: 2.5, SCANLINE_OFFSET: 0.5,
    GAMMA_INPUT: 2.4, GAMMA_OUTPUT: 2.4, BRIGHTNESS: 1.9,
  } },
  easymode: { name: 'CRT-EasyMode', label: 'EasyMode · crisp', source: easymodeSource, coords: 4, parameters: {
    SHARPNESS_H: 0.7, SHARPNESS_V: 1,
    MASK_STRENGTH: 0.16, MASK_DOT_WIDTH: 1, MASK_DOT_HEIGHT: 1, MASK_STAGGER: 0, MASK_SIZE: 1,
    SCANLINE_STRENGTH: 0.65, SCANLINE_BEAM_WIDTH_MIN: 1.5, SCANLINE_BEAM_WIDTH_MAX: 1.5,
    SCANLINE_BRIGHT_MIN: 0.35, SCANLINE_BRIGHT_MAX: 0.65, SCANLINE_CUTOFF: 1000,
    GAMMA_INPUT: 2.2, GAMMA_OUTPUT: 2.2, BRIGHT_BOOST: 1.12, DILATION: 1,
  } },
  lottes: { name: 'CRT-Lottes', label: 'Lottes · arcade', source: lottesSource, coords: 4, parameters: {
    hardScan: -6, hardPix: -3, warpX: 0, warpY: 0,
    maskDark: 0.8, maskLight: 1.4, scaleInLinearGamma: 1, shadowMask: 3,
    brightBoost: 1, hardBloomPix: -1.5, hardBloomScan: -2, bloomAmount: 0.1, shape: 2,
  } },
  satpixie: { name: 'SatPixie', label: 'SatPixie · natural' },
  royale: { name: 'CRT-Royale', label: 'Royale · detailed' },
};

// Host adapter for the unmodified upstream CRT shaders. The game
// still renders at its chosen resolution. Only this optional display image
// is reduced, in linear light after the original gamma ramp, for the CRT's
// beam reconstruction. See docs/crt-display.md and shaders/README.md.
export function createCrtDisplay(geometry) {
  let satpixie, royaleDisplay, linearSource, lastPreset;
  const source = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false,
  });
  source.texture.colorSpace = THREE.NoColorSpace;
  source.texture.flipY = false;
  const prepare = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
    uniforms: { frame: { value: null }, gamma: { value: 1 }, sourceSize: { value: new THREE.Vector2() }, scale: { value: 1 } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D frame;
      uniform float gamma;
      uniform vec2 sourceSize;
      uniform int scale;
      layout(location = 0) out highp vec4 prepared;
      void main() {
        ivec2 size = textureSize(frame, 0);
        vec2 center = gl_FragCoord.xy * vec2(size) / sourceSize;
        ivec2 start = ivec2(floor(center - float(scale) * 0.5));
        vec3 light = vec3(0.0);
        for (int y = 0; y < 4; y++) {
          if (y >= scale) break;
          for (int x = 0; x < 4; x++) {
            if (x >= scale) break;
            vec3 raw = texelFetch(frame, clamp(start + ivec2(x, y), ivec2(0), size - 1), 0).rgb;
            light += pow(raw, vec3(min(gamma, 1.0e30) * 2.4));
          }
        }
        prepared = vec4(pow(light / float(scale * scale), vec3(1.0 / 2.4)), 1.0);
      }`,
  });
  const materials = new Map();
  function materialFor(id) {
    if (!materials.has(id)) {
      const preset = CRT_PRESETS[id];
      const uniforms = Object.fromEntries(Object.entries({
        Texture: source.texture,
        TextureSize: new THREE.Vector2(), InputSize: new THREE.Vector2(), OutputSize: new THREE.Vector2(),
        ...preset.parameters,
      }).map(([key, value]) => [key, { value }]));
      materials.set(id, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
        defines: { FRAGMENT: 1, PARAMETER_UNIFORM: 1 }, uniforms,
        vertexShader: `out vec${preset.coords} TEX0;
          void main() { gl_Position = vec4(position.xy, 0.0, 1.0);
            TEX0 = ${preset.coords === 2 ? 'position.xy * 0.5 + 0.5' : 'vec4(position.xy * 0.5 + 0.5, 0.0, 1.0)'}; }`,
        fragmentShader: preset.source,
      }));
    }
    return materials.get(id);
  }
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mesh = new THREE.Mesh(geometry, prepare);
  mesh.frustumCulled = false; scene.add(mesh); scene.matrixAutoUpdate = false;
  return {
    apply(renderer, texture, gamma, preset = 'aperture') {
      if (!Object.hasOwn(CRT_PRESETS, preset)) throw new Error(`Unknown CRT shader: ${preset}`);
      if (preset !== lastPreset) satpixie?.reset();
      lastPreset = preset;
      const width = texture.image.width, height = texture.image.height;
      // Integer scaling keeps the reconstructed raster stable and avoids
      // moire. At typical desktop sizes this is a 400-600-line CRT image.
      const scale = Math.max(1, Math.min(4, Math.floor(height / 400)));
      const w = Math.max(1, Math.floor(width / scale)), h = Math.max(1, Math.floor(height / scale));
      if (preset === 'satpixie' && !linearSource) {
        linearSource = source.clone();
        linearSource.texture.minFilter = linearSource.texture.magFilter = THREE.LinearFilter;
      }
      const preparedSource = preset === 'satpixie' ? linearSource : source;
      preparedSource.setSize(w, h);
      prepare.uniforms.frame.value = texture; prepare.uniforms.gamma.value = gamma;
      prepare.uniforms.sourceSize.value.set(w, h); prepare.uniforms.scale.value = scale;
      mesh.material = prepare;
      renderer.setRenderTarget(preparedSource); renderer.render(scene, camera);
      if (preset === 'satpixie') {
        (satpixie ??= createSatpixie(geometry)).apply(renderer, preparedSource.texture, w, h, width, height);
        return;
      }
      if (preset === 'royale') {
        if (!royaleTextures) throw new Error('CRT-Royale has not finished loading');
        (royaleDisplay ??= royale.createRoyale(geometry, royaleTextures)).apply(renderer, preparedSource.texture, w, h, width, height);
        return;
      }
      const material = materialFor(preset), uniforms = material.uniforms;
      uniforms.TextureSize.value.set(w, h); uniforms.InputSize.value.set(w, h);
      uniforms.OutputSize.value.set(width, height);
      // At 1:1 there is no room between scanlines. Use a broad, uniform
      // beam instead of darkening the entire image with an unresolved mask.
      if (preset === 'aperture') {
        uniforms.SCANLINE_SIZE_MIN.value = scale === 1 ? 1.5 : 1.1;
        uniforms.BRIGHTNESS.value = scale === 1 ? 1.5 : 1.9;
      }
      mesh.material = material;
      renderer.setRenderTarget(null); renderer.render(scene, camera);
    },
    reset() { satpixie?.reset(); },
    dispose() {
      source.dispose(); linearSource?.dispose(); prepare.dispose(); satpixie?.dispose(); royaleDisplay?.dispose();
      for (const material of materials.values()) material.dispose();
    },
  };
}
