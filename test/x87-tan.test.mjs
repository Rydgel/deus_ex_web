import test from 'node:test';
import assert from 'node:assert/strict';
import {x87TanCandidates} from '../src/runtime/x87-tan.mjs';
import {buildWindowSceneFrame, sceneFrameMeasuredFovs} from '../src/runtime/script-window-scene-frame.mjs';

// The appTan qwords measured on real x87 FPTAN for the scene frame's admitted
// FOVs (script-window-scene-frame.mjs TANGENTS); the full hardware comparison
// is scripts/validate-x87-tan-hardware.mjs.
const io = new DataView(new ArrayBuffer(8));
const hex = value => { io.setFloat64(0, value, true); return io.getBigUint64(0, true).toString(16).padStart(16, '0'); };
const MEASURED = {1: '3f81df645e10066f', 30: '3fd126145e9ecd56', 60: '3fe279a74590331c', 75: '3fe88df153d6a676',
  90: '3fefffffffffffff', 120: '3ffbb67ae8584ca8', 170: '4026dc2fd0bfdbe5'};

test('the tangent model gives the measured appTan qwords', () => {
  assert.deepEqual(sceneFrameMeasuredFovs.map(String), Object.keys(MEASURED));
  for (const [fov, bits] of Object.entries(MEASURED)) {
    // FMUL keeps the exact 61-bit product; its double store is this correctly rounded product.
    const x = Math.fround(Number(fov)) * 0.008726646259971648;
    const candidates = x87TanCandidates(x);
    assert.ok(candidates.map(hex).includes(bits), `FOV ${fov}: ${candidates.map(hex)} vs ${bits}`);
  }
});

test('a non-measured FOV builds a frame', () => {
  const frame = buildWindowSceneFrame({location: [0, 0, 0], rotation: [0, 0, 0], width: 1440, height: 960, fov: 74.99874114990234});
  assert.ok(frame.projectionZ > 0);
});
