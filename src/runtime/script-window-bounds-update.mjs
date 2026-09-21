/**
 * Recovered Extension.dll XWindow bounds/list leaves reached by ConfigureChild.
 *
 * XWindow::ConfigureChild (script-window-configure-child.mjs) runs two leaves
 * once the reconfigure has stored the new geometry and the configure depth is
 * 1 (or the +0x28 window type is >= 1):
 *
 *   BoundsUpdate      0x10051160  — the recursive x87 absolute-bounds/clip
 *                                   computation, plus the GC bounds copy
 *                                   0x10026f00 and the child recursion.
 *   SortWindowLists   0x10045140  — re-sort the type>=1 ancestor's two window
 *                                   lists by screen position and re-index them,
 *                                   then the invalid-region check 0x10045000.
 *
 * BoundsUpdate (0x10051160) reads the window's own x/y/w/h (+0x78..+0x84) and
 * its parent's absolute-bounds struct (+0xd4..+0xe8), producing this window's
 * own absolute-bounds struct at +0xd4..+0xe8:
 *   +0xd4 absX  = parent.absX + x            (parent branch; 0 for a null parent)
 *   +0xd8 absY  = parent.absY + y            (0 for a null parent)
 *   +0xdc clipL = clamp(absX, parentClipL) - absX      (0 for a null parent)
 *   +0xe0 clipT = clamp(absY, parentClipT) - absY      (0 for a null parent)
 *   +0xe4 clipW = min(absX+w, parentClipR) - clamp(absX, parentClipL)   (w if null)
 *   +0xe8 clipH = min(absY+h, parentClipB) - clamp(absY, parentClipT)   (h if null)
 * where parentClipL = parent.absX + parent.clipL etc. Every add/sub rounds to
 * float32 and every compare uses the x87 C0/C3 flags (unordered counts with
 * `<` for the max and with `<=` for the min). When +0x130 (the window GC) is
 * non-null the six floats are copied to GC+0x2c..+0x40 (0x10026f00). Then the
 * body recurses over firstChild (+0x13c) / nextSibling (+0x148).
 *
 * SortWindowLists (0x10045140) qsorts listA (+0x14c, count +0x150) by
 * (absY,absX,pointer) and listB (+0x158, count +0x15c) by (absX,absY,pointer),
 * writes each entry's list index back (+0x11c / +0x120), then runs the
 * invalid-region check 0x10045000: with both accumulated invalid extents
 * (+0x16c width, +0x170 height) still zero it returns 0 and the top-level
 * repaint tail (0x1004c580 -> 0x10036ed0) does not run. Our window shell does
 * not maintain the manager draw/input lists, so both counts are zero here and
 * the sort/re-index/tail are inert; a non-empty invalid region or list is an
 * explicit boundary (the Stage-4 window-manager repaint path).
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c, bodies
 * 0x10051160-0x1005133c (BoundsUpdate), 0x10026f00-0x10026f12 (GC copy),
 * 0x10045140-0x10045215 (SortWindowLists) with comparators 0x10045250 /
 * 0x100452d0 and the invalid-region check 0x10045000-0x10045139.
 * See docs/script-window-bounds-update.md and
 * scripts/native-window-bounds-update-oracle.py.
 */

const freeze = Object.freeze;
const f = Math.fround;

export const WINDOW_BOUNDS_UPDATE_NATIVE = freeze({
  package: 'Extension',
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  boundsUpdate: 0x10051160,
  boundsUpdateEnd: 0x1005133d,
  gcSetBounds: 0x10026f00,
  gcSetBoundsEnd: 0x10026f13,
  sortWindowLists: 0x10045140,
  sortWindowListsEnd: 0x10045216,
  comparatorDrawOrder: 0x10045250,
  comparatorInputOrder: 0x100452d0,
  invalidRegionCheck: 0x10045000,
  invalidRegionCheckEnd: 0x1004513a,
});

/** Byte offsets in the native XWindow object (a superset of the ConfigureChild
 * offsets, adding the absolute-bounds struct and the GC/list fields). */
export const WINDOW_BOUNDS_OFFSETS = freeze({
  type: 0x28,
  drawListIndex: 0x11c,
  inputListIndex: 0x120,
  gc: 0x130,
  parent: 0x138,
  firstChild: 0x13c,
  nextSibling: 0x148,
  drawList: 0x14c,
  drawListCount: 0x150,
  inputList: 0x158,
  inputListCount: 0x15c,
  invalidWidth: 0x16c,
  invalidHeight: 0x170,
  x: 0x78,
  y: 0x7c,
  width: 0x80,
  height: 0x84,
  // Absolute-bounds struct: absX, absY, clipLeft, clipTop, clipWidth, clipHeight.
  absX: 0xd4,
  absY: 0xd8,
  clipLeft: 0xdc,
  clipTop: 0xe0,
  clipWidth: 0xe4,
  clipHeight: 0xe8,
});
/** The GC's copy target for the six absolute-bounds floats (GC+0x2c..+0x40). */
export const WINDOW_GC_BOUNDS_OFFSET = 0x2c;

