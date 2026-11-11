import test from 'node:test';
import assert from 'node:assert/strict';
import {DefaultsMap, DefaultValues, defaultValues, defaultValuesOf, snapshotOfDefaults} from '../src/runtime/defaults-map.mjs';

// The linked classes' defaults (docs/firefox-60fps-plan.md, "The linked classes' defaults and property links"): a table over frozen layers
// reads as one flat Map holding the same writes; the value Maps are shared and never written. Comparisons are on strings and booleans
// (never assert.equal on a runtime object: a failing one makes node inspect it).

const rng = seed => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const project = map => [...map.entries()].map(([key, value]) => `${key}=${value}`).sort().join(',');
const sameContents = (table, model) => table.size === model.size && project(table) === project(model) &&
  [...model].every(([key, value]) => table.get(key) === value && table.has(key)) && !table.has('absent') && table.get('absent') === undefined;

test('a defaults table reads as one flat Map holding the same writes, through snapshots and derived tables', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const random = rng(seed), pick = n => Math.floor(random() * n);
    // a few tables, each with its flat model; a derived table starts as a view of its source's snapshot
    const tables = [new DefaultsMap()], models = [new Map()], versions = [0];
    const snapshots = [];   // [frozen layer, a copy of the model when it was taken]
    for (let step = 0; step < 500; step++) {
      const at = pick(tables.length), table = tables[at], model = models[at], roll = random(), key = `k${pick(12)}`;
      if (roll < 0.45) { const value = pick(1000); assert.ok(table.set(key, value) === table); model.set(key, value); versions[at]++; }
      else if (roll < 0.6) { assert.ok(table.delete(key) === model.delete(key)); versions[at]++; }
      else if (roll < 0.62) { table.clear(); model.clear(); versions[at]++; }
      else if (roll < 0.8) snapshots.push([table.snapshot(), new Map(model)]);
      else if (roll < 0.86 && tables.length < 8) { tables.push(new DefaultsMap(table)); models.push(new Map(model)); versions.push(0); }
      assert.ok(sameContents(table, model), `seed ${seed} step ${step}: table ${at} differs from its model`);
      assert.ok(table.version === versions[at], `seed ${seed} step ${step}: version ${table.version} != ${versions[at]}`);
    }
    for (const [layer, copy] of snapshots) assert.ok(sameContents(layer, copy), `seed ${seed}: a snapshot changed after it was taken`);
    for (let i = 0; i < tables.length; i++) assert.ok(sameContents(tables[i], models[i]), `seed ${seed}: table ${i} at the end`);
  }
});

test('a snapshot is frozen, shared while nothing is written, and the table keeps its version', () => {
  const table = new DefaultsMap([['a', 1], ['b', 2]]);
  assert.ok(table.version === 0, 'entries given to the constructor are not changes');
  const first = table.snapshot();
  assert.ok(table.snapshot() === first, 'an unwritten table has the layer it stands on');
  assert.ok(table.isViewOf(first) && table.version === 0);
  assert.throws(() => first.set('c', 3), TypeError);
  assert.throws(() => first.delete('a'), TypeError);
  assert.throws(() => first.clear(), TypeError);
  assert.ok(first.snapshot() === first);
  table.set('a', 9);
  assert.ok(!table.isViewOf(first) && table.version === 1);
  assert.ok(first.get('a') === 1 && table.get('a') === 9, 'the layer keeps the entry it had');
  const second = table.snapshot();
  assert.ok(second !== first && second.get('a') === 9 && second.size === 2);
  table.delete('b');
  assert.ok(table.size === 1 && !table.has('b') && second.has('b') && first.has('b'));
  assert.ok(snapshotOfDefaults(table) !== snapshotOfDefaults(new Map([['a', 1]])));
  assert.ok(snapshotOfDefaults(new Map([['a', 1]])) instanceof Map);
});

