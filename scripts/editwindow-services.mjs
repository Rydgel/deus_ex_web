/**
 * JS-side services for the XEditWindow oracle replay.
 *
 * EditWindowHeap extends the ListWindow heap with the process-global cells the
 * edit model touches: the shared empty wstring, the filterText char scratch,
 * the two temp FString slots that stand in for native stack temps
 * (InsertText's filtered-string temp and the Enable* text-copy temp), the
 * clipboard FString (image global 0x1009ae00) and the exec convertPipes
 * static (0x100aead0 + flag 0x100aeac8).
 *
 * buildWindow constructs the same object image the Unicorn probe builds, and
 * dumpState produces the identical canonical dump shape so {events, state}
 * compare element-for-element.
 */
import {ListWindowHeap} from './listwindow-services.mjs';

export class EditWindowHeap extends ListWindowHeap {
  constructor() {
    super();
    this.charSlot = this.allocRaw(8);       // filterText charbuf + FilterChar dword
    this.scratchInsert = this.allocRaw(12); // InsertText filtered-string temp
    this.scratchCopy = this.allocRaw(12);   // Enable* text-copy temp
    this.clipboard = this.allocRaw(12);     // clipboard FString (0x1009ae00)
    this.convertBuffer = this.allocRaw(12); // convertPipes static (0x100aead0)
    this.convertFlag = this.allocRaw(4);    // convertPipes flag byte (0x100aeac8)
    this.convertRun = this.allocRaw(0x1000); // convertPipes run scratch (0x100add98)
  }
}

const W = {
  height: 0xe8, parent: 0x138, textFlags: 0x150,
  text: 0x168, textNum: 0x16c, textMax: 0x170,
  lineSpacing: 0x174, lineHeight: 0x178,
  relayoutFlags: 0x17c, pendingPos: 0x180, pendingLen: 0x184,
  linesData: 0x194, linesCount: 0x198, linesMax: 0x19c,
  relayoutFlags2: 0x1a0, pendingPos2: 0x1a4, pendingLen2: 0x1a8,
  lines2Data: 0x1b8, lines2Count: 0x1bc, lines2Max: 0x1c0,
  flags: 0x1d0, ip: 0x1d4, anchor: 0x1d8, ipType: 0x1dc,
  selStart: 0x1e0, selEnd: 0x1e4, maxSize: 0x1e8,
  ipTexture: 0x1ec, ipColor: 0x1f0,
  selTexture: 0x1f4, selColor: 0x1f8, selTextColor: 0x1fc,
  cursor: 0x200, sounds: 0x20c,
  undoData: 0x21c, undoNum: 0x220, undoMax: 0x224,
  undoPos: 0x228, maxUndos: 0x22c, savedUndoPos: 0x230,
  blinkOn: 0x23c, blinkOff: 0x240,
  stateFlags: 0x244, stickyX: 0x270,
};
const LINE_SIZE = 0x24;
const UNDO_SIZE = 0x1c;
const WINDOW_SIZE = 0x400;

function buildFString(heap, text, maxn) {
  if (text == null) return [0, 0, 0];
  const data = heap.allocString(text);
  const num = text.length + 1;
  return [data, num, maxn ?? num];
}

function buildLineTable(heap, records, maxn) {
  const count = records.length;
  const cap = maxn ?? count;
  const data = cap ? heap.allocRaw(LINE_SIZE * cap) : 0;
  records.forEach((rec, i) => {
    const at = data + i * LINE_SIZE;
    heap.write(at, 'f32', rec.x ?? 0);
    heap.write(at + 4, 'i32', rec.start ?? 0);
    heap.write(at + 8, 'i32', rec.visible ?? 0);
    heap.write(at + 0xc, 'i32', rec.full ?? 0);
  });
  return [data, count, cap];
}

