import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readPalette, readTexture, decodePixels } from '../src/unreal/textures.mjs';
import { toView, fromView, surfaceUV, buildSurfaceGeometry, cross, sub, dot } from '../src/unreal/geometry.mjs';
import { brushMatrix } from '../src/viewer/transforms.mjs';

test('coordinate reflection preserves units and has a reversible axis mapping', () => {
  assert.deepEqual(toView([1, 2, 3]), [2, 3, -1]);
  assert.deepEqual(fromView(toView([8, -16, 32])), [8, -16, 32]);
  assert.equal(Math.hypot(...toView([3, 4, 12])), 13);
});

const model = {
  points: [[10, 20, 30], [74, 20, 30], [10, 84, 30]],
  vectors: [[0, 0, 1], [2, 0, 0], [0, -1, 0]],
  surfaces: [{ base: 0, normal: 0, textureU: 1, textureV: 2, pan: [-16, 32] }],
};
test('UV conversion includes base, scale, negative pan, and wrapping without clamping', () => {
  assert.deepEqual(surfaceUV(model, model.surfaces[0], [138, 276, 30], 64, 128), [3.75, -1.75]);
});
test('both source windings face the authored normal after reflection; degenerate triangles drop', () => {
  for (const points of [[0, 1, 2], [0, 2, 1]]) {
    const result = buildSurfaceGeometry(model, [{ points }], 0, 64, 128);
    const p = [0, 3, 6].map(i => Array.from(result.positions.slice(i, i + 3)));
    assert.ok(dot(cross(sub(p[1], p[0]), sub(p[2], p[0])), result.normals) > 0);
    for (let i = 0; i < 3; i++) assert.deepEqual(Array.from(result.uvs.slice(i * 2, i * 2 + 2)), surfaceUV(model, model.surfaces[0], fromView(p[i]), 64, 128));
  }
  const degenerate = buildSurfaceGeometry(model, [{ points: [0, 0, 1] }], 0, 64, 128);
  assert.equal(degenerate.degenerate, 1); assert.equal(degenerate.positions.length, 0);
});

const transformed = (point, values) => fromView(new Vector3(...toView(point)).applyMatrix4(brushMatrix(values)).toArray());
const close = (actual, expected) => actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < 1e-6, `${actual} != ${expected}`));
test('brush rotations and scale/pivot order preserve Unreal actor transforms', () => {
  close(transformed([1, 0, 0], { Rotation: [0, 16384, 0] }), [0, 1, 0]);
  close(transformed([1, 0, 0], { Rotation: [16384, 0, 0] }), [0, 0, 1]);
  close(transformed([0, 1, 0], { Rotation: [0, 0, 16384] }), [0, 0, -1]);
  close(transformed([12, 20, 30], { PrePivot: [10, 20, 30], MainScale: { scale: [2, 3, 4] }, Rotation: [0, 16384, 0], PostScale: { scale: [5, 6, 7] }, Location: [100, 200, 300] }), [100, 224, 300]);
  assert.throws(() => brushMatrix({ MainScale: { shearRate: .5 } }), /Sheared/);
});

function assetFor(payload, className, version = 68, serialOffset = 20) {
  const bytes = new Uint8Array(serialOffset + payload.length); bytes.set(payload, serialOffset);
  return { bytes, pkg: { version, names: [{ name: 'None' }], imports: [], exports: [{ name: 'Test', path: 'Test', className, serialOffset, serialSize: payload.length, flags: 0 }] } };
}
function textureFixture(version = 68) {
  const data = [0, 2]; // None, two mips
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); data.push(...b); };
  for (const [width, pixels] of [[2, [0, 1, 1, 0]], [1, [1]]]) {
    if (version >= 63) u32(20 + data.length + 4 + 1 + pixels.length);
    data.push(pixels.length, ...pixels); u32(width); u32(width); data.push(width === 2 ? 1 : 0, width === 2 ? 1 : 0);
  }
  return assetFor(Uint8Array.from(data), 'Texture', version);
}
test('palette serialization keeps RGBA order; P8 surface masking uses index zero only', () => {
  const asset = assetFor(Uint8Array.of(0, 2, 10, 20, 30, 0, 100, 110, 120, 0), 'Palette');
  const palette = readPalette(asset, 1), mip = { width: 2, height: 1, data: Uint8Array.of(0, 1) };
  assert.deepEqual([...decodePixels(mip, 0, palette).data], [10, 20, 30, 255, 100, 110, 120, 255]);
  assert.deepEqual([...decodePixels(mip, 0, palette, true).data], [0, 0, 0, 0, 100, 110, 120, 255]);
  assert.deepEqual([...decodePixels(mip, 0, palette, 'point').data], [10, 20, 30, 0, 100, 110, 120, 255]);
  assert.throws(() => decodePixels(mip, 0, palette.subarray(0, 4)), /out of range/);
  assert.throws(() => decodePixels(mip, 0), /no palette/);
  assert.throws(() => decodePixels({ ...mip, width: 4 }, 0, palette), /size mismatch/);
});
test('old and new texture mips retain dimensions, pixels, and validated absolute offsets', () => {
  for (const version of [61, 68]) {
    const texture = readTexture(textureFixture(version), 1);
    assert.deepEqual(texture.mips.map(m => [m.width, m.height, [...m.data]]), [[2, 2, [0, 1, 1, 0]], [1, 1, [1]]]);
    assert.equal(texture.nativeBytes, 0);
  }
  const bad = textureFixture(); bad.bytes[22]++;
  assert.throws(() => readTexture(bad, 1), /end offset/);
  const badSize = textureFixture(); badSize.bytes[31] = 3;
  assert.throws(() => readTexture(badSize, 1), /dimensions/);
});
test('true-color texture formats decode channels explicitly and reject unknown encodings', () => {
  const pixel = data => ({ width: 1, height: 1, data: Uint8Array.from(data) });
  assert.deepEqual([...decodePixels(pixel([0, 248]), 2).data], [255, 0, 0, 255]);
  assert.deepEqual([...decodePixels(pixel([3, 4, 5]), 4).data], [3, 4, 5, 255]);
  assert.deepEqual([...decodePixels(pixel([3, 4, 5, 6]), 5).data], [5, 4, 3, 6]);
  assert.throws(() => decodePixels(pixel([0]), 99), /Unsupported/);
});
test('asset lookup rejects ambiguous names and resolves imported object paths case-insensitively', async () => {
  assert.throws(() => new AssetStore([{ path: 'a/Test.utx' }, { path: 'b/test.UTX' }]), /Ambiguous/);
  const store = new AssetStore([{ path: 'System/DeusEx.exe' }]);
  assert.equal(store.files.size, 0);
  await assert.rejects(store.get('absent'), /Missing package/);
  const target = { name: 'TexturePack', pkg: { exports: [{ path: 'Walls.Brick' }] }, exportsByPath: new Map([['walls.brick', 1]]) };
  store.get = async name => { assert.equal(name, 'texturepack'); return target; };
  const result = await store.resolve({ pkg: { imports: [{ path: 'texturepack.walls.BRICK' }] } }, -1);
  assert.equal(result.index, 1); assert.equal(result.key, 'TexturePack.Walls.Brick');
});
