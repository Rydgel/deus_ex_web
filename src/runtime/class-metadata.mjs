import {readClass} from '../unreal/classes.mjs';

/** A linked class's `metadata`: the fields the simulation reads, and the rest of the class export's source on demand.
 *
 * Host representation only (docs/live-heap.md "Load records and functions"). Linking spread everything `readClass` decodes into every
 * class's metadata: the dependency list (an object and a boxed CRC each, 19,000 on the Island), the decoded default properties
 * (their values and byte copies), the guid and the tail. The class loader's comment says the runtime state and the defaults come from the
 * serialized native records, not from these tags, and a trace over the three maps' benchmarks and 25 class-graph validators read
 * five fields of a class's metadata: `entry`, `classFlags`, `probeMask`, `ignoreMask` and `scriptSize`. Those, and the words the loader
 * overrides from the native record (`stateFlags`, `labelTableOffset`), are fields here. Every other key `readClass` returns reads the
 * export again on its first use and keeps the result, so a reader that wants one sees the value the spread held: the package bytes do
 * not change. The link still decodes the export once (readClass's own checks run at the same moment as before). */
const SOURCE_KEYS = ['base', 'next', 'scriptText', 'children', 'friendlyName', 'line', 'textPosition', 'scriptBytes', 'dependencies',
  'packageImports', 'within', 'configName', 'defaultsOffset', 'properties', 'values'];

export class ClassMetadata {
  constructor(asset, index, source, overrides) {
    this.entry = source.entry;
    this.classFlags = overrides.classFlags;
    this.probeMask = overrides.probeMask;
    this.ignoreMask = overrides.ignoreMask;
    this.stateFlags = overrides.stateFlags;
    this.labelTableOffset = overrides.labelTableOffset;
    this.scriptSize = overrides.scriptSize;
    this.sourceAsset = asset;
    this.sourceIndex = index;
    this.sourceDecoded = null;
  }
  /** What `readClass` returns for this export, decoded on the first use of a key held back. */
  source() { return this.sourceDecoded ??= readClass(this.sourceAsset, this.sourceIndex); }
}

for (const key of SOURCE_KEYS) {
  Object.defineProperty(ClassMetadata.prototype, key, {
    get() { return this.source()[key]; },
    // a write makes the key an own property, as an assignment to the old plain object did
    set(value) { Object.defineProperty(this, key, {value, writable: true, enumerable: true, configurable: true}); },
    enumerable: false, configurable: true,
  });
}
