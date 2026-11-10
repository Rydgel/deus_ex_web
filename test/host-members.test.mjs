import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {baseEpoch, riderEpochOf} from '../src/runtime/base-epoch.mjs';
import * as NEW_POSE from '../src/runtime/actor-pose-fields.mjs';
import * as NEW_MIRROR from '../src/runtime/actor-mirror-fields.mjs';
import * as NEW_LINK from '../src/runtime/actor-link-fields.mjs';
import * as NEW_FLAGS from '../src/runtime/actor-flag-words.mjs';
import {MapActorHost, hostDelete} from '../src/runtime/host-accessors.mjs';
import * as OLD_POSE from './helpers/actor-pose-fields-reference.mjs';
import * as OLD_MIRROR from './helpers/actor-mirror-fields-reference.mjs';
import * as OLD_LINK from './helpers/actor-link-fields-reference.mjs';
import * as OLD_FLAGS from './helpers/actor-flag-words-reference.mjs';

// docs/live-heap.md, "Actor hosts and mesh bindings": the installers of an actor host's image-backed members keep one state object
// a host over entries shared by the class (the old modules, verbatim in test/helpers, kept an entry object and an array for
// every member). The same host fixtures go through both: the members and their attributes, what enumerating the host yields,
// every value read and written, the errors, and the calls made on the object image (method and offset from the image's base, in
// order) must be identical.

const ROOT = 'Deus Ex GOTY Edition';
const VARIANTS = {
  old: {pose: OLD_POSE, mirror: OLD_MIRROR, link: OLD_LINK, flags: OLD_FLAGS},
  new: {pose: NEW_POSE, mirror: NEW_MIRROR, link: NEW_LINK, flags: NEW_FLAGS},
  // the same modules on a MapActorHost: its image-backed members are accessors of its prototype (docs/live-heap.md, "Actor hosts and mesh bindings")
  backed: {pose: NEW_POSE, mirror: NEW_MIRROR, link: NEW_LINK, flags: NEW_FLAGS},
};
let hostKind = 'plain';
const MEMBER = key => typeof key === 'string' && key in MapActorHost.prototype;
// the decoded actor's fields that a MapActorHost's constructor sets and the plain fixtures do not have
const CONSTRUCTED = new Set(['index', 'className', 'properties', 'nativeBytes', 'stack']);
const ignored = key => MEMBER(key) || CONSTRUCTED.has(key);
const dataKeys = host => Object.keys(host).filter(key => !ignored(key));

async function fixture() {
  const files = [];
  for (const name of await readdir(`${ROOT}/System`))
    if (/\.u$/i.test(name)) files.push({path: `System/${name}`, read: () => readFile(`${ROOT}/System/${name}`)});
  const assets = new AssetStore(files);
  const runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
  const engine = await assets.get('Engine');
  const load = async name => {
    const cls = await runtime.loadClass(engine, engine.exportsByPath.get(name));
    const fields = new Map();
    for (let node = cls; node; node = node.base)
      for (const field of node.fields?.values() ?? []) if (!fields.has(field.key)) fields.set(field.key, field);
    await Promise.all([...fields.values()].map(field => runtime.field(field)));
    return {cls, fields: [...fields.values()]};
  };
  const attach = (name, {cls}, members = {}) => {
    const host = hostKind === 'backed' ? Object.assign(new MapActorHost({index: 1, name, className: 'Probe', properties: null, nativeBytes: 0, stack: null}, {}), members)
      : {name, values: {}, ...members};
    runtime.attach(host, cls);
    return host;
  };
  return {runtime, load, attach};
}

/** Log every call made on the image's view, with the offset from the instance's base. */
function logImage(instance, log) {
  const real = instance.arena, base = instance.base;
  const wrapper = Object.create(real);
  Object.defineProperty(wrapper, 'view', {get() {
    return new Proxy(real.view, {get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => { log.push([String(prop), args[0] - base, ...args.slice(1)]); return value.apply(target, args); };
    }});
  }});
  // (the arena is the instance class's: an own property of this instance takes its place)
  Object.defineProperty(instance, 'arena', {value: wrapper, writable: true, configurable: true});
}

