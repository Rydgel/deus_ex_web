/** FlagBase iterators against Extension.dll (docs/script-flagbase-iterators.md).
 *
 * scripts/native-flagbase-iterator-oracle.py builds a real flag table with the
 * original SetBool/AddFlag bodies and runs the original CreateIterator,
 * GetNextFlag, DestroyIterator, DeleteFlag and DeleteAllFlags. The same
 * sequence runs here on createFlagBase (script-triggers.mjs): every
 * GetNextFlag result (found, name, type, including the exhausted None/0 and
 * one call past it), the type filter, DeusExRootWindow.ResetFlags' walk that
 * deletes the previous flag unless its name holds "SKTemp_", and the table
 * left after it and after DeleteAllFlags. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createFlagBase } from '../src/runtime/script-triggers.mjs';
import { gameDirectory } from './game-directory.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const oracle = JSON.parse(execFileSync(python, [path.resolve('scripts/native-flagbase-iterator-oracle.py'), gameDirectory()],
  { encoding: 'utf8', maxBuffer: 16 << 20 }));
assert.equal(oracle.hash, '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c');

const flags = createFlagBase();
// The oracle's SetBool(name index i, value i & 1, bAdd, expiration -1), in order.
oracle.names.forEach((name, i) => flags.setBool(name, (i + 1) & 1, true, -1));
const walk = (type, reset = false) => {
  const it = flags.createIterator(type), steps = [];
  let last = null;
  for (;;) {
    const r = flags.getNextFlag(it);
    steps.push({ found: r.found ? 1 : 0, name: r.name, type: r.type });
    if (reset && last && !last.includes('SKTemp_')) flags.deleteFlag(last, 0);
    last = r.found ? r.name : null;
    if (!r.found) break;
  }
  const extra = flags.getNextFlag(it);
  steps.push({ found: extra.found ? 1 : 0, name: extra.name, type: extra.type });
  flags.destroyIterator(it);
  return steps;
};
const remaining = () => { const it = flags.createIterator(7), out = []; for (let r; (r = flags.getNextFlag(it)).found;) out.push(r.name); flags.destroyIterator(it); return out; };

assert.deepEqual(walk(7), oracle.walkAll, 'a full walk visits buckets 0..63 in chain order');
assert.deepEqual(oracle.before.flat(), oracle.walkAll.filter(s => s.found).map(s => s.name), 'the oracle walk is its table order');
assert.deepEqual(walk(0), oracle.walkBools, 'type 0 (bools) visits every bool');
assert.deepEqual(walk(1), oracle.walkInts, 'type 1 finds nothing in a bool table');
flags.deleteFlag('Beta', 0);
flags.setBool('Beta', true, true, -1);
assert.deepEqual(remaining(), oracle.readded.flat(), 'a deleted and re-added flag takes its chain position again');
const reset = walk(7, true);
assert.deepEqual(reset, oracle.reset, "ResetFlags' walk");
assert.deepEqual(remaining(), oracle.afterReset.flat(), 'ResetFlags keeps only SKTemp_ flags');
flags.deleteAllFlags();
assert.deepEqual(remaining(), oracle.afterDeleteAll.flat(), 'DeleteAllFlags empties the table');
console.log(`FlagBase iterators: ${oracle.walkAll.length - 2} flags walked in the original bucket/chain order; ` +
  `type filter, ResetFlags deletion walk and DeleteAllFlags equal Extension.dll.`);
