#!/usr/bin/env node
/** Rehearse a live capture's input list in Play, headless, before taking the CrossOver bottle (docs/stage-5-exit-criteria.md "First original captures").
 *
 * The lines are the ones live-acceptance.mjs takes: --early "line|line" (typed in the original's frozen phase: KillAll, ghost, a SET of Location, walk,
 * a SET of ViewRotation) and --cmds "N:line|N:@down Enter|..." (after N unfrozen ticks; a `@down`/`@up` is a key edge through the User.ini binding). Every
 * line goes through Play's console command chain (viewProbe exec), key edges through game.inputKey. It prints, whenever it changes and every 60 ticks, the
 * named pawns' state, Enemy and Health, and the player's Health, hit regions, inHand and FrobTarget: whether a pickup's look-down selects the item, whether a
 * shot fires (the pistol's refire time swallows a press 30 ticks after the last), whether the pawns see the player. Class P: Play against itself, a rehearsal,
 * never evidence (the original's stream, deltas and frozen phase differ).
 *
 *   node scripts/stage5-capture-rehearsal.mjs --scene cmb1 [--ticks 900] [--pawns Terrorist0,ThugMale7,Terrorist10]
 *   node scripts/stage5-capture-rehearsal.mjs --map 01_NYC_UNATCOIsland --early "..." --cmds "..." [--ticks 900] */
import {readdir, readFile} from 'node:fs/promises';
import {SCENES} from './validate-stage5-live.mjs';
import './census-stage5-drivers.mjs';   // the census's deterministic clock (Date and performance.now follow the simulated frames)
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {openSession} from './census-stage5-session.mjs';
import {viewProbe} from '../src/viewer/view-probe.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const scene = option('scene', null) ? SCENES[option('scene')] : null;
if (option('scene', null) && !scene) { console.error(`--scene ${Object.keys(SCENES).join('|')}`); process.exit(2); }
const map = scene?.map ?? option('map', '01_NYC_UNATCOIsland');
const ticks = Number(option('ticks', scene?.ticks ?? 900));
const early = (scene?.early ?? option('early', '')).split('|').filter(Boolean);
const cmds = new Map();
for (const entry of (scene?.cmds ?? option('cmds', '')).split('|').filter(Boolean)) {
  const i = entry.indexOf(':'), n = Number(entry.slice(0, i));
  cmds.set(n, [...(cmds.get(n) ?? []), entry.slice(i + 1)]);
}

