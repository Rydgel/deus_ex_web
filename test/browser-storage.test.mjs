import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB, domException } from './helpers/fake-indexeddb.mjs';
import { openBrowserStorage, classifyStorageError, StorageError, STORAGE_FORMAT, DATABASE_VERSION } from '../src/runtime/browser-storage.mjs';
import { openConfigPersistence, persistenceMode } from '../src/runtime/config-persistence.mjs';
import { encodeIniText, decodeIniBytes } from '../src/runtime/ini-bytes.mjs';
import { createConfigStore } from '../src/runtime/config-store.mjs';

const text = value => encodeIniText(value);
const openWith = indexedDB => () => openBrowserStorage({ indexedDB, timeoutMs: 20 });
const USER = '[DeusEx.DeusExPlayer]\r\nbAskedToTrain=False\r\n\r\n';

test('a new database gets its stores and the format row; a second open keeps the rows', async () => {
  const fake = createFakeIndexedDB();
  const storage = await openBrowserStorage({ indexedDB: fake });
  assert.equal(storage.version, DATABASE_VERSION);
  assert.equal(await storage.format(), STORAGE_FORMAT);
  assert.deepEqual([...fake.databases.get('deusex-web').stores.keys()], ['meta', 'ini', 'saves', 'savedata', 'handles']);
  await storage.put('ini', { leaf: 'user.ini', bytes: text(USER), base: new Uint8Array(0) });
  await storage.put('saves', { dir: 'Save0001', name: 'SaveInfo.dxs', bytes: new Uint8Array([1, 2, 3]), size: 3 });
  await storage.put('saves', { dir: 'Save0002', name: 'SaveInfo.dxs', bytes: new Uint8Array([4]), size: 1 });
  storage.close();
  const again = await openBrowserStorage({ indexedDB: fake });
  assert.equal((await again.getAll('ini')).length, 1);
  assert.deepEqual((await again.getAllByIndex('saves', 'dir', 'Save0001')).map(row => row.size), [3], 'the dir index finds a directory\'s files');
  assert.equal(await again.count('saves'), 2);
  assert.ok((await again.get('ini', 'user.ini')).bytes instanceof Uint8Array);
  await again.delete('saves', ['Save0002', 'SaveInfo.dxs']);
  assert.equal(await again.count('saves'), 1);
  await again.clear('saves');
  assert.equal(await again.count('saves'), 0);
});

test('failures are classified by the name the browser gives them', () => {
  for (const [name, kind] of [['QuotaExceededError', 'quota'], ['VersionError', 'newer'], ['SecurityError', 'blocked'], ['InvalidStateError', 'unavailable'],
    ['UnknownError', 'unavailable'], ['AbortError', 'failed'], ['DataError', 'failed']])
    assert.equal(classifyStorageError(domException(name)), kind, name);
  assert.equal(classifyStorageError(Object.assign(domException('AbortError', 'Quota exceeded while committing')), 'x'), 'quota');
  assert.equal(classifyStorageError(new StorageError('closed', 'x')), 'closed');
});

test('open failures: no IndexedDB, blocked storage, a private window, a newer database, an open that never answers', async () => {
  await assert.rejects(openBrowserStorage({ indexedDB: null }), { kind: 'unavailable' });
  const blocked = createFakeIndexedDB(); blocked.openThrows = domException('SecurityError', 'The operation is insecure.');
  await assert.rejects(openBrowserStorage({ indexedDB: blocked }), { kind: 'blocked' });
  const privateWindow = createFakeIndexedDB(); privateWindow.openError = domException('InvalidStateError', 'A mutation operation was attempted on a database that did not allow mutations.');
  await assert.rejects(openBrowserStorage({ indexedDB: privateWindow }), error => error.kind === 'unavailable' && /private window/.test(error.message));
  const newer = createFakeIndexedDB();
  newer.databases.set('deusex-web', { version: DATABASE_VERSION + 1, stores: new Map() });
  await assert.rejects(openBrowserStorage({ indexedDB: newer }), { kind: 'newer' });
  const stuck = createFakeIndexedDB(); stuck.openBlocks = true;
  await assert.rejects(openBrowserStorage({ indexedDB: stuck, timeoutMs: 10 }), { kind: 'blocked' });
});

