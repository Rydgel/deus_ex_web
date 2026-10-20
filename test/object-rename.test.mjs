import test from 'node:test';
import assert from 'node:assert/strict';
import {ScriptObjectRegistry, renameRegisteredObjects} from '../src/runtime/script-object-construction.mjs';

// A name table and a bucket lookup shaped like script-object-lookup.mjs staticFindObject (Outer and FName index).
function world() {
  const names = new Map(), registry = new ScriptObjectRegistry();
  const internName = name => { const key = name.toLowerCase(); if (!names.has(key)) names.set(key, {name, index: names.size + 1}); return names.get(key); };
  const findObject = (outer, name) => {
    const index = internName(name).index, outerIndex = outer ? outer.index : 0;
    for (let object = registry.buckets[(index ^ outerIndex) & 0xfff]; object; object = object.hashNext)
      if (object.nameIndex === index && (object.outer ?? null) === (outer ?? null)) return object;
    return null;
  };
  const level = {index: 7, name: 'MyLevel'};
  const make = name => { const object = {index: -1, outer: level, name, nameIndex: internName(name).index, hashNext: null}; registry.add(object); return object; };
  return {registry, internName, findObject, level, make};
}

test('paired load-made objects take the original names, a swap included', () => {
  const w = world(), a = w.make('Shadow53'), b = w.make('Shadow54');
  const {renamed, kept} = renameRegisteredObjects(w.registry, [
    {object: a, outerIndex: 7, name: 'Shadow54'}, {object: b, outerIndex: 7, name: 'Shadow53'}], w);
  assert.equal(renamed.length, 2); assert.equal(kept.length, 0);
  assert.equal(w.findObject(w.level, 'Shadow54'), a);
  assert.equal(w.findObject(w.level, 'Shadow53'), b);
});

test('a name another object holds is kept, and the old name stays findable', () => {
  const w = world(), held = w.make('Candybar2'), ours = w.make('Candybar3');
  const {renamed, kept} = renameRegisteredObjects(w.registry, [{object: ours, outerIndex: 7, name: 'Candybar2'}], w);
  assert.equal(renamed.length, 0); assert.equal(kept.length, 1);
  assert.equal(w.findObject(w.level, 'Candybar2'), held);
  assert.equal(w.findObject(w.level, 'Candybar3'), ours);
});

test('a renamed object frees its old name for the next generated one', () => {
  const w = world(), ours = w.make('Candybar3');
  renameRegisteredObjects(w.registry, [{object: ours, outerIndex: 7, name: 'Candybar2'}], w);
  assert.equal(w.findObject(w.level, 'Candybar3'), null);
  assert.equal(w.findObject(w.level, 'Candybar2'), ours);
  assert.equal(ours.name, 'Candybar2');
});