const describe = value => {
  if (value instanceof Error) return {error: `${value.constructor.name}: ${value.message}`.replace('#<MapActorHost>', '#<Object>')};
  if (Array.isArray(value)) return value.map(describe);
  if (value && typeof value === 'object') return {object: value.name ?? '?'};
  if (typeof value === 'function') return 'function';
  return value;
};
/** What enumerating a host shows: names in order, attributes, and the symbol count. */
function shape(host) {
  const out = {keys: dataKeys(host), names: Object.getOwnPropertyNames(host).filter(key => !ignored(key)),
    symbols: Object.getOwnPropertySymbols(host).filter(symbol => symbol.description !== 'hostPending').length, forIn: [], descriptors: {}};
  for (const key in host) if (!ignored(key)) out.forIn.push(key);
  for (const name of out.names) {
    const d = Object.getOwnPropertyDescriptor(host, name);
    out.descriptors[name] = 'value' in d ? {data: true, enumerable: d.enumerable, configurable: d.configurable, writable: d.writable}
      : {accessor: true, enumerable: d.enumerable, configurable: d.configurable, get: typeof d.get, set: typeof d.set};
  }
  for (const symbol of Object.getOwnPropertySymbols(host)) {
    if (symbol.description === 'hostPending') continue;
    const d = Object.getOwnPropertyDescriptor(host, symbol);
    out.descriptors[String(symbol)] = {symbol: true, enumerable: d.enumerable, configurable: d.configurable, writable: d.writable};
  }
  return out;
}
const attempt = (transcript, label, action) => {
  try { transcript.push([label, describe(action())]); } catch (error) { transcript.push([label, describe(error)]); }
};

/** Run `script(modules, host, instance, transcript)` for the old and the new modules on twin hosts and compare. */
async function differential(make, script, {calls = 1, backed = true} = {}) {
  const results = {};
  for (const [variant, modules] of Object.entries(VARIANTS)) {
    if (variant === 'backed' && !backed) continue;
    hostKind = variant === 'backed' ? 'backed' : 'plain';
    const {host, instance, ctx} = make(variant);
    const log = [], transcript = [];
    logImage(instance, log);
    const epoch = baseEpoch();
    script(modules, host, instance, transcript, ctx);
    transcript.push(['shape', shape(host)]);
    transcript.push(['epoch', baseEpoch() - epoch]);
    const base = instance.base;
    results[variant] = {transcript, log, image: [...new Uint8Array(instance.arena.bytes.slice(base, base + instance.size))], refs: instance.refs ? [...instance.refs] : null,
      memberKeys: Object.keys(host).filter(MEMBER)};
  }
  hostKind = 'plain';
  assert.deepEqual(results.new.memberKeys, results.old.memberKeys, 'the members a plain host lists');
  if (results.backed) {
    assert.deepEqual(results.backed.memberKeys, [], 'a MapActorHost lists none of the image-backed members');
    // The one behavior that differs by design: `delete host.member` of an installed member throws on a plain host (a non-configurable own
    // accessor) and is a no-op on a MapActorHost (the member is on its prototype).
    const noDelete = list => list.filter(entry => entry[0] !== 'delete');
    assert.deepEqual(noDelete(results.backed.transcript), noDelete(results.old.transcript), 'transcript of the MapActorHost');
    assert.deepEqual(results.backed.log, results.old.log, 'image calls of the MapActorHost');
    assert.deepEqual(results.backed.image, results.old.image, 'image bytes of the MapActorHost');
    assert.deepEqual(results.backed.refs, results.old.refs, 'refs of the MapActorHost');
  }
  assert.deepEqual(results.new.transcript, results.old.transcript, 'transcript');
  assert.deepEqual(results.new.log, results.old.log, 'image calls');
  assert.deepEqual(results.new.image, results.old.image, 'image bytes');
  assert.deepEqual(results.new.refs, results.old.refs, 'refs');
  assert.ok(results.old.log.length >= calls, 'the script made calls on the image');
  return results;
}

