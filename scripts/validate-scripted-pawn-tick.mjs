#!/usr/bin/env node
/* Validates src/runtime/scripted-pawn-tick.mjs against the original AScriptedPawn::Tick (DeusEx.dll 0x100195a0) and its helpers
 * 0x10019e30 / 0x10019f60, executed from the real bytes by scripts/native-scripted-pawn-tick-oracle.py (Unicorn; the leaves are
 * the Super tick, InStasis, the level's DestroyActor, FName/FindFunctionChecked and ProcessEvent, which the oracle records).
 * Each scene runs on both sides; every field the function can write is compared at float32-bit precision, with the events
 * (name, parameter), the calls in order (InStasis, FindFunctionChecked, DestroyActor, the Super tick's arguments) and the
 * returned value. Then each mutant of the module must fail the scene that covers it.
 *
 *   node scripts/validate-scripted-pawn-tick.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modulePath = path.join(root, 'src/runtime/scripted-pawn-tick.mjs');
const python = process.env.NATIVE_PROBE_PYTHON || path.join(root, '.cache/native-probe-env/bin/python');
const oracle = path.join(root, 'scripts/native-scripted-pawn-tick-oracle.py');
if (!existsSync(python)) { console.log(`SKIP validate-scripted-pawn-tick: no probe python at ${python}`); process.exit(0); }
const module = await import(pathToFileURL(modulePath));
const f32 = Math.fround;

// --- the scenes ---------------------------------------------------------------------------------------------------------------
let seed = 0x5eed1234;
const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rnd = (lo, hi) => f32(lo + (hi - lo) * random());
const BASE = { Role: 4, RemoteRole: 0, Physics: 1, LastRenderTime: 99.5, DistanceFromPlayer: 300 };
const scenes = [];
const add = (name, fields = {}, extra = {}) => scenes.push({ name, fields: { ...BASE, ...fields }, delta: f32(1 / 60), tickType: 2, time: 100, ...extra });
const DT = [f32(1 / 60), f32(0.05), f32(0.001), f32(0.4)];

add('idle');
add('idle-dt-long', {}, { delta: f32(0.4) });
// role / tick type gate, then bSimulatedPawn
for (const [role, remote, tickType] of [[4, 3, 2], [1, 0, 2], [4, 0, 1], [2, 0, 2]])
  for (const simulated of [false, true])
    add(`gate-role${role}-remote${remote}-type${tickType}-sim${simulated}`, { Role: role, RemoteRole: remote, bSimulatedPawn: simulated, AlarmTimer: 1, FireTimer: 1, bDisappear: true }, { tickType });
// the simple countdown timers (guarded, clamped)
const guarded = ['FireTimer', 'SpecialTimer', 'AvoidWallTimer', 'AvoidBumpTimer', 'ObstacleTimer', 'CloakEMPTimer', 'TakeHitTimer',
  'CarcassCheckTimer', 'BeamCheckTimer', 'FutzTimer', 'PlayerAgitationTimer', 'AgitationCheckTimer'];
const values = [-0.5, 0, 0.001, f32(1 / 60), 0.02, 0.5, 1.5, 7.25, 100000.5];
for (const name of guarded) for (const v of values) add(`timer-${name}-${v}`, { [name]: f32(v) });
for (const v of values) add(`alarm-${v}`, { AlarmTimer: f32(v) });
for (const v of values) { add(`reload-weapon-${v}`, { ReloadTimer: f32(v), Weapon: 1 }); add(`reload-noweapon-${v}`, { ReloadTimer: f32(v) }); }
for (const v of [0, 0.5, 3.25, -1]) { add(`weapontimer-weapon-${v}`, { WeaponTimer: f32(v), Weapon: 1 }); add(`weapontimer-noweapon-${v}`, { WeaponTimer: f32(v) }); }
for (const v of [-0.1, 0, 0.001, 0.0166, 0.02, 1.2]) {
  add(`potential-enemy-${v}`, { PotentialEnemyTimer: f32(v), PotentialEnemyAlliance: 0x1234 });
}
for (const [timer, sustain] of [[-1, 5], [0, 5], [1, 5], [4.99, 5], [5, 5], [9, 5], [0.3, 0.2]])
  add(`distress-${timer}-${sustain}`, { DistressTimer: f32(timer), FearSustainTime: f32(sustain) });
// PrePivot easing
for (const time of [0, -1, 0.005, f32(1 / 60), 0.0167, 0.1, 2.5]) {
  add(`prepivot-${time}`, { PrePivotTime: f32(time), PrePivot: [rnd(-20, 20), rnd(-20, 20), rnd(-30, 30)], DesiredPrePivot: [rnd(-20, 20), rnd(-20, 20), rnd(-30, 30)] });
}
for (let i = 0; i < 20; i++) add(`prepivot-random-${i}`, { PrePivotTime: rnd(0.02, 3), PrePivot: [rnd(-50, 50), rnd(-50, 50), rnd(-50, 50)], DesiredPrePivot: [rnd(-50, 50), rnd(-50, 50), rnd(-50, 50)] }, { delta: DT[i % DT.length] });
// agitation and fear
for (const [timer, rate] of [[0, 0.3], [0.005, 0.3], [f32(1 / 60), 0.3], [0.5, 0.3], [2, 0.7], [-1, 0.5]]) {
  for (const changed of [false, true]) {
    const alliances = Array.from({ length: 16 }, (_, i) => ({ name: i % 3 === 0 ? 0 : 0x100 + i, level: rnd(-1, 1), agitation: i % 5 === 0 ? 0 : rnd(0, 2), permanent: i % 4 === 1 }));
    add(`agitation-${timer}-${rate}-${changed}`, { AgitationTimer: f32(timer), AgitationDecayRate: f32(rate), bAlliancesChanged: changed, AlliancesEx: alliances, AgitationCheckTimer: 0.5 });
  }
}
for (const [timer, rate, level] of [[0, 0.3, 1], [0.005, 0.3, 0.6], [f32(1 / 60), 0.5, 0.0001], [0.5, 0.3, 1], [2, 0.7, 0.9], [-1, 0.5, 0.4], [0, 0, 1], [0, 0.3, 0], [0.01, 0.9, 0.00001]])
  add(`fear-${timer}-${rate}-${level}`, { FearTimer: f32(timer), FearDecayRate: f32(rate), FearLevel: f32(level) });
// cloak, fire, avoidance
for (const [health, threshold] of [[100, 50], [50, 50], [10, 50], [-5, -3], [0, 0]]) add(`cloak-${health}-${threshold}`, { bHasCloak: true, Health: health, CloakThreshold: threshold });
add('no-cloak', { Health: 1, CloakThreshold: 100 });
for (const [burn, period] of [[0, 3], [2.9, 3], [2.99, 3], [3, 3], [10, 3], [0, 0.0166]]) add(`burn-${burn}-${period}`, { bOnFire: true, burnTimer: f32(burn), BurnPeriod: f32(period) });
add('burn-off', { burnTimer: 9, BurnPeriod: 3 });
for (const tactics of [false, true]) for (const physics of [1, 2, 4]) for (const turn of [0, 1, 2]) for (const acc of [[0, 0, 0], [100, 0, 0], [0, -20, 0], [0, 0, 5]]) {
  add(`tactics-${tactics}-p${physics}-t${turn}-a${acc.join('_')}`, { bAdvancedTactics: tactics, Physics: physics, TurnDirection: turn, NextDirection: 2, Acceleration: acc, MoveTimer: 6.29, ObstacleTimer: 1.5, ActorAvoiding: 0x4444 });
}
// bleeding
for (const rate of [0, 0.2, 0.9, 1, 5]) for (const bleeds of [false, true]) for (const velocity of [[0, 0, 0], [60, 0, 0], [300, 400, 0], [3, 4, 5], [1, 0, -2000]])
  add(`bleed-${rate}-${bleeds}-v${velocity.join('_')}`, { BleedRate: f32(rate), bCanBleed: bleeds, Velocity: velocity, ClotPeriod: 3, DropCounter: rnd(0, 0.5) });
for (let i = 0; i < 30; i++) add(`bleed-random-${i}`, { BleedRate: rnd(0.001, 1.5), bCanBleed: true, Velocity: [rnd(-500, 500), rnd(-500, 500), rnd(-200, 200)], ClotPeriod: rnd(0.5, 8), DropCounter: rnd(0, 2) }, { delta: DT[i % DT.length] });
add('bleed-tiny', { BleedRate: 0.00001, bCanBleed: true, ClotPeriod: 3 });
for (const [far, visible] of [[300, true], [1200, true], [1300, true], [5000, true], [5000, false]])
  add(`visible-only-${far}-${visible}`, { DistanceFromPlayer: far, bTickVisibleOnly: visible, BleedRate: 0.5, bCanBleed: true, ClotPeriod: 3, DropCounter: 3, Velocity: [30, 0, 0] });
// bDisappear
for (const stasis of [0, 1]) for (const [time, seen] of [[100, 99.5], [100, 95], [100, 94.99], [100, 101], [100, 40]])
  add(`disappear-stasis${stasis}-${time - seen}`, { bDisappear: true, LastRenderTime: seen }, { inStasis: stasis, time });
add('not-disappear-stale', { LastRenderTime: 1 });
// a full pawn
for (let i = 0; i < 30; i++) {
  const alliances = Array.from({ length: 16 }, (_, k) => ({ name: k % 2 ? 0x100 + k : 0, level: rnd(-1, 1), agitation: rnd(0, 2), permanent: k % 5 === 1 }));
  add(`mixed-${i}`, {
    AlarmTimer: rnd(0, 2), FireTimer: rnd(-1, 2), SpecialTimer: rnd(0, 2), ReloadTimer: rnd(0, 2), Weapon: i % 2, WeaponTimer: rnd(0, 4),
    AvoidWallTimer: rnd(0, 2), AvoidBumpTimer: rnd(0, 2), ObstacleTimer: rnd(0, 2), TakeHitTimer: rnd(0, 2),
    PrePivotTime: rnd(-1, 1), PrePivot: [rnd(-9, 9), rnd(-9, 9), rnd(-9, 9)], DesiredPrePivot: [rnd(-9, 9), rnd(-9, 9), rnd(-9, 9)],
    AgitationTimer: rnd(-1, 1), AgitationDecayRate: rnd(0, 1), bAlliancesChanged: i % 3 === 0, AlliancesEx: alliances,
    FearTimer: rnd(-1, 1), FearDecayRate: rnd(0, 1), FearLevel: rnd(0, 1),
    BleedRate: rnd(-0.2, 1), bCanBleed: i % 4 !== 0, Velocity: [rnd(-300, 300), rnd(-300, 300), 0], ClotPeriod: rnd(1, 5), DropCounter: rnd(0, 1),
    bAdvancedTactics: i % 2 === 0, TurnDirection: i % 3, Acceleration: i % 5 ? [10, 0, 0] : [0, 0, 0], MoveTimer: rnd(0, 6),
  }, { delta: DT[i % DT.length] });
}

// --- the oracle ---------------------------------------------------------------------------------------------------------------
const NAMES = ['PotentialEnemyAlliance'];
const toOracle = scene => {
  const fields = { ...scene.fields };
  const out = { fields, delta: scene.delta, tickType: scene.tickType, time: scene.time, inStasis: scene.inStasis ?? 0 };
  return out;
};
const text = execFileSync(python, [oracle], { input: JSON.stringify(scenes.map(toOracle)), maxBuffer: 1 << 28, env: { ...process.env, PYTHONWARNINGS: 'ignore' } }).toString();
const results = JSON.parse(text.slice(text.indexOf('[')));

// --- the JavaScript twin ------------------------------------------------------------------------------------------------------
const FLOATS = ['LastRenderTime', 'DistanceFromPlayer', 'MoveTimer', 'burnTimer', 'CarcassCheckTimer', 'PotentialEnemyTimer', 'BeamCheckTimer', 'ReloadTimer',
  'PrePivotTime', 'BleedRate', 'DropCounter', 'ClotPeriod', 'AgitationDecayRate', 'AgitationTimer', 'AgitationCheckTimer', 'PlayerAgitationTimer', 'FearSustainTime',
  'FearDecayRate', 'FearTimer', 'FearLevel', 'AlarmTimer', 'WeaponTimer', 'FireTimer', 'SpecialTimer', 'AvoidWallTimer', 'AvoidBumpTimer', 'ObstacleTimer',
  'TakeHitTimer', 'BurnPeriod', 'FutzTimer', 'DistressTimer', 'CloakEMPTimer'];
const VECTORS = ['Velocity', 'Acceleration', 'PrePivot', 'DesiredPrePivot'];
const BYTES = ['Physics', 'Role', 'RemoteRole', 'TurnDirection', 'NextDirection'];
const BOOLS = ['bSimulatedPawn', 'bAdvancedTactics', 'bOnFire', 'bAlliancesChanged', 'bCanBleed', 'bDisappear', 'bTickVisibleOnly', 'bClearedObstacle', 'bHasCloak'];
const INTS = ['Health', 'CloakThreshold', 'PotentialEnemyAlliance', 'Weapon', 'ActorAvoiding'];
const word = v => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); return b.getUint32(0, true).toString(16).padStart(8, '0'); };
const key = field => `deusex.scriptedpawn.allianceinfoex.${field}`;

function runTwin(scene, mod) {
  const store = {};
  for (const name of FLOATS) store[name] = 0;
  for (const name of VECTORS) store[name] = [0, 0, 0];
  for (const name of BYTES) store[name] = 0;
  for (const name of BOOLS) store[name] = false;
  for (const name of INTS) store[name] = 0;
  store.AlliancesEx = Array.from({ length: 16 }, () => ({ [key('alliancename')]: 0, [key('alliancelevel')]: 0, [key('agitationlevel')]: 0, [key('bpermanent')]: false }));
  for (const [name, value] of Object.entries(scene.fields)) {
    if (name === 'AlliancesEx') value.forEach((e, i) => { store.AlliancesEx[i] = { [key('alliancename')]: e.name ?? 0, [key('alliancelevel')]: f32(e.level ?? 0), [key('agitationlevel')]: f32(e.agitation ?? 0), [key('bpermanent')]: !!e.permanent }; });
    else if (VECTORS.includes(name)) store[name] = value.map(f32);
    else if (FLOATS.includes(name)) store[name] = f32(value);
    else store[name] = typeof value === 'boolean' ? value : value;
  }
  const actor = { name: 'pawn' };
  const calls = [], events = [];
  const services = {
    read: (a, name) => { if (!(name in store)) throw new Error(`twin read of ${name}`); const v = store[name]; return Array.isArray(v) && name !== 'AlliancesEx' ? v.slice() : v; },
    write: (a, name, value) => { if (!(name in store)) throw new Error(`twin write of ${name}`); store[name] = value; },
    level: { timeSeconds: scene.time },
    inStasis: () => { calls.push({ call: 'inStasis' }); return scene.inStasis ?? 0; },
    findFunction: (a, name) => { calls.push({ call: 'find', name, flag: 0 }); return {}; },
    processEvent: (a, name, args) => { events.push({ name, parms: args.length > 0, arg0: args.length ? (args[0] ? 1 : 0) : 0 }); },
    destroyActor: (a, flag) => { calls.push({ call: 'destroy', flag }); },
    noName: 0,
  };
  const proceed = mod.scriptedPawnTick(actor, scene.delta, scene.tickType, services);
  if (proceed) calls.push({ call: 'super', delta: word(f32(scene.delta)), tickType: scene.tickType });
  return { store, calls, events, proceed };
}

function compare(scene, native, twin) {
  const diffs = [];
  const note = (what, a, b) => diffs.push(`${scene.name}: ${what}: original ${JSON.stringify(a)} twin ${JSON.stringify(b)}`);
  if (native.returned !== (twin.proceed ? 1 : 1)) { /* the oracle's Super leaf returns 1; the destroy path returns 1 too */ }
  const nativeCalls = native.calls.map(c => c.call === 'super' ? { call: 'super', delta: c.delta, tickType: c.tickType } : c.call === 'destroy' ? { call: 'destroy', flag: c.flag } : c.call === 'find' ? { call: 'find', name: c.name, flag: c.flag } : { call: 'inStasis' });
  if (JSON.stringify(nativeCalls) !== JSON.stringify(twin.calls)) note('calls', nativeCalls, twin.calls);
  const nativeEvents = native.events.map(e => ({ name: e.name, parms: e.parms, arg0: e.parms ? (e.arg0 & 1) : 0 }));
  if (JSON.stringify(nativeEvents) !== JSON.stringify(twin.events)) note('events', nativeEvents, twin.events);
  for (const name of FLOATS) if (native.fields[name][0] !== word(twin.store[name])) note(name, native.fields[name][0], word(twin.store[name]));
  for (const name of VECTORS) { const a = native.fields[name].join(','), b = twin.store[name].map(word).join(','); if (a !== b) note(name, a, b); }
  for (const name of BYTES) if (native.fields[name][0] !== twin.store[name]) note(name, native.fields[name][0], twin.store[name]);
  for (const name of ['Health', 'CloakThreshold']) if (parseInt(native.fields[name][0], 16) >> 0 !== twin.store[name]) note(name, native.fields[name][0], twin.store[name]);
  // bit-fields from the oracle's raw dwords
  const MASKS = { bSimulatedPawn: ['raw30c', 0x40], bAdvancedTactics: ['raw318', 0x80000000], bOnFire: ['raw5a4', 1], bAlliancesChanged: ['raw650', 8], bCanBleed: ['raw6b8', 1],
    bDisappear: ['raw788', 1], bTickVisibleOnly: ['raw910', 0x400], bClearedObstacle: ['raw974', 8], bHasCloak: ['raw9d8', 8] };
  for (const [name, [raw, mask]] of Object.entries(MASKS)) {
    const a = (parseInt(native.raw[raw], 16) & mask) !== 0;
    if (a !== twin.store[name]) note(name, a, twin.store[name]);
  }
  // the pointer-like fields: a pointer that was cleared (ActorAvoiding), a name that became None (PotentialEnemyAlliance)
  if ((parseInt(native.fields.ActorAvoiding[0], 16) === 0) !== (!twin.store.ActorAvoiding)) note('ActorAvoiding', native.fields.ActorAvoiding[0], twin.store.ActorAvoiding);
  if (parseInt(native.fields.PotentialEnemyAlliance[0], 16) !== twin.store.PotentialEnemyAlliance) note('PotentialEnemyAlliance', native.fields.PotentialEnemyAlliance[0], twin.store.PotentialEnemyAlliance);
  native.alliances.forEach((entry, i) => {
    const level = word(twin.store.AlliancesEx[i][key('alliancelevel')]), agitation = word(twin.store.AlliancesEx[i][key('agitationlevel')]);
    if (entry[1] !== level || entry[2] !== agitation || (parseInt(entry[3], 16) & 1) !== (twin.store.AlliancesEx[i][key('bpermanent')] ? 1 : 0)) note(`alliance ${i}`, entry.slice(1), [level, agitation]);
  });
  return diffs;
}

