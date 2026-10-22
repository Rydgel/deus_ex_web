/** Visited-map restoration in Play against the measured original (docs/travel.md "Play, step 3"), headless.
 *
 * Scenario T is the Training pair (mission 0), the same legs as the measured s1/s3 sessions: Training, markers set, `LocalTravel 00_TrainingCombat`
 * (Training is filed), Combat, `LocalTravel 00_Training` (Combat is filed, Training restored), `LocalTravel 00_TrainingCombat` again (Training filed
 * again, Combat restored), then a mission change (Current wiped). The markers are the original's own kinds: a destroyed actor (KillAll), a spawned
 * item (summon), a moved mover, level time, an NPC's state. Checks:
 *   - Save\Current lists the files the original listed after each leg (names are DeusExLevelInfo.MapName, one per level left; none after a mission
 *     change);
 *   - the engine log holds the measured lines in the measured order for the save and the restore, and none of the begin-play lines
 *     (Game class is, Bringing Level, InitGame, Base Mutator);
 *   - the restored level has its markers: no troop, the summoned item, the mover where it was, the clock past the saved one, the NPCs in the states
 *     they were saved in, exactly one player pawn (the saved one, re-possessed), and nothing a begin-play pass would add.
 * Scenario I is the Island <-> HQ pair of mission 1 against the new capture rt1 (the same checks, the original's listing and log).
 * Scenario P walks through the Teleporters of that pair (`Map#Portal`), X triggers MapExits (direct, and with bPlayTransition) and A is the AI event
 * manager's snapshot/load round trip on a level that has run (the best sender).
 *
 *   node scripts/validate-travel-restore.mjs [--only T|I|P|A|X] */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { parseAiWords } from '../src/runtime/ai-events-payload.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const only = option('only', null);
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-travel-restore: no installed game data'); process.exit(0); }
const captures = new URL('../.work/travel/', import.meta.url).pathname;
if (!existsSync(`${captures}rt1/final.log`)) { console.log('SKIP validate-travel-restore: the measured captures are not in .work/travel (outside Git)'); process.exit(0); }
// Each scenario opens several levels and keeps their sessions: one process per scenario keeps the heap of each bounded.
if (!only) {
  const { spawnSync } = await import('node:child_process');
  let failed = 0;
  for (const scenario of ['T', 'I', 'P', 'X', 'A']) {
    const run = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--only', scenario], { stdio: 'inherit' });
    if (run.status !== 0) failed++;
  }
  console.log(failed ? `FAIL validate-travel-restore: ${failed} of 5 scenarios failed` : 'PASS validate-travel-restore: all five scenarios');
  process.exit(failed ? 1 : 0);
}

const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
const lower = value => String(value).toLowerCase();

const BEGIN_PLAY = /^(Log: Game class is|Log: Bringing Level|ScriptLog: InitGame|ScriptLog: Base Mutator)/;
/** The measured log of one leg, between its `Export travel` and the next level's `InitStateMachine`, filtered to what Play models. */
const MODELLED = /^(Log: (Export travel for|Browse:|Current mission number|Attempting to get player|Unloading: Package|Moving |LoadMap:|Spawning new actor|Possessed PlayerPawn)|Init: (Shut down|Initialized) moving brush tracker|Warning: |ScriptLog: (Login:|All inventory|DeusExLevelInfo - Spawned|\*\*\*\* InitStateMachine))/;
const normalize = line => line.replace(/\bSave=[\d.]+/, 'Save=<ms>').replace(/\b(\w+?)\d+\b(?= started mission)/g, '$1#').replace(/(Possessed PlayerPawn: \w+ )\S*?\.\w+?\d+$/, '$1<pawn>')
  .replace(/Mission\d+/, 'Mission#').replace(/\s+$/, '');

function legsOf(lines) {
  const legs = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('Log: Export travel for')) {
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) if (/InitStateMachine/.test(lines[j]) || lines[j].startsWith('Log: Export travel for')) { end = j + 1; break; }
    legs.push(lines.slice(i, end));
  }
  return legs;
}
/** The lines after LoadMap that the collection of the old level prints (`Unloading: Package` for each package it frees, the second tracker shutdown)
 * are the original's own garbage collection, which Play does not model (docs/travel.md "Unresolved" 10 and 11): they are left out of the comparison. */
const modelled = leg => {
  const loaded = leg.findIndex(line => line.startsWith('Log: LoadMap:'));
  return leg.filter((line, i) => MODELLED.test(line) && !(loaded >= 0 && i > loaded && /^(Log: Unloading: Package|Init: Shut down)/.test(line))).map(normalize);
};

