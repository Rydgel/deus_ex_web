import test from 'node:test';
import assert from 'node:assert/strict';
import {runPlayerPhysics} from '../src/runtime/player-physics.mjs';

// Integration checks only. Original numerical evidence belongs to the separate
// walking, falling, landing, query and callback native corpora.
function fixture(){
 const world={name:'$world',lineage:['engine.levelinfo']};let moves=0;
 const player={position:[0,0,100],velocity:[0,0,-100],grounded:false,radius:20,height:43,bodyRotation:[0,0,0],
  defaults:{AccelRate:2048,AirControl:.1,MaxStepHeight:25,Mass:150,bCanJump:true},unimplementedPhysicsEffects:new Set(),
  textureForHit:()=>null,collision:{queries:{levelInfo:world,lineCheck:()=>({time:.22,normal:[0,0,1],location:[0,0,0],actor:world})}},
  move(delta){moves++;this.position=this.position.map((v,i)=>Math.fround(v+delta[i]*.5));return {time:.5,hit:{normal:[0,0,1],actor:world}};}};
 return {player,world,moves:()=>moves};
}
const input={acceleration:[0,0,0],groundSpeed:320,isWalking:false,zone:{}};
test('landing continues walking on the same pawn and supplies walking OldLocation',()=>{
 const {player,world,moves}=fixture();
 const oldZ=runPlayerPhysics(player,.05,input),pawn=player.physicsPawn;
 assert.equal(moves(),1);assert.equal(player.grounded,true);assert.equal(pawn.base,world);
 assert.equal(player.justLanded,true);assert.equal(player.velocity[2],0);
 assert.equal(oldZ,player.position[2]);assert.notEqual(oldZ,100);
 runPlayerPhysics(player,1/120,input);assert.equal(player.physicsPawn,pawn);
 assert.equal(pawn.worldActor,world);
 pawn.acceleration=[1,0,0];pawn.destination=[pawn.position[0]-100,pawn.position[1],pawn.position[2]];
 pawn.hitWall({normal:[1,0,0],actor:world});
 assert.equal(pawn.moveTimer,-1);assert.equal(pawn.pawnFlags&0x100000,0x100000);
});
test('unsupported landing relocation fails before inventing movement or randomness',()=>{
 const {player}=fixture();
 player.collision.queries.lineCheck=()=>({time:1,normal:[0,0,0],actor:null});
 player.collision.findSpot=position=>position.map((v,i)=>v+(i===0?1:0));
 assert.throws(()=>runPlayerPhysics(player,.05,input),/FarMoveActor/);
});