test('pose members: install, reads, writes, resets, live pose, release and errors match the old module', async () => {
  const {runtime, load, attach} = await fixture();
  const actor = await load('actor');
  const make = oldLocation => variant => {
    const host = attach('Barrel0', actor, {position: [1.5, -2, 3.25], rotation: [0, -16384, 0], radius: 20, height: 30.5, values: {Location: [9, 9, 9], Rotation: [1, 2, 3]}});
    host.interpolation = {position: [7, 8, 9]};
    return {host, instance: runtime.instance(host)};
  };
  for (const oldLocation of [true, false]) {
    await differential(make(oldLocation), ({pose}, host, instance, t) => {
      const spec = host.values;
      t.push(['installed', pose.installPoseFields(host, instance, actor.fields, {values: spec, oldLocation}).sort()]);
      for (const prop of ['position', 'rotation', 'oldLocation', 'radius', 'height']) attempt(t, `read ${prop}`, () => host[prop]);
      host.position = [10, 20, 30]; host.rotation = [1, 2, 3]; host.radius = 11; host.height = 0.1;
      if (oldLocation) host.oldLocation = [4, 5, 6];
      for (const prop of ['position', 'rotation', 'oldLocation', 'radius', 'height']) attempt(t, `reread ${prop}`, () => host[prop]);
      attempt(t, 'bad write', () => { host.position = 'x'; });
      const restore = pose.keepLivePose(host);
      host.position = [0, 0, 0]; host.radius = 1;
      restore();
      for (const prop of ['position', 'radius']) attempt(t, `kept ${prop}`, () => host[prop]);
      for (const prop of ['position', 'rotation', 'oldLocation', 'radius', 'height', 'unrelated'])
        attempt(t, `reset ${prop}`, () => { pose.resetPoseField(host, prop); return host[prop]; });
      t.push(['isPoseProp', ['position', 'base', 'oldLocation'].map(pose.isPoseProp)]);
      attempt(t, 'twice', () => pose.installPoseFields(host, instance, actor.fields, {values: spec, oldLocation}));
      const field = actor.fields.find(f => f.key === 'engine.actor.location');
      const external = pose.imagePoseField(instance, field);
      t.push(['external', external.spec.prop, describe(external.get())]);
      external.set([3, 2, 1]);
      t.push(['external set', describe(external.get()), describe(host.position)]);
      t.push(['no field', pose.imagePoseField(instance, actor.fields.find(f => f.key === 'engine.actor.base'))]);
      instance.imageToken.released = true;
      for (const prop of ['position', 'oldLocation', 'height']) attempt(t, `released ${prop}`, () => host[prop]);
      attempt(t, 'released write', () => { host.radius = 3; });
      attempt(t, 'released external', () => external.get());
      t.push(['released keep', typeof pose.keepLivePose(host)]);
      instance.imageToken.released = false;
    }, {calls: 10});
  }
  // a host with an accessor member already is refused with the old message
  await differential(variant => {
    const host = attach('Odd0', actor, {position: [1, 2, 3], radius: 1, height: 1, rotation: [0, 0, 0]});
    Object.defineProperty(host, 'height', {get() { return 1; }, configurable: true});
    return {host, instance: runtime.instance(host)};
  }, ({pose}, host, instance, t) => {
    attempt(t, 'accessor host', () => pose.installPoseFields(host, instance, actor.fields, {values: host.values}));
  }, {calls: 1, backed: false});
});

