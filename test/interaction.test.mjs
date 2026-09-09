import test from 'node:test';
import assert from 'node:assert/strict';
import {traceActors,isFrobbable,isHighlighted,highlightCenterObject,tickWalkingInteraction} from '../src/runtime/interaction.mjs';
const actor=(name,lineage,properties={})=>({name,lineage,values:{CollisionRadius:10,...properties}});
const item=(name,radius=10)=>actor(name,['engine.inventory','engine.actor'],{CollisionRadius:radius});
const mover=()=>actor('door',['deusex.deusexmover','engine.mover','engine.brush','engine.actor'],{CollisionRadius:160,bHighlight:true,bFrobbable:true});
const pawn=()=>actor('npc',['deusex.scriptedpawn','engine.pawn','engine.actor'],{bHighlight:true});
const state=()=>({stateName:'PlayerWalking',position:[10,20,30],viewRotation:[0,0,0],maxFrobDistance:112,baseEyeHeight:40,frobTime:Math.fround(.1),frobTarget:null,carriedDecoration:null,npcHighlighting:true});
const select=actors=>highlightCenterObject(state(),function*(){for(const actor of actors)yield{actor};});

test('native TraceActors yields self, wrong class, world, and actor after world',()=>{
 const order=['self','wrong','world','owned'];let call;
 const q={levelInfo:'world',multiLineCheck(args){call=args;return order.map(actor=>({actor,location:[1,2,3],normal:[0,0,1]}));}};
 assert.deepEqual([...traceActors(q,{position:[4,5,6]},[7,8,9])].map(h=>h.actor),order);
 assert.deepEqual(call,{end:[7,8,9],start:[4,5,6],extent:[0,0,0],checkActors:1,worldActor:'world',extra:0});
});

test('source selection preserves first eligible mover, smaller radii and NPC priority',()=>{
 const door=mover(),npc=pawn(),a=item('large',20),b=item('small',5),equal=item('equal',5);
 assert.equal(select([door,npc]),door);
 assert.equal(select([a,door,b,equal]),b);
 assert.equal(select([a,npc,b]),npc);
 const tooLarge=item('tooLarge',99999);assert.equal(select([tooLarge,door]),door);
});

test('source carried/hidden exclusions do not turn use permissions into target filters',()=>{
 const s=state(),carried=item('carried',1),hidden=item('hidden',1),door=mover();hidden.values.bHidden=true;
 s.carriedDecoration=carried;door.values.bFrobbable=false;door.values.bHighlight=false;door.values.bDeleteMe=true;
 assert.equal(highlightCenterObject(s,()=>[{actor:carried},{actor:hidden},{actor:door}]),door);
 assert.equal(isFrobbable(door),true);assert.equal(isHighlighted(s,door),false);
});

test('source preserves eligible non-door classes and highlight branch order',()=>{
 for(const cls of ['deusex.deusexdecoration','engine.inventory','deusex.scriptedpawn','deusex.deusexcarcass','deusex.deusexprojectile'])assert.equal(isFrobbable(actor(cls,[cls,'engine.actor'])),true);
 assert.equal(isFrobbable(actor('plain',['engine.decoration','engine.actor'])),false);
 const s=state(),projectile=actor('thrown',['deusex.thrownprojectile','deusex.deusexprojectile','engine.actor'],{bHighlight:true,bStuck:false});
 assert.equal(isHighlighted(s,projectile),false);projectile.values.bStuck=true;assert.equal(isHighlighted(s,projectile),true);
 s.npcHighlighting=false;assert.equal(isHighlighted(s,pawn()),false);assert.equal(isHighlighted(s,null),true);
 s.behindView=true;assert.equal(isHighlighted(s,null),false);
});

test('native integer vector and source BaseEyeHeight segment ignores rendered eye',()=>{
 const s=state();s.viewRotation=[0,16384,0];s.traceEye=[900,900,900];let call;
 highlightCenterObject(s,(...args)=>{call=args;return[];});
 assert.deepEqual(call,[[10,132,70],[10,20,70],[0,0,0]]);assert.equal(s.frobTime,0);
});

test('source 0.1-second cache checks before adding this tick time',()=>{
 const s=state(),a=item('first'),b=item('second');s.frobTime=0;s.frobTarget=a;let calls=0;
 const query=()=>{calls++;return[{actor:b}];};
 for(let i=0;i<12;i++)tickWalkingInteraction(s,1/120,query);
 assert.equal(calls,0);assert.equal(s.frobTarget,a);
 tickWalkingInteraction(s,1/120,query);assert.equal(calls,1);assert.equal(s.frobTarget,b);assert.equal(s.frobTime,Math.fround(1/120));
 s.stateName='Dying';s.frobTime=1;assert.equal(highlightCenterObject(s,()=>{throw Error('unexpected query');}),b);assert.equal(s.frobTime,1);
});
