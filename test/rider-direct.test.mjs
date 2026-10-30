/** The rider pass's full scan reads Base from the object image (move-riders.mjs, docs/first-frames.md "Riders"): a slot whose
 * `baseInstance` names an instance is compared as the Base word with the mover's handle, every other slot takes `baseOf`. Each case
 * runs a scene whose actors keep their Base in a small arena (a word at the instance's offset), through `baseOf` reading the same
 * words, and compares the direct scan with the plain reads: the riders and their order, a Base stored by a rider's move into a later
 * slot, a mover that gets its handle during the scan, a table dropped by an epoch bump, and a slot the direct reads leave alone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {moveActorRiders} from '../src/runtime/move-riders.mjs';
import {bumpBaseEpoch, noteBaseChange} from '../src/runtime/base-epoch.mjs';
import {handleOf, identityOfHandle} from '../src/runtime/script-object-handles.mjs';
import {BASE_KEY} from '../src/runtime/actor-link-fields.mjs';

let keys = 0;
const BASE_AT = 4;
/** `count` actors with a Base word each in one arena; `image[i]` false leaves actor i out of the image (its `base` is a plain member). */
function scene(count, image = []) {
  const arena = {view: new DataView(new ArrayBuffer(64 * count))};
  const actors = [], moved = [];
  const mover = {name: 'mover'};
  for (let i = 0; i < count; i++) {
    const actor = {name: `a${i}`, plain: null};
    if (image[i] !== false) {
      actor.instance = {base: 64 * i, arena, cells: new Map([[BASE_KEY, {offset: BASE_AT}]]), imageToken: null, nativeObject: null, poison: null};
    }
    actors.push(actor);
  }
  const setBase = (actor, base) => {
    const old = actor.instance ? identityOfHandle(arena.view.getUint32(actor.instance.base + BASE_AT, true)) : actor.plain;
    if (actor.instance) arena.view.setUint32(actor.instance.base + BASE_AT, handleOf(base), true); else actor.plain = base;
    noteBaseChange(old, base);
  };
  const baseOf = actor => {
    if (actor.instance?.imageToken?.released) throw new Error('Script object allocation has been released');
    return actor.instance ? identityOfHandle(arena.view.getUint32(actor.instance.base + BASE_AT, true)) : actor.plain;
  };
  const zero = () => [0, 0, 0];
  const make = (direct, onMove) => ({actors, baseOf, location: zero, rotation: zero, isPawn: () => false, addViewRotationYaw: () => {},
    moveActor: other => { moved.push(other.name); onMove?.(other); }, actorLocation: zero, actorRotation: zero,
    riderCacheKey: `rider-direct-test-${keys++}`, ...(direct ? {baseInstance: other => other.instance ?? null} : {})});
  const pass = (direct, onMove) => { moved.length = 0; moveActorRiders(mover, [1, 0, 0], [0, 0, 0], make(direct, onMove)); return [...moved]; };
  return {mover, actors, arena, setBase, pass};
}

test('the direct scan finds the riders the plain reads find, in order, across slots without an image', () => {
  const s = scene(8, [true, true, false, true, true, false, true, true]);
  for (const i of [1, 2, 4, 5, 7]) s.setBase(s.actors[i], s.mover);
  s.setBase(s.actors[3], s.actors[0]);
  const plain = s.pass(false);
  assert.deepEqual(plain, ['a1', 'a2', 'a4', 'a5', 'a7']);
  bumpBaseEpoch();
  assert.deepEqual(s.pass(true), plain);
});

test('a null slot is skipped and a mover nobody names has no riders', () => {
  const s = scene(4);
  s.actors[2] = null;
  assert.deepEqual(s.pass(true), []);
  s.setBase(s.actors[3], s.mover);
  bumpBaseEpoch();
  assert.deepEqual(s.pass(true), ['a3']);
});

test('a Base stored into a later slot by a rider move is read when the scan reaches it', () => {
  const s = scene(6);
  s.setBase(s.actors[1], s.mover);
  const plain = s.pass(false, other => { if (other.name === 'a1') s.setBase(s.actors[4], s.mover); });
  assert.deepEqual(plain, ['a1', 'a4']);
  // (the same scene again, from the same state, through the image reads)
  s.setBase(s.actors[4], null);
  bumpBaseEpoch();
  const direct = s.pass(true, other => { if (other.name === 'a1') s.setBase(s.actors[4], s.mover); });
  assert.deepEqual(direct, plain);
});

test('a mover that is given its handle during the scan is found by a later slot', () => {
  // The mover has no handle: nothing in the image can name it. A slot outside the image (read by baseOf) is its rider; that rider's
  // move stores a pointer to it into a later slot of the image, which gives it a handle.
  const s = scene(5, [true, false, true, true, true]);
  s.actors[1].plain = s.mover;
  const stored = other => { if (other.name === 'a1') s.setBase(s.actors[3], s.mover); };
  const direct = s.pass(true, stored);
  assert.deepEqual(direct, ['a1', 'a3']);
});

test('an epoch bump during a rider move leaves the rest of the scan to the plain reads', () => {
  const s = scene(6);
  for (const i of [0, 2, 5]) s.setBase(s.actors[i], s.mover);
  const direct = s.pass(true, other => { if (other.name === 'a0') bumpBaseEpoch(); });
  assert.deepEqual(direct, ['a0', 'a2', 'a5']);
});

test('a released instance is read by baseOf, which raises at that slot after the earlier riders moved', () => {
  const s = scene(5);
  s.setBase(s.actors[1], s.mover); s.setBase(s.actors[3], s.mover);
  s.actors[2].instance.imageToken = {released: true};
  assert.throws(() => s.pass(true), /released/);
  // (the plain scan raises at the same slot, after the same moves)
  const moved = [];
  const plain = () => { try { s.pass(false, other => moved.push(other.name)); } catch { return moved.slice(); } return null; };
  assert.deepEqual(plain(), ['a1']);
});

test('a poisoned instance and a mover with its handle released take the plain reads', () => {
  const s = scene(4);
  s.setBase(s.actors[1], s.mover);
  s.actors[1].instance.poison = new Map([['x', {}]]);
  bumpBaseEpoch();
  assert.deepEqual(s.pass(true), ['a1']);
});
