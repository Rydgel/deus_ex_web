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
 *   node scripts/stage5-capture-rehearsal.mjs --scene cmb1 [--ticks 900] [--pawns Terrorist0,ThugMale7,Terrorist10] [--classes LAM,Tracer]
 *   node scripts/stage5-capture-rehearsal.mjs --map 01_NYC_UNATCOIsland --early "..." --cmds "..." [--ticks 900] */
import {readdir, readFile} from 'node:fs/promises';
import {SCENES} from './validate-stage5-live.mjs';
import './census-stage5-drivers.mjs';   // the census's deterministic clock (Date and performance.now follow the simulated frames)
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {openSession} from './census-stage5-session.mjs';
import {viewProbe} from '../src/viewer/view-probe.mjs';
import {typedCharacters, keyOfCode} from '../src/viewer/typed-characters.mjs';

const flagArg = name => process.argv.includes(`--${name}`);
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
// The capture opens the map directly, which leaves the player's FlagBase empty; Play's login adds PlayerTraveling, so the replay deletes it before the first
// frame (live-acceptance.mjs play): the same here, or Mission01's first Timer would run FirstFrame.
{ const base = c.read(c.player(), 'FlagBase'), call = ['PlayerTraveling', 0]; c.runtime.callFunction(c.runtime.lookup(base, 'DeleteFlag'), base, call.length, i => call[i]); }
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
const pawns = option('pawns', scene?.pawns?.join(',') ?? 'Terrorist0,ThugMale7,Terrorist10').split(',').map(name => c.actor(name)).filter(Boolean);
// A scene's devices (validate-stage5-live.mjs `devices`, Name:Class; --devices for an ad-hoc list): stamped every frame as the renderer's feedback would stamp
// what the player looks at (a headless frame draws no mesh, and a stasis device would never tick), and their state printed with the pawns'. A device the level
// does not hold yet (a summoned tool) is looked up again every tick.
const DEVICE_SUMMARY = {SecurityCamera: ['bPlayerSeen', 'bTrackPlayer', 'bEventTriggered', 'triggerTimer'], AutoTurret: ['bActive', 'curTarget', 'HitPoints'],
  AutoTurretGun: ['HitPoints'], LaserTrigger: ['lastAlarmTime', 'LastHitActor', 'bIsOn'], LaserEmitter: ['HitActor'], ControlPanel: ['bHacking', 'hackStrength'],
  AlarmUnit: ['bActive', 'alarmInstigator'], Multitool: ['NumCopies', 'bBeingUsed'], Decoration: ['HitPoints'], DeusExMover: ['doorStrength', 'bDestroyed', 'KeyNum'],
  Robot: ['EMPHitPoints', 'crazedTimer']};
// (the routes' devices: a door's lock and pick, the arcs, a Lockpick, a button; and what --player-view/--player-talk compare: the player's Energy and DataLink)
Object.assign(DEVICE_SUMMARY, {RepairBot: ['lastChargeTime'], MedicalBot: ['lastHealTime'], ATM: ['$atmBalance0', 'bLockedOut'], Computers: ['bOn', 'bAnimating']});
Object.assign(DEVICE_SUMMARY, {DeusExMover: [...DEVICE_SUMMARY.DeusExMover, 'bLocked', 'lockStrength', 'bPicking', 'bInterpolating'], ElectricityEmitter: ['bIsOn', 'lastHitActor'],
  DamageTrigger: ['bIsOn', 'damagee'], Projectile: ['bTracking', 'Target', 'Velocity'], Lockpick: ['NumCopies', 'bBeingUsed'], Actor: []});
const talk = () => ` energy=${short(c.read(p, 'Energy'))} dl=${c.read(p, 'DataLinkPlay')?.name ?? '-'} con=${c.read(p, 'conPlay')?.name ?? '-'}`;
const devices = (scene?.devices ?? option('devices', '').split(',').filter(Boolean)).map(entry => { const [name, rest] = entry.split(':'), [cls, via] = rest.split('@'); return {name, cls, via}; });
const deviceActor = d => d.via ? (owner => owner ? c.read(owner, d.via.split('.')[1]) : null)(c.actor(d.via.split('.')[0]))
  : c.actor(d.name) ?? c.actors().find(a => a.name.toLowerCase() === d.name.toLowerCase());
