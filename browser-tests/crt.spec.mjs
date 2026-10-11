import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

function errors(page) {
  const list = [];
  page.on('pageerror', error => list.push(error.message));
  page.on('console', message => { if (message.type() === 'error') list.push(message.text()); });
  return list;
}

test('CRT leaves the recovered display ramp exact when disabled, including after resize', async ({ page }) => {
  const failures = errors(page);
  await page.route('**/__crt-fixture', route => route.fulfill({ contentType: 'text/html', body: '<canvas id="fixture"></canvas>' }));
  await page.goto('http://127.0.0.1:5173/__crt-fixture');
  const results = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { createDisplayRamp } = await import('/src/viewer/display-ramp.mjs');
    const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('fixture'), antialias: false });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.autoClear = false;
    const ramp = createDisplayRamp(), gl = renderer.getContext();
    function frame(rgb, gamma, crt) {
      renderer.setClearColor(new THREE.Color().setRGB(...rgb.map(n => n / 255)), 1);
      renderer.clear(); ramp.apply(renderer, gamma, crt);
      const pixels = new Uint8Array(renderer.domElement.width * renderer.domElement.height * 4);
      gl.readPixels(0, 0, renderer.domElement.width, renderer.domElement.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return [...pixels];
    }
    const cases = [];
    for (const [width, height, gamma] of [[18, 14, 1], [31, 20, 2 / 3], [21, 16, 0.4],
      [48, 800, 2 / 3], [48, 1200, 2 / 3], [48, 1600, 2 / 3]]) {
      renderer.setSize(width, height, false);
      const rgb = [32, 128, 224], before = frame(rgb, gamma, false), on = frame(rgb, gamma, true);
      const after = frame(rgb, gamma, false);
      const expected = rgb.map(n => Math.round(255 * (n / 255) ** gamma));
      cases.push({ restored: after.every((value, i) => value === before[i]),
        changed: on.some((value, i) => value !== before[i]),
        error: before.reduce((max, value, i) => Math.max(max, Math.abs(value - (i % 4 === 3 ? 255 : expected[i % 4]))), 0) });
    }
    renderer.setSize(99, 90, false);
    const gray = frame([128, 128, 128], 1, true);
    const mean = [0, 1, 2].map(channel => gray.filter((_, i) => i % 4 === channel).reduce((a, b) => a + b, 0) / (99 * 90));
    const black = frame([0, 128, 254], 3.4028234663852886e38, true);
    const white = frame([255, 255, 255], 3.4028234663852886e38, true);
    const error = gl.getError();
    ramp.dispose(); renderer.dispose();
    return { cases, mean, black, white, error };
  });
  for (const { restored, changed, error } of results.cases) {
    expect(restored).toBe(true);
    expect(changed).toBe(true);
    expect(error).toBeLessThanOrEqual(1);
  }
  results.mean.forEach(value => expect(Math.abs(value - 128)).toBeLessThan(4));
  expect(Math.max(...results.mean) - Math.min(...results.mean)).toBeLessThan(1);
  expect(results.black.every((value, i) => value === (i % 4 === 3 ? 255 : 0))).toBe(true);
  expect(results.white.every(value => value > 200)).toBe(true);
  expect(results.error).toBe(0);
  expect(failures).toEqual([]);
});

test('CRT button and Alt+C work in Play, preserve input, and remember the preference', async ({ page }) => {
  const failures = errors(page);
  const ready = () => page.waitForFunction(() => window.deusExViewer?.status().ready);
  const toggle = page.locator('#crt');
  await page.goto('http://127.0.0.1:5173'); await ready();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('aria-keyshortcuts', 'Alt+C');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#scene')).toBeFocused();
  await page.waitForFunction(() => window.deusExViewer.status().gameplay?.player.grounded);
  const rotation = await page.evaluate(() => window.deusExViewer.status().rotation);
  await page.keyboard.down('Alt'); await page.keyboard.down('KeyC');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.down('KeyC'); // repeat must not toggle again or reach TurnRight
  await page.waitForTimeout(200);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.up('Alt'); await page.keyboard.up('KeyC');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.deusExViewer.status().rotation)).toEqual(rotation);

  await page.locator('#diagnostics').click();
  await page.locator('summary').click();
  await page.locator('#camera-position').focus();
  await page.keyboard.press('Alt+KeyC');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#close-panel').click();
  await page.locator('#hide-ui').click();
  await page.locator('#scene').focus();
  await page.keyboard.press('Alt+KeyC');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#toast')).toContainText('CRT enabled');
  await page.locator('#show-ui').click();

  await mkdir('reports/browser', { recursive: true });
  await page.screenshot({ path: 'reports/browser/crt-play.png' });
  await page.reload(); await ready();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const shaders = page.locator('#crt-shader');
  for (const shader of ['easymode', 'lottes', 'satpixie', 'royale']) {
    await shaders.selectOption(shader);
    await page.waitForFunction(shader => window.deusExViewer.status().crtShader === shader, shader);
  }
  await page.locator('#crt-compare').click();
  await expect(page.locator('#crt-comparison')).toBeVisible();
  await expect(page.locator('#crt-comparison-name')).toHaveText('CRT-Royale');
  await page.keyboard.press('Alt+Shift+KeyC');
  await expect(shaders).toHaveValue('aperture');
  await shaders.selectOption('satpixie');
  await page.screenshot({ path: 'reports/browser/crt-compare.png' });
  await page.reload(); await ready();
  await expect(shaders).toHaveValue('satpixie');
  await expect(page.locator('#crt-comparison')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#mode').selectOption('inspect');
  await page.screenshot({ path: 'reports/browser/crt-inspect.png' });
  await page.setViewportSize({ width: 820, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#scene').focus();
  await page.keyboard.press('Alt+KeyC');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.deusExViewer.status().runtimeError)).toBeNull();
  expect(failures).toEqual([]);
});

