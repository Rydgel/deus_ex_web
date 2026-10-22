/**
 * The browser's storage for what the original keeps on disk: IndexedDB, versioned, with the failures a browser has named
 * (docs/config-persistence.md "Failure handling", docs/save-storage.md).
 *
 * One database, `deusex-web`, with five object stores:
 *
 *   meta      {key, value}                                `format`: the storage format this build wrote (STORAGE_FORMAT)
 *   ini       {leaf, bytes, base, savedAt}                the player's kept DeusEx.ini and User.ini (config-store.mjs)
 *   saves     {dir, name, size, modified}                 one row per file of `Save\<dir>\` (save-store.mjs), without its bytes, so a
 *                                                         directory listing never reads a 3 MB save; index `dir`
 *   savedata  {dir, name, bytes}                          the bytes of that file, written in the same transaction as its row
 *   handles   {id, handle}                                a folder the player picked for saves (FileSystemDirectoryHandle)
 *
 * The database version is the schema's: `upgrade` moves an older database forward one version at a time inside the open's
 * versionchange transaction, so a future version adds its stores there and keeps every row. A database a *newer* build created
 * cannot be opened by this one (IndexedDB raises VersionError); that is reported as `newer` and the caller runs without
 * persistence rather than touching what it cannot read.
 *
 * Every failure is a StorageError with a `kind` the pages can message:
 *   unavailable  no IndexedDB, or it refuses writes (Firefox private windows, a browser with storage turned off)
 *   blocked      the page may not use storage (third-party frame, site data blocked), or an upgrade another tab holds open
 *   newer        the database is from a newer build
 *   quota        QuotaExceededError: the browser has no room; nothing already stored is lost
 *   closed       the connection went away (another tab upgraded the database, the user cleared site data)
 *   failed       anything else, with the browser's own message
 */

export const DATABASE_NAME = 'deusex-web';
export const DATABASE_VERSION = 1;
export const STORAGE_FORMAT = 1;
export const STORES = Object.freeze(['meta', 'ini', 'saves', 'savedata', 'handles']);

export class StorageError extends Error {
  constructor(kind, message, cause = null) {
    super(message);
    this.name = 'StorageError'; this.kind = kind; this.cause = cause;
  }
}

/** One line a page can show for a failure kind; `detail` is the browser's own message. */
export const STORAGE_MESSAGES = Object.freeze({
  unavailable: 'This browser does not keep data for this page (a private window or storage turned off): settings and saves last only until the page is closed.',
  blocked: 'The browser blocks storage for this page, or another tab holds the data open: settings and saves last only until the page is closed.',
  newer: 'The stored data comes from a newer version of this page: it was left alone, and settings and saves last only until the page is closed.',
  quota: 'The browser has no room left for this page\'s data: the last change was not kept.',
  closed: 'The browser closed this page\'s storage (another tab or cleared site data): reload the page to keep settings and saves.',
  failed: 'The browser could not store this page\'s data.',
});

/** The kind of a browser's storage error, by the name the DOMException carries. */
export function classifyStorageError(error) {
  if (error instanceof StorageError) return error.kind;
  switch (error?.name) {
    case 'QuotaExceededError': return 'quota';
    case 'VersionError': return 'newer';
    case 'SecurityError': return 'blocked';
    // Firefox's private windows: "A mutation operation was attempted on a database that did not allow mutations."
    case 'InvalidStateError': case 'UnknownError': case 'NotSupportedError': return 'unavailable';
    case 'AbortError': return /quota/i.test(String(error?.message)) ? 'quota' : 'failed';
    default: return 'failed';
  }
}

export function storageError(error, fallbackKind = null) {
  if (error instanceof StorageError) return error;
  const kind = fallbackKind && classifyStorageError(error) === 'failed' ? fallbackKind : classifyStorageError(error);
  const detail = error?.message ? ` (${error.name ?? 'Error'}: ${error.message})` : '';
  return new StorageError(kind, `${STORAGE_MESSAGES[kind]}${detail}`, error);
}

/** The schema, by version. Runs inside the versionchange transaction; each step only adds, so every row survives an upgrade. */
export function upgrade(db, oldVersion, transaction) {
  if (oldVersion < 1) {
    db.createObjectStore('meta', { keyPath: 'key' });
    db.createObjectStore('ini', { keyPath: 'leaf' });
    db.createObjectStore('saves', { keyPath: ['dir', 'name'] }).createIndex('dir', 'dir');
    db.createObjectStore('savedata', { keyPath: ['dir', 'name'] });
    db.createObjectStore('handles', { keyPath: 'id' });
    transaction.objectStore('meta').put({ key: 'format', value: STORAGE_FORMAT });
  }
}

