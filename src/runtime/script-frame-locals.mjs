/**
 * Function frames in the object arena (docs/rust-core.md, step R2a).
 *
 * UObject::CallFunction and ProcessEvent take a UFunction's frame block from
 * the FMemStack: `round4(round8(PropertiesSize +0x3c))` bytes, zeroed before
 * any argument is evaluated (ProcessEvent zeroes the part after the copied
 * parameters), with every parameter and local at its linked Offset `+0x48`
 * ([events](../../docs/script-events.md#temporary-frame-and-parameter-abi),
 * [execution](../../docs/script-execution.md)). The block is released when
 * the call returns. `FrameStack` is that allocator over the runtime's arena,
 * and `FrameLocals` addresses one block through the object-image cells
 * (script-object-image.mjs), so a local reads and writes the same bytes an
 * object property of that type does.
 *
 * Values without a byte form yet (names, strings, dynamic arrays) sit in the
 * frame's reference array, as for objects; object and class pointers are
 * handles in the block (R1a-2). A function whose class the native loader has
 * not linked has no offsets; its frame keeps every value in a Map, the
 * storage before R2a.
 */
import {functionImageCells, readCell, writeCell, readFixedElement, isFixedCell} from './script-object-image.mjs';
import {NO_ELEMENT, zeroValue} from './script-values.mjs';

const CHUNK = 1 << 18;

/** FMemStack for frame blocks: LIFO ranges inside arena chunks. A caller
 * saves `index` and `top` before pushing and restores both when its call
 * ends, normally or by an exception. Chunks are kept for reuse.
 *
 * With the Rust interpreter attached (script-vm-rust.mjs), the three state
 * words live in its FRAMES statics, so script calls in Rust push on the same
 * stack; it calls back into `advance` for a new chunk. */
export class FrameStack {
  constructor(arena) {
    this.arena = arena;
    this.chunks = [];
    this.at = 0;
    this.state = [-1, 0, 0];
  }
  /** Keep index, top and end at `address` in the arena (Rust's FRAMES). */
  attach(address) {
    const [index, top, end] = [this.index, this.top, this.end];
    this.at = address;
    this.index = index; this.top = top; this.end = end;
  }
  get index() { return this.at ? this.arena.view.getInt32(this.at, true) : this.state[0]; }
  set index(value) { if (this.at) this.arena.view.setInt32(this.at, value, true); else this.state[0] = value; }
  get top() { return this.at ? this.arena.view.getUint32(this.at + 4, true) : this.state[1]; }
  set top(value) { if (this.at) this.arena.view.setUint32(this.at + 4, value, true); else this.state[1] = value; }
  get end() { return this.at ? this.arena.view.getUint32(this.at + 8, true) : this.state[2]; }
  set end(value) { if (this.at) this.arena.view.setUint32(this.at + 8, value, true); else this.state[2] = value; }
  /** A zeroed block of `size` bytes; returns its base. */
  push(size) {
    const aligned = (size + 7) & ~7;
    if (this.top + aligned > this.end) this.advance(aligned);
    const base = this.top;
    this.top = base + aligned;
    this.arena.bytes.fill(0, base, base + aligned);
    return base;
  }
  advance(size) {
    let index = this.index + 1;
    while (index < this.chunks.length && this.chunks[index].size < size) index++;
    if (index === this.chunks.length) {
      const chunk = Math.max(CHUNK, size);
      this.chunks.push({base: this.arena.alloc(chunk), size: chunk});
    }
    const chunk = this.chunks[index];
    this.index = index;
    this.top = chunk.base;
    this.end = chunk.base + chunk.size;
  }
  restore(index, top) {
    this.index = index;
    this.top = top;
    this.end = index < 0 ? 0 : this.chunks[index].base + this.chunks[index].size;
  }
}

// Per prepared function: its frame cells, or null when it is not linked.
const layouts = new WeakMap();
const EMPTY = Object.freeze({size: 0, refCount: 0, cells: new Map(), fields: [], fieldCells: [],
  parameterCells: [], zeroRefs: [], slotFields: null});

/** The frame layout of a prepared function, or null for one with no linked
 * offsets (then its locals are a Map). */
