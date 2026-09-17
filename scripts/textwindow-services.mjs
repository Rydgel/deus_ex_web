/**
 * JS-side services for the XTextWindow / XTextLogWindow / XLargeTextWindow
 * oracle replay.
 *
 * TextWindowHeap extends the ListWindow bump heap with the process-global
 * cells the text model touches: the shared empty wstring, the L"\n" log
 * separator (0x10098e58), the Core GPropAddr global the exec marshal writes
 * through, the two heap scratch FString slots standing in for native stack
 * locals (the GNatives marshal local and FString::Mid's result temp), and the
 * exec convertPipes static (0x100aead0 + flag 0x100aeac8 + run scratch).
 *
 * buildWindow constructs the same object image the Unicorn probe builds
 * (including the fake vtable holding the +0x11c/+0x120 slots the SetText /
 * AppendText execs dispatch through), and dumpState produces the identical
 * canonical dump shape so {events, state} compare element-for-element.
 */
import {ListWindowHeap} from './listwindow-services.mjs';

const f32 = new DataView(new ArrayBuffer(4));
export const f32Bits = value => {
  f32.setFloat32(0, value, true);
  return f32.getUint32(0, true);
};

export class TextWindowHeap extends ListWindowHeap {
  constructor() {
    super();
    this.logSeparator = this.allocRaw(4);   // L"\n" separator (0x10098e58)
    this.view.setUint16(this.logSeparator, 0x0a, true);
    this.gpropCell = this.allocRaw(4);      // Core GPropAddr global (0x101e32f8)
    this.marshalLocal = this.allocRaw(12);  // exec string-marshal local FString
    this.scratchTemp = this.allocRaw(12);   // GetTextPart Mid() temp FString
    this.scratchLocal = this.allocRaw(12);  // GetTextPart marshal-local FString
    this.convertBuffer = this.allocRaw(12); // convertPipes static (0x100aead0)
    this.convertFlag = this.allocRaw(4);    // convertPipes flag byte (0x100aeac8)
    this.convertRun = this.allocRaw(0x1000); // convertPipes run scratch (0x100add98)
  }
}

const W = {
  windowType: 0x28, accelKey: 0xb4,
  parent: 0x138, hAlign: 0x14c, vAlign: 0x14d, textFlags: 0x150,
  hMargin: 0x154, vMargin: 0x158,
  minLines: 0x15c, maxLines: 0x160, minWidth: 0x164,
  text: 0x168, textNum: 0x16c, textMax: 0x170,
  lineSpacing: 0x174,
  logData: 0x178, logNum: 0x17c, logMax: 0x180, logFlags: 0x184,
  accelFlags: 0x584,
};
const LOG_SIZE = 0x14;
const WINDOW_SIZE = 0x600;

function buildFString(heap, text, maxn) {
  if (text == null) return [0, 0, 0];
  const data = heap.allocString(text);
  const num = text.length + 1;
  return [data, num, maxn ?? num];
}

export function buildWindow(heap, spec = {}) {
  const base = heap.allocRaw(WINDOW_SIZE);
  heap.bytes.fill(0, base, base + WINDOW_SIZE);
  const vtable = heap.allocRaw(0x128);
  heap.write(base, 'u32', vtable);
  // The two slots the SetText/AppendText execs dispatch through (identity in
  // the JS model — the entries call the model methods directly).
  heap.write(vtable + 0x11c, 'u32', 0x45d50);
  heap.write(vtable + 0x120, 'u32', 0x45e60);

  const [tdata, tnum, tmax] = buildFString(heap, spec.text, spec.textMax);
  heap.write(base + W.text, 'u32', tdata);
  heap.write(base + W.textNum, 'i32', tnum);
  heap.write(base + W.textMax, 'i32', tmax);

  heap.write(base + W.windowType, 'u8', spec.windowType ?? 0);
  heap.write(base + W.accelKey, 'u32', spec.accelKey ?? 0);
  heap.write(base + W.hAlign, 'u8', spec.hAlign ?? 0);
  heap.write(base + W.vAlign, 'u8', spec.vAlign ?? 0);
  heap.write(base + W.textFlags, 'u32', spec.textFlags ?? 0);
  heap.write(base + W.hMargin, 'u32', spec.hMarginBits ?? f32Bits(spec.hMargin ?? 0));
  heap.write(base + W.vMargin, 'u32', spec.vMarginBits ?? f32Bits(spec.vMargin ?? 0));
  heap.write(base + W.minLines, 'i32', spec.minLines ?? -1);
  heap.write(base + W.maxLines, 'i32', spec.maxLines ?? -1);
  heap.write(base + W.minWidth, 'u32', spec.minWidthBits ?? f32Bits(spec.minWidth ?? 0));
  heap.write(base + W.lineSpacing, 'u32',
    spec.lineSpacingBits ?? f32Bits(spec.lineSpacing ?? 0));
  heap.write(base + W.logFlags, 'u32', spec.logFlags ?? 0);
  heap.write(base + W.accelFlags, 'u32', spec.accelFlags ?? 0);

  const log = spec.log ?? [];
  const lcap = spec.logMax ?? log.length;
  const ldata = lcap ? heap.allocRaw(LOG_SIZE * lcap) : 0;
  log.forEach((rec, i) => {
    const at = ldata + i * LOG_SIZE;
    heap.write(at, 'u32', rec.expireBits ?? f32Bits(rec.expire ?? 0));
    const [rdata, rnum, rmax] = buildFString(heap, rec.text, rec.textMax);
    heap.write(at + 4, 'u32', rdata);
    heap.write(at + 8, 'i32', rnum);
    heap.write(at + 0xc, 'i32', rmax);
    heap.write(at + 0x10, 'u32', rec.color ?? 0);
  });
  heap.write(base + W.logData, 'u32', ldata);
  heap.write(base + W.logNum, 'i32', log.length);
  heap.write(base + W.logMax, 'i32', lcap);

  let parent = spec.parent ?? 0;
  if (parent === true || (parent && typeof parent === 'object')) {
    parent = buildWindow(heap, parent === true ? {} : parent).base;
  }
  heap.write(base + W.parent, 'u32', parent);
  return {base, vtable};
}

