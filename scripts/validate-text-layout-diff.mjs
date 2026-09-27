/** Differential check of the XLargeTextWindow / XEditWindow bodies against
 * Extension.dll (scripts/native-text-layout-oracle.py).
 *
 * The world — window, UGC, fonts with varied glyph metrics, font-page
 * textures, canvas and render interface — is built once in the window-host
 * native heap. Each case prepares its window there (JS-only preparation such
 * as a prior layout or edit may run first), serialises the heap image, runs
 * the JavaScript translation on the heap and the original body on the same
 * image in the oracle, then compares a canonical dump: the window bytes with
 * the FString/TArray data pointers replaced by their contents, the UGC bytes,
 * the recorded host events (script events, reconfigure/show-area requests,
 * sounds, DrawTile/glyph blocks, texture Lock/Unlock), EAX for int results and
 * the out-parameter cells. Unobservable stack garbage is masked on both sides:
 * the XTextParams flag bits above bit 1, a row state's colour floats while its
 * hasColor byte is 0, the vtable word, and the CursorRequested script
 * parameter block's shadow slot. docs/script-large-text-window.md. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import {writeFontImage, UFONT, FONT_PAGE} from '../src/runtime/script-font-model.mjs';
import {GC} from '../src/runtime/script-gc-state-model.mjs';
import {gcSetTextColor} from '../src/runtime/script-gc-set-text-color.mjs';
import {gcSetTileColor} from '../src/runtime/script-gc-set-tile-color.mjs';
import * as LT from '../src/runtime/script-window-large-text.mjs';
import * as ED from '../src/runtime/script-window-edit.mjs';
import {editMemory, textChangedRange, insertTextVirtual, setInsertionPointEntry} from '../src/runtime/script-edit-model.mjs';
import {gameDirectory} from './game-directory.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.NATIVE_PROBE_PYTHON || path.join(ROOT, '.cache/native-probe-env/bin/python');
const bitsView = new DataView(new ArrayBuffer(4));
const bits = v => (bitsView.setFloat32(0, v, true), bitsView.getUint32(0, true));
const fromBits = b => (bitsView.setUint32(0, b >>> 0, true), bitsView.getFloat32(0, true));
const IMAGE_BASE = 0x21000000;

// ---------------------------------------------------------------------------
// World.
// ---------------------------------------------------------------------------
const heap = createNativeHeap({capacity: 1 << 22});
const mem = heap.mem;
const W = {
  heap,
  u8: (o, off) => heap.read(o, off, 'u8'), u16: (o, off) => heap.read(o, off, 'u16'),
  u32: (o, off) => heap.read(o, off, 'u32'), i32: (o, off) => heap.read(o, off, 'i32'),
  f32: (o, off) => heap.read(o, off, 'f32'), ptr: (o, off) => heap.read(o, off, 'ptr'),
  setU8: (o, off, v) => heap.write(o, off, 'u8', v & 0xff), setU32: (o, off, v) => heap.write(o, off, 'u32', v >>> 0),
  setI32: (o, off, v) => heap.write(o, off, 'i32', v | 0), setF32: (o, off, v) => heap.write(o, off, 'f32', Math.fround(v)),
  setPtr: (o, off, v) => heap.write(o, off, 'ptr', v),
  addressOf: v => heap.addressOf(v),
  boundary: message => { throw new Error(message); },
};
let events = [], current = {};
const record = event => events.push(event);
const address = v => (v ? heap.addressOf(v) : 0);

// Render boundary: the texture vtable (+0x54 Lock, +0x58 Unlock), canvas table
// (+0x5c DrawTile) and render-interface table (+0x7c glyph DrawTile) hold the
// host's slot ids 1..4; the oracle patches the same words with its stubs.
const textureVtable = mem.allocRaw(0x80); mem.write(textureVtable + 0x54, 'u32', 1); mem.write(textureVtable + 0x58, 'u32', 2);
const canvas = {name: 'Canvas'}; heap.allocate(canvas, 0x80);
const sceneNode = mem.allocRaw(0x40), viewport = mem.allocRaw(0xc0), renderInterface = mem.allocRaw(4);
const renderTable = mem.allocRaw(0x100), canvasTable = mem.allocRaw(0x60);
W.setU32(canvas, 0, canvasTable); mem.write(canvasTable + 0x5c, 'u32', 4);
W.setU32(canvas, 0x78, viewport); W.setU32(canvas, 0x7c, sceneNode); W.setF32(canvas, 0x4c, 0.5);
mem.write(sceneNode, 'u32', viewport); mem.write(viewport + 0x64, 'u32', renderInterface);
mem.write(viewport + 0xb0, 'u32', 0x11); mem.write(viewport + 0xb4, 'u32', 0x22);
mem.write(renderInterface, 'u32', renderTable); mem.write(renderTable + 0x7c, 'u32', 3);
const texCache = {records: Array.from({length: 5}, () => mem.allocRaw(0x84)), static: mem.allocRaw(0x84), head: 0, count: 0};
const recordLabel = at => at === texCache.static ? 'recStatic' : texCache.records.includes(at) ? `rec${texCache.records.indexOf(at)}` : at;
const coords = c => [c.x, c.y, c.xl, c.yl, c.u, c.v, c.ul, c.vl];
const gcServices = {mem, objectAddress: o => heap.addressOf(o), texCache,
  callVirtual(slot, object, command) {
    const self = address(object) || object;
    if (slot === 1) { record({op: 'TextureLock', texture: self, record: recordLabel(command.record), b0: command.b0, b4: command.b4, arg3: command.arg3, ri: command.ri}); mem.write(command.record, 'u32', self); return; }
    if (slot === 2) { record({op: 'TextureUnlock', texture: self, record: recordLabel(command.record)}); return; }
    if (slot === 3) { record({op: 'DrawGlyphTile', ri: self, node: command.node, record: recordLabel(command.record), texture: mem.read(command.record, 'u32'), coords: coords(command), span: command.spanBuffer, z: command.z, color: [...command.color], fog: [...command.fog], polyFlags: command.polyFlags}); return; }
    if (slot === 4) { record({op: 'DrawTile', canvas: self, texture: command.texture, coords: coords(command), span: command.spanBuffer, z: command.z, color: [...command.color], fog: [...command.fog], polyFlags: command.polyFlags}); return; }
    throw new Error(`unknown render slot ${slot}`);
  }};

let textures = 0;
function makeTexture(width, height) {
  const texture = {name: `Texture${textures++}`};
  heap.allocate(texture, 0x60);
  W.setU32(texture, 0, textureVtable); W.setI32(texture, 0x34, width); W.setI32(texture, 0x38, height);
  return texture;
}
// Two synthetic fonts: printable ASCII with widths 3..9 and heights 9..12
// (bold wider/taller); page 0 covers 0..0xff.
function makeFont(boldness) {
  const chars = Array.from({length: 0x100}, (_, c) => c < 0x20 ? [0, 0, 0, 0]
    : [(c * 7) % 200, (c * 3) % 50, 3 + ((c * 5 + boldness) % 7), 9 + ((c + boldness) % 4)]);
  const font = writeFontImage(mem, {charsPerPage: 0x100, pageCount: 1, pages: [{chars}]});
  mem.write(mem.read(font + UFONT.pages, 'u32') + FONT_PAGE.texture, 'u32', heap.addressOf(makeTexture(256, 64)));
  return font;
}
const normalFont = makeFont(0), boldFont = makeFont(2);
const insertTexture = makeTexture(2, 14), selectTexture = makeTexture(8, 8);
const sounds = [1, 2, 3, 4].map(i => ({name: `Sound${i}`}));
sounds.forEach(sound => heap.allocate(sound, 0x40));
const root = {name: 'Root'}; heap.allocate(root, 0x800);
const parentWindow = {name: 'Parent'}; heap.allocate(parentWindow, 0x300);

const gc = {name: 'GC'}; heap.allocate(gc, GC.size);
function resetGc(spec = {}) {
  for (let off = 4; off < GC.size; off += 4) W.setU32(gc, off, 0);
  W.setU32(gc, GC.vtable, 0x100598dc);
  W.setU32(gc, GC.canvas, heap.addressOf(canvas));
  for (const [off, v] of [[GC.originX, spec.originX ?? 10], [GC.originY, spec.originY ?? 20], [GC.clipX, 0], [GC.clipY, 0],
    [GC.clipWidth, spec.clipWidth ?? 400], [GC.clipHeight, spec.clipHeight ?? 300]]) W.setF32(gc, off, v);
  W.setU8(gc, GC.style, 1);
  W.setU32(gc, GC.flags, spec.drawing === false ? 0 : 2);
  W.setU32(gc, GC.polyFlags, 0x800); W.setU32(gc, GC.textPolyFlags, 0x804);
  gcSetTileColor(gc, 0x80ff4020, gcServices); gcSetTextColor(gc, spec.textColor ?? 0x40c0e0a0, gcServices);
  W.setU32(gc, GC.normalFont, spec.normalFont ?? normalFont); W.setU32(gc, GC.boldFont, spec.boldFont ?? boldFont);
  W.setF32(gc, GC.textVSpacing, spec.vSpacing ?? 0);
  W.setU32(gc, GC.textFlags, spec.specialText ? 2 : 0);
  W.setI32(gc, 0x9c, 1); W.setI32(gc, 0xa0, 1);
}
W.gc = {get: () => gc, release: () => {}, services: gcServices};
W.tickOffset = () => fromBits(current.tickOffset ?? 0);
W.processScript = (win, event, args = [], options = {}) => {
  if (event === 'DrawWindow') { record({op: 'DrawWindow', gc: address(args[0])}); return undefined; }
  const floats = ['MouseMoved', 'MouseButtonPressed', 'MouseButtonReleased'].includes(event) ? 2 : 0;
  const words = args.map((v, i) => i < floats ? bits(v) : typeof v === 'boolean' ? Number(v)
    : typeof v === 'number' ? v >>> 0 : typeof v === 'string' ? v : address(v));
  record({op: 'ProcessScript', event, args: words});
  return options.result === undefined ? undefined : current.scriptResult ?? 0;
};
W.native = {getCursorPos: () => ({x: fromBits(current.cursorPos[0]), y: fromBits(current.cursorPos[1])})};

const editGlobals = {emptyWString: mem.allocRaw(4), clipboard: mem.allocRaw(12), convertBuffer: mem.allocRaw(12),
  convertFlag: mem.allocRaw(4), convertRun: mem.allocRaw(0x1000), charSlot: mem.allocRaw(8), scratchInsert: mem.allocRaw(12), keyBuffer: mem.allocRaw(4)};
const allocString = text => {
  const at = mem.allocRaw((text.length + 1) * 2);
  for (let i = 0; i < text.length; i++) mem.write(at + 2 * i, 'u16', text.charCodeAt(i));
  mem.write(at + 2 * text.length, 'u16', 0);
  return at;
};
const editMem = {...mem, ...editGlobals, alloc: size => mem.allocRaw(size), allocString,
  readString(at) { let s = ''; for (;; at += 2) { const u = mem.read(at, 'u16'); if (!u) return s; s += String.fromCharCode(u); } }};
const env = {
  editL: win => editMemory(win, editServices),
  askParentForReconfigure: win => record({op: 'AskParentForReconfigure', window: address(win)}),
  askParentToShowArea: (win, x, y, w, h) => record({op: 'AskParentToShowArea', area: [x, y, w, h].map(bits)}),
  setSelectability: (_win, value) => record({op: 'SetSelectability', value}),
  getRootWindow: () => current.root ? root : null,
  getCursorPos: win => W.native.getCursorPos(win),
  playSound: (_win, sound, volume, pitch, x, y) => record({op: 'PlaySound', args: [address(sound), bits(volume), bits(pitch), bits(x), bits(y)]}),
  processScript: (...args) => W.processScript(...args),
  isFocusWindow: () => Boolean(current.isFocus),
  isKeyDown: (_win, key) => current.keys?.[key] ?? 0,
  largeTextDraw: (win, g) => LT.largeTextDraw(W, win, g),
  keyBuffer: () => editGlobals.keyBuffer,
  scriptCursorRequested(win, source, x, y, hotX, hotY, color) {
    record({op: 'ProcessScript', event: 'CursorRequested', args: [address(source), bits(x), bits(y), bits(hotX), bits(hotY), color >>> 0, 'shadow']});
    return {texture: current.scriptResult ? heap.objectAt(current.scriptResult) : null, hotX, hotY, color};
  },
  v: {
    mouseMoved: (win, x, y) => record({op: 'MouseMoved', window: address(win), args: [bits(x), bits(y)]}),
    editActivated: (w, win, modified) => { record({op: 'EditActivated', window: address(w), args: [address(win), modified]}); return current.editActivatedResult ?? 0; },
  },
};
const editServices = {mem: editMem, objectAddress: win => heap.addressOf(win),
  updateCaret: (win, _base, sticky) => ED.computeCursorConfig(W, win, sticky, env),
  resetBlink: win => ED.showCursor(W, win, env),
  columnFromX: (win, _base, row, xBits) => ED.xToCol(W, win, row, fromBits(xBits)),
  askParentForReconfigure: win => env.askParentForReconfigure(win),
  textChanged: (win, receiver, _base, changed) => { record({op: 'TextChanged', window: receiver, args: [address(win), changed]}); return current.textChangedResult ?? 0; },
  findFilterChar: () => 0,
};
const textServices = {read: (o, off, k) => heap.read(o, off, k), write: (o, off, k, v) => heap.write(o, off, k, v),
  realloc: (at, size) => heap.realloc(at, size),
  askParentForReconfigure: ({object}) => env.askParentForReconfigure(object), makeAcceleratorTableDirty: () => {}};
const makeAreaDirty = (win, position, removed, inserted) => textChangedRange(editMemory(win, editServices), position, removed, inserted);

// ---------------------------------------------------------------------------
// Window images.
// ---------------------------------------------------------------------------
const windows = [];
function makeWindow(family, spec = {}) {
  const win = {name: `W${windows.length}`};
  heap.allocate(win, 0x300);
  windows.push(win);
  W.setU32(win, 0, family === 'edit' ? ED.EDIT.vtable : LT.LARGE_TEXT.vtable);
  W.setF32(win, 0x80, spec.width ?? 160); W.setF32(win, 0x84, spec.height ?? 90);
  const clip = spec.clip ?? [0, 0, 0, 0, spec.width ?? 160, spec.height ?? 90];
  clip.forEach((v, i) => W.setF32(win, 0xd4 + 4 * i, v));
  W.setPtr(win, 0x138, spec.parent ? parentWindow : null);
  W.setU32(win, 0x114, bits(spec.volume ?? 0.75));
  W.setPtr(win, 0x130, spec.ownGc ? gc : null);
  W.setU32(win, 0x74, spec.special ?? 0);
  W.setU8(win, 0x14c, spec.hAlign ?? 0); W.setU8(win, 0x14d, spec.vAlign ?? 0);
  W.setU32(win, 0x150, spec.wrap === false ? 0 : 1);
  W.setF32(win, 0x154, spec.hMargin ?? 3); W.setF32(win, 0x158, spec.vMargin ?? 2);
  W.setI32(win, 0x15c, spec.minLines ?? -1); W.setI32(win, 0x160, spec.maxLines ?? -1); W.setF32(win, 0x164, spec.minWidth ?? 0);
  heap.write(win, 0x168, 'string', spec.text ?? '');
  W.setF32(win, 0x174, spec.vSpace ?? 1); W.setF32(win, 0x178, spec.lineHeight ?? 12);
  W.setU32(win, 0x17c, 1); W.setU32(win, 0x1a0, 1);
  if (family === 'edit') {
    const E = ED.EDIT;
    W.setU32(win, E.flags, spec.editFlags ?? 1); W.setI32(win, E.insertPos, spec.insertPos ?? 0); W.setI32(win, E.insertHookPos, spec.insertPos ?? 0);
    W.setU8(win, E.insertType, spec.insertType ?? 0);
    W.setI32(win, E.selectStart, spec.select?.[0] ?? -1); W.setI32(win, E.selectEnd, spec.select?.[1] ?? -1);
    W.setI32(win, E.maxSize, 200000);
    W.setPtr(win, E.insertTexture, spec.noInsertTexture ? null : insertTexture); W.setU32(win, E.insertColor, 0xffffffff);
    W.setPtr(win, E.selectTexture, selectTexture); W.setU32(win, E.selectColor, 0xffc4c4c4); W.setU32(win, E.inverseColor, 0xff000000);
    W.setPtr(win, E.editCursor, spec.editCursor ? insertTexture : null); W.setPtr(win, E.editCursorShadow, selectTexture);
    W.setU32(win, E.editCursorColor, 0x00ff8040);
    sounds.forEach((sound, i) => W.setPtr(win, E.typeSound + 4 * i, sound));
    W.setI32(win, E.maxUndos, 0x40);
    W.setF32(win, E.blinkStart, 0.75); W.setF32(win, E.blinkPeriod, spec.blinkPeriod ?? 1);
    W.setF32(win, E.blinkDelay, spec.blinkDelay ?? 0.5); W.setF32(win, E.dragDelay, spec.dragDelay ?? 0.05);
    W.setU32(win, E.cursorFlags, spec.cursorFlags ?? 1);
    W.setF32(win, E.insertPrefWidth, spec.prefWidth ?? 0); W.setF32(win, E.insertPrefHeight, spec.prefHeight ?? 0);
    W.setF32(win, E.lastConfigWidth, spec.lastConfig?.[0] ?? -1); W.setF32(win, E.lastConfigHeight, spec.lastConfig?.[1] ?? -1);
    W.setI32(win, E.selectStartRow, -1); W.setI32(win, E.selectEndRow, -1);
  }
  return win;
}
const layout = win => LT.largeTextConfigurationChanged(W, win);

// ---------------------------------------------------------------------------
// Canonical dump over a byte reader (JS heap or oracle image + blocks).
// ---------------------------------------------------------------------------
const WINDOW_POINTERS = [0x168, 0x194, 0x1b8, 0x1c4, 0x21c];
function dump(read, win, family) {
  const base = heap.addressOf(win), g = heap.addressOf(gc);
  const u32 = at => read(at) | read(at + 1) << 8 | read(at + 2) << 16 | (read(at + 3) << 24 >>> 0);
  const bytes = (at, n) => Array.from({length: n}, (_, i) => read(at + i));
  const window = bytes(base, family === 'edit' ? 0x28c : 0x1d0);
  for (const off of [0, ...WINDOW_POINTERS]) window.fill(0, off, off + 4);
  for (const off of [0x17c, 0x1a0]) { window[off] &= 3; window.fill(0, off + 1, off + 4); }
  const array = (off, size) => {
    const data = u32(base + off), num = u32(base + off + 4) | 0;
    const content = num > 0 && data ? bytes(data, num * size) : [];
    return {num, max: u32(base + off + 8) | 0, content};
  };
  const rows = off => {
    const r = array(off, 0x24);
    for (let i = 0; i < r.num; i++) if (!r.content[i * 0x24 + 0x11]) r.content.fill(0, i * 0x24 + 0x14, i * 0x24 + 0x24);
    return r;
  };
  const text = array(0x168, 2);
  const out = {window: Buffer.from(window).toString('hex'), text: {num: text.num, max: text.max, content: Buffer.from(text.content).toString('hex')},
    rows: rows(0x194), queryRows: rows(0x1b8), gc: Buffer.from(bytes(g, GC.size)).toString('hex')};
  out.rows.content = Buffer.from(out.rows.content).toString('hex'); out.queryRows.content = Buffer.from(out.queryRows.content).toString('hex');
  if (family === 'edit') {
    const undo = array(0x21c, 0x1c), records = [];
    for (let i = 0; i < undo.num; i++) {
      const at = u32(base + 0x21c) + i * 0x1c, string = off => { const d = u32(at + off), n = u32(at + off + 4) | 0; return n && d ? Buffer.from(bytes(d, n * 2)).toString('hex') : ''; };
      records.push({pos: u32(at) | 0, old: string(4), new: string(0x10)});
    }
    out.undo = {num: undo.num, max: undo.max, records};
  }
  return out;
}

// ---------------------------------------------------------------------------
// Methods: the JS call and the oracle's dword arguments.
// ---------------------------------------------------------------------------
const cell = (index, value) => ({cell: index, value: value >>> 0});
const METHODS = {
  'largeText.configurationChanged': {js: win => LT.largeTextConfigurationChanged(W, win)},
  'largeText.preferredSize': {args: (bW, w, bH, h) => [bW, cell(0, bits(w)), bH, cell(1, bits(h))],
    js: (win, bW, w, bH, h) => { const r = LT.largeTextPreferredSize(W, win, bW, w, bH, h); return {cells: [bits(r.width), bits(r.height)]}; }},
  'largeText.granularity': {args: (h, v) => [cell(0, bits(h)), cell(1, bits(v))],
    js: (win, h, v) => { let out; LT.largeTextGranularity(W, win, h, v, (_w, h1, v1) => { record({op: 'ParentRequestedGranularity', h: bits(h1), v: bits(v1)}); out = [bits(h1), bits(v1)]; }); return {cells: out ?? [bits(h), bits(v)]}; }},
  'largeText.draw': {args: () => [heap.addressOf(gc)], js: win => LT.largeTextDraw(W, win, gc)},
  'largeText.setText': {args: text => [allocString(text)], js: (win, text) => LT.largeTextSetText(W, win, text, textServices)},
  'largeText.appendText': {args: text => [allocString(text)], js: (win, text) => LT.largeTextAppendText(W, win, text, textServices, makeAreaDirty)},
  'edit.computeCursorConfig': {js: (win, sticky) => ED.computeCursorConfig(W, win, sticky, env)},
  'edit.showCursor': {js: win => ED.showCursor(W, win, env)},
  'edit.tick': {args: delta => [bits(delta)], js: (win, delta) => ED.editTick(W, win, delta, env)},
  'edit.cursorRequested': {args: (x, y) => [heap.addressOf(parentWindow), bits(x), bits(y), cell(0, bits(-1)), cell(1, bits(-1)), cell(2, 0x00ffffff), cell(3, 0)],
    js: (win, x, y) => { const r = ED.editCursorRequested(W, win, parentWindow, x, y, -1, -1, 0x00ffffff, env);
      return {eax: address(r.texture), cells: [bits(r.hotX), bits(r.hotY), r.color >>> 0, r.shadow === undefined ? 0 : address(r.shadow)]}; }},
  'edit.preferredSize': {args: (bW, w, bH, h) => [bW, cell(0, bits(w)), bH, cell(1, bits(h))],
    js: (win, bW, w, bH, h) => { const r = ED.editPreferredSize(W, win, bW, w, bH, h); return {cells: [bits(r.width), bits(r.height)]}; }},
  'edit.configurationChanged': {js: win => ED.editConfigurationChanged(W, win, env)},
  'edit.visibilityChanged': {js: (win, visible) => ED.editVisibilityChanged(W, win, visible, env)},
  'edit.draw': {args: () => [heap.addressOf(gc)], js: win => ED.editDraw(W, win, gc, env)},
  'edit.keyPressed': {js: (win, key) => ({eax: ED.editKeyPressed(W, win, key, env)})},
  'edit.virtualKeyPressed': {js: (win, key, repeat) => ({eax: ED.editVirtualKeyPressed(W, win, key, repeat, env)})},
  'edit.mouseButtonPressed': {args: (x, y, key, count) => [bits(x), bits(y), key, count], js: (win, x, y, key, count) => ({eax: ED.editMouseButtonPressed(W, win, x, y, key, count, env)})},
  'edit.mouseMoved': {args: (x, y) => [bits(x), bits(y)], js: (win, x, y) => ED.editMouseMoved(W, win, x, y, env)},
  'edit.mouseButtonReleased': {args: (x, y, key, count) => [bits(x), bits(y), key, count], js: (win, x, y, key, count) => ({eax: ED.editMouseButtonReleased(W, win, x, y, key, count, env)})},
  'edit.appendText': {args: text => [allocString(text)], js: (win, text, at) => ED.editAppendText(W, win, at, env)},
  'edit.xToCol': {args: (row, x) => [row, bits(x)], js: (win, row, x) => ({eax: ED.xToCol(W, win, row, x)})},
  'edit.yToRow': {args: y => [bits(y)], js: (win, y) => ({eax: ED.yToRow(W, win, y)})},
  'edit.xyToPos': {args: (x, y) => [bits(x), bits(y)], js: (win, x, y) => ({eax: ED.xyToPos(W, win, x, y)})},
  'edit.playEditSound': {args: (sound, v, p) => [address(sounds[sound]), bits(v), bits(p)], js: (win, sound, v, p) => ED.playEditSound(W, win, sounds[sound], v, p, env)},
  'window.enableSpecialText': {js: (win, flag) => ED.enableSpecialText(W, win, flag, env)},
};

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------
const LONG = 'The quick brown fox jumps over the lazy dog while the note keeps going across several wrapped rows.';
const LINES = 'first line\nsecond line is a little longer\n\nfourth after a blank line\n';
const SPECIAL = 'plain |bbold words|b then |c80ff40coloured|!c text and |p3palette|!p end |&k';
const cases = [];
const add = (name, family, spec, method, args = [], options = {}) => cases.push({name, family, spec, method, args, options});
for (const [label, text] of [['empty', ''], ['word', 'Hello'], ['long', LONG], ['lines', LINES], ['nowrap', LONG]]) {
  add(`lt config ${label}`, 'largeText', {text, wrap: label !== 'nowrap'}, 'largeText.configurationChanged');
  add(`lt config ${label} narrow`, 'largeText', {text, width: 41, hMargin: 5}, 'largeText.configurationChanged');
}
add('lt config special', 'largeText', {text: SPECIAL}, 'largeText.configurationChanged', [], {gc: {specialText: true}});
add('lt config special plain gc', 'largeText', {text: SPECIAL}, 'largeText.configurationChanged');
add('lt config vspacing font', 'largeText', {text: LONG}, 'largeText.configurationChanged', [], {gc: {vSpacing: 2.5}});
add('lt config relayout same', 'largeText', {text: LONG, prelayout: true}, 'largeText.configurationChanged');
for (const [label, edit] of [['insert mid', {at: 20, insert: 'INSERTED TEXT HERE '}], ['delete', {at: 10, remove: 25}],
  ['newline', {at: 30, insert: '\n'}], ['append', {at: -1, insert: ' and more words at the end of it all'}],
  ['start', {at: 0, insert: 'Lead '}], ['replace all', {at: 0, remove: 999, insert: 'short'}]]) {
  add(`lt incremental ${label}`, 'largeText', {text: LONG, prelayout: true, edit}, 'largeText.configurationChanged');
  add(`lt incremental lines ${label}`, 'largeText', {text: LINES, prelayout: true, edit}, 'largeText.configurationChanged');
}
add('lt incremental width change', 'largeText', {text: LONG, prelayout: true, edit: {at: 5, insert: 'xx'}, widthAfter: 120}, 'largeText.configurationChanged');
for (const [bW, w, bH, h] of [[1, 120, 0, 0], [0, 0, 0, 0], [1, 60, 1, 50], [1, 4, 0, 0], [0, 0, 1, 30]])
  for (const [label, extra] of [['', {}], [' minlines', {minLines: 5, prelayout: true}], [' maxlines', {maxLines: 1, prelayout: true}], [' minwidth', {minWidth: 300}]])
    add(`lt preferred ${bW}${bH} ${w}x${h}${label}`, 'largeText', {text: LONG, ...extra}, 'largeText.preferredSize', [bW, w, bH, h]);
add('lt preferred empty', 'largeText', {text: ''}, 'largeText.preferredSize', [1, 100, 0, 0]);
add('lt granularity', 'largeText', {text: 'x', vSpace: 2.25}, 'largeText.granularity', [0.5, 0.5]);
add('lt granularity bold only', 'largeText', {text: 'x'}, 'largeText.granularity', [0, 0], {gc: {normalFont: 0}});
for (const [hAlign, vAlign] of [[0, 0], [1, 1], [2, 2], [1, 0], [2, 1]])
  add(`lt draw ${hAlign}${vAlign}`, 'largeText', {text: LINES, prelayout: true, hAlign, vAlign}, 'largeText.draw');
add('lt draw clipped', 'largeText', {text: LONG, prelayout: true, clip: [0, 0, 0, 13.5, 160, 20]}, 'largeText.draw');
add('lt draw special', 'largeText', {text: SPECIAL, prelayout: true}, 'largeText.draw', [], {gc: {specialText: true}});
add('lt draw no drawing', 'largeText', {text: LONG, prelayout: true}, 'largeText.draw', [], {gc: {drawing: false}});
add('lt setText', 'largeText', {text: 'old text', prelayout: true}, 'largeText.setText', ['new text value']);
add('lt appendText', 'largeText', {text: LONG, prelayout: true}, 'largeText.appendText', [' tail']);
add('lt appendText empty', 'largeText', {text: 'abc'}, 'largeText.appendText', ['']);

const EDIT_TEXT = 'Edit this note: first row\nsecond row with more words to wrap around the edge';
for (const type of [0, 1, 2, 3, 4])
  for (const [label, extra] of [['', {}], [' pref', {prefWidth: 5, prefHeight: 7}]])
    add(`edit caret type ${type}${label}`, 'edit', {text: EDIT_TEXT, prelayout: true, insertType: type, insertPos: 30, ...extra}, 'edit.computeCursorConfig', [1]);
for (const pos of [0, 5, 25, 26, 40, 78])
  add(`edit caret pos ${pos}`, 'edit', {text: EDIT_TEXT, prelayout: true, insertPos: pos}, 'edit.computeCursorConfig', [0]);
add('edit caret selection', 'edit', {text: EDIT_TEXT, prelayout: true, insertPos: 40, select: [8, 40]}, 'edit.computeCursorConfig', [0]);
add('edit caret empty', 'edit', {text: '', prelayout: true}, 'edit.computeCursorConfig', [1]);
for (const [hAlign, vAlign] of [[1, 1], [2, 2]])
  add(`edit caret align ${hAlign}${vAlign}`, 'edit', {text: EDIT_TEXT, prelayout: true, insertPos: 12, hAlign, vAlign}, 'edit.computeCursorConfig', [1]);
add('edit showCursor', 'edit', {text: EDIT_TEXT, prelayout: true, precaret: true, insertPos: 12}, 'edit.showCursor', [], {tickOffset: bits(0.125)});
for (const [label, extra, delta] of [['blink hold', {blinkDelay: 0.5}, 0.25], ['blink toggle', {blinkDelay: 0.1}, 0.25],
  ['blink overrun', {blinkDelay: 0.1, blinkPeriod: 0.2}, 0.5], ['not editing', {editFlags: 0, blinkDelay: 0.1}, 0.25],
  ['drag repeat', {cursorFlags: 3, dragDelay: 0.05}, 0.1], ['drag overrun', {cursorFlags: 3, dragDelay: 0.05}, 0.5], ['drag hold', {cursorFlags: 3}, 0.01]])
  add(`edit tick ${label}`, 'edit', {text: EDIT_TEXT, prelayout: true, precaret: true, ...extra}, 'edit.tick', [delta], {cursorPos: [bits(33), bits(15.5)]});
add('edit cursor own', 'edit', {text: 'x', editCursor: true}, 'edit.cursorRequested', [3, 4]);
add('edit cursor root', 'edit', {text: 'x'}, 'edit.cursorRequested', [3, 4], {root: true, rootCursor: true});
add('edit cursor script', 'edit', {text: 'x'}, 'edit.cursorRequested', [3, 4], {root: true});
add('edit cursor not editing', 'edit', {text: 'x', editFlags: 0, editCursor: true}, 'edit.cursorRequested', [3, 4]);
for (const [bW, w, bH, h] of [[1, 120, 0, 0], [0, 0, 0, 0], [1, 120, 1, 40]])
  for (const flags of [1, 3])
    add(`edit preferred ${bW}${bH} flags ${flags}`, 'edit', {text: EDIT_TEXT, editFlags: flags}, 'edit.preferredSize', [bW, w, bH, h]);
add('edit config first', 'edit', {text: EDIT_TEXT, insertPos: 30}, 'edit.configurationChanged');
add('edit config same size', 'edit', {text: EDIT_TEXT, insertPos: 30, lastConfig: [160, 90]}, 'edit.configurationChanged');
add('edit visibility on', 'edit', {text: EDIT_TEXT, prelayout: true, precaret: true}, 'edit.visibilityChanged', [1], {tickOffset: bits(0.03125)});
add('edit visibility off', 'edit', {text: EDIT_TEXT, prelayout: true, precaret: true}, 'edit.visibilityChanged', [0]);
add('edit draw unfocused', 'edit', {text: EDIT_TEXT, prelayout: true, precaret: true}, 'edit.draw');
add('edit draw focused', 'edit', {text: EDIT_TEXT, prelayout: true, precaret: true, insertPos: 12}, 'edit.draw', [], {isFocus: 1});
add('edit draw selection', 'edit', {text: EDIT_TEXT + '\nthird row here', prelayout: true, insertPos: 70, select: [8, 70], precaret: true}, 'edit.draw', [], {isFocus: 1});
add('edit draw selection one row', 'edit', {text: EDIT_TEXT, prelayout: true, insertPos: 14, select: [3, 14], precaret: true}, 'edit.draw', [], {isFocus: 1});
add('edit draw caret hidden', 'edit', {text: EDIT_TEXT, prelayout: true, precaret: true, cursorFlags: 0}, 'edit.draw', [], {isFocus: 1});
add('edit draw centered', 'edit', {text: EDIT_TEXT, prelayout: true, precaret: true, hAlign: 1, vAlign: 1, insertPos: 3}, 'edit.draw', [], {isFocus: 1});
for (const key of [0x41, 0x60, 0x1f, 0x7e, 0x20])
  add(`edit key 0x${key.toString(16)}`, 'edit', {text: EDIT_TEXT, prelayout: true, precaret: true, insertPos: 4}, 'edit.keyPressed', [key]);
add('edit key not editing', 'edit', {text: EDIT_TEXT, editFlags: 0}, 'edit.keyPressed', [0x41], {scriptResult: 1});
add('edit vkey enter single', 'edit', {text: 'one line', editFlags: 3, parent: true, prelayout: true, precaret: true}, 'edit.virtualKeyPressed', [0x0d, 0], {editActivatedResult: 0});
add('edit vkey enter multi', 'edit', {text: 'one line', prelayout: true, precaret: true}, 'edit.virtualKeyPressed', [0x0d, 1], {scriptResult: 1});
add('edit vkey other', 'edit', {text: 'one line'}, 'edit.virtualKeyPressed', [0x25, 0]);
for (const [label, count, keys] of [['click', 1, {}], ['double', 2, {}], ['ctrl', 1, {0x11: 1}], ['shift', 1, {0x10: 1}], ['triple', 3, {}]])
  add(`edit press ${label}`, 'edit', {text: EDIT_TEXT, prelayout: true, precaret: true, insertPos: 3}, 'edit.mouseButtonPressed', [40.5, 16, 1, count], {keys, tickOffset: bits(0.2)});
add('edit press right', 'edit', {text: EDIT_TEXT, prelayout: true}, 'edit.mouseButtonPressed', [40.5, 16, 2, 1]);
add('edit moved dragging', 'edit', {text: EDIT_TEXT, prelayout: true, precaret: true, cursorFlags: 3, insertPos: 3}, 'edit.mouseMoved', [90, 30]);
add('edit moved idle', 'edit', {text: EDIT_TEXT, prelayout: true}, 'edit.mouseMoved', [90, 30]);
add('edit release left', 'edit', {text: EDIT_TEXT, cursorFlags: 7}, 'edit.mouseButtonReleased', [1, 2, 1, 1]);
add('edit release right', 'edit', {text: EDIT_TEXT, cursorFlags: 7}, 'edit.mouseButtonReleased', [1, 2, 2, 1], {scriptResult: 1});
add('edit appendText', 'edit', {text: EDIT_TEXT, prelayout: true, precaret: true}, 'edit.appendText', [' appended']);
for (const [row, x] of [[0, 0], [0, 25.5], [1, 400], [-1, 5], [9, 5]]) add(`edit xToCol ${row} ${x}`, 'edit', {text: EDIT_TEXT, prelayout: true}, 'edit.xToCol', [row, x]);
for (const y of [-5, 0, 13.4, 14, 60, 999]) add(`edit yToRow ${y}`, 'edit', {text: EDIT_TEXT, prelayout: true, vAlign: y === 60 ? 1 : 0}, 'edit.yToRow', [y]);
for (const [x, y] of [[10, 5], [80, 20], [200, 200]]) add(`edit xyToPos ${x} ${y}`, 'edit', {text: EDIT_TEXT, prelayout: true}, 'edit.xyToPos', [x, y]);
add('edit xyToPos empty', 'edit', {text: ''}, 'edit.xyToPos', [4, 4]);
add('edit playEditSound', 'edit', {text: 'x', prelayout: true, precaret: true}, 'edit.playEditSound', [1, -1, 1]);
add('window enableSpecialText on', 'edit', {text: 'x', ownGc: true, special: 0}, 'window.enableSpecialText', [1]);
add('window enableSpecialText same', 'edit', {text: 'x', ownGc: true, special: 1}, 'window.enableSpecialText', [1]);

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------
const prepared = [];
for (const c of cases) {
  events = []; current = {...c.options};
  resetGc(c.options.gc);
  W.setPtr(root, 0x5a8, c.options.rootCursor ? insertTexture : null);
  const win = makeWindow(c.family, c.spec);
  if (c.spec.prelayout) layout(win);
  if (c.spec.edit) {
    const {at, insert = '', remove = 0} = c.spec.edit, text = heap.read(win, 0x168, 'string');
    const start = at < 0 ? text.length : Math.min(at, text.length), removed = Math.min(remove, text.length - start);
    heap.write(win, 0x168, 'string', text.slice(0, start) + insert + text.slice(start + removed));
    makeAreaDirty(win, start, removed, insert.length);
    if (c.spec.widthAfter) W.setF32(win, 0x80, c.spec.widthAfter);
  }
  if (c.spec.precaret) ED.computeCursorConfig(W, win, 1, env);
  const method = METHODS[c.method];
  const oracleArgs = method.args ? method.args(...c.args) : c.args.map(v => v >>> 0);
  const image = Buffer.from(heap.bytes.subarray(0, heap.usedEnd() - IMAGE_BASE)).toString('base64');
  events = [];
  const jsArgs = c.method.endsWith('appendText') && c.family === 'edit' ? [...c.args, oracleArgs[0]] : c.args;
  let result, error = null;
  try { result = method.js(win, ...jsArgs) ?? {}; } catch (e) { error = e; }
  const js = error ? {error: error.stack} : {events, eax: result.eax, cells: result.cells, state: dump(at => heap.bytes[at - IMAGE_BASE], win, c.family)};
  prepared.push({c, win, js, request: {name: c.name, image, family: c.family, window: heap.addressOf(win), parents: c.spec.parent ? [heap.addressOf(parentWindow)] : [],
    method: c.method, args: oracleArgs, gc: heap.addressOf(gc), tickOffset: c.options.tickOffset ?? 0, isFocus: c.options.isFocus ?? 0,
    root: c.options.root ? heap.addressOf(root) : 0, keys: Object.fromEntries(Object.entries(c.options.keys ?? {}).map(([k, v]) => [k, v])),
    cursorPos: c.options.cursorPos ?? [0, 0], scriptResult: c.options.scriptResult ?? 0,
    textChangedResult: c.options.textChangedResult ?? 0, editActivatedResult: c.options.editActivatedResult ?? 0,
    textureVtables: [textureVtable], canvasTable, renderTable}});
}
const oracle = JSON.parse(execFileSync(PYTHON, [path.join(ROOT, 'scripts', 'native-text-layout-oracle.py'), gameDirectory()], {
  input: JSON.stringify({cases: prepared.map(p => p.request)}), encoding: 'utf8', maxBuffer: 1 << 30}));
assert.equal(oracle.extensionBase, 0x12000000);

function firstDiff(got, expected, where = '$') {
  if (Object.is(got, expected)) return null;
  if (typeof got === 'string' && typeof expected === 'string' && /^[0-9a-f]*$/.test(got) && got.length === expected.length) {
    let i = 0; while (got[i] === expected[i]) i++;
    const at = i >> 1 & ~3;
    return {where: `${where}[+0x${at.toString(16)}]`, got: got.slice(at * 2, at * 2 + 16), expected: expected.slice(at * 2, at * 2 + 16)};
  }
  if (typeof got !== 'object' || typeof expected !== 'object' || !got || !expected) return {where, got, expected};
  for (const key of new Set([...Object.keys(got), ...Object.keys(expected)])) {
    const d = firstDiff(got[key], expected[key], `${where}.${key}`);
    if (d) return d;
  }
  return null;
}
const failures = [];
const report = [];
for (const {c, win, js} of prepared) {
  const o = oracle.cases[c.name];
  if (o.error || js.error) { failures.push(`${c.name}: ${o.error ? `oracle ${o.error}` : `js ${js.error}`}`); continue; }
  const image = Buffer.from(o.image, 'base64'), blocks = new Map(Object.entries(o.blocks).map(([a, b]) => [Number(a), Buffer.from(b, 'base64')]));
  const read = at => {
    if (at >= IMAGE_BASE && at < IMAGE_BASE + image.length) return image[at - IMAGE_BASE];
    for (const [base, data] of blocks) if (at >= base && at < base + data.length) return data[at - base];
    throw new Error(`oracle read outside the image and blocks: 0x${at.toString(16)}`);
  };
  const oracleEvents = o.events.map(e => e.op === 'ProcessScript' && e.event === 'CursorRequested' ? {...e, args: [...e.args.slice(0, 6), 'shadow']} : e);
  const expected = {events: oracleEvents, state: dump(read, win, c.family)};
  const got = {events: js.events, state: js.state};
  if (js.eax !== undefined) { expected.eax = o.eax; got.eax = js.eax >>> 0; }
  if (js.cells) { expected.cells = o.cells.slice(0, js.cells.length); got.cells = js.cells.map(v => v >>> 0); }
  const diff = firstDiff(got, expected);
  if (diff) failures.push(`${c.name}: ${diff.where} js=${JSON.stringify(diff.got)?.slice(0, 300)} oracle=${JSON.stringify(diff.expected)?.slice(0, 300)}`
    + (process.env.TEXT_LAYOUT_EVENTS && diff.where.startsWith('$.events') ? `\n  js ${JSON.stringify(got.events)}\n  or ${JSON.stringify(expected.events)}` : ''));
  else report.push(c.name);
}
console.log(`Text layout diff: ${report.length}/${prepared.length} cases identical`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
