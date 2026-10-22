/** Every real desktop save slot through Play's `?loadgame=N` path (docs/travel.md "Play, step 4"), headless, one process per slot.
 *
 * The slots are third-party files kept outside Git (the main checkout's `.work/internet-saves`, SOURCES.md there): 39 slots of one 2002-03 playthrough from
 * Liberty Island to Area 51 Page (nicouzouf) and two GOTY 1.112fm slots with modded weapons and augmentations (retromaggedon). They are untrusted data: this
 * only parses them (packages, tagged properties), nothing in them is executed. Per slot: the slot is the only one in the save directory; Play opens the logo
 * map, Escape opens MenuMain, its Load Game button opens the original's screen, which lists the slot (the row, its info text); the Load button runs
 * `LoadGame N` -> `ClientTravel("?loadgame=N")`; Browse takes the loadgame branch (Current emptied, the slot's files copied in); a new session restores
 * the slot's level with the saved player (no begin-play pass, no travel text) and ticks for two seconds. What stops is reported by name:
 * the stage reached and the first line of the error. A class, native or property kind Play does not support yet is an explicit boundary, never a substitute.
 *
 *   node scripts/validate-load-saves.mjs [--source nicouzouf|retromaggedon] [--slot <path to a Save directory>] [--list]
 *
 * Without --slot it walks the slots (one child process each, `--timeout` seconds apiece) and writes `.work/load-saves.json`. */
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const BASE = process.env.DX_INTERNET_SAVES ?? '/home/rydgel/projects/deus_ex_web/.work/internet-saves';
const SOURCES = { nicouzouf: path.join(BASE, 'nicouzouf/files/Deus Ex'), retromaggedon: path.join(BASE, 'retromaggedon/files') };
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-load-saves: no installed game data'); process.exit(0); }
if (!existsSync(BASE)) { console.log('SKIP validate-load-saves: the internet save slots are not in .work/internet-saves (outside Git)'); process.exit(0); }

async function slotsOf(source) {
  const found = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (/^Save\d+$/.test(entry.name)) found.push(full); else await walk(full); }
    }
  };
  await walk(SOURCES[source]);
  return found.sort();
}

if (!process.argv.includes('--slot')) {
  const wanted = option('source', null) ? [option('source')] : Object.keys(SOURCES);
  const timeout = Number(option('timeout', 600)) * 1000;
  const report = [];
  for (const source of wanted) for (const slot of await slotsOf(source)) {
    const started = process.hrtime.bigint();
    const run = spawnSync(process.execPath, ['--max-old-space-size=7168', new URL(import.meta.url).pathname, '--slot', slot], { encoding: 'utf8', timeout, maxBuffer: 1 << 26 });
    const last = (run.stdout ?? '').trim().split('\n').filter(line => line.startsWith('{')).at(-1);
    let result;
    try { result = JSON.parse(last); } catch { result = { slot: path.basename(slot), stage: 'process', ok: false, error: run.error ? String(run.error.message) : `exit ${run.status}: ${(run.stderr ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)}` }; }
    Object.assign(result, { source, seconds: Math.round(Number(process.hrtime.bigint() - started) / 1e9) });
    report.push(result);
    console.log(`${result.ok ? 'PASS' : 'STOP'} ${source}/${path.basename(slot)} ${result.map ?? ''} [${result.stage}] ${result.ok ? `${result.seconds}s` : result.error}`);
    await writeFile(new URL('../.work/load-saves.json', import.meta.url), JSON.stringify(report, null, 1));
  }
  const failed = report.filter(item => !item.ok);
  console.log(`${report.length - failed.length} of ${report.length} slots load; ${failed.length} stop by name`);
  process.exit(0);
}

