import { test, expect } from '@playwright/test';
import { BASE } from './browsers.mjs';

test.use({ viewport:{width:960,height:640} });

// The training Plant7 used to pause Play at the scene adapter (Plant7.Bump was an
// unsupported scene event). It is now implemented: a player bump runs the real
// inherited DeusExDecoration.Bump through the VM, which pushes the decoration
// (docs/script-plant-contact.md, scripts/validate-plant-push.mjs); its push sound
// plays now rather than being recorded as a deferred boundary, so the push is read
// from Plant7's Location through the simulation's live probe. This check confirms
// the contact does not pause, the browser keeps rendering (each project's: it ran in
// Firefox only before the browser matrix), and Player start still resets the scene.
test('player bump pushes the training plant without pausing, and Player start resets', async ({page}) => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${BASE}/?debug=1`);
  await page.waitForFunction(()=>window.deusExViewer?.status().gameplay?.player.grounded);
  const initial=await page.evaluate(()=>window.deusExViewer.status().gameplay.player.position);
  const plant=()=>page.evaluate(async()=>(await window.deusExViewer.liveProbe({read:{names:['Plant7'],props:['Location']}})).read.Plant7.Location);
  const placed=await plant();
  await page.locator('#scene').click();
  await page.keyboard.down('KeyW');await page.keyboard.down('KeyD');
  // Walk into the plant. Wait until it moves or a runtime error appears, so the
  // wait cannot hang; the assertions below require the push and forbid the old pause.
  await expect.poll(async()=>(await page.evaluate(()=>window.deusExViewer.status().runtimeError))||(await plant()).some((v,i)=>v!==placed[i]),{timeout:20000}).toBeTruthy();
  await page.keyboard.up('KeyW');await page.keyboard.up('KeyD');
  const pushed=await page.evaluate(()=>window.deusExViewer.status());
  expect(pushed.runtimeError,pushed.runtimeError?.message).toBeNull();
  expect(pushed.paused).toBe(false);
  expect(await plant()).not.toEqual(placed);
  // The browser keeps rendering after the contact.
  await page.waitForFunction(frame=>window.deusExViewer.status().frame>frame,pushed.frame);
  // Player start resets the scene to the original spawn.
  await page.locator('#tools-options').click();
  await page.getByRole('button',{name:'Player start',exact:true}).click();
  await page.waitForFunction(()=>window.deusExViewer.status().gameplay.player.grounded);
  const reset=await page.evaluate(()=>window.deusExViewer.status());
  expect(reset.runtimeError).toBeNull();
  await expect.poll(()=>page.evaluate(()=>window.deusExViewer.status().gameplay.player.position)).toEqual(initial);
  expect(errors).toEqual([]);
});

// The reported live-play symptom: after the second Training DataLink the door
// stopped responding to use. The DataLink lifecycle was not at fault — walking
// on past the first door reached OrdersTrigger2, whose original Touch calls
// Destroy(). That request had no live world services and paused Play, and a
// paused session ignores every later input, door use included.
// docs/script-world-destroy.md, scripts/validate-world-destroy.mjs.
test('the training route past the first door destroys its one-shot trigger and keeps Play responsive', async ({page}) => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${BASE}/?debug=1`);
  await page.waitForFunction(()=>window.deusExViewer?.status().gameplay?.player.grounded);
  const status=()=>page.evaluate(()=>window.deusExViewer.status());
  await page.locator('#scene').click({position:{x:500,y:350}});
  // Walk to the first door, use it, and keep walking through the corridor where
  // the trigger stands. The first DataLink starts on the way; the second starts
  // from the queue while the player is past the door.
  await page.keyboard.down('KeyW');
  await page.waitForFunction(()=>{
    const s=window.deusExViewer.status();
    return Boolean(s.runtimeError)||s.gameplay.player.position[0]>-243;
  },null,{timeout:30000});
  await page.locator('#scene').click({position:{x:500,y:350},button:'right'});   // DefUser.ini: RightMouse=ParseRightClick (use); F is CenterView
  // The door's original DeusExMover.Frob opens it (gameplay.spec.mjs reads the same mover); the old page-side use counter is gone.
  await expect.poll(async()=>(await status()).gameplay.doors.movers.find(m=>m.name==='DeusExMover16').alpha,{timeout:5000}).toBe(1);
  await page.waitForFunction(()=>{
    const s=window.deusExViewer.status();
    return Boolean(s.runtimeError)||s.gameplay.player.position[0]>300;
  },null,{timeout:30000});
  await page.keyboard.up('KeyW');
  const past=await status();
  expect(past.runtimeError,past.runtimeError?.message).toBeNull();
  // Two DataLink transmissions have run by now; the door is still usable.
  await expect.poll(async()=>(await page.locator('#infolink-title').textContent()),{timeout:30000})
    .toContain('END TRANSMISSION');
  // Input still drives the session after both transmissions and the destruction:
  // a paused runtime is exactly what made the door stop answering use.
  const parked=(await status()).gameplay.player.position[0];
  await page.keyboard.down('KeyS');
  await page.waitForFunction(start=>{
    const s=window.deusExViewer.status();
    return Boolean(s.runtimeError)||s.gameplay.player.position[0]<start-100;
  },parked,{timeout:30000});
  await page.keyboard.up('KeyS');
  const after=await status();
  expect(after.runtimeError,after.runtimeError?.message).toBeNull();
  expect(after.paused).toBe(false);
  // Use still runs rather than being swallowed by a paused session.
  await page.locator('#scene').click({position:{x:500,y:350},button:'right'});
  const used=await status();
  expect(used.runtimeError,used.runtimeError?.message).toBeNull();
  expect(errors).toEqual([]);
});
