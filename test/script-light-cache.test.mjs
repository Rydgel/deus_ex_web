import test from 'node:test';
import assert from 'node:assert/strict';
import { createLighting } from '../src/unreal/lighting.mjs';

function classAsset() {
  const bytes = Uint8Array.from([0, 0, 0, 0, 1, ...Array(12 + 16 + 2 + 4 + 4 + 16).fill(0), 0, 0, 0, 0, 2, 1, 64, 0]);
  const pkg = { version: 68, names: ['None', 'Light', 'LightBrightness'].map(name => ({ name })), imports: [],
    exports: [{ className: 'Class', name: 'Light', classIndex: 1, superIndex: 0, flags: 0, serialOffset: 0, serialSize: bytes.length },
      { className: 'Class', name: 'Light', classIndex: 1, superIndex: 0, flags: 0, serialOffset: 0, serialSize: bytes.length }] };
  return { pkg, bytes };
}

function fixture() {
  const asset = classAsset();
  const map = {
    actors: [
      { index: 1, className: 'LevelInfo', values: { AmbientHue: 0, AmbientSaturation: 0, AmbientBrightness: 0, Brightness: 1 } },
      { index: 2, className: 'TriggerLight', values: { LightType: 1, LightBrightness: 64, LightHue: 85, LightSaturation: 0,
        LightRadius: 3, LightEffect: 0, Location: [0, 0, 10], bSpecialLit: false, bStatic: false, bNoDelete: true } },
    ],
    model: {
      vectors: [[0, 0, 1], [1, 0, 0], [0, 1, 0]], points: [[0, 0, 0]],
      surfaces: [{ base: 0, normal: 0, textureU: 1, textureV: 2, flags: 0, lightMap: 0 }],
      lightMaps: [{ dataOffset: 0, pan: [0, 0], clamp: [1, 1], scale: [1, 1], lightActors: 0 }],
      lightBits: Uint8Array.of(0xff), lights: [2, 0], zones: [{ actor: 1 }], nodes: [],
    },
  };
  const assets = { resolve: async (source, index) => ({ key: `Light-${index}`, asset: source, index: 1 }) };
  return { asset, assets, map };
}

test('script light invalidation refills dependent pixels in place', async () => {
  const { asset, assets, map } = fixture();
  const lighting = await createLighting(map, asset, assets);
  await lighting.prepare(map.model);
  const lightmap = lighting.surface(map.model, 0, 0);
  const before = lightmap.pixels[1];
  const update = lighting.invalidate({ ref: 2, values: { LightBrightness: 128 } });
  assert.equal(update.changedLights.length, 1);
  assert.deepEqual(update.changedLights, [2]);
  assert.equal(update.lightmaps.length, 1);
  assert.equal(update.lightmaps[0], lightmap);
  assert.ok(lightmap.pixels[1] > before);
  assert.equal(lighting.stats.lightmaps, 1);
});

test('script light invalidation rejects the zero LightActors terminator', async () => {
  const { asset, assets, map } = fixture();
  const lighting = await createLighting(map, asset, assets);
  await lighting.prepare(map.model);
  lighting.surface(map.model, 0, 0);
  assert.throws(() => lighting.invalidate(0), /Invalid changed light reference/);
});

test('script light invalidation keeps unsupported radius changes outside the host route', async () => {
  const { asset, assets, map } = fixture();
  const lighting = await createLighting(map, asset, assets);
  await lighting.prepare(map.model);
  lighting.surface(map.model, 0, 0);
  assert.throws(() => lighting.invalidate({ ref: 2, values: { LightRadius: 12 } }), /Unsupported script light update field/);
});
