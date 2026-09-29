/** Differential check of the Rust BSP trace kernel (native/script-vm/src/
 * trace.rs, docs/rust-core.md step R3-a) against the JavaScript bodies it
 * transcribes: ray.mjs traceRayFast and extent-trace.mjs traceExtentJs.
 *
 * Real models: the 00_Training and 01_NYC_UNATCOIsland level BSPs and every
 * mover brush on both maps, owned through ABrush.ToWorld at key positions,
 * rotated, scaled and sheared, and through raw random coordinates. Seeded
 * segments: walking-length and long moves around actor locations, straight
 * drops, zero-length segments, endpoints on node planes and at the +-0.001
 * classification epsilons (rays) or the extent support distance (boxes),
 * starts inside solid, huge, infinite and NaN coordinates, and the extra node
 * flags (rays) and extents the callers use plus edge values. Synthetic models
 * cover what the kernel hands back (invalid links, non-number planes).
 *
 * Every case compares the kernel's own answer with the JavaScript body (by
 * Object.is on every number, and the result's key order), and the exported
 * traceRay/traceExtent with the JavaScript body, errors included. A kernel
 * hand-back is allowed only where the JavaScript throws. Also compared: the
 * kernel's software Math.sqrt and its storedSupport (with constructed float32
 * midpoints, which take the exact 64-bit path).
 *
 * TRACE_CASES (default 20000) sets the random rays per level; extents and
 * brush cases scale with it. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ClassDefaults} from '../src/unreal/classes.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {readModel} from '../src/unreal/model.mjs';
import {brushCollisionBounds} from '../src/runtime/brush-bounds.mjs';
import {brushToWorld} from '../src/runtime/coords.mjs';
import {traceRay, traceRayFast} from '../src/runtime/ray.mjs';
import {traceExtent, traceExtentJs, storedSupport} from '../src/runtime/extent-trace.mjs';
import {loadTraceKernel, sameTraceResult} from '../src/runtime/trace-kernel.mjs';
import {gameDirectory} from './game-directory.mjs';

const kernel = await loadTraceKernel();
assert.ok(kernel, 'the trace kernel loads (TRACE_KERNEL=js disables it)');
const x = kernel.x;
const f = Math.fround, CASES = Number(process.env.TRACE_CASES ?? 20000);
let seed = 0x7e3a11;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const pick = list => list[Math.floor(random() * list.length)];
const signed = size => (random() * 2 - 1) * size;
const add = (a, b) => a.map((v, i) => f(v + b[i]));

const tally = {cases: 0, rays: 0, rayHits: 0, extents: 0, extentHits: 0, handedBack: 0, throws: 0, mismatches: 0};
const examples = [], reasons = new Map();
const exact = (key, v) => typeof v === 'number' && (Object.is(v, -0) || !Number.isFinite(v)) ? (Object.is(v, -0) ? '-0' : String(v)) : v;
function mismatch(reason, input) {
  tally.mismatches++;
  reasons.set(reason.slice(0, 60), (reasons.get(reason.slice(0, 60)) ?? 0) + 1);
  if (examples.length < 8) examples.push(JSON.stringify({reason, ...input}, exact).slice(0, 600));
}
const attempt = call => { try { return {value: call()}; } catch (error) { return {error}; } };

/** One case: the kernel's answer, the JavaScript body and the exported entry.
 * On a decoded model the kernel hands back only cases the JavaScript throws
 * on; a synthetic model may be one it does not take (non-number planes, no
 * root, no nodes, non-int32 hull words). */