function runAll(mod) {
  const failures = [];
  scenes.forEach((scene, i) => {
    const r = results[i];
    if (!r.ok) { failures.push(`${scene.name}: oracle error ${r.error}`); return; }
    let twin;
    try { twin = runTwin(scene, mod); } catch (error) { failures.push(`${scene.name}: twin threw ${error.message}`); return; }
    failures.push(...compare(scene, r.result, twin));
  });
  return failures;
}

const failures = runAll(module);
for (const f of failures.slice(0, 30)) console.log('FAIL', f);
console.log(`${failures.length ? 'FAIL' : 'PASS'} validate-scripted-pawn-tick: ${scenes.length} scenes, ${failures.length} differences`);
if (failures.length) process.exit(1);

// --- mutants ------------------------------------------------------------------------------------------------------------------
const mutants = [
  { name: 'gate-role', pattern: "get('Role') < 2 ||", replacement: "get('Role') < 1 ||" },
  { name: 'disappear-age', pattern: '!le(ld(age), D5)', replacement: '!le(ld(age), D4)' },
  { name: 'disappear-stasis-first', pattern: 'services.inStasis(actor) || !le(ld(age), D5)', replacement: '!le(ld(age), D5)' },
  { name: 'age-floor', pattern: 'if (lt(elapsed, ZERO)) age = 0;', replacement: '' },
  { name: 'prepivot-interpolation', pattern: 'const inverse = st(x87div(D1, prePivotTime));', replacement: 'const inverse = st(x87div(D1, ld(dt)));' },
  { name: 'prepivot-end', pattern: "set('PrePivotTime', 0);", replacement: "set('PrePivotTime', 1);" },
  { name: 'alarm-unguarded', pattern: "const result = sub(ld(get('AlarmTimer')), ld(dt));", replacement: "const result = sub(ld(get('AlarmTimer')), ld(0));" },
  { name: 'weapon-timer', pattern: "if (get('Weapon')) set('WeaponTimer', st(x87add(ld(dt), ld(get('WeaponTimer')))));", replacement: "if (!get('Weapon')) set('WeaponTimer', st(x87add(ld(dt), ld(get('WeaponTimer')))));" },
  { name: 'reload-weapon', pattern: "if (!le(reload, ZERO) && get('Weapon'))", replacement: 'if (!le(reload, ZERO))' },
  { name: 'countdown-clamp', pattern: 'if (lt(result, ZERO)) set(name, 0);', replacement: '' },
  { name: 'potential-enemy-order', pattern: "if (le(result, ZERO)) {\n        set('PotentialEnemyTimer', 0);", replacement: "if (lt(result, ZERO)) {\n        set('PotentialEnemyTimer', 0);" },
  { name: 'distress-reset', pattern: "else set('DistressTimer', -1);", replacement: "else set('DistressTimer', 0);" },
  { name: 'cloak-parameter', pattern: "[get('Health') <= get('CloakThreshold')]", replacement: "[get('Health') < get('CloakThreshold')]" },
  { name: 'tactics-physics', pattern: "get('Physics') === 1 && get('TurnDirection') !== 0", replacement: "get('Physics') === 4 && get('TurnDirection') !== 0" },
  { name: 'tactics-timer', pattern: "if (get('TurnDirection') !== 0) set('MoveTimer'", replacement: "if (get('TurnDirection') === 0) set('MoveTimer'" },
  { name: 'tactics-cleared', pattern: "set('bClearedObstacle', true);", replacement: "set('bClearedObstacle', false);" },
  { name: 'burn-period', pattern: "if (!lt(burn, ld(get('BurnPeriod'))))", replacement: "if (!le(burn, ld(get('BurnPeriod'))))" },
  { name: 'visible-only', pattern: "!le(ld(get('DistanceFromPlayer')), F1200)", replacement: "!lt(ld(get('DistanceFromPlayer')), F1200)" },
  { name: 'bleed-clamp-low', pattern: 'if (lt(scaled, F005)) scaled = F005;', replacement: '' },
  { name: 'bleed-period', pattern: 'sub(D1, x), D01', replacement: 'sub(D1, x), ld64(0.2)' },
  { name: 'bleed-loop', pattern: 'while (!lt(ld(get(\'DropCounter\')), ld(threshold))) {', replacement: 'while (lt(ld(threshold), ld(get(\'DropCounter\')))) {' },
  { name: 'bleed-clot', pattern: "x87div(ld(dt), ld(get('ClotPeriod')))", replacement: "x87div(ld(dt), ld(get('ClotPeriod')))" .replace('ClotPeriod', 'DropCounter') },
  { name: 'bleed-zero', pattern: "set('DropCounter', 0);\n    set('BleedRate', 0);", replacement: "set('BleedRate', 0);" },
  { name: 'agitation-ratio', pattern: 'sub(D1, ratio), x87mul(ld(dt), ld(get(\'AgitationDecayRate\')))', replacement: 'ratio, x87mul(ld(dt), ld(get(\'AgitationDecayRate\')))' },
  { name: 'agitation-permanent', pattern: "entry[key('bpermanent')]) continue;", replacement: 'false) continue;' },
  { name: 'agitation-flag', pattern: "set('bAlliancesChanged', true);\n    changed = true;", replacement: 'changed = true;' },
  { name: 'fear-level', pattern: "set(['FearLevel', st(result)]);", replacement: "set(['FearLevel', st(decay)]);" },
  { name: 'fear-timer', pattern: "set(['FearTimer', st(sub(timer, ld(dt)))]);", replacement: "set(['FearTimer', 0]);" },
];
let mutantFailures = 0;
const source = readFileSync(modulePath, 'utf8');
for (const mutant of mutants) {
  if (source.split(mutant.pattern).length !== 2) { console.log(`MUTANT ${mutant.name}: pattern ${source.includes(mutant.pattern) ? 'not unique' : 'not found'}`); mutantFailures++; continue; }
  const temporary = path.join(root, `src/runtime/scripted-pawn-tick-mutant-${process.pid}.mjs`);
  writeFileSync(temporary, source.replace(mutant.pattern, mutant.replacement));
  try {
    const mutated = await import(pathToFileURL(temporary));
    const found = runAll(mutated);
    if (!found.length) { console.log(`MUTANT ${mutant.name}: SURVIVED`); mutantFailures++; }
  } finally { unlinkSync(temporary); }
}
console.log(`${mutantFailures ? 'FAIL' : 'PASS'} mutation coverage: ${mutants.length - mutantFailures}/${mutants.length} mutants detected`);
process.exit(mutantFailures ? 1 : 0);
