import test from 'node:test';
import assert from 'node:assert/strict';
import { Furl, parseFurl, mapFileStem, UnsupportedFurlForm, TRAVEL_ABSOLUTE, TRAVEL_PARTIAL, TRAVEL_RELATIVE, DEFAULT_MAP, levelUrlAfterLoad, loadGameUrl } from '../src/runtime/furl.mjs';

const last = new Furl({ map: 'DX', portal: 'stale', op: ['Name=Player', 'Class=DeusEx.JCDentonMale', 'loadonly', 'load=x', 'push'] });

test('a relative Map travel copies the base protocol, host, port and options (but PUSH, POP, PEER, LOAD) and adds nothing (0x103f7d22..0x103f7fbc)', () => {
  const url = parseFurl(new Furl({ map: 'DX', portal: '', op: ['Name=Player', 'Class=DeusEx.JCDentonMale'] }), '00_Training', TRAVEL_RELATIVE);
  assert.equal(url.map, '00_Training');
  assert.equal(url.portal, '');
  assert.deepEqual(url.op, ['Name=Player', 'Class=DeusEx.JCDentonMale']);
  // measured: `Browse: 00_Training?Name=Player?Class=DeusEx.JCDentonMale` from the logo map
  assert.equal(url.toString(), '00_Training?Name=Player?Class=DeusEx.JCDentonMale');
  // the copy compares each whole option (appStricmp): `loadgame`, `loadonly` and `load=x` stay, `LOAD` and `push` go; a base without player options gives none
  assert.deepEqual(parseFurl(new Furl({ op: ['old', 'LOAD', 'loadgame', 'load=x', 'push'] }), 'Map', TRAVEL_RELATIVE).op, ['old', 'loadgame', 'load=x']);
  // measured after a restart (LastURL `00_training?loadonly`, the tick removed `loadonly`): `Browse: 04_NYC_UNATCOIsland.dx`
  assert.equal(String(parseFurl(new Furl({ map: '00_training' }), '04_NYC_UNATCOIsland.dx', TRAVEL_RELATIVE)), '04_NYC_UNATCOIsland.dx');
  // measured: `Browse: ..\Save\Current\00_Training.dxs?Name=Player?Class=DeusEx.JCDentonMale?restart` (the base's options before the text's)
  const restart = parseFurl(new Furl({ map: '..\\Save\\Current\\00_Training.dxs', op: ['Name=Player', 'Class=DeusEx.JCDentonMale'] }), '?restart', TRAVEL_RELATIVE);
  assert.equal(String(restart), '..\\Save\\Current\\00_Training.dxs?Name=Player?Class=DeusEx.JCDentonMale?restart');
  const base = new Furl({ protocol: 'unreal', host: '', port: 7777, map: 'Index.unr' });
  assert.deepEqual([parseFurl(base, 'X', TRAVEL_RELATIVE).protocol, parseFurl(base, 'X', TRAVEL_RELATIVE).port], ['unreal', 7777]);
  assert.deepEqual([parseFurl(base, 'X', TRAVEL_PARTIAL).protocol, parseFurl(base, 'X', TRAVEL_PARTIAL).port], ['deusex', 7790]);
});

test('Map#Portal splits the portal; the base portal does not leak into a travel that names none', () => {
  const url = parseFurl(new Furl({ map: 'DX' }), '01_NYC_UNATCOHQ#hq_start', TRAVEL_RELATIVE);
  assert.deepEqual([url.map, url.portal], ['01_NYC_UNATCOHQ', 'hq_start']);
  assert.equal(parseFurl(new Furl({ map: 'DX', portal: '' }), '00_Training', TRAVEL_RELATIVE).portal, '');
  // a relative URL with no map text (?restart) keeps the base map and portal
  const restart = parseFurl(new Furl({ map: '00_Training', portal: 'p' }), '?restart', TRAVEL_RELATIVE);
  assert.deepEqual([restart.map, restart.portal, restart.hasOption('restart')], ['00_Training', 'p', true]);
});

test('partial keeps the base options except PUSH, POP, PEER and LOAD; absolute copies nothing but the base player options it lacks', () => {
  const partial = parseFurl(last, 'DXONLY', TRAVEL_PARTIAL);
  assert.deepEqual(partial.op, ['Name=Player', 'Class=DeusEx.JCDentonMale', 'loadonly', 'load=x']);
  assert.equal(partial.portal, '');
  // TRAVEL_Absolute with an internal base: each base Name=/Team=/Class=/Skin=/Face=/Voice=/OverrideClass= the new URL has no value for, logged (0x103f8900..0x103f8b66)
  const added = [];
  const absolute = parseFurl(last, 'DXONLY', TRAVEL_ABSOLUTE, { log: option => added.push(option) });
  assert.deepEqual(absolute.op, ['Name=Player', 'Class=DeusEx.JCDentonMale']);
  assert.deepEqual(added, ['Name=Player', 'Class=DeusEx.JCDentonMale']);
  assert.equal(parseFurl(last, '?loadonly', TRAVEL_ABSOLUTE).map, DEFAULT_MAP);
  assert.deepEqual(parseFurl(last, 'X?Name=JC', TRAVEL_ABSOLUTE).op, ['Name=JC', 'Class=DeusEx.JCDentonMale']);
  assert.deepEqual(parseFurl(null, 'X', TRAVEL_ABSOLUTE).op, []);
  // measured: `Browse: Index.dx?loadgame=77?Name=Player?Class=DeusEx.JCDentonMale` after two `URL: Adding default option` lines
  assert.equal(String(parseFurl(last, '?loadgame=77', TRAVEL_ABSOLUTE)), 'Index.dx?loadgame=77?Name=Player?Class=DeusEx.JCDentonMale');
});

