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
   park(){paused=true;},resume(){paused=false;},
   subtitlesDefault:()=>subtitlePreference,
   // Read the live original HUDConWindowFirst tree so a hidden or empty panel
   // cannot pass as subtitle rendering. Offsets: windowFlags 48, firstChild 316,
   // nextSibling 328, TextWindow text 360.
   async subtitlePanel(){
    const r=game.doors.scriptRuntime.runtime,p=game.player.collisionActor;
    const c=r.namedReference(p,'conPlay').get();if(!c)return null;
    const win=r.namedReference(c,'conWinFirst').get();if(!win)return null;
    const shell=await game.doors.scriptRuntime.infoLinkShell();if(shell.isDestroyed(win))return null;
    const tile=r.namedReference(win,'lowerConWindow').get(),texts=[];
    for(let ch=shell.readNative(tile,316,'ptr');ch;ch=shell.readNative(ch,328,'ptr'))
     if(r.instance(ch).cls.record.key==='extension.textwindow')texts.push(shell.readNative(ch,360,'string'));
    return {visible:Boolean(shell.readNative(win,48,'u32')&1),texts};
   }
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
 await page.locator('#tools-options').click();
 await page.getByLabel('Preview',{exact:true}).selectOption('instructor');
 await page.waitForFunction(()=>{
  const g=window.__instructorFixture.game(),r=g.doors.scriptRuntime.runtime;
  const t=r.levelFor(g.player.collisionActor).actors.find(a=>a?.name==='UNATCOTroop3');
  return r.namedReference(t,'bCanConverse').get();
 });
 expect(await page.evaluate(()=>window.deusExViewer.status().mode)).toBe('play');
 await page.locator('#scene').click({position:{x:600,y:350}});
 await page.waitForTimeout(300);await page.keyboard.press('KeyF');
 await expect.poll(async()=>(await status()).active).toBe(true);
 await expect.poll(async()=>(await status()).audio).toContain(true);
 // Subtitles default to the installed globalconfig (User.ini bSubtitles=True).
 const panel=()=>page.evaluate(()=>window.__instructorFixture.subtitlePanel());
 expect(await page.evaluate(()=>window.__instructorFixture.subtitlesDefault())).toBe(true);
 // The first-person panel shows the original speaker name and speech text.
 await expect.poll(async()=>{const s=await panel();return s&&s.visible?s.texts[0]:null;},{timeout:8000}).toBe('UNATCO Troop');
 expect((await panel()).texts.slice(1).some(t=>typeof t==='string'&&t.length>0)).toBe(true);
 await mkdir('reports/instructor',{recursive:true});await page.screenshot({path:'reports/instructor/subtitles-on.png'});
 await expect.poll(async()=>(await status()).active,{timeout:10000}).toBe(false);
 expect(await status()).toMatchObject({error:null,guards:4,failures:[]});
 // Toggle the discoverable preference off: the panel hides while speech plays.
 await page.locator('#tools-options').click();
 await page.locator('#diagnostics').click();
 await page.locator('#subtitles').uncheck();
 await page.locator('#close-panel').click();
 await page.waitForTimeout(1200); // past the original 1s repeat gate
 await aim();await page.locator('#scene').click({position:{x:600,y:350}});
 await page.waitForTimeout(300);await page.keyboard.press('KeyF');
 await expect.poll(async()=>(await status()).active).toBe(true);
 await expect.poll(async()=>(await status()).audio).toContain(true);
 let visibleSeen=false;for(let i=0;i<20;i++){const s=await panel();if(s&&s.visible)visibleSeen=true;await page.waitForTimeout(100);}
 expect(visibleSeen).toBe(false);
 await page.screenshot({path:'reports/instructor/subtitles-off.png'});
 await expect.poll(async()=>(await status()).active,{timeout:10000}).toBe(false);
 // Re-enable subtitles so the remaining flow keeps the original preference.
 await page.locator('#tools-options').click();
 await page.locator('#diagnostics').click();
 await page.locator('#subtitles').check();
 await page.locator('#close-panel').click();
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
 await page.locator('#tools-options').click();
 await page.getByRole('button',{name:'Player start',exact:true}).click();
 expect(await status()).toMatchObject({active:false,audio:[],error:null,failures:[]});
 await page.waitForTimeout(2500);await aim();await page.locator('#scene').click({position:{x:600,y:350}});
 await page.waitForTimeout(300);await page.keyboard.press('KeyF');
 await expect.poll(async()=>(await status()).active).toBe(true);
 await expect.poll(async()=>(await status()).active,{timeout:10000}).toBe(false);
 expect(errors).toEqual([]);expect((await status()).error).toBeNull();
});
