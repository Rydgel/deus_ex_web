/**
 * Native 722 Actor.ParabolicTrace through the UnrealScript callers on Liberty Island
 * (docs/parabolic-trace.md "In Play"), then the original Engine.dll on the same
 * level answers.
 *
 *  A. ScriptedPawn.GetProjectileList (9 arguments): Terrorist22 in state AvoidingProjectiles
 *     with a LAM (PHYS_Falling, bBounce) spawned beside it; the state's PickDestination
 *     calls GetProjectileList, which calls ParabolicTrace for the falling grenade.
 *  B. ScriptedPawn.AISafeToThrow (10 arguments): the same pawn holding a spawned WeaponLAM,
 *     called by name for several targets and throw accuracies; each call computes both
 *     throw angles and calls ParabolicTrace twice. The AI's own decision to throw (its
 *     Attacking state choosing a thrown weapon) is not driven here.
 *
 * Every native-722 call is recorded with the receiver's fields, the evaluated arguments,
 * the returned time and out location, and every PointRegion and MultiLineCheck answer
 * the translation consumed from the live level. scripts/native-parabolic-trace-oracle.py
 * then runs the original exec and worker (0x1036e190, 0x1036c0a0) in Unicorn over those
 * recorded answers (`replay`), failing on any divergence in the service calls the original
 * makes (arguments, order, count) and on any difference in the result or finalLocation.
 *
 *   NATIVE_PROBE_PYTHON=.cache/native-probe-env/bin/python node scripts/validate-parabolic-trace-play.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', { value: () => simulatedMs, configurable: true });

const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createGame } = await import('../src/viewer/game.mjs');
const { f32bits, refValue } = await import('../src/runtime/script-vm.mjs');
const { gameDirectory } = await import('./game-directory.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const W = f32bits;
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('01_NYC_UNATCOIsland');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const runtime = game.doors.scriptRuntime.runtime;
const read = (object, name) => runtime.readNamed(object, name);
const player = game.player.collisionActor;
const level = runtime.levelFor(player);
const step = () => { simulatedMs += 1000 / 60; game.tick(1 / 60); game.hud.commands(1440, 960, game.view()); };
for (let i = 0; i < 30; i++) step();

// ---- recording ---------------------------------------------------------------------------------------------------
const records = [];
let current = null, watched = null;
runtime.observeParabolicServices = (services, actor) => {
  const ids = new Map([[services.levelInfo, 0], [actor, 1]]);
  let next = 2;
  const idOf = a => { if (!ids.has(a)) ids.set(a, next++); return ids.get(a); };
  const describe = a => {
    const id = idOf(a);
    if (id >= 2 && !(id in current.actors)) {
      const owner = a.owner ?? null;
      current.actors[id] = { owner: null, blocks: services.blocksActors(a) };
      if (owner) current.actors[id].owner = describe(owner);
    }
    return id;
  };
  return {
    levelInfo: services.levelInfo,
    pointRegion(position) {
      const region = services.pointRegion(position), z = region.zone;
      current.log.push({ kind: 'region', position: [...position], leaf: region.leaf, zoneNumber: region.zoneNumber,
        zone: { gravity: [...z.gravity], velocity: [...z.velocity], terminal: z.terminalVelocity, water: z.water } });
      return region;
    },
    multiLineCheck(query) {
      const hits = services.multiLineCheck(query);
      current.log.push({ kind: 'mlc', end: [...query.end], start: [...query.start], extent: [...query.extent],
        check: query.checkActors ? 1 : 0, extra: query.extra,
        hits: hits.map(h => ({ actor: describe(h.actor), location: [...h.location], normal: [...h.normal], time: h.time, item: h.item, primitive: h.primitive })) });
      return hits;
    },
    isOwnedBy: services.isOwnedBy, blocksActors: services.blocksActors,
  };
};
const invokeNative = runtime.invokeNative.bind(runtime);
runtime.invokeNative = call => {
  if (call.index !== 722) return invokeNative(call);
  const actor = call.receiver, cache = {};
  let out = null;
  const evaluate = i => {
    if (i in cache) return cache[i];
    let value = call.evaluateArgument(i);
    if (i === 0) { const ref = value; value = { reference: true, get: () => ref.get(), set: v => { out = Array.from(v); ref.set(v); } }; }
    return (cache[i] = value);
  };
  let projectile = null;
  if (watched) { try { projectile = { location: read(watched, 'Location').map(W), velocity: read(watched, 'Velocity').map(W) }; } catch { /* destroyed */ } }
  const state = { location: read(actor, 'Location').map(W), velocity: read(actor, 'Velocity').map(W), radius: W(read(actor, 'CollisionRadius')),
    height: W(read(actor, 'CollisionHeight')), collide: read(actor, 'bCollideActors') ? 1 : 0, bounce: read(actor, 'bBounce') ? 1 : 0 };
  current = { log: [], actors: {} };
  const t0 = process.hrtime.bigint();
  const result = invokeNative({ ...call, evaluateArgument: evaluate });
  const micros = Number((process.hrtime.bigint() - t0) / 1000n);
  const params = [];
  for (let i = 0; i < 10; i++) {
    const value = i < call.argumentCount ? refValue(cache[i]) : undefined;
    if (i === 0) params.push({ out: true, words: [0, 0, 0] });
    else if (value === undefined || value === null) params.push({ skip: true });
    else if (Array.isArray(value)) params.push({ words: value.map(W) });
    else if (typeof value === 'boolean' || i === 3 || i === 7) params.push({ words: [value ? 1 : 0] });
    else params.push({ words: [W(value)] });
  }
  records.push({ argc: call.argumentCount, receiver: actor.name, state, projectile, params, result: W(result), time: result, out: out.map(W), outNumbers: out,
    log: current.log, actors: current.actors, micros });
  current = null;
  return result;
};

