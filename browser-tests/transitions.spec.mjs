import { test, expect } from '@playwright/test';

// Map-to-map transitions in the page (docs/travel-transitions.md): the Hong Kong lift pair (Helibase -> Market#cargoup -> Helibase#HeliBase restored) and the mission-14
// forms with a map extension and a blank before the portal (`14_OceanLab_UC.dx #UC`, then `14_OceanLab_Lab.dx #Sunkentunnel`, which restores the Lab filed under its MapName).
// The console line is SendPlayer's own ClientTravel (a MapExit adds ClearWindowStack first); the debugging page opens the first map from the list.
test.use({ channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 } });

test('the Hong Kong lift pair and the .dx URL forms travel and restore in the page', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/favicon/.test(message.location().url)) errors.push(message.text()); });
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const map = (name, timeout = 240_000) => page.waitForFunction(name => { const s = window.deusExViewer?.status(); return s?.ready && s.map?.toLowerCase() === name.toLowerCase() && !s.runtimeError; }, name, { timeout });
  const travel = async (line, to) => { await page.evaluate(line => window.deusExViewer.viewProbe({ exec: [line] }), line); await map(to, 180_000); await frames(60); };
  const playerAt = () => page.evaluate(() => window.deusExViewer.liveProbe({ player: {} }).then(r => r.player?.location ?? null, () => null)).catch(() => null);

  await page.goto(`${process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173'}/?debug=1&antialias=0&saves=off`);
  await map('00_Training');
  await page.getByRole('combobox', { name: 'Map', exact: true }).selectOption('06_HongKong_Helibase');
  await map('06_HongKong_Helibase');
  await frames(60);
  await travel('LocalTravel 06_HongKong_WanChai_Market#cargoup', '06_HongKong_WanChai_Market');
  await travel('LocalTravel 06_HongKong_Helibase#HeliBase', '06_HongKong_Helibase');
  const back = await playerAt();
  if (back) expect(Math.abs(back[0] - -1965.56)).toBeLessThan(40);   // the Helibase teleporter `HeliBase`, restored level

  await page.getByRole('combobox', { name: 'Map', exact: true }).selectOption('14_OceanLab_Lab');
  await map('14_OceanLab_Lab');
  await frames(60);
  await travel('LocalTravel 14_OceanLab_UC.dx #UC', '14_OceanLab_UC');
  await travel('LocalTravel 14_OceanLab_Lab.dx #Sunkentunnel', '14_OceanLab_Lab');
  await travel('LocalTravel 04_NYC_UNATCOIsland.dx', '04_NYC_UNATCOIsland');
  expect(await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null)).toBeNull();
  expect(errors).toEqual([]);
});
