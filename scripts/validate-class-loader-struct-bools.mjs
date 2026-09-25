#!/usr/bin/env node
/** Original SerializeBin bool bytes at the native-loader/VM boundary.
 * Core.dll 10166550–10166590; docs/script-load-graph.md. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readClass} from '../src/unreal/classes.mjs';
import {Reader} from '../src/unreal/package.mjs';
import {nameAt} from '../src/unreal/objects.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['System', 'Maps', 'Textures', 'Sounds', 'Music']) {
  for (const name of await readdir(path.join(root, directory)))
    files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
}
const assets = new AssetStore(files), asset = await assets.get('DeusEx');
const runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
const loader = runtime.classLoader, {slotOf} = loader.graph;
let compared = 0;
for (const name of ['scriptedpawn', 'greasel', 'karkian']) {
  const index = asset.exportsByPath.get(name), cls = await runtime.loadClass(asset, index);
  const field = runtime.lookupMember(cls, 'fields', 'InitialAlliances');
  const members = field.metadata.structFields;
  const bool = members.find(member => member.metadata.type === 'bool');
  const boolRecord = [...loader.graph.structFieldChain(slotOf(field.loadRecord, 0x5c))]
    .find(member => loader.graph.propertyKindOf(member) === 'BoolProperty');
  assert.equal(slotOf(boolRecord, 0x5c), 1);
  const values = runtime.defaultValue(cls, field);
  for (const tag of readClass(asset, index).properties.filter(tag => tag.name === 'InitialAlliances')) {
    const reader = new Reader(tag.data);
    const expected = [nameAt(asset.pkg, reader.compact()), reader.f32(), reader.u8() !== 0];
    assert.equal(reader.offset, tag.data.length, 'original struct consumes exactly its member stream');
    assert.deepEqual(members.map(member => values[tag.arrayIndex][member.key]), expected);
    compared++;
  }
  if (name === 'scriptedpawn') assert.equal(values[0][bool.key], false, 'zeroed struct bool is false');
  // Original bool serializer tests any nonzero byte, not the native mask.
  assert.equal(loader.value(boolRecord, 2, {member: true}), true);
  assert.equal(loader.value(boolRecord, 0, {member: true}), false);
  for (const value of [false, true]) {
    const changed = values.map(entry => ({...entry}));
    changed[0][bool.key] = value;
    runtime.classDefaultReference(cls, field).set(changed);
    const raw = cls.loadRecord.defaults.data.get(slotOf(field.loadRecord, 0x48));
    assert.equal(raw.bPermanent, Number(value));
    assert.deepEqual(loader.value(field.loadRecord, raw), changed[0]);
  }
  runtime.classDefaultReference(cls, field).set(values);
}
assert.equal(compared, 2);
assert.deepEqual(loader.graph.assertions, []);
assert.ok(loader.graph.warnings.every(warning => warning.kind === 'exists'));
console.log(`PASS native class-loader struct bools: ${compared} original alliance tags, zero default and bool write roundtrips`);
