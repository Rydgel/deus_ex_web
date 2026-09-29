/** Play integration of physFalling's water-zone integration on UNATCO Island
 * (docs/swimming.md "physFalling water paths" and "Decorations in water").
 *
 * Five breakable crates (CrateBreakableMedGeneral1, 2, 5, 8 and
 * CrateBreakableMedCombat13) start in WaterZone1 in PHYS_Falling with Mass 50
 * and Buoyancy 60 or 90. Until 2026-09-30 their field-backed non-Pawn falling
 * host did not expose Region.Zone's bWaterZone and they integrated dry: 1 and
 * 2 sank to the bottom and 5, 8 and 13 landed at once. Now physFalling takes
 * the original water integration (0x103d125a, bit-exact in
 * validate-native-falling), and the original DeusExDecoration/Decoration
 * ZoneChange and Tick bytecode runs through Play's dispatch when a crate
 * crosses the water surface.
 *
 * One child process per part boots the map through Play's createGame and ticks
 * at 60 Hz with the original Actor.Tick scheduler and no bypass:
 *  - idle: 600 ticks with no input. The first tick of each crate is compared
 *    with Engine.dll's physFalling run by scripts/native-falling-oracle.py on
 *    the same inputs (Location, Velocity, Mass, Buoyancy, Region.Zone fields,
 *    DeltaTime; the move is unobstructed in both), so Play is shown to reach
 *    the oracle-validated body with the live values. The rest records what the
 *    crates then do under original physics and script.
 *  - bench: bench-sim's workload (the forward key held from the first tick)
 *    for 360 ticks; the crates behave the same and no runtime boundary is
 *    reached.
 *
 * Requires NATIVE_PROBE_PYTHON (the Unicorn oracle environment). */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const CRATES = ['CrateBreakableMedGeneral1', 'CrateBreakableMedGeneral2', 'CrateBreakableMedGeneral5',
  'CrateBreakableMedGeneral8', 'CrateBreakableMedCombat13'];
