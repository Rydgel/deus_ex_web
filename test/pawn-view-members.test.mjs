import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {installActorFlagWords} from '../src/runtime/actor-flag-words.mjs';
import * as NEW from '../src/runtime/script-pawn-physics.mjs';
import * as OLD from './helpers/script-pawn-physics-reference.mjs';

// docs/live-heap.md, "Actor hosts and mesh bindings": a map pawn's physics view is built without turning its literal's controlledPlayer
// into an accessor, and the members whose source depends on whether the pawn's flag words are its image's share one function pair. The
// same pawns go through the old module (verbatim in test/helpers) and the new one: the members in order with their attributes, the value
// every member reads, what a write does, and the calls the view makes on the runtime's services must be identical.

const ROOT = 'Deus Ex GOTY Edition';

async function fixture() {
  const files = [];
  for (const name of await readdir(`${ROOT}/System`))
    if (/\.u$/i.test(name)) files.push({path: `System/${name}`, read: () => readFile(`${ROOT}/System/${name}`)});
  const assets = new AssetStore(files);
  const runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
  const engine = await assets.get('Engine');
  const classes = {};
  for (const name of ['pawn', 'playerpawn']) classes[name] = await runtime.loadClass(engine, engine.exportsByPath.get(name));
  const word = (host, offset) => { const i = runtime.instance(host); return i.arena.view.getUint32(i.base + offset, true); };
  return {runtime, classes, word};
}

const describe = value => {
  if (value instanceof Error) return {error: `${value.constructor.name}: ${value.message}`};
  if (Array.isArray(value)) return value.map(describe);
  if (value && typeof value === 'object') return {object: value.name ?? Object.keys(value).join(',')};
  if (typeof value === 'function') return 'function';
  return value;
};

function run({runtime, classes, word}, modules, {className, imaged, playerBound}) {
  const log = [];
  const host = {name: 'UNATCOTroop6', values: {bJustTeleported: true}, touching: [null, null, null, null], standingCount: 0};
  runtime.attach(host, classes[className]);
  if (imaged) {
    host.flags = word(host, 0x1dc) & 0x1f;
    host.actorFlags = word(host, 0x28) & 0xa0081;
    installActorFlagWords(host, runtime.instance(host), {collision: true, actor: true, motion: true});
  }
  if (playerBound) runtime.writeNamed(host, 'Player', host);
  const hash = {removeActor() {}, addActor() {}, actorEncroachmentCheck: () => [],
    lineCheck: () => ({time: 1, actor: null, location: [0, 0, 0], normal: [0, 0, 0]})};
  const level = {hash, actors: [], netMode: 0, model: null, pointRegion: () => ({zone: null, leaf: -1, zoneNumber: 0}), findSpot: () => true};
  const services = {level, worldActor: {name: '$world'},
    field: (actor, name) => { log.push(['field', name]); return runtime.namedReference(actor, name); },
    read: (actor, name) => { log.push(['read', name]); return runtime.readNamed(actor, name); },
    write: (actor, name, value) => { log.push(['write', name, JSON.stringify(value)]); return runtime.writeNamed(actor, name, value); },
    isA: (actor, key) => { for (let c = runtime.instance(actor).cls; c; c = c.base) if (c.record.key === key) return true; return false; },
    zoneFields: () => ({}), isProbing: () => false, dispatch: () => {}};
  const transcript = [];
  let view;
  try { view = modules.pawnPhysicsView(host, services); } catch (error) { transcript.push(['construct', describe(error)]); return {transcript, log}; }
  assert.equal(host._pawnPhysics, view);
  const names = Object.getOwnPropertyNames(view);
  transcript.push(['names', names, Object.keys(view), Object.getOwnPropertySymbols(view).length]);
  const members = [];
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(view, name);
    transcript.push(['descriptor', name, 'value' in d ? ['data', d.enumerable, d.configurable, d.writable, typeof d.value] : ['accessor', d.enumerable, d.configurable, typeof d.get, typeof d.set]]);
    if (!('value' in d)) members.push([name, d]);
  }
  for (const [name, d] of members) {
    let current;
    try { current = view[name]; transcript.push(['read', name, describe(current)]); } catch (error) { transcript.push(['read', name, describe(error)]); continue; }
    if (typeof d.set !== 'function') continue;
    const probe = typeof current === 'number' ? current + 1 : typeof current === 'boolean' ? !current
      : Array.isArray(current) && current.every(item => typeof item === 'number') ? current.map(item => item + 1) : undefined;
    if (probe === undefined) continue;
    try { view[name] = probe; transcript.push(['write', name, describe(probe), describe(view[name])]); } catch (error) { transcript.push(['write', name, describe(error)]); }
  }
  // the same members again, after the writes, and the fields underneath
  for (const [name] of members) { try { transcript.push(['reread', name, describe(view[name])]); } catch (error) { transcript.push(['reread', name, describe(error)]); } }
  for (const name of ['Location', 'Rotation', 'Velocity', 'Physics', 'bCollideActors', 'bBlockActors', 'bBlockPlayers', 'bCollideWorld', 'bDeleteMe', 'bStatic', 'bMovable'])
    transcript.push(['field', name, describe(runtime.readNamed(host, name))]);
  transcript.push(['methods', names.filter(name => typeof view[name] === 'function' || (Object.getOwnPropertyDescriptor(view, name).value instanceof Function))]);
  if (imaged) transcript.push(['actor words', host.flags, host.actorFlags, host.motionFlags]);
  return {transcript, log};
}

