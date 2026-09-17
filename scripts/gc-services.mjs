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

  /**
   * Per-case reset for a SHARED heap — mirrors the draw probe's run_case:
   * events and the 'a<N>' fallback counter restart; 'h<N>' (allocated
   * blocks), 'rec<N>'/'recStatic' (the process-global realize cache) and
   * their memory persist across cases exactly like the oracle's .bss.
   */
  resetCase() {
    this.events.length = 0;
    this.seen.clear();
    for (const [addr, label] of [...this.labels])
      if (!/^(h\d+|rec\d+|recStatic)$/.test(label)) this.labels.delete(addr);
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
  // Dict spec values build their runtime image here — in GC_FIELDS order,
  // matching the probe's _write_fields allocation/label sequence.
  const resolve = value => {
    if (value === 'this') return base;
    if (value && typeof value === 'object') {
      if ('node' in value) return nodeAddrs[value.node];
      if ('$canvas' in value) return buildCanvas(heap, value.$canvas);
      if ('$font' in value) return buildFont(heap, value.$font);
      if ('$texture' in value) return buildTexture(heap, value.$texture);
    }
    return value;
  };
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

// ---------------------------------------------------------------------------
// Draw-boundary images (scripts/native-gc-draw-probe.py mirrors).  The stub
// sentinels land in vtable slots; services.callVirtual distinguishes the
// boundary by which sentinel it was handed.
// ---------------------------------------------------------------------------

export const DRAW_TILE_SLOT = 0x5c;    // canvas vtable — UCanvas::DrawTile
export const DRAW_GLYPH_SLOT = 0x7c;   // FRenderInterface vtable — glyph path
export const TEX_LOCK_SLOT = 0x54;     // UTexture vtable — realize-cache Lock
export const TEX_UNLOCK_SLOT = 0x58;   // UTexture vtable — realize-cache Unlock
export const CANVAS_Z = 0x4c;
export const CANVAS_VIEWPORT = 0x78;   // canvas -> Viewport (realize Lock args)
export const CANVAS_SCENENODE = 0x7c;  // canvas -> FSceneNode (glyph arg0)
export const VIEWPORT_RI = 0x64;       // *sceneNode / viewport -> RI
export const TEX_USIZE = 0x34;
export const TEX_VSIZE = 0x38;

export const DRAW_STUB = 0xdeadc0de;
export const GLYPH_STUB = 0xdeadc0df;
export const LOCK_STUB = 0xdeadc0e0;
export const UNLOCK_STUB = 0xdeadc0e1;

/** Runtime UFont/FPage/FFontCharacter sizes (script-font-model.mjs). */
const FONT_CPP = 0x28, FONT_PAGES = 0x2c, FONT_COUNT = 0x30, FONT_MAX = 0x34;
const FONT_PAGE_SIZE = 0x10, FONT_GLYPH_SIZE = 0x10;

/** Fake UTexture: dims at +0x34/+0x38, Lock/Unlock stubs in the vtable. */
export function buildTexture(heap, spec = {}) {
  const tex = heap.allocRaw(0x60);
  const vtable = heap.allocRaw(0x80);
  heap.write(tex, 'u32', vtable);
  heap.write(vtable + TEX_LOCK_SLOT, 'u32', LOCK_STUB);
  heap.write(vtable + TEX_UNLOCK_SLOT, 'u32', UNLOCK_STUB);
  heap.write(tex + TEX_USIZE, 'i32', spec.u | 0);
  heap.write(tex + TEX_VSIZE, 'i32', spec.v | 0);
  heap.labels.set(tex, `tex${[...heap.labels.values()].filter(l => /^tex\d/.test(l)).length}`);
  return tex;
}

/**
 * Fake canvas + the render graph DrawText's glyph path needs:
 * canvas+0x78 -> viewport (+0x64 RI, +0xb0/+0xb4 forwarded to Lock),
 * canvas+0x7c -> scene node (*node+0x64 -> the same RI whose vtable+0x7c
 * is the glyph emit slot).  The canvas's own +0x5c stays a DrawTile stub.
 */
export function buildCanvas(heap, spec = {}) {
  const canvas = heap.allocRaw(0x80);
  const vtable = heap.allocRaw(0x100);
  heap.write(canvas, 'u32', vtable);
  heap.write(vtable + DRAW_TILE_SLOT, 'u32', DRAW_STUB);
  heap.write(canvas + CANVAS_Z, 'u32', resolveBits(spec.z ?? 0));
  const riVtable = heap.allocRaw(0x100);
  heap.write(riVtable + DRAW_GLYPH_SLOT, 'u32', GLYPH_STUB);
  const ri = heap.allocRaw(0x40);
  heap.write(ri, 'u32', riVtable);
  const vp = heap.allocRaw(0xc0);
  heap.write(vp + VIEWPORT_RI, 'u32', ri);
  if (spec.vpB0 !== undefined) heap.write(vp + 0xb0, 'u32', resolveBits(spec.vpB0));
  if (spec.vpB4 !== undefined) heap.write(vp + 0xb4, 'u32', resolveBits(spec.vpB4));
  const node = heap.allocRaw(0x40);
  heap.write(node, 'u32', vp);
  heap.write(canvas + CANVAS_VIEWPORT, 'u32', vp);
  heap.write(canvas + CANVAS_SCENENODE, 'u32', node);
  heap.labels.set(canvas, 'canvas');
  heap.labels.set(vp, 'vp');
  heap.labels.set(node, 'scenenode');
  heap.labels.set(ri, 'ri');
  return canvas;
}

/**
 * Runtime UFont image mirroring the probe's build_font: +0x28 charsPerPage,
 * +0x2c page table of 16-byte {texture, chars, num, max} records.
 * `pages[i]` = {'page'?: table-index, 'tex': {u,v}|0, 'chars': {rem: rec}|list}.
 */
export function buildFont(heap, spec) {
  const pages = spec.pages ?? [];
  const count = spec.pageCount ??
    pages.reduce((m, p, i) => Math.max(m, (p.page ?? i) + 1), 0);
  const font = heap.allocRaw(0x40);
  const table = heap.allocRaw(FONT_PAGE_SIZE * count);
  heap.bytes.fill(0, table, table + FONT_PAGE_SIZE * count);
  pages.forEach((page, i) => {
    const p = page.page ?? i;
    const chars = page.chars;
    let num, run;
    if (Array.isArray(chars)) {
      num = chars.length;
      run = heap.allocRaw(FONT_GLYPH_SIZE * Math.max(num, 1));
      heap.bytes.fill(0, run, run + FONT_GLYPH_SIZE * Math.max(num, 1));
      chars.forEach((rec, j) => {
        heap.write(run + FONT_GLYPH_SIZE * j + 0, 'i32', rec[0]);
        heap.write(run + FONT_GLYPH_SIZE * j + 4, 'i32', rec[1]);
        heap.write(run + FONT_GLYPH_SIZE * j + 8, 'i32', rec[2]);
        heap.write(run + FONT_GLYPH_SIZE * j + 12, 'i32', rec[3]);
      });
    } else {
      // {remainder-index: [startU, startV, uSize, vSize]} — the glyph array
      // is indexed by codepoint % charsPerPage; holes stay zeroed.
      const keys = Object.keys(chars).map(Number);
      num = keys.length ? Math.max(...keys) + 1 : 0;
      run = heap.allocRaw(FONT_GLYPH_SIZE * Math.max(num, 1));
      heap.bytes.fill(0, run, run + FONT_GLYPH_SIZE * Math.max(num, 1));
      for (const [rem, rec] of Object.entries(chars)) {
        heap.write(run + FONT_GLYPH_SIZE * Number(rem) + 0, 'i32', rec[0]);
        heap.write(run + FONT_GLYPH_SIZE * Number(rem) + 4, 'i32', rec[1]);
        heap.write(run + FONT_GLYPH_SIZE * Number(rem) + 8, 'i32', rec[2]);
        heap.write(run + FONT_GLYPH_SIZE * Number(rem) + 12, 'i32', rec[3]);
      }
    }
    const tex = page.tex ? buildTexture(heap, page.tex) : 0;
    heap.write(table + FONT_PAGE_SIZE * p + 0, 'u32', tex);
    heap.write(table + FONT_PAGE_SIZE * p + 4, 'u32', run);
    heap.write(table + FONT_PAGE_SIZE * p + 8, 'i32', num);
    heap.write(table + FONT_PAGE_SIZE * p + 12, 'i32', num);
  });
  heap.write(font + FONT_CPP, 'i32', spec.charsPerPage | 0);
  heap.write(font + FONT_PAGES, 'u32', table);
  heap.write(font + FONT_COUNT, 'i32', count);
  heap.write(font + FONT_MAX, 'i32', count);
  heap.labels.set(font, `font${[...heap.labels.values()].filter(l => /^font\d/.test(l)).length}`);
  return font;
}

/**
 * The DrawText realize cache service: five 0x84-byte FTextureInfo records
 * (labelled rec0..rec4) plus the static record, an empty MRU list.
 */
export function makeTexCache(heap) {
  const records = [0, 1, 2, 3, 4].map(i => {
    const rec = heap.allocRaw(0x84);
    heap.labels.set(rec, `rec${i}`);
    return rec;
  });
  const statik = heap.allocRaw(0x84);
  heap.labels.set(statik, 'recStatic');
  return {records, static: statik, head: 0, count: 0};
}

const F32B = new Float32Array(1);
const U32B = new Uint32Array(F32B.buffer);
export const resolveBits = v => (v && typeof v === 'object' && 'f' in v
  ? (F32B[0] = v.f, U32B[0]) : v >>> 0);

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