async function pairScenario({ id, title, first, second, other, firstFile, secondFile, troop, settle }) {
  console.log(`--- ${id}: ${title}`);
  const directory = createSaveDirectory();
  const { c } = await openSession(first, assets, { travel: {}, saveDirectory: directory });
  c.frames(settle);
  c.game.hud.scoped(() => c.runtime.writeNamed(c.player(), 'bCheatsEnabled', true));
  // markers: the troops destroyed, an item summoned, a door opened
  const troopsBefore = c.byClass(troop).length;
  c.exec(`KillAll ${troop}`); c.frames(5);
  c.exec('summon DeusEx.Candybar'); c.frames(5);
  const candy = c.byClass('Candybar').at(-1);
  const door = c.byClass('DeusExMover').find(m => !c.read(m, 'bLocked') && c.read(m, 'KeyNum') === 0 && c.read(m, 'MoveTime') > 0);
  c.trigger(door); c.frames(200);
  const marker = { troops: c.byClass(troop).length, candy: candy && c.pos(candy), doorKey: c.read(door, 'KeyNum'), doorAt: c.pos(door), doorName: door.name,
    time: c.read(c.level().actors[0], 'TimeSeconds') };
  console.log(`markers: ${troopsBefore} troops -> ${marker.troops}, ${candy?.name} at ${marker.candy?.map(Math.round)}, ${door.name} KeyNum ${marker.doorKey} at ${marker.doorAt.map(Math.round)}, t=${marker.time.toFixed(2)}`);
  check(marker.troops === 0 && candy && marker.doorKey === 1, 'T: the markers did not take');
  const states = new Map(c.actors().filter(a => c.isA(a, 'engine.pawn') && a !== c.player()).map(a => [a.name, c.state(a)]));

  const leg = (session, command) => { session.exec(command); session.frames(2); return session.takeTravel(); };
  // leg 1: Training -> Combat: Training is filed
  const r1 = leg(c, `LocalTravel ${second}`);
  check(r1 && !r1.restore && r1.map === second, `T1: the request ${JSON.stringify(r1 && { map: r1.map, restore: r1.restore })}`);
  const listing = () => directory.files('Current').map(file => file.name).sort();
  check(JSON.stringify(listing()) === JSON.stringify([firstFile]), `T1: Current holds ${listing()} (the original: ${firstFile})`);
    const { c: d } = await openSession(r1.map, assets, { travel: { arrival: r1, lastURL: r1.lastURL }, saveDirectory: directory });
  d.frames(60);
  // leg 2: Combat -> Training: Combat is filed, Training restored
  const r2 = leg(d, `LocalTravel ${first}`);
  check(r2 && r2.restore && r2.url === `..\\Save\\Current\\${first}.dxs?Name=Player?Class=DeusEx.JCDentonMale`, `T2: the request ${JSON.stringify(r2 && { url: r2.url, restore: r2.restore })}`);
  check(JSON.stringify(listing()) === JSON.stringify([secondFile, firstFile].sort()), `T2: Current holds ${listing()} (the original: ${secondFile}, ${firstFile})`);
  const { c: e } = await openSession(r2.map, assets, { travel: { arrival: r2, lastURL: r2.lastURL }, saveDirectory: directory });
  const logE = e.game.doors.scriptRuntime.engineLog;
  check(!logE.some(line => BEGIN_PLAY.test(line)), `T2: the restored level ran a begin-play line: ${logE.filter(line => BEGIN_PLAY.test(line))}`);
  // the markers survive
  const atArrival = {
    troops: e.byClass(troop).length, candy: e.byClass('Candybar').length,
    pawns: e.actors().filter(a => e.isA(a, 'engine.playerpawn')).length,
  };
  const door2 = e.actor(marker.doorName);
  check(atArrival.troops === 0, `T2: ${atArrival.troops} troops in the restored level (destroyed actors stay destroyed)`);
  check(atArrival.candy >= 1, 'T2: the summoned item is gone');
  check(atArrival.pawns === 1, `T2: ${atArrival.pawns} player pawns in the restored level (one: the saved pawn, re-possessed)`);
  check(e.read(door2, 'KeyNum') === 1, `T2: the door's KeyNum ${e.read(door2, 'KeyNum')}`);
  check(JSON.stringify(e.pos(door2)) === JSON.stringify(marker.doorAt), `T2: the door at ${e.pos(door2)}, saved at ${marker.doorAt}`);
  check(e.read(e.level().actors[0], 'TimeSeconds') >= marker.time, `T2: the clock restarted (${e.read(e.level().actors[0], 'TimeSeconds')} < ${marker.time})`);
  e.frames(90);
  const statesAfter = new Map(e.actors().filter(a => e.isA(a, 'engine.pawn') && a !== e.player()).map(a => [a.name, e.state(a)]));
  let kept = 0, changed = [];
  for (const [name, state] of states) if (statesAfter.has(name)) { if (statesAfter.get(name) === state) kept++; else changed.push(`${name}: ${state} -> ${statesAfter.get(name)}`); }
  console.log(`restored ${first}: ${atArrival.troops} troops, ${atArrival.candy} candybar, door KeyNum ${e.read(door2, 'KeyNum')}, ${kept}/${states.size} NPCs in their saved state after 1.5 s${changed.length ? ` (${changed.slice(0, 3).join('; ')})` : ''}`);
  check(kept >= states.size * 0.8, `T2: only ${kept}/${states.size} NPCs kept their state: ${changed.slice(0, 5)}`);
  // leg 3: Training -> Combat again: Training filed again, Combat restored
  const r3 = leg(e, `LocalTravel ${second}`);
  check(r3 && r3.restore, 'T3: Combat was not restored');
  check(JSON.stringify(listing()) === JSON.stringify([secondFile, firstFile].sort()), `T3: Current holds ${listing()}`);
  const { c: f } = await openSession(r3.map, assets, { travel: { arrival: r3, lastURL: r3.lastURL }, saveDirectory: directory });
  f.frames(30);
  // leg 4: a mission change wipes Current
  const r4 = leg(f, `LocalTravel ${other}`);
  check(r4 && !r4.restore && r4.map === other, 'T4: the mission change did not load the fresh level');
  check(listing().length === 0, `T4: Current holds ${listing()} after a mission change (the original: empty)`);

  // the log of the save and the restore against the measured one (rt1's Island/HQ legs have the same shape)
  const measured = (await readFile(`${captures}rt1/final.log`, 'utf8')).split(/\r?\n/);
  const measuredLegs = legsOf(measured).map(modelled);
  const play = legsOf([...d.game.doors.scriptRuntime.engineLog, ...logE]).map(modelled);
  const wanted = measuredLegs[2];   // HQ -> Island (restore): Export, Browse, mission numbers, save lines, LoadMap of the filed level, warning, login
  const got = play[0];
  console.log('log of leg 2 (save + restore), Play vs the measured Island/HQ leg:');
  const shape = lines => lines.map(line => line.replace(/\S*\.JCDentonMale\d+/, '<pawn>').replace(/Browse: \S+/, 'Browse: <map>').replace(/LoadMap: \S+/, 'LoadMap: <file>').replace(/Package \S+/, 'Package <p>').replace(/Level \S+/, 'Level <l>').replace(/Moving .*/, 'Moving <t>').replace(/mission number is \d+, next is \d+/, 'mission number is N, next is N')
    .replace(/InitStateMachine\(\).*/, 'InitStateMachine()'));
  const a = shape(got ?? []), b = shape(wanted ?? []);
  check(JSON.stringify(a) === JSON.stringify(b), `T: the save/restore log differs from the measured one:\n--- Play\n${a.join('\n')}\n--- original\n${b.join('\n')}`);
  console.log(a.join('\n'));
}