test('mirror members: install, reads, writes, resets, live vectors, the level target, release and errors match the old module', async () => {
  const {runtime, load, attach} = await fixture();
  const pawn = await load('pawn'), mover = await load('mover'), inventory = await load('inventory'), levelInfo = await load('levelinfo');
  const goal = attach('PatrolPoint0', pawn);
  const waiting = attach('Waiter', pawn);
  // a pawn
  await differential(() => {
    const host = attach('UNATCOTroop6', pawn, {physics: 2, velocity: [1.5, -2, 3.25], standingCount: 1, acceleration: [0, 1, 2], specialGoal: goal, nextPawn: null,
      values: {Physics: 1, StandingCount: 4, Velocity: [9, 9, 9], Acceleration: [1, 1, 1]}});
    return {host, instance: runtime.instance(host)};
  }, ({mirror}, host, instance, t) => {
    mirror.installMirrorFields(host, instance, pawn.fields, {values: host.values});
    const props = ['physics', 'standingCount', 'velocity', 'acceleration', 'specialGoal', 'nextPawn'];
    for (const prop of props) attempt(t, `read ${prop}`, () => host[prop]);
    host.physics = 3; host.standingCount = 7; host.velocity = [5, 6, 7]; host.acceleration = [0.1, 0.2, 0.3]; host.specialGoal = waiting; host.nextPawn = goal;
    for (const prop of props) attempt(t, `reread ${prop}`, () => host[prop]);
    attempt(t, 'bad object', () => { host.specialGoal = 5; });
    const live = mirror.liveVector(host, 'velocity');
    t.push(['live', live && [...live]]);
    live[1] = 99;
    t.push(['live set', describe(host.velocity), describe([live[0], live[1], live[2]])]);
    t.push(['live none', mirror.liveVector(host, 'physics'), mirror.liveVector(host, 'unknown'), mirror.liveVector(null, 'velocity')]);
    for (const prop of [...props, 'unknown']) attempt(t, `reset ${prop}`, () => { mirror.resetMirrorField(host, prop); return host[prop]; });
    attempt(t, 'twice', () => mirror.installMirrorFields(host, instance, pawn.fields, {values: host.values}));
    const velocity = pawn.fields.find(f => f.key === 'engine.actor.velocity');
    const external = mirror.imageField(instance, velocity);
    external.set([1, 2, 3]);
    t.push(['external', describe(external.get()), describe(host.velocity)]);
    t.push(['no field', mirror.imageField(instance, pawn.fields.find(f => f.key === 'engine.actor.location'))]);
    t.push(['mirrorsField', pawn.fields.map(f => mirror.mirrorsField(host, instance, f))]);
    instance.imageToken.released = true;
    attempt(t, 'released read', () => host.velocity);
    attempt(t, 'released write', () => { host.physics = 1; });
    attempt(t, 'released reset', () => mirror.resetMirrorField(host, 'velocity'));
    instance.imageToken.released = false;
  }, {calls: 10});
  // the player: Physics and Velocity are the movement port's
  await differential(() => {
    const host = attach('JCDentonMale', pawn, {values: {}});
    return {host, instance: runtime.instance(host)};
  }, ({mirror}, host, instance, t) => {
    mirror.installMirrorFields(host, instance, pawn.fields, {values: host.values, exclude: mirror.PLAYER_PORT});
    t.push(['names', dataKeys(host)]);
    host.standingCount = 2;
    t.push(['standing', host.standingCount]);
  });
  // a mover, with its replicated fields
  await differential(() => {
    const host = attach('DeusExMover7', mover, {clientUpdate: 0, realRotation: [0, -16384, 0], simOldPosition: [1, 2, 3], physics: 0, velocity: [0, 0, 0],
      values: {RealPosition: [4, 5, 6], SimInterpolate: [1, 0, 0], ClientUpdate: 1}});
    return {host, instance: runtime.instance(host)};
  }, ({mirror}, host, instance, t) => {
    mirror.installMirrorFields(host, instance, mover.fields, {values: host.values});
    for (const prop of ['clientUpdate', 'realRotation', 'realPosition', 'simOldPosition', 'simInterpolate', 'simOldRotPitch', 'simOldRotYaw', 'simOldRotRoll', 'waitingPawn', 'marker'])
      attempt(t, `read ${prop}`, () => host[prop]);
    host.waitingPawn = waiting; host.marker = goal; host.realPosition = [7, 8, 9]; host.simOldRotYaw = 123;
    for (const prop of ['waitingPawn', 'marker', 'realPosition', 'simOldRotYaw']) attempt(t, `reread ${prop}`, () => host[prop]);
    for (const prop of ['marker', 'realPosition', 'clientUpdate']) attempt(t, `reset ${prop}`, () => { mirror.resetMirrorField(host, prop); return host[prop]; });
  });
  // an inventory item (MyMarker shares the `marker` member with the mover's) and the scene level's PawnList
  await differential(() => {
    const host = attach('Medkit0', inventory, {marker: waiting, values: {}});
    return {host, instance: runtime.instance(host)};
  }, ({mirror}, host, instance, t) => {
    mirror.installMirrorFields(host, instance, inventory.fields, {values: host.values});
    t.push(['marker', describe(host.marker)]);
    host.marker = goal;
    t.push(['marker set', describe(host.marker)]);
    mirror.resetMirrorField(host, 'marker');
    t.push(['marker reset', describe(host.marker)]);
  });
  await differential(() => {
    const host = attach('LevelInfo0', levelInfo, {values: {}});
    host.level = {pawnList: waiting};
    return {host, instance: runtime.instance(host)};
  }, ({mirror}, host, instance, t) => {
    mirror.installMirrorFields(host, instance, levelInfo.fields, {target: host});
    t.push(['host names', dataKeys(host)]);
    const level = host.level;
    mirror.installMirrorFields(host, instance, levelInfo.fields, {target: level});
    t.push(['level names', Object.keys(level), describe(level.pawnList)]);
    level.pawnList = goal;
    t.push(['level set', describe(level.pawnList)]);
    attempt(t, 'twice', () => mirror.installMirrorFields(host, instance, levelInfo.fields, {target: level}));
    mirror.resetMirrorField(level, 'pawnList');
    t.push(['level reset', describe(level.pawnList)]);
  });
});