/** Reset the process-global scratch cells to the per-case spec state. */
export function resetGlobals(heap, spec = {}) {
  const [cdata, cnum, cmax] = buildFString(heap, spec.convert, spec.convertMax);
  heap.write(heap.convertBuffer, 'u32', cdata);
  heap.write(heap.convertBuffer + 4, 'i32', cnum);
  heap.write(heap.convertBuffer + 8, 'i32', cmax);
  heap.write(heap.convertFlag, 'u8', spec.convertFlag ?? 0);
  heap.write(heap.gpropCell, 'u32', 0);
}

/** Leaf services matching the probe's intercepted call sites. */
export function textLeafServices(heap, base, spec = {}) {
  const now = spec.now ?? 0;
  return {
    askParentForReconfigure(_object, windowBase) {
      heap.events.push({op: 'AskParentForReconfigure', object: heap.canon(windowBase)});
    },
    // 0x1004fda0 — the patched `fld qword; ret` clock stub returns the
    // configured f64 `now`; no event (the real leaf is silent).
    getTime() {
      return now;
    },
  };
}

export function dumpFString(heap, address) {
  const data = heap.read(address, 'u32');
  return {
    text: data ? heap.readString(data) : null,
    data: heap.canon(data),
    num: heap.read(address + 4, 'i32'),
    max: heap.read(address + 8, 'i32'),
  };
}

function dumpLogRecord(heap, address) {
  return {
    expire: heap.read(address, 'u32'),
    text: dumpFString(heap, address + 4),
    color: heap.read(address + 0x10, 'u32'),
  };
}

/** 0x1004c580 walk: first ancestor-or-self with windowType byte >= 2. */
function accelRoot(heap, base) {
  let addr = base;
  while (addr !== 0 && heap.read(addr + W.windowType, 'u8') < 2) {
    addr = heap.read(addr + W.parent, 'u32');
  }
  return addr;
}

export function dumpState(heap, base) {
  const ldata = heap.read(base + W.logData, 'u32');
  const lnum = heap.read(base + W.logNum, 'i32');
  const lmax = heap.read(base + W.logMax, 'i32');
  const log = ldata
    ? Array.from({length: lnum}, (_, i) => dumpLogRecord(heap, ldata + i * LOG_SIZE))
    : [];
  const root = accelRoot(heap, base);
  return {
    windowType: heap.read(base + W.windowType, 'u8'),
    accelKey: heap.read(base + W.accelKey, 'u32'),
    hAlign: heap.read(base + W.hAlign, 'u8'),
    vAlign: heap.read(base + W.vAlign, 'u8'),
    textFlags: heap.read(base + W.textFlags, 'u32'),
    hMargin: heap.read(base + W.hMargin, 'u32'),
    vMargin: heap.read(base + W.vMargin, 'u32'),
    minLines: heap.read(base + W.minLines, 'i32'),
    maxLines: heap.read(base + W.maxLines, 'i32'),
    minWidth: heap.read(base + W.minWidth, 'u32'),
    lineSpacing: heap.read(base + W.lineSpacing, 'u32'),
    logData: heap.canon(ldata), logNum: lnum, logMax: lmax,
    log,
    logFlags: heap.read(base + W.logFlags, 'u32'),
    text: dumpFString(heap, base + W.text),
    parent: heap.canon(heap.read(base + W.parent, 'u32')),
    accelRoot: heap.canon(root),
    accelRootFlags: root ? heap.read(root + W.accelFlags, 'u32') : 0,
    convert: dumpFString(heap, heap.convertBuffer),
    convertFlag: heap.read(heap.convertFlag, 'u8'),
    gprop: heap.canon(heap.read(heap.gpropCell, 'u32')),
  };
}
