/** Original Touch native cases through spawned actors' script/image storage.
 * The native event hook is controlled; original BeginTouch/AddTouch/EndTouch
 * execute in Engine.dll. This checks the adapter, not arbitrary Touch scripts.
 * See docs/script-spawn-touching.md. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile, mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {installActorCollisionView} from '../src/runtime/script-actor-collision.mjs';
import {beginTouch, endTouch} from '../src/runtime/actor-touch.mjs';
import {destroyScriptActor} from '../src/runtime/script-destroy.mjs';
import {readCell, isFixedCell, scalarCell} from '../src/runtime/script-object-image.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory(), dir = 'reports/movement/script-spawn-touching';
await mkdir(dir, {recursive: true});
const cases = [
  {op: 'begin'},
  {op: 'begin', cancelTouch: 's'},
  {op: 'begin', present: true, slot: 0},
  {op: 'end', present: true, slot: 0},
  {op: 'end', present: true, slot: 3},
  {op: 'end', present: true, slot: 3, noNotifySelf: 1},
].map(({present, slot, ...entry}) => ({...entry, source: 's', other: 'a', actors: [
  {id: 's', kind: 'Pawn', touching: Array.from({length: 4}, (_, i) => present && i === slot ? 'a' : null)},
  {id: 'a', kind: 'Pawn', touching: [null, null, null, present ? 's' : null]},
]}));
const encoded = JSON.stringify(cases);
await writeFile(`${dir}/cases.json`, encoded);
const capture = spawnSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-check-encroachment-oracle.py', root, `${dir}/cases.json`],
  {encoding: 'utf8', maxBuffer: 1024 * 1024});
assert.equal(capture.status, 0, capture.stderr);
await writeFile(`${dir}/original.json`, capture.stdout);
const original = JSON.parse(capture.stdout);
assert.equal(original.casesSha256, createHash('sha256').update(encoded).digest('hex'));

const files = [];
for (const directory of ['System', 'Textures', 'Sounds'])
  for (const name of await readdir(`${root}/${directory}`))
    files.push({path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`)});
const assets = new AssetStore(files);
const runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
const deusEx = await assets.get('DeusEx');
const classes = await Promise.all(['Fish', 'UNATCOTroopCarcass'].map(name =>
  runtime.loadClass(deusEx, deusEx.exportsByPath.get(name.toLowerCase()))));
const read = (actor, name) => runtime.readNamed(actor, name);
const write = (actor, name, value) => runtime.writeNamed(actor, name, value);
function actor(id, cls = classes[0], useBinding = true) {
  const host = {id, name: id};
  runtime.attach(host, cls);
  const lineage = [];
  for (let entry = cls; entry; entry = entry.base) lineage.push(entry.record.key);
  installActorCollisionView(host, {read, write, lineage, worldActor: null,
    bind: useBinding ? (a, name) => runtime.boundField(a, name) : null});
  const cell = runtime.instance(host).cells.get('engine.actor.touching');
  assert.ok(isFixedCell(cell));
  assert.equal(cell.dim, 4);
  assert.equal(cell.offset, 0xe8);
  assert.equal(cell.stride, 4);
  assert.equal(scalarCell(cell.element).kind, 'object');
  return host;
}
const ids = slots => [...slots].map(value => value?.id ?? null);
const imageSlots = host => {
  const instance = runtime.instance(host);
  return readCell(instance.cells.get('engine.actor.touching'), instance.arena.view, instance.refs, instance.base);
};
function checkSharedSlots(host) {
  assert.deepEqual(ids(host.touching), ids(read(host, 'Touching')), `${host.id}: host/script`);
  assert.deepEqual(ids(host.touching), ids(runtime.namedReference(host, 'Touching').get()), `${host.id}: host/reference`);
  assert.deepEqual(ids(host.touching), ids(imageSlots(host)), `${host.id}: host/image`);
}
for (const [index, fixture] of cases.entries()) {
  const actors = fixture.actors.map(item => actor(item.id, classes[index % classes.length], index % 2 === 0));
  const byId = new Map(actors.map(host => [host.id, host]));
  for (const item of fixture.actors) {
    // Seed through the host native surface: it must initialize the same
    // slots the original native event callback and DestroyActor read.
    const host = byId.get(item.id);
    item.touching.forEach((id, slot) => { host.touching[slot] = byId.get(id) ?? null; });
  }
  const events = [];
  const dispatch = (host, event, [other]) => {
    actors.forEach(checkSharedSlots);
    events.push({event, actor: host.id, other: other.id, touching: ids(read(host, 'Touching'))});
    if (event === 'Touch' && fixture.cancelTouch === host.id)
      write(host, 'Touching', read(host, 'Touching').map(value => value === other ? null : value));
  };
  const source = byId.get('s'), other = byId.get('a');
  if (fixture.op === 'begin') beginTouch(source, other, dispatch);
  else endTouch(source, other, fixture.noNotifySelf, dispatch);
  actors.forEach(checkSharedSlots);
  assert.deepEqual({result: null, events, touching: Object.fromEntries(actors.map(host => [host.id, ids(read(host, 'Touching'))]))},
    original.results[index], `native case ${index}`);
}

// Retained live views must read the arena's current buffer after growth.
const source = actor('Fish12'), other = actor('Fish16');
const retained = source.touching;
const instance = runtime.instance(source), before = instance.arena.view.buffer;
const allocation = instance.arena.alloc(before.byteLength + 1);
assert.notEqual(instance.arena.view.buffer, before);
retained[2] = other;
checkSharedSlots(source);
write(source, 'Touching', [other, null, null, null]);
assert.deepEqual(ids(retained), ['Fish16', null, null, null]);
retained.fill(null);
checkSharedSlots(source);
instance.arena.release(allocation, before.byteLength + 1);

// DestroyActor scans the surviving actor's script slots, then suppresses
// UnTouch on the destroyed target while clearing/dispatching the survivor.
const carcass = actor('UNATCOTroopCarcass0', classes[1]);
const pawn = actor('UNATCOTroop2');
const level = {actors: [carcass, pawn], pendingDeleted: null, engine: {audio: null}, collisionHash: null};
for (const host of level.actors) {
  write(host, 'Base', null); write(host, 'Owner', null); write(host, 'StandingCount', 0);
  write(host, 'bStatic', false); write(host, 'bNoDelete', false); write(host, 'Role', 4);
}
beginTouch(carcass, pawn, () => {});
const events = [];
const dispatch = (host, event, [other] = []) => {
  level.actors.filter(Boolean).forEach(checkSharedSlots);
  events.push([host.id, event, other?.id ?? null]);
};
assert.equal(destroyScriptActor(carcass, {read, write, levelFor: () => level, validate: () => true,
  isProbing: () => false, modify: () => {}, processEvent: dispatch, conditionalDestroy: () => {},
  endTouch: (host, other, suppress) => endTouch(host, other, suppress, dispatch)}), true);
assert.deepEqual(events, [['UNATCOTroopCarcass0', 'Destroyed', null], ['UNATCOTroop2', 'UnTouch', 'UNATCOTroopCarcass0']]);
assert.deepEqual(ids(read(pawn, 'Touching')), [null, null, null, null]);
assert.deepEqual(ids(read(carcass, 'Touching')), [null, null, null, null]);
console.log('Spawned Touching: 6 original native cases, host/script/image identity, callback cancellation, arena growth and DestroyActor live scan passed.');
