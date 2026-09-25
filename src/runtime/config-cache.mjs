/**
 * GConfig: the FConfigCacheIni the Deus Ex launcher hands to Core's appInit.
 *
 * DeusEx.exe compiles the SDK's inline FConfigCacheIni.h unoptimized. Its
 * SetString (0x10918030, guard string 0x10927a78) was checked against the
 * header branch by branch. See docs/script-config.md. Every FString key
 * compare is case-insensitive (FString operator==). TMap/TMultiMap::Find walks
 * the hash chain newest first, so it returns the LAST pair added under a key.
 * Iteration and Write follow the Pairs order.
 *
 * The browser has no writable System directory. FConfigFile::Write stores the
 * file text it would have saved in `written`, and Find re-reads that text in
 * place of the installed file, as a re-read from disk would.
 */

const lower = value => String(value ?? '').toLowerCase();

/** TMultiMap<FString,FString>: ordered pairs, newest-first lookup. */
export class ConfigSection {
  constructor() { this.pairs = []; }
  find(key) {
    const wanted = lower(key);
    for (let i = this.pairs.length - 1; i >= 0; i--) if (lower(this.pairs[i].key) === wanted) return this.pairs[i];
    return null;
  }
  /** TMultiMap::MultiFind order: newest first. */
  multiFind(key) {
    const wanted = lower(key), out = [];
    for (let i = this.pairs.length - 1; i >= 0; i--) if (lower(this.pairs[i].key) === wanted) out.push(this.pairs[i].value);
    return out;
  }
  add(key, value) { this.pairs.push({ key: String(key), value: String(value) }); }
  /** TMultiMap::Remove(Key): every pair under the key. */
  remove(key) {
    const wanted = lower(key), before = this.pairs.length;
    this.pairs = this.pairs.filter(pair => lower(pair.key) !== wanted);
    return before - this.pairs.length;
  }
}

/** FConfigFile: TMap<FString,FConfigSection> plus Dirty/NoSave. */
export class ConfigFile {
  constructor() { this.sections = []; this.dirty = false; this.noSave = false; }
  find(name) {
    const wanted = lower(name);
    return this.sections.find(entry => lower(entry.name) === wanted)?.section ?? null;
  }
  /** TMap::Set: an existing key keeps its slot and takes the new value. */
  set(name, section = new ConfigSection()) {
    const existing = this.sections.find(entry => lower(entry.name) === lower(name));
    if (existing) { existing.section = section; return section; }
    this.sections.push({ name: String(name), section });
    return section;
  }
  /** FConfigFile::Read: CR/LF-separated lines, `[Section]` headers and
   * `Key=Value` pairs. One pair of surrounding quotes is stripped from a
   * value, and a line outside any section is ignored. */
  read(text) {
    this.sections = [];
    if (text == null) return;
    let current = null;
    for (const line of String(text).split(/[\r\n]+/)) {
      if (line.startsWith('[') && line.length > 1 && line.endsWith(']')) {
        const name = line.slice(1, -1);
        current = this.find(name) ?? this.set(name);
      } else if (current && line) {
        const equals = line.indexOf('=');
        if (equals < 0) continue;
        let value = line.slice(equals + 1);
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 1) value = value.slice(1, -1);
        current.add(line.slice(0, equals), value);
      }
    }
  }
  /** FConfigFile::Write: the text, or null when nothing needs saving. */
  write() {
    if (!this.dirty || this.noSave) return null;
    this.dirty = false;
    let text = '';
    for (const { name, section } of this.sections) {
      text += `[${name}]\r\n`;
      for (const { key, value } of section.pairs) text += `${key}=${value}\r\n`;
      text += '\r\n';
    }
    return text;
  }
}

export class ConfigCache {
  /** `files`: Map of lowercase file name -> installed text (the System dir). */
  constructor({ files = new Map(), systemIni = 'DeusEx.ini', userIni = 'User.ini' } = {}) {
    this.installed = files;
    this.written = new Map();
    this.systemIni = systemIni;
    this.userIni = userIni;
    this.files = [];
  }
  resolveName(filename) {
    let name = filename == null ? this.systemIni : String(filename);
    // Add .ini when neither of the last five characters starts an extension.
    const length = name.length;
    if (length < 5 || (name[length - 4] !== '.' && name[length - 5] !== '.')) name += '.ini';
    if (lower(name) === 'user.ini') name = this.userIni;
    else if (lower(name) === 'system.ini') name = this.systemIni;
    return name;
  }
  diskText(name) {
    const key = lower(name);
    if (this.written.has(key)) return this.written.get(key);
    return this.installed.get(key) ?? null;
  }
  /** FConfigCacheIni::Find. */
  find(filename, createIfNotFound) {
    const name = this.resolveName(filename);
    let entry = this.files.find(file => lower(file.name) === lower(name));
    if (!entry && (createIfNotFound || this.diskText(name) !== null)) {
      entry = { name, file: new ConfigFile() };
      this.files.push(entry);
      entry.file.read(this.diskText(name));
    }
    return entry?.file ?? null;
  }
  /** GetString: the value truncated to `size - 1` characters, or null. */
  getString(section, key, filename, size = 0x400) {
    const pair = this.find(filename, false)?.find(section)?.find(key);
    return pair ? pair.value.slice(0, Math.max(0, size - 1)) : null;
  }
  /** GetSectionPrivate: a forced missing section is created; a forced or
   * non-const request marks the file dirty. */
  getSectionPrivate(section, force, isConst, filename) {
    const file = this.find(filename, force);
    if (!file) return null;
    let found = file.find(section);
    if (!found && force) found = file.set(section);
    if (found && (force || !isConst)) file.dirty = true;
    return found;
  }
  /** SetString, including the launcher's dirty rule: a missing key is added
   * and dirties the file; a value differing case-insensitively is replaced
   * and sets Dirty to whether it also differs case-sensitively. */
  setString(section, key, value, filename) {
    const file = this.find(filename, true);
    const target = file.find(section) ?? file.set(section);
    const pair = target.find(key);
    value = String(value);
    if (!pair) { target.add(key, value); file.dirty = true; }
    else if (lower(pair.value) !== lower(value)) { file.dirty = pair.value !== value; pair.value = value; }
  }
  /** Flush: write every (or the named) dirty file; `read` then drops it. */
  flush(read, filename = null) {
    for (const { name, file } of this.files) {
      if (filename !== null && lower(name) !== lower(filename)) continue;
      const text = file.write();
      if (text !== null) this.written.set(lower(name), text);
    }
    if (read) this.files = filename === null ? [] : this.files.filter(entry => lower(entry.name) !== lower(filename));
  }
}

/** Build the cache from the installed System/*.ini files (AssetStore
 * `configFiles`). */
export async function loadConfigCache(configFiles = []) {
  const files = new Map();
  for (const file of configFiles) {
    const leaf = String(file.path).replaceAll('\\', '/').split('/').pop();
    const data = await file.read();
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    // appLoadFileToString: a UTF-16LE file starts with FF FE; otherwise each
    // byte is one TCHAR.
    const text = bytes[0] === 0xff && bytes[1] === 0xfe
      ? new TextDecoder('utf-16le').decode(bytes.subarray(2))
      : new TextDecoder('latin1').decode(bytes);
    files.set(leaf.toLowerCase(), text);
  }
  return new ConfigCache({ files });
}