test('a derived table starts as a view of its source and no later write of the source shows in it', () => {
  const base = new DefaultsMap(), v = n => defaultValuesOf([0], [n]);
  base.set('x', v(1)); base.set('y', v(2));
  const child = new DefaultsMap(base);
  assert.ok(child.size === 2 && child.get('x') === v(1) && child.version === 0 && child.own === null);
  base.set('x', v(5)); base.set('z', v(3)); base.delete('y');
  assert.ok(child.get('x') === v(1) && child.get('y') === v(2) && !child.has('z') && child.size === 2, 'the child kept the base as it linked');
  child.delete('x'); child.set('w', v(4));
  assert.ok(child.size === 2 && !child.has('x') && child.has('w') && child.has('y'));
  assert.ok(base.get('x') === v(5) && base.size === 2, 'and the base did not see the child');
  child.set('x', v(6));
  assert.ok(child.get('x') === v(6) && child.size === 3);
  const seen = [...child].map(([key]) => key).sort().join(',');
  assert.ok(seen === 'w,x,y', seen);
});

test('layers that pile up are flattened and the table still reads right', () => {
  const table = new DefaultsMap(), model = new Map(), taken = [];
  for (let i = 0; i < 80; i++) {
    table.set(`k${i % 7}`, i); model.set(`k${i % 7}`, i);
    if (i % 11 === 3) { table.delete('k2'); model.delete('k2'); }
    taken.push([table.snapshot(), new Map(model)]);
    assert.ok(sameContents(table, model), `step ${i}`);
  }
  let depth = 0;
  for (let layer = table.parent; layer; layer = layer.parent) depth++;
  assert.ok(depth <= 25, `${depth} layers`);
  for (const [layer, copy] of taken) assert.ok(sameContents(layer, copy));
});

test('the values of a default are never written in place', () => {
  const values = defaultValuesOf([0, 1], ['a', 'b']);
  assert.ok(values instanceof Map && values instanceof DefaultValues && values.size === 2 && values.get(1) === 'b');
  assert.throws(() => values.set(2, 'c'), TypeError);
  assert.throws(() => values.delete(0), TypeError);
  assert.throws(() => values.clear(), TypeError);
  assert.ok(values.size === 2);
  assert.throws(() => new DefaultsMap().set('a', undefined), TypeError);
});

test('a default of one scalar is one object a value; nothing else is merged', () => {
  const one = (...args) => defaultValuesOf([0], args);
  for (const value of [0, 1, 2.5, -3, 'x', '', true, false, null, 1n, 2n ** 70n, Infinity]) {
    assert.ok(one(value) === one(value), `${String(value)} is one object`);
    assert.ok(Object.is(one(value).get(0), value) && one(value).size === 1 && one(value).has(0));
  }
  assert.ok(one(1) !== one('1') && one(1) !== one(true) && one(0) !== one(false) && one(null) !== one(0) && one(1) !== one(1n), 'kinds stay apart');
  assert.ok(one(0) !== one(-0) && Object.is(one(-0).get(0), -0) && Object.is(one(0).get(0), 0) && one(-0) === one(-0), 'a negative zero is told from zero');
  assert.ok(one(NaN) !== one(NaN) && Number.isNaN(one(NaN).get(0)), 'a NaN is not merged');
  const object = {kind: 'Texture'}, list = [1, 2, 3];
  assert.ok(one(object) !== one(object) && one(object).get(0) === object && one(list).get(0) === list, 'a value that holds a reference is not interned');
  assert.ok(defaultValuesOf([1], [5]) !== defaultValuesOf([1], [5]) && defaultValuesOf([1], [5]).get(1) === 5, 'index 1 alone is not interned');
  const two = defaultValuesOf([0, 1], [7, 8]);
  assert.ok(two !== defaultValuesOf([0, 1], [7, 8]) && two.size === 2 && [...two].map(entry => entry.join(':')).join() === '0:7,1:8');
  // a scratch list longer than the count is cut at the count
  assert.ok(defaultValuesOf([0, 5, 6], ['q', 'r', 's'], 1) === one('q'));
});

test('defaultValues makes the shared form of any Map or entries, and keeps one it is given', () => {
  const given = new Map([[0, 'a'], [3, 'b']]), made = defaultValues(given);
  assert.ok(made instanceof DefaultValues && made !== given && made.size === 2 && made.get(3) === 'b' && made.get(0) === 'a');
  assert.ok(defaultValues(made) === made);
  assert.ok(defaultValues(new Map([[0, 41]])) === defaultValuesOf([0], [41]));
  assert.ok(defaultValues([[0, {kind: 'Class'}]]) instanceof DefaultValues);
  given.set(9, 'z');
  assert.ok(made.size === 2, 'a copy');
});
