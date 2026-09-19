import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {AssetStore} from '../src/unreal/assets.mjs';
import {
  NATIVE_RESOURCE_CLASSES,
  ScriptResourceRegistry,
} from '../src/runtime/script-resources.mjs';

const ROOT = 'Deus Ex GOTY Edition';

async function packageFiles(names) {
  return Promise.all(names.map(async name => ({
    path: `System/${name}.u`,
    read: () => fs.readFile(`${ROOT}/System/${name}.u`),
  })));
}

async function fixture() {
  const assets = new AssetStore(await packageFiles(['Engine', 'Core', 'DeusEx', 'DeusExDeco', 'DeusExSounds']));
  const registry = new ScriptResourceRegistry({
    assets,
    indexProvider: {indexFor(className, name) {
      return className === 'LodMesh' && name === 'LightSwitch' ? 34271 : null;
    }},
  });
  return {assets, registry};
}

test('native resource catalog preserves measured class hierarchy and layout', () => {
  assert.equal(NATIVE_RESOURCE_CLASSES['engine.lodmesh'].staticClass, 0x105359d0);
  assert.equal(NATIVE_RESOURCE_CLASSES['engine.lodmesh'].instanceSize, 0x1b0);
  assert.equal(NATIVE_RESOURCE_CLASSES['engine.lodmesh'].serializer.body, 0x10354ab0);
  assert.equal(NATIVE_RESOURCE_CLASSES['engine.texture'].instanceSize, 0xc0);
  assert.equal(NATIVE_RESOURCE_CLASSES['engine.sound'].registrationBody, 0x1036fc02);
});

test('LightSwitch materializes one canonical object, package outer, class and decoded payload', async () => {
  const {assets, registry} = await fixture();
  const first = registry.resolve('DeusExDeco', 606);
  const second = registry.resolve('DeusExDeco', 606);
  const light = await first;
  const again = await second;
  const deco = await assets.get('DeusExDeco');
  const importedClass = await registry.resolve(deco, -4);

  assert.strictEqual(light, again);
  assert.strictEqual(light.object, again.object);
  assert.equal(light.kind, 'LodMesh');
  assert.equal(light.fullPath, 'DeusExDeco.LightSwitch');
  assert.equal(light.outer.kind, 'Package');
  assert.equal(light.outer.name, 'DeusExDeco');
  assert.equal(light.outer.key, 'package:deusexdeco');
  assert.equal(light.nativeClass.path, 'Engine.LodMesh');
  assert.equal(light.nativeClass.staticClass, 0x105359d0);
  assert.strictEqual(importedClass, light.nativeClass);
  assert.equal(importedClass.superClass.path, 'Engine.Mesh');
  assert.equal(importedClass.superClass.superClass.path, 'Engine.Primitive');
  assert.equal(light.globalIndex, 34271);
  assert.equal(light.payloadStatus, 'decoded-lodmesh');
  assert.equal(light.payloadComplete, false);
  assert.deepEqual(light.payload.sequences.map(sequence => sequence.name), ['All', 'Still', 'Off', 'On']);
  assert.deepEqual(light.payload.boundingBox.min, [-960, -162, -1600]);
});

test('script exports converge with native class imports through ScriptObjects', async () => {
  const {assets, registry} = await fixture();
  const deusEx = await assets.get('DeusEx');
  const engine = await assets.get('Engine');
  const core = await assets.get('Core');
  const actor = await registry.materialize(engine, engine.exportsByPath.get('actor'));
  const actorImport = await registry.resolve(deusEx, -3);
  const object = await registry.materialize(core, core.exportsByPath.get('object'));
  const objectImport = await registry.resolve(deusEx, -7);

  assert.strictEqual(actorImport, actor);
  assert.strictEqual(actorImport.object, actor.object);
  assert.equal(actorImport.kind, 'Class');
  assert.strictEqual(objectImport, object);
  assert.strictEqual(objectImport.object, object.object);
  assert.equal(objectImport.kind, 'Class');
  assert.equal(object.nativeClass.name, 'Class');
  assert.equal(object.nativeClass.staticClass??object.nativeClass.nativeRegistration?.staticClass,0x101f1c18);
});

test('class and outer edges are explicit collector references', async () => {
  const {registry} = await fixture();
  const light = await registry.materialize('DeusExDeco', 606);
  const seen = [];
  const result = registry.collectReferences(light, reference => seen.push(reference));

  assert.deepEqual(result.references.map(reference => reference.slot), ['outer', 'class', 'textures[0]']);
  assert.deepEqual(seen.map(reference => reference.slot), ['outer', 'class', 'textures[0]']);
  assert.equal(result.references[0].target, light.outer);
  assert.equal(result.references[1].target, light.nativeClass);
  assert.ok(result.references.every(reference => reference.mutable === false));
  assert.equal(result.references[2].target.key, 'deusexdeco.skins.lightswitchtex1');
  assert.match(result.unsupported[0], /live Play load finalization/);
});

test('Sound decodes its native payload while Texture retains its opaque boundary', async () => {
  const {assets, registry} = await fixture();
  const sounds = await assets.get('DeusExSounds');
  const onIndex = sounds.pkg.exports.findIndex(entry => entry.path === 'Special.Switch4ClickOn') + 1;
  const texture = await registry.materialize('DeusExDeco', 170);
  const sound = await registry.materialize(sounds, onIndex);
  const engine = await assets.get('Engine');
  const textureClass = await registry.materialize(engine, engine.exportsByPath.get('texture'));

  assert.equal(sound.kind, 'Sound');
  assert.equal(sound.nativeClass.path, 'Engine.Sound');
  assert.equal(sound.payloadStatus, 'decoded-wave');
  assert.equal(sound.payloadComplete,false);
  assert.equal(sound.payload.formatName.name,'wav');
  assert.equal(sound.payload.wave.data.size,11118);
  assert.match(sound.unsupported[0], /lazy Sound loading/);
  const collector=registry.collectReferences(sound);
  assert.deepEqual(collector.references.map(ref=>ref.slot),['outer','class']);
  assert.deepEqual(collector.nameReferences.map(ref=>ref.name),['wav']);
  assert.equal(texture.kind, 'Texture');
  assert.equal(texture.nativeClass.fullPath, 'Engine.Texture');
  assert.equal(texture.nativeClass.nativeRegistration.path, 'Engine.Texture');
  assert.strictEqual(textureClass.object, texture.nativeClass.object);
  assert.equal(textureClass.nativeRegistration.path, 'Engine.Texture');
  assert.equal(texture.payloadStatus, 'opaque');
  assert.match(texture.unsupported[0], /bulk-data/);

  const imported = sounds.pkg.imports.findIndex(entry => entry.path === 'DeusExSounds.Special.Switch4ClickOn');
  if (imported >= 0) {
    const importedRecord = await registry.resolve(sounds, -imported - 1);
    assert.strictEqual(importedRecord, sound);
  }
});

test('unknown imports remain explicit unresolved boundaries', async () => {
  const {registry} = await fixture();
  const fake = {
    name: 'Synthetic',
    pkg: {imports: [{classPackage: 'Missing', className: 'Object', outer: 0, name: 'Nope', path: 'Missing.Nope'}], exports: []},
  };
  const unresolved = await registry.resolveReference(fake, -1);
  assert.equal(unresolved.materialization, 'unresolved-import');
  assert.equal(unresolved.path, 'Missing.Nope');
  assert.match(unresolved.unsupported[0], /absent/);
});
