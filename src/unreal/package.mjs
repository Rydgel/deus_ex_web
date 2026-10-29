/** Read UE1 package tables without executing game code. Browser and Node compatible. */
export class PackageError extends Error {
  constructor(message, offset) {
    super(`${message} at byte ${offset}`);
    this.name = 'PackageError';
    this.offset = offset;
  }
}

export class Reader {
  constructor(input) {
    this.bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (!(this.bytes instanceof Uint8Array)) throw new TypeError('Expected Uint8Array or ArrayBuffer');
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.offset = 0;
  }

  require(size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.bytes.length - this.offset) {
      throw new PackageError(`Truncated or invalid read of ${size} bytes`, this.offset);
    }
  }

  seek(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.bytes.length) {
      throw new PackageError(`Invalid seek to ${offset}`, this.offset);
    }
    this.offset = offset;
  }

  take(size) {
    this.require(size);
    const result = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }

  u8() { this.require(1); return this.view.getUint8(this.offset++); }
  u16() { this.require(2); const n = this.view.getUint16(this.offset, true); this.offset += 2; return n; }
  u32() { this.require(4); const n = this.view.getUint32(this.offset, true); this.offset += 4; return n; }
  i32() { this.require(4); const n = this.view.getInt32(this.offset, true); this.offset += 4; return n; }
  i16() { this.require(2); const n = this.view.getInt16(this.offset, true); this.offset += 2; return n; }
  f32() {
    this.require(4);
    const n = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    if (!Number.isFinite(n)) throw new PackageError('Nonfinite float', this.offset - 4);
    return n;
  }

  /** UE1 signed compact index: 6 bits, then 7 + 7 + 7 + 5 bits. */
  compact() {
    const start = this.offset;
    let byte = this.u8();
    const negative = (byte & 0x80) !== 0;
    let value = byte & 0x3f;
    let more = (byte & 0x40) !== 0;
    for (let index = 1; more; index++) {
      byte = this.u8();
      if (index === 4 && byte > 0x1f) throw new PackageError('Compact index overflow', start);
      // Integer arithmetic only: `2 ** n` yields a heap number in the interpreter, and a heap number stored once makes V8 box
      // that field in every object of the shape (docs/live-heap.md "Steps 2 and 3's results"). The fourth group's 2 ** 27 is a
      // literal factor, which stays a small integer while the product fits.
      value += index === 4 ? (byte & 0x1f) * 134217728 : (byte & 0x7f) << (6 + (index - 1) * 7);
      more = index < 4 && (byte & 0x80) !== 0;
    }
    if (value > (negative ? 0x80000000 : 0x7fffffff)) {
      throw new PackageError('Compact index exceeds signed 32-bit range', start);
    }
    return negative && value !== 0 ? -value : value;
  }

  string(version = 68) {
    if (version < 64) {
      const start = this.offset;
      while (this.u8() !== 0) { /* Older packages store null-terminated names. */ }
      return new TextDecoder('windows-1252').decode(this.bytes.subarray(start, this.offset - 1));
    }
    const count = this.compact();
    if (count === 0) return '';
    const wide = count < 0;
    const bytes = this.take(Math.abs(count) * (wide ? 2 : 1));
    const end = bytes.length - (wide ? 2 : 1);
    if (bytes[end] !== 0 || (wide && bytes[end + 1] !== 0)) {
      throw new PackageError('Unterminated package string', this.offset - bytes.length);
    }
    if (wide) {
      // Original FString archive loading copies TCHAR units, including lone
      // surrogates and BOMs. TextDecoder rejects/replaces or strips those.
      let value = '';
      for (let index = 0; index < end; index += 2)
        value += String.fromCharCode(bytes[index] | bytes[index + 1] << 8);
      return value;
    }
    return new TextDecoder('windows-1252', { fatal: true }).decode(bytes.subarray(0, end));
  }
}

