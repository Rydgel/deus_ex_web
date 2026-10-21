import test from 'node:test';
import assert from 'node:assert/strict';
import { travelKey, findTravelText } from '../src/runtime/travel-import.mjs';
import { createSaveStore } from '../src/runtime/script-travel.mjs';
import { isHostFlagBase } from '../src/runtime/travel-export.mjs';
import { createFlagBase } from '../src/runtime/script-triggers.mjs';

test('the text is looked up by the URL\'s Name= option, else DefaultName (SpawnPlayActor 0x103971f7)', () => {
  assert.equal(travelKey(['Name=Alice', 'Class=DeusEx.JCDentonMale']), 'Alice');
  assert.equal(travelKey(['name=bob']), 'bob');
  assert.equal(travelKey(['Class=DeusEx.JCDentonMale']), 'Player');
  assert.equal(travelKey([]), 'Player');
});

test('TravelInfo is searched case-insensitively and, standalone, falls back to the first pair', () => {
  const pairs = [['Player', 'text-1'], ['Other', 'text-2']];
  assert.equal(findTravelText(pairs, 'PLAYER'), 'text-1');
  assert.equal(findTravelText(pairs, 'other'), 'text-2');
  assert.equal(findTravelText(pairs, 'Nobody'), 'text-1');
  assert.equal(findTravelText([], 'Player'), null);
  assert.equal(findTravelText(null, 'Player'), null);
});

test('DeleteSaveGameFiles releases the level package\'s loaders once, then empties the Current directory', () => {
  const log = [];
  const store = createSaveStore({ releaseLoaders: () => log.push('released') });
  store.current.set('00_training.dxs', new Uint8Array(3));
  assert.equal(store.has('00_training.dxs'), true);
  assert.deepEqual(store.deleteCurrent(), ['00_training.dxs']);
  assert.deepEqual(store.deleteCurrent(), []);
  assert.deepEqual(log, ['released']);
  assert.equal(store.has('00_training.dxs'), false);
});

test('the host FlagBase is recognized by its store shape, nothing else', () => {
  assert.equal(isHostFlagBase(createFlagBase()), true);
  assert.equal(isHostFlagBase({}), false);
  assert.equal(isHostFlagBase(null), false);
  assert.equal(isHostFlagBase({ entries: [], getBool() {}, setBool() {} }), false);
});

test('GetInt reads the int flag of that name and is 0 for a missing one or another type (XFlagBase::execGetInt 0x10025790)', () => {
  const flags = createFlagBase();
  assert.equal(flags.getInt('SKTemp_SkillPointsAvail'), 0);
  flags.setInt('SKTemp_SkillPointsAvail', 5000, true, 0);
  flags.setBool('SKTemp_SkillPointsAvail', true, true, 0);
  assert.equal(flags.getInt('sktemp_skillpointsavail'), 5000);
  assert.equal(flags.getBool('SKTemp_SkillPointsAvail'), true);
  flags.setBool('OnlyBool', true, true, 0);
  assert.equal(flags.getInt('OnlyBool'), 0);
});
