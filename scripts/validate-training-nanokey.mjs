/** Training opening: real movement, the unlocked spawn door, then the Train nano key.
 * No teleport and no host-cleared lock. The munitions instructor is not on
 * the far side of this door. See docs/script-nanokey.md. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1});
const input=createPlayerInputFixture(game);
const runtime=game.doors.scriptRuntime.runtime;
// Player start logs in a new player; re-read it after every reset.
let pawn=game.player.collisionActor;
const get=(object,key)=>runtime.namedReference(object,key).get();
const level=()=>runtime.levelFor(pawn);
const tick=(frames=1)=>input.tick(frames);
const driveForward=pressed=>input.driveLegacy({forward:pressed?1:0});
async function blocked(axis,yaw){
  input.steer(yaw);let stuck=0,count=0;driveForward(true);
  while(stuck<18&&count<800){const value=game.player.position[axis];tick(1);count++;
    if(Math.abs(game.player.position[axis]-value)<0.05)stuck++;else stuck=0;}
  driveForward(false);assert.ok(count<800,`the route reached its authored wall on axis ${axis}`);
}
const use=()=>game.use();
const place=()=>game.player.position.map(value=>Math.round(value));

assert.equal(game.start.name,'PlayerStart1');
assert.equal(get(pawn,'flagBase').getBool('MunitionsTrooperReady'),false);
const ring=get(pawn,'KeyRing');
assert.equal(runtime.instance(ring).cls.record.key,'deusex.nanokeyring');
assert.equal(get(ring,'Owner'),pawn);
assert.equal(get(pawn,'KeyList'),null);

const samples=[];
let still=0,frames=0;
driveForward(true);
while(still<18&&frames<400){
  const before=game.player.position[0];
  tick(1);
  frames++;
  if(frames%30===0)samples.push(game.player.position[0]);
  if(Math.abs(game.player.position[0]-before)<0.05)still++;else still=0;
}
driveForward(false);
assert.ok(samples.length>=4,'the walk to the spawn door lasts more than a step');
for(let index=1;index<samples.length;index++)
  assert.ok(samples[index]-samples[index-1]>20,`sustained east travel stalled at sample ${index}`);
assert.ok(game.player.position[0]-game.player.start[0]>800,'forward input reaches the spawn door');
assert.equal(game.interaction.frobTarget?.name,'DeusExMover16');
const opened=use();
assert.equal(opened.ok,true,'right click runs ParseRightClick -> DoFrob -> DeusExMover.Frob');
for(let index=0;index<150;index++)tick(1);
for(const name of ['DeusExMover16','DeusExMover17'])
  assert.equal(game.collision.movers.find(mover=>mover.name===name).interpolation.key,1,`${name} finishes opening`);

await blocked(0,0);
const corridor=place();
assert.ok(corridor[0]>500,'after the spawn door the corridor continues east');
await blocked(1,Math.PI/2);
await blocked(0,Math.PI);
const key=level().actors.find(actor=>actor?.name==='NanoKey0');
input.steerAt(key);
for(let index=0;index<12;index++)tick(1);
assert.equal(game.interaction.frobTarget,key,'the view trace selects NanoKey0');
assert.equal(use().ok,true);
const info=get(pawn,'KeyList');
assert.equal(get(info,'KeyID'),'Train');
assert.equal(get(info,'Description'),'Trainer Door');
assert.equal(get(info,'NextKey'),null);
assert.equal(level().actors.includes(key),false,'ParseRightClick destroys the world key');
assert.equal(game.selectNanoKeyRing(),true);
assert.equal(get(pawn,'inHand'),ring);

await blocked(0,0);
input.steer(-Math.PI/2);driveForward(true);
while(game.player.position[1]>840)tick(1);
driveForward(false);
input.steer(-2.4);driveForward(true);tick(70);driveForward(false);
const trainer=level().actors.find(actor=>actor?.name==='DeusExMover47');
const other=level().actors.find(actor=>actor?.name==='DeusExMover48');
input.steerAt(trainer);
for(let index=0;index<12;index++)tick(1);
assert.equal(game.interaction.frobTarget,trainer);
assert.equal(get(trainer,'bLocked'),true);
// Enter/LeftMouse is `ParseLeftClick|Fire`: ParseLeftClick's DoFrob(Self,
// inHand) branch sends the ring to DeusExMover.Frob.
game.inputButton('LeftMouse',true);game.inputButton('LeftMouse',false);
assert.equal(get(trainer,'bLocked'),false);
assert.equal(get(other,'bLocked'),false,'the original tag fanout unlocks both panels');
assert.equal(get(pawn,'flagBase').getBool('MunitionsTrooperReady'),false);
for(let index=0;index<8;index++)tick(1);
const opening=use();
assert.equal(opening.ok,true,'right click runs ParseRightClick -> DoFrob -> DeusExMover.Frob');
for(let index=0;index<150;index++)tick(1);
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