test('LoadMap keeps the file\'s URL for any option that starts with load (0x1038ce8b), else the level\'s URL is the one it was loaded with', () => {
  const file = { protocol: 'deusex', host: '', map: 'Index.dx', portal: '', options: [], port: 7790 };
  const kept = url => levelUrlAfterLoad(url, file, 1);
  assert.equal(kept(parseFurl(null, '04_NYC_UNATCOHQ?loadgame', TRAVEL_ABSOLUTE)).map, 'Index.dx');
  assert.equal(kept(new Furl({ map: '00_training', op: ['loadonly'] })).map, 'Index.dx');
  assert.equal(kept(new Furl({ map: 'X', op: ['LOAD'] })).map, 'Index.dx');
  const plain = kept(new Furl({ map: '04_NYC_UNATCOHQ', portal: 'unatcohq', op: ['Name=Player', 'Class=DeusEx.JCDentonMale'] }));
  assert.deepEqual(plain, { protocol: 'deusex', host: '', port: 7790, map: '04_NYC_UNATCOHQ', op: ['Name=Player', 'Class=DeusEx.JCDentonMale'], portal: 'unatcohq', valid: 1 });
  // a loaded game: the saved level's own URL, with its options
  const saved = levelUrlAfterLoad(loadGameUrl('00_Training', last), { ...file, map: '00_Training', options: ['Name=Player', 'Class=DeusEx.JCDentonMale'] }, 1);
  assert.deepEqual([saved.map, saved.op], ['00_Training', ['Name=Player', 'Class=DeusEx.JCDentonMale']]);
});

test('options answer HasOption and GetOption as Browse reads them', () => {
  const url = parseFurl(null, 'Map?loadgame=77?loadonly', TRAVEL_ABSOLUTE);
  assert.equal(url.hasOption('LoadOnly'), true);
  // FURL::HasOption compares the whole option (appStricmp, 0x103f9e3b): `loadgame=77` is not `loadgame`
  assert.equal(url.hasOption('loadgame'), false);
  assert.equal(url.hasOption('loadgame=77'), true);
  assert.equal(url.hasOption('restart'), false);
  assert.equal(url.getOption('loadgame='), '77');
  assert.equal(url.getOption('load=', 'none'), 'none');
  assert.equal(url.isLocal, true);
});

test('the installed forms that are not ported are refused by name, not approximated', () => {
  for (const text of ['..\\Save\\Current\\Map.dxs?load', 'unreal://host/Map', 'Map#Portal?Name=Player', 'Two Words', 'Map.dx extra', 'Map.dxx', 'Map #Portal', 'Map#Por tal'])
    assert.throws(() => parseFurl(null, text, TRAVEL_RELATIVE), UnsupportedFurlForm, text);
  assert.throws(() => parseFurl(null, 'Map', 7), TypeError);
});

test('the pure filename heads of the installed destinations keep their extension and blank in Map (measured URL.Map) and name the file without them', () => {
  const base = new Furl({ map: 'DX', portal: '' });
  const cases = [['04_NYC_UNATCOIsland.dx', '04_NYC_UNATCOIsland.dx', '', '04_NYC_UNATCOIsland'],
    ['14_Vandenberg_sub.dx#subbay', '14_Vandenberg_sub.dx', 'subbay', '14_Vandenberg_sub'],
    ['15_area51_bunker.dx #bunker_start', '15_area51_bunker.dx ', 'bunker_start', '15_area51_bunker'],
    ['14_OceanLab_UC.dx #UC', '14_OceanLab_UC.dx ', 'UC', '14_OceanLab_UC']];
  for (const [text, map, portal, stem] of cases) {
    const url = parseFurl(base, text, TRAVEL_RELATIVE);
    assert.deepEqual([url.map, url.portal, mapFileStem(url.map)], [map, portal, stem], text);
  }
  // FURL::String: the map, each option behind a `?`, then `#` and the portal
  assert.equal(parseFurl(Object.assign(base.clone(), { op: ['Name=Player', 'Class=DeusEx.JCDentonMale'] }), '15_area51_bunker.dx #bunker_start', TRAVEL_RELATIVE).toString(),
    '15_area51_bunker.dx ?Name=Player?Class=DeusEx.JCDentonMale#bunker_start');
  assert.equal(mapFileStem('00_Training'), '00_Training');
});
