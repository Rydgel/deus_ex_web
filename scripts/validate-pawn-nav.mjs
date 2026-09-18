#!/usr/bin/env node
/* Validates src/runtime/script-pawn-nav.mjs against the original Engine.dll
 * navigation workers.  The oracle is scripts/native-pawn-nav-probe.py, which
 * runs the real hash-verified machine code in Unicorn with the level's
 * MoveActor (+0x88) / FarMoveActor (+0x8c) / SingleLineCheck (+0xc0) boundary
 * captured as scripted commands.  Both sides are driven with the identical
 * scripted FCheckResult sequence, so the recovered control flow is compared
 * bit-exact — return code, ordered boundary calls, and the float32 location
 * the worker leaves the pawn in.
 *
 * Covered so far: checkMove (0x103c3290), the shared per-step probe beneath
 * every reach helper.  The reach/path workers are pending (see the doc).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modulePath = path.join(root, 'src/runtime/script-pawn-nav.mjs');
const module = await import(pathToFileURL(process.env.NAV_MODULE ?? modulePath));
const python = process.env.NATIVE_PROBE_PYTHON
  || path.join(root, '.cache/native-probe-env/bin/python');
const probeScript = path.join(root, 'scripts/native-pawn-nav-probe.py');
const cacheDir = path.join(root, '.cache/pawn-nav');
const skip = reason => {
  console.log(`SKIP validate-pawn-nav: ${reason}`);
  process.exit(0);
};
if (!existsSync(python)) skip(`no probe python at ${python}`);
if (!existsSync(probeScript)) skip(`no probe at ${probeScript}`);
mkdirSync(cacheDir, { recursive: true });

const f32 = Math.fround;
const io = new DataView(new ArrayBuffer(8));
const bitsOf = v => { io.setFloat32(0, v, true); return io.getUint32(0, true); };
const bitsHex = v => bitsOf(v).toString(16).padStart(8, '0');
const vecBits = v => v.map(bitsHex);

// -- Scripted boundary hits --------------------------------------------------
const H = (time, nz, actor = 0, nx = 0, ny = 0) =>
  ({ ret: 1, hit: { time, normal: [nx, ny, nz], actor, item: -1 } });

const BASE_PAWN = {
  location: [0, 0, 0], rotation: [0, 0, 0], maxStepHeight: 24.0,
  collisionRadius: 22.0, collisionHeight: 40.0, regionZone: 'dry',
};

/* A checkMove scene: delta/scale/flag args plus the scripted MoveActor result
 * sequence the worker consumes in order. */
function cm(name, mv, { delta = [40, 0, 0], scale = 40, flag = 1, target = 0,
                        actors = null, gravityZ = -950, pawn = {} } = {}) {
  const s = {
    name, body: 'checkMove', this: 'self',
    zones: { dry: { gravityZ } },
    pawn: { ...BASE_PAWN, ...pawn },
    // delta/scale are float32 stack args; flag/target are dwords.
    directArgs: [{ f: delta[0] }, { f: delta[1] }, { f: delta[2] }, 'hitbuf',
                 target, { f: scale }, { i: flag }],
    moveActor: mv,
    // JS-side echo of the scene for the twin run.
    js: { delta, scale, flag, target, gravityZ, pawn: { ...BASE_PAWN, ...pawn } },
  };
  if (actors) s.actors = actors;
  return s;
}

const TGT = { location: [50, 0, 0] };