/** Teleporter portals (`Map#Portal`: Teleporter.Touch -> Level.Game.SendPlayer), the route of the game itself: Liberty Island's Teleporter3
 * leads to HQ's `Inside_UN_HQ` and HQ's Teleporter2 back to the Island's `tunnel_drop_nyc`. The player stands on the teleporter and the
 * ticks run; the request carries the portal; the arrival is at the destination teleporter, in the fresh HQ and in the restored Island. */
async function portalScenario() {
  console.log('--- P: Teleporter portals (Liberty Island <-> UNATCO HQ)');
  const directory = createSaveDirectory();
  const { c } = await openSession('01_NYC_UNATCOIsland', assets, { travel: {}, saveDirectory: directory });
  c.frames(90);
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 80 && Math.abs(a[2] - b[2]) < 120;
  /** The player walks into the teleporter from 150 units away (a placement alone raises no Touch: a touch comes from a move into the cylinder). */
  const step = (session, teleporter) => {
    const at = session.pos(session.actor(teleporter));
    let from = null, yaw = 0;
    for (let k = 0; k < 8 && !from; k++) {
      const bearing = k * Math.PI / 4, p = [at[0] + Math.cos(bearing) * 150, at[1] + Math.sin(bearing) * 150, at[2] + 10];
      if (session.inWorld(p)) { from = p; yaw = bearing + Math.PI; }
    }
    session.fixture.place(from, { yaw });
    session.fixture.drive({ keys: { ArrowUp: true } });
    let request = null;
    for (let k = 0; k < 20 && !request; k++) { session.frames(5); request = session.takeTravel(); }
    session.fixture.releaseAll();
    return request;
  };
  const r1 = step(c, 'Teleporter3');
  check(r1 && r1.map === '01_NYC_UNATCOHQ' && r1.portal === 'Inside_UN_HQ' && !r1.restore, `P1: the request ${JSON.stringify(r1 && { map: r1.map, portal: r1.portal, restore: r1.restore })}`);
  if (!r1) return;
  const { c: d } = await openSession(r1.map, assets, { travel: { arrival: r1, lastURL: r1.lastURL }, saveDirectory: directory });
  const start1 = d.pos(d.actor('Teleporter1')), at1 = d.pos(d.player());
  console.log(`HQ: arrived at ${at1.map(Math.round)}, the Inside_UN_HQ teleporter at ${start1.map(Math.round)}`);
  check(near(at1, start1), `P1: the player arrived at ${at1.map(Math.round)}, not at Inside_UN_HQ ${start1.map(Math.round)}`);
  d.frames(60);
  const r2 = step(d, 'Teleporter2');
  check(r2 && r2.map === '01_NYC_UNATCOIsland' && r2.portal === 'tunnel_drop_nyc' && r2.restore, `P2: the request ${JSON.stringify(r2 && { map: r2.map, portal: r2.portal, restore: r2.restore })}`);
  if (!r2) return;
  const { c: e } = await openSession(r2.map, assets, { travel: { arrival: r2, lastURL: r2.lastURL }, saveDirectory: directory });
  const start2 = e.pos(e.actor('Teleporter4')), at2 = e.pos(e.player());
  console.log(`Island (restored): arrived at ${at2.map(Math.round)}, the tunnel_drop_nyc teleporter at ${start2.map(Math.round)}`);
  check(near(at2, start2), `P2: the restored player arrived at ${at2.map(Math.round)}, not at tunnel_drop_nyc ${start2.map(Math.round)}`);
  check(!e.game.doors.scriptRuntime.engineLog.some(line => BEGIN_PLAY.test(line)), 'P2: the restored level ran a begin-play line');
  e.frames(60);
}

