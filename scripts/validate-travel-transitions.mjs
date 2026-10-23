/** Map-to-map transitions of the campaign in Play against the original under Wine (docs/travel-transitions.md), headless.
 *
 * Each scenario replays one measured session (scripts/travel-steps/*.steps through scripts/travel-probe.sh; the captures stay in .work/travel, outside Git):
 * the logo map, `LocalTravel <the URL a MapExit or Teleporter holds>` for each leg (the console line is SendPlayer's own ClientTravel, MapExit.LoadMap adds
 * ClearWindowStack first), the arrival, and per leg
 *   - the engine log from `Export travel` to the arrival's `InitStateMachine` (the lines Play models, in the original's order);
 *   - the travel text the leg exported (every travel property of the player and its objects, normalized);
 *   - the player's flags after the arrival, and its location, rotation, view rotation and health;
 *   - the files `Save\Current` holds.
 * A leg that makes no request (an empty SendPlayer) is compared by the flags the PreTravel events left and by the log, which has no line for it.
 *
 *   A  the Hong Kong lifts: Helibase -> Market#cargoup -> Helibase#HeliBase (restored) -> an empty SendPlayer -> Market (restored)
 *   B  Mission02.PreTravel (MS_MapLeftEarly), a portal no Teleporter names (02_NYC_Street#ToStreet), Mission08.PreTravel (the EntranceCopter)
 *   D  the same PreTravels on levels that have run (MS_MapLeftEarly set, the EntranceCopter destroyed in the filed level)
 *   F  the camera paths of the bPlayTransition MapExits (the ride's place against level time, the arrival), fired by their tag: Island -> Battery Park, 04_NYC_BatteryPark's two exits
 *   E  a start spot far above the water: the original's player falls to the surface and swims (Physics 3), Play's too
 *   C  the `.dx` and `.dx #Portal` URL forms of mission 14 (filed and restored), and a mission change to 15_area51_bunker.dx #bunker_start
 *
 *   node scripts/validate-travel-transitions.mjs [--only A|B|C|D|E|F] */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { viewProbe } from '../src/viewer/view-probe.mjs';
import { travelTextOfDump, firstTravelTextDifference, parseTravelText } from '../src/runtime/travel-text.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const only = option('only', null);
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-travel-transitions: no installed game data'); process.exit(0); }
const captures = new URL('../.work/travel/', import.meta.url).pathname;