function buildUndoRecord(heap, rec, at) {
  heap.write(at, 'i32', rec.pos ?? 0);
  const [odata, onum, omax] = buildFString(heap, rec.old, rec.oldMax);
  const [ndata, nnum, nmax] = buildFString(heap, rec.new, rec.newMax);
  heap.write(at + 4, 'u32', odata);
  heap.write(at + 8, 'i32', onum);
  heap.write(at + 0xc, 'i32', omax);
  heap.write(at + 0x10, 'u32', ndata);
  heap.write(at + 0x14, 'i32', nnum);
  heap.write(at + 0x18, 'i32', nmax);
}

export function buildWindow(heap, spec = {}) {
  const base = heap.allocRaw(WINDOW_SIZE);
  heap.bytes.fill(0, base, base + WINDOW_SIZE);
  const vtable = heap.allocRaw(0x140);
  heap.write(base, 'u32', vtable);

  const [tdata, tnum, tmax] = buildFString(heap, spec.text, spec.textMax);
  heap.write(base + W.text, 'u32', tdata);
  heap.write(base + W.textNum, 'i32', tnum);
  heap.write(base + W.textMax, 'i32', tmax);

  const [ldata, lcount, lmax] = buildLineTable(heap, spec.lines ?? [], spec.linesMax);
  heap.write(base + W.linesData, 'u32', ldata);
  heap.write(base + W.linesCount, 'i32', lcount);
  heap.write(base + W.linesMax, 'i32', lmax);
  const [l2data, l2count, l2max] = buildLineTable(heap, spec.lines2 ?? [], spec.lines2Max);
  heap.write(base + W.lines2Data, 'u32', l2data);
  heap.write(base + W.lines2Count, 'i32', l2count);
  heap.write(base + W.lines2Max, 'i32', l2max);

  heap.write(base + W.flags, 'u32', spec.flags ?? 1);
  heap.write(base + W.ip, 'i32', spec.ip ?? 0);
  heap.write(base + W.anchor, 'i32', spec.anchor ?? 0);
  heap.write(base + W.ipType, 'u8', spec.ipType ?? 0);
  heap.write(base + W.selStart, 'i32', spec.selStart ?? 0);
  heap.write(base + W.selEnd, 'i32', spec.selEnd ?? 0);
  heap.write(base + W.maxSize, 'i32', spec.maxSize ?? 200000);
  heap.write(base + W.ipTexture, 'u32', spec.ipTexture ?? 0);
  heap.write(base + W.ipColor, 'u32', spec.ipColor ?? 0);
  heap.write(base + W.selTexture, 'u32', spec.selTexture ?? 0);
  heap.write(base + W.selColor, 'u32', spec.selColor ?? 0);
  heap.write(base + W.selTextColor, 'u32', spec.selTextColor ?? 0);
  (spec.cursor ?? [0, 0, 0]).forEach((v, i) => heap.write(base + W.cursor + 4 * i, 'u32', v));
  (spec.sounds ?? [0, 0, 0, 0]).forEach((v, i) => heap.write(base + W.sounds + 4 * i, 'u32', v));

  const undo = spec.undo ?? [];
  const ucap = spec.undoMax ?? undo.length;
  const udata = ucap ? heap.allocRaw(UNDO_SIZE * ucap) : 0;
  undo.forEach((rec, i) => buildUndoRecord(heap, rec, udata + i * UNDO_SIZE));
  heap.write(base + W.undoData, 'u32', udata);
  heap.write(base + W.undoNum, 'i32', undo.length);
  heap.write(base + W.undoMax, 'i32', ucap);
  heap.write(base + W.undoPos, 'i32', spec.undoPos ?? 0);
  heap.write(base + W.maxUndos, 'i32', spec.maxUndos ?? 64);
  heap.write(base + W.savedUndoPos, 'i32', spec.savedUndoPos ?? 0);

  heap.write(base + W.textFlags, 'u32', spec.textFlags ?? 0);
  heap.write(base + W.relayoutFlags, 'u32', spec.relayoutFlags ?? 0);
  heap.write(base + W.pendingPos, 'i32', spec.pendingPos ?? 0);
  heap.write(base + W.pendingLen, 'i32', spec.pendingLen ?? 0);
  heap.write(base + W.relayoutFlags2, 'u32', spec.relayoutFlags2 ?? 0);
  heap.write(base + W.pendingPos2, 'i32', spec.pendingPos2 ?? 0);
  heap.write(base + W.pendingLen2, 'i32', spec.pendingLen2 ?? 0);
  heap.write(base + W.height, 'f32', spec.height ?? 0);
  heap.write(base + W.lineSpacing, 'f32', spec.lineSpacing ?? 0);
  heap.write(base + W.lineHeight, 'f32', spec.lineHeight ?? 0);
  heap.write(base + W.stateFlags, 'u32', spec.stateFlags ?? 1);
  heap.write(base + W.blinkOn, 'f32', spec.blinkOn ?? 0.75);
  heap.write(base + W.blinkOff, 'f32', spec.blinkOff ?? 1.0);
  heap.write(base + W.stickyX, 'f32', spec.stickyX ?? 0);

  // Process-global scratch (probe begin_case resets these per case).
  const [cdata, cnum, cmax] = buildFString(heap, spec.clipboard);
  heap.write(heap.clipboard, 'u32', cdata);
  heap.write(heap.clipboard + 4, 'i32', cnum);
  heap.write(heap.clipboard + 8, 'i32', cmax);
  heap.write(heap.convertBuffer, 'u32', 0);
  heap.write(heap.convertBuffer + 4, 'i32', 0);
  heap.write(heap.convertBuffer + 8, 'i32', 0);
  heap.write(heap.convertFlag, 'u8', 0);

  let parent = spec.parent ?? 0;
  if (parent === true || (parent && typeof parent === 'object')) {
    parent = buildWindow(heap, parent === true ? {} : parent).base;
  }
  heap.write(base + W.parent, 'u32', parent);
  return {base, vtable};
}

