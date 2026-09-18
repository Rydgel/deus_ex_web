#!/usr/bin/env node
/* Validates src/runtime/script-pawn-perception.mjs against the original
 * Engine.dll bodies.  The oracle is three-tiered:
 *
 *   * every exec/worker body runs in Unicorn on the hash-verified image
 *     (scripts/native-pawn-perception-probe.py) — authoritative for integer,
 *     flag, float32 and trace-order behavior;
 *   * the worker's FVector::Rotation call (Core 0x10144390, FPATAN) and the
 *     AICanSee appAtan(double) extents are intercepted and answered from
 *     tools/pawn-rotation-probe.exe / tools/atan-double-probe.exe running the
 *     identical x87 sequences on real silicon through CrossOver/Wine —
 *     Unicorn is not authoritative for transcendental state;
 *   * the command-capture boundaries (UModel::FastLineCheck, SingleLineCheck,
 *     the lighting query, appFrand) are recording stubs fed scripted values,
 *     so each side consumes the same ordered queues — no trace subsystem is
 *     reimplemented here.
 *
 * Each scene runs both engines and compares: the return/out values, the
 * ordered FastLineCheck and SingleLineCheck request streams, the lighting
 * queries, every mutated pawn field at float32-bit precision, and the RNG
 * consumption count.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modulePath = path.join(root, 'src/runtime/script-pawn-perception.mjs');
const module = await import(pathToFileURL(process.env.PERCEPTION_MODULE ?? modulePath));

const python = process.env.NATIVE_PROBE_PYTHON
  || path.join(root, '.cache/native-probe-env/bin/python');
const probeScript = path.join(root, 'scripts/native-pawn-perception-probe.py');
const wine = process.env.X87_PROBE_WINE
  || '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';
const bottle = process.env.X87_PROBE_BOTTLE || 'DeusEx';
const cc = process.env.X87_PROBE_CC || 'i686-w64-mingw32-gcc';
const rotationExe = path.join(root, '.cache/pawn-rotation-probe.exe');
const rotationSrc = path.join(root, 'tools/pawn-rotation-probe.c');
const atanExe = path.join(root, '.cache/atan-double-probe.exe');
const atanSrc = path.join(root, 'tools/atan-double-probe.c');
const cacheDir = path.join(root, '.cache/pawn-percep');
const skip = reason => {
  console.log(`SKIP validate-pawn-perception: ${reason}`);
  process.exit(0);
};
if (!existsSync(python)) skip(`no probe python at ${python}`);
if (!existsSync(wine)) skip(`no CrossOver/Wine at ${wine} (set X87_PROBE_WINE)`);
try { execFileSync('which', [cc], { stdio: 'ignore' }); }
catch { skip(`no ${cc} on PATH (brew install mingw-w64)`); }
mkdirSync(cacheDir, { recursive: true });
execFileSync(cc, ['-O1', '-o', rotationExe, rotationSrc]);
execFileSync(cc, ['-O1', '-o', atanExe, atanSrc]);

const f32 = Math.fround;
const io = new DataView(new ArrayBuffer(8));
const f32bits = v => { io.setFloat32(0, v, true); return io.getUint32(0, true); };
const f32hex = v => f32bits(v).toString(16).padStart(8, '0');
const f64bits = v => { io.setFloat64(0, v, true); return io.getBigUint64(0, true); };
const vecHex = v => v.map(f32hex);

// --------------------------------------------------------------------------
// Mock actors: the probe fabricates raw native memory; the module reads the
// same script-declared fields through services.read/write.  The packed bool
// dwords stay raw and surface their bits as named flag properties so writes
// (bLOSflag toggles) update the dword the oracle reports.
// --------------------------------------------------------------------------
const FIELD = {
  location: 'Location', rotation: 'Rotation', viewRotation: 'ViewRotation',
  collisionRadius: 'CollisionRadius', collisionHeight: 'CollisionHeight',
  baseEyeHeight: 'BaseEyeHeight', eyeHeight: 'EyeHeight', stimulus: 'Stimulus',
  sightRadius: 'SightRadius', peripheralVision: 'PeripheralVision',
  hearingThreshold: 'HearingThreshold', lastSeenTime: 'LastSeenTime',
  fovAngle: 'FovAngle', field458: 'Skill', aiAddViewRotation: 'AIAddViewRotation',
  aiHorizontalFov: 'AIHorizontalFOV', aspectRatio: 'AspectRatio',
  angularResolution: 'AngularResolution', minAngularSize: 'MinAngularSize',
  visibilityThreshold: 'VisibilityThreshold', smellThreshold: 'SmellThreshold',
  lastSeenPos: 'LastSeenPos', lastSeeingPos: 'LastSeeingPos',
  owner: 'Owner', enemy: 'Enemy', pri: 'PlayerReplicationInfo',
  nextPawn: 'nextPawn', weapon: 'Weapon', field60c: 'ViewTarget',
};
const FLOAT_FIELDS = new Set([
  'collisionRadius', 'collisionHeight', 'baseEyeHeight', 'eyeHeight',
  'stimulus', 'sightRadius', 'peripheralVision', 'hearingThreshold',
  'lastSeenTime', 'fovAngle', 'field458', 'aiHorizontalFov', 'aspectRatio',
  'angularResolution', 'minAngularSize', 'visibilityThreshold', 'smellThreshold',
]);
const ROT_FIELDS = new Set(['rotation', 'viewRotation', 'aiAddViewRotation']);
const VEC_FIELDS = new Set(['location', 'lastSeenPos', 'lastSeeingPos', 'velocity', 'floor']);
const REF_FIELDS = new Set(['owner', 'enemy', 'pri', 'weapon', 'field60c']);
// Packed-bool dword -> { property: bit mask }, matching the native offsets.
const FLAG_DWORDS = {
  flags318: { bBehindView: 0x00000001, bIsPlayer: 0x00000002, bLOSflag: 0x00080000 },
  flags2c: { bDetectable: 0x00000001 },
  flags1dc: { bProjTarget: 0x00000010 },
  flags28: { bHidden: 0x00000002, bNetTemporary: 0x01000000, bBlockSight: 0x80000000 },
};
// Probe cls -> the ancestor name chain the worker's IsA walks reproduce.
const CLS_CHAIN = {
  pawn: ['pawn', 'actor'], playerpawn: ['playerpawn', 'pawn', 'actor'],
  levelinfo: ['levelinfo', 'actor'], inventory: ['inventory', 'actor'],
  actor: ['actor'],
};

function clsChain(cls) {
  if (!cls || cls === 'none') return [];
  if (cls.endsWith('*')) {
    const base = cls.slice(0, -1);
    return ['sub' + base, ...(CLS_CHAIN[base] ?? [base, 'actor'])];
  }
  return CLS_CHAIN[cls] ?? [cls, 'actor'];
}

function makeActor(spec = {}, objects) {
  const a = { __fields: {}, __clsChain: clsChain(spec.cls), __spec: spec };
  a.__fields.Name = spec.name ?? 'actor';
  for (const [key, prop] of Object.entries(FIELD)) {
    if (spec[key] === undefined) continue;
    if (VEC_FIELDS.has(key)) a.__fields[prop] = spec[key].map(f32);
    else if (ROT_FIELDS.has(key)) a.__fields[prop] = spec[key].map(v => v | 0);
    else if (FLOAT_FIELDS.has(key)) a.__fields[prop] = f32(spec[key]);
    else if (REF_FIELDS.has(key)) a.__fields[prop] = objects?.[spec[key]] ?? null;
    else a.__fields[prop] = spec[key];
  }
  if (spec.visibility !== undefined) a.__fields.Visibility = spec.visibility & 0xff;
  if (spec.health !== undefined) a.__fields.Health = spec.health | 0;
  if (spec.physics31 !== undefined) a.__fields.RemoteRole = spec.physics31 & 0xff;
  // Raw flag dwords plus named bit properties that read/write the dword.
  for (const [dword, bits] of Object.entries(FLAG_DWORDS)) {
    a[dword] = (spec[dword] ?? 0) >>> 0;
    for (const [prop, mask] of Object.entries(bits)) {
      Object.defineProperty(a.__fields, prop, {
        enumerable: true,
        get: () => (a[dword] & mask) !== 0,
        set: v => { a[dword] = (v ? a[dword] | mask : a[dword] & ~mask) >>> 0; },
      });
    }
  }
  a.__fields.nextPawn = null;
  return a;
}

function makeLevelInfo(spec = {}) {
  return {
    __fields: {
      NetMode: spec.netMode ?? 0,
      Game: spec.game ?? null,
      TimeSeconds: spec.timeSeconds ?? 100,
    },
    __clsChain: clsChain('levelinfo'),
  };
}

/** The JS twin of the probe's level container + command-capture queues. */
function buildScene(scene) {
  const objects = {};
  // PlayerReplicationInfo objects (referenced by pri:'name' and priMap).
  for (const [name, pspec] of Object.entries(scene.pris ?? {}))
    objects[name] = { __fields: { Team: (pspec.team ?? 0) & 0xff }, __clsChain: [] };
  const rawActors = scene.actors ?? {};
  const pawn = makeActor(scene.pawn ?? {}, objects);
  objects.self = pawn;
  for (const [name, spec] of Object.entries(rawActors)) objects[name] = makeActor(spec, objects);
  // Pawn list chain members are addressable as pawnlist0..N, like the probe.
  const pawnObjs = (scene.pawnList ?? []).map((spec, i) => {
    const a = makeActor(spec, objects);
    objects[`pawnlist${i}`] = a;
    return a;
  });
  const specOf = name => name === 'self' ? scene.pawn ?? {}
    : rawActors[name] ?? (name.startsWith('pawnlist') ? (scene.pawnList ?? [])[Number(name.slice(8))] : {}) ?? {};
  // Second pass resolves name references inside specs (enemy/owner/pri/viewTarget).
  for (const [name, a] of Object.entries(objects)) {
    if (!a?.__fields) continue;
    const spec = specOf(name);
    for (const [key, prop] of Object.entries(FIELD))
      if (REF_FIELDS.has(key) && typeof spec[key] === 'string')
        a.__fields[prop] = objects[spec[key]] ?? null;
  }
  for (const [aname, prname] of Object.entries(scene.priMap ?? {}))
    if (objects[aname]?.__fields) objects[aname].__fields.PlayerReplicationInfo = objects[prname];
  for (const [i, p] of pawnObjs.entries()) p.__fields.nextPawn = pawnObjs[i + 1] ?? null;
  const levelSpec = scene.level ?? {};
  const game = (levelSpec.game || levelSpec.teamGame)
    ? { __fields: { bTeamGame: Boolean(levelSpec.teamGame) }, __clsChain: [] }
    : null;
  const levelInfo = makeLevelInfo({ ...levelSpec, game });
  const level = {
    netMode: levelSpec.netMode ?? 0,
    model: { kind: 'model' },
    hash: null,
    actors: [levelInfo, ...pawnObjs,
      ...Object.entries(rawActors).filter(([, s]) => s?.inLevel !== false).map(([n]) => objects[n])],
    pawnList: pawnObjs[0] ?? null,
    netPlayers: (levelSpec.netActors ?? []).map(n => objects[n] ?? null),
  };
  const queues = {
    fastLine: [...(scene.fastLine ?? [1])], fi: 0,
    singleLine: [...(scene.singleLine ?? [1])], si: 0,
    lighting: [...(scene.lighting ?? [0.5])], li: 0,
    rand: [...(scene.rand ?? [0.75])], ri: 0,
  };
  const captured = { traces: [], slTraces: [], lights: [] };
  const services = {
    read: (o, n) => (o ? o.__fields[n] : undefined),
    write: (o, n, v) => { o.__fields[n] = v; },
    level: () => level,
    levelInfo: l => l.actors[0],
    levelActors: l => l.actors,
    model: l => l.model,
    pawnList: l => l.pawnList,
    nextPawn: p => p?.__fields.nextPawn ?? null,
    netPlayers: l => l.netPlayers,
    isA: (o, n) => Boolean(o?.__clsChain?.includes(String(n).toLowerCase())),
    rand: () => queues.rand[queues.ri++ % queues.rand.length] ?? 0,
    sameTeam: (viewer, cand, levelInfo) => {
      const game = levelInfo.__fields.Game;
      if (!game) return false;
      const vp = viewer.__fields.PlayerReplicationInfo, cp = cand.__fields.PlayerReplicationInfo;
      if (!vp || !cp) return false;
      if (!game.__fields.bTeamGame) return false;
      return (vp.__fields.Team & 0xff) === (cp.__fields.Team & 0xff);
    },
    lighting: (other, loc) => {
      captured.lights.push({ other: nameOf(other, objects), loc: loc.map(f32hex) });
      return queues.lighting[queues.li++ % queues.lighting.length] ?? 0;
    },
    fastLineCheck: (model, end, start) => {
      captured.traces.push({ end: end.map(f32hex), start: start.map(f32hex) });
      return queues.fastLine[queues.fi++ % queues.fastLine.length] ?? 0;
    },
    singleLineCheck: (level, viewer, target, end, start) => {
      captured.slTraces.push({
        pawn: nameOf(viewer, objects), other: nameOf(target, objects), end: end.map(f32hex),
      });
      return queues.singleLine[queues.si++ % queues.singleLine.length] ?? 0;
    },
    atan: x => (Object.keys(atanTable).length ? atanLookup(atanTable, x) : Math.atan(x)),
    vectorToRotator: Object.keys(rotationTable).length ? v => rotationLookup(rotationTable, v) : undefined,
  };
  return { objects, pawn, levelInfo, level, services, queues, captured };
}

