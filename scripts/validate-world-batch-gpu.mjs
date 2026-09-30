/** Pixel equivalence of ordered world batches, including restored GPU storage. */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

// Standalone, bounded local server: the fixture needs only source modules and
// generated textures, so this check does not require an installed game.
const server = await createServer({configFile: false, publicDir: false, logLevel: 'error',
  server: {host: '127.0.0.1', port: 0, strictPort: false}});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({args: process.platform === 'darwin' ? ['--use-angle=metal'] : []});
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await page.route('**/__world_batch_fixture__', route => route.fulfill({contentType: 'text/html',
    body: '<!doctype html><script type="module">import {runWorldBatchGpuFixture} from "/scripts/world-batch-gpu-fixture.mjs"; window.batchPixels = await runWorldBatchGpuFixture();</script>'}));
  await page.goto(new URL('/__world_batch_fixture__', server.resolvedUrls.local[0]).href);
  await page.waitForFunction(() => window.batchPixels, {}, {timeout: 30_000});
  const result = await page.evaluate(() => window.batchPixels);
  assert.deepEqual(errors, []);
  for (const frame of result.results) assert.equal(frame.differences, 0, JSON.stringify(frame));
  for (const frame of result.decodeResults) assert.equal(frame.differences, 0, JSON.stringify(frame));
  assert.equal(result.restoreDifferences, 0, 'Full update during context loss restores every atlas layer');
  assert.equal(result.errors, 0, 'No WebGL error after context restore');
  assert.ok(result.stats.after < result.stats.before / 2);
  console.log(JSON.stringify(result));
} finally {
  // Closing the isolated browser releases both generations of GPU objects.
  await browser?.close();await server.close();
}
