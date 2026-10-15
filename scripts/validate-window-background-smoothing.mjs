/** Window.SetBackgroundSmoothing (native 1423): the translation against the unchanged Extension.dll path.
 *
 * Authority: Extension.dll exec 0x10051dc0 -> XWindow::SetBackgroundSmoothing 0x1004d700 -> XGC::EnableSmoothing
 * 0x100270e0 (docs/screen-flash.md "Drug effects"). scripts/native-window-background-smoothing-oracle.py runs the
 * x86 with GeneratePolyFlags 0x1002af00 as the one intercepted leaf. Per case the recorded raw accesses (window +0x38,
 * +0x130, XGC +0x48, in order), the GeneratePolyFlags events and the final fields must equal the translation's. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setBackgroundSmoothingNative } from '../src/runtime/script-window-background-style.mjs';
import { gameDirectory } from './game-directory.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const oracle = JSON.parse(execFileSync(python, ['scripts/native-window-background-smoothing-oracle.py', gameDirectory()],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));

const WINDOW = { id: 'window' }, GC = { id: 'gc' };
let compared = 0, generated = 0;
for (const original of oracle.cases) {
  const memory = { window: { 0x38: original.windowFlags, 0x130: original.gc ? GC : null }, gc: { 0x48: original.gcFlags } };
  const accesses = [], events = [];
  const regionOf = object => (object === WINDOW ? 'window' : 'gc');
  const services = {
    read: (object, offset) => {
      const value = memory[regionOf(object)][offset];
      accesses.push({ op: 'read', region: regionOf(object), offset, value: value === GC ? 'gc' : value });
      return value;
    },
    write: (object, offset, kind, value) => {
      memory[regionOf(object)][offset] = value;
      accesses.push({ op: 'write', region: regionOf(object), offset, value });
    },
    generatePolyFlags: ({ gc }) => events.push({ op: 'GeneratePolyFlags', receiver: regionOf(gc) }),
  };
  setBackgroundSmoothingNative({ window: WINDOW, newValue: original.argument }, services);
  // The oracle logs the window pointer read as the pointer value; compare it as present/absent.
  const normalize = list => list.map(a => ({ op: a.op, region: a.region, offset: a.offset,
    value: a.region === 'window' && a.offset === 0x130 ? (a.value ? 1 : 0) : a.value }));
  assert.deepEqual(normalize(accesses), normalize(original.accesses.map(a => ({ ...a, value: a.region === 'window' && a.offset === 0x130 ? (a.value ? 'gc' : 0) : a.value }))),
    JSON.stringify({ w: original.windowFlags, g: original.gcFlags, a: original.argument, gc: original.gc }));
  assert.deepEqual(events, original.events.map(e => ({ op: e.op, receiver: e.receiver === 'gc' ? 'gc' : 'other' })));
  assert.equal(memory.window[0x38], original.final.windowFlags >>> 0);
  assert.equal(memory.gc[0x48], original.final.gcFlags >>> 0);
  compared++;
  generated += events.length;
}
assert.ok(compared >= 350 && generated >= 175, `cases ${compared}, GeneratePolyFlags leaves ${generated}`);
console.log(`PASS validate-window-background-smoothing: ${compared} cases (window flags, XGC flags, int arguments, null and non-null XGC) equal to Extension.dll 0x1004d700/0x100270e0; ${generated} GeneratePolyFlags leaf calls`);
