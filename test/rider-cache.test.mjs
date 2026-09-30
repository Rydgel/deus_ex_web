/** The rider pass's cached Level.Actors scan (move-riders.mjs) over the base
 * epoch and the per-mover Base-change count (base-epoch.mjs): a list is
 * reused across Base changes that do not touch the mover, and a scan runs
 * again after a rider leaves or arrives, or after a structural change. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {moveActorRiders} from '../src/runtime/move-riders.mjs';
import {bumpBaseEpoch, noteBaseChange} from '../src/runtime/base-epoch.mjs';

let keys = 0;
function scene() {
  const mover = {name: 'mover', base: null}, other = {name: 'other', base: null};
  const r1 = {name: 'r1', base: mover}, r2 = {name: 'r2', base: mover}, r3 = {name: 'r3', base: other};
  const actors = [mover, r1, other, r2, r3];
  let reads = 0;
  const moved = [];
  const zero = () => [0, 0, 0];
  const services = {actors, baseOf: a => { reads++; return a.base; }, location: zero, rotation: zero, isPawn: () => false,
    addViewRotationYaw: () => {}, moveActor: o => { moved.push(o.name); }, actorLocation: zero, actorRotation: zero,
    riderCacheKey: `rider-cache-test-${keys++}`};
  const pass = () => { moveActorRiders(mover, [1, 0, 0], [0, 0, 0], services); return moved.splice(0); };
  return {mover, other, r1, r2, r3, actors, pass, reads: () => reads};
}

test('a recorded rider list is reused until a Base change touches the mover', () => {
  const s = scene();
  assert.deepEqual(s.pass(), ['r1', 'r2']);
  assert.equal(s.reads(), 5, 'the first pass scans');
  assert.deepEqual(s.pass(), ['r1', 'r2']);
  assert.equal(s.reads(), 5, 'the second pass reuses the list');
  // Another actor changes base between other movers: this list stays.
  s.r3.base = null; noteBaseChange(s.other, null);
  assert.deepEqual(s.pass(), ['r1', 'r2']);
  assert.equal(s.reads(), 5, 'an unrelated Base change does not scan');
  // A rider leaves the mover.
  s.r1.base = null; noteBaseChange(s.mover, null);
  assert.deepEqual(s.pass(), ['r2']);
  assert.equal(s.reads(), 10, 'a rider leaving scans again');
  // A rider arrives, in Level.Actors order.
  s.r3.base = s.mover; noteBaseChange(null, s.mover);
  assert.deepEqual(s.pass(), ['r2', 'r3']);
  assert.equal(s.reads(), 15, 'a rider arriving scans again');
  assert.deepEqual(s.pass(), ['r2', 'r3']);
  assert.equal(s.reads(), 15);
  // A structural change of Level.Actors.
  bumpBaseEpoch();
  assert.deepEqual(s.pass(), ['r2', 'r3']);
  assert.equal(s.reads(), 20, 'the epoch scans again');
});

test('noteBaseChange ignores a write that keeps the value and non-object bases', () => {
  const s = scene();
  s.pass();
  noteBaseChange(s.mover, s.mover); noteBaseChange(null, null); noteBaseChange(undefined, null);
  assert.deepEqual(s.pass(), ['r1', 'r2']);
  assert.equal(s.reads(), 5);
});

test('a slot nulled after the scan is skipped and the actors epoch alone does not scan', async () => {
  const {bumpActorsEpoch} = await import('../src/runtime/base-epoch.mjs');
  const s = scene();
  assert.deepEqual(s.pass(), ['r1', 'r2']);
  bumpActorsEpoch();
  assert.deepEqual(s.pass(), ['r1', 'r2']);
  assert.equal(s.reads(), 5, 'a spawn or a removal does not scan');
  // DestroyActor nulled r1's slot: the cached pass skips it as a scan would.
  s.actors[1] = null; bumpActorsEpoch();
  assert.deepEqual(s.pass(), ['r2']);
  assert.equal(s.reads(), 5);
});