const props = label => ({ props: label });
const SCENARIOS = {
  A: { tag: 'tr-a', title: 'the Hong Kong lifts', legs: [
    { cmd: 'LocalTravel 06_HongKong_Helibase', snap: 'a1-helibase', ...props('a1-player') },
    { cmd: 'LocalTravel 06_HongKong_WanChai_Market#cargoup', snap: 'a2-market', ...props('a2-player') },
    { cmd: 'LocalTravel 06_HongKong_Helibase#HeliBase', snap: 'a3-helibase-restored', ...props('a3-player') },
    { cmd: 'LocalTravel', snap: 'a4-empty', none: true },
    { cmd: 'LocalTravel 06_HongKong_WanChai_Market#cargoup', snap: 'a5-market-restored', ...props('a5-player') }] },
  B: { tag: 'tr-b', title: 'Mission02/08 PreTravel and a portal no Teleporter names', legs: [
    { cmd: 'LocalTravel 02_NYC_BatteryPark', snap: 'b1-batterypark', ...props('b1-player') },
    { cmd: 'LocalTravel 02_NYC_Street#ToStreet', snap: 'b2-street', ...props('b2-player') },
    { cmd: 'LocalTravel 08_NYC_Street', snap: 'b3-street8', ...props('b3-player') },
    { cmd: 'LocalTravel 08_NYC_Bar#ToBarFrontEntrance', snap: 'b4-bar8' },
    { cmd: 'LocalTravel 08_NYC_Street#FromBarFrontEntrance', snap: 'b5-street8-restored', ...props('b5-player') }] },
  // D: the captured levels ran for an unknown time around the freeze (the freeze typed in BatteryPark did not hold at the Street: its InitStateMachine ran), so the
  // flags and texts after the first leg are not reproducible; the legs name the facts that are (`flagsInclude`, `helicopters`: the EntranceCopter is destroyed, the CopterExit helicopter is not), the engine log is not compared
  D: { tag: 'tr-d', title: 'Mission02/08 PreTravel on levels that have run', noLog: true, legs: [
    { cmd: 'LocalTravel 02_NYC_BatteryPark', snap: 'd1-batterypark', run: 360, loose: true, ...props('d1-player') },
    { cmd: 'LocalTravel 02_NYC_Street#ToStreet', snap: 'd2-street', loose: true, flagsInclude: ['MS_MapLeftEarly|0|3|1'], ...props('d2-player') },
    { cmd: 'LocalTravel 08_NYC_Street', snap: 'd3-street8', run: 360, loose: true, helicopters: 2, ...props('d3-player') },
    { cmd: 'LocalTravel 08_NYC_Bar#ToBarFrontEntrance', snap: 'd4-bar8', loose: true },
    { cmd: 'LocalTravel 08_NYC_Street#FromBarFrontEntrance', snap: 'd5-street8-restored', loose: true, helicopters: 1, ...props('d5-player') }] },
  // E: a start spot 1600 units above the water: the original's player falls and swims at the surface (Physics 3), as Play's does
  E: { tag: 'tr-e', title: 'a Teleporter start spot far above the water (Garage -> Storage#BackDoor)', noLog: true, legs: [
    { cmd: 'LocalTravel 06_HongKong_WanChai_Garage', snap: 'e4-storage', run: 240, loose: true, noCurrent: true },
    { cmd: 'LocalTravel 06_HongKong_Storage#BackDoor', snap: 'e4-storage', run: 600, loose: true, swim: true, ...props('e4-player') }] },
  // F: the camera paths of the bPlayTransition MapExits, fired by their tag (CauseEvent = Trigger on every actor with it): the ride's place against level time, then the arrival;
  // 04_NYC_BatteryPark's two exits share the tag Mission4Exit
  F: { tag: 'tr-f', title: 'bPlayTransition MapExits: the camera path and the arrival', legs: [
    { cmd: 'LocalTravel 01_NYC_UNATCOIsland', noSnap: true },
    { cmd: 'CauseEvent Dock_boat', cause: true, before: 'f0', path: Array.from({ length: 40 }, (_, i) => `f${i + 1}`), snap: 'f99-batterypark', ...props('f99-player') },
    { cmd: 'LocalTravel 04_NYC_BatteryPark', noSnap: true },
    { cmd: 'CauseEvent Mission4Exit', cause: true, before: 'g0', path: Array.from({ length: 40 }, (_, i) => `g${i + 1}`), snap: 'g99-mj12lab', ...props('g99-player') }] },
  C: { tag: 'tr-c', title: 'the .dx URL forms of mission 14 and the mission change to Area 51', legs: [
    { cmd: 'LocalTravel 14_OceanLab_Lab', snap: 'c1-lab', ...props('c1-player') },
    { cmd: 'LocalTravel 14_OceanLab_UC.dx #UC', snap: 'c2-uc', ...props('c2-player') },
    { cmd: 'LocalTravel 14_OceanLab_Lab.dx #Sunkentunnel', snap: 'c3-lab-back', ...props('c3-player') },
    { cmd: 'LocalTravel 14_Vandenberg_sub.dx#subbay', snap: 'c4-sub', ...props('c4-player') },
    { cmd: 'LocalTravel 14_Oceanlab_silo.dx #frontgate', snap: 'c5-silo', ...props('c5-player') },
    { cmd: 'LocalTravel 15_area51_bunker.dx #bunker_start', snap: 'c6-bunker', ...props('c6-player') },
    { cmd: 'LocalTravel 04_NYC_UNATCOIsland.dx', snap: 'c7-island4', ...props('c7-player') }] },
};
if (!only) {
  const { spawnSync } = await import('node:child_process');
  let failed = 0;
  for (const id of Object.keys(SCENARIOS)) {
    const run = spawnSync(process.execPath, ['--max-old-space-size=7168', new URL(import.meta.url).pathname, '--only', id], { stdio: 'inherit' });
    if (run.status !== 0) failed++;
  }
  console.log(failed ? `FAIL validate-travel-transitions: ${failed} of ${Object.keys(SCENARIOS).length} scenarios failed` : 'PASS validate-travel-transitions: every scenario');
  process.exit(failed ? 1 : 0);
}

