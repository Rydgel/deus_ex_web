import test from 'node:test';
import assert from 'node:assert/strict';
import { BindScope } from '../src/runtime/script-conversation-bind-scope.mjs';
import { asciiCaseEqual, bindEventsNative } from '../src/runtime/script-conversation-events.mjs';

function scopeFixture() {
  const reads = [], writes = [], loads = [];
  const store = new Map();
  const key = (object, field) => `${object.id}.${field}`;
  const scope = new BindScope({
    read: (object, field) => { reads.push(key(object, field)); return store.get(key(object, field)) ?? object[field]; },
    write: (object, field, value) => { writes.push(key(object, field)); store.set(key(object, field), value); return value; },
  });
  const services = { staticLoadObject: request => { loads.push(request.name); return { loaded: request.name, n: loads.length }; } };
  return { scope, reads, writes, loads, store, services };
}

const withMode = (mode, body) => {
  const saved = process.env.BIND_EVENTS;
  if (mode === undefined) delete process.env.BIND_EVENTS; else process.env.BIND_EVENTS = mode;
  try { return body(); } finally { if (saved === undefined) delete process.env.BIND_EVENTS; else process.env.BIND_EVENTS = saved; }
};

test('inside a call a repeated string read is served once and a write drops it', () => withMode(undefined, () => {
  const { scope, reads, writes } = scopeFixture();
  const actor = { id: 'a', BindName: 'Paul', speaker: null, nextEvent: { id: 'e2' } };
  scope.begin();
  assert.equal(scope.read(actor, 'BindName'), 'Paul');
  assert.equal(scope.read(actor, 'BindName'), 'Paul');
  assert.equal(reads.length, 1);
  // an object-valued field is not kept
  scope.read(actor, 'speaker');
  scope.read(actor, 'speaker');
  assert.equal(reads.filter(item => item === 'a.speaker').length, 2);
  scope.write(actor, 'BindName', 'Anna');
  assert.deepEqual(writes, ['a.BindName']);
  assert.equal(scope.read(actor, 'BindName'), 'Anna');
  scope.end();
  // after the call nothing is kept
  scope.read(actor, 'BindName');
  scope.read(actor, 'BindName');
  assert.equal(reads.filter(item => item === 'a.BindName').length, 4);
}));

test('a load repeated in a call with the same request returns the first load; a different request loads again', () => withMode(undefined, () => {
  const { scope, loads, services } = scopeFixture();
  const request = { classRef: { c: 1 }, outer: { o: 1 }, name: 'WeaponGEPGun', filename: 'DeusEx', flags: 2, sandbox: null };
  scope.begin();
  const first = scope.load(services, request);
  assert.equal(scope.load(services, { ...request }), first);
  assert.equal(loads.length, 1);
  assert.notEqual(scope.load(services, { ...request, name: 'Other' }), first);
  assert.notEqual(scope.load(services, { ...request, flags: 3 }), first, 'a load with other flags is another load');
  assert.equal(loads.length, 3);
  scope.end();
  assert.notEqual(scope.load(services, request), first);
}));

test('BIND_EVENTS=js passes every read and load through', () => withMode('js', () => {
  const { scope, reads, loads, services } = scopeFixture();
  const actor = { id: 'a', BindName: 'Paul' };
  scope.begin();
  scope.read(actor, 'BindName');
  scope.read(actor, 'BindName');
  scope.load(services, { classRef: null, outer: null, name: 'X', filename: 'DeusEx', flags: 2, sandbox: null });
  scope.load(services, { classRef: null, outer: null, name: 'X', filename: 'DeusEx', flags: 2, sandbox: null });
  scope.end();
  assert.equal(reads.length, 2);
  assert.equal(loads.length, 2);
}));

test('BIND_EVENTS=verify throws when a kept read or load is no longer what a real one returns', () => withMode('verify', () => {
  const { scope, store, services } = scopeFixture();
  const actor = { id: 'a', BindName: 'Paul' };
  scope.begin();
  scope.read(actor, 'BindName');
  store.set('a.BindName', 'Changed behind the scope');
  assert.throws(() => scope.read(actor, 'BindName'), /BIND_EVENTS=verify: read of .*\.BindName was kept as Paul, now Changed/);
  const request = { classRef: null, outer: null, name: 'X', filename: 'DeusEx', flags: 2, sandbox: null };
  const drifting = { staticLoadObject: () => ({ fresh: Math.random() }) };
  scope.load(drifting, request);
  assert.throws(() => scope.load(drifting, request), /BIND_EVENTS=verify: StaticLoadObject\(X\) was kept/);
  scope.end();
  assert.ok(services);
}));

test('the event chain is walked once per call and replayed for the later candidates; a cut-short walk is not noted', () => withMode(undefined, () => {
  const e3 = { id: 'e3', nextEvent: null }, e2 = { id: 'e2', nextEvent: e3 }, e1 = { id: 'e1', nextEvent: e2 };
  const conversation = { id: 'c', eventList: e1 };
  const actors = ['a', 'b', 'c'].map(id => ({ id, className: 'Pawn', BindName: id }));
  let linkReads = 0;
  const run = ({ bindActor }) => {
    const scope = new BindScope({ read: (object, field) => object[field], write: () => {} });
    const output = Array(10).fill(null);
    const report = bindEventsNative({
      conversation, conBoundActors: output, invokeActor: null,
      read: (object, field) => { if (field === 'nextEvent' || field === 'eventList') linkReads++; return object[field]; },
      write: () => {}, isA: (object, token) => object.className === token, reference: value => value,
      objects: actors, scope, collect: false, bindActor,
      readArray: (array, index) => array[index], writeArray: (array, index, value) => { array[index] = value; },
    });
    return { output, report };
  };
  const seen = [];
  run({ bindActor: details => { seen.push(`${details.secondActor.id}:${details.event.id}`); return false; } });
  assert.deepEqual(seen, ['a:e1', 'a:e2', 'a:e3', 'b:e1', 'b:e2', 'b:e3', 'c:e1', 'c:e2', 'c:e3']);
  assert.equal(linkReads, 4, 'eventList and three nextEvent reads, once');

  linkReads = 0;
  let calls = 0;
  assert.throws(() => run({ bindActor: () => { if (++calls === 2) throw new Error('stop'); return false; } }), /stop/);
  assert.equal(linkReads, 2, 'the walk stopped at the second event; nothing was noted from it');
}));

test('folded names are kept for the call and compare as the event bodies compare them', () => withMode(undefined, () => {
  const { scope } = scopeFixture();
  const ref = asciiCaseEqual;
  // outside a call: the plain comparison
  assert.equal(scope.equalText('Paul', 'PAUL'), true);
  scope.begin();
  for (const [a, b] of [['Paul', 'PAUL'], ['PaulDenton', 'pauldenton'], ['', ''], ['Shared\0ignored', 'SHARED'], ['Straße', 'STRASSE'], ['a', 'b']]) {
    assert.equal(scope.equalText(a, b), ref(a, b), `${a} ~ ${b}`);
    assert.equal(scope.equalText(a, b), ref(a, b));
  }
  assert.ok(scope.folds.size >= 6);
  assert.throws(() => scope.equalText(null, 'a'), TypeError);
  scope.end();
}));
