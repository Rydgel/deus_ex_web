/** The script native GotoState (113) against the original's execGotoState / UObject::GotoState / GotoLabel (Core.dll 0x1013dd00,
 * 0x1012e8f0, 0x1012eb10) running unchanged under Unicorn (scripts/native-goto-state-oracle.py).
 *
 * What the original does, and Play must: the exec reads (NewState, Label) with the current state's name and None as defaults; when the
 * state named is the one the object is in it calls GotoLabel only (ProbeMask kept, LatentAction cleared, Code at the label), otherwise
 * GotoState (ProbeMask = (class | state) & state ignore mask, Code cleared, Node/StateNode = the state) and then GotoLabel; the label
 * None means Begin. UObject::GotoState called directly for the state the object is already in recomputes the ProbeMask and clears Code
 * (the 0x1012ea1f block), which only native callers reach: no script GotoState does. Play's `ScriptState.transition` is that body.
 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {ScriptState} from '../src/runtime/script-state.mjs';
import {gameDirectory} from './game-directory.mjs';

const {stdout} = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3', ['scripts/native-goto-state-oracle.py', gameDirectory()], {maxBuffer: 1 << 20, timeout: 120000});
const original = JSON.parse(stdout).cases;

// The oracle's names: states 1001 (S1) and 1002 (S2), labels 1101/1102 in S1, 1201 and Begin(100) in S2.
const NAMES = new Map([[1001, 'S1'], [1002, 'S2'], [1101, 'L1'], [1102, 'L2'], [1201, 'L3'], [100, 'Begin']]);
const CLASS = {probeMask: [1, 0], ignoreMask: [0xffffffff, 0xffffffff]};
const INITIAL_MASK = [0xa5a5a5a5, 0x5a5a5a5a];

function node(name, labels, probe) {
  const offsets = new Set(Object.values(labels));
  return {record: {name, key: name.toLowerCase()}, base: null, labels: new Map(Object.entries(labels).map(([k, v]) => [k.toLowerCase(), v])),
    script: {probeMask: [probe, 0], ignoreMask: [0xffffffff, 0xffffffff]},
    compiled: {decoded: {statements: offsets}, createFrame: (instance, locals, services, {offset}) => ({cursor: offset, returned: false, resume() {}})}};
}
const S1 = node('S1', {L1: 0x10, L2: 0x20}, 0x100), S2 = node('S2', {L3: 0x30, Begin: 0x04}, 0x200);

/** An object in S1 with the oracle's fixture: ProbeMask poisoned, LatentAction 0x55, Code mid-script. */
function fixture() {
  const instance = {cls: {metadata: CLASS}};
  const state = new ScriptState(instance, {});
  state.setStateNode(S1);
  state.probeMask = INITIAL_MASK;
  const execution = {cursor: 0x40, returned: false, resume() {}};
  state.execution = execution; state.codeNode = S1; state.latentAction = 0x55;
  instance.state = state;
  const runtime = Object.create(ScriptRuntime.prototype);
  Object.assign(runtime, {
    instance: () => instance,
    lookupMember: (cls, kind, name) => ({key: name, name}),
    states: new Map([['s1', S1], ['s2', S2]]),
    boundaryNatives: new Set(), scriptVm: null, collisionViewActors: new WeakSet(), instances: new Map(),
  });
  return {runtime, instance, state};
}
const observe = state => ({
  stateNode: state.stateNode?.record.name ?? null,
  probeMask: [...state.probeMask],
  latent: state.latent,
  code: state.execution?.cursor ?? null,
});
const expected = c => ({stateNode: c.stateNode, probeMask: c.probeMask, latent: c.latent, code: c.code});

// UObject::GotoState direct (native callers): ScriptState.transition is its body.
for (const [name, state] of [['nativeSameState', S1], ['nativeDifferentState', S2]]) {
  const {state: s} = fixture();
  s.transition(state, CLASS);
  assert.deepEqual(observe(s), expected(original[name]), name);
}

// The exec wrapper: native 113 through ScriptRuntime.invokeNative with the script's parameters (undefined = EX_Nothing).
function exec(params) {
  const {runtime, state} = fixture();
  runtime.invokeNative({index: 113, receiver: {}, argumentCount: params.length, evaluateArgument: i => params[i]});
  return observe(state);
}
const name = index => (index === undefined ? undefined : NAMES.get(index));
for (const [label, params] of [
  ['execNoParameters', [undefined, undefined]],
  ['execSameStateNoLabel', [1001, undefined]],
  ['execSameStateLabel', [1001, 1101]],
  ['execDifferentStateNoLabel', [1002, undefined]],
  ['execDifferentStateLabel', [1002, 1201]],
]) {
  assert.ok(!original[label].error, `${label}: ${original[label].error}`);
  assert.deepEqual(exec(params.map(name)), expected(original[label]), label);
}
// The original reports a missing explicitly-named label (a log, not a state change); the fixture does not model the log's formatter.
assert.ok(original.execSameStateBeginDefault.error, 'an explicit missing label reaches the original\'s warning path');

// The same-state exec keeps the mask where UObject::GotoState would have recomputed it: the two bodies differ on the poisoned mask.
assert.notDeepEqual(original.nativeSameState.probeMask, original.execSameStateNoLabel.probeMask);
assert.deepEqual(original.execSameStateNoLabel.entered, [['GotoLabel', 100]]);
assert.deepEqual(original.execDifferentStateLabel.entered, [['GotoState', 1002], ['GotoLabel', 1201]]);
console.log('Native GotoState: 2 direct-body and 5 exec cases equal the original (Core 0x1012e8f0, 0x1013dd00, 0x1012eb10); a same-state script GotoState runs GotoLabel only');