const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
/** A console line as the captures typed it: the viewport's Exec chain (`set`, `LocalTravel`), `set LevelInfo bPlayersOnly True` being the freeze the captures carried into the next level through the class default. */
const typed = (c, line) => c.game.hud.scoped(() => viewProbe(c.game, { exec: [line] }).output[0]);
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };

const MODELLED = /^(Log: (Export travel for|Browse:|Current mission number|Attempting to get player|Unloading: Package|Moving |LoadMap:|Spawning new actor|Possessed PlayerPawn|Game class is|Bringing Level)|Init: (Shut down|Initialized) moving brush tracker|Warning: |ScriptLog: (Login:|All inventory|Spawned new mission script|\*\*\*\* InitStateMachine))/;
// (`skipping N bytes of type 10` is the size of a struct value in the file the level was restored from: Play's own writer orders the name table differently from the original's, a
// compact index of one or two bytes, docs/travel.md "Unresolved" 4; the spelling of a level package follows the URL text and FName's first spelling in the original, docs/travel.md "Unresolved" 19: the logs compare without case)
const normalize = line => line.toLowerCase().replace(/\bsave=[\d.]+/, 'save=<ms>').replace(/(possessed playerpawn: \w+ )\S*?\.\w+?\d+$/, '$1<pawn>').replace(/mission\d+/, 'mission#').replace(/skipping \d+ bytes/, 'skipping n bytes').replace(/\s+$/, '');
/** The measured log of each leg, from its `Export travel` to the next level's `InitStateMachine`, filtered to what Play models. */
function legsOf(lines) {
  const legs = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('Log: Export travel for')) {
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) if (/InitStateMachine/.test(lines[j]) || lines[j].startsWith('Log: Export travel for')) { end = j + 1; break; }
    legs.push(lines.slice(i, end));
  }
  return legs;
}
/** The lines the collection of the old level prints (`Unloading: Package` of the packages it frees, the tracker's second shutdown) are the original's own garbage
 * collection (docs/travel.md "Unresolved" 10, 11); only the left level's own `Unloading` (DeleteSaveGameFiles / SaveCurrentLevel) is compared. */
const modelled = leg => {
  const loaded = leg.findIndex(line => line.startsWith('Log: LoadMap:'));
  return leg.filter((line, i) => MODELLED.test(line) && !(loaded >= 0 && i > loaded && /^(Log: Unloading: Package|Init: Shut down)/.test(line))).map(normalize);
};
const originalFlags = text => text.split(/\r?\n/).map(line => /^\s+flag (\S+) type (\d+) expiration (-?\d+) value 0x([0-9a-f]+)/.exec(line)).filter(Boolean)
  .map(([, name, type, expiration, value]) => `${name}|${type}|${expiration}|${parseInt(value, 16) | 0}`).sort();
function originalPlayer(text) {
  const line = text.split(/\r?\n/).find(row => /^JCDentonMale JCDentonMale\d+ /.test(row));
  if (!line) return null;
  const triple = name => new RegExp(`${name}=\\(([^)]*)\\)`).exec(line)[1].split(',').map(Number);
  const physics = /Physics=(\d+)/.exec(line);
  const viewRotation = /ViewRotation=/.test(line) ? triple('ViewRotation') : null;
  return { location: triple('Location').map(Math.fround), rotation: triple('Rotation'), ...(viewRotation ? { viewRotation } : {}), ...(physics ? { physics: Number(physics[1]) } : {}), health: parseInt(/Health=0x([0-9a-f]+)/.exec(line)[1], 16) };
}
/** `f Current/<name>` rows of the save listing. */
const currentNames = text => text.split(/\r?\n/).map(line => /^f Current\/([^\t]+)\t/.exec(line)?.[1]).filter(Boolean).sort();

