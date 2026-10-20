/** The level's collision queries over the model the moving brush tracker
 * left (docs/brush-tracker.md "Collision"): ULevel::MultiLineCheck's world
 * check is Level->Model's LineCheck (vtable slot 22) with the trace's extent,
 * and ULevel::MultiPointCheck's is its PointCheck (slot 21); once NF_IsNew
 * clears, the tracker's fragments are ordinary nodes of that model, so a
 * mover's polygons stop a pawn's MoveActor, a projectile and Trace where the
 * mover was last rendered. Play's bodies (ray.mjs traceRayFast for a zero
 * extent, extent-trace.mjs traceExtentJs for a box, point-check.mjs
 * modelPointCheck) over bsp-occlusion.mjs lineModel() (the Rust tracker's
 * node block in place, with the static LeafHulls) against Engine's unchanged
 * UModel::LineCheck and UModel::PointCheck under Unicorn
 * (scripts/native-tracked-linecheck-oracle.py, on the tracker oracle's level
 * model after GNewBrushTracker), on three states of each map: the static BSP,
 * the tracker after construction (Update(NULL) at PC64) and after a frame
 * that moved every mover half way to its KeyPos[1] (Update per mover at 24
 * bits, as SetupDynamics runs it). The checks are segments through and
 * across every mover, at its placed and its moved location, with five
 * extents (zero, the 1-unit and 8-unit boxes, a standing pawn's 20 x 47.5
 * and a crouched one's 20 x 20 box at radius 40), and point checks along
 * them. Every result must agree bit for bit (the hit's Time, Location, Normal
 * and Item for a line; the outside flag and the Location, Normal and Item
 * the call left for a point), and the tracker's fragments must change some line
 * and some point checks on each map.
 *
 *   node scripts/validate-tracked-collision.mjs [--map 01_NYC_UNATCOIsland] [--reuse]
 *
 * --reuse takes the oracle's answer from .work/tracked-collision/oracle-<map>.json
 * when an earlier run stored one for the same request; mismatches are written
 * beside it.
 *
 * Needs NATIVE_PROBE_PYTHON (default .cache/native-probe-env/bin/python): SKIP
 * without it. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion } from '../src/runtime/bsp-occlusion.mjs';
import { traceRayFast } from '../src/runtime/ray.mjs';
import { traceExtentJs } from '../src/runtime/extent-trace.mjs';
import { modelPointCheck } from '../src/runtime/point-check.mjs';
import { buildMap, bits, position } from './brush-tracker-request.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) { console.log('SKIP validate-tracked-collision: no native probe environment'); process.exit(0); }
const argument = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const MAPS = argument('--map') ? [argument('--map')] : ['01_NYC_UNATCOIsland', '00_Training'];
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const kernel = (await loadScriptVmKernel()).occlusion;
const f = Math.fround;
const float = word => new Float32Array(new Uint32Array([word]).buffer)[0];
let seed = 0x5c0a1d;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const EXTENTS = [[0, 0, 0], [1, 1, 1], [8, 8, 8], [20, 20, 47.5], [40, 40, 20]].map(e => e.map(f));
const POINT_EXTENTS = [[0, 0, 0], [8, 8, 8], [20, 20, 47.5]].map(e => e.map(f));

// A line's result as the oracle reports it: UBOOL (1 clear) and, blocked, the
// FCheckResult's Time, Location, Normal and Item as words.
// The zero-extent branch stores the hit node in Item (0x103f3a89/0x103f3a8c); the box branch leaves the
// caller's INDEX_NONE (FCheckResult's constructor), and Play's level hits carry no item for it.
const lineRow = (hit, ray) => hit === null ? { clear: 1 }
  : { clear: 0, time: bits(hit.time), location: hit.location.map(bits), normal: hit.normal.map(bits), item: ray ? hit.node : -1 };
const nativeLine = (clear, hit) => clear ? { clear: 1 }
  : { clear: 0, time: hit.time, location: hit.location, normal: hit.normal, item: hit.item | 0 };
const pointRow = r => ({ outside: r.outside ? 1 : 0, location: r.location.map(bits), normal: r.normal.map(bits), item: r.item });
// UModel::PointCheck's FCheckResult as it left it (modelPointCheck starts
// from the Location, a zero Normal and Item -1, as the native does).
const nativePoint = (outside, hit) => ({ outside, location: hit.location, normal: hit.normal, item: hit.item | 0 });
const playPoint = pointRow;

// Known differences of Play's bodies on the static BSP, the same in all three states (the tracker plays no part): the
// recovery outputs of one Training PointCheck where Play's bevel (103f3050's edge plane, Item -1, normal Y 0) wins the
// nearest-face tie and the original keeps hull plane 5683 (normal Y -5.48e-17). The outside flag agrees. Open in
// docs/point-check.md ("Recovery tie between a hull plane and its bevel").
const KNOWN = { '00_Training': ['point DeusExMover25 moved level #1 step 1 8x8x8', 'point DeusExMover25 moved level #1 step 1 20x20x47.5'] };
const report = [];
let failed = false;
for (const mapName of MAPS) {
  const built = await buildMap(assets, mapName), model = built.map.model;
  const placed = built.actors.map(a => a.locationBits.map(float));
  // The moved state: every mover half way from KeyPos[0] to KeyPos[1] (one
  // SetupDynamics frame, every visible mover updated at 24 bits).
  const moved = Object.fromEntries(built.actors.map(a => [a.name, position(built.movers[a.name], { from: 0, to: 1, alpha: 0.5 })]));
  const checks = [], points = [];
  const segment = (label, at, direction, a, b) => {
    const n = Math.hypot(...direction) || 1;
    const start = at.map((v, i) => f(v - direction[i] / n * a)), end = at.map((v, i) => f(v + direction[i] / n * b));
    for (const extent of EXTENTS) checks.push({ label: `${label} ${extent.join('x')}`, start, end, extent });
    for (let k = 0; k <= 4; k++) for (const extent of POINT_EXTENTS)
      points.push({ label: `${label} step ${k} ${extent.join('x')}`, position: start.map((v, i) => f(v + (end[i] - v) * k / 4)), extent });
  };
  built.actors.forEach((mover, m) => {
    const there = [placed[m], moved[mover.name].locationBits.map(float)];
    there.forEach((at, w) => {
      const tag = `${mover.name} ${w ? 'moved' : 'placed'}`;
      for (let k = 0; k < 3; k++) segment(`${tag} #${k}`, at, [random() - .5, random() - .5, random() - .5], 60 + 200 * random(), 60 + 200 * random());
      for (let k = 0; k < 2; k++) {
        const yaw = 2 * Math.PI * random();
        segment(`${tag} level #${k}`, at, [Math.cos(yaw), Math.sin(yaw), 0], 80 + 200 * random(), 80 + 200 * random());
      }
      segment(`${tag} drop`, at, [0, 0, -1], 200, 200);
    });
  });
  // Play: the Rust tracker's model after construction (Update(NULL), PC64),
  // then the frame that moves every mover.
  const movers = built.actors.map((a, i) => ({ tag: 0x40000000 + i, flags: a.flags, locationBits: a.locationBits,
    rotation: a.rotation, prePivotBits: a.prePivotBits, mainScale: a.mainScale, postScale: a.postScale,
    specialLit: a.specialLit, polys: a.brush.polys.map(p => ({ ...p, textureKey: p.texture === null ? 0 : p.texture + 1 })) }));
  const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags: [], tracker: { movers } });
  const run = source => ({
    lines: checks.map(c => { const ray = c.extent.every(v => v === 0);
      return lineRow(ray ? traceRayFast(source, c.start, c.end) : traceExtentJs(source, c.start, c.end, c.extent), ray); }),
    points: points.map(p => playPoint(modelPointCheck(source, p.position, p.extent))),
  });
  const play = {};
  try {
    play.static = run(model);
    assert.equal(occlusion.tracker.construct({ pc64: true }), 0, 'tracker construction');
    play.tracked = run(occlusion.lineModel());
    const t = occlusion.tracker;
    built.actors.forEach((a, i) => t.setMover(i, moved[a.name]));
    built.actors.forEach((a, i) => { if (!(a.flags & 2)) assert.equal(t.update(i, { pc64: false }), 0, `${a.name}: tracker update`); });
    play.moved = run(occlusion.lineModel());
  } finally { occlusion.dispose(); }
  // The checks at the game thread's 0x037f (the word of every collision translation, native-collision-oracle.py); the tracker's
  // construction at 0x037f (Play's assumption, docs/brush-tracker.md "Precision") and the frame's Update at 0x007f (SetupDynamics, inside
  // the render pass's PC24).
  const request = { gameRoot: root, model: built.model, actors: built.actors, fillers: [], rootOutside: model.rootOutside ? 1 : 0, details: true,
    checkControlWord: 0x037f, constructControlWord: 0x037f,
    checks: checks.map(c => ({ start: c.start.map(bits), end: c.end.map(bits), extent: c.extent.map(bits) })),
    points: points.map(p => ({ position: p.position.map(bits), extent: p.extent.map(bits) })),
    moves: [{ op: 'frame', set: moved }] };
  const started = Date.now();
  // --reuse: the oracle's answer stored by an earlier run on the same request
  const cache = path.join('.work/tracked-collision', `oracle-${mapName}.json`), key = JSON.stringify(request).length;
  let original = process.argv.includes('--reuse') && existsSync(cache) ? JSON.parse(await readFile(cache, 'utf8')) : null;
  if (original?.requestLength !== key) {
    original = JSON.parse(execFileSync(python, ['scripts/native-tracked-linecheck-oracle.py'],
      { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 1 << 30 }));
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, JSON.stringify({ ...original, requestLength: key }));
  }
  const seconds = (Date.now() - started) / 1000;
  const row = { map: mapName, movers: built.actors.length, lines: checks.length, points: points.length, oracleSeconds: seconds };
  const mismatches = [];
  for (const [state, lineKey, hitKey, pointKey, pointHitKey] of [['static', 'static', 'staticHits', 'staticPoints', 'staticPointHits'],
    ['tracked', 'tracked', 'trackedHits', 'trackedPoints', 'trackedPointHits'], ['moved', 'moved', 'movedHits', 'movedPoints', 'movedPointHits']]) {
    const same = (kind, label, actual, expected, input) => {
      try { assert.deepEqual(actual, expected); } catch { mismatches.push({ state, kind, label, actual, expected, input }); }
    };
    checks.forEach((c, i) => same('line', c.label, play[state].lines[i], nativeLine(original[lineKey][i], original[hitKey][i]), c));
    points.forEach((p, i) => same('point', p.label, play[state].points[i], nativePoint(original[pointKey][i], original[pointHitKey][i]), p));
  }
  // A known static difference must stay static: the same in every state, and present.
  const known = new Set(KNOWN[mapName] ?? []);
  for (const label of known) for (const state of ['static', 'tracked', 'moved'])
    if (!mismatches.some(m => m.state === state && `${m.kind} ${m.label}` === label)) {
      console.log(`${mapName}: the known difference "${label}" agrees in the ${state} state now: update KNOWN`); failed = true;
    }
  row.knownStatic = known.size;
  mismatches.splice(0, mismatches.length, ...mismatches.filter(m => !known.has(`${m.kind} ${m.label}`)));
  if (mismatches.length) {
    const tally = {};
    for (const m of mismatches) { const k = `${m.state} ${m.kind} ${m.label.split(' ').at(-1)}`; tally[k] = (tally[k] ?? 0) + 1; }
    console.log(JSON.stringify({ map: mapName, mismatches: mismatches.length, tally }));
    for (const m of mismatches.slice(0, 6)) console.log(JSON.stringify(m));
    await writeFile(path.join('.work/tracked-collision', `mismatches-${mapName}.json`), JSON.stringify(mismatches, null, 1));
    failed = true;
  }
  const changed = (a, b, key) => play[a][key].filter((r, i) => JSON.stringify(r) !== JSON.stringify(play[b][key][i])).length;
  Object.assign(row, { trackedLines: changed('static', 'tracked', 'lines'), movedLines: changed('tracked', 'moved', 'lines'),
    trackedPoints: changed('static', 'tracked', 'points'), movedPoints: changed('tracked', 'moved', 'points'),
    blocked: play.moved.lines.filter(r => !r.clear).length, inside: play.moved.points.filter(r => !r.outside).length });
  report.push(row);
  console.log(JSON.stringify(row));
}
assert.ok(!failed, 'every result agrees with the original');
assert.ok(report.every(r => r.trackedLines > 0 && r.movedLines > 0), 'the tracker\'s fragments change some line checks on each map');
assert.ok(report.every(r => r.trackedPoints > 0 && r.movedPoints > 0), 'the tracker\'s fragments change some point checks on each map');
console.log('validate-tracked-collision: PASS');
