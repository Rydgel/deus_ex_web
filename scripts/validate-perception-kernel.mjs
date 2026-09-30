#!/usr/bin/env node
/**
 * The Rust perception natives (native/script-vm/src/percep.rs,
 * docs/rust-core.md R3-c) against the JavaScript bodies they transcribe:
 * execPawnAlliance (script-pawn-alliance.mjs) for IsValidEnemy (2105) and
 * GetPawnAllianceType (2107), execAICanSee (script-pawn-perception.mjs) for
 * AICanSee (705), with AIVisibility and AIGetLightLevel
 * (script-ai-visibility.mjs) inside it.
 *
 * Each case builds a random world in an ObjectArena: actor images at a
 * field layout the case writes into P_FIELDS, class rows with field and
 * flag words, receiver infos (HOST, BOUND with bound keys), names as
 * nameCellWord ids, host-side values for reads that go to JavaScript, and a
 * Level.Actors list with lights, empty slots, the LevelInfo and a zone. The
 * lowered native (PAWN_ENEMY, PAWN_ALLIANCE, AI_CAN_SEE) runs in Rust
 * through vm_run with mock imports that serve the same world; then the
 * images are restored and the JavaScript body runs on the same arguments
 * with services that read and write that world. The result bits, every
 * image byte, the host-side values, the trace calls (kind, source, end
 * points, answer) and any error must be identical. Hand-backs are counted;
 * a call whose every field is in the image must not hand back (alliance) or
 * read or write through JavaScript (AICanSee).
 *
 *   node scripts/validate-perception-kernel.mjs [--cases N] [--seed S]
 *
 * PERCEPTION_REACHED=1 also prints how often the JavaScript bodies read each
 * field, which shows how far the cases get through AICanSee.
 */
import assert from 'node:assert/strict';
import {instantiateScriptVm} from '../src/runtime/script-vm-kernel.mjs';
import {ObjectArena} from '../src/runtime/script-object-arena.mjs';
import {foldedNameId, nameCellWord, nameSpelling} from '../src/runtime/script-name-ids.mjs';
import {PERCEPTION_FIELDS} from '../src/runtime/script-vm-perception.mjs';
import {execPawnAlliance} from '../src/runtime/script-pawn-alliance.mjs';
import {execAICanSee} from '../src/runtime/script-pawn-perception.mjs';
import {x87load, x87add, x87mul, x87div, x87store} from '../src/runtime/script-vm.mjs';
import {fcoordsAxes} from '../src/runtime/script-pawn-locomotion.mjs';
import {vectorToRotator} from '../src/runtime/script-decoration-primitives.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : Number(argv[i + 1]); };
const CASES = option('cases', 12000), SEED = option('seed', 0x5eed1);

const K = {S_RETURN: 4, LIT_FLOAT: 21, LIT_BOOL: 23, LIT_NONE: 24, LOCAL_OBJECT: 34, JS_BOOL: 52, JS_FLOAT: 53,
  JS_OBJECT: 54, CONTEXT: 70, SELF: 71, PAWN_ENEMY: 200, PAWN_ALLIANCE: 201, AI_CAN_SEE: 202};
const R = {INT: 1, BOOL: 2, FLOAT: 3};
const NEXT_NONE = 0xffffffff, UNDEFINED = 0xffffffff, BOUND = 1, HOST = 2, H_SP = 1, H_VALID = 0x80000000;
const FIELD = Object.fromEntries(PERCEPTION_FIELDS.map(([name], i) => [name, i]));
const KIND = Object.fromEntries(PERCEPTION_FIELDS.map(([name, , kind]) => [name, kind]));
// The mock layout: [offset, bool mask]. Offsets follow the retail Actor, Pawn,
// ScriptedPawn, LevelInfo and ZoneInfo members; the lowering takes them from
// the cell registry.
const LAYOUT = {
  bDeleteMe: [0x28, 0x80], bDetectable: [0x2c, 1], Health: [0x428], Alliance: [0x5c4], AlliancesEx: [0x7ec],
  bLikesNeutral: [0x6c8, 0x100], bReverseAlliances: [0x8ec, 1], Location: [0x114], CollisionRadius: [0x1d4],
  CollisionHeight: [0x1d8], VisUpdateTime: [0x2e8], CurrentVisibility: [0x2ec], LastVisibility: [0x2f0],
  Velocity: [0x144], bUnlit: [0x194, 2], BaseEyeHeight: [0x3f4], MinAngularSize: [0x5b8], AspectRatio: [0x5b0],
  AIHorizontalFOV: [0x5ac], Rotation: [0x120], ViewRotation: [0x3dc], AIAddViewRotation: [0x5c8],
  VisibilityThreshold: [0x5bc], LightType: [0x1e0], LightBrightness: [0x1e2], LightRadius: [0x1e5],
  LightSaturation: [0x1e4], bStatic: [0x28, 1], TimeSeconds: [0x478], AmbientBrightness: [0x38c], AmbientSaturation: [0x38e],
};
const IMAGE = 0x900, STRIDE = 16, KEY0 = 200;
const ALLIANCE_NAME = 'deusex.scriptedpawn.allianceinfoex.alliancename';
const ALLIANCE_LEVEL = 'deusex.scriptedpawn.allianceinfoex.alliancelevel';
const AGITATION_LEVEL = 'deusex.scriptedpawn.allianceinfoex.agitationlevel';

