/** The ABI the walking-loop and pawn-move hosts share with their Rust
 * bodies: the walk field table's order (walk_loop.rs W_*), the import names
 * of both extern blocks, and the pawn-move record and result widths. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WALK_FIELDS, WalkLoopHost} from '../src/runtime/walk-loop-kernel.mjs';
import {HIT_WORDS, IO_WORDS, MovePawnHost} from '../src/runtime/move-pawn-kernel.mjs';

const rust = name => readFileSync(new URL(`../native/script-vm/src/${name}`, import.meta.url), 'utf8');
const externs = source => [...source.matchAll(/^\s*fn (js_\w+)\(/gm)].map(m => m[1]).sort();
const fakeVm = {runtime: null, arena: null, zone: {enabled: false}};

test('walk field table order matches walk_loop.rs', () => {
  const source = rust('walk_loop.rs');
  const consts = Object.fromEntries([...source.matchAll(/const (W_[A-Z_]+): usize = (\d+);/g)].map(m => [m[1], Number(m[2])]));
  const named = {Region: 'W_REGION_ZONE', CollisionRadius: 'W_RADIUS', CollisionHeight: 'W_HEIGHT',
    bJustTeleported: 'W_MOTION', ZoneGroundFriction: 'W_ZONE_FRICTION'};
  const spell = name => named[name] ?? 'W_' + name.replace(/^b(?=[A-Z])/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  WALK_FIELDS.forEach(([name], i) => assert.equal(consts[spell(name)], i, `${name} is row ${i}`));
  assert.equal(consts.W_COUNT, WALK_FIELDS.length);
  assert.equal(new Set(WALK_FIELDS.map(([, key]) => key)).size, WALK_FIELDS.length, 'distinct keys');
});

test('walk loop imports match the extern block', () => {
  assert.deepEqual(Object.keys(new WalkLoopHost(fakeVm).imports()).sort(), externs(rust('walk_loop.rs')));
});

test('pawn move imports and record widths match move_pawn.rs', () => {
  const source = rust('move_pawn.rs');
  assert.deepEqual(Object.keys(new MovePawnHost(fakeVm).imports()).sort(), externs(source));
  assert.equal(Number(source.match(/const HIT_WORDS: usize = (\d+);/)[1]), HIT_WORDS);
  assert.equal(Number(source.match(/static mut MP_IO: \[f64; (\d+)\]/)[1]), IO_WORDS);
});