function nameOf(actor, objects) {
  if (actor == null) return null;
  for (const [n, a] of Object.entries(objects)) if (a === actor) return n;
  return 'unknown';
}

const swap = h => h.match(/../g).reverse().join('');
function rotationLookup(table, vec) {
  const key = vec.map(v => swap(f32hex(v))).join('');
  const row = table[key];
  if (!row) throw new Error(`missing rotation oracle for ${key}`);
  return row;
}
function atanLookup(table, x) {
  const key = f64bits(x).toString(16).padStart(16, '0');
  const row = table[key];
  if (row === undefined) throw new Error(`missing atan oracle for ${key}`);
  const buf = new DataView(new ArrayBuffer(8));
  buf.setBigUint64(0, BigInt('0x' + row));   // row is the u64 double bits (hex)
  return buf.getFloat64(0);
}

/** Runs the module over a scene, returning the same shape the probe emits. */
function runJs(scene, mod = module) {
  const { objects, pawn, level, services, captured, queues } = buildScene(scene);
  const argValues = (scene.args ?? []).map(arg => {
    if (arg.kind === 'vector') return arg.value.map(f32);
    if (arg.kind === 'float') return f32(arg.value);
    if (arg.kind === 'int') return arg.value | 0;
    if (arg.kind === 'object') return objects[arg.value] ?? null;
    if (arg.kind === 'outfloat') {
      const cell = { reference: {}, value: f32(arg.seed ?? 0), get() { return this.value; }, set(v) { this.value = v; } };
      return cell;
    }
    if (arg.kind === 'out') return { reference: {}, value: objects[arg.value] ?? null, get() { return this.value; }, set(v) { this.value = v; } };
    return undefined;
  });
  const outCells = argValues.filter(a => a && a.reference);
  // A 'nothing' token is an omitted optional — argumentCount stops at the first
  // one, exactly as the native exec stops reading provided args at EX_Nothing.
  const firstNothing = (scene.args ?? []).findIndex(a => a.kind === 'nothing');
  const call = {
    receiver: pawn,
    argumentCount: firstNothing === -1 ? argValues.length : firstNothing,
    evaluateArgument: i => argValues[i],
  };
  const bodies = {
    LineOfSightTo: () => mod.execLineOfSightTo(call, services),
    CanSee: () => mod.execCanSee(call, services),
    PlayerCanSeeMe: () => mod.execPlayerCanSeeMe(call, services),
    PickTarget: () => mod.execPickTarget(call, services),
    PickAnyTarget: () => mod.execPickAnyTarget(call, services),
    AICanSee: () => mod.execAICanSee(call, services),
  };
  const returned = bodies[scene.body]();
  return {
    returned, returnedName: typeof returned === 'object' ? nameOf(returned, objects) : null,
    traces: captured.traces, slTraces: captured.slTraces, lights: captured.lights,
    randUsed: queues.ri,
    outFloats: outCells.map(c => f32hex(c.value)),
    pawn: {
      stimulus: f32hex(pawn.__fields.Stimulus ?? 0),
      flags318: pawn.flags318 >>> 0,
      lastSeenPos: vecHex(pawn.__fields.LastSeenPos ?? [0, 0, 0]),
      lastSeeingPos: vecHex(pawn.__fields.LastSeeingPos ?? [0, 0, 0]),
    },
  };
}

