import test from 'node:test';
import assert from 'node:assert/strict';
import { Furl, parseFurl, TRAVEL_RELATIVE, TRAVEL_PARTIAL } from '../src/runtime/furl.mjs';
import { browseDecision, getNextMissionNumber, getCurrentMissionNumber } from '../src/runtime/travel-browse.mjs';

// The branch table of docs/travel.md "Which branch each single-player entry takes"; (M) rows were measured in the original.
const level = (missionNumber, mapName = 'x', urlMap = mapName) => ({ info: { missionNumber, mapName }, urlMap });
// the boot's LastURL: the [DefaultPlayer] options a relative travel copies (furl.mjs)
const last = new Furl({ map: 'DX', op: ['Name=Player', 'Class=DeusEx.JCDentonMale'] });
const go = (text, type, options) => browseDecision({ url: parseFurl(last, text, type), lastURL: last, ...options });
const ops = effects => effects.map(effect => effect.op === 'log' ? effect.text : effect.op === 'loadMap' ? `loadMap ${effect.url}` : effect.op);

test('GetNextMissionNumber: -1 for an empty name or a name that does not start with two digits', () => {
  assert.deepEqual(['dx', 'dxonly', 'entry', '', '0x_a', '1', '00_Training', '01_NYC_UNATCOIsland', '99_Endgame1', '15_Area51'].map(getNextMissionNumber),
    [-1, -1, -1, -1, -1, -1, 0, 1, 99, 15]);
  assert.equal(getCurrentMissionNumber(null), -1);
  assert.equal(getCurrentMissionNumber({ info: null }), -1);
  assert.equal(getCurrentMissionNumber(level(-2)), -2);
});

test('game start (M): no level, cur -1, next -1 -> wipe, LoadMap', () => {
  const effects = go('DX', TRAVEL_RELATIVE, { level: null });
  assert.deepEqual(ops(effects), ['Doing load, not loadgame', 'Current mission number is -1, next is -1', 'deleteSaveGameFiles', 'loadMap DX?Name=Player?Class=DeusEx.JCDentonMale']);
});

test('the menu Training button (M): cur -2, next 0 -> player looked up, wipe, bStartingNewGame cleared, LoadMap', () => {
  const effects = go('00_Training', TRAVEL_RELATIVE, { level: level(-2, 'DX'), player: { bStartingNewGame: true } });
  assert.deepEqual(ops(effects), ['Doing load, not loadgame', 'Current mission number is -2, next is 0', 'Attempting to get player',
    'deleteSaveGameFiles', 'clearStartingNewGame', 'loadMap 00_Training?Name=Player?Class=DeusEx.JCDentonMale']);
  assert.equal(effects.at(-1).travelInfo, 'argument');
});

test('another mission wipes (M 1 -> 2); dx, dxonly and the endgames wipe', () => {
  assert.deepEqual(ops(go('02_NYC_Street', TRAVEL_RELATIVE, { level: level(1), player: { bStartingNewGame: false } })).slice(2),
    ['Attempting to get player', 'deleteSaveGameFiles', 'clearStartingNewGame', 'loadMap 02_NYC_Street?Name=Player?Class=DeusEx.JCDentonMale']);
  // next -1: the player is not looked up, so no flag is cleared (M `2, -1`, `open DX`)
  assert.deepEqual(ops(go('DX', TRAVEL_PARTIAL, { level: level(2) })).slice(1), ['Current mission number is 2, next is -1', 'deleteSaveGameFiles', 'loadMap DX?Name=Player?Class=DeusEx.JCDentonMale']);
  assert.equal(ops(go('99_Endgame1', TRAVEL_RELATIVE, { level: level(15), player: {} })).includes('deleteSaveGameFiles'), true);
});

