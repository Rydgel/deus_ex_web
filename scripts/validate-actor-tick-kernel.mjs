#!/usr/bin/env node
/**
 * The Rust actor tick (native/script-vm/src/tick.rs, docs/rust-core.md R3-d)
 * against the JavaScript bodies it transcribes: actor-tick.mjs
 * tickStandaloneActor with actorInStasis and the timer phase, and
 * animation-tick.mjs tickActorAnimation over the animation tick view.
 *
 * Boots a map (SCRIPT_VM=rust, so the interpreter instance and its tick
 * kernel exist) and first plays real ticks with ACTOR_TICK_DIFFERENTIAL
 * replaying every Rust tick against the JavaScript body. Then, on real
 * actors of every ticked class, it runs cases twice from the same state:
 * once through the kernel (`actorTick.run`, the JavaScript body where it
 * hands back), once through the JavaScript body, with the same scripted
 * services. Each case sets fields (thresholds, NaN payloads, signed zeros,
 * infinities), binds or poisons fields before or during the tick, and makes
 * callbacks write fields, bind, poison, release the actor, install a
 * DemoRecDriver or throw. The result, the error, the callbacks with their
 * arguments (bit-exact numbers), the level's deferred list and DemoRecDriver,
 * every image byte, the reference array and the shadow stack pointer must
 * be identical. A case whose fields are all in the image must not be handed
 * back. Constructed cases add what random values rarely reach: a tween
 * remainder whose operand order changes the float32 result (inputs found by
 * search), velocity-scaled main and blend rates, finished main and blend
 * sequences replicating their plane (beside signaling NaNs in the other
 * blend slots), and animation flags bound while the phase runs.
 *
 *   node scripts/validate-actor-tick-kernel.mjs [--map 00_Training] [--cases 60]
 *     [--ticks 40] [--seed S] [--actors-per-class 3] [--debug Actor:case]
 *
 * --debug prints one case's setup and the actor's field mask.
 */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';

process.env.SCRIPT_VM = 'rust';
process.env.ACTOR_TICK_DIFFERENTIAL ??= '1';
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const MAP = option('map', '00_Training'), CASES = Number(option('cases', 60)), TICKS = Number(option('ticks', 40));
const PER_CLASS = Number(option('actors-per-class', 3)), DEBUG = option('debug', null);
let seed = Number(option('seed', 0x7a11)) >>> 0;

const {AssetStore} = await import('../src/unreal/assets.mjs');
const {decodeMap} = await import('../src/unreal/map.mjs');
const {createGame} = await import('../src/viewer/game.mjs');
const {gameDirectory} = await import('./game-directory.mjs');
const {tickStandaloneActor} = await import('../src/runtime/actor-tick.mjs');
const {scriptedPawnTick} = await import('../src/runtime/scripted-pawn-tick.mjs');
const {SP_FIELDS} = await import('../src/runtime/actor-tick-kernel.mjs');
const {TICK_FIELDS, actorTickStats} = await import('../src/runtime/actor-tick-kernel.mjs');
const {handleOf, releaseHandle, handleLimit} = await import('../src/runtime/script-object-handles.mjs');

// ---- Deterministic randomness ---------------------------------------------
const random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = list => list[Math.floor(random() * list.length)];
const chance = p => random() < p;
const f32 = new DataView(new ArrayBuffer(8));
const bitsOf = v => (f32.setFloat32(0, v, true), f32.getUint32(0, true));
const fromBits = b => (f32.setUint32(0, b >>> 0, true), f32.getFloat32(0, true));
/** The float32 `steps` units of least precision from v. */
const ulp = (v, steps) => {
  const b = bitsOf(Math.fround(v));
  if (!Number.isFinite(v)) return v;
  if (v === 0) return fromBits(steps > 0 ? steps : 0x80000000 - steps);
  return fromBits(v > 0 ? b + steps : b - steps);
};
// Float values as raw float32 bits (NaN payloads, signed zeros).
const RAW = {qnan: 0x7fc00000, payload: 0x7fc12345, snan: 0x7fa00001, negnan: 0xffc00001, negzero: 0x80000000,
  inf: 0x7f800000, neginf: 0xff800000, denormal: 0x00000003, max: 0x7f7fffff};
const floatEdge = around => {
  const r = random();
  if (r < 0.25) return {raw: RAW[pick(Object.keys(RAW))]};
  if (r < 0.55) return ulp(around, pick([-2, -1, 0, 1, 2]));
  if (r < 0.75) return pick([0, 1, -1, 0.5, 0.2, 0.1, 0.0001, 0.001, 5, 1200, 32767, 1e-30, 3e38, -3e38]);
  return Math.fround((random() - 0.3) * 4);
};

// ---- Boot -----------------------------------------------------------------
const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(MAP);
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, kernel = runtime.scriptVm?.actorTick;
assert.ok(kernel?.enabled, 'the Rust actor tick kernel is not enabled (SCRIPT_VM=rust, ACTOR_TICK_KERNEL unset)');
const player = game.player.collisionActor, level = runtime.levelFor(player);

// ---- Real ticks under ACTOR_TICK_DIFFERENTIAL -------------------------------
const tickErrors = new Map();
for (let i = 0; i < TICKS; i++) {
  try { game.tick(1 / 60); }
  catch (error) {
    const message = String(error?.message ?? error).split('\n')[0];
    tickErrors.set(message, (tickErrors.get(message) ?? 0) + 1);
  }
}
for (const message of tickErrors.keys()) assert.ok(!message.startsWith('ACTOR_TICK_DIFFERENTIAL'), message);
const played = {...actorTickStats(), handback: new Map(actorTickStats().handback)};
console.log(`${MAP}: ${TICKS} ticks played, ${played.verified} Rust ticks replayed against JavaScript, ` +
  `${played.compared} field states compared, ${played.mismatches} mismatches; tick errors ${JSON.stringify(Object.fromEntries(tickErrors))}`);