let synthetic = false;
function check(kind, model, direct, reference, exported, input) {
  tally.cases++;
  tally[kind]++;
  const answer = direct(), expected = attempt(reference), actual = attempt(exported);
  if (expected.error) tally.throws++;
  if (answer === undefined) {
    tally.handedBack++;
    if (!expected.error && !synthetic) mismatch('kernel hands back a case the JavaScript answers', input);
  } else if (expected.error) {
    mismatch(`kernel answers where the JavaScript throws: ${expected.error.message}`, input);
  } else if (!sameTraceResult(answer, expected.value)) {
    mismatch('kernel result', {...input, kernel: answer, javascript: expected.value});
  } else if (answer) {
    tally[kind === 'rays' ? 'rayHits' : 'extentHits']++;
  }
  if (expected.error ? actual.error?.message !== expected.error.message : actual.error || !sameTraceResult(actual.value, expected.value))
    mismatch('exported entry', {...input, exported: actual.error?.message ?? actual.value, javascript: expected.error?.message ?? expected.value});
}
function ray(model, start, end, flags = 0, coords = null) {
  check('rays', model, () => kernel.ray(model, start, end, flags, coords), () => traceRayFast(model, start, end, flags, coords),
    () => traceRay(model, start, end, flags, coords), {start, end, flags, coords});
}
function extent(model, start, end, box, coords = null) {
  check('extents', model, () => kernel.extent(model, start, end, box, coords), () => traceExtentJs(model, start, end, box, coords),
    () => traceExtent(model, start, end, box, coords), {start, end, box, coords});
}

const FLAGS = [0, 0, 0, 0, 0x10, 0x10, 6, 1, 2, 4, 0x20, 0x21, 0x31, 0x100, -1, 0xffffffff, 0x7fffffff];
const BOXES = [[20, 20, 43], [16, 16, 16], [40, 40, 52], [20, 20, 43].map(v => f(v * f(.9))), [1, 1, 1],
  [f(.001), f(.001), f(.001)], [0, 0, 5], [5, 0, 0], [0, 7, 0], [12.5, 12.5, 0]];
const box = () => random() < .6 ? pick(BOXES) : [0, 1, 2].map(() => random() < .15 ? 0 : f(random() * 60));
const HUGE = [1e6, -1e6, 1e10, 3.4e38, -3.4e38, 1e39, -1e39, Infinity, -Infinity, NaN, 1e-45, -0];
const EPSILONS = [-.001001, -.001, -.000999, 0, .000999, .001, .001001];

/** A point on node `index`'s plane near `anchor`, and the plane's unit normal. */
function onPlane(plane, anchor) {
  const n = plane.slice(0, 3), square = n[0] ** 2 + n[1] ** 2 + n[2] ** 2;
  const distance = (anchor[0] * n[0] + anchor[1] * n[1] + anchor[2] * n[2] - plane[3]) / square;
  const length = Math.sqrt(square);
  return {point: anchor.map((v, i) => v - n[i] * distance), unit: n.map(v => v / length)};
}
function tangent(unit, size) {
  const axis = Math.abs(unit[2]) < .9 ? [0, 0, 1] : [1, 0, 0];
  const t = [unit[1] * axis[2] - unit[2] * axis[1], unit[2] * axis[0] - unit[0] * axis[2], unit[0] * axis[1] - unit[1] * axis[0]];
  const length = Math.hypot(...t) || 1, scale = signed(size) / length;
  return t.map(v => v * scale);
}

/** Segments around the anchors: walking moves, long moves, drops, zero
 * length, plane-grazing and edge coordinates. */
