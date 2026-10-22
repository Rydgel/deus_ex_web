import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parsePackage } from '../src/unreal/package.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';
import { writeSaveInfo } from '../src/runtime/save-info-write.mjs';

const PROPERTIES = { Year: 2026, Month: 10, Day: 21, Hour: 6, Minute: 29, Second: 23, DirectoryIndex: 77, Description: 'Untitled',
  MissionLocation: 'NYC - Liberty Island', MapName: '01_NYC_UNATCOIsland', saveCount: 1, saveTime: 135 };
const picture = () => Uint8Array.from({ length: 256 * 128 }, (_, i) => (i % 256 < 160 && (i >> 8) < 120) ? (i * 7) & 255 : 0);
const guid = Uint8Array.from({ length: 16 }, (_, i) => 0x10 + i);

test('the written SaveInfo.dxs reads back: properties, the P8 snapshot and its grey palette', () => {
  const bytes = writeSaveInfo({ properties: PROPERTIES, snapshot: { pitch: 256, height: 128, data: picture() }, guid, internalTime: [5, 6] });
  const info = parseSaveInfo(bytes);
  assert.deepEqual(info.properties, PROPERTIES);
  assert.equal(info.snapshot.texture, 'Texture0'); assert.equal(info.snapshot.palette, 'Palette0');
  assert.deepEqual([info.snapshot.image.width, info.snapshot.image.height, info.snapshot.image.format], [256, 128, 0]);
  assert.deepEqual([...info.snapshot.image.data], [...picture()]);
  assert.deepEqual([...info.snapshot.image.colors], Array.from({ length: 1024 }, (_, i) => i % 4 === 3 ? 255 : i >> 2));
});

test('the package has the measured layout: 33 names, 5 imports, 3 exports with no Outer, flags 0x70000 / 0x70004', () => {
  const bytes = writeSaveInfo({ properties: PROPERTIES, snapshot: { pitch: 256, height: 128, data: picture() }, guid });
  const pkg = parsePackage(bytes);
  assert.equal(pkg.names.length, 33);
  assert.deepEqual(pkg.names.slice(0, 8).map(entry => entry.name), ['None', 'InternalTime', 'VBits', 'VClamp', 'UBits', 'UClamp', 'Palette', 'Description']);
  assert.deepEqual(pkg.names.slice(-3).map(entry => entry.name), ['Texture0', 'Palette0', 'MyDeusExSaveInfo']);
  assert.equal(pkg.names[0].flags, 0x4070410); assert.equal(pkg.names[1].flags, 0x70010); assert.equal(pkg.names[25].flags, 0x4070010);
  assert.deepEqual(pkg.imports.map(entry => entry.path), ['Engine', 'Engine.Texture', 'DeusEx', 'DeusEx.DeusExSaveInfo', 'Engine.Palette']);
  assert.deepEqual(pkg.exports.map(entry => [entry.className, entry.name, entry.outer, entry.flags]),
    [['Texture', 'Texture0', 0, 0x70000], ['Palette', 'Palette0', 0, 0x70000], ['DeusExSaveInfo', 'MyDeusExSaveInfo', 0, 0x70004]]);
  assert.equal(bytes.length, 34569, 'the size of the measured Save0077 file');
});

test('a Palette before the Texture (the older desktop saves), cheats on, QuickSave\'s index, a description with other characters', () => {
  const properties = { ...PROPERTIES, DirectoryIndex: -1, Description: 'Quick Save', bCheatsEnabled: true };
  const bytes = writeSaveInfo({ properties, snapshot: { pitch: 256, height: 128, data: picture() }, guid, textureName: 'Texture3', paletteName: 'Palette3', textureFirst: false });
  const pkg = parsePackage(bytes);
  assert.deepEqual(pkg.exports.map(entry => entry.name), ['Palette3', 'Texture3', 'MyDeusExSaveInfo']);
  const info = parseSaveInfo(bytes);
  assert.deepEqual(info.properties, properties);
  assert.equal(info.snapshot.texture, 'Texture3');
  const wide = parseSaveInfo(writeSaveInfo({ properties: { ...PROPERTIES, Description: 'Sauvegarde été' }, snapshot: { pitch: 256, height: 128, data: picture() }, guid }));
  assert.equal(wide.properties.Description, 'Sauvegarde été');
});

test('defaults are not stored; without a snapshot the package holds only the SaveInfo (the OpenGL form)', () => {
  const bytes = writeSaveInfo({ properties: { ...PROPERTIES, saveTime: 0, Description: '' }, snapshot: null, guid });
  const pkg = parsePackage(bytes);
  assert.deepEqual(pkg.exports.map(entry => entry.className), ['DeusExSaveInfo']);
  const info = parseSaveInfo(bytes);
  assert.equal(info.properties.saveTime, undefined); assert.equal(info.properties.Description, undefined);
  assert.equal(info.snapshot, null);
});

const MEASURED = '../.work/travel';
const real = new URL(`${MEASURED}/dxs/save77-SaveInfo.dxs`, import.meta.url);
test('given the original\'s GUID, time, pixels and names, the writer reproduces the Wine session\'s Save0077 SaveInfo.dxs byte for byte', { skip: !existsSync(real) }, () => {
  const bytes = new Uint8Array(readFileSync(real));
  const pkg = parsePackage(bytes), info = parseSaveInfo(bytes);
  const texture = pkg.exports.findIndex(entry => entry.className === 'Texture');
  const values = readObject(pkg, bytes, texture + 1).values;
  const out = writeSaveInfo({ properties: info.properties, snapshot: { pitch: 256, height: 128, data: info.snapshot.image.data }, textureFirst: texture === 0,
    guid: Uint8Array.from(Buffer.from(pkg.guid, 'hex')), textureName: info.snapshot.texture, paletteName: info.snapshot.palette,
    internalTime: [values.InternalTime, values['InternalTime[1]']] });
  assert.equal(out.length, bytes.length);
  assert.deepEqual([...out], [...bytes]);
});