const scenes = [
  // Clean flat move: phase A full then a floor landing on the down-probe.
  cm('flat-reach', [H(1, 1), H(0.5, 1)]),
  cm('flat-far-drop', [H(1, 1), H(0.9, 1)]),
  // Blocked forward -> step-up/forward/step-down onto a floor.
  cm('step-up-floor', [H(0.5, 0), H(1, 1), H(1, 1), H(1, 1), H(0.5, 1)]),
  // Hit the target actor on the forward probe.
  cm('target-phaseA', [H(1, 1, 'tgt')], { target: 'tgt', actors: { tgt: TGT } }),
  cm('target-step', [H(0.5, 0), H(1, 1), H(1, 1, 'tgt')],
     { target: 'tgt', actors: { tgt: TGT } }),
  // Ledge: the down-probe runs the full drop -> -1, restore per flag.
  cm('ledge-flag1', [H(1, 1), H(1, 1)], { flag: 1 }),
  cm('ledge-flag0', [H(1, 1), H(1, 1)], { flag: 0 }),
  // Step-down lands on a wall (non-floor) -> blocked, restore, 0.
  cm('step-wall', [H(0.4, 0), H(1, 1), H(1, 1), H(0.6, 0)]),
  // Steep landing (normal.z < 0.7) -> -1, restore.
  cm('steep-landing', [H(1, 1), H(0.9, 0)]),
  cm('steep-boundary-hi', [H(1, 1), H(0.9, 0.69)]),
  cm('floor-boundary', [H(1, 1), H(0.9, 0.7)]),
  // Under-moved on a floor (displacement < scale): flag picks revert/keep.
  cm('undermoved-flag1', [H(1, 1), H(0.02, 1)], { flag: 1, scale: 40 }),
  cm('undermoved-flag0', [H(1, 1), H(0.02, 1)], { flag: 0, scale: 40 }),
  // Larger step delta + different scale.
  cm('big-step', [H(1, 1), H(0.5, 1)], { delta: [100, 0, 0], scale: 100 }),
  // Off-axis and vertical deltas.
  cm('offaxis', [H(1, 1), H(0.5, 1)], { delta: [30, 40, 0], scale: 50 }),
  // Inverted-gravity zone flips the probe sign.
  cm('lowgrav', [H(1, 1), H(0.5, 1)], { gravityZ: 50 }),
];

// ---------------------------------------------------------------------------
// Oracle: run the batch through the Unicorn probe.
// ---------------------------------------------------------------------------
function runProbe(payload) {
  return JSON.parse(execFileSync(python, [probeScript], {
    input: JSON.stringify(payload), maxBuffer: 1 << 28, encoding: 'utf8', cwd: root,
  }));
}

// ---------------------------------------------------------------------------
// JS twin: mirror the oracle's move_stub (loc += delta*hit.time) and
// farMove_stub (dest -> loc) exactly, feeding the same scripted hits in order.
// ---------------------------------------------------------------------------
function runJs(scene, mod = module) {
  const j = scene.js;
  const pawn = {
    location: j.pawn.location.map(f32), Rotation: j.pawn.rotation.slice(),
    MaxStepHeight: f32(j.pawn.maxStepHeight), zoneGravity: f32(j.gravityZ),
  };
  const scripted = scene.moveActor;
  let idx = 0, moves = 0, farMoves = 0;
  const services = {
    location: a => a.location,
    read: (a, n) => a[n],
    zoneGravity: a => a.zoneGravity,
    moveActor: (a, delta, rot, flags) => {
      moves++;
      const h = scripted[Math.min(idx, scripted.length - 1)].hit; idx++;
      a.location[0] = f32(a.location[0] + delta[0] * h.time);
      a.location[1] = f32(a.location[1] + delta[1] * h.time);
      a.location[2] = f32(a.location[2] + delta[2] * h.time);
      return { time: h.time, normal: h.normal, actor: h.actor === 'tgt' ? TGT : h.actor, item: h.item };
    },
    farMoveActor: (a, dest, test, noCheck) => { farMoves++; a.location = dest.map(f32); return 1; },
  };
  const target = j.target === 'tgt' ? TGT : j.target;
  const ret = mod.checkMove(pawn, j.delta, target, j.scale, j.flag, services);
  return { ret, moves, farMoves, locationBits: vecBits(pawn.location) };
}

function normalizeProbe(r) {
  return {
    ret: r.returned | 0,
    moves: r.counts.moveActor,
    farMoves: r.counts.farMoveActor,
    locationBits: r.pawn.locationBits,
  };
}

function compare(name, o, j) {
  const d = [];
  if (o.ret !== j.ret) d.push(`${name}: ret ${o.ret} != ${j.ret}`);
  if (o.moves !== j.moves) d.push(`${name}: moveActor calls ${o.moves} != ${j.moves}`);
  if (o.farMoves !== j.farMoves) d.push(`${name}: farMoveActor calls ${o.farMoves} != ${j.farMoves}`);
  if (o.locationBits.join() !== j.locationBits.join())
    d.push(`${name}: location ${o.locationBits} != ${j.locationBits}`);
  return d;
}

// ---------------------------------------------------------------------------
const probeResults = runProbe(scenes.map(s => {
  const { js, ...scene } = s;
  return scene;
}));