assert.equal(played.mismatches, 0);

// ---- Actors ---------------------------------------------------------------
const instanceOf = actor => actor?.[runtime.instanceKey] ?? runtime.instances.get(actor);
const byClass = new Map();
for (let i = level.firstDynamicActor; i < level.actors.length; i++) {
  const actor = level.actors[i], instance = instanceOf(actor);
  if (!instance?.base || instance.nativeObject?.released) continue;
  const key = instance.cls.record.key;
  if (!byClass.has(key)) byClass.set(key, []);
  if (byClass.get(key).length < PER_CLASS) byClass.get(key).push(actor);
}
const actors = [...byClass.values()].flat();
const has = (actor, name) => { try { return Boolean(runtime.lookupMember(instanceOf(actor).cls, 'fields', name)); } catch { return false; } };
const isA = (actor, key) => { for (let c = instanceOf(actor).cls; c; c = c.base) if (c.record.key === key) return true; return false; };
const sequencesOf = actor => {
  try { return runtime.meshPayload(actor)?.sequences ?? []; } catch { return []; }
};
console.log(`${actors.length} actors of ${byClass.size} classes; weapons: ${actors.filter(a => isA(a, 'engine.weapon')).map(a => a.name).join(', ') || 'none'}`);

// ---- State: save and restore around each run -------------------------------
function save(actor) {
  const instance = instanceOf(actor);
  return {actor, instance, bytes: instance.arena.bytes.slice(instance.base, instance.base + instance.size),
    refs: instance.refs ? instance.refs.slice() : null, bindings: new Set(instance.bindings.keys()),
    poison: instance.poison, nativeObject: instance.nativeObject,
    // ScriptState.latent is an accessor (script-state.mjs), so the state is
    // asked, not its own properties.
    state: instance.state, latent: instance.state ? instance.state.latent : undefined};
}
function restore(saved) {
  const {instance} = saved;
  instance.arena.bytes.set(saved.bytes, instance.base);
  if (saved.refs) for (let i = 0; i < saved.refs.length; i++) instance.refs[i] = saved.refs[i];
  // The runtime never removes a binding, and the kernel's cached mask
  // (instance.tickDesc) relies on that: drop it with the removed bindings.
  for (const key of [...instance.bindings.keys()]) if (!saved.bindings.has(key)) {
    instance.bindings.delete(key);
    instance.tickDesc = undefined;
  }
  instance.poison = saved.poison;
  instance.nativeObject = saved.nativeObject;
  if (saved.state) saved.state.latent = saved.latent;
}
const imageOf = instance => ({bytes: instance.arena.bytes.slice(instance.base, instance.base + instance.size),
  refs: instance.refs ? instance.refs.slice() : null});

/** A handle whose identity has been released (a stale pointer word). */
function releasedHandle() {
  const ghost = {name: 'released'}, handle = handleOf(ghost);
  releaseHandle(ghost);
  return handle;
}

// ---- Field setup ------------------------------------------------------------
const KEY = Object.fromEntries(TICK_FIELDS.map(([name, key]) => [name, key]));
function writeField(actor, name, value) {
  if (!has(actor, name)) return;
  const instance = instanceOf(actor), key = KEY[name] ?? runtime.lookupMember(instance.cls, 'fields', name).key;
  const cell = instance.cells?.get(key);
  // Raw float32 bits go into the cell (a NaN payload does not survive a
  // JavaScript store through a binding, which is not the point here).
  if (value && typeof value === 'object' && 'raw' in value) {
    if (cell && !instance.bindings.has(key)) instance.arena.view.setUint32(instance.base + cell.offset, value.raw, true);
    else runtime.writeNamed(actor, name, fromBits(value.raw));
    return;
  }
  if (Array.isArray(value) && cell?.tag !== undefined && value.some(v => v && typeof v === 'object' && 'raw' in v)) {
    const plain = value.map(v => v && typeof v === 'object' && 'raw' in v ? fromBits(v.raw) : v);
    runtime.writeNamed(actor, name, plain);
    if (!instance.bindings.has(key)) value.forEach((v, i) => {
      if (v && typeof v === 'object' && 'raw' in v)
        instance.arena.view.setUint32(instance.base + cell.offset + (cell.stride || 4) * i, v.raw, true);
    });
    return;
  }
  runtime.writeNamed(actor, name, value);
}

/** A host binding over a JavaScript value (as script-doors' bindings are). */
function bind(actor, name) {
  if (!has(actor, name)) return;
  const field = runtime.lookupMember(instanceOf(actor).cls, 'fields', name);
  let value = runtime.readNamed(actor, name);
  runtime.bindProperty(actor, field, {get: () => value, set: v => { value = v; }});
}
function poison(actor, name) {
  if (!has(actor, name)) return;
  const instance = instanceOf(actor), field = runtime.lookupMember(instance.cls, 'fields', name);
  if (!instance.cells?.get(field.key)) return;
  const value = runtime.readNamed(actor, name);
  (instance.poison ??= new Map()).set(field.key, {read: () => value, write: false, lazy: false});
}

