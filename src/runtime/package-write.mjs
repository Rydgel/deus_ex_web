/** A version-68 Unreal package writer: the file layout UObject::SavePackage produces for a saved level (docs/travel.md "The .dxs").
 *
 *   header (64 bytes)   magic 0x9e2a83c1, version 68, licensee 0, package flags, the name, export and import tables' count and offset,
 *                       the GUID, one generation {exports, names}
 *   names               at 64: FString + flags (u32) each
 *   export data         each export's serialized bytes, in export order
 *   imports             compact indices: classPackage, className (names), outer (i32), object name
 *   exports             compact class, compact super, outer (i32), name, flags (u32), compact serial size, compact serial offset (when size > 0)
 *
 * Names and imports are those the exports use. Their order, and the export order, are the caller's: the original writes them in GObjObjects and
 * FName-table order, which a Play session does not reproduce (docs/travel.md "Unresolved" 10), so a package keeps the source package's order for the
 * entries it holds, then adds the new ones in first-use order.
 *
 * The exports are serialized twice. The first pass (`collect`) only learns which names and imports the payloads use; the second writes the bytes with
 * the final indices. A payload writer is therefore a pure function of the context `{nameIndex, objectRef}` it is given. */
import { ByteWriter } from './byte-writer.mjs';

const lower = value => String(value ?? '').toLowerCase();
export const PACKAGE_VERSION = 68;
const MAGIC = 0x9e2a83c1;

/** The import table and the name table being collected, and the translation of a source package's references into them. */
export class PackageTables {
  constructor({ sourcePkg = null } = {}) {
    this.names = new Map();      // lower -> {text, flags, first, sourceIndex}
    this.importEntries = new Map();   // key -> {key, classPackage, className, outerKey, name, first, sourceIndex}
    this.sequence = 0;
    this.sourceNames = new Map();
    this.sourceImportOrder = new Map();
    if (sourcePkg) {
      sourcePkg.names.forEach((entry, i) => { if (!this.sourceNames.has(lower(entry.name))) this.sourceNames.set(lower(entry.name), { index: i, flags: entry.flags, text: entry.name }); });
      sourcePkg.imports.forEach((entry, i) => this.sourceImportOrder.set(importKey(entry.classPackage, entry.className, entry.outer ? importKeyOfIndex(sourcePkg, entry.outer) : '', entry.name), i));
    }
    this.finalNames = null; this.finalImports = null; this.exportCount = 0;
  }
  /** The name table index of `text` (in the first pass a placeholder; the name is recorded). */
  name(text) {
    text = String(text);
    const key = lower(text);
    let entry = this.names.get(key);
    if (!entry) {
      const source = this.sourceNames.get(key);
      entry = { text: source?.text ?? text, flags: source?.flags ?? 0x70010, first: this.sequence++, sourceIndex: source?.index ?? null };
      this.names.set(key, entry);
    }
    return this.finalNames ? this.finalNames.get(key) : 0;
  }
  /** An import entry (and its outer chain) for a package-level object; returns its negative index (a placeholder in the first pass). */
  importEntry({ classPackage, className, outerKey, name }) {
    const key = importKey(classPackage, className, outerKey, name);
    if (!this.importEntries.has(key))
      this.importEntries.set(key, { key, classPackage, className, outerKey, name, first: this.sequence++, sourceIndex: this.sourceImportOrder.get(key) ?? null });
    this.name(classPackage); this.name(className); this.name(name);
    return key;
  }
  importIndex(key) { return this.finalImports ? this.finalImports.get(key) : -1; }
  /** The import of `asset`'s package object itself (`Core.Package:<name>`). */
  packageKey(asset) {
    return this.importEntry({ classPackage: 'Core', className: 'Package', outerKey: '', name: asset.name });
  }
  /** The import key of export `index` of `asset` (a package asset: name, pkg), with its outer chain. */
  resourceKey(asset, index) {
    const entry = asset.pkg.exports[index - 1];
    if (!entry) throw new Error(`No export ${index} in ${asset.name}`);
    const outerKey = entry.outer === 0 ? this.packageKey(asset) : this.resourceKey(asset, entry.outer);
    // class index 0 is Core.Class itself (a class export: the package writer leaves its class implicit)
    if (entry.classIndex === 0) return this.importEntry({ classPackage: 'Core', className: 'Class', outerKey, name: entry.name });
    const classEntry = entry.classIndex < 0 ? asset.pkg.imports[-entry.classIndex - 1] : asset.pkg.exports[entry.classIndex - 1];
    if (!classEntry) throw new Error(`${asset.name}.${entry.path}: no class entry`);
    const classPackage = entry.classIndex < 0 ? classEntry.path.split('.')[0] : asset.name;
    return this.importEntry({ classPackage, className: classEntry.name, outerKey, name: entry.name });
  }
  /** Fix the final tables: source order first, then first use. */
  finalize() {
    const order = (a, b) => (a.sourceIndex !== null && b.sourceIndex !== null) ? a.sourceIndex - b.sourceIndex : a.sourceIndex !== null ? -1 : b.sourceIndex !== null ? 1 : a.first - b.first;
    const names = [...this.names.entries()].sort((x, y) => order(x[1], y[1]));
    this.finalNames = new Map(names.map(([key], i) => [key, i]));
    this.nameList = names.map(([, entry]) => entry);
    const imports = [...this.importEntries.values()].sort(order);
    this.finalImports = new Map(imports.map((entry, i) => [entry.key, -(i + 1)]));
    this.importList = imports;
  }
}

