/** Differential check of the XListWindow family against Extension.dll
 * (scripts/native-listwindow-family-oracle.py).
 *
 * Each case builds its own world in a fresh window-host native heap — a list
 * window with rows and columns, two parents, fonts with varied glyph metrics,
 * textures, the window's own and global GCs, canvas and render interface —
 * prepares the list through the JavaScript translation, serialises the heap
 * image and its live block sizes, then runs one native (the registered exec
 * body, its parameters decoded through GNatives as the VM hands them over,
 * skipped optional parameters as EX_Nothing) or one XListWindow virtual in
 * JavaScript and in the oracle, and compares a canonical dump: every window
 * dword, each row node with its fields and strings, each column with its
 * title/format strings, the hot-key and delimiter strings, the GC image, the
 * allocator stream (in-call blocks labelled by allocation order), every host
 * event (script events, reconfigure/show-area/selectability, sounds, the
 * selection and activation virtuals, DrawTile/glyph blocks, texture
 * Lock/Unlock), the result slot and the out cells. Draw runs at the render
 * pass's x87 control word 0x007f, everything else at 0x037f.
 *
 * A mutation table then replays every case with a deliberately wrong copy of
 * script-window-list.mjs (the preparation keeps the clean module) and requires
 * each mutant to diverge from the stored oracle results.
 * docs/script-window-list-family.md. */
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import {writeFontImage, UFONT, FONT_PAGE} from '../src/runtime/script-font-model.mjs';
import {GC} from '../src/runtime/script-gc-state-model.mjs';
import {gcSetTextColor} from '../src/runtime/script-gc-set-text-color.mjs';
import {gcSetTileColor} from '../src/runtime/script-gc-set-tile-color.mjs';
import {gcPushGC} from '../src/runtime/script-gc-push-gc.mjs';
import {gcPopGC} from '../src/runtime/script-gc-pop-gc.mjs';
import {gcCopyGC} from '../src/runtime/script-gc-copy-gc.mjs';
import {gcGetTextExtent} from '../src/runtime/script-gc-get-text-extent.mjs';
import {listMemory} from '../src/runtime/script-window-list-model.mjs';
import * as CLEAN from '../src/runtime/script-window-list.mjs';
import * as SCALE from '../src/runtime/script-window-scale-draw.mjs';
import {refValue} from '../src/runtime/script-vm.mjs';
import {loadExtensionNatives, encodeParam} from './native-exec-diff-lib.mjs';
import {gameDirectory} from './game-directory.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.NATIVE_PROBE_PYTHON || path.join(ROOT, '.cache/native-probe-env/bin/python');
const bitsView = new DataView(new ArrayBuffer(4));
const bits = v => (bitsView.setFloat32(0, v, true), bitsView.getUint32(0, true));
const fromBits = b => (bitsView.setUint32(0, b >>> 0, true), bitsView.getFloat32(0, true));
const IMAGE_BASE = 0x21000000;
const f = Math.fround;

