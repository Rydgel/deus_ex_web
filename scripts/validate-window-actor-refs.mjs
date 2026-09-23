/** Window actor refs: unchanged original DLL wrappers and table operations. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {createWindowActorRefDispatcher} from '../src/runtime/script-window-actor-refs.mjs';

const samples = [
  {name: 'null-does-not-compact', initial: [['a', 1]], deleted: ['a'],
    ops: [['add', null], ['remove', null], ['valid', null], ['valid', 'a']]},
  {name: 'duplicates-shared-pawn', secondWindow: true,
    ops: [['add', 'a'], ['add', 'a'], ['valid', 'a'], ['remove', 'a'], ['valid', 'a'], ['remove', 'a'], ['valid', 'a']]},
  {name: 'deletion-compaction', initial: [['a', 7], ['b', 3], [null, 22], ['c', 4]], deleted: ['a'],
    ops: [['valid', 'c'], ['kill', 'b'], ['remove', 'missing'], ['valid', 'b'], ['valid', 'c']]},
  {name: 'capacity', initial: Array.from({length: 32}, (_, i) => [`a${i}`, i + 1]),
    ops: [['add', 'a31'], ['add', 'new'], ['valid', 'a0'], ['valid', 'new']]},
  {name: 'ref-overflow', initial: [['a', 2147483647], ['b', -2147483648]],
    ops: [['add', 'a'], ['remove', 'b'], ['remove', 'a']]},
  {name: 'append-deleted', deleted: ['a'], ops: [['add', 'a'], ['valid', 'a']]},
  {name: 'no-pawn', noPawn: true, initial: [['a', 1]], ops: [['add', 'b'], ['remove', 'a'], ['valid', 'a']]},
  {name: 'no-root', noRoot: true, initial: [['a', 1]], ops: [['add', 'b'], ['remove', 'a'], ['valid', 'a']]},
];
const request = {gameRoot: gameDirectory(), samples};
const originalText = execFileSync(process.env.NATIVE_PROBE_PYTHON || path.resolve('.cache/native-probe-env/bin/python'),
  [path.resolve('scripts/native-window-actor-refs-oracle.py')],
  {input: JSON.stringify(request), encoding: 'utf8', timeout: 30000, maxBuffer: 2 ** 20});
const capture = path.resolve('.cache/window-actor-refs');
mkdirSync(capture, {recursive: true});
writeFileSync(path.join(capture, 'original-input.json'), JSON.stringify(request));
writeFileSync(path.join(capture, 'original.json'), originalText);
const original = JSON.parse(originalText);
assert.equal(original.hash, '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c');
for (const [index, sample] of samples.entries()) {
  const actors = new Map(), dead = new Set(sample.deleted ?? []);
  const actor = name => {
    if (name === null) return null;
    if (!actors.has(name)) actors.set(name, {name});
    return actors.get(name);
  };
  const pawn = {}, root = {0x28: 3, 0x588: sample.noPawn ? null : pawn};
  const window = {0x138: sample.noRoot ? null : root}, second = {0x138: window};
  const W = {u8: (o, offset) => o[offset] ?? 0, ptr: (o, offset) => o[offset] ?? null};
  const dispatch = createWindowActorRefDispatcher(W, {isDeleted: object => dead.has(object.name)});
  const table = dispatch.tableFor(pawn);
  for (const [i, [name, refs]] of (sample.initial ?? []).entries()) table.slots[i] = {actor: actor(name), refs};
  table.count = (sample.initial ?? []).length;
  const actual = [];
  for (const [step, [op, name]] of sample.ops.entries()) {
    let value = null;
    if (op === 'kill') dead.add(name);
    else {
      const result = dispatch({index: {add: 1497, remove: 1498, valid: 1499}[op],
        receiver: sample.secondWindow && step % 2 ? second : window,
        argumentCount: 1, evaluateArgument: () => actor(name)});
      assert.equal(result.handled, true);
      value = result.value ?? null;
    }
    actual.push({value, count: table.count, slots: table.slots.map(slot => [slot.actor?.name ?? null, slot.refs])});
  }
  assert.deepEqual(actual, original.cases[index], sample.name);
  assert.deepEqual(dispatch({index: 1429}), {handled: false});
}
console.log(`Window actor refs: ${samples.length} unchanged original DLL sequences, ${samples.reduce((n, s) => n + s.ops.length, 0)} steps, all 32 slots and counts match`);
