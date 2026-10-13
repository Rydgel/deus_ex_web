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
 * Covers checkMove/walkReach, physics dispatch, point/actor reach workers,
 * reachMask/directReach and the actorReachable exec. This comparator checks
 * verdicts, boundary counts and final field bits. Flying's full ordered-call
 * comparison is scripts/validate-pawn-flying-reach.mjs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, x87load, x87add, x87mul, x87store } from '../src/runtime/script-vm.mjs';
import { ScriptRuntime } from '../src/runtime/script-runtime.mjs';

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

/* The oracle's moveActor stub commits the displacement exactly like
 * ULevel::MoveActor: for each axis fld time; fmul m32 delta; fadd m32 loc;
 * fstp m32 loc.  Mirror that in 80-bit so partial-hit z landings round
 * identically. */
const commitMove = (loc, delta, time) => {
  const t = x87load(f32(time));   // the stub's `fld [time]` is a float32 (0.9 is stored 0.89999998)
  for (let i = 0; i < 3; i++)
    loc[i] = x87store(x87add(x87load(loc[i]), x87mul(t, x87load(delta[i]))));
};

// -- Scripted boundary hits --------------------------------------------------
const H = (time, nz, actor = 0, nx = 0, ny = 0) =>
  ({ ret: 1, hit: { time, normal: [nx, ny, nz], actor, item: -1 } });

const BASE_PAWN = {
  location: [0, 0, 0], rotation: [0, 0, 0], velocity: [0, 0, 0],
  maxStepHeight: 24.0, collisionRadius: 22.0, collisionHeight: 40.0,
  groundSpeed: 200.0, flags318: 0, field444: 0, collideFlag: 0,
  physics: 1, baseEyeHeight: 40.0,
  regionZone: 'dry', footZone: 'dry',
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

/* A walkReach scene: point/radius/arg18/target args plus the scripted MoveActor
 * sequence the ~100-step loop consumes.  Zones drive the water/pain gates; the
 * pawn's flag bits select the jump/arc/swim helpers (flag-free stays on the
 * walking path the port covers). */
function wr(name, mv, { point = [100, 0, 0], radius = 15, arg18 = 0, target = 0,
                        actors = null, zones = null, gIsEditor = 0,
                        pawn = {}, farMove = [1] } = {}) {
  const z = { dry: { gravityZ: -950 }, ...(zones || {}) };
  const s = {
    name, body: 'walkReach', this: 'self', gIsEditor,
    zones: z,
    pawn: { ...BASE_PAWN, ...pawn },
    // thiscall(pawn; point vec3, radius f, arg18 i, target ref/i).
    directArgs: [{ f: point[0] }, { f: point[1] }, { f: point[2] },
                 { f: radius }, { i: arg18 }, target === 0 ? { i: 0 } : { ref: target }],
    moveActor: mv, farMove,
    js: { point, radius, arg18, target, gIsEditor, zones: z,
          pawn: { ...BASE_PAWN, ...pawn }, actors: actors || {} },
  };
  if (actors) s.actors = actors;
  return s;
}

/* A physics-dispatch scene (0x103c1000): thiscall(pawn; point vec3, radius,
 * target).  Routes water-zone/PHYS 1/3 -> walkReach (ported), PHYS 4 ->
 * flyReach, else -> 0. Flying is covered by validate-pawn-flying-reach.mjs;
 * the water helper remains an unported service. */
function dp(name, mv, { point = [100, 0, 0], radius = 15, target = 0,
                        physics = 1, zones = null, gIsEditor = 0,
                        pawn = {}, farMove = [1] } = {}) {
  const z = { dry: { gravityZ: -950 }, ...(zones || {}) };
  const s = {
    name, body: 'dispatch', this: 'self', gIsEditor,
    zones: z,
    pawn: { ...BASE_PAWN, physics, ...pawn },
    directArgs: [{ f: point[0] }, { f: point[1] }, { f: point[2] },
                 { f: radius }, target === 0 ? { i: 0 } : { ref: target }],
    moveActor: mv, farMove,
    js: { point, radius, target, gIsEditor, zones: z,
          pawn: { ...BASE_PAWN, physics, ...pawn }, actors: {} },
  };
  return s;
}

/* A pointReachable-worker scene (0x103c0d30): thiscall(pawn; point vec3,
 * arg14).  arg14==0 runs the FastLineCheck; the worker then test-FarMoves and
 * physics-dispatches into walkReach.  pointRegion/fastLine/farMove are scripted
 * boundary results alongside the MoveActor sequence. */
function pw(name, mv, { point = [100, 0, 0], arg14 = 0, physics = 1,
                        zones = null, gIsEditor = 0, pawn = {},
                        pointRegion = ['dry'], fastLine = [1], farMove = [1, 1], farMoveAdjust = null } = {}) {
  const z = { dry: { gravityZ: -950 }, ...(zones || {}) };
  const pr = pointRegion.map(r => (typeof r === 'string' ? { zone: r } : r));
  const s = {
    name, body: 'pointWorker', this: 'self', gIsEditor,
    zones: z,
    pawn: { ...BASE_PAWN, physics, ...pawn },
    directArgs: [{ f: point[0] }, { f: point[1] }, { f: point[2] }, { i: arg14 }],
    moveActor: mv, farMove, pointRegion: pr, fastLine,
    js: { point, arg14, gIsEditor, zones: z, farMove,
          pawn: { ...BASE_PAWN, physics, ...pawn }, actors: {},
          pointRegion: pr, fastLine },
  };
  if (farMoveAdjust) s.farMoveAdjust = farMoveAdjust;
  return s;
}

/* A reachMask scene (0x10326d10): thiscall(pawn) -> 7-bit capability mask. */
function rm(name, { pawn = {} } = {}) {
  return {
    name, body: 'reachMask', this: 'self',
    pawn: { ...BASE_PAWN, ...pawn },
    js: { pawn: { ...BASE_PAWN, ...pawn } },
  };
}

/* A directReach scene (0x103dad20): thiscall(pawn; source nav, target).
 * navPoints carry paths[]/upstreamPaths[] ReachSpec index arrays; reachSpecs
 * is the level's spec table ({start,end,radius,height,flags}); singleLine is
 * the scripted SingleLineCheck sequence. */
function dr(name, { source = 'src', target = 'tgt', navPoints = null,
                    actors = null, reachSpecs = [], singleLine = [{ ret: 1, hit: { actor: 0, time: 1 } }],
                    pawn = {} } = {}) {
  const s = {
    name, body: 'directReach', this: 'self',
    zones: { dry: { gravityZ: -950 } },
    pawn: { ...BASE_PAWN, ...pawn },
    reachSpecs, singleLine,
    directArgs: [{ ref: source }, { ref: target }],
    js: { source, target, singleLine, pawn: { ...BASE_PAWN, ...pawn } },
  };
  if (navPoints) { s.navPoints = navPoints; s.js.navPoints = navPoints; }
  if (actors) { s.actors = actors; s.js.actors = actors; }
  return s;
}

/* An actorWorker scene (0x103c0630): thiscall(pawn; target, argC).  The target
 * is an actor/navpoint/inventory/trigger; zones + class drive the gates;
 * singleLine/farMove/moveActor are the scripted boundary sequences. */
function aw(name, mv, { target = 'tgt', argC = 0, actors = null, navPoints = null,
                        zones = null, gIsEditor = 0, pawn = {},
                        singleLine = null, farMove = [1, 1], farMoveAdjust = null } = {}) {
  const z = { dry: { gravityZ: -950 }, ...(zones || {}) };
  const s = {
    name, body: 'actorWorker', this: 'self', gIsEditor,
    zones: z,
    pawn: { ...BASE_PAWN, ...pawn },
    singleLine, moveActor: mv, farMove,
    directArgs: [{ ref: target }, { i: argC }],
    js: { target, argC, gIsEditor, zones: z, farMove,
          pawn: { ...BASE_PAWN, ...pawn }, actors: actors || {},
          singleLine },
  };
  if (actors) s.actors = actors;
  if (navPoints) s.navPoints = navPoints;
  if (farMoveAdjust) s.farMoveAdjust = farMoveAdjust;
  return s;
}

/* An actorReachable exec scene (0x103bc1a0): thiscall(pawn; FFrame, result*).
 * `args` carries the bytecode token stream (one object arg); the verdict lands
 * in *result (resultOut).  `navList` names the nav-list head; navpoints chain
 * via nextNav; the pawn's moveTarget is its Anchor (+0x34c). */
function ae(name, { target = 'tgt', navList = null, navPoints = null,
                    actors = null, zones = null, gIsEditor = 0, pawn = {},
                    singleLine = null, farMove = [1, 1], moveActor = [],
                    reachSpecs = [] } = {}) {
  const z = { dry: { gravityZ: -950 }, ...(zones || {}) };
  const s = {
    name, body: 'actorReachable', this: 'self', gIsEditor,
    zones: z,
    pawn: { ...BASE_PAWN, ...pawn },
    singleLine, moveActor, farMove, reachSpecs,
    args: [{ kind: 'object', value: target }],
    js: { target, gIsEditor, zones: z, farMove, navList,
          pawn: { ...BASE_PAWN, ...pawn }, actors: actors || {},
          navPoints: navPoints || {}, singleLine },
  };
  if (actors) s.actors = actors;
  if (navPoints) s.navPoints = navPoints;
  if (navList) s.navList = navList;
  return s;
}

/* A pathTowardWorker scene (0x103db3f0): thiscall(pawn; target, bSinglePath,
 * ANavigationPoint** foundbuf, bClearPaths).  The found node lands in
 * foundbuf; the nav-graph fields are the serialized NavigationPoint layout
 * (paths +0x360 / prunedPaths +0x3a0 outbound, upstreamPaths +0x320 inbound,
 * search state +0x420..+0x448).  fastLine/singleLine/farMove/moveActor/
 * pointRegion/specialCost/probing are the scripted boundary queues. */
function fp(name, { target = 'tgt', bSingle = 0, bClear = 1, navList = null,
                    navPoints = null, actors = null, zones = null, gIsEditor = 0,
                    pawn = {}, singleLine = null, farMove = [1], fastLine = [1],
                    moveActor = [], reachSpecs = [], specialCost = null,
                    probing = null, specialHandling = null, farMoveAdjust = null,
                    pointRegion = ['dry'] } = {}) {
  const z = { dry: { gravityZ: -950 }, ...(zones || {}) };
  const pr = pointRegion.map(r => (typeof r === 'string' ? { zone: r } : r));
  const s = {
    name, body: 'pathTowardWorker', this: 'self', gIsEditor,
    zones: z,
    pawn: { ...BASE_PAWN, ...pawn },
    singleLine, moveActor, farMove, fastLine, reachSpecs, pointRegion: pr,
    directArgs: [target ? { ref: target } : { i: 0 }, { i: bSingle },
                 { ref: 'foundbuf' }, { i: bClear }],
    js: { target, bSingle, bClear, gIsEditor, zones: z, farMove, fastLine,
          moveActor, navList, pawn: { ...BASE_PAWN, ...pawn },
          actors: actors || {}, navPoints: navPoints || {}, singleLine,
          specialCost, probing, specialHandling, pointRegion: pr },
  };
  if (actors) s.actors = actors;
  if (navPoints) s.navPoints = navPoints;
  if (navList) s.navList = navList;
  if (specialCost) s.specialCost = specialCost;
  if (probing) s.probing = probing;
  if (farMoveAdjust) s.farMoveAdjust = farMoveAdjust;   // {call index: [dx, dy, dz]}: the placement a successful FarMoveActor leaves the actor at
  return s;
}

/* A FindPathToward exec scene (0x103bc9c0, native 517): the three script
 * args (target object, optional bSinglePath=0, optional bClearPaths=1)
 * evaluate through the token stream; the result slot carries the found
 * actor pointer. */
function fx(name, opts = {}) {
  const { target = 'tgt', bSingle = 0, bClear = 1 } = opts;
  const s = fp(name, { ...opts, target, bSingle, bClear });
  s.body = 'findPathToward';
  delete s.directArgs;
  // The native always evaluates three GNatives args; omitted optional params
  // compile to EX_Nothing tokens so the exec's pre-initialized defaults
  // (bSinglePath=0, bClearPaths=1) survive the eval.
  const toks = [target ? { kind: 'object', value: target } : { kind: 'object', value: '__none' },
                { kind: 'int', value: bSingle }, { kind: 'int', value: bClear }];
  s.args = toks.slice(0, opts.argCount ?? 3);
  while (s.args.length < 3) s.args.push({ kind: 'nothing' });
  return s;
}

/* A pathToWorker scene (0x103dc1d0, FindPathTo's worker): thiscall(pawn;
 * FVector point, bSinglePath, ANavigationPoint** foundbuf, bClearPaths),
 * ret 0x18.  The graph/boundary options are fp()'s; there is no target
 * actor.  Every instruction of the body is recorded for the coverage check. */
function fpto(name, { point = [420, 0, 0], ...opts } = {}) {
  const s = fp(name, { ...opts, target: null });
  s.body = 'pathToWorker';
  s.directArgs = [{ f: point[0] }, { f: point[1] }, { f: point[2] }, { i: s.js.bSingle },
                  { ref: 'foundbuf' }, { i: s.js.bClear }];
  s.js.point = point;
  s.coverage = [PATH_TO_COVERAGE];
  return s;
}
/* A FindPathTo exec scene (0x103bc800, native 518): the point vector and
 * the optional bSinglePath=0 / bClearPaths=1 through the token stream; the
 * result slot carries the found actor (argCount < 3 sends EX_Nothing). */
function fxt(name, opts = {}) {
  const { point = [420, 0, 0], bSingle = 0, bClear = 1 } = opts;
  const s = fpto(name, { ...opts, point, bSingle, bClear });
  s.body = 'findPathTo';
  delete s.directArgs; s.coverage = [FIND_PATH_TO_EXEC_COVERAGE];
  s.args = [{ kind: 'vector', value: point }, { kind: 'int', value: bSingle }, { kind: 'int', value: bClear }]
    .slice(0, opts.argCount ?? 3);
  while (s.args.length < 3) s.args.push({ kind: 'nothing' });
  s.js.argCount = opts.argCount ?? 3;
  return s;
}
// The worker's body up to its SEH funclet (0x103dc5b7). The inlined
// check(XLevel->Actors(0)) and check(Actors(0)->IsA(ALevelInfo)) failure
// paths (an IsA chain ending in null, then appFailAssert) are the only
// instructions left out of the coverage requirement.
const PATH_TO_COVERAGE = ['103dc1d0', '103dc5b7'];
const PATH_TO_ASSERTS = new Set(['103dc20d', '103dc212', '103dc217', '103dc21c', '103dc222',
  '103dc23d', '103dc242', '103dc244', '103dc246', '103dc247', '103dc24a',
  '103dc24c', '103dc251', '103dc256', '103dc25b', '103dc261']);
// pathTowardWorker's falling-target delegation (0x103db4e6..0x103db567).
const DELEGATION_COVERAGE = ['103db4e6', '103db567'];
// execFindPathTo (0x103bc800..0x103bc95f). The rdtsc arms of XLevel's
// FindPath cycle stat run only with GTimestamp set (a stat, unobservable).
const FIND_PATH_TO_EXEC_COVERAGE = ['103bc800', '103bc95f'];
const FIND_PATH_TO_EXEC_STAT = new Set(['103bc88a', '103bc88c', '103bc88e', '103bc890',
  '103bc93a', '103bc93c', '103bc93e', '103bc940']);
// The tailSet call for a result that probes SpecialHandling (0x103bc906..
// 0x103bc90c): shared with 517 and, as there, not run by the oracle (the
// probe has no SpecialHandling event dispatch). Listed, not required.
const FIND_PATH_TO_EXEC_TAILSET = new Set(['103bc906', '103bc909', '103bc90b', '103bc90c']);

/* A GetPathnodeList scene (0x103c6490, ReachablePathnodes' worker):
 * thiscall(pawn; _FNavInfo* list, max, AActor* FromPoint, bUsePrunedPaths,
 * bSort), ret 0x14.  The list is the probe's 256-byte 'scratch' (32 x {node,
 * f32 dist}); all 32 slots are compared, including stale ones past the
 * count.  `levelInfo` names a fabricated LevelInfo (Actors(0), pawn.Level).
 * Every instruction of the body is recorded for the coverage check. */
function gp(name, { max = 32, from = null, pruned = 0, sort = 1, levelInfo = null, ...opts } = {}) {
  const s = fp(name, { ...opts, target: null });
  s.body = 'getPathnodeList';
  s.directArgs = [{ ref: 'scratch' }, { i: max }, from ? { ref: from } : { i: 0 },
                  { i: pruned }, { i: sort }];
  Object.assign(s.js, { max, from, pruned, sort, levelInfo });
  if (levelInfo) s.levelInfo = levelInfo;
  s.coverage = [PATHNODE_COVERAGE];
  return s;
}
/* A ReachablePathnodes exec scene (0x103c8bb0, native 1004): BaseClass,
 * out NavPoint ('foundbuf', or a non-lvalue None), FromPoint, out distance
 * ('vecbuf'), optional bUsePrunedPaths (EX_Nothing when undefined), then the
 * PRE_ITERATOR word and a body whose record token logs both out slots per
 * iteration; `breakAt` makes the body's n-th pass a script `break` (its
 * IteratorPop).  `vm` also runs the scene as compiled foreach bytecode
 * through ScriptRuntime.createIterator (breakAt 0 or 1 only). */
function rpn(name, { breakAt = 0, from = null, pruned, baseClass = '__none', navOut = 'out',
                     distOut = 'out', vm = true, ...opts } = {}) {
  const s = gp(name, opts);
  s.body = 'reachablePathnodes';
  delete s.directArgs;
  s.args = [{ kind: 'object', value: baseClass },
            navOut === 'out' ? { kind: 'out', value: 'foundbuf' } : { kind: 'object', value: '__none' },
            { kind: 'object', value: from ?? '__none' },
            distOut === 'out' ? { kind: 'out', value: 'vecbuf' } : { kind: 'float', value: 0.5 },
            pruned === undefined ? { kind: 'nothing' } : { kind: 'int', value: pruned }];
  s.iterator = { breakAt };
  s.coverage = [RPN_EXEC_COVERAGE, PATHNODE_COVERAGE];
  Object.assign(s.js, { breakAt, vm: vm && breakAt <= 1 });
  return s;
}
// GetPathnodeList up to its SEH funclet (0x103c690d).  Excluded: the inlined
// check(XLevel->Actors(0)) and check(Actors(0)->IsA(ALevelInfo)) failure
// paths before the overlap scan and before the distance scan (the LevelInfo
// IsA walk's null tail is itself the failure), then appFailAssert.
const PATHNODE_COVERAGE = ['103c6490', '103c690d'];
const PATHNODE_ASSERTS = new Set([
  '103c65a4', '103c65a9', '103c65ae', '103c65b3', '103c65b9',
  '103c65d4', '103c65d9', '103c65db', '103c65dd', '103c65de', '103c65e1',
  '103c65e3', '103c65e8', '103c65ed', '103c65f2', '103c65f8',
  '103c6791', '103c6796', '103c679b', '103c67a0', '103c67a6',
  '103c67c1', '103c67c6', '103c67c8', '103c67ca', '103c67cb', '103c67ce',
  '103c67d0', '103c67d5', '103c67da', '103c67df', '103c67e5']);
// execReachablePathnodes (0x103c8bb0..0x103c8d86): no exclusions.
const RPN_EXEC_COVERAGE = ['103c8bb0', '103c8d86'];
// Deterministic small-range draws (many ties) for the qsort scenes.
function lcg(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x >>> 16; };
}
/* A start-path list of `dists.length` entries (Paths first, then
 * PrunedPaths): the pawn overlaps n0, whose specs lead to e0..eN. */
function sortScene(name, dists, extra = {}) {
  const navPoints = { n0: { location: [5, 0, 0],
    paths: dists.slice(0, 16).map((_, i) => i),
    prunedPaths: dists.slice(16).map((_, i) => 16 + i) } };
  dists.forEach((_, i) => { navPoints[`e${i}`] = { location: [1000 + 10 * i, 0, 0] }; });
  return gp(name, { navList: 'n0', navPoints, pruned: dists.length > 16 ? 1 : 0,
    reachSpecs: dists.map((d, i) => ({ start: 'n0', end: `e${i}`, distance: d, radius: 30, height: 50, flags: 0 })),
    ...extra });
}
/* Distance-path nodes on a chain (none overlapping the pawn). */
function chain(points, extra = {}) {
  const names = points.map((_, i) => `d${i}`);
  return Object.fromEntries(points.map((location, i) =>
    [names[i], { location, ...(i + 1 < points.length ? { nextNav: names[i + 1] } : {}), ...extra }]));
}
/* f32-exact pseudo-random points at a distance in [lo, hi) of `origin`. */
function ring(count, seed, origin, lo, hi) {
  const r = lcg(seed), u = () => r() / 65536;
  return Array.from({ length: count }, () => {
    const d = lo + (hi - lo) * u(), yaw = 2 * Math.PI * u(), z = (u() - 0.5) * 0.4;
    return [origin[0] + d * Math.cos(yaw) * Math.sqrt(1 - z * z),
            origin[1] + d * Math.sin(yaw) * Math.sqrt(1 - z * z),
            origin[2] + d * z].map(f32);
  });
}

