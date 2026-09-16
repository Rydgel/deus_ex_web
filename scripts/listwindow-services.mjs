/**
 * Shared validator-side services for the XListWindow row/column model.
 *
 * `ListWindowHeap` is a byte-addressable bump heap that mirrors the probe
 * FMalloc: alloc/realloc/free calls become canonical events with
 * allocation-order block ids so deep-equality against the Unicorn run checks
 * not just values but the exact allocator traffic the native issued.
 * `buildWindow` constructs the same object image the probe's `window()` does,
 * and `dumpState` reproduces the probe's canonical dump including
 * encounter-order pointer labels.
 */

const f = Math.fround;

export class ListWindowHeap {
  constructor() {
    this.bytes = new Uint8Array(0x400000);
    this.view = new DataView(this.bytes.buffer);
    this.next = 0x1000;
    this.sizes = new Map();       // addr -> size (all allocations)
    this.blockIds = new Map();    // addr -> 'h<N>' for GMalloc-path blocks
    this.freed = new Set();
    this.seen = new Map();        // addr -> 'a<N>' encounter labels
    this.events = [];
    // Extension image scratch state: the sort-column list 0x100a6f28/0x100a7348.
    this.sortList = this.allocRaw(0x400);
    this.sortCount = this.allocRaw(4);
  }

  allocRaw(size) {
    const address = this.next;
    this.next += (Math.max(size, 4) + 15) & ~15;
    this.sizes.set(address, Math.max(size, 4));
    return address;
  }

  alloc(size, tag = 'new') {
    const address = this.allocRaw(size);
    const id = `h${this.blockIds.size}`;
    this.blockIds.set(address, id);
    this.events.push({op: 'Malloc', size, tag, block: id});
    return address;
  }

  realloc(address, size, tag = 'FArray') {
    if (!address) {
      const fresh = this.allocRaw(size);
      const id = `h${this.blockIds.size}`;
      this.blockIds.set(fresh, id);
      this.events.push({op: 'Realloc', old: 0, size, tag, block: id});
      return fresh;
    }
    const oldSize = this.sizes.get(address) ?? 0;
    const fresh = this.allocRaw(size);
    const id = `h${this.blockIds.size}`;
    this.blockIds.set(fresh, id);
    const keep = Math.min(oldSize, size);
    this.bytes.copyWithin(fresh, address, address + keep);
    this.bytes.fill(0, fresh + keep, fresh + size);
    this.sizes.delete(address);
    this.freed.add(address);
    this.events.push({op: 'Realloc', old: this.canon(address), size, tag, block: id});
    return fresh;
  }

  free(address) {
    this.events.push({op: 'Free', block: this.canon(address)});
    this.sizes.delete(address);
    this.freed.add(address);
  }

  canon(address) {
    if (!address) return 0;
    for (const [base, id] of this.blockIds) {
      const size = this.sizes.get(base) ?? 0;
      if (base <= address && address < base + Math.max(size, 4)) {
        let label = id + (this.freed.has(base) ? '!' : '');
        if (address !== base) label += `+${(address - base).toString(16)}`;
        return label;
      }
    }
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
      case 'f32': this.view.setFloat32(address, f(value), true); break;
      default: throw new Error(`unsupported heap kind ${kind}`);
    }
  }

  readString(address) {
    let text = '';
    for (let i = 0; ; i++) {
      const ch = this.view.getUint16(address + 2 * i, true);
      if (!ch) return text;
      text += String.fromCharCode(ch);
    }
  }

  allocString(text) {
    const address = this.allocRaw(2 * (text.length + 1));
    for (let i = 0; i < text.length; i++)
      this.view.setUint16(address + 2 * i, text.charCodeAt(i), true);
    this.view.setUint16(address + 2 * text.length, 0, true);
    return address;
  }

  writeString(address, text) {
    for (let i = 0; i < text.length; i++)
      this.view.setUint16(address + 2 * i, text.charCodeAt(i), true);
    this.view.setUint16(address + 2 * text.length, 0, true);
  }
}

const W = {
  colPacked: 0x3d, defFont: 0x54, style: 0x130, context: 0x134, parent: 0x138,
  delimiter: 0x14c, rowsData: 0x170, rowsCount: 0x174, rowsMax: 0x178,
  colsData: 0x17c, numCols: 0x180, flags: 0x188, padX: 0x18c, padY: 0x190,
  rowHeight: 0x19c, numSelected: 0x1a8, selected: 0x1ac, selected2: 0x1b0,
};
const C = {
  size: 0x38, index: 0, header: 4, sortPriority: 0x10, sortFlags: 0x14,
  width: 0x18, flagByte: 0x1c, packed: 0x1d, font: 0x24, type: 0x28, format: 0x2c,
};