test('a write that fails with a quota error rejects as `quota` and leaves what was stored', async () => {
  const fake = createFakeIndexedDB();
  const storage = await openBrowserStorage({ indexedDB: fake });
  await storage.put('ini', { leaf: 'user.ini', bytes: text(USER), base: new Uint8Array(0) });
  fake.failNext('put', domException('QuotaExceededError', 'The quota has been exceeded.'), 'saves');
  await assert.rejects(storage.put('saves', { dir: 'Save0001', name: 'a', bytes: new Uint8Array(8), size: 8 }), { kind: 'quota' });
  assert.equal((await storage.getAll('ini')).length, 1);
  assert.equal(await storage.count('saves'), 0);
  await storage.put('saves', { dir: 'Save0001', name: 'a', bytes: new Uint8Array(8), size: 8 });
  assert.equal(await storage.count('saves'), 1, 'the next write works');
});

test('a closed connection (another tab upgraded the database) fails with `closed`', async () => {
  const fake = createFakeIndexedDB();
  const storage = await openBrowserStorage({ indexedDB: fake });
  let heard = null; storage.onClose(reason => { heard = reason; });
  fake.databases.get('deusex-web');
  storage.close();
  assert.equal(heard, 'close');
  await assert.rejects(storage.getAll('ini'), { kind: 'closed' });
});

test('persistenceMode: on for the default start, off for ?debug=1, forced either way by ?persist', () => {
  assert.equal(persistenceMode('', true), 'on');
  assert.equal(persistenceMode('?debug=1', false), 'off');
  assert.equal(persistenceMode('?debug=1&persist=1', false), 'on');
  assert.equal(persistenceMode('?persist=0', true), 'off');
  assert.equal(persistenceMode('?persist=reset', true), 'reset');
  assert.equal(persistenceMode('?persist=reset', false), 'reset');
});

test('persistence off has no store; on keeps each written file across a new page', async () => {
  const off = await openConfigPersistence({ mode: 'off' });
  assert.equal(off.store, null);
  assert.equal(off.status().state, 'off');

  const fake = createFakeIndexedDB();
  const first = await openConfigPersistence({ mode: 'on', openStorage: openWith(fake) });
  assert.equal(first.status().state, 'on');
  assert.equal(first.store.has('user.ini'), false, 'a first visit keeps nothing');
  first.store.layer('user.ini', text(USER));
  first.store.write('User.ini', USER.replace('False', 'True'));
  await first.flush();
  first.close();
  // a reload
  const second = await openConfigPersistence({ mode: 'on', openStorage: openWith(fake) });
  assert.equal(decodeIniBytes(second.store.layer('user.ini', text(USER))), USER.replace('False', 'True'));
  // a reset forgets it, in memory and in storage
  await second.reset();
  assert.equal(decodeIniBytes(second.store.layer('user.ini', text(USER))), USER);
  second.close();
  const third = await openConfigPersistence({ mode: 'on', openStorage: openWith(fake) });
  assert.equal(third.store.has('user.ini'), false);
  // ?persist=reset forgets what was kept at the start and keeps from then on
  third.store.layer('user.ini', text(USER));
  third.store.write('User.ini', USER.replace('False', 'True')); await third.flush(); third.close();
  const fourth = await openConfigPersistence({ mode: 'reset', openStorage: openWith(fake) });
  assert.equal(fourth.store.has('user.ini'), false);
  fourth.store.layer('user.ini', text(USER)); fourth.store.write('User.ini', USER.replace('False', 'maybe')); await fourth.flush();
  assert.equal(decodeIniBytes((await (await openBrowserStorage({ indexedDB: fake })).get('ini', 'user.ini')).bytes), USER.replace('False', 'maybe'));
});