// ---------------------------------------------------------------------------
// One world per case: deterministic addresses, so a mutant replays the same image.
// ---------------------------------------------------------------------------
function makeWorld() {
  const heap = createNativeHeap({capacity: 1 << 21});
  const mem = heap.mem;
  const W = {
    heap,
    u8: (o, off) => heap.read(o, off, 'u8'), u16: (o, off) => heap.read(o, off, 'u16'),
    u32: (o, off) => heap.read(o, off, 'u32'), i32: (o, off) => heap.read(o, off, 'i32'),
    f32: (o, off) => heap.read(o, off, 'f32'), ptr: (o, off) => heap.read(o, off, 'ptr'),
    setU8: (o, off, v) => heap.write(o, off, 'u8', v & 0xff), setU32: (o, off, v) => heap.write(o, off, 'u32', v >>> 0),
    setI32: (o, off, v) => heap.write(o, off, 'i32', v | 0), setF32: (o, off, v) => heap.write(o, off, 'f32', f(v)),
    setPtr: (o, off, v) => heap.write(o, off, 'ptr', v),
    addressOf: v => heap.addressOf(v),
    boundary: message => { throw new Error(message); },
  };
  const w = {heap, mem, W, events: [], current: {}, recording: false, tracked: [], allocCount: 0};
  const record = event => { if (w.recording) w.events.push(event); };
  const address = v => (v ? heap.addressOf(v) : 0);
  w.record = record; w.address = address;
  // In-call allocations, labelled by allocation order like the oracle's GMalloc.
  // A freed range the JS heap reuses belongs to the live block (the oracle never reuses).
  w.canon = ptr => {
    ptr >>>= 0;
    if (!ptr) return 0;
    for (const live of [true, false])
      for (const block of w.tracked)
        if (block.live === live && block.base <= ptr && ptr < block.base + Math.max(block.size, 4)) {
          const name = block.label + (block.live ? '' : '!');
          return ptr === block.base ? name : `${name}+${(ptr - block.base).toString(16)}`;
        }
    return ptr;
  };
  const label = (at, size) => { if (!w.recording) return undefined; const block = {label: `h${w.allocCount++}`, base: at, size, live: true}; w.tracked.push(block); return block.label; };
  const retire = at => { for (const block of w.tracked) if (block.live && block.base === at >>> 0) block.live = false; };
  const readWString = at => { let s = ''; for (;; at += 2) { const u = mem.read(at, 'u16'); if (!u) return s; s += String.fromCharCode(u); } };
  const listMem = {...mem,
    emptyWString: mem.allocRaw(4), sortList: mem.allocRaw(0x400), sortCount: mem.allocRaw(4),
    glyphMiss: mem.allocRaw(0x10), glyphScratch: mem.allocRaw(4),
    alloc(size, tag) { const at = mem.allocRaw(size); record({op: 'Malloc', size, tag, block: label(at, size)}); return at; },
    realloc(old, size, tag) {
      old >>>= 0;
      if (!old && !size) return 0;                                     // Realloc(NULL, 0): no effect
      const at = heap.realloc(old, size);
      if (old) retire(old);
      const from = w.canon(old);                                       // labelled after the free, like the probe
      record({op: 'Realloc', old: from, size, tag, block: at ? label(at, size) : 0});
      return at;
    },
    free(at) { record({op: 'Free', block: w.canon(at)}); mem.free(at); retire(at); },
    readString: readWString,
    allocString(text) { const at = mem.allocRaw((text.length + 1) * 2); for (let i = 0; i < text.length; i++) mem.write(at + 2 * i, 'u16', text.charCodeAt(i)); mem.write(at + 2 * text.length, 'u16', 0); return at; },
  };
  // Render boundary (texture Lock/Unlock +0x54/+0x58, canvas DrawTile +0x5c,
  // render-interface glyph DrawTile +0x7c hold host slot ids; the oracle
  // patches the same words with its stubs).
  const textureVtable = mem.allocRaw(0x80); mem.write(textureVtable + 0x54, 'u32', 1); mem.write(textureVtable + 0x58, 'u32', 2);
  const canvas = {name: 'Canvas'}; heap.allocate(canvas, 0x80);
  const sceneNode = mem.allocRaw(0x40), viewport = mem.allocRaw(0xc0), renderInterface = mem.allocRaw(4);
  const renderTable = mem.allocRaw(0x100), canvasTable = mem.allocRaw(0x60);
  W.setU32(canvas, 0, canvasTable); mem.write(canvasTable + 0x5c, 'u32', 4);
  W.setU32(canvas, 0x78, viewport); W.setU32(canvas, 0x7c, sceneNode); W.setF32(canvas, 0x4c, 0.5);
  mem.write(sceneNode, 'u32', viewport); mem.write(viewport + 0x64, 'u32', renderInterface);
  mem.write(viewport + 0xb0, 'u32', 0x11); mem.write(viewport + 0xb4, 'u32', 0x22);
  mem.write(renderInterface, 'u32', renderTable); mem.write(renderTable + 0x7c, 'u32', 3);
  Object.assign(w, {textureVtable, canvasTable, renderTable});
  const texCache = {records: Array.from({length: 5}, () => mem.allocRaw(0x84)), static: mem.allocRaw(0x84), head: 0, count: 0};
  const recordLabel = at => at === texCache.static ? 'recStatic' : texCache.records.includes(at) ? `rec${texCache.records.indexOf(at)}` : at;
  const coords = c => [c.x, c.y, c.xl, c.yl, c.u, c.v, c.ul, c.vl];
  const noAllocation = () => { throw new Error('PushGC reached UObject allocation: prepare the GC free list'); };
  const gcServices = {mem, objectAddress: o => o.base ?? heap.addressOf(o), texCache, allocateObject: noAllocation, constructUObject: () => {},
    callVirtual(slot, object, command) {
      const self = address(object) || object;
      if (slot === 1) { record({op: 'TextureLock', texture: self, record: recordLabel(command.record), b0: command.b0, b4: command.b4, arg3: command.arg3, ri: command.ri}); mem.write(command.record, 'u32', self); return; }
      if (slot === 2) { record({op: 'TextureUnlock', texture: self, record: recordLabel(command.record)}); return; }
      if (slot === 3) { record({op: 'DrawGlyphTile', ri: self, node: command.node, record: recordLabel(command.record), texture: mem.read(command.record, 'u32'), coords: coords(command), span: command.spanBuffer, z: command.z, color: [...command.color], fog: [...command.fog], polyFlags: command.polyFlags}); return; }
      if (slot === 4) { record({op: 'DrawTile', canvas: self, texture: command.texture, coords: coords(command), span: command.spanBuffer, z: command.z, color: [...command.color], fog: [...command.fog], polyFlags: command.polyFlags}); return; }
      throw new Error(`unknown render slot ${slot}`);
    }};
  let textures = 0;
  const makeTexture = (width, height) => {
    const texture = {name: `Texture${textures++}`};
    heap.allocate(texture, 0x60);
    W.setU32(texture, 0, textureVtable); W.setI32(texture, 0x34, width); W.setI32(texture, 0x38, height);
    return texture;
  };
  // Two fonts: printable glyphs with widths 3..9 (wider when bold) and heights
  // from 9 or 12; the space's height sets the row height. Each is an object
  // image so GetColumnFont's result resolves.
  const makeFont = (boldness, height) => {
    const chars = Array.from({length: 0x100}, (_, c) => c < 0x20 ? [0, 0, 0, 0]
      : [(c * 7) % 200, (c * 3) % 50, 3 + ((c * 5 + boldness) % 7), c === 0x20 ? height : height + ((c + boldness) % 4)]);
    const image = writeFontImage(mem, {charsPerPage: 0x100, pageCount: 1, pages: [{chars}]});
    const font = {name: `Font${boldness}`};
    heap.allocate(font, UFONT.objectSize);
    heap.copyBytes(heap.addressOf(font), image, UFONT.objectSize);
    mem.write(mem.read(heap.addressOf(font) + UFONT.pages, 'u32') + FONT_PAGE.texture, 'u32', heap.addressOf(makeTexture(256, 64)));
    return font;
  };
  w.fontObjects = [makeFont(0, 9), makeFont(2, 12)];
  w.fonts = w.fontObjects.map(font => heap.addressOf(font));
  w.highlight = makeTexture(8, 8); w.focusTexture = makeTexture(4, 4);
  w.sounds = [1, 2, 3].map(i => { const sound = {name: `Sound${i}`}; heap.allocate(sound, 0x40); return sound; });
  w.client = {name: 'ClientObject'}; heap.allocate(w.client, 0x40);
  w.makeGc = (spec = {}) => {
    const gc = {name: 'GC'};
    heap.allocate(gc, GC.size);
    W.setU32(gc, GC.vtable, 0x100598dc);
    W.setU32(gc, GC.canvas, heap.addressOf(canvas));
    for (const [off, v] of [[GC.originX, spec.originX ?? 10], [GC.originY, spec.originY ?? 20], [GC.clipX, 0], [GC.clipY, 0],
      [GC.clipWidth, spec.clipWidth ?? 400], [GC.clipHeight, spec.clipHeight ?? 300]]) W.setF32(gc, off, v);
    W.setU8(gc, GC.style, 1);
    W.setU32(gc, GC.flags, 2);
    W.setU32(gc, GC.polyFlags, 0x800); W.setU32(gc, GC.textPolyFlags, 0x804);
    gcSetTileColor(gc, 0x80ff4020, gcServices); gcSetTextColor(gc, 0x40c0e0a0, gcServices);
    W.setU32(gc, GC.normalFont, w.fonts[0]); W.setU32(gc, GC.boldFont, w.fonts[1]);
    W.setI32(gc, 0x9c, 1); W.setI32(gc, 0xa0, 1);
    // A free list of saved nodes, so PushGC never reaches UObject allocation.
    gcServices.allocateObject = () => mem.allocRaw(GC.size);
    for (let i = 0; i < 4; i++) gcPushGC(gc, gcServices);
    for (let i = 0; i < 4; i++) gcPopGC(gc, -1, gcServices);
    gcServices.allocateObject = noAllocation;
    return gc;
  };
  const encodeArgs = (event, args) => {
    if (event === 'KeyPressed') return [String(args[0])];
    const floats = ['MouseMoved', 'MouseButtonPressed', 'MouseButtonReleased'].includes(event) ? 2 : 0;
    return args.map((v, i) => i < floats ? bits(v) : typeof v === 'boolean' ? Number(v)
      : typeof v === 'number' ? ((event.startsWith('Mouse') && i === 2) || (event === 'VirtualKeyPressed' && i === 0) ? v & 0xff : v >>> 0) : address(v));
  };
  const listServices = {mem: listMem, objectAddress: win => heap.addressOf(win),
    acquireContext: win => address(W.gc.get(win)),
    releaseContext: (win, _base, gc) => W.gc.release(win, gc ? heap.objectAt(gc) : null),
    measureString(_win, gc, outW, outH, text) {
      const extent = gcGetTextExtent({base: gc}, 0, readWString(text), gcServices);
      mem.write(outW, 'f32', extent.xExtent); mem.write(outH, 'f32', extent.yExtent);
    },
    askParentForReconfigure: (_win, base) => record({op: 'AskParentForReconfigure', object: w.canon(base)}),
    selectionChanged(_win, receiver, base, count, focus) {
      record({op: 'ListSelectionChanged', receiver: w.canon(receiver), list: w.canon(base), count: count >>> 0, focus: w.canon(focus)});
      return w.current.selectionResults?.[receiver] ?? 0;
    },
    isBlock: at => heap.blockSize(at) !== undefined,
    scratchString: mem.allocRaw(12),
  };
  W.gc = {services: gcServices,
    get(win) { const gc = W.ptr(win, 0x134); if (gc) { gcPushGC(gc, gcServices); gcCopyGC(gc, address(W.ptr(win, 0x130)), gcServices); } return gc; },
    release(_win, gc) { if (gc) gcPopGC(gc, -1, gcServices); }};
  w.env = {
    L: win => listMemory(win, listServices), listServices,
    windowInit: (_win, parent) => record({op: 'XWindow::Init', parent: w.canon(address(parent))}),
    setSelectability: (_win, value) => record({op: 'SetSelectability', value: value >>> 0}),
    askParentToShowArea: (_win, x, y, width, height) => record({op: 'AskParentToShowArea', area: [x, y, width, height].map(bits)}),
    playSound: (_win, sound, volume, pitch, x, y) => record({op: 'PlaySound', args: x === undefined
      ? [w.canon(sound), bits(volume), bits(pitch)] : [w.canon(sound), bits(volume), bits(pitch), bits(x), bits(y)]}),
    processScript(win, event, args = [], options = {}) {
      record({op: 'ProcessScript', event, window: w.canon(address(win)), args: encodeArgs(event, args)});
      return options.result === undefined ? undefined : w.current.scriptResult ?? 0;
    },
    listRowActivated(receiver, list, row) {
      record({op: 'ListRowActivated', receiver: w.canon(address(receiver)), list: w.canon(address(list)), row: w.canon(row)});
      return w.current.activateResults?.[address(receiver)] ?? 0;
    },
    isKeyDown: (_win, key) => w.current.keys?.[key] ?? 0,
    tickOffset: () => fromBits(w.current.tickOffset ?? 0),
    getCursorPos: () => ({x: fromBits(w.current.cursorPos[0]), y: fromBits(w.current.cursorPos[1])}),
    mouseMoved: (win, x, y) => record({op: 'MouseMoved', window: w.canon(address(win)), args: [bits(x), bits(y)]}),
    isFocusWindow: () => Boolean(w.current.isFocus),
    windowDraw: (_win, gc) => record({op: 'DrawWindow', gc: w.canon(address(gc))}),
  };
  w.parents = [0, 1].map(i => { const p = {name: `Parent${i}`}; heap.allocate(p, 0x300); return p; });
  W.setPtr(w.parents[0], 0x138, w.parents[1]);
  w.gGc = w.makeGc();
  w.rowOf = (win, i) => mem.read(W.u32(win, 0x170) + 4 * i, 'u32');
  w.constructPart = win => { record({op: 'UObject::UObject', object: w.canon(address(win))}); W.setU32(win, 0, 0x10059888); for (let o = 0xd4; o <= 0xe8; o += 4) W.setU32(win, o, 0); };
  w.nativeJs = (M, win, index, args) => {
    const call = {index, receiver: win, argumentCount: args.length, evaluateArgument: i => args[i]};
    const result = M.dispatchListWindowNative(W, call, w.env, refValue);
    if (!result.handled) throw new Error(`native ${index} not handled`);
    return result.value;
  };
  w.resolve = (win, a) => typeof a === 'function' ? a(w, win) : typeof a === 'string' && a.startsWith('$row') ? w.rowOf(win, Number(a.slice(4))) : a;
  w.makeList = (M, spec = {}) => {
    const win = {name: 'List'};
    heap.allocate(win, 0x300);
    M.constructListWindow(W, win, w.constructPart);
    W.setU32(win, 0x30, spec.visible === false ? 0 : 1);
    for (let i = 0; i < 4; i++) W.setU8(win, 0x3d + i, [0x11, 0x22, 0x33, 0x44][i]);
    W.setU32(win, 0x54, w.fonts[spec.font ?? 0]);
    W.setF32(win, 0x80, spec.width ?? 200); W.setF32(win, 0x84, spec.height ?? 120);
    (spec.clip ?? [0, 0, 0, 0, spec.width ?? 200, spec.height ?? 120]).forEach((v, i) => W.setF32(win, 0xd4 + 4 * i, v));
    W.setPtr(win, 0x130, w.gGc);
    W.setPtr(win, 0x134, w.makeGc());
    W.setPtr(win, 0x138, w.parents[0]);
    for (const p of w.parents) W.setU32(p, 0x30, spec.parentHidden ? 0 : 1);
    if (!spec.raw) M.initListWindow(W, win, w.parents[0], w.env);
    for (const [index, ...args] of spec.prep ?? []) w.nativeJs(M, win, index, args.map(a => w.resolve(win, a)));
    spec.after?.(win, w);
    return win;
  };
  // A scale window image with the members XScaleWindow::Draw reads.
  w.makeScale = spec => {
    const win = {name: 'Scale'};
    heap.allocate(win, 0x300);
    W.setU32(win, 0, 0x1005bab4);
    const t = () => makeTexture(16, 16);
    W.setU8(win, 0x14c, spec.vertical ? 1 : 0);
    W.setPtr(win, 0x150, spec.noScaleTexture ? null : t()); W.setPtr(win, 0x154, t());
    W.setPtr(win, 0x158, spec.ticks ? t() : null);
    W.setPtr(win, 0x15c, spec.caps ? t() : null); W.setPtr(win, 0x160, spec.caps ? t() : null);
    W.setU32(win, 0x164, spec.flags ?? 0);
    W.setPtr(win, 0x168, spec.borderPattern ? t() : null);
    W.setF32(win, 0x16c, spec.scaleBorder ?? 0); W.setF32(win, 0x170, spec.thumbBorder ?? 0);
    W.setU32(win, 0x174, 0x11223344); W.setU32(win, 0x178, 0x55667788);
    W.setU8(win, 0x17c, 2); W.setU8(win, 0x17d, 3); W.setU8(win, 0x17e, 4);
    [0x8090a0b0, 0xc0d0e0f0, 0x01020304].forEach((c, i) => { for (let b = 0; b < 4; b++) W.setU8(win, 0x17f + 4 * i + b, (c >>> (8 * b)) & 255); });
    W.setI32(win, 0x1c4, spec.numTicks ?? 10); W.setI32(win, 0x1cc, spec.span ?? 1);
    (spec.geometry ?? []).forEach((v, i) => W.setF32(win, 0x200 + 4 * i, v));
    W.setF32(win, 0x250, spec.start ?? 2); W.setF32(win, 0x254, spec.end ?? 150);
    return win;
  };
  return w;
}