function buildFString(heap, text) {
  if (text == null) return [0, 0, 0];
  const data = heap.allocString(text);
  return [data, text.length + 1, text.length + 1];
}

function buildField(heap, spec = {}) {
  const address = heap.allocRaw(24);
  const [data, num, max] = buildFString(heap, spec.text ?? null);
  heap.write(address, 'u32', data);
  heap.write(address + 4, 'u32', num);
  heap.write(address + 8, 'u32', max);
  heap.write(address + 0xc, 'u32', 0);
  heap.write(address + 0xc, 'f32', spec.value ?? 0);
  heap.write(address + 0x10, 'f32', spec.width ?? 0);
  heap.write(address + 0x14, 'f32', spec.height ?? 0);
  return address;
}

function buildRow(heap, spec = {}) {
  const address = heap.allocRaw(24);
  const fields = spec.fields ?? [];
  const data = fields.length ? heap.allocRaw(24 * fields.length) : 0;
  fields.forEach((fSpec, i) => {
    const src = buildField(heap, fSpec);
    heap.bytes.copyWithin(data + 24 * i, src, src + 24);
  });
  heap.write(address, 'i32', spec.row_id ?? spec.id ?? 0);
  heap.write(address + 4, 'u32', spec.flags ?? 0);
  heap.write(address + 8, 'u32', data);
  heap.write(address + 0xc, 'u32', fields.length);
  heap.write(address + 0x10, 'u32', fields.length);
  heap.write(address + 0x14, 'i32', spec.client ?? spec.clientData ?? 0);
  return address;
}

function buildColumn(heap, index, spec = {}, defaults = {}) {
  const address = heap.allocRaw(C.size);
  const [hdata, hnum, hmax] = buildFString(heap, spec.header ?? '');
  const [fdata, fnum, fmax] = buildFString(heap, spec.fmt ?? '');
  heap.write(address + C.index, 'i32', index);
  heap.write(address + C.header, 'u32', hdata);
  heap.write(address + C.header + 4, 'u32', hnum);
  heap.write(address + C.header + 8, 'u32', hmax);
  heap.write(address + C.sortPriority, 'i32', spec.sort_priority ?? 0);
  heap.write(address + C.sortFlags, 'u32', spec.sort_flags ?? 0);
  heap.write(address + C.width, 'f32', spec.width ?? 0);
  heap.write(address + C.flagByte, 'u8', spec.flag_byte ?? 0);
  heap.write(address + C.packed, 'u32', spec.packed ?? defaults.colPacked ?? 0);
  heap.write(address + C.font, 'u32', spec.font ?? defaults.defFont ?? 0);
  heap.write(address + C.type, 'u8', spec.col_type ?? spec.type ?? 0);
  heap.write(address + C.format, 'u32', fdata);
  heap.write(address + C.format + 4, 'u32', fnum);
  heap.write(address + C.format + 8, 'u32', fmax);
  return address;
}

export function buildWindow(heap, spec = {}) {
  const base = heap.allocRaw(0x700);
  const vtable = heap.allocRaw(0x200);
  heap.write(base, 'u32', vtable);
  const [ddata, dnum, dmax] = buildFString(heap, spec.delimiter ?? null);
  heap.write(base + W.delimiter, 'u32', ddata);
  heap.write(base + W.delimiter + 4, 'u32', dnum);
  heap.write(base + W.delimiter + 8, 'u32', dmax);
  const rows = (spec.rows ?? []).map(r => buildRow(heap, r));
  const rowMax = spec.rowMax ?? rows.length;
  const rdata = rowMax ? heap.allocRaw(4 * rowMax) : 0;
  rows.forEach((node, i) => heap.write(rdata + 4 * i, 'u32', node));
  (spec.rowSlack ?? []).forEach((value, i) => {
    if (rows.length + i + 1 > rowMax)
      throw new Error('rowSlack needs rowMax >= rows.length + rowSlack.length');
    heap.write(rdata + 4 * (rows.length + i), 'u32', value >>> 0);
  });
  heap.write(base + W.rowsData, 'u32', rdata);
  heap.write(base + W.rowsCount, 'u32', rows.length);
  heap.write(base + W.rowsMax, 'u32', spec.rowMax ?? rows.length);
  const cols = (spec.cols ?? []).map((c, i) => buildColumn(heap, i, c, spec));
  const cdata = cols.length ? heap.allocRaw(C.size * cols.length) : 0;
  cols.forEach((col, i) => heap.bytes.copyWithin(cdata + C.size * i, col, col + C.size));
  const numCols = spec.numCols ?? cols.length;
  if (numCols !== cols.length)
    throw new Error('numCols must equal cols.length: 0x180 is the cols TArray count');
  heap.write(base + W.colsData, 'u32', cdata);
  heap.write(base + W.numCols, 'u32', numCols);
  heap.write(base + W.numCols + 4, 'u32', spec.colMax ?? cols.length);
  heap.write(base + W.flags, 'u32', spec.flags ?? 0);
  heap.write(base + W.padX, 'f32', spec.padX ?? 0);
  heap.write(base + W.padY, 'f32', spec.padY ?? 0);
  heap.write(base + W.rowHeight, 'f32', spec.rowHeight ?? 0);
  heap.write(base + W.numSelected, 'i32', spec.numSelected ?? 0);
  const selected = spec.selectedRow != null ? rows[spec.selectedRow] : (spec.selected ?? 0);
  heap.write(base + W.selected, 'u32', selected);
  heap.write(base + W.selected2, 'u32', spec.selected2 ?? 0);
  heap.write(base + W.parent, 'u32', spec.parent ?? 0);
  heap.write(base + W.colPacked, 'u32', spec.colPacked ?? 0);
  heap.write(base + W.defFont, 'u32', spec.defFont ?? 0);
  const style = heap.allocRaw(0x60);
  heap.write(base + W.style, 'u32', style);
  heap.write(base + W.context, 'u32', spec.context ?? 0);
  return {base, heap, spec};
}

