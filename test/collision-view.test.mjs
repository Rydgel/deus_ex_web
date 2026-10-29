import test from 'node:test';
import assert from 'node:assert/strict';
import {installActorCollisionView} from '../src/runtime/script-actor-collision.mjs';
import {referenceInstallActorCollisionView} from './helpers/collision-view-reference.mjs';

// Live-heap step 5 (docs/live-heap.md "Step 5's results"): a spawned actor's members are accessors shared by every spawned actor.
// The version of 3502f642 (a closure pair for each member, test/helpers/collision-view-reference.mjs) and this one are run over the
// same logging storage: the same properties with the same attributes, and the same reads and writes in the same order.

const NAMES = ['StandingCount', 'Location', 'OldLocation', 'Rotation', 'CollisionRadius', 'CollisionHeight', 'Base', 'Physics', 'Velocity',
  'Acceleration', 'Owner', 'NextPawn', 'Tag', 'Touching', 'bStatic', 'bDeleteMe', 'bCollideWhenPlacing', 'bMovable', 'bCollideActors',
  'bBlockActors', 'bBlockPlayers', 'bProjTarget', 'bCollideWorld', 'bSpecialLit', 'bActorShadows', 'bCorona', 'bLensFlare', 'bBounce',
  'bFixedRotationDir', 'bRotateToDesired', 'bInterpolating', 'bJustTeleported'];

function storage(log) {
  const fields = new Map(NAMES.map((name, index) => [name, name === 'Touching' ? [null, null, null, null] : name.startsWith('b') ? index % 2 === 0 : [index, index + 1, index + 2]]));
  const entry = (actor, name) => ({
    get: () => { log.push(['entry get', actor.id, name]); return fields.get(name); },
    set: value => { log.push(['entry set', actor.id, name, JSON.stringify(value)]); fields.set(name, value); },
  });
  return {
    fields,
    read: (actor, name) => { log.push(['read', actor.id, name]); return fields.get(name); },
    write: (actor, name, value) => { log.push(['write', actor.id, name, JSON.stringify(value)]); fields.set(name, value); },
    bind: (actor, name) => { log.push(['bind', actor.id, name]); return entry(actor, name); },
  };
}

// the shared version adds one non-enumerable symbol member (the view); the members compared are the string-keyed ones
const names = host => Reflect.ownKeys(host).filter(key => typeof key === 'string');
const attributes = host => Object.fromEntries(names(host).map(key => {
  const d = Object.getOwnPropertyDescriptor(host, key);
  return [String(key), {accessor: 'get' in d || 'set' in d, getter: typeof d.get, setter: typeof d.set, enumerable: d.enumerable,
    configurable: d.configurable, writable: d.writable, value: 'value' in d && typeof d.value !== 'object' ? d.value : undefined}];
}));

function build(install, {bound, motion, lineage}) {
  const log = [], store = storage(log), host = {id: 'a'};
  const motionWord = motion ? {get: () => { log.push(['motion get']); return 0x101; }, set: value => log.push(['motion set', value]) } : null;
  install(host, {read: store.read, write: store.write, bind: bound ? store.bind : null, worldActor: {world: 1}, lineage, motionWord});
  return {host, log, store};
}

// every member read, then written, in a fixed order, recording what came back and what the storage saw
function exercise({host, log}) {
  const out = [];
  const members = names(host);
  for (const key of members) {
    try { out.push([key, JSON.stringify(host[key])]); } catch (error) { out.push([key, `throws ${error.message}`]); }
  }
  for (const key of members) {
    const d = Object.getOwnPropertyDescriptor(host, key);
    if (typeof d.set !== 'function') continue;
    try { host[key] = key === 'flags' ? 0xd : key === 'motionFlags' ? 0x41 : [7, 8, 9]; out.push([`set ${key}`, 'ok']); } catch (error) { out.push([`set ${key}`, `throws ${error.message}`]); }
    out.push([key, JSON.stringify(host[key])]);
  }
  for (let slot = 0; slot < 4; slot++) { host.touching[slot] = {id: `t${slot}`}; out.push([`touching ${slot}`, host.touching[slot].id]); }
  out.push(['touching keys', Object.keys(host.touching).join(',')], ['values keys', Object.keys(host.values).join(',')],
    ['values', JSON.stringify({...host.values})], ['same values', host.collisionValues === host.values]);
  try { host.collideActors = true; out.push(['collideActors set', host.collideActors]); } catch (error) { out.push(['collideActors set', `throws ${error.message}`]); }
  return {out, log: log.map(entry => entry.join(' '))};
}

for (const bound of [true, false]) for (const motion of [true, false]) for (const lineage of [['engine.actor'], ['engine.pawn', 'engine.actor'], ['engine.projectile', 'engine.actor']]) {
  test(`spawned actor view: bound ${bound}, motion word ${motion}, ${lineage[0]}`, () => {
    const was = build(referenceInstallActorCollisionView, {bound, motion, lineage}), is = build(installActorCollisionView, {bound, motion, lineage});
    assert.deepEqual(names(is.host), names(was.host), 'the same members in the same order');
    for (const object of [is.host, is.host.touching, is.host.values]) {
      const symbols = Reflect.ownKeys(object).filter(key => typeof key === 'symbol');
      assert.equal(symbols.length, 1);
      assert.equal(Object.getOwnPropertyDescriptor(object, symbols[0]).enumerable, false);
    }
    assert.deepEqual(attributes(is.host), attributes(was.host), 'the same attributes');
    assert.deepEqual(attributes(is.host.touching), attributes(was.host.touching));
    assert.deepEqual(attributes(is.host.values), attributes(was.host.values));
    const a = exercise(was), b = exercise(is);
    assert.deepEqual(b.out, a.out, 'the same values');
    assert.deepEqual(b.log, a.log, 'the same storage calls in the same order');
  });
}

test('two spawned actors share their accessor functions and keep their own storage', () => {
  const one = build(installActorCollisionView, {bound: true, motion: false, lineage: ['engine.actor']}),
    two = build(installActorCollisionView, {bound: true, motion: false, lineage: ['engine.actor']});
  const d = key => Object.getOwnPropertyDescriptor(one.host, key), e = key => Object.getOwnPropertyDescriptor(two.host, key);
  for (const key of ['position', 'velocity', 'flags', 'motionFlags', 'actorFlags']) {
    assert.equal(d(key).get, e(key).get, `${key} getter`);
  }
  one.host.position = [1, 1, 1];
  assert.deepEqual(one.store.fields.get('Location'), [1, 1, 1]);
  assert.notDeepEqual(two.store.fields.get('Location'), [1, 1, 1]);
});