/** Leaf services matching the probe's intercepted call sites. */
export function editLeafServices(heap, base, spec = {}) {
  const columns = [...(spec.columns ?? [])];
  const sink = spec.textChangedSink ?? 0;
  return {
    updateCaret(_object, _base, sticky) {
      heap.events.push({op: 'UpdateCaret', sticky: sticky | 0});
    },
    resetBlink() {
      heap.events.push({op: 'ResetBlink'});
    },
    columnFromX(_object, _base, line, x) {
      heap.events.push({op: 'ColumnFromX', line: line | 0, x: x | 0});
      return columns.length ? columns.shift() : 0;
    },
    askParentForReconfigure(_object, windowBase) {
      heap.events.push({op: 'AskParentForReconfigure', object: heap.canon(windowBase)});
    },
    textChanged(_object, receiver, sender, changed) {
      heap.events.push({
        op: 'TextChanged',
        receiver: heap.canon(receiver),
        sender: heap.canon(sender),
        changed: changed | 0,
      });
      return sink;
    },
    findFilterChar() {
      heap.events.push({op: 'FindFunction'});
      return spec.filterChar ?? 0;
    },
  };
}

function dumpFString(heap, address) {
  const data = heap.read(address, 'u32');
  return {
    text: data ? heap.readString(data) : null,
    data: heap.canon(data),
    num: heap.read(address + 4, 'i32'),
    max: heap.read(address + 8, 'i32'),
  };
}

function dumpLine(heap, address) {
  return {
    x: heap.read(address, 'u32'),
    start: heap.read(address + 4, 'i32'),
    visible: heap.read(address + 8, 'i32'),
    full: heap.read(address + 0xc, 'i32'),
  };
}

function dumpUndo(heap, address) {
  return {
    pos: heap.read(address, 'i32'),
    old: dumpFString(heap, address + 4),
    new: dumpFString(heap, address + 0x10),
  };
}