test('link members: install, Base, the Touching array, resets, release and errors match the old module', async () => {
  const {runtime, load, attach} = await fixture();
  const actor = await load('actor');
  const floor = attach('Floor0', actor), other = attach('Crate0', actor), third = attach('Crate1', actor);
  const slotKeys = {};
  const make = members => variant => {
    const host = attach('Barrel0', actor, members());
    return {host, instance: runtime.instance(host), ctx: {variant}};
  };
  const riders = () => [floor, other, third].map(riderEpochOf);
  const before = riders();
  await differential(make(() => ({base: floor, touching: [other, null, third, null]})), ({link}, host, instance, t, ctx) => {
    const start = riders();
    t.push(['installed', link.installLinkFields(host, instance, actor.fields).sort()]);
    t.push(['has', link.hasLinkField(host, 'base'), link.hasLinkField(host, 'touching'), link.hasLinkField(host, 'location'), link.hasLinkField(null, 'base')]);
    t.push(['isLinkProp', ['base', 'touching', 'physics'].map(link.isLinkProp)]);
    t.push(['linksField', actor.fields.map(f => link.linksField(instance, f))]);
    attempt(t, 'base', () => host.base);
    const slots = host.touching;
    t.push(['slots', Array.isArray(slots), slots.length, describe([...slots]), host.touching === slots, slots.indexOf(third), slots.map(item => item?.name ?? null)]);
    host.base = other;
    t.push(['rider counts', riders().map((n, i) => n - start[i])]);
    slots[1] = floor;
    t.push(['slots 2', describe([...slots])]);
    slots.fill(null);
    t.push(['slots 3', describe([...slots])]);
    host.touching = [third, null, null, floor];
    t.push(['slots 4', describe([...slots]), host.touching === slots]);
    attempt(t, 'short', () => { host.touching = [third]; });
    attempt(t, 'bad slot', () => { slots[0] = 3; });
    attempt(t, 'bad base', () => { host.base = 'x'; });
    attempt(t, 'twice', () => link.installLinkFields(host, instance, actor.fields));
    attempt(t, 'delete', () => { 'use strict'; delete host.base; });
    host.base = floor; host.touching = [other, null, null, null];
    link.resetLinkField(host, 'base'); link.resetLinkField(host, 'touching');
    t.push(['reset', describe(host.base), describe([...host.touching])]);
    link.resetLinkField(host, 'unknown');
    t.push(['slot symbols', Object.getOwnPropertySymbols(slots).length]);
    slotKeys[ctx.variant] = {keys: Object.keys(slots), names: Object.getOwnPropertyNames(slots), instanceOfArray: slots instanceof Array, constructor: slots.constructor === Array};
    t.push(['json', JSON.stringify(slots.map(item => item?.name ?? null)), String([...slots].map(item => item?.name ?? null))]);
    instance.imageToken.released = true;
    attempt(t, 'released base', () => host.base);
    attempt(t, 'released slot', () => slots[0]);
    attempt(t, 'released write', () => { slots[0] = null; });
    attempt(t, 'released set', () => { host.base = null; });
    instance.imageToken.released = false;
  }, {calls: 10});
  assert.notDeepEqual(riders(), before);
  // The one difference, by design (docs/live-heap.md "Actor hosts and mesh bindings"): the new array's four accessors are on its class's
  // prototype, so it has no key of its own, and its prototype is that class's (an Array subclass whose species is Array).
  assert.deepEqual(slotKeys.old, {keys: ['0', '1', '2', '3'], names: ['0', '1', '2', '3', 'length'], instanceOfArray: true, constructor: true});
  assert.deepEqual(slotKeys.new, {keys: [], names: ['length'], instanceOfArray: true, constructor: false});
  // an absent Base, no live slots
  await differential(make(() => ({touching: undefined})), ({link}, host, instance, t) => {
    t.push(['installed', link.installLinkFields(host, instance, actor.fields).sort()]);
    t.push(['base', describe(host.base)]);
    t.push(['touching', describe(host.touching)]);
  });
  await differential(make(() => ({touching: [null, null], base: floor})), ({link}, host, instance, t) => {
    t.push(['installed', link.installLinkFields(host, instance, actor.fields).sort()]);
    t.push(['has', link.hasLinkField(host, 'touching')]);
  });
});

