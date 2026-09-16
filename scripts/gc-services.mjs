/**
 * Shared validator-side services for the UGC drawing-state model.
 *
 * `GcHeap` is a byte-addressable bump heap mirroring the probe's scratch
 * allocator.  `buildGc` constructs the same object image the probe's
 * `gc_object()` does (0xb8 padded to 0x100, per-case fill byte, spec fields
 * as raw bit patterns, `nodes` pre-built linked objects referenced by
 * `{node: i}` / `'this'`) and `dumpState` reproduces the probe's canonical
 * dump including the raw 0x28..0xb8 hex so stray writes are caught.
 * `allocateObject` models the intercepted `UObject::StaticAllocateObject`
 * leaf PushGC reaches through the operator-new wrapper.
 */

const GC_VTABLE = 0x100598dc;
const GC_PRIVATE_CLASS = 0x100a28c8;
const ORACLE_DELTA = 0x12000000 - 0x10000000;

export class GcHeap {
  constructor() {
    this.bytes = new Uint8Array(0x40000);
    this.view = new DataView(this.bytes.buffer);
    this.next = 0x1000;
    this.sizes = new Map();
    this.seen = new Map();
    this.labels = new Map();
    this.hblocks = new Map();
    this.nodeAddrs = null;
    this.allocReturnsNull = false;
    this.events = [];
  }

  allocRaw(size) {
    const address = this.next;
    this.next += (Math.max(size, 4) + 15) & ~15;
    this.sizes.set(address, Math.max(size, 4));
    return address;
  }

  alloc(size, tag = 'new') {
    const address = this.allocRaw(size);
    this.events.push({op: 'Malloc', size, tag, block: `a${this.seen.size}`});
    return address;
  }

  /**
   * Modelled UObject::StaticAllocateObject leaf (the operator-new wrapper
   * always passes Class=&UGC::PrivateStaticClass, Name=NAME_None,
   * SetFlags=0, Template=0, Ptr=0).  Records the event the oracle's
   * intercepted leaf records, then returns a fresh zeroed 0x100-padded
   * block labelled 'h<N>'; spec.allocReturnsNull yields 0 instead.
   */
  allocateObject({outer, size}) {
    this.events.push({
      op: 'StaticAllocateObject',
      class: 'UGC::PrivateStaticClass',
      outer: this.canon(outer),
      name: 0,
      setFlags: 0,
      template: 0,
      ptr: 0,
    });
    if (this.allocReturnsNull) return 0;
    const address = this.allocRaw(0x100);
    this.bytes.fill(0, address, address + 0x100);
    this.sizes.set(address, size ?? 0xb8);
    const label = `h${this.hblocks.size}`;
    this.hblocks.set(address, label);
    this.labels.set(address, label);
    return address;
  }

  /** Intercepted Core `UObject::UObject()` base constructor leaf. */
  constructUObject(address) {
    this.events.push({op: 'UObject::UObject', object: this.canon(address)});
  }

  canon(address) {
    if (!address) return 0;
    if (address === GC_VTABLE || address === GC_VTABLE + ORACLE_DELTA) return 'UGC::vtable';
    if (address === GC_PRIVATE_CLASS || address === GC_PRIVATE_CLASS + ORACLE_DELTA)
      return 'UGC::PrivateStaticClass';
    if (this.labels.has(address)) return this.labels.get(address);
    if (this.seen.has(address)) return this.seen.get(address);
    const label = `a${this.seen.size}`;
    this.seen.set(address, label);
    return label;
  }

  read(address, kind) {
    switch (kind) {
      case 'i32': return this.view.getInt32(address, true);
      case 'u32': return this.view.getUint32(address, true);
      case 'i16': return this.view.getInt16(address, true);
      case 'u16': return this.view.getUint16(address, true);
      case 'i8': return this.view.getInt8(address);
      case 'u8': return this.view.getUint8(address);
      case 'f32': return this.view.getFloat32(address, true);
      default: throw new Error(`unsupported heap kind ${kind}`);
    }
  }

  write(address, kind, value) {
    switch (kind) {
      case 'i32': this.view.setInt32(address, value | 0, true); break;
      case 'u32': this.view.setUint32(address, value >>> 0, true); break;
      case 'i16': this.view.setInt16(address, value | 0, true); break;
      case 'u16': this.view.setUint16(address, value & 0xffff, true); break;
      case 'i8': this.view.setInt8(address, value | 0); break;
      case 'u8': this.view.setUint8(address, value & 0xff); break;
      case 'f32': this.view.setFloat32(address, Math.fround(value), true); break;
      default: throw new Error(`unsupported heap kind ${kind}`);
    }
  }
}