// ---- Memory and the module ------------------------------------------------
const arena = new ObjectArena();
const CODE = arena.alloc(0x1000), LOCALS = arena.alloc(256), BOUND_TABLE = arena.alloc(512);
const IMAGES = Array.from({length: 64}, () => arena.alloc(IMAGE));
const ROWS = Array.from({length: 64}, () => arena.alloc(64));
const view = () => arena.view;
const rd32 = at => view().getUint32(at, true), wr32 = (at, v) => view().setUint32(at, v >>> 0, true);

let world = null, calls = [], handlers = new Map();
const byHandle = handle => world.objects.get(handle) ?? assert.fail(`unknown handle ${handle}`);
const f64io = new DataView(new ArrayBuffer(8));
const sameNumber = (a, b) => {
  if (typeof a !== 'number' || typeof b !== 'number') return Object.is(a, b);
  if (a !== a || b !== b) return a !== a && b !== b;
  f64io.setFloat64(0, a, true);
  const lo = f64io.getUint32(0, true), hi = f64io.getUint32(4, true);
  f64io.setFloat64(0, b, true);
  return lo === f64io.getUint32(0, true) && hi === f64io.getUint32(4, true);
};

// ---- The world's reads and writes (the host services' semantics) ----------
function readField(o, name) {
  if (o.values.has(name)) return o.values.get(name);
  const [offset, mask] = LAYOUT[name], at = o.base + offset, v = view();
  switch (KIND[name]) {
    case 'bool': return (v.getUint32(at, true) & mask) !== 0;
    case 'int': return v.getInt32(at, true);
    case 'byte': return v.getUint8(at);
    case 'float': return v.getFloat32(at, true);
    case 'vector': return [v.getFloat32(at, true), v.getFloat32(at + 4, true), v.getFloat32(at + 8, true)];
    case 'rotator': return [v.getInt32(at, true), v.getInt32(at + 4, true), v.getInt32(at + 8, true)];
    case 'name': return o.names.get(name);
    default: throw new Error(`no read of ${name}`);
  }
}
function writeField(o, name, value) {
  const stored = Math.fround(Number(value ?? 0));
  if (o.values.has(name)) { o.values.set(name, stored); return; }
  view().setFloat32(o.base + LAYOUT[name][0], stored, true);
}
const isA = (o, kind) => {
  const tail = String(kind).split('.').pop().toLowerCase();
  return tail === 'playerpawn' ? o.player : tail === 'levelinfo' ? o.levelInfo : tail === 'pawn' ? o.pawn : false;
};
function traceAnswer(kind, a, b, points) {
  let h = kind === 'los' ? 0x2545f491 : 0x68e31da4;
  for (const p of points) {
    f64io.setFloat64(0, p, true);
    h = Math.imul(h ^ f64io.getUint32(0, true), 0x9e3779b1) ^ Math.imul(f64io.getUint32(4, true), 0x85ebca6b);
  }
  h = Math.imul(h ^ a.handle, 0x27d4eb2f) ^ (b ? b.handle : 0);
  return ((h >>> 11) % 5) >= 2;
}
function trace(kind, a, b, points) {
  const answer = traceAnswer(kind, a, b, points);
  world.traces.push([kind, a.handle, b ? b.handle : 0, ...points, answer ? 1 : 0]);
  return answer;
}
// Which fields the JavaScript bodies read, per case: how far the cases get.
const reached = new Map();
const perceptionServices = () => ({
  read: (a, name) => (reached.set(name, (reached.get(name) ?? 0) + 1), readField(a, name)),
  write: (a, name, value) => writeField(a, name, value),
  level: () => world,
  levelInfo: level => level?.actors?.[0] ?? null,
  levelActors: level => level?.actors ?? null,
  isA,
  zone: a => a.zone,
  lightLineCheck: (level, actor, point, start) => trace('light', actor, null, [...point, ...start]),
  singleLineCheck: (level, viewer, other, end, eye) => trace('los', viewer, other, [...end, ...eye]),
});
const allianceServices = () => ({
  read: (a, name) => readField(a, name),
  elements: (a, name) => {
    assert.equal(name, 'AlliancesEx');
    const base = a.base + LAYOUT.AlliancesEx[0];
    return {length: 16, at: i => ({[ALLIANCE_NAME]: a.allianceNames[i], [ALLIANCE_LEVEL]: view().getFloat32(base + STRIDE * i + 4, true),
      [AGITATION_LEVEL]: view().getFloat32(base + STRIDE * i + 8, true)})};
  },
  isA: (a, key) => key === 'deusex.scriptedpawn' && a.sp,
});

