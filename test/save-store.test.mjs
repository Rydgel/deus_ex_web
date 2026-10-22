import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB, domException } from './helpers/fake-indexeddb.mjs';
import { createFakeDirectory, putFile } from './helpers/fake-filesystem.mjs';
import { openBrowserStorage } from '../src/runtime/browser-storage.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import {
  createMemorySaveBackend, createIndexedDbSaveBackend, createFolderSaveBackend, createStoredSaveDirectory, ensureFolderPermission, folderError,
  pickSaveFolder, savedSaveFolder, importSaveFiles, exportSaveFiles, saveFilePath,
} from '../src/runtime/save-store.mjs';

const bytes = (...values) => new Uint8Array(values);
const parseInfo = data => ({ properties: { saveCount: data[0] }, snapshot: null });

/** The same script against every backend: the interface is one. */
async function exercise(make, label) {
  const backend = await make();
  const directory = await createStoredSaveDirectory({ backend, parseInfo, freeBytes: 1000 });
  assert.deepEqual(directory.directories(), [], `${label}: empty at first`);
  assert.equal(directory.info('Save0001'), null);
  await directory.write('Save0002', '00_Training.dxs', bytes(1, 2, 3, 4, 5, 6, 7, 8));
  await directory.write('Save0001', 'SaveInfo.dxs', bytes(7, 7));
  await directory.write('Save0001', '00_Training.dxs', bytes(9, 9, 9));
  await directory.write('QuickSave', 'SaveInfo.dxs', bytes(4));
  assert.deepEqual(directory.directories(), ['QuickSave', 'Save0001', 'Save0002'], `${label}: sorted without regard to case, as NTFS lists`);
  assert.deepEqual(directory.files('Save0001').sort((a, b) => a.name < b.name ? -1 : 1), [{ name: '00_Training.dxs', size: 3 }, { name: 'SaveInfo.dxs', size: 2 }]);
  assert.deepEqual(directory.info('Save0001'), { properties: { saveCount: 7 }, snapshot: null }, `${label}: SaveInfo.dxs is parsed on write`);
  assert.equal(directory.info('Save0002'), null, 'a directory with no SaveInfo has none');
  assert.deepEqual([...await directory.read('Save0002', '00_Training.dxs')], [1, 2, 3, 4, 5, 6, 7, 8], `${label}: the bytes come back as written`);
  assert.equal(await directory.read('Save0002', 'missing.dxs'), null);
  assert.ok(directory.freeSpaceBytes() < 1000, 'a write takes from the free space the natives see');
  // a new session over the same backend sees the same directory
  const again = await createStoredSaveDirectory({ backend, parseInfo });
  assert.deepEqual(again.directories(), directory.directories());
  assert.deepEqual(again.info('Save0001'), directory.info('Save0001'));
  assert.deepEqual(again.files('Save0002'), [{ name: '00_Training.dxs', size: 8 }]);
  // overwrite, and delete
  await directory.write('Save0001', 'SaveInfo.dxs', bytes(8, 8, 8));
  assert.equal(directory.info('Save0001').properties.saveCount, 8);
  assert.equal(await directory.remove('Save0001', '00_Training.dxs'), true);
  assert.equal(await directory.remove('Save0001', '00_Training.dxs'), false);
  assert.equal(await directory.removeDir('Save0001'), 1, `${label}: DeleteSaveGame removes the directory and its files`);
  assert.deepEqual(directory.directories(), ['QuickSave', 'Save0002']);
  assert.equal(directory.info('Save0001'), null);
  return { backend, directory };
}

test('every backend keeps the Save directory the same way', async () => {
  await exercise(async () => createMemorySaveBackend(), 'memory');
  const fakeIdb = createFakeIndexedDB();
  await exercise(async () => createIndexedDbSaveBackend(await openBrowserStorage({ indexedDB: fakeIdb })), 'indexeddb');
  await exercise(async () => createFolderSaveBackend(createFakeDirectory('Save')), 'folder');
});