// --------------------------------------------------------------------------
// Probe driver + oracle convergence for the transcendental tables.
// --------------------------------------------------------------------------
const runProbe = payload =>
  JSON.parse(execFileSync(python, [probeScript], {
    input: JSON.stringify(payload), maxBuffer: 1 << 28, encoding: 'utf8', cwd: root,
  }));

/** Measure each missed FVector::Rotation input on real silicon. */
function measureRotations(keys, table) {
  if (!keys.size) return;
  const lines = [...keys].map(key =>
    `${swap(key.slice(0, 8))} ${swap(key.slice(8, 16))} ${swap(key.slice(16, 24))}`);
  const csv = execFileSync(wine, [rotationExe], {
    input: lines.join('\n') + '\n',
    env: { ...process.env, CX_BOTTLE: bottle }, encoding: 'utf8', maxBuffer: 1 << 24,
  });
  for (const line of csv.split('\n')) {
    const p = line.trim().split(',');
    if (p.length !== 6 || p[0].startsWith('#')) continue;
    const key = p.slice(0, 3).map(h => swap(h.toLowerCase().padStart(8, '0'))).join('');
    table[key] = p.slice(3).map(h => Number(BigInt.asIntN(32, BigInt('0x' + h))));
  }
}

/** Measure each missed appAtan(double) input on real silicon. */
function measureAtans(keys, table) {
  if (!keys.size) return;
  const out = execFileSync(wine, [atanExe, ...keys], {
    env: { ...process.env, CX_BOTTLE: bottle }, encoding: 'utf8', maxBuffer: 1 << 24,
  });
  for (const line of out.split('\n')) {
    const p = line.trim().split(',');
    if (p.length !== 2) continue;
    table[p[0].toLowerCase().padStart(16, '0')] = p[1].toLowerCase().padStart(16, '0');
  }
}