// ---- A. GetProjectileList through AvoidingProjectiles -----------------------------------------------------------
const deusEx = await assets.get('DeusEx');
const classOf = name => runtime.loadClass(deusEx, deusEx.exportsByPath.get(name));
const pawn = level.actors.find(a => a?.name === 'Terrorist22');
const loc = read(pawn, 'Location');
runtime.farMoveActor(player, [loc[0] + 250, loc[1], loc[2] + 10], 0, 1);
for (let i = 0; i < 30; i++) step();
const lamClass = await classOf('lam');
const lam = runtime.spawnActor({ cls: lamClass.record, level, name: 'None', owner: null, instigator: player, location: [loc[0] + 120, loc[1] + 40, loc[2] + 200], rotation: [0, 0, 0] });
assert.ok(lam, 'SpawnActor admitted a LAM');
assert.equal(read(lam, 'Physics'), 2, 'the LAM falls (PHYS_Falling)');
assert.equal(read(lam, 'bBounce'), true);
const lamElasticity = read(lam, 'Elasticity');
const stateOf = p => runtime.instance(p).state?.stateNode?.record.name ?? '-';
const before = records.length;
runtime.gotoState(pawn, 'AvoidingProjectiles', 'None');
let error = null;
watched = lam;
for (let i = 0; i < 160 && !error; i++) {
  try { step(); }
  catch (e) { error = `${i}: ${String(e?.message ?? e).split('\n')[0]}`; }
}
watched = null;
assert.equal(error, null, 'no runtime error while the pawn avoids the grenade');
const projectileList = records.slice(before);
assert.ok(projectileList.length >= 1, 'GetProjectileList called ParabolicTrace');
for (const r of projectileList) {
  assert.equal(r.receiver, 'Terrorist22');
  assert.equal(r.argc, 9, 'GetProjectileList passes nine arguments (no granularity)');
  assert.deepEqual(r.params[8].words, [W(60)], 'landingSpeed 60');
  assert.deepEqual(r.params[5].words, [W(2)], 'maxTime 2');
  assert.deepEqual(r.params[6].words, [W(lamElasticity)], 'the LAM\'s Elasticity');
  assert.deepEqual(r.params[7].words, [1], 'the LAM\'s bBounce');
  assert.deepEqual(r.params[3].words, [1], 'bCheckActors true');
  assert.ok(r.params[9].skip, 'granularity omitted: the exec\'s 0.025 default');
  // The velocity and location are the grenade's at that tick.
  assert.deepEqual([r.params[2].words, r.params[1].words], [r.projectile.location, r.projectile.velocity],
    'startLocation and startVelocity are the falling LAM\'s Location and Velocity');
}