const importKey = (classPackage, className, outerKey, name) => lower(`${classPackage}.${className}:${outerKey}:${name}`);
function importKeyOfIndex(pkg, ref) {
  const entry = pkg.imports[-ref - 1];
  return importKey(entry.classPackage, entry.className, entry.outer ? importKeyOfIndex(pkg, entry.outer) : '', entry.name);
}

/**
 * @param tables      PackageTables
 * @param exports     [{className, classKey|classExport, superRef, outerExport, name, flags, write(w)}] in export order; `classKey` an import key
 *                    (PackageTables.resourceKey), or `classExport` an export position (1-based); `outerExport` an export position or 0
 * @param guid        16 bytes
 */
export function buildPackage(tables, exports, { guid }) {
  const data = exports.map(entry => { const w = new ByteWriter(1024); entry.write(w); return w.finish(); });
  const header = 64;
  let nameBytes;
  {
    const w = new ByteWriter(4096);
    for (const entry of tables.nameList) { w.string(entry.text); w.u32(entry.flags); }
    nameBytes = w.finish();
  }
  const offsets = [];
  let at = header + nameBytes.length;
  for (const bytes of data) { offsets.push(at); at += bytes.length; }
  const importsOffset = at;
  const importBytes = (() => {
    const w = new ByteWriter(4096);
    for (const entry of tables.importList) {
      w.compact(tables.finalNames.get(lower(entry.classPackage))); w.compact(tables.finalNames.get(lower(entry.className)));
      w.i32(entry.outerKey ? tables.finalImports.get(entry.outerKey) : 0);
      w.compact(tables.finalNames.get(lower(entry.name)));
    }
    return w.finish();
  })();
  const exportsOffset = importsOffset + importBytes.length;
  const exportBytes = (() => {
    const w = new ByteWriter(8192);
    exports.forEach((entry, i) => {
      w.compact(entry.classKey ? tables.finalImports.get(entry.classKey) : entry.classExport);
      w.compact(entry.superRef ?? 0);
      w.i32(entry.outerExport ?? 0);
      w.compact(tables.finalNames.get(lower(entry.name)));
      w.u32(entry.flags);
      w.compact(data[i].length);
      if (data[i].length > 0) w.compact(offsets[i]);
    });
    return w.finish();
  })();
  const out = new ByteWriter(exportsOffset + exportBytes.length + 16);
  out.u32(MAGIC); out.u16(PACKAGE_VERSION); out.u16(0); out.u32(1);
  out.i32(tables.nameList.length); out.i32(header);
  out.i32(exports.length); out.i32(exportsOffset);
  out.i32(tables.importList.length); out.i32(importsOffset);
  out.raw(guid);
  out.i32(1); out.u32(exports.length); out.u32(tables.nameList.length);
  if (out.length !== header) throw new Error(`package header is ${out.length} bytes`);
  out.raw(nameBytes);
  for (const bytes of data) out.raw(bytes);
  out.raw(importBytes); out.raw(exportBytes);
  return out.finish();
}
