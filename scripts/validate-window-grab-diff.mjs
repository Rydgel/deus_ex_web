/** Modal input grabs against the original Extension.dll bodies.
 *
 * scripts/native-window-grab-oracle.py runs the unchanged
 * XModalWindow::VisibilityChanged 0x10037330, the XRootWindow Grab/Ungrab
 * Keyboard/Mouse counters and IsMouseButton 0x1003a2c0; the same cases run
 * through src/runtime/script-window-input.mjs, comparing every step's events,
 * both grab counts and all 256 key-down bytes. docs/script-window-input.md. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import * as Input from '../src/runtime/script-window-input.mjs';
import {gameDirectory} from './game-directory.mjs';

const held = Array.from({length: 0x100}, (_, key) => (key * 7 + 1) & 0xff || 1);
const cases = [
  {name: 'IsMouseButton over every key', steps: [{op: 'isMouseButton'}]},
  {name: 'first keyboard grab clears held non-mouse keys, nested grabs only count', keyDown: held,
    steps: [{op: 'grabKeyboard'}, {op: 'grabKeyboard'}, {op: 'ungrabKeyboard'}, {op: 'ungrabKeyboard'},
      {op: 'ungrabKeyboard'}, {op: 'grabKeyboard'}]},
  {name: 'first mouse grab clears held mouse keys only', keyDown: held,
    steps: [{op: 'grabMouse'}, {op: 'grabMouse'}, {op: 'ungrabMouse'}, {op: 'ungrabMouse'}, {op: 'ungrabMouse'}]},
  {name: 'negative counts still clear and then increment', keyDown: held, keyboardGrab: -3, mouseGrab: -1,
    steps: [{op: 'grabKeyboard'}, {op: 'grabMouse'}, {op: 'ungrabKeyboard'}, {op: 'ungrabMouse'}]},
  {name: 'a parented modal grabs on show and ungrabs on hide', keyDown: held,
    steps: [{op: 'visibilityChanged', visible: 1}, {op: 'visibilityChanged', visible: 1},
      {op: 'visibilityChanged', visible: 0}, {op: 'visibilityChanged', visible: 0}, {op: 'visibilityChanged', visible: 0}]},
  {name: 'a nonzero UBOOL other than 1 is visible', keyDown: held, steps: [{op: 'visibilityChanged', visible: 0x80000000}]},
  {name: 'an unparented modal only runs the script event', keyDown: held, parent: false,
    steps: [{op: 'visibilityChanged', visible: 1}, {op: 'visibilityChanged', visible: 0}]},
  {name: 'a modal without a root only runs the script event', keyDown: held, rootFound: false,
    steps: [{op: 'visibilityChanged', visible: 1}]},
];

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const run = spawnSync(python, ['scripts/native-window-grab-oracle.py', gameDirectory()],
  {input: JSON.stringify({cases}), encoding: 'utf8', maxBuffer: 64e6});
if (run.status !== 0) throw new Error(`grab oracle failed: ${run.stderr || run.stdout}`);
const original = JSON.parse(run.stdout).results;

function translate(c) {
  const heap = createNativeHeap(), events = [];
  const root = {}, modal = {};
  heap.allocate(root, 0x740); heap.allocate(modal, 0x588);
  const names = new Map([[root, 'root'], [modal, 'modal']]);
  const W = {
    heap,
    u8: (o, off) => heap.read(o, off, 'u8'), i32: (o, off) => heap.read(o, off, 'i32'), ptr: (o, off) => heap.read(o, off, 'ptr'),
    setU8: (o, off, v) => heap.write(o, off, 'u8', v & 0xff), setI32: (o, off, v) => heap.write(o, off, 'i32', v | 0),
    setPtr: (o, off, v) => heap.write(o, off, 'ptr', v),
    processScript: (win, event, [visible]) => events.push({op: 'ProcessScript', window: names.get(win), value: null, third: 0, visible}),
  };
  W.setI32(root, 0x5d0, c.keyboardGrab ?? 0); W.setI32(root, 0x5cc, c.mouseGrab ?? 0);
  (c.keyDown ?? []).forEach((value, key) => W.setU8(root, 0x630 + key, value));
  W.setPtr(modal, 0x138, c.parent === false ? null : root);
  const getRootWindow = (_, win) => { events.push({op: 'GetRootWindow', window: names.get(win)}); return c.rootFound === false ? null : root; };
  const snapshot = () => ({keyboardGrab: W.i32(root, 0x5d0), mouseGrab: W.i32(root, 0x5cc),
    keyDown: Array.from({length: 0x100}, (_, key) => W.u8(root, 0x630 + key))});
  return {steps: c.steps.map(step => {
    const mark = events.length;
    let result = null;
    if (step.op === 'isMouseButton') result = Array.from({length: 0x100}, (_, key) => Input.isMouseButton(key));
    else if (step.op === 'visibilityChanged') Input.modalVisibilityChanged(W, modal, step.visible, getRootWindow);
    else ({grabKeyboard: Input.grabKeyboardEvents, ungrabKeyboard: Input.ungrabKeyboardEvents,
      grabMouse: Input.grabMouseEvents, ungrabMouse: Input.ungrabMouseEvents})[step.op](W, root);
    return {result, events: events.slice(mark), state: snapshot()};
  })};
}

let steps = 0;
for (const [index, c] of cases.entries()) {
  const expected = original[index];
  assert.ok(expected.steps.every(step => !step.stopped), `${c.name}: the original run stopped: ${JSON.stringify(expected.steps.at(-1))}`);
  const actual = translate(c);
  // The script event's parameter block holds the raw UBOOL; the translation
  // passes the VM a bool, so compare its truth with the original dword.
  for (const [i, step] of actual.steps.entries()) for (const [j, event] of step.events.entries()) {
    if (event.op !== 'ProcessScript') continue;
    const original = expected.steps[i].events[j];
    assert.equal(original?.op, 'ProcessScript', c.name);
    assert.equal(event.visible, original.value !== 0, `${c.name}: VisibilityChanged argument`);
    assert.equal(original.third, 0, `${c.name}: VisibilityChanged is an unchecked ProcessScript`);
    Object.assign(event, {value: original.value, third: original.third}); delete event.visible;
  }
  assert.deepEqual(actual, expected, c.name);
  steps += c.steps.length;
}
console.log(JSON.stringify({cases: cases.length, steps, mismatches: 0}));