// ---- One run --------------------------------------------------------------
const numberBits = v => { f32.setFloat64(0, v, true); return `${f32.getUint32(4, true).toString(16)}:${f32.getUint32(0, true).toString(16)}`; };
const same = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return numberBits(a) === numberBits(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  return Object.is(a, b);
};
const show = v => typeof v === 'number' ? `${v}/${numberBits(v)}` : Array.isArray(v) ? `[${v.map(show)}]` : v?.name ?? String(v);

/** The JavaScript tick: AScriptedPawn::Tick's phase for a ScriptedPawn, then AActor::Tick. */
function jsTick(actor, seconds, tickType, services) {
  if (runtime.isScriptedPawn(actor) && !scriptedPawnTick(actor, seconds, tickType, runtime.scriptedPawnTickServices(services))) return 1;
  return tickStandaloneActor(actor, seconds, tickType, services);
}

function run(spec, kernelPath) {
  const {actor} = spec, instance = instanceOf(actor), trace = [], counts = new Map();
  const deferredSentinel = {sentinel: true};
  const mockLevel = {netMode: 0, demoRecDriver: null, tickTag: spec.tickTag, timeSeconds: spec.timeSeconds,
    deferredHead: deferredSentinel, zoneLastRenderTime: () => spec.zone};
  const effects = (kind, args) => {
    trace.push([kind, ...args]);
    const n = counts.get(kind) ?? 0;
    counts.set(kind, n + 1);
    for (const effect of spec.effects.get(`${kind}#${n}`) ?? []) {
      if (effect.write) writeField(actor, ...effect.write);
      if (effect.bind) bind(actor, effect.bind);
      if (effect.poison) poison(actor, effect.poison);
      if (effect.release) instance.nativeObject = {...instance.nativeObject, released: true};
      if (effect.demo) mockLevel.demoRecDriver = {};
      if (effect.latent !== undefined && instance.state) instance.state.latent = effect.latent;
      if (effect.throw) throw new Error(effect.throw);
    }
  };
  const base = runtime.actorTickServices({level: mockLevel, tickType: spec.tickType}).services;
  const services = {...base, level: mockLevel,
    processEvent: (a, name, args) => effects(`event ${name}`, [a === actor, ...args]),
    processState: (a, delta) => effects('state', [a === actor, delta]),
    performPhysics: (a, delta) => effects('physics', [a === actor, delta]),
    destroyActor: (a, force) => effects('destroy', [a === actor, force]),
    farMoveActor: (weapon, location, test, noCheck) => effects('farMove', [weapon, location, test, noCheck]),
    showSelf: a => effects('showSelf', [a === actor]),
    checkEnemyVisible: a => effects('checkEnemy', [a === actor]),
    readInput: (viewport, delta) => effects('readInput', [delta]),
    isProbing: (a, name) => spec.probes[name] ?? true,
    allocateDeferredActor: () => { effects('allocate', []); return spec.allocation; },
    advanceAnimation: (a, delta) => runtime.processActorAnimation(a, delta),
  };
  const animationEvent = runtime.animationEvent;
  runtime.animationEvent = (receiver, record) => effects(`anim ${record.name}`, [receiver === actor]);
  let result, error = null, handedBack = false;
  const stackPointer = kernel.x.__stack_pointer.value;
  try {
    if (kernelPath) {
      result = kernel.run(actor, spec.seconds, {tickType: spec.tickType, services});
      if (result === undefined) {
        handedBack = true;
        result = jsTick(actor, spec.seconds, spec.tickType, services);
      }
    } else result = jsTick(actor, spec.seconds, spec.tickType, services);
  } catch (e) {
    error = String(e?.message ?? e);
  } finally {
    runtime.animationEvent = animationEvent;
  }
  // A callback that throws unwinds past the Rust frames: the host puts the
  // shadow stack pointer back.
  assert.equal(kernel.x.__stack_pointer.value, stackPointer, `${actor.name}: shadow stack pointer after ${error ?? 'the tick'}`);
  const deferred = mockLevel.deferredHead === deferredSentinel ? 'unchanged'
    : mockLevel.deferredHead === null ? 'null' : mockLevel.deferredHead?.actor === actor && mockLevel.deferredHead.next === deferredSentinel ? 'linked' : 'other';
  return {result, error, trace, deferred, demo: mockLevel.demoRecDriver !== null, image: imageOf(instance), handedBack};
}

// ---- Cases ----------------------------------------------------------------
const FLOAT_FIELDS = ['LastRenderTime', 'DistanceFromPlayer', 'TimerRate', 'TimerCounter', 'LifeSpan', 'SightCounter',
  'PainTime', 'SpeechTime', 'AnimFrame', 'AnimRate', 'TweenRate', 'AnimLast', 'AnimMinRate'];
const BOOL_FIELDS = ['bStasis', 'bForceStasis', 'bTransient', 'bTimerLoop', 'bIsPlayer', 'bViewTarget', 'bHidden',
  'bAdvancedTactics', 'bAnimFinished', 'bAnimLoop', 'bAnimNotify', 'bIsPawn'];
const CALLBACKS = ['state', 'event Tick', 'event Timer', 'event Expired', 'physics', 'anim AnimEnd', 'farMove', 'showSelf',
  'checkEnemy', 'event UpdateEyeHeight', 'event PainTimer', 'event SpeechTimer', 'event UpdateTactics', 'event EnableCloak',
  'event ExtinguishFire', 'event SpurtBlood', 'destroy'];
let otherActor = actors.find(a => a !== player);

