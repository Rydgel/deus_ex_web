/** SaveCurrentLevel's PaintProgress frame on the page (docs/loading-frame.md "Saving"): the frame the page drew last, again, under the
 * flash PaintProgress swaps in and the console's SAVING.
 *
 * The original's PaintProgress is a whole UGameEngine::Draw of the level as it stands when the save starts. A save starts between frames
 * (a key's exec runs from the window messages Launch's main loop dispatches after Engine->Tick, which drew the frame) or in a tick that has
 * moved nothing since the last frame (the Save Game screen's paused level), so that Draw is the last frame's world and HUD, with
 * PaintProgress's flash in place of the frame's own. The page keeps those raw colours: the display ramp's copy of the drawing buffer
 * (display-ramp.mjs `rawFrame`) when the frame drew no flash, or the copy `keepBeforeFlash` makes just before a flash draws (EndFlash
 * follows the HUD). `restore` draws them back into the drawing buffer, texel for texel. */
import * as THREE from 'three';

export function createProgressFrame() {
  let beforeFlash = null, kept = false;
  const uniforms = { frame: { value: null } };
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms, depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D frame;
      layout(location = 0) out highp vec4 raw;
      void main() { raw = vec4(texelFetch(frame, ivec2(gl_FragCoord.xy), 0).rgb, 1.0); }`,
  });
  // One triangle over the whole viewport.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(mesh); scene.matrixAutoUpdate = false;
  return {
    /** The copy pass's scene, for the shader warm-up. */
    scene,
    /** A frame of the simulation starts drawing: its flash has not drawn yet. */
    beginFrame() { kept = false; },
    /** The frame's flash is about to draw (flash-pass.mjs `before`): the drawing buffer, its world and HUD, is kept as it stands. */
    keepBeforeFlash(renderer) {
      const width = renderer.domElement.width, height = renderer.domElement.height;
      if (!beforeFlash || beforeFlash.image.width !== width || beforeFlash.image.height !== height) {
        beforeFlash?.dispose();
        beforeFlash = new THREE.FramebufferTexture(width, height);
        beforeFlash.minFilter = beforeFlash.magFilter = THREE.NearestFilter;
        beforeFlash.colorSpace = THREE.NoColorSpace;
        beforeFlash.flipY = false;
      }
      renderer.setRenderTarget(null);
      renderer.copyFramebufferToTexture(beforeFlash);
      kept = true;
    },
    /** The last frame's world and HUD, before its flash, drawn into the whole drawing buffer from `rawFrame` (the ramp's copy) or the copy
     * kept before its flash. False when there is none of the drawing buffer's size. */
    restore(renderer, rawFrame) {
      const source = kept ? beforeFlash : rawFrame, width = renderer.domElement.width, height = renderer.domElement.height;
      if (!source || source.image.width !== width || source.image.height !== height) return false;
      uniforms.frame.value = source;
      const pr = renderer.getPixelRatio(), full = [0, 0, width / pr, height / pr];
      renderer.setRenderTarget(null);
      renderer.setViewport(...full); renderer.setScissor(...full); renderer.setScissorTest(false);
      renderer.render(scene, camera);
      return true;
    },
    dispose() { beforeFlash?.dispose(); geometry.dispose(); material.dispose(); },
  };
}
