import test from 'node:test';
import assert from 'node:assert/strict';
import { lightColor, shadowMask, lightmapBasis, lightAttenuation, pointZone } from '../src/unreal/lighting.mjs';
import { LightAtlas } from '../src/viewer/light-atlas.mjs';
import { readPolys, moverModelFromPolys } from '../src/unreal/polys.mjs';
import { POLY } from '../src/unreal/geometry.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
test('modulated surfaces and zone portals use distinct original flags', () => {
  assert.equal(POLY.Modulated, 0x40); assert.equal(POLY.Portal, 0x04000000);
  assert.equal(POLY.Modulated & POLY.Portal, 0);
});
test('native Deus Ex colour sectors, inverse saturation and ambient brightness response', () => {
  assert.deepEqual(lightColor(0, 255, 0), [0, 0, 0]);
  const peak = .7 * 1.4 / (.01 + Math.sqrt(1.4));
  for (const [h, channel] of [[0, 0], [85, 1], [170, 2], [255, 0]]) {
    const c = lightColor(h, 0, 255); close(c[channel], peak);
    c.forEach((v, i) => { if (i !== channel) close(v, 0); });
  }
  lightColor(90, 255, 255).forEach(c => close(c, peak));
  close(lightColor(0, 128, 255)[1], peak * 128 / 255);
  close(lightColor(0, 0, 64)[0], .7 * (64 * 1.4 / 255) / (.01 + Math.sqrt(64 * 1.4 / 255)));
  assert.notEqual(lightColor(0, 0, 64)[0], peak * 64 / 255); // Ambient and actor brightness differ.
});

test('shadow masks respect row padding, light offset, bit order and original kernel', () => {
  const lm = { clamp: [9, 3], dataOffset: 2 };
  const bits = new Uint8Array(14); bits[10] = 0x80; // Second light, middle row, x=7.
  const a = shadowMask({ lightBits: bits }, lm, 1);
  close(a[9 + 7], 64 / 320); close(a[9 + 8], 40 / 320); close(a[7], 40 / 320);
  assert.equal(a[9], 0);
  assert.ok(shadowMask({ lightBits: bits }, lm, 0).every(x => x === 0));
  close(shadowMask({ lightBits: Uint8Array.of(255) }, { clamp: [1, 1], dataOffset: 0 }, 0)[0], 1);
  assert.throws(() => shadowMask({ lightBits: bits }, lm, 2), /outside/);
});

test('lightmap sample positions invert scaled and skewed texture axes', () => {
  const model = { points: [[10, 20, 30]], vectors: [[2, 1, 0], [0, -4, 0], [0, 0, 2]] };
  const surface = { base: 0, textureU: 0, textureV: 1, normal: 2 }, lm = { pan: [-9, 12], scale: [16, 8] };
  const b = lightmapBasis(model, surface, lm);
  for (const [x, y] of [[0, 0], [5, 3], [-2, 7]]) {
    const uv = b.uv(b.point(x, y)); close(uv[0], x + .5); close(uv[1], y + .5);
  }
  assert.throws(() => lightmapBasis(model, { ...surface, textureV: 0 }, lm), /Singular/);
});

test('native falloff combines incidence with smooth radius falloff and cone direction', () => {
  const light = { Location: [0, 0, 0], LightRadius: 3 };
  close(lightAttenuation(light, [50, 0, 0], [1, 0, 0]), .5);
  close(lightAttenuation(light, [25, 0, 0], [1, 0, 0]), .84375);
  assert.equal(lightAttenuation(light, [100, 0, 0], [1, 0, 0]), 0);
  assert.equal(lightAttenuation(light, [50, 0, 0], [0, 1, 0]), 0);
  // NonIncidence (0x10b054e0) subtracts the distance fraction from 1.02 and
  // keeps texels while FISTP(d^2*4093) < 4096, slightly past the radius.
  close(lightAttenuation({ ...light, LightEffect: 13 }, [25, 0, 0], [0, 1, 0]), .77);
  close(lightAttenuation({ ...light, LightEffect: 13 }, [100, 0, 0], [0, 1, 0]), .02);
  assert.equal(lightAttenuation({ ...light, LightEffect: 13 }, [100.04, 0, 0], [0, 1, 0]), 0);
  const spot = { ...light, LightEffect: 12, LightCone: 128, Rotation: [0, 0, 0] };
  close(lightAttenuation(spot, [50, 0, 0], [1, 0, 0]), .5);
  assert.equal(lightAttenuation(spot, [-50, 0, 0], [1, 0, 0]), 0);
  assert.equal(lightAttenuation({ ...spot, LightCone: 0 }, [50, 0, 0], [1, 0, 0]), 0);
});

