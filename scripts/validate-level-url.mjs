/** The level's URL (GLevel->URL) and the engine's LastURL across loads, saves and travels (docs/travel.md "FURL and the level's URL").
 *
 * The original's rules (Engine.dll, DeusEx.dll): UGameEngine::LoadMap sets `GLevel->URL = URL` only when the URL has no option that starts with `load`
 * (0x1038ce8b..0x1038ceed), so a loaded game (`?load?loadonly?loadgame`) keeps the URL its `.dxs` holds and a restart (`?loadonly`) the map file's
 * `Index.dx`; LoadMap's tail sets `LastURL = URL` (0x1038e059..0x1038e318) and Browse's loaded-game and filed-level branches `LastURL = GLevel->URL`
 * (0x1001138b, 0x10011c84); a relative FURL copies the base's options but PUSH, POP, PEER and LOAD (0x103f7d22..0x103f7fbc) and adds no player option
 * (only TRAVEL_Absolute does, 0x103f8900). ULevel::Serialize writes GLevel->URL into every saved level.
 *
 * Part A (the installed game): DX, `LocalTravel 00_Training`, `SaveGame 7` (the file's URL is the travel's: `00_Training`, Name=/Class=, as the original's own
 * `Save0001/00_training.dxs` holds), `LoadGame 7` (the loaded level's URL is the file's, not the LoadMap path with its load options), `SaveGame 8` (the same URL
 * again: Play's saves made in a loaded level used to store `load`, `loadonly`, `loadgame`), `LocalTravel 00_TrainingCombat` (`Browse:` with Name=/Class= only),
 * then, in the arrived Combat, `RestartLevel`: `LoadMap: 00_TrainingCombat?loadonly`, the restarted level's URL `Index.dx` (measured in the restart capture,
 * from Training), a `SaveGame 9` that stores it, and `LocalTravel 04_NYC_UNATCOIsland.dx`, whose lines the travel capture measured: `Browse: 04_NYC_UNATCOIsland.dx`,
 * `LoadMap: 04_NYC_UNATCOIsland.dx` (s4/f2-space-portal.log 802, 807: no Name=/Class=, LastURL was the restart's `00_training?loadonly`).
 *
 * Part B (always): the state such a load leaves, LastURL = the file's URL with `load`, `loadonly`, `loadgame` (the session's LastURL in Training), then
 * `LocalTravel 00_TrainingCombat`: the tick removes `loadonly`, the relative FURL drops `load` and keeps `loadgame` (`Browse: 00_TrainingCombat?loadgame?Name=Player?
 * Class=DeusEx.JCDentonMale`), the arrival keeps its map file's URL `Index.dx`, Login gets `?loadgame` (DeusExGameInfo.Login skips ResetPlayerToDefaults) and a
 * `SaveGame 10` there stores `Index.dx`.
 *
 * Part C (the census base `.work/chains/exits/census/c04-island-hq-line/Save0218`, one of Play's old saves whose Island URL holds `load`, `loadonly`, `loadgame`;
 * skipped when it is absent or holds no load option): `LoadGame 218`, then Teleporter1's travel (`04_NYC_UNATCOHQ#unatcohq`, the ClientTravel(URL,
 * TRAVEL_Relative, true) that SendPlayer and `LocalTravel` make): `Browse: 04_NYC_UNATCOHQ?loadgame?Name=Player?Class=DeusEx.JCDentonMale#unatcohq` and the
 * HQ's URL.Map `Index.dx`, the original's from the same base (.work/chains/mc04-island-hq-line `e2-hq`, measured on the Mac and the Linux host). `--no-census`
 * skips it.
 *
 *   node scripts/validate-level-url.mjs [--no-census] */
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { loadAssets, typeLine } from './chain-play.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';
import { parsePackage } from '../src/unreal/package.mjs';
import { readLevel } from '../src/unreal/model.mjs';

