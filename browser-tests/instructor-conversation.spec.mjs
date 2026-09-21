import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

test('ordinary use renders and plays the instructor, terminates, and survives Player start',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 // Test-only access for scene setup/observations. The shipped app keeps its
 // read-only diagnostics; all interaction is the real F key and simulation.
 await page.route('**/src/viewer/main.mjs*',async route=>{
  const response=await route.fetch();
  await route.fulfill({response,body:(await response.text()).replace('window.deusExViewer = { status };',`window.deusExViewer = { status };\nwindow.__instructorFixture={
   game:()=>game, audio:()=>[...conversationAudio.values()].map(e=>Boolean(e.source)),
   aim(){yaw=0;pitch=-.3;camera.rotation.set(pitch,yaw,0);},
   park(){paused=true;},resume(){paused=false;}
  };\n`)});
 });
 await page.goto('http://127.0.0.1:5173');
 await page.waitForFunction(()=>window.__instructorFixture&&window.deusExViewer.status().gameplay?.player.grounded);
 await page.waitForTimeout(2500);
 const status=()=>page.evaluate(()=>{
  const g=window.__instructorFixture.game(),r=g.doors.scriptRuntime.runtime,p=g.player.collisionActor;
  const read=(o,k)=>r.namedReference(o,k).get(),c=read(p,'conPlay');
  return {error:window.deusExViewer.status().runtimeError,active:Boolean(c),
   name:c?read(read(c,'con'),'conName'):null,audio:window.__instructorFixture.audio(),
   guards:window.deusExViewer.status().npcPreview.actors.filter(a=>a.actor.startsWith('UNATCO')).length,
   failures:[...g.doors.scriptRuntime.npcFailures.values()]};
 });
 const aim=()=>page.evaluate(()=>{
  const f=window.__instructorFixture,g=f.game(),r=g.doors.scriptRuntime.runtime,p=g.player.collisionActor;
  const t=r.levelFor(p).actors.find(a=>a?.name==='UNATCOTroop3'),loc=r.namedReference(t,'Location').get();
  g.collision.queries.changeActor(p,()=>{g.player.position=[loc[0]-80,loc[1],loc[2]];g.player.velocity=[0,0,0];});f.aim();
 });
 await aim();await page.locator('#scene').click({position:{x:600,y:350}});
 await page.waitForTimeout(300);await page.keyboard.press('KeyF');
 await expect.poll(async()=>(await status()).active).toBe(true);
 await expect.poll(async()=>(await status()).audio).toContain(true);
 await mkdir('reports/instructor',{recursive:true});await page.screenshot({path:'reports/instructor/greeting.png'});
 await expect.poll(async()=>(await status()).active,{timeout:10000}).toBe(false);
 expect(await status()).toMatchObject({error:null,guards:4,failures:[]});
 // Natural movement through FlagTrigger.Touch selects the second route.
 await page.evaluate(()=>{
  const f=window.__instructorFixture,g=f.game(),r=g.doors.scriptRuntime.runtime,p=g.player.collisionActor;
  const t=r.levelFor(p).actors.find(a=>a?.name==='UNATCOTroop3'),v=r.namedReference(t,'Location').get();
  g.collision.queries.changeActor(p,()=>{g.player.position=[v[0]-333,v[1]-60,v[2]+40];g.player.velocity=[0,0,0];});
 });
 await page.waitForTimeout(700);await page.keyboard.down('KeyW');
 await page.waitForFunction(()=>{
  const g=window.__instructorFixture.game();return g.doors.scriptRuntime.runtime.namedReference(g.player.collisionActor,'flagBase').get().getBool('MunitionsTrooperReady');
 });
 await page.keyboard.up('KeyW');await aim();await page.waitForTimeout(300);await page.keyboard.press('KeyF');
 await expect.poll(async()=>(await status()).name).toBe('MunitionsTrooperTake');
 await expect.poll(async()=>(await status()).audio).toContain(true);
 await page.screenshot({path:'reports/instructor/surrender.png'});
 await expect.poll(async()=>(await status()).active,{timeout:15000}).toBe(false);
 await page.waitForTimeout(1100);await page.keyboard.press('KeyF');
 await expect.poll(async()=>(await status()).active).toBe(true);
 await page.getByRole('button',{name:'Player start',exact:true}).click();
 expect(await status()).toMatchObject({active:false,audio:[],error:null,failures:[]});
 await page.waitForTimeout(2500);await aim();await page.locator('#scene').click({position:{x:600,y:350}});
 await page.waitForTimeout(300);await page.keyboard.press('KeyF');
 await expect.poll(async()=>(await status()).active).toBe(true);
 await expect.poll(async()=>(await status()).active,{timeout:10000}).toBe(false);
 expect(errors).toEqual([]);expect((await status()).error).toBeNull();
});
