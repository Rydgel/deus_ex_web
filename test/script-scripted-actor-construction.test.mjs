import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DATALINK_PLAY_CONSTRUCTION,
  SCRIPTED_ACTOR_CONSTRUCTION,
  resolveInheritedActorConstructor,
  verifyDataLinkPlayDefaults,
} from '../src/runtime/script-scripted-actor-construction.mjs';

const actor = {key: 'engine.actor', nativeConstructor: 0x10302dab, nativeVtable: 0x104268dc};
const conPlayBase = {key: 'deusex.conplaybase', nativeConstructor: null};
const dataLinkPlay = {key: 'deusex.datalinkplay', nativeConstructor: null};

test('DataLinkPlay selects the inherited AActor constructor only for its exact class chain', () => {
  const before = structuredClone({actor, conPlayBase, dataLinkPlay});
  const result = resolveInheritedActorConstructor({actor, conPlayBase, dataLinkPlay});
  assert.equal(result.inherited, true);
  assert.equal(result.constructor, 0x10302dab);
  assert.equal(result.constructorBody, 0x10323550);
  assert.equal(result.nativeVtable, 0x104268dc);
  assert.deepEqual({actor, conPlayBase, dataLinkPlay}, before);
  assert.throws(() => resolveInheritedActorConstructor({
    actor, conPlayBase, dataLinkPlay: {...dataLinkPlay, key: 'engine.camerapoint'},
  }), /deusex\.datalinkplay/);
  assert.throws(() => resolveInheritedActorConstructor({
    actor: {...actor, nativeConstructor: 0}, conPlayBase, dataLinkPlay,
  }), /ClassConstructor/);
});

test('linked property sizes and DataLink fields retain the recovered contract', () => {
  assert.equal(SCRIPTED_ACTOR_CONSTRUCTION.layout.actorPropertiesSize, 0x318);
  assert.equal(SCRIPTED_ACTOR_CONSTRUCTION.layout.conPlayBasePropertiesSize, 0x3c0);
  assert.equal(SCRIPTED_ACTOR_CONSTRUCTION.layout.dataLinkPlayPropertiesSize, 0x5ac);
  assert.equal(DATALINK_PLAY_CONSTRUCTION.fields.find(field => field.name === 'infoLinkNames').elementSize, 0x18);
  assert.equal(DATALINK_PLAY_CONSTRUCTION.fields.find(field => field.name === 'infoLinkNames').arrayDim, 17);
  assert.deepEqual(DATALINK_PLAY_CONSTRUCTION.fields.slice(-3).map(field => field.name),
    ['dataLinkQueue', 'DataLinkTrigger', 'EndTransmission']);
});

test('DataLinkPlay defaults and inherited PreBeginPlay source stay explicit', () => {
  const defaults = {...DATALINK_PLAY_CONSTRUCTION.authoredDefaults};
  const report = verifyDataLinkPlayDefaults(defaults);
  assert.equal(report.collisionFlagsClear, true);
  assert.equal(report.role, 4);
  assert.throws(() => verifyDataLinkPlayDefaults({...defaults, Role: 3}), /Role/);
  assert.equal(SCRIPTED_ACTOR_CONSTRUCTION.startup.preBeginPlay.netModeClient, 3);
  assert.equal(SCRIPTED_ACTOR_CONSTRUCTION.startup.preBeginPlay.relevanceService,
    'Level.Game.IsRelevant(Self)');
});
