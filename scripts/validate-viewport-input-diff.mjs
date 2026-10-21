/** The input events a Windows message delivers, against the original WinDrv.dll (docs/input-bindings.md "What WinDrv delivers").
 *
 * scripts/native-viewport-input-oracle.py runs the unchanged UWindowsViewport::ViewportWndProc (0x11109b30) and CauseInputEvent
 * (0x11108d60) over a fake viewport and engine and returns, for each message, the engine's InputEvent calls in order. The page's
 * translations are compared with it:
 *  - WM_MOUSEWHEEL (and the registered MSWHEEL_ROLLMSG): src/viewer/wheel-input.mjs `wheelMessage` for deltas of several notches,
 *    a single unit, the signed 16-bit limits and zero, whatever the low word of wParam holds;
 *  - WM_KEYDOWN / WM_KEYUP / WM_SYSKEYDOWN / WM_SYSKEYUP: a Windows virtual-key code is the EInputKey value, so the key the page
 *    resolves for a KeyboardEvent.code (src/viewer/input-key-names.mjs against the Engine.u table) is the one the original gets;
 *    Alt+Enter is ToggleFullscreen and no event;
 *  - WM_LBUTTON*, WM_RBUTTON*, WM_MBUTTON*: keys 1, 2 and 4 (src/viewer/window-pointer.mjs), pressed and released;
 *    the double-click and XBUTTON messages deliver no input event.
 * Needs NATIVE_PROBE_PYTHON (the Unicorn environment). */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {createInputConsole} from '../src/runtime/script-input-console.mjs';
import {GAME_KEY_CODES, inputKeyForCode} from '../src/viewer/input-key-names.mjs';
import {pointerButtonKey} from '../src/viewer/window-pointer.mjs';
import {wheelMessage} from '../src/viewer/wheel-input.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
const names = (await createInputConsole(runtime, assets)).names;

const WM = {keydown: 0x100, keyup: 0x101, syskeydown: 0x104, syskeyup: 0x105, mousemove: 0x200, lbuttondown: 0x201, lbuttonup: 0x202, lbuttondblclk: 0x203,
  rbuttondown: 0x204, rbuttonup: 0x205, rbuttondblclk: 0x206, mbuttondown: 0x207, mbuttonup: 0x208, mbuttondblclk: 0x209, mousewheel: 0x20a,
  xbuttondown: 0x20b, xbuttonup: 0x20c, xbuttondblclk: 0x20d};
const LEGACY = 0xc123;        // the registered MSWHEEL_ROLLMSG id the oracle stores in Window.dll's WindowMessageMouseWheel
const IST = {press: 1, release: 3, axis: 4};
const cases = [];
const add = (label, kase) => { cases.push({label, ...kase}); };

// ---- the wheel ----------------------------------------------------------------------------------------------------------------------------
const deltas = [120, -120, 240, -240, 360, 1, -1, 60, -60, 32767, -32768, 0];
for (const delta of deltas) {
  const high = (delta & 0xffff) << 16;
  for (const flags of [0, 0x8, 0x4, 0x28]) add(`wheel ${delta} flags ${flags}`, {message: WM.mousewheel, wParam: (high | flags) >>> 0, lParam: 0x00640064, wheel: delta});
  add(`legacy wheel ${delta}`, {message: LEGACY, wParam: delta & 0xffff, lParam: 0, wheel: delta});
}
// ---- the keys: every code the page maps, as the VK a Windows keyboard sends --------------------------------------------------------------
const VK = {Escape: 0x1b, Enter: 0x0d, NumpadEnter: 0x0d, Backspace: 8, Tab: 9, Space: 0x20, ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11,
  AltLeft: 0x12, AltRight: 0x12, ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27, Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21,
  PageDown: 0x22, Pause: 0x13, CapsLock: 0x14, NumLock: 0x90, ScrollLock: 0x91, PrintScreen: 0x2c, Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd,
  Period: 0xbe, Slash: 0xbf, Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde, NumpadMultiply: 0x6a, NumpadAdd: 0x6b,
  NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f};
