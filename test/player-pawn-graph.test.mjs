import test from 'node:test';
import assert from 'node:assert/strict';
import {watchPlayerPawnGraph} from '../src/runtime/player-pawn-graph.mjs';

const graph = () => ({engine: {client: {decals: true, viewports: [{actor: {name: 'JC'}, input: null}]}}, actors: []});

test('every link of the walk reports its writes, with the values and enumerability unchanged', () => {
  const level = graph(), events = [];
  const before = JSON.stringify(level);
  assert.equal(watchPlayerPawnGraph(level, complete => events.push(complete)), true);
  assert.equal(JSON.stringify(level), before);
  assert.deepEqual(Object.keys(level.engine.client.viewports[0]), ['actor', 'input']);
  const viewport = level.engine.client.viewports[0];
  viewport.actor = null;
  assert.deepEqual(events, [true]);
  viewport.input = {};
  assert.equal(events.length, 1, 'only the links of the walk are watched');
  level.engine.client.viewports[0] = {actor: {name: 'Other'}};
  level.engine.client.viewports = [];
  level.engine.client = {viewports: [{actor: null}]};
  level.engine = {client: {viewports: [{actor: null}]}};
  assert.equal(events.length, 5);
  // (a list with no first viewport has no link to watch: that write says the chain is no longer complete)
  assert.deepEqual(events, [true, true, false, true, true]);
  // an object a write installed is watched in turn
  level.engine.client.viewports[0].actor = {name: 'Again'};
  assert.equal(events.length, 6);
});

test('a write that installs a chain with a link that cannot be watched says so', () => {
  const level = graph(), events = [];
  watchPlayerPawnGraph(level, complete => events.push(complete));
  level.engine = {client: {viewports: [{}]}};
  assert.deepEqual(events, [false]);
});

test('a missing or already watched link is not a complete chain', () => {
  assert.equal(watchPlayerPawnGraph({}, () => {}), false);
  assert.equal(watchPlayerPawnGraph({engine: {client: {viewports: []}}}, () => {}), false);
  const level = graph();
  assert.equal(watchPlayerPawnGraph(level, () => {}), true);
  assert.equal(watchPlayerPawnGraph(level, () => {}), false);
  assert.equal(watchPlayerPawnGraph(null, () => {}), false);
});