// ---------------------------------------------------------------------------
// Canonical dump over a byte reader (JS heap or oracle image + blocks).
// ---------------------------------------------------------------------------
function dump(read, canonOf, base, gcBase, kind = 'list') {
  const u32 = at => (read(at) | read(at + 1) << 8 | read(at + 2) << 16 | read(at + 3) << 24) >>> 0;
  const i32 = at => u32(at) | 0;
  const text = (data, num) => { let s = ''; for (let i = 0; i < num; i++) { const u = read(data + 2 * i) | read(data + 2 * i + 1) << 8; if (!u) break; s += String.fromCharCode(u); } return s; };
  const str = at => { const data = u32(at), num = i32(at + 4); return {data: canonOf(data), num, max: i32(at + 8), text: data && num > 0 ? text(data, num) : null}; };
  const window = [];
  for (let o = 4; o < (kind === 'scale' ? 0x270 : 0x1d0); o += 4) window.push(canonOf(u32(base + o)));
  if (kind === 'scale') {
    const out = {window};
    if (gcBase) { const words = []; for (let o = 4; o < GC.size; o += 4) words.push(canonOf(u32(gcBase + o))); out.gc = words; }
    return out;
  }
  const rows = [], rdata = u32(base + 0x170), rnum = i32(base + 0x174);
  for (let i = 0; i < rnum && rdata; i++) {
    const node = u32(rdata + 4 * i);
    if (!node) { rows.push(null); continue; }
    const fdata = u32(node + 8), fnum = i32(node + 12), fields = [];
    for (let j = 0; j < fnum && fdata; j++) {
      const at = fdata + 0x18 * j;
      fields.push({...str(at), value: u32(at + 0xc), width: u32(at + 0x10), height: u32(at + 0x14)});
    }
    rows.push({node: canonOf(node), id: i32(node), flags: u32(node + 4), fieldsData: canonOf(fdata), fieldsMax: i32(node + 16), client: canonOf(u32(node + 0x14)), fields});
  }
  const cols = [], cdata = u32(base + 0x17c), cnum = i32(base + 0x180);
  for (let i = 0; i < cnum && cdata; i++) {
    const at = cdata + 0x38 * i, words = [];
    for (let o = 0; o < 0x38; o += 4) words.push(o === 4 || o === 0x2c ? 'str' : canonOf(u32(at + o)));
    cols.push({words, title: str(at + 4), format: str(at + 0x2c)});
  }
  const out = {window, rows, cols, delimiter: str(base + 0x14c), hotKey: str(base + 0x1c0)};
  if (gcBase) { const words = []; for (let o = 4; o < GC.size; o += 4) words.push(canonOf(u32(gcBase + o))); out.gc = words; }
  return out;
}

// ---------------------------------------------------------------------------
// Cases. Tokens: '$rowN' is row N of the prepared list, a function (w, win)
// resolves a world object, undefined (S) is a skipped optional parameter.
// ---------------------------------------------------------------------------
const cases = [];
const native = (name, spec, index, args, options = {}) => cases.push({name, spec, native: index, args, options});
const method = (name, spec, which, args = [], options = {}) => cases.push({name, spec, method: which, args, options});
const C = (r, g, b, a = 0) => ({'core.object.color.r': r, 'core.object.color.g': g, 'core.object.color.b': b, 'core.object.color.a': a});
const S = undefined;
const font1 = w => w.fontObjects[1], font0 = w => w.fontObjects[0];
const sound = i => w => w.sounds[i];
const highlightTexture = w => w.highlight, focusTex = w => w.focusTexture, client = w => w.client, drawGc = w => w.drawGc;
const outCell = () => ({reference: true, value: undefined, set(v) { this.value = v; }});

const twoCols = [[1760, 2]];
const rowsABC = [...twoCols, [1730, 'beta;20'], [1730, 'Alpha;3'], [1730, 'gamma;100'], [1730, 'Delta;7']];
const sorted = [...twoCols, [1780, 0], [1790, true], [1730, 'mike;1'], [1730, 'alpha;2'], [1730, 'zulu;3'], [1730, 'Kilo;4']];
const numeric = [...twoCols, [1775, 1, 1], [1730, 'a;12.5'], [1730, 'b;0x1f'], [1730, 'c;-3'], [1730, 'd;1:30']];
// Init leaves multi-select on (flags |= 6); the persona lists turn it off.
const multi = rowsABC, single = [...rowsABC, [1794, false]];
const persona = [[1794, false], [1760, 0], [1760, 1], [1805, highlightTexture], [1807, focusTex], [1806, C(40, 80, 120)], [1808, C(200, 100, 50)], [1804, C(255, 255, 255)], [1811, sound(0), sound(1)]];

// Construction and lifecycle.
method('construct', {raw: true, after: (win, w) => { for (let o = 4; o < 0x1d0; o += 4) w.W.setU32(win, o, 0); }}, 'construct');
method('init', {raw: true}, 'init', [w => w.parents[0]]);
method('cleanUp populated', {prep: [...rowsABC, [1765, 0, 'Name'], [1775, 1, 1, '%5.1f'], [1785, true], [1786, 0], [1755, '$row1']]}, 'cleanUp');
method('cleanUp empty', {}, 'cleanUp');
method('destruct after cleanUp', {prep: rowsABC, after: (win, w) => CLEAN.cleanUpListWindow(w.env.L(win))}, 'destruct');
method('destruct populated', {prep: [...rowsABC, [1765, 1, 'Value']]}, 'destruct');

