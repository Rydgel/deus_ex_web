/** Window timers against the original Extension.dll bodies.
 *
 * The oracle (scripts/native-window-timer-oracle.py) runs the unchanged
 * XWindow::AddTimer 0x1004fc20, RemoveTimer 0x1004fd20, InvokeTimers
 * 0x10051340 and XButtonWindow::AddActivateTimer 0x10008510 /
 * RemoveActivateTimer 0x10008480, with InvokeTimers reaching the original
 * XWindow::Timer / XButtonWindow::Timer virtuals. The same cases run through
 * src/runtime/script-window-timers.mjs over a native heap, and every step's
 * return value, events and both timer lists are compared exactly (floats as
 * bits). docs/script-window-input.md. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import * as Timers from '../src/runtime/script-window-timers.mjs';
import {gameDirectory} from './game-directory.mjs';

const bits = value => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); };
const float = raw => { const view = new DataView(new ArrayBuffer(4)); view.setUint32(0, raw >>> 0, true); return view.getFloat32(0, true); };
const W1 = id => ({id}), B1 = (id, extra = {}) => ({id, family: 'button', ...extra});
const add = (win, timeout, extra = {}) => ({op: 'addTimer', win, timeout: bits(timeout), ...extra});
const invoke = (win, delta) => ({op: 'invoke', win, delta: bits(delta)});
const cases = [
  {name: 'one-shot named timer fires once, frees its node, and the node is reused',
    windows: [W1('w')], names: ['KeypadDelay'], now: 10.5, last: 10.0,
    steps: [add('w', 1, {name: 'KeypadDelay', clientData: 7}), invoke('w', 0.5), invoke('w', 1.25),
      add('w', 2, {name: 'KeypadDelay'}), invoke('w', 0)]},
  {name: 'looping nameless timers compute invocations and carry the remainder',
    windows: [W1('w')], now: 3.25, last: 3.0,
    steps: [add('w', 0.1, {loop: 1}), add('w', 0.001, {loop: 1, clientData: -5}), invoke('w', 0.35),
      invoke('w', 1.7), invoke('w', 0.0999), invoke('w', 12.5)]},
  {name: 'looping named timers report their invocation counts to the timer function',
    windows: [W1('w')], names: ['Tick'], now: 7.1, last: 7.0,
    steps: [add('w', 0.1, {loop: 1, name: 'Tick'}), invoke('w', 0.35), invoke('w', 1.7),
      add('w', 0.001, {loop: 1, name: 'Tick', clientData: 3}), invoke('w', 12.5), invoke('w', 0.3), invoke('w', 0.0999)]},
  {name: 'list order, head/middle/tail removal, unknown and zero ids',
    windows: [W1('w')], names: ['A', 'B', 'C', 'D'], now: 1, last: 1,
    steps: [add('w', 1, {name: 'A'}), add('w', 2, {name: 'B'}), add('w', 3, {name: 'C'}), add('w', 4, {name: 'D'}),
      {op: 'removeTimer', win: 'w', timer: 2}, {op: 'removeTimer', win: 'w', timer: 3},
      {op: 'removeTimer', win: 'w', timer: 0}, {op: 'removeTimer', win: 'w', timer: 0x12345678},
      {op: 'removeTimer', win: 'w', timer: null}, {op: 'removeTimer', win: 'w', timer: 2},
      add('w', 5, {name: 'A'}), add('w', 6, {name: 'B'}), invoke('w', 3.5)]},
  {name: 'timeouts below 1e-6, zero, negative and NaN become 1e-6f',
    windows: [W1('w')], now: 0, last: 0,
    steps: [add('w', 0), add('w', -2), add('w', 1e-7), {op: 'addTimer', win: 'w', timeout: 0x7fc00000},
      add('w', 1e-6), add('w', 2e-6), invoke('w', 1e-6), invoke('w', 1e-6)]},
  {name: 'a window being destroyed refuses add, remove and invoke',
    windows: [W1('w'), {id: 'd', flags: 0x10}], names: ['T'], now: 0, last: 0,
    steps: [add('d', 1, {name: 'T'}), add('w', 1, {name: 'T'}), {op: 'setFlags', win: 'w', flags: 0x10},
      {op: 'removeTimer', win: 'w', timer: 0}, invoke('w', 5), {op: 'setFlags', win: 'w', flags: 0}, invoke('w', 5)]},
  {name: 'a timer function that destroys its window stops the walk and unlocks into SafeDestroy',
    windows: [W1('w')], names: ['First', 'Second'], now: 0, last: 0,
    onScript: {'Second#1': {flags: 0x10}},
    steps: [add('w', 1, {name: 'First'}), add('w', 1, {name: 'Second'}), invoke('w', 2)]},
  {name: 'button activate timer: press delay, re-arm, and XButtonWindow::Timer release',
    windows: [B1('b', {buttonFlags: 3, activateDelay: bits(0.1)})], names: ['Other'], now: 0, last: 0,
    steps: [{op: 'addActivateTimer', win: 'b'}, {op: 'addActivateTimer', win: 'b'}, add('b', 0.05),
      add('b', 0.5, {name: 'Other'}), invoke('b', 0.2), invoke('b', 0.4), {op: 'addActivateTimer', win: 'b'},
      {op: 'removeActivateTimer', win: 'b'}, {op: 'removeActivateTimer', win: 'b'}, invoke('b', 1)]},
  {name: 'a nameless timer on a plain window reaches the no-op XWindow::Timer',
    windows: [W1('w')], now: 0, last: 0, steps: [add('w', 0.5), invoke('w', 1)]},
  {name: 'remaining exactly zero does not fire',
    windows: [W1('w')], names: ['Z'], now: 0, last: 0, steps: [add('w', 0.5, {name: 'Z'}), invoke('w', 0.5), invoke('w', 1e-7)]},
];

// ---- original ------------------------------------------------------------
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const run = spawnSync(python, ['scripts/native-window-timer-oracle.py', gameDirectory()],
  {input: JSON.stringify({cases}), encoding: 'utf8', maxBuffer: 64e6});
if (run.status !== 0) throw new Error(`timer oracle failed: ${run.stderr || run.stdout}`);
const original = JSON.parse(run.stdout).results;

// ---- translation ---------------------------------------------------------
function translate(c) {
  const heap = createNativeHeap();
  const events = [], allocations = [], windows = new Map(), names = new Map();
  const W = {
    heap,
    u8: (o, off) => heap.read(o, off, 'u8'), u32: (o, off) => heap.read(o, off, 'u32'),
    i32: (o, off) => heap.read(o, off, 'i32'), f32: (o, off) => heap.read(o, off, 'f32'),
    setU32: (o, off, v) => heap.write(o, off, 'u32', v >>> 0), setI32: (o, off, v) => heap.write(o, off, 'i32', v | 0),
    setF32: (o, off, v) => heap.write(o, off, 'f32', Math.fround(v)),
    tickOffset: () => Timers.windowsTickOffset(c.now ?? 0, c.last ?? 0),
    allocTimerNode: () => { const node = {}; heap.allocate(node, 0x20); allocations.push(heap.addressOf(node)); events.push({op: 'Malloc', size: 32}); return node; },
    processScript: (win, name, [timer, invocations, clientData]) => {
      events.push({op: 'ProcessScript', window: names.get(win), name, timer: ref(timer), invocations, clientData: clientData >>> 0});
      const action = c.onScript?.[`${name}#${invocations}`];
      if (action) W.setU32(win, 0x30, action.flags);
    },
    v: {timer: (win, id) => { if (families.get(win) === 'button') Timers.buttonTimer(W, win, id,
      target => events.push({op: 'ChangeButtonAppearance', window: names.get(target)})); }},
    native: {safeDestroy: win => events.push({op: 'SafeDestroy', window: names.get(win)})},
  };
  const families = new Map();
  const ref = address => !address ? null : allocations.includes(address >>> 0) ? allocations.indexOf(address >>> 0) : `0x${(address >>> 0).toString(16).padStart(8, '0')}`;
  const nameText = ['None', ...(c.names ?? [])];
  const list = head => {
    const nodes = [];
    for (let node = head; node; node = W.u32(node, 0x1c)) nodes.push({node: ref(node), timeout: W.u32(node, 0), remaining: W.u32(node, 4),
      name: heap.read(node, 8, 'name'), loop: W.u32(node, 0xc), clientData: W.u32(node, 0x10), inUse: W.u32(node, 0x14), removed: W.u32(node, 0x18)});
    return nodes;
  };
  const snapshot = () => Object.fromEntries(c.windows.map(spec => {
    const win = windows.get(spec.id);
    const state = {flags: W.u32(win, 0x30), timers: list(W.u32(win, 0x128)), free: list(W.u32(win, 0x12c))};
    if (families.get(win) === 'button') { state.buttonFlags = W.u32(win, 0x174); state.activateTimer = ref(W.u32(win, 0x198)); }
    return [spec.id, state];
  }));
  for (const spec of c.windows) {
    const win = {id: spec.id};
    heap.allocate(win, spec.family === 'button' ? 0x1ec : 0x160);
    W.setU32(win, 0x30, spec.flags ?? 0);
    if (spec.family === 'button') { W.setU32(win, 0x174, spec.buttonFlags ?? 0); W.setU32(win, 0x178, spec.activateDelay ?? 0); }
    windows.set(spec.id, win); names.set(win, spec.id); families.set(win, spec.family ?? 'window');
  }
  const steps = [];
  for (const step of c.steps) {
    const mark = events.length, win = windows.get(step.win);
    let result = null;
    if (step.op === 'addTimer') result = ref(Timers.addTimer(W, win, float(step.timeout), step.loop ?? 0, step.clientData ?? 0,
      step.name ? nameText[nameText.indexOf(step.name)] : 'None'));
    else if (step.op === 'removeTimer') {
      const target = step.timer;
      Timers.removeTimer(W, win, Number.isInteger(target) && target >= 0 && target < allocations.length ? allocations[target] : (target ?? 0));
    } else if (step.op === 'invoke') Timers.invokeTimers(W, win, float(step.delta));
    else if (step.op === 'setFlags') W.setU32(win, 0x30, step.flags);
    else if (step.op === 'addActivateTimer') Timers.addActivateTimer(W, win);
    else if (step.op === 'removeActivateTimer') Timers.removeActivateTimer(W, win);
    steps.push({result, events: events.slice(mark), state: snapshot()});
  }
  return {steps};
}

let compared = 0;
for (const [index, c] of cases.entries()) {
  const expected = original[index];
  assert.ok(expected.steps.every(step => !step.stopped), `${c.name}: the original run stopped: ${JSON.stringify(expected.steps.at(-1))}`);
  assert.deepEqual(translate(c), expected, c.name);
  compared += c.steps.length;
}
console.log(JSON.stringify({cases: cases.length, steps: compared, mismatches: 0}));
