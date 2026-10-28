import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import { BASE } from './browsers.mjs';

// The Training instructor (UNATCOTroop3) by ordinary use. The only setup is the simulation's place probe, which puts the player in
// front of him and aims (it sets no frob target, flag, label or timer; the original HighlightCenterObject query selects him). The use is
// the right mouse button (DefUser.ini RightMouse=ParseRightClick; F is CenterView). What the conversation does is read through the
// simulation's probes, in either simulation mode (sim-worker.mjs `call`, or the page inline): conversationProbe for the conversation and
// its speech, liveProbe for the frob target and the flags.
// Before the simulation worker this spec patched main.mjs and read the page's own game; the subtitle window's tree and the speech's
// decoded sample it read that way are checked headless by scripts/validate-instructor-conversation.mjs, not here.
test('ordinary use plays the instructor, terminates, takes the second route after FlagTrigger, and survives Player start',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${BASE}/?debug=1`);
 await page.waitForFunction(()=>window.deusExViewer?.status().gameplay?.player.grounded);
 const read=(names,props)=>page.evaluate(async([names,props])=>(await window.deusExViewer.liveProbe({read:{names,props}})).read,[names,props]);
 const conversation=()=>page.evaluate(async()=>{
  const {conPlay}=await window.deusExViewer.conversationProbe({});
  return conPlay&&{con:conPlay.con,speaker:conPlay.event?.speaker??null,text:conPlay.event?.text??null};
 });
 const flag=name=>page.evaluate(async name=>(await window.deusExViewer.liveProbe({flags:{}})).flags.entries.find(entry=>entry.name===name)?.value??0,name);
 const error=()=>page.evaluate(()=>window.deusExViewer.status().runtimeError);
 await expect.poll(async()=>(await read(['UNATCOTroop3'],['bCanConverse'])).UNATCOTroop3.bCanConverse,{timeout:20000}).toBeTruthy();   // (a bool reads as 1)
 const troop=(await read(['UNATCOTroop3'],['Location'])).UNATCOTroop3.Location;
 // In front of him, aimed at him, until the original's frob trace selects him.
 const face=async offset=>{
  await page.evaluate(([at])=>window.deusExViewer.placeProbe({location:at,lookAt:'UNATCOTroop3'}),[troop.map((v,i)=>v+offset[i])]);
  await expect.poll(async()=>(await read(['@player'],['FrobTarget']))['@player'].FrobTarget,{timeout:5000}).toBe('UNATCOTroop3');
 };
 const use=()=>page.locator('#scene').click({position:{x:600,y:350},button:'right'});
 await page.locator('#scene').click({position:{x:600,y:350}});
 await page.waitForTimeout(2500);
 expect(await page.evaluate(()=>window.deusExViewer.status().mode)).toBe('play');

 // 1. The greeting: his speech, then the conversation ends by itself.
 await face([-80,0,0]);await use();
 await expect.poll(async()=>(await conversation())?.con??null).toBeTruthy();
 await expect.poll(async()=>(await conversation())?.speaker??null,{timeout:8000}).toBe('UNATCOTroop3');
 expect((await conversation())?.text?.length??0).toBeGreaterThan(0);
 await mkdir('reports/instructor',{recursive:true});await page.screenshot({path:'reports/instructor/greeting.png'});
 await expect.poll(conversation,{timeout:15000}).toBeNull();
 expect(await error()).toBeNull();
 expect((await page.evaluate(()=>window.deusExViewer.status().npcPreview.actors.filter(a=>a.actor.startsWith('UNATCO')).length))).toBe(4);

 // 2. Natural movement through FlagTrigger.Touch sets MunitionsTrooperReady, and use then takes the second route.
 await page.evaluate(([at])=>window.deusExViewer.placeProbe({location:at,rotation:[0,0,0]}),[troop.map((v,i)=>v+[-333,-60,40][i])]);
 await page.waitForTimeout(700);
 await page.keyboard.down('KeyW');
 try{await expect.poll(()=>flag('MunitionsTrooperReady'),{timeout:20000}).toBe(1);}finally{await page.keyboard.up('KeyW');}
 await page.waitForTimeout(1100);   // past the original 1 s repeat gate
 await face([-80,0,0]);await use();
 await expect.poll(async()=>(await conversation())?.con??null).toBe('MunitionsTrooperTake');
 await page.screenshot({path:'reports/instructor/surrender.png'});
 await expect.poll(conversation,{timeout:20000}).toBeNull();
 await page.waitForTimeout(1100);await use();
 await expect.poll(async()=>(await conversation())?.con??null).toBeTruthy();

 // 3. Player start ends the conversation and starts over; the instructor speaks again.
 await page.locator('#tools-options').click();
 await page.getByRole('button',{name:'Player start',exact:true}).click();
 await page.waitForFunction(()=>window.deusExViewer.status().gameplay?.player.grounded);
 await expect.poll(conversation).toBeNull();
 expect(await error()).toBeNull();
 await page.waitForTimeout(2500);
 await face([-80,0,0]);await use();
 await expect.poll(async()=>(await conversation())?.con??null).toBeTruthy();
 await expect.poll(conversation,{timeout:15000}).toBeNull();
 expect(await error()).toBeNull();
 expect(errors).toEqual([]);
});