// ---- Mock imports ----------------------------------------------------------
class VmError extends Error {}
const evaluate = (n, receiver) => handlers.get(n)(receiver);
let x;
const argsOf = index => {
  const v = view(), at = x.percep_args_ptr(), argc = v.getFloat64(at, true), nothing = v.getFloat64(at + 8, true);
  const kinds = index === 705 ? ['object', 'float', 'bool', 'bool', 'bool', 'bool'] : ['object', 'bool'];
  const values = [];
  for (let i = 0; i < argc; i++) {
    const slot = at + 16 + 8 * i, value = v.getFloat64(slot, true);
    if (nothing & (1 << i)) values.push(undefined);
    else if (kinds[i] === 'object') values.push(value === UNDEFINED ? undefined : value === 0 ? null : byHandle(value));
    else if (kinds[i] === 'float') values.push(v.getUint32(slot, true) === 1 && v.getUint32(slot + 4, true) === 0x7ff80000 ? undefined : value);
    else values.push(value !== 0);
  }
  return {argc, values};
};
const callOf = (node, receiver) => {
  const index = world.nodes.get(node), {argc, values} = argsOf(index);
  return {index, receiver: byHandle(receiver), argumentCount: argc, evaluateArgument: i => values[i]};
};
const imports = {
  js_int(frame, n, r) { calls.push('int'); return evaluate(n, r) | 0; },
  js_float(frame, n, r) {
    calls.push('float');
    const v = evaluate(n, r);
    if (v === undefined) { wr32(x.vm_float_undef_ptr(), 1); return NaN; }
    return +v;
  },
  js_bool(frame, n, r) { calls.push('bool'); return evaluate(n, r) ? 1 : 0; },
  js_object(frame, n, r) {
    calls.push('object');
    const v = evaluate(n, r);
    return v === undefined ? UNDEFINED : v === null ? 0 : v.handle;
  },
  js_receiver(handle) { const o = byHandle(handle); return o.host ? HOST : (o.base | (o.bound ? BOUND : 0)) >>> 0; },
  js_accessed_none() { calls.push('none'); },
  js_error(frame, code, n) { throw new VmError(`js_error ${code} (${n})`); },
  js_class_row(handle) { calls.push('row'); return byHandle(handle).row; },
  js_class_fields(handle) {
    calls.push('fields');
    const o = byHandle(handle), at = o.row + 16;
    wr32(at, o.fields);
    wr32(at + 4, H_VALID | (o.sp ? H_SP : 0));
  },
  js_pread(frame, handle, field, site) {
    const o = byHandle(handle), name = PERCEPTION_FIELDS[field][0];
    world.jsReads++;
    const v = readField(o, name);
    if (site === 2 && v === undefined) throw new Error(`AI visibility requires original ${name}`);
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  },
  js_pread3(frame, handle, field) {
    const o = byHandle(handle), v = readField(o, PERCEPTION_FIELDS[field][0]), at = x.percep_io_ptr();
    world.jsReads++;
    for (let i = 0; i < 3; i++) view().setFloat64(at + 8 * i, v[i], true);
  },
  js_pwrite(frame, handle, field, value) { world.jsWrites++; writeField(byHandle(handle), PERCEPTION_FIELDS[field][0], value); },
  js_is_a(frame, handle, name) { return isA(byHandle(handle), nameSpelling(name)) ? 1 : 0; },
  js_alliance(frame, node, receiver) {
    world.handback++;
    return Number(execPawnAlliance(callOf(node, receiver), allianceServices()));
  },
  js_aicansee(frame, node, receiver) {
    world.handback++;
    world.traces.length = 0;
    return execAICanSee(callOf(node, receiver), perceptionServices());
  },
  js_vis_info(frame, handle) {
    const info = world.actors[0];
    if (!info || !isA(info, 'LevelInfo')) throw new Error('AIVisibility requires Actors[0] to be LevelInfo');
    return world.lightingSeam ? 0 : info.handle;
  },
  js_zone(frame, handle) {
    const zone = byHandle(handle).zone;
    if (!zone) throw new Error('AIGetLightLevel requires the original Region.Zone');
    return zone.handle;
  },
  js_level_actors() {
    const n = world.actors.length, base = world.scan;
    wr32(base, n);
    world.actors.forEach((a, i) => {
      wr32(base + 4 + 8 * i, a ? a.handle : 0);
      wr32(base + 8 + 8 * i, a ? imports.js_receiver(a.handle) : 0);
    });
    return base;
  },
  js_light_trace(frame, source, px, py, pz, sx, sy, sz) {
    return trace('light', byHandle(source), null, [px, py, pz, sx, sy, sz]) ? 1 : 0;
  },
  js_los_trace(frame, viewer, other, ex, ey, ez, sx, sy, sz) {
    return trace('los', byHandle(viewer), byHandle(other), [...[ex, ey, ez].map(Math.fround), ...[sx, sy, sz].map(Math.fround)]) ? 1 : 0;
  },
  js_atan: Math.atan,
  js_atan2: Math.atan2,
  js_percep_begin() { world.begun++; },
  js_percep_verify(frame, node, receiver, result) { world.verified.push(result); },
};
x = await instantiateScriptVm(arena.memory, imports);
const RESULT_AT = x.vm_result_ptr(), SCAN = arena.alloc(4 + 8 * 80);
// P_FIELDS and P_ALLIANCE: the mock layout, key ids KEY0 + i.
PERCEPTION_FIELDS.forEach(([name], i) => {
  const at = x.percep_fields_ptr() + 12 * i, [offset, mask = 0] = LAYOUT[name];
  wr32(at, offset); wr32(at + 4, mask); wr32(at + 8, KEY0 + i);
});
[STRIDE, 0, 4, 8].forEach((v, i) => wr32(x.percep_alliance_ptr() + 4 * i, v));
wr32(x.percep_names_ptr(), foldedNameId('playerpawn'));
wr32(x.percep_names_ptr() + 4, foldedNameId('levelinfo'));
wr32(x.vm_bound_keys_ptr(), BOUND_TABLE);
wr32(x.vm_bound_keys_ptr() + 4, 512);
// No handle class table: every lookup asks js_class_row.
wr32(x.vm_classes_ptr(), 0);
wr32(x.vm_classes_ptr() + 4, 0);

// ---- Random worlds ---------------------------------------------------------
let seed = SEED >>> 0 || 1;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const pick = list => list[Math.floor(random() * list.length)];
const chance = p => random() < p;
const SPECIAL = [0, -0, 1, -1, 0.5, 0.25, 0.75, 1e-45, -1e-45, 1.1754942e-38, 3.4e38, -3.4e38, Infinity, -Infinity, NaN,
  22500, 150, 1000, 1e6, 0.0003046792916483, 0.1, 0.9, 30, 170, 200, 180, -180, 360];