/**
 * Open the database. `indexedDB` and `name` are the host's (tests pass a fake); `timeoutMs` bounds an open that never answers
 * (another tab holding an upgrade: `blocked`). Rejects with a StorageError.
 */
export async function openBrowserStorage({ indexedDB = globalThis.indexedDB, name = DATABASE_NAME, version = DATABASE_VERSION, timeoutMs = 4000 } = {}) {
  if (!indexedDB) throw new StorageError('unavailable', STORAGE_MESSAGES.unavailable);
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      let request;
      try { request = indexedDB.open(name, version); } catch (error) { reject(error); return; }
      const timer = setTimeout(() => reject(Object.assign(new Error('The database open was blocked'), { name: 'SecurityError' })), timeoutMs);
      request.onupgradeneeded = event => {
        try { upgrade(request.result, event.oldVersion, request.transaction); } catch (error) { try { request.transaction.abort(); } catch { /* already aborted */ } reject(error); }
      };
      request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
      request.onerror = () => { clearTimeout(timer); reject(request.error); };
      request.onblocked = () => { /* the timer reports it if the other tab never lets go */ };
    });
  } catch (error) { throw storageError(error); }
  return createBrowserStorage(db, { indexedDB, name, version });
}

/** The open database as promises. A `closed` connection (versionchange, clear-site-data) fails every call with a `closed` StorageError. */
export function createBrowserStorage(db, { indexedDB = globalThis.indexedDB, name = DATABASE_NAME, version = DATABASE_VERSION } = {}) {
  let closed = false;
  const listeners = new Set();
  const close = reason => { if (closed) return; closed = true; try { db.close(); } catch { /* gone already */ } for (const listener of listeners) listener(reason); };
  db.onversionchange = () => close('versionchange');
  db.onclose = () => close('close');
  /** Run `work(stores, tx)` in one transaction; resolves when the transaction commits, with the result of the IDBRequest `work`
   * returned (a read), if any. A request error or a failed commit rejects with a StorageError (a quota failure is `quota`). */
  const run = (storeNames, mode, work) => new Promise((resolve, reject) => {
    if (closed) { reject(new StorageError('closed', STORAGE_MESSAGES.closed)); return; }
    let tx, result, failure = null;
    try {
      tx = db.transaction(storeNames, mode);
      const stores = Object.fromEntries(storeNames.map(store => [store, tx.objectStore(store)]));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => { failure ??= tx.error ?? null; };
      tx.onabort = () => reject(storageError(tx.error ?? failure ?? new Error('The transaction was aborted')));
      const request = work(stores, tx);
      if (request && typeof request === 'object' && 'onsuccess' in request) request.onsuccess = () => { result = request.result; };
    } catch (error) {
      try { tx?.abort(); } catch { /* finished already */ }
      reject(storageError(error));
    }
  });
  return {
    kind: 'indexeddb', name, version,
    get closed() { return closed; },
    onClose(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { close('close'); },
    /** The `format` row: what this database's writer called its layout. */
    async format() { return (await this.get('meta', 'format'))?.value ?? null; },
    async get(store, key) { return run([store], 'readonly', stores => stores[store].get(key)); },
    async getAll(store) { return run([store], 'readonly', stores => stores[store].getAll()); },
    async getAllByIndex(store, index, key) { return run([store], 'readonly', stores => stores[store].index(index).getAll(key)); },
    async count(store) { return run([store], 'readonly', stores => stores[store].count()); },
    /** Put one row and wait for the transaction to commit (a quota failure surfaces here, as QuotaExceededError). */
    async put(store, value) { return run([store], 'readwrite', stores => { stores[store].put(value); }); },
    async putAll(store, values) { return run([store], 'readwrite', stores => { for (const value of values) stores[store].put(value); }); },
    async delete(store, key) { return run([store], 'readwrite', stores => { stores[store].delete(key); }); },
    async clear(store) { return run([store], 'readwrite', stores => { stores[store].clear(); }); },
    run,
    /** `navigator.storage.estimate()` as {quota, usage}, or null where the browser has none. */
    async estimate() {
      try { const estimate = await globalThis.navigator?.storage?.estimate?.(); return estimate ? { quota: estimate.quota ?? null, usage: estimate.usage ?? null } : null; }
      catch { return null; }
    },
  };
}
