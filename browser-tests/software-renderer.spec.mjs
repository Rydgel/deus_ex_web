import { test, expect } from '@playwright/test';
import { BASE } from './browsers.mjs';

// A software WebGL renderer (docs/stage-7-exit-criteria.md row 7.7.3): Chromium on SwiftShader (`--use-angle=swiftshader`), Firefox
// on Mesa's llvmpipe (LIBGL_ALWAYS_SOFTWARE=1 with GLVND pointed at Mesa: Linux only). Play names such a renderer (main.mjs softwareRenderer) and keeps the actor meshes on
// the CPU kernels (docs/gpu-mesh.md: a software renderer runs the GPU passes on the CPU, far slower), unless ?gpuMesh=1. Training
// loads, the game keeps real time (its clock follows the wall clock: a slow draw does not slow the game) and the page draws; the
// frame rate is reported, not bounded ("playable" has no declared bound on a software renderer).
test.use({ viewport: { width: 960, height: 640 } });
test.setTimeout(400_000);
test.use({ launchOptions: [async ({ browserName }, use) => use(browserName === 'chromium'
  ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }
  // Mesa's EGL even where another vendor's GL is the system's (GLVND picks it), and its software rasterizer
  : { env: { ...process.env, __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/50_mesa.json', __GLX_VENDOR_LIBRARY_NAME: 'mesa',
    LIBGL_ALWAYS_SOFTWARE: '1' } }), { scope: 'worker' }] });

test('a software renderer keeps the CPU mesh path, and Training keeps real time', async ({ page, browserName }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${BASE}/?debug=1`);
  await page.waitForFunction(() => window.deusExViewer?.status().gameplay?.player.grounded, null, { timeout: 360_000 });
  const graphics = await page.evaluate(() => window.deusExViewer.status().graphics);
  expect(graphics.renderer, `the renderer ${graphics.renderer}`).toMatch(/swiftshader|llvmpipe|softpipe|software/i);
  expect(graphics.meshPath).toBe('cpu');
  const view = () => page.evaluate(() => window.deusExViewer.viewProbe({}));
  const frame = () => page.evaluate(() => window.deusExViewer.status().frame);
  const start = { view: await view(), frame: await frame(), at: Date.now() };
  await page.waitForTimeout(10_000);
  const end = { view: await view(), frame: await frame(), at: Date.now() };
  const real = (end.at - start.at) / 1000, game = (end.view.timeSeconds - start.view.timeSeconds) / end.view.timeDilation;
  const fps = (end.frame - start.frame) / real;
  info.annotations.push({ type: 'measured', description: `${browserName} on ${graphics.renderer}: ${fps.toFixed(1)} drawn frames a second, game time ${game.toFixed(2)} s in ${real.toFixed(2)} s` });
  console.log(`${browserName} on ${graphics.renderer}: ${fps.toFixed(1)} fps, game ${game.toFixed(2)} s in ${real.toFixed(2)} s`);
  expect(fps).toBeGreaterThan(0.5);                      // it draws
  expect(game).toBeGreaterThan(real * 0.9);              // and the game keeps real time
  expect(game).toBeLessThan(real * 1.1);
  expect(errors).toEqual([]);
});
