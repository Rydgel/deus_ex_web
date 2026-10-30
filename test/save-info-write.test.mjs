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
  assert.equal(pkg.names.at(0).flags, 0x4070410); assert.equal(pkg.names.at(1).flags, 0x70010); assert.equal(pkg.names.at(25).flags, 0x4070010);
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

test('the order of the object names at the end of the name table is the caller\'s (process history), the rest is fixed', () => {
  const picture_ = { pitch: 256, height: 128, data: picture() };
  const names = nameTail => parsePackage(writeSaveInfo({ properties: PROPERTIES, snapshot: picture_, guid, nameTail })).names.map(entry => entry.name).slice(30);
  assert.deepEqual(names(null), ['Texture0', 'Palette0', 'MyDeusExSaveInfo']);
  assert.deepEqual(names(['Palette0', 'Texture0', 'MyDeusExSaveInfo']), ['Palette0', 'Texture0', 'MyDeusExSaveInfo']);
  assert.deepEqual(names(['Texture0', 'MyDeusExSaveInfo', 'Palette0']), ['Texture0', 'MyDeusExSaveInfo', 'Palette0']);
  assert.throws(() => names(['Texture0', 'Palette0']), /name tail/);
});

test('a time stamp field of 0 is not stored and its name is not in the table (32 names, as 4 of the 41 internet saves have)', () => {
  const bytes = writeSaveInfo({ properties: { ...PROPERTIES, Hour: 0 }, snapshot: { pitch: 256, height: 128, data: picture() }, guid });
  const pkg = parsePackage(bytes);
  assert.equal(pkg.names.length, 32);
  assert.equal(pkg.names.some(entry => entry.name === 'Hour'), false);
  assert.equal(parseSaveInfo(bytes).properties.Hour, undefined);
});

const MEASURED = '../.work/travel';
/** Write what an original file holds from its own values (GUID, InternalTime, pixels, names and their process-history orders). */
const rewrite = bytes => {
  const pkg = parsePackage(bytes), info = parseSaveInfo(bytes);
  const texture = pkg.exports.findIndex(entry => entry.className === 'Texture');
  const values = readObject(pkg, bytes, texture + 1).values;
  return writeSaveInfo({ properties: info.properties, snapshot: { pitch: 256, height: 128, data: info.snapshot.image.data }, textureFirst: texture === 0,
    guid: Uint8Array.from(Buffer.from(pkg.guid, 'hex')), textureName: info.snapshot.texture, paletteName: info.snapshot.palette,
    internalTime: [values.InternalTime, values['InternalTime[1]']], nameTail: pkg.names.slice(pkg.names.findIndex(entry => entry.name === 'Core') + 1).map(entry => entry.name) });
};
for (const [label, file] of [['the Wine session\'s Save0077', 'dxs/save77-SaveInfo.dxs'], ['a SaveGame 5 of a fresh Training (wa5, cheats off)', 'wa5/wa5.Save0005/SaveInfo.dxs'],
  ['a SaveGame 6 with the cheat flag on (wa5): bCheatsEnabled\'s tag and name', 'wa5/wa6.Save0006/SaveInfo.dxs'], ['a QuickSave (wa5)', 'wa5/waq.QuickSave/SaveInfo.dxs']]) {
  const real = new URL(`${MEASURED}/${file}`, import.meta.url);
  test(`given the original's GUID, time, pixels and names, the writer reproduces ${label} byte for byte`, { skip: !existsSync(real) }, () => {
    const bytes = new Uint8Array(readFileSync(real));
    const out = rewrite(bytes);
    assert.equal(out.length, bytes.length);
    assert.deepEqual([...out], [...bytes]);
  });
}

test('bCheatsEnabled: the last tag, its name between Snapshot and DirectoryIndex, 34 names (measured in the original\'s Save0006)', () => {
  const bytes = writeSaveInfo({ properties: { ...PROPERTIES, bCheatsEnabled: true }, snapshot: { pitch: 256, height: 128, data: picture() }, guid });
  const pkg = parsePackage(bytes);
  assert.equal(pkg.names.length, 34);
  assert.deepEqual(pkg.names.slice(19, 22).map(entry => entry.name), ['Snapshot', 'bCheatsEnabled', 'DirectoryIndex']);
  assert.equal(parseSaveInfo(bytes).properties.bCheatsEnabled, true);
});

test('the comparison with an original places every differing byte in a host input, after putting the process-history orders right (scripts/save-info-diff.mjs)', async () => {
  const { explainSaveInfoDifferences } = await import('../scripts/save-info-diff.mjs');
  const original = writeSaveInfo({ properties: PROPERTIES, snapshot: { pitch: 256, height: 128, data: picture() }, guid, textureName: 'Texture1', paletteName: 'Palette1', textureFirst: false,
    nameTail: ['Palette1', 'Texture1', 'MyDeusExSaveInfo'], internalTime: [5, 6] });
  const other = Uint8Array.from(picture(), (value, i) => (i % 256 < 160 && (i >> 8) < 120) ? 255 - value : 0);
  const play = writeSaveInfo({ properties: { ...PROPERTIES, Second: 24, saveTime: 136 }, snapshot: { pitch: 256, height: 128, data: other }, guid: Uint8Array.from(guid, v => v ^ 255),
    textureName: 'Texture1', paletteName: 'Palette1', textureFirst: true, nameTail: ['Texture1', 'Palette1', 'MyDeusExSaveInfo'], internalTime: [9, 10] });
  const diff = explainSaveInfoDifferences(play, original);
  assert.equal(diff.sameLayout, true); assert.equal(diff.reordered, true);
  assert.deepEqual(diff.unexpected, []);
  assert.deepEqual(diff.groups.map(group => group.label).sort(), ['DeusExSaveInfo.Second', 'DeusExSaveInfo.saveTime', 'Texture.InternalTime', 'Texture.InternalTime[1]', 'Texture: the snapshot\'s pixels', 'package GUID'].sort());
  // a property that is not a host input is caught
  const wrong = writeSaveInfo({ properties: { ...PROPERTIES, Description: 'Other text!' }, snapshot: { pitch: 256, height: 128, data: picture() }, guid, textureName: 'Texture1', paletteName: 'Palette1', textureFirst: false,
    nameTail: ['Palette1', 'Texture1', 'MyDeusExSaveInfo'], internalTime: [5, 6] });
  assert.equal(explainSaveInfoDifferences(wrong, original).sameLayout, false);
  const same = writeSaveInfo({ properties: { ...PROPERTIES, MissionLocation: 'NYC - Liberty Islanc' }, snapshot: { pitch: 256, height: 128, data: picture() }, guid, textureName: 'Texture1', paletteName: 'Palette1', textureFirst: false,
    nameTail: ['Palette1', 'Texture1', 'MyDeusExSaveInfo'], internalTime: [5, 6] });
  assert.deepEqual(explainSaveInfoDifferences(same, original).unexpected.map(entry => entry.label), ['DeusExSaveInfo.MissionLocation']);
});
