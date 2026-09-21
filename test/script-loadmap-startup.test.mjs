import test from 'node:test'; import assert from 'node:assert/strict';
import { forEachLiveActor, partitionActorArray } from '../src/runtime/script-loadmap-startup.mjs';

// UGameEngine::LoadMap pass loops reread the TArray data pointer and Num on
// every iteration, skip null slots, and advance by index (Engine.dll
// 0x1038d99a-0x1038d9cc for PreBeginPlay).

test('live pass visits actors appended during the pass', () => {
  const level = { actors: [{}, {}, {}] };
  const visited = [], appended = {};
  forEachLiveActor(level, actor => {
    visited.push(actor);
    if (visited.length === 1) level.actors.push(appended);
  });
  assert.deepEqual(visited, [level.actors[0], level.actors[1], level.actors[2], appended]);
});

test('live pass skips slots nulled mid-pass (destroyed actors drop out)', () => {
  const a = {}, b = {}, c = {};
  const level = { actors: [a, b, c] };
  const visited = [];
  forEachLiveActor(level, actor => {
    visited.push(actor);
    if (actor === a) level.actors[1] = null;
  });
  assert.deepEqual(visited, [a, c]);
});

test('live pass skips preexisting null slots', () => {
  const a = {}, b = {};
  const level = { actors: [a, null, null, b] };
  const visited = [];
  forEachLiveActor(level, actor => visited.push(actor));
  assert.deepEqual(visited, [a, b]);
});

test('live pass observes a data-pointer change (level.actors reassigned mid-pass)', () => {
  const a = {}, b = {}, c = {};
  const level = { actors: [a] };
  const visited = [];
  forEachLiveActor(level, actor => {
    visited.push(actor);
    if (visited.length === 1) level.actors = [a, b, c];
  });
  assert.deepEqual(visited, [a, b, c]);
});

test('live pass ends at the reread count (shrinking the array truncates)', () => {
  const a = {}, b = {}, c = {};
  const level = { actors: [a, b, c] };
  const visited = [];
  forEachLiveActor(level, actor => {
    visited.push(actor);
    if (visited.length === 1) level.actors = [a];
  });
  assert.deepEqual(visited, [a]);
});

// The LoadMap tail (0x1038dcd5): slots 0 and 1 copy verbatim, later slots
// compact non-null entries into statics then dynamics, and Level+0x110
// (iFirstNetActor) records the static-partition boundary.

test('partition preserves slots 0 and 1 verbatim including a null slot 1', () => {
  const info = {}, s1 = {}, s2 = {}, d1 = {}, d2 = {};
  const isStatic = actor => actor === s1 || actor === s2;
  const { actors, firstNetActor } = partitionActorArray([info, null, d1, s1, null, s2, d2], isStatic);
  assert.deepEqual(actors, [info, null, s1, s2, d1, d2]);
  assert.equal(firstNetActor, 4);
});

test('partition compacts destroyed and refused-export nulls out of the tail', () => {
  const info = {}, second = {}, d1 = {}, d2 = {};
  const { actors, firstNetActor } = partitionActorArray([info, second, null, d1, null, d2], () => false);
  assert.deepEqual(actors, [info, second, d1, d2]);
  assert.equal(firstNetActor, 2);
});

test('partition orders statics before dynamics preserving relative order', () => {
  const info = {}, second = {}, a = {}, b = {}, c = {}, d = {};
  const isStatic = actor => actor === b || actor === d;
  const { actors, firstNetActor } = partitionActorArray([info, second, a, b, c, d], isStatic);
  assert.deepEqual(actors, [info, second, b, d, a, c]);
  assert.equal(firstNetActor, 4);
});

test('partition of an all-dynamic tail leaves iFirstNetActor at the head', () => {
  const info = {}, second = {}, a = {};
  const { actors, firstNetActor } = partitionActorArray([info, second, a], () => false);
  assert.deepEqual(actors, [info, second, a]);
  assert.equal(firstNetActor, 2);
});
