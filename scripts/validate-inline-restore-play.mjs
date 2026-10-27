/** A filed level and a loaded game in Play's inline mode (the simulation on the page: Firefox's default, `?sim=inline` elsewhere; docs/class-graph-design.md
 * migration step 6, docs/travel.md "Play, step 3" and "step 4"). The worker restores them from Save\Current (sim-worker.mjs `load`); inline mode must do
 * the same, not load the map's .dx again.
 *
 * In headless Firefox (default) or Chromium with `?sim=inline` (`--browser chromium`), on the debugging page's first map, 00_Training:
 * 1. The level is changed (the cheat KillAll LightSwitch: LightSwitch0 goes), then `LocalTravel 00_TrainingCombat` files it in Save\Current and
 *    `LocalTravel 00_Training` comes back. The arrival restores 00_Training.dxs: LightSwitch0 is still gone (a load of the .dx would place it again).
 * 2. Once no DataLink plays, QuickSave files the level in the QuickSave slot; a decoration class is killed; `LoadGame -1` (DeusExPlayer.LoadGame:
 *    ClientTravel "?loadgame=-1") loads the slot. The page reads the slot's files from its storage and the level is restored from them: the class's
 *    actors are back, as many as at the save, and LightSwitch0, destroyed before the save, is still gone.
 * No page error or Play stop on the way.
 *
 *   node scripts/validate-inline-restore-play.mjs [--browser firefox|chromium] [--sim inline|worker]   (`--sim worker`: the same checks on the worker's restore) */
import assert from 'node:assert/strict';
import { chromium, firefox } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const NAME = 'validate-inline-restore-play';
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const engine = option('browser', 'firefox'), simMode = option('sim', 'inline');
if (engine !== 'firefox' && engine !== 'chromium') throw new Error('--browser must be firefox or chromium');
if (simMode !== 'inline' && simMode !== 'worker') throw new Error('--sim must be inline or worker');
try { gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }
const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = engine === 'firefox' ? await firefox.launch() : await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
const notes = [];
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const target = new URL(debugUrl(`${url}/`));
  // Firefox's page runs the simulation inline by default; `--sim worker` checks the worker's restore through the same page path
  if (engine === 'chromium' || simMode === 'worker') target.searchParams.set('sim', simMode);
  await page.goto(target.href);
  // a level restored from a file or a loaded game is named by the filed package's spelling (`00_training`)
  const ready = map => page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && (!map || s.map?.toLowerCase() === map.toLowerCase()); },
    map, { timeout: 300000, polling: 100 });
  const status = () => page.evaluate(() => { const s = window.deusExViewer.status(); return { map: s.map, sim: s.sim, runtimeError: s.runtimeError?.message ?? null }; });
  const exec = lines => page.evaluate(lines => window.deusExViewer.viewProbe({ exec: lines }), lines);
  const live = args => page.evaluate(args => window.deusExViewer.liveProbe(args), args);
  const actorsOf = async cls => (await live({ actors: cls })).actors.map(row => row.name);
  const settle = ms => page.waitForTimeout(ms);
  const noStop = async label => { const s = await status(); assert.equal(s.runtimeError, null, `${label}: Play stopped: ${s.runtimeError}`); };

  await ready('00_Training');
  const first = await status();
  assert.equal(first.sim, simMode, `the page runs the simulation ${first.sim}, not ${simMode}`);
  await settle(1500);
  await exec(['set DeusEx.JCDentonMale bCheatsEnabled True']);

  // 1. A filed level, restored by travel
  assert.ok((await actorsOf('deusex.lightswitch')).includes('LightSwitch0'), 'Training holds LightSwitch0 at the start');
  await exec(['KillAll LightSwitch']);
  await settle(500);
  assert.deepEqual(await actorsOf('deusex.lightswitch'), [], 'KillAll LightSwitch leaves no light switch');
  await exec(['LocalTravel 00_TrainingCombat']);
  await ready('00_TrainingCombat');
  await noStop('00_TrainingCombat');
  await settle(1500);
  await exec(['LocalTravel 00_Training']);
  await ready('00_Training');
  await noStop('00_Training, restored');
  await settle(1000);
  assert.deepEqual(await actorsOf('deusex.lightswitch'), [], 'the restored Training still has no LightSwitch0 (a load of the .dx would place it)');
  notes.push('travel: LightSwitch0 stays destroyed in the restored 00_Training');

  // 2. A loaded game: QuickSave, a change, LoadGame -1
  await page.waitForFunction(async () => { const out = await window.deusExViewer.liveProbe({ read: { names: ['@player'], props: ['dataLinkPlay'] } });
    return out.read['@player']?.dataLinkPlay == null; }, null, { timeout: 180000, polling: 1000 });
  const decorations = (await live({ actors: 'engine.decoration' })).actors.map(row => row.cls).filter(Boolean);
  const counts = new Map();
  for (const cls of decorations) counts.set(cls, (counts.get(cls) ?? 0) + 1);
  const [victim, before] = [...counts].filter(([cls]) => cls !== 'deusex.lightswitch').sort((a, b) => b[1] - a[1])[0] ?? [];
  assert.ok(victim && before > 0, 'a decoration class to change');
  await exec(['QuickSave']);
  await settle(3000);
  await noStop('QuickSave');
  await exec([`KillAll ${victim.split('.').pop()}`]);
  await settle(500);
  assert.equal((await actorsOf(victim)).length, 0, `KillAll ${victim} leaves none`);
  const saves = await page.evaluate(() => window.deusExViewer.saves?.() ?? null).catch(() => null);
  await exec(['LoadGame -1']);
  await page.waitForFunction(() => { const s = window.deusExViewer.status(); return s.ready && s.map?.toLowerCase() === '00_training' && document.getElementById('gate').hidden; },
    null, { timeout: 120000, polling: 100 }).catch(async error => {
    const view = await page.evaluate(() => ({ status: window.deusExViewer.status(), gate: document.getElementById('gate')?.hidden, message: document.getElementById('gate-message')?.textContent,
      toast: document.getElementById('toast')?.textContent }));
    throw new Error(`the loaded game did not arrive: ${JSON.stringify({ ...view, status: { map: view.status.map, ready: view.status.ready, runtimeError: view.status.runtimeError?.message ?? null } })}; saves ${JSON.stringify(saves)?.slice(0, 300)}; page errors ${errors.join(' | ')}`);
  });
  await settle(1500);
  await noStop('the loaded game');
  const after = (await actorsOf(victim)).length;
  assert.equal(after, before, `${victim}: ${after} after the loaded game, ${before} at the save`);
  // the change made before the save stays: the level came from the slot, not from the map's .dx
  assert.deepEqual(await actorsOf('deusex.lightswitch'), [], 'the loaded game has no LightSwitch0 (the save had none; a load of the .dx would place it)');
  notes.push(`loaded game: ${victim} ${before} at the save, 0 after KillAll, ${after} after LoadGame -1; LightSwitch0 stays destroyed`);
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
} finally {
  await browser.close();
  await server.close();
}
for (const note of notes) console.log(`  ${note}`);
console.log(`PASS ${NAME}: in ${engine}'s ${simMode} mode a level travel left is restored from Save\\Current and a loaded game from its slot's files`);
process.exit(0);
