/** Play integration of PHYS_Swimming and swimming navigation on UNATCO Island
 * (docs/swimming.md, docs/script-pawn-nav.md "Swimming contract").
 *
 * UNATCO Island reaches Physics=3 through PawnGenerator.GeneratePawn: the
 * fish generators' GeneratorScouts get Scout.SetPhysics(Fish.Default.Physics
 * = PHYS_Swimming) and then Scout.AIPickRandomDestination (native 709) in the
 * same call, whose band search runs APawn::swimMove (0x103c3ca0) in the water
 * zone. Three child processes, one at a time, each boot the map through Play's
 * createGame and tick at 60 Hz with the original Actor.Tick scheduler:
 *
 *  - unmodified: original Play, no bypass, with bench-sim's workload (the
 *    forward key held from the first tick; idle, the fish generators never
 *    call GeneratePawn within 30 s). Every scout AIPickRandomDestination
 *    completes through the original swimMove and finds a destination, the
 *    fish generators spawn their fish, and scouts and fish run physSwimming.
 *    The run ends at the first runtime boundary, which is no longer swimming
 *    navigation: PaulDenton0's GetNextWaypoint asks actorReachable (native
 *    520), whose walkReach needs the unported jumpArc (0x103c2f50).
 *  - exit and entry: original Play, no bypass, idle, with fixture setup at
 *    tick 20 (setup only). exit: GeneratorScout4 (no AI; its generator stays
 *    inactive while idle) placed in open water with Mass 100 / Buoyancy 150 /
 *    DesiredSpeed 1 rises, leaves the water through Swim's findWaterLine on the
 *    real BSP, is set to PHYS_Falling by physSwimming and falls back in, where
 *    physFalling's untranslated water-zone integration (0x103d125a) stops it.
 *    entry: Terrorist0 placed above the water falls in; the original
 *    ScriptedPawn.ZoneChange sets PHYS_Swimming inside MoveActor and
 *    physFalling hands off to startSwimming. The run ends at the next runtime
 *    boundary (the fixture moved the NPC away from its HomeLoc).
 *
 * The swimming bodies are bit-exact against Engine.dll in
 * validate-native-swimming and validate-pawn-swimming-reach; this checks that
 * Play reaches them. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const part = process.argv[2];
if (!part) {
  const results = {};
  for (const name of ['unmodified', 'exit', 'entry']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(`${name} part failed (${child.status}): ${child.stderr.split('\n').filter(l => !/Deprecation|trace-deprecation/.test(l)).slice(-12).join('\n')}`);
    results[name] = JSON.parse(child.stdout.trim().split('\n').at(-1));
  }
  const { unmodified, exit: water, entry: dive } = results;
  // 1. Unmodified Play: the scouts' band searches complete through the
  // original swimMove; swimming navigation is no longer a boundary.
  for (const scout of unmodified.scouts) {
    assert.equal(scout.physics, 3, `${scout.name} swims`);
    assert.ok(scout.picks.calls > 0 && scout.picks.found === scout.picks.calls,
      `${scout.name}: every AIPickRandomDestination found a destination (${scout.picks.found}/${scout.picks.calls})`);
    assert.ok(scout.swimCalls > 150, `${scout.name} ran physSwimming every tick (${scout.swimCalls})`);
    assert.deepEqual(scout.velocity, [0, 0, 0], `${scout.name}: NaN lift and zero DesiredSpeed hold the original scout still`);
  }
  assert.ok(unmodified.generators.filter(g => /0$/.test(g.name)).every(g => g.pawnCount > 0),
    'both water generators near the player spawned fish');
  assert.ok(unmodified.fishSwimCalls > 0, 'the spawned fish run physSwimming');
  // 2. The first runtime boundary without any bypass.
  assert.ok(unmodified.firstError.tick > 1000, `no boundary in the bench window (${unmodified.firstError.tick})`);
  assert.match(unmodified.firstError.message, /jumpArc service \(0x103c2f50\)/);
  const { index, receiver, function: caller } = unmodified.firstError.lastNavNative;
  assert.deepEqual({ index, receiver, caller }, { index: 520, receiver: 'PaulDenton0', caller: 'GetNextWaypoint' });
  // 3. Real water: exit through findWaterLine/setPhysics(Falling), and entry
  // through ScriptedPawn.ZoneChange and the physFalling hand-off.
  const exit = water.exit;
  assert.ok(exit.swimTicks > 20 && exit.exitTick > 0, 'the buoyant scout swam up to the surface');
  assert.equal(exit.exitRegionWater, false, 'Swim left the pawn at the water line outside the water zone');
  assert.ok(exit.exitZ > exit.surfaceZ - exit.height, 'the exit is at the water surface');
  assert.ok(exit.fellBackIn, 'PHYS_Falling returned the pawn into the water');
  assert.match(water.firstError?.message ?? '', /physFalling water-zone integration/, 'falling in water stops at the explicit boundary');
  const entry = dive.entry;
  assert.ok(entry.startSwimming >= 1, 'physFalling handed off to startSwimming');
  assert.equal(entry.physics, 3);
  assert.equal(entry.regionWater, true);
  const summary = {
    unmodified: { firstBoundary: unmodified.firstError, seconds: +(unmodified.firstError.tick / 60).toFixed(3),
      scouts: unmodified.scouts, generators: unmodified.generators, fishSwimCalls: unmodified.fishSwimCalls,
      player: unmodified.player },
    exit: { ...exit, firstError: water.firstError }, entry: { ...entry, nextBoundary: dive.firstError },
    scope: 'Island Play reaches physSwimming/startSwimming/Swim/findWaterLine through Actor.Tick; first boundaries reported' };
  console.log(JSON.stringify(summary, null, 1));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// A child part. Deterministic simulated clock, as bench-sim.
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
const { pawnPhysicsView } = await import('../src/runtime/script-pawn-physics.mjs');
const { gameDirectory } = await import('./game-directory.mjs');

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('01_NYC_UNATCOIsland');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const runtime = game.doors.scriptRuntime.runtime;
const level = runtime.levelFor(game.player.collisionActor);
const read = (actor, name) => runtime.readNamed(actor, name);
const actor = name => level.actors.find(a => a?.name === name);
const zoneOf = a => read(a, 'Region')['engine.actor.pointregion.zone'];
const regionWater = a => Boolean(read(zoneOf(a), 'bWaterZone'));

// Count the pawn physics entries each view actually takes (performPhysics's
// case 3 is view.swimming; the walking/falling hand-offs call startSwimming).
const calls = new Map();
const count = (name, kind) => calls.set(`${name}.${kind}`, (calls.get(`${name}.${kind}`) ?? 0) + 1);
const wrapViews = () => {
  for (const a of level.actors) {
    const view = a?._pawnPhysics;
    if (!view || view.__counted) continue;
    Object.defineProperty(view, '__counted', { value: true });
    for (const kind of ['swimming', 'startSwimming']) {
      const original = view[kind];
      view[kind] = (...args) => { count(a.name, kind); return original(...args); };
    }
  }
};
// The navigation natives' script context (receiver and calling function) and
// each receiver's AIPickRandomDestination verdicts.
const picks = {};
let lastNative = null;
const invokeNative = runtime.invokeNative.bind(runtime);
runtime.invokeNative = call => {
  const native = { index: call.index, receiver: call.receiver?.name ?? null, function: call.script?.name ?? null };
  if (call.index === 520 || call.index === 521) {
    const node = runtime.instance(call.receiver)?.state?.stateNode;
    native.state = node?.record?.name ?? node?.name ?? null;
    try { native.orders = read(call.receiver, 'Orders'); native.orderTag = read(call.receiver, 'OrderTag'); } catch { /* not a ScriptedPawn */ }
  }
  if ([517, 518, 520, 521, 525, 526, 708, 709].includes(call.index)) lastNative = native;
  const result = invokeNative(call);
  if (call.index === 709) {
    const p = picks[native.receiver] ??= { calls: 0, found: 0 };
    p.calls++; if (result) p.found++;
  }
  return result;
};
let tick = 0, firstError = null;
const step = () => {
  wrapViews();
  simulatedMs += 1000 / 60; tick++;
  lastNative = null;
  try { game.tick(1 / 60); }
  catch (error) {
    // lastNavNative: the last navigation native entered in the failing tick.
    firstError ??= { tick, message: String(error?.message ?? error).split('\n')[0], lastNavNative: lastNative };
  }
};
const scoutNames = ['GeneratorScout4', 'GeneratorScout5'];
const scoutState = () => scoutNames.map(name => ({ name, physics: read(actor(name), 'Physics'), velocity: read(actor(name), 'Velocity'),
  swimCalls: calls.get(`${name}.swimming`) ?? 0, picks: picks[name] ?? { calls: 0, found: 0 } }));