function makeCase(actor, family) {
  const seconds = pick([Math.fround(1 / 60), 0.005, 0.4, Math.fround(random() * 0.4), 0.05]);
  const timeSeconds = pick([10, 100.25, 3601.5, 7 + random()]);
  const spec = {actor, family, seconds, tickType: chance(0.85) ? 2 : pick([0, 1]), tickTag: pick([0, 1]),
    timeSeconds, zone: timeSeconds - 10, probes: {}, allocation: {}, fields: [], effects: new Map(),
    bindBefore: [], poisonBefore: [], owner: 'keep', weapon: 'keep'};
  const set = (name, value) => spec.fields.push([name, value]);
  const effect = (kind, n, value) => {
    const key = `${kind}#${n}`;
    if (!spec.effects.has(key)) spec.effects.set(key, []);
    spec.effects.get(key).push(value);
  };
  // Role 4 is the admitted route; any other Role throws in JavaScript.
  set('Role', chance(0.06) ? pick([3, 2, 1, 0, 5]) : 4);
  if (chance(0.3)) set('RemoteRole', pick([0, 1, 2, 3, 4]));
  const sequences = sequencesOf(actor);
  const withNotify = sequences.filter(s => s.notifies?.length);
  switch (family) {
    case 'stasis': {
      set('bStasis', chance(0.8));
      set('Physics', pick([0, 1, 2, 5, 4]));
      set('bForceStasis', chance(0.4));
      set('LastRenderTime', chance(0.5) ? ulp(timeSeconds - 5, pick([-1, 0, 1])) : floatEdge(timeSeconds - 5));
      spec.zone = pick([timeSeconds - 5, timeSeconds - 6, timeSeconds, Math.fround(timeSeconds - 5), NaN, undefined, '1']);
      set('DistanceFromPlayer', chance(0.6) ? ulp(1200, pick([-1, 0, 1])) : floatEdge(1200));
      set('bTransient', chance(0.5));
      break;
    }
    case 'timer': {
      const rate = chance(0.7) ? pick([seconds, seconds / 2, 0.1, 1, 1e-7, Math.fround(seconds * 3)]) : floatEdge(seconds);
      set('TimerRate', rate);
      set('TimerCounter', chance(0.5) ? ulp(Math.fround((typeof rate === 'number' ? rate : 0.1) - seconds), pick([-1, 0, 1])) : floatEdge(0.05));
      set('bTimerLoop', chance(0.5));
      if (chance(0.4)) effect('state', 0, {write: ['TimerRate', floatEdge(0.1)]});
      if (chance(0.4)) effect('event Timer', 0, {write: ['TimerRate', pick([0, 0.5, 1])]});
      if (chance(0.3)) effect('event Timer', 0, {write: ['TimerCounter', floatEdge(0)]});
      break;
    }
    case 'lifespan': {
      set('LifeSpan', chance(0.5) ? ulp(Math.fround(seconds + 0.0001), pick([-2, -1, 0, 1, 2])) : floatEdge(seconds));
      set('Physics', pick([0, 1, 2]));
      if (chance(0.4)) effect('event Expired', 0, {write: ['LifeSpan', 5]});
      if (chance(0.3)) effect('event Tick', 0, {write: ['Physics', pick([0, 2, 3])]});
      if (chance(0.3)) effect('event Tick', 0, {write: ['Role', pick([2, 3, 4, 1])]});
      break;
    }
    case 'animation': {
      const seq = pick([...withNotify, ...sequences, {name: 'None'}, {name: ''}, {name: 'NoSuchSequence'}]);
      set('AnimSequence', seq?.name ?? 'None');
      const last = Math.fround(chance(0.5) ? 1 - 1 / Math.max(1, seq?.frames ?? 8) : random());
      set('AnimLast', chance(0.8) ? last : floatEdge(last));
      set('AnimFrame', chance(0.6) ? pick([-0.5, -1e-9, 0, Math.fround(last - 0.01), Math.fround(random()), 0.999, ulp(last, -1)]) : floatEdge(0));
      set('AnimRate', chance(0.7) ? pick([0, 0.5, 2, 30, -0.5, -0.01, Math.fround(random() * 3)]) : floatEdge(1));
      set('TweenRate', chance(0.7) ? pick([0, 0.5, 5, 30]) : floatEdge(1));
      set('AnimMinRate', chance(0.7) ? pick([0, 0.2, 2]) : floatEdge(0.2));
      set('Velocity', pick([[0, 0, 0], [100, -50, 3], [1e20, 0, 0], [{raw: RAW.payload}, 0, 0], [-0, -0, -0]]));
      set('bAnimLoop', chance(0.5));
      set('bAnimNotify', chance(0.6));
      set('bAnimFinished', chance(0.3));
      if (has(actor, 'BlendAnimSequence') && chance(0.7)) {
        const names = [0, 1, 2, 3].map(() => chance(0.5) ? (pick(sequences)?.name ?? 'None') : pick(['None', '']));
        set('BlendAnimSequence', names);
        set('BlendAnimFrame', [0, 1, 2, 3].map(() => chance(0.7) ? pick([-0.5, 0, 0.3, 0.9, 1]) : floatEdge(0.5)));
        set('BlendAnimLast', [0, 1, 2, 3].map(() => chance(0.8) ? pick([0.5, 0.95, 1]) : floatEdge(0.9)));
        set('BlendAnimRate', [0, 1, 2, 3].map(() => chance(0.7) ? pick([0, 1, 5, -1]) : floatEdge(1)));
        set('BlendTweenRate', [0, 1, 2, 3].map(() => pick([0, 1, 10])));
        set('BlendAnimMinRate', [0, 1, 2, 3].map(() => pick([0, 0.5])));
      }
      // A notify just ahead of the frame, crossed at this rate.
      if (withNotify.length && chance(0.4)) {
        const sequence = pick(withNotify), notify = pick(sequence.notifies);
        spec.fields = spec.fields.filter(([name]) => !['AnimSequence', 'AnimFrame', 'AnimRate', 'AnimLast'].includes(name));
        set('AnimSequence', sequence.name);
        set('AnimFrame', Math.fround(Math.max(0, notify.time - pick([0.001, 0.01, 0.05]))));
        set('AnimRate', pick([1, 2, 5, -2]));
        set('AnimLast', pick([1, Math.fround(notify.time + 0.01), Math.fround(notify.time)]));
        set('bAnimNotify', true);
      }
      // Animation fields bound once the phase is under way (the per-read
      // JavaScript paths inside the Rust animation).
      if (chance(0.25)) effect(pick(['anim AnimEnd', 'anim PlayFootStep']), 0, {bind: pick(['Velocity', 'AnimSequence', 'AnimFrame',
        'AnimRate', 'AnimLast', 'bAnimLoop', 'BlendAnimFrame', 'BlendAnimSequence', 'BlendAnimLast', 'BlendAnimRate', 'RemoteRole'])});
      if (instanceOf(actor).state && chance(0.3)) effect('state', 0, {latent: pick([0x181, 0, 0x180])});
      if (chance(0.3)) spec.latent = pick([0x181, 0]);
      if (chance(0.3)) effect('anim AnimEnd', 0, {write: ['AnimRate', pick([0, 1, -1])]});
      if (chance(0.2)) effect('anim AnimEnd', 0, {write: ['AnimFrame', floatEdge(0.5)]});
      // The branch after the animation reads the Role and RemoteRole the
      // animation events left.
      if (chance(0.2)) effect('anim AnimEnd', 0, {write: ['Role', pick([2, 3, 1])]});
      if (chance(0.15)) effect('anim AnimEnd', 0, {write: ['RemoteRole', pick([3, 2])]});
      break;
    }
    case 'pawn': {
      set('bIsPawn', chance(0.9));
      set('bIsPlayer', chance(0.5));
      set('bViewTarget', chance(0.3));
      set('bHidden', chance(0.5));
      set('SightCounter', chance(0.5) ? pick([-1, -0, 0, 0.01, 0.2, Math.fround(seconds), ulp(seconds, 1)]) : floatEdge(0));
      set('PainTime', chance(0.5) ? ulp(Math.fround(seconds + 0.001), pick([-1, 0, 1])) : floatEdge(seconds));
      set('SpeechTime', chance(0.5) ? ulp(Math.fround(seconds + 0.001), pick([-1, 0, 1])) : floatEdge(seconds));
      set('bAdvancedTactics', chance(0.5));
      set('Rotation', [Math.floor(random() * 65536) - 32768, 0x7fffffff, -0x80000000]);
      set('ViewRotation', [1, 2, 3]);
      spec.probes.EnemyNotVisible = chance(0.5);
      spec.weapon = pick(['keep', 'none', 'other']);
      // The statements the Rust body leaves to JavaScript.
      if (chance(0.3)) spec.bindBefore.push(pick(['Rotation', 'ViewRotation', 'Weapon', 'Location']));
      if (chance(0.3)) effect('event Tick', 0, {write: ['Role', pick([3, 4, 2])]});
      if (chance(0.3)) effect('checkEnemy', 0, {write: ['SightCounter', 5]});
      if (chance(0.3)) effect('event PainTimer', 0, {write: ['SpeechTime', floatEdge(0.1)]});
      if (chance(0.2)) effect('farMove', 0, {write: ['Role', 3]});
      break;
    }
    case 'scripted': {
      if (!has(actor, 'AlarmTimer')) break;
      const timers = ['AlarmTimer', 'WeaponTimer', 'FireTimer', 'SpecialTimer', 'ReloadTimer', 'AvoidWallTimer', 'AvoidBumpTimer', 'ObstacleTimer',
        'CloakEMPTimer', 'TakeHitTimer', 'CarcassCheckTimer', 'PotentialEnemyTimer', 'BeamCheckTimer', 'FutzTimer', 'PlayerAgitationTimer',
        'AgitationCheckTimer', 'AgitationTimer', 'FearTimer', 'DistressTimer', 'burnTimer', 'BurnPeriod', 'FearSustainTime'];
      const edge = () => chance(0.5) ? pick([-0.5, 0, 0.001, 0.0166, 0.5, 1.5, 7.25]) : floatEdge(pick([0, seconds, 1]));
      for (const name of timers) if (chance(0.5)) set(name, edge());
      for (const name of ['AgitationDecayRate', 'FearDecayRate', 'FearLevel']) if (chance(0.6)) set(name, pick([0, 0.2, 0.7, 1, floatEdge(0)]));
      set('Role', 4);
      set('RemoteRole', pick([0, 0, 0, 3, 1]));
      set('bSimulatedPawn', chance(0.5));
      set('bDisappear', chance(0.35));
      set('LastRenderTime', pick([timeSeconds - 1, timeSeconds - 4.99, timeSeconds - 5, timeSeconds - 6, floatEdge(timeSeconds - 5)]));
      set('bTickVisibleOnly', chance(0.4));
      set('DistanceFromPlayer', pick([100, 1200, ulp(1200, 1), 3000]));
      set('bAdvancedTactics', chance(0.5));
      set('Acceleration', pick([[0, 0, 0], [50, 0, 0], [0, -3, 0], [0, 0, 1]]));
      set('TurnDirection', pick([0, 1, 2]));
      set('NextDirection', pick([0, 1, 2]));
      set('MoveTimer', pick([-1, 0, 1.655, 6.29, floatEdge(4)]));
      set('bHasCloak', chance(0.4));
      set('Health', pick([100, 50, 10, 0]));
      set('CloakThreshold', pick([50, 10, 0, 100]));
      set('bOnFire', chance(0.3));
      set('bCanBleed', chance(0.6));
      set('BleedRate', pick([0, 0.2, 0.9, 1, 5, -1]));
      set('ClotPeriod', pick([0.5, 3, 8]));
      set('DropCounter', pick([0, 0.4, 2]));
      set('Velocity', pick([[0, 0, 0], [60, 0, 0], [300, 400, 0], [1, 0, -2000]]));
      set('PrePivotTime', pick([0, -1, 0.005, Math.fround(seconds), 0.1, 2.5]));
      set('PrePivot', [random() * 20 - 10, random() * 20 - 10, random() * 20 - 10]);
      set('DesiredPrePivot', [random() * 20 - 10, random() * 20 - 10, random() * 20 - 10]);
      set('bAlliancesChanged', chance(0.6));
      if (has(actor, 'AlliancesEx') && chance(0.7)) set('AlliancesEx', Array.from({length: 16}, (_, i) => ({
        'deusex.scriptedpawn.allianceinfoex.alliancename': i % 3 ? 'Player' : 'None',
        'deusex.scriptedpawn.allianceinfoex.alliancelevel': 0.5,
        'deusex.scriptedpawn.allianceinfoex.agitationlevel': i % 4 ? Math.fround(random() * 2) : 0,
        'deusex.scriptedpawn.allianceinfoex.bpermanent': i % 5 === 1,
      })));
      spec.weapon = pick(['keep', 'none', 'other']);
      spec.probes.Tick = chance(0.5);
      // callbacks that change what the phase reads next, or take the actor away
      if (chance(0.3)) effect('event EnableCloak', 0, {write: [pick(['TurnDirection', 'bAdvancedTactics', 'MoveTimer']), pick([0, true, 2.5])]});
      if (chance(0.3)) effect('event ExtinguishFire', 0, {write: ['BleedRate', pick([0, 0.5])]});
      if (chance(0.4)) effect('event SpurtBlood', pick([0, 1]), {write: ['DropCounter', pick([0, 0.01])]});
      if (chance(0.15)) effect('event SpurtBlood', 0, {bind: pick(['DropCounter', 'BleedRate', 'ClotPeriod'])});
      if (chance(0.1)) effect('destroy', 0, {release: true});
      break;
    }
    case 'owner': {
      spec.owner = pick(['none', 'ticked', 'unticked', 'unattached', 'released', 'dangling']);
      spec.allocation = pick([{}, {}, null, 5]);
      // One identity for both runs, so both images hold the same handle.
      if (spec.owner === 'unattached') spec.ghost = {name: 'unattached'};
      if (spec.owner === 'released') {
        spec.ghostHandle = releasedHandle();
      }
      break;
    }
    default: break; // 'random' mixes below
  }
  if (family === 'random' || chance(0.25)) {
    for (let i = 0; i < 1 + Math.floor(random() * 6); i++) set(pick(FLOAT_FIELDS), floatEdge(pick([0, seconds, 1, 5])));
    for (let i = 0; i < Math.floor(random() * 4); i++) set(pick(BOOL_FIELDS), chance(0.5));
    if (chance(0.3)) set('Physics', pick([0, 1, 2, 3, 5]));
    if (chance(0.2)) spec.owner = pick(['none', 'ticked', 'unticked']);
    spec.probes.Tick = chance(0.7);
  }
  // Bound or poisoned fields, before the tick or from a callback.
  const names = [...TICK_FIELDS.map(([name]) => name), ...(family === 'scripted' ? SP_FIELDS.map(([name]) => name) : [])];
  if (chance(0.15)) for (let i = 0; i < 1 + Math.floor(random() * 3); i++) spec.bindBefore.push(pick(names));
  if (chance(0.05)) spec.poisonBefore.push(pick(names));
  if (chance(0.25)) {
    const kind = pick(CALLBACKS), r = random();
    effect(kind, 0, r < 0.4 ? {bind: pick(names)} : r < 0.55 ? {poison: pick(names)} : r < 0.7 ? {release: true}
      : r < 0.8 ? {demo: true} : r < 0.9 ? {throw: 'scripted callback error'} : {write: [pick(FLOAT_FIELDS), floatEdge(0)]});
  }
  if (spec.tickType !== 2 && chance(0.5)) spec.probes.Tick = false;
  return spec;
}