const f = Math.fround;
const part = process.argv[2];
if (!part) {
  const results = {};
  for (const name of ['idle', 'bench']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(`${name} part failed (${child.status}): ${child.stderr.split('\n').filter(l => !/Deprecation|trace-deprecation/.test(l)).slice(-12).join('\n')}`);
    results[name] = JSON.parse(child.stdout.trim().split('\n').at(-1));
  }
  const { idle, bench } = results;
  // 1. Initial state, from the map and class defaults.
  for (const c of idle.initial) {
    assert.equal(c.physics, 2, `${c.name} starts falling`);
    assert.equal(c.zone, 'WaterZone1', `${c.name} starts in WaterZone1`);
    assert.equal(c.zoneWater, true);
    assert.equal(c.mass, 50);
    assert.ok(c.buoyancy > c.mass, `${c.name} is buoyant (${c.buoyancy} > ${c.mass})`);
    assert.deepEqual([c.bFloating, c.bBobbing, c.bSplash], [false, false, false]);
  }
  // 2. Tick 1 equals Engine.dll's physFalling on the same inputs.
  const oracle = await nativeFirstTick(idle.firstTick);
  for (const [i, c] of idle.firstTick.entries()) {
    assert.deepEqual(c.after.location, oracle[i].position, `${c.name}: tick-1 Location equals the original physFalling`);
    assert.deepEqual(c.after.velocity, oracle[i].velocity, `${c.name}: tick-1 Velocity equals the original physFalling`);
    assert.ok(c.after.velocity[2] > 0, `${c.name}: buoyancy lifts it`);
  }
  // 3. The crates under the dock (5, 8, 13) rise until the BSP above them
  // stops them, and stay pinned there in PHYS_Falling inside the water zone.
  for (const run of [idle, bench]) for (const c of run.crates.filter(c => !/General[12]$/.test(c.name))) {
    assert.ok(c.maxRise > 5, `${c.name} rose ${c.maxRise}`);
    assert.equal(c.zoneChanges.length, 0, `${c.name} stays in WaterZone1`);
    assert.equal(c.final.physics, 2);
    assert.deepEqual(c.final.velocity, [0, 0, 0], `${c.name} is held by the geometry above it`);
    assert.ok(c.pinnedFrom > 0 && c.pinnedFrom < 60, `${c.name} pinned from tick ${c.pinnedFrom}`);
  }
  // 4. Crates 1 and 2 surface: leaving the water waterlogs Buoyancy
  // (Decoration.ZoneChange, 0.95 then 0.99), re-entering sets bSplash and
  // DeusExDecoration's bFloating, whose Tick rocks the rotation.
  for (const run of [idle, bench]) for (const c of run.crates.filter(c => /General[12]$/.test(c.name))) {
    const exits = c.zoneChanges.filter(z => z.to !== 'WaterZone1'), entries = c.zoneChanges.filter(z => z.to === 'WaterZone1');
    assert.ok(exits.length >= 2 && entries.length >= 2, `${c.name} crossed the surface (${exits.length} exits, ${entries.length} entries)`);
    assert.equal(exits[0].buoyancyAfter, f(f(.95) * 60), `${c.name}: the first exit waterlogs Buoyancy by 0.95`);
    assert.ok(exits.every(z => z.buoyancyAfter <= z.buoyancyBefore), 'waterlogging only lowers Buoyancy');
    assert.equal(entries[0].bFloatingAfter, true, `${c.name}: re-entry sets bFloating`);
    assert.equal(entries[0].bSplashAfter, true);
    assert.ok(c.rotations > 1, `${c.name}: DeusExDecoration.Tick rocks a floating crate`);
    assert.ok(c.final.location[2] > c.initial.location[2], `${c.name} floats above its start`);
  }
  assert.equal(idle.firstError, null, `idle: no runtime boundary in ${idle.ticks} ticks (${idle.firstError?.tick}: ${idle.firstError?.message})`);
  assert.equal(bench.firstError, null, `bench workload: no runtime boundary in ${bench.ticks} ticks (${bench.firstError?.tick}: ${bench.firstError?.message})`);
  const brief = run => run.crates.map(c => ({ name: c.name, maxRise: c.maxRise, pinnedFrom: c.pinnedFrom,
    final: { location: c.final.location, velocity: c.final.velocity, physics: c.final.physics, zone: c.final.zone },
    zoneChanges: c.zoneChanges.length, firstExit: c.zoneChanges.find(z => z.to !== 'WaterZone1')?.tick ?? null,
    firstEntry: c.zoneChanges.find(z => z.to === 'WaterZone1')?.tick ?? null, surfaceBand: c.surfaceBand,
    buoyancy: c.final.buoyancy, bFloating: c.final.bFloating }));
  console.log(JSON.stringify({ firstTick: idle.firstTick.map((c, i) => ({ name: c.name, velocity: c.after.velocity, original: oracle[i].velocity })),
    idle: { ticks: idle.ticks, firstError: idle.firstError, crates: brief(idle) },
    bench: { ticks: bench.ticks, firstError: bench.firstError, crates: brief(bench) },
    scope: 'Island Play crates take physFalling\'s water integration (tick 1 equals Engine.dll on the same inputs); later motion is original physics plus original ZoneChange/Tick bytecode in Play' }));
  process.exit(0);
}

/** Run the five tick-1 inputs through original physFalling (native-falling-oracle.py). */
async function nativeFirstTick(firstTick) {
  const clear = { time: 1, normal: [0, 0, 0] };
  const cases = firstTick.map(c => ({ position: c.before.location, velocity: c.before.velocity, acceleration: c.before.acceleration,
    dt: c.dt, groundSpeed: 0, accelRate: 0, airControl: 0, gravity: c.zoneFields.gravity, zoneVelocity: c.zoneFields.zoneVelocity,
    terminalVelocity: c.zoneFields.terminalVelocity, responses: Array(32).fill(clear), airBlocked: false,
    ancestry: 'decoration', nonPawn: true, regionWater: c.zoneFields.water, fluidFriction: c.zoneFields.fluidFriction,
    mass: c.before.mass, buoyancy: c.before.buoyancy, bobbing: c.before.bBobbing }));
  const directory = path.resolve('reports/movement/island-falling-water');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'first-tick-cases.json');
  await writeFile(file, JSON.stringify(cases));
  const { gameDirectory } = await import('./game-directory.mjs');
  const { stdout } = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
    [fileURLToPath(new URL('./native-falling-oracle.py', import.meta.url)), gameDirectory(), file], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  const results = JSON.parse(stdout).results;
  assert.equal(results.length, cases.length);
  for (const r of results) assert.deepEqual(r.events.filter(e => e.move).length, 1, 'one unobstructed substep');
  return results;
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
const { gameDirectory } = await import('./game-directory.mjs');

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('01_NYC_UNATCOIsland');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const runtime = game.doors.scriptRuntime.runtime;
const level = runtime.levelFor(game.player.collisionActor);
const read = (actor, name) => runtime.readNamed(actor, name);
const crates = CRATES.map(name => level.actors.find(a => a?.name === name));
assert.ok(crates.every(Boolean), 'the five crates are in the map');
const zoneOf = a => read(a, 'Region')['engine.actor.pointregion.zone'];
const snapshot = a => ({ location: read(a, 'Location'), velocity: read(a, 'Velocity'), acceleration: read(a, 'Acceleration'),
  physics: read(a, 'Physics'), zone: zoneOf(a)?.name ?? null, mass: read(a, 'Mass'), buoyancy: read(a, 'Buoyancy'),
  bFloating: read(a, 'bFloating'), bBobbing: read(a, 'bBobbing'), bSplash: read(a, 'bSplash'), rotation: read(a, 'Rotation') });

