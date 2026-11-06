import test from 'node:test';
import assert from 'node:assert/strict';
import {createRadiusActorsIterator, createVisibleActorsIterator} from '../src/runtime/script-iterators.mjs';

// RadiusActors and VisibleActors with the Rust core's area scan (render.rs area_scan, through `area`) against their JavaScript loops
// (scanArea, ACTOR_SCAN=js): the same actors in the same order for every radius and point, whichever slots the image does not answer.
const f = Math.fround;
const BASE = {name: 'Actor'}, OTHER = {name: 'Other'};
const isA = (actor, base) => base === BASE || actor.cls === base;
const actorWord = actor => actor.hidden ? 2 : 0x80;

const actors = [];
for (let i = 0; i < 120; i++) {
  actors.push(i % 11 === 5 ? null : {
    name: `A${i}`, cls: i % 3 === 0 ? OTHER : BASE, hidden: i % 7 === 2,
    position: [f(i * 37 % 400 - 200), f(i * 91 % 300 - 150), f(i % 5 * 20)], radius: f(i % 4 * 12),
    sees: i % 9 !== 4, untested: i % 13 === 6,
  });
}

/** area_scan's contract, over the fixture: kind 2 for an actor the image does not answer. */
function areaFor(log) {
  return (array, start, base, mode, radius, loc) => {
    log.push([start, mode]);
    const num = value => f(value);
    let cursor = start;
    while (cursor < array.length) {
      const actor = array[cursor++];
      if (actor === null) continue;
      if (actor.untested) return {kind: 2, cursor};
      if (mode === 2 && actor.hidden) continue;
      if (!isA(actor, base)) continue;
      if (mode === 1 || radius < 0 || radius > 0) {
        const d = [0, 1, 2].map(i => num(actor.position[i]) - loc[i]);
        const reach = mode === 1 ? radius + num(actor.radius) : radius;
        if (!(reach * reach > d[0] * d[0] + d[1] * d[1] + d[2] * d[2])) continue;
      }
      return {kind: 1, cursor};
    }
    return {kind: 0, cursor};
  };
}

const value = v => ({reference: true, get: () => v, set() {}});
function collect(make, args, extra) {
  let found = null;
  const out = {reference: true, get: () => found, set: v => { found = v; }};
  const evaluate = index => index === 1 ? out : args[index];
  const it = make({receiver: {position: [0, 0, 0]}, argumentCount: args.length, evaluateArgument: evaluate, actorClass: BASE,
    levelFor: () => ({actors, model: {}, fastLineCheck: (model, from) =>
      (actors.find(a => a && a.position[0] === from[0] && a.position[1] === from[1] && a.position[2] === from[2])?.sees ?? true) ? 1 : 0}),
    isA, actorWord, ...extra});
  const names = [];
  while (it.next()) names.push(found.name);
  return names;
}

test('RadiusActors through the area scan lists what the JavaScript loop lists', () => {
  const log = [];
  for (const radius of [0, 30, 90, 250, 1000]) for (const loc of [[0, 0, 0], [100, -40, 20], [-180, 120, 40]]) {
    const args = [BASE, null, radius, loc];
    const reference = collect(createRadiusActorsIterator, args, {});
    const rust = collect(createRadiusActorsIterator, args, {area: areaFor(log)});
    assert.deepEqual(rust, reference, `radius ${radius} at ${loc}`);
  }
  assert.ok(log.length > 15 && log.every(([, mode]) => mode === 1));
});

test('VisibleActors through the area scan lists what the JavaScript loop lists', () => {
  const log = [];
  let listed = 0;
  for (const radius of [0, 40, 120, 400]) for (const loc of [[0, 0, 0], [100, -40, 20], [-180, 120, 40]]) {
    const args = [BASE, null, radius, loc];
    const reference = collect(createVisibleActorsIterator, args, {});
    const rust = collect(createVisibleActorsIterator, args, {area: areaFor(log)});
    assert.deepEqual(rust, reference, `radius ${radius} at ${loc}`);
    listed += reference.length;
  }
  assert.ok(listed > 40, `${listed} actors listed`);
  assert.ok(log.length > 12 && log.every(([, mode]) => mode === 2));
});

test('a class that is not Actor narrows both scans alike', () => {
  const log = [];
  const args = [OTHER, null, 300, [0, 0, 0]];
  assert.deepEqual(collect(createRadiusActorsIterator, args, {area: areaFor(log)}), collect(createRadiusActorsIterator, args, {}));
  assert.deepEqual(collect(createVisibleActorsIterator, args, {area: areaFor(log)}), collect(createVisibleActorsIterator, args, {}));
});
