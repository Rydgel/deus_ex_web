// The original options menus in Play, default worker mode (docs/script-native-config.md).
//
// On 00_Training the page runs the worker's simulation; each step is one worker-side
// `settingsProbe` call that presses the original MenuMain/MenuSettings/MenuScreen buttons or drags
// a slider thumb (src/viewer/menu-driver.mjs), then the page lets frames pass. Checked on the page:
//   * Display > Adjust Brightness: dragging the slider runs MenuChoice_AdjustBrightness.
//     ScalePositionChanged (`set ini:... Brightness v` + FLUSH); the render device's Flush reaches
//     the page as the Brightness of its snapshot, so the page's brightness control and display
//     ramp exponent follow (1 / (2.5 * float32 Brightness)). Escape restores the saved value.
//   * Sound: the Sound Effects slider reaches the live Galaxy subsystem (SetInstantSoundVolume and
//     PostEditChange -> SetVolumes) and OK writes the class defaults back into GConfig.
//   * Controls: Mouse Sensitivity and Invert Mouse change the player's properties that
//     PlayerPawn.PlayerInput reads.
//
//   node scripts/validate-settings-play.mjs [--url http://...] [--query name=value]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {brightnessGamma} from '../src/viewer/display-ramp.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-settings-play: no installed game data'); process.exit(0); }
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
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let report;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/${option('query', '') ? `?${option('query', '')}` : ''}`);
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === '00_Training'; }, {}, {timeout: 240000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const settled = async () => { await frames(6); await page.evaluate(() => window.deusExViewer.settled()); };
  const step = async (step, wait = 12) => { const out = await page.evaluate(step => window.deusExViewer.settingsProbe(step), step); await frames(wait); await settled(); return out; };
  const state = () => page.evaluate(() => window.deusExViewer.settingsProbe({op: 'state'}));
  const status = () => page.evaluate(() => window.deusExViewer.status());
  const slider = () => page.evaluate(() => Number(document.getElementById('brightness').value));
  await frames(30);
  const sim = (await status()).sim;
  assert.notEqual(sim, 'inline', 'the default worker mode');

  // ---- Display > Adjust Brightness -------------------------------------------------------------
  await step({op: 'menu'});
  await step({op: 'invoke', screen: 'MenuSettings'});
  await step({op: 'invoke', screen: 'MenuScreenDisplay'});
  await step({op: 'press', choice: 'MenuChoice_Brightness'});
  assert.equal((await state()).top, 'deusex.menuscreenbrightness', 'the Brightness screen is open');
  const before = await status();
  assert.equal(before.brightness, 0.6, 'the installed Brightness 0.6');
  await step({op: 'drag', choice: 'MenuChoice_AdjustBrightness', tick: 4});         // 21 ticks over 0..1: 4/20
  const dim = await status(), dimState = await state();
  assert.equal(dimState.client.brightness, Math.fround(0.2), 'the live client took Brightness 0.2 (set + PostEditChange)');
  assert.ok(Math.abs(dim.brightness - 0.2) < 1e-6, `the page's brightness control follows the Flush: ${dim.brightness}`);
  assert.equal(Math.fround(dim.displayGamma), Math.fround(brightnessGamma(Math.fround(0.2))), 'the display ramp exponent');
  await step({op: 'drag', choice: 'MenuChoice_AdjustBrightness', tick: 20});
  const full = await status();
  assert.equal(Math.fround(full.displayGamma), Math.fround(brightnessGamma(1)), 'Brightness 1.0');
  // Escape on this screen saves (bEscapeSavesSettings): the new Brightness stays and reaches GConfig.
  await step({op: 'escape'});
  const kept = await status();
  assert.equal(Math.fround(kept.displayGamma), Math.fround(brightnessGamma(1)), 'Escape kept Brightness 1.0');
  assert.equal((await state()).top, 'deusex.menuscreendisplay', 'back on the Display screen');
  const saved = await page.evaluate(() => window.deusExViewer.settingsProbe({op: 'console', command: 'get ini:Engine.Engine.ViewportManager Brightness'}));
  assert.equal(saved.result, '1.000000', 'SaveSettings wrote the class default');
  // The screen's Cancel button restores the value LoadSetting saw (1.0) after a further drag.
  await step({op: 'press', choice: 'MenuChoice_Brightness'});
  await step({op: 'drag', choice: 'MenuChoice_AdjustBrightness', tick: 8});
  assert.ok(Math.abs((await status()).brightness - 0.4) < 1e-6, 'dragged to 0.4');
  await step({op: 'action', action: 2});
  const back = await status();
  assert.ok(Math.abs(back.brightness - 1) < 1e-6, `Cancel restored Brightness: ${back.brightness}`);

  // ---- Sound -------------------------------------------------------------------------------------
  await step({op: 'escape'}); await step({op: 'invoke', screen: 'MenuScreenSound'});
  assert.equal((await state()).top, 'deusex.menuscreensound', 'the Sound screen is open');
  const audioBefore = (await state()).audio;
  assert.deepEqual([audioBefore.musicVolume, audioBefore.soundVolume, audioBefore.speechVolume], [153, 204, 255], 'the installed volumes');
  await step({op: 'drag', choice: 'MenuChoice_SoundVolume', tick: 5});               // 11 ticks over 0..255
  const sound = (await state()).audio;
  assert.equal(sound.soundVolume, Math.trunc(255 * 5 / 10), 'SetInstantSoundVolume took FloatToByte(slider value)');
  await step({op: 'drag', choice: 'MenuChoice_MusicVolume', tick: 3});
  assert.equal((await state()).audio.musicVolume, Math.trunc(255 * 3 / 10), 'SetInstantMusicVolume');
  await step({op: 'action', action: 1});                                              // OK: SaveSettings
  const configured = await page.evaluate(() => window.deusExViewer.settingsProbe({op: 'console', command: 'get ini:Engine.Engine.AudioDevice SoundVolume'}));
  assert.equal(configured.result, '127', 'OK wrote SoundVolume through set ini:');
  assert.equal(configured.audio.soundVolume, 127, 'the live subsystem kept it');

  // ---- Controls ----------------------------------------------------------------------------------
  await step({op: 'invoke', screen: 'MenuScreenControls'});
  assert.equal((await state()).top, 'deusex.menuscreencontrols', 'the Controls screen is open');
  assert.equal((await state()).player.mouseSensitivity, 3, 'the installed MouseSensitivity');
  await step({op: 'drag', choice: 'MenuChoice_MouseSensitivity', tick: 5});          // 10 ticks, 1..10: tick 5 -> 5 or 6
  const sensitive = (await state()).player;
  assert.ok(sensitive.mouseSensitivity > 3, `ScalePositionChanged -> UpdateSensitivity: ${sensitive.mouseSensitivity}`);
  await step({op: 'press', choice: 'MenuChoice_InvertMouse'});
  await step({op: 'action', action: 1});
  assert.equal((await state()).player.invertMouse, true, 'OK saved Invert Mouse');

  // ---- Display > Screen Resolution: SetRes fixes the page's drawing buffer ---------------------------
  const before800 = await page.evaluate(() => { const c = document.getElementById('scene'); return [c.width, c.height]; });
  await step({op: 'console', command: 'SetRes 800x600'}, 20);
  const buffer = await page.evaluate(() => { const c = document.getElementById('scene'); return [c.width, c.height]; });
  assert.deepEqual(buffer, [800, 600], `SetRes 800x600 fixed the drawing buffer (was ${before800})`);
  const current = await page.evaluate(() => window.deusExViewer.settingsProbe({op: 'console', command: 'GetCurrentRes'}));
  assert.equal(current.result, '800x600', 'GetCurrentRes reports the new viewport size');

  const final = await status();
  assert.equal(final.runtimeError, null, `no runtime error: ${final.runtimeError?.message}`);
  assert.deepEqual(errors, [], 'no page errors');
  report = {sim, brightness: [before.brightness, dim.brightness, full.brightness, kept.brightness, back.brightness],
    gamma: [dim.displayGamma, full.displayGamma], audio: [audioBefore.soundVolume, sound.soundVolume, configured.result],
    mouse: sensitive.mouseSensitivity, buffer};
} finally {
  await browser.close();
  await server?.close();
}
console.log(`settings-play: ${JSON.stringify(report)}`);