// ---- B. AISafeToThrow by name ------------------------------------------------------------------------------------
runtime.gotoState(pawn, 'Standing', 'None');
for (let i = 0; i < 10; i++) step();
const weaponClass = await classOf('weaponlam');
const weapon = runtime.spawnActor({ cls: weaponClass.record, level, name: 'None', owner: pawn, instigator: null, location: read(pawn, 'Location'), rotation: [0, 0, 0] });
assert.equal(read(weapon, 'ProjectileClass')?.name, 'LAM');
runtime.writeNamed(pawn, 'Weapon', weapon);
const here3 = read(pawn, 'Location');
const throwStart = [here3[0], here3[1], here3[2] + 30];
const playerAt = read(player, 'Location');
const targets = [playerAt, [here3[0] + 300, here3[1], here3[2] - 40], [here3[0] - 150, here3[1] + 220, here3[2] - 40], [here3[0] + 900, here3[1] - 200, here3[2] - 60], [here3[0] + 40, here3[1], here3[2] - 40]];
const beforeThrow = records.length;
const verdicts = [];
for (const target of targets) {
  for (const accuracy of [0.025, 0.01, 0.1]) {
    const result = { value: undefined };
    runtime.processEvent(pawn, 'AISafeToThrow', [target.slice(), throwStart.slice(), accuracy, [0, 0, 0]], { reference: true, get: () => result.value, set: v => { result.value = v; } });
    verdicts.push(result.value);
  }
}
const throws = records.slice(beforeThrow);
assert.ok(throws.length >= 2 && throws.length % 2 === 0, 'AISafeToThrow calls ParabolicTrace for both throw angles');
for (const r of throws) {
  assert.equal(r.argc, 10);
  assert.deepEqual(r.params[5].words, [W(5)], 'maxTime 5');
  assert.deepEqual(r.params[8].words, [W(60)], 'landingSpeed 60');
  assert.ok([0.025, 0.01, 0.1].some(a => r.params[9].words[0] === W(a)), 'throwAccuracy passed as granularity');
  assert.deepEqual(r.params[3].words, [1]);
}

// ---- the original on the recorded answers ------------------------------------------------------------------------
const cases = records.map((r, index) => ({ id: `play-${index}`, mode: 'exec', actor: r.state, params: r.params, outRef: true,
  scene: { replay: r.log, replayActors: r.actors } }));
const python = process.env.NATIVE_PROBE_PYTHON ?? process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const oracle = JSON.parse(execFileSync(python, [path.join(here, 'native-parabolic-trace-oracle.py'), root],
  { input: JSON.stringify({ cases }), encoding: 'utf8', maxBuffer: 1 << 30 }));
let landed = 0, services = 0;
oracle.results.forEach((expected, index) => {
  const r = records[index];
  assert.equal(expected.status, 'ok', `${expected.id}: the original ran on the recorded answers (${expected.reason})`);
  assert.equal(expected.replayLeft, 0, `${expected.id}: the original consumed every recorded service call`);
  assert.equal(expected.result, r.result, `${expected.id}: time 0x${expected.result.toString(16)} (original) != 0x${r.result.toString(16)} (Play)`);
  assert.deepEqual(expected.out, r.out, `${expected.id}: finalLocation`);
  if (r.time > 0) landed++;
  services += r.log.length;
});
const meanMicros = Math.round(records.reduce((n, r) => n + r.micros, 0) / records.length);
console.log(JSON.stringify({ ok: true, calls: records.length, getProjectileList: projectileList.length, aiSafeToThrow: throws.length,
  aiSafeToThrowVerdicts: verdicts, returnedATime: landed, recordedServiceCalls: services, meanMicrosPerCall: meanMicros,
  examples: records.slice(0, 3).map(r => ({ argc: r.argc, time: r.time, final: r.outNumbers })) }));
process.exit(0);