test('zone lookup selects authored BSP sides and rejects cycles', () => {
  const node = { plane: [1, 0, 0, 10], front: -1, back: -1, zones: [3, 7] };
  assert.equal(pointZone({ nodes: [node] }, [11, 0, 0]), 7);
  assert.equal(pointZone({ nodes: [node] }, [9, 0, 0]), 3);
  assert.throws(() => pointZone({ nodes: [{ ...node, front: 0 }] }, [11, 0, 0]), /Cyclic/);
});

test('atlas padding prevents neighboring lightmaps from bleeding into samples', () => {
  const atlas = new LightAtlas(4);
  const lm = { width: 2, height: 1, pixels: [1, 0, 0, 0, 0, 1], uv: () => [.5, .5] };
  const tile = atlas.add(lm); assert.equal(atlas.add(lm), tile);
  assert.deepEqual(atlas.coordinates(tile, []), [.375, .375, 1]);
  assert.deepEqual(tile.bounds, [.375, .375, .625, .375]);
  assert.deepEqual([...tile.page.pixels.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...tile.page.pixels.slice(12, 16)], [0, 0, 255, 255]);
  lm.pixels = [0, 1, 0, 1, 1, 0];
  const version = tile.page.texture.version;
  assert.equal(atlas.update(lm), tile);
  assert.equal(tile.page.texture.version, version + 1);
  assert.deepEqual([...tile.page.pixels.slice(0, 4)], [0, 255, 0, 255]);
  assert.deepEqual([...tile.page.pixels.slice(12, 16)], [255, 255, 0, 255]);
  assert.deepEqual(atlas.coordinates(tile, []), [.375, .375, 1]);
  assert.equal(atlas.add({ ...lm }).page.index, 1);
  assert.deepEqual(atlas.coordinates(atlas.add(null), []), [0, 0, 0]);
  assert.throws(() => atlas.add({ ...lm, width: 3 }), /fit/);
  atlas.dispose();
});

test('mover polygon decoder and correspondence use authored bases, not empty BSP light indices', () => {
  const data = [0], u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); data.push(...b); };
  const vector = v => { for (const n of v) { const b = Buffer.alloc(4); b.writeFloatLE(n); data.push(...b); } };
  u32(1); u32(1); data.push(3);
  const base = [0, 0, 0], normal = [0, 0, 1], u = [2, 0, 0], v = [0, 2, 0];
  [base, normal, u, v, base, [1, 0, 0], [0, 1, 0]].forEach(vector);
  u32(0); data.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
  const bytes = Uint8Array.from(data), pkg = { names: [{ name: 'None' }], exports: [{ className: 'Polys', serialOffset: 0, serialSize: bytes.length }] };
  const polygons = readPolys(pkg, bytes, 1);
  const model = { points: [base], vectors: [normal, u, v], lightMaps: [{}], surfaces: [{ base: 0, normal: 0, textureU: 1, textureV: 2, pan: [0, 0], texture: 0, lightMap: -1 }] };
  // The brush tracker's surfaces: one per polygon, iLightMap = iBrushPoly.
  const lit = [{ ...polygons[0], brushPolygon: 3, flags: 0x41000000 }, { ...polygons[0], brushPolygon: -1, flags: 1 }];
  const mover = moverModelFromPolys(model, lit, { specialLit: true });
  assert.deepEqual(mover.model.surfaces.map(s => s.lightMap), [3, -1]);
  assert.equal(mover.model.surfaces[0].flags, 0x100000, 'PolyFlags & 0x3cffffff, PF_SpecialLit for a bSpecialLit mover');
  assert.equal(mover.triangles.length, 1, 'an invisible polygon draws nothing');
  assert.equal(model.surfaces[0].lightMap, -1);
  assert.throws(() => readPolys(pkg, bytes.subarray(0, -1), 1), /Truncated/);
});