// --------------------------------------------------------------------------
// Scene corpus.  Field names use the probe's spec keys (see
// native-pawn-perception-probe.py:actor).  Scripted command queues drive the
// command-capture stubs: fastLine/singleLine are byte results consumed in
// order, lighting a float, rand the appFrand stream.
// --------------------------------------------------------------------------
const obj = n => ({ kind: 'object', value: n });
const vec = (x, y, z) => ({ kind: 'vector', value: [x, y, z] });
const flt = v => ({ kind: 'float', value: v });
const int = v => ({ kind: 'int', value: v });
const outf = seed => ({ kind: 'outfloat', seed });
const nth = () => ({ kind: 'nothing' });

// A mid-range NPC pawn viewer facing +x, and a same-distance pawn target.
const NPC = {
  cls: 'pawn', location: [0, 0, 0], rotation: [0, 0, 0], viewRotation: [0, 0, 0],
  baseEyeHeight: 40, collisionRadius: 32, collisionHeight: 44, health: 100,
  sightRadius: 2000, peripheralVision: -0.5, field458: 0, stimulus: 0,
  aiHorizontalFov: 90, aspectRatio: 1.333333, minAngularSize: 0.0001,
  visibilityThreshold: 0.2, aiAddViewRotation: [0, 0, 0], flags318: 0,
  flags1dc: 0x10, flags2c: 0x1, flags28: 0, visibility: 128,
};
const TGT_PAWN = {
  cls: 'pawn', collisionRadius: 32, collisionHeight: 44, baseEyeHeight: 40,
  health: 100, flags1dc: 0x10, flags2c: 0x1, visibility: 128,
};
const TGT_ACTOR = {
  cls: 'inventory', collisionRadius: 20, collisionHeight: 20,
  flags1dc: 0x10, flags2c: 0x1, visibility: 128,
};