test('the stored directory answers the reads the GameDirectory natives make as the in-memory one does', async () => {
  const stored = await createStoredSaveDirectory({ backend: createMemorySaveBackend() });
  const reference = createSaveDirectory();
  for (const [dir, name, size] of [['Save0002', 'a.dxs', 5], ['Save0001', 'SaveInfo.dxs', 2], ['quicksave', 'b.dxs', 9]]) {
    await stored.write(dir, name, new Uint8Array(size));
    reference.put({ directory: dir, files: [{ name, size }] });
  }
  assert.deepEqual(stored.directories(), reference.directories());
  for (const dir of reference.directories()) assert.deepEqual(stored.files(dir), reference.files(dir));
  assert.equal(stored.freeSpaceBytes(), null, 'no figure until the host says');
});

test('the IndexedDB backend survives a reload and a quota failure leaves the file and its row both out', async () => {
  const fake = createFakeIndexedDB();
  const first = await createStoredSaveDirectory({ backend: createIndexedDbSaveBackend(await openBrowserStorage({ indexedDB: fake })) });
  await first.write('Save0001', 'a.dxs', bytes(1, 2, 3));
  fake.failNext('put', domException('QuotaExceededError'), 'savedata');
  await assert.rejects(first.write('Save0002', 'b.dxs', bytes(5, 6)), { kind: 'quota' });
  assert.deepEqual(first.directories(), ['Save0001'], 'a failed write is not in the listing');
  const second = await createStoredSaveDirectory({ backend: createIndexedDbSaveBackend(await openBrowserStorage({ indexedDB: fake })) });
  assert.deepEqual(second.directories(), ['Save0001']);
  assert.deepEqual([...await second.read('Save0001', 'a.dxs')], [1, 2, 3]);
  assert.equal(await createIndexedDbSaveBackend(await openBrowserStorage({ indexedDB: fake })).read('Save0002', 'b.dxs'), null, 'the aborted transaction wrote nothing');
});

test('the IndexedDB backend reports what is left of the quota as the free space', async () => {
  const fake = createFakeIndexedDB();
  const storage = await openBrowserStorage({ indexedDB: fake });
  const real = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { estimate: async () => ({ quota: 1000, usage: 400 }) } } });
  try { assert.equal(await createIndexedDbSaveBackend(storage).freeSpace(), 600); }
  finally { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: real }); }
});

test('a picked folder is the Save directory: listed two levels deep, files untouched, empty directories removed', async () => {
  const root = createFakeDirectory('Save');
  await putFile(root, 'Save0001', 'SaveInfo.dxs', [1]);
  await putFile(root, 'Save0001', '00_Training.dxs', [2, 2]);
  await putFile(root, 'Current', '00_Training.dxs', [3]);
  (await root.getFileHandle('desktop.ini', { create: true })).bytes = bytes(0);           // a file beside the directories is not a save
  const backend = createFolderSaveBackend(root);
  const listing = (await backend.list()).map(({ dir, name, size }) => `${dir}/${name}:${size}`).sort();
  assert.deepEqual(listing, ['Current/00_Training.dxs:1', 'Save0001/00_Training.dxs:2', 'Save0001/SaveInfo.dxs:1']);
  await backend.write('Save0003', 'SaveInfo.dxs', bytes(5, 5, 5));
  assert.deepEqual([...await backend.read('Save0003', 'SaveInfo.dxs')], [5, 5, 5]);
  assert.equal(await backend.remove('Save0003', 'SaveInfo.dxs'), true);
  assert.equal(root.entries.has('Save0003'), false, 'the directory goes with its last file');
  assert.equal(await backend.removeDir('Save0001'), 2);
  assert.ok(root.entries.has('desktop.ini'), 'nothing else in the folder is touched');
  assert.equal(await backend.read('Nope', 'x'), null);
});