const vkOf = code => {
  let match;
  if ((match = /^Digit([0-9])$/.exec(code))) return 0x30 + Number(match[1]);
  if ((match = /^Key([A-Z])$/.exec(code))) return match[1].charCodeAt(0);
  if ((match = /^Numpad([0-9])$/.exec(code))) return 0x60 + Number(match[1]);
  if ((match = /^F([0-9]+)$/.exec(code))) return 0x70 + Number(match[1]) - 1;
  return VK[code];
};
for (const code of GAME_KEY_CODES) {
  const vk = vkOf(code);
  assert.ok(vk, `${code} has a Windows virtual-key code`);
  add(`${code} down`, {message: WM.keydown, wParam: vk, lParam: 0, code, vk});
  add(`${code} up`, {message: WM.keyup, wParam: vk, lParam: 0, code, vk});
  if (vk === 0x12 || vk >= 0x70 && vk <= 0x7b) { add(`${code} sys down`, {message: WM.syskeydown, wParam: vk, lParam: 0, code, vk}); add(`${code} sys up`, {message: WM.syskeyup, wParam: vk, lParam: 0, code, vk}); }
}
add('Alt+Enter', {message: WM.keydown, wParam: 0x0d, lParam: 0, keyState: {18: 0x8000}, altEnter: true});
add('Enter without Alt', {message: WM.keydown, wParam: 0x0d, lParam: 0, keyState: {18: 0}});
add('Alt key state without the high bit', {message: WM.keydown, wParam: 0x0d, lParam: 0, keyState: {18: 0x0001}});
add('key 0 down', {message: WM.keydown, wParam: 0, lParam: 0, edge: [{key: 0, action: IST.press, delta: 0}]});          // CauseInputEvent: 0 <= key < 0xff
add('key 0xfe down', {message: WM.keydown, wParam: 0xfe, lParam: 0, edge: [{key: 0xfe, action: IST.press, delta: 0}]});
add('key 0xff down', {message: WM.keydown, wParam: 0xff, lParam: 0, edge: []});
add('key 0x100 down', {message: WM.keydown, wParam: 0x100, lParam: 0, edge: []});
// ---- the mouse buttons ---------------------------------------------------------------------------------------------------------------------
for (const [button, down, up, flag] of [[0, WM.lbuttondown, WM.lbuttonup, 1], [2, WM.rbuttondown, WM.rbuttonup, 2], [1, WM.mbuttondown, WM.mbuttonup, 16]]) {
  add(`button ${button} down`, {message: down, wParam: flag, lParam: 0x00640064, button});
  add(`button ${button} up`, {message: up, wParam: 0, lParam: 0x00640064, button});
}
for (const message of [WM.lbuttondblclk, WM.rbuttondblclk, WM.mbuttondblclk, WM.xbuttondown, WM.xbuttonup, WM.xbuttondblclk])
  add(`message ${message.toString(16)} delivers no input event`, {message, wParam: 0x00010001, lParam: 0x00640064, none: true});

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const run = spawnSync(python, ['scripts/native-viewport-input-oracle.py', root], {input: JSON.stringify({cases}), encoding: 'utf8', maxBuffer: 64e6});
if (run.status !== 0) throw new Error(`viewport input oracle failed: ${run.stderr || run.stdout}`);
const results = JSON.parse(run.stdout).results;
const inputEvents = result => result.events.filter(event => event.op === 'engine.InputEvent').map(({key, action, delta}) => ({key, action, delta}));

let checked = 0;
cases.forEach((kase, index) => {
  const result = results[index], events = inputEvents(result);
  if (kase.wheel !== undefined) {
    const expected = wheelMessage(kase.wheel).map(event => ({key: names.indexOf(`IK_${event.name}`), action: event.action, delta: event.delta}));
    assert.deepEqual(events, expected, kase.label);
    assert.ok(!result.stopped, kase.label);
    if (kase.wheel === 0) assert.deepEqual(events, [], 'a zero delta does nothing');
  } else if (kase.code) {
    const key = inputKeyForCode(names, kase.code);
    assert.equal(key, kase.vk, `${kase.code}: the page's EInputKey is the Windows virtual-key code`);
    const press = kase.message === WM.keydown || kase.message === WM.syskeydown;
    assert.deepEqual(events, [{key: kase.vk, action: press ? IST.press : IST.release, delta: 0}], kase.label);
  } else if (kase.altEnter) {
    assert.deepEqual(events, [], 'Alt+Enter delivers no input event');
    assert.deepEqual(result.events.map(event => event.op), ['GetKeyState', 'ToggleFullscreen']);
  } else if (kase.label.startsWith('Enter without') || kase.label.startsWith('Alt key state')) {
    assert.deepEqual(events, [{key: 13, action: IST.press, delta: 0}], kase.label);
  } else if (kase.button !== undefined) {
    const key = pointerButtonKey(kase.button);
    const press = [WM.lbuttondown, WM.rbuttondown, WM.mbuttondown].includes(kase.message);
    assert.deepEqual(events, [{key, action: press ? IST.press : IST.release, delta: 0}], kase.label);
    assert.equal(names[key], `IK_${['', 'LeftMouse', 'RightMouse', '', 'MiddleMouse'][key]}`);
  } else if (kase.none) {
    assert.deepEqual(events, [], kase.label);
  } else if (kase.edge) {
    assert.deepEqual(events, kase.edge, kase.label);
  }
  checked++;
});
console.log(`Viewport input passed: ${checked} messages (${deltas.length * 5} wheel, ${GAME_KEY_CODES.length} key codes, buttons, double-click and XBUTTON) against the original WinDrv window procedure.`);
if (process.env.DX_VERBOSE) for (const [index, kase] of cases.entries()) if (index % 7 === 0 || kase.altEnter || kase.none) console.log(kase.label.padEnd(36), JSON.stringify(inputEvents(results[index])), results[index].stopped ?? '');