const scenes = [
  // ===== LineOfSightTo (514) — flat path, distSq metric =====================
  // Near pawn, clear top-center trace.
  { name: 'los-near-clear', body: 'LineOfSightTo',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t'), int(0)], fastLine: [1] },
  // Near pawn, every trace blocked.
  { name: 'los-near-blocked', body: 'LineOfSightTo',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t'), int(0)], fastLine: [0, 0, 0, 0, 0] },
  // Far pawn beyond the flat-path cap -> return 0 with no trace.
  { name: 'los-far-gate', body: 'LineOfSightTo',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [5000, 0, 0] } },
    args: [obj('t'), int(0)], fastLine: [1] },
  // Far pawn past the 1e6 split but inside the cap*0.5 prob gate; the NPC
  // rand gate traces when appFrand >= 0.5.
  { name: 'los-far-decay-trace', body: 'LineOfSightTo',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [2000, 0, 0] } },
    args: [obj('t'), int(0)], rand: [0.9], fastLine: [1] },
  // Same far pawn, appFrand < 0.5 -> return 0 with no trace.
  { name: 'los-far-decay-skip', body: 'LineOfSightTo',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [2000, 0, 0] } },
    args: [obj('t'), int(0)], rand: [0.2], fastLine: [1] },
  // Far pawn beyond cap*0.5 -> the probability gate returns 0 before frand.
  { name: 'los-far-probgate', body: 'LineOfSightTo',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [3000, 0, 0] } },
    args: [obj('t'), int(0)], rand: [0.2], fastLine: [1] },
  // bIgnoreDistance bypasses the cap and forces the near path.
  { name: 'los-ignore-distance', body: 'LineOfSightTo',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [5000, 0, 0] } },
    args: [obj('t'), int(1)], fastLine: [1] },
  // bIgnoreDistance passed a non-1 truthy int -> native treats it as false.
  { name: 'los-ignore-non1', body: 'LineOfSightTo',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [5000, 0, 0] } },
    args: [obj('t'), int(2)], fastLine: [1] },
  // Non-pawn target uses the smaller flat cap (9e6 npc / 16e6 player).
  { name: 'los-nonpawn-cap', body: 'LineOfSightTo',
    pawn: { ...NPC }, actors: { t: { ...TGT_ACTOR, location: [3500, 0, 0] } },
    args: [obj('t'), int(0)], fastLine: [1] },
  // Player viewer (bIsPlayer): far split reached, prob gate passes, then
  // bIsPlayer short-circuits the rand gate straight to the direct trace.
  { name: 'los-player-viewer', body: 'LineOfSightTo',
    pawn: { ...NPC, flags318: 0x2 },
    actors: { t: { ...TGT_PAWN, location: [2500, 0, 0] } },
    args: [obj('t'), int(0)], fastLine: [1] },
  // Enemy target: two dedicated traces then the near/far split; both stamp.
  { name: 'los-enemy-clear', body: 'LineOfSightTo',
    pawn: { ...NPC, enemy: 't' }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t'), int(0)], fastLine: [1] },
  { name: 'los-enemy-blocked-near', body: 'LineOfSightTo',
    pawn: { ...NPC, enemy: 't' }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t'), int(0)], fastLine: [0, 0, 1] },
  // Blocked enemy beyond 1e6 distSq -> the far split returns 0, no more traces.
  { name: 'los-enemy-blocked-far', body: 'LineOfSightTo',
    pawn: { ...NPC, enemy: 't' }, actors: { t: { ...TGT_PAWN, location: [1500, 0, 0] } },
    args: [obj('t'), int(0)], fastLine: [0, 0, 0, 0, 0] },

  // ===== CanSee (533) — FOV path, scaled metric ============================
  // Target dead ahead (dot=1 > PV): stimulus high, scaled within cap -> traces.
  { name: 'see-front-clear', body: 'CanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t')], fastLine: [1] },
  // Target behind (dot=-1): stimulus <= 0 -> return 0 with no trace.
  { name: 'see-behind', body: 'CanSee',
    pawn: { ...NPC, peripheralVision: 0.7 },
    actors: { t: { ...TGT_PAWN, location: [-300, 0, 0] } },
    args: [obj('t')], fastLine: [1] },
  // Far target: scaled exceeds the FOV cap -> return 0, no trace.
  { name: 'see-far-gate', body: 'CanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [3000, 0, 0] } },
    args: [obj('t')], fastLine: [1] },
  // Top-center blocked then a corner clears (near pawn, all corners traced
  // when checkFOV keeps the flag clear on this frame's budget).
  { name: 'see-corner', body: 'CanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t')], fastLine: [0, 1] },
  // Scaled metric sensitive to the Skill divisor: a steep target whose dz term
  // pushes scaled over the FOV cap only when the divisor stays at its floor.
  { name: 'see-scaled-far', body: 'CanSee',
    pawn: { ...NPC, field458: 0 },
    actors: { t: { ...TGT_PAWN, location: [100, 0, 1100] } },
    args: [obj('t')], fastLine: [1] },
  // Enemy forces checkFOV=0 -> flat path (bLOSflag is not toggled).
  { name: 'see-enemy', body: 'CanSee',
    pawn: { ...NPC, enemy: 't' }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t')], fastLine: [1] },

  // ===== PlayerCanSeeMe (532) ==============================================
  // netMode 0 -> net players list; viewer in range and facing -> 1.
  { name: 'pcsm-net0-clear', body: 'PlayerCanSeeMe',
    pawn: { ...TGT_PAWN, location: [300, 0, 0], flags1dc: 0x10 },
    level: { netMode: 0, netActors: ['v'] },
    actors: { v: { cls: 'playerpawn', location: [0, 0, 0], viewRotation: [0, 0, 0], baseEyeHeight: 40, collisionRadius: 32, collisionHeight: 44, sightRadius: 2000, peripheralVision: -0.5, field458: 0, flags318: 0x2, health: 100 } },
    args: [], fastLine: [1] },
  // netMode 0, viewer's ViewTarget == actor -> immediate 1 (no distance test).
  { name: 'pcsm-viewtarget', body: 'PlayerCanSeeMe',
    pawn: { ...TGT_PAWN, location: [9000, 0, 0], flags1dc: 0x10 },
    level: { netMode: 0, netActors: ['v'] },
    actors: { v: { cls: 'playerpawn', location: [0, 0, 0], field60c: 'self', viewRotation: [0, 0, 0], baseEyeHeight: 40, collisionRadius: 32, collisionHeight: 44, sightRadius: 2000, peripheralVision: -0.5, field458: 0, flags318: 0x2, health: 100 } },
    args: [], fastLine: [1] },
  // netMode 0, viewer too far (distSq >= (actorCR+3.6)*1e5) -> 0.
  { name: 'pcsm-far', body: 'PlayerCanSeeMe',
    pawn: { ...TGT_PAWN, location: [700, 0, 0], flags1dc: 0x10 },
    level: { netMode: 0, netActors: ['v'] },
    actors: { v: { cls: 'playerpawn', location: [0, 0, 0], viewRotation: [0, 0, 0], baseEyeHeight: 40, collisionRadius: 32, collisionHeight: 44, sightRadius: 2000, peripheralVision: -0.5, field458: 0, flags318: 0x2, health: 100 } },
    args: [], fastLine: [1] },
  // netMode 1 (server) -> pawn list; viewer behind (dot^2 < distSq*0.25) -> 0.
  { name: 'pcsm-pawnlist-behind', body: 'PlayerCanSeeMe',
    pawn: { ...TGT_PAWN, location: [-300, 0, 0], flags1dc: 0x10 },
    level: { netMode: 1 },
    pawnList: [{ cls: 'playerpawn', location: [0, 0, 0], viewRotation: [0, 0, 0], baseEyeHeight: 40, collisionRadius: 32, collisionHeight: 44, sightRadius: 2000, peripheralVision: -0.5, field458: 0, flags318: 0x2, health: 100 }],
    args: [], fastLine: [1] },

  // ===== PickTarget (531) ===================================================
  // One candidate wins -> bestAim/bestDist written, returns the pawn.
  { name: 'pt-basic', body: 'PickTarget',
    pawn: { ...NPC, location: [0, 0, 0] },
    level: { game: 1 },
    pawnList: [{ ...TGT_PAWN, location: [300, 0, 0] }],
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], fastLine: [1] },
  // Candidate behind the fire direction (dot<=0) -> skipped, no winner.
  { name: 'pt-behind', body: 'PickTarget',
    pawn: { ...NPC, location: [0, 0, 0] },
    level: { game: 1 },
    pawnList: [{ ...TGT_PAWN, location: [-300, 0, 0] }],
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], fastLine: [1] },
  // Candidate beyond the 4e6 PickTarget cap but inside the shared worker's own
  // distance gate -> the PickTarget cap is the unique filter that rejects it.
  { name: 'pt-far', body: 'PickTarget',
    pawn: { ...NPC, location: [0, 0, 0] },
    level: { game: 1 },
    pawnList: [{ ...TGT_PAWN, location: [2500, 0, 0] }],
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], rand: [0.9], fastLine: [1] },
  // Dead candidate (health<=0) -> skipped.
  { name: 'pt-dead', body: 'PickTarget',
    pawn: { ...NPC, location: [0, 0, 0] },
    level: { game: 1 },
    pawnList: [{ ...TGT_PAWN, location: [300, 0, 0], health: 0 }],
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], fastLine: [1] },
  // Candidate without bProjTarget -> skipped.
  { name: 'pt-noprojtarget', body: 'PickTarget',
    pawn: { ...NPC, location: [0, 0, 0] },
    level: { game: 1 },
    pawnList: [{ ...TGT_PAWN, location: [300, 0, 0], flags1dc: 0 }],
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], fastLine: [1] },
  // No GameInfo -> candidate skipped even though everything else passes.
  { name: 'pt-nogame', body: 'PickTarget',
    pawn: { ...NPC, location: [0, 0, 0] },
    level: {},
    pawnList: [{ ...TGT_PAWN, location: [300, 0, 0] }],
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], fastLine: [1] },
  // Team game, same team byte -> skipped.
  { name: 'pt-sameteam', body: 'PickTarget',
    pawn: { ...NPC, location: [0, 0, 0], pri: 'p0' },
    level: { teamGame: 1 },
    pris: { p0: { team: 2 }, p1: { team: 2 } },
    pawnList: [{ ...TGT_PAWN, location: [300, 0, 0], pri: 'p1' }],
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], fastLine: [1] },
  // Worker fails (trace blocked) -> candidate skipped, no winner.
  { name: 'pt-blocked', body: 'PickTarget',
    pawn: { ...NPC, location: [0, 0, 0] },
    level: { game: 1 },
    pawnList: [{ ...TGT_PAWN, location: [300, 0, 0] }],
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], fastLine: [0, 0, 0, 0, 0] },
  // Higher-score candidate wins over a nearer lower-score one.
  { name: 'pt-score', body: 'PickTarget',
    pawn: { ...NPC, location: [0, 0, 0] },
    level: { game: 1 },
    pawnList: [
      { ...TGT_PAWN, location: [300, 0, 0], name: 'c0' },
      { ...TGT_PAWN, location: [400, 0, 0], name: 'c1' },
    ],
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], fastLine: [1, 1] },

  // ===== PickAnyTarget (534) ===============================================
  // Non-pawn bProjTarget target wins; pawns are excluded.
  { name: 'pat-nonpawn', body: 'PickAnyTarget',
    pawn: { ...NPC, location: [0, 0, 0] },
    level: {},
    actors: { t: { ...TGT_ACTOR, location: [300, 0, 0], inLevel: true } },
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], fastLine: [1] },
  // Non-pawn candidate without bProjTarget is filtered out (no winner).
  { name: 'pat-noproj', body: 'PickAnyTarget',
    pawn: { ...NPC, location: [0, 0, 0] },
    level: {},
    actors: { t: { ...TGT_ACTOR, location: [300, 0, 0], inLevel: true, flags1dc: 0 } },
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], fastLine: [1] },
  // A pawn in the actor list is skipped (isA(Pawn) excludes it).
  { name: 'pat-skips-pawn', body: 'PickAnyTarget',
    pawn: { ...NPC, location: [0, 0, 0] },
    level: {},
    actors: { t: { ...TGT_PAWN, location: [300, 0, 0], inLevel: true } },
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], fastLine: [1] },
  // Non-pawn target beyond the distance cap -> skipped.
  { name: 'pat-far', body: 'PickAnyTarget',
    pawn: { ...NPC, location: [0, 0, 0] },
    level: {},
    actors: { t: { ...TGT_ACTOR, location: [3000, 0, 0], inLevel: true } },
    args: [outf(0), outf(0), vec(1, 0, 0), vec(0, 0, 40)], fastLine: [1] },

  // ===== AICanSee (705) =====================================================
  // Arg order: [object, visibility, bCheckVis, bCheckDir, bCheckCyl, bCheckLOS];
  // the optional bools default 1,1,0,1 (bCheckCylinder defaults OFF).
  // Visible target dead ahead: angular size, dir trapezoid, lighting, LOS.
  { name: 'aic-clear', body: 'AICanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t'), flt(1), int(1), int(1), int(1), int(1)], singleLine: [1], lighting: [0.8] },
  // Null target -> 0.
  { name: 'aic-null', body: 'AICanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('none'), nth(), nth(), nth(), nth(), nth()] },
  // Non-positive visibility -> 0.
  { name: 'aic-zerovis', body: 'AICanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t'), flt(0), nth(), nth(), nth(), nth()] },
  // !bDetectable -> 0.
  { name: 'aic-nodetect', body: 'AICanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0], flags2c: 0 } },
    args: [obj('t'), nth(), nth(), nth(), nth(), nth()] },
  // Angular size below MinAngularSize -> 0.
  { name: 'aic-minsize', body: 'AICanSee',
    pawn: { ...NPC, minAngularSize: 0.5 },
    actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t'), nth(), nth(), nth(), nth(), nth()] },
  // Behind the viewer (yaw outside the trapezoid) -> acc 0, no LOS trace.
  { name: 'aic-behind', body: 'AICanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [-300, 0, 0] } },
    args: [obj('t'), nth(), nth(), nth(), nth(), nth()], singleLine: [1], lighting: [0.8] },
  // bCheckCylinder defaults OFF -> a point trace, not the cylinder fan.
  { name: 'aic-point-default', body: 'AICanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t'), nth(), nth(), nth(), nth(), nth()], singleLine: [1], lighting: [0.8] },
  // Direction check off -> no trapezoid/rotation; still LOS.
  { name: 'aic-nodir', body: 'AICanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [-300, 0, 0] } },
    args: [obj('t'), flt(1), int(1), int(0), int(1), int(1)], singleLine: [1], lighting: [0.8] },
  // Visibility check off -> no lighting query consumed.
  { name: 'aic-novis', body: 'AICanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t'), flt(1), int(0), int(1), int(1), int(1)], singleLine: [1] },
  // LOS check off -> acc survives without a trace.
  { name: 'aic-nolos', body: 'AICanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t'), flt(1), int(1), int(1), int(1), int(0)], lighting: [0.8] },
  // LOS blocked -> acc forced 0.
  { name: 'aic-los-blocked', body: 'AICanSee',
    pawn: { ...NPC }, actors: { t: { ...TGT_PAWN, location: [300, 0, 0] } },
    args: [obj('t'), flt(1), int(1), int(1), int(1), int(1)], singleLine: [0, 0, 0, 0], lighting: [0.8] },
  // Cylindrical player target (large enough to fill the view): 3 vertical traces.
  { name: 'aic-cyl-player', body: 'AICanSee',
    pawn: { ...NPC, minAngularSize: 0 },
    actors: { t: { cls: 'playerpawn', location: [60, 0, 0], collisionRadius: 30, collisionHeight: 40, baseEyeHeight: 30, health: 100, flags1dc: 0x10, flags2c: 0x1, visibility: 128 } },
    args: [obj('t'), flt(1), int(1), int(1), int(1), int(1)], singleLine: [1, 1, 1], lighting: [0.8] },
  // Cylindrical non-player target: top, bottom, then two side-fan traces.
  { name: 'aic-cyl-npc', body: 'AICanSee',
    pawn: { ...NPC, minAngularSize: 0 },
    actors: { t: { ...TGT_PAWN, location: [60, 0, 0], collisionRadius: 30, collisionHeight: 40 } },
    args: [obj('t'), flt(1), int(1), int(1), int(1), int(1)], singleLine: [1, 1, 1, 1], lighting: [0.8] },
  // Near target pitch floor: distSq<22500 keeps pitch trapezoid >= 0.75 even
  // when the target is steeply above (pitch outside the plateau).  Low
  // visibility keeps acc near the threshold so the floor value is observable.
  { name: 'aic-pitch-floor', body: 'AICanSee',
    pawn: { ...NPC, minAngularSize: 0 },
    actors: { t: { ...TGT_PAWN, location: [40, 0, 110] } },
    args: [obj('t'), flt(0.02), int(1), int(1), int(1), int(1)], singleLine: [1], lighting: [0.8] },
  // bCheckCylinder on but the target is too small to fill the view: the
  // angular-size gate drops it to a single point trace instead of the fan.
  // High visibility keeps acc above the threshold so the LOS path is reached.
  { name: 'aic-cyl-far', body: 'AICanSee',
    pawn: { ...NPC, minAngularSize: 0 },
    actors: { t: { ...TGT_PAWN, location: [3500, 0, 0] } },
    args: [obj('t'), flt(20), int(1), int(1), int(1), int(1)], singleLine: [1], lighting: [0.8] },
];

