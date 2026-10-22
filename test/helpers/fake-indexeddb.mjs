/**
 * A small in-memory IndexedDB for the unit tests of browser-storage.mjs: open with a version and an upgrade, object stores with a keyPath
 * (string or array) and indexes, transactions with get / getAll / count / put / delete / clear, events delivered asynchronously, and
 * failures injected by the test. It models only what browser-storage.mjs uses; the browser spec (browser-tests/config-persistence.spec.mjs)
 * runs the same code against Chromium's real IndexedDB.
 */
const keyOf = (keyPath, value) => Array.isArray(keyPath) ? keyPath.map(part => value[part]) : value[keyPath];
const text = key => JSON.stringify(key);
const defer = work => queueMicrotask(work);
// IndexedDB clones what it stores; a FileSystemHandle is cloneable there and stays itself in the fake.
const clone = value => value && typeof value === 'object' && value.handle ? { ...structuredClone({ ...value, handle: undefined }), handle: value.handle } : structuredClone(value);

export function domException(name, message = name) { const error = new Error(message); error.name = name; return error; }

export function createFakeIndexedDB() {
  const databases = new Map();
  /** Injected failures: {op, store, error, once}; matched when a request executes. */
  const failures = [];
  const calls = [];
  const api = {
    databases, calls,
    /** Fail the next request of `op` ('get', 'getAll', 'put', 'delete', 'clear', 'count') on `store` (any when null). */
    failNext(op, error, store = null) { failures.push({ op, store, error }); },
    /** `open` raises this synchronously (a browser that blocks storage) or answers it as an error event. */
    openError: null, openThrows: null, openBlocks: false,
    open(name, version) {
      calls.push(['open', name, version]);
      if (api.openThrows) throw api.openThrows;
      const request = { result: null, error: null, transaction: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      defer(() => {
        if (api.openBlocks) { request.onblocked?.(); return; }
        if (api.openError) { request.error = api.openError; request.onerror?.(); return; }
        let record = databases.get(name);
        if (record && version < record.version) { request.error = domException('VersionError', 'The requested version is less than the existing version'); request.onerror?.(); return; }
        const oldVersion = record?.version ?? 0;
        const db = { objectStoreNames: [], onversionchange: null, onclose: null, closed: false };
        record ??= { version: 0, stores: new Map() };
        const upgradeStores = record.stores;
        db.close = () => { db.closed = true; };
        db.createObjectStore = (storeName, { keyPath }) => {
          const store = { keyPath, rows: new Map(), indexes: new Map() };
          upgradeStores.set(storeName, store); db.objectStoreNames.push(storeName);
          return { createIndex: (indexName, path) => { store.indexes.set(indexName, path); }, put: value => store.rows.set(text(keyOf(keyPath, value)), clone(value)) };
        };
        db.transaction = (names, mode) => transaction(db, record, [].concat(names), mode);
        db.objectStoreNames.push(...upgradeStores.keys());
        request.result = db;
        if (version > oldVersion) {
          request.transaction = { objectStore: storeName => { const store = upgradeStores.get(storeName); return { put: value => store.rows.set(text(keyOf(store.keyPath, value)), clone(value)) }; }, abort() { record.aborted = true; } };
          const wasNew = !databases.has(name);
          databases.set(name, record);
          try { request.onupgradeneeded?.({ oldVersion }); } catch (error) { if (wasNew) databases.delete(name); throw error; }
          if (record.aborted) { if (wasNew) databases.delete(name); delete record.aborted; request.error = domException('AbortError'); request.onerror?.(); return; }
          record.version = version;
        }
        request.onsuccess?.();
      });
      return request;
    },
  };

  function transaction(db, record, names, mode) {
    if (db.closed) throw domException('InvalidStateError', 'The database connection is closing.');
    const tx = { error: null, oncomplete: null, onerror: null, onabort: null, queue: [], running: false, aborted: false, undo: [] };
    const fail = error => {
      if (tx.aborted) return;
      tx.aborted = true; tx.error = error;
      for (const undo of tx.undo.reverse()) undo();   // an aborted transaction leaves nothing of what it wrote
      tx.onerror?.(); tx.onabort?.();
    };
    // `rows` before and after a write, so an abort can restore it
    const remember = (store, key) => { const had = store.rows.has(key), old = store.rows.get(key); tx.undo.push(() => { if (had) store.rows.set(key, old); else store.rows.delete(key); }); };
    const request = (op, store, work) => {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      tx.queue.push(() => {
        const index = failures.findIndex(f => f.op === op && (f.store === null || f.store === store));
        if (index >= 0) { const { error } = failures.splice(index, 1)[0]; req.error = error; req.onerror?.(); fail(error); return; }
        try { req.result = work(); } catch (error) { req.error = error; req.onerror?.(); fail(error); return; }
        req.onsuccess?.();
      });
      return req;
    };
    tx.objectStore = storeName => {
      const store = record.stores.get(storeName);
      if (!store || !names.includes(storeName)) throw domException('NotFoundError', `No object store ${storeName}`);
      const writable = () => { if (mode !== 'readwrite') throw domException('ReadOnlyError'); };
      const rowsOf = () => [...store.rows.values()].map(value => clone(value));
      return {
        get: key => request('get', storeName, () => { const row = store.rows.get(text(key)); return row === undefined ? undefined : clone(row); }),
        getAll: () => request('getAll', storeName, rowsOf),
        count: () => request('count', storeName, () => store.rows.size),
        put: value => { writable(); return request('put', storeName, () => { remember(store, text(keyOf(store.keyPath, value))); store.rows.set(text(keyOf(store.keyPath, value)), clone(value)); return keyOf(store.keyPath, value); }); },
        delete: key => { writable(); return request('delete', storeName, () => { remember(store, text(key)); store.rows.delete(text(key)); }); },
        clear: () => { writable(); return request('clear', storeName, () => { for (const key of store.rows.keys()) remember(store, key); store.rows.clear(); }); },
        index: indexName => ({ getAll: key => request('getAll', storeName, () => rowsOf().filter(row => text(row[store.indexes.get(indexName)]) === text(key))) }),
      };
    };
    tx.abort = () => fail(domException('AbortError', 'The transaction was aborted'));
    // The requests run in order, then the transaction completes (an empty one too).
    const pump = () => {
      if (tx.aborted) return;
      const next = tx.queue.shift();
      if (next) { next(); defer(pump); } else tx.oncomplete?.();
    };
    defer(() => defer(pump));
    return tx;
  }
  return api;
}