/** Supports the UE1 versions present in Deus Ex (61, 68), plus version 69. */
export function parsePackage(input) {
  const r = new Reader(input);
  if (r.u32() !== 0x9e2a83c1) throw new PackageError('Not an Unreal package', 0);
  const version = r.u16();
  const licenseeVersion = r.u16();
  if (![61, 68, 69].includes(version)) throw new PackageError(`Unsupported package version ${version}`, 4);
  const flags = r.u32();
  const tables = {};
  for (const name of ['names', 'exports', 'imports']) {
    const count = r.i32();
    const offset = r.i32();
    if (count < 0 || count > 1_000_000 || offset < 0 || offset > r.bytes.length) {
      throw new PackageError(`Invalid ${name} table count or offset`, r.offset - 8);
    }
    tables[name] = { count, offset };
  }
  let guid = null;
  let heritage = null;
  let generations = [];
  if (version < 68) {
    heritage = { count: r.i32(), offset: r.i32() };
    if (heritage.count < 0 || heritage.offset < 0 || heritage.offset > r.bytes.length ||
      heritage.count > Math.floor((r.bytes.length - heritage.offset) / 16)) {
      throw new PackageError('Invalid heritage table', 36);
    }
  } else {
    guid = Array.from(r.take(16), n => n.toString(16).padStart(2, '0')).join('');
    const generationCount = r.i32();
    if (generationCount < 0 || generationCount > 100_000) throw new PackageError('Invalid generation count', 52);
    r.require(generationCount * 8);
    generations = Array.from({ length: generationCount }, () => ({ exports: r.u32(), names: r.u32() }));
  }
  const headerSize = r.offset;
  const tableRanges = [];

  function table(kind, minimumBytes, parse) {
    const { offset, count } = tables[kind];
    if (count === 0) return [];
    if (offset < headerSize || count > Math.floor((r.bytes.length - offset) / minimumBytes)) {
      throw new PackageError(`Invalid ${kind} table extent`, offset);
    }
    r.seek(offset);
    const values = Array.from({ length: count }, parse);
    tableRanges.push([offset, r.offset, kind]);
    return values;
  }

  const names = table('names', 5, () => ({ name: r.string(version), flags: r.u32() }));
  function nameAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= names.length) {
      throw new PackageError(`Invalid name reference ${index}`, r.offset);
    }
    return names[index].name;
  }
  // Every field is declared in the literal, so an entry has no out-of-line property array (`path` and `className` are filled
  // below).
  const imports = table('imports', 7, () => ({
    classPackage: nameAt(r.compact()),
    className: nameAt(r.compact()),
    outer: r.i32(),
    name: nameAt(r.compact()),
    path: '',
  }));
  const exports = table('exports', 12, () => {
    const classIndex = r.compact(), superIndex = r.compact(), outer = r.i32();
    const name = nameAt(r.compact()), flags = r.u32(), serialSize = r.compact();
    const serialOffset = serialSize > 0 ? r.compact() : null;
    if (serialSize < 0 || (serialSize > 0 && (
      serialOffset < headerSize || serialSize > r.bytes.length - serialOffset
    ))) throw new PackageError(`Invalid export payload for ${name}`, r.offset);
    return { classIndex, superIndex, outer, name, flags, serialSize, serialOffset, className: '', path: '' };
  });
  tableRanges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < tableRanges.length; i++) {
    if (tableRanges[i][0] < tableRanges[i - 1][1]) throw new PackageError('Overlapping package tables', tableRanges[i][0]);
  }

  function objectAt(index) {
    if (index === 0) return null;
    const entry = index > 0 ? exports[index - 1] : imports[-index - 1];
    if (!entry) throw new PackageError(`Invalid object reference ${index}`, r.offset);
    return entry;
  }
  function objectPath(index) {
    const seen = new Set();
    const parts = [];
    while (index !== 0) {
      if (seen.has(index)) throw new PackageError('Cyclic object outer reference', r.offset);
      seen.add(index);
      const entry = objectAt(index);
      parts.push(entry.name);
      index = entry.outer;
    }
    return parts.reverse().join('.');
  }
  imports.forEach((entry, i) => { entry.path = objectPath(-i - 1); });
  exports.forEach((entry, i) => {
    objectAt(entry.superIndex);
    entry.className = objectAt(entry.classIndex)?.name ?? 'Class';
    entry.path = objectPath(i + 1);
  });
  const dependencies = [...new Set(imports
    .filter(entry => entry.outer === 0 && entry.className === 'Package')
    .map(entry => entry.name))].sort();
  return { version, licenseeVersion, flags, guid, heritage, generations, tables, names, imports, exports, dependencies };
}

export function summarizePackage(pkg) {
  const classes = Object.create(null);
  for (const entry of pkg.exports) classes[entry.className] = (classes[entry.className] ?? 0) + 1;
  return {
    version: pkg.version, licenseeVersion: pkg.licenseeVersion,
    names: pkg.names.length, imports: pkg.imports.length, exports: pkg.exports.length,
    dependencies: pkg.dependencies,
    exportClasses: Object.fromEntries(Object.entries(classes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  };
}