/** MapExit (DeusEx/MapExit.uc), the other way into the same chain: triggered, it runs LoadMap -> Level.Game.SendPlayer(Player, DestMap), or with
 * bPlayTransition the camera path (the player's Interpolating state along the InterpolationPoints) and, at InterpolateEnd, SendPlayer(Self, NextMap).
 *   X1: 02_NYC_Street's exit to 02_NYC_Warehouse#ToRoofTop and the Warehouse's way back, 02_NYC_Street#FromRoofTop (the Street restored);
 *   X2: 03_NYC_UNATCOIsland's transition to 03_NYC_BatteryPark (mission 3 both: the Island is filed). */
async function mapExitScenario() {
  console.log('--- X: MapExit (direct, and with bPlayTransition)');
  const exitOf = (session, name) => session.actor(name);
  const fire = (session, exit, frames) => {
    session.game.hud.scoped(() => session.runtime.processEvent(exit, 'Trigger', [session.player(), session.player()]));
    for (let n = 0; n < frames; n += 10) { session.frames(10); const request = session.takeTravel(); if (request) return request; }
    return null;
  };
  {
    const directory = createSaveDirectory();
    const { c } = await openSession('02_NYC_Street', assets, { travel: {}, saveDirectory: directory });
    c.frames(60);
    const r1 = fire(c, exitOf(c, 'MapExit0'), 100);
    check(r1 && r1.map === '02_NYC_Warehouse' && r1.portal === 'ToRoofTop' && !r1.restore, `X1: the request ${JSON.stringify(r1 && { map: r1.map, portal: r1.portal, restore: r1.restore })}`);
    check(JSON.stringify(directory.files('Current').map(f => f.name)) === JSON.stringify(['02_NYC_Street.dxs']), `X1: Current holds ${directory.files('Current').map(f => f.name)}`);
    if (!r1) return;
    const { c: d } = await openSession(r1.map, assets, { travel: { arrival: r1, lastURL: r1.lastURL }, saveDirectory: directory });
    d.frames(60);
    const r2 = fire(d, exitOf(d, 'MapExit1'), 100);
    check(r2 && r2.map === '02_NYC_Street' && r2.portal === 'FromRoofTop' && r2.restore, `X1: the way back ${JSON.stringify(r2 && { map: r2.map, portal: r2.portal, restore: r2.restore })}`);
    if (!r2) return;
    const { c: e } = await openSession(r2.map, assets, { travel: { arrival: r2, lastURL: r2.lastURL }, saveDirectory: directory });
    const portal = e.byTag('FromRoofTop').find(a => e.isA(a, 'engine.teleporter'));
    const at = e.pos(e.player());
    console.log(`Street (restored): arrived at ${at.map(Math.round)}, FromRoofTop at ${portal && e.pos(portal).map(Math.round)}`);
    check(portal && Math.hypot(at[0] - e.pos(portal)[0], at[1] - e.pos(portal)[1]) < 80, 'X1: the restored Street did not place the player at FromRoofTop');
    check(!e.game.doors.scriptRuntime.engineLog.some(line => BEGIN_PLAY.test(line)), 'X1: the restored Street ran a begin-play line');
    e.frames(60);
  }
  {
    const directory = createSaveDirectory();
    const { c } = await openSession('03_NYC_UNATCOIsland', assets, { travel: {}, saveDirectory: directory });
    c.frames(60);
    const exit = exitOf(c, 'MapExit0');
    const r = fire(c, exit, 3000);
    check(r && r.map === '03_NYC_BatteryPark' && !r.restore, `X2: the request ${JSON.stringify(r && { map: r.map, portal: r.portal, restore: r.restore })}`);
    check(JSON.stringify(directory.files('Current').map(f => f.name)) === JSON.stringify(['03_NYC_UNATCOIsland.dxs']), `X2: Current holds ${directory.files('Current').map(f => f.name)}`);
    if (r) {
      const { c: d } = await openSession(r.map, assets, { travel: { arrival: r, lastURL: r.lastURL }, saveDirectory: directory });
      d.frames(60);
      check(d.state(d.player()) === 'deusex.deusexplayer.playerwalking', `X2: the arrived player is in ${d.state(d.player())}`);
      console.log(`BatteryPark: arrived in ${d.state(d.player())} after the transition path`);
    }
  }
}

