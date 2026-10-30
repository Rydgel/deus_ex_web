/** A package's name, import and export tables as columns (docs/live-heap.md "Package tables").
 *
 * Host representation only. `parsePackage` used to build one object for each name (`{name, flags}`), import and export, and a path
 * string for each of them: on the Island's 55 packages 97 k, 5 k and 105 k objects, 82 k heap numbers (a flag word above the Smi range
 * boxes the field of every object of its shape) and 96 k strings, which a major GC marked one by one. A table now holds the
 * entries' fields as typed arrays (and the name strings once, in `NameTable.texts`); an entry is read through `at(index)`, a view
 * made when it is asked for, whose getters return exactly what the object held: the strings, the integers with their sign, the flag
 * words as unsigned numbers, `null` where the offset was null. Nothing keeps a view. `toObject(index)` makes the old plain object,
 * for validators and one-off tools.
 *
 * The array methods the readers used (`length`, iteration, `forEach`, `map`, `filter`, `find`, `findIndex`, `some`, `every`,
 * `flatMap`, `entries`, `slice`) are here, so only an index expression `table[i]` changed to `table.at(i)`. `Array.prototype.at`
 * takes the same call on a plain array (fixtures hand the readers plain arrays); a negative index is the readers' to avoid (`exportAt`).
 *
 * A path (`entry.path`) is the entry's name joined to its outers' names with `.`, built when it is asked for. `ExportPaths`
 * (`export-paths.mjs`) is the lowercase path index `exportsByPath` was.
 */

// util.inspect (an assertion's diff, a console.log) shows an entry as the object it was and a table as its size: the columns are megabytes.
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export class PackageTable {
  constructor(length) { this.length = length; }

  /** The entry at `index` (0-based), or undefined. */
  at(index) { return Number.isInteger(index) && index >= 0 && index < this.length ? this.view(index) : undefined; }

  *[Symbol.iterator]() { for (let index = 0; index < this.length; index += 1) yield this.view(index); }
  *entries() { for (let index = 0; index < this.length; index += 1) yield [index, this.view(index)]; }
  *keys() { for (let index = 0; index < this.length; index += 1) yield index; }
  *values() { yield* this; }
  forEach(visit, thisArg) { for (let index = 0; index < this.length; index += 1) visit.call(thisArg, this.view(index), index, this); }
  map(visit, thisArg) {
    const result = new Array(this.length);
    for (let index = 0; index < this.length; index += 1) result[index] = visit.call(thisArg, this.view(index), index, this);
    return result;
  }
  filter(test, thisArg) {
    const result = [];
    for (let index = 0; index < this.length; index += 1) {
      const entry = this.view(index);
      if (test.call(thisArg, entry, index, this)) result.push(entry);
    }
    return result;
  }
  find(test, thisArg) {
    for (let index = 0; index < this.length; index += 1) {
      const entry = this.view(index);
      if (test.call(thisArg, entry, index, this)) return entry;
    }
    return undefined;
  }
  findIndex(test, thisArg) {
    for (let index = 0; index < this.length; index += 1) if (test.call(thisArg, this.view(index), index, this)) return index;
    return -1;
  }
  some(test, thisArg) { return this.findIndex(test, thisArg) >= 0; }
  every(test, thisArg) {
    for (let index = 0; index < this.length; index += 1) if (!test.call(thisArg, this.view(index), index, this)) return false;
    return true;
  }
  flatMap(visit, thisArg) { return this.map(visit, thisArg).flat(1); }
  slice(start, end) { return this.toArray().slice(start, end); }
  /** The views of every entry, as an array. */
  toArray() { return this.map(entry => entry); }
  /** The old plain-object form of every entry (validators and one-off tools). */
  objects() { return this.map((entry, index) => this.toObject(index)); }
  [INSPECT]() { return `${this.constructor.name}(${this.length})`; }
  /** `JSON.stringify(pkg)` writes the old arrays of objects (scripts/inspect-package.mjs --tables). */
  toJSON() { return this.objects(); }
}

