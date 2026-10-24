/** Planner of the Stage 6 chain harness (docs/stage-6-chains.md): finds the placements a chain step needs, in Play's world, and prints them as chain data.
 * A placement is a harness step; the planner only chooses where, so that the original and Play are given the same numbers.
 *
 *   node scripts/chain-plan.mjs approach <map> <actor> [--distance D] [--seconds S] [--lift L]    walk into an actor's cylinder (a Teleporter, a MapExit, a trigger):
 *                                                                                                  the bearings from which a held forward key reaches it
 *   node scripts/chain-plan.mjs drop <map> <actor> [--lifts 50,70] [--yaw N]                       placements above the cylinder: the fall enters it (a placement inside raises no Touch)
 *   node scripts/chain-plan.mjs stand <map> <actor> [--distances 60,90] [--lift L] [--settle F]                  places at a distance from the actor with a clear line to it, aimed at it
 *   node scripts/chain-plan.mjs face <map> <actor> [--distances 60,90] [--lift L] [--freeze] [--all] [--aim x,y,z] [--accept A,B]  the places from which the view trace selects the actor (frob)
 *       [--before "CauseEvent a; CauseEvent b"]   console lines run (cheats on) after each restart, 4 s of ticks after each, before the trial: movers the chain opens first
 *   any mode: [--flags a,b]   flags set after the start and each restart (4 s of ticks): the scene a chain's flags stage (a pawn a script brings in)
 *   node scripts/chain-plan.mjs face-chain <mission> <step> <actor>...   the face placements in the level a chain reaches: the chain (scripts/chains/mission<mission>.mjs) runs in
 *                                                                        Play to its step <step> (0-based, not run; a slot's level differs from the cold map), then each place
 *                                                                        around each actor is tried in that state (no restart: the trials follow each other)
 */
