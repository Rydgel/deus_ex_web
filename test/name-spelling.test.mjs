import test from 'node:test';
import assert from 'node:assert/strict';
import {NameSpelling} from '../src/unreal/name-spelling.mjs';

// Package name tables as the linker reads them: RF_LoadForClient|RF_LoadForServer|RF_LoadForEdit|RF_TagExp, the flags shipped names carry.
const pkg = (...names) => ({names: names.map(name => typeof name === 'string' ? {name, flags: 0x70010} : name)});
const boot = pkg('None', 'M00MeetPage_Played');
const conText = pkg('DL_X', 'DL_X_Played', 'DL_Y', 'DL_Z', 'M00MeetPage');

test('a new process: the map enters before DeusExConText, so the map spells the name (mission 0)', () => {
  const s = new NameSpelling();
  s.addBoot(boot);
  s.beginLevel(pkg('dl_x', 'dl_x_played'));
  s.enterPackage(conText);   // the level start's ConBindEvents
  assert.equal(s.spell('DL_X'), 'dl_x');
  assert.equal(s.intern('DL_X_Played'), 'dl_x_played');
  assert.equal(s.intern('M00MeetPage_Played'), 'M00MeetPage_Played', 'a startup package spelled it first');
});

test('a travel: the next map enters while the previous level\'s DeusExConText is still in the table (mission 10)', () => {
  const s = new NameSpelling();
  s.addBoot(boot);
  s.beginLevel(pkg('MetroOnly'));
  s.enterPackage(conText);
  s.beginLevel(pkg('dl_x', 'dl_x_played', 'dl_y'));   // the Chateau: LoadMap's verify load, then its collection
  assert.equal(s.spell('dl_x'), 'DL_X');
  assert.equal(s.spell('dl_x_played'), 'DL_X_Played');
  s.enterPackage(conText);   // the arrival's ConBindEvents
  assert.equal(s.intern(`${s.spell('DL_X')}_Played`), 'DL_X_Played');
  assert.equal(s.intern(`${s.spell('dl_y')}_Played`), 'DL_Y_Played', 'a new name takes the text it is made from');
});

test('the collection drops what neither the new map nor a startup package holds', () => {
  const s = new NameSpelling();
  s.addBoot(boot);
  s.beginLevel(pkg('dl_z', 'MetroOnly'));
  s.enterPackage(conText);
  assert.equal(s.intern('runtime_NAME'), 'runtime_NAME');
  assert.equal(s.spell('DL_Z'), 'dl_z');
  s.beginLevel(pkg('Other'));
  assert.equal(s.spell('RUNTIME_name'), 'RUNTIME_name', 'a name a script made is collected');
  assert.equal(s.spell('metroonly'), 'metroonly', 'the previous map\'s names are collected');
  assert.equal(s.spell('dl_z'), 'dl_z', 'the previous map\'s spelling no longer exists');
  s.enterPackage(conText);
  assert.equal(s.spell('dl_z'), 'DL_Z', 'DeusExConText enters it again with its own spelling');
  assert.equal(s.spell('none'), 'None');
  assert.equal(s.intern('m00meetpage_played'), 'M00MeetPage_Played', 'startup names are never collected');
});

test('the linker enters only names whose flags meet the game\'s load context, folds ASCII only, and stops at NUL', () => {
  const s = new NameSpelling();
  s.beginLevel(pkg({name: 'EditorOnly', flags: 0x40010}, {name: 'Client', flags: 0x10000}, 'Cafeé'));
  assert.equal(s.spell('editoronly'), 'editoronly');
  assert.equal(s.spell('CLIENT'), 'Client');
  assert.equal(s.spell('CAFEé'), 'Cafeé');
  assert.equal(s.spell('cafeÉ'), 'cafeÉ', '_wcsicmp in the C locale folds a-z only');
  assert.equal(s.intern('Name\u0000Suffix'), 'Name');
  assert.equal(s.spell('NAME'), 'Name');
});
