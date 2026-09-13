import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';

import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {arrayReference, propertyReference} from '../src/runtime/script-values.mjs';

const ROOT = 'Deus Ex GOTY Edition';

async function fixture() {
  const files = [];
  for (const name of await readdir(`${ROOT}/System`)) {
    if (!/\.u$/i.test(name)) continue;
    files.push({path: `System/${name}`, read: () => readFile(`${ROOT}/System/${name}`)});
  }
  const assets = new AssetStore(files);
  return {assets, runtime: new ScriptRuntime(assets)};
}

async function struct(runtime, assets, packageName, exportPath) {
  const asset = await assets.get(packageName);
  const index = asset.exportsByPath.get(exportPath.toLowerCase());
  assert.ok(index, `Missing ${packageName}.${exportPath}`);
  const record = await runtime.objects.resolve(asset, index);
  return {asset, index, record, layout: await runtime.structLayout(record)};
}

function directFields(layout) {
  return [...layout.fields.values()].map(field => ({
    name: field.record.name,
    kind: field.kind,
    offset: field.offset,
    elementSize: field.elementSize,
    bitMask: field.bitMask,
  }));
}

test('original DeusEx/Core struct schemas link to measured native offsets', async () => {
  const {assets, runtime} = await fixture();
  const cases = [
    ['DeusEx', 'ScriptedPawn.InventoryItem', 8, [
      ['Inventory', 'ClassProperty', 0, 4, null],
      ['Count', 'IntProperty', 4, 4, null],
    ]],
    ['DeusEx', 'DeusExRootWindow.S_DataVaultFunction', 16, [
      ['Function', 'StrProperty', 0, 12, null],
      ['winClass', 'ClassProperty', 12, 4, null],
    ]],
    ['DeusEx', 'MenuScreenCustomizeKeys.S_KeyDisplayItem', 16, [
      ['inputKey', 'ByteProperty', 0, 1, null],
      ['displayName', 'StrProperty', 4, 12, null],
    ]],
    ['DeusEx', 'AllianceTrigger.InitialAllianceInfo', 12, [
      ['AllianceName', 'NameProperty', 0, 4, null],
      ['AllianceLevel', 'FloatProperty', 4, 4, null],
      ['bPermanent', 'BoolProperty', 8, 4, 1],
    ]],
    ['DeusEx', 'ScriptedPawn.InitialAllianceInfo', 12, [
      ['AllianceName', 'NameProperty', 0, 4, null],
      ['AllianceLevel', 'FloatProperty', 4, 4, null],
      ['bPermanent', 'BoolProperty', 8, 4, 1],
    ]],
    ['Core', 'Object.Color', 4, [
      ['R', 'ByteProperty', 0, 1, null],
      ['G', 'ByteProperty', 1, 1, null],
      ['B', 'ByteProperty', 2, 1, null],
      ['A', 'ByteProperty', 3, 1, null],
    ]],
  ];

  for (const [packageName, path, size, expected] of cases) {
    const result = await struct(runtime, assets, packageName, path);
    assert.equal(result.layout.nativeVtable, 0x10175698, path);
    assert.equal(result.layout.propertiesSize, size, path);
    assert.deepEqual(directFields(result.layout), expected.map(([name, kind, offset, elementSize, bitMask]) => ({
      name, kind, offset, elementSize, bitMask,
    })), path);
  }
});

test('inherited and nested original structs preserve base size and recursive stride', async () => {
  const {assets, runtime} = await fixture();
  const plane = await struct(runtime, assets, 'Core', 'Object.Plane');
  assert.equal(plane.layout.propertiesSize, 16);
  assert.deepEqual(directFields(plane.layout), [
    {name: 'W', kind: 'FloatProperty', offset: 12, elementSize: 4, bitMask: null},
  ]);
  assert.deepEqual((await runtime.structFields(plane.record)).map(field => field.name), ['W', 'X', 'Y', 'Z']);

  const volume = await struct(runtime, assets, 'Core', 'Object.BoundingVolume');
  assert.equal(volume.layout.propertiesSize, 44);
  assert.deepEqual(directFields(volume.layout), [
    {name: 'Sphere', kind: 'StructProperty', offset: 28, elementSize: 16, bitMask: null},
  ]);
  const sphere = volume.layout.fields.values().next().value;
  assert.equal(sphere.record.metadata.structKey, 'core.object.plane');
  assert.equal(sphere.record.metadata.elementSize, 16);
  assert.equal((await runtime.structLayout(await runtime.objects.resolve(
    volume.asset, volume.asset.exportsByPath.get('object.plane'),
  ))).propertiesSize, 16);
});

test('consecutive bools share native storage while logical values remain keyed', async () => {
  const {assets, runtime} = await fixture();
  const result = await struct(runtime, assets, 'DeusEx', 'Computers.sSpecialOptions');
  assert.equal(result.layout.propertiesSize, 48);
  const bools = [...result.layout.fields.values()].filter(field => field.kind === 'BoolProperty');
  assert.deepEqual(bools.map(field => [field.record.name, field.offset, field.elementSize, field.bitMask]), [
    ['bTriggerOnceOnly', 44, 4, 1],
    ['bAlreadyTriggered', 44, 4, 2],
  ]);
  assert.equal(bools[0].record.metadata.bitMask, null);
  assert.equal(bools[1].record.metadata.bitMask, null);
});

test('runtime array and nested struct references use the linked original stride', async () => {
  const {assets, runtime} = await fixture();
  const damage = await assets.get('DeusEx');
  const cls = await runtime.loadClass(damage, damage.exportsByPath.get('damagehuddisplay'));
  const field = runtime.lookupMember(cls, 'fields', 'IconInfo');
  assert.equal(field.metadata.arrayDim, 7);
  assert.equal(field.metadata.elementSize, 36);
  assert.equal(field.metadata.structKey, 'deusex.damagehuddisplay.siconinfo');

  let storage = runtime.defaultValue(cls, field);
  const fieldReference = propertyReference(field, () => storage, value => { storage = value; });
  const warnings = [];
  const element = arrayReference(2, fieldReference, warning => warnings.push(warning));
  assert.equal(element.arrayIndex, 2);
  assert.equal(element.addressOffset, 72);
  assert.equal(element.get()[field.metadata.structFields[0].key][0], 'None');

  const activeMember = field.metadata.structFields.find(member => member.name === 'bActive');
  const active = runtime.structReference(element, activeMember);
  active.set(true);
  assert.equal(storage[2][activeMember.key], true);
  assert.equal(storage[1][activeMember.key], false);

  const colorMember = field.metadata.structFields.find(member => member.name === 'Color');
  const color = runtime.structReference(element, colorMember);
  const redMember = colorMember.metadata.structFields.find(member => member.name === 'R');
  runtime.structReference(color, redMember).set(255);
  assert.equal(storage[2][colorMember.key][redMember.key], 255);
  assert.equal(storage[1][colorMember.key][redMember.key], 0);

  const clamped = arrayReference(99, fieldReference, warning => warnings.push(warning));
  assert.equal(clamped.arrayIndex, 6);
  assert.equal(warnings.at(-1).clampedIndex, 6);
});