try { gameDirectory(); } catch { console.log('SKIP validate-level-url: no installed game data'); process.exit(0); }
const census = new URL('../.work/chains/exits/census/c04-island-hq-line/Save0218/', import.meta.url).pathname;
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
const assets = await loadAssets();
const directory = createSaveDirectory();
let session = null, c = null;
const open = async (map, options) => {
  session?.dispose(); session = null; c = null;
  for (let i = 0; i < 2; i++) await new Promise(resolve => setImmediate(resolve));
  session = await openSession(map, assets, { saveDirectory: directory, ...options });
  c = session.c;
};
const frames = (n, label) => {
  for (let i = 0; i < n; i++) { c.frames(1); const request = c.takeTravel(); if (request) return request; }
  throw new Error(`${label}: no travel request after ${n} frames`);
};
const arrive = async request => open(request.map, { travel: { snapshotSource: () => null, arrival: request, lastURL: request.lastURL } });
const log = () => c.game.doors.scriptRuntime.engineLog;
const lastLine = prefix => log().findLast(line => line.startsWith(prefix)) ?? null;
const text = url => `${url.protocol}://${url.host}${url.map}${url.op.map(option => `?${option}`).join('')}${url.portal ? `#${url.portal}` : ''}:${url.port}`;
/** The URL a slot's level file holds (readLevel: ULevel::Serialize's URL). */
const savedUrl = slot => {
  // the slot holds every level filed in Current; the saved game's own is the one its SaveInfo names (DeusExSaveInfo.MapName)
  const mapName = String(directory.info(slot)?.properties?.MapName ?? '').toLowerCase();
  const file = directory.files(slot).find(entry => entry.name.toLowerCase() === `${mapName}.dxs`);
  if (!file) return null;
  const bytes = directory.readFile(slot, file.name), pkg = parsePackage(bytes);
  const { url, urlValid } = readLevel(pkg, bytes, pkg.exports.findIndex(entry => entry.className === 'Level') + 1);
  return { protocol: url.protocol, host: url.host, port: url.port, map: url.map, portal: url.portal, op: url.options, valid: urlValid };
};
const save = (index, label) => {
  c.game.hud.scoped(() => c.game.hud.host.consoleCommands.consoleCommand(c.player(), `SaveGame ${index}`));
  c.frames(5);
  const url = savedUrl(`Save${String(index).padStart(4, '0')}`);
  check(url, `${label}: SaveGame ${index} wrote no level`);
  return url;
};
const PLAYER = ['Name=Player', 'Class=DeusEx.JCDentonMale'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameUrl = (a, b) => same([a.protocol, a.host, a.port, a.map, a.portal, a.op, a.valid], [b.protocol, b.host, b.port, b.map, b.portal, b.op, b.valid]);

// Part A
await open('DX', { travel: { snapshotSource: () => null } });
c.frames(60);
typeLine(c, 'LocalTravel 00_Training');
const toTraining = frames(10, 'LocalTravel 00_Training');
check(same(toTraining.loadUrl?.op, PLAYER) && same(toTraining.lastURL, toTraining.loadUrl), `A1: the travel's LoadMap URL ${JSON.stringify(toTraining.loadUrl)} is LastURL after the load (${JSON.stringify(toTraining.lastURL)})`);
await arrive(toTraining);
console.log('A1 00_Training by travel:', text(c.game.levelUrl));
check(c.game.levelUrl.map === '00_Training' && same(c.game.levelUrl.op, PLAYER), `A1: the travelled level's URL ${text(c.game.levelUrl)}`);
c.frames(120);
const saved7 = save(7, 'A2');
console.log('A2 Save0007 level URL:', saved7 && text(saved7));
check(saved7 && saved7.protocol === 'deusex' && saved7.host === '' && saved7.map === '00_Training' && saved7.portal === '' && same(saved7.op, PLAYER) && saved7.port === 7790 && saved7.valid === 1,
  `A2: SaveGame 7 stored ${saved7 && text(saved7)} (the original's own Training save: deusex://00_Training?Name=Player?Class=DeusEx.JCDentonMale:7790)`);

c.exec('LoadGame 7');
const load7 = frames(10, 'LoadGame 7');
check(same(load7.options, ['load', 'loadonly', 'loadgame', ...PLAYER]), `A3: LoadGame 7's LoadMap options ${load7.options}`);
check(lastLine('Log: URL: Adding default option') !== null, 'A3: the absolute FURLs logged `URL: Adding default option`');
await arrive(load7);
console.log('A3 loaded game:', text(c.game.levelUrl));
check(saved7 && sameUrl(c.game.levelUrl, saved7), `A3: the loaded level's URL ${text(c.game.levelUrl)} is the file's ${saved7 && text(saved7)} (LoadMap keeps it for the load options)`);
c.frames(120);
const saved8 = save(8, 'A4');
console.log('A4 Save0008 level URL:', saved8 && text(saved8));
check(saved8 && saved7 && sameUrl(saved8, saved7), `A4: SaveGame 8 in the loaded level stored ${saved8 && text(saved8)}, not the URL it was loaded from (${saved7 && text(saved7)})`);

typeLine(c, 'LocalTravel 00_TrainingCombat');
const toCombat = frames(10, 'LocalTravel 00_TrainingCombat');
check(lastLine('Log: Browse:') === 'Log: Browse: 00_TrainingCombat?Name=Player?Class=DeusEx.JCDentonMale', `A5: ${lastLine('Log: Browse:')}`);
check(same(toCombat.options, PLAYER), `A5: the travel from the loaded level carries ${toCombat.options}`);

await arrive(toCombat);
console.log('A5 00_TrainingCombat by travel:', text(c.game.levelUrl));
check(c.game.levelUrl.map === '00_TrainingCombat' && same(c.game.levelUrl.op, PLAYER), `A5: the travelled level's URL ${text(c.game.levelUrl)}`);
c.frames(120);

c.exec('RestartLevel');
const restart = frames(10, 'RestartLevel');
check(/^00_trainingcombat\?loadonly$/i.test(restart.url) && same(restart.options, ['loadonly']), `A6: the restart loads ${restart.url}`);
await arrive(restart);
console.log('A6 restarted level:', text(c.game.levelUrl));
check(c.game.levelUrl.map === 'Index.dx' && c.game.levelUrl.op.length === 0 && c.game.levelUrl.protocol === 'deusex' && c.game.levelUrl.port === 7790,
  `A6: the restarted level's URL ${text(c.game.levelUrl)} (measured: Index.dx, the map file's)`);
c.frames(120);
const saved9 = save(9, 'A6');
console.log('A6 Save0009 level URL:', saved9 && text(saved9));
check(saved9 && saved9.map === 'Index.dx' && saved9.op.length === 0, `A6: SaveGame 9 in the restarted level stored ${saved9 && text(saved9)}`);
typeLine(c, 'LocalTravel 04_NYC_UNATCOIsland.dx');
const toIsland = frames(10, 'LocalTravel 04_NYC_UNATCOIsland.dx');
check(lastLine('Log: Browse:') === 'Log: Browse: 04_NYC_UNATCOIsland.dx', `A7: ${lastLine('Log: Browse:')} (measured: Log: Browse: 04_NYC_UNATCOIsland.dx)`);
check(lastLine('Log: LoadMap:') === 'Log: LoadMap: 04_NYC_UNATCOIsland.dx' && toIsland.options.length === 0, `A7: ${lastLine('Log: LoadMap:')} (measured: Log: LoadMap: 04_NYC_UNATCOIsland.dx)`);
session?.dispose(); session = null;

// Part B: the state a loaded old save leaves (LastURL = GLevel->URL = the file's, with `load`, `loadonly`, `loadgame`), set as the session's LastURL
await open('00_Training', { travel: { snapshotSource: () => null, lastURL: { map: '00_Training', op: ['load', 'loadonly', 'loadgame', ...PLAYER] } } });
c.frames(120);
typeLine(c, 'LocalTravel 00_TrainingCombat');
const poisoned = frames(10, 'LocalTravel 00_TrainingCombat (load options in LastURL)');
check(lastLine('Log: Browse:') === 'Log: Browse: 00_TrainingCombat?loadgame?Name=Player?Class=DeusEx.JCDentonMale', `B1: ${lastLine('Log: Browse:')}`);
check(same(poisoned.options, ['loadgame', ...PLAYER]) && !poisoned.loadgame, `B1: the request carries ${poisoned.options} and is ${poisoned.loadgame ? 'a loaded game' : 'a travel'}`);
await arrive(poisoned);
console.log('B2 arrival with loadgame:', text(c.game.levelUrl));
check(c.game.levelUrl.map === 'Index.dx' && c.game.levelUrl.op.length === 0, `B2: the arrival's URL ${text(c.game.levelUrl)} (LoadMap keeps the map file's Index.dx)`);
check(/\?loadgame(\?|$)/i.test(c.game.doors.scriptRuntime.arrival?.optionsText ?? ''), `B2: Login's options ${c.game.doors.scriptRuntime.arrival?.optionsText}`);
c.frames(120);
const saved10 = save(10, 'B3');
console.log('B3 Save0010 level URL:', saved10 && text(saved10));
check(saved10 && saved10.map === 'Index.dx' && saved10.op.length === 0, `B3: SaveGame 10 stored ${saved10 && text(saved10)}`);
session?.dispose(); session = null;

// Part C: the census base itself (Play's old save; skipped when it is absent, or clean once the bases are made again)
const censusIsland = existsSync(census) ? (await readdir(census)).find(name => /^04_NYC_UNATCOIsland\.dxs$/i.test(name)) : null;
const censusUrl = censusIsland ? (() => { const bytes = new Uint8Array(readFileSync(`${census}${censusIsland}`)), pkg = parsePackage(bytes);
  return readLevel(pkg, bytes, pkg.exports.findIndex(entry => entry.className === 'Level') + 1).url; })() : null;
if (process.argv.includes('--no-census') || !censusUrl || !censusUrl.options.some(option => /^load/i.test(option)))
  console.log(`C skipped: ${process.argv.includes('--no-census') ? '--no-census' : !censusUrl ? `no ${census}` : 'the census base holds no load option'}`);
else {
  const files = [];
  for (const name of await readdir(census)) files.push({ name, bytes: new Uint8Array(await readFile(`${census}${name}`)) });
  const info = files.find(file => /^saveinfo\.dxs$/i.test(file.name));
  directory.put({ directory: 'Save0218', files, info: info ? parseSaveInfo(info.bytes) : null });
  await open('DX', { travel: { snapshotSource: () => null } });
  c.frames(60);
  c.exec('LoadGame 218');
  const load = frames(10, 'LoadGame 218');
  await arrive(load);
  const island = c.game.levelUrl;
  console.log('C1 loaded census base:', text(island));
  check(island.map === '04_NYC_UNATCOIsland' && same(island.op, ['load', 'loadonly', 'loadgame', ...PLAYER]), `C1: the base's Island URL ${text(island)} (the file's, with Play's old load options)`);
  c.frames(180);
  typeLine(c, 'LocalTravel 04_NYC_UNATCOHQ#unatcohq');
  const toHq = frames(10, 'LocalTravel 04_NYC_UNATCOHQ#unatcohq');
  check(lastLine('Log: Browse:') === 'Log: Browse: 04_NYC_UNATCOHQ?loadgame?Name=Player?Class=DeusEx.JCDentonMale#unatcohq', `C2: ${lastLine('Log: Browse:')}`);
  check(same(toHq.options, ['loadgame', ...PLAYER]) && !toHq.restore, `C2: the HQ request carries ${toHq.options}${toHq.restore ? ' (restored)' : ''}`);
  await arrive(toHq);
  console.log('C3 HQ arrival:', text(c.game.levelUrl));
  check(c.game.levelUrl.map === 'Index.dx' && c.game.levelUrl.op.length === 0, `C3: the HQ's URL ${text(c.game.levelUrl)} (the original's from the same base: Index.dx)`);
  // DeusExGameInfo.Login(Portal, Options): `!HasOption(Options, "Loadgame")` is false, so ResetPlayerToDefaults and the dump location are skipped
  check(/\?loadgame(\?|$)/i.test(c.game.doors.scriptRuntime.arrival?.optionsText ?? ''), `C3: Login's options ${c.game.doors.scriptRuntime.arrival?.optionsText}`);
  session?.dispose(); session = null;
}

if (failures.length) { console.log(`FAIL validate-level-url:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('PASS validate-level-url: the level URL follows LoadMap\'s load-option rule through saves, loads, a restart and travels; LastURL is LoadMap\'s and Browse\'s');