/** The AI event manager through ai_snapshot and ai_load on a level that has run: the words a snapshot gives load back into a manager whose snapshot
 * is the same words. The Street holds receivers with a best sender (an actor handle: AIProcess stores the sender's Actor) after a few seconds,
 * which no measured file does (every receiver of the saved Island has none), so the round trip is the check on that field. */
async function aiScenario() {
  console.log('--- A: the AI event manager round trip (02_NYC_Street)');
  const { c } = await openSession('02_NYC_Street', assets, { travel: {}, saveDirectory: createSaveDirectory() });
  c.frames(180);
  const ai = c.runtime.scriptVm.aiEvents, info = c.level().actors[0];
  const first = ai.snapshot();
  const { receivers } = parseAiWords(first);
  const withBest = receivers.filter(r => r.bestSender !== 0).length;
  console.log(`snapshot: ${first.length} words, ${receivers.length} receivers, ${withBest} with a best sender`);
  check(withBest > 0, 'A: no receiver holds a best sender after 3 s (the round trip does not cover the field)');
  ai.load(info, first);
  const second = ai.snapshot();
  check(second.length === first.length && first.every((word, i) => word === second[i]), `A: ai_load(ai_snapshot()) changed the words (${first.length} -> ${second.length})`);
}

if (!only || only === 'T') await pairScenario({ id: 'T', title: 'Training <-> Training Combat (mission 0)', first: '00_Training', second: '00_TrainingCombat', other: '01_NYC_UNATCOIsland',
  firstFile: '00_training.dxs', secondFile: '00_TrainingCombat.dxs', troop: 'UNATCOTroop', settle: 90 });
if (!only || only === 'I') await pairScenario({ id: 'I', title: 'Liberty Island <-> UNATCO HQ (mission 1)', first: '01_NYC_UNATCOIsland', second: '01_NYC_UNATCOHQ', other: '02_NYC_Street',
  firstFile: '01_NYC_UNATCOIsland.dxs', secondFile: '01_NYC_UNATCOHQ.dxs', troop: 'UNATCOTroop', settle: 90 });
if (!only || only === 'P') await portalScenario();
if (!only || only === 'A') await aiScenario();
if (!only || only === 'X') await mapExitScenario();
if (failures.length) { console.log(`FAIL validate-travel-restore:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('PASS validate-travel-restore: the listing, the markers, the log and the re-possession match the measured original');
