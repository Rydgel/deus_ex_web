import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {arrayReference, propertyReference} from '../src/runtime/script-values.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = path.resolve(process.argv[2] ?? gameDirectory());
const files = [];
for (const directory of ['System', 'Textures', 'Sounds', 'Music', 'Maps']) {
  for (const name of await readdir(path.join(root, directory))) {
    const relative = `${directory}/${name}`;
    files.push({path: relative, read: () => readFile(path.join(root, relative))});
  }
}
const assets = new AssetStore(files);
const runtime = new ScriptRuntime(assets);

async function loadStruct(packageName, exportPath) {
  const asset = await assets.get(packageName);
  const index = asset.exportsByPath.get(exportPath.toLowerCase());
  assert.ok(index, `Missing ${packageName}.${exportPath}`);
  const record = await runtime.objects.resolve(asset, index);
  return {asset, index, record, layout: await runtime.structLayout(record)};
}

function fields(layout) {
  return [...layout.fields.values()].map(field => ({
    name: field.record.name,
    kind: field.kind,
    offset: field.offset,
    elementSize: field.elementSize,
    bitMask: field.bitMask,
  }));
}

const expected = [
  ['DeusEx', 'ScriptedPawn.InventoryItem', 8, [
    ['Inventory', 'ClassProperty', 0, 4, null], ['Count', 'IntProperty', 4, 4, null],
  ]],
  ['DeusEx', 'DeusExRootWindow.S_DataVaultFunction', 16, [
    ['Function', 'StrProperty', 0, 12, null], ['winClass', 'ClassProperty', 12, 4, null],
  ]],
  ['DeusEx', 'MenuScreenCustomizeKeys.S_KeyDisplayItem', 16, [
    ['inputKey', 'ByteProperty', 0, 1, null], ['displayName', 'StrProperty', 4, 12, null],
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
    ['R', 'ByteProperty', 0, 1, null], ['G', 'ByteProperty', 1, 1, null],
    ['B', 'ByteProperty', 2, 1, null], ['A', 'ByteProperty', 3, 1, null],
  ]],
];

const linked = [];
for (const [packageName, exportPath, size, expectedFields] of expected) {
  const result = await loadStruct(packageName, exportPath);
  assert.equal(result.layout.propertiesSize, size, exportPath);
  const actual = fields(result.layout);
  assert.deepEqual(actual, expectedFields.map(([name, kind, offset, elementSize, bitMask]) => ({
    name, kind, offset, elementSize, bitMask,
  })), exportPath);
  linked.push({exportPath, propertiesSize: size, fields: actual});
}

const plane = await loadStruct('Core', 'Object.Plane');
assert.equal(plane.layout.propertiesSize, 16);
assert.deepEqual((await runtime.structFields(plane.record)).map(field => field.name), ['W', 'X', 'Y', 'Z']);
const volume = await loadStruct('Core', 'Object.BoundingVolume');
assert.equal(volume.layout.propertiesSize, 44);
assert.deepEqual(fields(volume.layout), [
  {name: 'Sphere', kind: 'StructProperty', offset: 28, elementSize: 16, bitMask: null},
]);
const sphere = volume.layout.fields.values().next().value;
assert.equal(sphere.record.metadata.structKey, 'core.object.plane');

const boolStruct = await loadStruct('DeusEx', 'Computers.sSpecialOptions');
const bools = [...boolStruct.layout.fields.values()].filter(field => field.kind === 'BoolProperty');
assert.deepEqual(bools.map(field => [field.record.name, field.offset, field.bitMask]), [
  ['bTriggerOnceOnly', 44, 1], ['bAlreadyTriggered', 44, 2],
]);
assert.equal(bools[0].record.metadata.bitMask, null);
assert.equal(bools[1].record.metadata.bitMask, null);

const damage = await assets.get('DeusEx');
const damageClass = await runtime.loadClass(damage, damage.exportsByPath.get('damagehuddisplay'));
const iconField = runtime.lookupMember(damageClass, 'fields', 'IconInfo');
let storage = runtime.defaultValue(damageClass, iconField);
const rootReference = propertyReference(iconField, () => storage, value => { storage = value; });
const element = arrayReference(2, rootReference);
const activeMember = iconField.metadata.structFields.find(member => member.name === 'bActive');
runtime.structReference(element, activeMember).set(true);
const colorMember = iconField.metadata.structFields.find(member => member.name === 'Color');
const colorReference = runtime.structReference(element, colorMember);
const redMember = colorMember.metadata.structFields.find(member => member.name === 'R');
runtime.structReference(colorReference, redMember).set(255);
assert.equal(storage[2][activeMember.key], true);
assert.equal(storage[2][colorMember.key][redMember.key], 255);
assert.equal(storage[1][activeMember.key], false);
assert.equal(storage[1][colorMember.key][redMember.key], 0);

console.log(JSON.stringify({
  packageRoot: root,
  linked,
  inherited: {
    plane: {propertiesSize: plane.layout.propertiesSize, fields: [...plane.layout.fields.values()].map(field => [field.record.name, field.offset])},
    boundingVolume: {propertiesSize: volume.layout.propertiesSize, sphereOffset: sphere.offset, sphereSize: sphere.elementSize},
  },
  packedBools: bools.map(field => ({name: field.record.name, offset: field.offset, bitMask: field.bitMask})),
  runtimeAccess: {arrayDimension: iconField.metadata.arrayDim, elementSize: iconField.metadata.elementSize,
    selectedIndex: element.arrayIndex, selectedAddressOffset: element.addressOffset,
    active: storage[2][activeMember.key], red: storage[2][colorMember.key][redMember.key]},
}, null, 2));
