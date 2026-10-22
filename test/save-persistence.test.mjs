import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB, domException } from './helpers/fake-indexeddb.mjs';
import { createFakeDirectory, putFile } from './helpers/fake-filesystem.mjs';
import { openBrowserStorage, StorageError } from '../src/runtime/browser-storage.mjs';
import { openSavePersistence, saveMode } from '../src/viewer/save-persistence.mjs';
import { describeSaves } from '../src/viewer/saves-ui.mjs';

const bytes = (...values) => new Uint8Array(values);
const parseInfo = data => data[0] === 255 ? null : ({ properties: { saveCount: data[0] }, snapshot: null });
const file = (path, ...values) => ({ webkitRelativePath: path, name: path.split('/').pop(), lastModified: 5, async arrayBuffer() { return bytes(...values).buffer; } });
const open = (fake, options = {}) => openSavePersistence({ mode: 'on', openStorage: () => openBrowserStorage({ indexedDB: fake }), parseInfo, showDirectoryPicker: null, ...options });
const installation = async (permission = 'granted') => {
  const root = createFakeDirectory('Deus Ex', { permission });
  await root.getDirectoryHandle('System', { create: true });
  await putFile(root, 'Save', '.keep', []);                                      // (a file in Save itself is not a save)
  const save = await root.getDirectoryHandle('Save');
  await putFile(save, 'Save0001', 'SaveInfo.dxs', [3]);
  await putFile(save, 'Save0001', '00_Training.dxs', [9, 9, 9]);
  return root;
};

test('saveMode: on for the default start, off for the debugging page, forced either way by ?saves', () => {
  assert.equal(saveMode('', true), 'on');
  assert.equal(saveMode('?debug=1', false), 'off');
  assert.equal(saveMode('?debug=1&saves=on', false), 'on');
  assert.equal(saveMode('?saves=off', true), 'off');
});

test('with saves off nothing is read or kept, and the storage is never opened', async () => {
  const persistence = await openSavePersistence({ mode: 'off', openStorage: () => { throw new Error('opened'); }, parseInfo });
  assert.deepEqual(persistence.simSaves(), []);
  assert.deepEqual([persistence.status().mode, persistence.status().source, persistence.status().canPickFolder], ['off', 'memory', false]);
  assert.equal(describeSaves(persistence.status()).line.startsWith('Saves are not kept'), true);
});

test('by default saves are kept in the browser: an import is listed for the simulation and survives a new page', async () => {
  const fake = createFakeIndexedDB();
  const changes = [];
  const first = await open(fake, { onChange: status => changes.push(status.slots) });
  assert.equal(first.status().source, 'browser');
  assert.deepEqual(first.simSaves(), []);
  const result = await first.importFiles([file('Deus Ex/Save/Save0001/SaveInfo.dxs', 3), file('Deus Ex/Save/Save0001/00_Training.dxs', 1, 2), file('Deus Ex/Save/notes.txt', 0)]);
  assert.deepEqual(result, { written: 2, skipped: ['Deus Ex/Save/notes.txt'] });
  assert.deepEqual(changes, [1], 'the status and the listing are reported after the import');
  const [slot] = first.simSaves();
  assert.deepEqual([slot.directory, slot.files.map(f => `${f.name}:${f.size}`).sort(), slot.info.properties.saveCount], ['Save0001', ['00_Training.dxs:2', 'SaveInfo.dxs:1'], 3]);
  const second = await open(fake);
  assert.deepEqual(second.simSaves().map(s => s.directory), ['Save0001'], 'a new page finds it');
  const zip = await second.exportZip();
  assert.equal(zip.count, 2); assert.equal(zip.name, 'Deus Ex Saves.zip');
  assert.equal(new TextDecoder().decode(zip.bytes).includes('Save/Save0001/SaveInfo.dxs'), true, 'the archive holds the Save folder of the game');
});

test('a picked folder takes over, is remembered, and the game folder\'s own Save is used', async () => {
  const fake = createFakeIndexedDB();
  const root = await installation();
  const first = await open(fake, { showDirectoryPicker: async options => { assert.equal(options.mode, 'readwrite'); return root; } });
  assert.deepEqual([first.status().source, first.status().canPickFolder], ['browser', true]);
  await first.pickFolder();
  const status = first.status();
  assert.deepEqual([status.source, status.folder.name, status.folder.state, status.folder.installed, status.slots], ['folder', 'Deus Ex', 'granted', true, 1]);
  assert.deepEqual(first.simSaves().map(s => s.directory), ['Save0001'], 'the file beside the directories is not a slot');
  assert.equal(describeSaves(status).line, 'Saves are in the Save folder of “Deus Ex” (1 save).');
  // a later visit: the stored handle, permission still granted
  const later = await open(fake);
  assert.deepEqual([later.status().source, later.status().folder.state], ['folder', 'granted']);
  assert.deepEqual(later.simSaves().map(s => s.directory), ['Save0001']);
  // what an import writes lands in the folder, as the original's files
  await later.importFiles([file('Save/Save0002/SaveInfo.dxs', 4)]);
  const save = await root.getDirectoryHandle('Save');
  assert.deepEqual([...(await save.getDirectoryHandle('Save0002')).entries.keys()], ['SaveInfo.dxs']);
  // forgetting the folder hands the saves back to the browser, and leaves the folder's files where they were
  await later.forgetFolder();
  assert.deepEqual([later.status().source, later.status().folder], ['browser', null]);
  assert.deepEqual(later.simSaves(), []);
  assert.ok(save.entries.has('Save0001'));
  assert.equal((await open(fake)).status().source, 'browser', 'and the next visit does not look for it');
});

