import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime, cleanupPlan} from '../src/runtime/script-runtime.mjs';
import {layoutOwner} from '../src/runtime/script-object-image.mjs';
import {liveCylinderValues} from '../src/runtime/actor-pose-fields.mjs';
import {ScriptState} from '../src/runtime/script-state.mjs';

// docs/firefox-60fps-plan.md, "The script runtime's instance state": a class that declares no property of its own has its base's
// layout, so its cells, field table and cleanup plan are the layout owner's (145 of the Island's 289 attached classes); an instance
// reads what its class gives every instance (runtime, arena, cells, size, field table) through one shared object; the part few
// instances have is made on first write; a state keeps its frame and booleans out of its own slots; a live cylinder's values inherit
// the host's serialized values. Checked on DeusEx's real ScriptedPawn family and decorations.

const ROOT = 'Deus Ex GOTY Edition';

async function load(names) {
  const files = [];
  for (const directory of ['System', 'Sounds', 'Textures'])
    for (const name of await readdir(`${ROOT}/${directory}`))
      files.push({path: `${directory}/${name}`, read: () => readFile(`${ROOT}/${directory}/${name}`)});
  const assets = new AssetStore(files);
  const runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
  const deusEx = await assets.get('DeusEx');
  const classes = new Map();
  for (const name of names) {
    const cls = await runtime.loadClass(deusEx, deusEx.exportsByPath.get(name));
    const fields = new Map();
    for (let node = cls; node; node = node.base)
      for (const field of node.fields?.values() ?? []) if (!fields.has(field.key)) fields.set(field.key, field);
    await Promise.all([...fields.values()].map(field => runtime.field(field)));
    classes.set(name, cls);
  }
  return {runtime, classes};
}

test('classes without a property of their own share their layout owner\'s cells, field table and plan', async () => {
  const {runtime, classes} = await load(['scriptedpawn', 'terrorist', 'unatcotroop', 'basketball', 'plant1', 'deusexdecoration', 'jcdentonmale']);
  const graph = runtime.classLoader.graph, owner = name => layoutOwner(classes.get(name), graph).record.key;
  assert.equal(owner('scriptedpawn'), 'deusex.scriptedpawn', 'a class with properties of its own is its own owner');
  assert.equal(owner('terrorist'), 'deusex.scriptedpawn');
  assert.equal(owner('unatcotroop'), 'deusex.scriptedpawn');
  assert.equal(owner('basketball'), 'deusex.deusexdecoration');
  assert.equal(owner('plant1'), 'deusex.deusexdecoration');
  assert.equal(owner('jcdentonmale'), 'deusex.human', 'the player declares none: it has Human\'s layout');
  const attach = (name, id) => {
    const host = {name: `${name}${id}`, values: {}};
    runtime.attach(host, classes.get(name));
    return {host, instance: runtime.instance(host)};
  };
  const pawn = attach('scriptedpawn', 0), terrorist = attach('terrorist', 0), troop = attach('unatcotroop', 0);
  assert.equal(terrorist.instance.cells, pawn.instance.cells);
  assert.equal(troop.instance.cells, pawn.instance.cells);
  assert.equal(terrorist.instance.fieldTable, pawn.instance.fieldTable);
  assert.equal(terrorist.instance.info.fields, pawn.instance.info.fields);
  assert.equal(terrorist.instance.size, pawn.instance.size);
  // CleanupDestroyed's plan is the layout's: made once for the classes that share it, and alternating between them keeps it.
  const plan = cleanupPlan(pawn.instance);
  assert.ok(plan, 'a ScriptedPawn has a cleanup plan');
  assert.equal(cleanupPlan(terrorist.instance), plan);
  assert.equal(cleanupPlan(troop.instance), plan);
  assert.equal(cleanupPlan(pawn.instance), plan);
  assert.notEqual(terrorist.instance.cls, pawn.instance.cls);
  const plant = attach('plant1', 0), basket = attach('basketball', 0), decoration = attach('deusexdecoration', 0), player = attach('jcdentonmale', 0);
  assert.equal(plant.instance.cells, decoration.instance.cells);
  assert.equal(basket.instance.fieldTable, decoration.instance.fieldTable);
  assert.notEqual(player.instance.cells, pawn.instance.cells);
  assert.notEqual(plant.instance.cells, pawn.instance.cells);
  // Every instance still reads and writes its own image through the shared tables, and the handles are one for each field and cell.
  runtime.writeNamed(terrorist.host, 'Health', 77);
  runtime.writeNamed(troop.host, 'Health', 33);
  assert.equal(runtime.readNamed(terrorist.host, 'Health'), 77);
  assert.equal(runtime.readNamed(troop.host, 'Health'), 33);
  assert.equal(runtime.namedHandle(terrorist.instance, 'Health'), runtime.namedHandle(pawn.instance, 'Health'));
  assert.equal(runtime.namedHandle(terrorist.instance, 'health'), runtime.namedHandle(troop.instance, 'health'));
  assert.equal(runtime.lookupMember(classes.get('terrorist'), 'fields', 'Health'), runtime.lookupMember(classes.get('scriptedpawn'), 'fields', 'Health'));
  assert.equal(runtime.lookupMember(classes.get('terrorist'), 'fields', 'NoSuchProperty'), null);
  // The layout's cells give the fields at the offsets the class's own layout gives them.
  for (const [key, cell] of terrorist.instance.cells) assert.equal(pawn.instance.cells.get(key), cell);
});

