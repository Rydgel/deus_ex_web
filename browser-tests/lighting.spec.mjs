import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { BASE } from './browsers.mjs';

// Original saved JCDentonMale1: Location + EyeHeight, ViewRotation. Native HFOV 75.
const cameras = [
  { name: 'start', position: [-1149.2435302734375, 825.8439331054688, -40.19999694824219], rotation: [65524, 31, 0] },
  { name: 'side', position: [-1149.2435302734375, 825.8439331054688, -40.19999694824219], rotation: [65501, 2496, 0] },
];
test('static lighting, display brightness and fixed original cameras render without shader errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewportSize({ width: 926, height: 719 });
  await page.goto(`${BASE}/?debug=1`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready);
  // Inspect and Play have different control text heights. Select the fixed-camera
  // mode before sizing the canvas to the original capture's 926 × 603 viewport.
  await page.getByRole('combobox', { name: 'Movement mode' }).selectOption('inspect');
  const canvas = page.locator('#scene'), box = await canvas.boundingBox();
  // (Rounded up: Playwright takes whole pixels, and a browser may lay the bars out at fractional heights, as Firefox on macOS does;
  // the canvas's buffer is the floor of its box, so its box between 603 and 604 gives 603.)
  await page.setViewportSize({ width: 926, height: Math.ceil(719 + 603 - box.height) });
  await expect.poll(() => canvas.evaluate(c => [c.width, c.height])).toEqual([926, 603]);
  const initial = await page.evaluate(() => window.deusExViewer.status());
  expect(initial).toMatchObject({ renderErrors: [], lightingEnabled: true, brightness: .6,
    lighting: { missingLightmaps: 0, lightmaps: 5212, atlasPages: 6 } });
  expect(initial.lighting.shadowMasks).toBeGreaterThan(15000);
  const unlitProbe = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
    const canvas = document.getElementById('scene'), gl = canvas.getContext('webgl2'), pixel = new Uint8Array(4);
    gl.readPixels(810, canvas.height - 61, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    resolve(Array.from(pixel));
  })));
  for (const c of cameras) {
    const dir = `reports/lighting/${c.name}`; await mkdir(dir, { recursive: true });
    await page.locator('#tools-options').click();
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
    await page.getByText('Reference camera', { exact: true }).click();
    await page.getByLabel('Position (X, Y, Z)').fill(c.position.join(','));
    await page.getByLabel('Rotation (pitch, yaw, roll)').fill(c.rotation.join(','));
    await page.getByRole('button', { name: 'Apply camera', exact: true }).click();
    await page.getByText('Reference camera', { exact: true }).click();
    await page.getByLabel('Close diagnostics').click();
    await canvas.screenshot({ path: `${dir}/browser-gamma.png` });
    await page.locator('#tools-options').click();
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
    await page.getByRole('slider', { name: 'Brightness', exact: true }).fill('0.4');
    await page.getByLabel('Close diagnostics').click();
    const lit = await canvas.screenshot({ path: `${dir}/browser-raw.png` });
    const unchanged = c.name === 'start' ? await unlitProbe() : null;
    await page.locator('#tools-options').click();
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
    await page.getByLabel('Original lighting', { exact: true }).uncheck();
    await page.getByLabel('Close diagnostics').click();
    const unlit = await canvas.screenshot({ path: `${dir}/browser-unlit.png` });
    if (unchanged) {
      expect(unchanged[0]).toBeGreaterThan(120);
      expect(await unlitProbe()).toEqual(unchanged); // Authored unlit ceiling detail.
    }
    expect(lit.equals(unlit)).toBe(false);
    expect(await page.evaluate(() => window.deusExViewer.status().lightingEnabled)).toBe(false);
    await writeFile(`${dir}/browser-status.json`, JSON.stringify(await page.evaluate(() => window.deusExViewer.status()), null, 2));
    await page.locator('#tools-options').click();
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
    await page.getByLabel('Original lighting', { exact: true }).check();
    await page.getByRole('slider', { name: 'Brightness', exact: true }).fill('0.6');
    await page.getByLabel('Close diagnostics').click();
  }
  expect(errors).toEqual([]);
});
