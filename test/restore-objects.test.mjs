import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlagBase } from '../src/runtime/script-triggers.mjs';
import { hashScriptName } from '../src/runtime/script-names.mjs';
import { fillRestoredFlagStore, isSavedFlag, isSavedFlagBase, PLAIN_SAVED_OBJECTS, NATIVE_SAVED_OBJECTS } from '../src/runtime/script-restore-objects.mjs';
import { loadGameUrl } from '../src/runtime/furl.mjs';
import { createSaveDirectory, saveSlotDirectory } from '../src/runtime/save-directory.mjs';

// A saved FlagBase as the restore reads it: the FlagBase object's hashTable heads and nextFlag chains, each flag with its class, name, hash, expiration and value.
const flag = (key, name, fields = {}) => ({ key, flagName: name, flagHash: hashScriptName(name.toLowerCase()) | 0, expiration: 0, nextFlag: null, ...fields });
const reader = { readNamed: (object, name) => object[name] };

test('a saved flag store is walked bucket by bucket and chain by chain into the host store with each flag\'s type, value and expiration', () => {
  const a = flag('extension.flagbool', 'MeetPaul_Played', { expiration: 2, bValue: true });
  const b = flag('extension.flagint', 'SKTemp_SkillPointsTotal', { intValue: 5000 });
  const c = flag('extension.flagbool', 'M1MissionStart', { expiration: 2, bValue: true });
  const base = Object.assign(createFlagBase(), { hashTable: [a, null, b, c], defaultFlagExpiration: 2 });
  const count = fillRestoredFlagStore(reader, base, f => f.key);
  assert.equal(count, 3);
  assert.equal(base.getBool('MeetPaul_Played'), true);
  assert.equal(base.getInt('SKTemp_SkillPointsTotal'), 5000);
  assert.equal(base.getBool('M1MissionStart'), true);
  assert.deepEqual([...base.entries.values()].map(e => `${e.name}|${e.type}|${e.expiration}`).sort(),
    ['M1MissionStart|0|2', 'MeetPaul_Played|0|2', 'SKTemp_SkillPointsTotal|2|0']);
  // a new flag takes the saved default expiration (SetDefaultExpiration from defaultFlagExpiration)
  base.setBool('Later', true, true, -1);
  assert.equal(base.entries.get('later').expiration, 2);
});

test('a chained bucket keeps its saved order and a flag with another hash than its name is refused', () => {
  const second = flag('extension.flagbool', 'Second', { bValue: true });
  const first = flag('extension.flagbool', 'First', { bValue: true, nextFlag: second });
  const base = Object.assign(createFlagBase(), { hashTable: [first], defaultFlagExpiration: 0 });
  fillRestoredFlagStore(reader, base, f => f.key);
  assert.deepEqual([...base.entries.values()].map(e => e.name), ['First', 'Second']);
  const wrong = Object.assign(createFlagBase(), { hashTable: [flag('extension.flagbool', 'Bad', { flagHash: 7, bValue: true })], defaultFlagExpiration: 0 });
  assert.throws(() => fillRestoredFlagStore(reader, wrong, f => f.key), /carries the hash 7/);
  const other = Object.assign(createFlagBase(), { hashTable: [flag('extension.flagfloat', 'F')], defaultFlagExpiration: 0 });
  assert.throws(() => fillRestoredFlagStore(reader, other, f => f.key), /flagfloat/);
});

test('the classes a saved level\'s objects may have: flag objects, plain script objects and the two native ones', () => {
  assert.ok(isSavedFlag('extension.flagbase') && isSavedFlag('extension.flagbool') && !isSavedFlag('deusex.deusexnote'));
  assert.ok(isSavedFlagBase('extension.flagbase') && !isSavedFlagBase('extension.flagbool'));
  assert.deepEqual([...PLAIN_SAVED_OBJECTS].sort(), ['deusex.deusexgoal', 'deusex.deusexnote', 'deusex.nanokeyinfo']);
  assert.deepEqual(Object.keys(NATIVE_SAVED_OBJECTS).sort(), ['deusex.datavaultimagenote', 'deusex.deusexlog']);
});

test('the loaded game\'s LoadMap URL is the measured one, and QuickSave and slot directories are named as the original names them', () => {
  assert.equal(String(loadGameUrl('01_NYC_UNATCOIsland')), '..\\Save\\Current\\01_NYC_UNATCOIsland.dxs?load?loadonly?loadgame?Name=Player?Class=DeusEx.JCDentonMale');
  assert.equal(saveSlotDirectory(-1), 'QuickSave');
  assert.equal(saveSlotDirectory(77), 'Save0077');
});

test('the page\'s listing replaces the slots but not Current, the simulation\'s own scratch directory', () => {
  const directory = createSaveDirectory({ saves: [{ directory: 'Save0001', files: [{ name: 'SaveInfo.dxs', size: 1 }] }] });
  directory.writeFile('Current', 'A.dxs', new Uint8Array([1, 2, 3]));
  directory.replace([{ directory: 'Save0002', files: [{ name: 'SaveInfo.dxs', size: 1 }] }]);
  assert.deepEqual(directory.directories(), ['Current', 'Save0002']);
  assert.deepEqual([...directory.readFile('Current', 'A.dxs')], [1, 2, 3]);
  // a listing that names Current wins
  directory.replace([{ directory: 'Current', files: [{ name: 'B.dxs', size: 1 }] }]);
  assert.deepEqual(directory.files('Current').map(file => file.name), ['B.dxs']);
});