// Rows.
for (const [tag, prep] of [['plain', rowsABC], ['sorted', sorted], ['numeric', numeric]]) {
  native(`AddRow ${tag}`, {prep}, 1730, ['Echo;55', 9]);
  native(`AddRow ${tag} skip client`, {prep}, 1730, ['Echo;55', S]);
  native(`AddRow ${tag} empty`, {prep}, 1730, ['', S]);
  native(`AddRow ${tag} wide`, {prep}, 1730, ['a much longer first column value;and the second', 1]);
}
native('AddRow first row', {}, 1730, ['only', S]);
native('AddRow auto-expand off', {prep: [...twoCols, [1792, false], [1730, 'x;y']]}, 1730, ['wider text here;z', S]);
native('AddRow reverse case sort', {prep: [...twoCols, [1780, 0, true, true], [1790, true], [1730, 'b;1'], [1730, 'B;2']]}, 1730, ['a;3', S]);
for (const [i, tag] of [[0, 'first'], [2, 'middle'], [3, 'last']])
  native(`DeleteRow ${tag}`, {prep: rowsABC}, 1731, [`$row${i}`]);
native('DeleteRow selected focus', {prep: [...rowsABC, [1751, '$row1']]}, 1731, ['$row1']);
native('DeleteRow anchor', {prep: [...multi, [1751, '$row0'], [1755, '$row2', S, false]]}, 1731, ['$row0']);
native('DeleteRow none', {prep: rowsABC}, 1731, [0]);
native('ModifyRow plain', {prep: rowsABC}, 1732, ['$row1', 'Renamed and longer;8']);
native('ModifyRow sorted moves', {prep: sorted}, 1732, ['$row0', 'aaa;9']);
native('ModifyRow sorted to end', {prep: sorted}, 1732, ['$row1', 'zzzz;9']);
native('ModifyRow sorted out of order', {prep: sorted}, 1732, ['$row2', 'a;9']);
native('ModifyRow none', {prep: rowsABC}, 1732, [0, 'x']);
native('DeleteAllRows selected', {prep: [...rowsABC, [1751, '$row2']]}, 1733, []);
native('DeleteAllRows empty', {}, 1733, []);
for (const [c, tag] of [[0, 'text'], [1, 'numeric'], [5, 'invalid'], [-1, 'negative']]) {
  native(`SetField ${tag}`, {prep: numeric}, 1734, ['$row1', c, '42.25 wide text']);
  native(`SetFieldValue ${tag}`, {prep: numeric}, 1736, ['$row2', c, 3.75]);
  native(`GetField ${tag}`, {prep: numeric}, 1735, ['$row0', c], {resultString: true});
  native(`GetFieldValue ${tag}`, {prep: numeric}, 1737, ['$row0', c]);
}
native('SetField sorted moves', {prep: sorted}, 1734, ['$row3', 0, 'aardvark']);
native('SetField no row', {prep: numeric}, 1734, [0, 0, 'x']);
native('GetField empty field', {prep: [...twoCols, [1730, 'only']]}, 1735, ['$row0', 1], {resultString: true});
for (const i of [0, 3, 4, -1]) native(`IndexToRowId ${i}`, {prep: rowsABC}, 1720, [i]);
native('RowIdToIndex', {prep: rowsABC}, 1721, ['$row2']);
native('RowIdToIndex none', {prep: rowsABC}, 1721, [0]);
native('SetRowClientInt', {prep: rowsABC}, 1722, ['$row1', -77]);
native('GetRowClientInt', {prep: [...rowsABC, [1722, '$row1', 31]]}, 1723, ['$row1']);
native('SetRowClientObject', {prep: rowsABC}, 1724, ['$row2', client]);
native('GetRowClientObject', {prep: [...rowsABC, [1724, '$row0', client]]}, 1725, ['$row0']);
native('GetNumRows', {prep: rowsABC}, 1740, []);
native('GetNumSelectedRows', {prep: [...multi, [1742, '$row0'], [1742, '$row2']]}, 1741, []);

// Selection and focus.
for (const [tag, prep] of [['single', single], ['multi', multi]]) {
  native(`SelectRow ${tag}`, {prep: [...prep, [1742, '$row0']]}, 1742, ['$row2', true]);
  native(`SelectRow ${tag} skip`, {prep: [...prep, [1742, '$row0']]}, 1742, ['$row1', S]);
  native(`SelectRow ${tag} off`, {prep: [...prep, [1742, '$row0']]}, 1742, ['$row0', false]);
  native(`SelectRow ${tag} same`, {prep: [...prep, [1742, '$row0']]}, 1742, ['$row0', true]);
  native(`SelectAllRows ${tag}`, {prep}, 1743, [S]);
  native(`SelectAllRows ${tag} off`, {prep: [...prep, [1742, '$row1']]}, 1743, [false]);
  native(`ToggleRowSelection ${tag}`, {prep: [...prep, [1742, '$row1']]}, 1745, ['$row1']);
  native(`ToggleRowSelection ${tag} on`, {prep: [...prep, [1742, '$row1']]}, 1745, ['$row3']);
  for (const [args, kind] of [[['$row3', S, S, S], 'defaults'], [['$row3', false, false, true], 'span'], [['$row2', false, true, false], 'invert'], [['$row0', true, false, true], 'clear span']])
    native(`SelectToRow ${tag} ${kind}`, {prep: [...prep, [1755, '$row1']]}, 1744, args);
  for (const move of [0, 1, 2, 3, 4, 5, 6])
    native(`MoveRow ${tag} ${move}`, {prep: [...prep, [1751, '$row1']]}, 1750, [move, S, S, S]);
  native(`MoveRow ${tag} drag`, {prep: [...prep, [1751, '$row0']]}, 1750, [1, true, false, true]);
  native(`MoveRow ${tag} no focus`, {prep}, 1750, [0, S, S, S]);
  native(`SetRow ${tag}`, {prep: [...prep, [1751, '$row0']]}, 1751, ['$row2', S, S, S]);
  native(`SetRow ${tag} drag keep`, {prep: [...prep, [1751, '$row0']]}, 1751, ['$row3', true, false, true]);
  native(`GetSelectedRow ${tag}`, {prep: [...prep, [1742, '$row2']]}, 1747, []);
}
native('MoveRow empty', {}, 1750, [1, S, S, S]);
native('MoveRow page down', {prep: [...rowsABC, [1730, 'e;1'], [1730, 'f;1'], [1730, 'g;1'], [1730, 'h;1'], [1751, '$row0']], height: 25, clip: [0, 0, 0, 0, 200, 25]}, 1750, [3, S, S, S]);
native('SetRow none', {prep: rowsABC}, 1751, [0, S, S, true]);
native('SetFocusRow', {prep: rowsABC}, 1755, ['$row2', S, S]);
native('SetFocusRow no move no anchor', {prep: rowsABC}, 1755, ['$row3', false, false]);
native('SetFocusRow none', {prep: [...rowsABC, [1755, '$row1']]}, 1755, [0, S, S]);
native('GetFocusRow', {prep: [...rowsABC, [1755, '$row1']]}, 1756, []);
native('IsRowSelected', {prep: [...rowsABC, [1742, '$row1']]}, 1746, ['$row1']);
native('IsRowSelected no', {prep: [...rowsABC, [1742, '$row1']]}, 1746, ['$row0']);
native('GetSelectedRow none', {prep: rowsABC}, 1747, []);
native('ShowFocusRow', {prep: [...rowsABC, [1755, '$row3', false]]}, 1810, []);
native('ShowFocusRow none', {prep: rowsABC}, 1810, []);

// Columns.
for (const n of [0, 1, 3, 5]) native(`SetNumColumns ${n}`, {prep: rowsABC}, 1760, [n]);
native('GetNumColumns', {prep: rowsABC}, 1761, []);
native('ResizeColumns', {prep: rowsABC}, 1762, [S]);
native('ResizeColumns expand only', {prep: [...rowsABC, [1767, 0, 300]]}, 1762, [true]);
native('SetColumnTitle', {prep: rowsABC}, 1765, [1, 'Value']);
native('SetColumnTitle invalid', {prep: rowsABC}, 1765, [2, 'x']);
native('GetColumnTitle', {prep: [...rowsABC, [1765, 0, 'Name']]}, 1766, [0], {resultString: true});
native('GetColumnTitle empty', {prep: rowsABC}, 1766, [1], {resultString: true});
native('GetColumnTitle invalid', {prep: rowsABC}, 1766, [4], {resultString: true});
for (const [args, tag] of [[[0, 150], 'wider'], [[1, 1], 'narrower'], [[1, NaN], 'nan'], [[3, 5], 'invalid']])
  native(`SetColumnWidth ${tag}`, {prep: rowsABC}, 1767, args);