const real = (scale, special = 0.15) => chance(special) ? pick(SPECIAL) : Math.fround((random() * 2 - 1) * scale);
const positive = scale => chance(0.1) ? pick(SPECIAL) : Math.fround(random() * scale);
const rotation = () => chance(0.1) ? (random() * 4294967296) | 0 : Math.floor((random() * 2 - 1) * 70000);
const NAMES = ['None', '', 'Player', 'player', 'UNATCO', 'unatco', 'NSF', 'Thugs', 'Robot', 'none', 'NONE', 'Civilian'];
const NAN_BITS = [0x7fa00001, 0xffc12345, 0x7fc00000, 0xff800001, 0x7fffffff];
const ALLIANCE_FLOATS = [0, -0, 1, -1, 0.5, 2, 0.99999994, 1.0000001, -1e-45, 1e-45, NaN, -Infinity, Infinity, -0.5];

let nextHandle = 7;
function actor(kind) {
  const index = world.list.length;
  const o = {handle: nextHandle += 2, base: IMAGES[index], row: ROWS[index], host: false, bound: false,
    fields: 0x7fffffff, sp: false, player: false, pawn: false, levelInfo: false, values: new Map(), names: new Map(),
    allianceNames: [], zone: null, kind};
  arena.bytes.fill(0, o.base, o.base + IMAGE);
  arena.bytes.fill(0, o.row, o.row + 64);
  world.list.push(o);
  world.objects.set(o.handle, o);
  return o;
}
/** Finish an object: its class row (one per object) and its access path. */
function finish(o) {
  const name = o.levelInfo ? 'levelinfo' : o.player ? 'playerpawn' : o.sp ? 'scriptedpawn' : 'actor';
  wr32(o.row + 4, 1);
  wr32(o.row + 8, 1000 + world.list.indexOf(o));
  wr32(o.row + 12, foldedNameId(name));
  if (world.allFast) return;
  if (chance(0.03)) o.row = 0;
  if (chance(0.08)) o.host = true;
  else if (chance(0.25)) o.bound = true;
  if (chance(0.1)) o.fields &= ~(1 << Math.floor(random() * PERCEPTION_FIELDS.length));
  if (chance(0.03)) o.fields = 0;
}
/** Whether every read of `fields` on `o` is in the image. */
const fast = (o, fields) => !o.host && o.row !== 0 &&
  fields.every(field => o.fields & (1 << field) && !(o.bound && arena.bytes[BOUND_TABLE + KEY0 + field]));
const setName = (o, name, value) => {
  o.names.set(name, value);
  wr32(o.base + LAYOUT[name][0], nameCellWord(value));
};
const put = (o, name, value) => {
  const [offset, mask] = LAYOUT[name], at = o.base + offset, v = view();
  switch (KIND[name]) {
    case 'bool': v.setUint32(at, value ? v.getUint32(at, true) | mask : v.getUint32(at, true) & ~mask, true); break;
    case 'int': v.setInt32(at, value, true); break;
    case 'byte': v.setUint8(at, value); break;
    case 'float': v.setFloat32(at, value, true); break;
    case 'vector': value.forEach((c, i) => v.setFloat32(at + 4 * i, c, true)); break;
    case 'rotator': value.forEach((c, i) => v.setInt32(at + 4 * i, c, true)); break;
    default: throw new Error(name);
  }
};
/** A value served from the host side (a binding) for a read Rust makes in
 * JavaScript: any double, not only a float32. */
const boundKey = field => arena.bytes[BOUND_TABLE + KEY0 + field] !== 0;
const jsPath = (o, name) => o.host || o.row === 0 || !(o.fields & (1 << FIELD[name])) || (o.bound && boundKey(FIELD[name]));
const hostValue = (o, name) => {
  if (!jsPath(o, name) || !chance(0.5)) return;
  const kind = KIND[name];
  if (kind === 'float') o.values.set(name, chance(0.5) ? (random() * 2 - 1) * 500 : readField(o, name));
  else if (kind === 'vector') o.values.set(name, [0, 1, 2].map(() => (random() * 2 - 1) * 2000));
  else if (kind === 'rotator') o.values.set(name, [0, 1, 2].map(() => rotation()));
  else if (kind === 'byte') o.values.set(name, Math.floor(random() * 256));
  else if (kind === 'bool') o.values.set(name, chance(0.5));
};
function markBoundKeys() {
  arena.bytes.fill(0, BOUND_TABLE, BOUND_TABLE + 512);
  for (let i = 0; i < PERCEPTION_FIELDS.length; i++) if (chance(0.3)) arena.bytes[BOUND_TABLE + KEY0 + i] = 1;
}
function newWorld() {
  world = {list: [], objects: new Map(), actors: [], traces: [], nodes: new Map(), scan: SCAN, lightingSeam: false,
    jsReads: 0, jsWrites: 0, handback: 0, begun: 0, verified: [], allFast: chance(0.15)};
  handlers = new Map();
  calls = [];
  markBoundKeys();
}

