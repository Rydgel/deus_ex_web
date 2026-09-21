import {test,expect} from '@playwright/test';

test('unavailable Wasm keeps the existing JavaScript pose path playable and reports the fallback',async({page})=>{
  await page.route('**/*.wasm',route=>route.abort());
  await page.goto('http://127.0.0.1:5173');
  await page.waitForFunction(()=>window.deusExViewer?.status().ready);
  await page.locator('#scene').click({position:{x:500,y:350}});
  const initial=await page.evaluate(()=>window.deusExViewer.status());
  expect(initial).toMatchObject({mode:'play',runtimeError:null,npcPreview:{poseBackend:'javascript'}});
  expect(initial.npcPreview.actors).toHaveLength(18);
  expect(initial.npcPreview.kernelError).toBeTruthy();
  await page.keyboard.down('KeyW');
  try {
    await expect.poll(async()=> (await page.evaluate(()=>window.deusExViewer.status())).gameplay.player.position[0])
      .toBeGreaterThan(initial.gameplay.player.position[0]+20);
  } finally {await page.keyboard.up('KeyW');}
  expect((await page.evaluate(()=>window.deusExViewer.status())).runtimeError).toBeNull();
});