native('SetColumnWidth no auto-expand', {prep: [...rowsABC, [1792, false]]}, 1767, [0, 1]);
native('GetColumnWidth', {prep: rowsABC}, 1768, [1]);
native('GetColumnWidth hidden', {prep: [...rowsABC, [1777, 1]]}, 1768, [1]);
native('GetColumnWidth invalid', {prep: rowsABC}, 1768, [9]);
native('SetColumnAlignment', {prep: rowsABC}, 1769, [1, 2]);
native('GetColumnAlignment', {prep: [...rowsABC, [1769, 1, 1]]}, 1770, [1]);
native('GetColumnAlignment invalid', {prep: rowsABC}, 1770, [-3]);
native('SetColumnColor', {prep: rowsABC}, 1771, [0, C(1, 2, 3, 4)]);
native('GetColumnColor', {prep: [...rowsABC, [1771, 1, C(9, 8, 7, 6)]]}, 1772, [1, outCell], {out: [1]});
native('GetColumnColor invalid', {prep: rowsABC}, 1772, [-1, outCell], {out: [1]});
native('SetColumnFont', {prep: rowsABC}, 1773, [1, font1]);
native('SetColumnFont none', {prep: [...rowsABC, [1773, 0, font1]]}, 1773, [0, null]);
native('SetColumnFont same', {prep: rowsABC}, 1773, [0, null]);
native('SetColumnFont no gc', {prep: rowsABC, after: (win, w) => w.W.setPtr(win, 0x134, null)}, 1773, [1, font1]);
native('GetColumnFont', {prep: rowsABC}, 1774, [0]);
native('GetColumnFont invalid', {prep: rowsABC}, 1774, [7]);
for (const [args, tag] of [[[1, 1, S], 'float'], [[1, 2, S], 'time'], [[1, 0, S], 'text'], [[1, 1, '%7.3f'], 'format'], [[4, 1, S], 'invalid']])
  native(`SetColumnType ${tag}`, {prep: rowsABC}, 1775, args);
native('GetColumnType', {prep: numeric}, 1776, [1]);
native('HideColumn', {prep: rowsABC}, 1777, [1, S]);
native('HideColumn show', {prep: [...rowsABC, [1777, 1]]}, 1777, [1, false]);
native('HideColumn same', {prep: rowsABC}, 1777, [0, false]);
native('IsColumnHidden', {prep: [...rowsABC, [1777, 1]]}, 1778, [1]);
native('IsColumnHidden invalid', {prep: rowsABC}, 1778, [2]);

// Sorting.
native('SetSortColumn auto', {prep: [...rowsABC, [1790, true]]}, 1780, [1, true, S]);
native('SetSortColumn manual', {prep: rowsABC}, 1780, [0, S, S]);
native('AddSortColumn', {prep: [...rowsABC, [1780, 1], [1790, true]]}, 1781, [0, S, true]);
native('RemoveSortColumn', {prep: [...rowsABC, [1780, 1], [1781, 0], [1790, true]]}, 1782, [1]);
native('ResetSortColumns', {prep: [...rowsABC, [1780, 1], [1790, true]]}, 1783, [S]);
native('ResetSortColumns off', {prep: [...rowsABC, [1780, 1]]}, 1783, [false]);
native('Sort text', {prep: [...rowsABC, [1780, 0]]}, 1784, []);
native('Sort numeric reverse', {prep: [...numeric, [1780, 1, true]]}, 1784, []);
native('Sort case sensitive', {prep: [...rowsABC, [1780, 0, false, true]]}, 1784, []);
native('EnableAutoSort', {prep: [...rowsABC, [1780, 0]]}, 1790, [S]);
native('EnableAutoSort off', {prep: [...rowsABC, [1790, true]]}, 1790, [false]);
native('IsAutoSortEnabled', {prep: [...rowsABC, [1790, true]]}, 1791, []);
native('EnableAutoExpandColumns off', {prep: rowsABC}, 1792, [false]);
native('EnableAutoExpandColumns on', {prep: [...rowsABC, [1792, false]]}, 1792, [S]);
native('IsAutoExpandColumnsEnabled', {prep: rowsABC}, 1793, []);
native('EnableMultiSelect off', {prep: [...multi, [1742, '$row0'], [1742, '$row1'], [1742, '$row3']]}, 1794, [false]);
native('EnableMultiSelect on', {prep: rowsABC}, 1794, [S]);
native('IsMultiSelectEnabled', {prep: rowsABC}, 1795, []);

// Hot keys, margins, page size, delimiter, colours, textures, sounds.
native('EnableHotKeys off', {prep: rowsABC}, 1785, [false]);
native('EnableHotKeys', {prep: [...rowsABC, [1785, false]]}, 1785, [S]);
native('SetHotKeyColumn', {prep: rowsABC}, 1786, [1]);
native('SetFieldMargins', {prep: rowsABC}, 1800, [5, 2]);
native('SetFieldMargins same', {prep: rowsABC}, 1800, [3, 1]);
native('SetFieldMargins no expand', {prep: [...rowsABC, [1792, false]]}, 1800, [6, 1]);
native('GetFieldMargins', {prep: [...rowsABC, [1800, 4.5, 2.25]]}, 1801, [outCell, outCell], {out: [0, 1]});
native('GetPageSize', {prep: rowsABC, height: 47, clip: [0, 0, 0, 0, 200, 47]}, 1802, []);
native('GetPageSize no rows', {height: 5}, 1802, []);
native('SetDelimiter', {prep: rowsABC}, 1803, ['|tail']);
native('SetDelimiter empty', {prep: rowsABC}, 1803, ['']);
native('SetHighlightTextColor', {}, 1804, [C(10, 20, 30, 40)]);
native('SetHighlightTexture', {}, 1805, [highlightTexture]);
native('SetHighlightColor', {}, 1806, [C(50, 60, 70, 80)]);
native('SetFocusTexture', {}, 1807, [focusTex]);
native('SetFocusColor', {}, 1808, [C(90, 100, 110, 120)]);
native('SetFocusThickness', {}, 1809, [2.5]);
native('SetListSounds', {}, 1811, [sound(0), sound(1)]);
native('SetListSounds skip', {prep: [[1811, sound(0), sound(1)]]}, 1811, [S, S]);
for (const [tag, spec] of [['focus', {prep: [...rowsABC, [1755, '$row2', false]]}], ['clip', {prep: rowsABC, clip: [0, 0, 5, 7, 60, 30]}],
  ['no clip', {prep: rowsABC, clip: [0, 0, 0, 0, 0, 0]}], ['hidden parent', {prep: rowsABC, parentHidden: true}], ['hidden', {prep: rowsABC, visible: false}]])
  native(`PlayListSound ${tag}`, spec, 1812, [sound(2), S, S]);
native('PlayListSound volume', {prep: rowsABC}, 1812, [sound(2), 0.5, 1.5]);

