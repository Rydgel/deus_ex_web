/** Differential check of the Rust collision hash and line checks
 * (native/script-vm/src/hash.rs, src/runtime/collision-kernel.mjs,
 * docs/rust-core.md step R3-b) against the JavaScript they transcribe, which
 * stays the reference (collision-hash.mjs, level-queries.mjs, multiline.mjs,
 * line-filter.mjs, primitive-collision.mjs).
 *
 * 1. Pieces on seeded and edge inputs: `x ** 2` against `x * x` (the
 *    transcription's assumption), the line-query cells with X's 64-bit x87
 *    expansion and the 0..255/cell-budget check, the cylinder primitive, the
 *    CRT qsort (ties, NaN, signed zeros), and MultiLineCheck's world clip,
 *    mover backoff, movers-only rule and 64-hit cap over supplied hits.
 * 2. The hash: a kernel-store hash and a JavaScript hash take the same
 *    seeded registrations, removals, re-registrations and refused inputs
 *    (the same results and errors), and every query's visit order is
 *    compared.
 * 3. Real levels (00_Training, 01_NYC_UNATCOIsland): the level actors are
 *    registered as game.mjs registers them, in a kernel and a JavaScript
 *    createLevelQueries, and seeded lineCheck and multiLineCheck queries
 *    (every flag family, sources with owner chains, zero, pawn, small,
 *    negative and non-finite extents, long and zero-length segments, huge
 *    and NaN coordinates) must give identical results (keys, order, numbers
 *    by Object.is, identities) or the same error. Between batches actors
 *    move, are destroyed (0x80) and re-registered on both, collision bits
 *    change without re-registration (read live), and candidates whose
 *    getters touch the hash (re-entrant mutation and nested queries) must
 *    throw or answer as the JavaScript does.
 *
 * COLLISION_CASES (default 20000) scales the seeded cases; COLLISION_ONLY
 * (pieces, hash, levels; comma-separated) runs some sections. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ClassDefaults} from '../src/unreal/classes.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {readModel} from '../src/unreal/model.mjs';
import {loadTraceKernel} from '../src/runtime/trace-kernel.mjs';
import {createCollisionHash, collisionHashLineBounds} from '../src/runtime/collision-hash.mjs';
import {createLevelQueries} from '../src/runtime/level-queries.mjs';
import {multiLineCheck, sortLineHits} from '../src/runtime/multiline.mjs';
import {primitiveLineHit} from '../src/runtime/primitive-collision.mjs';
import {primitiveCollisionBounds, brushCollisionBounds} from '../src/runtime/brush-bounds.mjs';
import {traceExtent} from '../src/runtime/extent-trace.mjs';
import {kernelHashStore, lineResultDifference, kernelStats} from '../src/runtime/collision-kernel.mjs';
import {gameDirectory} from './game-directory.mjs';
import {loadScriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';
import {walkingSurfacePrelude, walkingSurfaceTextures, surfaceScanInputs, scanSurface} from '../src/runtime/walking-surface.mjs';
import {x87add, x87double, x87load, x87mul, x87neg, x87store} from '../src/runtime/script-vm.mjs';

const kernel = await loadTraceKernel();
assert.ok(kernel, 'the trace kernel loads (TRACE_KERNEL=js disables it)');
assert.ok(kernelHashStore(), 'the kernel hash store is available (HASH_KERNEL=js disables it)');
const x = kernel.x;
const f = Math.fround, CASES = Number(process.env.COLLISION_CASES ?? 20000);
let seed = 0x5eed13;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const pick = list => list[Math.floor(random() * list.length)];
const signed = size => (random() * 2 - 1) * size;
const exact = (key, v) => typeof v === 'number' && (Object.is(v, -0) || !Number.isFinite(v)) ? (Object.is(v, -0) ? '-0' : String(v)) : v;
const tally = {};
const sections = process.env.COLLISION_ONLY?.split(',');
const only = name => !sections || sections.includes(name);
const count = (key, n = 1) => { tally[key] = (tally[key] ?? 0) + n; };
const examples = [];
function mismatch(reason, input) {
  count('mismatches');
  if (examples.length < 10) examples.push(JSON.stringify({reason, ...input}, exact).slice(0, 700));
}
const attempt = call => { try { return {value: call()}; } catch (error) { return {error}; } };
const test = () => new Float64Array(kernel.arena.memory.buffer, x.lc_test_ptr(), 2 + 11 * 256);
const f32 = () => f((random() < .5 ? -1 : 1) * random() * 2 ** Math.floor(signed(40)));
const HUGE = [1e6, -1e6, 32767.5, -32768, 32640, 32639.998046875, 1e10, 3.4e38, -3.4e38, 1e-45, -0, 0];

// ---------------------------------------------------------------------------
// 1. Pieces.
if (only('pieces')) {
  // Pawn physics' x87 tails: AvgPhysicsTime and physFalling's refund, the
  // Rust Ext model against the BigInt one on float32 bit patterns.
  const ops = await loadScriptVmKernel();
  const bitsView = new DataView(new ArrayBuffer(4));
  const float = () => {
    const r = random();
    if (r < .5) return f(random() < .5 ? random() * .1 : random());
    if (r < .6) return pick([0, -0, 1, -1, NaN, Infinity, -Infinity, 1e-45, -1e-45, 1.1754942e-38, 3.4028235e38, .8, .2]);
    bitsView.setUint32(0, (random() * 2 ** 32) >>> 0);
    return bitsView.getFloat32(0);
  };
  let bad = 0;
  const one = {neg: 0, sig: 1n, exp: 0};
  for (let i = 0; i < CASES * 20; i++) {
    const avg = float(), dt = float(), remaining = float(), time = float(), step = float();
    const avgExpected = x87store(x87add(x87mul(x87load(avg), x87double(0.8)), x87mul(x87load(dt), x87double(0.2))));
    const refundExpected = x87store(x87add(x87mul(x87add(one, x87neg(x87load(time))), x87load(step)), x87load(remaining)));
    if (!Object.is(ops.avgPhysicsTime(avg, dt), avgExpected)) { bad++; if (examples.length < 10) examples.push(JSON.stringify({avg, dt}, exact)); }
    if (!Object.is(ops.refundTime(remaining, time, step), refundExpected)) { bad++; if (examples.length < 10) examples.push(JSON.stringify({remaining, time, step}, exact)); }
  }
  if (bad) mismatch('x87 tails', {bad});
  count('x87Tails', CASES * 40);
}
if (only('pieces')) {
  // x ** 2 is x * x in this V8 (fdlibm pow's y == 2 case).
  const view = new DataView(new ArrayBuffer(8));
  let bad = 0;
  const square = v => { if (!Object.is(v ** 2, v * v)) bad++; };
  for (const v of [0, -0, 1, -1, NaN, Infinity, -Infinity, 5e-324, 1e-160, 1e160, 1.3407807929942596e154, Number.MAX_VALUE]) square(v);
  for (let i = 0; i < CASES * 50; i++) {
    view.setUint32(0, (random() * 2 ** 32) >>> 0); view.setUint32(4, (random() * 2 ** 32) >>> 0);
    square(view.getFloat64(0)); square(f32()); square(signed(4096));
  }
  assert.equal(bad, 0, 'x ** 2 equals x * x');
  count('squares', CASES * 150 + 12);
}
if (only('pieces')) {
  // Line-query cells: collisionHashLineBounds and the seed-independent check.
  const coordinate = () => {
    const r = random();
    if (r < .3) return f(signed(33000));
    if (r < .45) return f(Math.round(signed(260)) * 256 - 32768 + pick([0, 128, -128, 127.5, 128.00001, .001953125]));
    if (r < .6) return f(pick([128.001953125, -32768, 32767, -32640, 32640]) + pick([0, 2 ** -10, -(2 ** -12), 2 ** -20]));
    if (r < .7) return pick(HUGE);
    return f32();
  };
  const extent = () => {
    const r = random();
    if (r < .3) return 0;
    if (r < .5) return f(random() * 60);
    if (r < .7) return f(pick([1e-12, 1e-14, 1e-16, 1e-30, 1e-40, 2 ** -20, 2 ** -60]) * (1 + random()));
    if (r < .8) return pick([-0, -1, f(-random() * 50)]);
    if (r < .9) return f(random() * 2 ** 20);
    return f32();
  };
  let n = 0;
  for (let i = 0; i < CASES * 30; i++) {
    const start = [coordinate(), coordinate(), coordinate()];
    const end = random() < .3 ? [...start] : random() < .5 ? start.map(v => f(v + signed(400))) : [coordinate(), coordinate(), coordinate()];
    const box = random() < .5 ? [0, 0, 0] : [extent(), extent(), extent()];
    if (random() < .3) box[0] = extent();
    const expected = attempt(() => collisionHashLineBounds({start, end, extent: box}));
    if (expected.error) continue;
    n++;
    x.lc_test_cells(start[0], start[1], start[2], end[0], end[1], end[2], box[0], box[1], box[2]);
    const t = test(), cells = [t[0], t[1], t[2], t[3], t[4], t[5]], {min, max} = expected.value;
    if (cells.some((v, j) => v !== [...min, ...max][j])) mismatch('line cells', {start, end, box, kernel: cells, javascript: [...min, ...max]});
    // createCollisionHash's check in its seed-independent mode.
    const span = (a, b) => Math.max(0, b - a + 1);
    const supported = !min.some(v => v > 255) && !max.some(v => v > 255) && span(min[0], max[0]) * span(min[1], max[1]) * span(min[2], max[2]) <= 1000000;
    if ((t[6] !== 0) !== supported) mismatch('cell check', {start, end, box, kernel: t[6], javascript: supported});
  }
  count('cells', n);
}
if (only('pieces')) {
  // The cylinder primitive against primitiveLineHit.
  const location = () => [f(signed(2000)), f(signed(2000)), f(signed(500))];
  const record = t => ({time: t[2], location: [t[3], t[4], t[5]], normal: [t[6], t[7], t[8]]});
  let n = 0, hits = 0;
  for (let i = 0; i < CASES * 20; i++) {
    const l = random() < .05 ? location().map((v, j) => j === Math.floor(random() * 3) ? pick([NaN, Infinity, -0]) : v) : location();
    const r = random() < .1 ? pick([0, -0, -5, NaN, 1e-20, f(random() * 1e6)]) : f(random() * 60);
    const h = random() < .1 ? pick([0, -3, NaN, 1e-20]) : f(random() * 60);
    const around = scale => l.map(v => f(v + signed(scale)));
    const kind = random();
    const start = kind < .3 ? around(r + 40) : kind < .5 ? around(r * 3 + 10) : kind < .6 ? [l[0], l[1], f(l[2] + signed(h))] : around(400);
    let end = kind < .7 ? around(r * 2 + 60) : random() < .5 ? [...start] : [start[0], start[1], f(l[2] + signed(h * 3 + 20))];
    if (random() < .1) end = start.map((v, j) => f(v + pick([0, 1e-6, -1e-6, 2 ** -20])));
    const box = random() < .4 ? [0, 0, 0] : random() < .9 ? [f(random() * 40), f(random() * 40), f(random() * 60)] : [pick([-1, 0, 1e-30, NaN]), f(random() * 5), pick([-2, 0, 3])];
    if (random() < .02) start[Math.floor(random() * 3)] = pick([NaN, Infinity, 3.4e38]);
    if (i % 4 === 0) {
      // Boundaries: a start inside (or radially just outside) the expanded
      // cylinder whose inward dot product is near the -0.1 threshold, and
      // cylinders thin enough for the entry normal's 1e-8 test.
      const kind = i % 12;
      const rx = f(r + f(box[0])), zc = f(l[2] + signed(Math.max(0, h) * .9));
      if (kind === 0 || kind === 4) {
        const angle = random() * Math.PI * 2, reach = kind === 0 ? random() * rx : Math.sqrt(rx * rx + random() * 2.5);
        const x0 = Math.cos(angle) * reach, y0 = Math.sin(angle) * reach, squared = x0 * x0 + y0 * y0 || 1;
        const dot = kind === 0 ? -.1 + signed(random() < .5 ? .02 : 2e-6) : -1 - random() * 50;
        const side = signed(3);
        start.splice(0, 3, f(l[0] + x0), f(l[1] + y0), zc);
        end.splice(0, 3, f(start[0] + dot * x0 / squared - side * y0), f(start[1] + dot * y0 / squared + side * x0), f(zc + signed(2)));
      } else if (kind === 8) {
        const tiny = f(pick([1e-4, 3e-3, 1e-2, 5e-5]) * random());
        l[0] = f(l[0]); box.splice(0, 3, 0, 0, 0);
        start.splice(0, 3, f(l[0] - 5 - random() * 20), f(l[1] + signed(tiny)), f(l[2]));
        end.splice(0, 3, f(l[0] + 5 + random() * 20), f(l[1] + signed(tiny)), f(l[2] + signed(1)));
        const expected = primitiveLineHit(l, tiny, f(10), start, end, box);
        const answered = x.lc_test_primitive(l[0], l[1], l[2], tiny, f(10), start[0], start[1], start[2], end[0], end[1], end[2], 0, 0, 0);
        n++;
        if (!answered !== !expected) mismatch('thin primitive hit/miss', {l, tiny, start, end});
        else if (expected) {
          hits++;
          const d = lineResultDifference(record(test()), {time: expected.time, location: expected.location, normal: expected.normal});
          if (d) mismatch(`thin primitive${d}`, {l, tiny, start, end});
        }
      }
    }
    const expected = primitiveLineHit(l, r, h, start, end, box);
    const answered = x.lc_test_primitive(l[0], l[1], l[2], r, h, start[0], start[1], start[2], end[0], end[1], end[2], box[0], box[1], box[2]);
    n++;
    if (!answered !== !expected) { mismatch('primitive hit/miss', {l, r, h, start, end, box, kernel: answered, javascript: expected}); continue; }
    if (!expected) continue;
    hits++;
    const actual = record(test()), d = lineResultDifference(actual, {time: expected.time, location: expected.location, normal: expected.normal});
    if (d) mismatch(`primitive${d}`, {l, r, h, start, end, box, kernel: actual, javascript: expected});
  }
  count('primitives', n);
  count('primitiveHits', hits);
}
if (only('pieces')) {
  // The qsort over times.
  const times = [0, -0, 1, .5, .25, NaN, 1e-7, f(.3), f(.3), 2, -1];
  let n = 0;
  for (let i = 0; i < CASES * 2; i++) {
    const size = random() < .7 ? Math.floor(random() * 20) : Math.floor(random() * 257);
    const ties = random() < .5, nan = random() < .2;
    const list = Array.from({length: size}, () => nan && random() < .1 ? NaN : ties ? pick(times) : f(random()));
    const reference = list.map((time, index) => ({time, index}));
    sortLineHits(reference);
    const t = test();
    list.forEach((time, j) => { t[2 + 11 * j] = time; });
    x.lc_test_sort(size);
    const order = Array.from({length: size}, (_, j) => test()[2 + 11 * j]);
    n++;
    if (order.some((v, j) => v !== reference[j].index)) mismatch('sort order', {list, kernel: order, javascript: reference.map(h => h.index)});
  }
  count('sorts', n);
}
if (only('pieces')) {
  // World clip, join and sort over supplied hits, against multiLineCheck
  // with the same world and actor answers.
  let n = 0, backoffs = 0, capped = 0, onlyMovers = 0;
  for (let i = 0; i < CASES * 4; i++) {
    const reach = pick([30, 600, 600, 6000]), kind = random();
    // Short, long (the movers-only rule's 30-unit reach at world times under
    // .01) and nearly X-parallel segments at X near zero (a float32-subnormal
    // X backoff).
    const start = [kind >= .1 && kind < .2 ? pick([0, -0, 1e-40, 1.4e-45]) : f(signed(1000)), f(signed(1000)), f(signed(300))];
    const end = kind < .1 ? [...start] : kind < .2 ? [f(start[0] + pick([1e-39, -3e-40, 1.4e-45, 2e-38])), f(start[1] + signed(reach)), f(start[2] + signed(reach))]
      : start.map(v => f(v + signed(reach)));
    const world = random() < .7;
    const normal = pick([[0, 0, 1], [1, 0, 0], [f(.6), f(.8), 0], [0, -0, -1]]);
    const along = t => start.map((v, j) => f(v + (end[j] - v) * t));
    const worldTime = world ? f(random() < .3 ? random() * .01 : random() < .2 ? .01 + signed(1e-4) : random()) : 1;
    const worldHit = world ? {time: worldTime, normal, location: along(worldTime), node: Math.floor(random() * 100), penetrating: random() < .1,
      primitive: null, item: 7} : null;
    const size = random() < .8 ? Math.floor(random() * 12) : Math.floor(random() * 150);
    const actors = Array.from({length: size}, (_, j) => {
      const time = random() < .1 ? pick([0, 1, NaN, worldTime]) : f(random());
      // Flush with the world hit (the mover backoff's reach is 2 units).
      const flush = world && random() < .4;
      const location = flush ? worldHit.location.map(v => f(v + signed(random() < .5 ? .5 : 1.5))) : along(time);
      return {mover: random() < .4, hit: {outside: false, location, normal: flush || random() < .2 ? [...normal] : pick([[0, 0, 1], [-1, 0, 0]]), time, actor: j}};
    });
    if (actors.length > 64) capped++;
    const expected = multiLineCheck({hashPresent: true, isMover: id => actors[id].mover,
      worldLineCheck: () => worldHit && structuredClone(worldHit),
      actorLineCheck: () => actors.map(a => ({...a.hit, location: [...a.hit.location], normal: [...a.hit.normal]})).reverse(),
    }, end, start, [0, 0, 0], 1, world ? '$world' : null, 0);
    if (worldHit && worldHit.time < .01) onlyMovers++;
    const t = test();
    let slot = 0;
    const put = (h, mover, id, kind) => {
      const at = 2 + 11 * slot++;
      t.set([h.time, ...h.location, ...h.normal, h.node ?? 0, mover ? 1 : 0, id, kind], at);
    };
    if (worldHit) put(worldHit, worldHit.penetrating, -1, 0);
    for (let j = 0; j < actors.length; j++) put(actors[j].hit, actors[j].mover, j, 2);
    const joined = x.lc_test_join(world ? 1 : 0, actors.length, start[0], start[1], start[2], end[0], end[1], end[2]);
    n++;
    const out = test(), actual = Array.from({length: joined}, (_, j) => {
      const at = 2 + 11 * j;
      return {time: out[at], location: [out[at + 1], out[at + 2], out[at + 3]], normal: [out[at + 4], out[at + 5], out[at + 6]],
        actor: out[at + 9] === -1 ? '$world' : out[at + 9]};
    });
    const reference = expected.map(h => ({time: h.time, location: h.location, normal: h.normal, actor: h.actor}));
    for (const h of expected) if (h.actor !== '$world' && h.location !== actors[h.actor].hit.location &&
      h.location.some((v, j) => v !== actors[h.actor].hit.location[j]) && worldHit) backoffs++;
    const d = lineResultDifference(actual, reference);
    if (d) mismatch(`join${d}`, {start, end, worldHit, actors: actors.length, kernel: actual.slice(0, 4), javascript: reference.slice(0, 4)});
  }
  count('joins', n);
  count('joinBackoffs', backoffs);
  count('joinCapped', capped);
  count('joinOnlyMovers', onlyMovers);
}

// ---------------------------------------------------------------------------
// 2. The hash: the kernel store against the JavaScript buckets.
if (only('hash')) {
  const kernelHash = createCollisionHash({store: kernelHashStore()}), reference = createCollisionHash();
  const both = (name, run) => {
    const a = attempt(() => run(kernelHash)), b = attempt(() => run(reference));
    if (a.error || b.error) {
      if (a.error?.message !== b.error?.message) mismatch(`hash ${name} error`, {kernel: a.error?.message, javascript: b.error?.message});
      return;
    }
    if (JSON.stringify(a.value) !== JSON.stringify(b.value)) mismatch(`hash ${name} result`, {});
    return a.value;
  };
  const actors = Array.from({length: 300}, (_, id) => ({id, actorFlags: 0}));
  const registered = new Map();
  const box = () => {
    const centre = [f(signed(3000)), f(signed(3000)), f(signed(800))], size = random() < .8 ? f(random() * 80) : f(random() * 1500);
    return {min: centre.map(v => f(v - size)), max: centre.map((v, j) => f(v + size * (j === 2 ? .5 : 1)))};
  };
  let orders = 0;
  for (let i = 0; i < CASES * 3; i++) {
    const actor = pick(actors), r = random();
    if (r < .35) {
      const bounds = box(), location = bounds.min.map((v, j) => f((v + bounds.max[j]) / 2));
      if (random() < .03) actor.actorFlags = 0x80;
      const result = both('addActor', hash => hash.addActor(actor, bounds, {location, actorFlags: actor.actorFlags}));
      actor.actorFlags = 0;
      if (result) registered.set(actor, {bounds, location});
    } else if (r < .55) {
      const entry = registered.get(actor), wrong = random() < .05;
      both('removeActor', hash => hash.removeActor(actor, wrong ? box() : entry?.bounds, {location: entry?.location}));
      if (!wrong) registered.delete(actor);
    } else if (r < .8) {
      const b = box(), start = b.min, end = random() < .2 ? start : b.max;
      const query = {start, end, extent: random() < .5 ? [0, 0, 0] : [f(random() * 40), f(random() * 40), f(random() * 50)]};
      const a = attempt(() => kernelHash.lineCandidates(query)), e = attempt(() => reference.lineCandidates(query));
      orders++;
      if (a.error || e.error ? a.error?.message !== e.error?.message : a.value.length !== e.value.length || a.value.some((v, j) => v !== e.value[j]))
        mismatch('hash line visit order', {query, kernel: a.error?.message ?? a.value?.map(v => v.id), javascript: e.error?.message ?? e.value?.map(v => v.id)});
      // The query itself (callbacks in visit order, reversed hits).
      const calls = [[], []];
      const hits = [kernelHash, reference].map((hash, j) => attempt(() => hash.actorLineCheck(query, hit => { calls[j].push(hit.id); return hit.id % 3 ? hit.id : null; })));
      if (JSON.stringify(calls[0]) !== JSON.stringify(calls[1]) || JSON.stringify(hits[0].value) !== JSON.stringify(hits[1].value) || hits[0].error?.message !== hits[1].error?.message)
        mismatch('hash actorLineCheck', {query});
    } else {
      const bounds = box();
      const a = attempt(() => kernelHash.boundsCandidates({bounds})), e = attempt(() => reference.boundsCandidates({bounds}));
      orders++;
      if (a.error || e.error ? a.error?.message !== e.error?.message : a.value.length !== e.value.length || a.value.some((v, j) => v !== e.value[j]))
        mismatch('hash bounds visit order', {bounds, kernel: a.error?.message ?? a.value?.length, javascript: e.error?.message ?? e.value?.length});
    }
  }
  // Re-entrant mutation and nested queries from a callback.
  const someone = [...registered.keys()][0], other = [...registered.keys()][1];
  if (someone && other) {
    const entry = registered.get(someone), q = {start: entry.bounds.min, end: entry.bounds.max};
    for (const [name, inner] of [['mutation', hash => hash.removeActor(other, registered.get(other).bounds)],
      ['nested', hash => hash.actorLineCheck(q, () => null)], ['nested encroachment', hash => hash.actorEncroachmentCheck({bounds: entry.bounds}, () => null)]]) {
      const outcome = [kernelHash, reference].map(hash => attempt(() => hash.actorLineCheck(q, () => inner(hash))));
      if (outcome[0].error?.message !== outcome[1].error?.message || !outcome[0].error) mismatch(`hash re-entrant ${name}`, {kernel: outcome[0].error?.message, javascript: outcome[1].error?.message});
    }
  }
  count('hashOperations', CASES * 3);
  count('hashOrders', orders);
}

// ---------------------------------------------------------------------------
// 3. Real levels.
const root = gameDirectory(), files = [];
if (only('levels')) for (const directory of ['Maps', 'System', 'Textures']) for (const name of await readdir(path.join(root, directory)))
  files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files), defaults = new ClassDefaults(assets);
const FLAGS = [0x17, 0x17, 6, 6, 6, 0x37, 0x37, 4, 2, 1, 8, 0x10, 0x30, 0x14, 0x1f, 0x3f, 0, 0x16, 0x13];
const BOXES = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [20, 20, 43], [25, 25, 40], [16, 16, 16], [f(18), f(18), f(38.7)], [1, 1, 1],
  [f(.001), f(.001), f(.001)], [0, 0, 5], [12.5, 12.5, 0]];
const timing = [];

for (const name of only('levels') ? ['00_Training', '01_NYC_UNATCOIsland'] : []) {
  const asset = await assets.get(name), map = decodeMap(asset.bytes), model = map.model;
  // The colliding actors as game.mjs builds them.
  const byIndex = new Map(), actors = [];
  for (const actor of map.actors) byIndex.set(actor.index, actor);
  for (const actor of map.actors) {
    const v = await defaults.forActor(asset, actor);
    if (!v.Location || !v.bCollideActors) continue;
    const host = {name: actor.name, index: actor.index, values: v};
    host.lineage = await defaults.lineage(asset, asset.pkg.exports[actor.index - 1].classIndex);
    host.collisionBits = 1 | (v.bBlockActors ? 4 : 0) | (v.bBlockPlayers ? 8 : 0) | (v.bProjTarget ? 16 : 0);
    host.flags = host.collisionBits | (v.bCollideWorld ? 2 : 0);
    host.actorFlags = (v.bStatic ? 1 : 0) | (v.bDeleteMe ? 0x80 : 0) | (v.bCollideWhenPlacing ? 0x20000 : 0) | (v.bMovable ? 0x80000 : 0);
    if (v.bIsMover && v.Brush > 0) {
      host.model = readModel(asset.pkg, asset.bytes, v.Brush);
      host.position = v.Location.map(f);
      host.collisionValues = {...v, get Location() { return host.position; }, get Rotation() { return host.rotation ?? v.Rotation; }};
    } else {
      Object.assign(host, {position: [...v.Location], radius: v.CollisionRadius ?? 0, height: v.CollisionHeight ?? 0});
      // A live cylinder, as linkDecorationCollision gives a moved actor.
      host.collisionValues = {...v, get Location() { return host.position; },
        get CollisionRadius() { return host.radius ?? v.CollisionRadius ?? 0; }, get CollisionHeight() { return host.height ?? v.CollisionHeight ?? 0; }};
    }
    actors.push(host);
  }
  for (const host of actors) host.owner = byIndex.has(host.values.Owner) ? actors.find(a => a.index === host.values.Owner) ?? null : null;
  // Twins: second registrations of identical cylinders (equal hit times, the
  // qsort's tie order).
  for (const host of actors.filter(a => !a.model).slice(0, 40)) {
    const twin = {...host, name: `${host.name}Twin`, position: [...host.position]};
    twin.collisionValues = {...host.values, get Location() { return twin.position; },
      get CollisionRadius() { return twin.radius; }, get CollisionHeight() { return twin.height; }};
    actors.push(twin);
  }
  const options = {extentCheck: traceExtent};
  const k = createLevelQueries(model, actors, options);
  // The JavaScript reference, with the same level info object.
  const levelInfo = k.levelInfo;
  const jq = createLevelQueries(model, [], {...options, kernel: false, levelInfo});
  for (const actor of actors) jq.addActor(actor);
  const anchors = actors.map(a => a.position.map(f));
  const cylinders = actors.filter(a => !a.model), movers = actors.filter(a => a.model);
  // Owner chains for sources: some reach candidates, one reaches the level.
  const sources = [null, null, ...cylinders.slice(0, 20), {name: 'viewOfFirst', owner: cylinders[0]}, {name: 'ownedByLevel', owner: levelInfo},
    {name: 'chain', owner: {name: 'mid', owner: cylinders[1] ?? null}}];

  const both = (label, run, input) => {
    count('levelQueries');
    const a = attempt(() => run(k)), e = attempt(() => run(jq));
    if (a.error || e.error) {
      count('levelThrows');
      if (a.error?.message !== e.error?.message) mismatch(`${label} error`, {...input, kernel: a.error?.message ?? 'answers', javascript: e.error?.message ?? 'answers'});
      return;
    }
    const d = lineResultDifference(a.value, e.value);
    if (d) mismatch(`${label}${d}`, input);
    else if (Array.isArray(a.value) ? a.value.length : !a.value.outside) count('levelHits');
  };
  const segment = () => {
    const anchor = pick(anchors), kind = random();
    const near = (s, size) => s.map((v, i) => f(v + signed(i === 2 ? size / 3 : size)));
    if (kind < .35) { const s = near(anchor, 120); return [s, near(s, 100)]; }
    if (kind < .5) { const s = near(anchor, 30); return [s, near(anchor, 60)]; }
    if (kind < .62) { const s = near(anchor, 1500); return [s, near(s, 3000)]; }
    if (kind < .72) { const s = near(anchor, 60); return [s, [s[0], s[1], f(s[2] - random() * 200)]]; }
    if (kind < .8) { const s = near(anchor, 200); return [s, [...s]]; }
    if (kind < .88) {
      // A walking-surface scan: from inside the actor's cylinder outward.
      const a = pick(cylinders), r = f(a.radius), yaw = random() * Math.PI * 2;
      const s = [a.position[0], a.position[1], f(a.position[2] - f(a.height * f(.95)))];
      return [s, [f(s[0] + 2 * r * Math.cos(yaw)), f(s[1] + 2 * r * Math.sin(yaw)), f(s[2] + 4 * Math.floor(random() * 9))]];
    }
    if (kind < .93) {
      // Through a line of actors (ties, many hits).
      const a = pick(anchors), b = pick(anchors);
      return [a.map(v => f(v + signed(5))), b.map(v => f(v + signed(5)))];
    }
    if (kind < .96 && movers.length) {
      // Into or out of a mover brush (its node flags against the extra flags).
      // From inside its solid (the bounds' centre) or from its pivot.
      const m = pick(movers), bounds = brushCollisionBounds(m.model, m.collisionValues);
      const centre = bounds.min.map((v, i) => f((v + bounds.max[i]) / 2 + signed(1)));
      const inside = random() < .6 ? centre : m.position.map(v => f(v + signed(20)));
      const outside = centre.map((v, i) => f(v + signed(i === 2 ? 60 : 200)));
      return random() < .5 ? [inside, outside] : [outside, inside];
    }
    const s = near(anchor, 100), e = near(s, 100), target = random() < .5 ? s : e;
    target[Math.floor(random() * 3)] = pick([...HUGE, NaN, Infinity, -Infinity]);
    return [s, e];
  };
  const box = () => random() < .75 ? pick(BOXES) : random() < .7 ? [0, 1, 2].map(() => random() < .2 ? 0 : f(random() * 50))
    : [pick([-1, 0, NaN, 5]), pick([0, 3, -0]), pick([0, -2, 4])];
  const batch = size => {
    for (let i = 0; i < size; i++) {
      const [start, end] = segment(), flags = pick(FLAGS), extra = pick([0, 0, 0, 4, 0x10, 0x20, 0x104, 0x30]);
      const extent = extra & 0x30 && random() < .6 ? [0, 0, 0] : box();
      if (random() < .7) {
        const source = pick(sources);
        both('lineCheck', q => q.lineCheck(start, end, extent, flags, extra, source), {start, end, extent, flags, extra, source: source?.name ?? null});
      } else {
        const query = {end, start, extent, checkActors: random() < .85 ? 1 : 0, worldActor: random() < .75 ? levelInfo : null, extra};
        both('multiLineCheck', q => q.multiLineCheck(query), {start, end, extent, checkActors: query.checkActors, world: !!query.worldActor, extra});
      }
    }
  };
  const change = (actor, mutate) => {
    for (const q of [k, jq]) q.removeActor(actor);
    mutate();
    for (const q of [k, jq]) q.addActor(actor);
  };
  const perBatch = Math.max(50, Math.round(CASES / 20));
  for (let round = 0; round < 20; round++) {
    batch(perBatch);
    // Moves: cylinders walk, movers slide (their ToWorld follows).
    for (let m = 0; m < 30; m++) {
      const a = pick(actors);
      if (a.model) change(a, () => { a.position = a.position.map((v, i) => f(v + signed(i === 2 ? 20 : 60))); });
      else change(a, () => { a.position = a.position.map((v, i) => f(v + signed(i === 2 ? 10 : 40))); if (random() < .1) a.radius = f(random() * 60); });
    }
    // Collision bits written without re-registration (read live).
    for (let m = 0; m < 20; m++) {
      const a = pick(actors);
      a.collisionBits = pick([1, 5, 9, 13, 17, 29, 3]);
    }
    // Destroyed actors: removed, then AddActor skips them; later restored.
    const dead = pick(cylinders);
    for (const q of [k, jq]) q.removeActor(dead);
    dead.actorFlags |= 0x80;
    for (const q of [k, jq]) assert.equal(q.hash.addActor(dead, primitiveCollisionBounds(null, dead.collisionValues), {location: dead.position, actorFlags: dead.actorFlags}), null);
    batch(perBatch / 5);
    dead.actorFlags &= ~0x80;
    for (const q of [k, jq]) q.addActor(dead);
    // Live cylinders that differ from their registration (read at query
    // time, as the JavaScript does): non-finite locations, a changed radius.
    const odd = [pick(cylinders), pick(cylinders)], saved = odd.map(a => ({position: a.position, radius: a.radius, height: a.height}));
    odd[0].position = odd[0].position.map((v, i) => i === round % 3 ? pick([NaN, Infinity, -0]) : v);
    odd[1].radius = pick([f(odd[1].radius * 3), 0, NaN, -5]);
    odd[1].height = pick([odd[1].height, NaN, 0]);
    batch(perBatch / 5);
    odd.forEach((a, i) => Object.assign(a, saved[i]));
  }
  // Re-entrancy: a candidate whose Location getter mutates the hash or
  // queries it, and a source whose owner getter queries (allowed there).
  {
    const victim = pick(cylinders), bystander = cylinders.find(a => a !== victim), saved = victim.collisionValues;
    const s = victim.position.map(v => f(v - 40)), e = victim.position.map(v => f(v + 40));
    for (const [label, action] of [['mutation', q => q.removeActor(bystander)], ['nested', q => q.lineCheck(s, e, [0, 0, 0], 0x17, 0, null)],
      ['nested multi', q => q.multiLineCheck({end: e, start: s, extent: [0, 0, 0], checkActors: 1, worldActor: null})]]) {
      // The getter acts once per outer query, on the queries running it.
      let current = null;
      victim.collisionValues = {...saved, get Location() {
        const q = current;
        current = null;
        if (q) action(q);
        return victim.position;
      }, get CollisionRadius() { return victim.radius; }, get CollisionHeight() { return victim.height; }};
      for (const flags of [0x17, 6]) {
        const outcome = [k, jq].map(q => { current = q; try { return attempt(() => q.lineCheck(s, e, [0, 0, 0], flags, 0, null)); } finally { current = null; } });
        count('reentrant');
        const d = outcome[0].error || outcome[1].error ? (outcome[0].error?.message === outcome[1].error?.message ? null : `${outcome[0].error?.message} | ${outcome[1].error?.message}`)
          : lineResultDifference(outcome[0].value, outcome[1].value);
        if (d) mismatch(`re-entrant ${label} ${d}`, {flags});
        // The level is usable afterwards.
        batch(20);
      }
      current = null;
      victim.collisionValues = saved;
    }
    const querySource = {name: 'queryingOwner', get owner() { return this.q ? (this.q.lineCheck(s, e, [0, 0, 0], 6, 0, null), null) : null; }};
    const outcome = [k, jq].map(q => { querySource.q = q; return attempt(() => q.lineCheck(s, e, [0, 0, 0], 0x17, 0, querySource)); });
    const d = outcome[0].error || outcome[1].error ? outcome[0].error?.message === outcome[1].error?.message ? null : 'errors' : lineResultDifference(outcome[0].value, outcome[1].value);
    if (d) mismatch(`nested query from the filter ${d}`, {});
    count('reentrant');
  }
  // The walking-surface scanner: walkingSurfacePrelude with the kernel scan
  // (surfaceScan) and without it, on the level's real surface textures
  // (Training's ladders included), from real pawn and actor positions.
  {
    const textures = await walkingSurfaceTextures(assets, asset, model);
    const ladders = new Set(model.nodes.map((node, i) => textures[node.surface]?.outerName?.toLowerCase() === 'ladder' ? i : -1).filter(i => i >= 0));
    // Pawn stances facing ladder polygons: in front of the polygon's centre
    // by a radius, facing it, feet below its middle.
    const ladderStances = [...ladders].filter(i => model.nodes[i].vertexCount > 0).slice(0, 300).map(i => {
      const node = model.nodes[i], n = node.plane.slice(0, 3), centre = [0, 0, 0];
      for (let j = 0; j < node.vertexCount; j++) {
        const p = model.points[model.vertices[node.vertexPool + j].point];
        for (let k = 0; k < 3; k++) centre[k] += p[k] / node.vertexCount;
      }
      return {centre, n, yaw: Math.round(Math.atan2(-n[1], -n[0]) * 32768 / Math.PI)};
    });
    let scans = 0, ladderRuns = 0;
    // A texture list whose outer names differ from real data only in case or
    // nullness (a scan stops on null or 'Ladder'; the ladder branch lowercases).
    const variants = textures.map((t, i) => t && i % 5 === 1 ? {...t, outerName: pick(['LADDER', null, 'ladder', 'Ladder'])} : t);
    let scanTextures = textures;
    const prelude = (q, kernelScan, position, radius, height, yaw, owner) => {
      const textures = scanTextures;
      const log = [];
      const pawn = {position, radius, height, rotation: [0, yaw, 0], owner, physics: pick([1, 1, 2]),
        acceleration: pick([[0, 0, 0], [f(1), 0, 0]]), velocity: [0, 0, 0], viewRotation: [0, yaw, 0], groundSpeed: 320,
        lineCheck: (a, b, e, flags, extra) => q.lineCheck(a, b, e, flags, extra, pawn),
        textureForHit: hit => {
          if (hit?.actor !== q.levelInfo) return null;
          const node = model.nodes[hit.item];
          if (!node) throw new Error(`WalkTexture world hit item is not a valid BSP node: ${hit.item}`);
          return textures[node.surface] ?? null;
        },
        walkTexture: (texture, location, normal) => log.push({texture: texture?.key ?? null, location, normal}),
        flying: () => log.push('flying'),
      };
      if (kernelScan) pawn.surfaceScan = (start, ends, p, floorEnd) => q.surfaceScan(start, ends, p, floorEnd, pawn, model, textures, q.levelInfo);
      // The scan's own answer: the kernel's, or the JavaScript scan's.
      const {start, ends, floorEnd} = surfaceScanInputs(pawn);
      const scan = attempt(() => kernelScan ? q.surfaceScan(start, ends, position.map(f), floorEnd, pawn, model, textures, q.levelInfo)
        : scanSurface(pawn, start, ends, position.map(f), floorEnd));
      const hitFields = h => h && {actor: h.actor?.name ?? h.actor, item: h.item, location: h.location, normal: h.normal};
      const scanned = scan.error ? scan.error.message : JSON.stringify({index: scan.value.index, selected: hitFields(kernelScan ? scan.value.selected : scan.value.selectedHit),
        floor: hitFields(scan.value.floor)}, exact);
      const outcome = attempt(() => walkingSurfacePrelude(pawn, f(.016), 0));
      return {value: outcome.value, error: outcome.error?.message, log, velocity: pawn.velocity, scanned};
    };
    for (let i = 0; i < Math.max(200, CASES / 4); i++) {
      const a = pick(cylinders), r = random();
      let radius = random() < .8 ? f(a.radius || 20) : f(random() * 40), height = f(random() < .8 ? a.height || 40 : random() * 60);
      let position = (r < .75 ? a.position : pick(anchors)).map(v => f(v + signed(r < .5 ? 2 : 40)));
      let yaw = Math.trunc(signed(70000));
      if (r < .3 && ladderStances.length) {
        const stance = pick(ladderStances), gap = radius + signed(8);
        radius = f(random() * 10 + 15); height = f(random() * 20 + 30);
        position = stance.centre.map((v, j) => f(v + stance.n[j] * gap + (j === 2 ? height * .95 - 16 + signed(20) : signed(6))));
        yaw = stance.yaw + Math.trunc(signed(6000));
      }
      const owner = random() < .2 ? pick(actors) : undefined;
      const seedBefore = seed;
      const expected = prelude(jq, false, position, radius, height, yaw, owner);
      seed = seedBefore;
      const actual = prelude(k, true, position, radius, height, yaw, owner);
      scans++;
      if (actual.log.includes('flying')) ladderRuns++;
      if (actual.error !== expected.error || actual.value !== expected.value || JSON.stringify(actual.log, exact) !== JSON.stringify(expected.log, exact)
        || JSON.stringify(actual.velocity, exact) !== JSON.stringify(expected.velocity, exact) || actual.scanned !== expected.scanned)
        mismatch('walking-surface prelude', {position, radius, height, yaw, kernel: actual, javascript: expected});
    }
    // The variant texture list, then consecutive scans beside a mover whose
    // owner chain alternately holds it (the scan's filter answers are per call).
    scanTextures = variants;
    for (let i = 0; i < 60; i++) {
      const position = pick(anchors).map(v => f(v + signed(30))), yaw = Math.trunc(signed(65536));
      const expected = prelude(jq, false, position, f(20), f(40), yaw, undefined), actual = prelude(k, true, position, f(20), f(40), yaw, undefined);
      scans++;
      if (actual.error !== expected.error || JSON.stringify(actual.log, exact) !== JSON.stringify(expected.log, exact) || actual.scanned !== expected.scanned)
        mismatch('walking-surface prelude, texture variants', {position, yaw, kernel: actual, javascript: expected});
    }
    scanTextures = textures;
    for (const m of movers) {
      for (let i = 0; i < 6; i++) {
        const position = m.position.map((v, j) => f(v + signed(j === 2 ? 20 : 40))), yaw = Math.trunc(signed(65536));
        const owner = i % 2 ? m : undefined;
        const expected = prelude(jq, false, position, f(24), f(40), yaw, owner), actual = prelude(k, true, position, f(24), f(40), yaw, owner);
        scans++;
        if (actual.error !== expected.error || JSON.stringify(actual.log, exact) !== JSON.stringify(expected.log, exact) || actual.scanned !== expected.scanned)
          mismatch('walking-surface prelude beside an owned mover', {position, yaw, owner: owner?.name, kernel: actual, javascript: expected});
      }
    }
    // A candidate whose Location read throws: the same error from both.
    {
      const victim = cylinders[3] ?? cylinders[0], saved = victim.collisionValues;
      victim.collisionValues = {...saved, get Location() { throw new Error('Location read fails'); },
        get CollisionRadius() { return victim.radius; }, get CollisionHeight() { return victim.height; }};
      for (let i = 0; i < 20; i++) {
        const position = victim.position.map(v => f(v + signed(30))), yaw = Math.trunc(signed(65536));
        const expected = prelude(jq, false, position, f(20), f(40), yaw, undefined), actual = prelude(k, true, position, f(20), f(40), yaw, undefined);
        scans++;
        if (actual.error !== expected.error || JSON.stringify(actual.log, exact) !== JSON.stringify(expected.log, exact) || actual.scanned !== expected.scanned)
          mismatch('walking-surface prelude with a throwing read', {position, kernel: actual.error, javascript: expected.error});
        if (expected.error) count('scanThrows');
      }
      victim.collisionValues = saved;
    }
    count('scans', scans);
    count('ladderScans', ladderRuns);
  }
  // Timing: the same walking-style queries through each.
  const scans = [];
  for (let i = 0; i < 3000; i++) {
    const a = pick(cylinders), r = f(a.radius), yaw = random() * Math.PI * 2;
    const s = [a.position[0], a.position[1], f(a.position[2] - f(a.height * f(.95)))];
    scans.push([s, [f(s[0] + 2 * r * Math.cos(yaw)), f(s[1] + 2 * r * Math.sin(yaw)), f(s[2] + 4 * Math.floor(random() * 9))], a]);
  }
  const time = q => { const t0 = performance.now(); for (let r = 0; r < 5; r++) for (const [s, e, a] of scans) q.lineCheck(s, e, [0, 0, 0], 6, 0, a); return (performance.now() - t0) / 5; };
  time(jq); time(k);
  timing.push(`${name}: ${actors.length} actors (${movers.length} movers), ${scans.length} scan lineChecks ${time(jq).toFixed(1)}→${time(k).toFixed(1)} ms`);
}

console.log(`validate-collision-kernel: ${JSON.stringify(tally)}; kernel ${kernelStats.answered} answered, ${kernelStats.handedBack} handed back; timing JS→Rust: ${timing.join('; ')}`);
if (examples.length) console.log(examples.join('\n'));
assert.equal(tally.mismatches ?? 0, 0, 'the collision kernel answers exactly as the JavaScript');