/* Alternate forward-full / down-floor hits so each checkMove step progresses
 * like a flat walk; padded at the tail to the requested depth. */
function flatWalk(depth) {
  const mv = [];
  for (let i = 0; i < depth; i++) { mv.push(H(1, 1)); mv.push(H(0.1, 1)); }
  return mv;
}

// Fill the pawn-side candidate list before encountering the only node with
// a direct route to the distant target. sortedInsert must admit that late
// node even at capacity, including before an existing equal-distance node.
function crowdedPathScene(name, firstX) {
  const navPoints = Object.fromEntries(Array.from({length: 32}, (_, i) =>
    [`n${i}`, {location: [i === 0 ? firstX : 100 + i, 0, 0],
      nextNav: i === 31 ? 'late' : `n${i + 1}`}]));
  navPoints.late = {location: [10, 0, 0], paths: [0], nextNav: 'tgt'};
  navPoints.tgt = {location: [2000, 0, 0]};
  return fx(name, {navList: 'n0', navPoints, moveActor: flatWalk(12),
    reachSpecs: [{start: 'late', end: 'tgt', distance: 1990,
      radius: 30, height: 50, flags: 0}],
    singleLine: [{ret: 1, hit: {actor: 0, time: 1}}]});
}

/* aiDirection scene (0x1036d030): thiscall(pawn; out rot*, centralYaw i,
 * yawDist f, centralPitch i, pitchDist f).  Consumes two scripted appFrand
 * draws (f64 queue) and writes {pitch,yaw,roll=0} into vecbuf. */
function ad(name, { cy = 0, yd = 0, cp = 0, pd = 0, frand = [0.5] } = {}) {
  // NaN can't cross the JSON payload: pass the raw f32 dword instead.
  const f = v => (Number.isNaN(v) ? { i: 0x7fc00000 } : { f: v });
  return {
    name, body: 'aiDirection', this: 'self',
    zones: { dry: { gravityZ: -950 } },
    pawn: { ...BASE_PAWN },
    frand,
    directArgs: [{ ref: 'vecbuf' }, { i: cy }, f(yd), { i: cp }, f(pd)],
    js: { cy, yd, cp, pd, frand, pawn: { ...BASE_PAWN } },
  };
}

/* aiPickSearch scene (0x103c78a0): thiscall(pawn; origin vec3, yaw i, pitch i,
 * minR f, maxR f, arg24 f, out vec3*).  The stepped-move loop consumes the
 * scripted MoveActor sequence through checkMove/flyMove; outNull exercises the
 * native's null-out-ptr tail. */
function as(name, mv, { origin = [0, 0, 0], yaw = 0x4000, pitch = 0,
                        minR = 40, maxR = 100, zones = null, gIsEditor = 0,
                        pawn = {}, outNull = 0 } = {}) {
  const z = { dry: { gravityZ: -950 }, ...(zones || {}) };
  return {
    name, body: 'aiPickSearch', this: 'self', gIsEditor,
    zones: z,
    pawn: { ...BASE_PAWN, ...pawn },
    directArgs: [{ f: origin[0] }, { f: origin[1] }, { f: origin[2] },
                 { i: yaw }, { i: pitch }, { f: minR }, { f: maxR }, { f: 15.0 },
                 outNull ? { i: 0 } : { ref: 'vecbuf' }],
    moveActor: mv,
    js: { origin, yaw, pitch, minR, maxR, gIsEditor, zones: z,
          pawn: { ...BASE_PAWN, ...pawn }, outNull },
  };
}

/* aiPickWorker scene (0x103c7fc0): thiscall(pawn; minDist f, maxDist f,
 * centralYaw i, yawDist f, centralPitch i, pitchDist f, tries i, mult f,
 * out vec3*).  Each try consumes two frand draws through aiDirection. */
function ap(name, mv, { minDist = 40, maxDist = 100, cy = 0x4000, yd = 1,
                        cp = 0, pd = 1, tries = 1, mult = 1, frand = [0.5],
                        zones = null, gIsEditor = 0, pawn = {}, outNull = 0 } = {}) {
  const z = { dry: { gravityZ: -950 }, ...(zones || {}) };
  return {
    name, body: 'aiPickWorker', this: 'self', gIsEditor,
    zones: z,
    pawn: { ...BASE_PAWN, ...pawn },
    frand,
    directArgs: [{ f: minDist }, { f: maxDist }, { i: cy }, { f: yd },
                 { i: cp }, { f: pd }, { i: tries }, { f: mult },
                 outNull ? { i: 0 } : { ref: 'vecbuf' }],
    moveActor: mv,
    js: { minDist, maxDist, cy, yd, cp, pd, tries, mult, frand, gIsEditor,
          zones: z, pawn: { ...BASE_PAWN, ...pawn }, outNull },
  };
}

/* aiPickExec scene (0x103c86f0, native 709): the nine script args evaluate
 * through the token stream; `out` resolves to vecbuf via GPropAddr while
 * `nothing` leaves GPropAddr=0 so the worker writes the dead temp slot. */
function ax(name, mv, { minDist = 40, maxDist = 100, cy = 0x4000, yd = 1,
                        cp = 0, pd = 1, tries = 1, mult = 1, frand = [0.5],
                        zones = null, pawn = {}, outKind = 'out' } = {}) {
  const z = { dry: { gravityZ: -950 }, ...(zones || {}) };
  return {
    name, body: 'aiPickExec', this: 'self',
    zones: z,
    pawn: { ...BASE_PAWN, ...pawn },
    frand,
    moveActor: mv,
    args: [{ kind: 'float', value: minDist }, { kind: 'float', value: maxDist },
           { kind: 'int', value: cy }, { kind: 'float', value: yd },
           { kind: 'int', value: cp }, { kind: 'float', value: pd },
           { kind: 'int', value: tries }, { kind: 'float', value: mult },
           outKind === 'out' ? { kind: 'out', value: 'vecbuf' } : { kind: 'nothing' }],
    js: { args: [minDist, maxDist, cy, yd, cp, pd, tries, mult], frand,
          outRef: outKind === 'out', zones: z, pawn: { ...BASE_PAWN, ...pawn } },
  };
}

