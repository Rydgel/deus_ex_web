import test from 'node:test';
import assert from 'node:assert/strict';
import {Player} from '../src/runtime/player.mjs';
import {runPlayerPhysics} from '../src/runtime/player-physics.mjs';
import {farMoveActor} from '../src/runtime/relocation.mjs';
// Integration regression: native bit stores are established by walking/falling
// and FarMove corpora, not by this adapter-only test.
test('physics clears the same teleport bit read by rejected FarMove, preserving other flags',()=>{
 const player=new Player({findSpot:p=>p.slice(),queries:{levelInfo:{},lineCheck:()=>({time:1,actor:null,normal:[0,0,0]})}},{CollisionRadius:20,CollisionHeight:43,BaseEyeHeight:39,bJustTeleported:true,bMovable:true,bCollideWorld:true,AccelRate:2048,AirControl:.1,MaxStepHeight:25,Mass:150},[0,0,100],()=>({}));
 player.textureForHit=()=>null;
 const source=player.collisionActor;source.actorFlags=0x80000;source.motionFlags=0x80000104;
 player.move=function(delta){this.position=this.position.map((v,i)=>Math.fround(v+delta[i]));return {time:1,hit:null};};
 runPlayerPhysics(player,.01,{acceleration:[0,0,0],groundSpeed:320,isWalking:false,zone:{}});
 const pawn=player.physicsPawn;
 assert.equal(pawn.justTeleported,false);assert.equal(source.motionFlags,0x80000004);
 const rejected=farMoveActor({findSpot:()=>false},source,[50,0,100]);
 assert.equal(rejected,false);pawn.justTeleported=Boolean(source.motionFlags&0x100);
 assert.equal(pawn.justTeleported,false);assert.equal(source.motionFlags,0x80000004);
 const success=farMoveActor({setActorZone(){}},source,[50,0,100],0,1);
 assert.equal(success,true);assert.equal(pawn.justTeleported,true);assert.equal(source.motionFlags,0x80000104);
 pawn.justTeleported=false;assert.equal(source.motionFlags,0x80000004);
 source.motionFlags|=0x100;assert.equal(pawn.justTeleported,true);
});
