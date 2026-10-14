/** The page side of the original's vertex projection (docs/frame-projection.md):
 * the shared uniforms of one pass frame and the patch that makes a three.js
 * material project its vertices with Render.dll's and D3DDrv's chain
 * (frame-projection-glsl.mjs) instead of the camera's matrices.
 *
 * The pass sets the frame it draws (`use`) before each renderer.render call:
 * the main frame, each mirror or sky child frame; a pass without a frame (a
 * ViewportWindow's, Inspect, a session without OccludeBsp) leaves the uniforms
 * off and the camera projects as before. Materials share the one uniform
 * set, so three.js uploads it with whichever material binds first. */
import * as THREE from 'three';
import { depthConstants, floatWord } from '../runtime/frame-projection.mjs';
import { frameProjectionGlsl } from './frame-projection-glsl.mjs';

const uniforms = {
  uFpOn: { value: 0 }, uFpZero: { value: 0 },
  uFpOrigin: { value: new THREE.Vector3() }, uFpAxisX: { value: new THREE.Vector3() },
  uFpAxisY: { value: new THREE.Vector3() }, uFpAxisZ: { value: new THREE.Vector3() },
  uFpProj: { value: new THREE.Vector4() }, uFpRect: { value: new THREE.Vector4() }, uFpView: { value: new THREE.Vector4() },
  uFpDepth: { value: new THREE.Vector3(depthConstants(32).zBias, depthConstants(32).zScale, 1) },
};

/** The vertex stage of project_vertex: the camera's projection, replaced by
 * the frame's when the pass has one. A mesh's world position is the matrix
 * world of its group (the identity for static world geometry, so the model
 * points arrive unchanged) in three's axes, [y, z, -x] of Unreal's. */
const projectVertex = camera => `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
if ( uFpOn > 0.5 ) {
${camera ? `	if ( deusHasCamera ) gl_Position = fpClip( deusCamera );
	else ` : '	'}{
		vec3 fpWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
		gl_Position = fpClip( fpView( vec3( -fpWorld.z, fpWorld.x, fpWorld.y ) ) );
	}
}
`;

/** Cache-key suffix of the patched programs. */
export const FRAME_PROJECTION_KEY = 'fp1';

export const frameProjection = {
  uniforms,
  /** ?vertexProjection=off (or deusExViewer.vertexProjection(false)) keeps the
   * camera's projection in every pass; programs still carry the code. */
  enabled: true,
  /** Patches a material's vertex shader (an onBeforeCompile body):
   * world-space `transformed`, the frame's clip position. `floatFloat` false
   * when the shader already carries gpu-mesh-glsl's FLOAT_FLOAT (its barrier
   * uniform is the one in scope); `camera` when begin_vertex left the vertex's
   * camera-space point in `deusCamera` (`deusHasCamera`: the GPU mesh draw). */
  patch(shader, { floatFloat = true, camera = false } = {}) {
    Object.assign(shader.uniforms, uniforms);
    // Before main(): after every declaration the shader carries (the GPU mesh
    // draw's float-float helpers among them). Run it last in onBeforeCompile.
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${frameProjectionGlsl({ floatFloat })}\nvoid main() {`)
      .replace('#include <project_vertex>', projectVertex(camera));
  },
  /** The pass projects with `projection` (play-camera.mjs projectionOf's
   * shape, or sim-session.mjs's child frames: Proj.Z, RProj.Z, FX15, FY15 and
   * the Coords) into `view`, the viewport the pass renders into; `rect` is
   * the frame's rectangle (X, Y, XB, YB), `mirror` its Frame->Mirror. A
   * projection without Coords or RProj.Z (an older snapshot) turns it off. */
  use(projection, rect, view, mirror = 1) {
    if (!this.enabled || !projection?.coords || !(projection.rprojZ > 0)) return this.off();
    const c = projection.coords;
    uniforms.uFpOrigin.value.set(c[0], c[1], c[2]);
    uniforms.uFpAxisX.value.set(c[3], c[4], c[5]);
    uniforms.uFpAxisY.value.set(c[6], c[7], c[8]);
    uniforms.uFpAxisZ.value.set(c[9], c[10], c[11]);
    uniforms.uFpProj.value.set(projection.projZ, projection.rprojZ, projection.fx15, projection.fy15);
    uniforms.uFpRect.value.set(rect.width, rect.height, rect.x, rect.y);
    uniforms.uFpView.value.set(view.width, view.height, view.x, view.y);
    const depth = depthConstants(32);
    uniforms.uFpDepth.value.set(depth.zBias, depth.zScale, mirror < 0 ? -1 : 1);
    uniforms.uFpOn.value = 1;
  },
  off() { uniforms.uFpOn.value = 0; },
  /** The values the next draw uses (validators). */
  state: () => ({ on: uniforms.uFpOn.value, origin: uniforms.uFpOrigin.value.toArray(), axes: [uniforms.uFpAxisX, uniforms.uFpAxisY, uniforms.uFpAxisZ].map(u => u.value.toArray()),
    proj: uniforms.uFpProj.value.toArray(), rect: uniforms.uFpRect.value.toArray(), view: uniforms.uFpView.value.toArray(),
    depth: uniforms.uFpDepth.value.toArray().map(Math.fround).map(floatWord) }),
};