/** The names: `texts` (the spellings) and `flagWords` (the unsigned flag words). */
export class NameTable extends PackageTable {
  constructor(texts, flagWords) {
    super(texts.length);
    this.texts = texts;
    this.flagWords = flagWords;
  }
  /** The text of name `index`, or undefined past the table. */
  text(index) { return this.texts[index]; }
  view(index) { return new NameEntry(this, index); }
  toObject(index) { return { name: this.texts[index], flags: this.flagWords[index] }; }
  /** A table from the old form `[{name, flags}]` (fixtures). */
  static fromObjects(list) {
    return new NameTable(list.map(entry => entry.name), Uint32Array.from(list, entry => (entry.flags ?? 0) >>> 0));
  }
}

class NameEntry {
  constructor(table, index) { this.table = table; this.index = index; }
  get name() { return this.table.texts[this.index]; }
  get flags() { return this.table.flagWords[this.index]; }
  toObject() { return this.table.toObject(this.index); }
  toJSON() { return this.toObject(); }
  [INSPECT]() { return this.toObject(); }
}

/** The tables of one package, for the entries' paths and class names: `{names, imports, exports}`. */
export class PackageLinks {
  constructor(names, imports, exports) {
    this.names = names;
    this.imports = imports;
    this.exports = exports;
  }

  /** The name text of the object a reference names (positive: an export, negative: an import), or undefined. */
  nameOf(ref) {
    return ref > 0 ? this.exports.text(ref - 1) : ref < 0 ? this.imports.text(-ref - 1) : undefined;
  }
  outerOf(ref) { return ref > 0 ? this.exports.outers[ref - 1] : this.imports.outers[-ref - 1]; }

  /** The object path of a nonzero reference: its name joined to its outers' names with `.`. */
  pathOf(ref) {
    let outer = this.outerOf(ref);
    if (outer === 0) return this.nameOf(ref);
    const parts = [this.nameOf(ref)];
    // A parsed package has no cycle (parsePackage checks every chain); the bound keeps a hand-built one from looping.
    for (let steps = this.imports.length + this.exports.length; outer !== 0 && steps > 0; steps -= 1) {
      parts.push(this.nameOf(outer));
      outer = this.outerOf(outer);
    }
    return parts.reverse().join('.');
  }
}

/** The imports. A name is a position in `names`; the three string fields are read through it. */
export class ImportTable extends PackageTable {
  constructor(names, classPackages, classNames, outers, nameIndexes) {
    super(outers.length);
    this.names = names;
    this.classPackages = classPackages;
    this.classNames = classNames;
    this.outers = outers;
    this.nameIndexes = nameIndexes;
    this.links = null;
  }
  classPackage(index) { return this.names.texts[this.classPackages[index]]; }
  className(index) { return this.names.texts[this.classNames[index]]; }
  outer(index) { return this.outers[index]; }
  text(index) { return this.names.texts[this.nameIndexes[index]]; }
  path(index) { return this.links.pathOf(-index - 1); }
  view(index) { return new ImportEntry(this, index); }
  toObject(index) {
    return { classPackage: this.classPackage(index), className: this.className(index), outer: this.outers[index], name: this.text(index), path: this.path(index) };
  }
  /** A table from the old form (fixtures): the entries' paths are kept as given, `path` defaulting to the name. */
  static fromObjects(list) {
    const texts = [], at = text => { const found = texts.indexOf(text); if (found >= 0) return found; texts.push(text); return texts.length - 1; };
    const columns = [list.map(entry => at(entry.classPackage ?? '')), list.map(entry => at(entry.className ?? '')),
      list.map(entry => at(entry.name ?? ''))];
    const table = new ImportTable(new NameTable(texts, new Uint32Array(texts.length)), Int32Array.from(columns[0]), Int32Array.from(columns[1]),
      Int32Array.from(list, entry => entry.outer ?? 0), Int32Array.from(columns[2]));
    table.links = { pathOf: ref => list[-ref - 1].path ?? list[-ref - 1].name };
    return table;
  }
}

class ImportEntry {
  constructor(table, index) { this.table = table; this.index = index; }
  get classPackage() { return this.table.classPackage(this.index); }
  get className() { return this.table.className(this.index); }
  get outer() { return this.table.outers[this.index]; }
  get name() { return this.table.text(this.index); }
  get path() { return this.table.path(this.index); }
  toObject() { return this.table.toObject(this.index); }
  toJSON() { return this.toObject(); }
  [INSPECT]() { return this.toObject(); }
}