/** Constructed cases for paths random values rarely reach: operand orders
 * that change a float32 result, replication of finished sequences, blend
 * element writes beside signaling NaNs, flags bound during the phase. */
function fixedCases(actor) {
  const out = [];
  const base = (family, seconds = Math.fround(1 / 60)) => ({actor, family, seconds, tickType: 2, tickTag: 0,
    timeSeconds: 10, zone: 0, probes: {Tick: false}, allocation: {}, fields: [['Role', 4], ['LastRenderTime', 9]],
    effects: new Map(), bindBefore: [], poisonBefore: [], owner: 'none', weapon: 'keep'});
  const add = (spec, fields, effects = {}) => {
    spec.fields.push(...fields);
    for (const [key, list] of Object.entries(effects)) spec.effects.set(key, list);
    out.push(spec);
  };
  const quietMain = [['AnimSequence', 'Fixed'], ['bAnimNotify', false], ['bAnimLoop', false], ['AnimMinRate', 0]];
  // The blend passes run only while the main sequence is active: a main
  // sequence that stops short of AnimLast leaves the time to them.
  const runningMain = [...quietMain, ['AnimFrame', 0.1], ['AnimRate', 1], ['AnimLast', 0.95]];
  // remainder(advanced, old, 0): (end - stop) * rem / (end - start) and
  // (end - stop) / (end - start) * rem round to different float32 values
  // for these (found by search).
  for (const [old, rem, tween] of [[-0.037275899201631546, 0.17727705836296082, 34.5],
    [-0.2078460305929184, 0.36231139302253723, 39], [-0.3233242928981781, 0.08002646267414093, 16]])
    add(base('tween remainder', rem), [...quietMain, ['AnimFrame', old], ['TweenRate', tween], ['AnimRate', 1], ['AnimLast', 1]]);
  // Velocity-scaled rates from frame 0, where the float32 rounding of the
  // blend's scaled rate shows in the frame.
  for (const [velocity, rate] of [[[1.1, 2.3, 0.7], -0.013], [[37.5, -12.25, 3], -0.0071], [[0.3, 0.4, 0.05], -1.7]]) {
    add(base('scaled main'), [...quietMain, ['AnimFrame', 0], ['AnimRate', rate], ['AnimLast', 1], ['Velocity', velocity]]);
    if (has(actor, 'BlendAnimSequence')) add(base('scaled blend'), [...runningMain, ['Velocity', velocity],
      ['BlendAnimSequence', ['Fixed', 'None', 'None', 'None']], ['BlendAnimFrame', [0, 0, 0, 0]],
      ['BlendAnimLast', [1, 1, 1, 1]], ['BlendAnimRate', [rate, 0, 0, 0]], ['BlendAnimMinRate', [0, 0, 0, 0]],
      ['BlendTweenRate', [0, 0, 0, 0]]]);
  }
  // Finished sequences replicate (RemoteRole below 2), the rate clamped
  // when AnimEnd leaves a high AnimRate.
  for (const [remote, rateAfter] of [[0, undefined], [1, 3], [0, 100], [2, 100]])
    add(base('replicate main'), [...quietMain, ['RemoteRole', remote], ['AnimFrame', 0.9], ['AnimRate', 5], ['AnimLast', 0.95]],
      rateAfter === undefined ? {} : {'anim AnimEnd#0': [{write: ['AnimRate', rateAfter]}]});
  if (has(actor, 'BlendAnimSequence')) for (const slot of [0, 1, 3]) {
    const names = ['None', 'None', 'None', 'None'], frames = [{raw: RAW.snan}, 0.5, {raw: RAW.payload}, {raw: RAW.snan}];
    names[slot] = 'Fixed';
    frames[slot] = 0.9;
    add(base('replicate blend'), [...runningMain, ['RemoteRole', slot === 3 ? 2 : 0],
      ['BlendAnimSequence', names], ['BlendAnimFrame', frames], ['BlendAnimLast', [0.95, 0.95, 0.95, 0.95]],
      ['BlendAnimRate', [2, {raw: RAW.snan}, 2, 2].map((v, i) => i === slot ? 5 : v)], ['BlendAnimMinRate', [0, 0, 0, 0]],
      ['BlendTweenRate', [0, 0, 0, 0]]]);
  }
  // A looping sequence crossing AnimLast with time left; AnimEnd binds a
  // flag, so the next iteration reads the flags through JavaScript.
  for (const flag of ['bAnimLoop', 'bAnimNotify', 'bAnimFinished'])
    add(base('loop bound flag', 0.1), [['AnimSequence', 'Fixed'], ['bAnimNotify', false], ['bAnimLoop', true],
      ['AnimFrame', 0.95], ['AnimLast', 0.96], ['AnimRate', 30], ['AnimMinRate', 0]], {'anim AnimEnd#0': [{bind: flag}]});
  return out;
}

