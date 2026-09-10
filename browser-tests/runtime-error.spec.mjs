import { test, expect } from '@playwright/test';

test.use({ browserName:'firefox',viewport:{width:960,height:640} });

test('unsupported plant contact keeps Firefox rendering and allows a scene reset', async ({page}) => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:5173');
  await page.waitForFunction(()=>window.deusExViewer?.status().gameplay?.player.grounded);
  const initial=await page.evaluate(()=>window.deusExViewer.status().gameplay.player.position);
  await page.locator('#scene').click();
  await page.keyboard.down('KeyW');await page.keyboard.down('KeyD');
  await page.waitForFunction(()=>window.deusExViewer.status().runtimeError,null,{timeout:20000});
  await page.keyboard.up('KeyW');await page.keyboard.up('KeyD');
  const stopped=await page.evaluate(()=>window.deusExViewer.status());
  expect(stopped.runtimeError.message).toContain('Plant7.Bump');
  expect(stopped.paused).toBe(true);
  await expect(page.locator('#toast')).toContainText('Player start');
  await page.waitForFunction(frame=>window.deusExViewer.status().frame>frame,stopped.frame);
  await page.getByRole('button',{name:'Player start',exact:true}).click();
  await page.waitForFunction(()=>window.deusExViewer.status().gameplay.player.grounded);
  const reset=await page.evaluate(()=>window.deusExViewer.status());
  expect(reset.runtimeError).toBeNull();
  await expect.poll(()=>page.evaluate(()=>window.deusExViewer.status().gameplay.player.position)).toEqual(initial);
  expect(errors).toEqual([]);
});
