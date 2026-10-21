// Typed characters in the browser, default worker mode
// (docs/script-window-typed-keys.md "Play").
//
// Real keyboard events on the page: each keydown goes to the worker as its
// key ('key') and then as the WM_CHAR units typedCharacters gives for it
// ('char'). On 00_Training, F2 opens the Goals screen, Alt+N presses
// "Add |&Note" through the accelerator table, and the typed "Hi\ é€" lands
// in the new note as "Hi é€" (PersonaNotesEditWindow.FilterChar refuses the
// backslash; 'é' and '€' come as French-layout keydowns, '€' with AltGr). Backspace deletes the
// '€' and Tab saves the note. The worker-side window probe
// (src/viewer/window-probe.mjs) reads the result.
//
//   node scripts/validate-window-typed-key-browser.mjs [--url http://...] [--query sim=inline] [--shot note.png]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-window-typed-key-browser: no installed game data'); process.exit(0); }
let server = null, url = option('url', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  // The tree may itself sit in .work/ or .claude/worktrees/, which the config denies.
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let report;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(debugUrl(`${url}/${option('query', '') ? `?${option('query', '')}` : ''}`));
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === '00_Training'; }, {}, {timeout: 240000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const probe = () => page.evaluate(() => window.deusExViewer.windowProbe());
  const settled = async () => { await frames(6); await page.evaluate(() => window.deusExViewer.settled()); };
  await frames(30);
  // Give the canvas the keyboard focus (a click, as a player would).
  await page.mouse.click(512, 320);
  await settled();
  const sim = (await page.evaluate(() => window.deusExViewer.status())).sim;
  await page.keyboard.press('F2'); await settled();
  const goals = await probe();
  assert.equal(goals.top, 'deusex.personascreengoals', 'F2 opens the Goals screen');
  await page.keyboard.down('Alt'); await page.keyboard.press('n'); await page.keyboard.up('Alt'); await settled();
  const added = await probe();
  assert.deepEqual([added.focus, added.text], ['deusex.personanoteseditwindow', 'New Note'], 'Alt+N added a note through the accelerator');
  for (const key of ['Shift+H', 'i', 'Backslash', 'Space']) { await page.keyboard.press(key); await frames(1); }
  // Playwright's keyboard knows only the US layout: 'é' and '€' come as the
  // keydowns a French layout sends (Digit2 gives 'é'; AltGr+E, which
  // Windows reports as Ctrl+Alt, gives '€').
  for (const [code, key, altGr] of [['Digit2', 'é', false], ['KeyE', '€', true]]) {
    await page.evaluate(({code, key, altGr}) => {
      const init = {code, key, ctrlKey: altGr, altKey: altGr, bubbles: true, cancelable: true};
      document.dispatchEvent(new KeyboardEvent('keydown', init));
      document.dispatchEvent(new KeyboardEvent('keyup', init));
    }, {code, key, altGr});
    await frames(1);
  }
  await settled();
  const typed = await probe();
  assert.equal(typed.text, 'Hi é€', 'the typed characters reach the note through the worker (FilterChar drops the backslash)');
  if (option('shot', null)) await page.screenshot({path: option('shot', null)});
  await page.keyboard.press('Backspace'); await settled();
  assert.equal((await probe()).text, 'Hi é', 'Backspace deletes the last character');
  await page.keyboard.press('Tab'); await settled();
  const saved = await probe();
  assert.deepEqual(saved.notes, ['Hi é'], 'Tab moved the focus and the note was saved');
  const status = await page.evaluate(() => window.deusExViewer.status());
  assert.equal(status.runtimeError, null, `no runtime error: ${status.runtimeError?.message}`);
  assert.deepEqual(errors, [], 'no page errors');
  report = {sim, goals: goals.top, note: typed.text, saved: saved.notes};
} finally {
  await browser.close();
  await server?.close();
}
console.log(`window-typed-key-browser: ${JSON.stringify(report)}`);