// UGC field layout: name -> [offset, kind].  'bits4' takes a list of four
// dword bit patterns.  Mirrors GC_FIELDS in scripts/native-gc-probe.py.
const GC_FIELDS = {
  vtable: [0x00, 'u32'],
  canvas: [0x28, 'u32'],
  originX: [0x2c, 'u32'],
  originY: [0x30, 'u32'],
  clipX: [0x34, 'u32'],
  clipY: [0x38, 'u32'],
  clipWidth: [0x3c, 'u32'],
  clipHeight: [0x40, 'u32'],
  style: [0x44, 'u8'],
  flags: [0x48, 'u32'],
  polyFlags: [0x4c, 'u32'],
  textPolyFlags: [0x50, 'u32'],
  tileColor: [0x54, 'u32'],
  tileFloats: [0x58, 'bits4'],
  textColor: [0x68, 'u32'],
  textFloats: [0x6c, 'bits4'],
  normalFont: [0x7c, 'u32'],
  boldFont: [0x80, 'u32'],
  unknown84: [0x84, 'u32'],
  underlineHeight: [0x88, 'u32'],
  baselineOffset: [0x8c, 'u32'],
  textVSpacing: [0x90, 'u32'],
  hAlign: [0x94, 'u8'],
  vAlign: [0x95, 'u8'],
  textFlags: [0x98, 'u32'],
  unknown9c: [0x9c, 'u32'],
  unknownA0: [0xa0, 'u32'],
  nodeFlags: [0xa4, 'u32'],
  depth: [0xa8, 'u32'],
  stackTop: [0xac, 'u32'],
  freeList: [0xb0, 'u32'],
  owner: [0xb4, 'u32'],
};

export function buildGc(heap, spec = {}) {
  const base = heap.allocRaw(0x100);
  const nodes = spec.nodes;
  const nodeAddrs = nodes ? nodes.map(() => heap.allocRaw(0x100)) : [];
  heap.nodeAddrs = nodes ? nodeAddrs : null;
  heap.allocReturnsNull = Boolean(spec.allocReturnsNull);
  heap.labels.set(base, 'this');
  nodeAddrs.forEach((address, i) => heap.labels.set(address, `n${i}`));
  const fill = (spec.fill ?? 0xa5) & 0xff;
  heap.bytes.fill(fill, base, base + 0x100);
  for (const address of nodeAddrs) heap.bytes.fill(fill, address, address + 0x100);
  const resolve = value => value === 'this' ? base
    : (value && typeof value === 'object' && 'node' in value ? nodeAddrs[value.node] : value);
  const writeFields = (address, fields) => {
    for (const [name, [offset, kind]] of Object.entries(GC_FIELDS)) {
      if (!(name in fields)) continue;
      const value = resolve(fields[name]);
      if (kind === 'bits4') {
        for (let i = 0; i < 4; i++) heap.write(address + offset + 4 * i, 'u32', value[i]);
      } else {
        heap.write(address + offset, kind, value);
      }
    }
  };
  writeFields(base, spec);
  nodes?.forEach((fields, i) => writeFields(nodeAddrs[i], fields));
  return {base, heap, spec, nodeAddrs};
}

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** Decode a raw f32 bit pattern (u32) to the JS number the heap stores. */
export function f32FromBits(bits) {
  U32[0] = bits >>> 0;
  return F32[0];
}

const GC_PTR_FIELDS = new Set(['vtable', 'canvas', 'normalFont', 'boldFont',
  'stackTop', 'freeList', 'owner']);

function dumpObject(heap, base, canonPtrs) {
  const state = {};
  for (const [name, [offset, kind]] of Object.entries(GC_FIELDS)) {
    if (kind === 'bits4') {
      state[name] = [0, 1, 2, 3].map(i => heap.read(base + offset + 4 * i, 'u32'));
    } else {
      const value = heap.read(base + offset, kind);
      state[name] = canonPtrs && GC_PTR_FIELDS.has(name) ? heap.canon(value) : value;
    }
  }
  const raw = heap.bytes.slice(base + 0x28, base + 0xb8);
  if (canonPtrs) {
    // Pointer fields carry raw addresses that differ between runtimes; the
    // canonicalised fields carry the graph identity, so zero them in the hex.
    for (const name of GC_PTR_FIELDS) {
      const offset = GC_FIELDS[name][0];
      if (offset >= 0x28 && offset <= 0xb4) raw.fill(0, offset - 0x28, offset - 0x24);
    }
  }
  state.raw = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');
  return state;
}

export function dumpState(heap, base) {
  if (!heap.nodeAddrs && heap.hblocks.size === 0)
    return dumpObject(heap, base, false);
  const state = {this: dumpObject(heap, base, true), nodes: {}};
  const seen = new Set([base]);
  (heap.nodeAddrs ?? []).forEach((address, i) => {
    seen.add(address);
    state.nodes[`n${i}`] = dumpObject(heap, address, true);
  });
  for (const chain of [0xac, 0xb0]) {
    let address = heap.read(base + chain, 'u32');
    while (address && !seen.has(address)) {
      seen.add(address);
      state.nodes[heap.canon(address)] = dumpObject(heap, address, true);
      address = heap.read(address + 0xac, 'u32');
    }
  }
  for (const [address, label] of heap.hblocks) {
    if (!seen.has(address)) state.nodes[label] = dumpObject(heap, address, true);
  }
  return state;
}
