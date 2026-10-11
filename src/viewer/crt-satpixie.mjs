import * as THREE from 'three';
import accumulateSource from './shaders/satpixie/accumulate.mjs';
import horizontalSource from './shaders/satpixie/blur_horiz.mjs';
import verticalSource from './shaders/satpixie/blur_vert.mjs';
import finalSource from './shaders/satpixie/satpixie-crt.mjs';

// Vulkan GLSL -> WebGL2 binding/stage syntax only. The four upstream pass
// bodies, including the PassFeedback1 recurrence, remain intact.
function fragment(source) {
  const [header] = source.split('#pragma stage vertex');
  const body = source.split('#pragma stage fragment')[1];
  return (header + body)
    .replace(/^#version.*$/gm, '')
    .replace(/layout\(push_constant\) uniform Push\s*\{([\s\S]*?)\}\s*params;/, 'struct Push {$1}; uniform Push params;')
    .replace(/layout\(std140[^)]*\) uniform UBO\s*\{[\s\S]*?\}\s*global;/, '')
    .replace(/layout\([^)]*\)\s*/g, '')
    .replace(/^#pragma.*$/gm, '')
    .replace('mod(params.FrameCount, 640)', 'mod(float(params.FrameCount), 640.0)')
    .replace(/vec2 blur = ([^;]+);/, '#define blur ($1)');
}
export function createSatpixie(geometry) {
  const target = () => new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false,
  });
  const accumulation = target(), horizontal = [target(), target()], vertical = target();
  let history = 0, frame = 0, dirty = true;
  const params = {
    SourceSize: new THREE.Vector4(), OriginalSize: new THREE.Vector4(), OutputSize: new THREE.Vector4(), FrameCount: 0,
    acc_modulate: 0.65, blur_x: 0, blur_y: 0, natural_vision: 1, gamma: 2.3,
    ghosting_on: 0, chroma_on: 1, chroma_strength: 0.7,
    vignette_on: 1, vignette_aspect: 0, wiggle_toggle: 0, scanroll: 1,
    // Preserve the game image's pointer coordinates and full HUD.
    overscan_crop: 0, ShadowMaskMode: 0,
  };
  const uniforms = {
    params: { value: params }, Source: { value: null }, PassFeedback1: { value: null },
    accum1: { value: accumulation.texture }, blur2: { value: vertical.texture },
  };
  const materials = [accumulateSource, horizontalSource, verticalSource, finalSource].map(source => new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms, depthTest: false, depthWrite: false,
    vertexShader: 'out vec2 vTexCoord; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); vTexCoord = position.xy * 0.5 + 0.5; }',
    fragmentShader: fragment(source),
  }));
  const scene = new THREE.Scene(), camera = new THREE.Camera(), mesh = new THREE.Mesh(geometry, materials[0]);
  mesh.frustumCulled = false; scene.add(mesh); scene.matrixAutoUpdate = false;
  const clear = new THREE.Color();
  const size = (uniform, w, h) => uniform.set(w, h, 1 / w, 1 / h);
  return {
    reset() { dirty = true; },
    apply(renderer, texture, w, h, width, height) {
      const aw = w * 2, ah = h * 2; // satpixie-crt.slangp: accumulate at source x2.
      if (accumulation.width !== aw || accumulation.height !== ah) dirty = true;
      for (const target of [accumulation, ...horizontal, vertical]) target.setSize(aw, ah);
      if (dirty) {
        renderer.getClearColor(clear); const alpha = renderer.getClearAlpha();
        renderer.setClearColor(0, 0); renderer.setRenderTarget(horizontal[history]); renderer.clear();
        renderer.setClearColor(clear, alpha); frame = 0; dirty = false;
      }
      params.FrameCount = frame++; size(params.OriginalSize, w, h);
      const draw = (index, input, iw, ih, output, ow, oh) => {
        uniforms.Source.value = input; size(params.SourceSize, iw, ih); size(params.OutputSize, ow, oh);
        mesh.material = materials[index]; renderer.setRenderTarget(output); renderer.render(scene, camera);
      };
      uniforms.PassFeedback1.value = horizontal[history].texture;
      draw(0, texture, w, h, accumulation, aw, ah);
      const next = 1 - history;
      draw(1, accumulation.texture, aw, ah, horizontal[next], aw, ah);
      draw(2, horizontal[next].texture, aw, ah, vertical, aw, ah);
      draw(3, vertical.texture, aw, ah, null, width, height);
      history = next;
    },
    dispose() { for (const target of [accumulation, ...horizontal, vertical]) target.dispose(); for (const material of materials) material.dispose(); },
  };
}