test('folder failures: permission, a folder that went away, a write the disk refuses', async () => {
  assert.equal(folderError(domException('NotAllowedError')).kind, 'denied');
  assert.equal(folderError(domException('NotFoundError')).kind, 'missing');
  assert.equal(folderError(domException('AbortError')).kind, 'cancelled');
  assert.equal(folderError(domException('QuotaExceededError')).kind, 'quota');
  assert.match(folderError(domException('NotAllowedError', 'blocked')).message, /permission/);
  const root = createFakeDirectory('Save');
  const backend = createFolderSaveBackend(root);
  root.state.failWrite = domException('QuotaExceededError', 'disk full');
  await assert.rejects(backend.write('Save0001', 'a.dxs', bytes(1)), { kind: 'quota' });
  root.state.failWrite = null;
  root.state.readOnly = true;
  await assert.rejects(backend.write('Save0001', 'b.dxs', bytes(1)), { kind: 'denied' });
  // the permission check: granted, prompt (asked again from a click), denied
  const granted = createFakeDirectory('Save', { permission: 'granted' });
  assert.equal(await ensureFolderPermission(granted), true);
  const prompt = createFakeDirectory('Save', { permission: 'prompt' });
  assert.equal(await ensureFolderPermission(prompt), false, 'not asked without a user activation');
  assert.equal(await ensureFolderPermission(prompt, { request: true }), true);
  const denied = createFakeDirectory('Save', { permission: 'denied' });
  assert.equal(await ensureFolderPermission(denied, { request: true }), false);
});

test('the picked folder\'s handle is kept in IndexedDB for the next visit', async () => {
  const fake = createFakeIndexedDB();
  const storage = await openBrowserStorage({ indexedDB: fake });
  assert.equal(await savedSaveFolder(storage), null);
  const root = createFakeDirectory('Save');
  const picked = await pickSaveFolder(storage, { showDirectoryPicker: async options => { assert.equal(options.mode, 'readwrite'); return root; } });
  assert.equal(picked, root);
  storage.close();
  assert.equal(await savedSaveFolder(await openBrowserStorage({ indexedDB: fake })), root);
  await assert.rejects(pickSaveFolder(storage, { showDirectoryPicker: null }), { kind: 'unavailable' });
  const cancelled = await openBrowserStorage({ indexedDB: fake });
  await assert.rejects(pickSaveFolder(cancelled, { showDirectoryPicker: async () => { throw domException('AbortError', 'The user aborted a request.'); } }), { kind: 'cancelled' });
});

test('import and export without the File System Access API', async () => {
  assert.deepEqual(saveFilePath('Save/Save0001/SaveInfo.dxs'), { dir: 'Save0001', name: 'SaveInfo.dxs' });
  assert.deepEqual(saveFilePath('Save0001\\SaveInfo.dxs'), { dir: 'Save0001', name: 'SaveInfo.dxs' });
  assert.equal(saveFilePath('SaveInfo.dxs'), null);
  const directory = await createStoredSaveDirectory({ backend: createMemorySaveBackend() });
  const file = (path, ...values) => ({ webkitRelativePath: path, name: path.split('/').pop(), lastModified: 5, async arrayBuffer() { return bytes(...values).buffer; } });
  const result = await importSaveFiles(directory, [file('Deus Ex/Save/Save0001/SaveInfo.dxs', 1, 2), file('Deus Ex/Save/QuickSave/00_Training.dxs', 3),
    file('Deus Ex/Save/readme.txt', 9), file('Deus Ex/Save/Other/x.dxs', 9)]);
  assert.deepEqual(result, { written: 2, skipped: ['Deus Ex/Save/readme.txt', 'Deus Ex/Save/Other/x.dxs'] });
  assert.deepEqual(directory.directories(), ['QuickSave', 'Save0001']);
  const out = await exportSaveFiles(directory);
  assert.deepEqual(out.map(entry => [entry.path, [...entry.bytes]]).sort(), [['QuickSave/00_Training.dxs', [3]], ['Save0001/SaveInfo.dxs', [1, 2]]]);
  assert.deepEqual((await exportSaveFiles(directory, { only: ['Save0001'] })).map(entry => entry.path), ['Save0001/SaveInfo.dxs']);
});
