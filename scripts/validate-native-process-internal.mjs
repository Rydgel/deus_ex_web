/** Script function calls and the ProbeMask against the original's UObject::ProcessInternal (Core.dll 0x1013f690) running unchanged under
 * Unicorn (scripts/native-process-internal-oracle.py).
 *
 * ProcessInternal tests the function's name before it executes the bytecode: a probe name (index 0x12c to 0x16b) on an object with a
 * StateFrame runs only when that bit of the frame's ProbeMask is set, whoever made the call (script `A.Trigger()` or the engine's event),
 * so Disable('Trigger') silences both. Play's ScriptRuntime.callFunction (script to script) is checked on the same twelve cases.
 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {ScriptState} from '../src/runtime/script-state.mjs';
import {probeNames} from '../src/unreal/probe-names.mjs';
import {gameDirectory} from './game-directory.mjs';

const {stdout} = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3', ['scripts/native-process-internal-oracle.py', gameDirectory()], {maxBuffer: 1 << 20, timeout: 120000});
const original = JSON.parse(stdout).cases;

const nameOf = index => [...probeNames].find(([, v]) => v === index)?.[0] ?? 'ordinaryfunction';
const bit = n => (1 << n) >>> 0;
const CASES = {
  probeBitSet: [0x12c + 4, [bit(4), 0]],
  probeBitClear: [0x12c + 4, [bit(5), 0]],
  probeMaskZero: [0x12c + 4, [0, 0]],
  firstProbeBitClear: [0x12c, [0xfffffffe, 0xffffffff]],
  firstProbeBitSet: [0x12c, [1, 0]],
  word1BitClear: [0x12c + 40, [0xffffffff, bit(7)]],
  word1BitSet: [0x12c + 40, [0, bit(8)]],
  lastProbeBitClear: [0x16b, [0xffffffff, 0x7fffffff]],
  lastProbeBitSet: [0x16b, [0, 0x80000000]],
  firstOutsideRangeMaskZero: [0x16c, [0, 0]],
  belowRangeMaskZero: [0x12b, [0, 0]],
  noStateFrameProbeName: [0x12c + 4, [0, 0], false],
};

function play([name, mask, stateFrame = true]) {
  let ran = 0;
  const instance = {};
  if (stateFrame) { const state = new ScriptState(instance, {}); state.probeMask = mask; instance.state = state; }
  const runtime = Object.create(ScriptRuntime.prototype);
  Object.assign(runtime, {
    boundaryFunctions: new Map(), classLoader: null,
    instance: () => instance,
    executeScript: () => { ran++; return undefined; },
    destroyFunctionLocals: () => {},
  });
  const fn = {script: {nativeIndex: 0, functionFlags: 0}, parameters: [], fields: [], result: null};
  runtime.callFunction({key: `package.class.${nameOf(name)}`, function: fn}, {}, 0);
  return ran === 1;
}

for (const [label, args] of Object.entries(CASES)) assert.equal(play(args), original[label].bodyRan, label);
assert.ok(Object.values(original).some(c => !c.bodyRan) && Object.values(original).some(c => c.bodyRan));
console.log(`Script calls and the ProbeMask: ${Object.keys(CASES).length} cases equal the original's ProcessInternal (Core 0x1013f690): a masked probe-named function does not run`);
