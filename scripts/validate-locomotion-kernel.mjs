#!/usr/bin/env node
/**
 * The Rust latent polls (native/script-vm/src/loco.rs, docs/rust-core.md
 * "October 1: latent polls") against the JavaScript bodies they transcribe:
 * script-pawn-locomotion.mjs pollMoveTo 501, pollMoveToward 503, pollStrafeTo
 * 505, pollStrafeFacing 507, pollTurnTo 509, pollTurnToward 511 and
 * pollWaitForLanding 528, through the runtime's
 * pollLatent service.
 *
 * Boots a map (SCRIPT_VM=rust), plays a few ticks, then runs cases on real
 * pawns: each case writes the pawn's locomotion fields (Physics, Location,
 * Destination, Focus near and far, Velocity below and above 100, MoveTimer
 * signs, the flags, edge floats: NaN payloads, infinities, huge values)
 * and its MoveTarget and FaceTarget (None, navigation points, inventory,
 * pawns, the pawn itself), then polls twice from the same images: once in
 * Rust (`vm_loco_poll`), once in JavaScript. A Rust poll that hands back
 * must have written nothing; one that completes must leave every image
 * byte of the pawn and its targets as JavaScript does, with the same
 * latent outcome, and JavaScript must have called no event.
 *
 *   node scripts/validate-locomotion-kernel.mjs [--map 00_Training] [--cases 3000] [--seed S]
 */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';

process.env.SCRIPT_VM = 'rust';
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const MAP = option('map', '00_Training'), CASES = Number(option('cases', 3000));
let seed = Number(option('seed', 0x10c0)) >>> 0;

const {AssetStore} = await import('../src/unreal/assets.mjs');
const {decodeMap} = await import('../src/unreal/map.mjs');
const {createGame} = await import('../src/viewer/game.mjs');
const {gameDirectory} = await import('./game-directory.mjs');
const {handleOf} = await import('../src/runtime/script-object-handles.mjs');
const {vectorToRotator} = await import('../src/runtime/script-decoration-primitives.mjs');

const random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = list => list[Math.floor(random() * list.length)];
const chance = p => random() < p;
const io = new DataView(new ArrayBuffer(4));
const fromBits = b => (io.setUint32(0, b >>> 0, true), io.getFloat32(0, true));
const EDGES = [0x7fc00000, 0x7fc12345, 0xffc00001, 0x7f800000, 0xff800000, 0x80000000, 0x00000003, 0x7f7fffff, 0x5f000000, 0x60000000];
const edge = () => fromBits(pick(EDGES));
const around = (v, spread) => Math.fround(v + (random() - 0.5) * 2 * spread);

// ---- Boot -----------------------------------------------------------------
const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(MAP);
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, vm = runtime.scriptVm;
assert.ok(vm?.loco, 'the Rust interpreter is not running (SCRIPT_VM=rust)');
for (let i = 0; i < 20; i++) game.tick(1 / 60);
const x = vm.exports ?? vm.actorTick.x;
vm.loco.table();
assert.ok(vm.loco.complete, 'the locomotion field table is incomplete');

// ---- Actors ---------------------------------------------------------------
const player = game.player.collisionActor, level = runtime.levelFor(player);
const instanceOf = actor => actor?.[runtime.instanceKey] ?? runtime.instances.get(actor);
const isA = (actor, key) => { for (let c = instanceOf(actor)?.cls; c; c = c.base) if (c.record.key === key) return true; return false; };
const live = level.actors.filter(a => a && instanceOf(a)?.base && !instanceOf(a).nativeObject?.released);
const pawns = live.filter(a => isA(a, 'engine.pawn') && !isA(a, 'engine.playerpawn'));
const navigation = live.filter(a => isA(a, 'engine.navigationpoint')).slice(0, 40);
const inventory = live.filter(a => isA(a, 'engine.inventory')).slice(0, 20);
const others = live.filter(a => !isA(a, 'engine.pawn') && !isA(a, 'engine.navigationpoint') && !isA(a, 'engine.inventory')).slice(0, 20);
assert.ok(pawns.length && navigation.length, `${MAP} has no pawns or navigation points`);
console.log(`${MAP}: ${pawns.length} pawns, ${navigation.length} navigation points, ${inventory.length} inventory, ${others.length} others`);

// An image with its reference array (pointer cells hold handles; refs keep
// the identities).
const image = actor => { const i = instanceOf(actor); return i.arena.bytes.slice(i.base, i.base + i.size); };
const refsOf = actor => instanceOf(actor).refs?.slice() ?? null;
const restore = (actor, bytes, refs) => {
  const i = instanceOf(actor);
  i.arena.bytes.set(bytes, i.base);
  if (refs) for (let k = 0; k < refs.length; k++) i.refs[k] = refs[k];
};
const read = (actor, name) => runtime.readNamed(actor, name);
const write = (actor, name, value) => runtime.writeNamed(actor, name, value);