// --------------------------------------------------------------------------
// Oracle convergence: run the corpus, measure every unmeasured FVector::Rotation
// and appAtan input on real silicon, fold them into the tables, re-run until
// the probe reports no misses.  The module consumes the same tables through
// the services.atan / services.vectorToRotator seams.
// --------------------------------------------------------------------------
const rotationTable = {}, atanTable = {};
for (let round = 0; round < 5; round++) {
  const payload = scenes.map(s => ({ ...s, rotationTable, atanTable }));
  const results = runProbe(payload);
  const rotMiss = new Set(), atanMiss = new Set();
  results.forEach((r, i) => {
    if (r.ok) scenes[i].result = r.result;
    else { scenes[i].result = r; }
    for (const miss of r.result?.missedOracles ?? []) {
      if (miss[0] === 'rotation') rotMiss.add(miss[1]);
      else if (miss[0] === 'atan') atanMiss.add(miss[1]);
    }
  });
  if (!rotMiss.size && !atanMiss.size) break;
  measureRotations(rotMiss, rotationTable);
  measureAtans(atanMiss, atanTable);
  writeFileSync(path.join(cacheDir, 'rotation-table.json'), JSON.stringify(rotationTable));
  writeFileSync(path.join(cacheDir, 'atan-table.json'), JSON.stringify(atanTable));
  if (round === 4) throw new Error('Perception transcendental oracle misses did not converge');
}