test('pawn view members match the old module for map pawns, composed pawns and a player pawn', async () => {
  const shared = await fixture();
  for (const options of [
    {className: 'pawn', imaged: true},
    {className: 'pawn', imaged: false},
    {className: 'playerpawn', imaged: true, playerBound: true},
    {className: 'playerpawn', imaged: false, playerBound: true},
  ]) {
    const was = run(shared, OLD, options), is = run(shared, NEW, options);
    const label = JSON.stringify(options);
    assert.deepEqual(is.transcript, was.transcript, `transcript ${label}`);
    assert.deepEqual(is.log, was.log, `service calls ${label}`);
    assert.ok(was.transcript.length > 200, `the transcript is a real one ${label}: ${was.transcript.length}`);
  }
});

test('pawn views share one hidden class whatever the pawn: every view is a fast-mode object', async () => {
  const shared = await fixture();
  const {execFileSync} = await import('node:child_process');
  // %HasFastProperties needs --allow-natives-syntax: ask a child process that builds one view of each kind
  const script = `
    import {readFile, readdir} from 'node:fs/promises';
    const root = ${JSON.stringify(ROOT)};
    const {AssetStore} = await import(${JSON.stringify(new URL('../src/unreal/assets.mjs', import.meta.url).href)});
    const {ScriptRuntime} = await import(${JSON.stringify(new URL('../src/runtime/script-runtime.mjs', import.meta.url).href)});
    const {installActorFlagWords} = await import(${JSON.stringify(new URL('../src/runtime/actor-flag-words.mjs', import.meta.url).href)});
    const {pawnPhysicsView} = await import(${JSON.stringify(new URL('../src/runtime/script-pawn-physics.mjs', import.meta.url).href)});
    const files = [];
    for (const name of await readdir(root + '/System')) if (/\\.u$/i.test(name)) files.push({path: 'System/' + name, read: () => readFile(root + '/System/' + name)});
    const assets = new AssetStore(files), runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
    const engine = await assets.get('Engine');
    const cls = await runtime.loadClass(engine, engine.exportsByPath.get('pawn'));
    const word = (host, offset) => { const i = runtime.instance(host); return i.arena.view.getUint32(i.base + offset, true); };
    const out = [];
    for (const imaged of [true, false, true, false]) {
      const host = {name: 'P', values: {bJustTeleported: true}, touching: [null, null, null, null], standingCount: 0};
      runtime.attach(host, cls);
      if (imaged) { host.flags = word(host, 0x1dc) & 0x1f; host.actorFlags = word(host, 0x28) & 0xa0081; installActorFlagWords(host, runtime.instance(host), {collision: true, actor: true, motion: true}); }
      const services = {level: {hash: {removeActor() {}, addActor() {}, actorEncroachmentCheck: () => [], lineCheck: () => ({time: 1})}, actors: [], netMode: 0, model: null,
        pointRegion: () => ({zone: null, leaf: -1, zoneNumber: 0}), findSpot: () => true}, worldActor: {name: 'w'},
        field: (a, n) => runtime.namedReference(a, n), read: (a, n) => runtime.readNamed(a, n), write: (a, n, v) => runtime.writeNamed(a, n, v),
        isA: (a, key) => { for (let c = runtime.instance(a).cls; c; c = c.base) if (c.record.key === key) return true; return false; },
        zoneFields: () => ({}), isProbing: () => false, dispatch: () => {}};
      out.push(%HasFastProperties(pawnPhysicsView(host, services)));
    }
    console.log(JSON.stringify(out));
  `;
  const output = execFileSync(process.execPath, ['--allow-natives-syntax', '--input-type=module', '-e', script], {encoding: 'utf8'});
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)), [true, true, true, true]);
  assert.ok(shared);
});