test('all CRT pipelines preserve the original comparison half, orientation, resize and off output', async ({ page }) => {
  const failures = errors(page);
  await page.route('**/__crt-fixture', route => route.fulfill({ contentType: 'text/html', body: '<canvas id="fixture"></canvas>' }));
  await page.goto('http://127.0.0.1:5173/__crt-fixture');
  const results = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { createDisplayRamp, CRT_PRESETS, prepareCrtPreset } = await import('/src/viewer/display-ramp.mjs');
    const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('fixture'), antialias: false });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; renderer.autoClear = false;
    const scene = new THREE.Scene(), camera = new THREE.Camera();
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: { size: { value: new THREE.Vector2() } },
      vertexShader: 'void main() { gl_Position = vec4(position, 1.0); }',
      fragmentShader: `uniform vec2 size; out vec4 color;
        void main() { vec2 p = gl_FragCoord.xy / size;
          color = vec4(vec3(p.y < 0.5 ? 0.15 : 0.7) + 0.04 * sin(p.x * 80.0), 1.0); }`,
    });
    scene.add(new THREE.Mesh(geometry, material));
    const ramp = createDisplayRamp(), gl = renderer.getContext(), cases = [];
    for (const id of Object.keys(CRT_PRESETS)) {
      await prepareCrtPreset(id);
      for (const [w, h, dpr] of [[319, 803, 1], [321, 405, 2]]) {
        renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
        const width = renderer.domElement.width, height = renderer.domElement.height;
        material.uniforms.size.value.set(width, height);
        renderer.setScissor(7, 9, 23, 31);
        const render = (enabled, compare = false) => {
          renderer.setRenderTarget(null); renderer.render(scene, camera); ramp.apply(renderer, 2 / 3, enabled, id, compare);
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          return pixels;
        };
        const before = render(false), split = render(true, true), after = render(false);
        let leftExact = true, changed = false, top = 0, bottom = 0, samples = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          for (let c = 0; c < 4; c++) {
            if (x < Math.floor(width / 2)) leftExact &&= split[i + c] === before[i + c];
            else changed ||= split[i + c] !== before[i + c];
          }
          if (x > width * 0.6 && x < width * 0.9) {
            if (y > height * 0.1 && y < height * 0.4) bottom += split[i];
            if (y > height * 0.6 && y < height * 0.9) { top += split[i]; samples++; }
          }
        }
        cases.push({ id, dpr, leftExact, changed, restored: after.every((n, i) => n === before[i]),
          upright: top / samples > bottom / samples + 25,
          scissor: renderer.getScissor(new THREE.Vector4()).toArray(), scissorTest: renderer.getScissorTest(), error: gl.getError() });
      }
    }
    renderer.setPixelRatio(1); renderer.setSize(256, 160, false);
    const sampleSatpixie = level => {
      renderer.setClearColor(new THREE.Color(level, level, level), 1); renderer.clear();
      ramp.apply(renderer, 1, true, 'satpixie');
      const pixel = new Uint8Array(4); gl.readPixels(128, 80, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return [...pixel];
    };
    ramp.reset(); const fresh = sampleSatpixie(0);
    sampleSatpixie(1); const retained = sampleSatpixie(0);
    ramp.reset(); const reset = sampleSatpixie(0);
    ramp.dispose(); geometry.dispose(); material.dispose(); renderer.dispose();
    return { cases, fresh, retained, reset };
  });
  for (const row of results.cases) {
    expect(row, JSON.stringify(row)).toMatchObject({ leftExact: true, changed: true, restored: true, upright: true,
      scissor: [7, 9, 23, 31], scissorTest: false, error: 0 });
  }
  expect(results.retained[0]).toBeGreaterThan(results.fresh[0] + 20);
  expect(results.reset).toEqual(results.fresh);
  expect(failures).toEqual([]);
});