if (part === 'unmodified') {
  // bench-sim's workload: the forward key held through the installed bindings.
  // Idle, the fish generators stay inactive and no scout is set to swim.
  const { createPlayerInputFixture } = await import('./player-input-fixture.mjs');
  createPlayerInputFixture(game).key('KeyW', true);
}
const generators = () => level.actors.filter(a => /^Fish2?Generator[01]$/.test(a?.name ?? '')).map(a => ({ name: a.name,
  active: read(a, 'bActive'), pawnCount: read(a, 'PawnCount'), scout: read(a, 'Scout')?.name ?? null }));
if (part === 'unmodified') {
  while (!firstError && tick < Number(process.env.ISLAND_TICKS ?? 1400)) step();
  const fishSwimCalls = [...calls].filter(([k]) => /^Fish2?\d+\.swimming$/.test(k)).reduce((s, [, n]) => s + n, 0);
  console.log(JSON.stringify({ firstError, scouts: scoutState(), fishSwimCalls, generators: generators(),
    player: read(game.player.collisionActor, 'Location').map(Math.round) }));
} else if (part === 'exit') {
  for (let i = 0; i < 20; i++) step();
  assert.equal(firstError, null);
  // WaterZone1 surface above the open-water fixture point.
  const water = p => Boolean(read(level.pointRegion(p.map(Math.fround)).zone, 'bWaterZone'));
  let surfaceZ = null;
  for (let z = -800; z < 0; z++) if (water([-3000, 7500, z]) && !water([-3000, 7500, z + 1])) surfaceZ = z;
  // (1) Exit: a buoyant GeneratorScout4 in open water. The fish generator only
  // drives its scout from its first GeneratePawn (tick 153).
  const scout = actor('GeneratorScout4');
  const view = pawnPhysicsView(scout, runtime.pawnPhysicsServices(scout));
  for (const [name, value] of [['Mass', 100], ['Buoyancy', 150], ['DesiredSpeed', 1], ['bCollideWorld', true]]) runtime.writeNamed(scout, name, value);
  assert.ok(view.farMove([-3000, 7500, -420], 0, 1), 'fixture placement');
  view.velocity = [0, 0, 0];
  view.setPhysics(3);
  const exit = { surfaceZ, height: read(scout, 'CollisionHeight'), swimTicks: 0, exitTick: 0, exitZ: null, exitRegionWater: null, fellBackIn: false };
  while (!firstError && tick < 110) {
    step();
    const physics = read(scout, 'Physics');
    if (physics === 3) exit.swimTicks++;
    else if (!exit.exitTick && physics === 2) {
      exit.exitTick = tick; exit.exitZ = read(scout, 'Location')[2]; exit.exitRegionWater = regionWater(scout);
    } else if (exit.exitTick && physics === 2 && regionWater(scout)) { exit.fellBackIn = true; break; }
  }
  exit.physSwimmingCalls = calls.get('GeneratorScout4.swimming') ?? 0;
  // Back in the water in PHYS_Falling (a plain Pawn has no ZoneChange that
  // selects swimming), the next physFalling substep stops at the untranslated
  // water-zone integration.
  const reentry = tick;
  while (!firstError && tick < reentry + 5) step();
  console.log(JSON.stringify({ exit, firstError }));
} else if (part === 'entry') {
  for (let i = 0; i < 20; i++) step();
  assert.equal(firstError, null);
  // (2) Entry: Terrorist0 above the water at the WaterZone1 actor. Placed this
  // early its Standing state still has bStasis clear, so Actor.Tick runs it.
  const npc = actor('Terrorist0');
  const npcView = pawnPhysicsView(npc, runtime.pawnPhysicsServices(npc));
  assert.ok(npcView.farMove([-2802, 6641, -300], 0, 1), 'fixture placement');
  npcView.velocity = [0, 0, 0];
  npcView.setPhysics(2);
  const startTick = tick;
  while (!firstError && tick < startTick + 60) step();
  const entry = { startSwimming: calls.get('Terrorist0.startSwimming') ?? 0, physics: read(npc, 'Physics'), regionWater: regionWater(npc),
    z: read(npc, 'Location')[2], ticks: tick - startTick };
  console.log(JSON.stringify({ entry, firstError }));
} else throw new Error(`Unknown part ${part}`);
process.exit(0);
