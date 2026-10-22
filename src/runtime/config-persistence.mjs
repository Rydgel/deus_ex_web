/**
 * The page's side of configuration persistence (docs/config-persistence.md): open the browser storage, load the player's kept
 * DeusEx.ini and User.ini into a config store (config-store.mjs), and keep each file the game writes. Settings survive a reload
 * as the original's survive a restart: the file the game wrote is the file the next start reads.
 *
 * Persistence is on for the default start (the original's start) and off for the `?debug=1` page every validator opens, which
 * must start from the installed ini. `?persist=1` turns it on anywhere, `?persist=0` off, `?persist=reset` forgets what was kept
 * and keeps from then on.
 *
 * Failures never stop the page: the store still keeps the files in memory (settings last for the session, as a run of the
 * original keeps its GConfig until it exits) and `status()` says why they will not outlive it, with the message to show.
 */
import { createConfigStore, PERSISTED_INI } from './config-store.mjs';
import { openBrowserStorage, storageError, STORAGE_FORMAT, STORAGE_MESSAGES } from './browser-storage.mjs';

/** `off`, `on` or `reset` from the page's query string and whether it is the original's start. */
export function persistenceMode(search, originalStart) {
  const value = new URLSearchParams(search).get('persist');
  if (value === '0') return 'off';
  if (value === 'reset') return 'reset';
  if (value === '1') return 'on';
  return originalStart ? 'on' : 'off';
}

const isRow = row => row && typeof row.leaf === 'string' && row.bytes instanceof Uint8Array && row.base instanceof Uint8Array;

/**
 * `mode` from persistenceMode; `openStorage` the storage open (tests pass failures); `onStatus(status)` hears every change of
 * the status. Returns `{store, status(), flush(), reset()}`; `store` is null when persistence is off.
 */
export async function openConfigPersistence({ mode = 'off', openStorage = openBrowserStorage, onStatus = () => {} } = {}) {
  let status = { state: mode === 'off' ? 'off' : 'on', kind: null, message: null, rebased: [] };
  const setStatus = next => { status = { ...status, ...next }; onStatus(status); };
  if (mode === 'off') return { store: null, status: () => status, flush: async () => {}, reset: async () => {}, close() {} };

  let storage = null, saved = new Map();
  try {
    storage = await openStorage();
    const format = await storage.format();
    // A format row from a newer build: leave its rows alone (the schema check in open already refuses a newer version).
    if (format !== null && format > STORAGE_FORMAT) throw storageError(Object.assign(new Error(`format ${format}`), { name: 'VersionError' }));
    if (mode === 'reset') await storage.clear('ini');
    else for (const row of await storage.getAll('ini')) if (isRow(row) && PERSISTED_INI.includes(row.leaf)) saved.set(row.leaf, { bytes: row.bytes, base: row.base });
  } catch (error) {
    const failure = storageError(error);
    storage = null; saved = new Map();
    setStatus({ state: 'unavailable', kind: failure.kind, message: failure.message });
  }

  const pending = new Set();
  /** The sink: one transaction per written file. A failure changes the status and leaves the in-memory copy the store holds. */
  const persist = (leaf, record) => {
    if (!storage) return null;
    const write = storage.put('ini', { leaf, bytes: record.bytes, base: record.base, savedAt: Date.now() })
      .then(() => { if (status.state === 'failing') setStatus({ state: 'on', kind: null, message: null }); },
        error => { const failure = storageError(error); setStatus({ state: 'failing', kind: failure.kind, message: failure.message }); })
      .finally(() => pending.delete(write));
    pending.add(write);
    return write;
  };
  const store = createConfigStore({ saved, persist });
  return {
    store,
    status: () => status,
    /** Release the storage connection (a second set of files replaces this persistence). */
    close() { storage?.close(); },
    /** Resolves when every write handed to the storage so far has settled (tests; the page does not wait). */
    async flush() { while (pending.size) await Promise.all([...pending]); },
    /** Forget the kept files, in memory and in storage: the next read is the installed files. */
    async reset() {
      store.clear();
      if (storage) try { await storage.clear('ini'); } catch (error) { const failure = storageError(error); setStatus({ state: 'failing', kind: failure.kind, message: failure.message }); }
    },
  };
}

export { STORAGE_MESSAGES };
