import test from 'node:test';
import assert from 'node:assert/strict';
import {moverBlockedBy} from '../src/runtime/check-encroachment.mjs';
import {moveTranslatingMover} from '../src/runtime/mover-move.mjs';
test('original Brush predicate accepts ordinary targets and distinguishes controlled players',()=>{
 const mover={movingBrush:true,flags:4};
 assert.equal(moverBlockedBy(mover,{flags:0}),false);
 assert.equal(moverBlockedBy(mover,{flags:2}),true);
 assert.equal(moverBlockedBy(mover,{flags:2,controlledPlayer:true}),false);
 assert.equal(moverBlockedBy(mover,{flags:2,projectile:true}),true);
 assert.equal(moverBlockedBy({...mover,flags:2},{movingBrush:true,flags:4}),true);
});
test('nonblocking original trigger candidates do not invoke mover push',()=>{
 const mover={movingBrush:true,movable:true,collideActors:true,blockActors:true,blockPlayers:true,position:[0,0,0],rotation:[0,0,0]};
 assert.equal(moveTranslatingMover(mover,[1,0,0],{encroachmentCheck:()=>[{isPawn:false,flags:1}],moveSmooth:()=>assert.fail('nonblocking trigger pushed'),dispatch:()=>assert.fail('nonblocking trigger notified'),removeActor:()=>{},addActor:()=>{}}),true);
 assert.deepEqual(mover.position,[1,0,0]);
});