// Virtuals.
method('preferredSize', {prep: rowsABC}, 'preferredSize', [1, {cell: 0, value: bits(-1)}, 0, {cell: 1, value: bits(-1)}]);
method('preferredSize hidden', {prep: [...rowsABC, [1777, 0]]}, 'preferredSize', [0, {cell: 0, value: 0}, 1, {cell: 1, value: 0}]);
method('preferredSize empty', {}, 'preferredSize', [0, {cell: 0, value: 0}, 0, {cell: 1, value: 0}]);
method('granularity', {prep: rowsABC}, 'granularity', [{cell: 0, value: bits(7)}, {cell: 1, value: bits(9)}]);
const drawRows = [[1730, 'first row'], [1730, 'second row is longer'], [1730, 'third'], [1730, ''], [1730, 'fifth']];
method('draw plain', {prep: [...persona, ...drawRows]}, 'draw', [drawGc], {draw: true});
method('draw selected focus', {prep: [...persona, [1794, true], ...drawRows, [1742, '$row1'], [1742, '$row3'], [1755, '$row2', false]]}, 'draw', [drawGc], {draw: true, isFocus: 1});
method('draw focus off screen', {prep: [...persona, ...drawRows, [1751, '$row0']], clip: [0, 0, 0, 30, 200, 20]}, 'draw', [drawGc], {draw: true, isFocus: 1});
method('draw clipped range', {prep: [...persona, ...drawRows], clip: [0, 0, 0, 13.25, 200, 26.5]}, 'draw', [drawGc], {draw: true});
method('draw columns aligned', {prep: [...persona, [1760, 3], [1769, 1, 1], [1769, 2, 2], [1767, 0, 50], [1767, 1, 70], [1767, 2, 60], [1730, 'left;centre;right'], [1730, 'l;c;r'], [1751, '$row1']]}, 'draw', [drawGc], {draw: true, isFocus: 1});
method('draw hidden column', {prep: [...persona, [1760, 3], [1777, 1], [1773, 2, font1], [1730, 'a;hidden;b'], [1730, 'c;hidden;d']]}, 'draw', [drawGc], {draw: true});
method('draw margins', {prep: [...persona, [1800, 7.5, 3.25], ...drawRows]}, 'draw', [drawGc], {draw: true});
method('draw odd line size', {prep: [...persona, [1800, 1.3, 0.7], ...drawRows], clip: [0, 0, 0, 7.1, 200, 33.3]}, 'draw', [drawGc], {draw: true});
// The first visible row is fistp((clipY + 1e-5) / lineSize - 0.5) with
// lineSize 11: one row down hits the bias, row 33 rounds half to even.
method('draw scrolled one row', {prep: [...persona, ...drawRows], clip: [0, 0, 0, 11, 200, 33]}, 'draw', [drawGc], {draw: true});
const manyRows = Array.from({length: 40}, (_, i) => [1730, `row ${i}`]);
method('draw scrolled far', {prep: [...persona, ...manyRows, [1751, '$row33']], clip: [0, 0, 0, 363, 200, 44]}, 'draw', [drawGc], {draw: true, isFocus: 1, gcSpec: {originX: 0, originY: 0, clipWidth: 1000, clipHeight: 1000}});
method('draw empty', {prep: persona}, 'draw', [drawGc], {draw: true, isFocus: 1});
method('draw no line size', {prep: [[1760, 1], [1773, 0, font0], [1800, 0, -4.5]]}, 'draw', [drawGc], {draw: true});
const pressed = [...single, [1811, sound(0), sound(1)]];
for (const [tag, keys] of [['plain', {}], ['shift', {16: 1}], ['ctrl', {17: 1}], ['shift ctrl', {16: 1, 17: 1}]]) {
  method(`mouseButtonPressed ${tag}`, {prep: [...pressed, [1751, '$row0']]}, 'mouseButtonPressed', [5, 25.5, 1, 1], {keys, tickOffset: bits(0.375)});
  method(`mouseButtonPressed multi ${tag}`, {prep: [...pressed, [1794, true], [1751, '$row0']]}, 'mouseButtonPressed', [5, 33, 1, 1], {keys, tickOffset: bits(0.375)});
}
method('mouseButtonPressed below', {prep: pressed}, 'mouseButtonPressed', [5, 500, 1, 1], {tickOffset: bits(1)});
method('mouseButtonPressed above', {prep: pressed}, 'mouseButtonPressed', [5, -9, 1, 1], {tickOffset: bits(1)});
method('mouseButtonPressed right', {prep: pressed}, 'mouseButtonPressed', [5, 12, 2, 1], {scriptResult: 1});
method('mouseButtonPressed empty', {}, 'mouseButtonPressed', [5, 12, 1, 1]);
const dragging = (index, select) => (win, w) => { if (select) w.nativeJs(CLEAN, win, 1751, [w.rowOf(win, 0)]); w.W.setU32(win, 0x1b4, 1); w.W.setI32(win, 0x1b8, index); };
method('mouseMoved dragging', {prep: [...pressed, [1794, true]], after: dragging(0, true)}, 'mouseMoved', [10, 37.5]);
method('mouseMoved same row', {prep: pressed, after: dragging(1)}, 'mouseMoved', [10, 13]);
method('mouseMoved idle', {prep: pressed}, 'mouseMoved', [10, 37.5]);
method('mouseButtonReleased single', {prep: pressed, after: dragging(0)}, 'mouseButtonReleased', [4, 20, 1, 1]);
method('mouseButtonReleased double', {prep: pressed, after: dragging(0)}, 'mouseButtonReleased', [4, 20, 1, 2]);
method('mouseButtonReleased double handled', {prep: pressed}, 'mouseButtonReleased', [4, 20, 1, 2], {activateSelf: true});
method('mouseButtonReleased double outside', {prep: pressed}, 'mouseButtonReleased', [4, 900, 1, 2]);
method('mouseButtonReleased double hidden', {prep: pressed, parentHidden: true}, 'mouseButtonReleased', [4, 20, 1, 3]);
method('mouseButtonReleased right', {prep: pressed}, 'mouseButtonReleased', [4, 20, 2, 2], {scriptResult: 1});
const hotRows = [...rowsABC, [1730, 'Golf;1'], [1730, 'apple;2'], [1730, 'avocado;3']];
for (const [key, tag] of [[0x67, 'g'], [0x41, 'A'], [0x5f, 'underscore'], [0x2e, 'dot'], [0, 'nul']])
  method(`keyPressed ${tag}`, {prep: hotRows}, 'keyPressed', [key]);
method('keyPressed repeat cycles', {prep: [...hotRows, [1751, '$row1']]}, 'keyPressed', [0x61], {hotKey: 'aa'});
method('keyPressed prefix', {prep: hotRows}, 'keyPressed', [0x76], {hotKey: 'a'});
method('keyPressed prefix at focus', {prep: [...hotRows, [1730, 'apricot;4'], [1751, '$row5']]}, 'keyPressed', [0x70], {hotKey: 'a'});
method('keyPressed no match', {prep: rowsABC}, 'keyPressed', [0x71]);
method('keyPressed hot keys off', {prep: [...rowsABC, [1785, false]]}, 'keyPressed', [0x61], {scriptResult: 1});
method('keyPressed bad column', {prep: [...rowsABC, [1786, 5]]}, 'keyPressed', [0x61]);
for (const [key, tag] of [[0x0d, 'enter'], [0x26, 'up'], [0x1b, 'escape'], [0x41, 'a']])
  method(`virtualKeyPressed ${tag}`, {prep: [...pressed, [1751, '$row1']]}, 'virtualKeyPressed', [key, 0], {hotKey: 'be', scriptResult: key === 0x41 ? 1 : 0});
method('visibilityChanged shown', {prep: pressed}, 'visibilityChanged', [1]);
method('visibilityChanged shown focused', {prep: [...pressed, [1755, '$row2']]}, 'visibilityChanged', [1]);
method('visibilityChanged hidden', {prep: pressed}, 'visibilityChanged', [0]);
method('visibilityChanged empty', {}, 'visibilityChanged', [1]);
const delay = (value, drag = true) => (win, w) => { if (drag) w.W.setU32(win, 0x1b4, 1); w.W.setF32(win, 0x1bc, value); };
method('tick drag expires', {prep: pressed, after: delay(0.05)}, 'tick', [bits(0.0625)], {cursorPos: [bits(12), bits(30.5)]});
method('tick drag holds', {prep: pressed, after: delay(0.5)}, 'tick', [bits(0.0625)], {cursorPos: [bits(12), bits(30.5)]});
method('tick drag exact', {prep: pressed, after: delay(0.0625)}, 'tick', [bits(0.0625)], {cursorPos: [bits(1), bits(2)]});
method('tick hot key expires', {prep: pressed}, 'tick', [bits(1.5)], {hotKey: 'ab'});
method('tick hot key holds', {prep: pressed}, 'tick', [bits(0.25)], {hotKey: 'ab'});
method('tick idle', {prep: pressed}, 'tick', [bits(0.25)]);

// ---------------------------------------------------------------------------
// Run one case in a fresh world: `M` is the module for the measured call.
// ---------------------------------------------------------------------------
// XScaleWindow::Draw (the scroll area's scrollbars around an overflowing list).
// Geometry +0x200..+0x24c: scale x/y/w/h, thumb x/y/w/h, tick x/y/w/h, cap1 u/v/w/h, cap2 u/v/w/h.
const scaleGeometry = [0, 0, 15, 160, 1.5, 33.25, 12, 41.75, 2, 3, 9, 4, 0, 0, 12, 5, 1, 2, 12, 6];
const scaleCase = (name, spec) => cases.push({name, scale: spec, method: 'scaleDraw', args: [drawGc], options: {draw: true}});
scaleCase('scale vertical plain', {vertical: true, geometry: scaleGeometry});
scaleCase('scale vertical stretched border caps', {vertical: true, flags: 3, scaleBorder: 2, thumbBorder: 1.5, borderPattern: true, caps: true, geometry: scaleGeometry});
scaleCase('scale horizontal caps ticks', {flags: 0x10, caps: true, ticks: true, numTicks: 6, span: 2, geometry: [3, 1, 170.5, 14, 40.25, 2, 30.5, 11, 0, 2, 4, 9, 0, 0, 5, 11, 1, 1, 6, 11], end: 160.5});
scaleCase('scale vertical ticks from start', {vertical: true, flags: 4, ticks: true, numTicks: 7, geometry: scaleGeometry, start: 1.25, end: 151.75});
scaleCase('scale vertical ticks span odd', {vertical: true, flags: 0x15, ticks: true, numTicks: 9, span: 3, geometry: [0, 0, 15, 160, 1.5, 33.25, 12, 41.75, 2.5, 3, 9, 3.5, 0, 0, 12, 5, 1, 2, 12, 6], start: 0.3, end: 133.7});
scaleCase('scale border swallows track', {vertical: true, scaleBorder: 9, borderPattern: true, caps: true, thumbBorder: 30, geometry: scaleGeometry});
scaleCase('scale no textures', {vertical: true, noScaleTexture: true, geometry: [0, 0, 0, 0, 1, 2, 0, 5]});