export function dumpFString(heap, address) {
  const data = heap.read(address, 'u32');
  return {text: data ? heap.readString(data) : null, data: heap.canon(data),
          num: heap.read(address + 4, 'u32'), max: heap.read(address + 8, 'u32')};
}

export function dumpState(heap, base) {
  const rdata = heap.read(base + W.rowsData, 'u32');
  const rcount = heap.read(base + W.rowsCount, 'u32');
  const rmax = heap.read(base + W.rowsMax, 'u32');
  const cdata = heap.read(base + W.colsData, 'u32');
  const numCols = heap.read(base + W.numCols, 'i32');
  const rows = [];
  for (let i = 0; i < rcount; i++) {
    const node = heap.read(rdata + 4 * i, 'u32');
    if (!node) { rows.push(null); continue; }
    const fdata = heap.read(node + 8, 'u32');
    const fcount = heap.read(node + 0xc, 'u32');
    const fmax = heap.read(node + 0x10, 'u32');
    const fields = [];
    for (let j = 0; j < fcount; j++) {
      const a = fdata + 24 * j;
      fields.push({str: dumpFString(heap, a), value: heap.read(a + 0xc, 'u32'),
                   width: heap.read(a + 0x10, 'u32'), height: heap.read(a + 0x14, 'u32')});
    }
    rows.push({id: heap.read(node, 'i32'), flags: heap.read(node + 4, 'u32'),
               clientData: heap.read(node + 0x14, 'i32'), fields, fieldsMax: fmax,
               node: heap.canon(node)});
  }
  const cols = [];
  for (let i = 0; i < numCols; i++) {
    const a = cdata + C.size * i;
    cols.push({index: heap.read(a + C.index, 'i32'), header: dumpFString(heap, a + C.header),
               sortPriority: heap.read(a + C.sortPriority, 'i32'),
               sortFlags: heap.read(a + C.sortFlags, 'u32'),
               width: heap.read(a + C.width, 'u32'),
               flagByte: heap.read(a + C.flagByte, 'u8'),
               packed: heap.read(a + C.packed, 'u32'),
               font: heap.canon(heap.read(a + C.font, 'u32')),
               type: heap.read(a + C.type, 'u8'),
               format: dumpFString(heap, a + C.format)});
  }
  const sortN = heap.read(heap.sortCount, 'i32');
  const sortCols = [];
  for (let i = 0; i < Math.max(sortN, 0); i++) {
    const ptr = heap.read(heap.sortList + 4 * i, 'u32');
    const aligned = cdata && ptr && (ptr - cdata) % C.size === 0;
    sortCols.push({col: heap.canon(ptr), index: aligned ? Math.floor((ptr - cdata) / C.size) : null});
  }
  return {
    rowsData: heap.canon(rdata), rowsCount: rcount, rowsMax: rmax,
    colsData: heap.canon(cdata), colsCount: numCols,
    colsMax: heap.read(base + W.numCols + 4, 'u32'),
    numCols,
    flags: heap.read(base + W.flags, 'u32'),
    padX: heap.read(base + W.padX, 'u32'),
    padY: heap.read(base + W.padY, 'u32'),
    rowHeight: heap.read(base + W.rowHeight, 'u32'),
    numSelected: heap.read(base + W.numSelected, 'i32'),
    selected: heap.canon(heap.read(base + W.selected, 'u32')),
    selected2: heap.canon(heap.read(base + W.selected2, 'u32')),
    rows, cols,
    sortCount: sortN, sortCols,
  };
}
