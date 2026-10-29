import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {releaseMapPropertyTags} from '../src/runtime/script-map-properties.mjs';

// docs/live-heap.md, "Actor hosts and mesh bindings": the decoded map's property tags are released once the map actors are attached
// (releaseMapPropertyTags); prepareMapProperties then reads them again from the package (scripts/validate-map-property-tags.mjs compares the
// initial values it gives).

const ROOT = 'Deus Ex GOTY Edition';

test('a decoded actor\'s tags are one literal with byteLength, and the same as the package gives', async () => {
  const files = [];
  for (const name of await readdir(`${ROOT}/Maps`)) if (name === '00_Training.dx') files.push({path: `Maps/${name}`, read: () => readFile(`${ROOT}/Maps/${name}`)});
  const assets = new AssetStore(files);
  const asset = await assets.get('00_Training');
  const map = decodeMap(asset.bytes);
  const tags = map.actors.map(actor => actor.properties);
  assert.ok(tags.reduce((n, list) => n + list.length, 0) > 1000);
  for (const list of tags) for (const tag of list) {
    assert.deepEqual(Object.keys(tag), ['name', 'type', 'struct', 'arrayIndex', 'value', 'decoded', 'byteLength']);
    assert.equal(typeof tag.byteLength, 'number');
  }
  // the package gives the same tags (what prepareMapProperties reads again), with their payloads
  for (const actor of map.actors) {
    const again = readObject(asset.pkg, asset.bytes, actor.index).properties;
    assert.deepEqual(again.map(({data, ...tag}) => ({...tag, byteLength: data.length})), actor.properties, actor.name);
  }
});

test('decodeMap with properties: false keeps no tags and the same summary', async () => {
  const files = [{path: 'Maps/00_Training.dx', read: () => readFile(`${ROOT}/Maps/00_Training.dx`)}];
  const asset = await new AssetStore(files).get('00_Training');
  const full = decodeMap(asset.bytes, {triangles: false}), bare = decodeMap(asset.bytes, {triangles: false, properties: false});
  assert.ok(full.summary.undecodedActorProperties > 0);
  assert.deepEqual(bare.summary, full.summary);
  assert.equal(bare.actors.length, full.actors.length);
  assert.ok(bare.actors.every(actor => actor.properties === null));
  assert.deepEqual(bare.actors.map(({properties, ...rest}) => rest), full.actors.map(({properties, ...rest}) => rest));
});

test('releaseMapPropertyTags releases the host copies and leaves hosts without tags alone', () => {
  const tags = [{name: 'Tag'}];
  const map = {actors: [{properties: tags}, {properties: tags}]};
  const host = {properties: tags}, plain = {name: 'x'};
  releaseMapPropertyTags(map, [host, plain]);
  assert.equal(map.actors[0].properties, null);
  assert.equal(host.properties, null);
  assert.equal('properties' in plain, false, 'a host that never had tags gets none');
});
