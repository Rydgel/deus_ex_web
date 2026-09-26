import test from 'node:test';
import assert from 'node:assert/strict';
import {collectLoadMapGarbage, LOADMAP_GC} from '../src/runtime/script-loadmap-gc.mjs';
import {ScriptObjectRegistry} from '../src/runtime/script-object-construction.mjs';
import {GC_FLAGS} from '../src/runtime/script-gc.mjs';

function world() {
  const registry = new ScriptObjectRegistry();
  const add = (name, outer = null, extra = {}) => {
    const record = {identity: {name}, index: -1, nameIndex: registry.objects.length + 1, outer, hashNext: null, flags: 0, name, ...extra};
    record.identity.record = record;
    registry.add(record);
    return record;
  };
  const transient = add('Transient');
  const pkg = add('Map');
  const level = add('MyLevel', pkg);
  const oldPlayer = add('Player0', pkg, {actor: true});
  const flagBase = add('FlagBase0', oldPlayer);
  const shadow = add('Shadow0', pkg, {actor: true});
  const kept = add('Kept0', transient);
  return {registry, transient, pkg, level, oldPlayer, flagBase, shadow, kept};
}

test('LoadMap tags the old package actors, nulls references to them and purges in index order', () => {
  const {registry, transient, pkg, level, oldPlayer, flagBase, shadow, kept} = world();
  const mapActor = {name: 'Trigger0', reference: oldPlayer.identity, keep: kept.identity};
  const levelActors = [mapActor];
  const events = [];
  const result = collectLoadMapGarbage({
    registry, levelPackage: pkg, levelActors,
    recordOf: identity => identity.record ?? null,
    isActor: record => record.actor === true,
    rootArray: [transient.identity, level.identity],
    serialize: (identity, visit) => {
      const record = identity.record;
      if (record) visit({get: () => record.outer?.identity ?? null, set: value => { record.outer = value?.record ?? null; }});
      if (record === level) for (const actor of levelActors) visit({get: () => actor, set: () => {}});
      if (identity === mapActor) {
        visit({get: () => mapActor.reference, set: value => { mapActor.reference = value; }});
        visit({get: () => mapActor.keep, set: value => { mapActor.keep = value; }});
      }
    },
    conditionalDestroy: record => events.push(`destroy:${record.name}`),
    finalDelete: (record, flags) => {
      events.push(`delete:${record.name}:${flags}`);
      registry.objects[record.index] = null;
      registry.freeIndices.push(record.index);
    },
    setGarbageCollecting: active => events.push(`collecting:${active}`),
  });
  assert.equal(oldPlayer.flags & LOADMAP_GC.eliminate, LOADMAP_GC.eliminate);
  assert.equal(shadow.flags & LOADMAP_GC.eliminate, LOADMAP_GC.eliminate);
  // The archive's exclusion wrote the surviving holder back as null.
  assert.equal(mapActor.reference, null);
  assert.deepEqual(result.excluded.map(entry => [entry.holder.name, entry.target.name]), [['Trigger0', 'Player0']]);
  assert.equal(mapActor.keep, kept.identity);
  assert.equal(kept.flags & GC_FLAGS.unreachable, 0);
  assert.deepEqual(events, [
    'collecting:true',
    'destroy:Player0', 'destroy:FlagBase0', 'destroy:Shadow0',
    'delete:Player0:1', 'delete:FlagBase0:1', 'delete:Shadow0:1',
    'collecting:false',
  ]);
  // GObjAvailable in index order; AddObject reuses the highest slot first.
  assert.deepEqual(result.available, [oldPlayer.index, flagBase.index, shadow.index]);
  const next = {identity: {}, index: -1, nameIndex: 99, outer: null, hashNext: null, flags: 0};
  assert.equal(registry.add(next), shadow.index);
});

test('an actor in the reloaded Actors array keeps its tag cleared', () => {
  const {registry, transient, pkg, level, shadow} = world();
  const result = collectLoadMapGarbage({
    registry, levelPackage: pkg, levelActors: [shadow.identity],
    recordOf: identity => identity.record ?? null, isActor: record => record.actor === true,
    rootArray: [transient.identity, level.identity],
    serialize: (identity, visit) => {
      const record = identity.record;
      if (record === level) visit({get: () => shadow.identity, set: () => {}});
    },
    conditionalDestroy: () => {}, finalDelete: () => {}, setGarbageCollecting: () => {},
  });
  assert.equal(shadow.flags & LOADMAP_GC.eliminate, 0);
  assert.equal(result.purged.includes(shadow), false);
  assert.equal(result.eliminated.includes(shadow), true);
});