test('flag words: install, reads, writes, bit members, release and errors match the old module', async () => {
  const {runtime, load, attach} = await fixture();
  const pawn = await load('pawn'), actor = await load('actor');
  const word = (host, offset) => { const i = runtime.instance(host); return i.arena.view.getUint32(i.base + offset, true); };
  for (const [name, cls, flags] of [['pawn', pawn, {collision: true, actor: true, motion: true}], ['actor', actor, {collision: true, actor: true}],
    ['actor motion', actor, {motion: true}], ['actor words', actor, {actor: true}], ['collision', actor, {collision: true}]]) {
    await differential(() => {
      const host = attach('Doctor0', cls, {values: {bJustTeleported: true}});
      host.flags = word(host, 0x1dc) & 0x1f;
      host.actorFlags = word(host, 0x28) & 0xa0081;
      host.static = Boolean(host.actorFlags & 1); host.movable = Boolean(host.actorFlags & 0x80000);
      host.motionFlags = word(host, 0x1ec) & 0x1ff;
      return {host, instance: runtime.instance(host)};
    }, ({flags: modules}, host, instance, t) => {
      const words = modules.installActorFlagWords(host, instance, flags);
      t.push([name, 'words', Object.fromEntries(['collision', 'actor', 'motion'].map(key => [key, Boolean(words[key])]))]);
      t.push(['same words', modules.flagWordsOf(host) === words, modules.flagWordsOf({}), modules.flagWordsOf(null)]);
      const props = ['flags', 'collisionBits', 'collideActors', 'collideWorld', 'blockActors', 'blockPlayers', 'blocking', 'actorFlags', 'static', 'movable', 'motionFlags'];
      const read = label => { for (const prop of props) attempt(t, `${label} ${prop}`, () => host[prop]); };
      read('read');
      if (flags.collision) { host.flags = 0x1f; read('flags 1f'); host.flags = 0x0; read('flags 0'); host.flags = 0x7fffffff; read('flags big'); }
      if (flags.actor) { host.actorFlags = 0xa0081; read('actor all'); host.actorFlags = 0; read('actor none'); }
      if (flags.motion) { host.motionFlags = 0x1ff; read('motion all'); host.motionFlags = 0x40; read('motion 40'); }
      attempt(t, 'bit write', () => { host.collideActors = true; });
      attempt(t, 'twice', () => modules.installActorFlagWords(host, instance, flags));
      attempt(t, 'actorWordOf', () => modules.actorWordOf(instance) & 0xa0083);
      const external = modules.flagWord(instance, modules.MOTION_WORD);
      t.push(['flagWord', external.get()]);
      external.set(0x140);
      t.push(['flagWord set', external.get(), flags.motion ? host.motionFlags : null]);
      attempt(t, 'delete', () => { 'use strict'; if (hostKind === 'backed') hostDelete(host, 'flags'); else delete host.flags; });
      instance.imageToken.released = true;
      for (const prop of props) attempt(t, `released ${prop}`, () => host[prop]);
      attempt(t, 'released write', () => { host.actorFlags = 1; });
      attempt(t, 'released actorWordOf', () => modules.actorWordOf(instance));
      attempt(t, 'released flagWord', () => external.get());
      instance.imageToken.released = false;
    }, {calls: 10});
  }
  // an image word that differs from the host's is refused with the old message
  for (const [label, members] of [['flags', {flags: 0x1}], ['actorFlags', {actorFlags: 0x3}], ['motion', {motionFlags: 0x7}], ['static', {static: true}]]) {
    await differential(() => {
      const host = attach('Odd1', actor, {values: {bJustTeleported: true}});
      host.flags = word(host, 0x1dc) & 0x1f; host.actorFlags = word(host, 0x28) & 0xa0081; host.motionFlags = word(host, 0x1ec) & 0x1ff;
      Object.assign(host, members);
      return {host, instance: runtime.instance(host)};
    }, ({flags: modules}, host, instance, t) => {
      attempt(t, label, () => modules.installActorFlagWords(host, instance, {collision: true, actor: true, motion: true}));
      t.push(['names', dataKeys(host)]);
    });
  }
});