test('within one mission the level left is filed, then the destination is restored when filed (M 0,0 1,1 2,2)', () => {
  for (const [cur, text] of [[0, '00_TrainingCombat'], [1, '01_NYC_UNATCOHQ'], [2, '02_NYC_Bar']]) {
    const effects = go(text, TRAVEL_RELATIVE, { level: level(cur), player: { bStartingNewGame: false } });
    assert.deepEqual(ops(effects).slice(0, 3), ['Doing load, not loadgame', `Current mission number is ${cur}, next is ${cur}`, 'Attempting to get player']);
    assert.deepEqual(effects.slice(3).map(effect => effect.op), ['pruneTravelActors', 'saveCurrentLevel', 'loadMap']);
    assert.equal(effects[4].position, -2);
    const load = effects.at(-1);
    assert.equal(load.travelInfo, 'argument');
    assert.equal(load.url.map, text);
    // the filed level: FURL(&URL, <SavePath>\Current\<name>.dxs, TRAVEL_Partial), measured `LoadMap: ..\Save\Current\<Map>.dxs?Name=Player?Class=DeusEx.JCDentonMale`
    assert.equal(load.saved.file, `${text}.dxs`);
    assert.equal(String(load.saved.url), `..\\Save\\Current\\${text}.dxs?Name=Player?Class=DeusEx.JCDentonMale`);
  }
  // a `.dx` suffix on the destination (three installed MapExits) is stripped from the file name; the portal is carried to the saved URL
  const portal = browseDecision({ url: Object.assign(parseFurl(last, '01_NYC_UNATCOHQ', TRAVEL_RELATIVE), { portal: 'p' }), lastURL: last, level: level(1), player: {} });
  assert.equal(String(portal.at(-1).saved.url), '..\\Save\\Current\\01_NYC_UNATCOHQ.dxs?Name=Player?Class=DeusEx.JCDentonMale#p');
  const suffixed = browseDecision({ url: new Furl({ map: '01_NYC_UNATCOHQ.dx', op: ['Name=Player'] }), lastURL: last, level: level(1), player: {} });
  assert.equal(suffixed.at(-1).saved.name, '01_NYC_UNATCOHQ');
  // `Map.dx ` (the blank before a `#`): Left(index of the first `.dx`) drops the blank with the extension (appStrstr, case-sensitive: `.DX` would stay)
  const spaced = browseDecision({ url: Object.assign(new Furl({ map: '14_OceanLab_UC.dx ', op: ['Name=Player'] }), { portal: 'UC' }), lastURL: last, level: level(14), player: {} });
  assert.equal(spaced.at(-1).saved.name, '14_OceanLab_UC');
  assert.equal(spaced.at(-1).saved.file, '14_OceanLab_UC.dxs');
  assert.equal(browseDecision({ url: new Furl({ map: '14_OceanLab_UC.DX', op: [] }), lastURL: last, level: level(14), player: {} }).at(-1).saved.name, '14_OceanLab_UC.DX');
});

test('bStartingNewGame (StartNewGame, the menu Training) wipes even within a mission', () => {
  const effects = go('01_NYC_UNATCOIsland', TRAVEL_RELATIVE, { level: level(1), player: { bStartingNewGame: true } });
  assert.deepEqual(ops(effects).slice(-3), ['deleteSaveGameFiles', 'clearStartingNewGame', 'loadMap 01_NYC_UNATCOIsland?Name=Player?Class=DeusEx.JCDentonMale']);
});

test('a loadonly option wipes without looking for the player', () => {
  const url = parseFurl(last, '01_NYC_UNATCOIsland?loadonly', TRAVEL_RELATIVE);
  const effects = browseDecision({ url, lastURL: last, level: level(1), player: { bStartingNewGame: false } });
  assert.deepEqual(ops(effects).slice(1), ['Current mission number is 1, next is 1', 'deleteSaveGameFiles', 'loadMap 01_NYC_UNATCOIsland?Name=Player?Class=DeusEx.JCDentonMale?loadonly']);
});

test('?restart (M): Current emptied, the level reloaded by its MapName with loadonly, no mission lines', () => {
  const lastWithPortal = new Furl({ map: '..\\Save\\Current\\00_Training.dxs', portal: 'p', op: ['Name=Player', 'Class=DeusEx.JCDentonMale'] });
  const url = parseFurl(lastWithPortal.clone(), '?restart', TRAVEL_RELATIVE);
  // measured: `Browse: ..\Save\Current\00_Training.dxs?Name=Player?Class=DeusEx.JCDentonMale?restart` (the portal is the tick's to clear)
  assert.equal(String(Object.assign(url.clone(), { portal: '' })), '..\\Save\\Current\\00_Training.dxs?Name=Player?Class=DeusEx.JCDentonMale?restart');
  const effects = browseDecision({ url, lastURL: lastWithPortal, level: level(0, '00_training'), player: {} });
  assert.deepEqual(ops(effects), ['deleteSaveGameFiles', 'loadMap 00_training?loadonly#p']);
  assert.equal(effects[1].travelInfo, 'level');
  // without a level info the URL is LastURL
  const bare = browseDecision({ url, lastURL: last, level: { info: null, urlMap: 'x' } });
  assert.equal(bare[1].url.map, 'DX');
});

