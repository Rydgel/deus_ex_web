import { test, expect } from '@playwright/test';
import { BASE } from './browsers.mjs';

// A WebGL 2 without EXT_color_buffer_float (docs/stage-7-exit-criteria.md row 7.7.2): the GPU mesh path, which renders its pose and
// lighting passes into float targets (gpu-mesh.mjs), is not made, and the actors take the CPU kernels, the reference path (docs/gpu-mesh.md).
// `gpuMesh=1` asks for the GPU path even on a software renderer (headless Chromium's SwiftShader), so the refusal is what turns it away.
test.use({ viewport: { width: 960, height: 640 } });

test('a refused EXT_color_buffer_float: the GPU mesh path falls back to the CPU one, and Play runs and draws its actors', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const get = WebGL2RenderingContext.prototype.getExtension, list = WebGL2RenderingContext.prototype.getSupportedExtensions;
    WebGL2RenderingContext.prototype.getExtension = function (name) { return name === 'EXT_color_buffer_float' ? null : get.call(this, name); };
    WebGL2RenderingContext.prototype.getSupportedExtensions = function () { return list.call(this)?.filter(name => name !== 'EXT_color_buffer_float') ?? null; };
  });
  await page.goto(`${BASE}/?debug=1&gpuMesh=1`);
  await page.waitForFunction(() => window.deusExViewer?.status().gameplay?.player.grounded, null, { timeout: 240_000 });
  await expect(page.locator('#notes')).toContainText('GPU mesh path unavailable: GPU mesh requires EXT_color_buffer_float');
  const before = await page.evaluate(() => window.deusExViewer.status());
  expect(before).toMatchObject({ mode: 'play', runtimeError: null });
  // the level's actors, on the CPU path (`gpu`: the actor mesh layer has a GPU layout)
  expect(before.npcPreview).toMatchObject({ gpu: false, visible: true });
  expect(before.npcPreview.actors.length).toBeGreaterThan(0);
  expect(before.npcPreview.triangles).toBeGreaterThan(0);
  await page.waitForFunction(frame => window.deusExViewer.status().frame > frame + 30, before.frame);
  const after = await page.evaluate(() => window.deusExViewer.status());
  expect(after.runtimeError).toBeNull();
  expect(after.calls).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