test('a folder that needs the browser\'s permission again is offered for reconnecting, and until then the browser\'s storage is used', async () => {
  const fake = createFakeIndexedDB();
  const root = await installation('prompt');
  const storage = await openBrowserStorage({ indexedDB: fake });
  await storage.put('handles', { id: 'saves', handle: root, name: root.name });
  storage.close();
  const persistence = await open(fake);
  const status = persistence.status();
  assert.deepEqual([status.source, status.folder.state, status.slots], ['browser', 'prompt', 0]);
  assert.match(status.message, /needs your permission again/);
  await persistence.reconnectFolder();
  assert.deepEqual([persistence.status().source, persistence.status().folder.state, persistence.status().message], ['folder', 'granted', null]);
  assert.deepEqual(persistence.simSaves().map(s => s.directory), ['Save0001']);
  // refused: the state stays and the error is a StorageError the page can show
  const refused = await installation('denied');
  const again = await createFakeIndexedDB();
  const storage2 = await openBrowserStorage({ indexedDB: again });
  await storage2.put('handles', { id: 'saves', handle: refused, name: refused.name });
  const other = await open(again);
  assert.equal(other.status().source, 'browser');
  await assert.rejects(other.reconnectFolder(), { kind: 'denied' });
  assert.equal(other.status().source, 'browser');
});

test('a dismissed picker changes nothing; a folder that cannot be read leaves the browser in charge with the reason', async () => {
  const fake = createFakeIndexedDB();
  const persistence = await open(fake, { showDirectoryPicker: async () => { throw domException('AbortError', 'The user aborted a request.'); } });
  await assert.rejects(persistence.pickFolder(), { kind: 'cancelled' });
  assert.equal(persistence.status().source, 'browser');
  // the stored folder went away between visits
  const gone = createFakeDirectory('Deus Ex');
  gone.values = async function* () { throw domException('NotFoundError', 'gone'); };
  const storage = await openBrowserStorage({ indexedDB: fake });
  await storage.put('handles', { id: 'saves', handle: gone, name: gone.name });
  const later = await open(fake);
  assert.equal(later.status().source, 'browser');
  assert.equal(later.status().folder.state, 'unusable');
  assert.equal(later.status().error.kind, 'missing');
});

test('browser storage that cannot open leaves memory, with the reason, and the page still lists and imports', async () => {
  const persistence = await openSavePersistence({ mode: 'on', parseInfo, showDirectoryPicker: null,
    openStorage: async () => { throw new StorageError('unavailable', 'no storage here'); } });
  assert.deepEqual([persistence.status().source, persistence.status().message], ['memory', 'no storage here']);
  await persistence.importFiles([file('Save/Save0001/SaveInfo.dxs', 1)]);
  assert.equal(persistence.simSaves().length, 1);
  assert.match(describeSaves(persistence.status()).line, /last only until this page closes/);
});

test('the dev server\'s Save folder shows under the page\'s own saves, read-only', async () => {
  const served = new Map([['Save0007/SaveInfo.dxs', bytes(7)], ['QuickSave/SaveInfo.dxs', bytes(2)]]);
  const source = { manifest: async () => ({ files: [...served].map(([path, data]) => { const [dir, name] = path.split('/'); return { dir, name, size: data.length, modified: 1 }; }) }),
    file: async (dir, name) => served.get(`${dir}/${name}`) ?? null };
  const fake = createFakeIndexedDB();
  const persistence = await open(fake, { served: source });
  assert.equal(persistence.status().served, true);
  assert.deepEqual(persistence.simSaves().map(s => `${s.directory}:${s.info.properties.saveCount}`), ['QuickSave:2', 'Save0007:7']);
  await persistence.importFiles([file('Save/Save0007/SaveInfo.dxs', 70)]);
  assert.deepEqual(persistence.simSaves().map(s => `${s.directory}:${s.info.properties.saveCount}`), ['QuickSave:2', 'Save0007:70'], 'the page\'s copy hides the served slot');
  assert.match(describeSaves(persistence.status()).line, /also listed, read-only/);
});

test('a folder changed behind the page (the desktop game saved) is found by a refresh, once', async () => {
  const fake = createFakeIndexedDB();
  const root = await installation();
  const changes = [];
  const persistence = await open(fake, { showDirectoryPicker: async () => root, onChange: status => changes.push(status.slots) });
  await persistence.pickFolder();
  changes.length = 0;
  assert.equal(await persistence.refresh(), false, 'nothing changed');
  await putFile(await root.getDirectoryHandle('Save'), 'Save0002', 'SaveInfo.dxs', [5]);
  assert.equal(await persistence.refresh(), true);
  assert.deepEqual(changes, [2]);
  assert.equal(await persistence.refresh(), false);
  assert.deepEqual(persistence.simSaves().map(s => s.directory), ['Save0001', 'Save0002']);
});

test('a SaveInfo that is not a package lists the directory without info, as the original\'s Load Game screen shows a "save info missing" row', async () => {
  const persistence = await open(createFakeIndexedDB());
  await persistence.importFiles([file('Save/Save0001/SaveInfo.dxs', 255), file('Save/Save0002/SaveInfo.dxs', 6)]);
  assert.deepEqual(persistence.simSaves().map(s => [s.directory, s.info === null]), [['Save0001', true], ['Save0002', false]]);
  assert.equal(persistence.status().slots, 1, 'one save is listed as loadable');
});
