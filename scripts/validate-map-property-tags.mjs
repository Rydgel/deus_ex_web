#!/usr/bin/env node
/** Released map property tags against retained ones (docs/live-heap.md, "Actor hosts and mesh bindings"): the decoded map's tags are released once the
 * map actors are attached (script-map-properties.mjs releaseMapPropertyTags) and prepareMapProperties then reads them again from the package.
 * For every actor of one map: the authored fields and the initial value of every field of its class, from the retained tags and from the tags read
 * again, must be identical.
 *
 *   node scripts/validate-map-property-tags.mjs [--map 00_Training] [--limit 60]
 */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {prepareMapProperties, releaseMapPropertyTags} from '../src/runtime/script-map-properties.mjs';
import {gameDirectory} from './game-directory.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const mapName = flag('map', '00_Training'), limit = Number(flag('limit', 60));
const root = gameDirectory(), files = [];
for (const directory of ['System', 'Textures', 'Sounds', 'Music', 'Maps']) for (const name of await readdir(`${root}/${directory}`))
  if (directory !== 'Maps' || name === `${mapName}.dx`) files.push({path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`)});
const assets = new AssetStore(files), runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
const asset = await assets.get(mapName), map = decodeMap(asset.bytes);
const actors = new Map(map.actors.map(actor => [actor.index, actor]));

// one actor of each class first, then the rest in order, up to the limit
const seen = new Set(), chosen = [];
for (const actor of map.actors) if (!seen.has(actor.className)) { seen.add(actor.className); chosen.push(actor); }
for (const actor of map.actors) if (chosen.length < limit && !chosen.includes(actor)) chosen.push(actor);
chosen.length = Math.min(chosen.length, Math.max(limit, seen.size));

const named = (key, value) => value && typeof value === 'object' && 'className' in value && 'index' in value ? `actor:${value.name}` : value;
async function result(actor) {
  const cls = await runtime.loadClass(asset, asset.pkg.exports[actor.index - 1].classIndex);
  const initial = await prepareMapProperties(runtime, asset, actor, cls, actors);
  const out = new Map(), fields = [];
  for (let node = cls; node; node = node.base) for (const field of node.fields?.values() ?? []) fields.push(field);
  for (const field of fields) {
    await runtime.field(field);
    try { out.set(field.key, JSON.stringify(initial(field), named)); } catch (error) { out.set(field.key, `error ${error.message}`); }
  }
  return {out, authored: initial.authoredFields.map(field => field.key)};
}
const before = [];
for (const actor of chosen) before.push(await result(actor));
releaseMapPropertyTags(map, []);
let fields = 0, authored = 0;
for (const [index, actor] of chosen.entries()) {
  assert.equal(actor.properties, null);
  const after = await result(actor);
  assert.deepEqual(after.authored, before[index].authored, `${actor.name} authored fields`);
  assert.deepEqual([...after.out], [...before[index].out], actor.name);
  fields += after.out.size; authored += after.authored.length;
}
assert.ok(authored > 0);
console.log(`${mapName}: ${chosen.length} actors of ${seen.size} classes, ${authored} authored fields and ${fields} initial values the same from released and retained tags`);
