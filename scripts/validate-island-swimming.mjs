/** Play integration of PHYS_Swimming on UNATCO Island (docs/swimming.md).
 *
 * UNATCO Island reaches Physics=3 through PawnGenerator.GeneratePawn: the
 * fish generators' GeneratorScouts get Scout.SetPhysics(Fish.Default.Physics
 * = PHYS_Swimming) and then Scout.AIPickRandomDestination (native 709) in the
 * same call. Three child processes, one at a time, each boot the map through
 * Play's createGame and tick at 60 Hz with the original Actor.Tick scheduler:
 *
 *  - unmodified: original Play, no bypass, with bench-sim's workload (the
 *    forward key held from the first tick; idle, the fish generators never
 *    call GeneratePawn within 30 s). It runs to the first runtime
 *    boundary, which is aiPickSearch's waterMove (0x103c3ca0) inside that
 *    GeneratePawn call, one statement after the scouts were set to swim; no
 *    swimming boundary is reached.
 *  - scouts: bench-sim's waterMove and native 708 early returns only (NOT
 *    original behavior; they stand in for the unported upstream services) and
 *    no physics patch. The scouts then run APawn::performPhysics case 3 into
 *    physSwimming every tick. Their Mass 0 / Buoyancy 0 / DesiredSpeed 0
 *    defaults make calcVelocity's lift NaN and the speed clamp zero, so they
 *    hold still (the Mass 0 cases of validate-native-swimming).
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
 * validate-native-swimming; this checks that Play reaches them. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { register } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const part = process.argv[2];
if (!part) {
  const results = {};
  for (const name of ['unmodified', 'scouts', 'exit', 'entry']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(`${name} part failed (${child.status}): ${child.stderr.split('\n').filter(l => !/Deprecation|trace-deprecation/.test(l)).slice(-12).join('\n')}`);
    results[name] = JSON.parse(child.stdout.trim().split('\n').at(-1));
  }
  const { unmodified, scouts, exit: water, entry: dive } = results;
  // 1. Unmodified Play: the first boundary is waterMove, in the tick where the
  // scouts were set to PHYS_Swimming; swimming is not what stops Play.
  assert.match(unmodified.firstError.message, /waterMove service \(0x103c3ca0\)/);
  assert.ok(unmodified.scouts.some(s => s.physics === 3), 'GeneratePawn set a fish scout to PHYS_Swimming before AIPickRandomDestination');
  assert.equal(unmodified.swimCalls, 0, 'no swimming physics ran before the waterMove boundary');
  // 2. Scouts with the upstream nav stand-ins: case 3 runs physSwimming, no error.
  assert.deepEqual(scouts.errors, {}, 'no runtime error with only the waterMove/708 stand-ins');
  for (const scout of scouts.scouts) {
    assert.equal(scout.physics, 3);
    assert.ok(scout.swimCalls > 150, `${scout.name} ran physSwimming every tick (${scout.swimCalls})`);
    assert.deepEqual(scout.velocity, [0, 0, 0], `${scout.name}: NaN lift and zero DesiredSpeed hold the original scout still`);
  }
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
    unmodified: { firstBoundary: unmodified.firstError.message, tick: unmodified.firstError.tick,
      seconds: +(unmodified.firstError.tick / 60).toFixed(3), scoutsSetToSwim: unmodified.scouts.filter(s => s.physics === 3).map(s => s.name),
      player: unmodified.player, generators: unmodified.generators },
    scouts: { ticks: scouts.ticks, swimCalls: Object.fromEntries(scouts.scouts.map(s => [s.name, s.swimCalls])), bypassHits: scouts.bypassHits,
      firstError: scouts.firstError },
    exit: { ...exit, firstError: water.firstError }, entry: { ...entry, nextBoundary: dive.firstError },
    scope: 'Island Play reaches physSwimming/startSwimming/Swim/findWaterLine through Actor.Tick; first boundaries reported' };
  console.log(JSON.stringify(summary, null, 1));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// A child part. The scouts part installs only the waterMove/708 stand-ins.
if (part === 'scouts') {
  const hooks = new URL('./bench-sim-hooks.mjs', import.meta.url).href;
  const source = `import { BYPASS_PATCHES } from ${JSON.stringify(hooks)};
const from = re => BYPASS_PATCHES.find(([pattern]) => String(pattern) === String(re))[1];
const PATCHES = [
  [/\\/src\\/runtime\\/script-pawn-nav\\.mjs$/, from(/\\/src\\/runtime\\/script-pawn-nav\\.mjs$/),
    "{globalThis.__bypassHit?.('waterMove 0x103c3ca0');return 0;}"],
  [/\\/src\\/runtime\\/script-doors\\.mjs$/, from(/\\/src\\/runtime\\/script-doors\\.mjs$/),
    "if(call.index===708){globalThis.__bypassHit?.('native 708');return false;}throw new Error(\`Unsupported original door native \${call.index} in \${path}\`);"],
];
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const patch = PATCHES.find(([pattern]) => pattern.test(new URL(url).pathname));
  if (!patch) return result;
  const text = String(result.source);
  if (!text.includes(patch[1])) throw new Error('island swimming stand-in no longer matches ' + url);
  return { ...result, source: text.replace(patch[1], patch[2]) };
}`;
  register(`data:text/javascript,${encodeURIComponent(source)}`, import.meta.url);
}
const bypassHits = {};
globalThis.__bypassHit = name => { bypassHits[name] = (bypassHits[name] ?? 0) + 1; };

// Deterministic simulated clock, as bench-sim.
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
let tick = 0, firstError = null;
const errors = {};
const step = () => {
  wrapViews();
  simulatedMs += 1000 / 60; tick++;
  try { game.tick(1 / 60); }
  catch (error) {
    const message = String(error?.message ?? error).split('\n')[0];
    firstError ??= { tick, message };
    errors[message] = (errors[message] ?? 0) + 1;
  }
};
const scoutNames = ['GeneratorScout4', 'GeneratorScout5'];
const scoutState = () => scoutNames.map(name => ({ name, physics: read(actor(name), 'Physics'), velocity: read(actor(name), 'Velocity'),
  swimCalls: calls.get(`${name}.swimming`) ?? 0 }));

if (part === 'unmodified' || part === 'scouts') {
  // bench-sim's workload: the forward key held through the installed bindings.
  // Idle, the fish generators stay inactive and no scout is set to swim.
  const { createPlayerInputFixture } = await import('./player-input-fixture.mjs');
  createPlayerInputFixture(game).key('KeyW', true);
}
const generators = () => level.actors.filter(a => /^Fish2?Generator[01]$/.test(a?.name ?? '')).map(a => ({ name: a.name,
  active: read(a, 'bActive'), triggered: read(a, 'bTriggered'), tag: read(a, 'Tag'),
  triggers: level.actors.filter(t => t && t !== a && (() => { try { return read(t, 'Event') === read(a, 'Tag') && read(a, 'Tag') !== 'None'; } catch { return false; } })()).map(t => t.name) }));
if (part === 'unmodified') {
  while (!firstError && tick < Number(process.env.ISLAND_TICKS ?? 400)) step();
  const swimCalls = [...calls].filter(([k]) => k.endsWith('.swimming') || k.endsWith('.startSwimming')).reduce((s, [, n]) => s + n, 0);
  console.log(JSON.stringify({ firstError, scouts: scoutState(), swimCalls, generators: generators(),
    player: read(game.player.collisionActor, 'Location').map(Math.round) }));
} else if (part === 'scouts') {
  while (tick < 400) step();
  console.log(JSON.stringify({ ticks: tick, errors, firstError, bypassHits, scouts: scoutState() }));
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
