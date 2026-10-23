/** Planner of the Stage 6 chain harness (docs/stage-6-chains.md): finds the placements a chain step needs, in Play's world, and prints them as chain data.
 * A placement is a harness step; the planner only chooses where, so that the original and Play are given the same numbers.
 *
 *   node scripts/chain-plan.mjs approach <map> <actor> [--distance D] [--seconds S] [--lift L]    walk into an actor's cylinder (a Teleporter, a MapExit, a trigger):
 *                                                                                                  the bearings from which a held forward key reaches it
 *   node scripts/chain-plan.mjs drop <map> <actor> [--lifts 50,70] [--yaw N]                       placements above the cylinder: the fall enters it (a placement inside raises no Touch)
 *   node scripts/chain-plan.mjs stand <map> <actor> [--distances 60,90] [--lift L] [--settle F]                  places at a distance from the actor with a clear line to it, aimed at it
 *   node scripts/chain-plan.mjs face <map> <actor> [--distances 60,90] [--lift L] [--freeze] [--all]  the places from which the view trace selects the actor (frob)
 */
import { fileURLToPath } from 'node:url';
import { loadAssets, typeLine } from './chain-play.mjs';
import { openSession } from './census-stage5-session.mjs';
import { placeLines } from './chain-lib.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : Number(args[i + 1]); };
const [mode, map, actorName] = args;
const assets = await loadAssets();
const { c, run } = await openSession(map, assets, { travel: {} });
c.frames(Number(args.includes('--settle') ? args[args.indexOf('--settle') + 1] : (mode === 'stand' ? 900 : 60)));   // a pawn with Sitting or Wandering orders walks to its place first
const target = c.actor(actorName);
if (!target) throw new Error(`no actor ${actorName} in ${map}`);
const at = c.pos(target);
const distance = option('distance', 200), lift = option('lift', 40), seconds = option('seconds', 2);
const yawUnits = bearing => Math.round(((bearing * 32768 / Math.PI) % 65536 + 65536) % 65536) % 65536;
const out = [];
if (mode === 'approach') {
  for (let k = 0; k < 8; k++) {
    const bearing = k * Math.PI / 4, from = [Math.round(at[0] + Math.cos(bearing) * distance), Math.round(at[1] + Math.sin(bearing) * distance), Math.round(at[2] + lift)];
    if (!c.inWorld(from)) { out.push({ k, from, note: 'outside the world' }); continue; }
    c.restart(); c.frames(30); c.takeTravel();
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
    c.restart(); c.frames(30); c.takeTravel();
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
    c.restart(); c.frames(30); c.takeTravel();
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
    c.restart(); c.frames(30); c.takeTravel();
    for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at: from, view: aim(from[2]) })]) { typeLine(c, line); c.frames(10); }
    c.frames(60);
    const floor = c.pos(c.player())[2];
    from[2] = Math.round(floor + 1);
    const view = aim(floor);
    c.restart(); c.frames(30); c.takeTravel();
    c.watched.add(target);
    if (freeze) { typeLine(c, 'set DeusEx.JCDentonMale bCheatsEnabled True'); typeLine(c, 'set LevelInfo bPlayersOnly True'); c.frames(5); }
    for (const line of ['set DeusEx.JCDentonMale bCheatsEnabled True', ...placeLines({ at: from, view })]) { typeLine(c, line); c.frames(20); }
    c.frames(60);
    const landed = c.pos(c.player()).map(v => Math.round(v * 10) / 10);
    const picked = c.game.interaction.frobTarget;
    out.push({ d, k, from, view, landed, target: picked?.name ?? null, hit: picked === target });
    if (picked === target && !args.includes('--all')) break;
  }
}
for (const row of out) console.log(JSON.stringify(row));
process.exit(0);
