// The two actor mesh paths draw the same frame (docs/visual-acceptance.md "CPU
// and GPU mesh paths"; docs/script-lodmesh-lod.md "Child frames"): the same
// view under a paused Playwright clock and the inline simulation, once on the
// default GPU path, again on it (the scenario must reproduce its own pixels),
// and once with ?gpuMesh=0 (the CPU path). The player is placed with the
// capture's console inputs (ghost, Location, ViewRotation, Region), URender's
// MLOD may be raised on the simulation side so that mirror frames select other
// LOD states than the main frame's, and each run reads its drawing buffer with
// readPixels. The CPU run must give the GPU run's pixels exactly.
// Host measurement of the page against itself, not an original-game reference.
//
//   node scripts/validate-mesh-path-frames.mjs [--frames 90] [--case N] [--shots DIR]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-mesh-path-frames: no installed game data'); process.exit(0); }
const frames = Number(option('frames', 90));
// Views in 10_Paris_Club: the bar mirror with the player's reflection (JC at
// (78, -1008, 27), his Region), and the restroom's mirror (the eye 40 above
// the player's Location) at MLOD 3 and 10,
// where TrashCan1 and Faucet7 reduce differently in the mirror frame than in
// the main frame (validate-lodmesh-lod-play.mjs --mirrors).
const CASES = [
  {name: 'bar mirror, the player reflected', map: '10_Paris_Club', location: [78, -1008, 27], rotation: [61736, 0, 0],
    region: {zone: 'ZoneInfo4', iLeaf: 380, zoneNumber: 7}},
  {name: 'restroom mirror, MLOD 3', map: '10_Paris_Club', location: [-1424, -1064, -140], rotation: [0, 32768, 0], settings: {shapeLOD: 3}, differing: true},
  {name: 'restroom mirror, MLOD 10', map: '10_Paris_Club', location: [-1424, -1064, -140], rotation: [0, 32768, 0], settings: {shapeLOD: 10}, differing: true},
];
const root = fileURLToPath(new URL('..', import.meta.url));
const {default: base} = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
const server = await createServer({...base, configFile: false, root, logLevel: 'error',
  server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const INSTALL = new Date('2001-06-23T12:00:00Z').getTime(), START = INSTALL + 3600 * 1000;

async function run(browser, testCase, query) {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch(), text = await response.text(), from = 'antialias: true })';
    if (!text.includes(from)) throw new Error('validate-mesh-path-frames: the page\'s renderer construction changed');
    await route.fulfill({response, body: text.replace(from, 'antialias: true, preserveDrawingBuffer: true })')});
  });
  await page.addInitScript(() => { try { localStorage.setItem('deusex.uiHidden', '1'); } catch { /* storage unavailable */ } });
  try {
    await page.clock.install({time: INSTALL});
    await page.goto(debugUrl(`${url}/?hold=1&seed=1&sim=inline${query}`));
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
    await page.evaluate(map => { const menu = document.getElementById('map'); menu.value = map; menu.dispatchEvent(new Event('change')); }, testCase.map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && s.mode === 'play'; },
      testCase.map, {timeout: 240000});
    // The capture's inputs, then the held frame loop released at a fixed fake time.
    await page.evaluate(([c]) => {
      window.deusExViewer.viewProbe({ghost: true});
      window.deusExViewer.viewProbe({location: c.location, rotation: c.rotation, region: c.region ?? null});
      if (c.settings) window.deusExViewer.lodProbe({settings: c.settings});
    }, [testCase]);
    await page.clock.pauseAt(START);
    await page.evaluate(() => window.deusExViewer.release());
    for (let frame = 1; frame <= frames; frame++) await page.clock.runFor(16);
    const result = await page.evaluate(async () => {
      const canvas = document.getElementById('scene'), gl = canvas.getContext('webgl2');
      const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight, pixels = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const rows = (await window.deusExViewer.lodProbe({all: true})) ?? [];
      const toBase64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
      return {width, height, pixels: toBase64(pixels), error: window.deusExViewer.status().runtimeError?.message ?? null,
        anim: window.deusExViewer.viewProbe({}).anim?.frame,
        frames: rows.reduce((n, row) => n + (row.frames?.length ?? 0), 0),
        differing: rows.reduce((n, row) => n + (row.frames ?? []).filter(f => !f.same).length, 0),
        paths: [...new Set(rows.map(row => row.path))], preserved: gl.getContextAttributes().preserveDrawingBuffer,
        // A cleared buffer reads all zero: the frame must have drawn.
        drawn: pixels.reduce((n, v, i) => n + ((i & 3) === 3 && v !== 0), 0)};
    });
    return {...result, pixels: Buffer.from(result.pixels, 'base64'), errors};
  } finally { await page.close(); }
}
const diff = (a, b) => { let n = 0, max = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; max = Math.max(max, d); } } return {bytes: n, max}; };

