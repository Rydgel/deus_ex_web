/** Play's camera from the simulation frame (docs/sim-worker.md): the page
 * draws with it and the simulation side culls and stamps with its own copy,
 * so both run this on the same inputs. */
import * as THREE from 'three';
import { toView } from '../unreal/geometry.mjs';

/** The original's depth range (D3DDrv SetRes 0x1000c40f..0x1000c45b,
 * docs/frame-projection.md): the vertex depth is `_33 * (1 - 1/Z)` with `_33
 * = far / (far - 1)`, so view depth 1 maps to 0 and the far plane to 1; far
 * is 32767 (8192 on a 16-bit viewport). That is a perspective projection with
 * near 1 and far 32767 over the device's [0, 1] depth range. */
export const PLAY_NEAR = 1, PLAY_FAR = 32767;

/** A camera as Play's: 75° default, near 1, far 32767, rotation order YXZ. */
export function createPlayCamera() {
  const camera = new THREE.PerspectiveCamera(75, 1, PLAY_NEAR, PLAY_FAR);
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

/** One Play frame's camera: the view, then the projection: the pass frame's
 * (`projection`, see projectionOf) or, without one, the render rect's aspect
 * and the view's FOV when it draws. With a drawn rect the result depends on
 * the view and the rect (and the frame's projection) alone. */
export function applyPlayFrame(camera, view, renderRect, projection = null) {
  const angles = view ? pointCamera(camera, view) : null;
  camera.userData.projection = null;
  if (view && projection) setFrameProjection(camera, projection);
  else if (view && renderRect?.render && renderRect.width > 0 && renderRect.height > 0)
    setViewAspect(camera, renderRect.width / renderRect.height, view.fov);
  return angles;
}

const wordFloat = (() => { const u = new Uint32Array(1), f = new Float32Array(u.buffer); return word => (u[0] = word, f[0]); })();
/** The projection fields of the pass frame OccludeBsp and the draws read
 * (occlusion frame words: 12 X, 13 Y, 14 FX15, 15 FY15, 20 Proj.Z), as the
 * numbers setFrameProjection takes; null when the words are not a drawn
 * frame. */
export function projectionOf(words) {
  const width = words[12] | 0, height = words[13] | 0;
  if (!(width > 0 && height > 0)) return null;
  return { width, height, fx15: wordFloat(words[14]), fy15: wordFloat(words[15]), projZ: wordFloat(words[20]),
    rprojZ: wordFloat(words[60]), coords: Array.from({ length: 12 }, (_, i) => wordFloat(words[i])) };
}

/** The same from the ComputeRenderSize layout the Rust core keeps for every
 * frame (`fields`: Coords 0..11, FX15 14, FY15 15, Proj.Z 21, RProj.Z 24) and
 * the frame's rectangle size. */
export function projectionOfFields(fields, width, height) {
  return { width, height, fx15: wordFloat(fields[14]), fy15: wordFloat(fields[15]), projZ: wordFloat(fields[21]),
    rprojZ: wordFloat(fields[24]), coords: Array.from({ length: 12 }, (_, i) => wordFloat(fields[i])) };
}

const basis = new THREE.Matrix4();
/** Poses the camera from a frame's Coords (12 binary32: origin, then the X, Y
 * and Z axes in world space): the original's camera orientation comes from
 * ComputeRenderCoords' sine tables, not from the rotator's angles, and
 * differs from an exact rotation by up to 0.3 pixel at 1440 wide
 * (docs/frame-projection.md). Unreal's X axis is the screen's right, Y down
 * and Z forward; three's camera looks down -z with y up, in the world
 * [y, z, -x]. */
export function setCameraCoords(camera, coords) {
  const axis = (k, sign) => { const [x, y, z] = coords.slice(3 + 3 * k, 6 + 3 * k); return new THREE.Vector3(sign * y, sign * z, -sign * x); };
  camera.position.fromArray(toView(coords.slice(0, 3)));
  camera.quaternion.setFromRotationMatrix(basis.makeBasis(axis(0, 1), axis(1, -1), axis(2, -1)));
}

/** The original's projection from the pass frame instead of a FOV:
 * Render.dll projects to `ScreenX = X * RZ + FX15` and
 * `ScreenY = Y * RZ + FY15` with `RZ = Proj.Z / Z`, and D3DDrv submits each
 * vertex at `XB + ScreenX - 0.5` (the 0.5 of D3D's integer pixel centres),
 * so in the rectangle's GL window coordinates a point sits at
 * `FX15 + X * Proj.Z / Z`: the focal length Proj.Z (one value for both axes)
 * and the centre (FX15, FY15), half a pixel and 1.0001/2 beyond the middle
 * of the rectangle. As a symmetric three.js projection over a width x height
 * view that is a vertical FOV of 2 atan(height / (2 Proj.Z)) and a view
 * offset of (FX15 - width/2, FY15 - height/2) pixels. `projection`:
 * {width, height, fx15, fy15, projZ} (projectionOf). */
export function setFrameProjection(camera, projection) {
  const { width, height, fx15, fy15, projZ, coords } = projection;
  camera.userData.projection = projection;
  // The frame's orientation and origin, when it carries them.
  if (coords) setCameraCoords(camera, coords);
  camera.aspect = width / height;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(height / (2 * projZ)));
  camera.userData.fov = undefined;
  camera.setViewOffset(width, height, -(fx15 - width / 2), -(fy15 - height / 2), width, height);
}

/** The original's pixel centres, as a constant where no pass frame is at
 * hand (a session without OccludeBsp, Inspect). Render.dll projects to ScreenX = X·RZ +
 * FX15, with FX15 = (SizeX + 1.0001)·0.5 (ComputeRenderSize, occlude.rs);
 * D3DDrv submits each vertex at ScreenX − 0.5 (DrawGouraudPolygon
 * 0x1000583c/0x1000584f, DrawComplexSurface 0x10003c0e, the 0.5 at
 * 0x1001864c); and D3D rasterizes screen-space vertices with pixel centres
 * on integer coordinates, half a pixel from GL's. Its image therefore sits
 * 0.50005 px right of and below a symmetric GL projection, as measured
 * against the original's frames (docs/visual-acceptance.md). `width` and
 * `height` are the 3D view's size in device pixels. */
export const PIXEL_CENTRE = 0.50005;
export function setPixelCentre(camera, width, height) {
  // A frame projection carries the centre itself (setFrameProjection).
  if (camera.userData.projection) return;
  const view = camera.view;
  if (view?.enabled && view.fullWidth === width && view.fullHeight === height && view.offsetX === -PIXEL_CENTRE) return;
  camera.setViewOffset(width, height, -PIXEL_CENTRE, -PIXEL_CENTRE, width, height);
}
