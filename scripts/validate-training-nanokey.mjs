/** Training opening: real movement, the unlocked spawn door, then the Train nano key.
 * No teleport and no host-cleared lock. The munitions instructor is not on
 * the far side of this door. See docs/script-nanokey.md. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1});
const runtime=game.doors.scriptRuntime.runtime;
// Player start logs in a new player; re-read it after every reset.
let pawn=game.player.collisionActor;
const get=(object,key)=>runtime.namedReference(object,key).get();
const level=()=>runtime.levelFor(pawn);
const idle={forward:0,right:0,yaw:0,pitch:0,jump:false,crouch:false,walk:false};
const move=(yaw,forward=1,pitch=0)=>({forward,right:0,yaw,pitch,jump:false,crouch:false,walk:false});
const tick=input=>game.tick(1/60,input);
const place=()=>game.player.position.map(value=>Math.round(value));

assert.equal(game.start.name,'PlayerStart1');
assert.equal(get(pawn,'flagBase').getBool('MunitionsTrooperReady'),false);
const ring=get(pawn,'KeyRing');
assert.equal(runtime.instance(ring).cls.record.key,'deusex.nanokeyring');
assert.equal(get(ring,'Owner'),pawn);
assert.equal(get(pawn,'KeyList'),null);

const samples=[];
let still=0,frames=0;
while(still<18&&frames<400){
  const before=game.player.position[0];
  tick(move(0));
  frames++;
  if(frames%30===0)samples.push(game.player.position[0]);
  if(Math.abs(game.player.position[0]-before)<0.05)still++;else still=0;
}
assert.ok(samples.length>=4,'the walk to the spawn door lasts more than a step');
for(let index=1;index<samples.length;index++)
  assert.ok(samples[index]-samples[index-1]>20,`sustained east travel stalled at sample ${index}`);
assert.ok(game.player.position[0]-game.player.start[0]>800,'forward input reaches the spawn door');
assert.equal(game.interaction.frobTarget?.name,'DeusExMover16');
const opened=game.use();
assert.equal(opened.ok,true,'right click runs ParseRightClick -> DoFrob -> DeusExMover.Frob');
for(let index=0;index<150;index++)tick(idle);
for(const name of ['DeusExMover16','DeusExMover17'])
  assert.equal(game.collision.movers.find(mover=>mover.name===name).interpolation.key,1,`${name} finishes opening`);

function blocked(axis,yaw){
  let stuck=0,count=0;
  while(stuck<18&&count<800){
    const value=game.player.position[axis];
    tick(move(yaw));
    count++;
    if(Math.abs(game.player.position[axis]-value)<0.05)stuck++;else stuck=0;
  }
}
blocked(0,0);
const corridor=place();
assert.ok(corridor[0]>500,'after the spawn door the corridor continues east');
blocked(1,Math.PI/2);
blocked(0,Math.PI);
const key=level().actors.find(actor=>actor?.name==='NanoKey0');
const keyLocation=get(key,'Location');
const beside=game.player.position;
const yaw=Math.atan2(keyLocation[1]-beside[1],keyLocation[0]-beside[0]);
const pitch=Math.atan2(keyLocation[2]-(beside[2]+game.player.baseEyeHeight),
  Math.hypot(keyLocation[0]-beside[0],keyLocation[1]-beside[1]));
for(let index=0;index<12;index++)tick(move(yaw,0,pitch));
assert.equal(game.interaction.frobTarget,key,'the view trace selects NanoKey0');
assert.equal(game.use().ok,true);
const info=get(pawn,'KeyList');
assert.equal(get(info,'KeyID'),'Train');
assert.equal(get(info,'Description'),'Trainer Door');
assert.equal(get(info,'NextKey'),null);
assert.equal(level().actors.includes(key),false,'ParseRightClick destroys the world key');
assert.equal(game.selectNanoKeyRing(),true);
assert.equal(get(pawn,'inHand'),ring);

blocked(0,0);
while(game.player.position[1]>840)tick(move(-Math.PI/2));
for(let index=0;index<70;index++)tick(move(-2.4));
const trainer=level().actors.find(actor=>actor?.name==='DeusExMover47');
const other=level().actors.find(actor=>actor?.name==='DeusExMover48');
const doorLocation=get(trainer,'Location');
const stand=game.player.position;
const doorYaw=Math.atan2(doorLocation[1]-stand[1],doorLocation[0]-stand[0]);
const doorPitch=Math.atan2(doorLocation[2]-(stand[2]+game.player.baseEyeHeight),
  Math.hypot(doorLocation[0]-stand[0],doorLocation[1]-stand[1]));
for(let index=0;index<12;index++)tick(move(doorYaw,0,doorPitch));
assert.equal(game.interaction.frobTarget,trainer);
assert.equal(get(trainer,'bLocked'),true);
// Enter/LeftMouse is `ParseLeftClick|Fire`: ParseLeftClick's DoFrob(Self,
// inHand) branch sends the ring to DeusExMover.Frob.
game.pressFire();game.releaseFire();
assert.equal(get(trainer,'bLocked'),false);
assert.equal(get(other,'bLocked'),false,'the original tag fanout unlocks both panels');
assert.equal(get(pawn,'flagBase').getBool('MunitionsTrooperReady'),false);
for(let index=0;index<8;index++)tick(move(doorYaw,0,doorPitch));
const opening=game.use();
assert.equal(opening.ok,true,'right click runs ParseRightClick -> DoFrob -> DeusExMover.Frob');
for(let index=0;index<150;index++)tick(idle);
for(const name of ['DeusExMover47','DeusExMover48'])
  assert.equal(game.collision.movers.find(mover=>mover.name===name).interpolation.key,1);
assert.equal(game.doors.scriptRuntime.npcFailures.size,0);

game.reset();pawn=game.player.collisionActor;
assert.equal(get(pawn,'KeyList'),null);
assert.notEqual(get(pawn,'KeyRing'),ring);
assert.equal(get(get(pawn,'KeyRing'),'Owner'),pawn);
assert.equal(level().actors.some(actor=>actor?.name==='NanoKey0'),true,'Player start restores the map key');
assert.equal(get(level().actors.find(actor=>actor?.name==='DeusExMover47'),'bLocked'),true);

console.log(`Training nano key passed: ${frames} frames and ${Math.round(game.player.start[0]*-1+samples.at(-1))}u east to the spawn door, Train entered the ring, and the trainer door unlocked and opened. The munitions instructor flag stayed false.`);