const natives = await loadExtensionNatives();
const shapeOf = index => { const n = natives.get(index); if (!n) throw new Error(`native ${index} is not registered`); return n; };
const FLOAT_ARGS = new Set(['mouseButtonPressed', 'mouseMoved', 'mouseButtonReleased']);
function methodJs(M, w, which) {
  const {W, env, record} = w, canon = w.canon, address = w.address;
  const table = {
    construct: win => M.constructListWindow(W, win, w.constructPart),
    destruct: win => { record({op: 'ConditionalDestroy', object: canon(address(win))}); M.destroyListMembers(env.L(win));
      for (let i = 0; i < 2; i++) record({op: 'ConditionalDestroy', object: canon(address(win))}); record({op: 'UObject::~UObject', object: canon(address(win))}); },
    init: (win, parent) => M.initListWindow(W, win, parent, env),
    cleanUp: win => { M.cleanUpListWindow(env.L(win)); record({op: 'XWindow::CleanUp'}); },
    preferredSize: win => { const r = M.listPreferredSize(W, win); return {cells: [bits(r.width), bits(r.height)]}; },
    granularity: win => { let out; M.listGranularity(W, win, (_w, h1, v1) => { record({op: 'ParentRequestedGranularity', h: bits(h1), v: bits(v1)}); out = [bits(h1), bits(v1)]; }); return {cells: out}; },
    draw: (win, gc) => M.listDraw(W, win, gc, env),
    mouseButtonPressed: (win, x, y, button, clicks) => ({eax: M.listMouseButtonPressed(W, win, fromBits(x), fromBits(y), button, clicks, env)}),
    mouseMoved: (win, x, y) => M.listMouseMoved(W, win, fromBits(x), fromBits(y), env),
    mouseButtonReleased: (win, x, y, button, clicks) => ({eax: M.listMouseButtonReleased(W, win, fromBits(x), fromBits(y), button, clicks, env)}),
    keyPressed: (win, key) => ({eax: M.listKeyPressed(W, win, key, env)}),
    virtualKeyPressed: (win, key, repeat) => ({eax: M.listVirtualKeyPressed(W, win, key, repeat, env)}),
    visibilityChanged: (win, visible) => M.listVisibilityChanged(W, win, visible, env),
    tick: (win, delta) => M.listTick(W, win, fromBits(delta), env),
    scaleDraw: (win, gc) => (M.scaleDraw ?? SCALE.scaleDraw)(W, win, gc),
  };
  return table[which];
}
function runCase(c, M) {
  const w = makeWorld(), {heap, W, mem} = w;
  w.current = {...c.options};
  const win = c.scale ? w.makeScale(c.scale) : w.makeList(CLEAN, {...c.spec});
  if (c.options.hotKey) {
    const s = c.options.hotKey, hot = heap.addressOf(win) + 0x1c0, at = heap.realloc(0, (s.length + 1) * 2);
    for (let i = 0; i < s.length; i++) mem.write(at + 2 * i, 'u16', s.charCodeAt(i));
    mem.write(at + 2 * s.length, 'u16', 0);
    mem.write(hot, 'u32', at); mem.write(hot + 4, 'i32', s.length + 1); mem.write(hot + 8, 'i32', s.length + 1); W.setF32(win, 0x1cc, 1);
  }
  if (c.options.activateSelf) w.current.activateResults = {[w.address(win)]: 1};
  if (c.options.draw) w.drawGc = w.makeGc(c.options.gcSpec ?? {originX: 12, originY: 30, clipWidth: 240, clipHeight: 160});
  const args = c.args.map(a => (a === outCell ? outCell() : w.resolve(win, a)));
  const image = Buffer.from(heap.bytes.subarray(0, heap.usedEnd() - IMAGE_BASE)).toString('base64');
  const blocks = heap.blockEntries();
  w.recording = true;
  let request, result = {}, error = null;
  try {
    if (c.native !== undefined) {
      const shape = shapeOf(c.native), params = [];
      shape.params.forEach((p, i) => {
        const v = args[i];
        if (p.out) params.push({out: i});
        else if (v === undefined) params.push({skip: true});
        else if (p.kind === 'StrProperty') params.push({string: String(v)});
        else if (p.kind === 'ObjectProperty' || p.kind === 'ClassProperty') params.push(encodeParam(p, w.address(v)));
        else if (p.kind === 'struct:color') params.push(encodeParam(p, ['r', 'g', 'b', 'a'].map(k => v[`core.object.color.${k}`])));
        else params.push(encodeParam(p, v));
      });
      request = {exec: shape.exec, params, resultString: Boolean(c.options.resultString)};
      const value = w.nativeJs(M, win, c.native, args.slice(0, shape.params.length).map((v, i) =>
        shape.params[i].kind === 'FloatProperty' && !shape.params[i].out && v !== undefined ? f(v) : v));
      const kind = shape.result?.kind ?? null;
      result = {value, kind, cells: (c.options.out ?? []).map(i => args[i].value),
        canonResult: kind === 'IntProperty' ? w.canon(value | 0) : kind === 'ObjectProperty' ? w.canon(w.address(value)) : undefined};
    } else {
      const words = args.map((a, i) => (a && typeof a === 'object' && 'cell' in a) ? a : (a && typeof a === 'object') ? w.address(a)
        : FLOAT_ARGS.has(c.method) && i < 2 ? bits(a) : a >>> 0);
      request = {method: c.method, args: words, controlWord: ['draw', 'scaleDraw'].includes(c.method) ? 0x007f : 0x037f, noVtable: Boolean(c.scale)};
      const jsArgs = ['preferredSize', 'granularity'].includes(c.method) ? [] : FLOAT_ARGS.has(c.method) ? [bits(args[0]), bits(args[1]), ...args.slice(2)] : args;
      result = methodJs(M, w, c.method)(win, ...jsArgs) ?? {};
    }
  } catch (e) { error = e; }
  w.recording = false;
  const gcBase = c.options.draw ? w.address(w.drawGc) : 0;
  const kind = c.scale ? 'scale' : 'list';
  const js = error ? {error: error.stack} : {events: w.events, result, state: dump(at => heap.bytes[at - IMAGE_BASE], w.canon, w.address(win), gcBase, kind)};
  return {js, base: w.address(win), gcBase, kind, request: {name: c.name, image, blocks, window: w.address(win), parents: w.parents.map(w.address),
    ...request, keys: Object.fromEntries(Object.entries(c.options.keys ?? {})), isFocus: c.options.isFocus ?? 0,
    tickOffset: c.options.tickOffset ?? 0, cursorPos: c.options.cursorPos ?? [0, 0], scriptResult: c.options.scriptResult ?? 0,
    activateResults: Object.fromEntries(Object.entries(w.current.activateResults ?? {}).map(([k, v]) => [String(k), v])),
    selectionResults: {}, textureVtables: [w.textureVtable], canvasTable: w.canvasTable, renderTable: w.renderTable}};
}

// ---------------------------------------------------------------------------
// Compare.
// ---------------------------------------------------------------------------
function firstDiff(got, expected, where = '$') {
  if (Object.is(got, expected)) return null;
  if (typeof got !== 'object' || typeof expected !== 'object' || !got || !expected) return {where, got, expected};
  for (const key of new Set([...Object.keys(got), ...Object.keys(expected)])) {
    const d = firstDiff(got[key], expected[key], `${where}.${key}`);
    if (d) return d;
  }
  return null;
}
function expectedOf(c, o, run) {
  const image = Buffer.from(o.image, 'base64'), blocks = [...Object.entries(o.blocks)].map(([a, b]) => [Number(a), Buffer.from(b, 'base64')]);
  const read = at => {
    for (const [base, data] of blocks) if (at >= base && at < base + data.length) return data[at - base];
    if (at >= IMAGE_BASE && at < IMAGE_BASE + image.length) return image[at - IMAGE_BASE];
    throw new Error(`oracle read outside the image and blocks: 0x${at.toString(16)}`);
  };
  const allocs = o.allocs.map(([at, size, ident, live]) => ({at, size, ident, live}));
  const canon = ptr => {
    ptr >>>= 0;
    if (!ptr) return 0;
    for (const a of allocs) if (a.at <= ptr && ptr < a.at + Math.max(a.size, 4)) {
      const name = a.ident + (a.live ? '' : '!');
      return ptr === a.at ? name : `${name}+${(ptr - a.at).toString(16)}`;
    }
    return ptr;
  };
  const expected = {events: o.events, state: dump(read, canon, run.base, run.gcBase, run.kind)};
  if (c.native !== undefined) {
    const raw = Buffer.from(o.result, 'hex'), word = raw.readUInt32LE(0), kind = run.js.result?.kind;
    if (kind === 'IntProperty' || kind === 'ObjectProperty') expected.result = canon(word);
    else if (kind === 'BoolProperty') expected.result = word !== 0;
    else if (kind === 'FloatProperty') expected.result = word;
    else if (kind === 'ByteProperty') expected.result = raw[0];
    else if (kind === 'StrProperty') {
      const num = raw.readInt32LE(4);
      let s = ''; for (let i = 0; i < num - 1 && word; i++) s += String.fromCharCode(read(word + 2 * i) | read(word + 2 * i + 1) << 8);
      expected.result = s;
    }
    if (c.options.out) expected.cells = c.options.out.map(i => o.cells[i]);
    expected.paramsLeft = o.paramsLeft;
  } else {
    if (run.js.result?.eax !== undefined) expected.eax = o.eax & 0xff;
    if (run.js.result?.cells) expected.cells = o.cells.slice(0, run.js.result.cells.length);
  }
  return expected;
}
function gotOf(c, run) {
  const {js} = run, got = {events: js.events, state: js.state};
  if (c.native !== undefined) {
    const {kind, value} = js.result;
    if (kind === 'IntProperty' || kind === 'ObjectProperty') got.result = js.result.canonResult;
    else if (kind === 'BoolProperty') got.result = Boolean(value);
    else if (kind === 'FloatProperty') got.result = bits(value);
    else if (kind === 'ByteProperty') got.result = value & 0xff;
    else if (kind === 'StrProperty') got.result = String(value ?? '');
    if (c.options.out) got.cells = js.result.cells.map(v => v === undefined ? 'unset' : typeof v === 'number' ? bits(v)
      : ['r', 'g', 'b', 'a'].reduce((word, k, i) => word | (v[`core.object.color.${k}`] << (8 * i)), 0) >>> 0);
    got.paramsLeft = 0;
  } else {
    if (js.result.eax !== undefined) got.eax = js.result.eax & 0xff;
    if (js.result.cells) got.cells = js.result.cells.map(v => v >>> 0);
  }
  return got;
}

