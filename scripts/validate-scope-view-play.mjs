// The weapon scope view in Play (DeusExScopeView, docs/script-play-hud.md "Modulated tiles"), in the default worker mode: on 00_Training the
// debug loadout's WeaponRifle (belt 5) is drawn and ToggleScope (`[`) zooms it (bZoomed, FOV 75 to ScopeFOV 10). DrawWindow draws the black
// borders with tile color 0,0,0, then HUDScopeView with DSTY_Modulated: D3DDrv.dll DrawTile gives a PF_Modulated tile the vertex color
// 0xffffffff and PF_Masked (0x10005c22 to 0x10005c9d), so the lens shows the world. The check: zoomed, no runtime error, the lens centre
// shows the world (not black) and the screen outside the lens is black.
//   node scripts/validate-scope-view-play.mjs [--url http://...] [--shot scoped.png]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {debugUrl} from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-scope-view-play: no installed game data'); process.exit(0); }
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
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`, '--mute-audio']});
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 768}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const target = new URL(debugUrl(`${url}/`));
  target.searchParams.set('loadout', '1');
  await page.goto(target.href);
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === '00_Training'; }, {}, {timeout: 300000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const weapon = () => page.evaluate(async () => (await window.deusExViewer.inputProbe({op: 'state'}))?.weapon ?? null);
  await page.mouse.click(512, 384);
  await frames(90);
  await page.keyboard.press('Digit5');
  await frames(150);
  assert.equal((await weapon())?.cls, 'deusex.weaponrifle', 'belt 5 draws the loadout rifle');
  await page.keyboard.press('BracketLeft');
  await frames(120);
  const scoped = await weapon();
  assert.equal(scoped.zoomed, true, 'ToggleScope zooms');
  assert.equal(await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null), null);
  // The canvas's pixels: the lens centre (inside HUDScopeView's clear disc) and a corner of the screen (the black borders)
  const shot = await page.screenshot({path: option('shot', undefined)});
  const box = await page.evaluate(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; });
  // (the screenshot decoded in the page: no PNG decoder in node_modules)
  const pixels = await page.evaluate(async b64 => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    return {width: bitmap.width, data: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data)};
  }, shot.toString('base64'));
  const mean = (cx, cy, half) => {
    let sum = 0, n = 0;
    for (let y = Math.round(cy - half); y < cy + half; y++) for (let x = Math.round(cx - half); x < cx + half; x++) {
      const i = (y * pixels.width + x) * 4; sum += pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2]; n += 3;
    }
    return sum / n;
  };
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const lens = mean(cx + 40, cy + 40, 12), border = mean(box.x + box.w * 0.3, box.y + box.h * 0.2, 12);
  assert.ok(lens > 8, `the lens shows the world (mean ${lens.toFixed(1)})`);
  assert.ok(border < 2, `outside the lens is black (mean ${border.toFixed(1)})`);
  assert.deepEqual(errors, []);
  console.log(`PASS validate-scope-view-play: the rifle zoomed, lens mean ${lens.toFixed(1)}, border mean ${border.toFixed(1)}`);
} finally {
  await browser.close();
  await server?.close();
}