/** The exports. `classNames` and `paths` are null for a parsed package (derived from the tables); a fixture may carry them. */
export class ExportTable extends PackageTable {
  constructor(names, columns) {
    super(columns.outers.length);
    this.names = names;
    this.classIndexes = columns.classIndexes;
    this.superIndexes = columns.superIndexes;
    this.outers = columns.outers;
    this.nameIndexes = columns.nameIndexes;
    this.flagWords = columns.flagWords;
    this.serialSizes = columns.serialSizes;
    this.serialOffsets = columns.serialOffsets;
    this.links = null;
    this.fixtureClassNames = columns.classNames ?? null;
    this.fixturePaths = columns.paths ?? null;
  }
  text(index) { return this.names.texts[this.nameIndexes[index]]; }
  classIndex(index) { return this.classIndexes[index]; }
  superIndex(index) { return this.superIndexes[index]; }
  outer(index) { return this.outers[index]; }
  flags(index) { return this.flagWords[index]; }
  serialSize(index) { return this.serialSizes[index]; }
  /** The payload's offset, or null for an export with no payload (stored as -1: a payload's offset is past the header). */
  serialOffset(index) { const offset = this.serialOffsets[index]; return offset < 0 ? null : offset; }
  /** The name of the export's class: its class reference's name, `Class` for the null reference. */
  className(index) {
    if (this.fixtureClassNames !== null && this.fixtureClassNames[index] !== undefined) return this.fixtureClassNames[index];
    const ref = this.classIndexes[index];
    return ref === 0 ? 'Class' : this.links.nameOf(ref) ?? 'Class';
  }
  path(index) {
    if (this.fixturePaths !== null && this.fixturePaths[index] !== undefined) return this.fixturePaths[index];
    return this.links.pathOf(index + 1);
  }
  view(index) { return new ExportEntry(this, index); }
  toObject(index) {
    return { classIndex: this.classIndexes[index], superIndex: this.superIndexes[index], outer: this.outers[index], name: this.text(index),
      flags: this.flagWords[index], serialSize: this.serialSizes[index], serialOffset: this.serialOffset(index),
      className: this.className(index), path: this.path(index) };
  }
  /** A copy of the table with export `index` changed (fixtures: a synthetic payload size). The copy keeps the entries' class names and paths as they read. */
  with(index, changes) {
    const list = this.objects();
    list[index] = { ...list[index], ...changes };
    return ExportTable.fromObjects(list);
  }
  /** A table from the old form (fixtures); a field the entry lacks reads as 0 (null for the offset). */
  static fromObjects(list) {
    const texts = [], at = text => { const found = texts.indexOf(text); if (found >= 0) return found; texts.push(text); return texts.length - 1; };
    const nameIndexes = Int32Array.from(list, entry => at(entry.name ?? ''));
    const table = new ExportTable(new NameTable(texts, new Uint32Array(texts.length)), {
      classIndexes: Int32Array.from(list, entry => entry.classIndex ?? 0), superIndexes: Int32Array.from(list, entry => entry.superIndex ?? 0),
      outers: Int32Array.from(list, entry => entry.outer ?? 0), nameIndexes, flagWords: Uint32Array.from(list, entry => (entry.flags ?? 0) >>> 0),
      serialSizes: Int32Array.from(list, entry => entry.serialSize ?? 0), serialOffsets: Int32Array.from(list, entry => entry.serialOffset ?? -1),
      classNames: list.map(entry => entry.className), paths: list.map(entry => entry.path) });
    table.links = { nameOf: () => undefined, pathOf: ref => list[ref - 1].path ?? list[ref - 1].name };
    return table;
  }
}

class ExportEntry {
  constructor(table, index) { this.table = table; this.index = index; }
  get classIndex() { return this.table.classIndexes[this.index]; }
  get superIndex() { return this.table.superIndexes[this.index]; }
  get outer() { return this.table.outers[this.index]; }
  get name() { return this.table.text(this.index); }
  get flags() { return this.table.flagWords[this.index]; }
  get serialSize() { return this.table.serialSizes[this.index]; }
  get serialOffset() { return this.table.serialOffset(this.index); }
  get className() { return this.table.className(this.index); }
  get path() { return this.table.path(this.index); }
  toObject() { return this.table.toObject(this.index); }
  toJSON() { return this.toObject(); }
  [INSPECT]() { return this.toObject(); }
}