export class WindowBoundsUpdateBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', object = null, value = undefined} = {}) {
    super(message);
    this.name = 'WindowBoundsUpdateBoundaryError';
    this.code = `WINDOW_BOUNDS_UPDATE_${kind}`;
    this.object = object;
    this.value = value;
  }
}

const fail = (message, details = {}) => { throw new WindowBoundsUpdateBoundaryError(message, details); };

function present(value) { return value !== null && value !== undefined && value !== 0; }

function requireReadWrite(services) {
  if (typeof services?.read !== 'function' || typeof services?.write !== 'function')
    fail('XWindow bounds leaves require read/write services', {kind: 'SERVICE'});
}

function readF32(read, object, offset) {
  const value = read(object, offset, 'f32');
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number') fail('XWindow bounds require a numeric float field', {object, value});
  return f(value);
}

function readPtr(read, object, offset) {
  const value = read(object, offset, 'ptr');
  return value === undefined ? null : value;
}

function readI32(read, object, offset) {
  const value = read(object, offset, 'u32');
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value)) fail('XWindow bounds require an integer list field', {object, value});
  return value | 0;
}

// fcom flag helpers: C0 (carry) is set for `st0 < src` and for unordered.
const flagLess = (a, b) => Number.isNaN(a) || Number.isNaN(b) || a < b;
// C3|C0 is set for `st0 <= src` and for unordered.
const flagLessOrEqual = (a, b) => Number.isNaN(a) || Number.isNaN(b) || a <= b;

/**
 * Execute XWindow::BoundsUpdate (0x10051160) over the window subtree.
 * `services.read(object, offset, kind)` / `services.write(object, offset, kind,
 * value)` expose the raw window storage. Recurses over the children exactly as
 * the native body does.
 */
export function boundsUpdateNative(object, services = {}) {
  requireReadWrite(services);
  const {read, write} = services;
  const O = WINDOW_BOUNDS_OFFSETS;
  const w = readF32(read, object, O.width);
  const h = readF32(read, object, O.height);
  const parent = readPtr(read, object, O.parent);

  if (present(parent)) {
    const x = readF32(read, object, O.x);
    const y = readF32(read, object, O.y);
    const pAbsX = readF32(read, parent, O.absX);
    const pAbsY = readF32(read, parent, O.absY);
    const pClipL = readF32(read, parent, O.clipLeft);
    const pClipT = readF32(read, parent, O.clipTop);
    const pClipW = readF32(read, parent, O.clipWidth);
    const pClipH = readF32(read, parent, O.clipHeight);
    // Absolute position of this window (fld x; fadd parent.absX / fld parent.absY; fadd y).
    const absX = f(x + pAbsX);
    const absY = f(pAbsY + y);
    // This window's own edges and the parent's absolute clip rectangle.
    const right0 = f(absX + w);
    const bottom0 = f(absY + h);
    const parentClipL = f(pClipL + pAbsX);
    const parentClipT = f(pClipT + pAbsY);
    const parentClipR = f(parentClipL + pClipW);
    const parentClipB = f(parentClipT + pClipH);
    // Clamp against the parent: left/top are max, right/bottom are min.
    const left = flagLess(absX, parentClipL) ? parentClipL : absX;
    const top = flagLess(absY, parentClipT) ? parentClipT : absY;
    const right = flagLessOrEqual(right0, parentClipR) ? right0 : parentClipR;
    const bottom = flagLessOrEqual(bottom0, parentClipB) ? bottom0 : parentClipB;
    write(object, O.absX, 'f32', absX);
    write(object, O.absY, 'f32', absY);
    write(object, O.clipLeft, 'f32', f(left - absX));
    write(object, O.clipTop, 'f32', f(top - absY));
    write(object, O.clipWidth, 'f32', f(right - left));
    write(object, O.clipHeight, 'f32', f(bottom - top));
  } else {
    write(object, O.absX, 'f32', 0);
    write(object, O.absY, 'f32', 0);
    write(object, O.clipLeft, 'f32', 0);
    write(object, O.clipTop, 'f32', 0);
    write(object, O.clipWidth, 'f32', w);
    write(object, O.clipHeight, 'f32', h);
  }

  // GC bounds copy (0x10026f00): six floats -> GC+0x2c..+0x40.
  const gc = readPtr(read, object, O.gc);
  if (present(gc)) {
    for (let i = 0; i < 6; i += 1) {
      write(gc, WINDOW_GC_BOUNDS_OFFSET + i * 4, 'f32', readF32(read, object, O.absX + i * 4));
    }
  }

  // Recurse over the children (firstChild -> nextSibling), with a cycle guard.
  const seen = new Set();
  for (let child = readPtr(read, object, O.firstChild); present(child);
       child = readPtr(read, child, O.nextSibling)) {
    if (seen.has(child)) fail('XWindow BoundsUpdate received a cyclic child chain', {object: child});
    seen.add(child);
    boundsUpdateNative(child, services);
  }
}

