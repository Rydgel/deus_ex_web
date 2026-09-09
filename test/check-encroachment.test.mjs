import test from 'node:test';
import assert from 'node:assert/strict';
import {checkPlayerEncroachment} from '../src/runtime/check-encroachment.mjs';
import {beginTouch,endTouch,isOverlapping} from '../src/runtime/actor-touch.mjs';
const actor=(id,extra={})=>({id,position:[0,0,0],radius:20,height:43,flags:15,physics:1,isPawn:false,pawnFlags:0,touching:[null,null,null,null],...extra});
const player=()=>actor('s',{controlledPlayer:true,isPawn:true,pawnFlags:2});

test('native CheckEncroachment rejection skips notifications; notify0 retains EncroachedBy',()=>{
 for(const reject of [false,true]){
  const s=player(),a=actor('a'),events=[];
  assert.equal(checkPlayerEncroachment(s,[100,0,0],[0,0,0],0,{encroachmentCheck:()=>[{actor:a}],dispatch:(who,event)=>{events.push([who.id,event]);return reject;}}),reject);
  assert.deepEqual(events,reject?[['s','EncroachingOn']]:[['s','EncroachingOn'],['a','EncroachedBy']]);
 }
});
test('native notify1 removes old touches at current pose before reciprocal new touch',()=>{
 const s=player(),old=actor('old',{position:[500,0,0]}),a=actor('a',{flags:1}),events=[];
 s.touching[0]=old;old.touching[0]=s;
 checkPlayerEncroachment(s,[500,0,0],[0,0,0],1,{encroachmentCheck:()=>[{actor:a}],dispatch:(who,event)=>events.push([who.id,event])});
 assert.deepEqual(events,[['s','UnTouch'],['old','UnTouch'],['s','Touch'],['a','Touch']]);
 assert.equal(s.touching[3],a);assert.equal(a.touching[3],s);assert.deepEqual(old.touching,[null,null,null,null]);
});
test('native callback changes blocking flags before notification pass',()=>{
 const s=player(),a=actor('a'),events=[];
 checkPlayerEncroachment(s,[0,0,0],[0,0,0],1,{encroachmentCheck:()=>[{actor:a}],dispatch:(who,event)=>{events.push(event);if(event==='EncroachingOn')a.flags=1;return false;}});
 assert.deepEqual(events,['EncroachingOn','Touch','Touch']);
});
test('native Touch callback cancellation prevents reciprocal insertion',()=>{
 const s=player(),a=actor('a'),events=[];
 beginTouch(s,a,(who,event)=>{events.push([who.id,event]);who.touching[3]=null;});
 assert.deepEqual(events,[['s','Touch']]);assert.deepEqual(a.touching,[null,null,null,null]);
});
test('native full list removes every stationary actor and inserts in last freed slot',()=>{
 const s=player(),a=actor('a'),old=Array.from({length:4},(_,i)=>actor('b'+i,{physics:i%2?0:1})),events=[];
 s.touching=[...old];for(const b of old)b.touching[0]=s;
 beginTouch(s,a,(who,event)=>events.push([who.id,event]));
 assert.deepEqual(events,[['s','UnTouch'],['b1','UnTouch'],['s','UnTouch'],['b3','UnTouch'],['s','Touch'],['a','Touch']]);
 assert.deepEqual(s.touching.map(x=>x?.id??null),['b0',null,'b2','a']);
});
test('native refused full-list insertion still permits reciprocal touch',()=>{
 const s=player(),a=actor('a');s.touching=Array.from({length:4},(_,i)=>actor('b'+i));
 beginTouch(s,a,()=>{});assert.equal(s.touching.includes(a),false);assert.equal(a.touching[3],s);
});
test('native EndTouch suppresses only source notification and overlap boundaries are strict',()=>{
 const s=player(),a=actor('a',{position:[40,0,0]}),events=[];s.touching[2]=a;a.touching[1]=s;
 assert.equal(isOverlapping(s,a),false);a.position=[39,0,0];assert.equal(isOverlapping(s,a),true);
 endTouch(s,a,true,(who,event)=>events.push([who.id,event]));assert.deepEqual(events,[['a','UnTouch']]);
});