const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
const summary = [];
try {
  for (const [index, testCase] of CASES.entries()) {
    if (option('case', null) !== null && Number(option('case')) !== index) continue;
    const gpu = await run(browser, testCase, ''), again = await run(browser, testCase, ''), cpu = await run(browser, testCase, '&gpuMesh=0');
    for (const side of [gpu, again, cpu]) {
      assert.deepEqual(side.errors, [], `${testCase.name}: page errors`); assert.equal(side.error, null, `${testCase.name}: runtime error`);
      assert.equal(side.preserved, true, `${testCase.name}: the renderer patch keeps the drawing buffer`);
      assert.ok(side.drawn > 0, `${testCase.name}: the frame drew pixels`);
    }
    assert.deepEqual(gpu.paths, ['gpu'], `${testCase.name}: the default run takes the GPU path`);
    assert.deepEqual(cpu.paths, ['cpu'], `${testCase.name}: ?gpuMesh=0 takes the CPU path`);
    assert.equal(gpu.anim, cpu.anim, `${testCase.name}: both runs hold the player's animation at one frame`);
    if (testCase.differing) assert.ok(cpu.differing > 0 && gpu.differing > 0, `${testCase.name}: a child frame draws a LOD state other than the main frame's`);
    const reproduces = diff(gpu.pixels, again.pixels), paths = diff(gpu.pixels, cpu.pixels);
    if (option('shots', null)) for (const [label, side] of [['gpu', gpu], ['cpu', cpu]]) {
      // The bottom row first: a PNG through the drawing buffer's rows reversed.
      const {default: zlib} = await import('node:zlib');
      const rowBytes = side.width * 4, raw = Buffer.alloc((rowBytes + 1) * side.height);
      for (let y = 0; y < side.height; y++) { raw[y * (rowBytes + 1)] = 0; side.pixels.copy(raw, y * (rowBytes + 1) + 1, (side.height - 1 - y) * rowBytes, (side.height - y) * rowBytes); }
      const crc = (() => { const table = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
        return buf => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; })();
      const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4); data.copy(out, 8);
        out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
      const header = Buffer.alloc(13); header.writeUInt32BE(side.width, 0); header.writeUInt32BE(side.height, 4); header[8] = 8; header[9] = 6;
      await writeFile(`${option('shots')}/${testCase.name.replace(/\W+/g, '-')}-${label}.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
    }
    assert.equal(reproduces.bytes, 0, `${testCase.name}: the GPU scenario reproduces its own pixels (${reproduces.bytes} bytes differ)`);
    assert.equal(paths.bytes, 0, `${testCase.name}: the CPU path draws the GPU path's pixels (${paths.bytes} bytes differ, up to ${paths.max})`);
    summary.push(`${testCase.name}: ${gpu.width}x${gpu.height} identical${testCase.differing ? `, ${gpu.differing} child-frame draws of another LOD state` : ''}, anim ${gpu.anim.toFixed(4)}`);
  }
} finally { await browser.close(); await server.close(); }
console.log(`validate-mesh-path-frames: PASS (${frames} frames each; ${summary.join('; ')})`);
