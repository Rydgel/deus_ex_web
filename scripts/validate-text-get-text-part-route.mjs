/** TextWindow.GetTextPart (native 1554) as Play dispatches it: the window host's string form (script-window-host-natives.mjs) against the
 * original exec body's results (scripts/native-text-get-text-part-oracle.py, the cases of scripts/textwindow-cases.json section
 * getTextPart). The memory-cell translation (script-text-get-text-part.mjs) has its own validator
 * (validate-text-get-text-part.mjs); the dispatcher shares its FString::Mid bounds (midRange) and does the slice on the window's
 * JavaScript string. The exec-diff harness cannot run this exec as a leaf (it allocates through GMalloc), hence this check.
 * Needs NATIVE_PROBE_PYTHON. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import {dispatchWindowHostNative} from '../src/runtime/script-window-host-natives.mjs';
import {gameDirectory} from './game-directory.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const cases = JSON.parse(readFileSync(new URL('./textwindow-cases.json', import.meta.url), 'utf8')).getTextPart;
const original = JSON.parse(execFileSync(python, [new URL('./native-text-get-text-part-oracle.py', import.meta.url).pathname, gameDirectory()],
  {encoding: 'utf8', maxBuffer: 1 << 26})).cases;

let compared = 0;
for (const [name, spec] of Object.entries(cases)) {
  const heap = createNativeHeap({capacity: 1 << 20}), win = {name: 'TextWindow'};
  heap.allocate(win, 0x200);
  if (spec.spec.text !== null) heap.write(win, 0x168, 'string', spec.spec.text);
  const W = {heap};
  let written = null;
  const outArgument = spec.args[2];
  const values = [spec.args[0].int, spec.args[1].int,
    'outString' in outArgument ? {reference: true, set: v => { written = v; }} : 0];
  const result = dispatchWindowHostNative(W, {index: 1554, receiver: win, argumentCount: 3, evaluateArgument: i => values[i]});
  assert.equal(result.handled, true, `${name}: not routed`);
  const want = original[name].result;
  assert.equal(result.value, want.value, `${name}: result`);
  if (want.out === null) assert.equal(written, null, `${name}: no destination`);
  else assert.equal(written === '' ? null : written, want.out.text, `${name}: OutText`);
  compared++;
}
console.log(JSON.stringify({cases: compared, mismatches: 0}));