test('an instance reads the class\'s shared part and makes the rest on first write', async () => {
  const {runtime, classes} = await load(['terrorist']);
  const host = {name: 'Terrorist0', values: {}}, other = {name: 'Terrorist1', values: {}};
  runtime.attach(host, classes.get('terrorist'));
  runtime.attach(other, classes.get('terrorist'));
  const instance = runtime.instance(host);
  assert.equal(instance.runtime, runtime);
  assert.equal(instance.arena, runtime.objectArena());
  assert.equal(instance.info, runtime.instance(other).info, 'the objects of a class share the instance class');
  assert.equal(instance.extra, null, 'an object with nothing to remember has no extra part');
  assert.equal(instance.globalIndex, undefined);
  assert.equal(instance.singular, false);
  assert.equal(instance.bindSetVersion, -1);
  assert.equal(instance.defaultsSnapshot, undefined);
  instance.globalIndex = 1234;
  instance.singular = true;
  assert.equal(instance.globalIndex, 1234);
  assert.equal(instance.singular, true);
  assert.equal(runtime.instance(other).extra, null, 'the other object has none');
  assert.equal(runtime.instance(other).globalIndex, undefined);
  // An actor's pendingKill is its bDeleteMe once its receiver is recorded; before that and for any other object it is a plain value.
  assert.equal(instance.deleteMe, null);
  instance.pendingKill = true;
  assert.equal(instance.pendingKill, true);
  instance.pendingKill = false;
});

test('a state keeps its frame and its booleans out of its own slots', () => {
  const services = {dispatchStateEvent() {}};
  const a = new ScriptState({}, services, true), b = new ScriptState({}, services, true);
  assert.equal(a.config, b.config, 'the states of a runtime share their services and locals kind');
  assert.equal(a.services, services);
  assert.equal(a.localsAreMap, true);
  assert.equal(new ScriptState({}, services, false).localsAreMap, false);
  assert.equal(a.frame, null, 'a state that runs no code has no frame');
  a.setStateNode(null);
  assert.equal(a.frame, null, 'clearing the node and the code allocates nothing');
  assert.equal(a.execution, null);
  assert.equal(a.codeNode, null);
  assert.equal(a.localValues, null);
  const locals = a.locals;
  assert.ok(locals instanceof Map);
  assert.equal(a.locals, locals);
  assert.ok(a.frame !== null);
  assert.equal(b.frame, null);
  a.endingState = true;
  assert.equal(a.endingState, true);
  assert.equal(a.changedState, false);
  a.changedState = true;
  a.endingState = false;
  assert.equal(a.endingState, false);
  assert.equal(a.changedState, true);
  // A services value that cannot key a WeakMap still gives a state.
  assert.equal(new ScriptState({}, null, true).services, null);
});

test('a live cylinder\'s values inherit the serialized values and read the host\'s pose', () => {
  const values = {Location: [1, 2, 3], CollisionRadius: 24, CollisionHeight: 48, PrePivot: [0, 0, 0], Tag: 'crate'};
  const host = {position: [10, 20, 30], radius: undefined, height: 60};
  const cylinder = liveCylinderValues(host, values);
  assert.deepEqual(cylinder.Location, [10, 20, 30]);
  host.position = [11, 21, 31];
  assert.deepEqual(cylinder.Location, [11, 21, 31], 'the host\'s live position');
  assert.equal(cylinder.CollisionRadius, 24, 'a radius the host has not set is the serialized one');
  assert.equal(cylinder.CollisionHeight, 60);
  host.radius = 16;
  assert.equal(cylinder.CollisionRadius, 16);
  assert.equal(cylinder.Tag, 'crate');
  assert.deepEqual(cylinder.PrePivot, [0, 0, 0]);
  assert.equal(liveCylinderValues({position: [0, 0, 0]}, {}).CollisionRadius, 0, 'neither: zero');
  assert.deepEqual(Object.keys(cylinder).sort(), ['CollisionHeight', 'CollisionRadius', 'Location']);
});