// ZoneChange reaches the crates only through MoveActor's SetActorZone.
const zoneChanges = new Map(crates.map(c => [c, []]));
let tick = 0;
const processEvent = runtime.processEvent.bind(runtime);
runtime.processEvent = (actor, name, args, ...rest) => {
  const list = name === 'ZoneChange' ? zoneChanges.get(actor) : null;
  if (!list) return processEvent(actor, name, args, ...rest);
  const before = { buoyancy: read(actor, 'Buoyancy'), velocityZ: read(actor, 'Velocity')[2] };
  const result = processEvent(actor, name, args, ...rest);
  list.push({ tick, to: args[0]?.name ?? null, velocityZ: before.velocityZ, buoyancyBefore: before.buoyancy,
    buoyancyAfter: read(actor, 'Buoyancy'), bFloatingAfter: read(actor, 'bFloating'), bSplashAfter: read(actor, 'bSplash'),
    physicsAfter: read(actor, 'Physics') });
  return result;
};
if (part === 'bench') {
  const { createPlayerInputFixture } = await import('./player-input-fixture.mjs');
  createPlayerInputFixture(game).key('KeyW', true);
}
const initial = crates.map(c => ({ name: c.name, ...snapshot(c), zoneWater: Boolean(read(zoneOf(c), 'bWaterZone')) }));
const zoneFields = c => { const z = zoneOf(c); return { water: Boolean(read(z, 'bWaterZone')), fluidFriction: read(z, 'ZoneFluidFriction'),
  gravity: read(z, 'ZoneGravity'), zoneVelocity: read(z, 'ZoneVelocity'), terminalVelocity: read(z, 'ZoneTerminalVelocity') }; };
const tracks = crates.map(c => ({ name: c.name, initial: snapshot(c), maxRise: 0, pinnedFrom: 0, rotations: 0, lastRotation: null,
  surfaceBand: null }));
let firstError = null, firstTick = null;
const ticks = part === 'idle' ? 600 : 360;
while (!firstError && tick < ticks) {
  const before = tick === 0 ? crates.map(c => ({ ...snapshot(c), zoneFields: zoneFields(c) })) : null;
  simulatedMs += 1000 / 60; tick++;
  try { game.tick(1 / 60); }
  catch (error) { firstError = { tick, message: String(error?.message ?? error).split('\n')[0] }; }
  if (before) {
    // Actor.Tick's DeltaTime for a 1/60 s frame at TimeDilation 1.
    firstTick = crates.map((c, i) => ({ name: c.name, dt: f(1 / 60), before: before[i], zoneFields: before[i].zoneFields, after: snapshot(c) }));
  }
  for (const [i, c] of crates.entries()) {
    const t = tracks[i], s = snapshot(c), rise = f(s.location[2] - t.initial.location[2]);
    t.maxRise = Math.max(t.maxRise, rise);
    const still = s.velocity.every(v => v === 0) && s.physics === 2;
    if (still && !t.pinnedFrom) t.pinnedFrom = tick; else if (!still) t.pinnedFrom = 0;
    const key = s.rotation.join(',');
    if (t.lastRotation !== null && key !== t.lastRotation) t.rotations++;
    t.lastRotation = key;
    if (tick > 120) t.surfaceBand = t.surfaceBand ? [Math.min(t.surfaceBand[0], s.location[2]), Math.max(t.surfaceBand[1], s.location[2])]
      : [s.location[2], s.location[2]];
  }
}
console.log(JSON.stringify({ ticks: tick, firstError, initial, firstTick,
  crates: tracks.map((t, i) => ({ ...t, lastRotation: undefined, zoneChanges: zoneChanges.get(crates[i]), final: snapshot(crates[i]) })) }));
process.exit(0);
