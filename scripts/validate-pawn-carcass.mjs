// ScriptedPawn natives 2108 HaveSeenCarcass and 2109 AddCarcass (src/runtime/script-pawn-carcass.mjs) against the unchanged DeusEx.dll
// exec wrappers and workers run under Unicorn (scripts/native-pawn-carcass-oracle.py): the result dword, the Carcasses[4] list, NumCarcasses,
// the bytecode advance, and that nothing else of the receiver changes. docs/script-pawn-carcass.md.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';

const samples = [];
const add = (label, index, name, carcasses = [], extra = {}) => samples.push({label, index, name, carcasses, ...extra});
for (const index of [2108, 2109]) {
  add(`empty-${index}`, index, 'Carcass1');
  add(`one-hit-${index}`, index, 'carcass1', ['Carcass1']);
  add(`one-miss-${index}`, index, 'Carcass2', ['Carcass1']);
  add(`case-${index}`, index, 'CARCASS1', ['carcass1']);
  add(`last-slot-hit-${index}`, index, 'D', ['A', 'B', 'C', 'D'], {num: 4});
  add(`full-miss-${index}`, index, 'E', ['A', 'B', 'C', 'D'], {num: 4});
  add(`third-${index}`, index, 'C', ['A', 'B'], {num: 2});
  // entries past NumCarcasses are not scanned
  add(`stale-entry-${index}`, index, 'B', ['A', 'B', 'C'], {num: 1});
  add(`none-${index}`, index, 'None', [], {num: 0});
  add(`negative-count-${index}`, index, 'A', ['A'], {num: -1});
  add(`large-count-${index}`, index, 'A', ['B', 'C', 'D', 'E'], {num: 5});
}
const original = JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-pawn-carcass-oracle.py', gameDirectory()], {input: JSON.stringify(samples), encoding: 'utf8'}));
const {execPawnCarcass} = await import('../src/runtime/script-pawn-carcass.mjs');
for (const [i, sample] of samples.entries()) {
  const total = Math.max(sample.num ?? sample.carcasses.length, 0);
  void total;
  const actor = {Carcasses: Array.from({length: 4}, (_, k) => sample.carcasses[k] ?? 'None'), NumCarcasses: sample.num ?? sample.carcasses.length};
  const services = {read: (a, name) => a[name], write: (a, name, value) => { a[name] = value; }};
  const result = execPawnCarcass({receiver: actor, index: sample.index, argumentCount: 1, evaluateArgument: () => sample.name}, services);
  const want = original[i];
  if (sample.index === 2108) assert.equal(Number(result), want.result, sample.label);
  else assert.equal(result, undefined, `${sample.label}: AddCarcass returns nothing`);
  assert.deepEqual(actor.Carcasses.map(n => String(n).toLowerCase()), want.carcasses, `${sample.label}: list`);
  assert.equal(actor.NumCarcasses, want.num, `${sample.label}: count`);
}
console.log(`PASS ${samples.length} original HaveSeenCarcass/AddCarcass exec calls: scan bound, case folding, the 4-entry cap, unsigned count gate and the untouched receiver.`);