// ---- Code ------------------------------------------------------------------
let nextNode = 5000;
const node = fn => { const id = nextNode++; handlers.set(id, fn); return id; };
function assemble(words) {
  const code = [1, 3, NEXT_NONE, ...words];
  new Uint32Array(arena.memory.buffer, CODE, code.length).set(code.map(v => v >>> 0));
  return CODE;
}
function run(words, self, check) {
  wr32(x.vm_budget_ptr(), 1000000);
  wr32(x.vm_runaway_ptr(), 0);
  wr32(x.vm_float_undef_ptr(), 0);
  wr32(x.percep_check_ptr(), check ? 1 : 0);
  const sp = x.__stack_pointer.value;
  try { return x.vm_run(assemble(words), 42, LOCALS, self.handle, 0); } finally { x.__stack_pointer.value = sp; }
}
const readResult = rkind => {
  const v = view().getFloat64(RESULT_AT, true);
  return rkind === R.BOOL ? v === 1 : v;
};
let local = 0;
/** An object argument: its words and the value evaluateArgument returns. */
function objectArgument(o) {
  if (o === undefined) return {words: [K.JS_OBJECT, node(() => undefined)], value: undefined};
  if (o === null) return chance(0.5) ? {words: [K.LIT_NONE], value: null} : {words: [K.JS_OBJECT, node(() => null)], value: null};
  if (chance(0.2)) return {words: [K.JS_OBJECT, node(() => o)], value: o};
  const at = 4 * (local++ % 60);
  wr32(LOCALS + at, o.handle);
  return {words: [K.LOCAL_OBJECT, at], value: o};
}
function boolArgument(allowJs = true) {
  if (allowJs && chance(0.25)) {
    const v = pick([true, false, 0, 1, '', 'x', undefined, null, NaN]);
    return {words: [K.JS_BOOL, node(() => v)], value: v};
  }
  const v = chance(0.5);
  return {words: [K.LIT_BOOL, v ? 1 : 0], value: v};
}
function floatArgument() {
  if (chance(0.2)) {
    const v = pick([undefined, 1, 0.5, 0, -1, NaN, '2', null, 1e-45, 3]);
    return {words: [K.JS_FLOAT, node(() => v)], value: v};
  }
  const v = chance(0.7) ? pick([1, 1, 0.5, 0.25, 2, 0.75]) : real(3);
  f64io.setFloat32(0, v, true);
  return {words: [K.LIT_FLOAT, f64io.getUint32(0, true)], value: Math.fround(v)};
}
/** A native call node on `receiver`, through a context 20% of the time. */
function callWords(kind, index, args, viewer) {
  const n = node(() => { throw new Error('the native node itself is never evaluated in JavaScript'); });
  world.nodes.set(n, index);
  const words = [kind, n, args.length];
  for (const a of args) if (a.nothing) words.push(0); else words.push(1, ...a.words);
  if (!chance(0.2)) return {words, self: viewer};
  const caller = actor('caller');
  finish(caller);
  const at = 4 * (local++ % 60);
  wr32(LOCALS + at, viewer.handle);
  return {words: [K.CONTEXT, node(() => assert.fail('context node')), words.length + 0, K.LOCAL_OBJECT, at, ...words], self: caller};
}

// ---- Comparison -------------------------------------------------------------
function snapshot() {
  return {bytes: world.list.map(o => arena.bytes.slice(o.base, o.base + IMAGE)),
    values: world.list.map(o => new Map(o.values))};
}
function restore(s) {
  world.list.forEach((o, i) => { arena.bytes.set(s.bytes[i], o.base); o.values = new Map(s.values[i]); });
}
function outcome(fn) {
  world.traces = [];
  let value, error = null;
  try { value = fn(); } catch (e) { if (e instanceof VmError) throw e; error = String(e?.message); }
  return {value, error, traces: world.traces, state: snapshot()};
}
const stats = {alliance: 0, pawnAlliance: 0, aiCanSee: 0, fast: 0, handback: 0, errors: 0, positive: 0, traces: 0,
  jsReads: 0, jsWrites: 0, verified: 0, allFast: 0, boundaries: 0, negativeZero: 0};
let checks = 0;
function compare(rust, js, label) {
  const fail = message => assert.fail(`${label}: ${message}`);
  if (rust.error !== js.error) fail(`error Rust ${rust.error}, JavaScript ${js.error}`);
  if (!rust.error && !sameNumber(rust.value, js.value)) fail(`result Rust ${rust.value}, JavaScript ${js.value}`);
  if (rust.traces.length !== js.traces.length) fail(`${rust.traces.length} traces in Rust, ${js.traces.length} in JavaScript`);
  rust.traces.forEach((t, i) => {
    if (t.length !== js.traces[i].length || !t.every((v, k) => sameNumber(v, js.traces[i][k])))
      fail(`trace ${i}: Rust ${t.join(',')}, JavaScript ${js.traces[i].join(',')}`);
  });
  world.list.forEach((o, i) => {
    const a = rust.state.bytes[i], b = js.state.bytes[i];
    for (let k = 0; k < IMAGE; k++) if (a[k] !== b[k]) fail(`${o.kind} image byte 0x${k.toString(16)}: ${a[k]} vs ${b[k]}`);
    for (const [name, value] of rust.state.values[i])
      if (!sameNumber(value, js.state.values[i].get(name)) && !(Array.isArray(value) && value.every((c, k) => sameNumber(c, js.state.values[i].get(name)[k]))))
        fail(`${o.kind} host value ${name}: ${value} vs ${js.state.values[i].get(name)}`);
  });
  checks++;
  if (rust.error) stats.errors++;
  stats.traces += rust.traces.length;
}