function segment(model, anchors, boxExtent = null) {
  const anchor = pick(anchors), kind = random();
  if (kind < .35) {
    const start = add(anchor, [signed(300), signed(300), signed(100)]);
    return [start, add(start, [signed(60), signed(60), signed(60)])];
  }
  if (kind < .5) {
    const start = add(anchor, [signed(2000), signed(2000), signed(600)]);
    return [start, add(start, [signed(4000), signed(4000), signed(1200)])];
  }
  if (kind < .6) {
    const start = add(anchor, [signed(200), signed(200), signed(60)]);
    return [start, add(start, [0, 0, -random() * 200])];
  }
  if (kind < .68) {
    const start = add(anchor, [signed(3000), signed(3000), signed(1000)]);
    return [start, [...start]];
  }
  if (kind < .92) {
    const node = pick(model.nodes), {point, unit} = onPlane(node.plane, add(anchor, [signed(200), signed(200), signed(100)]));
    const push = boxExtent ? Math.abs(unit[0]) * boxExtent[0] + Math.abs(unit[1]) * boxExtent[1] + Math.abs(unit[2]) * boxExtent[2] : 0;
    const offset = () => pick(EPSILONS) + (boxExtent ? pick([push, -push, push * 1.1, 0]) : 0) + (random() < .3 ? signed(2) : 0);
    const a = offset(), b = random() < .5 ? a : offset(), t = tangent(unit, 40);
    return [point.map((v, i) => f(v + unit[i] * a)), point.map((v, i) => f(v + t[i] + unit[i] * b))];
  }
  const start = add(anchor, [signed(100), signed(100), signed(100)]), end = add(start, [signed(100), signed(100), signed(100)]);
  const target = random() < .5 ? start : end;
  target[Math.floor(random() * 3)] = pick(HUGE);
  if (random() < .3) target[Math.floor(random() * 3)] = pick(HUGE);
  return [start, end];
}

// Kernel pieces with their own JavaScript counterparts.
{
  const view = new DataView(new ArrayBuffer(8));
  let checked = 0, bad = 0;
  const sqrtCase = v => { checked++; if (!Object.is(x.trace_test_sqrt(v), Math.sqrt(v))) bad++; };
  for (const v of [0, -0, 1, 2, 4, Infinity, -Infinity, NaN, -1, 5e-324, 2.2250738585072014e-308, Number.MAX_VALUE, 1 - 2 ** -53, 4 - 2 ** -50]) sqrtCase(v);
  for (let i = 0; i < CASES * 20; i++) {
    view.setUint32(0, (random() * 2 ** 31) >>> 0); view.setUint32(4, (random() * 2 ** 32) >>> 0);
    sqrtCase(view.getFloat64(0)); sqrtCase(f(random() * 1e5)); sqrtCase(i * i + (i & 1));
  }
  assert.equal(bad, 0, 'kernel sqrt equals Math.sqrt');
  tally.sqrt = checked;
}
{
  const f32 = () => f((random() < .5 ? -1 : 1) * random() * 2 ** Math.floor(signed(40)));
  let checked = 0, midpoints = 0, bad = 0;
  const supportCase = (p, e) => {
    checked++;
    const value = Math.abs(p[2] * e[2]) + Math.abs(p[1] * e[1]) + Math.abs(p[0] * e[0]), stored = f(value);
    if (value !== stored && Math.abs(value - stored) === 2 ** (Math.floor(Math.log2(value)) - 24)) midpoints++;
    if (!Object.is(x.trace_test_stored_support(p[0], p[1], p[2], e[0], e[1], e[2]), storedSupport(p, e))) bad++;
  };
  for (let i = 0; i < CASES * 5; i++) {
    supportCase([f32(), f32(), f32()], [f32(), f32(), f32()].map(Math.abs));
    // A float32 A, an odd multiple of half its unit, and a term the double
    // sum drops, in every order: the midpoint path.
    const a = f(1 + random()) * 2 ** Math.floor(signed(20)), exponent = Math.floor(Math.log2(a));
    const half = f((2 * Math.floor(random() * 4) + 1) * 2 ** (exponent - 24));
    const low = f(random() * 2 ** (exponent - 53 - Math.floor(random() * 20)));
    const terms = [a, half, low].sort(() => random() - .5), scale = pick([1, 2, .5, .25]);
    supportCase(terms.map(v => f(v / scale)).map((v, j) => j === 1 && random() < .5 ? -v : v), [scale, scale, scale]);
  }
  assert.equal(bad, 0, 'kernel storedSupport equals the JavaScript');
  assert.ok(midpoints > CASES, 'storedSupport midpoint cases were exercised');
  tally.support = checked;
  tally.supportMidpoints = midpoints;
}

