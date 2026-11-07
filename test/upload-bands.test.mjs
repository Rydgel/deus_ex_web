import test from 'node:test';
import assert from 'node:assert/strict';
import { coalesceRects, CALL_BYTES } from '../src/viewer/upload-bands.mjs';

// A seeded generator (the tests must not depend on Math.random).
const generator = seed => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

function randomRects(random, size, count) {
  return Array.from({ length: count }, () => {
    const width = 3 + Math.floor(random() * 40), height = 3 + Math.floor(random() * 40);
    return [Math.floor(random() * (size - width)), Math.floor(random() * (size - height)), width, height];
  });
}

test('every input rectangle lies inside a returned one, and no returned one leaves the page', () => {
  const random = generator(7), size = 1024;
  for (let round = 0; round < 300; round++) {
    const rects = randomRects(random, size, 1 + Math.floor(random() * 120));
    const out = coalesceRects(rects);
    assert.ok(out.length <= rects.length);
    for (const [x, y, w, h] of out) assert.ok(x >= 0 && y >= 0 && x + w <= size && y + h <= size && w > 0 && h > 0);
    for (const [x, y, w, h] of rects)
      assert.ok(out.some(([bx, by, bw, bh]) => bx <= x && by <= y && bx + bw >= x + w && by + bh >= y + h), `rect ${x},${y} ${w}x${h} is not covered`);
  }
});

test('a merge costs no more than the calls it saves, and a rectangle that stays alone is the same array', () => {
  const random = generator(11), size = 1024;
  for (let round = 0; round < 300; round++) {
    const rects = randomRects(random, size, 2 + Math.floor(random() * 80)).map(rect => [...rect, 'extra']);
    const out = coalesceRects(rects);
    const cost = list => list.reduce((sum, [, , w, h]) => sum + CALL_BYTES + 4 * w * h, 0);
    // The greedy sweep never makes the page's upload dearer than sending the rectangles one by one.
    assert.ok(cost(out) <= cost(rects), 'the bands cost more than the rectangles');
    for (const rect of out) if (rect.length > 4) assert.ok(rects.includes(rect), 'an unmerged rectangle was copied');
  }
});

test('tiles side by side on a shelf join, a tile on another shelf does not', () => {
  const shelf = [[1, 1, 20, 20], [23, 1, 20, 18], [45, 1, 20, 22], [67, 1, 20, 20]];
  assert.deepEqual(coalesceRects(shelf), [[1, 1, 86, 22]]);
  const far = coalesceRects([...shelf, [1, 600, 20, 20]]);
  assert.equal(far.length, 2);
  assert.deepEqual(far[1], [1, 600, 20, 20]);
  assert.deepEqual(coalesceRects([[5, 5, 10, 10]]), [[5, 5, 10, 10]]);
  assert.deepEqual(coalesceRects([]), []);
});

test('two small tiles far apart on one shelf stay two calls', () => {
  const out = coalesceRects([[1, 1, 16, 16], [900, 1, 16, 16]]);
  assert.equal(out.length, 2);
});