test('rows that are not a kept file are ignored', async () => {
  const fake = createFakeIndexedDB();
  const storage = await openBrowserStorage({ indexedDB: fake });
  await storage.put('ini', { leaf: 'user.ini', bytes: 'not bytes', base: null });
  await storage.put('ini', { leaf: 'detected.ini', bytes: text('[A]\r\n'), base: text('') });
  await storage.put('ini', { leaf: 'deusex.ini', bytes: text('[A]\r\nK=1\r\n'), base: text('[A]\r\n') });
  storage.close();
  const persistence = await openConfigPersistence({ mode: 'on', openStorage: openWith(fake) });
  assert.deepEqual([...persistence.store.snapshot().keys()], ['deusex.ini']);
});

test('storage that cannot open leaves the page on the installed files, and says why', async () => {
  const seen = [];
  for (const [setup, kind] of [[fake => { fake.openThrows = domException('SecurityError'); }, 'blocked'],
    [fake => { fake.openError = domException('InvalidStateError'); }, 'unavailable'],
    [fake => { fake.databases.set('deusex-web', { version: 9, stores: new Map() }); }, 'newer']]) {
    const fake = createFakeIndexedDB(); setup(fake);
    const persistence = await openConfigPersistence({ mode: 'on', openStorage: openWith(fake), onStatus: status => seen.push(status.kind) });
    assert.equal(persistence.status().state, 'unavailable');
    assert.equal(persistence.status().kind, kind);
    assert.ok(persistence.status().message.length > 20, 'a message the page can show');
    // the game still writes, and the store keeps it for this page
    persistence.store.layer('user.ini', text(USER));
    persistence.store.write('User.ini', USER.replace('False', 'True'));
    assert.equal(decodeIniBytes(persistence.store.layer('user.ini', text(USER))), USER.replace('False', 'True'), 'settings last as long as the page');
    await persistence.flush();
  }
  assert.deepEqual(seen, ['blocked', 'unavailable', 'newer']);
  const none = await openConfigPersistence({ mode: 'on', openStorage: () => openBrowserStorage({ indexedDB: undefined }) });
  assert.equal(none.status().kind, 'unavailable');
});

test('a quota failure on a write is reported once and the next write recovers; the store keeps the file throughout', async () => {
  const fake = createFakeIndexedDB();
  const statuses = [];
  const persistence = await openConfigPersistence({ mode: 'on', openStorage: openWith(fake), onStatus: status => statuses.push(status.state + ':' + status.kind) });
  persistence.store.layer('user.ini', text(USER));
  fake.failNext('put', domException('QuotaExceededError'), 'ini');
  persistence.store.write('User.ini', USER.replace('False', 'True'));
  await persistence.flush();
  assert.equal(persistence.status().state, 'failing');
  assert.equal(persistence.status().kind, 'quota');
  assert.equal(decodeIniBytes(persistence.store.layer('user.ini', text(USER))), USER.replace('False', 'True'));
  persistence.store.write('User.ini', USER.replace('False', 'Again'));
  await persistence.flush();
  assert.equal(persistence.status().state, 'on', 'a write that fits clears the failure');
  assert.deepEqual(statuses, ['failing:quota', 'on:null']);
  assert.equal(decodeIniBytes((await (await openBrowserStorage({ indexedDB: fake })).get('ini', 'user.ini')).bytes), USER.replace('False', 'Again'));
});

test('the worker\'s store hands each write to the page, whose store keeps and persists it', async () => {
  const fake = createFakeIndexedDB();
  const page = await openConfigPersistence({ mode: 'on', openStorage: openWith(fake) });
  const messages = [];
  const worker = createConfigStore({ saved: page.store.snapshot(), persist: (leaf, record) => messages.push({ leaf, bytes: record.bytes, base: record.base }) });
  worker.layer('user.ini', text(USER));
  worker.write('User.ini', USER.replace('False', 'True'));
  assert.equal(messages.length, 1);
  for (const message of messages) page.store.accept(message.leaf, message);   // main.mjs onConfig
  await page.flush();
  const stored = await (await openBrowserStorage({ indexedDB: fake })).get('ini', 'user.ini');
  assert.equal(decodeIniBytes(stored.bytes), USER.replace('False', 'True'));
  assert.equal(decodeIniBytes(stored.base), USER);
});