// --------------------------------------------------------------------------
// Compare every scene.
// --------------------------------------------------------------------------
function normalizeProbe(r) {
  const byAddr = {};
  for (const [n, a] of Object.entries(r.addresses ?? {})) byAddr[a] = n;
  byAddr[r.pawnAddress] = 'self';
  const ref = a => (a === 0 ? null : byAddr[a] ?? `0x${(a >>> 0).toString(16)}`);
  return {
    resultOut: r.resultOut, resultOutValue: r.resultOutValue,
    returned: ref(r.returned),
    winner: ref(parseInt(r.resultOut, 16)),
    traces: r.traces.map(t => ({ end: t.end.map(f32hex), start: t.start.map(f32hex) })),
    slTraces: r.slTraces.map(t => ({ pawn: ref(t.pawn), other: ref(t.other), end: t.end.map(f32hex) })),
    lights: r.lights.map(l => ({ other: ref(l.other), loc: l.loc.map(f32hex) })),
    randUsed: r.randUsed,
    outFloats: Object.values(r.outFloats ?? {}).map(f32hex),
    pawn: {
      stimulus: f32hex(r.pawn.stimulus),
      flags318: r.pawn.flags318 >>> 0,
      lastSeenPos: r.pawn.lastSeenPosBits,
      lastSeeingPos: r.pawn.lastSeeingPosBits,
    },
  };
}

function compare(name, oracle, js, body) {
  const diffs = [];
  const eq = (label, a, b) => {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) diffs.push(`${label}: oracle ${sa} vs js ${sb}`);
  };
  if (body === 'PickTarget' || body === 'PickAnyTarget') {
    eq('resultOut', oracle.winner, js.returnedName);
    eq('outFloats', oracle.outFloats, js.outFloats);
  } else if (body === 'AICanSee') {
    eq('resultOut', oracle.resultOut, f32hex(js.returned));
  } else {
    eq('resultOut', parseInt(oracle.resultOut, 16), js.returned & 0xff);
  }
  eq('traces', oracle.traces, js.traces);
  eq('slTraces', oracle.slTraces, js.slTraces);
  eq('lights', oracle.lights, js.lights);
  eq('randUsed', oracle.randUsed, js.randUsed);
  for (const k of Object.keys(oracle.pawn)) eq(`pawn.${k}`, oracle.pawn[k], js.pawn[k]);
  return diffs.map(d => `${name}: ${d}`);
}