export function dumpState(heap, base) {
  const tdata = heap.read(base + W.text, 'u32');
  const text = {
    text: tdata ? heap.readString(tdata) : null,
    data: heap.canon(tdata),
    num: heap.read(base + W.textNum, 'i32'),
    max: heap.read(base + W.textMax, 'i32'),
  };
  const ldata = heap.read(base + W.linesData, 'u32');
  const lcount = heap.read(base + W.linesCount, 'i32');
  const lmax = heap.read(base + W.linesMax, 'i32');
  const lines = ldata
    ? Array.from({length: lcount}, (_, i) => dumpLine(heap, ldata + i * LINE_SIZE))
    : [];
  const l2data = heap.read(base + W.lines2Data, 'u32');
  const l2count = heap.read(base + W.lines2Count, 'i32');
  const l2max = heap.read(base + W.lines2Max, 'i32');
  const lines2 = l2data
    ? Array.from({length: l2count}, (_, i) => dumpLine(heap, l2data + i * LINE_SIZE))
    : [];
  const udata = heap.read(base + W.undoData, 'u32');
  const unum = heap.read(base + W.undoNum, 'i32');
  const umax = heap.read(base + W.undoMax, 'i32');
  const undo = udata
    ? Array.from({length: unum}, (_, i) => dumpUndo(heap, udata + i * UNDO_SIZE))
    : [];
  return {
    flags: heap.read(base + W.flags, 'u32'),
    ip: heap.read(base + W.ip, 'i32'),
    anchor: heap.read(base + W.anchor, 'i32'),
    ipType: heap.read(base + W.ipType, 'u8'),
    selStart: heap.read(base + W.selStart, 'i32'),
    selEnd: heap.read(base + W.selEnd, 'i32'),
    maxSize: heap.read(base + W.maxSize, 'i32'),
    ipTexture: heap.canon(heap.read(base + W.ipTexture, 'u32')),
    ipColor: heap.read(base + W.ipColor, 'u32'),
    selTexture: heap.canon(heap.read(base + W.selTexture, 'u32')),
    selColor: heap.read(base + W.selColor, 'u32'),
    selTextColor: heap.read(base + W.selTextColor, 'u32'),
    cursor: [0, 1, 2].map(i => heap.read(base + W.cursor + 4 * i, 'u32')),
    sounds: [0, 1, 2, 3].map(i => heap.read(base + W.sounds + 4 * i, 'u32')),
    undoData: heap.canon(udata), undoNum: unum, undoMax: umax,
    undoPos: heap.read(base + W.undoPos, 'i32'),
    maxUndos: heap.read(base + W.maxUndos, 'i32'),
    savedUndoPos: heap.read(base + W.savedUndoPos, 'i32'),
    blinkOn: heap.read(base + W.blinkOn, 'u32'),
    blinkOff: heap.read(base + W.blinkOff, 'u32'),
    stateFlags: heap.read(base + W.stateFlags, 'u32'),
    stickyX: heap.read(base + W.stickyX, 'u32'),
    height: heap.read(base + W.height, 'u32'),
    lineSpacing: heap.read(base + W.lineSpacing, 'u32'),
    lineHeight: heap.read(base + W.lineHeight, 'u32'),
    textFlags: heap.read(base + W.textFlags, 'u32'),
    relayoutFlags: heap.read(base + W.relayoutFlags, 'u32'),
    pendingPos: heap.read(base + W.pendingPos, 'i32'),
    pendingLen: heap.read(base + W.pendingLen, 'i32'),
    relayoutFlags2: heap.read(base + W.relayoutFlags2, 'u32'),
    pendingPos2: heap.read(base + W.pendingPos2, 'i32'),
    pendingLen2: heap.read(base + W.pendingLen2, 'i32'),
    text,
    linesData: heap.canon(ldata), linesCount: lcount, linesMax: lmax,
    lines,
    lines2Data: heap.canon(l2data), lines2Count: l2count, lines2Max: l2max,
    lines2,
    undo,
    parent: heap.canon(heap.read(base + W.parent, 'u32')),
    clipboard: dumpFString(heap, heap.clipboard),
    convert: dumpFString(heap, heap.convertBuffer),
    convertFlag: heap.read(heap.convertFlag, 'u8'),
  };
}
