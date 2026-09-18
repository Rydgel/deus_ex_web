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
import { x87load, x87add, x87mul, x87store } from '../src/runtime/script-vm.mjs';

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
  const t = x87load(time);
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
 * flyReach, else -> 0.  Only the walkReach and the 0-branches are bit-exact
 * validatable here (fly/water helpers aren't ported yet). */
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
                        pointRegion = ['dry'], fastLine = [1], farMove = [1, 1] } = {}) {
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
                        singleLine = null, farMove = [1, 1] } = {}) {
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

/* Alternate forward-full / down-floor hits so each checkMove step progresses
 * like a flat walk; padded at the tail to the requested depth. */
function flatWalk(depth) {
  const mv = [];
  for (let i = 0; i < depth; i++) { mv.push(H(1, 1)); mv.push(H(0.1, 1)); }
  return mv;
}

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
  // The second (upstream +0x3a0) path array finds the spec too.
  dr('dr-upstream', {
    navPoints: { src: { upstreamPaths: [0] } }, actors: { tgt: {} },
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
  ae('ae-nav-hit', {
    navList: 'n0',
    navPoints: { tgt: { location: [30, 0, 0] }, n0: { location: [50, 0, 0], nextNav: 'tgt' } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1 },
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
  }),
  // Same but PHYS_Flying (4) -> falls through to the worker (slc=1 proves it).
  ae('ae-nav-flying-unreach', {
    navList: 'n0',
    navPoints: { tgt: { location: [500, 0, 0] }, n0: { location: [30, 0, 0] } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 4 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 0.5 } }],
  }),
  // No nav point within radius -> found=0 -> worker fallback.
  ae('ae-nav-none-near', {
    navList: 'n0',
    navPoints: { tgt: { location: [300, 0, 0] }, n0: { location: [500, 0, 0] } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1 },
    singleLine: [{ ret: 1, hit: { actor: 0, time: 0.5 } }],
  }),
  // Inventory target with a +0x398 holder -> redirect onto the nav point.
  ae('ae-inv-redirect', {
    navList: 'n0',
    actors: { tgt: { cls: 'inventory', location: [50, 0, 0], field398: 'hold' } },
    navPoints: { hold: { location: [30, 0, 0] }, n0: { location: [10, 0, 0], nextNav: 'hold' } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1 },
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
    singleLine: [{ ret: 1, hit: { actor: 0, time: 0.5 } }],
  }),
  // Nav point above the pawn's collision height -> |dz|>=CH -> not within ->
  // found=0 -> worker fallback (slc=1 proves the worker ran).
  ae('ae-nav-above', {
    navList: 'n0',
    navPoints: { tgt: { location: [200, 0, 0] }, n0: { location: [30, 0, 100] } },
    pawn: { collisionRadius: 20, collisionHeight: 40, physics: 1 },
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
    singleLine: [{ ret: 1, hit: { actor: 0, time: 1 } }],
    moveActor: [H(1, 1), H(0.1, 1), H(1, 1), H(0.1, 1), H(1, 1), H(0.1, 1)],
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
      return { time: h.time, normal: h.normal, actor: h.actor === 'tgt' ? TGT : h.actor, item: h.item };
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
      const h = scripted[Math.min(idx, scripted.length - 1)].hit; idx++;
      commitMove(a.location, delta, h.time);
      return { time: h.time, normal: h.normal, actor: h.actor === j.target ? tgt : h.actor, item: h.item };
    },
    farMoveActor: (a, dest, test, noCheck) => {
      farMoves++;
      const r = farSeq ? farSeq[Math.min(fi++, farSeq.length - 1)] : 1;
      if (r) a.location = dest.map(f32);
      return r;
    },
    jumpArc: () => 0, altMove: () => 0, waterReach: () => 0, flyReach: () => 0,
  };
  const ret = scene.body === 'dispatch'
    ? mod.physicsReach(pawn, j.point.map(f32), j.radius, tgt, services)
    : scene.body === 'pointWorker'
    ? mod.pointWorker(pawn, j.point.map(f32), j.arg14, services)
    : mod.walkReach(pawn, j.point.map(f32), j.radius, j.arg18, tgt, services);
  return { ret, moves, farMoves, locationBits: vecBits(pawn.location),
           velocityBits: vecBits(pawn.velocity) };
}

