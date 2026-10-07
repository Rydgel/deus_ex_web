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

// DrawLodMesh's FOV factor (docs/script-lodmesh-lod.md): the precision-
// control-24 argument and the float FSTP m32 stores, measured on real x87
// (AMD Ryzen 9 8945HS under Wine, control word 0x007f) by
// scripts/validate-x87-tan-hardware.mjs's "lod" mode: FOV bits -> [argument
// qword, tangent float bits].
const LOD_MEASURED = {'42700000': ['3fe0c15240000000', '3f13cd3a'], '42960000': ['3fe4f1a6c0000000', '3f446f8a'],
  '42b40000': ['3fe921fb60000000', '3f800000'], '42f00000': ['3ff0c15240000000', '3fddb3d8'],
  '4295ffd6': ['3fe4f1a0e0000000', '3f446f40']};

test('the LOD tangent model gives the measured precision-control-24 floats', async () => {
  const {lodMeshTanArgument, lodMeshTanFactor, floatBits, bitsFloat} = await import('../src/runtime/lodmesh-lod.mjs');
  for (const [fov, [argument, tangent]] of Object.entries(LOD_MEASURED)) {
    const value = bitsFloat(parseInt(fov, 16));
    assert.equal(hex(lodMeshTanArgument(value)), argument, `FOV ${value}: argument`);
    assert.equal(floatBits(lodMeshTanFactor(value)).toString(16).padStart(8, '0'), tangent, `FOV ${value}: tangent float`);
  }
});
