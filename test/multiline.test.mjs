import test from 'node:test';
import assert from 'node:assert/strict';
import { multiLineCheck, sortLineHits } from '../src/runtime/multiline.mjs';

// Reference facts from original Engine.dll + bundled MSVCRT.dll execution.
// Regenerate the full corpus with scripts/validate-native-multiline.mjs.
const hit = (i, time = .5, location = [50, 0, 0], normal = [1, 0, 0]) => ({ actor: `a${i}`,
  time: Math.fround(time), location: [...location], normal: [...normal], primitive: 0x11000000 + i, item: i });
function run(world, actors, extent = [0, 0, 0]) {
  const events = [];
  const hits = multiLineCheck({ hashPresent: true,
    isMover: actor => Number(actor.slice(1)) % 2 === 0,
    worldLineCheck(end, start, extent, extra) {
      events.push({ world: { end, start, extent, extra } }); return world;
    },
    actorLineCheck(end, start, extent, extra) {
      events.push({ actors: { end, start, extent, extra } }); return actors;
    },
  }, [100, 0, 0], [0, 0, 0], extent, 1, world ? '$world' : null, 0x1234);
  for (let i = 0; i < hits.length; i++) assert.equal(hits[i].next, hits[i + 1] ?? null);
  return { hits, events };
}

test('original CRT tie ordering changes at the eight-entry partition cutoff', () => {
  // Native cases 6, 24, 27.
  for (const [size, expected] of [[2, [1, 0]], [8, [1, 2, 3, 4, 5, 6, 7, 0]],
    [9, [4, 1, 2, 3, 0, 5, 6, 7, 8]]]) {
    assert.deepEqual(sortLineHits(Array.from({ length: size }, (_, i) => hit(i))).map(h => h.item), expected);
  }
});

test('original world hit shortens actor queries, recovers nearby movers and rescales times', () => {
  // Native case 234.
  const actors = [hit(0, .1), hit(1, .2), hit(2, .3)];
  const { hits, events } = run(hit(99), actors);
  assert.deepEqual(events, [
    { world: { end: [100, 0, 0], start: [0, 0, 0], extent: [0, 0, 0], extra: 52 } },
    { actors: { end: [54.9998893737793, 0, 0], start: [0, 0, 0], extent: [0, 0, 0], extra: 4660 } },
  ]);
  assert.deepEqual(hits.map(h => h.item), [1, 0, 2, 99]);
  assert.deepEqual(hits.map(h => h.time), [.10999977588653564, .47999995946884155, .47999995946884155, .5]);
  assert.deepEqual(actors.map(h => h.location), [[48, 0, 0], [50, 0, 0], [48, 0, 0]]);
  assert.notEqual(hits[1], actors[0]);
  assert.notEqual(hits[1].location, actors[0].location);
});

test('original initial-solid path retains movers and preserves its zero-length recovery result', () => {
  // Native case 235: original masked divisions produce NaN; the comparator's
  // unordered branch determines the result order. No invented clamp is added.
  const actors = [hit(0, .2, [0, 0, 0]), hit(1, .01, [0, 0, 0]),
    hit(2, .7, [0, 0, 0], [0, 1, 0]), hit(3, .3, [0, 0, 0])];
  const { hits, events } = run(hit(99, 0, [0, 0, 0]), actors, [20, 20, 43]);
  assert.deepEqual(hits.map(h => h.item), [0, 2, 99]);
  assert.deepEqual(hits.map(h => h.time), [NaN, 0, 0]);
  assert.deepEqual(hits[0].location, [NaN, NaN, NaN]);
  assert.deepEqual(events[1].actors.end, [0, 0, 0]);
  assert.equal(actors[1].time, .009999999776482582);
  assert.equal(actors[3].time, .30000001192092896);
});

test('original 64-result capacity includes the world hit and leaves later actor hits untouched', () => {
  // Native case 466.
  const actors = Array.from({ length: 80 }, (_, i) => hit(i, .5, [20, 0, 0]));
  const { hits } = run(hit(99, .5, [10, 0, 0]), actors);
  assert.equal(hits.length, 64);
  assert.deepEqual(hits.map(h => h.item).sort((a, b) => a - b), [...Array(63).keys(), 99]);
  assert.equal(actors[62].time, .37499624490737915);
  assert.equal(actors[63].time, .5);
  assert.equal(actors[79].time, .5);
});
