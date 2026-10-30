/** A linker's export table (ULinkerLoad's ExportMap) over the package's parsed export entries.
 *
 * Host representation only (docs/live-heap.md "Steps 2 and 3's results"). Each linker used to copy every export's classIndex,
 * superIndex, flags, serialSize and serialOffset into one more object, and the DynamicLoadObject graph built a third. Here the entries
 * stay the package's (`pkg.exports`, read-only, shared by every reader of the package) and the table keeps only what the linker owns
 * and changes: the interned name of each export, the created object, and the hash chain, as one typed array and one array of objects.
 * The original's FObjectExport slots are read through `record(index)`, a view that reads and writes the table, so a reader that holds
 * one sees the current object. Hot walks (the export hash, VerifyImport's candidate scan) read the columns by index and allocate nothing.
 *
 * Fixtures and validators hand the same functions plain arrays of records; the `export*` helpers read both.
 */
import { ExportTable } from '../unreal/package-tables.mjs';

class ExportRecord {
  constructor(table, index) {
    this.table = table;
    this.index = index;
  }
  get classIndex() { return this.table.entries.classIndexes[this.index]; }
  get superIndex() { return this.table.entries.superIndexes[this.index]; }
  get packageIndex() { return this.table.entries.outers[this.index]; }
  get objectName() { return this.table.names[this.index]; }
  get objectFlags() { return this.table.entries.flagWords[this.index]; }
  get serialSize() { return this.table.entries.serialSizes[this.index]; }
  get serialOffset() { return this.table.entries.serialOffset(this.index); }
  get object() { return this.table.objects[this.index]; }
  set object(value) { this.table.objects[this.index] = value; }
  get hashNext() { return this.table.hashNexts[this.index]; }
  set hashNext(value) { this.table.hashNexts[this.index] = value; }
}

/** The DynamicLoadObject graph's view of an export (script-dynamic-load-object.mjs): StaticLoadObject's FindExportIndex reads these names. */
export class DynamicExportRecord {
  constructor(table, index) {
    this.table = table;
    this.index = index;
  }
  get classIndex() { return this.table.entries.classIndexes[this.index]; }
  get outerIndex() { return this.table.entries.outers[this.index]; }
  get nameIndex() { return this.table.names[this.index]; }
  get object() { return this.table.objects[this.index]; }
  set object(value) { this.table.objects[this.index] = value; }
  get nextHash() { return this.table.hashNexts[this.index]; }
  set nextHash(value) { this.table.hashNexts[this.index] = value; }
}

export class LinkerExports {
  /** `entries`: the package's parsed exports (an ExportTable; a fixture's plain array of records becomes one); `names`: an Int32Array of
   * each export's process-wide FName index. */
  constructor(entries, names, View = ExportRecord) {
    this.entries = Array.isArray(entries) ? ExportTable.fromObjects(entries) : entries;
    entries = this.entries;
    this.names = names;
    this.View = View;
    this.objects = new Array(entries.length).fill(null);
    this.hashNexts = new Int32Array(entries.length).fill(-1);
    this.length = entries.length;
  }

  classIndex(index) { return this.entries.classIndexes[index]; }
  packageIndex(index) { return this.entries.outers[index]; }
  objectName(index) { return this.names[index]; }
  objectFlags(index) { return this.entries.flagWords[index]; }
  object(index) { return this.objects[index]; }
  setObject(index, value) { this.objects[index] = value; }
  hashNext(index) { return this.hashNexts[index]; }
  setHashNext(index, value) { this.hashNexts[index] = value; }

  /** The FObjectExport view of an export, or undefined past the end. */
  record(index) {
    return Number.isInteger(index) && index >= 0 && index < this.length ? new this.View(this, index) : undefined;
  }

  *[Symbol.iterator]() { for (let index = 0; index < this.length; index += 1) yield new this.View(this, index); }
  some(test) { for (const record of this) if (test(record)) return true; return false; }
  every(test) { for (const record of this) if (!test(record)) return false; return true; }

  /** Whether any export has its object created. */
  hasObject() {
    for (let index = 0; index < this.objects.length; index += 1) if (this.objects[index]) return true;
    return false;
  }
}

const table = exports => exports instanceof LinkerExports;

/** The export record at an index (a view for a LinkerExports, the element of a plain array), or undefined. */
export const exportRecord = (exports, index) => table(exports) ? exports.record(index) : exports?.[index];
/** The created object of an export (undefined when there is no such export). */
export const exportObject = (exports, index) => table(exports) ? exports.object(index) : exports?.[index]?.object;
export const setExportObject = (exports, index, object) => {
  if (table(exports)) exports.setObject(index, object);
  else exports[index].object = object;
};
export const exportsHaveObject = exports => table(exports) ? exports.hasObject() : exports.some(entry => entry.object);