/** The draw-order comparator 0x10045250: (absY, absX, pointer address). */
export function compareDrawOrder(read, a, b, addressOf) {
  return compareByKeys(read, a, b, addressOf, WINDOW_BOUNDS_OFFSETS.absY, WINDOW_BOUNDS_OFFSETS.absX);
}

/** The input-order comparator 0x100452d0: (absX, absY, pointer address). */
export function compareInputOrder(read, a, b, addressOf) {
  return compareByKeys(read, a, b, addressOf, WINDOW_BOUNDS_OFFSETS.absX, WINDOW_BOUNDS_OFFSETS.absY);
}

function compareByKeys(read, a, b, addressOf, primary, secondary) {
  const pa = readF32(read, a, primary), pb = readF32(read, b, primary);
  if (flagLess(pa, pb)) return -1;                 // C0 -> a < b (or unordered)
  if (!flagLessOrEqual(pa, pb)) return 1;           // not (C3|C0) -> a > b
  const sa = readF32(read, a, secondary), sb = readF32(read, b, secondary);
  if (flagLess(sa, sb)) return -1;
  if (!flagLessOrEqual(sa, sb)) return 1;
  // Pointer tie-break: cmp edx(b),ecx(a); jbe -> -1 else sbb/neg -> +1.
  const aAddr = addressOf ? addressOf(a) : 0, bAddr = addressOf ? addressOf(b) : 0;
  return bAddr <= aAddr ? -1 : 1;
}

/**
 * Execute XWindow::SortWindowLists (0x10045140) for the reached configuration.
 * Sorts and re-indexes the ancestor's draw/input lists when they carry more
 * than one entry, then runs the invalid-region check. The window shell keeps
 * no manager lists, so both counts are zero here; a populated list or a
 * non-empty invalid region is an explicit Stage-4 window-manager boundary.
 */
export function sortWindowListsNative(object, _child, services = {}) {
  requireReadWrite(services);
  const {read, write} = services;
  const O = WINDOW_BOUNDS_OFFSETS;
  sortList(read, write, object, O.drawList, O.drawListCount, O.drawListIndex, 'draw',
    (a, b) => compareDrawOrder(read, a, b, services.addressOf));
  sortList(read, write, object, O.inputList, O.inputListCount, O.inputListIndex, 'input',
    (a, b) => compareInputOrder(read, a, b, services.addressOf));
  // Invalid-region check (0x10045000): with both accumulated extents zero the
  // native returns 0 and the top-level repaint tail does not run.
  const invalidWidth = readF32(read, object, O.invalidWidth);
  const invalidHeight = readF32(read, object, O.invalidHeight);
  const drawCount = readI32(read, object, O.drawListCount);
  if (drawCount !== 0 || invalidWidth !== 0 || invalidHeight !== 0) {
    fail('XWindow SortWindowLists reached the window-manager repaint tail (Stage 4)', {
      object, value: {drawCount, invalidWidth, invalidHeight},
    });
  }
}

function sortList(read, write, object, listOffset, countOffset, indexOffset, label, comparator) {
  const count = readI32(read, object, countOffset);
  if (count < 0) fail(`XWindow SortWindowLists read a negative ${label} list count`, {object, value: count});
  if (count === 0) return;
  const list = readPtr(read, object, listOffset);
  if (!present(list)) fail(`XWindow SortWindowLists ${label} list pointer is null`, {object});
  fail(`XWindow SortWindowLists reached a populated ${label} list (Stage 4)`, {object, value: count});
  // Faithful continuation for a populated list (unreached here): the qsort with
  // `comparator` followed by writing each entry's index to `indexOffset`.
  void comparator; void write; void indexOffset;
}
