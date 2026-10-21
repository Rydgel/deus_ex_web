import test from 'node:test';
import assert from 'node:assert/strict';
import { Furl, parseFurl, UnsupportedFurlForm, TRAVEL_ABSOLUTE, TRAVEL_PARTIAL, TRAVEL_RELATIVE, DEFAULT_MAP } from '../src/runtime/furl.mjs';

const last = new Furl({ map: 'DX', portal: 'stale', op: ['Name=Player', 'Class=DeusEx.JCDentonMale', 'loadonly', 'load=x', 'push'] });

test('a relative Map travel carries the base host and no options; Name= and Class= are added (measured Browse line)', () => {
  const url = parseFurl(new Furl({ map: 'DX', portal: '', op: ['old'] }), '00_Training', TRAVEL_RELATIVE);
  assert.equal(url.map, '00_Training');
  assert.equal(url.portal, '');
  assert.deepEqual(url.op, ['Name=Player', 'Class=DeusEx.JCDentonMale']);
  assert.equal(url.toString(), '00_Training?Name=Player?Class=DeusEx.JCDentonMale');
});

test('Map#Portal splits the portal; the base portal does not leak into a travel that names none', () => {
  const url = parseFurl(new Furl({ map: 'DX' }), '01_NYC_UNATCOHQ#hq_start', TRAVEL_RELATIVE);
  assert.deepEqual([url.map, url.portal], ['01_NYC_UNATCOHQ', 'hq_start']);
  assert.equal(parseFurl(new Furl({ map: 'DX', portal: '' }), '00_Training', TRAVEL_RELATIVE).portal, '');
  // a relative URL with no map text (?restart) keeps the base map and portal
  const restart = parseFurl(new Furl({ map: '00_Training', portal: 'p' }), '?restart', TRAVEL_RELATIVE);
  assert.deepEqual([restart.map, restart.portal, restart.hasOption('restart')], ['00_Training', 'p', true]);
});

test('partial keeps the base options except PUSH, POP, PEER and LOAD; absolute copies nothing', () => {
  const partial = parseFurl(last, 'DXONLY', TRAVEL_PARTIAL);
  assert.deepEqual(partial.op, ['Name=Player', 'Class=DeusEx.JCDentonMale', 'loadonly']);
  assert.equal(partial.portal, '');
  const absolute = parseFurl(last, 'DXONLY', TRAVEL_ABSOLUTE);
  assert.deepEqual(absolute.op, ['Name=Player', 'Class=DeusEx.JCDentonMale']);
  assert.equal(parseFurl(last, '?loadonly', TRAVEL_ABSOLUTE).map, DEFAULT_MAP);
});

test('options answer HasOption and GetOption as Browse reads them', () => {
  const url = parseFurl(null, 'Map?loadgame=77?loadonly', TRAVEL_ABSOLUTE);
  assert.equal(url.hasOption('LoadOnly'), true);
  assert.equal(url.hasOption('loadgame'), true);
  assert.equal(url.hasOption('restart'), false);
  assert.equal(url.getOption('loadgame='), '77');
  assert.equal(url.getOption('load=', 'none'), 'none');
  assert.equal(url.isLocal, true);
});

test('the installed forms that are not ported are refused by name, not approximated', () => {
  for (const text of ['04_NYC_UNATCOIsland.dx', '15_area51_bunker.dx #bunker_start', '14_Oceanlab_silo.dx #frontgate', '..\\Save\\Current\\Map.dxs?load',
    'unreal://host/Map', 'Map#Portal?Name=Player', 'Two Words'])
    assert.throws(() => parseFurl(null, text, TRAVEL_RELATIVE), UnsupportedFurlForm, text);
  assert.throws(() => parseFurl(null, 'Map', 7), TypeError);
});
