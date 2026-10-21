/** The page's last drawn frame, kept for RootWindow.GenerateSnapshot (docs/root-snapshot.md).
 *
 * The original reads the render device's viewport frame back (URenderDevice::ReadPixels) at the moment the script asks, which is
 * the frame the player last saw. The simulation has no frame, so while the player's UIBackground is 1 (Snapshot) the page copies
 * each finished frame (the canvas after the display ramp) into a texture on the GPU, one framebuffer copy a frame, nothing otherwise,
 * and reads the kept frame back only when a snapshot is requested. The pixels come out as ReadPixels' dwords (blue in the low byte,
 * top row first) at the canvas size. Unmeasured: ReadPixels reads a 16-bit DirectDraw surface and maps it through a gamma table
 * (D3DDrv 0x10007610); this frame is 8 bits per channel as displayed. */
import * as THREE from 'three';

export function createFrameKeeper(renderer) {
  let texture = null, width = 0, height = 0, target = null, copy = null;
  return {
    get hasFrame() { return texture !== null; },
    /** Copy the finished frame (call after the last pass of a drawn frame). */
    keep() {
      const w = renderer.domElement.width, h = renderer.domElement.height;
      if (!texture || w !== width || h !== height) {
        texture?.dispose();
        texture = new THREE.FramebufferTexture(w, h);
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        texture.colorSpace = THREE.NoColorSpace;
        texture.flipY = false;
        width = w; height = h;
      }
      renderer.setRenderTarget(null);
      renderer.copyFramebufferToTexture(texture);
    },
    /** Drop the kept frame (the setting is off). */
    reset() { texture?.dispose(); texture = null; target?.dispose(); target = null; },
    /** The kept frame as {width, height, pixels: Uint32Array of BGRA dwords, top row first}, or null before the first kept frame. */
    read() {
      if (!texture) return null;
      if (!copy) {
        const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const material = new THREE.ShaderMaterial({uniforms: {map: {value: null}}, depthTest: false, depthWrite: false, toneMapped: false,
          vertexShader: 'varying vec2 texCoord; void main(){texCoord=uv;gl_Position=vec4(position.xy,0.,1.);}',
          fragmentShader: 'uniform sampler2D map; varying vec2 texCoord; void main(){gl_FragColor=texture2D(map,texCoord);}'});
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
        copy = {scene, camera, material};
      }
      if (!target || target.width !== width || target.height !== height) {
        target?.dispose();
        target = new THREE.WebGLRenderTarget(width, height, {depthBuffer: false, stencilBuffer: false, colorSpace: THREE.NoColorSpace,
          minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter});
      }
      copy.material.uniforms.map.value = texture;
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(copy.scene, copy.camera);
      const bytes = new Uint8Array(width * height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, bytes);
      renderer.setRenderTarget(previous);
      // The read is bottom row first, RGBA; ReadPixels' dword is B | G << 8 | R << 16 | A << 24 with the top row first.
      const pixels = new Uint32Array(width * height);
      for (let y = 0; y < height; y++) {
        let from = (height - 1 - y) * width * 4, to = y * width;
        for (let x = 0; x < width; x++, from += 4, to++)
          pixels[to] = (bytes[from + 2] | (bytes[from + 1] << 8) | (bytes[from] << 16) | (255 << 24)) >>> 0;
      }
      return {width, height, pixels};
    },
  };
}