function compareAll(mod) {
  let failures = 0; const failed = [];
  for (const scene of scenes) {
    const r = scene.result;
    if (!r || r.ok === false) { console.log(`FAIL ${scene.name}: probe error — ${r?.error ?? 'no result'}`); failures++; failed.push(scene.name); continue; }
    let js;
    try { js = runJs(scene, mod); }
    catch (e) { console.log(`FAIL ${scene.name}: js threw ${e.stack ?? e}`); failures++; failed.push(scene.name); continue; }
    const diffs = compare(scene.name, normalizeProbe(r), js, scene.body);
    if (diffs.length) { failures++; failed.push(scene.name); diffs.forEach(d => console.log(`FAIL ${d}`)); }
  }
  return { failures, failed };
}

const { failures, failed } = compareAll(module);
const passed = scenes.length - failures;
console.log(`${failures ? 'FAIL' : 'PASS'} validate-pawn-perception: ${passed}/${scenes.length} scenes bit-exact`);
if (failures) process.exit(1);

// --------------------------------------------------------------------------
// Mutation coverage: each edit rewrites one behavior the disassembly dictates;
// the suite proves sensitivity by requiring the listed scenes to flip.
// --------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
const SRC = readFileSync(modulePath, 'utf8');
const MUTATIONS = [
  // --- Shared LOS worker (514/533/532) ---
  // NPC flat-path scaled multiplier (visScale*4000 -> cap bound).
  { name: 'los-flat-cap-npc', pattern: 'const s = x87mul(ld(visScale), ld(isPlayer ? 5000 : 4000));',
    replacement: 'const s = x87mul(ld(visScale), ld(isPlayer ? 5000 : 2000));',
    expect: ['los-far-decay-trace'] },
  { name: 'los-near-split', pattern: 'if (scaledOrDistFinal <= 1000000 || bIgnoreDistance) {',
    replacement: 'if (scaledOrDistFinal <= 4000000 || bIgnoreDistance) {',
    expect: ['los-far-decay-trace'] },
  { name: 'see-stim-hi', pattern: 'const k = tIsPos ? D08 : D017;',
    replacement: 'const k = tIsPos ? ld64(-0.8) : D017;',
    expect: ['see-front-clear'] },
  { name: 'see-scaled-divisor', pattern: "const divisor = Math.max(Number(rd(services, viewer, 'Skill')) + 1, 1);",
    replacement: "const divisor = Math.max(Number(rd(services, viewer, 'Skill')) + 2, 1);",
    expect: ['see-scaled-far'] },
  // --- PlayerCanSeeMe (532) ---
  { name: 'pcsm-netmode-branch', pattern: 'if (netMode === 0) useNetList = true;',
    replacement: 'if (netMode === 0) useNetList = false;',
    expect: ['pcsm-net0-clear'] },
  { name: 'pcsm-dist-cap', pattern: 'const cap = st(x87mul(x87add(ld(aCR), ld64(3.6)), ld64(100000)));',
    replacement: 'const cap = st(x87mul(x87add(ld(aCR), ld64(3.6)), ld64(1000)));',
    expect: ['pcsm-net0-clear'] },
  // --- PickTarget (531) ---
  { name: 'pt-dist-cap', pattern: 'if (!(distSq < 4000000)) continue;',
    replacement: 'if (!(distSq < 10000000)) continue;',
    expect: ['pt-far'] },
  { name: 'pt-game-req', pattern: "if (!rd(services, levelInfo, 'Game')) continue;",
    replacement: "if (false) continue;",
    expect: ['pt-nogame'] },
  // --- PickAnyTarget (534) ---
  { name: 'pat-pawn-excl', pattern: "if (services.isA(cand, 'Pawn')) continue;",
    replacement: 'if (false) continue;',
    expect: ['pat-skips-pawn'] },
  { name: 'pat-projtarget', pattern: "if (!truthy(rd(services, cand, 'bProjTarget'))) continue;\n      if (services.isA(cand, 'Pawn')) continue;",
    replacement: "if (false) continue;\n      if (services.isA(cand, 'Pawn')) continue;",
    expect: ['pat-noproj'] },
  // --- AICanSee (705) ---
  { name: 'aic-angmul', pattern: 'let acc = st(x87mul(x87mul(ld(visibility), ld(ratio)), ld(64)));',
    replacement: 'let acc = st(x87mul(x87mul(ld(visibility), ld(ratio)), ld(32)));',
    expect: ['aic-clear'] },
  { name: 'aic-pitch-floor', pattern: 'if (distSq < 22500 && pitchTrap < 0.75) pitchTrap = 0.75;',
    replacement: 'if (distSq < 22500 && pitchTrap < 0.75) pitchTrap = 0.25;',
    expect: ['aic-pitch-floor'] },
  { name: 'aic-cyl-gate', pattern: 'const cyl = bCheckCylinder && (ratio >= 0.0003046792916483);',
    replacement: 'const cyl = bCheckCylinder;',
    expect: ['aic-cyl-far'] },
];

const tmpModule = path.join(path.dirname(modulePath), '.mutant-perception.mjs');
let mutFailures = 0;
for (const mut of MUTATIONS) {
  if (!SRC.includes(mut.pattern)) { console.log(`FAIL mutation ${mut.name}: pattern not found`); mutFailures++; continue; }
  writeFileSync(tmpModule, SRC.replace(mut.pattern, mut.replacement));
  const mod = await import(pathToFileURL(tmpModule) + `?v=${Date.now()}${mut.name}`);
  const flipped = new Set();
  for (const scene of scenes) {
    const r = scene.result;
    if (!r || r.ok === false) continue;
    let js;
    try { js = runJs(scene, mod); } catch { flipped.add(scene.name); continue; }
    const diffs = compare(scene.name, normalizeProbe(r), js, scene.body);
    if (diffs.length) flipped.add(scene.name);
  }
  const missing = mut.expect.filter(n => !flipped.has(n));
  if (missing.length) { console.log(`FAIL mutation ${mut.name}: did not flip ${missing.join(',')}`); mutFailures++; }
  else console.log(`mutation ${mut.name}: flipped ${mut.expect.join(',')}`);
}
rmSync(tmpModule, { force: true });
if (mutFailures) { console.log(`FAIL validate-pawn-perception: ${mutFailures} mutations insensitive`); process.exit(1); }
console.log(`PASS validate-pawn-perception: ${scenes.length} scenes + ${MUTATIONS.length} mutations`);