// ---- Cases ----------------------------------------------------------------
const POLLS = [501, 503, 505, 507, 509, 511, 528];
const outcomes = new Map();
const count = key => outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
for (let n = 0; n < CASES; n++) {
  const pawn = pick(pawns), index = pick(POLLS);
  const delta = pick([1 / 60, 0.05, 0.4, Math.fround(random() * 0.1)]);
  const targetOf = () => {
    const r = random();
    return r < 0.15 ? null : r < 0.6 ? pick(navigation) : r < 0.75 && inventory.length ? pick(inventory)
      : r < 0.88 ? pick(pawns) : r < 0.92 ? player : others.length ? pick(others) : null;
  };
  const moveTarget = targetOf(), faceTarget = targetOf();
  const touched = [pawn, moveTarget, faceTarget].filter(Boolean);
  const saved = touched.map(a => [a, image(a), refsOf(a)]);
  // The case's fields.
  // Scenarios aim at the bodies' compares: arrival (horizontal 16, the
  // height bound max(48, CollisionHeight)), Touch (CollisionRadius and
  // CollisionHeight), the facing cone, deceleration at speed 100, braking
  // (AvgPhysicsTime*speed*1.4 against the distance), the melee bound and
  // the speed cap; the rest is spread.
  const loc = read(pawn, 'Location');
  const targetLoc = moveTarget ? read(moveTarget, 'Location') : null;
  const ch = pick([20, 39, 44, 48, 60]), cr = pick([10, 20, 34]);
  write(pawn, 'CollisionHeight', ch);
  write(pawn, 'CollisionRadius', cr);
  const physics = pick([1, 1, 1, 1, 0, 3, 4, 4, 2, 0xa]);
  write(pawn, 'Physics', physics);
  const touchScene = moveTarget && isA(moveTarget, 'engine.inventory') && chance(0.6);
  let at = loc;
  if (touchScene) {
    // The pawn beside the item: horizontal distance at CollisionRadius,
    // height difference at CollisionHeight, each a few ulps either way.
    const angle = random() * 2 * Math.PI, r = cr * pick([0.5, 1, 1, 1.5]) + pick([0, 0, 1e-4, -1e-4]);
    const dz = (chance(0.5) ? 1 : -1) * (ch * pick([0.5, 1, 1, 2]) + pick([0, 0, 1e-4, -1e-4]));
    at = [Math.fround(targetLoc[0] + r * Math.cos(angle)), Math.fround(targetLoc[1] + r * Math.sin(angle)), Math.fround(targetLoc[2] + dz)];
    // Exactly CollisionRadius away along an axis, level: d2 equals CR*CR.
    if (chance(0.3)) {
      const [ux, uy] = pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
      at = [Math.fround(targetLoc[0] + cr * ux), Math.fround(targetLoc[1] + cr * uy), targetLoc[2]];
    }
    write(pawn, 'Location', at);
  }
  // A goal at a chosen horizontal distance and height from the pawn.
  const offset = () => {
    const h = pick([0, 8, 15.99, 16, 16.01, 20, 100, 400, 3000]) * (1 + pick([0, 0, 1e-7, -1e-7]));
    const dz = pick([0, 10, 46, 47.99, 48, 48.01, ch, ch + 0.01, ch - 0.01, 200]) * (chance(0.5) ? 1 : -1);
    const angle = random() * 2 * Math.PI;
    return [Math.fround(at[0] + h * Math.cos(angle)), Math.fround(at[1] + h * Math.sin(angle)), Math.fround(at[2] + dz)];
  };
  const destination = chance(0.05) ? [edge(), 0, 0] : moveTarget && chance(0.3) ? targetLoc : offset();
  write(pawn, 'Destination', destination);
  const focus = chance(0.05) ? [0, edge(), 0] : chance(0.5) ? destination : offset();
  write(pawn, 'Focus', focus);
  // Velocity at a chosen speed (100 is the deceleration bound).
  const speed = pick([0, 0, 50, 99.99, 100, 100.01, 150, 300, 600]);
  const heading = random() * 2 * Math.PI;
  write(pawn, 'Velocity', chance(0.05) ? [edge(), 1, 2] :
    [Math.fround(speed * Math.cos(heading)), Math.fround(speed * Math.sin(heading)), pick([0, 0, 3, -20])]);
  write(pawn, 'Acceleration', [around(0, 500), around(0, 500), around(0, 10)]);
  // Rotation: random, or with its yaw at the facing cone's edges from the
  // goal's direction (the JavaScript vectorToRotator gives that yaw).
  // The facing goal (StrafeTo faces Focus, StrafeFacing its FaceTarget) and
  // the steering goal (Destination, or MoveToward's target).
  const goal = index === 509 || index === 505 ? focus
    : index === 511 || index === 507 ? (faceTarget ? read(faceTarget, 'Location') : focus)
      : index === 503 ? (targetLoc ?? destination) : destination;
  const steerGoal = index === 503 ? (targetLoc ?? destination) : destination;
  let yaw = Math.floor(random() * 200000) - 100000;
  if (chance(0.5) && [0, 1, 2].every(i => Number.isFinite(Math.fround(goal[i] - at[i])))) {
    const toward = vectorToRotator([0, 1, 2].map(i => Math.fround(goal[i] - (at[i] ?? 0))))[1] & 0xffff;
    yaw = toward + (chance(0.5) ? 1 : -1) * pick([0x7cf, 0x7d0, 0x7d1, 0xf82f, 0xf830, 0xf82e, 0]) + pick([0, 65536, -65536]);
  }
  write(pawn, 'Rotation', [Math.floor(random() * 65536) - 32768, yaw | 0, 0]);
  write(pawn, 'DesiredRotation', [1, 2, 3]);
  write(pawn, 'MoveTimer', chance(0.05) ? edge() : pick([-1, -0, 0, 0.5, 1.2, 5]));
  write(pawn, 'DesiredSpeed', pick([0, 0.3, 0.5, 1, 2, Math.fround(random() * 3)]));
  write(pawn, 'AccelRate', pick([0, 500, 2048, Math.fround(random() * 3000)]));
  // AvgPhysicsTime: spread, or such that AvgPhysicsTime*speed*1.4 is near
  // the goal's distance.
  const distance = Math.hypot(steerGoal[0] - at[0], steerGoal[1] - at[1], physics === 1 ? 0 : steerGoal[2] - at[2]);
  write(pawn, 'AvgPhysicsTime', speed && chance(0.5)
    ? Math.fround(distance / (speed * 1.4) * (1 + pick([0, 1e-6, -1e-6, 0.01, -0.01])))
    : pick([0, 0.016, 0.05, 0.4]));
  // MeleeRange: spread, or at the melee bound for a Pawn target.
  const meleeBound = moveTarget && isA(moveTarget, 'engine.pawn')
    ? (distance - read(moveTarget, 'CollisionRadius') - cr) / 0.8 : null;
  write(pawn, 'MeleeRange', meleeBound !== null && chance(0.6)
    ? Math.fround(meleeBound * (1 + pick([0, 1e-6, -1e-6]))) : pick([0, 40, 80]));
  write(pawn, 'LatentFloat', chance(0.05) ? edge() : pick([2.5, 0.01, 0.5, -1, 0, Math.fround(delta), Math.fround(delta / 2)]));
  write(pawn, 'bCanStrafe', chance(0.3));
  write(pawn, 'bReducedSpeed', chance(0.4));
  write(pawn, 'bAdvancedTactics', chance(0.1));
  write(pawn, 'bCanGlide', chance(0.35));
  write(pawn, 'MoveTarget', moveTarget);
  write(pawn, 'FaceTarget', faceTarget);
  const before = touched.map(a => [a, image(a), refsOf(a)]);

  // Rust.
  const rust = x.vm_loco_poll(handleOf(pawn), index, delta);
  const afterRust = touched.map(a => image(a));
  for (const [a, bytes, refs] of before) restore(a, bytes, refs);

  // JavaScript, with events recorded.
  const state = {latent: index}, events = [];
  const processEvent = runtime.processEvent;
  runtime.processEvent = (actor, name, args) => { events.push(name); return processEvent.call(runtime, actor, name, args); };
  let error = null;
  try { runtime.services.pollLatent({index, receiver: pawn, state, seconds: delta}); }
  catch (e) { error = String(e?.message ?? e).split('\n')[0]; }
  finally { delete runtime.processEvent; }
  const afterJs = touched.map(a => image(a));
  for (const [a, bytes, refs] of saved) restore(a, bytes, refs);

  const what = `case ${n}: ${pawn.name} poll ${index} delta ${delta} MoveTarget ${moveTarget?.name ?? 'None'} FaceTarget ${faceTarget?.name ?? 'None'}`;
  if (rust === -1) {
    count(`${index} JavaScript`);
    before.forEach(([a, bytes], i) => assert.ok(Buffer.compare(Buffer.from(bytes), Buffer.from(afterRust[i])) === 0,
      `${what}: handed back after writing ${a.name}`));
    continue;
  }
  count(`${index} ${rust ? 'done' : 'wait'}`);
  assert.equal(error, null, `${what}: Rust completed where JavaScript threw ${error}`);
  assert.deepEqual(events, [], `${what}: Rust completed where JavaScript called ${events}`);
  assert.equal(rust === 1, state.latent === 0, `${what}: Rust ${rust ? 'cleared' : 'kept'} the latent action, JavaScript ${state.latent}`);
  touched.forEach((a, i) => {
    const r = afterRust[i], j = afterJs[i];
    for (let k = 0; k < r.length; k++)
      if (r[k] !== j[k]) assert.fail(`${what}: ${a.name} image byte +0x${k.toString(16)} Rust ${r[k]} JavaScript ${j[k]}`);
  });
}
const summary = [...outcomes].sort().map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`validate-locomotion-kernel: ${CASES} cases identical (${summary})`);