import { fileURLToPath } from 'node:url';
import { loadAssets, typeLine, typeChar, pressKey, runChainInPlay } from './chain-play.mjs';
import { openSession } from './census-stage5-session.mjs';
import { placeLines, loadChain } from './chain-lib.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : Number(args[i + 1]); };
const [mode, map, actorName] = args;
if (mode === 'face-chain') {
  const [, mission, stop, ...names] = args;
  const chain = await loadChain(mission);
  chain.steps = chain.steps.slice(0, Number(stop));
  const { session: c } = await runChainInPlay(chain);
  const eye = c.game.player.baseEyeHeight, unit = 32768 / Math.PI;
  for (const name of names) {
    const target = c.actor(name), at = c.pos(target);
    c.watched.add(target);
    let found = 0;
    for (const d of [40, 50, 65]) for (let k = 0; k < 8 && found < 2; k++) {
      const bearing = k * Math.PI / 4, from = [Math.round(at[0] + Math.cos(bearing) * d), Math.round(at[1] + Math.sin(bearing) * d), Math.round(at[2] + 30)];
      if (!c.inWorld(from)) continue;
      for (const line of placeLines({ at: from, view: [0, 0] })) { typeLine(c, line); c.frames(10); }
      c.frames(40);
      // aimed from where the player landed, then read back what the view trace selects
      const p = c.pos(c.player()), dx = at[0] - p[0], dy = at[1] - p[1], dz = at[2] - (p[2] + eye);
      const view = [Math.round(Math.atan2(dz, Math.hypot(dx, dy)) * unit), Math.round(((Math.atan2(dy, dx) * unit) % 65536 + 65536) % 65536)];
      typeLine(c, `set DeusEx.JCDentonMale ViewRotation (Pitch=${view[0]},Yaw=${view[1]},Roll=0)`); c.frames(30);
      if (c.game.interaction.frobTarget?.name === name) { found++; console.log(JSON.stringify({ target: name, d, k, at: [p[0], p[1], p[2] + 1].map(Math.round), view })); }
    }
    if (!found) console.log(JSON.stringify({ target: name, found: 0 }));
  }
  process.exit(0);
}
if (mode === 'terminal') {
  // node scripts/chain-plan.mjs terminal <map> <computer> <user> <password>: the computer frobbed from a place the view trace selects it from, the login typed,
  // then the special options' buttons with their centres in Play's root and as the `point` op takes them (the original's 1280x720 viewport over a centred window)
  const [, , , user, password] = args;
  const assets = await loadAssets();
  const { c } = await openSession(map, assets, { travel: {} });
  c.frames(60);
  const target = c.actor(actorName), at = c.pos(target), eye = c.game.player.baseEyeHeight, unit = 32768 / Math.PI;
  c.watched.add(target);
  let placed = null;
  for (const d of [45, 60]) for (let k = 0; k < 8 && !placed; k++) {
    const bearing = k * Math.PI / 4, from = [Math.round(at[0] + Math.cos(bearing) * d), Math.round(at[1] + Math.sin(bearing) * d), Math.round(at[2] + 30)];
    if (!c.inWorld(from)) continue;
    for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at: from, view: [0, 0] })]) { typeLine(c, line); c.frames(10); }
    c.frames(40);
    const p = c.pos(c.player()), dx = at[0] - p[0], dy = at[1] - p[1], dz = at[2] - (p[2] + eye);
    const view = [Math.round(Math.atan2(dz, Math.hypot(dx, dy)) * unit), Math.round(((Math.atan2(dy, dx) * unit) % 65536 + 65536) % 65536)];
    typeLine(c, `set DeusEx.JCDentonMale ViewRotation (Pitch=${view[0]},Yaw=${view[1]},Roll=0)`); c.frames(30);
    if (c.game.interaction.frobTarget?.name === actorName) placed = { at: [p[0], p[1], p[2] + 1].map(Math.round), view };
  }
  if (!placed) throw new Error(`no place selects ${actorName}`);
  console.log(JSON.stringify({ place: placed }));
  typeLine(c, 'ParseRightClick'); c.frames(120);
  for (const ch of user) typeChar(c, ch);
  pressKey(c, 'TAB');
  for (const ch of password) typeChar(c, ch);
  pressKey(c, 'ENTER'); c.frames(120);
  const W = c.game.doors.scriptRuntime.windowHost.W, r = c.runtime, root = c.read(c.player(), 'rootWindow');
  const rootW = W.f32(root, 0xe4), rootH = W.f32(root, 0xe8);
  const stack = r.readNamed(root, 'winStack').slice(0, r.readNamed(root, 'winCount'));
  const terminal = stack.at(-1), screen = terminal ? c.read(terminal, 'winComputer') : null;
  const screenClass = screen ? r.instance(screen).cls.record.key : null;
  console.log(JSON.stringify({ terminal: terminal ? r.instance(terminal).cls.record.key : null, screen: screenClass, user: terminal ? c.read(terminal, 'userName') : null }));
  if (screenClass?.endsWith('computerscreenspecialoptions')) {
    const options = c.read(target, 'specialOptions');
    for (const entry of c.read(screen, 'optionButtons')) {
      const field = name => Object.entries(entry).find(([k]) => k.toLowerCase().endsWith(name.toLowerCase()))?.[1];
      const specialIndex = field('specialIndex'), btnSpecial = field('btnSpecial');
      if (!btnSpecial) continue;
      const x = W.f32(btnSpecial, 0xd4) + W.f32(btnSpecial, 0x80) * .5, y = W.f32(btnSpecial, 0xd8) + W.f32(btnSpecial, 0x84) * .5;
      const text = Object.entries(options[specialIndex]).find(([k]) => k.endsWith('.text'))?.[1];
      console.log(JSON.stringify({ specialIndex, text, play: [x, y], point: [Math.round(x + 640 - rootW / 2), Math.round(y + 360 - rootH / 2)] }));
    }
  }
  process.exit(0);
}
const assets = await loadAssets();
const { c, run } = await openSession(map, assets, { travel: {} });
// --flags a,b: flags set (planning only, not a chain step) after the start and each restart, with 4 s of ticks, so the level's script stages the scene a chain reaches
// (a pawn a mission script brings into the world once a flag is set: Stanton Dowd after M08MeetHarleyFilben_Played)
const sceneFlags = args.includes('--flags') ? args[args.indexOf('--flags') + 1].split(',') : [];
const stage = () => { if (!sceneFlags.length) return; for (const name of sceneFlags) c.read(c.player(), 'FlagBase').setBool(name, true, true, 0); c.frames(240); };
const restart = () => { c.restart(); c.frames(30); c.takeTravel(); stage(); };
stage();
c.frames(Number(args.includes('--settle') ? args[args.indexOf('--settle') + 1] : (mode === 'stand' ? 900 : 60)));   // a pawn with Sitting or Wandering orders walks to its place first
const target = c.actor(actorName);
if (!target) throw new Error(`no actor ${actorName} in ${map}`);
const aimOption = args.includes('--aim') ? args[args.indexOf('--aim') + 1].split(',').map(Number) : null;
const accept = new Set((args.includes('--accept') ? args[args.indexOf('--accept') + 1].split(',') : [actorName]));
const at = aimOption ?? c.pos(target);   // --aim x,y,z: aim and stand around this point instead of the actor's origin (a mover's origin is not where its face is)
const distance = option('distance', 200), lift = option('lift', 40), seconds = option('seconds', 2);
const yawUnits = bearing => Math.round(((bearing * 32768 / Math.PI) % 65536 + 65536) % 65536) % 65536;
const out = [];
if (mode === 'approach') {
  for (let k = 0; k < 8; k++) {
    const bearing = k * Math.PI / 4, from = [Math.round(at[0] + Math.cos(bearing) * distance), Math.round(at[1] + Math.sin(bearing) * distance), Math.round(at[2] + lift)];
    if (!c.inWorld(from)) { out.push({ k, from, note: 'outside the world' }); continue; }
    restart();
    const view = [0, yawUnits(bearing + Math.PI)];
    for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at: from, view })]) { typeLine(c, line); c.frames(20); }
    c.frames(60);
    const landed = c.pos(c.player()).map(v => Math.round(v * 10) / 10);
    c.game.inputKey('ArrowUp', true);
    let request = null;
    for (let n = 0; n < seconds * 60 && !request; n += 5) { c.frames(5); request = c.takeTravel(); }
    c.game.inputKey('ArrowUp', false);
    out.push({ k, from, view, landed, walked: c.pos(c.player()).map(Math.round), request: request ? `${request.map}${request.portal ? `#${request.portal}` : ''}` : null, conPlay: c.read(c.player(), 'conPlay')?.name ?? null });
  }
}
if (mode === 'drop') {
  // a placement above the actor's cylinder: the fall enters it (a Touch comes from a move into the cylinder, a placement inside raises none)
  const radius = c.read(target, 'CollisionRadius'), height = c.read(target, 'CollisionHeight'), eyeHeight = c.game.player.baseEyeHeight;
  const lifts = (args.includes('--lifts') ? args[args.indexOf('--lifts') + 1].split(',').map(Number) : [50, 70, 100]);
  const view = [0, args.includes('--yaw') ? Number(args[args.indexOf('--yaw') + 1]) : 0];
  for (const lift of lifts) {
    const from = [Math.round(at[0]), Math.round(at[1]), Math.round(at[2] + height + lift)];
    if (!c.inWorld(from)) { out.push({ lift, from, note: 'outside the world' }); continue; }
    restart();
    const before = c.read(c.player(), 'DataLinkPlay');
    for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at: from, view, drop: true })]) { typeLine(c, line); c.frames(10); }
    let request = null;
    for (let n = 0; n < 240 && !request; n += 10) { c.frames(10); request = c.takeTravel(); }
    out.push({ lift, from, view, landed: c.pos(c.player()).map(v => Math.round(v * 10) / 10), request: request ? `${request.map}${request.portal ? `#${request.portal}` : ''}` : null,
      datalink: Boolean(c.read(c.player(), 'DataLinkPlay')) && !before });
  }
}
if (mode === 'stand') {
  // places at a distance from an actor with a clear line from the eye to it (a conversation's NPC must see... be seen: it is rendered when the view shows it), landed first, aimed from the landed eye
  const { fastLineCheck } = await import('../src/runtime/fast-line-check.mjs');
  const eyeHeight = c.game.player.baseEyeHeight, unit = 32768 / Math.PI;
  const distances = (args.includes('--distances') ? args[args.indexOf('--distances') + 1].split(',').map(Number) : [60, 90, 120]);
  const height = c.read(target, 'CollisionHeight') ?? 40;
  const level = c.level(), check = (a, b) => (level.fastLineCheck ?? fastLineCheck)(level.model, a, b);
  for (const d of distances) for (let k = 0; k < 8; k++) {
    const bearing = k * Math.PI / 4;
    const from = [Math.round(at[0] + Math.cos(bearing) * d), Math.round(at[1] + Math.sin(bearing) * d), Math.round(at[2] + lift)];
    if (!c.inWorld(from)) continue;
    const aim = z => { const dx = at[0] - from[0], dy = at[1] - from[1], dz = at[2] - (z + eyeHeight), horizontal = Math.hypot(dx, dy); return [Math.round(Math.atan2(dz, horizontal) * unit), yawUnits(Math.atan2(dy, dx))]; };
    restart();
    for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at: from, view: aim(from[2]) })]) { typeLine(c, line); c.frames(10); }
    c.frames(60);
    const here = c.pos(c.player()), floor = here[2];
    if (Math.abs(floor - at[2]) > 60) { out.push({ d, k, from, floor: Math.round(floor), note: 'another level' }); continue; }
    const eye = [here[0], here[1], floor + eyeHeight], clear = check(eye, [at[0], at[1], at[2] + height * 0.5]);
    out.push({ d, k, at: [from[0], from[1], Math.round(floor + 1)], view: aim(floor), clear, zone: c.read(c.player(), 'Region')?.['engine.actor.pointregion.zonenumber'] });
  }
}
if (mode === 'face') {
  // places from which the view trace selects the actor: the eye is baseEyeHeight above the player's centre; pitch and yaw in rotator units
  const eyeHeight = c.game.player.baseEyeHeight, unit = 32768 / Math.PI;
  const distances = (args.includes('--distances') ? args[args.indexOf('--distances') + 1].split(',').map(Number) : [60, 90, 48]);
  const freeze = args.includes('--freeze');
  for (const d of distances) for (let k = 0; k < 8; k++) {
    const bearing = k * Math.PI / 4;
    const from = [Math.round(at[0] + Math.cos(bearing) * d), Math.round(at[1] + Math.sin(bearing) * d), Math.round(at[2] + lift)];
    if (!c.inWorld(from)) continue;
    const aim = z => { const dx = at[0] - from[0], dy = at[1] - from[1], dz = at[2] - (z + eyeHeight), horizontal = Math.hypot(dx, dy); return [Math.round(Math.atan2(dz, horizontal) * unit), yawUnits(Math.atan2(dy, dx))]; };
    // first pass: where the player lands (the floor under the place); the second places him there, aimed from the landed eye
    restart();
    for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at: from, view: aim(from[2]) })]) { typeLine(c, line); c.frames(10); }
    c.frames(60);
    const floor = c.pos(c.player())[2];
    from[2] = Math.round(floor + 1);
    const view = aim(floor);
    restart();
    if (args.includes('--before')) {
      typeLine(c, 'set DeusEx.JCDentonMale bCheatsEnabled True');
      for (const line of args[args.indexOf('--before') + 1].split(';')) { typeLine(c, line.trim()); c.frames(240); }
    }
    c.watched.add(target);
    if (freeze) { typeLine(c, 'set DeusEx.JCDentonMale bCheatsEnabled True'); typeLine(c, 'set LevelInfo bPlayersOnly True'); c.frames(5); }
    for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at: from, view })]) { typeLine(c, line); c.frames(20); }
    c.frames(60);
    const landed = c.pos(c.player()).map(v => Math.round(v * 10) / 10);
    const picked = c.game.interaction.frobTarget;
    const hit = picked ? accept.has(picked.name) : false;
    out.push({ d, k, from, view, landed, target: picked?.name ?? null, hit });
    if (hit && !args.includes('--all')) break;
  }
}
for (const row of out) console.log(JSON.stringify(row));
process.exit(0);
