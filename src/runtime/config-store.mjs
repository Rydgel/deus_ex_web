/**
 * The player's kept .ini files over the installed ones (docs/config-persistence.md).
 *
 * The original keeps its settings in two files of System\: DeusEx.ini (GConfig's System file) and User.ini (its User file).
 * `FConfigFile::Write` (DeusEx.exe 0x10915760) writes the whole file, immediately, whenever `SaveConfig`'s `Flush(0)` finds it
 * dirty, and nothing writes at exit; the next run reads that file back (appInit, Core 0x10149ad5-0x10149d6b: the file named by
 * INI=/USERINI= or DeusEx.ini/User.ini, copied from Default.ini/DefUser.ini only when it does not exist). The browser has
 * no writable System directory, so this store plays the writable file: it holds, per file, the bytes `appSaveStringToFile`
 * would have written, and a read of the file returns them in place of the installed bytes.
 *
 * A record is `{bytes, base}`: the written file and the installed file it was written over. While the installed file is
 * unchanged (`base` equals it) a read is `bytes`, the original's exactly. If the installed file changed since (another
 * installation, an edited file), the read is the installed file with the player's changes laid over it (`rebaseIni`): every key
 * whose saved value differs from `base` (or that `base` lacked) is set in the installed text, as SetString would.
 *
 * The store is pure: `persist(leaf, record)` is the one sink a host gives it (the page's IndexedDB, or a message to the page
 * from the simulation worker), and the saved records it starts with are whatever the host loaded.
 */
import { ConfigFile } from './config-cache.mjs';
import { decodeIniBytes, encodeIniText, sameBytes } from './ini-bytes.mjs';

/** The files GConfig keeps, by lowercase leaf name: the System file and the User file (ConfigCache.resolveName). */
export const PERSISTED_INI = Object.freeze(['deusex.ini', 'user.ini']);

/** The file appInit copies a missing one from: Default.ini to DeusEx.ini (Core 0x10149ad5), DefUser.ini to User.ini (0x10149c06). */
export const FIRST_RUN_SOURCE = Object.freeze({ 'deusex.ini': 'default.ini', 'user.ini': 'defuser.ini' });

const lower = value => String(value).toLowerCase();
const leafOf = path => lower(String(path).replaceAll('\\', '/').split('/').pop());

/** The installed text with the player's changes laid over it: each key of the saved file whose value differs from `base`'s (or that
 * `base` lacks) is set in the installed text the way SetString sets it (an existing key keeps its slot, a new one is appended). */
export function rebaseIni(installedBytes, saved) {
  const read = bytes => { const file = new ConfigFile(); file.read(decodeIniBytes(bytes)); return file; };
  const target = read(installedBytes), changed = read(saved.bytes), base = read(saved.base);
  for (const { name, section } of changed.sections) {
    const seen = new Set();
    for (const { key } of section.pairs) {
      if (seen.has(lower(key))) continue;
      seen.add(lower(key));
      const value = section.find(key).value;                    // the newest pair under a key is the one a Find returns
      if (base.find(name)?.find(key)?.value === value) continue;
      const into = target.find(name) ?? target.set(name), pair = into.find(key);
      if (pair) pair.value = value; else into.add(key, value);
    }
  }
  target.dirty = true;
  return encodeIniText(target.write());
}

/**
 * `saved`: Map of lowercase leaf -> {bytes, base} the host loaded. `persist(leaf, record)`: called with each file written
 * (and each record `accept` takes); it may return a promise, which the store does not wait for.
 */
export function createConfigStore({ saved = new Map(), persist = null } = {}) {
  const records = new Map();
  for (const [leaf, record] of saved) records.set(lower(leaf), { bytes: record.bytes, base: record.base });
  const installedBytes = new Map();           // leaf -> the installed bytes the file was layered over
  const rebased = new Set();                  // leaves whose installed file changed under the saved one
  const layers = new Map();                   // leaf -> the layered bytes of a rebase (computed once)
  const store = {
    persisted: leaf => PERSISTED_INI.includes(lower(leaf)),
    /** The bytes a read of `leaf` returns, given the installed file's bytes (a first-run copy where it is missing). */
    layer(leaf, installed) {
      leaf = lower(leaf);
      const record = records.get(leaf);
      if (installed) installedBytes.set(leaf, installed);
      if (!record) return installed ?? null;
      if (!installed || sameBytes(record.base, installed)) return record.bytes;
      if (!layers.has(leaf)) { layers.set(leaf, rebaseIni(installed, record)); rebased.add(leaf); }
      return layers.get(leaf);
    },
    /** Flush's write of a file: the text `FConfigFile::Write` built, kept as the bytes appSaveStringToFile writes. */
    write(name, text) {
      const leaf = lower(name);
      if (!PERSISTED_INI.includes(leaf)) return null;            // GConfig's other files (Running.ini, Detected.ini) are the launcher's
      return store.accept(leaf, { bytes: encodeIniText(text), base: installedBytes.get(leaf) ?? new Uint8Array(0) });
    },
    /** Take a record (a write of the simulation worker, a record the host loaded) and hand it to the sink. */
    accept(leaf, record) {
      leaf = lower(leaf);
      if (!PERSISTED_INI.includes(leaf)) return null;
      records.set(leaf, { bytes: record.bytes, base: record.base });
      layers.delete(leaf); rebased.delete(leaf);
      return persist?.(leaf, records.get(leaf));
    },
    /** Forget every kept file (a reset): reads are the installed files again. */
    clear() { records.clear(); layers.clear(); rebased.clear(); },
    /** The records, for a worker that starts with the page's state. */
    snapshot: () => new Map(records),
    get rebased() { return [...rebased]; },
    has: leaf => records.has(lower(leaf)),
  };
  return store;
}

/**
 * The config files as the original sees them: a missing DeusEx.ini or User.ini is its Default.ini/DefUser.ini (the first-run copy),
 * and with a store each reads the player's kept bytes over the installed ones. `files` are `{path, read}`; the result holds only the
 * .ini files, new objects where they changed. A first-run source is only consulted where the file it copies to is missing.
 */
export function layerConfigFiles(files, store = null) {
  const byLeaf = new Map();
  for (const file of files) byLeaf.set(leafOf(file.path), file);
  // The installed file is read once; each read of the entry layers the store's current record over it.
  const layered = (leaf, path, source, rest = {}) => {
    let installed = null;
    return { ...rest, path, async read() {
      installed ??= await readBytes(source);
      return store ? store.layer(leaf, installed) ?? installed : installed;
    } };
  };
  const out = files.map(file => {
    const leaf = leafOf(file.path);
    return PERSISTED_INI.includes(leaf) ? layered(leaf, file.path, file, file) : file;
  });
  for (const leaf of PERSISTED_INI) {
    if (byLeaf.has(leaf)) continue;
    const source = byLeaf.get(FIRST_RUN_SOURCE[leaf]);
    const name = leaf === 'deusex.ini' ? 'DeusEx.ini' : 'User.ini';
    if (source) out.push(layered(leaf, String(source.path).replace(/[^/\\]*$/, name), source));
    else if (store?.has(leaf)) out.push({ path: `System/${name}`, read: async () => store.layer(leaf, null) });
  }
  return out;
}

async function readBytes(file) {
  const data = await file.read();
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}
