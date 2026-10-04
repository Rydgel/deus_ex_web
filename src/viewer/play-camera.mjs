/** Play's camera from the simulation frame (docs/sim-worker.md): the page
 * draws with it and the simulation side culls and stamps with its own copy,
 * so both run this on the same inputs. */
import * as THREE from 'three';
import { toView } from '../unreal/geometry.mjs';

/** A camera as Play's: 75° default, near 1, far 65536, rotation order YXZ. */
export function createPlayCamera() {
  const camera = new THREE.PerspectiveCamera(75, 1, 1, 65536);
  camera.rotation.order = 'YXZ';
  return camera;
}

const angle = n => ((n % 65536 + 98304) % 65536 - 32768) * Math.PI / 32768;
/** A rotator as the view's Euler (pitch, -yaw, -roll in 'YXZ', as pointCamera). */
export const rotatorEuler = ([pitchUnits, yawUnits, rollUnits]) =>
  new THREE.Euler(angle(pitchUnits), -angle(yawUnits), -angle(rollUnits), 'YXZ');
/** The horizontal FOV over a view's width, as the vertical FOV three takes. */
export const verticalFov = (horizontal, aspect) =>
  THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(horizontal / 2)) / aspect));

/** Points the camera along a PlayerCalcView result: its location, its
 * rotation (pitch, -yaw, -roll in 'YXZ') and its horizontal FOV over the
 * camera's current aspect. Returns the yaw and pitch the page keeps for its
 * free camera. */
export function pointCamera(camera, view) {
  camera.position.fromArray(toView(view.location));
  const pitch = angle(view.rotation[0]), yaw = -angle(view.rotation[1]);
  camera.rotation.set(pitch, yaw, -angle(view.rotation[2]));
  camera.fov = verticalFov(view.fov, camera.aspect);
  camera.updateProjectionMatrix();
  return { pitch, yaw };
}

/** The original renders the 3D view into the root window's render viewport
 * (XRootWindow PreRender, script-root-render-viewport.mjs): the horizontal
 * FOV spans the rect's width, so a letterbox crops vertically about the
 * rect's centre. */
export function setViewAspect(camera, aspect, fov) {
  if (camera.aspect === aspect && camera.userData.fov === fov) return;
  camera.aspect = aspect; camera.userData.fov = fov;
  camera.fov = verticalFov(fov, aspect);
  camera.updateProjectionMatrix();
}

/** One Play frame's camera: the view, then the render rect's aspect when it
 * draws. With a drawn rect the result depends on the view and the rect
 * alone. */
export function applyPlayFrame(camera, view, renderRect) {
  const angles = view ? pointCamera(camera, view) : null;
  if (view && renderRect?.render && renderRect.width > 0 && renderRect.height > 0)
    setViewAspect(camera, renderRect.width / renderRect.height, view.fov);
  return angles;
}