function prepare(spec) {
  const {actor} = spec, saved = [save(actor)];
  if (spec.owner !== 'keep' && has(actor, 'Owner')) {
    if (spec.owner === 'none') writeField(actor, 'Owner', null);
    else if (spec.owner === 'unattached') writeField(actor, 'Owner', spec.ghost);
    else if (spec.owner === 'dangling') {
      // A word no handle was ever allocated for: JavaScript reads None.
      const instance = instanceOf(actor), cell = instance.cells?.get('engine.actor.owner');
      if (cell && !instance.bindings.has('engine.actor.owner'))
        instance.arena.view.setUint32(instance.base + cell.offset, handleLimit() + 4096, true);
    } else if (spec.owner === 'released') {
      // A released handle's identity is never stored again: write its word.
      const instance = instanceOf(actor), cell = instance.cells?.get('engine.actor.owner');
      if (cell && !instance.bindings.has('engine.actor.owner'))
        instance.arena.view.setUint32(instance.base + cell.offset, spec.ghostHandle ??= releasedHandle(), true);
    } else if (otherActor && otherActor !== actor) {
      saved.push(save(otherActor));
      writeField(otherActor, 'bTicked', spec.owner === 'ticked' ? spec.tickTag === 1 : spec.tickTag !== 1);
      writeField(actor, 'Owner', otherActor);
    }
  }
  if (spec.weapon !== 'keep' && has(actor, 'Weapon')) writeField(actor, 'Weapon', spec.weapon === 'none' ? null : otherActor ?? null);
  for (const [name, value] of spec.fields) writeField(actor, name, value);
  if (spec.latent !== undefined && instanceOf(actor).state) instanceOf(actor).state.latent = spec.latent;
  for (const name of spec.bindBefore) bind(actor, name);
  for (const name of spec.poisonBefore) poison(actor, name);
  return saved;
}

