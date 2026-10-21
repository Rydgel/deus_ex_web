import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

test('Training spawn walk opens the spawn door and the Train key door',async({page})=>{
 test.setTimeout(180000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/src/viewer/main.mjs*',async route=>{
  const response=await route.fetch();
  await route.fulfill({response,body:(await response.text()).replace('window.deusExViewer = { status };',`window.deusExViewer = { status };\nwindow.__walkFixture={
   pos:()=>window.deusExViewer.status().gameplay.player.position.slice(),
   frob:()=>game.interaction.frobTarget?.name??null,
   key:(name)=>game.collision.movers.find(m=>m.name===name).interpolation.key,
   locked:(name)=>game.doors.scriptRuntime.runtime.namedReference(game.doors.scriptRuntime.runtime.levelFor(game.player.collisionActor).actors.find(a=>a?.name===name),'bLocked').get(),
   train:()=>{const r=game.doors.scriptRuntime.runtime,p=game.player.collisionActor,k=r.namedReference(p,'KeyList').get();return k?r.namedReference(k,'KeyID').get():null;},
   ready:()=>game.doors.scriptRuntime.runtime.namedReference(game.player.collisionActor,'flagBase').get().getBool('MunitionsTrooperReady'),
   failures:()=>[...game.doors.scriptRuntime.npcFailures.values()],
   error:()=>window.deusExViewer.status().runtimeError,
  };\n`)});
 });
 await page.goto('http://127.0.0.1:5173/?debug=1');
 await page.waitForFunction(()=>window.__walkFixture&&window.deusExViewer.status().gameplay?.player.grounded);
 await page.waitForTimeout(500);
 const read=()=>page.evaluate(()=>window.__walkFixture.pos());
 const spawn=await read();
 expect(spawn[0]).toBeLessThan(-1000);
 await mkdir('reports/training-walk',{recursive:true});
 await page.screenshot({path:'reports/training-walk/spawn.png'});
 await page.locator('#scene').click({position:{x:720,y:420}});
 const hold=async(key,until)=>{
  await page.keyboard.down(key);
  await page.waitForFunction(until,null,{timeout:20000});
  await page.keyboard.up(key);
 };
 await hold('KeyW',()=>window.__walkFixture.pos()[0]>-700);
 const mid=await read();
 expect(mid[0]-spawn[0]).toBeGreaterThan(400);
 await page.screenshot({path:'reports/training-walk/mid-corridor.png'});
 await hold('KeyW',()=>window.__walkFixture.pos()[0]>-260&&Math.hypot(window.deusExViewer.status().gameplay.player.velocity[0],window.deusExViewer.status().gameplay.player.velocity[1])<5);
 expect(await page.evaluate(()=>window.__walkFixture.frob())).toBe('DeusExMover16');
 await page.keyboard.press('KeyF');
 await page.waitForFunction(()=>window.__walkFixture.key('DeusExMover16')===1&&window.__walkFixture.key('DeusExMover17')===1,{timeout:8000});
 await page.screenshot({path:'reports/training-walk/door-open.png'});
 await hold('KeyW',()=>window.__walkFixture.pos()[0]>500);
 await lookAt(page,415,1072,-145);
 await hold('KeyW',()=>window.__walkFixture.pos()[1]>1040);
 await lookAt(page,415,1072,-145);
 await hold('KeyW',()=>window.__walkFixture.frob()==='NanoKey0'||window.__walkFixture.pos()[0]<470);
 await lookAt(page,415,1072,-145);
 await page.waitForTimeout(250);
 await page.keyboard.press('KeyF');
 await expect.poll(()=>page.evaluate(()=>window.__walkFixture.train()),{timeout:4000}).toBe('Train');
 await page.screenshot({path:'reports/training-walk/key.png'});
 await page.keyboard.press('Digit1');
 await lookAt(page,586,826,-144);
 await hold('KeyW',()=>window.__walkFixture.pos()[0]>540&&window.__walkFixture.pos()[1]<900);
 await lookAt(page,384,640,-112);
 await hold('KeyW',()=>window.__walkFixture.frob()==='DeusExMover47'||window.__walkFixture.pos()[0]<400);
 await lookAt(page,384,576,-80);
 await page.keyboard.press('Enter');
 await expect.poll(()=>page.evaluate(()=>window.__walkFixture.locked('DeusExMover47'))).toBe(false);
 await page.keyboard.press('KeyF');
 await page.waitForFunction(()=>window.__walkFixture.key('DeusExMover47')===1,{timeout:8000});
 await page.screenshot({path:'reports/training-walk/trainer-door.png'});
 expect(await page.evaluate(()=>window.__walkFixture.ready())).toBe(false);
 expect(await page.evaluate(()=>window.__walkFixture.failures())).toEqual([]);
 expect(await page.evaluate(()=>window.__walkFixture.error())).toBeNull();
 expect(errors).toEqual([]);
});

function wrap(angle){while(angle>Math.PI)angle-=Math.PI*2;while(angle<-Math.PI)angle+=Math.PI*2;return angle;}
async function aimAxis(page,index,target){
 for(let i=0;i<10;i++){
  const current=(await page.evaluate(()=>window.deusExViewer.status().rotation))[index];
  const delta=wrap(target-current);
  if(Math.abs(delta)<0.12)return;
  if(index===1)await turn(page,-delta,0);else await turn(page,0,-delta);
 }
 throw new Error(`camera axis ${index} stayed at ${(await page.evaluate(()=>window.deusExViewer.status().rotation))[index]}`);
}
async function lookAt(page,x,y,z){
 const pos=await page.evaluate(()=>window.__walkFixture.pos());
 const eyeZ=pos[2]+40;
 const cameraYaw=-Math.atan2(y-pos[1],x-pos[0]);
 const pitch=Math.atan2(z-eyeZ,Math.hypot(x-pos[0],y-pos[1]));
 await aimAxis(page,1,cameraYaw);
 await aimAxis(page,0,pitch);
}
async function turn(page, radians, pitch=0){
 // Camera yaw falls as movementX grows; player yaw is the negation of camera yaw.
 // Positive radians turns the player left. Positive pitch looks down.
 const dx=Math.round(radians/0.0025);
 const dy=Math.round(pitch/0.0025);
 const box=await page.locator('#scene').boundingBox();
 const x=box.x+box.width/2, y=box.y+box.height/2;
 await page.mouse.move(x,y);
 await page.mouse.down();
 await page.mouse.move(x+dx,y+dy,{steps:6});
 await page.mouse.up();
 await page.waitForTimeout(100);
}