export function frameLayout(fn, loader) {
  const cached = layouts.get(fn);
  if (cached && cached.source === fn.fields) return cached.layout;
  const record = fn.record && loader ? loader.nativeIdentity(fn.record) : null;
  const image = record && functionImageCells(fn.fields, record, {graph: loader.graph,
    identity: value => loader.identity(value), nativeRecord: value => loader.nativeIdentity(value)});
  // An unlinked function may be linked later (its class loaded); only a
  // linked result is final.
  if (!image) return null;
  const fieldCells = fn.fields.map(field => image.cells.get(field.key) ?? null);
  const slotFields = fn.fields.filter((field, index) => !fieldCells[index]);
  // The reference array of a zeroed frame: each imaged value's zero, written
  // once through its cell into a scratch array.
  const zeroRefs = new Array(image.refCount).fill(undefined);
  const scratch = new DataView(new ArrayBuffer(Math.max(8, image.size)));
  fn.fields.forEach((field, index) => {
    if (fieldCells[index]?.refCount) writeCell(fieldCells[index], scratch, zeroRefs, zeroValue(field));
  });
  for (let offset = 0; offset < scratch.byteLength; offset++)
    if (scratch.getUint8(offset)) throw new Error(`Zero local value has nonzero bytes: ${fn.record.key}`);
  const layout = Object.freeze({
    size: image.size, refCount: image.refCount, cells: image.cells, fields: fn.fields, fieldCells,
    parameterCells: fn.parameters.map(field => image.cells.get(field.key) ?? null),
    zeroRefs, slotFields: slotFields.length ? slotFields : null,
  });
  layouts.set(fn, {source: fn.fields, layout});
  return layout;
}

/** One function frame's parameters and locals. `has`/`get`/`set` keep the
 * Map interface of the storage before R2a: `get` returns the stored value
 * and `set` takes a value already copied through the property's codec. */
export class FrameLocals {
  constructor(layout, arena, base, slots) {
    this.layout = layout;
    this.arena = arena;
    this.base = base;
    this.refs = layout.refCount ? layout.zeroRefs.slice() : layout.zeroRefs;
    this.slots = slots;
  }
  cell(key) {
    return this.layout.cells.get(key);
  }
  has(key) {
    return this.layout.cells.has(key) || (this.slots !== null && this.slots.has(key));
  }
  get(key) {
    const cell = this.layout.cells.get(key);
    if (cell) return readCell(cell, this.arena.view, this.refs, this.base);
    return this.slots?.get(key);
  }
  set(key, value) {
    const cell = this.layout.cells.get(key);
    if (cell) writeCell(cell, this.arena.view, this.refs, value, this.base);
    else (this.slots ??= new Map()).set(key, value);
    return this;
  }
  readCell(cell) {
    return readCell(cell, this.arena.view, this.refs, this.base);
  }
  writeCell(cell, value) {
    writeCell(cell, this.arena.view, this.refs, value, this.base);
  }
}

/** A frame with no parameters or locals (state code). */
export const emptyFrameLocals = arena => new FrameLocals(EMPTY, arena, 0, null);

/** A frame local's cell as a reference's storage (storageReference). */
export class LocalCellStorage {
  constructor(locals, cell) {
    this.descriptor = null;
    this.locals = locals;
    this.cell = cell;
  }
  get() {
    const locals = this.locals;
    return readCell(this.cell, locals.arena.view, locals.refs, locals.base);
  }
  readElement(index) {
    if (!isFixedCell(this.cell)) return NO_ELEMENT;
    const locals = this.locals;
    return readFixedElement(this.cell, locals.arena.view, locals.refs, index, locals.base);
  }
  set(value) {
    const locals = this.locals;
    writeCell(this.cell, locals.arena.view, locals.refs, value, locals.base);
  }
}

/** A frame for `fn` on `stack`: its block when linked, otherwise a Map with
 * each field's zero value. The caller restores the stack when the call ends. */
export function createFrameLocals(fn, loader, stack) {
  const layout = stack ? frameLayout(fn, loader) : null;
  if (!layout) {
    const locals = new Map(), fields = fn.fields;
    for (let i = 0; i < fields.length; i++) locals.set(fields[i].key, zeroValue(fields[i]));
    return locals;
  }
  const base = layout.size ? stack.push(layout.size) : 0;
  let slots = null;
  if (layout.slotFields) {
    slots = new Map();
    for (const field of layout.slotFields) slots.set(field.key, zeroValue(field));
  }
  return new FrameLocals(layout, stack.arena, base, slots);
}
