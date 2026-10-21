import test from 'node:test';
import assert from 'node:assert/strict';
import {createSaveDirectory, saveSlotDirectory, wildcardMatch, saveDirectoryKilobytes, saveFreeKilobytes, newSaveFileIndex,
  generateSaveFilename, hostSaveDirectory, DEFAULT_FREE_BYTES} from '../src/runtime/save-directory.mjs';
import {primeSaveDirectoryHost} from '../src/viewer/save-directory-host.mjs';
import {msvcrtWtoi} from '../src/runtime/script-text-parser.mjs';

test('a slot index names its directory as GetSaveInfo does: -1 is QuickSave, the rest Save%04d', () => {
  assert.equal(saveSlotDirectory(-1), 'QuickSave');
  assert.equal(saveSlotDirectory(0), 'Save0000');
  assert.equal(saveSlotDirectory(1), 'Save0001');
  assert.equal(saveSlotDirectory(12345), 'Save12345');
  assert.equal(saveSlotDirectory(-2), 'Save-002', 'the C format pads the sign into the width');
});

test('FindFirstFile wildcards: Save* matches Save directories only, case-insensitively', () => {
  const names = ['Current', 'QuickSave', 'Save0001', 'save0002', 'SaveInfo.dxs'];
  assert.deepEqual(names.filter(name => wildcardMatch('Save*', name)), ['Save0001', 'save0002', 'SaveInfo.dxs']);
  assert.equal(wildcardMatch('*.*', 'SaveInfo.dxs'), true);
  assert.equal(wildcardMatch('Save????', 'Save0001'), true);
  assert.equal(wildcardMatch('Save?', 'Save0001'), false);
});

test('GetSaveDirectorySize: each file is divided by 1024 as a signed int and the sum is an int (the measured saves, 4 MB on the screen)', () => {
  assert.equal(saveDirectoryKilobytes([{size: 3268631}, {size: 34576}]), 3192 + 33);
  assert.equal(saveDirectoryKilobytes([{size: 1023}]), 0);
  assert.equal(saveDirectoryKilobytes([{size: 1024}]), 1);
  assert.equal(saveDirectoryKilobytes([{size: -1}]), 0, 'a failed FileSize (-1) rounds toward zero');
  assert.equal(saveDirectoryKilobytes([]), 0);
});

test('GetSaveFreeSpace: free bytes / 1024 as a signed 64-bit division, returned as an int; a failed call is 0', () => {
  assert.equal(saveFreeKilobytes(92745808 * 1024), 92745808);
  assert.equal(saveFreeKilobytes(92745808 * 1024 + 1023), 92745808);
  assert.equal(saveFreeKilobytes(null), 0);
  assert.equal(saveFreeKilobytes(2 ** 41), 2 ** 31 | 0, 'beyond 2 TiB the original\'s int wraps (the browser input is capped below it)');
});

test('GetNewSaveFileIndex reads the number from the sixth character of the match (a bug of the original: Save1234 is 234)', () => {
  assert.equal(newSaveFileIndex([], msvcrtWtoi), 1);
  assert.equal(newSaveFileIndex(['Save0001'], msvcrtWtoi), 2);
  assert.equal(newSaveFileIndex(['Save0001', 'Save0007', 'Save0003'], msvcrtWtoi), 8);
  assert.equal(newSaveFileIndex(['Save0100'], msvcrtWtoi), 101);
  assert.equal(newSaveFileIndex(['Save1234'], msvcrtWtoi), 235);
  assert.equal(newSaveFileIndex(['Current', 'QuickSave'], msvcrtWtoi), 1, 'QuickSave contains "Save" but nothing numeric follows it');
});

test('GenerateSaveFilename formats "%s%04d.%s"', () => {
  assert.equal(generateSaveFilename(1), 'Save0001.dxs');
  assert.equal(generateSaveFilename(12), 'Save0012.dxs');
  assert.equal(generateSaveFilename(1, 'tmp'), 'Save0001.tmp');
});

test('the in-memory Save directory is empty by default, lists directories in name order and copies what it returns', () => {
  const empty = createSaveDirectory();
  assert.deepEqual(empty.directories(), []);
  assert.deepEqual(empty.files('Save0001'), []);
  assert.equal(empty.info('QuickSave'), null);
  assert.equal(empty.freeSpaceBytes(), null);
  const directory = createSaveDirectory({freeSpaceBytes: () => 5, saves: [{directory: 'Save0002'}, {directory: 'QuickSave', files: [{name: 'a.dxs', size: 7}]}, {directory: 'Save0001'}]});
  assert.deepEqual(directory.directories(), ['QuickSave', 'Save0001', 'Save0002']);
  directory.files('QuickSave')[0].size = 99;
  assert.equal(directory.files('QuickSave')[0].size, 7);
  assert.equal(directory.freeSpaceBytes(), 5);
  directory.remove('Save0002');
  assert.deepEqual(directory.directories(), ['QuickSave', 'Save0001']);
});

test('the host free space: StorageManager.estimate() when there is one (quota - usage, capped), else the fixed default', async () => {
  const directory = createSaveDirectory({freeSpaceBytes: DEFAULT_FREE_BYTES});
  assert.deepEqual(await primeSaveDirectoryHost({storage: undefined, directory}), {source: 'default'});
  assert.equal(directory.freeSpaceBytes(), DEFAULT_FREE_BYTES);
  const result = await primeSaveDirectoryHost({storage: {estimate: async () => ({quota: 1000 * 1024, usage: 300 * 1024})}, directory});
  assert.equal(result.source, 'StorageManager.estimate');
  assert.equal(directory.freeSpaceBytes(), 700 * 1024);
  await primeSaveDirectoryHost({storage: {estimate: async () => ({quota: 10 * 2 ** 40, usage: 0})}, directory});
  assert.equal(saveFreeKilobytes(directory.freeSpaceBytes()), 2 ** 31 - 1, 'capped at what the int can hold');
  await primeSaveDirectoryHost({storage: {estimate: async () => ({quota: 5, usage: 9})}, directory});
  assert.equal(directory.freeSpaceBytes(), 0);
  assert.deepEqual(await primeSaveDirectoryHost({storage: {estimate: async () => { throw new Error('no'); }}, directory}), {source: 'default'});
  assert.equal(hostSaveDirectory(), hostSaveDirectory(), 'one directory per realm');
});