// ---- Alliance cases -----------------------------------------------------------
function alliancePawn(kind, sp) {
  const o = actor(kind);
  o.sp = sp; o.pawn = true;
  setName(o, 'Alliance', pick(NAMES));
  put(o, 'Health', pick([0, -1, 1, 100, 2147483647, -2147483648, 5]));
  put(o, 'bDeleteMe', chance(0.1));
  put(o, 'bDetectable', chance(0.9));
  if (sp) {
    const base = o.base + LAYOUT.AlliancesEx[0];
    for (let i = 0; i < 16; i++) {
      const name = chance(0.5) ? pick(NAMES) : 'None';
      o.allianceNames.push(name);
      wr32(base + STRIDE * i, nameCellWord(name));
      view().setFloat32(base + STRIDE * i + 4, pick(ALLIANCE_FLOATS), true);
      view().setFloat32(base + STRIDE * i + 8, pick(ALLIANCE_FLOATS), true);
    }
    put(o, 'bLikesNeutral', chance(0.3));
    put(o, 'bReverseAlliances', chance(0.2));
  }
  finish(o);
  return o;
}
function allianceCase(index) {
  newWorld();
  const me = alliancePawn('receiver', true), other = alliancePawn('other', chance(0.6));
  const target = chance(0.85) ? other : pick([null, undefined, me]);
  const args = [objectArgument(target)];
  if (index === 2105 && chance(0.6)) args.push(chance(0.2) ? {nothing: true, value: undefined} : boolArgument(false));
  const {words, self} = callWords(index === 2105 ? K.PAWN_ENEMY : K.PAWN_ALLIANCE, index, args, me);
  const rkind = index === 2105 ? R.BOOL : R.INT;
  const before = snapshot(), check = chance(0.2);
  const rust = outcome(() => (assert.equal(run([K.S_RETURN, rkind, ...words], self, check), -1), readResult(rkind)));
  const handedBack = world.handback;
  restore(before);
  const js = outcome(() => {
    const v = execPawnAlliance({index, receiver: me, argumentCount: args.length, evaluateArgument: i => args[i].value}, allianceServices());
    return index === 2105 ? Boolean(v) : v;
  });
  compare({...rust, value: rkind === R.BOOL ? Boolean(rust.value) : rust.value}, js, `alliance ${index} case ${checks}`);
  // Every read in the image: the call completes in Rust.
  const ALL = [0, 1, 2, 3, 4, 5, 6];
  if (fast(me, ALL) && fast(other, ALL)) assert.equal(handedBack, 0, `alliance ${index} case ${checks} runs in Rust`);
  if (handedBack) stats.handback++; else stats.fast++;
  if (check && !handedBack) {
    assert.equal(world.verified.length, 1, 'a completed call reports to js_percep_verify');
    assert.ok(sameNumber(world.verified[0], view().getFloat64(RESULT_AT, true)), 'the verified value is the result');
    stats.verified++;
  }
  index === 2105 ? stats.alliance++ : stats.pawnAlliance++;
}

