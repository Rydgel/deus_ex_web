// Batch GObjObjects captures of the running original (docs/object-index-captures.md):
// for each map, a fresh DeusEx.exe on 00_Training.dx opens the map from the
// console (`open <map>`), waits, and tools/dump-gobjects-win.exe dumps the
// registry to .cache/original-gobjects-<date>-<map>-open.txt; the game then
// quits. Each map gets its own process, so every capture is the same
// convention as the Island one (Training, then `open`), whatever the order.
//
//   node scripts/capture-object-indices.mjs [--maps a,b] [--wait ms] [--date yyyymmdd] [--force]
//
// The game runs through ad/scripts/original-game.mjs, so DX_WINE, DX_GAME and
// (plain Wine) WINEPREFIX select the installation; tools/dump-gobjects-win.exe
// and ad/tools/dxinput.exe must be built. Existing captures are kept unless
// --force.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINE, GAME, SYSTEM, BOTTLE, launch, run, find } from '../ad/scripts/original-game.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const wait = Number(flag('--wait', 30000));
const date = flag('--date', new Date().toISOString().slice(0, 10).replace(/-/g, ''));
const force = argv.includes('--force');
const maps = (flag('--maps', null)?.split(',') ?? readdirSync(path.join(GAME, 'Maps'))
  .filter(name => /\.dx$/i.test(name)).map(name => name.replace(/\.dx$/i, '')).sort());
const env = { ...process.env, CX_BOTTLE: BOTTLE, WINEDEBUG: '-all' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const script = text => {
  const file = path.join(root, '.cache', 'capture-object-indices.txt');
  writeFileSync(file, text);
  return file;
};
// dxinput find exits nonzero while no DeusEx.exe window exists.
const running = () => {
  try { find(); return true; } catch { return false; }
};
const dump = () => execFileSync(WINE, ['C:\\Deus Ex GOTY Edition\\System\\dump-gobjects-win.exe'],
  { env, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 120000 });

if (!existsSync(path.join(SYSTEM, 'dump-gobjects-win.exe'))) throw new Error(`no dump-gobjects-win.exe in ${SYSTEM}`);
mkdirSync(path.join(root, '.cache'), { recursive: true });
const summary = [];
// A wineserver that shuts down between maps restarts cold with the next
// launch, which then boots too late for the console command (every third map
// on the Linux host): keep it running for the batch (`wineserver -k` at the
// end, or after a hung game, ends it).
try { execFileSync('wineserver', ['-p'], { env }); } catch { /* CrossOver manages its own */ }
const gameProcesses = () => {
  try { return execFileSync('pgrep', ['-f', 'DeusEx\\.exe'], { encoding: 'utf8' }).trim().length > 0; } catch { return false; }
};
// One fresh process: launch, open the map after `boot` ms, dump, quit.
async function attempt(map, boot) {
  for (let i = 0; i < 30 && gameProcesses(); i++) await sleep(1000);
  if (gameProcesses()) { execFileSync('wineserver', ['-k'], { env }); await sleep(3000); }
  launch('00_Training.dx');
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(1000); up = running(); }
  if (!up) return { error: 'no game window' };
  // A previous force-kill shows the "Recovery Mode" wizard first.
  try { run(script('button Run Deus Ex\n'), 30000); } catch { /* no wizard */ }
  run(script(`sleep ${boot}\ncmd open ${map}\nsleep ${wait}\n`), boot + wait + 120000);
  const text = dump();
  const header = text.split(/\r?\n/, 1)[0];
  const loaded = text.split(/\r?\n/).some(line => line.toLowerCase().endsWith(` package.${map.toLowerCase()}`));
  try { run(script('cmd exit\n'), 30000); } catch { /* checked below */ }
  let down = false;
  for (let i = 0; i < 30 && !down; i++) { await sleep(1000); down = !running(); }
  if (!down) execFileSync('wineserver', ['-k'], { env });
  await sleep(3000);
  return { text, header, loaded, forced: !down };
}
for (const map of maps) {
  const out = path.join(root, '.cache', `original-gobjects-${date}-${map.toLowerCase()}-open.txt`);
  if (existsSync(out) && !force) { summary.push({ map, skipped: 'exists' }); continue; }
  const began = Date.now();
  // The console opens the map only once Training has loaded; after a forced
  // quit the recovery wizard delays the boot, so a dump without the map's
  // package is retried with a longer wait.
  let result = await attempt(map, 15000), attempts = 1;
  if (!result.error && !result.loaded) { result = await attempt(map, 45000); attempts++; }
  if (result.error) { summary.push({ map, error: result.error }); break; }
  if (result.loaded) writeFileSync(out, result.text);
  summary.push({ map, header: result.header, loaded: result.loaded, forced: result.forced, attempts,
    seconds: Math.round((Date.now() - began) / 1000) });
  console.log(JSON.stringify(summary.at(-1)));
}
try { execFileSync('wineserver', ['-k'], { env }); } catch { /* already gone */ }
console.log(JSON.stringify({ captured: summary.filter(s => s.header).length, notLoaded: summary.filter(s => s.header && !s.loaded).map(s => s.map), errors: summary.filter(s => s.error) }));
