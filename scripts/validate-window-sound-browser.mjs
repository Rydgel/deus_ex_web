// Window.PlaySound reaching Galaxy in the browser, default worker mode
// (docs/script-window-sound.md "Play").
//
// Real keyboard input on the page: F2 opens the Goals screen, Alt+N presses
// "Add Note", Tab saves it (the interface sounds the original scripts play
// through Window.PlaySound, native 1473). The simulation worker's window
// probe (src/viewer/window-probe.mjs) reads the recorded window requests and
// Galaxy's channels; the music status shows the voice operations that reach
// the worklet's library. Nothing crosses the page for the sound itself.
//
//   node scripts/validate-window-sound-browser.mjs [--url http://...] [--query sim=inline] [--explore]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-window-sound-browser: no installed game data'); process.exit(0); }
let server = null, url = option('url', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`, '--autoplay-policy=no-user-gesture-required']});
let report;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(debugUrl(`${url}/${option('query', '') ? `?${option('query', '')}` : ''}`));
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === '00_Training'; }, {}, {timeout: 240000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const probe = () => page.evaluate(() => window.deusExViewer.windowProbe());
  const music = () => page.evaluate(() => window.deusExViewer.musicStatus());
  const settled = async () => { await frames(6); await page.evaluate(() => window.deusExViewer.settled()); };
  await frames(30);
  await page.mouse.click(512, 320);
  await settled();
  const sim = (await page.evaluate(() => window.deusExViewer.status())).sim;
  const first = await probe();
  const explore = process.argv.includes('--explore');
  assert.equal(first.galaxy.galaxyVoices, true, 'effects play through Galaxy\'s own voices (the worklet library)');
  assert.deepEqual(first.sounds, [], 'no window sound before any input');
  assert.ok(first.slotModel?.count >= 42167 && /00_Training/.test(first.slotModel.source), `the worker seeded the registry slot model from Training's capture: ${JSON.stringify(first.slotModel)}`);
  const libraryBefore = (await music()).library;
  await page.keyboard.press('F2'); await settled();
  const goals = await probe();
  assert.equal(goals.top, 'deusex.personascreengoals', 'F2 opens the Goals screen');
  const names = list => list.map(request => request.sound.replace(/^deusexsounds\.userinterface\./, ''));
  assert.deepEqual(names(goals.sounds), ['menu_activate', 'menu_focus'], 'the Goals screen plays its original window sounds');
  assert.ok(goals.sounds.every(request => request.played === true), 'Galaxy took every request');
  // Galaxy's own channels hold them: no actor, a slot-0 counter id, radius 100.
  const channels = goals.galaxy.channels;
  assert.deepEqual(channels.map(c => c.id).sort((a, b) => a - b), [-32, -16], 'counter ids -1<<4 and -2<<4');
  assert.ok(channels.every(c => c.radius === 100 && (c.id & 0xe) === 0 && c.voice), 'radius 100, slot 0, a Galaxy voice each');
  assert.ok(goals.sounds.every(request => Math.abs(request.volume - Math.fround(.25 * 100 / 99)) < 1e-6), 'volume .25 scaled by 100/99');
  assert.ok(goals.sounds.some(request => request.pan !== 0), 'the pointer position pans the sound');
  const libraryAfter = (await music()).library;
  assert.ok(libraryAfter.voiceOps > libraryBefore.voiceOps, `voice operations reached the worklet's library: ${libraryBefore.voiceOps} -> ${libraryAfter.voiceOps}`);
  assert.ok(libraryAfter.samples > libraryBefore.samples, `the UI samples were registered: ${libraryBefore.samples} -> ${libraryAfter.samples}`);
  await page.keyboard.down('Alt'); await page.keyboard.press('n'); await page.keyboard.up('Alt'); await settled();
  const added = await probe();
  assert.deepEqual(names(added.sounds.slice(goals.sounds.length)), ['menu_press'], 'Add Note plays Menu_Press');
  assert.equal(added.galaxy.counter, -3, 'the counter follows the third sound');
  await page.keyboard.press('Tab'); await settled();
  const saved = await probe();
  assert.equal(saved.sounds.length, added.sounds.length + 1, 'the save moved the focus with a sound');
  if (explore) console.log(JSON.stringify(saved.sounds));
  const status = await page.evaluate(() => window.deusExViewer.status());
  assert.equal(status.runtimeError, null, `no runtime error: ${status.runtimeError?.message}`);
  assert.deepEqual(errors, [], 'no page errors');
  // The windows the Goals screen made took slots of the model, and gave them back as the screen closed or stayed.
  assert.ok(saved.slotModel.allocated > first.slotModel.allocated, `windows and graphics contexts take model slots: ${first.slotModel.allocated} -> ${saved.slotModel.allocated}`);
  assert.equal(saved.slotModel.rejected, 0, 'every slot the model was given back was one it had handed out');
  report = {sim, sounds: names(saved.sounds), channels, voiceOps: [libraryBefore.voiceOps, libraryAfter.voiceOps], samples: [libraryBefore.samples, libraryAfter.samples]};
} finally {
  await browser.close();
  await server?.close();
}
console.log(`window-sound-browser: ${JSON.stringify(report)}`);