const gameRoot = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${gameRoot}/${directory}`)) files.push({path: `${directory}/${name}`, read: () => readFile(`${gameRoot}/${directory}/${name}`)});
const {c} = await openSession(map, new AssetStore(files));
// The capture's frozen phase: the map is opened with bPlayersOnly set, the early lines are typed into the held level (live-acceptance.mjs original), and
// the pawns start at the release; the frames before it are the player's alone, as here.
const info = c.level().actors[0];
c.runtime.writeNamed(info, 'bPlayersOnly', true);
c.frames(30); c.runtime.writeNamed(c.player(), 'bCheatsEnabled', true);
const r = v => v.map(x => Math.round(x * 10) / 10);
const exec = line => { const out = c.game.hud.scoped(() => viewProbe(c.game, {exec: [line]}).output[0]); console.log(`> ${line}`, out ? JSON.stringify(out).slice(0, 120) : ''); };
for (const line of early) exec(line);
c.frames(60);
c.runtime.writeNamed(info, 'bPlayersOnly', false);
const p = c.player();
console.log('placed', r(c.pos(p)), 'physics', c.read(p, 'Physics'), 'zone', c.read(p, 'Region')?.['engine.actor.pointregion.zonenumber'], 'state', c.state(p), 'view', c.read(p, 'ViewRotation'));
const pawns = option('pawns', 'Terrorist0,ThugMale7,Terrorist10').split(',').map(name => c.actor(name)).filter(Boolean);
// A scene's devices (validate-stage5-live.mjs `devices`, Name:Class; --devices for an ad-hoc list): stamped every frame as the renderer's feedback would stamp
// what the player looks at (a headless frame draws no mesh, and a stasis device would never tick), and their state printed with the pawns'. A device the level
// does not hold yet (a summoned tool) is looked up again every tick.
const DEVICE_SUMMARY = {SecurityCamera: ['bPlayerSeen', 'bTrackPlayer', 'bEventTriggered', 'triggerTimer'], AutoTurret: ['bActive', 'curTarget', 'HitPoints'],
  AutoTurretGun: ['HitPoints'], LaserTrigger: ['lastAlarmTime', 'LastHitActor', 'bIsOn'], LaserEmitter: ['HitActor'], ControlPanel: ['bHacking', 'hackStrength'],
  AlarmUnit: ['bActive', 'alarmInstigator'], Multitool: ['NumCopies', 'bBeingUsed'], Decoration: ['HitPoints'], DeusExMover: ['doorStrength', 'bDestroyed', 'KeyNum'],
  Robot: ['EMPHitPoints', 'crazedTimer']};
const devices = (scene?.devices ?? option('devices', '').split(',').filter(Boolean)).map(entry => { const [name, rest] = entry.split(':'), [cls, via] = rest.split('@'); return {name, cls, via}; });
const deviceActor = d => d.via ? (owner => owner ? c.read(owner, d.via.split('.')[1]) : null)(c.actor(d.via.split('.')[0]))
  : c.actor(d.name) ?? c.actors().find(a => a.name.toLowerCase() === d.name.toLowerCase());
const short = v => typeof v === 'number' ? Math.round(v * 100) / 100 : typeof v === 'boolean' ? Number(v) : v?.name ?? v;
const regions = ['HealthHead', 'HealthTorso', 'HealthLegLeft', 'HealthLegRight', 'HealthArmLeft', 'HealthArmRight'];
let last = '';
for (let tick = 1; tick <= ticks; tick++) {
  for (const line of cmds.get(tick - 1) ?? []) {
    if (!line) continue;
    const edge = /^@(down|up) (\S+)$/.exec(line);
    if (edge) { c.game.inputKey(edge[2], edge[1] === 'down'); console.log(`> ${line} after ${tick - 1}`); } else exec(line);
  }
  // (a destroyed device leaves the stamped set before its release: the renderer stamps nothing that is gone)
  for (const a of [...c.watched]) if (c.runtime.isReleased?.(a) || c.gone(a)) c.watched.delete(a);
  for (const d of devices) { const a = deviceActor(d); if (a && !c.gone(a)) c.watched.add(a); }
  try { c.frames(1); } catch (error) { console.log(`tick ${tick}: ${error.message.split('\n')[0]}`); break; }
  // (a pawn's NumCarcasses when it has seen a body, and its SeekType while it seeks: 1 sound, 2 sight, 3 guess, 4 carcass, ScriptedPawn.ESeekType)
  const line = pawns.map(a => c.gone(a) ? `${a.name}:gone` : `${a.name}:${c.state(a).split('.').pop()}/${c.read(a, 'Enemy')?.name ?? '-'}/h${c.read(a, 'Health')}`
    + `${c.read(a, 'NumCarcasses') ? `/bodies${c.read(a, 'NumCarcasses')}` : ''}${/seeking/i.test(c.state(a)) ? `/seek${c.read(a, 'SeekType')}` : ''}`).join(' ')
    + ` | player h${c.read(p, 'Health')} [${regions.map(n => c.read(p, n)).join(',')}] ${c.state(p).split('.').pop()} inHand=${c.read(p, 'inHand')?.name ?? '-'}`
    + ` frob=${c.read(p, 'FrobTarget')?.name ?? '-'} tracers=${c.byClass('Tracer').length}`
    + (scene?.flags ?? option('flags', 'StatueAlarmTriggered').split(',')).filter(Boolean).map(f => ` ${f}=${Number(c.flag(f.toLowerCase()))}`).join('')
    // --props "Name=Prop,Prop;Name2=..." (Name @weapon: the player's Weapon): more fields printed with the line
    + (option('props', '') ?? '').split(';').filter(Boolean).map(spec => { const [name, list] = spec.split('='); const a = name === '@weapon' ? c.read(p, 'Weapon') : c.actor(name);
      return ` ${name}:${a ? `${c.state(a).split('.').pop()}/${list.split(',').map(n => short(c.read(a, n))).join('/')}` : '-'}`; }).join('')
    + devices.map(d => { const a = deviceActor(d); return !a ? ` ${d.name}:-` : c.gone(a) ? ` ${d.name}:gone` : ` ${d.name}:${c.state(a).split('.').pop()}/${(DEVICE_SUMMARY[d.cls] ?? []).map(n => short(c.read(a, n))).join('/')}`; }).join('');
  if (line !== last || tick % 60 === 0) { console.log(tick, line); last = line; }
}
for (const a of pawns) console.log('end', a.name, c.gone(a) ? 'gone' : r(c.pos(a)), c.gone(a) ? '' : c.read(a, 'Rotation'));
console.log('carcasses', c.actors().filter(a => c.isA(a, 'deusex.deusexcarcass')).map(a => {
  const items = []; for (let i = c.read(a, 'Inventory'); i && items.length < 32; i = c.read(i, 'Inventory')) items.push(i.name);
  return items.length ? `${a.name}[${items.join(',')}]` : a.name;
}).join(' '));
process.exit(0);
