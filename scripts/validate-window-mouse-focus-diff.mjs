/** Mouse position, hit testing and focus against the original Extension.dll.
 *
 * scripts/native-window-mouse-focus-oracle.py runs the unchanged SetCursorPos,
 * SetRootCursorPos (with ClampMousePosition), ProcessMouseMove, GetMouseWindow,
 * FindWindowByPoint, IsPointInWindow, SetFocusWindow, AskParentToShowArea,
 * XClipRect::Intersect and ConvertCoordinates over window images with their
 * real vtables. The same cases run through src/runtime/script-window-mouse.mjs
 * (with the existing SetFocusWindow translation) and the shared family
 * virtuals; every step's result, events and window state compare exactly,
 * floats as bits. docs/script-window-input.md. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import * as Mouse from '../src/runtime/script-window-mouse.mjs';
import * as Input from '../src/runtime/script-window-input.mjs';
import * as T from '../src/runtime/script-window-tree-natives.mjs';
import * as F from '../src/runtime/script-window-families.mjs';
import {moveTabGroupNative} from '../src/runtime/script-window-root-tick.mjs';
import {gameDirectory} from './game-directory.mjs';

const f = Math.fround;
const bits = value => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); };
const float = raw => { const view = new DataView(new ArrayBuffer(4)); view.setUint32(0, raw >>> 0, true); return view.getFloat32(0, true); };

// A keypad-shaped tree: a root with a HUD sibling and an EnterLeave modal of buttons.
const tree = (extra = {}) => [
  {id: 'root', family: 'root', type: 3, flags: 7, width: 640, height: 480, clip: [0, 0, 0, 0, 640, 480],
    mouseX: 5, mouseY: 5, lastX: 5, lastY: 5, ...extra.root},
  {id: 'hud', parent: 'root', width: 640, height: 480, clip: [0, 0, 0, 0, 640, 480], flags: 3},
  {id: 'keypad', family: 'modal', type: 2, parent: 'root', x: 200, y: 100, width: 200, height: 240,
    clip: [200, 100, 0, 0, 200, 240], flags: 7, focusMode: 3, ...extra.keypad},
  {id: 'b1', family: 'button', parent: 'keypad', x: 10, y: 10, width: 40, height: 30,
    clip: [210, 110, 0, 0, 40, 30], focusSound: 11, unfocusSound: 12, ...extra.b1},
  {id: 'b2', family: 'button', parent: 'keypad', x: 60.5, y: 10, width: 40, height: 30,
    clip: [260.5, 110, 0, 0, 40, 30], focusSound: 21, unfocusSound: 22},
  {id: 'b3', family: 'toggle', parent: 'keypad', x: 180, y: 200, width: 40, height: 30,
    clip: [380, 300, 0, 0, 20, 30], focusSound: 31, unfocusSound: 32},
  {id: 'label', family: 'text', parent: 'keypad', x: 10, y: 60, width: 150, height: 20,
    clip: [210, 160, 0, 0, 150, 20], flags: 3},
];
const cursor = (x, y) => ({op: 'setRootCursorPos', root: 'root', x, y});
// The keypad modal as its own tab group: rows b1 b2 b3 (label is not selectable).
const tabbed = (extra = {}) => tree({...extra, keypad: {tabIndex: 0, rowTable: ['b1', 'b2', 'b3', 'label'],
  colTable: ['b1', 'b3', 'b2', 'label'], groupTable: ['keypad'], ...extra.keypad}}).map(spec =>
  ({...spec, ...({b1: {rowIndex: 0, colIndex: 0}, b2: {rowIndex: 1, colIndex: 2}, b3: {rowIndex: 2, colIndex: 1},
    label: {rowIndex: 3, colIndex: 3}}[spec.id] ?? {}), ...(extra[spec.id] && spec.id !== 'keypad' ? extra[spec.id] : {})}));
const focus = target => ({op: 'setFocusWindow', win: 'root', target});
const disable = id => ({op: 'set', win: id, offset: 0x30, value: 5});
const cases = [
  {name: 'SetCursorPos walks the keypad: enter, focus, leave, re-enter, still, clamp',
    windows: tree(), steps: [
      {op: 'setCursorPos', win: 'keypad', x: 25, y: 25}, cursor(270.25, 125.75), cursor(270.25, 125.75),
      cursor(215, 115), cursor(300, 300), cursor(-50, 900), {op: 'setCursorPos', win: 'b3', x: 0.125, y: 3}]},
  {name: 'Enter-only focus keeps focus when the mouse leaves',
    windows: tree({keypad: {focusMode: 2}}), steps: [cursor(215, 115), cursor(250, 250), cursor(265, 115)]},
  {name: 'MFocus_None only reports enter/leave and moves',
    windows: tree({keypad: {focusMode: 0}}), steps: [cursor(215, 115), cursor(265, 115)]},
  {name: 'a held button tracks the pointer inside and outside it',
    windows: tree({b1: {buttonFlags: 2}}), steps: [cursor(215, 115), cursor(249.5, 139.5),
      cursor(251, 120), cursor(215, 115)]},
  {name: 'a grabbed window receives the mouse wherever it is',
    windows: tree(), steps: [cursor(215, 115), {op: 'set', win: 'root', offset: 0x5c4, windowValue: 'b2'},
      cursor(30, 30), {op: 'getMouseWindow', root: 'root'}, {op: 'getMouseWindow', root: 'root', modal: 'hud'}]},
  {name: 'SetFocusWindow: non-selectable, hidden, repeated and cleared targets',
    windows: tree(), steps: [{op: 'setFocusWindow', win: 'root', target: 'label'},
      {op: 'setFocusWindow', win: 'b1', target: 'b2'}, {op: 'setFocusWindow', win: 'b1', target: 'b2'},
      {op: 'set', win: 'b1', offset: 0x30, value: 6}, {op: 'setFocusWindow', win: 'root', target: 'b1'},
      {op: 'setFocusWindow', win: 'root', target: 'hud'}, {op: 'setFocusWindow', win: 'root', target: null}]},
  {name: 'AskParentToShowArea: clipped, empty, hidden and fully shown areas',
    windows: tree(), steps: [
      {op: 'askParentToShowArea', win: 'b3', x: 0, y: 0, w: 40, h: 30},
      {op: 'askParentToShowArea', win: 'b3', x: 2.5, y: 1.25, w: 10.1, h: 3.3},
      {op: 'askParentToShowArea', win: 'b3', x: 30, y: 0, w: 20, h: 5},
      {op: 'askParentToShowArea', win: 'b3', x: 50, y: 0, w: 10, h: 5},
      {op: 'askParentToShowArea', win: 'b1', x: 0, y: 0, w: 0, h: 5},
      {op: 'askParentToShowArea', win: 'b1', x: 0.1, y: 0.2, w: 39.7, h: 29.9},
      {op: 'set', win: 'keypad', offset: 0x30, value: 6},
      {op: 'askParentToShowArea', win: 'b3', x: 0, y: 0, w: 40, h: 30}]},
  {name: 'FindWindowByPoint and IsPointInWindow edges',
    windows: tree(), steps: [
      {op: 'findWindowByPoint', win: 'keypad', x: 10, y: 10}, {op: 'findWindowByPoint', win: 'keypad', x: 49.99, y: 39.99},
      {op: 'findWindowByPoint', win: 'keypad', x: 50, y: 40}, {op: 'findWindowByPoint', win: 'keypad', x: 200, y: 10},
      {op: 'findWindowByPoint', win: 'keypad', x: -0, y: 0}, {op: 'findWindowByPoint', win: 'root', x: 215, y: 115},
      {op: 'isPointInWindow', win: 'b1', x: 40, y: 0}, {op: 'isPointInWindow', win: 'b1', x: 39.999, y: 29.999},
      {op: 'isPointInWindow', win: 'b1', x: -1e-30, y: 5}, {op: 'isPointInWindow', win: 'b1', x: NaN, y: 5},
      {op: 'set', win: 'b1', offset: 0x30, value: 1}, {op: 'findWindowByPoint', win: 'keypad', x: 15, y: 15}]},
  {name: 'MoveFocus walks the row and column tables with and without wrap',
    windows: tabbed(), steps: [focus('b1'), {op: 'moveFocus', win: 'b1', direction: 1}, {op: 'moveFocus', win: 'root', direction: 1},
      {op: 'moveFocus', win: 'root', direction: 1, wrap: 1}, {op: 'moveFocus', win: 'root', direction: 0},
      {op: 'moveFocus', win: 'root', direction: 3}, {op: 'moveFocus', win: 'root', direction: 2, wrap: 1},
      {op: 'set', win: 'keypad', offset: 0x164, value: 4}, {op: 'moveFocus', win: 'root', direction: 1}, {op: 'moveFocus', win: 'root', direction: 1}]},
  {name: 'MoveFocus skips untraversable entries and without candidates falls back to MoveTabGroup',
    windows: tabbed(), steps: [focus('b2'), disable('b3'), {op: 'moveFocus', win: 'root', direction: 1, wrap: 1},
      disable('b1'), {op: 'moveFocus', win: 'root', direction: 1, wrap: 1}]},
  {name: 'CheckFocusWindow: preferred focus, MoveFocus, then no focus',
    windows: tabbed(), steps: [focus('b1'), {op: 'checkFocusWindow', win: 'keypad'}, disable('b1'),
      {op: 'checkFocusWindow', win: 'keypad'}, focus('b3'), {op: 'set', win: 'keypad', offset: 0x178, windowValue: 'b3'},
      disable('b3'), {op: 'checkFocusWindow', win: 'b3'}, disable('b2'), {op: 'checkFocusWindow', win: 'b2'}]},
  {name: 'XClipRect::Intersect and ConvertCoordinates rounding',
    windows: tree(), steps: [
      {op: 'intersect', a: [0.1, 0.2, 0.3, 0.7, 100.33, 50.1], b: [1e-3, 3.3, 7.77, 0.05, 90.9, 60.6]},
      {op: 'intersect', a: [16777215, 1, 0.5, 0.5, 3.75, 1e-7], b: [16777000, 1, 100, 0, 1e5, 2]},
      {op: 'intersect', a: [0, 0, 0, 0, 10, 10], b: [20, 20, 0, 0, 5, 5]},
      {op: 'intersect', a: [-5, -5, 1, 1, 10, 10], b: [-6, -4, 0.3, 0.3, NaN, 4]},
      {op: 'convertCoordinates', from: 'b2', x: 0.3, y: 0.7, to: 'root'},
      {op: 'convertCoordinates', from: 'root', x: 1e8, y: -3.3, to: 'b2'},
      {op: 'convertCoordinates', from: 'b3', x: 16777215, y: 0.1, to: 'label'}]},
  {name: 'HandleButtons obeys the root mouse-input suppression bit',
    windows: tree({root:{mouseFlags:4}}),steps:[{op:'handleButtons',root:'root',key:1,action:1}]},
  {name: 'HandleButtons captures, focuses and dispatches button press/release with multi-click counts',
    now:1,lastTick:0,windows:tree({root:{mouseX:215,mouseY:115,clickDeadline:2,lastWindow:'b1',lastKey:1,
      clickX:215,clickY:115,clickIndex:0},b1:{pressSound:41,clickSound:42}}),steps:[
      {op:'handleButtons',root:'root',key:1,action:1},{op:'handleButtons',root:'root',key:1,action:3},
      {op:'handleButtons',root:'root',key:1,action:1}]},
  {name: 'HandleButtons bubbles unhandled raw and pressed events through cached parents',
    now:1,lastTick:0,windows:tree({root:{mouseX:215,mouseY:165,clickDeadline:2,lastWindow:'label',lastKey:1,
      clickX:215,clickY:165}}),steps:[{op:'handleButtons',root:'root',key:1,action:1}]},
];

// ---- original ------------------------------------------------------------
// Floats travel as bits (JSON has no NaN or -0); a window-valued write names its target.
const FLOAT_KEYS = new Set(['x', 'y', 'w', 'h', 'width', 'height', 'mouseX', 'mouseY', 'lastX', 'lastY',
  'multiClickTime','multiClickDistance','clickDeadline','clickX','clickY','repeatDelay','repeatAt']);
const encode = object => Object.fromEntries(Object.entries(object).map(([key, value]) =>
  [key, FLOAT_KEYS.has(key) && typeof value === 'number' ? {bits: bits(value)}
    : ['clip', 'a', 'b'].includes(key) ? value.map(v => ({bits: bits(v)})) : value]));
const oracleCases = cases.map(c => ({...c, windows: c.windows.map(encode), steps: c.steps.map(step =>
  step.windowValue ? {...encode(step), op: 'setWindow', windowRef: step.windowValue} : encode(step))}));
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const run = spawnSync(python, ['scripts/native-window-mouse-focus-oracle.py', gameDirectory()],
  {input: JSON.stringify({cases: oracleCases}), encoding: 'utf8', maxBuffer: 64e6});
if (run.status !== 0) throw new Error(`mouse/focus oracle failed: ${run.stderr || run.stdout}`);
const original = JSON.parse(run.stdout).results;

// ---- translation ---------------------------------------------------------
const FAMILY = {window: 'extension.window', text: 'extension.textwindow', button: 'extension.buttonwindow',
  toggle: 'extension.togglewindow', modal: 'extension.modalwindow', root: 'extension.rootwindow'};
const SIZE = {window: 0x160, text: 0x174, button: 0x1ec, toggle: 0x1f4, modal: 0x588, root: 0x744};
function translate(c) {
  const heap = createNativeHeap(), events = [], windows = new Map(), ids = new Map(), families = new Map(), sounds = new Map();
  const soundFor = id => { if (!id) return null; if (!sounds.has(id)) { const s = {sound: id}; heap.allocate(s, 16); sounds.set(id, s); } return sounds.get(id); };
  const ref = value => value === null || value === undefined ? null : ids.get(value) ?? `unknown`;
  const W = {
    heap,
    u8: (o, off) => heap.read(o, off, 'u8'), u32: (o, off) => heap.read(o, off, 'u32'), i32: (o, off) => heap.read(o, off, 'i32'),
    f32: (o, off) => heap.read(o, off, 'f32'), ptr: (o, off) => heap.read(o, off, 'ptr'),
    setU8: (o, off, v) => heap.write(o, off, 'u8', v & 0xff), setU32: (o, off, v) => heap.write(o, off, 'u32', v >>> 0),
    setI32: (o, off, v) => heap.write(o, off, 'i32', v | 0), setF32: (o, off, v) => heap.write(o, off, 'f32', f(v)),
    setPtr: (o, off, v) => heap.write(o, off, 'ptr', v),
    native: {playSound: (win, sound, volume, pitch) => events.push({op: 'PlaySound', window: ref(win),
      sound: sound?.sound ?? 0, volume: bits(volume), pitch: bits(pitch)})},
    farray: {num: (o, off) => heap.read(o, off + 4, 'i32'), ptr: (o, off, i) => heap.mem.read(heap.read(o, off, 'u32') + 4 * i, 'ptr')},
    tickOffset:()=>f((c.now??1)-(c.lastTick??0)),
  };
  // The host's W.native focus services (script-window-host.mjs).
  Object.assign(W.native, {
    setFocusWindow: (win, target) => Mouse.setFocusWindow(W, win, target),
    moveTabGroup: (win, direction) => moveTabGroupNative(W, win, direction, {...T, ...F, setFocusWindow: (root, target) => Mouse.setFocusWindow(W, root, target)}),
    moveFocus: (win, direction, wrap) => Mouse.moveFocus(W, win, direction, wrap, {getTabGroupWindow: T.getTabGroupWindow, moveTabGroup: (root, move) => W.native.moveTabGroup(root, move)}),
  });
  const processScript = (win, name, args) => {
    const params = ['MouseMoved'].includes(name) ? args.map(bits)
      : name === 'RawMouseButtonPressed' ? [bits(args[0]),bits(args[1]),args[2],args[3]]
      : ['MouseButtonPressed','MouseButtonReleased'].includes(name) ? [bits(args[0]),bits(args[1]),args[2],args[3]]
      : name.endsWith('Descendant')||name.startsWith('ButtonActivated') ? [ref(args[0])]
      : name === 'ChildRequestedShowArea' ? [ref(args[0]), ...args.slice(1).map(bits)] : [];
    events.push({op: 'ProcessScript', window: ref(win), name, params, third: 0});
    return false;
  };
  W.v = Mouse.mouseFocusVirtuals(W, {familyOf: win => families.get(win), processScript,
    changeButtonAppearance: win => events.push({op: 'ChangeButtonAppearance', window: ref(win)}),
    boundary: message => { throw new Error(message); }});
  W.v.mouseGrabLost=()=>undefined;
  W.v.buttonActivated=(win,source)=>processScript(win,'ButtonActivated',[source],{result:false})?1:0;
  W.v.buttonActivatedRight=(win,source)=>processScript(win,'ButtonActivatedRight',[source],{result:false})?1:0;
  const activateButton=(win,key)=>{for(let current=win;current;current=W.ptr(current,0x138))
    if((key===2?W.v.buttonActivatedRight(current,win):W.v.buttonActivated(current,win)))break;};
  const basePressed=W.v.mouseButtonPressed,baseReleased=W.v.mouseButtonReleased;
  W.v.mouseButtonPressed=(win,...args)=>families.get(win)==='extension.buttonwindow'
    ?Input.buttonMousePressed(W,win,...args,{processScript,changeButtonAppearance:w=>events.push({op:'ChangeButtonAppearance',window:ref(w)}),tickOffset:W.tickOffset,activateButton})
    :basePressed(win,...args);
  W.v.mouseButtonReleased=(win,...args)=>families.get(win)==='extension.buttonwindow'
    ?Input.buttonMouseReleased(W,win,...args,{processScript,changeButtonAppearance:w=>events.push({op:'ChangeButtonAppearance',window:ref(w)}),activateButton,isPointInWindow:(w,x,y)=>Mouse.isPointInWindow(W,w,x,y)})
    :baseReleased(win,...args);
  for (const spec of c.windows) {
    const family = spec.family ?? 'window', win = {id: spec.id};
    heap.allocate(win, SIZE[family]);
    windows.set(spec.id, win); ids.set(win, spec.id); families.set(win, FAMILY[family]);
  }
  for (const spec of c.windows) {
    const win = windows.get(spec.id), family = spec.family ?? 'window';
    W.setU8(win, 0x28, spec.type ?? 0); W.setU32(win, 0x30, spec.flags ?? 7);
    [['x', 0x78], ['y', 0x7c], ['width', 0x80], ['height', 0x84]].forEach(([key, offset]) => W.setF32(win, offset, spec[key] ?? 0));
    (spec.clip ?? [0, 0, 0, 0, 0, 0]).forEach((value, i) => W.setF32(win, 0xd4 + 4 * i, value));
    W.setPtr(win, 0x104, soundFor(spec.focusSound)); W.setPtr(win, 0x108, soundFor(spec.unfocusSound));
    if (spec.parent) {
      const parent = windows.get(spec.parent), last = W.ptr(parent, 0x140);
      W.setPtr(win, 0x138, parent);
      if (last) { W.setPtr(last, 0x148, win); W.setPtr(win, 0x144, last); } else W.setPtr(parent, 0x13c, win);
      W.setPtr(parent, 0x140, win);
    }
    W.setI32(win, 0x11c, spec.rowIndex ?? 0); W.setI32(win, 0x120, spec.colIndex ?? 0);
    if ('tabIndex' in spec) W.setI32(win, 0x168, spec.tabIndex);
    if ('tabFlags' in spec) W.setU32(win, 0x164, spec.tabFlags);
    if (family === 'modal' || family === 'root') { W.setU8(win, 0x174, spec.focusMode ?? 0); W.setPtr(win, 0x178, windows.get(spec.preferredFocus) ?? null); }
    if (family === 'button' || family === 'toggle') {
      W.setU32(win,0x174,spec.buttonFlags??0);W.setF32(win,0x17c,spec.repeatDelay??0);W.setF32(win,0x19c,spec.repeatAt??0);
      W.setPtr(win,0x190,soundFor(spec.pressSound));W.setPtr(win,0x194,soundFor(spec.clickSound));W.setU8(win,0x1a0,spec.inputKey??0);
    }
    if (family === 'root') {
      [['mouseX', 0x590], ['mouseY', 0x594], ['lastX', 0x598], ['lastY', 0x59c]].forEach(([key, offset]) => W.setF32(win, offset, spec[key] ?? 0));
      W.setU32(win, 0x5a4, spec.mouseFlags ?? 0);
      W.setF32(win,0x610,spec.multiClickTime??.5);W.setF32(win,0x614,spec.multiClickDistance??10);
      W.setI32(win,0x618,spec.clickIndex??0);W.setI32(win,0x61c,spec.lastKey??0);W.setF32(win,0x620,spec.clickDeadline??0);
      W.setF32(win,0x628,spec.clickX??-1);W.setF32(win,0x62c,spec.clickY??-1);
    }
  }
  for (const spec of c.windows) for (const [offset, key] of [[0x14c, 'rowTable'], [0x158, 'colTable'], [0x17c, 'groupTable']]) {
    if (!(key in spec)) continue;
    const data = heap.allocRaw(Math.max(4, 4 * spec[key].length));
    spec[key].forEach((id, i) => heap.mem.write(data + 4 * i, 'ptr', windows.get(id)));
    const win = windows.get(spec.id);
    W.setU32(win, offset, data); W.setI32(win, offset + 4, spec[key].length); W.setI32(win, offset + 8, spec[key].length);
  }
  for (const spec of c.windows) if ((spec.family ?? 'window') === 'root') {
    const win = windows.get(spec.id);
    [['mouseWindow', 0x5a0], ['grabbed', 0x5c4], ['focus', 0x5c8]].forEach(([key, offset]) => W.setPtr(win, offset, windows.get(spec[key]) ?? null));
    W.setPtr(win,0x624,windows.get(spec.lastWindow)??null);
  }
  const snapshot = () => Object.fromEntries(c.windows.map(spec => {
    const win = windows.get(spec.id), family = spec.family ?? 'window', entry = {flags: W.u32(win, 0x30)};
    if (family === 'modal' || family === 'root') { entry.preferredFocus = ref(W.ptr(win, 0x178)); entry.groupLocation = [W.u32(win, 0x16c), W.u32(win, 0x170)]; }
    if (family === 'button' || family === 'toggle') Object.assign(entry,{buttonFlags:W.u32(win,0x174),repeatAt:W.u32(win,0x19c),inputKey:W.u8(win,0x1a0)});
    if (family === 'root') Object.assign(entry, {mouseX: W.u32(win, 0x590), mouseY: W.u32(win, 0x594),
      lastX: W.u32(win, 0x598), lastY: W.u32(win, 0x59c), mouseWindow: ref(W.ptr(win, 0x5a0)),
      mouseFlags: W.u32(win, 0x5a4), focus: ref(W.ptr(win, 0x5c8)),grabbed:ref(W.ptr(win,0x5c4)),clickIndex:W.i32(win,0x618),
      lastKey:W.i32(win,0x61c),clickDeadline:W.u32(win,0x620),lastWindow:ref(W.ptr(win,0x624)),clickX:W.u32(win,0x628),clickY:W.u32(win,0x62c)});
    return [spec.id, entry];
  }));
  const at = id => windows.get(id);
  const rect = r => r.map(v => f(v));
  const toRect = ([ox, oy, cx, cy, cw, ch]) => ({ox, oy, cx, cy, cw, ch});
  return {steps: c.steps.map(step => {
    const mark = events.length;
    let result = null;
    switch (step.op) {
      case 'intersect': { const a = Mouse.clipRectIntersect(toRect(rect(step.a)), toRect(rect(step.b))); result = [a.ox, a.oy, a.cx, a.cy, a.cw, a.ch].map(bits); break; }
      case 'convertCoordinates': { const r = Mouse.convertCoordinates(W, at(step.from), f(step.x), f(step.y), at(step.to)); result = [bits(r.x), bits(r.y)]; break; }
      case 'findWindowByPoint': { const r = Mouse.findWindowByPoint(W, at(step.win), f(step.x), f(step.y)); result = r ? [ref(r.win), bits(r.x), bits(r.y)] : [null, 0, 0]; break; }
      case 'getMouseWindow': { const r = Mouse.getMouseWindow(W, at(step.root), at(step.modal) ?? null); result = [ref(r.win), bits(r.x), bits(r.y)]; break; }
      case 'isPointInWindow': result = Mouse.isPointInWindow(W, at(step.win), f(step.x), f(step.y)); break;
      case 'setCursorPos': Mouse.setCursorPos(W, at(step.win), f(step.x), f(step.y)); break;
      case 'setRootCursorPos': Mouse.setRootCursorPos(W, at(step.root), f(step.x), f(step.y)); break;
      case 'processMouseMove': Mouse.processMouseMove(W, at(step.root)); break;
      case 'setFocusWindow': result = Mouse.setFocusWindow(W, at(step.win), at(step.target) ?? null); break;
      case 'moveFocus': result = ref(Mouse.moveFocus(W, at(step.win), step.direction, step.wrap ?? 0,
        {getTabGroupWindow: T.getTabGroupWindow, moveTabGroup: (root, move) => W.native.moveTabGroup(root, move)})); break;
      case 'checkFocusWindow': T.checkFocusWindow(W, at(step.win)); break;
      case 'askParentToShowArea': Mouse.askParentToShowArea(W, at(step.win), f(step.x), f(step.y), f(step.w), f(step.h)); break;
      case 'handleButtons': result=Input.handleButtons(W,at(step.root),step.key,step.action,{topChild:T.topChild,lowerSibling:T.lowerSibling,
        getMouseWindow:(root,modal)=>Mouse.getMouseWindow(W,root,modal),convertCoordinates:(...args)=>Mouse.convertCoordinates(W,...args),
        setFocusWindow:(root,target)=>Mouse.setFocusWindow(W,root,target),getRootWindow:T.getRootWindow,tickOffset:W.tickOffset});break;
      case 'set': if (step.windowValue) W.setPtr(at(step.win), step.offset, at(step.windowValue)); else W.setU32(at(step.win), step.offset, step.value); break;
      default: throw new Error(`unknown op ${step.op}`);
    }
    return {result, events: events.slice(mark), state: snapshot()};
  })};
}

let steps = 0;
for (const [index, c] of cases.entries()) {
  const expected = original[index];
  assert.ok(expected.steps.every(step => !step.stopped), `${c.name}: the original run stopped: ${JSON.stringify(expected.steps.find(step => step.stopped))}`);
  const actual = translate(c);
  for (const [i, step] of expected.steps.entries())
    assert.deepEqual(actual.steps[i], step, `${c.name}, step ${i} ${JSON.stringify(c.steps[i])}`);
  steps += c.steps.length;
}
console.log(JSON.stringify({cases: cases.length, steps, mismatches: 0}));