/* Nav-graph twin: reachMask/directReach/actorWorker.  Builds named actors and
 * nav-points with their class/zone/path surface, the level's ReachSpec table,
 * and the same scripted boundary sequences the oracle records. */
const ISA = {
  actor: ['Actor'], pawn: ['Pawn', 'Actor'],
  playerpawn: ['PlayerPawn', 'Pawn', 'Actor'],
  scriptedpawn: ['ScriptedPawn', 'Pawn', 'Actor'],
  navpoint: ['NavPoint', 'Actor'], navigationpoint: ['NavPoint', 'Actor'],
  warpzonemarker: ['WarpZoneMarker', 'NavPoint', 'Actor'],
  inventoryspot: ['InventorySpot', 'NavPoint', 'Actor'],
  mover: ['Mover', 'Actor'], inventory: ['Inventory', 'Actor'],
  trigger: ['Trigger', 'Triggers', 'Actor'], levelinfo: ['LevelInfo', 'Actor'],
};
function runJsGraph(scene, mod = module) {
  const j = scene.js;
  const zones = j.zones || {};
  const zoneObj = n => {
    const s = zones[n] || {};
    return { water: !!s.water, pain: !!s.pain, damageType: s.damageType | 0, gravityZ: s.gravityZ };
  };
  const mkActor = spec => {
    const cls = spec.cls || 'actor';
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
      __isA: ISA[cls] || ['Actor'],
      __rz: spec.regionZone ?? 'dry', __fz: spec.footZone ?? 'dry',
      __paths: spec.paths || [], __upstream: spec.upstreamPaths || [],
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
  for (const [n, spec] of Object.entries(j.navPoints || {}))
    actors[n].__nextNav = ref(spec.nextNav);
  for (const [n, spec] of Object.entries(j.actors || {}))
    actors[n].Field398 = ref(spec.field398);
  pawn.Anchor = ref(j.pawn.moveTarget);                       // pawn+0x34c
  const specs = (scene.reachSpecs || []).map(s => ({
    start: ref(s.start), distance: s.distance | 0, end: ref(s.end),
    radius: s.radius | 0, height: s.height | 0, reachFlags: s.flags | 0, pruned: s.pruned | 0,
  }));
  const target = ref(j.target);
  const scripted = scene.moveActor || [];
  const slSeq = j.singleLine || null, farSeq = j.farMove || null;
  let idx = 0, moves = 0, farMoves = 0, sli = 0, fi = 0;
  const services = {
    location: a => a.location, velocity: a => a.velocity,
    read: (a, n) => a[n],
    zoneGravity: a => a.zoneGravity,
    gIsEditor: () => !!j.gIsEditor,
    regionZone: a => zoneObj(a.__rz ?? 'dry'),
    footZone: a => zoneObj(a.__fz ?? 'dry'),
    isA: (a, key) => !!(a && a.__isA && a.__isA.includes(key)),
    level: a => ({ model: { id: 'model' } }),
    model: lvl => lvl.model,
    reachSpecTable: a => specs,
    paths: a => a.__paths, upstreamPaths: a => a.__upstream,
    singleLineCheck: (src, end, start, flags, extent, extra) => {
      const arr = slSeq || [{ ret: 1, hit: { actor: 0, time: 1 } }];
      const r = arr[Math.min(sli++, arr.length - 1)];
      const h = r.hit || {};
      return { ret: r.ret | 0, time: h.time ?? 1, actor: ref(h.actor ?? 0), item: h.item ?? -1 };
    },
    moveActor: (a, delta, rot, flags) => {
      moves++;
      const h = scripted[Math.min(idx, scripted.length - 1)].hit; idx++;
      commitMove(a.location, delta, h.time);
      return { time: h.time, normal: h.normal, actor: ref(h.actor ?? 0), item: h.item };
    },
    farMoveActor: (a, dest, test, noCheck) => {
      farMoves++;
      const r = farSeq ? farSeq[Math.min(fi++, farSeq.length - 1)] : 1;
      if (r) a.location = dest.map(f32);
      return r;
    },
    jumpArc: () => 0, altMove: () => 0, waterReach: () => 0, flyReach: () => 0,
    pointRegion: () => zoneObj('dry'), fastLineCheck: () => 1,
    navListHead: () => ref(j.navList),                        // level+0x90 head
    nextNav: n => n.__nextNav,                                // navpoint+0x42c
  };
  const ret = scene.body === 'reachMask' ? mod.reachMask(pawn, services)
    : scene.body === 'directReach' ? mod.directReach(pawn, actors[j.source], target, services)
    : scene.body === 'actorReachable' ? mod.actorReachable(pawn, target, services)
    : mod.actorWorker(pawn, target, j.argC, services);
  return { ret, moves, farMoves, slc: sli, locationBits: vecBits(pawn.location) };
}

function normalizeProbe(r, isExec) {
  return {
    // Exec natives write the verdict to *result; workers return it in eax.
    ret: isExec ? parseInt(r.resultOut, 16) : r.returned | 0,
    moves: r.counts.moveActor,
    farMoves: r.counts.farMoveActor,
    slc: r.counts.singleLineCheck,
    locationBits: r.pawn.locationBits,
    velocityBits: r.pawn.velocityBits,
  };
}

function compare(name, o, j) {
  const d = [];
  if (o.ret !== j.ret) d.push(`${name}: ret ${o.ret} != ${j.ret}`);
  if (o.moves !== j.moves) d.push(`${name}: moveActor calls ${o.moves} != ${j.moves}`);
  if (o.farMoves !== j.farMoves) d.push(`${name}: farMoveActor calls ${o.farMoves} != ${j.farMoves}`);
  if (j.slc !== undefined && o.slc !== j.slc) d.push(`${name}: singleLineCheck calls ${o.slc} != ${j.slc}`);
  if (o.locationBits.join() !== j.locationBits.join())
    d.push(`${name}: location ${o.locationBits} != ${j.locationBits}`);
  if (j.velocityBits && o.velocityBits.join() !== j.velocityBits.join())
    d.push(`${name}: velocity ${o.velocityBits} != ${j.velocityBits}`);
  return d;
}

const EXEC_BODIES = new Set(['actorReachable']);
const runFor = scene =>
  (scene.body === 'walkReach' || scene.body === 'dispatch' || scene.body === 'pointWorker' ? runJsWalk
   : scene.body === 'reachMask' || scene.body === 'directReach' || scene.body === 'actorWorker' || EXEC_BODIES.has(scene.body) ? runJsGraph
   : runJs);

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
  try { js = runFor(scene)(scene); }
  catch (e) { console.log(`FAIL ${scene.name}: js threw ${e.stack ?? e}`); failures++; continue; }
  const diffs = compare(scene.name, normalizeProbe(r.result, EXEC_BODIES.has(scene.body)), js);
  if (diffs.length) { failures++; diffs.forEach(d => console.log(`FAIL ${d}`)); }
}
const passed = scenes.length - failures;
console.log(`${failures ? 'FAIL' : 'PASS'} validate-pawn-nav: ${passed}/${scenes.length} scenes bit-exact`);

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
    pattern: 'if ((spec.radius | 0) < cri) continue;',
    replacement: 'if ((spec.radius | 0) < 0) continue;',
    expect: ['dr-radius'] },
  // The cannot-open-Mover continue becomes a hard accept.
  { name: 'dr-mover-gate',
    pattern: 'if (!(f318 & 0x10000)) continue;',
    replacement: 'if (!(f318 & 0x10000)) return 1;',
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
    try { js = runFor(scenes[i])(scenes[i], mutMod); } catch { flipped.push(scenes[i].name); continue; }
    if (compare(scenes[i].name, normalizeProbe(r.result, EXEC_BODIES.has(scenes[i].body)), js).length) flipped.push(scenes[i].name);
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
