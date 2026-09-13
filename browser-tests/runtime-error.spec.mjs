import { test, expect } from '@playwright/test';

test.use({ browserName:'firefox',viewport:{width:960,height:640} });

// The training Plant7 used to pause Play at the scene adapter (Plant7.Bump was an
// unsupported scene event). It is now implemented: a player bump runs the real
// inherited DeusExDecoration.Bump through the VM, pushing the decoration and
// recording its push sound as a deferred boundary (docs/script-plant-contact.md,
// scripts/validate-plant-push.mjs). This check confirms the contact no longer
// pauses, Firefox keeps rendering, and Player start still resets the scene.
test('player bump pushes the training plant without pausing, and Player start resets', async ({page}) => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:5173');
  await page.waitForFunction(()=>window.deusExViewer?.status().gameplay?.player.grounded);
  const initial=await page.evaluate(()=>window.deusExViewer.status().gameplay.player.position);
  await page.locator('#scene').click();
  await page.keyboard.down('KeyW');await page.keyboard.down('KeyD');
  // Walk into the plant. Wait until it is pushed (its push sound is recorded) or a
  // runtime error appears, so the wait cannot hang; the assertion below requires
  // the push and forbids the old pause.
  await page.waitForFunction(()=>{
    const s=window.deusExViewer.status();
    return Boolean(s.runtimeError)||(s.gameplay?.deferredEffects??[]).some(effect=>/Plant7\.PushSound/.test(effect));
  },null,{timeout:20000});
  await page.keyboard.up('KeyW');await page.keyboard.up('KeyD');
  const pushed=await page.evaluate(()=>window.deusExViewer.status());
  expect(pushed.runtimeError,pushed.runtimeError?.message).toBeNull();
  expect(pushed.paused).toBe(false);
  expect(pushed.gameplay.deferredEffects.some(effect=>/Plant7\.PushSound/.test(effect))).toBe(true);
  // Firefox keeps rendering after the contact.
  await page.waitForFunction(frame=>window.deusExViewer.status().frame>frame,pushed.frame);
  // Player start resets the scene to the original spawn.
  await page.getByRole('button',{name:'Player start',exact:true}).click();
  await page.waitForFunction(()=>window.deusExViewer.status().gameplay.player.grounded);
  const reset=await page.evaluate(()=>window.deusExViewer.status());
  expect(reset.runtimeError).toBeNull();
  await expect.poll(()=>page.evaluate(()=>window.deusExViewer.status().gameplay.player.position)).toEqual(initial);
  expect(errors).toEqual([]);
});