// ---- one slot ----------------------------------------------------------------------------------------------------------------------------
const slot = option('slot');
const result = { slot: path.basename(slot), stage: 'start', ok: false };
const done = () => { console.log(JSON.stringify(result)); process.exit(result.ok ? 0 : 1); };
try {
  const { AssetStore } = await import('../src/unreal/assets.mjs');
  const { openSession } = await import('./census-stage5-session.mjs');
  const { createSaveDirectory } = await import('../src/runtime/save-directory.mjs');
  const { parseSaveInfo } = await import('../src/runtime/save-info.mjs');
  const { createMenuDriver } = await import('../src/viewer/menu-driver.mjs');
  const files = [];
  for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
    for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
  const assets = new AssetStore(files);
  const index = Number(/Save(\d+)$/.exec(slot)[1]);
  const entries = [];
  for (const name of await readdir(slot)) entries.push({ name, bytes: new Uint8Array(await readFile(path.join(slot, name))) });
  const infoBytes = entries.find(entry => entry.name === 'SaveInfo.dxs')?.bytes;
  const info = parseSaveInfo(infoBytes);
  result.map = info.properties.MapName; result.location = info.properties.MissionLocation;
  const directory = createSaveDirectory({ saves: [{ directory: `Save${String(index).padStart(4, '0')}`, files: entries, info }] });

  // 1. the original's screen lists the slot
  result.stage = 'screen';
  const { c } = await openSession('DX', assets, { travel: {}, saveDirectory: directory });
  c.frames(60);
  const driver = createMenuDriver(c.game);
  c.key('Escape'); c.frames(20);
  if (driver.top() !== 'deusex.menumain') throw new Error(`Escape opened ${driver.top()}, not MenuMain`);
  driver.invoke('MenuScreenLoadGame'); c.frames(10);
  const rows = driver.listRows('lstGames');
  if (rows.rows.length !== 1) throw new Error(`the Load Game screen lists ${rows.rows.length} rows for one slot`);
  result.row = rows.rows[0].slice(0, 2);
  if (Number(rows.rows[0][3]) !== index) throw new Error(`the row's save index is ${rows.rows[0][3]}, not ${index}`);

  // 2. Load: LoadGame -> ClientTravel("?loadgame=N") -> the tick's Browse
  result.stage = 'browse';
  c.game.hud.scoped(() => driver.pressActionKey('LOAD')); c.frames(4);
  const request = c.takeTravel();
  if (!request) throw new Error('the Load button made no request for the next level');
  if (!request.restore) throw new Error(`Browse made no restore request: ${request.url}`);
  const current = directory.files('Current').map(file => file.name).sort();
  result.current = current;

  // 3. the new session restores the slot's level with the saved player
  result.stage = 'restore';
  const { c: d } = await openSession(request.map, assets, { travel: { arrival: request, lastURL: request.lastURL }, saveDirectory: directory });
  const log = d.game.doors.scriptRuntime.engineLog;
  if (log.some(line => /^Log: (Game class is|Bringing Level)|InitGame|Base Mutator/.test(line))) throw new Error('the loaded level ran a begin-play pass');
  const pawns = d.actors().filter(a => d.isA(a, 'engine.playerpawn')).length;
  if (pawns !== 1) throw new Error(`${pawns} player pawns in the loaded level`);
  const p = d.player();
  result.player = { location: d.pos(p).map(v => Math.round(v)), health: d.read(p, 'Health'), name: p.name };
  result.flags = [...(d.read(p, 'FlagBase')?.entries?.keys() ?? [])].length;
  result.inventory = [];
  for (let item = d.read(p, 'Inventory'); item && result.inventory.length < 200; item = d.read(item, 'Inventory')) result.inventory.push(d.runtime.instance(item).cls.record.name);
  result.actors = d.actors().length;

  // 4. two seconds of the loaded level
  result.stage = 'tick';
  d.frames(120);
  result.stage = 'ticked';
  // 5. a slot that carries other levels of its mission (the visited maps the original filed in Save\\Current): the loaded player leaves for one of them
  // (PruneTravelActors, SaveCurrentLevel(-2) of the loaded level, the filed level restored from the original's file, the travel text imported)
  const others = current.filter(name => name !== 'SaveInfo.dxs' && name.toLowerCase() !== request.restore.file.toLowerCase());
  if (others.length) {
    result.stage = 'travel';
    const stem = others[0].replace(/\.dxs$/i, '');
    d.exec(`LocalTravel ${stem}`); d.frames(2);
    const leave = d.takeTravel();
    if (!leave) throw new Error(`LocalTravel ${stem} made no request`);
    if (!leave.restore) throw new Error(`LocalTravel ${stem} did not restore the filed level: ${leave.url}`);
    const { c: e } = await openSession(leave.map, assets, { travel: { arrival: leave, lastURL: leave.lastURL }, saveDirectory: directory });
    e.frames(120);
    result.travelled = stem;
    result.stage = 'travelled';
  }
  result.ok = true;
} catch (error) {
  result.error = String(error?.message ?? error).split('\n')[0].slice(0, 400);
  result.where = String(error?.stack ?? '').split('\n').slice(1, 14).map(line => line.trim().replace(/^at /, '').replace(/\(?file:\/\/.*\/(src\/[^)]*|scripts\/[^)]*)\)?/, '$1'));
}
done();