const readDevice = (a, n) => n.startsWith('$atmBalance') ? Object.entries(c.read(a, 'userList')[Number(n.slice(11))]).find(([k]) => k.endsWith('.balance'))?.[1] : c.read(a, n);
const short = v => typeof v === 'number' ? Math.round(v * 100) / 100 : typeof v === 'boolean' ? Number(v) : v?.name ?? v;
// A conversation scene also prints, whenever it changes: the player's ConPlay, its state and current event (class and label, a speech's speaker and first
// words), the choices the third-person window shows, the player's skill points and Inventory chain, the flags, and the named pawns' Alliance and Orders.
const named = (v, n = 'name') => Array.isArray(v) ? v.map(x => typeof x === 'number' ? Math.round(x * 10) / 10 : x) : v && typeof v === 'object' ? v[n] ?? v.name : v;
const conLine = () => {
  const conPlay = c.read(p, 'conPlay'), base = c.read(p, 'FlagBase');
  let con = '-';
  if (conPlay) {
    const event = c.read(conPlay, 'currentEvent'), cls = event ? c.runtime.instance(event).cls.record.key.split('.').pop().replace('conevent', '') : '-';
    const speech = cls === 'speech' ? `${c.read(event, 'speakerName')}:"${String(c.read(c.read(event, 'conSpeech'), 'speech')).slice(0, 24)}"` : '';
    const window = c.read(conPlay, 'conWinThird');
    con = `${conPlay.name} ${String(c.read(c.read(conPlay, 'con'), 'conName'))} ${c.state(conPlay).split('.').pop()} ${cls}${event && c.read(event, 'label') ? `@${c.read(event, 'label')}` : ''} ${speech}${window ? ` choices=${c.read(window, 'numChoices')}` : ''}`;
  }
  const items = []; for (let i = c.read(p, 'Inventory'); i && items.length < 32; i = c.read(i, 'Inventory')) items.push(i.name);
  const flags = [...(base?.entries?.values() ?? [])].map(e => `${e.name}=${e.type ? e.value : e.value ? 1 : 0}`).sort().join(' ');
  return `con ${con} | sp${c.read(p, 'SkillPointsAvail')} cr${c.read(p, 'Credits')} inv[${items.join(',')}] goal=${c.read(p, 'FirstGoal')?.name ?? '-'} image=${c.read(p, 'FirstImage')?.name ?? '-'}`
    + ` | ${pawns.map(a => c.gone(a) ? `${a.name}:gone` : `${a.name}:${named(c.read(a, 'Alliance'))}/${named(c.read(a, 'Orders'))}${extraProps.map(n => { try { return `/${n}=${JSON.stringify(named(c.read(a, n)))}`; } catch { return ''; } }).join('')}`).join(' ')} | flags ${flags}`;
};
let lastCon = '';
// A conversation scene's pawns near the player (1,500 units) are stamped as the renderer stamps an actor in view (the census's render feedback,
// census-stage5-session.mjs): a headless frame draws no mesh, so LastRenderTime would age past ScriptedPawn.Tick's low-priority window and no radius
// conversation would start (the capture and the replay render). A far pawn stays unstamped: stamped, it would leave stasis (BumFemale0 got up and wandered).
const stampNear = () => { for (const a of pawns) { if (c.gone(a)) { c.watched.delete(a); continue; } const d = Math.hypot(...c.pos(a).map((v, i) => v - c.pos(p)[i])); if (d < 1500) c.watched.add(a); else c.watched.delete(a); } };
// --props a,b: more properties of the named pawns on the conversation line (a frob that starts nothing: bInterruptState, bCanConverse, Physics); an entry
// with `=` is the device scenes' "Name=Prop,Prop;..." form, printed on the main line
const extraProps = (option('props', '') ?? '').includes('=') ? [] : (option('props', '') ?? '').split(',').filter(Boolean);
const regions = ['HealthHead', 'HealthTorso', 'HealthLegLeft', 'HealthLegRight', 'HealthArmLeft', 'HealthArmRight'];
// --window: the top modal window and the root's focus window on the line (a window scene: which button holds the focus when a key edge arrives)
const rootWindow = flagArg('window') ? c.runtime.namedReference(p, 'rootWindow').get() : null, W = flagArg('window') ? c.game.hud.host.W : null;
const windowName = o => o ? c.runtime.instance(o).cls.record.name : '-';
const windowLine = () => { if (!rootWindow) return ''; const f = W.ptr(rootWindow, 0x5c8), label = f ? (() => { try { return String(c.read(f, 'buttonText') ?? '').replace(/[|&\s]+/g, ' ').trim(); } catch { return ''; } })() : '';
  return ` win=${windowName(c.topModal())}/${windowName(f)}${label ? `[${label}]` : ''}`; };
