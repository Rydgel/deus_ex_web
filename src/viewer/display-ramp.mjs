import * as THREE from 'three';

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
export function createDisplayRamp() {
  let texture = null;
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
    /** The clear colour whose ramped value is `color` (a THREE.Color). */
    rawClear(color, gamma) {
      const inverse = 1 / gamma;
      return new THREE.Color(color.r ** inverse, color.g ** inverse, color.b ** inverse);
    },
    /** Ramp the default framebuffer in place; the renderer's viewport must
     * cover the whole drawing buffer. */
    apply(renderer, gamma) {
      const width = renderer.domElement.width, height = renderer.domElement.height;
      if (!texture || texture.image.width !== width || texture.image.height !== height) {
        texture?.dispose();
        texture = new THREE.FramebufferTexture(width, height);
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        texture.colorSpace = THREE.NoColorSpace;
        // three leaves the allocation's UNPACK_FLIP_Y in place, which raw
        // typed-array uploads (gpu-mesh.mjs) would inherit.
        texture.flipY = false;
        uniforms.frame.value = texture;
      }
      renderer.setRenderTarget(null);
      renderer.copyFramebufferToTexture(texture);
      uniforms.gamma.value = gamma;
      renderer.render(scene, camera);
    },
    dispose() { texture?.dispose(); geometry.dispose(); material.dispose(); },
  };
}