async function scenario(id) {
  const spec = SCENARIOS[id];
  const cap = `${captures}${spec.tag}/`;
  if (!existsSync(`${cap}final.log`)) { console.log(`--- ${id}: SKIP (the capture ${spec.tag} is not in .work/travel)`); return; }
  console.log(`--- ${id}: ${spec.title}`);
  const measured = (await readFile(`${cap}final.log`, 'utf8')).split(/\r?\n/);
  const measuredLegs = legsOf(measured).map(modelled);
  const directory = createSaveDirectory();
  const { c: logo } = await openSession('DX', assets, { travel: {}, saveDirectory: directory });
  logo.frames(30);
  typed(logo, 'set DeusEx.JCDentonMale bCheatsEnabled True');
  if (!spec.legs.some(leg => leg.run)) typed(logo, 'set LevelInfo bPlayersOnly True');
  let session = logo;
  const logs = [logo.game.doors.scriptRuntime.engineLog];   // each session's engine log (the arrays keep growing), in order
  let legIndex = 0;
  for (const leg of spec.legs) {
    const label = `${id}${spec.legs.indexOf(leg) + 1}`;
    const readCap = async ext => (await readFile(`${cap}${leg.snap}.${ext}`, 'utf8'));
    typed(session, leg.cmd);
    let request = null, trace = null;
    if (leg.cause) {
      // the ride: one frame at a time (the level left does not tick again once the tick's travel step has made its request)
      trace = [];
      const info = session.level().actors[0];
      for (let n = 0; n < 20000 && !request; n++) {
        session.frames(1);
        trace.push({ t: session.read(info, 'TimeSeconds'), loc: session.pos(session.player()), phys: session.read(session.player(), 'Physics') });
        request = session.takeTravel();
      }
    } else { session.frames(leg.none ? 360 : 2); request = session.takeTravel(); }
    if (leg.none) {
      check(!request, `${label}: an empty SendPlayer made a request (${request?.url})`);
      const flags = [...(session.read(session.player(), 'FlagBase')?.entries?.values() ?? [])].map(e => `${e.name}|${e.type}|${e.expiration}|${e.value | 0}`).sort();
      const want = originalFlags(await readCap('flags.txt'));
      check(JSON.stringify(flags) === JSON.stringify(want), `${label}: flags after the empty SendPlayer ${flags.join(' ')} (the original: ${want.join(' ')})`);
      console.log(`${label}: ${leg.cmd.trim()} -> no request; ${flags.length} flags${JSON.stringify(flags) === JSON.stringify(want) ? ' equal' : ' (DIFFER)'}`);
      continue;
    }
    if (!check(request, `${label}: ${leg.cmd} made no request`)) return;
    const text = request.travelInfo[0][1];
    const { c: next } = await openSession(request.map, assets, { travel: { arrival: request, lastURL: request.lastURL }, saveDirectory: directory });
    // the captured sessions freeze the arrival from its load (the class default carried) or, with `run`, let it run for that long and freeze it then
    if (leg.run) { next.frames(leg.run); typed(next, 'set LevelInfo bPlayersOnly True'); next.frames(60); }
    else { typed(next, 'set LevelInfo bPlayersOnly True'); next.frames(180); }
    if (leg.noSnap) {
      logs.push(next.game.doors.scriptRuntime.engineLog);
      console.log(`${label}: ${leg.cmd.trim()} -> ${request.map}${request.portal ? `#${request.portal}` : ''} (no snapshot of this arrival; the log is compared)`);
      session = next;
      continue;
    }
    // 0. the ride along a camera path: the place of the player against level time (Physics 8, PHYS_Interpolating)
    let rideNote = '';
    if (leg.cause) {
      const samples = [];
      for (const label2 of leg.path) {
        const line = (await readFile(`${cap}${label2}.props.txt`, 'utf8').catch(() => '')).split(/\r?\n/).find(row => /^JCDentonMale JCDentonMale\d+ /.test(row));
        if (!line) continue;
        const loc = /Location=\(([^)]*)\)/.exec(line)[1].split(',').map(Number), phys = Number(/Physics=(\d+)/.exec(line)[1]), t = Number(/LevelTime=([-\d.e+]+)/.exec(line)[1]);
        samples.push({ t, loc, phys });
      }
      const ride = samples.filter(sample => sample.phys === 8);
      // The wall-clock cost of a sample in the capture (a process start under Wine, seconds) is far above a camera path's length in level time, so a capture holds one or two samples of
      // the ride: each lies on Play's path, and the first is no later than the level time the capture had spent since the sample taken before the event
      const before = leg.before ? await readFile(`${cap}${leg.before}.props.txt`, 'utf8').then(text => /LevelTime=([-\d.e+]+)/.exec(text.split(/\r?\n/).find(row => /^JCDentonMale JCDentonMale\d+ /.test(row)) ?? '')?.[1], () => null) : null;
      if (check(ride.length >= 1, `${label}: the capture holds no sample of the ride`)) {
        const at = ride.map(sample => { let best = -1, distance = Infinity; trace.forEach((point, i) => { if (point.phys !== 8) return; const d = Math.hypot(point.loc[0] - sample.loc[0], point.loc[1] - sample.loc[1], point.loc[2] - sample.loc[2]); if (d < distance) { distance = d; best = i; } }); return { i: best, d: distance }; });
        const worst = Math.max(...at.map(a => a.d));
        check(worst < 8, `${label}: a sample of the ride lies ${worst.toFixed(1)} units from Play's path`);
        const first = trace.findIndex(point => point.phys === 8);
        const elapsedPlay = trace[at[0].i].t - trace[first].t;
        if (before !== null && before !== undefined) {
          const bound = ride[0].t - Number(before);
          check(elapsedPlay <= bound + 0.1, `${label}: Play's player needs ${elapsedPlay.toFixed(2)} s of level time to reach the first sample, the capture had ${bound.toFixed(2)} s`);
        }
        let drift = 0;
        for (let k = 1; k < ride.length; k++) {
          const play = trace[at[k].i].t - trace[at[k - 1].i].t, original = ride[k].t - ride[k - 1].t;
          drift = Math.max(drift, Math.abs(play - original));
          check(Math.abs(play - original) < 0.12 + 0.01 * original, `${label}: between samples ${k} and ${k + 1} Play's player took ${play.toFixed(2)} s of level time, the original's ${original.toFixed(2)} s`);
        }
        rideNote = `, ${ride.length} ride sample(s) within ${worst.toFixed(1)} units of Play's path (reached ${elapsedPlay.toFixed(1)} s into the ride, the capture's bound ${before != null ? (ride[0].t - Number(before)).toFixed(1) : '-'} s), ${(trace.length / 60).toFixed(1)} s of ride to the request`;
      }
    }
    // 1. the travel text this leg exported
    const exported = travelTextOfDump(await readCap('travel.txt'));
    const difference = leg.loose ? null : firstTravelTextDifference(exported.text, text, { times: true });
    check(difference === null, `${label}: the exported travel text differs at line ${difference?.line}: expected ${JSON.stringify(difference?.expected)}, got ${JSON.stringify(difference?.actual)}`);
    // 2. the flags of the arrived player
    const p = next.player();
    const flags = [...(next.read(p, 'FlagBase')?.entries?.values() ?? [])].map(e => `${e.name}|${e.type}|${e.expiration}|${e.value | 0}`).sort();
    const wantFlags = originalFlags(await readCap('flags.txt'));
    check(leg.loose || JSON.stringify(flags) === JSON.stringify(wantFlags), `${label}: flags ${flags.join(' ')} (the original: ${wantFlags.join(' ')})`);
    for (const flag of leg.flagsInclude ?? []) check(flags.includes(flag) && wantFlags.includes(flag), `${label}: the flag ${flag} is missing (Play ${flags.includes(flag)}, the original ${wantFlags.includes(flag)})`);
    if (leg.helicopters !== undefined) {
      const count = next.byClass('BlackHelicopter').length;
      check(count === leg.helicopters, `${label}: ${count} BlackHelicopter actors in the level (the original: ${leg.helicopters})`);
    }
    // 3. where the player stands
    let playerNote = '';
    if (leg.props) {
      const want = originalPlayer(await readCap('props.txt').catch(() => readFile(`${cap}${leg.props}.props.txt`, 'utf8')));
      const got = { location: next.pos(p).map(Math.fround), rotation: next.read(p, 'Rotation'), viewRotation: next.read(p, 'ViewRotation'), physics: next.read(p, 'Physics'), health: next.read(p, 'Health') };
      if (check(want, `${label}: the capture has no player row`))
        for (const key of Object.keys(want)) {
          // a fresh arrival drops from the start spot to the floor and rests at a height that depends on the frame times of the fall (Play 1/60 s, the original's own):
          // the height is compared within 0.25, the rest exactly
          if (leg.run && (key === 'rotation' || key === 'viewRotation')) continue;   // a level that ran for an unmeasured time turned the player (docs/travel-transitions.md, open)
          if (key === 'rotation' && leg.swim) continue;                 // the swimmer's yaw follows nothing the capture holds
          if (key === 'location' && leg.swim) { check(got.location.every((v, i) => Math.abs(v - want.location[i]) < (i === 2 ? 8 : 1e-3)), `${label}: the swimmer at ${got.location} (the original: ${want.location}; the surface bobs by a few units)`); continue; }
          const same = key === 'location' && !request.restore ? got.location.every((v, i) => Math.abs(v - want.location[i]) < (i === 2 ? 0.25 : 1e-3)) : JSON.stringify(got[key]) === JSON.stringify(want[key]);
          check(same, `${label}: player ${key} ${JSON.stringify(got[key])} (the original: ${JSON.stringify(want[key])})`);
        }
      playerNote = `, player at ${got.location.map(Math.round)}`;
    }
    // 4. Save\Current
    const names = directory.files('Current').map(file => file.name).sort();
    const wantNames = currentNames(await readCap('save.txt'));
    check(leg.noCurrent || JSON.stringify(names) === JSON.stringify(wantNames), `${label}: Current holds ${names} (the original: ${wantNames})`);
    logs.push(next.game.doors.scriptRuntime.engineLog);
    console.log(`${label}: ${leg.cmd.trim()} -> ${request.map}${request.portal ? `#${request.portal}` : ''}${request.restore ? ' (restored)' : ''}; ${parseTravelText(text).length} records${leg.loose ? '' : difference ? ' (DIFFER)' : ' equal'}, ${flags.length} flags${leg.loose ? '' : JSON.stringify(flags) === JSON.stringify(wantFlags) ? ' equal' : ' (DIFFER)'}${playerNote}${rideNote}; Current ${names.join(', ')}`);
    session = next;
    legIndex++;
  }
  // 5. the engine log of every leg
  if (spec.noLog) { if (failures.length) { console.log(`FAIL validate-travel-transitions ${only}:\n  ${failures.join('\n  ')}`); process.exit(1); } console.log(`PASS validate-travel-transitions ${only}`); process.exit(0); }
  const playLegs = legsOf(logs.flat()).map(modelled);
  check(playLegs.length === measuredLegs.length, `${id}: ${playLegs.length} legs in Play's log, ${measuredLegs.length} in the original's`);
  const shape = lines => lines;
  for (let i = 0; i < Math.min(playLegs.length, measuredLegs.length); i++) {
    const a = shape(playLegs[i]), b = shape(measuredLegs[i]);
    const same = JSON.stringify(a) === JSON.stringify(b);
    check(same, `${id}: the log of leg ${i + 1} differs:\n--- Play\n${a.join('\n')}\n--- original\n${b.join('\n')}`);
    console.log(`log of leg ${i + 1}: ${a.length} modelled lines${same ? ' in the original\'s order' : ' (DIFFER)'}`);
  }
}

await scenario(only);
if (failures.length) { console.log(`FAIL validate-travel-transitions ${only}:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS validate-travel-transitions ${only}`);
