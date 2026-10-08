import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyPlayFrame, createPlayCamera, PIXEL_CENTRE, projectionOf, setPixelCentre, setViewAspect } from '../src/viewer/play-camera.mjs';

// The pass frame's projection (play-camera.mjs setFrameProjection): in the
// rectangle's GL window coordinates a point sits at FX15 + X * Proj.Z / Z
// from the left and FY15 + Y * Proj.Z / Z from the top (Render.dll's ScreenX
// and ScreenY, D3DDrv's integer pixel centres), with one focal length for
// both axes.
const f32 = Math.fround;
const frame = (width, height, fov) => {
  // ComputeRenderSize's fields as float32 (the FOV's tangent in doubles here).
  const fx15 = f32((width + 1.0001) * 0.5), fy15 = f32((height + 1.0001) * 0.5);
  return { width, height, fx15, fy15, projZ: f32(f32(width * 0.5) / Math.tan(fov * Math.PI / 360)) };
};
const windowOf = (camera, point) => {
  const v = new THREE.Vector4(point[0], point[1], point[2], 1).applyMatrix4(camera.projectionMatrix);
  const { width, height } = camera.userData.projection ?? { width: camera.view.fullWidth, height: camera.view.fullHeight };
  return [(v.x / v.w * 0.5 + 0.5) * width, (0.5 - v.y / v.w * 0.5) * height];
};

test('a frame projection puts points at FX15 + X * Proj.Z / Z, FY15 + Y * Proj.Z / Z', () => {
  for (const [w, h, fov] of [[1440, 960, 75], [1024, 462, 75], [1920, 1080, 90], [801, 601, 120], [640, 240, 60]]) {
    const camera = createPlayCamera(), projection = frame(w, h, fov);
    camera.userData.projection = null;
    applyPlayFrame(camera, { location: [0, 0, 0], rotation: [0, 0, 0], fov }, { render: true, width: w, height: h }, projection);
    camera.rotation.set(0, 0, 0); camera.updateMatrixWorld();
    for (const [x, y, z] of [[0, 0, 100], [37, -12, 250], [-400, 90, 800], [5, 5, 1.5]]) {
      // three's camera space: +x right, +y up, looking down -z; x, y are
      // the frame's X right and Y up here (Y down is -y).
      const [sx, sy] = windowOf(camera, [x, y, -z]);
      assert.ok(Math.abs(sx - (projection.fx15 + x * projection.projZ / z)) < 1e-6 * Math.max(1, Math.abs(sx)), `${w}x${h} x`);
      assert.ok(Math.abs(sy - (projection.fy15 - y * projection.projZ / z)) < 1e-6 * Math.max(1, Math.abs(sy)), `${w}x${h} y`);
    }
  }
});

test('the frame projection agrees with the FOV and the constant centre within a fraction of a pixel at FOV 75', () => {
  for (const [w, h] of [[1440, 960], [1024, 462], [1920, 1080]]) {
    const framed = createPlayCamera(), fov = createPlayCamera(), projection = frame(w, h, 75);
    applyPlayFrame(framed, { location: [0, 0, 0], rotation: [0, 0, 0], fov: 75 }, { render: true, width: w, height: h }, projection);
    applyPlayFrame(fov, { location: [0, 0, 0], rotation: [0, 0, 0], fov: 75 }, { render: true, width: w, height: h });
    setPixelCentre(fov, w, h);
    for (const camera of [framed, fov]) { camera.rotation.set(0, 0, 0); camera.updateMatrixWorld(); }
    let worst = 0;
    for (const [x, y, z] of [[0, 0, 100], [300, -100, 400], [-1000, 400, 900], [50, 50, 20]]) {
      const a = windowOf(framed, [x, y, -z]), b = windowOf(fov, [x, y, -z]);
      worst = Math.max(worst, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    }
    assert.ok(worst < 0.01, `${w}x${h}: worst ${worst} px`);
  }
});

test('projectionOf reads the frame words and a later FOV frame clears the frame projection', () => {
  const words = new Array(64).fill(0), u = new Uint32Array(1), g = new Float32Array(u.buffer);
  const word = value => (g[0] = value, u[0]);
  words[12] = 1440; words[13] = 960; words[14] = word(720.5); words[15] = word(480.5); words[20] = word(1032.5);
  assert.deepEqual(projectionOf(words), { width: 1440, height: 960, fx15: 720.5, fy15: 480.5, projZ: f32(1032.5) });
  assert.equal(projectionOf(new Array(64).fill(0)), null);
  const camera = createPlayCamera();
  applyPlayFrame(camera, { location: [0, 0, 0], rotation: [0, 0, 0], fov: 75 }, { render: true, width: 1440, height: 960 }, projectionOf(words));
  assert.ok(camera.userData.projection);
  applyPlayFrame(camera, { location: [0, 0, 0], rotation: [0, 0, 0], fov: 75 }, { render: true, width: 1440, height: 960 });
  assert.equal(camera.userData.projection, null);
  setPixelCentre(camera, 1440, 960);
  assert.equal(camera.view.offsetX, -PIXEL_CENTRE);
  setViewAspect(camera, 1440 / 960, 75);
  assert.ok(Math.abs(camera.fov - THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(37.5)) / 1.5))) < 1e-9);
});
