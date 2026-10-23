/** The original renderer's texture sampling state on every base-texture path (docs/texture-sampling.md).
 *
 * D3DDrv's stage setup (0x10009e20) gives every texture stage LINEAR magnification and minification,
 * MIPFILTER POINT (UseTrilinear=False, UseMipmapping=True in the shipped DeusEx.ini) and a level-of-detail
 * bias of -0.5; PF_NoSmooth surfaces use POINT for both filters. The fixture
 * (scripts/texture-sampling-fixture.mjs) draws a 512 x 512 texture whose mip level k is a solid colour at
 * quarter-level distances from the picks' ties, through the plain MeshBasicMaterial (actor skins, decals), the
 * world's light-atlas material and the batched world shader, and checks the colour on screen is the level the
 * device state selects. The previous sampling (trilinear, no bias) blends two levels and draws every case a
 * level coarser or blended: this check fails on it. Needs no original assets.
 *
 *   node scripts/validate-texture-sampling.mjs */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import { debugUrl } from './page-url.mjs';

const server = await createServer({configFile: false, publicDir: false, logLevel: 'error',
  // its own dependency cache: its config differs from vite.config.mjs's, so .vite-cache/deps would be rebuilt (vite.config.mjs)
  cacheDir: '.vite-cache/standalone', server: {host: '127.0.0.1', port: 0, strictPort: false}});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({args: process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=gl']});
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/__texture_sampling_fixture__', route => route.fulfill({contentType: 'text/html',
    body: '<!doctype html><script type="module">import {runTextureSamplingFixture} from "/scripts/texture-sampling-fixture.mjs"; window.samplingResult = await runTextureSamplingFixture();</script>'}));
  await page.goto(debugUrl(new URL('/__texture_sampling_fixture__', server.resolvedUrls.local[0]).href));
  await page.waitForFunction(() => window.samplingResult, {}, {timeout: 60_000});
  const result = await page.evaluate(() => window.samplingResult);
  assert.deepEqual(errors, []);
  assert.equal(result.errors, 0, 'no WebGL error');
  assert.equal(result.bias, -0.5, 'the device bias');
  const batchedRows = result.rows.filter(row => row.kind === 'batched');
  assert.ok(batchedRows.every(row => row.batches > 0), 'the batched world shader is the one drawn');
  let checked = 0;
  for (const row of result.rows) {
    for (const [j, level] of row.levels.entries()) {
      assert.ok(row.distances[j] <= 4, `${row.kind} texture ${j} at lambda ${row.lambda}: the pixel is a palette colour (no blended levels): ${JSON.stringify(row)}`);
      assert.equal(level, row.expected, `${row.kind} texture ${j} at lambda ${row.lambda} (quad ${row.size} px): level ${row.expected} expected, ${level} drawn`);
      checked++;
    }
  }
  const [smooth, noSmooth] = result.noSmooth;
  assert.equal(smooth.magFilter, result.filters.linear); assert.equal(smooth.minFilter, result.filters.linearMipmapNearest);
  assert.equal(noSmooth.magFilter, result.filters.nearest); assert.equal(noSmooth.minFilter, result.filters.nearestMipmapNearest);
  const colors = [[200, 30, 30], [30, 200, 30], [30, 30, 200], [200, 200, 30]];
  // The two pixels either side of the centre line of a 2 x 2 texture on a 64-pixel quad: POINT draws texels; LINEAR blends them.
  assert.ok(colors.some(c => c.every((v, i) => v === noSmooth.left[i])) && colors.some(c => c.every((v, i) => v === noSmooth.right[i])), `PF_NoSmooth draws texels: ${JSON.stringify(noSmooth)}`);
  assert.ok(!colors.some(c => c.every((v, i) => v === smooth.left[i])), `a smooth surface blends its texels at the boundary: ${JSON.stringify(smooth)}`);
  // The texels are filtered in display space (no sRGB decode): between 0 and 255 the pixel next to the boundary is a plain mix.
  for (const kind of ['plain', 'world']) assert.ok(result.space[kind][0] >= 110 && result.space[kind][0] <= 136, `${kind}: 8-bit texels filter in display space (${result.space[kind]})`);
  console.log(`validate-texture-sampling: PASS (${checked} level checks: plain, world and batched shaders at lambda 0.25..6.75 with bias ${result.bias}; PF_NoSmooth POINT; display-space filtering ${result.space.plain[0]}/${result.space.world[0]})`);
} finally {
  await browser?.close(); await server.close();
}
