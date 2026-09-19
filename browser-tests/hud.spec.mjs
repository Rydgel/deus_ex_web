import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

test('original health HUD, compass and InfoLink remain live across turning and reset',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const status=()=>page.evaluate(()=>window.deusExViewer.status());
  await page.goto('http://127.0.0.1:5173');
  await page.waitForFunction(()=>window.deusExViewer?.status().gameplay?.hud?.health.head.displayedHealth===100);
  const initial=await status();
  expect(initial.gameplay.hud).toMatchObject({energy:100,underwater:false,health:{head:{color:[0,255,0]}}});
  await expect(page.locator('#crosshair')).toBeHidden();
  const box=await page.locator('#scene').boundingBox();
  await page.mouse.move(box.x+600,box.y+350);await page.mouse.down();
  await page.mouse.move(box.x+760,box.y+350,{steps:8});await page.mouse.up();
  await expect.poll(async()=>(await status()).gameplay.hud.compass.yaw).not.toBe(initial.gameplay.hud.compass.yaw);
  const turned=await status();expect(turned.gameplay.hud.compass.drawPos).not.toBe(initial.gameplay.hud.compass.drawPos);
  await page.getByRole('button',{name:'Player start',exact:true}).click();
  await page.locator('#scene').click({position:{x:600,y:350}});
  await page.keyboard.down('KeyW');
  await page.waitForFunction(()=>window.deusExViewer.status().gameplay.player.position[0]>-1000);
  await page.keyboard.up('KeyW');
  await expect(page.locator('#infolink-title')).toHaveText('Jaime Reyes',{timeout:15000});
  await expect.poll(()=>page.locator('#infolink-text').textContent()).toContain('I figured');
  await mkdir('reports/hud',{recursive:true});await page.screenshot({path:'reports/hud/original-infolink.png'});
  await page.getByRole('button',{name:'Player start',exact:true}).click();
  await expect(page.locator('#infolink-shell')).toBeHidden();
  await expect.poll(async()=>(await status()).gameplay.hud.health.head.displayedHealth).toBe(100);
  expect((await status()).runtimeError).toBeNull();expect(errors).toEqual([]);
});
