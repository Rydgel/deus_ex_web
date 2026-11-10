import {NativeSlots} from './native-slots.mjs';

/** A load-graph record (script-load-graph.mjs makeRecord): the stand-in for a UObject in native memory. It is its own slot store
 * (`nativeSlots` is the record itself), so the words at its native offsets are its indexed elements and the record is one object and its
 * elements, not a record, a wrapper and a pair array (docs/live-heap.md "Load records and functions").
 *
 * The fields below are the ones every record has. The names a record gained afterwards stay as they are (a resource's `resourceConstructed`
 * and mesh payload, a static class's `staticClass`): few records have them. `nativeAddress` and `address` are assigned after construction
 * with the record's synthetic address, a number past V8's Smi range. */
export class LoadRecord extends NativeSlots {
  constructor(key, kind) {
    super();
    this.nativeAddress = null;
    this.address = null;
    this.key = key;
    this.name = key;
    this.loadOrdinal = -1; // its place in the load edges (script-load-edges.mjs)
    this.nativeConstructor = null;
    this.objectFlags = null;
    this.base = null;
    this.kind = kind;
    this.instanceValues = null; // a resource's instance memory above +0x28 (an OffsetMap), made where one is constructed or first written
    this.hashBuckets = null;
    this.farrays = null;
    this.script = null;
    this.defaults = null;
  }
  get nativeSlots() { return this; }
}