const runs = cases.map(c => runCase(c, CLEAN));
const oracle = JSON.parse(execFileSync(PYTHON, [path.join(ROOT, 'scripts', 'native-listwindow-family-oracle.py'), gameDirectory()], {
  input: JSON.stringify({cases: runs.map(r => r.request)}), encoding: 'utf8', maxBuffer: 1 << 30}));
if (oracle.extensionBase !== 0x12000000) throw new Error('oracle base');
const failures = [], expectations = new Map(), opCounts = {};
cases.forEach((c, i) => {
  const run = runs[i], o = oracle.cases[c.name];
  if (o.error || run.js.error) { failures.push(`${c.name}: ${o.error ? `oracle ${o.error}` : `js ${run.js.error}`}`); return; }
  const expected = expectedOf(c, o, run);
  expectations.set(c.name, expected);
  for (const e of o.events) opCounts[e.op] = (opCounts[e.op] ?? 0) + 1;
  const diff = firstDiff(gotOf(c, run), expected);
  if (diff) failures.push(`${c.name}: ${diff.where} js=${JSON.stringify(diff.got)?.slice(0, 300)} oracle=${JSON.stringify(diff.expected)?.slice(0, 300)}`
    + (process.env.LIST_FAMILY_EVENTS && diff.where.startsWith('$.events') ? `\n  js ${JSON.stringify(run.js.events)}\n  or ${JSON.stringify(o.events)}` : ''));
});
const nativesCovered = new Set(cases.filter(c => c.native !== undefined).map(c => c.native));
const bodies = new Set(cases.filter(c => c.method).map(c => c.method));
console.log(`ListWindow family diff: ${cases.length - failures.length}/${cases.length} cases identical (${nativesCovered.size} natives, ${bodies.size} virtual/lifecycle bodies)`);
console.log(`oracle events: ${Object.entries(opCounts).sort().map(([op, n]) => `${op} ${n}`).join(', ')}`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }

// ---------------------------------------------------------------------------
// Mutations: each must diverge somewhere.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {find: "X(fieldH)), p24sub(X(y), rowMargin)), X(1))", replace: "X(fieldH)), p24sub(X(y), rowMargin)), X(2))", note: 'Draw text baseline +2 instead of +1.0'},
  {find: 'first = x87fistp(p24sub(X(t), X(0.5)));', replace: 'first = Math.floor(t);', note: 'Draw first row by floor instead of fistp(t - 0.5)'},
  {find: 'p24add(clipY, XD(1e-5))', replace: 'clipY', note: 'Draw first row without the 1e-5 bias'},
  {find: "else tx = S(p24add(p24mul(p24sub(X(colW), X(fieldW)), XD(0.5)), X(colX)));", replace: "else tx = S(p24add(X(colX), colMargin));", note: 'Draw centred column aligned left'},
  {find: "if (!flag(L, LIST_FLAGS.multiSelect)) { clear = 1; spanRange = 0; }", replace: "if (!flag(L, LIST_FLAGS.multiSelect)) { clear = 1; }", note: 'MoveToRow keeps the span in single-select'},
  {find: "!(compareRows(L, node, rowAt(L, index + 1)) > 0)", replace: "compareRows(L, node, rowAt(L, index + 1)) > 0", note: 'CheckPosition successor test corrected'},
  {find: "moveToRow(W, L, env, rowAt(L, index), 1, ctrlKeep ? 0 : 1, ctrlInvert, shift, 1);", replace: "moveToRow(W, L, env, rowAt(L, index), 1, 1, ctrlInvert, shift, 1);", note: 'Click always clears the other rows'},
  {find: "case 1742: { const n = row(0); selectRow(L, n, bool(1, true)); break; }", replace: "case 1742: { const n = row(0); selectRow(L, n, bool(1, false)); break; }", note: 'SelectRow default bSelect false'},
  {find: "X(L.read(L.base + LIST.lineSize, 'f32'))), X(L.read(L.base + LIST.rowMargin, 'f32'))))", replace: "X(L.read(L.base + LIST.lineSize, 'f32'))), X(0)))", note: 'PlayListSound y without the row margin'},
  {find: "let index = match > 1 ? start - 1 : start;", replace: "let index = start;", note: 'FindRowByKey prefix search skips the focus row'},
  {find: "W.setF32(win, LIST.colMargin, 3);", replace: "W.setF32(win, LIST.colMargin, 2);", note: 'Init column margin 2'},
  {find: "if (c === 'lt' || c === 'un') {", replace: "if (c !== 'gt') {", note: 'Tick drag repeat fires at exactly zero'},
  {find: ": (c & 0xff000000) >>> 0)); break; }", replace: ": 0)); break; }", note: 'GetColumnColor invalid column alpha 0'},
  {find: "if (L.read(L.base + LIST.anchorLine, 'u32') === node) L.write(L.base + LIST.anchorLine, 'u32', 0);", replace: '', note: 'DeleteRow keeps a dangling anchor'},
  {find: "if (visible && !L.read(L.base + LIST.focusLine, 'u32') && rowsNum(L) > 0) setRow(W, L, env, rowAt(L, 0), 1, 1, 0);", replace: '', note: 'VisibilityChanged does not select row 0'},
  {find: "if ((clicks | 0) > 1 && lineSize > 0 && num > 0) {", replace: "if ((clicks | 0) > 0 && lineSize > 0 && num > 0) {", note: 'Single click activates'},
  {file: 'scale', find: "pattern(x, y, w, h, 0, 0, 0, a.stretch ? 0 : h, a.texture);", replace: "pattern(x, y, w, h, 0, 0, 0, a.stretch ? h : 0, a.texture);", note: 'Scale stretch flag inverted (vertical)'},
  {file: 'scale', find: "if (!(flags & 4)) { first = 1; count--; }", replace: "if (!(flags & 4)) { first = 1; }", note: 'Scale draws one tick too many'},
  {file: 'scale', find: "x = S(p24add(r(x), r(a.borderWidth)));", replace: "x = S(p24add(r(x), r(0)));", note: 'Scale border does not inset x'},
];
const sources = {list: readFileSync(path.join(ROOT, 'src/runtime/script-window-list.mjs'), 'utf8'),
  scale: readFileSync(path.join(ROOT, 'src/runtime/script-window-scale-draw.mjs'), 'utf8')};
const caught = [], missed = [];
for (const [i, mutation] of MUTATIONS.entries()) {
  const source = sources[mutation.file ?? 'list'];
  const hits = source.split(mutation.find).length - 1;
  if (hits !== 1) { console.error(`mutation ${i} (${mutation.note}): find string occurs ${hits} times`); process.exit(1); }
  const file = path.join(ROOT, 'src/runtime', `.mut-list-family-${process.pid}-${i}.mjs`);
  writeFileSync(file, source.replace(mutation.find, mutation.replace));
  try {
    const mutated = await import(url.pathToFileURL(file).href);
    const M = mutation.file === 'scale' ? {...CLEAN, scaleDraw: mutated.scaleDraw} : mutated;
    let detail = null;
    for (const c of cases) {
      const expected = expectations.get(c.name);
      const run = runCase(c, M);
      if (run.js.error) { detail = `${c.name}: threw`; break; }
      if (firstDiff(gotOf(c, run), expected)) { detail = c.name; break; }
    }
    if (!detail) missed.push(`mutation ${i} (${mutation.note}) was not detected`);
    else caught.push(`${mutation.note} -> ${detail}`);
  } finally { rmSync(file, {force: true}); }
}
console.log(`mutations: ${caught.length}/${MUTATIONS.length} detected`);
if (missed.length) { console.error(missed.join('\n')); process.exit(1); }
if (process.env.LIST_FAMILY_VERBOSE) console.log(caught.join('\n'));