let last = '';
for (let tick = 1; tick <= ticks; tick++) {
  for (const line of cmds.get(tick - 1) ?? []) {
    if (!line) continue;
    const edge = /^@(down|up) (\S+)$/.exec(line), typed = /^@type (.+)$/.exec(line);
    // (`@type TEXT`: WM_CHAR units; a key edge's own WM_CHAR is TranslateMessage's, as live-probe.mjs delivers it with --typed-chars, which the rehearsal always does)
    if (typed) { for (const char of typed[1]) c.game.inputChar(char.charCodeAt(0)); console.log(`> ${line} after ${tick - 1}`); }
    else if (edge) {
      c.game.inputKey(edge[2], edge[1] === 'down'); console.log(`> ${line} after ${tick - 1}`);
      const key = edge[1] === 'down' ? keyOfCode(edge[2]) : null;
      if (key !== null) for (const unit of typedCharacters({key})) c.game.inputChar(unit);
    } else exec(line);
  }
  // (a destroyed device leaves the stamped set before its release: the renderer stamps nothing that is gone)
  for (const a of [...c.watched]) if (c.runtime.isReleased?.(a) || c.gone(a)) c.watched.delete(a);
  for (const d of devices) { const a = deviceActor(d); if (a && !c.gone(a)) c.watched.add(a); }
  if (scene?.conversation) stampNear();
  const gcTrace = (process.env.GC_TRACE ?? '').split(':').map(Number);
  globalThis.__gcAllocLog = gcTrace.length === 2 && tick >= gcTrace[0] && tick <= gcTrace[1] ? (globalThis.__gcAllocLog ?? []) : null;
  try { c.frames(1); } catch (error) { console.log(`tick ${tick}: ${error.message.split('\n')[0]}`); break; }
  if (globalThis.__gcAllocLog?.length) { console.log(`gc allocs at ${tick}:`); for (const {stack: s} of globalThis.__gcAllocLog) console.log('  ' + s.split('\n').slice(2, 16).map(l => l.trim().replace(/^at /, '').replace(/\(file:\S*\/(src|scripts)\//, '(')).join(' < ')); globalThis.__gcAllocLog = []; }
  // (a pawn's NumCarcasses when it has seen a body, and its SeekType while it seeks: 1 sound, 2 sight, 3 guess, 4 carcass, ScriptedPawn.ESeekType)
  const line = pawns.map(a => c.gone(a) ? `${a.name}:gone` : `${a.name}:${c.state(a).split('.').pop()}/${c.read(a, 'Enemy')?.name ?? '-'}/h${c.read(a, 'Health')}`
    + `${c.read(a, 'NumCarcasses') ? `/bodies${c.read(a, 'NumCarcasses')}` : ''}${/seeking/i.test(c.state(a)) ? `/seek${c.read(a, 'SeekType')}` : ''}`).join(' ')
    + ` | player h${c.read(p, 'Health')} [${regions.map(n => c.read(p, n)).join(',')}] ${c.state(p).split('.').pop()} @${c.pos(p).map(Math.round)} inHand=${c.read(p, 'inHand')?.name ?? '-'}`
    + ` frob=${c.read(p, 'FrobTarget')?.name ?? '-'} tracers=${c.byClass('Tracer').length}${talk()} credits=${c.read(p, 'Credits')}`
    + (scene?.flags ?? option('flags', 'StatueAlarmTriggered').split(',')).filter(Boolean).map(f => ` ${f}=${Number(c.flag(f.toLowerCase()))}`).join('')
    // --props "Name=Prop,Prop;Name2=..." (Name @weapon: the player's Weapon; @player: the player): more fields printed with the line
    + (option('props', '') ?? '').split(';').filter(spec => spec.includes('=')).map(spec => { const [name, list] = spec.split('='); const a = name === '@weapon' ? c.read(p, 'Weapon') : name === '@player' ? p : c.actor(name);
      return ` ${name}:${a ? `${c.state(a).split('.').pop()}/${list.split(',').map(n => short(c.read(a, n))).join('/')}` : '-'}`; }).join('')
    + windowLine()
    // --classes LAM,Tracer: every actor of those classes (a placed LAM, a flying projectile): name, state and position, printed with the line
    + (option('classes', '') ?? '').split(',').filter(Boolean).map(cls => c.byClass(cls).map(a => ` ${a.name}:${c.state(a).split('.').pop()}@${c.pos(a).map(Math.round)}`).join('')).join('')
    + devices.map(d => { const a = deviceActor(d); return !a ? ` ${d.name}:-` : c.gone(a) ? ` ${d.name}:gone` : ` ${d.name}:${c.state(a).split('.').pop()}/${(DEVICE_SUMMARY[d.cls] ?? []).map(n => short(readDevice(a, n))).join('/')}`; }).join('');
  if (line !== last || tick % 60 === 0) { console.log(tick, line); last = line; }
  if (scene?.conversation || flagArg('con')) { const now = conLine(); if (now !== lastCon) { console.log(tick, now); lastCon = now; } }
}
for (const a of pawns) console.log('end', a.name, c.gone(a) ? 'gone' : r(c.pos(a)), c.gone(a) ? '' : c.read(a, 'Rotation'));
console.log('carcasses', c.actors().filter(a => c.isA(a, 'deusex.deusexcarcass')).map(a => {
  const items = []; for (let i = c.read(a, 'Inventory'); i && items.length < 32; i = c.read(i, 'Inventory')) items.push(i.name);
  return items.length ? `${a.name}[${items.join(',')}]` : a.name;
}).join(' '));
process.exit(0);