// Synthetic models: the one-plane ray fixture and models the kernel hands back.
synthetic = true;
const plane = (extra = {}) => ({rootOutside: 1, leafHulls: [], nodes: [{plane: [1, 0, 0, 0], back: -1, front: -1,
  coplanar: -1, collisionBound: -1, vertexCount: 4, flags: 0, ...extra}]});
for (const model of [plane(), plane({front: 7}), plane({plane: [1, 0, 0]}), plane({plane: [1, 0, 0, '0']}),
  {...plane(), rootOutside: undefined}, {rootOutside: 0, leafHulls: [], nodes: []}, plane({collisionBound: 0}),
  {...plane({collisionBound: 0}), leafHulls: [0, -1, 1.5, 0, 0, 0, 0, 0]}, {...plane({collisionBound: 0}), leafHulls: [0, -1, 0, 0, 0, 0, 0, 0]}]) {
  for (const a of [-10, -.001001, -.001, -.000999, 0, .000999, .001, .001001, 10]) {
    for (const b of [-10, -.001001, -.001, 0, .001, .001001, 10]) {
      for (const flags of [0, 0x10, 1]) ray(model, [f(a), 0, 0], [f(b), 1, 0], flags);
      extent(model, [f(a), 0, 0], [f(b), 1, 0], [1, 1, 1]);
    }
  }
  for (const bad of [[0, 0, 0], [-1, 1, 1], [NaN, 1, 1], [1, 1]]) extent(model, [0, 0, 0], [5, 0, 0], bad);
  extent(model, [Infinity, 0, 0], [5, 0, 0], [1, 1, 1]);
}
// A 40,000-node chain: traversals deeper than the kernel's scratch stacks
// (handed back), and an upload that makes the arena grow before the levels.
const chain = {rootOutside: 1, leafHulls: [], nodes: Array.from({length: 40000}, (_, i) => ({plane: [1, 0, 0, i],
  back: -1, front: i + 1 < 40000 ? i + 1 : -1, collisionBound: -1, vertexCount: i % 7 ? 4 : 0, flags: i % 5 ? 0 : 0x20}))};
const deepBefore = tally.handedBack;
for (const length of [0, 50, 2000, 2100, 5000]) {
  for (const flags of [0, 0x10]) {
    ray(chain, [f(-.5), 0, 0], [f(length + .25), 3, 0], flags);
    ray(chain, [f(length + .25), 0, 0], [f(-.5), 3, 0], flags);
  }
  extent(chain, [f(length + .25), 0, 0], [f(-.5), 3, 0], [2, 2, 2]);
}
tally.deepHandedBack = tally.handedBack - deepBefore;
synthetic = false;

// Real levels and their mover brushes.
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System']) for (const name of await readdir(path.join(root, directory)))
  files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files), defaults = new ClassDefaults(assets), timing = [];
