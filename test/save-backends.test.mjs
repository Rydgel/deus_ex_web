import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDirectory } from './helpers/fake-filesystem.mjs';
import {
  createMemorySaveBackend, createFolderSaveBackend, createStoredSaveDirectory, resolveSaveFolder, createServedSaveBackend, createLayeredSaveBackend,
} from '../src/runtime/save-store.mjs';

const bytes = (...values) => new Uint8Array(values);

test('the picked folder may be the installation: its Save folder is used, created by the first write, and nothing else in it is touched', async () => {
  const install = createFakeDirectory('Deus Ex');
  await install.getDirectoryHandle('System', { create: true });
  await install.getDirectoryHandle('Maps', { create: true });
  const place = await resolveSaveFolder(install);
  assert.deepEqual([place.installed, place.root, place.name], [true, null, 'Save'], 'no Save folder yet: nothing to read, nothing created');
  const backend = createFolderSaveBackend(place);
  assert.deepEqual(await backend.list(), []);
  assert.equal(await backend.read('Save0001', 'SaveInfo.dxs'), null);
  assert.equal(await backend.remove('Save0001', 'SaveInfo.dxs'), false);
  assert.equal(install.entries.has('Save'), false, 'reading created nothing');
  await backend.write('Save0001', 'SaveInfo.dxs', bytes(4, 5));
  assert.deepEqual([...install.entries.keys()].sort(), ['Maps', 'Save', 'System']);
  assert.deepEqual([...await backend.read('Save0001', 'SaveInfo.dxs')], [4, 5]);
  // the same folder on a later visit has its Save, whatever case the file system gave it
  const again = await resolveSaveFolder(install);
  assert.equal(again.root.name, 'Save');
  // a folder with no System directory is the Save directory itself
  const plain = createFakeDirectory('My saves');
  const own = await resolveSaveFolder(plain);
  assert.deepEqual([own.installed, own.root], [false, plain]);
});

test('the dev server\'s Save folder is a read-only backend; layered under the page\'s own saves, a directory the page holds hides the served one', async () => {
  const served = new Map([['Save0001/SaveInfo.dxs', bytes(1)], ['Save0001/00_Training.dxs', bytes(1, 1)], ['QuickSave/SaveInfo.dxs', bytes(2)]]);
  const readOnly = createServedSaveBackend({
    manifest: async () => ({ files: [...served].map(([path, data]) => { const [dir, name] = path.split('/'); return { dir, name, size: data.length, modified: 7 }; }) }),
    file: async (dir, name) => served.get(`${dir}/${name}`) ?? null,
  });
  assert.equal((await readOnly.list()).length, 3);
  assert.deepEqual([...await readOnly.read('QuickSave', 'SaveInfo.dxs')], [2]);
  assert.equal(await readOnly.read('Save0009', 'SaveInfo.dxs'), null);
  for (const attempt of [() => readOnly.write('Save0002', 'a.dxs', bytes(1)), () => readOnly.remove('Save0001', 'SaveInfo.dxs'), () => readOnly.removeDir('Save0001')])
    await assert.rejects(attempt(), { kind: 'denied' });

  const own = createMemorySaveBackend();
  const layered = createLayeredSaveBackend(own, readOnly);
  assert.deepEqual((await layered.list()).map(f => `${f.dir}/${f.name}`).sort(), ['QuickSave/SaveInfo.dxs', 'Save0001/00_Training.dxs', 'Save0001/SaveInfo.dxs']);
  assert.deepEqual([...await layered.read('Save0001', 'SaveInfo.dxs')], [1], 'read from the served folder');
  await layered.write('save0001', 'SaveInfo.dxs', bytes(9, 9));                       // the page's copy of the slot (names compare without regard to case, as NTFS's)
  assert.deepEqual((await layered.list()).map(f => `${f.dir}/${f.name}:${f.size}`).sort(), ['QuickSave/SaveInfo.dxs:1', 'save0001/SaveInfo.dxs:2'], 'its directory hides the served one whole');
  assert.deepEqual([...await layered.read('save0001', 'SaveInfo.dxs')], [9, 9]);
  assert.equal(await layered.read('save0001', '00_Training.dxs'), null, 'a file only the hidden directory has is not there');
  await assert.rejects(layered.remove('QuickSave', 'SaveInfo.dxs'), { kind: 'denied' });
  await assert.rejects(layered.removeDir('QuickSave'), { kind: 'denied' });
  assert.equal(await layered.removeDir('save0001'), 1);
  assert.equal((await layered.list()).length, 3, 'with the page\'s copy gone the served slot shows again');
  const directory = await createStoredSaveDirectory({ backend: layered, parseInfo: data => ({ properties: { saveCount: data[0] }, snapshot: null }) });
  assert.deepEqual(directory.directories(), ['QuickSave', 'Save0001']);
  assert.equal(directory.info('QuickSave').properties.saveCount, 2);
});

test('a SaveInfo that cannot be read leaves the other slots listed, and its own as a directory without info', async () => {
  const backend = createMemorySaveBackend();
  await backend.write('Save0001', 'SaveInfo.dxs', bytes(1));
  await backend.write('Save0002', 'SaveInfo.dxs', bytes(2));
  const flaky = { ...backend, read: async (dir, name) => { if (dir === 'Save0001') throw new Error('locked'); return backend.read(dir, name); } };
  const directory = await createStoredSaveDirectory({ backend: flaky, parseInfo: data => data[0] === 2 ? { properties: {}, snapshot: null } : null });
  assert.deepEqual(directory.directories(), ['Save0001', 'Save0002']);
  assert.equal(directory.info('Save0001'), null);
  assert.notEqual(directory.info('Save0002'), null);
});