let failures = 0;
for (let i = 0; i < scenes.length; i++) {
  const r = probeResults[i];
  const scene = scenes[i];
  if (!r || r.ok === false) {
    console.log(`FAIL ${scene.name}: probe error — ${r?.error ?? 'no result'}`);
    failures++; continue;
  }
  let js;
  try { js = runJs(scene); }
  catch (e) { console.log(`FAIL ${scene.name}: js threw ${e.stack ?? e}`); failures++; continue; }
  const diffs = compare(scene.name, normalizeProbe(r.result), js);
  if (diffs.length) { failures++; diffs.forEach(d => console.log(`FAIL ${d}`)); }
}
const passed = scenes.length - failures;
console.log(`${failures ? 'FAIL' : 'PASS'} validate-pawn-nav checkMove: ${passed}/${scenes.length} scenes bit-exact`);

// ---------------------------------------------------------------------------
// Mutation coverage: each edit rewrites one behavior the disassembly dictates.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  // Phase-A target hit: unique via the `let hit` declaration.
  { name: 'actor-hit-code',
    pattern: "  let hit = moveActor(services, pawn, delta, rot);\n  if (target && hit.actor === target) return 5;",
    replacement: "  let hit = moveActor(services, pawn, delta, rot);\n  if (target && hit.actor === target) return 4;",
    expect: ['target-phaseA'] },
  // Steep-landing threshold (the down-probe 0x103c3697 site): a 0.0 bound turns
  // every steep landing into a floor landing.  Unique via the trailing comment.
  { name: 'steep-threshold',
    pattern: 'if (ltU(ld(hit.normal[2]), D07)) {                   // 0x103c3697: steep landing',
    replacement: 'if (ltU(ld(hit.normal[2]), D0)) {',
    expect: ['steep-landing', 'steep-boundary-hi'] },
  // Displacement test direction: swapping the operands inverts moved-enough.
  { name: 'displace-dir', pattern: 'if (leU(scaleSq, distSq)) return 1;',
    replacement: 'if (leU(distSq, scaleSq)) return 1;',
    expect: ['flat-reach', 'flat-far-drop', 'step-up-floor', 'big-step',
             'offaxis', 'lowgrav', 'undermoved-flag1', 'undermoved-flag0'] },
  // flag==0 ledge keeps the forward step (postLoc), not the origin.
  { name: 'ledge-flag-branch',
    pattern: 'farMove(services, pawn, postLoc);                      // 0x103c367b keep forward step',
    replacement: 'farMove(services, pawn, origLoc);',
    expect: ['ledge-flag0'] },
];

const src = readFileSync(modulePath, 'utf8');
const runtimeUrl = pathToFileURL(path.join(root, 'src/runtime/')).href;
let mutFailures = 0;
for (const mut of MUTATIONS) {
  if (!src.includes(mut.pattern)) {
    console.log(`MUTATION ${mut.name}: pattern not found — ${mut.pattern.slice(0, 60)}`);
    mutFailures++; continue;
  }
  if (src.split(mut.pattern).length !== 2) {
    console.log(`MUTATION ${mut.name}: pattern not unique`); mutFailures++; continue;
  }
  const mutated = src.replace(mut.pattern, mut.replacement)
    .replace(/from '\.\//g, `from '${runtimeUrl}`);
  const mutPath = path.join(cacheDir, `mut-${mut.name}.mjs`);
  writeFileSync(mutPath, mutated);
  let mutMod;
  try { mutMod = await import(pathToFileURL(mutPath).href + `?v=${Date.now()}`); }
  catch (e) { console.log(`MUTATION ${mut.name}: import threw ${e.message}`); mutFailures++; continue; }
  const flipped = [];
  for (let i = 0; i < scenes.length; i++) {
    const r = probeResults[i];
    if (!r?.result) continue;
    let js;
    try { js = runJs(scenes[i], mutMod); } catch { flipped.push(scenes[i].name); continue; }
    if (compare(scenes[i].name, normalizeProbe(r.result), js).length) flipped.push(scenes[i].name);
  }
  const missed = mut.expect.filter(n => !flipped.includes(n));
  if (!flipped.length || missed.length) {
    console.log(`MUTATION ${mut.name}: expected ${mut.expect.join(',')} to flip; flipped=[${flipped.join(',')}]`);
    mutFailures++;
  }
  try { unlinkSync(mutPath); } catch { /* cleaned on next run at worst */ }
}
console.log(`${mutFailures ? 'FAIL' : 'PASS'} mutation coverage: ${MUTATIONS.length - mutFailures}/${MUTATIONS.length} mutants detected`);
if (failures || mutFailures) process.exit(1);
