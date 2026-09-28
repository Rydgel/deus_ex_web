import { test, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

test('Training floor matches the native reflection and clips geometry behind the plane', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  // Test-only access to rendering resources; the shipping hook remains read-only.
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('world.flushLighting(renderer);',
      'world.flushLighting(renderer); window.__mirrorProbe = {world, scene, camera, renderer, THREE};') });
  });
  await page.route(/\/src\/viewer\/mirrors\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('renderer.clippingPlanes = [group.plane];',
      'renderer.clippingPlanes = window.__disableMirrorClip ? [] : [group.plane];') });
  });
  await page.setViewportSize({ width: 926, height: 719 });
  await page.goto('http://127.0.0.1:5173');
  await page.waitForFunction(() => window.deusExViewer?.status().ready && Boolean(window.__mirrorProbe));
  await page.getByRole('combobox', { name: 'Movement mode' }).selectOption('inspect');
  const canvas = page.locator('#scene'), box = await canvas.boundingBox();
  await page.setViewportSize({ width: 926, height: 719 + 603 - box.height });
  await expect.poll(() => canvas.evaluate(c => [c.width, c.height])).toEqual([926, 603]);
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await page.getByText('Reference camera', { exact: true }).click();
  await page.getByLabel('Position (X, Y, Z)').fill('-1149.2435302734375,825.8439331054688,-40.19999694824219');
  await page.getByLabel('Rotation (pitch, yaw, roll)').fill('65524,31,0');
  await page.getByRole('button', { name: 'Apply camera', exact: true }).click();
  await page.getByText('Reference camera', { exact: true }).click();
  await page.getByRole('slider', { name: 'Brightness', exact: true }).fill('0.4');
  await page.getByLabel('Close diagnostics').click();
  await mkdir('.cache/mirrors', { recursive: true });
  const baseline = await canvas.screenshot({ path: '.cache/mirrors/entrance.png' });
  expect(await page.evaluate(() => window.deusExViewer.status().mirrors)).toMatchObject({
    surfaces: 46, planes: 4, unsupportedSurfaces: 0 });
  expect(await page.evaluate(() => window.deusExViewer.status().mirrors.renderedPlanes)).toBeGreaterThan(0);
  // The original native window capture is a local acceptance asset, never Git
  // content. Its two regions exclude the HUD, crosshair, and known mesh gaps.
  if (existsSync('reports/lighting/start/native-frame.png')) {
    const native = await readFile('reports/lighting/start/native-frame.png');
    const comparison = await page.evaluate(async ({ native, actual }) => {
    async function pixels(base64) {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
    const a = await pixels(native), b = await pixels(actual);
    return [[350, 360, 610, 525], [440, 462, 490, 511]].map(box => {
      let error = 0, count = 0;
      for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) for (let c = 0; c < 3; c++) {
        const offset = (y * a.width + x) * 4 + c;
        error += Math.abs(a.data[offset] - b.data[offset]); count++;
      }
      return { box, meanAbsoluteRGBError: error / count };
    });
  }, { native: native.toString('base64'), actual: baseline.toString('base64') });
    expect(comparison[0].meanAbsoluteRGBError).toBeLessThan(5.5);
    expect(comparison[1].meanAbsoluteRGBError).toBeLessThan(8);
    await writeFile('.cache/mirrors/comparison.json', JSON.stringify(comparison, null, 2));
  } else {
    test.info().annotations.push({ type: 'native-capture-unavailable', description:
      'Native visual comparison requires the local reports/lighting/start/native-frame.png capture; integration checks still run.' });
  }
  // A bright object between the reflected eye and the floor would leak into
  // the reflection without the original NearClip halfspace. The real floor
  // occludes it in the main view in both cases.
  await page.evaluate(() => {
    const { THREE, scene } = window.__mirrorProbe;
    const cube = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
    cube.position.set(825.8439331054688, -160, 900); scene.add(cube); window.__clipCube = cube;
  });
  const clipped = await canvas.screenshot();
  expect(clipped.equals(baseline)).toBe(true);
  await page.evaluate(() => { window.__disableMirrorClip = true; });
  const unclipped = await canvas.screenshot({ path: '.cache/mirrors/clip-disabled.png' });
  expect(unclipped.equals(baseline)).toBe(false);
  await page.evaluate(() => {
    window.__disableMirrorClip = false;
    const cube = window.__clipCube; cube.removeFromParent(); cube.geometry.dispose(); cube.material.dispose();
  });
  // Targets follow the drawing buffer; reflection resources and side flips must
  // not corrupt the following main view or allocate new textures every frame.
  const textures = await page.evaluate(() => window.__mirrorProbe.renderer.info.memory.textures);
  await page.setViewportSize({ width: 1100, height: 810 });
  await canvas.screenshot({ path: '.cache/mirrors/resized.png' });
  expect(await page.evaluate(() => window.__mirrorProbe.renderer.info.memory.textures)).toBe(textures);
  expect(await page.evaluate(() => ({ errors: window.deusExViewer.status().renderErrors,
    gamma: window.deusExViewer.status().displayGamma, clipping: window.__mirrorProbe.renderer.clippingPlanes.length,
    sides: [...window.__mirrorProbe.world.materials.values()].every(m => m.side !== window.__mirrorProbe.THREE.BackSide) })))
    .toEqual({ errors: [], gamma: 1, clipping: 0, sides: true });
  expect(errors).toEqual([]);
});