for (const name of ['00_Training', '01_NYC_UNATCOIsland']) {
  const asset = await assets.get(name), map = decodeMap(asset.bytes), model = map.model;
  const anchors = map.actors.map(actor => actor.values.Location).filter(v => Array.isArray(v) && v.length === 3).map(v => v.map(f));
  // Level rays and extents, then a timing pass over the same walking-style
  // inputs (kernel against JavaScript).
  const walking = [];
  for (let i = 0; i < CASES; i++) {
    const [start, end] = segment(model, anchors), flags = pick(FLAGS);
    ray(model, start, end, flags);
    if (i < 2000) walking.push([start, end, flags]);
  }
  const boxes = [];
  for (let i = 0; i < CASES / 4; i++) {
    const b = box(), [start, end] = segment(model, anchors, b);
    extent(model, start, end, b);
    if (i < 500) boxes.push([start, end, b]);
  }
  const time = run => { const t0 = performance.now(); for (let r = 0; r < 5; r++) run(); return (performance.now() - t0) / 5; };
  const safe = call => { try { call(); } catch {} };
  timing.push(`${name} ${walking.length} rays ${time(() => walking.forEach(([s, e, fl]) => safe(() => traceRayFast(model, s, e, fl)))).toFixed(1)}→` +
    `${time(() => walking.forEach(([s, e, fl]) => safe(() => kernel.ray(model, s, e, fl)))).toFixed(1)} ms, ${boxes.length} extents ` +
    `${time(() => boxes.forEach(([s, e, b]) => safe(() => traceExtentJs(model, s, e, b)))).toFixed(1)}→` +
    `${time(() => boxes.forEach(([s, e, b]) => safe(() => kernel.extent(model, s, e, b)))).toFixed(1)} ms`);

  for (const actor of map.actors) {
    const values = await defaults.forActor(asset, actor);
    if (!values.bIsMover || !(values.Brush > 0)) continue;
    const brush = readModel(asset.pkg, asset.bytes, values.Brush);
    const owners = [0, .5, 1].map(fraction => ({...values,
      Location: values.Location.map((v, i) => f(v + (values['KeyPos[1]']?.[i] ?? 0) * fraction)),
      Rotation: (values.Rotation ?? [0, 0, 0]).map((v, i) => Math.trunc(v + (values['KeyRot[1]']?.[i] ?? 0) * fraction))}));
    for (let i = 0; i < 3; i++) owners.push({...values, Rotation: [0, 1, 2].map(() => Math.trunc(signed(65536))),
      ...(i ? {MainScale: {scale: [f(.5 + random() * 2), f(.5 + random()), pick([1, -1])], shearRate: f(signed(.6)), shearAxis: 1 + Math.floor(random() * 6)},
        PostScale: {scale: [f(.75), f(1.5), f(2)]}} : {})});
    const perOwner = Math.max(4, Math.round(CASES / 400));
    for (const owner of owners) {
      const coords = brushToWorld(owner), bounds = brushCollisionBounds(brush, owner);
      const center = bounds.min.map((v, i) => f((v + bounds.max[i]) / 2)), span = bounds.min.map((v, i) => bounds.max[i] - v + 80);
      for (let i = 0; i < perOwner; i++) {
        const start = center.map((v, j) => f(v + signed(span[j]))), end = random() < .1 ? [...start] : center.map((v, j) => f(v + signed(span[j])));
        ray(brush, start, end, pick(FLAGS), coords);
        extent(brush, start, end, box(), coords);
      }
    }
    // Raw coordinates: any twelve floats.
    for (let i = 0; i < 4; i++) {
      const coords = Array.from({length: 12}, (_, j) => f(j < 3 ? values.Location[j] + signed(50) : signed(2)));
      const start = values.Location.map(v => f(v + signed(300))), end = values.Location.map(v => f(v + signed(300)));
      ray(brush, start, end, pick(FLAGS), coords);
      extent(brush, start, end, box(), coords);
    }
  }
}

const s = kernel.stats;
console.log(`validate-trace-kernel: ${tally.cases} cases (${tally.rays} rays, ${tally.rayHits} hits; ${tally.extents} extents, ` +
  `${tally.extentHits} hits; ${tally.throws} JavaScript throws, ${tally.handedBack} handed back, ${tally.deepHandedBack} of them deeper than ` +
  `the scratch stacks), ${tally.mismatches} mismatches; ` +
  `${tally.sqrt} sqrt, ${tally.support} storedSupport (${tally.supportMidpoints} midpoints) bit-identical; ${s.models} models uploaded (arena ${kernel.arena.memory.buffer.byteLength / 2 ** 20} MiB); ` +
  `timing JS→Rust: ${timing.join('; ')}`);
if (examples.length) console.log([...reasons].map(([r, n]) => `${n} ${r}`).join('\n') + '\n' + examples.join('\n'));
assert.equal(tally.mismatches, 0, 'the trace kernel answers exactly as the JavaScript');