const scenes = [
  // Clean flat move: phase A full then a floor landing on the down-probe.
  cm('flat-reach', [H(1, 1), H(0.5, 1)]),
  cm('flat-far-drop', [H(1, 1), H(0.9, 1)]),
  // The original prologue clears Delta.Z before the first MoveActor call.
  cm('incoming-z-cleared', [H(1, 1), H(0.5, 1)], { delta: [40, 0, 100] }),
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

  // -- walkReach (0x103c1b70) -----------------------------------------------
  // Flat walk to a point 100 units away: ~5 innerRadius steps, then arrival.
  wr('wr-flat-reach', flatWalk(20), { pawn: { collisionRadius: 20 } }),
  // A longer walk exercises more loop iterations.
  wr('wr-flat-far', flatWalk(30), { point: [300, 0, 0], pawn: { collisionRadius: 20 } }),
  // Pawn already inside the inner radius -> arrival on iteration 1, no probe.
  wr('wr-inside-radius', flatWalk(4), { point: [10, 0, 0], pawn: { collisionRadius: 20 } }),
  // Point below with |dz| < step -> reached via the arrival |dz| gate.
  wr('wr-below-step', flatWalk(20), { point: [60, 0, -20], pawn: { collisionRadius: 20 } }),
  // Blocked with collide flag clear -> reached=0 immediately (fail).
  wr('wr-blocked-nocollide', [H(1, 1), H(1, 1)], { pawn: { collideFlag: 0 } }),
  // Steep landing on the down-probe -> -1, collide set but no jump/swim bits ->
  // innerRadius(20) <= maxStep(24) so no retry: reached=0.
  wr('wr-ledge-noflags', [H(1, 1), H(0.9, 0)], { pawn: { collideFlag: 1 } }),
  // CR(30) > maxStep(24): a ledge clamps innerRadius to maxStep and retries the
  // loop; with no floor ever it exhausts and fails.
  wr('wr-ledge-clamp', [H(1, 1), H(0.9, 0)],
     { pawn: { collisionRadius: 30, collideFlag: 1 } }),
  // Diagonal target direction exercises the flat SafeNormal far step.
  wr('wr-diagonal', flatWalk(20), { point: [200, 100, 0], pawn: { collisionRadius: 20 } }),
  // Foot-region pain zone whose damageType the pawn doesn't resist -> reached=0.
  wr('wr-pain-zone', flatWalk(20),
     { zones: { hot: { gravityZ: -950, pain: 1, damageType: 7 } },
       pawn: { collisionRadius: 20, footZone: 'hot', field444: 0 } }),
  // Water region on a pawn that cannot swim (flags318 bit 0x4000 clear): the
  // water gate forces edi=0 without invoking the swim helper -> reached=0.
  wr('wr-water-noswim', flatWalk(20),
     { zones: { pool: { gravityZ: -950, water: 1 } },
       pawn: { collisionRadius: 20, regionZone: 'pool', flags318: 0 } }),
  // Nonzero velocity is saved and restored verbatim through the epilogue.
  wr('wr-vel-restore', flatWalk(20),
     { pawn: { collisionRadius: 20, velocity: [3.5, -2.25, 7.75] } }),

  // -- physics dispatch (0x103c1000) ----------------------------------------
  // PHYS_Walking -> walkReach: reaches a flat point.
  dp('dp-walk-reach', flatWalk(20), { physics: 1, pawn: { collisionRadius: 20 } }),
  // PHYS_Swimming -> walkReach as well.
  dp('dp-swim-reach', flatWalk(20), { physics: 3, pawn: { collisionRadius: 20 } }),
  // PHYS_Falling(2) routes to none of 1/3/4 -> 0 without probing.
  dp('dp-falling', flatWalk(4), { physics: 2, pawn: { collisionRadius: 20 } }),
  // PHYS_None(0) -> 0.
  dp('dp-none', flatWalk(4), { physics: 0, pawn: { collisionRadius: 20 } }),

  // -- pointReachable worker (0x103c0d30) ------------------------------------
  // Dry-to-dry reach: pointRegion->dry, fastLine->1, farMove test+restore, then
  // walkReach reaches the flat point.
  pw('pw-reach', flatWalk(20), { pawn: { collisionRadius: 20 } }),
  // Beyond the 1e6 distSq limit (point 2000 away) -> 0 before any boundary.
  pw('pw-too-far', flatWalk(4), { point: [2000, 0, 0], pawn: { collisionRadius: 20 } }),
  // Editor nonzero skips the distance gate entirely -> still reaches.
  pw('pw-editor', flatWalk(20), { gIsEditor: 1, point: [2000, 0, 0],
                                  pawn: { collisionRadius: 20 } }),
  // Dest zone is water, pawn region dry, no canSwim (flags318 & 0x4000 = 0) -> 0.
  pw('pw-water-gate', flatWalk(4), {
    zones: { wet: { gravityZ: -950, water: true } },
    pointRegion: ['wet'], pawn: { collisionRadius: 20 } }),
  // Same water dest but pawn canSwim -> passes the gate and reaches.
  pw('pw-water-swim', flatWalk(20), {
    zones: { wet: { gravityZ: -950, water: true } },
    pointRegion: ['wet'], pawn: { collisionRadius: 20, flags318: 0x4000 } }),
  // Dest zone is pain with a damage type the pawn does not resist -> 0.
  pw('pw-pain-gate', flatWalk(4), {
    zones: { lava: { gravityZ: -950, pain: true, damageType: 7 } },
    pointRegion: ['lava'], pawn: { collisionRadius: 20 } }),
  // Pain dest but the pawn's ReducedDamageType matches -> gate passed.
  pw('pw-pain-immune', flatWalk(20), {
    zones: { lava: { gravityZ: -950, pain: true, damageType: 7 } },
    pointRegion: ['lava'], pawn: { collisionRadius: 20, field444: 7 } }),
  // Line of sight fails (fastLine->0) -> 0 before any farMove/move.
  pw('pw-no-los', flatWalk(4), { fastLine: [0], pawn: { collisionRadius: 20 } }),
  // arg14!=0 skips FastLineCheck; reach decided purely by the farMove+walk.
  pw('pw-arg14-skip', flatWalk(20), { arg14: 1, fastLine: [0],
                                     pawn: { collisionRadius: 20 } }),
  // farMove test fails -> no restore, dispatch still runs into walkReach.
  // the walk aims at the Location a successful test move left (0x103c0ecb-0x103c0f06), not at the point
  pw('pw-farmove-adjusted', flatWalk(20), { pawn: { collisionRadius: 20 }, farMoveAdjust: { 0: [12, -9, 0] } }),
  pw('pw-farmove-fail', flatWalk(20), { farMove: [0, 0],
                                      pawn: { collisionRadius: 20 } }),
  // Blocked walk: forward probe always blocked -> walkReach returns 0.
  pw('pw-blocked', [H(0.5, 1), H(0.1, 1)], { pawn: { collisionRadius: 20 } }),

  // -- reachMask 0x10326d10 --------------------------------------------------
  // Maps pawn +0x318 bits [13,15,14,12,16,17,1] -> reach-mask bits [0..6].
  rm('rm-zero', { pawn: { flags318: 0 } }),
  rm('rm-all', { pawn: { flags318: 0x1ffff } }),
  rm('rm-bit1', { pawn: { flags318: 0x2 } }),        // -> 64
  rm('rm-bit12', { pawn: { flags318: 0x1000 } }),    // -> 8
  rm('rm-bit13', { pawn: { flags318: 0x2000 } }),    // -> 1
  rm('rm-bit14', { pawn: { flags318: 0x4000 } }),    // -> 4
  rm('rm-bit15', { pawn: { flags318: 0x8000 } }),    // -> 2
  rm('rm-bit16', { pawn: { flags318: 0x10000 } }),   // -> 16
  rm('rm-bit17', { pawn: { flags318: 0x20000 } }),   // -> 32
  rm('rm-mixed', { pawn: { flags318: 0x6000 } }),    // bits13+14 -> 1|4 = 5

  // -- directReach 0x103dad20 ------------------------------------------------
  // Matching ReachSpec (end==target, dims/flags admit) + clear SLC -> 1.
  dr('dr-clear', {
    navPoints: { src: { paths: [0] } }, actors: { tgt: {} },
    reachSpecs: [{ start: 'src', end: 'tgt', radius: 20, height: 40, flags: 0 }],
    pawn: { collisionRadius: 20, collisionHeight: 40 },
  }),
  // ReachSpec radius < pawn CR -> rejected before the line check (slc=0).
  dr('dr-radius', {
    navPoints: { src: { paths: [0] } }, actors: { tgt: {} },
    reachSpecs: [{ start: 'src', end: 'tgt', radius: 19, height: 40, flags: 0 }],
    pawn: { collisionRadius: 20, collisionHeight: 40 },
  }),
  // reachFlags requires a capability the pawn lacks -> rejected (slc=0).
  dr('dr-flags', {
    navPoints: { src: { paths: [0] } }, actors: { tgt: {} },
    reachSpecs: [{ start: 'src', end: 'tgt', radius: 20, height: 40, flags: 8 }],
    pawn: { collisionRadius: 20, collisionHeight: 40 },
  }),
  // The second outbound array (+0x3a0 PrunedPaths) finds the spec too.
  dr('dr-pruned', {
    navPoints: { src: { prunedPaths: [0] } }, actors: { tgt: {} },
    reachSpecs: [{ start: 'src', end: 'tgt', radius: 20, height: 40, flags: 0 }],
    pawn: { collisionRadius: 20, collisionHeight: 40 },
  }),
  // Spec end != target -> no match -> 0.
  dr('dr-wrong-end', {
    navPoints: { src: { paths: [0] } }, actors: { tgt: {}, other: {} },
    reachSpecs: [{ start: 'src', end: 'other', radius: 20, height: 40, flags: 0 }],
    pawn: { collisionRadius: 20, collisionHeight: 40 },
  }),
  // SLC hits a Mover the pawn can't open (flags318&0x10000 == 0) -> skip -> 0.
  dr('dr-mover-blocked', {
    navPoints: { src: { paths: [0] } },
    actors: { tgt: {}, door: { cls: 'mover' } },
    reachSpecs: [{ start: 'src', end: 'tgt', radius: 20, height: 40, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 'door', time: 0.5 } }],
    pawn: { collisionRadius: 20, collisionHeight: 40, flags318: 0 },
  }),
  // Mover openable (flags318&0x10000) and pawn bit1 -> return 1.
  dr('dr-mover-open', {
    navPoints: { src: { paths: [0] } },
    actors: { tgt: {}, door: { cls: 'mover' } },
    reachSpecs: [{ start: 'src', end: 'tgt', radius: 20, height: 40, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 'door', time: 0.5 } }],
    pawn: { collisionRadius: 20, collisionHeight: 40, flags318: 0x10002 },
  }),
  // Mover + flags318&0x10000 but !bit1: openable iff mover +0x4ec&8 == 0 -> 1.
  dr('dr-mover-field4ec', {
    navPoints: { src: { paths: [0] } },
    actors: { tgt: {}, door: { cls: 'mover', field4ec: 0 } },
    reachSpecs: [{ start: 'src', end: 'tgt', radius: 20, height: 40, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 'door', time: 0.5 } }],
    pawn: { collisionRadius: 20, collisionHeight: 40, flags318: 0x10000 },
  }),
  // Same but mover +0x4ec&8 set and pawn !bit1 -> continue -> 0.
  dr('dr-mover-blocked2', {
    navPoints: { src: { paths: [0] } },
    actors: { tgt: {}, door: { cls: 'mover', field4ec: 8 } },
    reachSpecs: [{ start: 'src', end: 'tgt', radius: 20, height: 40, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 'door', time: 0.5 } }],
    pawn: { collisionRadius: 20, collisionHeight: 40, flags318: 0x10000 },
  }),
  // SLC hits a non-mover actor -> treat as clear -> 1.
  dr('dr-nonmover', {
    navPoints: { src: { paths: [0] } },
    actors: { tgt: {}, crate: {} },
    reachSpecs: [{ start: 'src', end: 'tgt', radius: 20, height: 40, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 'crate', time: 0.5 } }],
    pawn: { collisionRadius: 20, collisionHeight: 40 },
  }),

  // -- actorWorker 0x103c0630 ------------------------------------------------
  // Pawn target inside R=min(CR*1.5,melee)+tCR+pCR -> return 1 (no farMove).
  aw('aw-pawn-inside', flatWalk(4), {
    actors: { tgt: { cls: 'pawn', location: [50, 0, 0], collisionRadius: 22, collisionHeight: 40 } },
    pawn: { meleeRange: 40, physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // Pawn target beyond R, within 800 -> farMove fit + walkReach.
  aw('aw-pawn-reach', flatWalk(40), {
    actors: { tgt: { cls: 'pawn', location: [120, 0, 0], collisionRadius: 22, collisionHeight: 40 } },
    pawn: { meleeRange: 40, physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // The same, the test move leaving the pawn off the target (0x103c09b2-0x103c0a0b): the walk aims at that Location.
  aw('aw-pawn-reach-adjusted', flatWalk(40), {
    actors: { tgt: { cls: 'pawn', location: [120, 0, 0], collisionRadius: 22, collisionHeight: 40 } },
    pawn: { meleeRange: 40, physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    farMoveAdjust: { 0: [12, -9, 0] },
  }),
  // Pawn target beyond 800 -> widen R to dist-800 before walking.
  aw('aw-pawn-far', flatWalk(50), {
    actors: { tgt: { cls: 'pawn', location: [900, 0, 0], collisionRadius: 22, collisionHeight: 40 } },
    pawn: { meleeRange: 40, physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // Non-pawn target beyond 800 (non-editor) -> return 0 before any boundary.
  aw('aw-actor-far', [], {
    actors: { tgt: { cls: 'actor', location: [900, 0, 0] } },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // Non-pawn within 800 -> R=15 -> farMove + physicsReach(target=0).
  aw('aw-actor', flatWalk(40), {
    actors: { tgt: { cls: 'actor', location: [100, 0, 0] } },
    pawn: { physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // A non-pawn target, the test move leaving the pawn off it (0x103c0ae3-0x103c0b20).
  aw('aw-actor-adjusted', flatWalk(40), {
    actors: { tgt: { cls: 'actor', location: [100, 0, 0] } },
    pawn: { physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    farMoveAdjust: { 0: [12, -9, 0] },
  }),
  // Inventory target -> R = tCR + pCR - 2.
  aw('aw-inventory', flatWalk(40), {
    actors: { tgt: { cls: 'inventory', location: [100, 0, 0], collisionRadius: 15 } },
    pawn: { physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // Trigger target -> same R = tCR + pCR - 2.
  aw('aw-trigger', flatWalk(40), {
    actors: { tgt: { cls: 'trigger', location: [100, 0, 0], collisionRadius: 15 } },
    pawn: { physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // WarpZoneMarker -> physicsReach receives the actor (not 0) as target; the
  // scripted target hit makes the target arg observable via checkMove's
  // hit.actor === target -> 5 early-reach.
  aw('aw-warp', [H(0.5, 0, 'tgt'), ...flatWalk(40)], {
    actors: { tgt: { cls: 'warpzonemarker', location: [100, 0, 0] } },
    pawn: { physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // flags1dc&4 -> physicsReach target arg = actor (same as warp).
  aw('aw-f1dc', [H(0.5, 0, 'tgt'), ...flatWalk(40)], {
    actors: { tgt: { cls: 'actor', location: [100, 0, 0], flags1dc: 4 } },
    pawn: { physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // LOS blocked by a non-target actor -> return 0.
  aw('aw-los-blocked', [], {
    actors: { tgt: { cls: 'pawn', location: [100, 0, 0], collisionRadius: 22 }, wall: {} },
    pawn: { meleeRange: 40, physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 'wall', time: 0.5 } }],
  }),
  // LOS hits the target itself -> not blocked -> proceeds.
  aw('aw-los-target', flatWalk(40), {
    actors: { tgt: { cls: 'pawn', location: [100, 0, 0], collisionRadius: 22 } },
    pawn: { meleeRange: 40, physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 'tgt', time: 0.5 } }],
  }),
  // argC != 0 -> the LOS SingleLineCheck is skipped entirely.
  aw('aw-no-los', flatWalk(40), {
    argC: 1,
    actors: { tgt: { cls: 'pawn', location: [100, 0, 0], collisionRadius: 22 } },
    pawn: { meleeRange: 40, physics: 1 },
  }),
  // Pawn target in a footZone pain zone, no resist -> return 0.
  aw('aw-foot-pain', [], {
    actors: { tgt: { cls: 'pawn', location: [50, 0, 0], footZone: 'pain' } },
    zones: { pain: { pain: 1, damageType: 3 } },
    pawn: { meleeRange: 40, physics: 1 },
  }),
  // Same pain zone but ReducedDamageType matches -> immune -> proceeds.
  aw('aw-foot-pain-resist', flatWalk(4), {
    actors: { tgt: { cls: 'pawn', location: [50, 0, 0], footZone: 'pain' } },
    zones: { pain: { pain: 1, damageType: 3 } },
    pawn: { meleeRange: 40, physics: 1, field444: 3 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // Non-pawn target in a regionZone pain zone, no resist -> return 0.
  aw('aw-region-pain', [], {
    actors: { tgt: { cls: 'actor', location: [50, 0, 0], regionZone: 'pain' } },
    zones: { pain: { pain: 1, damageType: 3 } },
    pawn: { physics: 1 },
  }),
  // Target in a water regionZone and pawn can't swim (flags318&0x4000==0) -> 0.
  aw('aw-water-noswim', [], {
    actors: { tgt: { cls: 'pawn', location: [50, 0, 0], regionZone: 'water' } },
    zones: { water: { water: 1 } },
    pawn: { meleeRange: 40, physics: 1 },
  }),
  // Same water but pawn can swim -> proceeds.
  aw('aw-water-swim', flatWalk(4), {
    actors: { tgt: { cls: 'pawn', location: [50, 0, 0], regionZone: 'water' } },
    zones: { water: { water: 1 } },
    pawn: { meleeRange: 40, physics: 1, flags318: 0x4000 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // Editor mode skips the non-pawn distance gate entirely.
  aw('aw-editor-far', flatWalk(50), {
    gIsEditor: 1,
    actors: { tgt: { cls: 'actor', location: [900, 0, 0] } },
    pawn: { physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // Null target -> return 0.
  aw('aw-null', [], { target: '__none' }),

  // -- actorReachable exec 0x103bc1a0 (result lands in *result) --------------
  // Null object arg -> result 0.
  ae('ae-null', { target: '__none' }),
  // Non-NavigationPoint target -> straight to actorWorker (slc blocks -> 0).
  ae('ae-nonpawn', {
    actors: { tgt: { cls: 'actor', location: [50, 0, 0] } },
    pawn: { physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 0.5 } }],
  }),
  // NavPoint target found in the nav list within radius -> fast-path 1.
  // (ReachSpecs.Num>0 at level+0x90 is the fast-path gate.)
  ae('ae-nav-hit', {
    navList: 'n0',
    navPoints: { tgt: { location: [30, 0, 0] }, n0: { location: [50, 0, 0], nextNav: 'tgt' } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1 },
    reachSpecs: [{ start: 'n0', end: 'tgt', distance: 20, radius: 20, height: 40, flags: 0 }],
  }),
  // Nearby nav point reaches the target via a ReachSpec -> directReach 1.
  ae('ae-nav-direct', {
    navList: 'n0',
    navPoints: { tgt: { location: [200, 0, 0] },
                 n0: { location: [30, 0, 0], paths: [0], nextNav: 'tgt' } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1 },
    reachSpecs: [{ start: 'n0', end: 'tgt', radius: 20, height: 40, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // Pawn Anchor (+0x34c) is the target -> anchor fast-path 1.
  ae('ae-anchor-hit', {
    navList: 'n0',
    navPoints: { a1: { location: [30, 0, 0] }, n0: { location: [10, 0, 0] } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1, moveTarget: 'a1' },
    target: 'a1',
    reachSpecs: [{ start: 'a1', end: 'a1', distance: 1, radius: 20, height: 40, flags: 0 }],
  }),
  // Anchor within radius reaches the far target via a ReachSpec.
  ae('ae-anchor-direct', {
    navList: 'n0',
    navPoints: { a1: { location: [30, 0, 0], paths: [0] }, tgt: { location: [200, 0, 0] },
                 n0: { location: [10, 0, 0] } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1, moveTarget: 'a1' },
    reachSpecs: [{ start: 'a1', end: 'tgt', radius: 20, height: 40, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // Nearby nav point but no ReachSpec to target -> found, non-flying -> 0
  // (no boundary calls proves the worker was NOT invoked).
  ae('ae-nav-found-unreach', {
    navList: 'n0',
    navPoints: { tgt: { location: [500, 0, 0] }, n0: { location: [30, 0, 0] } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1 },
    reachSpecs: [{ start: 'n0', end: 'n0', distance: 1, radius: 20, height: 40, flags: 0 }],
  }),
  // Same but PHYS_Flying (4) -> falls through to the worker (slc=1 proves it).
  ae('ae-nav-flying-unreach', {
    navList: 'n0',
    navPoints: { tgt: { location: [500, 0, 0] }, n0: { location: [30, 0, 0] } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 4 },
    reachSpecs: [{ start: 'n0', end: 'n0', distance: 1, radius: 20, height: 40, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 0.5 } }],
  }),
  // No nav point within radius -> found=0 -> worker fallback.
  ae('ae-nav-none-near', {
    navList: 'n0',
    navPoints: { tgt: { location: [300, 0, 0] }, n0: { location: [500, 0, 0] } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1 },
    reachSpecs: [{ start: 'n0', end: 'n0', distance: 1, radius: 20, height: 40, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 0.5 } }],
  }),
  // Inventory target with a +0x398 holder -> redirect onto the nav point.
  ae('ae-inv-redirect', {
    navList: 'n0',
    actors: { tgt: { cls: 'inventory', location: [50, 0, 0], field398: 'hold' } },
    navPoints: { hold: { location: [30, 0, 0] }, n0: { location: [10, 0, 0], nextNav: 'hold' } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1 },
    reachSpecs: [{ start: 'n0', end: 'hold', distance: 20, radius: 20, height: 40, flags: 0 }],
    // Blocked slc makes the un-redirected worker path return 0 so the redirect
    // is observable (redirect -> fast-path 1, no redirect -> worker 0).
    singleLine: [{ ret: 1, hit: { actor: 0, time: 0.5 } }],
  }),
  // Inventory target with no holder -> stays Inventory -> worker fallback.
  ae('ae-inv-noholder', {
    actors: { tgt: { cls: 'inventory', location: [50, 0, 0] } },
    pawn: { physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 0.5 } }],
  }),
  // Pawn CR>115 -> the nav fast path is skipped -> worker fallback.
  ae('ae-big-pawn', {
    navList: 'tgt',
    navPoints: { tgt: { location: [30, 0, 0] } },
    pawn: { collisionRadius: 200, collisionHeight: 40, physics: 1 },
    reachSpecs: [{ start: 'tgt', end: 'tgt', distance: 1, radius: 20, height: 40, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 0.5 } }],
  }),
  // Nav point above the pawn's collision height -> |dz|>=CH -> not within ->
  // found=0 -> worker fallback (slc=1 proves the worker ran).
  ae('ae-nav-above', {
    navList: 'n0',
    navPoints: { tgt: { location: [200, 0, 0] }, n0: { location: [30, 0, 100] } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1 },
    reachSpecs: [{ start: 'n0', end: 'n0', distance: 1, radius: 20, height: 40, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 0.5 } }],
  }),
  // Inventory redirect where the holder nav point is NOT within radius -> the
  // worker runs on the restored inventory target (close -> reachable -> 1).
  // Skipping the +0x398 restore makes the worker see the far holder -> 0.
  ae('ae-inv-worker', {
    navList: 'n0',
    actors: { tgt: { cls: 'inventory', location: [50, 0, 0], field398: 'hold' } },
    navPoints: { hold: { location: [500, 0, 0] }, n0: { location: [500, 0, 0] } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1 },
    reachSpecs: [{ start: 'n0', end: 'n0', distance: 1, radius: 20, height: 40, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: [H(1, 1), H(0.1, 1), H(1, 1), H(0.1, 1), H(1, 1), H(0.1, 1)],
  }),

  // -- aiDirection 0x1036d030 (out = {pitch,yaw,0} ints) ----------------------
  // Neutral draws (u=0) leave the centers untouched.
  ad('ad-neutral', { cy: 0x4000, yd: 1, cp: 0, pd: 1, frand: [0.5, 0.5] }),
  // Quarter draws: d'=0.625, m=0.3 -> yawOff=trunc(0.3*-32768)=-9830,
  // pitchOff=trunc(0.3*16383)=4914 -> out {4914, 100-9830, 0}.
  ad('ad-quarter', { cy: 100, yd: 0.25, cp: 0, pd: 0.25, frand: [0.25, 0.75] }),
  // Zero distributions (d'=0.5) with extreme draws hit the outer remap:
  // u=-1 -> m=1 -> -32768; u=+1 -> m=1 -> +16383.
  ad('ad-extremes', { cy: 0, yd: 0, cp: 0, pd: 0, frand: [0.0, 1.0] }),
  // Inner-remap inside the fold point (u=0.5 <= d'=0.75): m=u(1-d)/d; the
  // pitch distribution differs (0.375 -> d'=0.6875) so the draws stay distinct.
  ad('ad-inner', { cy: 0, yd: 0.5, cp: 0, pd: 0.375, frand: [0.75, 0.25] }),
  // Distribution clamps: yd<0 -> 0 (d'=0.5), pd>=1 -> 1 (d'=1 -> offset 0).
  ad('ad-clamps', { cy: 0x100, yd: -0.25, cp: 0x200, pd: 2.5, frand: [0.75, 0.75] }),
  // NaN distribution clamps to 0 through the unordered FCOM path.
  ad('ad-nan-dist', { cy: 0, yd: NaN, cp: 0, pd: NaN, frand: [0.75, 0.25] }),
  // Yaw offset wraps the int32 rotator component past 0xffff.
  ad('ad-wrap', { cy: 0x8000, yd: 0, cp: 0, pd: 0, frand: [0.0, 0.5] }),

  // -- aiPickSearch 0x103c78a0 ----------------------------------------------
  // Flat walk enters the [40,100] band and is pushed out by the scripted
  // down-probe sinking (oracle: candidate ~88.88y with the sine-table x drift).
  as('as-flat-band', flatWalk(8), { yaw: 0x4000 }),
  // First step blocked by a wall -> cont=0 -> ret 0, out = startLoc.
  as('as-blocked', [H(0.5, 0), H(1, 1), H(0.5, 0), H(0.6, 0)],
     { pawn: { collideFlag: 1 } }),
  // Tiny band jumped over in one step: prev -1 -> +1 -> best = overshoot pos.
  as('as-overshoot', flatWalk(4), { minR: 1, maxR: 10 }),
  // PHYS_Flying -> flyMove path (no down-probe; pitch arg is used).
  as('as-fly', [H(1, 1), H(1, 1), H(1, 1), H(1, 1), H(1, 1), H(1, 1)],
     { pawn: { physics: 4 }, pitch: 0x2000 }),
  // PHYS_Falling -> mode 0: early 0 with no farMove and no out write.
  as('as-phys0', [], { pawn: { physics: 2 } }),
  // Ledge with step>maxStep -> retry at maxStep, then exits when ledge repeats.
  as('as-maxstep-retry', [H(1, 1), H(1, 1), H(1, 1), H(1, 1)],
     { pawn: { collisionRadius: 30, collideFlag: 1 } }),
  // Foot-zone pain gate stops the loop after the first step.
  as('as-pain-stop', flatWalk(8),
     { zones: { hot: { gravityZ: -950, pain: 1, damageType: 7 } },
       pawn: { collideFlag: 1, footZone: 'hot', field444: 0 } }),
  // Band unreachable inside 100 iterations -> ret 0, out = startLoc.
  as('as-iter-cap', flatWalk(110), { minR: 3000, maxR: 4000 }),
  // Null out ptr: the native skips the out write; vecbuf stays zeroed.
  as('as-nullout', flatWalk(8), { yaw: 0x4000, outNull: 1 }),
  // CR=4 < stepMin: the stride floor lifts the step to 5 (still under-moved
  // at 5 >= 4.1 scale) — pinned by the ai-step-floor mutation.
  as('as-small-step', flatWalk(30), { minR: 40, maxR: 100,
     pawn: { collisionRadius: 4 } }),
  // CR=30 > stepMax: the stride clamps to 25 — pinned by ai-step-clamp.
  as('as-stride-clamp', flatWalk(12), { minR: 40, maxR: 100,
     pawn: { collisionRadius: 30 } }),

  // -- aiPickWorker 0x103c7fc0 ----------------------------------------------
  // Single try through direction + search.
  ap('ap-flat', flatWalk(8), { cy: 0x4000, yd: 1, cp: 0, pd: 1,
                               frand: [0.5, 0.5], tries: 1, mult: 1 }),
  // tries=0 clamps to 1 -> still runs exactly one attempt.
  ap('ap-tries0', flatWalk(8), { cy: 0x4000, yd: 1, cp: 0, pd: 1,
                                frand: [0.5, 0.5], tries: 0, mult: 1 }),
  // mult=0 clamps to 9.9999997e-05 -> band [4e5,1e6] unreachable -> ret 0.
  ap('ap-mult-floor', flatWalk(8), { cy: 0x4000, yd: 1, cp: 0, pd: 1,
                                    frand: [0.5, 0.5], tries: 1, mult: 0 }),
  // mult=0.5: first search finds in [80,200], then a second search pulls the
  // destination to f32(dist*0.5) along the same direction.
  ap('ap-second-stage', flatWalk(16), { cy: 0x4000, yd: 1, cp: 0, pd: 1,
                                       frand: [0.5, 0.5], tries: 1, mult: 0.5 }),
  // First direction blocked (wall), second reaches -> tries consumed twice.
  ap('ap-retry', [H(0.5, 0), H(1, 1), H(0.5, 0), H(0.6, 0), ...flatWalk(10)],
     { cy: 0x4000, yd: 1, cp: 0, pd: 1, tries: 2, mult: 1,
       frand: [0.5, 0.5, 0.25, 0.75], pawn: { collideFlag: 1 } }),
  // Walking pawns mask the pitch arg (usePitch=0): the pitch draw is consumed
  // but the search receives pitch=0.
  ap('ap-walk-nopitch', flatWalk(8), { cy: 0x4000, yd: 0, cp: 0x1000, pd: 0,
                                      frand: [0.0, 1.0], tries: 1, mult: 1 }),
  // Flying pawn: usePitch=1 -> the random pitch reaches flyMove's dirVec.
  ap('ap-fly-pitch', [H(1, 1), H(1, 1), H(1, 1), H(1, 1), H(1, 1), H(1, 1)],
     { cy: 0x4000, yd: 0, cp: 0x1000, pd: 0, frand: [0.0, 1.0],
       tries: 1, mult: 1, pawn: { physics: 4 } }),

  // -- aiPickExec 0x103c86f0 (native 709, verdict in *result) ------------------
  // Full script path: nine tokens -> worker -> *result=1, vecbuf=candidate.
  ax('ax-flat', flatWalk(8), { cy: 0x4000, yd: 1, cp: 0, pd: 1,
                              frand: [0.5, 0.5], tries: 1, mult: 1 }),
  // Non-reference out arg: GPropAddr stays 0 -> worker writes the temp slot;
  // *result still gets the verdict while vecbuf stays zeroed.
  ax('ax-out-temp', flatWalk(8), { cy: 0x4000, yd: 1, cp: 0, pd: 1,
                                  frand: [0.5, 0.5], tries: 1, mult: 1,
                                  outKind: 'nothing' }),

  // -- FindPathToward 0x103bc9c0 + worker 0x103db3f0 (native 517) ------------
  crowdedPathScene('fpt-full-list-closer', 100),
  crowdedPathScene('fpt-full-list-equal', 10),
  // Null target: *result=0 without touching the worker.
  fx('fpt-null-target', {
    target: null, navList: 'navA',
    navPoints: { navA: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'navA', end: 'navA', distance: 1, radius: 30, height: 50 }],
  }),
  // Missing LevelInfo+0x548 nav list: the worker gates out immediately.
  fp('fpt-no-navlist', {
    navPoints: { navA: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'navA', end: 'navA', distance: 1, radius: 30, height: 50 }],
  }),
  // Empty ReachSpec table (level+0x90): second entry gate fails.
  fp('fpt-no-specs', {
    navList: 'navA', navPoints: { navA: { location: [10, 0, 0] } },
    reachSpecs: [],
  }),
  // Anchored pawn with a direct spec edge to the navpoint target: scoutB
  // validates navA, directReach wins, *result=target.
  fx('fpt-direct', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'tgt' },
      tgt: { location: [40, 0, 0] },
    },
    reachSpecs: [{ start: 'navA', end: 'tgt', distance: 30, radius: 30, height: 50, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // Same edge via the Anchor seed (pawn+0x34c MoveTarget): scoutA seeds
  // items[0] directly, skipping scoutB's eye-LOS + pointWorker validation.
  fx('fpt-anchor-direct', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'tgt', collisionHeight: 40 },
      tgt: { location: [40, 0, 0] },
    },
    pawn: { moveTarget: 'navA' },
    reachSpecs: [{ start: 'navA', end: 'tgt', distance: 30, radius: 30, height: 50, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // No direct edge: scoutC hops items[0] -> pawn fit-tests into navA, then
  // pointWorker(targetLoc, arg14=0) passes -> found = target.
  fx('fpt-hop', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], nextNav: 'tgt' },
      tgt: { location: [20, 0, 0] },
    },
    reachSpecs: [{ start: 'navA', end: 'navA', distance: 1, radius: 30, height: 50 }],
  }),
  // BFS-1 route: scoutD flags navB (navA's outbound neighbor), then the
  // backward walk over tgt's upstreamPaths relaxes navB and pops it as the
  // bEndPoint -> found = navB (first hop toward the target).
  fx('fpt-bfs1', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'navB' },
      navB: { location: [200, 0, 0], nextNav: 'tgt' },
      tgt: { location: [400, 0, 0], upstreamPaths: [1] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 190, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'tgt', distance: 200, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0],   // scoutB sees navA; scoutC navA->tgt LOS fails
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // bSpecialCost node: scoutA's reset calls SpecialCost (scripted 50); the
  // relax cost becomes tgt.vW 0 + 200 + 50 + bPW 190 = 440.
  fx('fpt-bfs1-specialcost', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'navB' },
      navB: { location: [200, 0, 0], flags448: 8, nextNav: 'tgt' },
      tgt: { location: [400, 0, 0], upstreamPaths: [1] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 190, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'tgt', distance: 200, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    specialCost: [50],
  }),
  // Seeded target with no inbound edge: BFS-1 exhausts, seeded -> fail.
  fx('fpt-bfs1-nospec', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'navB' },
      navB: { location: [200, 0, 0], nextNav: 'tgt' },
      tgt: { location: [400, 0, 0] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 190, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // scoutE with two passing candidates (the Island's SecurityBot0 walking to PatrolPoint19, 2026-10-13): the
  // pawn is 100 from navA (the endpoint scoutB marks), navB and navC lie between, each with a route to the
  // target and a clear reach. Candidates are tried in ascending route weight and the FIRST that passes the eye
  // LOS and pointWorker becomes the result (the loop exits at 0x103db302-0x103db304); the translation took the
  // last (navC) where the original returns navB.
  fx('fpt-scoute-first-passing', {
    navList: 'navA',
    navPoints: {
      navA: { location: [100, 0, 0], nextNav: 'navB' },
      navB: { location: [120, 20, 0], nextNav: 'navC' },
      navC: { location: [130, -30, 0], nextNav: 'tgt' },
      tgt: { location: [400, 0, 0], upstreamPaths: [0, 1, 2] },
    },
    reachSpecs: [{ start: 'navA', end: 'tgt', distance: 150, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'tgt', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'navC', end: 'tgt', distance: 70, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 1, 1, 1, 1, 1, 1, 1],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    farMove: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    moveActor: flatWalk(60),
  }),
  // scoutE runs pointWorker whatever the line check says (0x103db2c0-0x103db2f7: the byte is stored, pointWorker(cand, 1) is
  // called, then both are tested): the first candidate's line check fails, the walk is still made (the Underworld's
  // TriadRedArrow1 at tick 18, 2026-10-13: the original ran pointWorker after a failed line check; the translation skipped it).
  fx('fpt-scoute-flc-fails', {
    navList: 'navA',
    navPoints: {
      navA: { location: [100, 0, 0], nextNav: 'navB' },
      navB: { location: [120, 20, 0], nextNav: 'navC' },
      navC: { location: [130, -30, 0], nextNav: 'tgt' },
      tgt: { location: [400, 0, 0], upstreamPaths: [0, 1, 2] },
    },
    reachSpecs: [{ start: 'navA', end: 'tgt', distance: 150, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'tgt', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'navC', end: 'tgt', distance: 70, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0, 1, 1, 1, 1, 1, 1],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    farMove: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    moveActor: flatWalk(60),
  }),
  // A successful test FarMoveActor leaves the pawn where the engine's placement put it, and the walk aims there, not at the
  // point (pointWorker 0x103c0ecb-0x103c0f06: the Location is read into the destination before the restore). The Underworld's Female5
  // at tick 560, 2026-10-13: the original's walk to PathNode149 started at the adjusted x (-682.5), Play's at the raw one.
  fx('fpt-test-move-adjusted', {
    navList: 'navA',
    navPoints: {
      navA: { location: [100, 0, 0], nextNav: 'navB' },
      navB: { location: [120, 20, 0], nextNav: 'navC' },
      navC: { location: [130, -30, 0], nextNav: 'tgt' },
      tgt: { location: [400, 0, 0], upstreamPaths: [0, 1, 2] },
    },
    reachSpecs: [{ start: 'navA', end: 'tgt', distance: 150, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'tgt', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'navC', end: 'tgt', distance: 70, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 1, 1, 1, 1, 1, 1, 1],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    farMove: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    farMoveAdjust: { 0: [12, -9, 0] },
    moveActor: flatWalk(60),
  }),
  // The second hop (0x103dbb1c-0x103dbb56) is the same: pointWorker(hop2, 1) runs after a failed line check, and the pawn is
  // restored (FarMoveActor(origLoc, 1, 1)) on every path.
  fx('fpt-pass2-hop2-flc0', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], upstreamPaths: [2], nextNav: 'navX' },
      navX: { location: [50, 0, 0], upstreamPaths: [0, 1], nextNav: 'navB' },
      navB: { location: [290, 0, 0], paths: [1] },
    },
    actors: { tgt: { cls: 'actor', location: [290, 0, 200] } },
    reachSpecs: [{ start: 'navA', end: 'navX', distance: 40, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'navX', distance: 240, radius: 30, height: 50, flags: 0 },
                 { start: 'navX', end: 'navA', distance: 40, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0, 0, 0, 0, 1, 0],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    farMove: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    moveActor: flatWalk(60),
  }),
  // Exec tail on the fpt-bfs1 graph: bShootSpecial clears, SpecialPause
  // zeroes, and a result equal to SpecialGoal clears SpecialGoal.
  fx('fpt-exec-tail', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'navB' },
      navB: { location: [200, 0, 0], nextNav: 'tgt' },
      tgt: { location: [400, 0, 0], upstreamPaths: [1] },
    },
    pawn: { flags318: 0x2000000, specialPause: 5.0, specialGoal: 'navB' },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 190, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'tgt', distance: 200, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    probing: [0],
  }),
  // Six-hop chain navA->n0->n1->n2->n3->n4->tgt: the bEndPoint marker lands
  // on n0 (navA's outbound neighbor); BFS-1 relaxes n4..n0 back from tgt and
  // pops n0 -> found = first hop n0.
  fx('fpt-bfs-deep', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'n0' },
      n0: { location: [70, 0, 0], upstreamPaths: [0], nextNav: 'n1' },
      n1: { location: [130, 0, 0], upstreamPaths: [1], nextNav: 'n2' },
      n2: { location: [190, 0, 0], upstreamPaths: [2], nextNav: 'n3' },
      n3: { location: [250, 0, 0], upstreamPaths: [3], nextNav: 'n4' },
      n4: { location: [310, 0, 0], upstreamPaths: [4], nextNav: 'tgt' },
      tgt: { location: [370, 0, 0], upstreamPaths: [5] },
    },
    reachSpecs: [{ start: 'navA', end: 'n0', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n1', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'n1', end: 'n2', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'n2', end: 'n3', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'n3', end: 'n4', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'n4', end: 'tgt', distance: 60, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // Same chain with bSinglePath=1: the 5th pop aborts before n0 wins.
  fx('fpt-singlepath-abort', {
    bSingle: 1, navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'n0' },
      n0: { location: [70, 0, 0], upstreamPaths: [0], nextNav: 'n1' },
      n1: { location: [130, 0, 0], upstreamPaths: [1], nextNav: 'n2' },
      n2: { location: [190, 0, 0], upstreamPaths: [2], nextNav: 'n3' },
      n3: { location: [250, 0, 0], upstreamPaths: [3], nextNav: 'n4' },
      n4: { location: [310, 0, 0], upstreamPaths: [4], nextNav: 'tgt' },
      tgt: { location: [370, 0, 0], upstreamPaths: [5] },
    },
    reachSpecs: [{ start: 'navA', end: 'n0', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n1', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'n1', end: 'n2', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'n2', end: 'n3', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'n3', end: 'n4', distance: 60, radius: 30, height: 50, flags: 0 },
                 { start: 'n4', end: 'tgt', distance: 60, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // Pass 2 on a non-navpoint target: navB's actorWorker to tgt fails (the
  // target floats 200 above the node, past the climb gate), so the worker
  // re-collects, flags navB's outbound neighbor navX, validates navB, then
  // BFS-2 runs from navA over navA's inbound navX->navA spec.  The reversed
  // chain makes navA the tail; the hop-2 FLC + pointWorker check returns
  // navX.
  // No anchor reachable: every anchor-scan FastLineCheck fails, so flag14
  // stays 0 and the worker takes pass 2 — scoutD marks the target-side
  // head's (navB) outbound neighbour navX as bEndPoint, scoutB validates
  // navB from the pawn, and BFS-2 runs navA.upstreamPaths -> navX.
  fx('fpt-pass2', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], upstreamPaths: [2], nextNav: 'navX' },
      navX: { location: [50, 0, 0], upstreamPaths: [0, 1], nextNav: 'navB' },
      navB: { location: [290, 0, 0], paths: [1] },
    },
    actors: { tgt: { cls: 'actor', location: [290, 0, 200] } },
    reachSpecs: [{ start: 'navA', end: 'navX', distance: 40, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'navX', distance: 240, radius: 30, height: 50, flags: 0 },
                 { start: 'navX', end: 'navA', distance: 40, radius: 30, height: 50, flags: 0 }],
    // scoutB-FLC navA, scoutC-FLC navA->tgt, 3 scan FLCs (navB,navX,navA),
    // pass2 scoutB-FLC navB, hop2 FLC.
    fastLine: [1, 0, 0, 0, 0, 1, 1],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    farMove: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    moveActor: flatWalk(60),
  }),
  // bClearPaths=0 skips scoutA's reset: the fabricated visitedWeight/cost
  // survive into the BFS instead of being overwritten (10M / ExtraCost).
  fx('fpt-noclear', {
    bClear: 0, navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'tgt',
              visitedWeight: 77, cost: 33 },
      tgt: { location: [40, 0, 0] },
    },
    reachSpecs: [{ start: 'navA', end: 'tgt', distance: 30, radius: 30, height: 50, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),
  // argCount=2 leaves bClearPaths at its native default 1 -> the reset runs.
  fx('fpt-default-clear', {
    argCount: 2, bSingle: 0, navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'tgt',
              visitedWeight: 77, cost: 33 },
      tgt: { location: [40, 0, 0] },
    },
    reachSpecs: [{ start: 'navA', end: 'tgt', distance: 30, radius: 30, height: 50, flags: 0 }],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
  }),

  // -- findPathTo worker 0x103dc1d0 (FindPathTo 518 / falling-target path) ---
  // Entry gates: no LevelInfo nav list, empty ReachSpec table.
  fpto('fto-no-navlist', {
    navPoints: { navA: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'navA', end: 'navA', distance: 1, radius: 30, height: 50 }],
  }),
  fpto('fto-no-specs', {
    navList: 'navA', navPoints: { navA: { location: [10, 0, 0] } }, reachSpecs: [],
  }),
  // No node within 800 of the pawn: the pawn-side list is empty -> 0, no restore.
  fpto('fto-no-pawn-side', {
    point: [2400, 0, 0], navList: 'navA', navPoints: { navA: { location: [2000, 0, 0] } },
    reachSpecs: [{ start: 'navA', end: 'navA', distance: 1, radius: 30, height: 50 }],
  }),
  // No node within 800 of the point: the point-side list is empty -> 0.
  fpto('fto-no-point-side', {
    point: [5000, 0, 0], navList: 'navA', navPoints: { navA: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'navA', end: 'navA', distance: 1, radius: 30, height: 50 }],
  }),
  // scoutB rejects every pawn-side node (eye FastLineCheck fails) -> restore, 0.
  fpto('fto-scoutb-fail', {
    point: [70, 0, 0], navList: 'navA', navPoints: { navA: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'navA', end: 'navA', distance: 1, radius: 30, height: 50 }],
    fastLine: [0],
  }),
  // The pawn stands at navA (scoutB sets the anchor); scoutC's hop from navA
  // reaches the point -> found = the pawn-side head navA, not the point-side
  // head navB.
  fpto('fto-hop', {
    point: [70, 0, 0], navList: 'navA', moveActor: flatWalk(40),
    navPoints: { navA: { location: [10, 0, 0], nextNav: 'navB' }, navB: { location: [60, 0, 0] } },
    reachSpecs: [{ start: 'navA', end: 'navA', distance: 1, radius: 30, height: 50 }],
  }),
  // The MoveTarget anchor seeds the pawn-side head: no scoutB.
  fpto('fto-anchor-hop', {
    point: [70, 0, 0], navList: 'navA', moveActor: flatWalk(40), pawn: { moveTarget: 'navA' },
    navPoints: { navA: { location: [10, 0, 0], nextNav: 'navB', collisionHeight: 40 },
                 navB: { location: [60, 0, 0] } },
    reachSpecs: [{ start: 'navA', end: 'navA', distance: 1, radius: 30, height: 50 }],
  }),
  // Anchored, no hop (scoutC's FastLineCheck fails): scoutD marks navB, the
  // point scan reaches navC, BFS from navC relaxes navB -> found = navB.
  fpto('fto-bfs', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'navB' },
      navB: { location: [200, 0, 0], paths: [1], upstreamPaths: [0], nextNav: 'navC' },
      navC: { location: [400, 0, 0], upstreamPaths: [1] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 190, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'navC', distance: 200, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0, 1],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: flatWalk(60),
  }),
  // The scan's first candidate fails pointReachable's move (far step
  // blocked) and the second (navB) passes: keys[0] = ftol(sqrt) of navB's.
  fpto('fto-scan-second', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'navB' },
      navB: { location: [200, 0, 0], paths: [1], upstreamPaths: [0], nextNav: 'navC' },
      navC: { location: [400, 0, 0], upstreamPaths: [1] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 190, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'navC', distance: 200, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0, 1, 1],
    farMove: [1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: flatWalk(60),
  }),
  // Every scan FastLineCheck fails: no point anchor -> restore, 0.  The pawn
  // is bHunting: unlike the toward worker, nothing seeds the head for it.
  fpto('fto-scan-exhaust', {
    navList: 'navA', pawn: { flags318: 0x200000 },
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'navB' },
      navB: { location: [200, 0, 0], paths: [1], upstreamPaths: [0], nextNav: 'navC' },
      navC: { location: [400, 0, 0], upstreamPaths: [1] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 190, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'navC', distance: 200, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0, 0],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: flatWalk(60),
  }),
  // The point anchor navC has no inbound spec: BFS fails -> restore, 0.
  fpto('fto-bfs-fail', {
    navList: 'navA',
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'navB' },
      navB: { location: [200, 0, 0], upstreamPaths: [0], nextNav: 'navC' },
      navC: { location: [400, 0, 0] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 190, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0, 1],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: flatWalk(60),
  }),
  // The pawn is 200 from navA: scoutB marks it an endpoint without the
  // anchor, the scan reaches navB, BFS finds navA, and scoutE refines over
  // the pawn-side candidates.
  fpto('fto-scoute', {
    navList: 'navA',
    navPoints: {
      navA: { location: [200, 0, 0], paths: [0], nextNav: 'navB' },
      navB: { location: [400, 0, 0], upstreamPaths: [0] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 200, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 1, 1],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: flatWalk(80),
  }),
  // The same with bSinglePath=1: no scoutE.
  fpto('fto-singlepath', {
    bSingle: 1, navList: 'navA',
    navPoints: {
      navA: { location: [200, 0, 0], paths: [0], nextNav: 'navB' },
      navB: { location: [400, 0, 0], upstreamPaths: [0] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 200, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 1, 1],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: flatWalk(80),
  }),
  // Actors(0) is a LevelInfo subclass (DeusExLevelInfo in the game's maps):
  // the inlined IsA walks one Super link before matching.
  (() => {
    const s = fpto('fto-levelinfo-subclass', {
      point: [70, 0, 0], navList: 'navA', moveActor: flatWalk(40),
      actors: { dxli: { cls: 'levelinfo*' } },
      navPoints: { navA: { location: [10, 0, 0], nextNav: 'navB' }, navB: { location: [60, 0, 0] } },
      reachSpecs: [{ start: 'navA', end: 'navA', distance: 1, radius: 30, height: 50 }],
    });
    s.levelInfo = 'dxli';
    return s;
  })(),
  // bClearPaths=0: scoutA leaves the fabricated search state.
  fpto('fto-noclear', {
    bClear: 0, point: [70, 0, 0], navList: 'navA', moveActor: flatWalk(40),
    navPoints: { navA: { location: [10, 0, 0], nextNav: 'navB', visitedWeight: 77, cost: 33 },
                 navB: { location: [60, 0, 0], visitedWeight: 55, cost: 11 } },
    reachSpecs: [{ start: 'navA', end: 'navA', distance: 1, radius: 30, height: 50 }],
  }),
  // -- FindPathTo exec 0x103bc800 (native 518) ------------------------------
  // fto-bfs's graph through the exec: result navB; bShootSpecial and
  // SpecialPause clear; navB is the SpecialGoal, so SpecialGoal clears.
  fxt('ftx-bfs-tail', {
    navList: 'navA', pawn: { flags318: 0x2000000, specialPause: 5.0, specialGoal: 'navB' },
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'navB' },
      navB: { location: [200, 0, 0], paths: [1], upstreamPaths: [0], nextNav: 'navC' },
      navC: { location: [400, 0, 0], upstreamPaths: [1] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 190, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'navC', distance: 200, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0, 1], probing: [0],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: flatWalk(60),
  }),
  // A failed search: the result slot stays None; the tail still clears.
  fxt('ftx-fail', {
    navList: 'navA', pawn: { flags318: 0x2000000, specialPause: 2.0 },
    navPoints: {
      navA: { location: [10, 0, 0], paths: [0], nextNav: 'navB' },
      navB: { location: [200, 0, 0], paths: [1], upstreamPaths: [0], nextNav: 'navC' },
      navC: { location: [400, 0, 0], upstreamPaths: [1] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 190, radius: 30, height: 50, flags: 0 },
                 { start: 'navB', end: 'navC', distance: 200, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 0, 0],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: flatWalk(60),
  }),
  // Only the point: bSinglePath=0 and bClearPaths=1 are the pre-stored
  // defaults (scoutE runs; the reset overwrites the fabricated state).
  fxt('ftx-point-only', {
    argCount: 1, navList: 'navA',
    navPoints: {
      navA: { location: [200, 0, 0], paths: [0], nextNav: 'navB', visitedWeight: 77, cost: 33 },
      navB: { location: [400, 0, 0], upstreamPaths: [0] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 200, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 1, 1], probing: [0],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: flatWalk(80),
  }),
  // bSinglePath given, bClearPaths omitted (still 1).
  fxt('ftx-single-default-clear', {
    argCount: 2, bSingle: 1, navList: 'navA',
    navPoints: {
      navA: { location: [200, 0, 0], paths: [0], nextNav: 'navB', visitedWeight: 77, cost: 33 },
      navB: { location: [400, 0, 0], upstreamPaths: [0] },
    },
    reachSpecs: [{ start: 'navA', end: 'navB', distance: 200, radius: 30, height: 50, flags: 0 }],
    fastLine: [1, 1, 1], probing: [0],
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: flatWalk(80),
  }),
  // bClearPaths=0 given: the fabricated search state survives into the BFS.
  fxt('ftx-noclear', {
    bClear: 0, point: [70, 0, 0], navList: 'navA', moveActor: flatWalk(40), probing: [0],
    navPoints: { navA: { location: [10, 0, 0], nextNav: 'navB', visitedWeight: 77, cost: 33 },
                 navB: { location: [60, 0, 0], visitedWeight: 55, cost: 11 } },
    reachSpecs: [{ start: 'navA', end: 'navA', distance: 1, radius: 30, height: 50 }],
  }),
  // pathTowardWorker with a PHYS_Falling Pawn target: target->jumpLanding
  // (one 0.1 s tick onto a floor, then the restoring FarMoveActor of the
  // target) and the findPathTo worker toward the landing on the fto-bfs graph.
  (() => {
    const s = fp('fpt-falling-target', {
      navList: 'navA',
      zones: { dry: { gravityZ: -950, gravity: [0, 0, -950], zoneVelocity: [0, 0, 0], fluidFriction: 1.2 } },
      actors: { tgt: { cls: 'pawn', physics: 2, location: [400, 0, 100], velocity: [30, 0, -200],
        collisionRadius: 20, collisionHeight: 40, collideFlag: 1, regionZone: 'dry', footZone: 'dry' } },
      navPoints: {
        navA: { location: [10, 0, 0], paths: [0], nextNav: 'navB' },
        navB: { location: [200, 0, 0], paths: [1], upstreamPaths: [0], nextNav: 'navC' },
        navC: { location: [400, 0, 0], upstreamPaths: [1] },
      },
      reachSpecs: [{ start: 'navA', end: 'navB', distance: 190, radius: 30, height: 50, flags: 0 },
                   { start: 'navB', end: 'navC', distance: 200, radius: 30, height: 50, flags: 0 }],
      fastLine: [1, 0, 1],
      singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
      moveActor: [H(0.5, 1), ...flatWalk(60)],
    });
    s.coverage = [PATH_TO_COVERAGE, DELEGATION_COVERAGE];
    return s;
  })(),

  // -- GetPathnodeList 0x103c6490 (ReachablePathnodes 1004's worker) -------
  // Start node = the first list node the pawn overlaps; its Paths specs, no
  // reachability test, sorted (n2/n3 tie at 195).
  gp('gpl-start-sort3', {
    navList: 'n0', navPoints: { n0: { location: [5, 0, 0], paths: [0, 1, 2] },
      n1: { location: [300, 0, 0] }, n2: { location: [0, 200, 0] }, n3: { location: [0, -200, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 295, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n2', distance: 195, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n3', distance: 195, radius: 30, height: 50, flags: 0 }],
  }),
  gp('gpl-sort-off', {
    sort: 0, navList: 'n0', navPoints: { n0: { location: [5, 0, 0], paths: [0, 1, 2] },
      n1: { location: [300, 0, 0] }, n2: { location: [0, 200, 0] }, n3: { location: [0, -200, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 295, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n2', distance: 195, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n3', distance: 1, radius: 30, height: 50, flags: 0 }],
  }),
  // Every spec gate: End None, End not a NavigationPoint, a NavigationPoint
  // subclass End, radius 21 < 22, height 39 < 40, a flag outside the mask;
  // PrunedPaths ignored without bUsePrunedPaths.
  gp('gpl-start-filters', {
    navList: 'n0',
    navPoints: { n0: { location: [5, 0, 0], paths: [0, 1, 2, 3, 4, 5, 6, 7], prunedPaths: [8] },
      n1: { location: [10, 0, 0] }, n2: { location: [20, 0, 0], cls: 'navpoint*' },
      n3: { location: [30, 0, 0] }, n4: { location: [40, 0, 0] } },
    actors: { a1: { location: [50, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 0, distance: 1, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'a1', distance: 2, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n2', distance: 50, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n4', distance: 3, radius: 21, height: 50, flags: 0 },
                 { start: 'n0', end: 'n4', distance: 4, radius: 30, height: 39, flags: 0 },
                 { start: 'n0', end: 'n4', distance: 5, radius: 30, height: 50, flags: 1 },
                 { start: 'n0', end: 'n1', distance: 10, radius: 22, height: 40, flags: 0 },
                 { start: 'n0', end: 'n3', distance: 50, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n4', distance: 6, radius: 30, height: 50, flags: 0 }],
  }),
  // The same gates over PrunedPaths, continuing the Paths count; the pawn's
  // bCanWalk|bCanOpenDoors mask admits flags 1|0x10 but not 2.
  gp('gpl-start-pruned', {
    pruned: 1, navList: 'n0', pawn: { flags318: 0x12000 },
    navPoints: { n0: { location: [5, 0, 0], paths: [6], prunedPaths: [0, 1, 2, 3, 4, 5, 7, 8, 9] },
      n1: { location: [10, 0, 0] }, n2: { location: [20, 0, 0], cls: 'navpoint*' },
      n3: { location: [30, 0, 0] }, n4: { location: [40, 0, 0] } },
    actors: { a1: { location: [50, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 0, distance: 1, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'a1', distance: 2, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n2', distance: 50, radius: 30, height: 50, flags: 0x11 },
                 { start: 'n0', end: 'n4', distance: 3, radius: 21, height: 50, flags: 0 },
                 { start: 'n0', end: 'n4', distance: 4, radius: 30, height: 39, flags: 0 },
                 { start: 'n0', end: 'n4', distance: 5, radius: 30, height: 50, flags: 2 },
                 { start: 'n0', end: 'n1', distance: 60, radius: 22, height: 40, flags: 1 },
                 { start: 'n0', end: 'n3', distance: 50, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n4', distance: -6, radius: 30, height: 50, flags: 0x10 },
                 { start: 'n0', end: 'n1', distance: 7, radius: 30, height: 50, flags: 0 }],
  }),
  // max 3: the Paths scan stops at the cap and the PrunedPaths scan exits
  // on its first entry; then the cap reached inside the PrunedPaths scan.
  gp('gpl-start-cap', {
    max: 3, pruned: 1, navList: 'n0',
    navPoints: { n0: { location: [5, 0, 0], paths: [0, 1, 2, 3, 4], prunedPaths: [5] },
      n1: { location: [10, 0, 0] }, n2: { location: [20, 0, 0] }, n3: { location: [30, 0, 0] } },
    reachSpecs: [0, 1, 2, 3, 4, 5].map(i => ({ start: 'n0', end: `n${1 + (i % 3)}`, distance: 90 - i,
      radius: 30, height: 50, flags: 0 })),
  }),
  gp('gpl-pruned-cap', {
    max: 3, pruned: 1, navList: 'n0',
    navPoints: { n0: { location: [5, 0, 0], paths: [0], prunedPaths: [1, 2, 3, 4] },
      n1: { location: [10, 0, 0] }, n2: { location: [20, 0, 0] }, n3: { location: [30, 0, 0] } },
    reachSpecs: [0, 1, 2, 3, 4].map(i => ({ start: 'n0', end: `n${1 + (i % 3)}`, distance: 10 + 7 * i,
      radius: 30, height: 50, flags: 0 })),
  }),
  // One entry (no sort call) and none (both arrays empty).
  gp('gpl-one', {
    navList: 'n0', navPoints: { n0: { location: [5, 0, 0], paths: [0] }, n1: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 12, radius: 30, height: 50, flags: 0 }],
  }),
  gp('gpl-start-empty', {
    pruned: 1, navList: 'n0', navPoints: { n0: { location: [5, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n0', distance: 12, radius: 30, height: 50, flags: 0 }],
  }),
  // A NavigationPoint FromPoint is the start node itself (no overlap test,
  // ahead of the overlapping n0); a NavigationPoint subclass takes the walk.
  gp('gpl-from-nav', {
    from: 'nF', navList: 'n0',
    navPoints: { n0: { location: [5, 0, 0], paths: [0], nextNav: 'nF' },
      nF: { location: [3000, 0, 0], paths: [1, 2] }, n1: { location: [10, 0, 0] }, n2: { location: [20, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 5, radius: 30, height: 50, flags: 0 },
                 { start: 'nF', end: 'n2', distance: 40, radius: 30, height: 50, flags: 0 },
                 { start: 'nF', end: 'n1', distance: 30, radius: 30, height: 50, flags: 0 }],
  }),
  gp('gpl-from-subclass', {
    from: 'nF', navList: 'n0',
    navPoints: { n0: { location: [5, 0, 0], paths: [0], nextNav: 'nF' },
      nF: { location: [3000, 0, 0], paths: [1], cls: 'navpoint*' }, n1: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 5, radius: 30, height: 50, flags: 0 },
                 { start: 'nF', end: 'n1', distance: 30, radius: 30, height: 50, flags: 0 }],
  }),
  // A non-NavigationPoint FromPoint moves only the distance origin: overlap
  // stays the pawn's (d0 sits on a1), and actorReachable runs from the pawn
  // (every node > 800 away -> all rejected, the stale list stays visible).
  gp('gpl-from-actor', {
    from: 'a1', actors: { a1: { location: [3000, 0, 0], collisionRadius: 30, collisionHeight: 30 } },
    navList: 'd0', navPoints: chain([[3005, 0, 0], [2100, 0, 0], [3500.5, 0.25, 10], [3000, 999, 0],
      [4001, 0, 0], [3000, 0, -700.75]]),
  }),
  // ...and the MoveTarget overlap test still runs after it.
  gp('gpl-from-actor-anchor', {
    from: 'a1', actors: { a1: { location: [3000, 0, 0] } }, pawn: { moveTarget: 'nM' },
    navList: 'd0', navPoints: { ...chain([[3005, 0, 0]]), nM: { location: [0, 10, 30], paths: [0] },
      n1: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'nM', end: 'n1', distance: 9, radius: 30, height: 50, flags: 0 }],
  }),
  // MoveTarget: an overlapping one wins over the list; one out of reach, a
  // non-NavigationPoint one and a NavigationPoint subclass.
  gp('gpl-mt-hit', {
    pawn: { moveTarget: 'nM' }, navList: 'n0',
    navPoints: { n0: { location: [5, 0, 0], paths: [0] }, nM: { location: [-5, 3, -20], paths: [1] },
      n1: { location: [10, 0, 0] }, n2: { location: [20, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 5, radius: 30, height: 50, flags: 0 },
                 { start: 'nM', end: 'n2', distance: 9, radius: 30, height: 50, flags: 0 }],
  }),
  gp('gpl-mt-far', {
    pawn: { moveTarget: 'nM' }, navList: 'n0',
    navPoints: { n0: { location: [5, 0, 0], paths: [0] }, nM: { location: [-16, 16, 0], paths: [1] },
      n1: { location: [10, 0, 0] }, n2: { location: [20, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 5, radius: 30, height: 50, flags: 0 },
                 { start: 'nM', end: 'n2', distance: 9, radius: 30, height: 50, flags: 0 }],
  }),
  gp('gpl-mt-actor', {
    pawn: { moveTarget: 'a1' }, navList: 'n0', actors: { a1: { location: [1, 0, 0] } },
    navPoints: { n0: { location: [5, 0, 0], paths: [0] }, n1: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 5, radius: 30, height: 50, flags: 0 }],
  }),
  gp('gpl-mt-subclass', {
    pawn: { moveTarget: 'nM' }, navList: 'n0',
    navPoints: { n0: { location: [5, 0, 0], paths: [0] }, nM: { location: [0, 0, 39], paths: [1], cls: 'navpoint*' },
      n1: { location: [10, 0, 0] }, n2: { location: [20, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 5, radius: 30, height: 50, flags: 0 },
                 { start: 'nM', end: 'n2', distance: 9, radius: 30, height: 50, flags: 0 }],
  }),
  // IsOverlapping's strict bounds: r² = dx² (n0) and h² = dz² (n1) do not
  // overlap; n2's own CollisionRadius/Height widen r and h.
  gp('gpl-overlap-edges', {
    navList: 'n0',
    navPoints: { n0: { location: [22, 0, 0], paths: [0], nextNav: 'n1' },
      n1: { location: [0, 0, 40], paths: [0], nextNav: 'n2' },
      n2: { location: [30, 0, 45], collisionRadius: 10, collisionHeight: 10, paths: [1] },
      n3: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n3', distance: 5, radius: 30, height: 50, flags: 0 },
                 { start: 'n2', end: 'n3', distance: 8, radius: 30, height: 50, flags: 0 }],
  }),
  gp('gpl-overlap-second', {
    navList: 'n0',
    navPoints: { n0: { location: [500, 0, 0], paths: [0], nextNav: 'n1' },
      n1: { location: [-3, -4, 12], paths: [1] }, n2: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n2', distance: 5, radius: 30, height: 50, flags: 0 },
                 { start: 'n1', end: 'n2', distance: 8, radius: 30, height: 50, flags: 0 }],
  }),
  // IsBrush needs both Brush (+0x178) and ABrush ancestry: b0 is skipped,
  // b1 (Brush None) overlaps.
  gp('gpl-overlap-brush', {
    navList: 'b0',
    navPoints: { b0: { location: [5, 0, 0], cls: 'brush', brush: 1, paths: [0], nextNav: 'b1' },
      b1: { location: [6, 0, 0], cls: 'brush', paths: [1] }, n2: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'b0', end: 'n2', distance: 5, radius: 30, height: 50, flags: 0 },
                 { start: 'b1', end: 'n2', distance: 8, radius: 30, height: 50, flags: 0 }],
  }),
  // The pawn's own Level (Actors(0), here also the list head) never overlaps.
  gp('gpl-overlap-level', {
    levelInfo: 'nL', navList: 'nL',
    navPoints: { nL: { location: [5, 0, 0], cls: 'levelinfo', paths: [0], nextNav: 'n1' },
      n1: { location: [6, 0, 0], paths: [1] }, n2: { location: [10, 0, 0] } },
    reachSpecs: [{ start: 'nL', end: 'n2', distance: 5, radius: 30, height: 50, flags: 0 },
                 { start: 'n1', end: 'n2', distance: 8, radius: 30, height: 50, flags: 0 }],
  }),
  // Distance path: d0/d4 reachable, d1 beyond actorReachable's 800, d2
  // beyond 1000 (never listed), d3's line of sight blocked.
  gp('gpl-dist-filter', {
    navList: 'd0', navPoints: chain([[100, 0, 0], [900, 0, 0], [1200, 0, 0], [300, 0, 0], [60, 60, 0]]),
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }, { ret: 1, hit: { actor: 0, time: 0.5 } },
                 { ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: flatWalk(200),
  }),
  // A full list (max 3): 810 replaces, among the farther entries, the
  // nearest (820), not the farthest; 990 and 900 have no farther entry;
  // 830 replaces 850.  All beyond 800: actorReachable rejects them.
  gp('gpl-dist-replace', {
    max: 3, navList: 'd0',
    navPoints: chain([[850, 0, 0], [820, 0, 0], [900, 0, 0], [810, 0, 0], [990, 0, 0], [830, 0, 0], [900, 0, 0]]),
  }),
  gp('gpl-dist-replace-ties', {
    max: 3, navList: 'd0',
    navPoints: chain([[850, 0, 0], [0, 850, 0], [900, 0, 0], [820, 0, 0], [0, 0, 850], [0, 0, -820]]),
  }),
  // 34 fractional points between 800 and 1000: the 32 cap, the replacement
  // rule and the 80-bit appSqrt/fstp rounding of every distance.
  gp('gpl-dist-cap32', { navList: 'd0', navPoints: chain(ring(34, 7, [0, 0, 0], 800.5, 999.5)) }),
  gp('gpl-dist-from-ring', {
    from: 'a1', actors: { a1: { location: [-3000.25, 1500.5, 64.125] } },
    navList: 'd0', navPoints: chain(ring(40, 11, [-3000.25, 1500.5, 64.125], 1, 1100)),
  }),
  gp('gpl-dist-from-ring2', {
    from: 'a1', actors: { a1: { location: [2048.75, -777.5, -12.5] } }, max: 20,
    navList: 'd0', navPoints: chain(ring(30, 23, [2048.75, -777.5, -12.5], 900, 1000.5)),
  }),
  gp('gpl-empty-list', { navPoints: { n1: { location: [10, 0, 0] } } }),
  // appSqrt keeps the 80-bit root.  (6007001, 17505000, 18507001)·2^-15 is
  // a Pythagorean triple whose hypotenuse c is an f32 midpoint (odd at
  // 2^-15 in [512,1024)); dz = 2^-17 makes distSq the double c² + 2^-34, so
  // the root lies within half a double ulp above c.  fstp dword of the
  // 80-bit root rounds up; a double-rounded root would tie to the even
  // neighbour below.  The pawn is far away: actorReachable rejects.
  gp('gpl-dist-sqrt-tie', {
    from: 'a1', actors: { a1: { location: [0, 0, 0] } }, pawn: { location: [5000, 5000, 0] },
    navList: 'd0', navPoints: chain([[6007001 / 32768, 17505000 / 32768, 2 ** -17], [700, 700, 0]]),
  }),
  // Actors(0) is a LevelInfo subclass (DeusExLevelInfo in the game's maps):
  // both inlined check(IsA(ALevelInfo)) walks take one Super link.
  gp('gpl-levelinfo-subclass', {
    levelInfo: 'dxli', actors: { dxli: { cls: 'levelinfo*' } },
    navList: 'd0', navPoints: chain([[850, 0, 0], [0, 900.5, 0]]),
  }),
  // The qsort: shortsort (<= 8) and partitioned (> 8) sizes, ties, sorted,
  // reversed and constant inputs, unsorted when bSort is 0.
  ...[2, 3, 4, 5, 7, 8, 9, 10, 11, 13, 15, 16, 17, 20, 23, 24, 27, 31, 32, 32].map((n, k) => {
    const r = lcg(101 + k);
    return sortScene(`gpl-sort-${n}-${k}`, Array.from({ length: n }, () => (r() % (k % 3 === 0 ? 4 : 40)) * 25));
  }),
  sortScene('gpl-sort-ascending', Array.from({ length: 32 }, (_, i) => 10 * i)),
  sortScene('gpl-sort-descending', Array.from({ length: 32 }, (_, i) => 1000 - 10 * i)),
  sortScene('gpl-sort-constant', Array.from({ length: 32 }, () => 77)),
  sortScene('gpl-sort-two-values', Array.from({ length: 29 }, (_, i) => (i * 7) % 3 ? 5 : 9)),
  sortScene('gpl-sort-unsorted', Array.from({ length: 20 }, (_, i) => (i * 13) % 7), { sort: 0 }),

  // -- execReachablePathnodes 0x103c8bb0 (native 1004) ---------------------
  rpn('rpn-start', {
    navList: 'n0', navPoints: { n0: { location: [5, 0, 0], paths: [0, 1, 2] },
      n1: { location: [300, 0, 0] }, n2: { location: [0, 200, 0] }, n3: { location: [0, -200, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 295, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n2', distance: 195, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n3', distance: 195, radius: 30, height: 50, flags: 0 }],
  }),
  rpn('rpn-break-1', {
    breakAt: 1, navList: 'n0', navPoints: { n0: { location: [5, 0, 0], paths: [0, 1] },
      n1: { location: [300, 0, 0] }, n2: { location: [0, 200, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 295, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n2', distance: 195, radius: 30, height: 50, flags: 0 }],
  }),
  rpn('rpn-break-2', {
    breakAt: 2, navList: 'n0', navPoints: { n0: { location: [5, 0, 0], paths: [0, 1, 2] },
      n1: { location: [300, 0, 0] }, n2: { location: [0, 200, 0] }, n3: { location: [0, -200, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 295, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n2', distance: 195, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n3', distance: 100, radius: 30, height: 50, flags: 0 }],
  }),
  rpn('rpn-empty', { navPoints: { n1: { location: [10, 0, 0] } } }),
  // A class BaseClass (unused) and an explicit bUsePrunedPaths: true / false.
  rpn('rpn-pruned-class', {
    baseClass: '__class_navpoint', pruned: 1, navList: 'n0',
    navPoints: { n0: { location: [5, 0, 0], paths: [0], prunedPaths: [1, 2] },
      n1: { location: [10, 0, 0] }, n2: { location: [20, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 30, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n2', distance: 20, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n1', distance: 25, radius: 30, height: 50, flags: 0 }],
  }),
  rpn('rpn-pruned-off', {
    pruned: 0, navList: 'n0',
    navPoints: { n0: { location: [5, 0, 0], paths: [0], prunedPaths: [1, 2] },
      n1: { location: [10, 0, 0] }, n2: { location: [20, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 30, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n2', distance: 20, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n1', distance: 25, radius: 30, height: 50, flags: 0 }],
  }),
  rpn('rpn-from-nav', {
    from: 'nF', navList: 'n0',
    navPoints: { n0: { location: [5, 0, 0], paths: [0], nextNav: 'nF' },
      nF: { location: [3000, 0, 0], paths: [1, 2] }, n1: { location: [10, 0, 0] }, n2: { location: [20, 0, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 5, radius: 30, height: 50, flags: 0 },
                 { start: 'nF', end: 'n2', distance: 40, radius: 30, height: 50, flags: 0 },
                 { start: 'nF', end: 'n1', distance: 30, radius: 30, height: 50, flags: 0 }],
  }),
  // NavPoint as a non-lvalue: the writes go to a private temporary, the
  // iteration still runs once per entry and the record sees None.
  rpn('rpn-temp-navpoint', {
    navOut: 'temp', navList: 'n0', navPoints: { n0: { location: [5, 0, 0], paths: [0, 1] },
      n1: { location: [300, 0, 0] }, n2: { location: [0, 200, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 295, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n2', distance: 195, radius: 30, height: 50, flags: 0 }],
  }),
  // distance as a non-lvalue: the exec writes its private temporary.
  rpn('rpn-temp-dist', {
    distOut: 'temp', navList: 'n0', navPoints: { n0: { location: [5, 0, 0], paths: [0, 1] },
      n1: { location: [300, 0, 0] }, n2: { location: [0, 200, 0] } },
    reachSpecs: [{ start: 'n0', end: 'n1', distance: 295, radius: 30, height: 50, flags: 0 },
                 { start: 'n0', end: 'n2', distance: 195, radius: 30, height: 50, flags: 0 }],
  }),
  // The distance path through the exec (FromPoint None, default pruned).
  rpn('rpn-dist', {
    navList: 'd0', navPoints: chain([[100, 0, 0], [900, 0, 0], [1200, 0, 0], [300, 0, 0], [60, 60, 0]]),
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }, { ret: 1, hit: { actor: 0, time: 0.5 } },
                 { ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: flatWalk(200),
  }),
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
      commitMove(a.location, delta, h.time);
      return { time: f32(h.time), normal: h.normal, actor: h.actor === 'tgt' ? TGT : h.actor, item: h.item };
    },
    farMoveActor: (a, dest, test, noCheck) => { farMoves++; a.location = dest.map(f32); return 1; },
  };
  const target = j.target === 'tgt' ? TGT : j.target;
  const ret = mod.checkMove(pawn, j.delta, target, j.scale, j.flag, services);
  return { ret, moves, farMoves, locationBits: vecBits(pawn.location) };
}

/* walkReach twin: the full field surface (velocity, collision dims, ground
 * speed, flag dword, zones) plus the helper seams the flag-free walking path
 * never invokes.  The oracle's stubs mirror loc += delta*hit.time and the
 * FarMove restore. */
function runJsWalk(scene, mod = module) {
  const j = scene.js;
  const zones = j.zones || {};
  const zoneObj = n => {
    const s = zones[n] || {};
    return { water: !!s.water, pain: !!s.pain, damageType: s.damageType | 0, gravityZ: s.gravityZ };
  };
  const tgtSpec = j.target !== 0 ? (j.actors?.[j.target] || {}) : null;
  const tgt = tgtSpec === null ? 0 : {
    CollisionRadius: f32(tgtSpec.collisionRadius ?? 46),
    CollisionHeight: f32(tgtSpec.collisionHeight ?? 46),
    WarpDestZone: tgtSpec.warpDestZone ? zoneObj(tgtSpec.warpDestZone) : 0,
    __cls: tgtSpec.cls || 'actor',
  };
  const pawn = {
    location: j.pawn.location.map(f32), velocity: (j.pawn.velocity || [0, 0, 0]).map(f32),
    Rotation: j.pawn.rotation.slice(),
    CollisionRadius: f32(j.pawn.collisionRadius), CollisionHeight: f32(j.pawn.collisionHeight),
    MaxStepHeight: f32(j.pawn.maxStepHeight), GroundSpeed: f32(j.pawn.groundSpeed),
    Flags318: j.pawn.flags318 | 0, ReducedDamageType: j.pawn.field444 | 0,
    CollideFlag: j.pawn.collideFlag | 0, Physics: j.pawn.physics | 0,
    BaseEyeHeight: f32(j.pawn.baseEyeHeight ?? 40),
    zoneGravity: f32((zones[j.pawn.regionZone] || {}).gravityZ ?? -950),
    __rz: j.pawn.regionZone, __fz: j.pawn.footZone,
  };
  const scripted = scene.moveActor;
  const farSeq = j.farMove || null, prSeq = j.pointRegion || null, flSeq = j.fastLine || null;
  let idx = 0, moves = 0, farMoves = 0, fi = 0, pri = 0, fli = 0;
  const moveArgs = [], farArgs = [];
  const services = {
    location: a => a.location, velocity: a => a.velocity,
    read: (a, n) => a[n],
    zoneGravity: a => a.zoneGravity,
    gIsEditor: () => !!j.gIsEditor,
    regionZone: a => zoneObj(a.__rz ?? 'dry'),
    footZone: a => zoneObj(a.__fz ?? 'dry'),
    isA: (a, key) => !!(a && a.__cls === key),
    level: a => ({ model: a.__model ?? { id: 'model' } }),
    model: lvl => lvl.model,
    pointRegion: pt => {
      const r = (prSeq || ['dry'])[Math.min(pri++, (prSeq || []).length - 1)];
      return zoneObj(typeof r === 'string' ? r : (r.zone || 'dry'));
    },
    fastLineCheck: (model, end, start) => (flSeq || [1])[Math.min(fli++, (flSeq || [1]).length - 1)],
    moveActor: (a, delta, rot, flags) => {
      moves++;
      moveArgs.push([...delta].map(f32));
      const h = scripted[Math.min(idx, scripted.length - 1)].hit; idx++;
      commitMove(a.location, delta, h.time);
      return { time: f32(h.time), normal: h.normal, actor: h.actor === j.target ? tgt : h.actor, item: h.item };
    },
    farMoveActor: (a, dest, test, noCheck) => {
      farArgs.push([[...dest].map(f32), test ? 1 : 0, noCheck ? 1 : 0]);
      const call = farMoves++;
      const r = farSeq ? farSeq[Math.min(fi++, farSeq.length - 1)] : 1;
      if (r) {
        a.location = dest.map(f32);
        // scene.farMoveAdjust: the engine's placement leaves the actor off the destination (the oracle's stub does the same)
        const adjust = scene.farMoveAdjust?.[call];
        if (adjust) a.location = a.location.map((v, i) => f32(v + adjust[i]));
      }
      return r;
    },
    waterReach: () => { throw new Error('waterReach is outside this corpus'); },
  };
  const ret = scene.body === 'dispatch'
    ? mod.physicsReach(pawn, j.point.map(f32), j.radius, tgt, services)
    : scene.body === 'pointWorker'
    ? mod.pointWorker(pawn, j.point.map(f32), j.arg14, services)
    : mod.walkReach(pawn, j.point.map(f32), j.radius, j.arg18, tgt, services);
  return { ret, moves, farMoves, locationBits: vecBits(pawn.location),
           velocityBits: vecBits(pawn.velocity), moveArgs, farArgs };
}

/* Nav-graph twin: reachMask/directReach/actorWorker.  Builds named actors and
 * nav-points with their class/zone/path surface, the level's ReachSpec table,
 * and the same scripted boundary sequences the oracle records. */
const ISA = {
  actor: ['Actor'], pawn: ['Pawn', 'Actor'],
  playerpawn: ['PlayerPawn', 'Pawn', 'Actor'],
  scriptedpawn: ['ScriptedPawn', 'Pawn', 'Actor'],
  navpoint: ['NavPoint', 'Actor'], navigationpoint: ['NavPoint', 'Actor'],
  patrolpoint: ['PatrolPoint', 'NavPoint', 'Actor'],
  warpzonemarker: ['WarpZoneMarker', 'NavPoint', 'Actor'],
  inventoryspot: ['InventorySpot', 'NavPoint', 'Actor'],
  mover: ['Mover', 'Actor'], inventory: ['Inventory', 'Actor'],
  trigger: ['Trigger', 'Triggers', 'Actor'], levelinfo: ['LevelInfo', 'Actor'],
  brush: ['Brush', 'Actor'],
};
function runJsGraph(scene, mod = module, throughRuntime = false) {
  const j = scene.js;
  const zones = j.zones || {};
  const zoneObj = n => {
    const s = zones[n] || {};
    // jumpLanding (the falling-target delegation) reads the full ZoneGravity,
    // ZoneVelocity and ZoneFluidFriction; the probe's zone is zeroed elsewhere.
    return { water: !!s.water, pain: !!s.pain, damageType: s.damageType | 0, gravityZ: s.gravityZ,
      gravity: (s.gravity ?? [0, 0, s.gravityZ ?? -950]).map(f32),
      velocity: (s.zoneVelocity ?? [0, 0, 0]).map(f32), fluidFriction: f32(s.fluidFriction ?? 0) };
  };
  const mkActor = spec => {
    // A trailing '*' fabricates a subclass of the named class (probe side);
    // the twin flattens it into the ancestry list.
    const cls = (spec.cls || 'actor').replace(/\*+$/, '');
    return {
      location: (spec.location || [0, 0, 0]).map(f32),
      velocity: (spec.velocity || [0, 0, 0]).map(f32),
      Rotation: (spec.rotation || [0, 0, 0]).slice(),
      // Unspecified fields are 0 in the probe's zeroed fabricated memory.
      CollisionRadius: f32(spec.collisionRadius ?? 0),
      CollisionHeight: f32(spec.collisionHeight ?? 0),
      MaxStepHeight: f32(spec.maxStepHeight ?? 0),
      MeleeRange: f32(spec.meleeRange ?? 0),
      GroundSpeed: f32(spec.groundSpeed ?? 0),
      BaseEyeHeight: f32(spec.baseEyeHeight ?? 0),
      Flags318: spec.flags318 | 0, ReducedDamageType: spec.field444 | 0,
      Flags1dc: spec.flags1dc | 0, Flags4ec: spec.field4ec | 0,
      CollideFlag: spec.collideFlag | 0, Physics: spec.physics | 0,
      zoneGravity: f32((zones[spec.regionZone] || {}).gravityZ ?? -950),
      // NavigationPoint search state (+0x420..+0x448). The probe packs the
      // +0x448 bools into flags448; the twin keeps them as named fields.
      visitedWeight: spec.visitedWeight | 0, bestPathWeight: spec.bestPathWeight | 0,
      cost: spec.cost | 0, ExtraCost: spec.extraCost | 0,
      bPlayerOnly: !!(spec.flags448 & 1) || !!spec.bPlayerOnly,
      bEndPoint: !!(spec.flags448 & 2) || !!spec.bEndPoint,
      bEndPointOnly: !!(spec.flags448 & 4) || !!spec.bEndPointOnly,
      bSpecialCost: !!(spec.flags448 & 8) || !!spec.bSpecialCost,
      SpecialPause: f32(spec.specialPause ?? 0),
      __isA: ISA[cls] || ['Actor'],
      __rz: spec.regionZone ?? 'dry', __fz: spec.footZone ?? 'dry',
      __paths: spec.paths || [], __upstream: spec.upstreamPaths || [],
      __pruned: spec.prunedPaths || [],
      Brush: spec.brush | 0,                                  // +0x178 (IsBrush)
    };
  };
  const actors = {};
  for (const [n, spec] of Object.entries(j.navPoints || {}))
    actors[n] = mkActor({ cls: 'navpoint', ...spec });
  for (const [n, spec] of Object.entries(j.actors || {}))
    actors[n] = mkActor(spec);
  const pawn = mkActor({ cls: 'pawn', ...j.pawn });
  actors.self = pawn;
  const ref = v => (typeof v === 'string' ? (actors[v] ?? 0) : v);
  // Ref-valued fields resolve only after every actor exists.
  for (const [n, spec] of Object.entries(j.navPoints || {})) {
    actors[n].__nextNav = ref(spec.nextNav);
    actors[n].nextOrdered = ref(spec.nextOrdered);
    actors[n].prevOrdered = ref(spec.prevOrdered);
    actors[n].previousPath = ref(spec.previousPath);
    actors[n].startPath = ref(spec.startPath);
  }
  for (const [n, spec] of Object.entries(j.actors || {}))
    actors[n].Field398 = ref(spec.field398);
  pawn.MoveTarget = ref(j.pawn.moveTarget);                   // pawn+0x34c
  pawn.SpecialGoal = ref(j.pawn.specialGoal);                 // pawn+0x45c
  // pawn+0xa8: the scene's LevelInfo, else the probe's own fresh one.
  pawn.Level = j.levelInfo ? ref(j.levelInfo) : { levelInfo: true };
  const specs = (scene.reachSpecs || []).map(s => ({
    start: ref(s.start), distance: s.distance | 0, end: ref(s.end),
    radius: s.radius | 0, height: s.height | 0, reachFlags: s.flags | 0, pruned: s.pruned | 0,
  }));
  const target = ref(j.target);
  const scripted = scene.moveActor || [];
  const slSeq = j.singleLine || null, farSeq = j.farMove || null;
  const flSeq = j.fastLine || null, prSeq = j.pointRegion || null;
  let idx = 0, moves = 0, farMoves = 0, sli = 0, fi = 0, fli = 0;
  const flArgs = [];   // each FastLineCheck call's (end, start): the original's argument order is part of the contract
  const moveArgs = [], farArgs = [];   // MoveActor deltas and FarMoveActor (dest, test, noCheck) per call: what a walk aims at is part of the contract
  let sci = 0, shi = 0, pri = 0, pqi = 0;
  const scCalls = [], shCalls = [];
  const services = {
    location: a => a.location, velocity: a => a.velocity,
    read: (a, n) => a[n],
    write: (a, n, v) => { a[n] = v; },
    zoneGravity: a => a.zoneGravity,
    gIsEditor: () => !!j.gIsEditor,
    regionZone: a => zoneObj(a.__rz ?? 'dry'),
    footZone: a => zoneObj(a.__fz ?? 'dry'),
    isA: (a, key) => !!(a && a.__isA && a.__isA.includes(key)),
    // IsProbing consumes the same scripted queue the probe's hook serves.
    isProbing: (a, name) => {
      const arr = j.probing || [0];
      return arr[Math.min(pri++, arr.length - 1)] | 0;
    },
    level: a => ({ model: { id: 'model' } }),
    model: lvl => lvl.model,
    reachSpecTable: a => specs,
    // +0x320 upstreamPaths (inbound), +0x360 Paths and +0x3a0 PrunedPaths
    // (both outbound).
    paths: a => a.__paths, upstreamPaths: a => a.__upstream,
    prunedPaths: a => a.__pruned,
    specialCost: (nav, p) => {
      const arr = j.specialCost || [0];
      const v = arr[Math.min(sci++, arr.length - 1)];
      scCalls.push({ nav, pawn: p });
      return v | 0;
    },
    specialHandling: (node, p) => {
      const arr = j.specialHandling || [null];
      shCalls.push({ node, pawn: p });
      return ref(arr[Math.min(shi++, arr.length - 1)]);
    },
    singleLineCheck: (src, end, start, flags, extent, extra) => {
      const arr = slSeq || [{ ret: 1, hit: { actor: 0, time: 1 } }];
      const r = arr[Math.min(sli++, arr.length - 1)];
      const h = r.hit || {};
      return { ret: r.ret | 0, time: h.time ?? 1, actor: ref(h.actor ?? 0), item: h.item ?? -1 };
    },
    moveActor: (a, delta, rot, flags) => {
      moves++;
      moveArgs.push([...delta].map(f32));
      const h = scripted[Math.min(idx, scripted.length - 1)].hit; idx++;
      commitMove(a.location, delta, h.time);
      return { time: f32(h.time), normal: h.normal, actor: ref(h.actor ?? 0), item: h.item };
    },
    farMoveActor: (a, dest, test, noCheck) => {
      farArgs.push([[...dest].map(f32), test ? 1 : 0, noCheck ? 1 : 0]);
      const call = farMoves++;
      const r = farSeq ? farSeq[Math.min(fi++, farSeq.length - 1)] : 1;
      if (r) {
        a.location = dest.map(f32);
        const adjust = scene.farMoveAdjust?.[call];
        if (adjust) a.location = a.location.map((v, i) => f32(v + adjust[i]));
      }
      return r;
    },
    waterReach: () => { throw new Error('waterReach is outside this corpus'); },
    // The twin's services already act on any actor (target->jumpLanding).
    forActor: () => services,
    pointRegion: pt => {
      const arr = prSeq || [{ zone: 'dry' }];
      const r = arr[Math.min(pqi++, arr.length - 1)];
      return zoneObj(typeof r === 'string' ? r : (r.zone || 'dry'));
    },
    fastLineCheck: (model, end, start) => {
      const arr = flSeq || [1];
      flArgs.push([[...end].map(f32), [...start].map(f32)]);
      return arr[Math.min(fli++, arr.length - 1)] | 0;
    },
    navListHead: () => ref(j.navList),                        // LevelInfo+0x548
    nextNav: n => n.__nextNav,                                // navpoint+0x42c
  };
  const foundCell = { node: null };
  let ret, pathnodes = null, iter = null;
  if (scene.body === 'reachMask') ret = mod.reachMask(pawn, services);
  else if (scene.body === 'directReach')
    ret = mod.directReach(pawn, actors[j.source], target, services);
  else if (scene.body === 'actorReachable')
    ret = mod.actorReachable(pawn, target, services);
  else if (scene.body === 'pathTowardWorker')
    ret = mod.pathTowardWorker(pawn, target, j.bSingle | 0, foundCell, j.bClear | 0, services);
  else if (scene.body === 'pathToWorker')
    ret = mod.pathToWorker(pawn, j.point.map(f32), j.bSingle | 0, foundCell, j.bClear | 0, services);
  else if (scene.body === 'findPathTo') {
    if (throughRuntime) {
      // The same tokens as the oracle: EX_VectorConst, EX_IntConst or EX_Nothing.
      const f32bytes = v => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return [...b]; };
      const args = scene.args.flatMap(arg => arg.kind === 'nothing' ? [0x0b]
        : arg.kind === 'vector' ? [0x23, ...arg.value.flatMap(f32bytes)]
        : [0x1d, ...Array.from({length: 4}, (_, i) => (arg.value >>> (8 * i)) & 255)]);
      const bytes = Uint8Array.from([0x04, 0x62, 0x06, ...args, 0x16]);
      const vm = compileFunction({pkg: {imports: [], exports: []}, entry: {path: scene.name}, bytes, size: bytes.length});
      const host = {boundaryNatives: new Set(), collisionViewActors: new WeakSet(), pawnNavServices: () => services};
      ret = vm.run(pawn, {}, {invokeNative: call => ScriptRuntime.prototype.invokeNative.call(host, call)});
    } else {
      ret = mod.execFindPathTo(pawn, j.point.map(f32), j.argCount > 1 ? j.bSingle | 0 : 0,
        j.argCount > 2 ? j.bClear | 0 : 1, services);
    }
  }
  else if (scene.body === 'findPathToward') {
    if (throughRuntime) {
      // Decode the SAME argument tokens the native oracle evaluates. In
      // particular, EX_Nothing must reach invokeNative as undefined rather
      // than being replaced here with the desired default from scene.js.
      const args = scene.args.flatMap(arg => arg.kind === 'nothing' ? [0x0b]
        : arg.kind === 'object' ? (target ? [0x20, 1] : [0x2a])
        : [0x1d, ...Array.from({length: 4}, (_, i) => (arg.value >>> (8 * i)) & 255)]);
      const bytes = Uint8Array.from([0x04, 0x62, 0x05, ...args, 0x16]);
      const vm = compileFunction({pkg: {imports: [], exports: [{name: 'Target'}]},
        entry: {path: scene.name}, bytes, size: bytes.length + (target ? 3 : 0)});
      const host = {boundaryNatives: new Set(), collisionViewActors: new WeakSet(),
        pawnNavServices: () => services};
      ret = vm.run(pawn, {}, {objectReference: () => target,
        invokeNative: call => ScriptRuntime.prototype.invokeNative.call(host, call)});
    } else {
      ret = mod.execFindPathToward(pawn, target, j.bSingle | 0, j.bClear | 0, services);
    }
  }
  else if (scene.body === 'getPathnodeList') {
    pathnodes = [];
    ret = mod.getPathnodeList(pawn, pathnodes, j.max, ref(j.from) || null, j.pruned, j.sort, services);
  }
  else if (scene.body === 'reachablePathnodes') {
    if (throughRuntime) iter = runVmPathnodes(scene, pawn, actors, services);
    else {
      // The exec's five argument evaluations, then the VM's loop: next()
      // before each body pass, the record body, a `break` at breakAt.
      const cells = { foundbuf: { v: null }, vecbuf: { v: 0 } };
      const evaluate = i => {
        const a = scene.args[i];
        if (a.kind === 'out') { const c = cells[a.value]; return { reference: true, get: () => c.v, set: v => { c.v = v; } }; }
        if (a.kind === 'object') return a.value === '__none' ? null : a.value === '__class_navpoint' ? CLASS_NAVPOINT : ref(a.value);
        if (a.kind === 'int' || a.kind === 'float') return a.value;
        return undefined;
      };
      const it = mod.createReachablePathnodesIterator({ receiver: pawn, argumentCount: scene.args.length,
        evaluateArgument: evaluate, services });
      const records = [];
      let exit = 'end';
      while (it.next()) {
        records.push([cells.foundbuf.v, cells.vecbuf.v]);
        if (records.length === j.breakAt) { exit = 'pop'; break; }
      }
      iter = { records, exit, found: cells.foundbuf.v, dist: cells.vecbuf.v };
    }
  }
  else ret = mod.actorWorker(pawn, target, j.argC, services);
  // foundbuf/result slot values resolve to node names for comparison.
  const nameOf = new Map(Object.entries(actors).map(([n, a]) => [a, n]));
  const navOut = FOUND_BODIES.has(scene.body);
  const navState = {};
  for (const [n, a] of Object.entries(actors)) {
    if (n === 'self') continue;
    navState[n] = {
      visitedWeight: a.visitedWeight | 0, bestPathWeight: a.bestPathWeight | 0,
      nextOrdered: nameOf.get(a.nextOrdered) || (a.nextOrdered ? '?obj' : '0'),
      prevOrdered: nameOf.get(a.prevOrdered) || (a.prevOrdered ? '?obj' : '0'),
      startPath: nameOf.get(a.startPath) || (a.startPath ? '?obj' : '0'),
      previousPath: nameOf.get(a.previousPath) || (a.previousPath ? '?obj' : '0'),
      cost: a.cost | 0, extraCost: a.ExtraCost | 0,
      flags448: ((a.bPlayerOnly ? 1 : 0) | (a.bEndPoint ? 2 : 0)
        | (a.bEndPointOnly ? 4 : 0) | (a.bSpecialCost ? 8 : 0)),
    };
  }
  return {
    // findPathToward's result slot is an actor pointer: null -> '0' like the
    // probe's zeroed resultOut; live actors resolve to their scene name
    // (the `ret` key below).
    moves, farMoves, slc: sli, fli, flArgs, moveArgs, farArgs,
    locationBits: vecBits(pawn.location),
    // The 517 bodies also emit the found slot, per-node search state, and the
    // pawn's special-nav fields; other bodies leave them undefined so the
    // compare skips them (the probe only reports them for FOUND_BODIES).
    scCalls: navOut ? scCalls.length : undefined,
    shCalls: navOut ? shCalls.length : undefined,
    navState: navOut ? navState : undefined,
    specialGoal: navOut ? (nameOf.get(pawn.SpecialGoal) || (pawn.SpecialGoal ? '?obj' : '0'))
                        : undefined,
    specialPause: navOut ? pawn.SpecialPause : undefined,
    flags318: navOut ? pawn.Flags318 : undefined,
    // GetPathnodeList: all 32 list slots {node, f32 dist} (stale ones too).
    list: pathnodes ? Array.from({ length: 32 }, (_, i) => pathnodes[i]
      ? [nameOf.get(pathnodes[i].node) || '?obj', bitsHex(pathnodes[i].dist)] : ['0', '00000000']) : undefined,
    // ReachablePathnodes: each body pass's out slots, the exit and the
    // slots' final values.
    iterRecords: iter ? iter.records.map(([n, d]) => [n ? nameOf.get(n) || '?obj' : '0', bitsHex(d ?? 0)]) : undefined,
    iterExit: iter ? iter.exit : undefined,
    found: iter ? (iter.found ? nameOf.get(iter.found) || '?obj' : '0') : navOut ? (foundCell.node ? (nameOf.get(foundCell.node) || '?obj') : '0') : undefined,
    finalDist: iter ? bitsHex(iter.dist ?? 0) : undefined,
    ret: scene.body === 'reachablePathnodes' ? undefined
      : scene.body === 'findPathToward' || scene.body === 'findPathTo'
      ? (ret ? (nameOf.get(ret) || '?obj') : '0')
      : (ret && typeof ret === 'object') ? (nameOf.get(ret) || '?obj') : ret,
  };
}

const CLASS_NAVPOINT = { class: 'NavigationPoint' };
/* ReachablePathnodes as compiled foreach bytecode through the VM and
 * ScriptRuntime.createIterator: foreach ReachablePathnodes(BaseClass, Found,
 * FromPoint, Dist[, pruned]) { native(1023)(Found, Dist); [break;] }.
 * In-memory offsets count each compact object index as 4 bytes. */
function runVmPathnodes(scene, pawn, actors, services) {
  const parts = [];                                         // [bytes, memSize]
  const put = (bytes, mem = bytes.length) => parts.push([bytes, mem]);
  const at = () => parts.reduce((n, [, m]) => n + m, 0);
  const [base, nav, from, dist, pruned] = scene.args;
  put([0x2f]); put([0x63, 0xec]);                           // EX_Iterator, native 1004
  put(base.value === '__none' ? [0x2a] : [0x20, 4], base.value === '__none' ? 1 : 5);
  put(nav.kind === 'out' ? [0x01, 1] : [0x2a], nav.kind === 'out' ? 5 : 1);
  put(from.value === '__none' ? [0x2a] : [0x20, 3], from.value === '__none' ? 1 : 5);
  if (dist.kind === 'out') put([0x01, 2], 5);
  else put([0x1e, ...new Uint8Array(Float32Array.of(dist.value).buffer)]);
  if (pruned.kind === 'nothing') put([0x0b]);
  else put([0x1d, pruned.value & 255, 0, 0, 0]);
  put([0x16]);
  const wEndAt = parts.length; put([0, 0]);                 // patched below
  put([0x63, 0xff, 0x01, 1, 0x01, 2, 0x16], 13);            // the record call
  let jumpAt = -1;
  if (scene.js.breakAt === 1) { put([0x30]); jumpAt = parts.length; put([0x06, 0, 0]); }
  put([0x31]);
  const wEnd = at(); put([0x30]);
  const after = at(); put([0x04, 0x0b]);
  parts[wEndAt][0] = [wEnd & 255, wEnd >> 8];
  if (jumpAt >= 0) parts[jumpAt][0] = [0x06, after & 255, after >> 8];
  const bytes = Uint8Array.from(parts.flatMap(([b]) => b));
  const vm = compileFunction({ pkg: { imports: [], exports: [{ name: 'Found' }, { name: 'Dist' }, { name: 'From' }, { name: 'Cls' }] },
    entry: { path: scene.name }, bytes, size: at() });
  const host = { pawnNavServices: () => services };
  const records = [];
  const value = v => (v?.reference ? v.get() : v);
  pawn.Found = null; pawn.Dist = 0;
  vm.run(pawn, {}, {
    iterator: call => ScriptRuntime.prototype.createIterator.call(host, call),
    invokeNative: call => {
      if (call.index !== 1023) throw new Error(`unexpected native ${call.index}`);
      records.push([value(call.evaluateArgument(0)), value(call.evaluateArgument(1))]);
    },
    objectReference: (fn, index) => index === 3 ? actors[from.value] : index === 4 ? CLASS_NAVPOINT : null,
  });
  return { records, exit: scene.js.breakAt === 1 && records.length ? 'pop' : 'end',
    found: pawn.Found, dist: pawn.Dist };
}

/* AI-pick twin (709 chain): direction/search/worker/exec bodies share the
 * moveActor/farMove boundary stubs plus the scripted appFrand queue.  `outBuf`
 * mirrors the probe's vecbuf: direction writes int rotator words, the rest
 * write float32 vector components. */
function runJsPick(scene, mod = module) {
  const j = scene.js;
  const zones = j.zones || {};
  const zoneObj = n => {
    const s = zones[n] || {};
    return { water: !!s.water, pain: !!s.pain, damageType: s.damageType | 0, gravityZ: s.gravityZ };
  };
  const pawn = {
    location: (j.pawn.location || [0, 0, 0]).map(f32),
    velocity: (j.pawn.velocity || [0, 0, 0]).map(f32),
    Rotation: (j.pawn.rotation || [0, 0, 0]).slice(),
    CollisionRadius: f32(j.pawn.collisionRadius), CollisionHeight: f32(j.pawn.collisionHeight),
    MaxStepHeight: f32(j.pawn.maxStepHeight), GroundSpeed: f32(j.pawn.groundSpeed ?? 200),
    Flags318: j.pawn.flags318 | 0, ReducedDamageType: j.pawn.field444 | 0,
    CollideFlag: j.pawn.collideFlag | 0, Physics: j.pawn.physics | 0,
    BaseEyeHeight: f32(j.pawn.baseEyeHeight ?? 40),
    zoneGravity: f32((zones[j.pawn.regionZone] || {}).gravityZ ?? -950),
    __rz: j.pawn.regionZone ?? 'dry', __fz: j.pawn.footZone ?? 'dry',
  };
  const scripted = scene.moveActor || [];
  const frSeq = j.frand || [0.5];
  let idx = 0, moves = 0, farMoves = 0, fri = 0;
  const services = {
    location: a => a.location, velocity: a => a.velocity,
    read: (a, n) => a[n],
    zoneGravity: a => a.zoneGravity,
    gIsEditor: () => !!j.gIsEditor,
    regionZone: a => zoneObj(a.__rz ?? 'dry'),
    footZone: a => zoneObj(a.__fz ?? 'dry'),
    frand: () => frSeq[Math.min(fri++, frSeq.length - 1)],
    moveActor: (a, delta, rot, flags) => {
      moves++;
      const h = scripted[Math.min(idx, scripted.length - 1)].hit; idx++;
      commitMove(a.location, delta, h.time);
      return { time: f32(h.time), normal: h.normal, actor: 0, item: h.item };
    },
    farMoveActor: (a, dest, test, noCheck) => {
      farMoves++; a.location = dest.map(f32); return 1;
    },
    // The mode-3 swim body 0x103c3ca0 is not ported: keep it explicit.
    waterMove: () => { throw new Error('waterMove is outside this corpus'); },
  };
  const outBuf = [0, 0, 0];
  let ret;
  if (scene.body === 'aiDirection') {
    const dir = mod.aiDirection(services.frand, j.cy, j.yd, j.cp, j.pd);
    outBuf[0] = dir[0]; outBuf[1] = dir[1]; outBuf[2] = dir[2];
    ret = 1;   // eax is the out pointer — the vecbuf compare carries fidelity
  } else if (scene.body === 'aiPickSearch') {
    ret = mod.aiPickSearch(pawn, j.origin.map(f32), j.yaw | 0, j.pitch | 0,
                           f32(j.minR), f32(j.maxR), 15.0,
                           j.outNull ? null : outBuf, services);
  } else if (scene.body === 'aiPickWorker') {
    ret = mod.aiPickWorker(pawn, f32(j.minDist), f32(j.maxDist), j.cy | 0, f32(j.yd),
                           j.cp | 0, f32(j.pd), j.tries | 0, f32(j.mult),
                           j.outNull ? null : outBuf, services);
  } else {
    // aiPickExec: nine evaluated slots; a {set} ref for `out`, null for the
    // dead temp slot the native writes when the arg is not a reference.
    const dest = j.outRef
      ? { set: v => { outBuf[0] = v[0]; outBuf[1] = v[1]; outBuf[2] = v[2]; } }
      : null;
    ret = mod.execAiPickRandomDestination(pawn, j.args, dest, services);
  }
  return { ret, moves, farMoves, frand: fri,
           outBits: scene.body === 'aiDirection'
             ? outBuf.map(w => (w >>> 0).toString(16).padStart(8, '0'))
             : vecBits(outBuf),
           locationBits: vecBits(pawn.location) };
}

// aiDirection returns the out pointer in eax — normalized to a nonzero flag
// (the vecbuf compare carries the real fidelity check for those scenes).
const PTR_RET_BODIES = new Set(['aiDirection']);
// Bodies whose result slot (or &found cell) carries an actor pointer — the
// probe reports the raw address; resolve it through the scene's address map.
const FOUND_BODIES = new Set(['pathTowardWorker', 'findPathToward', 'pathToWorker', 'findPathTo']);
function normalizeProbe(r, isExec, body) {
  const nameOf = new Map(Object.entries(r.addresses || {}).map(([n, a]) => [a, n]));
  // Probe address fields are hex strings; the addresses map keys are ints.
  const addr = s => {
    const v = typeof s === 'string' ? parseInt(s, 16) : s;
    return nameOf.get(v) || (v === 0 ? '0' : String(s));
  };
  const navBodies = FOUND_BODIES.has(body);
  return {
    // Exec natives write the verdict to *result; workers return it in eax.
    // FindPathToward's result slot is an actor pointer, not a verdict int.
    ret: body === 'reachablePathnodes' ? undefined
        : body === 'findPathToward' || body === 'findPathTo' ? addr(r.resultOut)
        : isExec ? parseInt(r.resultOut, 16)
        : PTR_RET_BODIES.has(body) ? (r.returned !== 0 ? 1 : 0)
        : r.returned | 0,
    found: navBodies || body === 'reachablePathnodes' ? addr(r.found) : undefined,
    list: body === 'getPathnodeList'
      ? Array.from({ length: 32 }, (_, i) => [addr(r.scratch[2 * i]), r.scratch[2 * i + 1]]) : undefined,
    iterRecords: r.iterRecords ? r.iterRecords.map(([n, d]) => [addr(n), d]) : undefined,
    iterExit: r.iterExit ?? undefined,
    finalDist: body === 'reachablePathnodes' ? r.vecbuf[0] : undefined,
    navState: navBodies
      ? Object.fromEntries(Object.entries(r.navState).map(([n, s]) => [n, {
          visitedWeight: s.visitedWeight, bestPathWeight: s.bestPathWeight,
          nextOrdered: addr(s.nextOrdered), prevOrdered: addr(s.prevOrdered),
          startPath: addr(s.startPath), previousPath: addr(s.previousPath),
          cost: s.cost, extraCost: s.extraCost, flags448: parseInt(s.flags448, 16),
        }]))
      : undefined,
    specialGoal: navBodies ? addr(r.pawnSpecial.specialGoal) : undefined,
    specialPause: navBodies ? r.pawnSpecial.specialPause : undefined,
    flags318: navBodies ? r.pawn.flags318 : undefined,
    scCalls: navBodies ? r.counts.specialCost : undefined,
    moves: r.counts.moveActor,
    farMoves: r.counts.farMoveActor,
    slc: r.counts.singleLineCheck,
    fli: r.counts.fastLineCheck,
    flArgs: (r.commands || []).filter(c => c.op === 'fastLineCheck').map(c => [c.end.map(f32), c.start.map(f32)]),
    moveArgs: (r.commands || []).filter(c => c.op === 'moveActor').map(c => c.delta.map(f32)),
    farArgs: (r.commands || []).filter(c => c.op === 'farMoveActor').map(c => [c.dest.map(f32), c.test ? 1 : 0, c.noCheck ? 1 : 0]),
    frand: r.counts.frand,
    outBits: r.vecbuf.slice(0, 3),
    locationBits: r.pawn.locationBits,
    velocityBits: r.pawn.velocityBits,
  };
}

function compare(name, o, j) {
  const d = [];
  if (process.env.DEBUG_SCENE && name.startsWith(process.env.DEBUG_SCENE)) console.error(name, 'oracle moves', JSON.stringify(o.moveArgs?.slice(0, 6)), 'far', JSON.stringify(o.farArgs?.slice(0, 8)), 'js moves', JSON.stringify(j.moveArgs?.slice(0, 6)));
  if (o.ret !== j.ret) d.push(`${name}: ret ${o.ret} != ${j.ret}`);
  if (o.moves !== j.moves) d.push(`${name}: moveActor calls ${o.moves} != ${j.moves}`);
  if (o.farMoves !== j.farMoves) d.push(`${name}: farMoveActor calls ${o.farMoves} != ${j.farMoves}`);
  if (j.slc !== undefined && o.slc !== j.slc) d.push(`${name}: singleLineCheck calls ${o.slc} != ${j.slc}`);
  if (j.frand !== undefined && o.frand !== j.frand) d.push(`${name}: frand draws ${o.frand} != ${j.frand}`);
  if (j.outBits && o.outBits.join() !== j.outBits.join())
    d.push(`${name}: out ${o.outBits} != ${j.outBits}`);
  if (o.locationBits.join() !== j.locationBits.join())
    d.push(`${name}: location ${o.locationBits} != ${j.locationBits}`);
  if (j.velocityBits && o.velocityBits.join() !== j.velocityBits.join())
    d.push(`${name}: velocity ${o.velocityBits} != ${j.velocityBits}`);
  if (j.found !== undefined && o.found !== j.found)
    d.push(`${name}: found ${o.found} != ${j.found}`);
  if (j.fli !== undefined && o.fli !== j.fli)
    d.push(`${name}: fastLineCheck calls ${o.fli} != ${j.fli}`);
  if (j.moveArgs && JSON.stringify(o.moveArgs) !== JSON.stringify(j.moveArgs)) {
    const at = j.moveArgs.findIndex((v, i) => JSON.stringify(v) !== JSON.stringify(o.moveArgs[i]));
    d.push(`${name}: MoveActor delta #${at} ${JSON.stringify(o.moveArgs[at])} != ${JSON.stringify(j.moveArgs[at])}`);
  }
  if (j.farArgs && JSON.stringify(o.farArgs) !== JSON.stringify(j.farArgs)) {
    const at = j.farArgs.findIndex((v, i) => JSON.stringify(v) !== JSON.stringify(o.farArgs[i]));
    d.push(`${name}: FarMoveActor (dest, test, noCheck) #${at} ${JSON.stringify(o.farArgs[at])} != ${JSON.stringify(j.farArgs[at])}`);
  }
  if (j.flArgs && j.flArgs.length && JSON.stringify(o.flArgs) !== JSON.stringify(j.flArgs))
    d.push(`${name}: fastLineCheck (end, start) ${JSON.stringify(o.flArgs)} != ${JSON.stringify(j.flArgs)}`);
  if (j.scCalls !== undefined && o.scCalls !== j.scCalls)
    d.push(`${name}: specialCost calls ${o.scCalls} != ${j.scCalls}`);
  if (j.specialGoal !== undefined && o.specialGoal !== j.specialGoal)
    d.push(`${name}: specialGoal ${o.specialGoal} != ${j.specialGoal}`);
  if (j.specialPause !== undefined && o.specialPause !== j.specialPause)
    d.push(`${name}: specialPause ${o.specialPause} != ${j.specialPause}`);
  if (j.flags318 !== undefined && (o.flags318 | 0) !== (j.flags318 | 0))
    d.push(`${name}: flags318 ${(o.flags318 >>> 0).toString(16)} != ${(j.flags318 >>> 0).toString(16)}`);
  if (j.list && JSON.stringify(o.list) !== JSON.stringify(j.list))
    d.push(`${name}: list ${JSON.stringify(o.list)} != ${JSON.stringify(j.list)}`);
  if (j.iterRecords && JSON.stringify(o.iterRecords) !== JSON.stringify(j.iterRecords))
    d.push(`${name}: iteration records ${JSON.stringify(o.iterRecords)} != ${JSON.stringify(j.iterRecords)}`);
  if (j.iterExit !== undefined && o.iterExit !== j.iterExit)
    d.push(`${name}: iterator exit ${o.iterExit} != ${j.iterExit}`);
  if (j.finalDist !== undefined && o.finalDist !== j.finalDist)
    d.push(`${name}: final distance ${o.finalDist} != ${j.finalDist}`);
  if (j.navState && o.navState) {
    for (const n of new Set([...Object.keys(o.navState), ...Object.keys(j.navState)])) {
      const a = o.navState[n], b = j.navState[n];
      if (!a || !b) { d.push(`${name}: navState ${n} missing`); continue; }
      for (const k of Object.keys(b))
        if (String(a[k]) !== String(b[k]))
          d.push(`${name}: navState ${n}.${k} ${a[k]} != ${b[k]}`);
    }
  }
  return d;
}

const EXEC_BODIES = new Set(['actorReachable', 'aiPickExec', 'findPathToward', 'findPathTo']);
const PICK_BODIES = new Set(['aiDirection', 'aiPickSearch', 'aiPickWorker', 'aiPickExec']);
const GRAPH_BODIES = new Set(['reachMask', 'directReach', 'actorWorker',
                              'pathTowardWorker', 'findPathToward', 'pathToWorker', 'findPathTo',
                              'getPathnodeList', 'reachablePathnodes']);
const runFor = scene =>
  (PICK_BODIES.has(scene.body) ? runJsPick
   : scene.body === 'walkReach' || scene.body === 'dispatch' || scene.body === 'pointWorker' ? runJsWalk
   : GRAPH_BODIES.has(scene.body) || EXEC_BODIES.has(scene.body) ? runJsGraph
   : runJs);

// ---------------------------------------------------------------------------
const probeResults = runProbe(scenes.map(s => {
  const { js, ...scene } = s;
  return scene;
}));

let failures = 0, runtimeCases = 0;
for (let i = 0; i < scenes.length; i++) {
  const r = probeResults[i];
  const scene = scenes[i];
  if (!r || r.ok === false) {
    console.log(`FAIL ${scene.name}: probe error — ${r?.error ?? 'no result'}`);
    failures++; continue;
  }
  let js;
  try { js = runFor(scene)(scene); }
  catch (e) { console.log(`FAIL ${scene.name}: js threw ${e.stack ?? e}`); failures++; continue; }
  const diffs = compare(scene.name, normalizeProbe(r.result, EXEC_BODIES.has(scene.body), scene.body), js);
  if (scene.body === 'findPathToward' || scene.body === 'findPathTo'
      || (scene.body === 'reachablePathnodes' && scene.js.vm)) {
    runtimeCases++;
    try {
      diffs.push(...compare(`${scene.name} VM/runtime`, normalizeProbe(r.result, true, scene.body),
        runJsGraph(scene, module, true)));
    } catch (error) { diffs.push(`${scene.name} VM/runtime: ${error.stack ?? error}`); }
  }
  if (diffs.length) { failures++; diffs.forEach(d => console.log(`FAIL ${d}`)); }
}
// Every instruction of the findPathTo worker (but its two appFailAssert
// calls) and of the toward worker's falling-target delegation executed.
{
  const [listing] = runProbe([{ disasm: { pathTo: PATH_TO_COVERAGE, delegation: DELEGATION_COVERAGE,
    exec518: FIND_PATH_TO_EXEC_COVERAGE, getPathnodeList: PATHNODE_COVERAGE,
    exec1004: RPN_EXEC_COVERAGE } }]);
  const covered = new Set(probeResults.flatMap(r => r?.result?.coverage ?? []));
  const missed = Object.entries(listing.result.instructions).flatMap(([name, list]) =>
    list.filter(a => !covered.has(a) && !PATH_TO_ASSERTS.has(a) && !FIND_PATH_TO_EXEC_STAT.has(a)
      && !FIND_PATH_TO_EXEC_TAILSET.has(a) && !PATHNODE_ASSERTS.has(a)).map(a => `${name}:${a}`));
  const total = Object.values(listing.result.instructions).reduce((n, list) => n + list.length, 0);
  const excluded = PATH_TO_ASSERTS.size + FIND_PATH_TO_EXEC_STAT.size + FIND_PATH_TO_EXEC_TAILSET.size
    + PATHNODE_ASSERTS.size;
  const perBody = Object.entries(listing.result.instructions).map(([name, list]) =>
    `${name} ${list.filter(a => covered.has(a)).length}/${list.length}`).join(', ');
  if (missed.length) { failures++; console.log(`FAIL findPathTo/ReachablePathnodes coverage: ${missed.length} instructions not executed: ${missed.join(' ')}`); }
  else console.log(`PASS findPathTo/ReachablePathnodes coverage: ${total - excluded}/${total} instructions executed (${perBody}; excluded: ${PATH_TO_ASSERTS.size + PATHNODE_ASSERTS.size} check() failure path, ${FIND_PATH_TO_EXEC_STAT.size} GTimestamp stat, ${FIND_PATH_TO_EXEC_TAILSET.size} unverified tailSet call)`);
}
const passed = scenes.length - failures;
console.log(`${failures ? 'FAIL' : 'PASS'} validate-pawn-nav: ${passed}/${scenes.length} scenes bit-exact`);
console.log(`Compared ${runtimeCases} FindPathToward/FindPathTo/ReachablePathnodes scenes through decoded VM/runtime dispatch.`);

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

  // -- walkReach mutants -----------------------------------------------------
  // Far-step scale 4.1 -> 400: every far step under-moves -> checkMove returns
  // 0 (blocked) instead of 1 -> the reach scenes fail.
  { name: 'wr-far-scale',
    pattern: '      scale = 4.1;',
    replacement: '      scale = 400.0;',
    expect: ['wr-flat-reach', 'wr-flat-far', 'wr-below-step', 'wr-diagonal',
             'wr-vel-restore'] },
  // Arrival |dz|<step gate inverted: a close-enough drop no longer counts, so
  // the within-radius arrivals fall through to the landing-arc and miss.
  { name: 'wr-arrival-gate',
    pattern: 'if (ltU(ld(adz), ld(step))) reached = 1;',
    replacement: 'if (gtU(ld(adz), ld(step))) reached = 1;',
    expect: ['wr-inside-radius'] },

  // -- pointReachable worker (0x103c0d30) mutants ----------------------------
  // distSq limit 1e6 -> 5000: every non-editor reach scene (point 100 ->
  // d2=10000) now fails the gate before any boundary call.
  { name: 'pw-dist-limit',
    pattern: 'if (gtU(d2, ld(1000000.0))) return 0;',
    replacement: 'if (gtU(d2, ld(5000.0))) return 0;',
    expect: ['pw-reach', 'pw-water-swim', 'pw-pain-immune', 'pw-arg14-skip',
             'pw-farmove-fail'] },
  // canSwim bit 0x4000 -> 0x8000: a swimming pawn no longer exempts the water
  // gate, so the water-dest reach is rejected.
  { name: 'pw-water-swim',
    pattern: 'if (!rz.water && !(flags318 & 0x4000) && destZone.water) return 0;',
    replacement: 'if (!rz.water && !(flags318 & 0x8000) && destZone.water) return 0;',
    expect: ['pw-water-swim'] },
  // Pain-resist compare inverted: an unresisted pain zone now passes while the
  // resisted one is rejected.
  { name: 'pw-pain-resist',
    pattern: 'if (!fz.pain && destZone.pain && destZone.damageType !== rdt) return 0;',
    replacement: 'if (!fz.pain && destZone.pain && destZone.damageType === rdt) return 0;',
    expect: ['pw-pain-gate', 'pw-pain-immune'] },
  // Blocked LOS returns 1 instead of 0: the no-LOS scene now reports reachable.
  { name: 'pw-los-block',
    pattern: 'if (!services.fastLineCheck(model, point, eye)) return 0;',
    replacement: 'if (!services.fastLineCheck(model, point, eye)) return 1;',
    expect: ['pw-no-los'] },
  // arg14 gate inverted: the arg14!=0 scene now runs (and fails) the LOS check
  // while the arg14==0 no-LOS scene skips it and reaches.
  { name: 'pw-arg14-gate',
    pattern: '  if (arg14 === 0) {',
    replacement: '  if (arg14 !== 0) {',
    expect: ['pw-arg14-skip', 'pw-no-los'] },

  // -- reachMask (0x10326d10) mutants ---------------------------------------
  // bit1 -> bit2 for output bit6: the lone bit1 scene loses its mask bit.
  { name: 'rm-bit1-src',
    pattern: '(((f >>> 1) & 1) << 6)',
    replacement: '(((f >>> 2) & 1) << 6)',
    expect: ['rm-bit1'] },

  // -- directReach (0x103dad20) mutants -------------------------------------
  // Radius gate never rejects: the under-radius spec now reaches the SLC and
  // returns 1 instead of being filtered out.
  { name: 'dr-radius-gate',
    // Unique via the ftoi comment; scoutD/BFS share the dims gate.
    pattern: 'if ((spec.radius | 0) < cri) continue;                // spec+0x0c < ftoi(CR)',
    replacement: 'if ((spec.radius | 0) < 0) continue;                // spec+0x0c < ftoi(CR)',
    expect: ['dr-radius'] },
  // The cannot-open-Mover continue becomes a hard accept.
  { name: 'dr-mover-gate',
    // Unique via the next line; scoutD repeats the same mover gate.
    pattern: 'if (!(f318 & 0x10000)) continue;                    // !bCanOpenDoors\n'
           + '        if (f318 & 0x2) return 1;',
    replacement: 'if (!(f318 & 0x10000)) return 1;                      // !bCanOpenDoors\n'
           + '        if (f318 & 0x2) return 1;',
    expect: ['dr-mover-blocked'] },

  // -- actorWorker (0x103c0630) mutants -------------------------------------
  // canSwim bit 0x4000 -> 0x8000: the swimming pawn loses its water exemption.
  { name: 'aw-water-swim',
    pattern: 'if (rz.water && !(f318 & 0x4000)) return 0;',
    replacement: 'if (rz.water && !(f318 & 0x8000)) return 0;',
    expect: ['aw-water-swim'] },
  // Pawn footZone pain-resist compare inverted: immune now blocked, vulnerable
  // now allowed.
  { name: 'aw-foot-pain',
    pattern: 'if (fz.pain && fz.damageType !== rdt) return 0;',
    replacement: 'if (fz.pain && fz.damageType === rdt) return 0;',
    expect: ['aw-foot-pain', 'aw-foot-pain-resist'] },
  // Within-combined-radius returns 0 instead of 1: the close pawn target now
  // falls through to the walk instead of the immediate accept.
  { name: 'aw-within-radius',
    pattern: 'if (leU(distSq, Rsq)) return 1;',
    replacement: 'if (leU(distSq, Rsq)) return 0;',
    expect: ['aw-pawn-inside'] },
  // LOS "hit a non-target" gate inverted: a blocker no longer blocks and a
  // direct hit on the target now blocks.
  { name: 'aw-los-target',
    pattern: 'if (!eqU(ld(hit.time), D1) && hit.actor !== target) return 0;',
    replacement: 'if (!eqU(ld(hit.time), D1) && hit.actor === target) return 0;',
    expect: ['aw-los-blocked', 'aw-los-target'] },
  // WarpZoneMarker no longer passes the actor as the physicsReach target.
  { name: 'aw-warp-target',
    pattern: "services.isA(target, 'WarpZoneMarker') ? target : 0",
    replacement: "false ? target : 0",
    expect: ['aw-warp'] },
  // argC LOS gate inverted: the argC=1 scene now runs the line check (slc 0->1).
  { name: 'aw-argc-los',
    pattern: '  if (argC === 0) {',
    replacement: '  if (argC !== 0) {',
    expect: ['aw-no-los'] },

  // -- actorReachable exec 0x103bc1a0 ---------------------------------------
  // Null object arg should short-circuit to result 0, not 1.
  { name: 'ae-null-gate',
    pattern: 'if (!target) return 0;                                    // 0x103bc1dc',
    replacement: 'if (!target) return 1;                                    // 0x103bc1dc',
    expect: ['ae-null'] },
  // Inventory holder redirect dropped: the worker then sees the Inventory
  // (blocked slc -> 0) instead of the fast-path NavigationPoint (1).
  { name: 'ae-inv-redirect',
    pattern: 'if (holder) { origInv = t; t = holder; }',
    replacement: 'if (false) { origInv = t; t = holder; }',
    expect: ['ae-inv-redirect'] },
  // Anchor==target equality lost: the anchor fast-path can no longer return 1.
  { name: 'ae-anchor-eq',
    pattern: 'if (anchor === t || directReach',
    replacement: 'if (anchor === null || directReach',
    expect: ['ae-anchor-hit'] },
  // Nav==target equality lost: the list scan can no longer return 1 on match.
  { name: 'ae-nav-eq',
    pattern: 'if (nav === t || directReach',
    replacement: 'if (nav === null || directReach',
    expect: ['ae-nav-hit'] },
  // CR<=115 gate inverted: big pawns now take the fast path, small ones skip it.
  { name: 'ae-cr-gate',
    pattern: 'leU(ld(CR), ld(115.0))',
    replacement: 'geU(ld(CR), ld(115.0))',
    expect: ['ae-nav-hit', 'ae-big-pawn'] },
  // found+PHYS_Flying gate inverted: non-flying now falls to the worker and
  // flying short-circuits to 0 instead.
  { name: 'ae-found-phys',
    pattern: "rd(services, pawn, 'Physics') !== 4",
    replacement: "rd(services, pawn, 'Physics') === 4",
    expect: ['ae-nav-found-unreach', 'ae-nav-flying-unreach'] },
  // |dz|<CH vertical gate removed: an overhead nav point now counts as "within".
  { name: 'ae-dz-gate',
    pattern: 'if (geU(ltU(dz, D0) ? x87neg(dz) : dz, CH)) return false;',
    replacement: 'if (false) return false;',
    expect: ['ae-nav-above'] },
  // +0x398 restore dropped: the worker sees the far holder, not the inventory.
  { name: 'ae-inv-undo',
    pattern: 'if (origInv) t = origInv;',
    replacement: 'if (false) t = origInv;',
    expect: ['ae-inv-worker'] },

  // -- AIPickRandomDestination (709) chain mutants ---------------------------
  // Score classifier: dropping the below-min branch makes sub-min positions
  // read sc=0 -> haveBest flips early.  Only observable where the band is
  // missed or overshot; a clean band entry rewrites best to the same loc.
  { name: 'ai-score-min',
    pattern: 'ltU(ld(x), ld(minSq)) ? -1 : gtU(ld(x), ld(maxSq)) ? 1 : 0;',
    replacement: 'false ? -1 : gtU(ld(x), ld(maxSq)) ? 1 : 0;',
    expect: ['as-overshoot', 'as-maxstep-retry', 'as-iter-cap',
             'ap-mult-floor', 'ap-second-stage'] },
  // Search step floor 5.0 -> 0.5: a CR=4 pawn strides 0.5 instead of 5 and
  // under-moves checkMove's 4.1 scale on every step -> blocked.
  { name: 'ai-step-floor',
    pattern: 'if (ltU(ld(step), ld(5.0))) step = 5.0;',
    replacement: 'if (ltU(ld(step), ld(0.5))) step = 0.5;',
    expect: ['as-small-step'] },
  // The stride upper clamp dropped: CR=30 steps 30 at a time instead of 25,
  // landing on a different in-band candidate.
  { name: 'ai-step-clamp',
    pattern: '  else if (!leU(ld(step), ld(25.0))) step = 25.0;',
    replacement: '',
    expect: ['as-stride-clamp'] },
  // usePitch mask dropped: walking keeps pitch=0 anyway, but the flying scene
  // now always receives pitch=0 -> different dirVec -> different candidate.
  { name: 'ai-usepitch',
    pattern: '    if (phys !== 3 || services.regionZone(pawn).water) usePitch = 1;',
    replacement: '    if (false) usePitch = 1;',
    expect: ['ap-fly-pitch'] },
  // Second-stage multiplier search dropped: the mult<1 hit keeps the far
  // candidate instead of re-searching at f32(dist*mult).
  { name: 'ai-second-stage',
    pattern: 'if (found && ltU(ld(mult), D1)) {                     // 0x103c80e2 mult<1',
    replacement: 'if (false) {',
    expect: ['ap-second-stage'] },
  // tries clamp dropped: tries=0 runs zero attempts -> ret 0.
  { name: 'ai-tries-clamp',
    pattern: 'tries = (tries | 0) >= 1 ? tries | 0 : 1;',
    replacement: 'tries = 0;',
    expect: ['ap-tries0'] },
  // The yaw draw consumed the pitch distribution (and vice versa).
  { name: 'ai-draw-swap',
    pattern: 'const yawOff = aiDraw(frand, dy, 32767.0, -32768.0);            // 0x1036d0d8',
    replacement: 'const yawOff = aiDraw(frand, dp, 32767.0, -32768.0);            // 0x1036d0d8',
    expect: ['ad-inner', 'ad-clamps'] },
];

MUTATIONS.push(
  // -- findPathTo worker (0x103dc1d0) mutants --------------------------------
  // The toward worker's bHunting fallback grafted on: a hunting pawn with no
  // point anchor would search from the unreached head.
  { name: 'fto-hunting-fallback',
    pattern: "    if (!state.seeded) return fail();                       // 0x103dc4e4",
    replacement: "    if (!state.seeded && (rd(services, pawn, 'Flags318') & 0x200000)) state.seeded = 1;\n    if (!state.seeded) return fail();",
    expect: ['fto-scan-exhaust'] },
  // scoutE gated on the anchor alone: bSinglePath no longer skips it.
  { name: 'fto-scoute-gate',
    pattern: "  if (!state.anchor && !bSinglePath)                        // [ebp-0x14]==0\n    navScoutE(listP, pawn, found, services);                // 0x103018cf\n  return 1;\n}",
    replacement: "  if (!state.anchor)\n    navScoutE(listP, pawn, found, services);\n  return 1;\n}",
    expect: ['fto-singlepath'] },
  // The hop result is the pawn-side head, not the point-side head.
  { name: 'fto-hop-found',
    pattern: 'found.node = listP.items[0];                          // 0x103dc383',
    replacement: 'found.node = listT.items[0];',
    expect: ['fto-hop', 'fto-anchor-hop'] },
  // The point anchor's BFS seed is the distance, not the squared distance.
  { name: 'fto-scan-key',
    pattern: 'listT.keys[0] = x87ftol(appSqrt(ld(listT.keys[i])));  // 0x103dc4ac fild, sqrt, ftol',
    replacement: 'listT.keys[0] = listT.keys[i];',
    expect: ['fto-bfs', 'fto-scan-second'] },
);

MUTATIONS.push(
  // -- scoutE (0x103db0e0) -------------------------------------------------
  // The destination of the walk is the point, not the Location the test move left (pointWorker / actorWorker, both branches).
  { name: 'pw-dest-raw',
    pattern: "return physicsReach(pawn, dest, 15.0, 0, services);",
    replacement: "return physicsReach(pawn, point, 15.0, 0, services);",
    expect: ['pw-farmove-adjusted', 'fpt-test-move-adjusted'] },
  { name: 'aw-pawn-dest-raw',
    pattern: "return physicsReach(pawn, dest, st(R), target, services);",
    replacement: "return physicsReach(pawn, tloc.map(f32), st(R), target, services);",
    expect: ['aw-pawn-reach-adjusted'] },
  { name: 'aw-actor-dest-raw',
    pattern: "return physicsReach(pawn, dest, R, arg4, services);",
    replacement: "return physicsReach(pawn, tloc.map(f32), R, arg4, services);",
    expect: ['aw-actor-adjusted'] },
  // scoutE short-circuits on the line check (pointWorker not run after a failed line check).
  { name: 'scoute-flc-short-circuit',
    pattern: "    const clear = services.fastLineCheck(model, cloc, eye);\n    const reachable = pointWorker(pawn, cloc, 1, services);\n    if (!clear || !reachable) continue;",
    replacement: "    if (!services.fastLineCheck(model, cloc, eye)) continue;\n    if (!pointWorker(pawn, cloc, 1, services)) continue;",
    expect: ['fpt-scoute-flc-fails'] },
  // The second hop short-circuits and restores the pawn only on success.
  { name: 'hop2-flc-short-circuit',
    pattern: "      const clear = services.fastLineCheck(model, hloc, eye);\n      const reachable = pointWorker(pawn, hloc, 1, services);\n      if (clear && reachable) found.node = hop2;\n      services.farMoveActor(pawn, origLoc, 1, 1);           // 0x103dbb56\n      return 1;",
    replacement: "      if (services.fastLineCheck(model, hloc, eye) &&\n          pointWorker(pawn, hloc, 1, services)) {\n        found.node = hop2;\n        services.farMoveActor(pawn, origLoc, 1, 1);         // 0x103dbb56\n        return 1;\n      }\n      return 1;",
    expect: ['fpt-pass2-hop2-flc0'] },
  // The listA/listT scans pass the item first and the target second (the original: target, item).
  { name: 'scan-flc-order',
    pattern: "      if (!services.fastLineCheck(model, targetLoc, iloc)) continue;   // 0x103db78f: (target, item), as the live trace shows",
    replacement: "      if (!services.fastLineCheck(model, iloc, targetLoc)) continue;",
    expect: ['fpt-pass2'] },
  // The last passing candidate wins (the loop not exiting at the first success).
  { name: 'scoute-last-passing',
    pattern: "    return;                                                 // 0x103db302 -> epilogue 0x103db304\n",
    replacement: "",
    expect: ['fpt-scoute-first-passing'] },
  // -- GetPathnodeList (0x103c6490) / ReachablePathnodes (1004) mutants -----
  // A full list replacing its farthest farther entry (the "obvious" rule).
  { name: 'gpl-replace-farthest',
    pattern: 'if (slot < 0 || !leU(ld(list[slot].dist), ld(list[k].dist))) slot = k;',
    replacement: 'if (slot < 0 || ltU(ld(list[slot].dist), ld(list[k].dist))) slot = k;',
    expect: ['gpl-dist-replace'] },
  // The shared appSqrt's double rounding of the root.
  { name: 'gpl-sqrt-double-rounding',
    pattern: 'const d = coreAppSqrt(distSq);                        // 0x103c6845',
    replacement: 'const d = appSqrt(distSq);',
    expect: ['gpl-dist-sqrt-tie'] },
  // The overlap scan from the FromPoint instead of the pawn.
  { name: 'gpl-overlap-from',
    pattern: "      if (isOverlapping(pawn, nav, services)) { start = nav; break; } // 0x103c6616",
    replacement: "      if (isOverlapping(fromPoint && !services.isA(fromPoint, 'NavPoint') ? fromPoint : pawn, nav, services)) { start = nav; break; }",
    expect: ['gpl-from-actor'] },
  // A NavigationPoint MoveTarget taken without the overlap test.
  { name: 'gpl-mt-no-overlap',
    pattern: "    if (anchor && services.isA(anchor, 'NavPoint') && isOverlapping(pawn, anchor, services))",
    replacement: "    if (anchor && services.isA(anchor, 'NavPoint'))",
    expect: ['gpl-mt-far'] },
  // IsOverlapping's XY bound inclusive.
  { name: 'overlap-xy-inclusive',
    pattern: 'if (leU(x87mul(r, r), x87add(x87mul(dy, dy), x87mul(dx, dx)))) return 0;',
    replacement: 'if (ltU(x87mul(r, r), x87add(x87mul(dy, dy), x87mul(dx, dx)))) return 0;',
    expect: ['gpl-overlap-edges'] },
  // A stable sort in place of MSVCRT's qsort.
  { name: 'gpl-stable-sort',
    pattern: 'if (bSort && count > 1) msvcrtQsort(list, count, pathnodeCompare); // 0x103c68ef',
    replacement: 'if (bSort && count > 1) list.slice(0, count).sort(pathnodeCompare).forEach((e, i) => { list[i] = e; });',
    expect: ['gpl-sort-two-values', 'gpl-start-filters'] },
  // The qsort pivot one element lower.
  { name: 'qsort-pivot',
    pattern: 'swap(lo + (size >>> 1), lo);                          // 0x780254ff',
    replacement: 'swap(lo + ((size - 1) >>> 1), lo);',
    expect: ['gpl-sort-two-values'] },
  // The iterator not clearing NavPoint before the exhaustion test.
  { name: 'rpn-no-clear',
    pattern: '      navOut.set(null);                                     // 0x103c8d02\n',
    replacement: '',
    expect: ['rpn-start'] },
);

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
    try { js = runFor(scenes[i])(scenes[i], mutMod); } catch { flipped.push(scenes[i].name); continue; }
    if (compare(scenes[i].name, normalizeProbe(r.result, EXEC_BODIES.has(scenes[i].body), scenes[i].body), js).length) flipped.push(scenes[i].name);
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