// ---- The comparison -------------------------------------------------------
const traceKinds = new Map();
let cases = 0, handbacks = 0, expectedRust = 0, errors = 0, deferrals = 0, callbacks = 0;
const families = ['stasis', 'timer', 'lifespan', 'animation', 'pawn', 'scripted', 'owner', 'scripted', 'random'];
const handbackBefore = actorTickStats().handback.get('prelude') ?? 0;
for (const actor of actors) {
  const fixed = fixedCases(actor);
  for (let n = 0; n < CASES + fixed.length; n++) {
    const spec = n < CASES ? makeCase(actor, families[n % families.length]) : fixed[n - CASES];
    if (DEBUG && `${actor.name}:${n}` === DEBUG) console.log('case', JSON.stringify({...spec, actor: actor.name,
      effects: [...spec.effects]}, (k, v) => typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
    const saved = prepare(spec);
    if (DEBUG && `${actor.name}:${n}` === DEBUG) {
      kernel.table();
      const d = kernel.describe(instanceOf(actor), actor);
      console.log('mask missing', TICK_FIELDS.filter((_, i) => !((i < 32 ? d.lo >>> i : d.hi >>> (i - 32)) & 1)).map(([name]) => name).join(','));
    }
    const imageComplete = !spec.bindBefore.length && !spec.poisonBefore.length && !isA(actor, 'engine.playerpawn') &&
      (typeof spec.zone === 'number') && typeof spec.seconds === 'number';
    const rust = run(spec, true);
    if (rust.error?.startsWith('ACTOR_TICK_DIFFERENTIAL'))
      console.log(`case ${actor.name}:${n} ${spec.family}`, JSON.stringify({seconds: spec.seconds, tickType: spec.tickType, tickTag: spec.tickTag, time: spec.timeSeconds, fields: spec.fields, effects: [...spec.effects], bindBefore: spec.bindBefore, weapon: spec.weapon}, (k, v) => typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
    for (const s of saved.slice().reverse()) restore(s);
    const saved2 = prepare(spec);
    const js = run(spec, false);
    for (const s of saved2.slice().reverse()) restore(s);
    cases++;
    const where = `${actor.name} (${instanceOf(actor).cls.record.key}) case ${n} ${spec.family}`;
    assert.equal(rust.error, js.error, `${where}: error`);
    assert.ok(same(rust.result, js.result), `${where}: result Rust ${rust.result} JavaScript ${js.result}`);
    assert.equal(rust.deferred, js.deferred, `${where}: deferred list`);
    assert.equal(rust.demo, js.demo, `${where}: DemoRecDriver`);
    assert.equal(rust.trace.length, js.trace.length,
      `${where}: ${rust.trace.length} callbacks in Rust, ${js.trace.length} in JavaScript\n Rust ${rust.trace.map(t => t[0]).join(', ')}\n JS   ${js.trace.map(t => t[0]).join(', ')}`);
    rust.trace.forEach((entry, i) => assert.ok(same(entry, js.trace[i]),
      `${where}: callback ${i} Rust ${entry.map(show)} JavaScript ${js.trace[i].map(show)}`));
    const at = rust.image.bytes.findIndex((b, i) => b !== js.image.bytes[i]);
    assert.equal(at, -1, `${where}: image byte +0x${at.toString(16)} Rust ${rust.image.bytes[at]} JavaScript ${js.image.bytes[at]}`);
    assert.ok(same(rust.image.refs ?? [], js.image.refs ?? []), `${where}: reference array`);
    if (rust.handedBack) handbacks++;
    if (imageComplete && !isA(actor, 'engine.playerpawn') && rust.handedBack && spec.fields.every(([name, v]) => name !== 'Role' || v === 4)) {
      // A hand-back of an image-complete case needs a JavaScript error first.
      assert.ok(rust.error !== null, `${where}: handed back with every field in the image`);
    }
    if (imageComplete) expectedRust++;
    if (rust.error) errors++;
    if (rust.deferred === 'linked' || rust.deferred === 'null') deferrals++;
    callbacks += rust.trace.length;
    for (const [kind] of rust.trace) traceKinds.set(kind, (traceKinds.get(kind) ?? 0) + 1);
  }
}
const stats = actorTickStats();
console.log(`${cases} cases on ${actors.length} actors of ${byClass.size} classes: identical results, errors, ` +
  `callbacks (${callbacks}), deferred lists and image bytes; ${handbacks} handed back, ${errors} errors, ` +
  `${deferrals} deferred`);
console.log(`kernel paths: ${stats.get} JavaScript reads, ${stats.set} writes, ${stats.statements} statements, ` +
  `${stats.animation} animation phases in JavaScript; replay: ${stats.verified} ticks, ${stats.mismatches} mismatches`);
console.log(`hand-backs by reason: ${[...stats.handback].map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`kernel imports: ${[...stats.imports].map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`callbacks by kind: ${[...traceKinds].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
assert.ok(stats.get > 0 && stats.set > 0 && stats.statements > 0 && stats.animation > 0, 'a fallback path was not exercised');
assert.equal(stats.mismatches, 0);
console.log('validate-actor-tick-kernel: ok');
