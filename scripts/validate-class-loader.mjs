#!/usr/bin/env node
/** New loader-to-VM boundary against original package values and native bool
 * writes. Reuses the existing seven-class evidence instead of a larger census.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readClass} from '../src/unreal/classes.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {readScriptStructValue} from '../src/runtime/script-struct-values.mjs';
import {serializeTaggedProperty} from '../src/runtime/script-linker-preload.mjs';
import {gameDirectory} from './game-directory.mjs';
import {importText} from '../src/runtime/config-text.mjs';
import {NativeSlots} from '../src/runtime/native-slots.mjs';
import { exportAt } from '../src/unreal/objects.mjs';

const root = gameDirectory();
const files = [];
for (const directory of ['System', 'Maps', 'Textures', 'Sounds', 'Music']) {
  for (const name of await readdir(path.join(root, directory)))
    files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
}
const assets = new AssetStore(files);
const runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
const deusEx = await assets.get('DeusEx');
const loader = runtime.classLoader;
const graph = loader.graph;
const {slotOf} = graph;

// Established references from the original bool writer, without any native
// service stubs. The old signed mask guard fails the first case.
const nativeBools = JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-tagged-bool-oracle.py', root], {encoding: 'utf8'}));
for (const sample of nativeBools) {
  const boolClass = {};
  const property = {nativeSlots: NativeSlots.from([[0x24, {value: boolClass}], [0x48, {value: 0}],
    [0x38, {value: 4}], [0x5c, {value: sample.mask}]])};
  let word = sample.before;
  serializeTaggedProperty({raw: sample.value ? 0x83 : 3, arrayIndex: 0},
    {ar0c: 1}, property, null, {boolPropertyClass: boolClass,
      dataReference: () => ({get: () => word, set: value => { word = value; }})});
  assert.equal(word, sample.after, `native packed bool mask ${sample.mask.toString(16)}`);
}

const names = ['DataVaultImage', 'DeusExWeapon', 'WeaponAssaultGun', 'DeusExPlayer',
  'Gray', 'Rocket', 'MenuScreenCustomizeKeys'];
let compared = 0;
for (const name of names) {
  const index = deusEx.exportsByPath.get(name.toLowerCase());
  // Publish the VM handle before native loading to catch identity replacement.
  const before = await runtime.objects.resolve(deusEx, index);
  const cls = await runtime.loadClass(deusEx, index);
  assert.equal(cls.record, before, `${name} retains its canonical identity`);
  assert.equal(cls.defaultsSource, 'original-linker-serialized');
  assert.equal(cls.record.loadRecord, cls.loadRecord);
  assert.equal(slotOf(cls.loadRecord, 0x10), graph.linkers.get('deusex'));
  assert.equal(slotOf(cls.loadRecord, 0x14), index - 1);
  assert.equal(slotOf(cls.loadRecord, 0x1c) & 0x200, 0, `${name} RF_NeedLoad cleared`);
  assert.equal(loader.identity(slotOf(cls.loadRecord, 0x28)), cls.base?.record ?? null);
  assert.equal(await runtime.loadClass(deusEx, index), cls, `${name} repeated load shares the class`);
  const oracle = readClass(deusEx, index);
  assert.equal(cls.metadata.classFlags, oracle.classFlags);
  assert.deepEqual(cls.metadata.probeMask, oracle.probeMask);
  assert.deepEqual(cls.metadata.ignoreMask, oracle.ignoreMask);
  for (const tag of oracle.properties) {
    const field = runtime.lookupMember(cls, 'fields', tag.name);
    const values = cls.defaults.get(field.key);
    assert.ok(values?.has(tag.arrayIndex), `${name}.${tag.name}[${tag.arrayIndex}] is native-loaded`);
    const actual = values.get(tag.arrayIndex);
    let expected = tag.value;
    if ([5, 8].includes(tag.type)) expected = await runtime.objects.resolve(deusEx, tag.value);
    else if (tag.type === 10) expected = await readScriptStructValue(deusEx, field, tag.data,
      {resolveObject: (asset, ref) => runtime.objects.resolve(asset, ref)});
    // UClass::Serialize ends with LoadConfig on the defaults: a config
    // property with a value in the installed .ini takes that value instead
    // (docs/script-config.md). Sections compare case-insensitively.
    const flags = field.metadata.flags ?? 0;
    if (flags & 0x4000) {
      const section = flags & 0x40000 ? field.key.split('.').slice(0, 2).join('.') : `deusex.${name}`;
      const key = field.metadata.arrayDim > 1 ? `${tag.name}[${tag.arrayIndex}]` : tag.name;
      const text = graph.config.getString(section, key, oracle.configName ?? 'System');
      const kind = {1: 'byte', 2: 'int', 3: 'bool', 4: 'float', 6: 'name', 13: 'string'}[tag.type];
      if (text !== null && kind) {
        assert.deepEqual(actual, importText(kind, text).value, `${name}.${tag.name}[${tag.arrayIndex}] takes its .ini value`);
        continue;
      }
    }
    assert.deepEqual(actual, expected, `${name}.${tag.name}[${tag.arrayIndex}] matches package bytes`);
    compared += 1;
  }
}

const dvi = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('datavaultimage'));
const dviImport = exportAt(deusEx.pkg, dvi.record.index).superIndex;
assert.ok(dviImport < 0);
const nativeInventory = graph.indexToObject(graph.linkers.get('deusex'), dviImport);
assert.equal(loader.identity(nativeInventory), dvi.base.record, 'native imported super and VM share one handle');
assert.equal(await runtime.objects.resolve(deusEx, dviImport), dvi.base.record);
assert.equal(slotOf(nativeInventory, 0x10), graph.linkers.get('engine'));
const resource = await runtime.prepareResource(dvi.record);
assert.equal(resource.object, dvi.record);
assert.equal(loader.identity(slotOf(dvi.loadRecord, 0x18)), resource.outer,
  'native LinkerRoot and resource Outer share the same package identity');
assert.equal(loader.identity(slotOf(dvi.loadRecord, 0x24)), resource.nativeClass,
  'native metaclass and resource Class share the same native descriptor');

// Exercise the logical/native default-write boundary, including packed siblings
// and a nested string value. This is representation wiring, not new game rules.
const weapon = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('deusexweapon'));
const boolFields = weapon.propertyLink.filter(f => f.metadata.type === 'bool');
const pair = boolFields.flatMap((field, index) => boolFields.slice(index + 1)
  .filter(other => slotOf(field.loadRecord, 0x48) === slotOf(other.loadRecord, 0x48)).map(other => [field, other]))[0];
assert.ok(pair, 'weapon has packed bool siblings');
const [first, sibling] = pair;
const siblingBefore = runtime.defaultValue(weapon, sibling);
const old = runtime.defaultValue(weapon, first);
runtime.classDefaultReference(weapon, first).set(!old);
assert.equal(runtime.defaultValue(weapon, sibling), siblingBefore);
const offset = slotOf(first.loadRecord, 0x48), word = weapon.loadRecord.defaults.data.get(offset);
assert.equal(Boolean(word & slotOf(first.loadRecord, 0x5c)), !old);
assert.equal(Boolean(word & slotOf(sibling.loadRecord, 0x5c)), siblingBefore);
runtime.classDefaultReference(weapon, first).set(old);

const keys = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('menuscreencustomizekeys'));
const strings = keys.propertyLink.find(field => field.metadata.type === 'struct' &&
  field.metadata.arrayDim === 71);
assert.ok(strings, 'largest indexed string-owning struct property');
const original = runtime.defaultValue(keys, strings);
runtime.classDefaultReference(keys, strings).set(original);
const firstRaw = keys.loadRecord.defaults.data.get(slotOf(strings.loadRecord, 0x48));
assert.deepEqual(loader.value(strings.loadRecord, firstRaw), original[0], 'struct default write roundtrip');

assert.deepEqual(graph.assertions, []);
assert.ok(graph.warnings.every(w => w.kind === 'exists'));
assert.ok(graph.boundaries.has('native-constructor-defaults'), 'unimplemented C++ defaults remain explicit');

// Real class defaults have queued native resources. The old broad UObject
// fallback would clear RF_NeedLoad and consume only their tagged-property
// prefix. Refuse both unimplemented virtuals before altering their flags.
// Play now admits Engine.Texture (docs/script-font-load.md); the procedural
// Fire.FireTexture serializer and PostLoad remain unrecovered.
const pendingTexture = graph.loadedObjects.find(record =>
  graph.fullName(graph.classRecordOf(record)) === 'Fire.FireTexture' &&
  (slotOf(record, 0x1c) & 0x01000200) === 0x01000200);
assert.ok(pendingTexture, 'the real queue includes an unfinished procedural texture');
const textureFlags = slotOf(pendingTexture, 0x1c);
const textureReader = slotOf(pendingTexture, 0x10).reader;
const readerOffset = textureReader.offset;
assert.throws(() => graph.preload(pendingTexture), /no recovered Serialize body/);
assert.throws(() => graph.conditionalPostLoad(pendingTexture), /No recovered PostLoad/);
assert.equal(slotOf(pendingTexture, 0x1c), textureFlags);
assert.equal(textureReader.offset, readerOffset);

// Core.Package has a separately recovered Serialize wrapper that forwards
// only to UObject. A real grouped resource package is therefore admitted.
const packageGroup = graph.loadedObjects.find(record =>
  graph.fullName(graph.classRecordOf(record)) === 'Core.Package' &&
  (slotOf(record, 0x1c) & 0x200));
assert.ok(packageGroup, 'defaults reach an unfinished resource group package');
const packageFlags = slotOf(packageGroup, 0x1c);
graph.preload(packageGroup);
assert.equal(slotOf(packageGroup, 0x1c) & 0x200, 0);
assert.equal(slotOf(packageGroup, 0x1c) & 0x01000000, packageFlags & 0x01000000);
assert.ok(graph.warnings.every(w => w.kind === 'exists'), 'package serializer consumes its exact payload');
console.log(`PASS native class loader: ${names.length} classes, ${compared} original default values, ` +
  `${nativeBools.length} original bool writes, canonical imports, mutable defaults and explicit resource boundaries`);
