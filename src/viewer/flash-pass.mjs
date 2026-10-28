/** The viewport flash: UD3DRenderDevice::EndFlash's full-screen quad (docs/screen-flash.md).
 *
 * One quad over the whole canvas with the colour screen-flash.mjs derives (fog RGB, alpha min(2 * scale.x, 1), as
 * bytes), blended as the device does: source factor ONE, destination factor SRCALPHA, so the frame becomes
 * `fog + frame * alpha`. It draws after the HUD (the PostRenderFlash event that paints the windows precedes EndFlash
 * in UGameEngine::Draw) and before the display ramp, so it is in the frame's raw colour space and the ramp maps the
 * result with the rest. The neutral flash (scale 0.5, fog 0) draws nothing. */
import * as THREE from 'three';
import { endFlash } from '../runtime/screen-flash.mjs';

export function createFlashPass() {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: { flash: { value: new THREE.Vector4() } },
    vertexShader: 'void main(){gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader: 'uniform vec4 flash; void main(){gl_FragColor=flash;}',
    depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide, toneMapped: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
    // The back buffer's alpha stays as it is.
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const device = { index: 0, offset: 4, normalColorOp: 4, normalAlphaOp: 1, z33: 1, z43: 0.5 };
  return {
    /** The pass's scene, for the shader warm-up (shader-warmup.mjs). */
    scene,
    /** Draw the flash of the frame (`{scale, fog}`, the planes Draw hands to Lock); returns whether anything drew. */
    render(renderer, flash) {
      if (!flash) return false;
      const plan = endFlash({ scale: flash.scale, fog: flash.fog, sizeX: renderer.domElement.width, sizeY: renderer.domElement.height, device });
      if (!plan.drawn) return false;
      const { a, r, g, b } = plan.colour;
      material.uniforms.flash.value.set(r / 255, g / 255, b / 255, a / 255);
      renderer.clearDepth();
      renderer.render(scene, camera);
      return true;
    },
    dispose() { mesh.geometry.dispose(); material.dispose(); },
  };
}