// ---- AICanSee cases -------------------------------------------------------------
function place(o, around, spread) {
  put(o, 'Location', around.map(c => chance(0.03) ? pick(SPECIAL) : Math.fround(c + (random() * 2 - 1) * spread)));
}
// Boundary cases, computed with the JavaScript model the body uses: a
// MinAngularSize equal to the angular size, a yaw exactly on the plateau of
// a zero-extent trapezoid, lights at exactly their radius, and a visibility
// cache of negative zeros.
const ld = x87load, st = x87store;
const dot3 = (a, b) => x87add(x87add(x87mul(ld(a[0]), ld(b[0])), x87mul(ld(a[1]), ld(b[1]))), x87mul(ld(a[2]), ld(b[2])));
function setValue(o, name, value) {
  if (o.values.has(name)) o.values.set(name, value);
  put(o, name, value);
}
function probe(viewer, other) {
  const vLoc = readField(viewer, 'Location'), oLoc = readField(other, 'Location');
  const eye = [vLoc[0], vLoc[1], Math.fround(vLoc[2] + readField(viewer, 'BaseEyeHeight'))];
  const delta = [0, 1, 2].map(i => Math.fround(oLoc[i] - eye[i]));
  let distSq = st(dot3(delta, delta));
  if (!(distSq >= 1)) distSq = 1;
  const cr = readField(other, 'CollisionRadius'), ch = readField(other, 'CollisionHeight');
  return {delta, ratio: st(x87div(x87add(x87mul(ld(cr), ld(cr)), x87mul(ld(ch), ld(ch))), ld(distSq)))};
}
function boundary(viewer, other, info) {
  const which = random();
  if (which < 0.08) {
    const {ratio} = probe(viewer, other);
    if (Number.isFinite(ratio)) { setValue(viewer, 'MinAngularSize', ratio); stats.boundaries++; }
  } else if (which < 0.14) {
    setValue(other, 'CollisionRadius', 0);
    setValue(viewer, 'MinAngularSize', 0);
    const {delta} = probe(viewer, other);
    const base = readField(viewer, viewer.player ? 'ViewRotation' : 'Rotation'), add = readField(viewer, 'AIAddViewRotation');
    let rot;
    try {
      const axes = fcoordsAxes([0, 1, 2].map(i => Math.fround(base[i] + add[i])));
      rot = vectorToRotator([1, 2, 3].map(k => st(dot3(axes[k], delta))));
    } catch { return; }
    let d = Math.fround(st(x87mul(ld(rot[1] * 360), ld(1.52587890625e-05))));
    while (d <= -180) d = Math.fround(d + 360);
    while (d > 180) d = Math.fround(d - 360);
    setValue(viewer, 'AIHorizontalFOV', Math.fround(2 * Math.abs(d)));
    stats.boundaries++;
  } else if (which < 0.2) {
    const at = [Math.round(random() * 2000 - 1000), Math.round(random() * 2000 - 1000), Math.round(random() * 400)];
    setValue(other, 'Location', at);
    for (let k = 0; k < 3; k++) {
      const light = actor('light'), radius = Math.floor(random() * 150);
      put(light, 'LightType', 1);
      put(light, 'LightBrightness', 1 + Math.floor(random() * 255));
      put(light, 'LightRadius', radius);
      put(light, 'LightSaturation', Math.floor(random() * 256));
      put(light, 'bStatic', true);
      const offset = 25 * (radius + 1);
      put(light, 'Location', k === 0 ? [at[0] - offset, at[1], at[2]] : k === 1 ? [at[0], at[1] + offset, at[2]] : [at[0], at[1], at[2] - offset]);
      finish(light);
      world.actors.push(light);
    }
    // distanceSq 275593 against radiusSq 275625 (LightRadius 20): the double
    // store of distanceSq / radiusSq before appSqrt changes the attenuation.
    const witness = actor('light');
    put(witness, 'LightType', 1);
    put(witness, 'LightBrightness', 255);
    put(witness, 'LightRadius', 20);
    put(witness, 'LightSaturation', 255);
    put(witness, 'bStatic', false);
    put(witness, 'Location', [at[0] + 524, at[1] - 24, at[2] + 21]);
    finish(witness);
    world.actors.push(witness);
    put(other, 'bUnlit', false);
    setValue(other, 'VisUpdateTime', -1e30);
    // Nothing else lights the target, so each light's contribution reaches
    // the cache; the call reaches AIVisibility.
    for (let i = 0; i < world.actors.length; i++) if (world.actors[i]?.kind === 'light' && i < world.actors.length - 4) world.actors[i] = null;
    setValue(world.list[1], 'AmbientBrightness', 0);
    setValue(viewer, 'MinAngularSize', 0);
    world.reachVisibility = true;
    stats.boundaries++;
  } else if (which < 0.24) {
    // A negative elapsed time extrapolates: (±0 - -0) * negative + -0 is -0.
    setValue(other, 'CurrentVisibility', chance(0.5) ? 0 : -0);
    setValue(other, 'LastVisibility', -0);
    setValue(other, 'VisUpdateTime', Math.fround(readField(info, 'TimeSeconds') + (chance(0.5) ? 0.1 : -0.1)));
    setValue(other, 'Velocity', [0, 0, 0]);
    setValue(viewer, 'VisibilityThreshold', chance(0.5) ? 0 : -0);
    stats.boundaries++;
  }
}
function aiCanSeeCase() {
  newWorld();
  const info = actor('levelinfo');
  info.levelInfo = !chance(0.03);
  put(info, 'TimeSeconds', chance(0.03) ? pick(SPECIAL) : Math.fround(random() * 100));
  // NaN payloads: what JavaScript stores for one depends on V8, so Rust hands
  // these calls back before its first write.
  if (chance(0.02)) wr32(info.base + LAYOUT.TimeSeconds[0], pick(NAN_BITS));
  finish(info);
  const zone = actor('zone');
  put(zone, 'AmbientBrightness', Math.floor(random() * 256));
  put(zone, 'AmbientSaturation', Math.floor(random() * 256));
  finish(zone);
  const viewer = actor('viewer');
  viewer.pawn = true; viewer.player = chance(0.15);
  place(viewer, [0, 0, 0], 2000);
  put(viewer, 'BaseEyeHeight', chance(0.9) ? positive(60) : real(100));
  put(viewer, 'MinAngularSize', chance(0.8) ? Math.fround(random() * 0.0004) : real(1));
  put(viewer, 'AspectRatio', chance(0.8) ? Math.fround(0.5 + random() * 2) : real(2));
  put(viewer, 'AIHorizontalFOV', chance(0.8) ? Math.fround(30 + random() * 150) : real(400));
  put(viewer, 'Rotation', [rotation(), rotation(), rotation()]);
  put(viewer, 'ViewRotation', [rotation(), rotation(), rotation()]);
  put(viewer, 'AIAddViewRotation', chance(0.7) ? [0, 0, 0] : [rotation(), rotation(), rotation()]);
  put(viewer, 'VisibilityThreshold', chance(0.8) ? Math.fround(random() * 0.05) : real(1));
  finish(viewer);
  const other = chance(0.03) ? viewer : actor('other');
  if (other !== viewer) {
    other.pawn = chance(0.8); other.player = other.pawn && chance(0.4);
    const loc = view(), vl = [0, 1, 2].map(i => loc.getFloat32(viewer.base + LAYOUT.Location[0] + 4 * i, true));
    place(other, vl.map(c => c !== c ? 0 : c), chance(0.7) ? 400 : 3000);
    put(other, 'CollisionRadius', chance(0.9) ? positive(60) : real(100));
    put(other, 'CollisionHeight', chance(0.9) ? positive(60) : real(100));
    put(other, 'BaseEyeHeight', positive(60));
    put(other, 'bDetectable', chance(0.93));
    finish(other);
    // Half the viewers face the target (yaw, and pitch within the view).
    if (chance(0.5)) {
      const ol = [0, 1, 2].map(i => view().getFloat32(other.base + LAYOUT.Location[0] + 4 * i, true));
      const yaw = Math.round(Math.atan2(ol[1] - vl[1], ol[0] - vl[0]) * 32768 / Math.PI + (random() * 2 - 1) * 4000);
      const pitch = Math.round((random() * 2 - 1) * 3000);
      put(viewer, viewer.player ? 'ViewRotation' : 'Rotation', [pitch, yaw, Math.floor((random() * 2 - 1) * 2000)]);
    }
  }
  const time = readField(info, 'TimeSeconds');
  const elapsed = pick([0.1, 0.25, 0.3, 0.4, 0.5, 0.6, 2, 5, -0.3, 0]) + (chance(0.5) ? random() * 0.01 : 0);
  put(other, 'VisUpdateTime', chance(0.05) ? pick(SPECIAL) : Math.fround(time - elapsed));
  put(other, 'CurrentVisibility', chance(0.05) ? pick(SPECIAL) : Math.fround(random()));
  if (chance(0.03)) wr32(other.base + LAYOUT.CurrentVisibility[0], pick(NAN_BITS));
  put(other, 'LastVisibility', chance(0.05) ? pick(SPECIAL) : Math.fround(random()));
  put(other, 'Velocity', [0, 1, 2].map(() => chance(0.05) ? pick(SPECIAL) : Math.fround((random() * 2 - 1) * 300)));
  put(other, 'bUnlit', chance(0.08));
  other.zone = chance(0.04) ? null : zone;
  // Level.Actors: the LevelInfo first, then lights, empty slots and the pawns.
  const otherLoc = [0, 1, 2].map(i => view().getFloat32(other.base + LAYOUT.Location[0] + 4 * i, true)).map(c => c !== c ? 0 : c);
  world.actors.push(info);
  const lights = Math.floor(random() * 30);
  for (let i = 0; i < lights; i++) {
    if (chance(0.1)) { world.actors.push(null); continue; }
    const light = actor('light');
    put(light, 'LightType', chance(0.4) ? 0 : Math.floor(random() * 4));
    put(light, 'LightBrightness', chance(0.1) ? 0 : Math.floor(random() * 256));
    put(light, 'LightRadius', Math.floor(random() * 256));
    put(light, 'LightSaturation', Math.floor(random() * 256));
    put(light, 'bStatic', chance(0.5));
    place(light, otherLoc, chance(0.7) ? 600 : 5000);
    finish(light);
    world.actors.push(light);
  }
  world.actors.splice(1 + Math.floor(random() * world.actors.length), 0, other);
  if (other !== viewer && chance(0.7)) world.actors.splice(1 + Math.floor(random() * world.actors.length), 0, viewer);
  if (chance(0.3)) world.actors.push(zone);
  if (chance(0.5)) { put(other, 'LightType', 1); put(other, 'LightBrightness', 200); put(other, 'LightRadius', 50); }
  world.lightingSeam = !world.allFast && chance(0.02);
  for (const o of world.list) for (const name of Object.keys(LAYOUT)) if (KIND[name] !== 'name' && KIND[name] !== 'fixed') hostValue(o, name);
  if (other !== viewer) boundary(viewer, other, info);
  // Arguments.
  const argc = chance(0.1) ? 1 + Math.floor(random() * 5) : 6;
  const args = [];
  for (let i = 0; i < argc; i++) {
    if (i > 0 && chance(0.06)) { args.push({nothing: true, value: undefined}); continue; }
    if (i === 0) args.push(chance(0.03) ? {nothing: true, value: undefined} : objectArgument(chance(0.04) ? pick([null, undefined]) : other));
    else if (world.reachVisibility) args.push(i === 1 ? {words: [K.LIT_FLOAT, 0x3f800000], value: 1} : {words: [K.LIT_BOOL, i === 3 ? 0 : 1], value: i !== 3});
    else if (i === 1) args.push(floatArgument());
    else args.push(i !== 4 && chance(0.7) ? {words: [K.LIT_BOOL, 1], value: true} : boolArgument());
  }
  const {words, self} = callWords(K.AI_CAN_SEE, 705, args, viewer);
  const before = snapshot(), check = chance(0.2);
  const rust = outcome(() => (assert.equal(run([K.S_RETURN, R.FLOAT, ...words], self, check), -1), readResult(R.FLOAT)));
  const handedBack = world.handback, reads = world.jsReads, writes = world.jsWrites;
  restore(before);
  const js = outcome(() => execAICanSee({index: 705, receiver: viewer, argumentCount: args.length,
    evaluateArgument: i => args[i].value}, perceptionServices()));
  if (Object.is(js.value, -0)) stats.negativeZero++;
  compare(rust, js, `AICanSee case ${checks}`);
  if (world.allFast) {
    assert.equal(reads, 0, `AICanSee case ${checks}: every read in the image`);
    assert.equal(writes, 0, `AICanSee case ${checks}: every write in the image`);
    stats.allFast++;
  }
  stats.aiCanSee++;
  if (handedBack) stats.handback++; else stats.fast++;
  if (!rust.error && rust.value > 0) stats.positive++;
  stats.jsReads += reads;
  stats.jsWrites += writes;
  if (check && !handedBack && !rust.error && world.begun) {
    assert.equal(world.verified.length, 1, 'a completed call reports to js_percep_verify');
    stats.verified++;
  }
}

for (let i = 0; i < CASES; i++) {
  const which = i % 5;
  if (which === 0) allianceCase(2107);
  else if (which < 3) allianceCase(2105);
  else aiCanSeeCase();
}
if (process.env.PERCEPTION_REACHED) console.log([...reached].map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`validate-perception-kernel: ${checks} cases identical (${stats.alliance} IsValidEnemy, ` +
  `${stats.pawnAlliance} GetPawnAllianceType, ${stats.aiCanSee} AICanSee; ${stats.fast} completed in Rust, ` +
  `${stats.handback} handed back, ${stats.errors} errors, ${stats.positive} visible, ${stats.traces} traces, ` +
  `${stats.jsReads} JavaScript reads, ${stats.jsWrites} JavaScript writes, ${stats.verified} verified, ` +
  `${stats.allFast} with every access in the image, ${stats.boundaries} boundary cases, ${stats.negativeZero} -0 results)`);
