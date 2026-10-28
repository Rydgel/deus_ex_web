import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import { BASE } from './browsers.mjs';

// A walk from the Training spawn with the original default keys (DefUser.ini): W walks, the right mouse button uses
// (RightMouse=ParseRightClick; F is CenterView), 0 takes the key ring (ActivateBelt 0) and Enter is ParseLeftClick|Fire. The view is
// turned through the simulation's place probe (a ViewRotation, as the mouse would leave it); the frob target, the key list, a door's
// lock and the flags are read through its live probe, the doors through status(). The player's place is the simulation's own
// (viewProbe, answered after the frames posted before it): in worker mode status() carries the game status of every 15th post, and a
// walk stopped on it overshoots by a hundred units or more. Before the simulation worker this spec patched main.mjs to read the page's
// own game.
test('Training spawn walk opens the spawn door and the Train key door',async({page})=>{
 test.setTimeout(180000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${BASE}/?debug=1`);
 await page.waitForFunction(()=>window.deusExViewer?.status().gameplay?.player.grounded);
 await page.waitForTimeout(500);
 const status=()=>page.evaluate(()=>window.deusExViewer.status());
 const pos=()=>page.evaluate(async()=>(await window.deusExViewer.viewProbe({})).location);
 const read=async(name,prop)=>(await page.evaluate(async([name,prop])=>(await window.deusExViewer.liveProbe({read:{names:[name],props:[prop]}})).read,[name,prop]))[name]?.[prop]??null;
 const frob=()=>read('@player','FrobTarget');
 const door=async name=>(await status()).gameplay.doors.movers.find(m=>m.name===name).alpha;
 const hold=async(key,until)=>{await page.keyboard.down(key);try{await expect.poll(until,{timeout:20000}).toBe(true);}finally{await page.keyboard.up(key);}};
 // The player's view toward a point, from the eye.
 const lookAt=async(x,y,z)=>{
  const at=await pos(),eye=[at[0],at[1],at[2]+(await read('@player','EyeHeight'))],units=r=>(Math.round(r*32768/Math.PI)+65536)%65536;
  await page.evaluate(rotation=>window.deusExViewer.placeProbe({rotation}),[units(Math.atan2(z-eye[2],Math.hypot(x-eye[0],y-eye[1]))),units(Math.atan2(y-eye[1],x-eye[0])),0]);
  await page.waitForTimeout(150);
 };
 const sweep=async(name,x,y,z)=>{
  for(const degrees of [0,4,-4,8,-8,12,-12,16,-16,20,-20]){
   const at=await pos(),eye=[at[0],at[1],at[2]+(await read('@player','EyeHeight'))],units=r=>(Math.round(r*32768/Math.PI)+65536)%65536;
   const yaw=Math.atan2(y-eye[1],x-eye[0])+degrees*Math.PI/180,pitch=Math.atan2(z-eye[2],Math.hypot(x-eye[0],y-eye[1]));
   await page.evaluate(rotation=>window.deusExViewer.placeProbe({rotation}),[units(pitch),units(yaw),0]);
   await page.waitForTimeout(250);
   if(await frob()===name)return;
  }
  throw new Error(`no view toward (${x}, ${y}, ${z}) selects ${name}; the frob target is ${await frob()}`);
 };
 const use=()=>page.locator('#scene').click({position:{x:720,y:420},button:'right'});
 const spawn=await pos();
 expect(spawn[0]).toBeLessThan(-1000);
 await mkdir('reports/training-walk',{recursive:true});
 await page.screenshot({path:'reports/training-walk/spawn.png'});
 await page.locator('#scene').click({position:{x:720,y:420}});
 await hold('KeyW',async()=>(await pos())[0]>-700);
 const mid=await pos();
 expect(mid[0]-spawn[0]).toBeGreaterThan(400);
 await page.screenshot({path:'reports/training-walk/mid-corridor.png'});
 await hold('KeyW',async()=>{const p=await pos(),v=await read('@player','Velocity');return p[0]>-260&&Math.hypot(v[0],v[1])<5;});
 expect(await frob()).toBe('DeusExMover16');
 await use();
 await expect.poll(async()=>[await door('DeusExMover16'),await door('DeusExMover17')],{timeout:8000}).toEqual([1,1]);
 await page.screenshot({path:'reports/training-walk/door-open.png'});
 await hold('KeyW',async()=>(await pos())[0]>500);
 // straight at the key on the desk (415, 1072), until it is in reach (MaxFrobDistance 112 from the eye) or selected
 await lookAt(415,1072,-145);
 await hold('KeyW',async()=>{const p=await pos();return (await frob())==='NanoKey0'||Math.hypot(p[0]-415,p[1]-1072)<90;});
 // stopped, then the view on the key itself, until the original's frob trace selects it (the desk lamp behind it is selected from
 // other places)
 await expect.poll(async()=>{const v=await read('@player','Velocity');return Math.hypot(v[0],v[1]);}).toBeLessThan(1);
 await page.evaluate(()=>window.deusExViewer.placeProbe({lookAt:'NanoKey0'}));
 await expect.poll(frob,{timeout:4000}).toBe('NanoKey0');
 await use();
 await expect.poll(()=>read('@player.KeyList','KeyID'),{timeout:4000}).toBe('Train');
 await page.screenshot({path:'reports/training-walk/key.png'});
 await page.keyboard.press('Digit0');
 await lookAt(586,826,-144);
 await hold('KeyW',async()=>{const p=await pos();return p[0]>540&&p[1]<900;});
 await lookAt(384,640,-112);
 await hold('KeyW',async()=>(await frob())==='DeusExMover47'||(await pos())[0]<400);
 // stopped at the trainer's door, the view swept across it until the original's frob trace selects its panel DeusExMover47
 // (DeusExMover48 beside it is selected from some places), as a player turns the mouse until the door is highlighted
 await expect.poll(async()=>{const v=await read('@player','Velocity');return Math.hypot(v[0],v[1]);}).toBeLessThan(1);
 await sweep('DeusExMover47',384,576,-80);
 await page.keyboard.press('Enter');
 await expect.poll(()=>read('DeusExMover47','bLocked')).toBeFalsy();
 await use();
 await expect.poll(()=>door('DeusExMover47'),{timeout:8000}).toBe(1);
 await page.screenshot({path:'reports/training-walk/trainer-door.png'});
 const flags=await page.evaluate(async()=>(await window.deusExViewer.liveProbe({flags:{}})).flags.entries);
 expect(flags.find(entry=>entry.name==='MunitionsTrooperReady')?.value??0).toBe(0);
 expect((await status()).runtimeError).toBeNull();
 expect(errors).toEqual([]);
});
