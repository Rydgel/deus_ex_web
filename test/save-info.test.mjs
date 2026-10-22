import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSaveInfo } from './helpers/save-info-fixture.mjs';
import { parseSaveInfo, snapshotPixels } from '../src/runtime/save-info.mjs';

const PROPERTIES = { Year: 2026, Month: 9, Day: 12, Hour: 14, Minute: 47, Second: 33, DirectoryIndex: 1, Description: 'UNATCO Training Course',
  MissionLocation: 'UNATCO Training Course', MapName: '00_training', saveCount: 1, saveTime: 983 };
const grey = Uint8Array.from({ length: 256 * 4 }, (_, i) => i % 4 === 3 ? 255 : i >> 2);
const picture = (width, height) => Uint8Array.from({ length: width * height }, (_, i) => (i * 7) & 255);

test('a SaveInfo.dxs gives its DeusExSaveInfo properties and the P8 snapshot with its palette', () => {
  const bytes = buildSaveInfo({ properties: PROPERTIES, snapshot: { width: 256, height: 128, data: picture(256, 128), colors: grey } });
  const info = parseSaveInfo(bytes);
  assert.deepEqual(info.properties, PROPERTIES);
  assert.equal(info.snapshot.texture, 'Texture1'); assert.equal(info.snapshot.palette, 'Palette1');
  assert.deepEqual([info.snapshot.image.width, info.snapshot.image.height, info.snapshot.image.format], [256, 128, 0]);
  assert.deepEqual([...info.snapshot.image.data], [...picture(256, 128)]);
  assert.deepEqual([...info.snapshot.image.colors], [...grey]);
});

test('a property equal to the class default is not stored: bCheatsEnabled appears only when set', () => {
  assert.equal(parseSaveInfo(buildSaveInfo({ properties: PROPERTIES })).properties.bCheatsEnabled, undefined);
  assert.equal(parseSaveInfo(buildSaveInfo({ properties: { ...PROPERTIES, bCheatsEnabled: true } })).properties.bCheatsEnabled, true);
});

test('a SaveInfo without a Snapshot has none; a texture in a form this reader does not decode keeps its names and no picture', () => {
  assert.equal(parseSaveInfo(buildSaveInfo({ properties: PROPERTIES })).snapshot, null);
  const rgb = parseSaveInfo(buildSaveInfo({ properties: PROPERTIES, snapshot: { width: 8, height: 8, data: new Uint8Array(8 * 8 * 3), colors: grey, format: 4 } }));
  assert.equal(rgb.snapshot.texture, 'Texture1'); assert.equal(rgb.snapshot.image, null);
});

test('bytes that are not a SaveInfo package give null, as StaticLoadObject of a bad file does', () => {
  assert.equal(parseSaveInfo(new Uint8Array(0)), null);
  assert.equal(parseSaveInfo(new Uint8Array(200)), null);
  const bytes = buildSaveInfo({ properties: PROPERTIES, snapshot: { width: 8, height: 8, data: picture(8, 8), colors: grey } });
  assert.equal(parseSaveInfo(bytes.subarray(0, bytes.length - 40)), null, 'a truncated package');
});

test('the snapshot pixels are the palette applied to the P8 indices; index zero keeps its colour with alpha zero (the HUD\'s point decode)', () => {
  const colors = Uint8Array.from([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, ...new Array(253 * 4).fill(0)]);
  const { width, height, data } = snapshotPixels({ width: 2, height: 2, data: Uint8Array.from([0, 1, 2, 1]), colors });
  assert.deepEqual([width, height], [2, 2]);
  assert.deepEqual([...data], [10, 20, 30, 0, 40, 50, 60, 255, 70, 80, 90, 255, 40, 50, 60, 255]);
});