test('loadgame: the measured Browse sequence (LoadGame 77): log lines, Current emptied and refilled from the slot, LoadMap of the slot\'s level (M)', () => {
  const url = parseFurl(last, '?loadgame=77', 0);
  assert.equal(String(url), 'Index.dx?loadgame=77?Name=Player?Class=DeusEx.JCDentonMale');
  const asked = [];
  const effects = browseDecision({ url, lastURL: last, level: level(1), saveInfo: index => { asked.push(index); return { mapName: '01_NYC_UNATCOIsland' }; } });
  assert.deepEqual(asked, [77]);
  // no `Current mission number` line, no player lookup (M)
  assert.deepEqual(ops(effects), ['Doing loadgame, not load', 'Loading: Package saveInfo', 'deleteSaveGameFiles', 'copySaveGameFiles',
    'URL: Adding default option Name=Player', 'URL: Adding default option Class=DeusEx.JCDentonMale',
    'loadMap ..\\Save\\Current\\01_NYC_UNATCOIsland.dxs?load?loadonly?loadgame?Name=Player?Class=DeusEx.JCDentonMale']);
  assert.deepEqual([effects[3].from, effects[3].to], ['Save0077', 'Current']);
  assert.equal(effects.at(-1).travelInfo, 'none');
  assert.deepEqual(effects.at(-1).loadgame, { index: 77, dir: 'Save0077', mapName: '01_NYC_UNATCOIsland', file: '01_NYC_UNATCOIsland.dxs' });
});

test('loadgame: QuickSave is index -1, a slot with no SaveInfo returns without loading, a session with no save directory stops by name', () => {
  const quick = browseDecision({ url: parseFurl(last, '?loadgame=-1', 0), lastURL: last, level: level(0), saveInfo: () => ({ mapName: '00_training' }) });
  assert.equal(quick[3].from, 'QuickSave');
  const missing = browseDecision({ url: parseFurl(last, '?loadgame=5', 0), lastURL: last, level: level(0), saveInfo: () => null });
  assert.deepEqual(missing.map(effect => effect.op), ['log', 'loadGameFailed']);
  const bare = browseDecision({ url: parseFurl(null, 'Index?loadgame=77', 0), lastURL: last, level: level(1) });
  assert.deepEqual(bare.map(effect => effect.op), ['boundary']);
  assert.match(bare[0].name, /loadgame/);
});

test('a LastURL with the load options a loaded game\'s file held (Play\'s old saves): the travel carries `loadgame` into the same-mission branch', () => {
  // GLevel->URL of the loaded level is the file's `04_NYC_UNATCOIsland?load?loadonly?loadgame?Name=...`, LastURL = GLevel->URL; the tick removes `loadonly`
  const poisoned = new Furl({ map: '04_NYC_UNATCOIsland', op: ['load', 'loadgame', 'Name=Player', 'Class=DeusEx.JCDentonMale'] });
  const url = parseFurl(poisoned, '04_NYC_UNATCOHQ#unatcohq', TRAVEL_RELATIVE);
  assert.equal(String(url), '04_NYC_UNATCOHQ?loadgame?Name=Player?Class=DeusEx.JCDentonMale#unatcohq');
  // `loadgame` is not `loadgame=` (GetOption's prefix includes the `=`), nor `loadonly` (HasOption is the whole option): the mission logic, within mission 4
  const effects = browseDecision({ url, lastURL: poisoned, level: level(4, '04_NYC_UNATCOIsland'), player: { bStartingNewGame: false } });
  assert.deepEqual(ops(effects), ['Doing load, not loadgame', 'Current mission number is 4, next is 4', 'Attempting to get player', 'pruneTravelActors', 'saveCurrentLevel',
    'loadMap 04_NYC_UNATCOHQ?loadgame?Name=Player?Class=DeusEx.JCDentonMale#unatcohq']);
  // the filed level's URL is partial: `loadgame` stays
  assert.equal(String(effects.at(-1).saved.url), '..\\Save\\Current\\04_NYC_UNATCOHQ.dxs?loadgame?Name=Player?Class=DeusEx.JCDentonMale#unatcohq');
});

test('network URLs are a named stop, not an approximation', () => {
  const network = browseDecision({ url: new Furl({ host: 'example.org', map: 'DX' }), lastURL: last, level: level(1) });
  assert.match(network[0].reason, /multiplayer/);
  assert.throws(() => browseDecision({ url: 'DX', lastURL: last }), TypeError);
});
