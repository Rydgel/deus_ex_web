/** The typed-character route (WM_CHAR) against the original binaries.
 *
 * scripts/native-window-typed-key-oracle.py runs the unchanged
 * XGameEngineExt::Key, UEngine::Key (Engine.dll), XInputExt::Key,
 * XRootWindow::Key, HandleKeyboard, XWindow::KeyPressed, XModalWindow::
 * KeyPressed (IsCurrentModal, GetAcceleratorWindow, BuildAcceleratorTable)
 * and XWindow::AcceleratorKeyPressed over window trees whose vtables are the
 * real XWindow / XTextWindow / XButtonWindow / XToggleWindow / XModalWindow /
 * XRootWindow / XEditWindow / XListWindow tables. The same cases run through
 * src/runtime/script-window-typed-keys.mjs with the shared accelerator-table
 * translation; every step's result, the event stream (script events with
 * their FString parameter, the Edit/List KeyPressed calls, Console.KeyType's
 * FindFunctionChecked/ProcessEvent) and the window state (accelerator
 * tables and dirty flags, root focus, grab count, key bytes) must match.
 * The family table of KeyPressed / AcceleratorKeyPressed / HandleKeyboard
 * bodies is read from every Extension window vftable and compared with the
 * host's routing (KEY_PRESSED_BODIES). docs/script-window-typed-keys.md. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, rmSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import * as TK from '../src/runtime/script-window-typed-keys.mjs';
import * as T from '../src/runtime/script-window-tree-natives.mjs';
import * as F from '../src/runtime/script-window-families.mjs';
import {gameDirectory} from './game-directory.mjs';

const IK_ALT = 0x12;
// A menu-shaped tree: the root with a HUD child (type 0), a hidden modal and
// the current modal holding an edit field, a list, a label, a toggle and
// two accelerator buttons; a second (lower) modal holds its own button.
const tree = (extra = {}) => [
  {id: 'root', family: 'root', type: 3, flags: 7, keyboardGrab: 1, ...extra.root},
  {id: 'hud', parent: 'root', flags: 3, ...extra.hud},
  {id: 'lower', family: 'modal', type: 2, parent: 'root', flags: 7, ...extra.lower},
  {id: 'lowerButton', family: 'button', parent: 'lower', flags: 7, acceleratorKey: 0x51, ...extra.lowerButton},
  {id: 'hidden', family: 'modal', type: 2, parent: 'root', flags: 6, ...extra.hidden},
  {id: 'menu', family: 'modal', type: 2, parent: 'root', flags: 7, ...extra.menu},
  {id: 'edit', family: 'edit', parent: 'menu', flags: 7, ...extra.edit},
  {id: 'list', family: 'list', parent: 'menu', flags: 7, ...extra.list},
  {id: 'label', family: 'text', parent: 'menu', flags: 3, ...extra.label},
  {id: 'toggle', family: 'toggle', parent: 'menu', flags: 7, acceleratorKey: 0x74, ...extra.toggle},
  {id: 'yes', family: 'button', parent: 'menu', flags: 7, acceleratorKey: 0x59, ...extra.yes},
  {id: 'no', family: 'button', parent: 'menu', flags: 7, acceleratorKey: 0x6e, ...extra.no},
  {id: 'off', family: 'button', parent: 'menu', flags: 5, acceleratorKey: 0x4f, ...extra.off},
  {id: 'plain', family: 'window', parent: 'menu', flags: 7, ...extra.plain},
];
const engine = (key, extra = {}) => ({op: 'gameEngineKey', key, root: 'root', ...extra});
const rootKey = key => ({op: 'rootKey', root: 'root', key});
const cases = [
  {name: 'Console.KeyType takes the key first: the BYTE goes to ProcessEvent and the windows see nothing',
    windows: tree({root: {focus: 'edit'}}), keyResults: {edit: 1},
    steps: [engine(0x61, {keyType: 1}), engine(0x20ac, {keyType: 1})]},
  {name: 'an unhandled key reaches the focused edit through XInputExt::Key and the root',
    windows: tree({root: {focus: 'edit'}}), keyResults: {edit: 1},
    steps: [engine(0x61), engine(0xe9), engine(0x20ac), engine(0x10041), engine(0)]},
  {name: 'engine-side gates: no console, no input, not an InputExt, no actor, not a PlayerPawnExt, no root, no grab',
    windows: tree({root: {focus: 'edit'}}), keyResults: {edit: 1},
    steps: [engine(0x41, {console: false}), engine(0x41, {input: false}), engine(0x41, {inputExt: false}),
      engine(0x41, {actor: false}), engine(0x41, {playerPawnExt: false}), engine(0x41, {root: null}),
      {op: 'set', win: 'root', offset: 0x5d0, value: 0}, engine(0x41), {op: 'set', win: 'root', offset: 0x5d0, value: 0xffffffff},
      engine(0x41), {op: 'inputExtKey', key: 0x42, root: 'root'}, {op: 'inputExtKey', key: 0x42, root: 'root', playerPawnExt: false}]},
  {name: 'XRootWindow::Key consumes every key while grabbed, whatever the windows return',
    windows: tree({root: {focus: 'plain'}}),
    steps: [rootKey(0x41), {op: 'set', win: 'root', offset: 0x5d0, value: 0}, rootKey(0x41)]},
  {name: 'the focus walk bubbles an unhandled key through every parent to the root',
    windows: tree({root: {focus: 'edit'}}), steps: [rootKey(0x41), {op: 'handleKeyboard', root: 'root', key: 0x7e}]},
  {name: 'a script that handles the key stops the walk at its window',
    windows: tree({root: {focus: 'plain'}}), scriptResults: {'menu:KeyPressed': 1},
    steps: [rootKey(0x78), {op: 'set', win: 'root', offset: 0x5c8, windowValue: 'list'}, rootKey(0x78)]},
  {name: 'the list and the edit field run their own KeyPressed bodies',
    windows: tree({root: {focus: 'list'}}), keyResults: {list: 1},
    steps: [rootKey(0x6c), {op: 'set', win: 'root', offset: 0x5c8, windowValue: 'edit'}, rootKey(0x6c)]},
  {name: 'without a focus the key goes to the topmost visible modal, past the HUD and hidden windows',
    windows: tree(), steps: [rootKey(0x41), {op: 'set', win: 'menu', offset: 0x30, value: 6}, rootKey(0x42),
      {op: 'set', win: 'lower', offset: 0x30, value: 6}, rootKey(0x43)]},
  {name: 'Alt skips windows of type < 2 and Alt+key on the current modal reaches its accelerator button',
    windows: tree({root: {focus: 'yes', keysDown: [IK_ALT]}}), scriptResults: {'yes:AcceleratorKeyPressed': 1},
    steps: [rootKey(0x79), rootKey(0x59), rootKey(0x4e), rootKey(0x6e), rootKey(0x54), rootKey(0x4f), rootKey(0x51)]},
  {name: 'accelerators need Alt, the current modal and a key in 1..0xfe',
    windows: tree({root: {focus: 'edit'}}),
    steps: [rootKey(0x79), {op: 'keyDown', root: 'root', key: IK_ALT}, rootKey(0x79), rootKey(0x179), rootKey(0xff),
      {op: 'set', win: 'menu', offset: 0x30, value: 6}, {op: 'set', win: 'root', offset: 0x5c8, windowValue: 'lowerButton'}, rootKey(0x51)]},
  {name: 'the table is rebuilt only when dirty',
    windows: tree({root: {focus: 'edit', keysDown: [IK_ALT]}, menu: {acceleratorDirty: 0}}),
    steps: [rootKey(0x59), {op: 'set', win: 'menu', offset: 0x584, value: 1}, rootKey(0x59)]},
  {name: 'the bridges build a one-character FString (none for 0) in every family',
    windows: tree(), scriptResults: {'toggle:KeyPressed': 1, 'yes:AcceleratorKeyPressed': 1},
    steps: [{op: 'keyPressed', win: 'plain', key: 0x41}, {op: 'keyPressed', win: 'label', key: 0xe9},
      {op: 'keyPressed', win: 'toggle', key: 0x20ac}, {op: 'keyPressed', win: 'yes', key: 0}, {op: 'keyPressed', win: 'hud', key: 0x10061},
      {op: 'keyPressed', win: 'menu', key: 0x7f}, {op: 'keyPressed', win: 'root', key: 0x0d},
      {op: 'acceleratorKeyPressed', win: 'yes', key: 0x59}, {op: 'acceleratorKeyPressed', win: 'no', key: 0xff}]},
  {name: 'IsCurrentModal and GetAcceleratorWindow edges',
    windows: tree(), steps: [{op: 'getAcceleratorWindow', win: 'menu', key: 0xff}, {op: 'isCurrentModal', win: 'menu'}, {op: 'isCurrentModal', win: 'lower'},
      {op: 'isCurrentModal', win: 'root'}, {op: 'isCurrentModal', win: 'hud'},
      {op: 'getAcceleratorWindow', win: 'menu', key: 0}, {op: 'getAcceleratorWindow', win: 'menu', key: 0x6e},
      {op: 'getAcceleratorWindow', win: 'menu', key: 0x4e}, {op: 'getAcceleratorWindow', win: 'menu', key: 0xfe},
      {op: 'getAcceleratorWindow', win: 'menu', key: 0x10059}, {op: 'getAcceleratorWindow', win: 'lower', key: 0x71},
      {op: 'set', win: 'menu', offset: 0x30, value: 6}, {op: 'isCurrentModal', win: 'lower'}, {op: 'isCurrentModal', win: 'menu'}]},
  {name: 'with no modal open the root is the current modal and Alt+key reaches a HUD accelerator',
    windows: [{id: 'root', family: 'root', type: 3, flags: 7, keyboardGrab: 1, keysDown: [IK_ALT]},
      {id: 'hud', parent: 'root', flags: 3}, {id: 'hudButton', family: 'button', parent: 'hud', flags: 7, acceleratorKey: 0x48}],
    scriptResults: {'hudButton:AcceleratorKeyPressed': 1},
    steps: [{op: 'isCurrentModal', win: 'root'}, rootKey(0x68), rootKey(0x48), rootKey(0x49)]},
  {name: 'a window being destroyed after its unhandled key is the line 0x648 assertion',
    windows: tree({root: {focus: 'edit'}, edit: {flags: 0x17}}), steps: [rootKey(0x41)]},
];

// ---- original ------------------------------------------------------------
const oracleCases = cases.map(c => ({...c, steps: c.steps.map(step =>
  step.windowValue ? {op: 'setWindow', win: step.win, offset: step.offset, windowRef: step.windowValue} : step)}));
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const run = spawnSync(python, ['scripts/native-window-typed-key-oracle.py', gameDirectory()],
  {input: JSON.stringify({cases: oracleCases}), encoding: 'utf8', maxBuffer: 64e6});
if (run.status !== 0) throw new Error(`typed-key oracle failed: ${run.stderr || run.stdout}`);
const {vtables, results: original} = JSON.parse(run.stdout);

// ---- the family table ----------------------------------------------------
for (const [name, slots] of Object.entries(vtables)) {
  assert.equal(slots['0xc8'], TK.keyPressedBody(`extension.${name}`), `${name} KeyPressed (+0xc8)`);
  assert.equal(slots['0xd0'], 'XWindow::AcceleratorKeyPressed', `${name} AcceleratorKeyPressed (+0xd0)`);
  if (name === 'rootwindow') assert.equal(slots['0x128'], 'XRootWindow::HandleKeyboard', 'root HandleKeyboard (+0x128)');
}

// ---- translation ---------------------------------------------------------
const FAMILY = {window: 'extension.window', text: 'extension.textwindow', button: 'extension.buttonwindow',
  toggle: 'extension.togglewindow', modal: 'extension.modalwindow', root: 'extension.rootwindow',
  edit: 'extension.editwindow', list: 'extension.listwindow'};
const SIZE = {window: 0x160, text: 0x174, button: 0x1ec, toggle: 0x1f4, modal: 0x588, root: 0x744, edit: 0x28c, list: 0x1d0};
function translate(c, TK) {
  const heap = createNativeHeap(), events = [], windows = new Map(), ids = new Map(), families = new Map();
  const ref = value => value === null || value === undefined ? null : ids.get(value) ?? 'unknown';
  const W = {
    heap,
    u8: (o, off) => heap.read(o, off, 'u8'), u16: (o, off) => heap.read(o, off, 'u16'), u32: (o, off) => heap.read(o, off, 'u32'),
    i32: (o, off) => heap.read(o, off, 'i32'), ptr: (o, off) => heap.read(o, off, 'ptr'),
    setU8: (o, off, v) => heap.write(o, off, 'u8', v & 0xff), setU32: (o, off, v) => heap.write(o, off, 'u32', v >>> 0),
    setI32: (o, off, v) => heap.write(o, off, 'i32', v | 0), setPtr: (o, off, v) => heap.write(o, off, 'ptr', v),
  };
  const processScript = (win, name, args) => {
    const text = args[0], num = text ? text.length + 1 : 0;
    events.push({op: 'ProcessScript', window: ref(win), name, params: [text, num, num], third: 0});
    return Boolean(c.scriptResults?.[`${ref(win)}:${name}`]);
  };
  const tree = {getRootWindow: T.getRootWindow, topChild: T.topChild, lowerSibling: T.lowerSibling};
  W.v = {
    keyPressed(win, key) {
      switch (TK.keyPressedBody(families.get(win))) {
        case 'XEditWindow::KeyPressed': case 'XListWindow::KeyPressed':
          events.push({op: 'KeyPressed', family: families.get(win) === 'extension.editwindow' ? 'edit' : 'list', window: ref(win), key});
          return c.keyResults?.[ref(win)] ?? 0;
        case 'XModalWindow::KeyPressed':
          return TK.modalKeyPressed(W, win, key, {processScript, buildAcceleratorTable: F.buildAcceleratorTable, ...tree});
        default: return TK.windowKeyPressed(processScript, win, key);
      }
    },
    acceleratorKeyPressed: (win, key) => TK.windowAcceleratorKeyPressed(processScript, win, key),
    handleKeyboard: (root, key) => TK.handleKeyboard(W, root, key, tree),
  };
  for (const spec of c.windows) {
    const family = spec.family ?? 'window', win = {id: spec.id};
    heap.allocate(win, SIZE[family]);
    windows.set(spec.id, win); ids.set(win, spec.id); families.set(win, FAMILY[family]);
  }
  for (const spec of c.windows) {
    const win = windows.get(spec.id), family = spec.family ?? 'window';
    W.setU8(win, 0x28, spec.type ?? 0); W.setU32(win, 0x30, spec.flags ?? 7);
    heap.write(win, 0xb4, 'u16', spec.acceleratorKey ?? 0);
    if (spec.parent) {
      const parent = windows.get(spec.parent), last = W.ptr(parent, 0x140);
      W.setPtr(win, 0x138, parent);
      if (last) { W.setPtr(last, 0x148, win); W.setPtr(win, 0x144, last); } else W.setPtr(parent, 0x13c, win);
      W.setPtr(parent, 0x140, win);
    }
    if (family === 'modal' || family === 'root') W.setU32(win, 0x584, spec.acceleratorDirty ?? 1);
    if (family === 'root') {
      W.setPtr(win, 0x5c8, windows.get(spec.focus) ?? null);
      W.setI32(win, 0x5d0, spec.keyboardGrab ?? 0);
      for (const key of spec.keysDown ?? []) W.setU8(win, 0x630 + key, 1);
    }
  }
  const snapshot = () => Object.fromEntries(c.windows.map(spec => {
    const win = windows.get(spec.id), family = spec.family ?? 'window', entry = {flags: W.u32(win, 0x30)};
    if (family === 'modal' || family === 'root') {
      entry.acceleratorDirty = W.u32(win, 0x584);
      entry.accelerators = {};
      for (let i = 0; i < 0xff; i++) { const target = W.ptr(win, 0x188 + 4 * i); if (target) entry.accelerators[i] = ref(target); }
    }
    if (family === 'root') {
      entry.focus = ref(W.ptr(win, 0x5c8)); entry.keyboardGrab = W.i32(win, 0x5d0);
      entry.keysDown = []; for (let k = 0; k < 0xff; k++) if (W.u8(win, 0x630 + k)) entry.keysDown.push(k);
    }
    return [spec.id, entry];
  }));
  // The engine objects of a gameEngineKey/inputExtKey step (the oracle's fakes).
  const engineServices = step => ({
    console: () => step.console ?? true ? 'console' : null,
    keyType(console, byte) {
      events.push({op: 'FindFunctionChecked', object: console, name: 820, global: 0});
      events.push({op: 'ProcessEvent', object: console, function: 'FindFunctionChecked(820,0)', key: byte, result: 0});
      return step.keyType ?? 0;
    },
    input: () => step.input ?? true ? 'input' : null,
    isInputExt: () => step.inputExt ?? true,
    actor: () => step.actor ?? true ? 'actor' : null,
    isPlayerPawnExt: () => step.playerPawnExt ?? true,
    rootWindow: () => windows.get(step.root) ?? null,
    rootKey: (root, key) => TK.rootKey(W, root, key),
  });
  const at = id => windows.get(id);
  const steps = [];
  for (const step of c.steps) {
    const mark = events.length;
    let result = null;
    try {
      switch (step.op) {
        case 'gameEngineKey': result = TK.gameEngineKey('viewport', step.key, engineServices(step)); break;
        case 'inputExtKey': result = TK.inputExtKey('input', step.key, engineServices(step)); break;
        case 'rootKey': result = TK.rootKey(W, at(step.root), step.key); break;
        case 'handleKeyboard': result = TK.handleKeyboard(W, at(step.root), step.key, tree); break;
        case 'keyPressed': result = W.v.keyPressed(at(step.win), step.key & 0xffff); break;
        case 'acceleratorKeyPressed': result = W.v.acceleratorKeyPressed(at(step.win), step.key & 0xffff); break;
        case 'isCurrentModal': result = TK.isCurrentModal(W, at(step.win), tree); break;
        case 'getAcceleratorWindow': result = ref(TK.getAcceleratorWindow(W, at(step.win), step.key, F.buildAcceleratorTable) || null); break;
        case 'keyDown': W.setU8(at(step.root), 0x630 + step.key, step.value ?? 1); break;
        case 'set': if (step.windowValue) W.setPtr(at(step.win), step.offset, at(step.windowValue)); else W.setU32(at(step.win), step.offset, step.value); break;
        default: throw new Error(`unknown op ${step.op}`);
      }
    } catch (error) {
      if (!/assertion \(line 0x648\)/.test(error.message)) throw error;
      steps.push({stopped: 'appFailAssert line 0x648', events: events.slice(mark)});
      break;
    }
    steps.push({result, events: events.slice(mark), state: snapshot()});
  }
  return {steps};
}

let steps = 0, stops = 0;
for (const [index, c] of cases.entries()) {
  const expected = original[index];
  const stopped = expected.steps.find(step => step.stopped);
  if (stopped && !stopped.stopped.startsWith('appFailAssert')) throw new Error(`${c.name}: the original run stopped: ${JSON.stringify(stopped)}`);
  const actual = translate(c, TK);
  assert.equal(actual.steps.length, expected.steps.length, `${c.name}: step count`);
  for (const [i, step] of expected.steps.entries())
    assert.deepEqual(actual.steps[i], step, `${c.name}, step ${i} ${JSON.stringify(c.steps[i])}`);
  steps += expected.steps.length; stops += stopped ? 1 : 0;
}

// ---- mutations: each deliberately wrong copy of the module must diverge ----
const MUTATIONS = [
  ['if (!W.i32(root, ROOT_INPUT.keyboardGrab)) return 0;', 'if (W.i32(root, ROOT_INPUT.keyboardGrab) <= 0) return 0;', 'Key needs a positive grab count'],
  ['  W.v.handleKeyboard(root, key);\n  return 1;', '  return W.v.handleKeyboard(root, key) ? 1 : 0;', 'Key returns HandleKeyboard\'s result'],
  ["while (child && W.u8(child, O.type) < 2) child = lowerSibling(W, child, 1);\n    target = child || root;", "target = child || root;", 'HandleKeyboard takes the top child of any type'],
  ['if (W.u8(win, O.type) >= 2 || !isKeyDown(W, root, IK_ALT, getRootWindow))', 'if (true)', 'Alt does not skip type < 2 windows'],
  ['W.v.keyPressed(win, key & 0xffff)', 'W.v.keyPressed(win, key & 0xff)', 'KeyPressed gets a byte'],
  ["(key & 0xffff) ? String.fromCharCode(key & 0xffff) : ''", 'String.fromCharCode(key & 0xffff)', 'key 0 builds a one-character string'],
  ['  if (!result && isCurrentModal(W, win, tree) && isKeyDown(W, win, IK_ALT, tree.getRootWindow)) {', '  if (!result && isKeyDown(W, win, IK_ALT, tree.getRootWindow)) {', 'accelerators without IsCurrentModal'],
  ['  if (!key || key >= 0xff) return 0;', '  if (!key || key > 0xff) return 0;', 'GetAcceleratorWindow accepts 0xff'],
  ['  buildAcceleratorTable(W, modal);\n', '', 'GetAcceleratorWindow skips BuildAcceleratorTable'],
  ['  if (console && S.keyType(console, key & 0xff)) return 1;', '  if (console && S.keyType(console, key)) return 1;', 'KeyType gets the whole key'],
  ['  return input && S.isInputExt(input) ? inputExtKey(input, key, S) : 0;', '  return input ? inputExtKey(input, key, S) : 0;', 'no IsA(XInputExt) test'],
  ["  return (child || root) === win ? 1 : 0;", "  return child === win ? 1 : 0;", 'IsCurrentModal without the root fallback'],
];
const moduleFile = new URL('../src/runtime/script-window-typed-keys.mjs', import.meta.url);
const source = readFileSync(moduleFile, 'utf8');
const caught = [], missed = [];
for (const [i, [find, replace, note]] of MUTATIONS.entries()) {
  const hits = source.split(find).length - 1;
  if (hits !== 1) throw new Error(`mutation ${i} (${note}): find string occurs ${hits} times`);
  const file = new URL(`../src/runtime/.mut-typed-keys-${process.pid}-${i}.mjs`, import.meta.url);
  writeFileSync(file, source.replace(find, replace));
  try {
    const M = await import(file.href);
    let detail = null;
    for (const [index, c] of cases.entries()) {
      let actual;
      try { actual = translate(c, M); } catch { detail = `${c.name}: threw`; break; }
      if (!isDeepStrictEqual(actual.steps, original[index].steps)) { detail = c.name; break; }
    }
    (detail ? caught : missed).push(`${note}${detail ? ` -> ${detail}` : ''}`);
  } finally { rmSync(file, {force: true}); }
}
if (missed.length) throw new Error(`undetected mutations: ${missed.join('; ')}`);
if (process.env.TYPED_KEY_VERBOSE) console.log(caught.join('\n'));
console.log(JSON.stringify({cases: cases.length, steps, assertions: stops, vtables: Object.keys(vtables).length, mismatches: 0,
  mutations: `${caught.length}/${MUTATIONS.length} detected`}));
