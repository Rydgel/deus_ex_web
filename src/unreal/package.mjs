/** Read UE1 package tables without executing game code. Browser and Node compatible. */
import { NameTable, ImportTable, ExportTable, PackageLinks } from './package-tables.mjs';
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

  // `build(count)` makes the table's columns and reads its entries; an empty table is built without a seek.
  function table(kind, minimumBytes, build) {
    const { offset, count } = tables[kind];
    if (count === 0) return build(0);
    if (offset < headerSize || count > Math.floor((r.bytes.length - offset) / minimumBytes)) {
      throw new PackageError(`Invalid ${kind} table extent`, offset);
    }
    r.seek(offset);
    const result = build(count);
    tableRanges.push([offset, r.offset, kind]);
    return result;
  }

  const names = table('names', 5, count => {
    const texts = [], flagWords = new Uint32Array(count);
    for (let i = 0; i < count; i++) { texts.push(r.string(version)); flagWords[i] = r.u32(); }
    return new NameTable(texts, flagWords);
  });
  function nameIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= names.length) {
      throw new PackageError(`Invalid name reference ${index}`, r.offset);
    }
    return index;
  }
  // The columns hold the entries' fields (package-tables.mjs); a name is a position in `names`.
  const imports = table('imports', 7, count => {
    const classPackages = new Int32Array(count), classNames = new Int32Array(count), outers = new Int32Array(count), nameIndexes = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      classPackages[i] = nameIndex(r.compact());
      classNames[i] = nameIndex(r.compact());
      outers[i] = r.i32();
      nameIndexes[i] = nameIndex(r.compact());
    }
    return new ImportTable(names, classPackages, classNames, outers, nameIndexes);
  });
  const exports = table('exports', 12, count => {
    const columns = { classIndexes: new Int32Array(count), superIndexes: new Int32Array(count), outers: new Int32Array(count),
      nameIndexes: new Int32Array(count), flagWords: new Uint32Array(count), serialSizes: new Int32Array(count), serialOffsets: new Int32Array(count) };
    for (let i = 0; i < count; i++) {
      columns.classIndexes[i] = r.compact();
      columns.superIndexes[i] = r.compact();
      columns.outers[i] = r.i32();
      const name = nameIndex(r.compact());
      columns.nameIndexes[i] = name;
      columns.flagWords[i] = r.u32();
      const serialSize = r.compact();
      const serialOffset = serialSize > 0 ? r.compact() : -1;
      if (serialSize < 0 || (serialSize > 0 && (
        serialOffset < headerSize || serialSize > r.bytes.length - serialOffset
      ))) throw new PackageError(`Invalid export payload for ${names.texts[name]}`, r.offset);
      columns.serialSizes[i] = serialSize;
      columns.serialOffsets[i] = serialOffset;
    }
    return new ExportTable(names, columns);
  });
  tableRanges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < tableRanges.length; i++) {
    if (tableRanges[i][0] < tableRanges[i - 1][1]) throw new PackageError('Overlapping package tables', tableRanges[i][0]);
  }

  // Every reference and every outer chain is checked once here, as building each entry's path did; the paths are made when asked for.
  const links = imports.links = exports.links = new PackageLinks(names, imports, exports);
  function checkReference(index) {
    if (index === 0) return;
    if (index > 0 ? index > exports.length : -index > imports.length) throw new PackageError(`Invalid object reference ${index}`, r.offset);
  }
  // A chain longer than the entries it can name repeats one: the cycle objectPath's seen-set caught.
  const chainLimit = imports.length + exports.length;
  function checkChain(index) {
    for (let steps = 0; index !== 0; steps++) {
      if (steps > chainLimit) throw new PackageError('Cyclic object outer reference', r.offset);
      checkReference(index);
      index = links.outerOf(index);
    }
  }
  for (let i = 0; i < imports.length; i++) checkChain(-i - 1);
  for (let i = 0; i < exports.length; i++) {
    checkReference(exports.superIndexes[i]);
    checkReference(exports.classIndexes[i]);
    checkChain(i + 1);
  }
  const dependencyNames = new Set();
  for (let i = 0; i < imports.length; i++) if (imports.outers[i] === 0 && imports.className(i) === 'Package') dependencyNames.add(imports.text(i));
  const dependencies = [...dependencyNames].sort();
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
